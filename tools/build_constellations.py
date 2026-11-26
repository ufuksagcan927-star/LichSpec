#!/usr/bin/env python3
"""
Build web/data/constellations.json (constellation stick figures, label positions and names) from
d3-celestial's data/constellations.lines.json and data/constellations.json.

    npm pack d3-celestial@0.7.35 && tar xzf d3-celestial-0.7.35.tgz
    python tools/build_constellations.py package/data web/data/constellations.json

d3-celestial (BSD-3-Clause, Olaf Frohn) took the figures from the IAU constellation charts
(IAU and Sky & Telescope). Coordinates are J2000; d3-celestial stores right ascension as GeoJSON
longitude (-180..180), converted back here to 0..360 degrees. Long segments are split into
pieces of at most 2 degrees so they follow the great circle in any projection.
"""
import json
import math
import sys
from pathlib import Path


def ra360(lon):
    return round(lon % 360.0, 3)


def unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def radec(v):
    x, y, z = v
    n = math.sqrt(x * x + y * y + z * z)
    return ra360(math.degrees(math.atan2(y, x))), round(math.degrees(math.asin(z / n)), 3)


def densify(points, step=2.0):
    out = [points[0]]
    for (ra1, de1), (ra2, de2) in zip(points, points[1:]):
        a, b = unit(ra1, de1), unit(ra2, de2)
        ang = math.degrees(math.acos(max(-1.0, min(1.0, sum(p * q for p, q in zip(a, b))))))
        n = max(1, math.ceil(ang / step))
        for k in range(1, n + 1):
            t = k / n
            if n == 1:
                out.append((ra2, de2))
                continue
            # slerp
            th = math.radians(ang)
            s1, s2 = math.sin((1 - t) * th) / math.sin(th), math.sin(t * th) / math.sin(th)
            out.append(radec(tuple(s1 * p + s2 * q for p, q in zip(a, b))))
    return out


def main(src, dst):
    src = Path(src)
    lines = json.loads((src / "constellations.lines.json").read_text(encoding="utf-8"))
    names = json.loads((src / "constellations.json").read_text(encoding="utf-8"))
    polylines = []
    for f in lines["features"]:
        for part in f["geometry"]["coordinates"]:
            pts = [(ra360(lon), round(lat, 3)) for lon, lat in part]
            pts = densify(pts)
            polylines.append([c for p in pts for c in p])
    labels = []
    seen = set()
    for f in names["features"]:
        p = f["properties"]
        abbr = p["desig"]
        lon, lat = f["geometry"]["coordinates"]
        key = (abbr, round(lon, 2), round(lat, 2))
        if key in seen:
            continue
        seen.add(key)
        labels.append([abbr, ra360(lon), round(lat, 2), int(p.get("rank", 3))])
    # Latin names and genitives, for search ("Ursa Major", "Alpha Centauri")
    cnames = {}
    for f in names["features"]:
        p = f["properties"]
        old = cnames.get(p["desig"], [p["name"]])[0]
        # Serpens comes in two parts (Caput, Cauda): keep the common name
        cnames[p["desig"]] = [old if old == p["name"] else old.split()[0], p["gen"]]
    out = {
        "meta": {
            "source": "d3-celestial 0.7.35 (BSD-3-Clause, Olaf Frohn): constellations.lines.json, constellations.json; "
                      "figures after the IAU constellation charts (IAU and Sky & Telescope)",
            "epoch": "J2000",
            "lines": "each entry is one polyline: [ra1, dec1, ra2, dec2, ...] in degrees",
            "labels": "[IAU abbreviation, ra, dec, rank]; rank 1 = most prominent",
            "names": "{IAU abbreviation: [Latin name, genitive]}",
        },
        "lines": polylines,
        "labels": labels,
        "names": cnames,
    }
    Path(dst).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    n = sum(len(p) // 2 for p in polylines)
    print(f"{len(polylines)} polylines, {n} points, {len(labels)} labels -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
