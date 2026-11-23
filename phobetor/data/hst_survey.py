#!/usr/bin/env python3
"""
LichSpec / Phobetor - gokyuzune yayilmis Hubble (HST) veri seti.

1) MAST'tan Hubble'in ACS/WFC ile F606W/F814W filtrelerinde cektigi tum HAP-SVM alanlarini listeler,
   birbirine 3' den yakin olanlari tekillestirir.
2) Yildizca zengin alanlari (yildiz kumeleri, galaktik duzlem, Magellan bulutlari vb.) one cikararak
   ve gokyuzunu bolgelere bolup her bolgeden alarak N alan secer.
3) Her alan icin 1500x1500 px (60") HST kesiti indirir ve iki etiket kaynagi ekler:
     - Gaia DR3 (yildiz kimligi ve parlaklik, G<21)
     - Hubble Source Catalog (HSC v3): Gaia'nin goremedigi sonuk kaynaklar; CI ile nokta/yayvan ayrimi
Kesintiye dayanikli: biten alan atlanir, tekrar calistirmak kaldigi yerden devam eder.

Kullanim:
    python hst_survey.py select --n 300 --out data_hst
    python hst_survey.py fetch  --out data_hst --workers 3
"""
import argparse
import io
import json
import sys
import time
import traceback
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord, search_around_sky
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import UA, http_get, propagate, query_gaia, gaia_is_star  # noqa: E402

MAST_TAP = "https://mast.stsci.edu/vo-tap/api/v0.1/caom/sync"
SIZE_PX = 1500
PIX = 0.04  # arcsec
STAR_RICH = {"STELLAR CLUSTER", "STAR", "EXT-STAR", "EXT-CLUSTER", "ISM", "EXT-MEDIUM"}


# ---------------------------------------------------------------------------
# 1-2) Alan secimi
# ---------------------------------------------------------------------------
def list_hap_fields():
    q = ("SELECT obs_id, target_name, target_classification, s_ra, s_dec, t_exptime, filters, t_min "
         "FROM dbo.ObsPointing WHERE obs_collection='HST' AND instrument_name='ACS/WFC' "
         "AND provenance_name='HAP-SVM' AND (filters='F606W' OR filters='F814W') AND t_exptime>300")
    r = requests.post(MAST_TAP, data=dict(LANG="ADQL", QUERY=q), timeout=900, headers=UA)
    r.raise_for_status()
    t = parse_single_table(io.BytesIO(r.content)).to_table().to_pandas()
    for c in t.columns:
        if t[c].dtype == object:
            t[c] = t[c].astype(str)
    return t


def dedupe(t, radius_arcmin=3.0):
    c = SkyCoord(t.s_ra.values * u.deg, t.s_dec.values * u.deg)
    i1, i2, _, _ = search_around_sky(c, c, radius_arcmin * u.arcmin)
    nb = pd.Series(i2).groupby(i1).apply(list)
    taken = np.zeros(len(t), bool)
    keep = []
    for i in np.argsort(-t.t_exptime.values):  # en derin pozlamayi tut
        if taken[i]:
            continue
        keep.append(i)
        taken[nb[i]] = True
    return t.iloc[keep].reset_index(drop=True)


def select_fields(n, seed=0):
    t = dedupe(list_hap_fields())
    g = SkyCoord(t.s_ra.values * u.deg, t.s_dec.values * u.deg).galactic
    t["gal_l"], t["gal_b"] = g.l.deg, g.b.deg
    t["cls"] = t.target_classification.str.split(";").str[0].str.strip().str.upper()
    t["star_rich"] = t.cls.isin(STAR_RICH) | (np.abs(t.gal_b) < 15)
    rng = np.random.default_rng(seed)
    # Gokyuzunu 12x6 bolgeye bol (RA 30 derece, Dec 30 derece), her bolgeden sirayla sec
    t["cell"] = (t.s_ra // 30).astype(int) * 10 + ((t.s_dec + 90) // 30).astype(int)
    n_rich = n // 2

    def spread(df, k):
        df = df.sample(frac=1, random_state=int(rng.integers(1e9)))
        df["rank"] = df.groupby("cell").cumcount()
        return df.sort_values(["rank"]).head(k)

    a = spread(t[t.star_rich], n_rich)
    b = spread(t[~t.index.isin(a.index)], n - len(a))
    sel = pd.concat([a, b]).reset_index(drop=True)
    sel["field"] = [f"hst{i:04d}" for i in range(len(sel))]
    return t, sel


# ---------------------------------------------------------------------------
# 3) Indirme + etiketleme
# ---------------------------------------------------------------------------
def fetch_hst_cut(ra, dec):
    r = http_get("https://mast.stsci.edu/hapcut/api/v0.1/astrocut",
                 dict(ra=ra, dec=dec, x=SIZE_PX, y=SIZE_PX, units="px"), timeout=900)
    if not r.content.startswith(b"PK"):
        raise RuntimeError("HAP kesiti yok: " + r.text[:100])
    z = zipfile.ZipFile(io.BytesIO(r.content))
    pref = ["f606w", "f814w", "f625w", "f555w", "f775w", "f475w", "f850lp"]
    best, best_key = None, None
    for n in z.namelist():
        if not (n.startswith("hst_cutout_skycell") and n.endswith(".fits")):
            continue
        filt = n.rsplit("_", 1)[-1][:-5]
        if filt not in pref:
            continue
        with fits.open(io.BytesIO(z.read(n))) as h:
            d = h["SCI"].data
            cov = float(np.mean(np.isfinite(d) & (d != 0)))
        key = (round(cov, 2), -pref.index(filt))
        if best_key is None or key > best_key:
            best, best_key = n, key
    if best is None or best_key[0] < 0.3:
        raise RuntimeError(f"yetersiz kapsam ({best_key})")
    with fits.open(io.BytesIO(z.read(best))) as h:
        data = h["SCI"].data.astype(np.float32)
        hdr = h["SCI"].header.copy()
        prim = h[0].header
    data[data == 0] = np.nan
    hdr["ORBI_BND"] = best.rsplit("_", 1)[-1][:-5]
    hdr["ORBI_UNI"] = "electrons/s"
    hdr["ORBI_EPO"] = float(Time(prim["EXPSTART"], format="mjd").decimalyear) if "EXPSTART" in prim else 2016.0
    hdr["ORBI_COV"] = best_key[0]
    hdr["ORBI_SRC"] = best[:68]
    return data, hdr


def query_hsc(ra, dec, radius_deg):
    from astroquery.mast import Catalogs
    for i in range(3):
        try:
            t = Catalogs.query_region(f"{ra} {dec}", radius=radius_deg, catalog="HSC", magtype=1)
            break
        except Exception:
            if i == 2:
                raise
            time.sleep(5 * (i + 1))
    cols = ["MatchID", "MatchRA", "MatchDec", "CI", "NumImages", "A_F606W", "A_F814W", "W3_F555W"
            if "W3_F555W" in t.colnames else "A_F555W"]
    df = t[[c for c in cols if c in t.colnames]].to_pandas()
    return df


def label_field(data, hdr, gaia, hsc):
    w = WCS(hdr, naxis=2)
    ny, nx = data.shape

    def to_pix(ra, de):
        x, y = w.world_to_pixel(SkyCoord(ra * u.deg, de * u.deg))
        ok = (x >= 0) & (x < nx - 1) & (y >= 0) & (y < ny - 1)
        xi = np.clip(np.round(np.nan_to_num(x)).astype(int), 0, nx - 1)
        yi = np.clip(np.round(np.nan_to_num(y)).astype(int), 0, ny - 1)
        ok &= np.isfinite(data[yi, xi])
        return x, y, ok

    ra, de = propagate(gaia, float(hdr["ORBI_EPO"]))
    x, y, ok = to_pix(ra, de)
    lg = pd.DataFrame(dict(catalog="gaia", source_id=gaia.source_id.astype(str).values, x=x, y=y, ra=ra, dec=de,
                           g_mag=gaia.phot_g_mean_mag.values, bp_rp=gaia.bp_rp.values,
                           is_star=gaia_is_star(gaia), ci=np.nan, hst_mag=np.nan))[ok]
    if len(hsc):
        x, y, ok = to_pix(hsc.MatchRA.values, hsc.MatchDec.values)
        mag = hsc.get("A_F606W", pd.Series(np.nan, index=hsc.index)).fillna(
            hsc.get("A_F814W", pd.Series(np.nan, index=hsc.index)))
        lh = pd.DataFrame(dict(catalog="hsc", source_id=hsc.MatchID.astype(str).values, x=x, y=y,
                               ra=hsc.MatchRA.values, dec=hsc.MatchDec.values, g_mag=np.nan, bp_rp=np.nan,
                               # ACS/WFC icin nokta kaynak konsantrasyon indeksi ~0.9-1.3
                               is_star=(hsc.CI.values > 0.75) & (hsc.CI.values < 1.35),
                               ci=hsc.CI.values, hst_mag=mag.values))[ok]
        # Gaia ile 0.1" icinde eslesen HSC kaynaklarini tekrar etme
        if len(lg) and len(lh):
            from scipy.spatial import cKDTree
            d, _ = cKDTree(np.c_[lg.x, lg.y]).query(np.c_[lh.x, lh.y])
            lh = lh[d > 0.1 / PIX * 2.5]
        lab = pd.concat([lg, lh], ignore_index=True)
    else:
        lab = lg.reset_index(drop=True)
    return lab


def process(row, out: Path):
    name = row.field
    done = out / "labels" / f"{name}.csv"
    if done.exists():
        return name, "atlandi (var)"
    data, hdr = fetch_hst_cut(row.s_ra, row.s_dec)
    rad = SIZE_PX * PIX / 3600 / np.sqrt(2) + 0.002
    gaia = query_gaia(row.s_ra, row.s_dec, rad, out / "gaia" / f"{name}.parquet")
    hsc = query_hsc(row.s_ra, row.s_dec, rad)
    lab = label_field(data, hdr, gaia, hsc)
    hdr["ORBI_FLD"] = name
    hdr["ORBI_TGT"] = str(row.target_name)[:60]
    fits.PrimaryHDU(data, header=hdr).writeto(out / "raw" / f"{name}.fits.gz", overwrite=True)
    lab.to_csv(done, index=False)
    return name, (f"{hdr['ORBI_BND']} kapsam={hdr['ORBI_COV']:.2f} gaia={int((lab.catalog=='gaia').sum())} "
                  f"hsc={int((lab.catalog=='hsc').sum())} nokta={int(lab.is_star.sum())}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select", "fetch"])
    ap.add_argument("--out", default="data_hst")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("raw", "labels", "gaia"):
        (out / s).mkdir(parents=True, exist_ok=True)
    if a.cmd == "select":
        allf, sel = select_fields(a.n, a.seed)
        allf.to_csv(out / "all_hap_fields.csv", index=False)
        sel.to_csv(out / "fields.csv", index=False)
        print(f"Toplam tekil HST alani: {len(allf)}, secilen: {len(sel)} "
              f"(yildizca zengin {int(sel.star_rich.sum())})")
        return
    sel = pd.read_csv(out / "fields.csv")
    log = open(out / "fetch_log.txt", "a")
    ok = fail = 0
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(process, r, out): r.field for r in sel.itertuples()}
        for f in as_completed(futs):
            name = futs[f]
            try:
                _, msg = f.result()
                ok += 1
            except Exception as e:
                msg = "HATA: " + str(e)[:150]
                fail += 1
                (out / "errors.txt").open("a").write(f"{name}\n{traceback.format_exc()}\n")
            line = f"[{ok + fail}/{len(sel)}] {name} {msg}"
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()
    print(f"Bitti: {ok} basarili, {fail} hata")


if __name__ == "__main__":
    main()
