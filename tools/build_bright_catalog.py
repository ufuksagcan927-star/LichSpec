"""Build LichSpec's offline bright-star catalogue (web/data/bright_stars.json).

Source data (all public, nothing is invented here):
  * Hipparcos main catalogue (ESA 1997) via the Gaia archive TAP: position,
    V magnitude, B-V, parallax, spectral type.
  * Gaia DR3 astrophysical_parameters joined through the official
    hipparcos2_best_neighbour cross-match: GSP-Phot Teff/logg/[M/H]/radius and,
    where the RVS spectrum allowed it, GSP-Spec abundances ([M/H], [Fe/M],
    [alpha/Fe], [Ca/Fe], [Mg/Fe], [Si/Fe], [Ti/Fe]).
  * Star names / Bayer / Flamsteed designations from d3-celestial's
    starnames.json (BSD-3, Olaf Frohn), keyed by HIP number.

Usage:
  python tools/build_bright_catalog.py --vmax 7.0 --names path/to/starnames.json
"""
import argparse
import csv
import io
import json
import math
import sys
import urllib.parse
import urllib.request

TAP = "https://gea.esac.esa.int/tap-server/tap/sync"

QUERY = """
SELECT h.hip, h.ra, h.de, h.vmag, h.b_v, h.plx, h.e_plx, h.pmra, h.pmde,
       h.sptype, h.hd, h.varflag,
       x.source_id,
       ap.teff_gspphot, ap.logg_gspphot, ap.mh_gspphot, ap.radius_gspphot,
       ap.distance_gspphot,
       ap.teff_gspspec, ap.logg_gspspec, ap.mh_gspspec, ap.fem_gspspec,
       ap.alphafe_gspspec, ap.cafe_gspspec, ap.mgfe_gspspec, ap.sife_gspspec,
       ap.tife_gspspec
FROM public.hipparcos AS h
LEFT JOIN gaiadr3.hipparcos2_best_neighbour AS x ON x.original_ext_source_id = h.hip
LEFT JOIN gaiadr3.astrophysical_parameters AS ap ON ap.source_id = x.source_id
WHERE h.vmag < {vmax} AND h.ra IS NOT NULL
"""


def tap(query):
    body = urllib.parse.urlencode(
        {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}
    ).encode()
    with urllib.request.urlopen(TAP, data=body, timeout=600) as r:
        return list(csv.DictReader(io.StringIO(r.read().decode())))


def num(v, nd=None):
    if v in (None, ""):
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    if math.isnan(f):
        return None
    return round(f, nd) if nd is not None else f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vmax", type=float, default=7.0)
    ap.add_argument("--names", default=None, help="d3-celestial starnames.json")
    ap.add_argument("--out", default="web/data/bright_stars.json")
    a = ap.parse_args()

    names = {}
    if a.names:
        with open(a.names, encoding="utf-8") as f:
            names = json.load(f)

    rows = tap(QUERY.format(vmax=a.vmax))
    print(f"{len(rows)} rows from Gaia archive", file=sys.stderr)

    # Column order is stored once in the file to keep it compact.
    cols = ["hip", "ra", "dec", "v", "bv", "plx", "eplx", "sp", "name", "desig",
            "con", "hd", "gaia", "teff", "logg", "mh", "rad", "teff_s", "logg_s",
            "mh_s", "fem", "alpha", "ca", "mg", "si", "ti", "var"]
    out, seen = [], set()
    for r in rows:
        hip = int(r["hip"])
        if hip in seen:  # several Gaia neighbours can map to one HIP: keep first
            continue
        seen.add(hip)
        n = names.get(str(hip), {})
        desig = ""
        if n.get("bayer"):
            desig = n["bayer"] + " " + n.get("c", "")
        elif n.get("flam"):
            desig = n["flam"] + " " + n.get("c", "")
        elif n.get("var"):
            desig = n["var"] + " " + n.get("c", "")
        out.append([
            hip, num(r["ra"], 5), num(r["de"], 5), num(r["vmag"], 2),
            num(r["b_v"], 3), num(r["plx"], 2), num(r["e_plx"], 2),
            (r["sptype"] or "").strip() or None,
            n.get("name") or None, desig.strip() or None, n.get("c") or None,
            int(r["hd"]) if r["hd"] else None,
            r["source_id"] or None,
            num(r["teff_gspphot"], 0), num(r["logg_gspphot"], 2),
            num(r["mh_gspphot"], 2), num(r["radius_gspphot"], 2),
            num(r["teff_gspspec"], 0), num(r["logg_gspspec"], 2),
            num(r["mh_gspspec"], 2), num(r["fem_gspspec"], 2),
            num(r["alphafe_gspspec"], 2), num(r["cafe_gspspec"], 2),
            num(r["mgfe_gspspec"], 2), num(r["sife_gspspec"], 2),
            num(r["tife_gspspec"], 2),
            (r["varflag"] or "").strip() or None,
        ])
    out.sort(key=lambda s: s[3] if s[3] is not None else 99)
    meta = {
        "description": "LichSpec bright-star catalogue (Hipparcos V<%.1f + Gaia DR3 astrophysical parameters)" % a.vmax,
        "sources": [
            "ESA 1997, The Hipparcos Catalogue (via Gaia archive public.hipparcos)",
            "Gaia Collaboration 2023, Gaia DR3 astrophysical_parameters",
            "d3-celestial starnames.json (BSD-3, O. Frohn)",
        ],
        "count": len(out),
        "cols": cols,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "stars": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} stars to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
