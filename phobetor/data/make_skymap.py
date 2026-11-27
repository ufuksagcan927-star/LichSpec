#!/usr/bin/env python3
"""Secilen Hubble alanlarinin gokyuzu haritasi + ornek etiketli goruntu (QA)."""
import sys
from pathlib import Path
import numpy as np, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from astropy.io import fits
from astropy.visualization import AsinhStretch, ImageNormalize, ZScaleInterval

root = Path(sys.argv[1] if len(sys.argv) > 1 else "data_hst")
s = pd.read_csv(root / "split.csv")
fig = plt.figure(figsize=(11, 6), dpi=110)
ax = fig.add_subplot(111, projection="aitoff")
for sp, c in [("train", "#2a7de1"), ("val", "#f2a20c"), ("test", "#d6336c")]:
    d = s[s.split == sp]
    ra = np.deg2rad(np.where(d.s_ra > 180, d.s_ra - 360, d.s_ra))
    ax.scatter(-ra, np.deg2rad(d.s_dec), s=9, c=c, label=f"{sp} ({len(d)})", alpha=0.85)
ax.grid(alpha=0.3); ax.set_xticklabels([]); ax.legend(loc="lower right", fontsize=9)
ax.set_title(f"Phobetor Hubble veri seti: {len(s)} alan (renk = egitim/dogrulama/test)", fontsize=11)
fig.tight_layout(); fig.savefig(root / "skymap.png"); plt.close(fig)

# ornek: en kalabalik test alani, orijinal + bir bozulmus kopya
t = s[s.split == "test"].field
cnt = {f: sum(1 for _ in open(root / "labels" / f"{f}.csv")) for f in t}
n = min(cnt, key=lambda f: abs(cnt[f] - 300))  # orta yogunlukta bir test alani
fig, axs = plt.subplots(1, 2, figsize=(12, 6.3), dpi=100)
for ax, img, lab, title in [(axs[0], f"raw/{n}.fits.gz", f"labels/{n}.csv", f"{n} orijinal"),
                            (axs[1], f"degraded/{n}_d0.fits.gz", f"labels_degraded/{n}_d0.csv", f"{n} bozulmus")]:
    d = fits.getdata(root / img).astype(float); d = np.nan_to_num(d, nan=np.nanmedian(d))
    l = pd.read_csv(root / lab); l = l[l.is_star]
    ax.imshow(d, origin="lower", cmap="gray", norm=ImageNormalize(d, interval=ZScaleInterval(), stretch=AsinhStretch()))
    ax.scatter(l.x, l.y, s=(d.shape[0] / 160) ** 2, facecolors="none", edgecolors="#00e5ff", lw=0.4)
    ax.set_title(f"{title} ({len(l)} nokta kaynak)", fontsize=10); ax.set_axis_off()
fig.tight_layout(); fig.savefig(root / "sample.png")
