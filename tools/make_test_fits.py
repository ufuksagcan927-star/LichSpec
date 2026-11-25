"""Write a small FITS test image with a TAN WCS centred on the Pleiades (1.2 deg field).

The pixels are noise plus Gaussian stars at the Hipparcos positions of the bright
catalogue, so the plate-solution check has both bright stars and Gaia sources in view.
"""
import json
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

out = Path(sys.argv[1] if len(sys.argv) > 1 else "pleiades.fits")
out.parent.mkdir(parents=True, exist_ok=True)
n, scale = 900, 1.2 / 900  # 900 px, 1.2 deg
w = WCS(naxis=2)
w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
w.wcs.crval = [56.75, 24.12]
w.wcs.crpix = [n / 2 + 0.5, n / 2 + 0.5]
w.wcs.cd = [[-scale, 0], [0, scale]]

rng = np.random.default_rng(1)
img = rng.normal(100, 5, (n, n)).astype(np.float32)
cat = json.loads((Path(__file__).resolve().parent.parent / "web/data/bright_stars.json").read_text())
cols = cat["meta"]["cols"]
iy, ix = np.mgrid[0:n, 0:n]
for row in cat["stars"]:
    s = dict(zip(cols, row))
    if abs(s["dec"] - 24.12) > 1 or abs(s["ra"] - 56.75) > 1.2:
        continue
    x, y = w.all_world2pix([[s["ra"], s["dec"]]], 0)[0]
    if 0 <= x < n and 0 <= y < n:
        amp = 5000 * 10 ** (-0.4 * (s["v"] - 3))
        img += (amp * np.exp(-((ix - x) ** 2 + (iy - y) ** 2) / (2 * 2.0 ** 2))).astype(np.float32)
fits.PrimaryHDU(img, header=w.to_header()).writeto(out, overwrite=True)
print("wrote", out)
