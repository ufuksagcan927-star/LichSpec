#!/usr/bin/env python3
"""Genis alan veri seti: DSS2 gokyuzu taramasi goruntuleri + OpenNGC (NGC/IC) katalog etiketleri.

Amator gokyuzu fotograflarina benzeyen genis alanlarda bulutsu, yildiz kumesi ve buyuk galaksi tanimak icin.

Goruntu: DSS2 (POSS-II / UKST Schmidt plaklari) mavi, kirmizi ve yakin kizilotesi bantlari, IRSA Finder Chart
servisinden. Her bant ayni kuzey-yukari izgaraya yeniden orneklenir. DSS2 bandi olmayan yerde DSS1 kullanilir
(FITS basliginda yazar).
Etiket: OpenNGC (NGC, IC ve ek liste; NED / HyperLEDA / SIMBAD derlemesi). Her nesne icin konum, tur,
buyuk / kucuk eksen ve konum acisi katalogdan aynen alinir; hicbir etiket uretilmez.

    python genis_alan_dataset.py --ngc NGC.csv --addendum addendum.csv --out genis_v1

Kesilirse kaldigi yerden devam eder.
"""
import argparse
import io
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

API = "https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api"
UA = {"User-Agent": "lichspec-phobetor-widefield/0.1"}
SINIF = {
    "G": "galaksi", "GPair": "galaksi", "GTrpl": "galaksi", "GGroup": "galaksi",
    "OCl": "acik_kume", "GCl": "kuresel_kume", "PN": "gezegenimsi_bulutsu",
    "HII": "salma_bulutsusu", "EmN": "salma_bulutsusu", "RfN": "yansima_bulutsusu",
    "SNR": "supernova_kalintisi", "Neb": "bulutsu", "Cl+N": "kume_ve_bulutsu",
    "*Ass": "yok_say", "DrkN": "yok_say", "Other": "yok_say", "*": "yok_say", "**": "yok_say", "Nova": "yok_say",
}
BANDS = [("DSS_MAVI", "dss2blue", "dss1blue"), ("DSS_KIRMIZI", "dss2red", "dss1red"), ("DSS_KIZILOTESI", "dss2ir", None)]
MAX_PIX = 768          # cikti goruntusunun en uzun kenari (piksel)
MIN_SCALE = 1.0        # yay saniyesi / piksel (DSS2 kirmizi plak olcegi)


def load_catalog(ngc, addendum):
    d = pd.concat([pd.read_csv(ngc, sep=";", low_memory=False), pd.read_csv(addendum, sep=";", low_memory=False)])
    d = d[d.Type.isin(SINIF)].copy()
    c = SkyCoord(d.RA.values, d.Dec.values, unit=(u.hourangle, u.deg))
    d["ra"], d["dec"] = c.ra.deg, c.dec.deg
    d["sinif"] = d.Type.map(SINIF)
    d["pa"] = d.PosAng.where((d.PosAng >= 0) & (d.PosAng <= 180))
    d["mag"] = d["V-Mag"].fillna(d["B-Mag"])
    return d.reset_index(drop=True)


def choose_targets(cat, n_gal_small, seed):
    rng = np.random.default_rng(seed)
    t = cat[cat.sinif.ne("galaksi") & cat.sinif.ne("yok_say")]
    g = cat[cat.sinif.eq("galaksi")]
    big = g[g.MajAx >= 3.0]
    small = g[(g.MajAx >= 1.5) & (g.MajAx < 3.0)]
    small = small.iloc[rng.permutation(len(small))[:n_gal_small]]
    t = pd.concat([t, big, small])
    size = t.MajAx.fillna(2.0)
    t = t.assign(fov=np.clip(3.5 * size, 8.0, 60.0)).sort_values("fov", ascending=False)
    keep, centers = [], []
    for i, r in t.iterrows():
        # ayni yere ve benzer olcege dusen ikinci bir alan acma (zaten etiketli)
        dup = any(abs(np.log(r.fov / f)) < np.log(2) and
                  np.hypot((r.ra - ra) * np.cos(np.radians(r.dec)), r.dec - de) * 60 < 0.3 * f for ra, de, f in centers)
        if not dup:
            keep.append(i)
            centers.append((r.ra, r.dec, r.fov))
    t = t.loc[keep].copy()
    # merkezi biraz kaydir: nesne her zaman ortada olmasin
    off = rng.uniform(-0.2, 0.2, size=(len(t), 2)) * t.fov.to_numpy()[:, None] / 60.0
    t["fra"] = t.ra + off[:, 0] / np.cos(np.radians(t.dec))
    t["fdec"] = np.clip(t.dec + off[:, 1], -89.9, 89.9)
    return t


def split_of(ra, dec, seed):
    """Gokyuzu bolgesine gore bolum: 10 x 10 derecelik bloklar rastgele train / val / test'e (70/15/15)."""
    bx = int(np.floor(ra * np.cos(np.radians(dec)) / 10.0))
    by = int(np.floor((dec + 90) / 10.0))
    h = np.random.default_rng([seed, bx + 1000, by]).random()
    return "train" if h < 0.70 else "val" if h < 0.85 else "test"


def fetch(ra, dec, fov, bands):
    for a in range(4):
        try:
            p = dict(locstr=f"{ra:.6f} {dec:+.6f}", survey="DSS", mode="getImage", subsetsize=f"{fov:.2f}", file_type="fits")
            if bands:
                p["dss_bands"] = ",".join(bands)
            r = requests.get(API, params=p,
                             timeout=600, headers=UA)
            r.raise_for_status()
            if r.content[:2] != b"PK":
                raise RuntimeError(r.text[:200])
            z = zipfile.ZipFile(io.BytesIO(r.content))
            out = {}
            for n in z.namelist():
                for b in ("dss2blue", "dss2red", "dss2ir", "dss1blue", "dss1red"):
                    if n.endswith(f"_{b}.fits"):
                        h = fits.open(io.BytesIO(z.read(n)))
                        out[b] = (h[0].data.astype(np.float32), h[0].header)
            return out
        except Exception:  # noqa: BLE001
            if a == 3:
                raise
            time.sleep(20 * (a + 1))


def target_wcs(ra, dec, fov):
    scale = max(MIN_SCALE, fov * 60.0 / MAX_PIX)
    n = int(round(fov * 60.0 / scale))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-scale / 3600.0, scale / 3600.0]
    return w, n, scale


def make_field(r, cat, out, seed):
    name = f"ga_{r.Name}"
    split = split_of(r.fra, r.fdec, seed)
    img_p = out / split / "goruntuler" / f"{name}.fits"
    lab_p = out / split / "etiketler" / f"{name}.csv"
    if img_p.exists() and lab_p.exists():
        return None
    from reproject import reproject_interp
    w, n, scale = target_wcs(r.fra, r.fdec, r.fov)
    got = fetch(r.fra, r.fdec, r.fov * 1.1, ["poss2ukstu_blue", "poss2ukstu_red", "poss2ukstu_ir"])
    if any(b2 not in got for _, b2, b1 in BANDS if b1):
        try:  # varsayilan istek, varsa DSS1 bantlarini da getirir
            got.update({k: v for k, v in fetch(r.fra, r.fdec, r.fov * 1.1, []).items() if k not in got})
        except Exception:  # noqa: BLE001
            pass
    if "dss2red" not in got and "dss1red" not in got:
        return dict(ad=name, hata="kirmizi bant yok")
    hdus = [fits.PrimaryHDU()]
    cover, missing, srcs = [], [], []
    for ext, b2, b1 in BANDS:
        src = b2 if b2 in got else b1 if b1 and b1 in got else None
        h = w.to_header()
        if src is None:
            # bu bolgede bant yok (ornegin guneyde bazi DSS2 mavi plaklari): katman bos (NaN) yazilir
            missing.append(ext)
            h["KAYNAK"] = ("yok", "bu bolgede bant yok")
            hdus.append(fits.CompImageHDU(np.full((n, n), np.nan, np.float32), header=h, name=ext,
                                          compression_type="RICE_1", quantize_level=16, quantize_method=2))
            continue
        data, hdr = got[src]
        arr, fp = reproject_interp((data, WCS(hdr)), w, shape_out=(n, n))
        arr = np.where(fp > 0, arr, np.nan).astype(np.float32)
        cover.append(float(np.isfinite(arr).mean()))
        srcs.append(src)
        for k in ("PLATEID", "SURVEY", "EXPOSURE", "DATE-OBS", "BANDPASS", "EMULSION", "FILTER", "PLTLABEL"):
            if k in hdr:
                h[k] = hdr[k]
        h["KAYNAK"] = (src, "DSS bandi (dss2* tercih, yoksa dss1*)")
        h["OLCEK"] = (scale, "yay saniyesi / piksel")
        hdus.append(fits.CompImageHDU(arr, header=h, name=ext, compression_type="RICE_1",
                                      quantize_level=16, quantize_method=2))
    # etiketler: alana dusen butun katalog nesneleri
    x, y = w.world_to_pixel(SkyCoord(cat.ra.values * u.deg, cat.dec.values * u.deg))
    m = (x >= -0.5) & (x < n - 0.5) & (y >= -0.5) & (y < n - 0.5)
    L = cat[m].copy()
    L["x"], L["y"] = x[m], y[m]
    L["buyuk_eksen_px"] = L.MajAx * 60.0 / scale
    L["kucuk_eksen_px"] = L.MinAx * 60.0 / scale
    L["hedef"] = L.Name.eq(r.Name)
    cols = ["Name", "sinif", "Type", "x", "y", "ra", "dec", "MajAx", "MinAx", "pa", "buyuk_eksen_px", "kucuk_eksen_px",
            "mag", "B-Mag", "V-Mag", "SurfBr", "Hubble", "M", "Common names", "hedef"]
    L = L[cols].rename(columns={"Name": "ad", "Type": "ngc_tur", "MajAx": "buyuk_eksen_yaydk", "MinAx": "kucuk_eksen_yaydk",
                                "pa": "aci_derece", "mag": "parlaklik", "B-Mag": "b_mag", "V-Mag": "v_mag",
                                "SurfBr": "yuzey_parlakligi", "Hubble": "hubble_tipi", "M": "messier", "Common names": "yaygin_ad"})
    img_p.parent.mkdir(parents=True, exist_ok=True)
    lab_p.parent.mkdir(parents=True, exist_ok=True)
    fits.HDUList(hdus).writeto(img_p, overwrite=True)
    L.to_csv(lab_p, index=False, float_format="%.6g")
    return dict(ad=name, bolum=split, hedef=r.Name, sinif=r.sinif, ra=r.fra, dec=r.fdec, alan_yaydk=round(r.fov, 2),
                olcek=round(scale, 3), boyut=n, nesne=len(L), kapsama=round(min(cover), 4),
                eksik_bant=",".join(missing), kaynak_bantlar=",".join(srcs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ngc", required=True)
    ap.add_argument("--addendum", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--small-galaxies", type=int, default=400)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cat = load_catalog(a.ngc, a.addendum)
    t = choose_targets(cat, a.small_galaxies, a.seed)
    if a.limit:
        t = t.iloc[np.random.default_rng(a.seed).permutation(len(t))[:a.limit]]
    print(f"katalog {len(cat)} nesne, {len(t)} alan; hedef siniflari:\n{t.sinif.value_counts().to_string()}", flush=True)
    rows, errs = [], []
    idx_p = out / "index.csv"
    if idx_p.exists():
        rows = pd.read_csv(idx_p).to_dict("records")
    done = {r["ad"] for r in rows}
    todo = [r for _, r in t.iterrows() if f"ga_{r.Name}" not in done]
    t0 = time.time()
    with ThreadPoolExecutor(a.workers) as ex:
        futs = [ex.submit(make_field, r, cat, out, a.seed) for r in todo]
        for i, f in enumerate(futs):
            try:
                res = f.result()
            except Exception as e:  # noqa: BLE001
                res = dict(ad=f"ga_{todo[i].Name}", hata=str(e)[:200])
            if res is None:
                continue
            (errs if "hata" in res else rows).append(res)
            if (i + 1) % 25 == 0 or i + 1 == len(futs):
                pd.DataFrame(rows).to_csv(idx_p, index=False)
                print(f"[{i + 1}/{len(futs)}] {len(errs)} hata, {time.time() - t0:.0f} s", flush=True)
    pd.DataFrame(rows).to_csv(idx_p, index=False)
    if errs:
        pd.DataFrame(errs).to_csv(out / "hatalar.csv", index=False)
    (out / "siniflar.json").write_text(json.dumps(SINIF, indent=1, ensure_ascii=False), encoding="utf-8")
    print(pd.DataFrame(rows).groupby("bolum").size().to_string())


if __name__ == "__main__":
    main()
