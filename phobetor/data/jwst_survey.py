#!/usr/bin/env python3
"""
LichSpec / Phobetor - JWST NIRCam pilot.

JWST NIRCam F200W mozaikleri (0.031"/px) Hubble'dan da keskin ve kizilotesi oldugu icin tozun
arkasindaki yildizlari gosterir. Mozaikler 0.5-3 GB oldugu icin dosyanin tamami indirilmez:
HTTP aralik istegiyle (fsspec) sadece merkezdeki 2000x2000 px kesit okunur.

Etiketler:
  - Gaia DR3 (parlak yildizlar; JWST'de cogu doyuma ulasir, flag: saturated_likely)
  - jwst_sep: temiz JWST goruntusunde SEP ile bulunan, SNR>10 ve nokta kaynak gibi gorunen
    (yari-genislik dar, basiklik dusuk) kaynaklar. Bunlar "yari-otomatik" etikettir; bozulmus
    kopyalarda modeli egitmek icin yeterince guvenilirdir ama Gaia/HSC kadar bagimsiz degildir.

Kullanim:
    python jwst_survey.py select --n 30 --out data_jwst
    python jwst_survey.py fetch  --out data_jwst --workers 3
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
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import UA, make_labels, query_gaia  # noqa: E402
from hst_survey import MAST_TAP, STAR_RICH, dedupe  # noqa: E402
from degrade import snr_at  # noqa: E402

SIZE = 2000
DL = "https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:JWST/product/{}"


def select(n, seed=0):
    q = ("SELECT obs_id, target_name, target_classification, s_ra, s_dec, t_exptime, filters "
         "FROM dbo.ObsPointing WHERE obs_collection='JWST' AND instrument_name LIKE 'NIRCAM%' "
         "AND calib_level=3 AND filters LIKE '%F200W%' AND t_exptime>200 AND dataRights='PUBLIC'")
    r = requests.post(MAST_TAP, data=dict(LANG="ADQL", QUERY=q), timeout=900, headers=UA)
    r.raise_for_status()
    t = parse_single_table(io.BytesIO(r.content)).to_table().to_pandas()
    for c in t.columns:
        if t[c].dtype == object:
            t[c] = t[c].astype(str)
    t = t[t.obs_id.str.endswith("nircam_clear-f200w")]  # alt-dizi (sub) ve koronograf gozlemlerini disla
    t = dedupe(t.reset_index(drop=True), radius_arcmin=5)
    g = SkyCoord(t.s_ra.values * u.deg, t.s_dec.values * u.deg).galactic
    t["gal_b"] = g.b.deg
    t["cls"] = t.target_classification.str.split(";").str[0].str.strip().str.upper()
    t["star_rich"] = t.cls.isin(STAR_RICH) | (np.abs(t.gal_b) < 15)
    a = t[t.star_rich].sample(min(n * 2 // 3, int(t.star_rich.sum())), random_state=seed)
    b = t[~t.star_rich].sample(n - len(a), random_state=seed)
    sel = pd.concat([a, b]).reset_index(drop=True)
    sel["field"] = [f"jw{i:04d}" for i in range(len(sel))]
    return t, sel


def fetch_cut(obs_id):
    url = DL.format(f"{obs_id}_i2d.fits")
    with fits.open(url, use_fsspec=True, lazy_load_hdus=True,
                   fsspec_kwargs={"block_size": 4 * 2 ** 20}) as h:
        sci = h["SCI"]
        hdr = sci.header.copy()
        ny, nx = hdr["NAXIS2"], hdr["NAXIS1"]
        # gecerli piksellerin yogun oldugu bolgeyi bulmak icin seyrek bir ornekle
        step = max(1, min(nx, ny) // 40)
        rows = np.arange(0, ny, step)
        grid = np.array([sci.section[int(y), ::step] for y in rows])
        ok = np.isfinite(grid) & (grid != 0)
        yy, xx = np.nonzero(ok)
        if len(yy) == 0:
            raise RuntimeError("bos mozaik")
        cy, cx = int(np.median(rows[yy])), int(np.median(xx * step))
        half = SIZE // 2
        y0, x0 = max(0, min(cy - half, ny - SIZE)), max(0, min(cx - half, nx - SIZE))
        data = np.array(sci.section[y0:y0 + SIZE, x0:x0 + SIZE], dtype=np.float32)
        prim = h[0].header
    w = WCS(hdr, naxis=2)[y0:y0 + SIZE, x0:x0 + SIZE]
    out = w.to_header()
    data[data == 0] = np.nan
    cov = float(np.isfinite(data).mean())
    if cov < 0.5:
        raise RuntimeError(f"yetersiz kapsam {cov:.2f}")
    out["ORBI_BND"] = "f200w"
    out["ORBI_UNI"] = hdr.get("BUNIT", "MJy/sr")
    out["ORBI_EPO"] = 2023.0
    if "EXPSTART" in prim:
        from astropy.time import Time
        out["ORBI_EPO"] = float(Time(prim["EXPSTART"], format="mjd").decimalyear)
    out["ORBI_COV"] = round(cov, 2)
    out["ORBI_SRC"] = obs_id[:68]
    return data, out


def sep_pointlike(data):
    import sep
    img = np.ascontiguousarray(np.nan_to_num(data, nan=0.0), dtype=np.float64)
    mask = ~np.isfinite(data)
    # bulutsu gibi yapili arka plani bastirmak icin kucuk orgulu yerel arka plan ve yerel gurultu
    bkg = sep.Background(img, mask=mask, bw=32, bh=32, fw=3, fh=3)
    sub = img - bkg
    sep.set_extract_pixstack(5_000_000)
    sep.set_sub_object_limit(8192)
    o = sep.extract(sub, 10.0, err=bkg.rms(), mask=mask, minarea=6)
    if len(o) == 0:
        return pd.DataFrame(columns=["x", "y"])
    fwhm = 2 * np.sqrt(np.log(2) * (o["a"] ** 2 + o["b"] ** 2))
    med = np.median(fwhm[o["flux"] > np.percentile(o["flux"], 50)])
    # nokta kaynak: dar, yuvarlak ve isigi merkezde toplanmis (tepe/toplam aki orani yuksek)
    conc = o["peak"] / np.maximum(o["flux"], 1e-12)
    point = ((fwhm < 1.5 * med) & (o["b"] / np.maximum(o["a"], 1e-6) > 0.7) & (o["flag"] == 0)
             & (conc > 0.5 * np.median(conc)))
    return pd.DataFrame(dict(x=o["x"][point], y=o["y"][point], fwhm=fwhm[point]))


def process(row, out):
    name = row.field
    done = out / "labels" / f"{name}.csv"
    if done.exists():
        return "var"
    data, hdr = fetch_cut(row.obs_id)
    w = WCS(hdr, naxis=2)
    rad = SIZE * 0.031 / 3600 / np.sqrt(2) + 0.003
    gaia = query_gaia(row.s_ra, row.s_dec, max(rad, 0.03), out / "gaia" / f"{name}.parquet")
    lg = make_labels(data, hdr, gaia)
    lg["catalog"] = "gaia"
    lg["saturated_likely"] = lg.g_mag < 17
    js = sep_pointlike(data)
    if len(js) and len(lg):
        from scipy.spatial import cKDTree
        d, _ = cKDTree(np.c_[lg.x, lg.y]).query(np.c_[js.x, js.y])
        js = js[d > 5]
    if len(js):
        c = w.pixel_to_world(js.x.values, js.y.values)
        js = js.assign(catalog="jwst_sep", ra=c.ra.deg, dec=c.dec.deg, is_star=True, saturated_likely=False)
    lab = pd.concat([lg, js], ignore_index=True)
    lab["snr_est"] = snr_at(data, lab.x.values, lab.y.values, 3.0) if len(lab) else []
    lab["detectable"] = lab.snr_est > 5
    hdr["ORBI_FLD"] = name
    hdr["ORBI_TGT"] = str(row.target_name)[:60]
    fits.PrimaryHDU(data, header=hdr).writeto(out / "raw" / f"{name}.fits.gz", overwrite=True)
    lab.to_csv(done, index=False)
    return f"gaia={len(lg)} jwst_nokta={len(js)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select", "fetch"])
    ap.add_argument("--out", default="data_jwst")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("raw", "labels", "gaia"):
        (out / s).mkdir(parents=True, exist_ok=True)
    if a.cmd == "select":
        allf, sel = select(a.n)
        allf.to_csv(out / "all_jwst_fields.csv", index=False)
        sel.to_csv(out / "fields.csv", index=False)
        print(f"Tekil JWST F200W alani: {len(allf)}, secilen: {len(sel)} (yildizca zengin {int(sel.star_rich.sum())})")
        return
    sel = pd.read_csv(out / "fields.csv")
    log = open(out / "fetch_log.txt", "a")
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(process, r, out): r.field for r in sel.itertuples()}
        for i, f in enumerate(as_completed(futs), 1):
            name = futs[f]
            try:
                msg = f.result()
            except Exception as e:
                msg = "HATA: " + str(e)[:150]
                (out / "errors.txt").open("a").write(f"{name}\n{traceback.format_exc()}\n")
            line = f"[{i}/{len(sel)}] {name} {msg}"
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()


if __name__ == "__main__":
    main()
