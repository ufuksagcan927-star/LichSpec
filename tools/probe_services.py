#!/usr/bin/env python3
"""
Probe the public data services the static LichSpec site depends on.

    python tools/probe_services.py

Runs on CI (real internet). For every VizieR mirror it reports DNS, latency, HTTP status
and whether the browser would be allowed to read the answer (CORS). On the first working
mirror it prints the Gaia DR3 column names used by the star card, and times the
"brightest N stars in this field" query the sky layer makes, checking that the sort
really picks the brightest stars of the whole field.
"""
import socket
import sys
import time
from urllib.parse import urlencode, urlparse

import requests

ORIGIN = "https://lichspec-check.example"
MIRRORS = {
    "cds": "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
    "cfa": "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
    "iucaa": "https://vizier.iucaa.in/viz-bin/asu-tsv",
    "naoj": "https://vizier.nao.ac.jp/viz-bin/asu-tsv",
    "china": "https://vizier.china-vo.org/viz-bin/asu-tsv",
    "idia": "https://vizier.idia.ac.za/viz-bin/asu-tsv",
}
OTHER = {
    "tapvizier": "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?" + urlencode({
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "tsv",
        "QUERY": 'SELECT TOP 5 Source, Gmag FROM "I/355/gaiadr3" WHERE 1=CONTAINS(POINT(\'ICRS\', RA_ICRS, DE_ICRS), '
                 "CIRCLE('ICRS', 132.846, 11.814, 0.2)) ORDER BY Gmag"}),
    "hipscat": "https://hipscat.cds.unistra.fr/HiPSCatService/I/355/gaiadr3/properties",
    "mocserver gaia hips record": "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=record",
    "alasky dss2 properties": "https://alasky.cds.unistra.fr/DSS/DSSColor/properties",
}
SID = "604917354477128448"   # a bright M67 giant with GSP-Spec abundances
FIELDS = {"M67 (b=+32)": (132.846, 11.814), "Cygnus (b=+1)": (305.0, 36.5)}


def dns(host):
    try:
        return ",".join(sorted({a[4][0] for a in socket.getaddrinfo(host, 443)}))[:60]
    except OSError as e:
        return f"FAIL {e}"


def get(url, timeout=60):
    t = time.time()
    try:
        r = requests.get(url, headers={"Origin": ORIGIN}, timeout=timeout)
        return r, time.time() - t, None
    except requests.RequestException as e:
        return None, time.time() - t, f"{type(e).__name__}: {str(e)[:160]}"


def cors(r):
    a = r.headers.get("Access-Control-Allow-Origin")
    return "CORS ok" if a in ("*", ORIGIN) else f"NO CORS ({a!r})"


def tsv(text):
    lines = [ln for ln in text.splitlines()]
    i = 0
    while i < len(lines) and (lines[i].startswith("#") or not lines[i].strip()):
        i += 1
    if i >= len(lines):
        return [], []
    header = [h.strip() for h in lines[i].split("\t")]
    i += 1
    while i < len(lines) and not set(lines[i]) <= set("-\t "):
        i += 1
    rows = []
    for ln in lines[i + 1:]:
        if not ln.strip() or ln.startswith("#"):
            break
        rows.append(dict(zip(header, [c.strip() for c in ln.split("\t")])))
    return header, rows


def info_lines(text):
    return [ln for ln in text.splitlines() if ln.startswith("#") and any(
        k in ln.lower() for k in ("trunc", "out.max", "limit", "warning", "error", "sorted"))]


def main():
    print("== VizieR mirrors (small Gaia DR3 cone)")
    working = []
    for name, base in MIRRORS.items():
        host = urlparse(base).hostname
        url = base + "?" + urlencode({"-source": "I/355/gaiadr3", "-c": "132.846 +11.814", "-c.rs": "60",
                                      "-out": "Source,Gmag", "-out.max": "3", "-sort": "Gmag"})
        r, dt, err = get(url, 30)
        if r is None:
            print(f"- {name:6} dns={dns(host)} | {err} ({dt:.1f}s)")
            continue
        h, rows = tsv(r.text)
        ok = r.ok and rows
        print(f"- {name:6} dns={dns(host)} | HTTP {r.status_code} {dt:.1f}s | {cors(r)} | rows={len(rows)} "
              f"{rows[:1] if rows else r.text[:120]!r}")
        if ok and cors(r) == "CORS ok":
            working.append((dt, name, base))

    print("\n== other services")
    for name, url in OTHER.items():
        host = urlparse(url).hostname
        r, dt, err = get(url, 45)
        if r is None:
            print(f"- {name}: dns={dns(host)} | {err} ({dt:.1f}s)")
            continue
        body = r.text
        if "mocserver" in name:
            body = "\n    ".join(ln for ln in body.splitlines() if "url" in ln or "ID" in ln)
        print(f"- {name}: HTTP {r.status_code} {dt:.1f}s | {cors(r)}\n    {body[:900]}")

    if not working:
        print("\nno working VizieR mirror with CORS")
        return 1
    working.sort()
    _, name, base = working[0]
    print(f"\n== using fastest mirror: {name}")

    for table in ("I/355/gaiadr3", "I/355/paramp"):
        r, dt, err = get(base + "?" + urlencode({"-source": table, "Source": SID, "-out.all": "1", "-out.max": "1"}))
        if r is None:
            print(f"- {table}: {err}")
            continue
        h, rows = tsv(r.text)
        print(f"- {table} by Source, all columns ({dt:.1f}s): {len(h)} columns")
        if rows:
            print("    " + " | ".join(f"{k}={v}" for k, v in rows[0].items() if v != ""))
        else:
            print("    " + r.text[:600].replace("\n", "\n    "))

    print("\n== brightest-N field query (what the sky layer asks for)")
    for fname, (ra, dec) in FIELDS.items():
        for rdeg in (1.77, 0.9, 0.35):
            for n in (3000,):
                params = {"-source": "I/355/gaiadr3", "-c": f"{ra} {dec:+}", "-c.rd": str(rdeg),
                          "-out": "Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,Plx,e_Plx", "-out.max": str(n), "-sort": "Gmag"}
                r, dt, err = get(base + "?" + urlencode(params), 90)
                if r is None:
                    print(f"- {fname} r={rdeg}: {err} ({dt:.1f}s)")
                    continue
                h, rows = tsv(r.text)
                g = [float(x["Gmag"]) for x in rows if x.get("Gmag")]
                gmax = max(g) if g else None
                print(f"- {fname} r={rdeg}° top {n}: {dt:.1f}s, rows={len(rows)}, "
                      f"G {min(g) if g else None}..{gmax}, sorted={g == sorted(g)}; info={info_lines(r.text)[:3]}")
                if gmax is None or rdeg < 0.5:
                    continue
                # Is it really the brightest n of the whole field? Count stars brighter than gmax.
                chk = dict(params, **{"-out": "Gmag", "-out.max": "50000", "Gmag": f"<{gmax}"})
                chk.pop("-sort")
                r2, dt2, err2 = get(base + "?" + urlencode(chk), 120)
                if r2 is None:
                    print(f"    check: {err2}")
                    continue
                h2, rows2 = tsv(r2.text)
                print(f"    check: stars with G < {gmax} in the field = {len(rows2)} ({dt2:.1f}s) "
                      f"-> {'brightest-N OK' if len(rows2) <= n * 1.02 else 'NOT the brightest (sorted after truncation)'}")
        # same field with a magnitude cut, as the site would send it
        for gcut in (13, 15, 17):
            params = {"-source": "I/355/gaiadr3", "-c": f"{ra} {dec:+}", "-c.rd": "1.77",
                      "-out": "Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,Plx,e_Plx", "-out.max": "3000",
                      "-sort": "Gmag", "Gmag": f"<{gcut}"}
            r, dt, err = get(base + "?" + urlencode(params), 90)
            if r is None:
                print(f"- {fname} r=1.77 G<{gcut}: {err} ({dt:.1f}s)")
                continue
            h, rows = tsv(r.text)
            print(f"- {fname} r=1.77° G<{gcut}: {dt:.1f}s, rows={len(rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
