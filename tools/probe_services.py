#!/usr/bin/env python3
"""
Probe the public data services the static LichSpec site depends on.

    python tools/probe_services.py

Runs on CI (real internet). For every VizieR mirror the site uses it reports DNS (system
and public resolvers), latency, HTTP status and whether a browser may read the answer
(CORS); then whether CDS's Gaia DR3 HiPS catalogue answers, the Gaia DR3 columns the star
card reads, and how long the "brightest 3000 stars in this field" query takes at the
largest radius the site allows at three galactic latitudes.
"""
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode, urlparse

import requests

ORIGIN = "https://lichspec-check.example"
# the mirrors the site uses (web/js/data.js); IUCAA, NAOJ and China-VO timed out from CI
MIRRORS = {
    "cds": "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
    "cfa": "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
    "idia": "https://vizier.idia.ac.za/viz-bin/asu-tsv",
}
OTHER = {
    "Gaia DR3 HiPS catalogue": "https://hipscat.cds.unistra.fr/HiPSCatService/I/355/gaiadr3/properties",
    "alasky (Aladin image tiles)": "https://alasky.cds.unistra.fr/DSS/DSSColor/properties",
}
SID, SRA, SDEC = "604917354477128448", 132.8746, 11.7880   # a bright M67 giant with GSP-Spec abundances
# (galactic l, b, radius the site allows there: web/js/data.js maxFieldRadius)
FIELDS = [(75.0, 1.5, 0.32), (180.0, 18.0, 0.5), (215.7, 31.9, 0.75)]


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


def resolvers(host):
    out = []
    for ns in ("8.8.8.8", "1.1.1.1", "9.9.9.9"):
        try:
            r = subprocess.run(["dig", "+short", "+time=3", "+tries=1", f"@{ns}", host], capture_output=True, text=True, timeout=15)
            out.append(f"{ns}: {' '.join(r.stdout.split()) or 'no answer'}")
        except (OSError, subprocess.SubprocessError) as e:
            out.append(f"{ns}: {type(e).__name__}")
    return " | ".join(out)


def main():
    print("== VizieR mirrors (small Gaia DR3 cone)")
    working = []
    for name, base in MIRRORS.items():
        host = urlparse(base).hostname
        url = base + "?" + urlencode({"-source": "I/355/gaiadr3", "-c": "132.846 +11.814", "-c.rs": "60",
                                      "-out": "Source,Gmag", "-out.max": "3", "-sort": "Gmag"})
        r, dt, err = get(url, 20)
        print(f"- {name:5} system dns={dns(host)} | public dns: {resolvers(host)}")
        if r is None:
            print(f"        {err} ({dt:.1f}s)")
            continue
        h, rows = tsv(r.text)
        print(f"        HTTP {r.status_code} {dt:.1f}s | {cors(r)} | rows={len(rows)}")
        if r.ok and rows and cors(r) == "CORS ok":
            working.append((dt, name, base))

    print("\n== other services")
    for name, url in OTHER.items():
        host = urlparse(url).hostname
        r, dt, err = get(url, 15)
        if r is None:
            print(f"- {name}: dns={dns(host)} | {err} ({dt:.1f}s)")
        else:
            print(f"- {name}: HTTP {r.status_code} {dt:.1f}s | {cors(r)}")

    if not working:
        print("\nno working VizieR mirror with CORS")
        return 1
    working.sort()
    _, name, base = working[0]
    print(f"\n== using fastest mirror: {name}")

    for table in ("I/355/gaiadr3", "I/355/paramp"):
        r, dt, err = get(base + "?" + urlencode({"-source": table, "-c": f"{SRA} +{SDEC}", "-c.rs": "5",
                                                 "Source": SID, "-out.all": "1", "-out.max": "1"}), 60)
        if r is None:
            print(f"- {table}: {err}")
            continue
        h, rows = tsv(r.text)
        print(f"- {table} by Source + position, all columns ({dt:.1f}s): {len(h)} columns")
        if rows and table.endswith("paramp"):
            print("    " + " | ".join(f"{k}={v}" for k, v in rows[0].items() if v != ""))

    print("\n== field query at the largest radius the site allows (brightest 3000)")
    from astropy.coordinates import SkyCoord
    for l, b, rdeg in FIELDS:
        c = SkyCoord(l=l, b=b, unit="deg", frame="galactic").icrs
        params = {"-source": "I/355/gaiadr3", "-c": f"{c.ra.deg:.4f} {c.dec.deg:+.4f}", "-c.rd": str(rdeg),
                  "-out": "Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,Plx,e_Plx", "-out.max": "3000", "-sort": "Gmag"}
        r, dt, err = get(base + "?" + urlencode(params), 70)
        if r is None:
            print(f"- l={l} b={b} r={rdeg}: {err} ({dt:.1f}s)")
            continue
        h, rows = tsv(r.text)
        g = [float(x["Gmag"]) for x in rows if x.get("Gmag")]
        print(f"- l={l} b={b} r={rdeg}°: {dt:.1f}s, rows={len(rows)}, G {min(g) if g else None}..{max(g) if g else None}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
