#!/usr/bin/env python3
"""
LichSpec / Phobetor - yildiz tespiti veri seti olusturucu.

Her gokyuzu alani icin birden fazla arsivden (SDSS, Pan-STARRS, Legacy Survey, Hubble/HST)
ayni bolgenin FITS kesitlerini indirir, Gaia DR3 kataloğundan bu bolgedeki yildizlarin
konumlarini ceker ve her goruntu icin piksel koordinatli "dogru cevap" (ground truth)
etiket dosyasi uretir. Ayrica SEP ile basit bir tespit yapip Gaia'ya gore
yakalama oranini (recall) raporlar; bu, egitilecek modelin gecmesi gereken taban cizgisidir.

Kullanim:
    python build_dataset.py --out data                # config'teki tum alanlar
    python build_dataset.py --out data --fields m67   # tek alan
    python build_dataset.py --out data --skip hst     # bir arsivi atla
"""
import argparse
import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.nddata import Cutout2D
from astropy.time import Time
from astropy.wcs import WCS

# ---------------------------------------------------------------------------
# Alanlar: birden fazla arsivin kapsadigi kucuk bolgeler.
# hst=True olanlarda Hubble HAP mozaigi mevcut (MAST hapcut ile kontrol edildi).
# ---------------------------------------------------------------------------
FIELDS = {
    # Acik yildiz kumesi M67: orta yogunluk, SDSS+PS1+Legacy+HST
    "m67": dict(ra=132.846, dec=11.814, hst=True),
    # Kuresel kume M3 (merkezden ~1' disari): yogun alan, SDSS+PS1+Legacy+HST
    "m3_out": dict(ra=205.548, dec=28.395, hst=True, crowded=True),
    # SDSS Stripe 82: seyrek yuksek galaktik enlem alani, cok sayida galaksi (yanlis pozitif testi)
    "s82_a": dict(ra=20.000, dec=0.000, hst=False),
    # COSMOS alani: seyrek, derin, galaksi zengin
    "cosmos": dict(ra=150.100, dec=2.200, hst=False),
}

GROUND_SIZE_ARCMIN = 6.0   # yer teleskoplari icin kesit boyu
HST_SIZE_PX = 1500         # HST kesit boyu (0.04"/px -> 60")
GAIA_GMAX = 21.0
UA = {"User-Agent": "lichspec-phobetor-dataset/0.1 (astropy/astroquery research script)"}

GAIA_TAP = ["https://gaia.ari.uni-heidelberg.de/tap/sync",
            "https://gea.esac.esa.int/tap-server/tap/sync"]

SURVEYS = ["sdss", "ps1", "legacy", "hst"]


def http_get(url, params=None, timeout=300, tries=4):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout, headers=UA)
            r.raise_for_status()
            return r
        except Exception as e:  # ag hatalarinda tekrar dene
            last = e
            time.sleep(2 ** i)
    raise last


# ---------------------------------------------------------------------------
# Arsiv indiricileri: her biri (data[float32], header) dondurur, header icinde gecerli WCS var.
# ---------------------------------------------------------------------------
def fetch_legacy(ra, dec, size_arcmin):
    pix = 0.262
    n = int(round(size_arcmin * 60 / pix))
    r = http_get("https://www.legacysurvey.org/viewer/fits-cutout",
                 dict(ra=ra, dec=dec, layer="ls-dr10", pixscale=pix, bands="r", size=n))
    with fits.open(io.BytesIO(r.content)) as h:
        data = h[0].data.astype(np.float32)
        hdr = h[0].header.copy()
    if data.ndim == 3:
        data = data[0]
    hdr["ORBI_BND"] = "r"
    hdr["ORBI_UNI"] = "nanomaggies"
    hdr["ORBI_EPO"] = 2017.0  # DR10 coklu-donem birlesimi, yaklasik ortalama donem
    return data, hdr


def fetch_ps1(ra, dec, size_arcmin):
    pix = 0.25
    n = int(round(size_arcmin * 60 / pix))
    lst = http_get("https://ps1images.stsci.edu/cgi-bin/ps1filenames.py",
                   dict(ra=ra, dec=dec, filters="r", type="stack")).text
    tab = pd.read_csv(io.StringIO(lst), sep=r"\s+")
    if len(tab) == 0:
        raise RuntimeError("PS1 kapsami yok")
    fn = tab["filename"].iloc[0]
    r = http_get("https://ps1images.stsci.edu/cgi-bin/fitscut.cgi",
                 dict(ra=ra, dec=dec, size=n, format="fits", red=fn))
    with fits.open(io.BytesIO(r.content)) as h:
        data = h[0].data.astype(np.float64)
        hdr = h[0].header.copy()
    # PS1 stack'leri asinh olcekli saklanir -> dogrusal aki
    if "BSOFTEN" in hdr and "BOFFSET" in hdr:
        a = 2.5 / np.log(10)
        data = hdr["BOFFSET"] + hdr["BSOFTEN"] * 2 * np.sinh(data / (2 * a))
    hdr["ORBI_BND"] = "r"
    hdr["ORBI_UNI"] = "counts (zp=25+2.5log10(exptime))"
    hdr["ORBI_EPO"] = 2012.0
    return data.astype(np.float32), hdr


def fetch_sdss(ra, dec, size_arcmin):
    from astroquery.sdss import SDSS
    c = SkyCoord(ra * u.deg, dec * u.deg)
    # alanin merkezine en yakin "primary" kareyi sec
    sql = (f"SELECT TOP 1 run, camcol, field, dbo.fDistanceArcMinEq({ra:.5f},{dec:.5f},ra,dec) AS d "
           f"FROM Field WHERE ra BETWEEN {ra-0.3:.5f} AND {ra+0.3:.5f} "
           f"AND dec BETWEEN {dec-0.3:.5f} AND {dec+0.3:.5f} ORDER BY d")
    res = None
    for i in range(3):
        try:
            res = SDSS.query_sql(sql, data_release=17)
            break
        except Exception:
            time.sleep(3 * (i + 1))
    if res is None or len(res) == 0:
        res = SDSS.query_region(c, radius=1 * u.arcmin, data_release=17,
                                fields=["run", "camcol", "field", "rerun", "ra", "dec"])
        if res is None or len(res) == 0:
            raise RuntimeError("SDSS kapsami yok")
        sep = SkyCoord(res["ra"] * u.deg, res["dec"] * u.deg).separation(c)
        res = res[[int(np.argmin(sep))]]
    row = res[0]
    run, camcol, field = int(row["run"]), int(row["camcol"]), int(row["field"])
    url = (f"https://data.sdss.org/sas/dr17/eboss/photoObj/frames/301/{run}/{camcol}/"
           f"frame-r-{run:06d}-{camcol}-{field:04d}.fits.bz2")
    import bz2
    r = http_get(url)
    with fits.open(io.BytesIO(bz2.decompress(r.content))) as h:
        img = h[0].data.astype(np.float32)
        hdr = h[0].header.copy()
    w = WCS(hdr)
    n = int(round(size_arcmin * 60 / 0.396))
    cut = Cutout2D(img, c, (n, n), wcs=w, mode="partial", fill_value=np.nan)
    hdr2 = cut.wcs.to_header()
    for k in ("NMGY", "EXPTIME", "TAI", "RUN", "CAMCOL", "FRAME"):
        if k in hdr:
            hdr2[k] = hdr[k]
    hdr2["ORBI_BND"] = "r"
    hdr2["ORBI_UNI"] = "nanomaggies"
    epoch = Time(hdr["TAI"] / 86400.0, format="mjd", scale="tai").decimalyear if "TAI" in hdr else 2005.0
    hdr2["ORBI_EPO"] = float(epoch)
    return cut.data.astype(np.float32), hdr2


def fetch_hst(ra, dec, size_px):
    r = http_get("https://mast.stsci.edu/hapcut/api/v0.1/astrocut",
                 dict(ra=ra, dec=dec, x=size_px, y=size_px, units="px"), timeout=600)
    if not r.content.startswith(b"PK"):
        raise RuntimeError("HST HAP kapsami yok: " + r.text[:120])
    z = zipfile.ZipFile(io.BytesIO(r.content))
    # Not: "hst_combined_skycells" dosyalarinda CRVAL/CRPIX eksik geliyor (hapcut hatasi),
    # bu yuzden tek tek skycell kesitlerini kullanip kapsami en genis olani seciyoruz.
    names = [n for n in z.namelist() if n.startswith("hst_cutout_skycell") and n.endswith(".fits")]
    pref = ["f606w", "f625w", "f555w", "f775w", "f814w", "f475w", "f850lp"]  # Gaia G'ye yakinlik
    best, best_key = None, None
    for n in names:
        filt = n.rsplit("_", 1)[-1].replace(".fits", "")
        if filt not in pref:
            continue
        with fits.open(io.BytesIO(z.read(n))) as h:
            d = h["SCI"].data
            cov = float(np.mean(np.isfinite(d) & (d != 0)))
        key = (round(cov, 2), -pref.index(filt))
        if best_key is None or key > best_key:
            best, best_key = n, key
    if best is None:
        raise RuntimeError("uygun HST filtresi yok")
    with fits.open(io.BytesIO(z.read(best))) as h:
        data = h["SCI"].data.astype(np.float32)
        hdr = h["SCI"].header.copy()
        prim = h[0].header
    data[data == 0] = np.nan  # kapsam disi
    hdr["ORBI_BND"] = best.rsplit("_", 1)[-1].replace(".fits", "")
    hdr["ORBI_UNI"] = "electrons/s"
    hdr["ORBI_EPO"] = 2016.0
    for k in ("EXPSTART",):
        if k in prim:
            hdr["ORBI_EPO"] = float(Time(prim[k], format="mjd").decimalyear)
    hdr["ORBI_SRC"] = best[:68]
    return data, hdr


# ---------------------------------------------------------------------------
# Gaia DR3
# ---------------------------------------------------------------------------
def query_gaia(ra, dec, radius_deg, cache: Path):
    if cache.exists():
        return pd.read_parquet(cache)
    q = f"""
    SELECT g.source_id, g.ra, g.dec, g.pmra, g.pmdec, g.parallax, g.parallax_over_error,
           g.phot_g_mean_mag, g.phot_bp_mean_mag, g.phot_rp_mean_mag, g.bp_rp,
           g.ruwe, g.astrometric_excess_noise, g.classprob_dsc_combmod_star,
           g.classprob_dsc_combmod_galaxy, g.non_single_star, g.teff_gspphot
    FROM gaiadr3.gaia_source AS g
    WHERE 1 = CONTAINS(POINT('ICRS', g.ra, g.dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))
      AND g.phot_g_mean_mag < {GAIA_GMAX}
    """
    # Gaia DR3 TAP: once Heidelberg ARI (resmi ortak veri merkezi), sonra ESA
    df, err = None, None
    for ep in GAIA_TAP:
        try:
            r = requests.post(ep, data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q),
                              timeout=600, headers=UA)
            r.raise_for_status()
            if not r.text.startswith("source_id"):
                raise RuntimeError("beklenmeyen yanit: " + r.text[:80])
            df = pd.read_csv(io.StringIO(r.text))
            break
        except Exception as e:
            err = e
    if df is None:
        raise RuntimeError(f"Gaia sorgusu basarisiz: {err}")
    df.columns = [c.lower() for c in df.columns]
    df.to_parquet(cache)
    return df


def gaia_is_star(df, crowded=False):
    """Gaia'ya gore yildiz olma ihtimali yuksek kaynaklar.
    Anlamli paralaks veya ozdevinim varsa kesin yildiz; yoksa DSC siniflandiricisina bak."""
    pm = np.hypot(df.pmra.fillna(0), df.pmdec.fillna(0))
    moving = (df.parallax_over_error.fillna(0) > 5) | (pm > 5)
    # DSC olasiligi olmayan (soluk / kalabalik) kaynaklari dislamiyoruz; sadece
    # galaksi gibi gorunenleri (galaksi olasiligi yuksek ya da astrometrik olarak yayvan) eliyoruz.
    if crowded:
        # Kuresel kume gibi kalabalik alanlarda DSC ve astrometrik gurultu kalabaliktan bozulur;
        # bu yonde 6' icinde arka plan galaksisi sayisi ihmal edilebilir, hepsini yildiz say.
        return np.ones(len(df), dtype=bool)
    galaxy = df.classprob_dsc_combmod_galaxy.fillna(0) > 0.5
    extended = (df.astrometric_excess_noise.fillna(0) > 3.0) & ~moving
    return (moving | ~(galaxy | extended)).values


def propagate(df, epoch):
    """Gaia 2016.0 konumlarini goruntu donemine tasir (ozdevinim)."""
    dt = epoch - 2016.0
    cosd = np.cos(np.deg2rad(df.dec.values))
    ra = df.ra.values + (df.pmra.fillna(0).values * dt / 3.6e6) / cosd
    de = df.dec.values + df.pmdec.fillna(0).values * dt / 3.6e6
    return ra, de


def make_labels(data, hdr, gaia, crowded=False):
    w = WCS(hdr, naxis=2)
    epoch = float(hdr.get("ORBI_EPO", 2016.0))
    ra, de = propagate(gaia, epoch)
    x, y = w.world_to_pixel(SkyCoord(ra * u.deg, de * u.deg))
    ny, nx = data.shape
    inside = (x >= 0) & (x < nx - 1) & (y >= 0) & (y < ny - 1)
    valid = np.zeros_like(inside)
    xi = np.clip(np.round(x).astype(int), 0, nx - 1)
    yi = np.clip(np.round(y).astype(int), 0, ny - 1)
    valid[inside] = np.isfinite(data[yi[inside], xi[inside]])
    lab = pd.DataFrame(dict(
        source_id=gaia.source_id.values, x=x, y=y, ra=ra, dec=de,
        g_mag=gaia.phot_g_mean_mag.values, bp_rp=gaia.bp_rp.values,
        is_star=gaia_is_star(gaia, crowded), ruwe=gaia.ruwe.values,
        teff=gaia.teff_gspphot.values,
    ))
    return lab[valid].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Taban cizgisi: SEP ile tespit + Gaia eslestirme
# ---------------------------------------------------------------------------
def pixscale_arcsec(hdr):
    w = WCS(hdr, naxis=2)
    from astropy.wcs.utils import proj_plane_pixel_scales
    return float(np.mean(np.abs(proj_plane_pixel_scales(w))) * 3600)


def sep_baseline(data, hdr, lab, thresh=5.0):
    import sep
    img = np.ascontiguousarray(data, dtype=np.float64)
    mask = ~np.isfinite(img)
    img[mask] = 0
    bkg = sep.Background(img, mask=mask)
    sub = img - bkg
    sep.set_extract_pixstack(2_000_000)
    sep.set_sub_object_limit(4096)
    obj = sep.extract(sub, thresh, err=bkg.globalrms, mask=mask, minarea=5)
    ps = pixscale_arcsec(hdr)
    rad_px = max(1.0 / ps, 2.0)  # 1" veya 2 px
    stars = lab[lab.is_star]
    if len(obj) == 0 or len(stars) == 0:
        return dict(n_det=int(len(obj)), n_gaia_star=int(len(stars)))
    from scipy.spatial import cKDTree
    t = cKDTree(np.c_[obj["x"], obj["y"]])
    d, _ = t.query(np.c_[stars.x, stars.y])
    hit = d < rad_px
    out = dict(n_det=int(len(obj)), n_gaia_star=int(len(stars)),
               recall_all=float(hit.mean()), match_radius_px=round(rad_px, 2),
               pixscale_arcsec=round(ps, 4))
    for gm in (18, 19, 20):
        sel = stars.g_mag.values < gm
        if sel.sum():
            out[f"recall_G<{gm}"] = float(hit[sel].mean())
    # Eslesen tespitlerden sapma (astrometrik uyum kontrolu)
    if hit.sum():
        _, idx = t.query(np.c_[stars.x, stars.y])
        dx = obj["x"][idx[hit]] - stars.x.values[hit]
        dy = obj["y"][idx[hit]] - stars.y.values[hit]
        out["median_offset_arcsec"] = float(np.median(np.hypot(dx, dy)) * ps)
    return out


def save_preview(data, lab, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from astropy.visualization import AsinhStretch, ImageNormalize, ZScaleInterval
    d = np.nan_to_num(data, nan=np.nanmedian(data))
    norm = ImageNormalize(d, interval=ZScaleInterval(), stretch=AsinhStretch())
    fig, ax = plt.subplots(figsize=(7, 7), dpi=110)
    ax.imshow(d, origin="lower", cmap="gray", norm=norm)
    s = lab[lab.is_star]
    g = lab[~lab.is_star]
    r = max(6, data.shape[0] / 120)
    ax.scatter(s.x, s.y, s=r ** 2, facecolors="none", edgecolors="#00e5ff", lw=0.6, label=f"Gaia yildiz ({len(s)})")
    ax.scatter(g.x, g.y, s=r ** 2, facecolors="none", edgecolors="#ff9800", lw=0.6, label=f"Gaia diger ({len(g)})")
    ax.legend(loc="upper right", fontsize=8)
    ax.set_title(title, fontsize=10)
    ax.set_axis_off()
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--fields", nargs="*", default=list(FIELDS))
    ap.add_argument("--skip", nargs="*", default=[])
    ap.add_argument("--no-preview", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    for sub in ("raw", "labels", "gaia", "previews"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    report = {}
    for name in a.fields:
        f = FIELDS[name]
        print(f"\n=== {name} (RA={f['ra']}, Dec={f['dec']}) ===", flush=True)
        radius = (GROUND_SIZE_ARCMIN / 60) / np.sqrt(2) + 0.01
        gaia = query_gaia(f["ra"], f["dec"], radius, out / "gaia" / f"{name}.parquet")
        print(f"  Gaia DR3: {len(gaia)} kaynak (G<{GAIA_GMAX})", flush=True)
        report[name] = {"gaia_sources": int(len(gaia))}
        for sv in SURVEYS:
            if sv in a.skip or (sv == "hst" and not f["hst"]):
                continue
            fpath = out / "raw" / name / f"{sv}.fits"
            fpath.parent.mkdir(parents=True, exist_ok=True)
            try:
                if fpath.exists():
                    with fits.open(fpath) as h:
                        data, hdr = h[0].data.astype(np.float32), h[0].header
                else:
                    if sv == "hst":
                        data, hdr = fetch_hst(f["ra"], f["dec"], HST_SIZE_PX)
                    else:
                        data, hdr = {"sdss": fetch_sdss, "ps1": fetch_ps1, "legacy": fetch_legacy}[sv](
                            f["ra"], f["dec"], GROUND_SIZE_ARCMIN)
                    hdr["ORBI_FLD"] = name
                    hdr["ORBI_SRV"] = sv
                    fits.PrimaryHDU(data, header=hdr).writeto(fpath, overwrite=True)
            except Exception as e:
                print(f"  [{sv}] ATLANDI: {e}", flush=True)
                report[name][sv] = {"error": str(e)[:200]}
                continue
            lab = make_labels(data, hdr, gaia, f.get("crowded", False))
            lab.to_csv(out / "labels" / f"{name}_{sv}.csv", index=False)
            stats = sep_baseline(data, hdr, lab)
            stats.update(shape=list(data.shape), n_labels=int(len(lab)),
                         n_star_labels=int(lab.is_star.sum()), band=hdr.get("ORBI_BND"))
            report[name][sv] = stats
            print(f"  [{sv}] {data.shape} etiket={len(lab)} yildiz={lab.is_star.sum()} "
                  f"SEP recall={stats.get('recall_all', float('nan')):.3f} "
                  f"ofset={stats.get('median_offset_arcsec', float('nan')):.3f}\"", flush=True)
            if not a.no_preview:
                save_preview(data, lab, out / "previews" / f"{name}_{sv}.png",
                             f"{name} / {sv} ({hdr.get('ORBI_BND')})")
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print("\nRapor:", out / "report.json")


if __name__ == "__main__":
    main()
