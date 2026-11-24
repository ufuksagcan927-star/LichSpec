#!/usr/bin/env python3
"""
LichSpec / Phobetor - Euclid yildiz tespiti veri seti (v1). Veri surumu: Euclid Q1 (Mart 2025), IRSA.

Tek uydu (Euclid), ayni iki kamera (VIS + NISP), ayni 4 bant. Her ornek:
  goruntuler/<ad>.fits   1024x1024 piksel (0.1"/px = 102.4"x102.4"), 12 katman:
                          SCI_VIS, SCI_Y, SCI_J, SCI_H   (arka plani cikarilmis bilimsel goruntu)
                          RMS_VIS ... RMS_H              (piksel basina gurultu)
                          FLAG_VIS ... FLAG_H            (Euclid'in kendi hata haritasi, bit maskesi)
  etiketler/<ad>.csv     karedeki HER kaynak, Euclid'in resmi katalogundan (MER + PHZ):
                          x, y (piksel; numpy: dizi[y, x]), sinif (yildiz / galaksi / kuasar /
                          kuresel_kume / belirsiz / sahte), olasiliklar, parlakliklar, bayraklar, Gaia kimligi
  onizleme/<ad>.jpg      sadece bakmak icin renkli resim (mavi=VIS, yesil=Y+J, kirmizi=H)

Etiketlerin hicbiri bu betik tarafindan uretilmez; hepsi katalogdan oldugu gibi alinir.
Kataloglar karo basina resmi dosyalardan okunur (IRSA IBE): MER FINAL-CAT ve PHZ CLASSCAT.
Bolumler (train/val/test) gokyuzu bolgesine gore ayrilir (euclid_tiles_q1.csv).

Kullanim:
    python euclid_dataset.py --tiles euclid_tiles_q1.csv --out euclid_v1 --per-tile 8 --workers 3
"""
import argparse
import gzip
import io
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
import astropy.units as u

UA = {"User-Agent": "lichspec-phobetor-dataset/0.3"}
BANDS = ["VIS", "Y", "J", "H"]
KINDS = ["SCI", "RMS", "FLAG"]
SIZE = 1024
MER_COLS = ["object_id", "ra", "dec",
            "flux_vis_psf", "fluxerr_vis_psf", "flux_y_templfit", "fluxerr_y_templfit",
            "flux_j_templfit", "fluxerr_j_templfit", "flux_h_templfit", "fluxerr_h_templfit",
            "point_like_prob", "point_like_flag", "extended_prob", "spurious_prob", "spurious_flag",
            "det_quality_flag", "she_flag", "binary_flag", "variable_flag", "gaia_id", "gaia_match_quality",
            "vis_det", "mumax_minus_mag", "segmentation_area", "ellipticity", "fwhm",
            "flag_vis", "flag_y", "flag_j", "flag_h",
            "blended_prob", "deblended_flag", "mag_stargal_sep", "mu_max", "semimajor_axis", "position_angle",
            "kron_radius"]
PHZ_COLS = ["phz_classification", "phz_star_prob", "phz_gal_prob", "phz_qso_prob", "phz_glob_cl_prob"]
SINIF = {1: "yildiz", 2: "galaksi", 4: "kuasar", 8: "kuresel_kume"}


def log(msg, out):
    line = time.strftime("%H:%M:%S ") + msg
    print(line, flush=True)
    with open(out / "build_log.txt", "a") as f:
        f.write(line + "\n")


RELEASE = "q1"


IBE = "https://irsa.ipac.caltech.edu/ibe/data/euclid/q1/catalogs"


def _ibe_file(folder, tile, prefix):
    """Karo klasorundeki resmi katalog dosyasinin adresini bulur (IRSA IBE dizin listesi)."""
    url = f"{IBE}/{folder}/{int(tile)}/"
    for a in range(4):
        try:
            r = requests.get(url, timeout=60, headers=UA)
            r.raise_for_status()
            names = sorted(set(re.findall(r'href="(' + re.escape(prefix) + r'[^"]*\.fits)"', r.text)))
            if not names:
                raise RuntimeError(f"{prefix} bulunamadi: {url}")
            return url + names[-1]
        except Exception:  # noqa: BLE001
            if a == 3:
                raise
            time.sleep(10 * (a + 1))


def _download(url, path):
    for a in range(4):
        try:
            with requests.get(url, stream=True, timeout=300, headers=UA) as r:
                r.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in r.iter_content(1 << 22):
                        f.write(chunk)
            return path
        except Exception:  # noqa: BLE001
            if a == 3:
                raise
            time.sleep(15 * (a + 1))


def _read_cols(path, names):
    """Istenen sutunlari okur. Tamsayi sutunlarda katalogun 'bos' isareti (TNULL) gercek bos degere (NA) cevrilir."""
    out = {}
    with fits.open(path, memmap=True) as h:
        d, cols = h[1].data, h[1].columns
        for n in names:
            x = np.array(d[n])
            if x.dtype.byteorder not in ("=", "|"):
                x = x.astype(x.dtype.newbyteorder("="))
            null = cols[n].null
            if x.dtype.kind in "iu" and null is not None and str(null).strip() != "":
                a = pd.array(x, dtype="Int64")
                a[x == int(null)] = pd.NA
                out[n] = a
            else:
                out[n] = x
    return out


def tile_catalog(tile, cache: Path):
    """Karonun resmi Euclid Q1 kataloglari: MER FINAL-CAT (konum, akı, bayraklar) + PHZ CLASSCAT (siniflar).
    IRSA'daki euclid_q1_mer_catalogue / euclid_q1_phz_classification tablolarinin kaynak dosyalari."""
    p = cache / f"{tile}.parquet"
    if p.exists():
        return pd.read_parquet(p)
    mer_map = {c: c.upper() for c in MER_COLS}
    mer_map.update(ra="RIGHT_ASCENSION", dec="DECLINATION")
    tmp = cache / f"_tmp_{tile}_mer.fits"
    tmp2 = cache / f"_tmp_{tile}_phz.fits"
    try:
        _download(_ibe_file("MER_FINAL_CATALOG", tile, f"EUC_MER_FINAL-CAT_TILE{int(tile)}"), tmp)
        m = pd.DataFrame({c: v for c, v in zip(MER_COLS, _read_cols(tmp, [mer_map[c] for c in MER_COLS]).values())})
        _download(_ibe_file("PHZ_PF_OUTPUT_FOR_L3", tile, "EUC_PHZ_CLASSCAT_"), tmp2)
        z = _read_cols(tmp2, ["OBJECT_ID"] + [c.upper() for c in PHZ_COLS])
        z = pd.DataFrame({"object_id": z["OBJECT_ID"], **{c: z[c.upper()] for c in PHZ_COLS}})
    finally:
        for f in (tmp, tmp2):
            if f.exists():
                f.unlink()
    z = z.drop_duplicates("object_id")
    d = m.merge(z, on="object_id", how="left")
    d = d.drop_duplicates("object_id").reset_index(drop=True)
    d.to_parquet(p, index=False)
    return d


MER_IMG = "https://irsa.ipac.caltech.edu/ibe/data/euclid/q1/MER"


def tile_products(tile, ra=None, dec=None):
    """Karonun 12 MER mozaiginin (4 bant x bilimsel/RMS/FLAG) IRSA adresleri, IBE dizin listesinden."""
    t = int(tile)
    pats = {}
    for b in BANDS:
        cam, tag = ("VIS", "VIS") if b == "VIS" else ("NISP", f"NIR-{b}")
        pats[("SCI", b)] = (cam, f"EUC_MER_BGSUB-MOSAIC-{tag}_TILE{t}-")
        pats[("RMS", b)] = (cam, f"EUC_MER_MOSAIC-{tag}-RMS_TILE{t}-")
        pats[("FLAG", b)] = (cam, f"EUC_MER_MOSAIC-{tag}-FLAG_TILE{t}-")
    listing = {}
    for cam in ("VIS", "NISP"):
        url = f"{MER_IMG}/{t}/{cam}/"
        for a in range(4):
            try:
                r = requests.get(url, timeout=60, headers=UA)
                r.raise_for_status()
                listing[cam] = (url, sorted(set(re.findall(r'href="(EUC_MER_[^"]+\.fits)"', r.text))))
                break
            except Exception:  # noqa: BLE001
                if a == 3:
                    raise
                time.sleep(10 * (a + 1))
    prods = {}
    for key, (cam, prefix) in pats.items():
        url, names = listing[cam]
        hits = [n for n in names if n.startswith(prefix)]
        if hits:
            prods[key] = url + hits[-1]
    missing = [(k, b) for k in KINDS for b in BANDS if (k, b) not in prods]
    if missing:
        raise RuntimeError(f"eksik urun: {missing}")
    return prods


def fetch_cut(url, ra, dec, size_arcsec):
    full = f"{url}?center={ra:.7f},{dec:.7f}&size={size_arcsec:.1f}arcsec&gzip=true"
    err = None
    for a in range(4):
        try:
            r = requests.get(full, timeout=600, headers=UA)
            r.raise_for_status()
            raw = r.content
            if raw[:2] == b"\x1f\x8b":  # IRSA gzip=true yaniti: application/gzip
                raw = gzip.decompress(raw)
            h = fits.open(io.BytesIO(raw))
            hdu = [x for x in h if x.data is not None][0]
            return hdu.data, hdu.header
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(10 * (a + 1))
    raise err


def crop(data, hdr, ra, dec):
    w = WCS(hdr, naxis=2)
    px, py = w.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
    x0 = int(np.floor(float(px) + 0.5)) - SIZE // 2
    y0 = int(np.floor(float(py) + 0.5)) - SIZE // 2
    ny, nx = data.shape
    if x0 < 0 or y0 < 0 or x0 + SIZE > nx or y0 + SIZE > ny:
        raise RuntimeError(f"kesit kucuk: {data.shape} x0={x0} y0={y0}")
    return data[y0:y0 + SIZE, x0:x0 + SIZE], w[y0:y0 + SIZE, x0:x0 + SIZE]


def preview(sci):
    from astropy.visualization import make_lupton_rgb
    vis, y, j, h = [np.nan_to_num(sci[b].astype(float)) for b in BANDS]
    s = max(np.percentile(vis[vis != 0], 99.0) if (vis != 0).any() else 1.0, 1e-6)

    def norm(a):
        nz = a[a != 0]
        p = np.percentile(nz, 99.0) if nz.size else 1.0
        return a / max(p, 1e-9) * s
    return make_lupton_rgb(norm(h), norm(y + j), vis, stretch=s * 0.5, Q=8)


def overlay(img, lab, path):
    from PIL import Image, ImageDraw
    colors = {"yildiz": (0, 229, 255), "galaksi": (255, 152, 0), "kuasar": (255, 64, 255),
              "kuresel_kume": (118, 255, 3), "belirsiz": (189, 189, 189), "sahte": (255, 23, 68)}
    im = Image.fromarray(img).convert("RGB")
    d = ImageDraw.Draw(im)
    for r in lab.itertuples():
        c = colors.get(r.sinif, (255, 255, 255))
        if r.sinif == "sahte":
            d.line([(r.x - 6, r.y - 6), (r.x + 6, r.y + 6)], fill=c, width=2)
            d.line([(r.x - 6, r.y + 6), (r.x + 6, r.y - 6)], fill=c, width=2)
        else:
            d.ellipse([r.x - 9, r.y - 9, r.x + 9, r.y + 9], outline=c, width=2)
    im.save(path, quality=90)


def labels_for(cat, w):
    x, y = w.world_to_pixel(SkyCoord(cat.ra.values * u.deg, cat.dec.values * u.deg))
    m = (x >= -0.5) & (x < SIZE - 0.5) & (y >= -0.5) & (y < SIZE - 0.5)
    lab = cat[m].copy()
    lab.insert(1, "x", np.round(x[m], 3))
    lab.insert(2, "y", np.round(y[m], 3))
    cls = lab.phz_classification.astype("Int64")
    s = cls.map(SINIF).fillna("belirsiz").astype(str)
    s[(lab.spurious_flag.astype("Int64") == 1).fillna(False).astype(bool).values] = "sahte"
    lab.insert(3, "sinif", s.values)
    for b, c in (("vis", "flux_vis_psf"), ("y", "flux_y_templfit"), ("j", "flux_j_templfit"), ("h", "flux_h_templfit")):
        f = lab[c].astype(float)
        lab[f"mag_{b}"] = np.where(f > 0, 23.9 - 2.5 * np.log10(np.where(f > 0, f, 1.0)), np.nan).round(4)
    g = lab.gaia_id.astype("Int64")
    lab["gaia_id"] = g.astype("string").fillna("").where(g.fillna(0) > 0, "")
    return lab.reset_index(drop=True)


def make_sample(tile, k, ra, dec, prods, cat, row, out, pool):
    name = f"euc_{int(tile)}_{k}"
    part = row.bolum
    lp = out / part / "etiketler" / f"{name}.csv"
    if lp.exists():
        return name, "var"
    size_arcsec = (SIZE + 24) * 0.1
    futs = {pool.submit(fetch_cut, prods[(kd, b)], ra, dec, size_arcsec): (kd, b) for kd in KINDS for b in BANDS}
    raw = {}
    for f in as_completed(futs):
        raw[futs[f]] = f.result()
    arrs, wcs_ref = {}, None
    for (kd, b), (data, hdr) in raw.items():
        a, w = crop(data, hdr, ra, dec)
        arrs[(kd, b)] = (a, w, hdr)
        if (kd, b) == ("SCI", "VIS"):
            wcs_ref = w
    # tum katmanlar ayni piksel izgarasinda mi?
    c0 = wcs_ref.pixel_to_world(0, 0)
    for (kd, b), (a, w, _) in arrs.items():
        if c0.separation(w.pixel_to_world(0, 0)).arcsec > 0.02:
            raise RuntimeError(f"izgara uyusmuyor: {kd} {b}")
    vis = arrs[("SCI", "VIS")][0]
    cov = float(np.mean(np.isfinite(vis) & (vis != 0)))
    nir_cov = min(float(np.mean(np.isfinite(arrs[("SCI", b)][0]) & (arrs[("SCI", b)][0] != 0))) for b in ("Y", "J", "H"))
    if cov < 0.95 or nir_cov < 0.95:  # kismi kapsanan kesitler (bos seritler, kenarlar) alinmaz
        return name, f"atlandi kapsama vis={cov:.2f} nir={nir_cov:.2f}"
    lab = labels_for(cat, wcs_ref)
    whdr = wcs_ref.to_header()
    prim = fits.Header()
    prim["TELESCOP"] = "Euclid"
    prim["ORBI_TIL"] = (int(tile), "Euclid MER karo kimligi")
    prim["ORBI_K"] = (int(k), "karo icindeki kesit sirasi")
    prim["ORBI_RA"] = (round(ra, 7), "kesit merkezi RA (deg)")
    prim["ORBI_DEC"] = (round(dec, 7), "kesit merkezi Dec (deg)")
    prim["ORBI_GL"] = (round(float(row.l), 4), "galaktik boylam")
    prim["ORBI_GB"] = (round(float(row.b), 4), "galaktik enlem")
    prim["ORBI_PRT"] = (part, "bolum")
    prim["ORBI_COV"] = (round(cov, 4), "VIS kapsama orani")
    prim["PIXSCALE"] = (0.1, "arcsec/piksel")
    prim["COMMENT"] = "Katmanlar: SCI_<bant>, RMS_<bant>, FLAG_<bant>; bantlar VIS, Y, J, H. Ayni piksel izgarasi."
    prim["ORBI_REL"] = (RELEASE.upper(), "Euclid veri surumu")
    prim["COMMENT"] = "AB parlaklik = MAGZERO - 2.5*log10(piksel degeri toplami). Kaynak: Euclid (ESA), IRSA."
    hdus = [fits.PrimaryHDU(header=prim)]
    for kd in KINDS:
        for b in BANDS:
            a, w, src = arrs[(kd, b)]
            h = whdr.copy()
            for key in ("MAGZERO", "FILTER", "BUNIT"):
                if key in src:
                    h[key] = src[key]
            h["EXTNAME"] = f"{kd}_{b}"
            if kd == "FLAG":  # bit maskesi: kayipsiz (GZIP_2 bu haritalarda RICE'tan ~8 kat kucuk)
                hdus.append(fits.CompImageHDU(np.asarray(a, dtype=np.int32), header=h, compression_type="GZIP_2"))
            else:  # SCI: gurultunun 1/16'si adim; RMS: 1/4 adim (goreli hata < %0.5)
                hdus.append(fits.CompImageHDU(np.asarray(a, dtype=np.float32), header=h, compression_type="RICE_1",
                                              quantize_level=16.0 if kd == "SCI" else 4.0, quantize_method=2))
    for sub in ("goruntuler", "etiketler", "onizleme"):
        (out / part / sub).mkdir(parents=True, exist_ok=True)
    fits.HDUList(hdus).writeto(out / part / "goruntuler" / f"{name}.fits", overwrite=True)
    img = preview({b: arrs[("SCI", b)][0] for b in BANDS})
    from PIL import Image
    Image.fromarray(img).save(out / part / "onizleme" / f"{name}.jpg", quality=90)
    if k == 0:
        (out / "kontrol").mkdir(exist_ok=True)
        overlay(img, lab, out / "kontrol" / f"{name}_etiketli.jpg")
    lab.to_csv(lp, index=False)
    n = lab.sinif.value_counts().to_dict()
    return name, f"kaynak={len(lab)} yildiz={n.get('yildiz', 0)} galaksi={n.get('galaksi', 0)} sahte={n.get('sahte', 0)} kapsama={cov:.2f}"


def centers(cat, ra, dec, per_tile, seed):
    """Karo icinde 5x5 aday merkez (0.1 derece aralik, kesitler cakismaz). Kenar karolarda gorunturun bir kismi
    bos oldugu icin, katalogdaki kaynak yogunlugu tam kapsama duzeyinde olan adaylar arasindan rastgele secer.
    Secimde yildiz sayisina bakilmaz; sadece kapsama."""
    half = (SIZE / 2) * 0.1 / 3600
    cosd = np.cos(np.deg2rad(dec))
    x = ((cat.ra.values - ra + 180) % 360 - 180) * cosd
    y = cat.dec.values - dec
    grid = np.arange(-2, 3) * 0.1
    cands, counts = [], []
    for oy in grid:
        for ox in grid:
            cands.append((ox, oy))
            counts.append(int(((np.abs(x - ox) < half) & (np.abs(y - oy) < half)).sum()))
    counts = np.array(counts)
    if not (counts > 0).any():
        return []
    ref = np.median(counts[counts > 0])
    ok = [i for i in range(len(cands)) if counts[i] >= 0.6 * ref]
    rng = np.random.default_rng(seed)
    pick = sorted(rng.choice(ok, size=min(per_tile, len(ok)), replace=False).tolist())
    return [((ra + cands[i][0] / cosd) % 360, dec + cands[i][1]) for i in pick]


def do_tile(row, out, per_tile, pool):
    tile = int(row.tile)
    t0 = time.time()
    cat = tile_catalog(tile, out / "_katalog_onbellek")
    prods = tile_products(tile, row.ra, row.dec)
    res = []
    for k, (ra, dec) in enumerate(centers(cat, row.ra, row.dec, per_tile, tile)):
        try:
            res.append(make_sample(tile, k, ra, dec, prods, cat, row, out, pool))
        except Exception as e:  # noqa: BLE001
            res.append((f"euc_{tile}_{k}", "HATA: " + str(e)[:160]))
            with open(out / "errors.txt", "a") as f:
                f.write(f"{tile} {k}\n{traceback.format_exc()}\n")
    return tile, len(cat), res, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", default="euclid_tiles_q1.csv")
    ap.add_argument("--out", default="euclid_v1")
    ap.add_argument("--per-tile", type=int, default=8)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    out = Path(a.out)
    (out / "_katalog_onbellek").mkdir(parents=True, exist_ok=True)
    tiles = pd.read_csv(a.tiles)
    if a.limit:
        tiles = tiles.head(a.limit)
    dl_pool = ThreadPoolExecutor(4 * a.workers)
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(do_tile, r, out, a.per_tile, dl_pool): int(r.tile) for r in tiles.itertuples()}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                tile, ncat, res, dt = f.result()
                log(f"[{i}/{len(tiles)}] karo {tile} katalog={ncat} sure={dt:.0f}s", out)
                for name, msg in res:
                    log(f"    {name} {msg}", out)
            except Exception as e:  # noqa: BLE001
                log(f"[{i}/{len(tiles)}] karo {futs[f]} HATA: {str(e)[:200]}", out)
                with open(out / "errors.txt", "a") as fh:
                    fh.write(f"{futs[f]}\n{traceback.format_exc()}\n")
    dl_pool.shutdown()


if __name__ == "__main__":
    main()
