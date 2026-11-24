"""LichSpec sky-explorer prototype backend.

Serves the static site in ../web and a small JSON API:

  GET  /api/gaia/cone?ra=..&dec=..&r=..   Gaia DR3 sources (+ astrophysical params)
                                          near a point, r in arcsec. Proxied
                                          because the ESA TAP has no CORS.
  POST /api/solve                         upload an image. FITS with a celestial
                                          WCS is solved locally; any other image
                                          (or FITS without WCS) is sent to
                                          Astrometry.net (needs ASTROMETRY_API_KEY).
  GET  /api/solve/<id>                    poll an Astrometry.net submission.

Every solved field returns the same shape: centre, radius, footprint corners,
a PNG preview of the photo, and the stars identified in it (bright catalogue
+ Gaia DR3) with their pixel positions on the photo.

Run:  pip install -r server/requirements.txt && python server/app.py
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import time
import uuid
import warnings
from pathlib import Path

import numpy as np
import requests
from flask import Flask, abort, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
NOVA = os.environ.get("ASTROMETRY_URL", "https://nova.astrometry.net")
NOVA_KEY = os.environ.get("ASTROMETRY_API_KEY", "")
MAX_UPLOAD = 60 * 1024 * 1024

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD

# --------------------------------------------------------------------------
# Bright-star catalogue (same file the browser uses)
# --------------------------------------------------------------------------
_cat = json.loads((WEB / "data" / "bright_stars.json").read_text(encoding="utf-8"))
COLS = _cat["meta"]["cols"]
STARS = _cat["stars"]
CAT_RA = np.array([s[1] for s in STARS], dtype=float)
CAT_DEC = np.array([s[2] for s in STARS], dtype=float)


def star_dict(row):
    return {c: v for c, v in zip(COLS, row) if v is not None}


# --------------------------------------------------------------------------
# Gaia DR3
# --------------------------------------------------------------------------
GAIA_COLS = """g.source_id, g.ra, g.dec, g.phot_g_mean_mag, g.bp_rp, g.parallax,
 g.parallax_error, g.radial_velocity, ap.teff_gspphot, ap.logg_gspphot,
 ap.mh_gspphot, ap.distance_gspphot, ap.radius_gspphot, ap.mh_gspspec,
 ap.fem_gspspec, ap.alphafe_gspspec, ap.spectraltype_esphs,
 ap.classprob_dsc_combmod_star, ap.classprob_dsc_combmod_galaxy,
 ap.classprob_dsc_combmod_quasar"""


def gaia_query(adql: str, timeout=60):
    r = requests.post(
        GAIA_TAP,
        data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql},
        timeout=timeout,
    )
    r.raise_for_status()
    j = r.json()
    names = [m["name"] for m in j["metadata"]]
    out = []
    for row in j["data"]:
        d = {}
        for k, v in zip(names, row):
            if v is None or (isinstance(v, float) and math.isnan(v)):
                continue
            d[k] = str(v) if k == "source_id" else v
        out.append(d)
    return out


def gaia_cone(ra, dec, r_deg, gmax=None, top=50):
    where = (
        f"1=CONTAINS(POINT('ICRS', g.ra, g.dec), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {r_deg:.7f}))"
    )
    if gmax is not None:
        where += f" AND g.phot_g_mean_mag < {gmax:.2f}"
    q = (
        f"SELECT TOP {int(top)} {GAIA_COLS}, "
        f"DISTANCE(POINT('ICRS', g.ra, g.dec), POINT('ICRS', {ra:.7f}, {dec:.7f}))*3600 AS sep_arcsec "
        "FROM gaiadr3.gaia_source AS g "
        "LEFT JOIN gaiadr3.astrophysical_parameters AS ap ON ap.source_id = g.source_id "
        f"WHERE {where} ORDER BY g.phot_g_mean_mag ASC"
    )
    return gaia_query(q)


@app.get("/api/gaia/cone")
def api_gaia_cone():
    try:
        ra = float(request.args["ra"])
        dec = float(request.args["dec"])
        r = min(float(request.args.get("r", 15)), 600.0)  # arcsec
    except (KeyError, ValueError):
        abort(400, "ra, dec (deg) and r (arcsec) required")
    try:
        rows = gaia_cone(ra, dec, r / 3600.0, top=25)
    except Exception as e:  # network / archive down
        return jsonify({"ok": False, "error": f"Gaia arşivine ulaşılamadı: {e}"}), 502
    rows.sort(key=lambda d: d.get("sep_arcsec", 1e9))
    return jsonify({"ok": True, "sources": rows})


# --------------------------------------------------------------------------
# Plate solving
# --------------------------------------------------------------------------
JOBS: dict[str, dict] = {}  # local id -> state (in-memory, prototype only)


def stretch_png(data: np.ndarray, max_side=1400) -> tuple[str, float]:
    """asinh-stretched 8-bit PNG (base64) of a 2-D array, returns (png_b64, scale)."""
    from PIL import Image

    a = np.nan_to_num(np.asarray(data, dtype=float))
    lo, hi = np.percentile(a, [5, 99.7])
    a = np.clip((a - lo) / max(hi - lo, 1e-9), 0, 1)
    a = np.arcsinh(a * 10) / np.arcsinh(10)
    img = Image.fromarray((np.flipud(a) * 255).astype(np.uint8))
    scale = 1.0
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode(), scale


def image_png(raw: bytes, max_side=1400) -> tuple[str, float, int, int]:
    from PIL import Image

    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    w, h = img.size
    scale = 1.0
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode(), scale, w, h


def fits_wcs(raw: bytes):
    """Return (data2d, celestial WCS or None) from FITS bytes."""
    from astropy.io import fits
    from astropy.wcs import WCS, FITSFixedWarning

    hdul = fits.open(io.BytesIO(raw))
    for hdu in hdul:
        if hdu.data is None or getattr(hdu.data, "ndim", 0) < 2:
            continue
        data = hdu.data
        while data.ndim > 2:
            data = data[0]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            try:
                w = WCS(hdu.header).celestial
                ok = w.has_celestial and w.naxis == 2
            except Exception:
                w, ok = None, False
        return data, (w if ok else None)
    raise ValueError("FITS dosyasında 2 boyutlu görüntü bulunamadı")


def describe_field(w, width, height, png_b64, png_scale, png_mime, source, extra=None):
    """Common solution payload from a celestial WCS + image size."""
    from astropy.wcs.utils import proj_plane_pixel_scales

    cx, cy = (width - 1) / 2, (height - 1) / 2
    (ra0, dec0), = w.all_pix2world([[cx, cy]], 0)
    corners = w.all_pix2world([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], 0)
    pixscale = float(np.mean(proj_plane_pixel_scales(w)) * 3600)  # arcsec/px

    def sep(ra1, dec1, ra2, dec2):
        r1, d1, r2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
        c = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(r1 - r2)
        return np.degrees(np.arccos(np.clip(c, -1, 1)))

    radius = float(max(sep(ra0, dec0, c[0], c[1]) for c in corners))

    def on_image(ras, decs):
        px = w.all_world2pix(np.column_stack([ras, decs]), 0)
        ok = (px[:, 0] >= 0) & (px[:, 0] <= width - 1) & (px[:, 1] >= 0) & (px[:, 1] <= height - 1)
        return px, ok

    # 1) bright catalogue stars in the field
    near = np.where(sep(ra0, dec0, CAT_RA, CAT_DEC) <= radius)[0]
    stars = []
    if len(near):
        px, ok = on_image(CAT_RA[near], CAT_DEC[near])
        for i, p, k in zip(near, px, ok):
            if k:
                d = star_dict(STARS[i])
                d.update(src="bright", x=float(p[0]), y=float(p[1]))
                stars.append(d)

    # 2) Gaia DR3: the brightest sources in the field (identification of fainter stars)
    gaia, gaia_err = [], None
    try:
        rows = gaia_cone(ra0, dec0, min(radius, 3.0), top=150)
        if rows:
            px, ok = on_image([r["ra"] for r in rows], [r["dec"] for r in rows])
            for r, p, k in zip(rows, px, ok):
                if k:
                    r.update(src="gaia", x=float(p[0]), y=float(p[1]))
                    gaia.append(r)
    except Exception as e:
        gaia_err = f"Gaia sorgusu başarısız: {e}"

    # Pixel coordinates are in FITS/astropy convention (origin bottom-left);
    # the preview PNG is flipped for FITS, so tell the browser how to draw.
    payload = {
        "status": "solved",
        "source": source,
        "center": {"ra": float(ra0), "dec": float(dec0)},
        "radius_deg": radius,
        "pixscale_arcsec": pixscale,
        "width": int(width),
        "height": int(height),
        "corners": [[float(a), float(b)] for a, b in corners],
        "preview": {"data": png_b64, "mime": png_mime, "scale": png_scale,
                    "y_flipped": png_mime == "image/png"},
        "stars": sorted(stars, key=lambda d: d.get("v", 99)),
        "gaia": gaia,
        "gaia_error": gaia_err,
    }
    if extra:
        payload.update(extra)
    return payload


def nova_session():
    r = requests.post(f"{NOVA}/api/login",
                      data={"request-json": json.dumps({"apikey": NOVA_KEY})}, timeout=30)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != "success":
        raise RuntimeError(j.get("errormessage", "Astrometry.net girişi başarısız"))
    return j["session"]


@app.post("/api/solve")
def api_solve():
    f = request.files.get("file")
    if not f:
        abort(400, "file alanı gerekli")
    raw = f.read()
    name = (f.filename or "upload").lower()
    is_fits = name.endswith((".fits", ".fit", ".fts", ".fits.gz")) or raw[:6] == b"SIMPLE"

    # Fast path: FITS that already carries a celestial WCS -> no external solver needed.
    if is_fits:
        try:
            data, w = fits_wcs(raw)
        except Exception as e:
            return jsonify({"status": "error", "error": f"FITS okunamadı: {e}"}), 400
        if w is not None:
            h, wd = data.shape
            png, scale = stretch_png(data)
            return jsonify(describe_field(w, wd, h, png, scale, "image/png", "fits-wcs"))

    if not NOVA_KEY:
        return jsonify({
            "status": "error",
            "error": "Bu görüntüde koordinat bilgisi (WCS) yok. Astrometry.net ile çözmek için "
                     "sunucuda ASTROMETRY_API_KEY ortam değişkeni tanımlanmalı (ücretsiz anahtar: "
                     "nova.astrometry.net > API).",
        }), 400

    try:
        sess = nova_session()
        r = requests.post(
            f"{NOVA}/api/upload",
            files={
                "request-json": (None, json.dumps({
                    "session": sess, "publicly_visible": "n",
                    "allow_modifications": "n", "allow_commercial_use": "n",
                })),
                "file": (f.filename or "upload", raw, "application/octet-stream"),
            },
            timeout=120,
        )
        r.raise_for_status()
        j = r.json()
        if j.get("status") != "success":
            raise RuntimeError(j.get("errormessage", "yükleme reddedildi"))
    except Exception as e:
        return jsonify({"status": "error", "error": f"Astrometry.net'e gönderilemedi: {e}"}), 502

    if is_fits:
        data, _ = fits_wcs(raw)
        png, scale = stretch_png(data)
        mime, (hgt, wid) = "image/png", data.shape
    else:
        png, scale, wid, hgt = image_png(raw)
        mime = "image/jpeg"
    lid = uuid.uuid4().hex[:12]
    JOBS[lid] = {"subid": j["subid"], "png": png, "scale": scale, "mime": mime,
                 "w": wid, "h": hgt, "t0": time.time()}
    return jsonify({"status": "queued", "id": lid, "subid": j["subid"]})


@app.get("/api/solve/<lid>")
def api_solve_poll(lid):
    st = JOBS.get(lid)
    if not st:
        abort(404)
    if "result" in st:
        return jsonify(st["result"])
    try:
        sub = requests.get(f"{NOVA}/api/submissions/{st['subid']}", timeout=30).json()
        jobs = [jb for jb in (sub.get("jobs") or []) if jb]
        if not jobs:
            return jsonify({"status": "queued", "elapsed": time.time() - st["t0"]})
        job = jobs[0]
        js = requests.get(f"{NOVA}/api/jobs/{job}", timeout=30).json().get("status")
        if js == "failure":
            st["result"] = {"status": "error",
                            "error": "Astrometry.net bu görüntünün koordinatlarını bulamadı."}
            return jsonify(st["result"])
        if js != "success":
            return jsonify({"status": "solving", "job": job, "elapsed": time.time() - st["t0"]})

        # Solved: fetch the WCS header astrometry.net computed and annotate the field.
        from astropy.io import fits
        from astropy.wcs import WCS

        wraw = requests.get(f"{NOVA}/wcs_file/{job}", timeout=60).content
        w = WCS(fits.Header.fromstring(wraw[: wraw.find(b"END") + 80].decode("ascii", "ignore"))).celestial
        ann = requests.get(f"{NOVA}/api/jobs/{job}/annotations/", timeout=30).json()
        res = describe_field(w, st["w"], st["h"], st["png"], st["scale"], st["mime"],
                             "astrometry.net",
                             extra={"annotations": ann.get("annotations", []),
                                    "nova_job": job})
        st["result"] = res
        st.pop("png", None)
        return jsonify(res)
    except Exception as e:
        return jsonify({"status": "solving", "warning": str(e), "elapsed": time.time() - st["t0"]})


# --------------------------------------------------------------------------
# Static site
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:p>")
def static_files(p):
    return send_from_directory(WEB, p)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"LichSpec gökyüzü prototipi: http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
