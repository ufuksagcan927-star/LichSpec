#!/usr/bin/env python3
"""
LichSpec / Phobetor - sentetik kalite dusurme.

Yuksek kaliteli goruntulerden (HST, Legacy Survey, Pan-STARRS) bulaniklastirma,
cozunurluk dusurme, gurultu, kozmik isin, uydu izi ve 8-bit sikistirma ile
daha kotu kalitede kopyalar uretir. Etiketler (Gaia konumlari) her donusume gore
yeniden hesaplanir, boylece model "her kalitede" ayni yildizlari bulmayi ogrenir.

Kullanim:
    python degrade.py --data data --variants 6 --seed 42
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from scipy.ndimage import gaussian_filter

HQ_SURVEYS = ("hst", "legacy", "ps1")


def block_reduce(img, k):
    if k == 1:
        return img
    ny, nx = (img.shape[0] // k) * k, (img.shape[1] // k) * k
    return np.nanmean(img[:ny, :nx].reshape(ny // k, k, nx // k, k), axis=(1, 3))


def add_trail(img, rng, amp):
    ny, nx = img.shape
    x0, y0 = rng.uniform(0, nx), rng.uniform(0, ny)
    ang = rng.uniform(0, np.pi)
    yy, xx = np.mgrid[0:ny, 0:nx]
    d = np.abs((xx - x0) * np.sin(ang) - (yy - y0) * np.cos(ang))
    img += amp * np.exp(-0.5 * (d / rng.uniform(0.7, 2.0)) ** 2)


def degrade(img, rng):
    """Rastgele bir bozulma zinciri uygular. (yeni_goruntu, k, parametreler) dondurur."""
    p = {}
    finite = np.isfinite(img)
    work = np.where(finite, img, np.nanmedian(img)).astype(np.float64)
    _, med, rms = sigma_clipped_stats(work[::4, ::4], sigma=3)
    rms = max(rms, 1e-6)

    # 1) Atmosfer / optik bulaniklik (PSF genisletme)
    p["blur_sigma_px"] = float(rng.choice([0, rng.uniform(0.6, 1.5), rng.uniform(1.5, 4.0)]))
    if p["blur_sigma_px"] > 0:
        work = gaussian_filter(work, p["blur_sigma_px"])

    # 2) Daha buyuk piksel (dusuk cozunurluklu dedektor)
    k = int(rng.choice([1, 1, 2, 3, 4]))
    p["downsample"] = k
    work = block_reduce(work, k)
    fmask = block_reduce(finite.astype(float), k) > 0.5

    # 3) Gurultu: arka plan gurultusunu f kat artir + kaynaga bagli Poisson
    _, med2, rms2 = sigma_clipped_stats(work[::2, ::2], sigma=3)
    f = float(rng.choice([1.0, rng.uniform(2, 5), rng.uniform(5, 20)]))
    p["noise_factor"] = f
    extra = rms2 * np.sqrt(max(f ** 2 - 1, 0))
    gain_like = (rms2 * f) ** 2 / max(abs(med2), rms2) if f > 1 else 0
    src = np.clip(work - med2, 0, None)
    shot = np.sqrt(src * gain_like / 50.0) if gain_like else 0
    work = work + rng.normal(0, 1, work.shape) * np.sqrt(extra ** 2 + np.square(shot))

    # 4) Gok parlakligi gradyani (isik kirliligi / ay)
    if rng.random() < 0.4:
        ny, nx = work.shape
        gx, gy = rng.normal(0, 1, 2)
        yy, xx = np.mgrid[0:ny, 0:nx] / max(nx, ny)
        amp = rms2 * f * rng.uniform(2, 20)
        work += amp * (gx * xx + gy * yy)
        p["sky_gradient"] = float(amp)

    # 5) Kozmik isinlar / sicak pikseller
    n_cr = int(rng.integers(0, 60))
    if n_cr:
        ys = rng.integers(0, work.shape[0], n_cr)
        xs = rng.integers(0, work.shape[1], n_cr)
        work[ys, xs] += rms2 * f * rng.uniform(20, 300, n_cr)
    p["cosmic_rays"] = n_cr

    # 6) Uydu izi
    if rng.random() < 0.25:
        add_trail(work, rng, rms2 * f * rng.uniform(5, 50))
        p["satellite_trail"] = True

    # 7) 8-bit asinh sikistirma (amator / JPEG benzeri dinamik aralik kaybi)
    if rng.random() < 0.3:
        lo, hi = np.percentile(work, [1, 99.8])
        x = np.arcsinh(np.clip((work - lo) / (hi - lo + 1e-12), 0, None) * 10) / np.arcsinh(10)
        work = np.round(np.clip(x, 0, 1) * 255).astype(np.float32)
        p["quantized_8bit"] = True

    work[~fmask] = np.nan
    return work.astype(np.float32), k, p


def snr_at(img, xs, ys, r):
    """Etiket konumlarinda kaba SNR tahmini (aperture toplami / gurultu)."""
    from photutils.aperture import CircularAperture, CircularAnnulus, aperture_photometry
    good = np.isfinite(img)
    d = np.where(good, img, 0)
    _, _, rms = sigma_clipped_stats(d[good][::3], sigma=3)
    pos = np.c_[xs, ys]
    ap = CircularAperture(pos, r=r)
    an = CircularAnnulus(pos, r_in=2.5 * r, r_out=4 * r)
    t = aperture_photometry(d, [ap, an])
    bkg = t["aperture_sum_1"] / an.area
    flux = t["aperture_sum_0"] - bkg * ap.area
    return np.asarray(flux / (rms * np.sqrt(ap.area) + 1e-12))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--variants", type=int, default=6)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    root = Path(a.data)
    out_img = root / "degraded"
    out_lab = root / "labels_degraded"
    out_img.mkdir(exist_ok=True)
    out_lab.mkdir(exist_ok=True)
    rng = np.random.default_rng(a.seed)
    meta = {}
    for f in sorted((root / "raw").glob("*/*.fits")):
        field, sv = f.parent.name, f.stem
        if sv not in HQ_SURVEYS:
            continue
        lab_path = root / "labels" / f"{field}_{sv}.csv"
        if not lab_path.exists():
            continue
        lab = pd.read_csv(lab_path)
        with fits.open(f) as h:
            img, hdr = h[0].data.astype(np.float32), h[0].header
        w = WCS(hdr, naxis=2)
        for i in range(a.variants):
            d, k, p = degrade(img, rng)
            name = f"{field}_{sv}_d{i:02d}"
            nl = lab.copy()
            nl["x"] = (nl.x + 0.5) / k - 0.5
            nl["y"] = (nl.y + 0.5) / k - 0.5
            ny, nx = d.shape
            nl = nl[(nl.x >= 0) & (nl.x < nx - 1) & (nl.y >= 0) & (nl.y < ny - 1)].reset_index(drop=True)
            r = max(2.0, 1.5 * (1 + p["blur_sigma_px"] / k))
            nl["snr_est"] = snr_at(d, nl.x.values, nl.y.values, r) if len(nl) else []
            nl["detectable"] = nl.snr_est > 5
            nw = w[::k, ::k] if k > 1 else w
            h2 = nw.to_header()
            for kk in ("ORBI_FLD", "ORBI_SRV", "ORBI_BND", "ORBI_EPO"):
                if kk in hdr:
                    h2[kk] = hdr[kk]
            h2["ORBI_DEG"] = json.dumps(p)[:68]
            fits.PrimaryHDU(d, header=h2).writeto(out_img / f"{name}.fits", overwrite=True)
            nl.to_csv(out_lab / f"{name}.csv", index=False)
            p.update(source=f"raw/{field}/{sv}.fits", shape=list(d.shape),
                     n_labels=int(len(nl)), n_detectable=int(nl.detectable.sum()))
            meta[name] = p
            print(name, p, flush=True)
    (root / "degraded_meta.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
