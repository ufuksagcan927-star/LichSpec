"""Build LichSpec's offline star catalogue (web/data/bright_stars.json).

What goes in (all public, nothing is invented here):
  * Every Hipparcos star brighter than --vmax, from the Hipparcos main catalogue (ESA 1997)
    via the Gaia archive TAP: position (ICRS, epoch 1991.25), V, B-V, parallax, spectral type,
    HD number, variability flag.
  * Every fainter star that has a name: all stars d3-celestial names (Proxima Centauri,
    Barnard's Star, Kapteyn's Star, ...) and the stars in ALIASES below (Ross 128, Gliese 581,
    VY Canis Majoris, ...). They come from the same ESA query when the archive answers. If it
    does not (it was closed in Nov 2026 to prepare Gaia DR4) or a star has no 1997 astrometry,
    the row is filled from the Hipparcos new reduction (van Leeuwen 2007: position at epoch
    1991.25, parallax) through the ARI Heidelberg Gaia TAP, with V and B-V of the 1997
    catalogue as given in d3-celestial's stars.14.json; those rows have no spectral type.
    A star in neither reduction keeps d3-celestial's J2000 position and no parallax.
  * For all of them, Gaia DR3 astrophysical_parameters joined through the official
    hipparcos2_best_neighbour cross-match: GSP-Phot Teff/logg/[M/H]/radius and, where the
    RVS spectrum allowed it, GSP-Spec abundances.
  * Famous stars that are not in Hipparcos (FAMOUS below: Wolf 359, TRAPPIST-1, UY Scuti, ...),
    straight from Gaia DR3 gaia_source + astrophysical_parameters by source_id ("extra" rows,
    epoch 2016.0). Each source_id was found by position and checked against the star's
    known parallax, proper motion, brightness or colour.
  * Names, Bayer / Flamsteed designations and Turkish names ("tr") from d3-celestial's
    starnames.json (BSD-3, Olaf Frohn), keyed by HIP number; common names and catalogue
    designations in ALIASES / FAMOUS are standard designations of these stars.
  * The constellation of stars without a Bayer or Flamsteed designation, from the IAU
    boundaries in d3-celestial's constellations.bounds.json.

Usage (d3-celestial: npm pack d3-celestial@0.7.35 && tar xzf d3-celestial-0.7.35.tgz):
  python tools/build_bright_catalog.py --vmax 7.0 --d3 package/data
  # ESA archive closed? Keep the V < vmax rows of an existing build, refresh names, add the rest:
  python tools/build_bright_catalog.py --base web/data/bright_stars.json --d3 package/data
"""
import argparse
import csv
import html
import io
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ESA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
ARI_TAP = "https://gaia.ari.uni-heidelberg.de/tap/sync"

AP_COLS = """ap.teff_gspphot, ap.logg_gspphot, ap.mh_gspphot, ap.radius_gspphot,
       ap.teff_gspspec, ap.logg_gspspec, ap.mh_gspspec, ap.fem_gspspec,
       ap.alphafe_gspspec, ap.cafe_gspspec, ap.mgfe_gspspec, ap.sife_gspspec,
       ap.tife_gspspec"""

ESA_QUERY = """
SELECT h.hip, h.ra, h.de, h.vmag, h.b_v, h.plx, h.e_plx, h.pmra, h.pmde,
       h.sptype, h.hd, h.varflag,
       x.source_id,
       """ + AP_COLS + """
FROM public.hipparcos AS h
LEFT JOIN gaiadr3.hipparcos2_best_neighbour AS x ON x.original_ext_source_id = h.hip
LEFT JOIN gaiadr3.astrophysical_parameters AS ap ON ap.source_id = x.source_id
WHERE (h.vmag < {vmax}{named}) AND h.ra IS NOT NULL
"""

# Hipparcos new reduction (van Leeuwen 2007) at ARI: no V, spectral type or HD number.
ARI_QUERY = """
SELECT h.hip, h.ra, h.dec, h.plx, h.e_plx,
       x.source_id,
       """ + AP_COLS + """
FROM hipparcos AS h
LEFT JOIN gaiadr3.hipparcos2_best_neighbour AS x ON x.original_ext_source_id = h.hip
LEFT JOIN gaiadr3.astrophysical_parameters AS ap ON ap.source_id = x.source_id
WHERE h.hip IN ({hips})
"""

FAMOUS_QUERY = """
SELECT g.source_id, g.ra, g.dec, g.phot_g_mean_mag, g.bp_rp, g.parallax, g.parallax_error,
       g.pmra, g.pmdec, g.radial_velocity, g.ruwe, g.phot_variable_flag,
       """ + AP_COLS + """, ap.lum_flame, ap.mass_flame, ap.age_flame, ap.spectraltype_esphs
FROM gaiadr3.gaia_source AS g
LEFT JOIN gaiadr3.astrophysical_parameters AS ap ON ap.source_id = g.source_id
WHERE g.source_id IN ({ids})
"""

# Display-name overrides: the IAU name where d3-celestial shortens it, otherwise the
# catalogue designation the star is known by.
NAMES = {
    70890: "Proxima Centauri",
    57548: "Ross 128", 92403: "Ross 154",
    114046: "Lacaille 9352", 105090: "Lacaille 8760", 1475: "Groombridge 34",
    110893: "Kruger 60", 91768: "Struve 2398 A", 91772: "Struve 2398 B",
    74995: "Gliese 581", 113020: "Gliese 876", 57087: "Gliese 436",
    35793: "VY Canis Majoris", 76976: "HD 140283",
}
# Other names people search for (common names, Gliese / variable-star designations).
ALIASES = {
    71683: ["Alpha Centauri", "Alpha Centauri A", "GJ 559 A"],
    71681: ["Alpha Centauri B", "GJ 559 B"],
    70890: ["Proxima", "Alpha Centauri C", "GJ 551", "V645 Centauri"],
    87937: ["GJ 699", "V2500 Ophiuchi"],
    24186: ["GJ 191", "VZ Pictoris"],
    36208: ["GJ 273"],
    3829: ["van Maanen 2", "GJ 35"],
    54035: ["GJ 411"],
    11767: ["Demirkazık", "Kuzey Yıldızı", "North Star"],
    32349: ["Sirius A", "GJ 244"],
    37279: ["GJ 280"],
    8102: ["GJ 71"],
    16537: ["GJ 144"],
    108870: ["GJ 845"],
    104214: ["61 Cygni A", "GJ 820 A"],
    104217: ["61 Cygni B", "GJ 820 B"],
    107259: ["Garnet Star", "Herschel's Garnet Star"],
    57548: ["GJ 447", "FI Virginis"],
    92403: ["GJ 729", "V1216 Sagittarii"],
    114046: ["GJ 887"],
    105090: ["AX Microscopii", "GJ 825"],
    1475: ["Groombridge 34 A", "GJ 15 A"],
    110893: ["GJ 860 A"],
    91768: ["GJ 725 A"],
    91772: ["GJ 725 B"],
    74995: ["GJ 581", "Wolf 562"],
    113020: ["GJ 876", "Ross 780"],
    57087: ["GJ 436", "Ross 905"],
    35793: ["VY CMa"],
    76976: ["Methuselah", "Methuselah Star"],
}
# Not in Hipparcos: (name, Gaia DR3 source_id, aliases[, flags]). Identification checks on the right.
# dusty: wrapped in its own dust (Eta Carinae's Homunculus nebula), so its colour says nothing about its
# temperature and the site must not estimate one from it.
FAMOUS = [
    ("Wolf 359", 3864972938605115520, ["CN Leonis", "GJ 406"]),                 # parallax 415 mas
    ("TRAPPIST-1", 2635476908753563008, ["2MASS J23062928-0502285"]),           # parallax 80.2 mas
    ("Teegarden's Star", 35227046884571776, ["SO J025300.5+165258"]),           # parallax 261 mas, pm 5.1"/yr
    ("Ross 248", 1926461164913660160, ["HH Andromedae", "GJ 905"]),             # parallax 316 mas, pm 1.6"/yr
    ("Tabby's Star", 2081900940499099136, ["Boyajian's Star", "KIC 8462852"]),   # G 11.8 at its KIC position
    ("Kepler-452", 2079597124345617280, []),                                    # G 13.4, parallax 1.8 mas
    ("UY Scuti", 4152993273702130432, ["UY Sct"]),                              # G 6.7, BP-RP 4.2
    ("Stephenson 2-18", 4253084565963481856, ["St2-18"]),                       # BP-RP 8.0 in Stephenson 2
    ("Eta Carinae", 5350358584482202880, ["η Car"], {"dusty": 1}),              # G 4.0, no Gaia parallax
]


def tap(url, query, tries=3):
    body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}).encode()
    csv.field_size_limit(10 ** 8)
    err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, data=body, timeout=600) as r:
                text = r.read().decode()
            if text.lstrip().startswith("<"):
                # an HTML maintenance page or a VOTable error instead of CSV
                raise RuntimeError(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(text)))[:200])
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as e:  # noqa: BLE001 - report and retry any network/service error
            err = e
            print(f"  {url}: {e} (try {i + 1}/{tries})", file=sys.stderr)
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


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


# ----------------------------------------------------------------- constellations
def _b1875_matrix():
    """Precession J2000 -> B1875.0 (IAU 1976, Lieske 1977). The IAU constellation boundaries
    are lines of constant right ascension and declination for the equinox B1875.0."""
    t = (2405889.258550475 - 2451545.0) / 36525.0
    s = math.pi / 180 / 3600
    zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * s
    z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * s
    th = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * s
    cz, sz, cZ, sZ, ct, st = math.cos(zeta), math.sin(zeta), math.cos(z), math.sin(z), math.cos(th), math.sin(th)
    return [[cZ * ct * cz - sZ * sz, -cZ * ct * sz - sZ * cz, -cZ * st],
            [sZ * ct * cz + cZ * sz, -sZ * ct * sz + cZ * cz, -sZ * st],
            [st * cz, -st * sz, ct]]


_B1875 = _b1875_matrix()


def to_b1875(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    v = (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))
    w = [sum(_B1875[i][j] * v[j] for j in range(3)) for i in range(3)]
    return math.degrees(math.atan2(w[1], w[0])) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, w[2]))))


def load_bounds(path):
    """IAU boundaries as [(abbr, ring in B1875 degrees, contains_north_pole)]. d3-celestial gives
    the corners precessed to J2000; back in B1875 the edges run along constant RA or Dec."""
    out = []
    for f in json.loads(Path(path).read_text(encoding="utf-8"))["features"]:
        for ring in f["geometry"]["coordinates"]:
            pts = [to_b1875(lon % 360.0, lat) for lon, lat in ring]
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            out.append((f["id"], pts, f["id"] == "UMi"))
    return out


def constellation(bounds, ra, dec):
    """Constellation of a J2000/ICRS position: precess to B1875, then count crossings of the
    meridian arc from the point to the north celestial pole with each boundary (UMi is the
    only area around the north pole)."""
    ra, dec = to_b1875(ra, dec)
    wrap = lambda x: (x + 180.0) % 360.0 - 180.0
    for abbr, ring, npole in bounds:
        n = 0
        for (l1, b1), (l2, b2) in zip(ring, ring[1:] + ring[:1]):
            x1 = wrap(l1 - ra)
            x2 = x1 + wrap(l2 - l1)
            if (x1 < 0) != (x2 < 0):
                b = b1 + (b2 - b1) * (-x1) / (x2 - x1)
                if b > dec:
                    n += 1
        if (n % 2 == 1) != npole:
            return abbr
    return None


# ----------------------------------------------------------------- rows
COLS = ["hip", "ra", "dec", "v", "bv", "plx", "eplx", "sp", "name", "desig",
        "con", "hd", "gaia", "teff", "logg", "mh", "rad", "teff_s", "logg_s",
        "mh_s", "fem", "alpha", "ca", "mg", "si", "ti", "var", "tr", "alias"]
NAME_COLS = {"name", "desig", "con", "tr", "alias"}
AP_FIELDS = ["teff_gspphot", "logg_gspphot", "mh_gspphot", "radius_gspphot", "teff_gspspec",
             "logg_gspspec", "mh_gspspec", "fem_gspspec", "alphafe_gspspec", "cafe_gspspec",
             "mgfe_gspspec", "sife_gspspec", "tife_gspspec"]
AP_KEYS = ["teff", "logg", "mh", "rad", "teff_s", "logg_s", "mh_s", "fem", "alpha", "ca", "mg", "si", "ti"]


def ap_values(r):
    return {k: num(r.get(f), 0 if k.startswith("teff") else 2) for k, f in zip(AP_KEYS, AP_FIELDS)}


def esa_row(r):
    return {
        "hip": int(r["hip"]), "ra": num(r["ra"], 5), "dec": num(r["de"], 5), "v": num(r["vmag"], 2),
        "bv": num(r["b_v"], 3), "plx": num(r["plx"], 2), "eplx": num(r["e_plx"], 2),
        "sp": (r["sptype"] or "").strip() or None, "hd": int(r["hd"]) if r["hd"] else None,
        "gaia": r["source_id"] or None, "var": (r["varflag"] or "").strip() or None, **ap_values(r),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vmax", type=float, default=7.0)
    ap.add_argument("--d3", required=True, help="d3-celestial data folder (starnames.json, stars.14.json, constellations.bounds.json)")
    ap.add_argument("--base", default=None, help="reuse the rows of an existing build instead of querying the ESA archive")
    ap.add_argument("--out", default="web/data/bright_stars.json")
    a = ap.parse_args()

    d3 = Path(a.d3)
    names = json.loads((d3 / "starnames.json").read_text(encoding="utf-8"))
    hip14 = {int(f["id"]): f for f in json.loads((d3 / "stars.14.json").read_text(encoding="utf-8"))["features"]}
    bounds = load_bounds(d3 / "constellations.bounds.json")
    wanted = sorted({int(h) for h, n in names.items() if n.get("name")} | set(NAMES) | set(ALIASES))
    wanted_set = set(wanted)

    rows = {}
    if a.base:
        base = json.loads(Path(a.base).read_text(encoding="utf-8"))
        bcols = base["meta"]["cols"]
        for r in base["stars"]:
            o = {c: r[i] for i, c in enumerate(bcols) if c not in NAME_COLS}
            rows[o["hip"]] = o
        print(f"{len(rows)} rows from {a.base}", file=sys.stderr)
    else:
        named = ", ".join(str(h) for h in wanted)
        for r in tap(ESA_TAP, ESA_QUERY.format(vmax=a.vmax, named=f" OR h.hip IN ({named})")):
            o = esa_row(r)
            rows.setdefault(o["hip"], o)   # several Gaia neighbours can map to one HIP: keep first
        print(f"{len(rows)} rows from the ESA Gaia archive", file=sys.stderr)

    supplement = {}
    missing = [h for h in wanted if h not in rows]
    if missing:
        print(f"{len(missing)} named stars missing; asking the Hipparcos new reduction (ARI)", file=sys.stderr)
        for r in tap(ARI_TAP, ARI_QUERY.format(hips=", ".join(map(str, missing)))):
            hip = int(r["hip"])
            if hip in rows or hip not in hip14:
                continue
            p = hip14[hip]["properties"]
            rows[hip] = {"hip": hip, "ra": num(r["ra"], 5), "dec": num(r["dec"], 5), "v": num(p.get("mag"), 2),
                         "bv": num(p.get("bv"), 3), "plx": num(r["plx"], 2), "eplx": num(r["e_plx"], 2),
                         "gaia": r["source_id"] or None, **ap_values(r)}
            supplement[hip] = "hip2"
        for hip in missing:
            if hip not in rows and hip in hip14:   # in neither reduction: d3-celestial's J2000 position
                f = hip14[hip]
                lon, lat = f["geometry"]["coordinates"]
                rows[hip] = {"hip": hip, "ra": round(lon % 360, 5), "dec": round(lat, 5),
                             "v": num(f["properties"].get("mag"), 2), "bv": num(f["properties"].get("bv"), 3)}
                supplement[hip] = "d3"
        lost = [h for h in missing if h not in rows]
        if lost:
            print(f"  not found anywhere: {lost}", file=sys.stderr)

    out = []
    for hip, o in rows.items():
        n = names.get(str(hip), {})
        desig = ""
        for k in ("bayer", "flam", "var"):
            if n.get(k):
                desig = n[k] + " " + n.get("c", "")
                break
        alias = list(ALIASES.get(hip, []))
        if n.get("bayer") and n.get("flam"):
            alias.append(f"{n['flam']} {n.get('c', '')}".strip())       # "58 Ori" for α Ori
        if n.get("gl"):
            alias.append(n["gl"].replace(" ", " "))
        name = NAMES.get(hip) or n.get("name") or None
        if name and n.get("name") and n["name"] != name:
            alias.insert(0, n["name"])
        hd = o.get("hd")
        if hd is None and n.get("hd"):
            m = re.search(r"\d+", n["hd"])
            hd = int(m.group()) if m else None
        con = n.get("c") or None
        if con is None and hip in wanted_set and o.get("ra") is not None:
            con = constellation(bounds, o["ra"], o["dec"])   # named stars without Bayer/Flamsteed letter
        seen, uniq = set(), []
        for x in alias:   # "GJ 559 A" and d3-celestial's "GJ 559A" are the same name
            k = re.sub(r"\s+", "", x.lower())
            if x and k not in seen and x != name:
                seen.add(k)
                uniq.append(x)
        o.update(name=name, desig=desig.strip() or None, con=con, hd=hd, tr=n.get("tr") or None, alias=uniq or None)
        out.append([o.get(c) for c in COLS])
    out.sort(key=lambda s: s[3] if s[3] is not None else 99)

    # famous stars outside Hipparcos, straight from Gaia DR3
    extra_cols = ["name", "alias", "con", "ra", "dec", "gaia", "g", "bprp", "plx", "eplx", "pmra", "pmdec",
                  "rv", "ruwe", "var", "sp", "lumf", "mass", "age", "dusty"] + AP_KEYS
    extra = []
    got = {r["source_id"]: r for r in tap(ARI_TAP, FAMOUS_QUERY.format(ids=", ".join(str(f[1]) for f in FAMOUS)))}
    for name, sid, aliases, *flags in FAMOUS:
        r = got.get(str(sid))
        if not r:
            print(f"  {name}: Gaia DR3 {sid} not found", file=sys.stderr)
            continue
        ra, dec = num(r["ra"], 6), num(r["dec"], 6)
        e = {"name": name, "alias": aliases or None, "con": constellation(bounds, ra, dec), "ra": ra, "dec": dec,
             "gaia": str(sid), "g": num(r["phot_g_mean_mag"], 3), "bprp": num(r["bp_rp"], 3),
             "plx": num(r["parallax"], 3), "eplx": num(r["parallax_error"], 3), "pmra": num(r["pmra"], 1),
             "pmdec": num(r["pmdec"], 1), "rv": num(r["radial_velocity"], 1), "ruwe": num(r["ruwe"], 2),
             "var": "1" if r["phot_variable_flag"] == "VARIABLE" else None,
             "sp": (r["spectraltype_esphs"] or "").strip() or None, "lumf": num(r["lum_flame"], 3),
             "mass": num(r["mass_flame"], 3), "age": num(r["age_flame"], 2), **ap_values(r),
             **(flags[0] if flags else {})}
        extra.append([e.get(c) for c in extra_cols])

    meta = {
        "description": "LichSpec star catalogue: every Hipparcos star with V < %.1f and every named fainter one, "
                       "with Gaia DR3 astrophysical parameters; plus famous stars outside Hipparcos from Gaia DR3 "
                       "(extra)" % a.vmax,
        "sources": [
            "ESA 1997, The Hipparcos Catalogue (via Gaia archive public.hipparcos)",
            "van Leeuwen 2007, Hipparcos new reduction (via ARI Heidelberg Gaia TAP): position and parallax of "
            "named stars the 1997 query did not return (no spectral type for these)",
            "Gaia Collaboration 2023, Gaia DR3 gaia_source and astrophysical_parameters",
            "d3-celestial 0.7.35 (BSD-3, O. Frohn): starnames.json (names, Turkish names), stars.14.json "
            "(V and B-V of the supplementary rows), constellations.bounds.json",
        ],
        "epoch": "stars: ICRS, epoch 1991.25 (named stars in neither Hipparcos reduction, without a parallax: "
                 "J2000 from d3-celestial); extra: Gaia DR3, epoch 2016.0",
        "count": len(out),
        "cols": COLS,
        "extra_cols": extra_cols,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "stars": out, "extra": extra}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} stars + {len(extra)} extra to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
