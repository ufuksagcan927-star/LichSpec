#!/usr/bin/env python3
"""
LichSpec / Phobetor - cok kanalli (renkli) JWST NIRCam veri seti.

Her alan icin 3 kizilotesi filtre:
  mavi  = F115W veya F150W   (kisa dalga)
  yesil = F200W              (etiketlerin uretildigi referans izgara, 0.031"/px)
  kirmizi = F444W, F356W veya F277W (uzun dalga, 0.063"/px -> referans izgaraya yeniden orneklenir)
Mozaiklerin tamami indirilmez; her bant icin sadece gereken bolge HTTP aralik istegiyle okunur.

Cikis:
  raw/<alan>.fits.gz   (3, H, W) kup: [mavi, yesil, kirmizi], baslikta BAND1..3
  rgb/<alan>.png       8-bit renkli onizleme
  labels/<alan>.csv    Gaia + jwst_sep etiketleri (F200W uzerinden), snr_est, detectable

Kullanim:
    python jwst_multiband.py --src data_jwst/all_jwst_fields.csv --n 300 --out data_jwst_mb --workers 4
"""
import argparse
import io
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.wcs import WCS
from PIL import Image
from scipy.ndimage import map_coordinates

sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import UA, make_labels, query_gaia  # noqa: E402
from hst_survey import MAST_TAP  # noqa: E402
from jwst_survey import DL, SIZE, fetch_cut, sep_pointlike  # noqa: E402
from degrade import snr_at  # noqa: E402

BLUE = ["f150w", "f115w"]
RED = ["f444w", "f356w", "f277w"]


def available_ids():
    q = ("SELECT obs_id FROM dbo.ObsPointing WHERE obs_collection='JWST' AND instrument_name LIKE 'NIRCAM%' "
         "AND calib_level=3 AND dataRights='PUBLIC' AND (filters LIKE '%F115W%' OR filters LIKE '%F150W%' "
         "OR filters LIKE '%F277W%' OR filters LIKE '%F356W%' OR filters LIKE '%F444W%')")
    r = requests.post(MAST_TAP, data=dict(LANG="ADQL", QUERY=q), timeout=900, headers=UA)
    r.raise_for_status()
    t = parse_single_table(io.BytesIO(r.content)).to_table()
    return set(str(x) for x in t["obs_id"])


def resample_band(obs_id, ref_wcs, shape):
    """Baska bir bandin mozaiginden, referans izgaranin kapladigi bolgeyi okuyup referansa yeniden ornekler."""
    url = DL.format(f"{obs_id}_i2d.fits")
    ny, nx = shape
    yy, xx = np.mgrid[0:ny:8, 0:nx:8]
    with fits.open(url, use_fsspec=True, lazy_load_hdus=True, fsspec_kwargs={"block_size": 4 * 2 ** 20}) as h:
        sci = h["SCI"]
        sw = WCS(sci.header, naxis=2)
        Ny, Nx = sci.header["NAXIS2"], sci.header["NAXIS1"]
        # referans izgaranin kenarlarini kaynak piksellerine cevir
        edge = np.concatenate([np.c_[np.arange(0, nx, 50), np.zeros(len(range(0, nx, 50)))],
                               np.c_[np.arange(0, nx, 50), np.full(len(range(0, nx, 50)), ny - 1)],
                               np.c_[np.zeros(len(range(0, ny, 50))), np.arange(0, ny, 50)],
                               np.c_[np.full(len(range(0, ny, 50)), nx - 1), np.arange(0, ny, 50)]])
        sky = ref_wcs.pixel_to_world(edge[:, 0], edge[:, 1])
        sx, sy = sw.world_to_pixel(sky)
        x0, x1 = int(max(0, np.floor(sx.min()) - 3)), int(min(Nx, np.ceil(sx.max()) + 4))
        y0, y1 = int(max(0, np.floor(sy.min()) - 3)), int(min(Ny, np.ceil(sy.max()) + 4))
        if x1 - x0 < 10 or y1 - y0 < 10:
            raise RuntimeError("bant bolgeyi kapsamiyor")
        sub = np.array(sci.section[y0:y1, x0:x1], dtype=np.float32)
    sub[sub == 0] = np.nan
    # tum referans pikselleri icin kaynak koordinatlari
    Y, X = np.mgrid[0:ny, 0:nx]
    sky = ref_wcs.pixel_to_world(X.ravel(), Y.ravel())
    px, py = sw.world_to_pixel(sky)
    filled = np.nan_to_num(sub, nan=0.0)
    valid = np.isfinite(sub).astype(np.float32)
    coords = np.vstack([py - y0, px - x0])
    v = map_coordinates(filled, coords, order=1, mode="constant", cval=0.0).reshape(ny, nx)
    m = map_coordinates(valid, coords, order=1, mode="constant", cval=0.0).reshape(ny, nx)
    out = np.where(m > 0.5, v / np.maximum(m, 1e-6), np.nan).astype(np.float32)
    return out


def stretch(ch):
    g = np.isfinite(ch)
    if not g.any():
        return np.zeros(ch.shape)
    lo, hi = np.percentile(ch[g], [1, 99.8])
    x = np.clip((np.where(g, ch, lo) - lo) / max(hi - lo, 1e-12), 0, 1)
    return np.arcsinh(x * 30) / np.arcsinh(30)


def process(row, out, ids):
    name = row.field
    done = out / "labels" / f"{name}.csv"
    if done.exists():
        return "var"
    base = row.obs_id.rsplit("-f200w", 1)[0]
    blue = next((f for f in BLUE if f"{base}-{f}" in ids), None)
    red = next((f for f in RED if f"{base}-{f}" in ids), None)
    if not blue or not red:
        raise RuntimeError("3 bant yok")
    g, hdr = fetch_cut(row.obs_id)
    w = WCS(hdr, naxis=2)
    b = resample_band(f"{base}-{blue}", w, g.shape)
    r = resample_band(f"{base}-{red}", w, g.shape)
    cube = np.stack([b, g, r])
    # etiketler: F200W
    rad = SIZE * 0.031 / 3600 / np.sqrt(2) + 0.003
    gaia = query_gaia(row.s_ra, row.s_dec, max(rad, 0.03), out / "gaia" / f"{name}.parquet")
    lg = make_labels(g, hdr, gaia)
    lg["catalog"] = "gaia"
    js = sep_pointlike(g)
    if len(js) and len(lg):
        from scipy.spatial import cKDTree
        d, _ = cKDTree(np.c_[lg.x, lg.y]).query(np.c_[js.x, js.y])
        js = js[d > 5]
    if len(js):
        c = w.pixel_to_world(js.x.values, js.y.values)
        js = js.assign(catalog="jwst_sep", ra=c.ra.deg, dec=c.dec.deg, is_star=True)
    lab = pd.concat([lg, js], ignore_index=True)
    lab["snr_est"] = snr_at(g, lab.x.values, lab.y.values, 3.0) if len(lab) else []
    lab["detectable"] = lab.snr_est > 5
    h = hdr.copy()
    h["BAND1"], h["BAND2"], h["BAND3"] = blue, "f200w", red
    h["ORBI_FLD"] = name
    h["ORBI_TGT"] = str(row.target_name)[:60]
    fits.PrimaryHDU(cube, header=h).writeto(out / "raw" / f"{name}.fits.gz", overwrite=True)
    rgb = np.dstack([stretch(r), stretch(g), stretch(b)])
    Image.fromarray(np.flipud(np.round(rgb * 255).astype(np.uint8))).save(out / "rgb" / f"{name}.png")
    lab.to_csv(done, index=False)
    return f"{blue}+f200w+{red} etiket={len(lab)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="data_jwst/all_jwst_fields.csv")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--out", default="data_jwst_mb")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("raw", "rgb", "labels", "gaia"):
        (out / s).mkdir(parents=True, exist_ok=True)
    ids = available_ids()
    fp = out / "fields.csv"
    if not fp.exists():
        t = pd.read_csv(a.src)
        base = t.obs_id.str.rsplit("-f200w", n=1).str[0]
        ok = [any(f"{b}-{f}" in ids for f in BLUE) and any(f"{b}-{f}" in ids for f in RED) for b in base]
        t = t[ok]
        # yildizca zengin alanlari one al, sonra rastgele
        t = pd.concat([t[t.star_rich], t[~t.star_rich].sample(frac=1, random_state=0)]).head(a.n)
        t["field"] = [f"jwmb{i:04d}" for i in range(len(t))]
        t.to_csv(fp, index=False)
    sel = pd.read_csv(fp)
    log = open(out / "fetch_log.txt", "a")
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(process, r, out, ids): r.field for r in sel.itertuples()}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                msg = f.result()
            except Exception as e:
                msg = "HATA: " + str(e)[:150]
                (out / "errors.txt").open("a").write(f"{futs[f]}\n{traceback.format_exc()}\n")
            line = f"[{i}/{len(sel)}] {futs[f]} {msg}"
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()


if __name__ == "__main__":
    main()
