#!/usr/bin/env python3
"""
Test photos for the in-browser photo solver (tools/photo_check.js).

    python tools/make_test_photos.py <out-dir> [--real]

1. Synthetic phone-like night photos rendered from web/data/bright_stars.json: gnomonic lens with
   optional barrel distortion, Gaussian + Moffat star profiles, sky glow with a gradient, photon and read
   noise, in-camera blur, sRGB tone curve, JPEG compression, a dark foreground and trailed stars in some,
   plus a stacked camera photo in which every star brighter than about V 5 is clipped at 255.
   The true pointing is known, so the solution can be checked exactly.
2. With --real: real sky images. Mellinger all-sky photographic mosaic cut out by the CDS hips2fits
   service in gnomonic projection (wide fields like a phone or camera), and a few freely licensed camera
   photos of Orion from Wikimedia Commons (downloaded only for the test, never committed).

Writes <out-dir>/cases.json: [{file, kind, expect: {ra, dec, fov?, within_deg}, must_solve}].
"""
import io
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

D2R = np.pi / 180
ROOT = Path(__file__).resolve().parent.parent

SYNTH = {
    # dark sky, main camera (26 mm equivalent, 4:3), Orion
    "orion_main": dict(ra=84, dec=0, roll=8, hfov=67, size=[1024, 768], fwhm=2.0, m0=11.4, sky=40, white=2500, q=85, nr=0.5, grad=0.6),
    # city sky, Big Dipper, strong gradient, dark foreground: only ~12 stars visible
    "uma_city": dict(ra=175, dec=55, roll=-20, hfov=67, size=[1024, 768], fwhm=2.4, m0=10.7, sky=400, white=6000, read=4, q=80, nr=0.7, grad=2.0, fg=0.18, skycol=[1.2, 1.0, 0.75]),
    # 3x telephoto, Taurus and the Pleiades, portrait
    "taurus_tele": dict(ra=60, dec=22, roll=95, hfov=25, size=[768, 1024], fwhm=2.2, m0=12.6, sky=60, white=3000, q=88, nr=0.4, grad=0.3),
    # ultrawide, Cygnus and the summer triangle, barrel distortion
    "cygnus_ultrawide": dict(ra=300, dec=38, roll=40, hfov=100, size=[1024, 768], fwhm=1.8, m0=10.6, sky=50, white=2500, q=82, nr=0.5, grad=0.8, k1=-0.03),
    # Cassiopeia, trailed stars (long hand-held exposure)
    "cas_trailed": dict(ra=15, dec=60, roll=170, hfov=67, size=[1024, 768], fwhm=2.0, ell=1.2, ell_pa=0.6, m0=11.7, sky=120, white=3500, q=80, nr=0.6, grad=1.0),
    # Scorpius, heavy noise reduction and JPEG, foreground
    "sco_main": dict(ra=250, dec=-30, roll=-60, hfov=67, size=[1024, 768], fwhm=2.6, m0=11.2, sky=150, white=4000, read=4, q=70, nr=1.0, grad=1.2, fg=0.1),
    # camera on a tripod, many exposures stacked: every star brighter than about V 5 is clipped at 255,
    # so the brightest stars can only be told apart by the size of their clipped core and halo
    "orion_deep_stack": dict(ra=84, dec=-1, roll=-10, hfov=40, size=[1600, 1067], fwhm=4.5, m0=14.0, sky=10, white=150, read=2, q=90, nr=0.3, grad=0.4,
                             kind="synthetic camera stack"),
}

# Mellinger cut-outs: (name, ra, dec, fov_deg along the long side, rotation, width, height)
MELLINGER = [
    ("mellinger_orion_60", 84.0, 2.0, 60, 15, 1024, 768),
    ("mellinger_cygnus_90", 305.0, 40.0, 90, -30, 1024, 768),
    ("mellinger_sco_35", 250.0, -28.0, 35, 0, 768, 1024),
    ("mellinger_uma_70", 170.0, 55.0, 70, 160, 1024, 683),
]

# Freely licensed camera photos of Orion on Wikimedia Commons (resized by Commons to 1600 px).
COMMONS = [
    "Orion_Constellation1.jpg",
    "Orion_Constellation_with_40mm_lens.jpg",
    "Constellation_Orion_from_Grand_Canyon.jpg",
    "2012-02-21_21-01-50-orion-78f-12d-11o.jpg",
]


def load_catalog():
    cat = json.loads((ROOT / "web/data/bright_stars.json").read_text(encoding="utf-8"))
    cols = cat["meta"]["cols"]
    col = lambda k: [r[cols.index(k)] for r in cat["stars"]]
    v = np.array([x if x is not None else 99 for x in col("v")], float)
    bv = np.array([x if x is not None else 0.6 for x in col("bv")], float)
    return np.array(col("ra"), float), np.array(col("dec"), float), v, bv


def render(c, out, cat, seed):
    RA, DEC, V, BV = cat
    rng = np.random.default_rng(seed)
    W, H = c["size"]
    f = (W / 2) / np.tan(c["hfov"] / 2 * D2R)
    a, d, a0, d0 = RA * D2R, DEC * D2R, c["ra"] * D2R, c["dec"] * D2R
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    xi = np.cos(d) * np.sin(a - a0) / cosc
    eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
    th = c["roll"] * D2R
    u = -xi * np.cos(th) + eta * np.sin(th)          # seen from inside: east is to the left
    v = xi * np.sin(th) + eta * np.cos(th)
    k = 1 + c.get("k1", 0.0) * (u * u + v * v)
    x, y = W / 2 - 0.5 + f * u * k, H / 2 - 0.5 - f * v * k
    idx = np.nonzero((cosc > 0.2) & (x > -10) & (x < W + 10) & (y > -10) & (y < H + 10) & (V < 8))[0]
    img = np.zeros((H, W, 3))
    sig, e, halo = c["fwhm"] / 2.355, c.get("ell", 0.0), 0.04
    for i in idx:
        F = 10 ** (-0.4 * (V[i] - c["m0"]))
        rad = int(np.ceil(max(4 * sig, 3 + 1.5 * max(0, 3 - V[i])) * 1.2 * (1 + e)))
        xa, xb = max(0, int(x[i]) - rad), min(W, int(x[i]) + rad + 1)
        ya, yb = max(0, int(y[i]) - rad), min(H, int(y[i]) + rad + 1)
        if xa >= xb or ya >= yb:
            continue
        yy, xx = np.mgrid[ya:yb, xa:xb]
        dx, dy = xx - x[i], yy - y[i]
        if e:
            pa = c.get("ell_pa", 0.3)
            p, q = dx * np.cos(pa) + dy * np.sin(pa), -dx * np.sin(pa) + dy * np.cos(pa)
            d2 = (p / (1 + e)) ** 2 + q ** 2
        else:
            d2 = dx * dx + dy * dy
        core = np.exp(-d2 / (2 * sig * sig)) / (2 * np.pi * sig * sig * (1 + e))
        hs = 3.5 * sig
        prof = (1 - halo) * core + halo * (1 + d2 / (hs * hs)) ** -2.5 * (1.5 / (np.pi * hs * hs))
        t = np.clip((BV[i] + 0.3) / 2.0, 0, 1)
        col = np.array([0.75 + 0.25 * t, 0.85 - 0.1 * t * t, 1.0 - 0.55 * t])
        img[ya:yb, xa:xb] += F * prof[..., None] * col
    yy, xx = np.mgrid[0:H, 0:W]
    g = c.get("grad", 0.0)
    glow = c["sky"] * (1 + g * (yy / H) ** 2 + 0.15 * g * (xx / W))
    img += glow[..., None] * np.array(c.get("skycol", [0.8, 0.9, 1.1]))
    if c.get("fg"):
        edge = H * (1 - c["fg"]) + 0.04 * H * np.sin(xx[0] / W * 9 + 1) + 0.02 * H * np.sin(xx[0] / W * 37)
        img[yy > edge[None, :]] = c["sky"] * 0.35 * np.array([1.0, 0.9, 0.8])
    img = rng.poisson(np.maximum(img, 0)).astype(float) + rng.normal(0, c.get("read", 3.0), img.shape)
    lin = np.clip(img / c["white"], 0, 1)
    srgb = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    pil = Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    if c.get("nr"):
        pil = pil.filter(ImageFilter.GaussianBlur(c["nr"]))
    pil.save(out, quality=c.get("q", 85))


def fetch(url, timeout=90, report=False):
    req = urllib.request.Request(url, headers={"User-Agent": "LichSpec-test/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:  # say what the service answered
        if report:
            print("  ", url, "->", e.code, e.read()[:400].decode("utf-8", "replace").replace("\n", " "))
        raise


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cases = []
    cat = load_catalog()
    for n, (name, c) in enumerate(SYNTH.items()):
        render(c, out / f"{name}.jpg", cat, seed=n + 1)
        cases.append(dict(file=f"{name}.jpg", kind=c.get("kind", "synthetic phone-like"), must_solve=True,
                          expect=dict(ra=c["ra"], dec=c["dec"], fov=c["hfov"], within_deg=0.5)))
        print("made", name)
    if "--real" in sys.argv:
        for name, ra, dec, fov, rot, w, h in MELLINGER:
            q = urllib.parse.urlencode(dict(hips="CDS/P/Mellinger/color", width=w, height=h, fov=fov, projection="TAN",
                                            coordsys="icrs", ra=ra, dec=dec, rotation_angle=rot, format="jpg"))
            try:
                data = fetch("https://alasky.cds.unistra.fr/hips-image-services/hips2fits?" + q, report=True)
                Image.open(io.BytesIO(data)).verify()
                (out / f"{name}.jpg").write_bytes(data)
                cases.append(dict(file=f"{name}.jpg", kind="real sky (Mellinger via hips2fits)", must_solve=True,
                                  expect=dict(ra=ra, dec=dec, fov=fov, within_deg=1.0)))
                print("fetched", name, len(data), "bytes")
            except Exception as e:  # service down: report, the check skips it
                print("could not fetch", name, e)
        for fname in COMMONS:
            try:
                data = fetch("https://commons.wikimedia.org/wiki/Special:FilePath/" + fname + "?width=1600")
                Image.open(io.BytesIO(data)).verify()
                local = "commons_" + fname.replace("/", "_")
                (out / local).write_bytes(data)
                # only the target is known: Orion's centre (Alnilam), within 30 degrees
                cases.append(dict(file=local, kind="real camera photo (Wikimedia Commons)", must_solve=False,
                                  source="https://commons.wikimedia.org/wiki/File:" + fname,
                                  expect=dict(ra=84.05, dec=-1.2, within_deg=30)))
                print("fetched", fname, len(data), "bytes")
            except Exception as e:
                print("could not fetch", fname, e)
    (out / "cases.json").write_text(json.dumps(cases, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
