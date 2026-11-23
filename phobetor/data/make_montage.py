#!/usr/bin/env python3
"""Ham ve bozulmus goruntulerden ornek bir karsilastirma paneli cizer (QA icin)."""
import sys
from pathlib import Path
import numpy as np, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from astropy.io import fits
from astropy.visualization import AsinhStretch, ImageNormalize, ZScaleInterval

root = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
items = [("raw/m67/legacy.fits", "labels/m67_legacy.csv", "M67 Legacy (orijinal)"),
         ("degraded/m67_legacy_d03.fits", "labels_degraded/m67_legacy_d03.csv", "M67 Legacy, bozulmus (2x piksel, 11x gurultu, uydu izi)"),
         ("raw/m3_out/hst.fits", "labels/m3_out_hst.csv", "M3 Hubble (orijinal)"),
         ("degraded/m3_out_hst_d04.fits", "labels_degraded/m3_out_hst_d04.csv", "M3 Hubble, bozulmus (4x piksel, uydu izi)"),
         ("raw/m67/ps1.fits", "labels/m67_ps1.csv", "M67 Pan-STARRS (orijinal)"),
         ("degraded/m67_ps1_d00.fits", "labels_degraded/m67_ps1_d00.csv", "M67 Pan-STARRS, bozulmus (bulanik, 4x gurultu)")]
fig, axs = plt.subplots(3, 2, figsize=(10, 15), dpi=100)
for ax, (img, lab, title) in zip(axs.flat, items):
    d = fits.getdata(root / img).astype(float)
    d = np.nan_to_num(d, nan=np.nanmedian(d))
    l = pd.read_csv(root / lab)
    ax.imshow(d, origin="lower", cmap="gray", norm=ImageNormalize(d, interval=ZScaleInterval(), stretch=AsinhStretch()))
    ax.scatter(l.x, l.y, s=(d.shape[0] / 90) ** 2, facecolors="none", edgecolors="#00e5ff", lw=0.5)
    ax.set_title(title, fontsize=9); ax.set_axis_off()
fig.tight_layout(); fig.savefig(root / "montage.png")
