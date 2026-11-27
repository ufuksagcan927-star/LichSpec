#!/usr/bin/env python3
"""Fetch the published catalogues tools/build_sky_objects.py combines with OpenNGC.

    python tools/fetch_sky_tables.py --out sky-tables [--print]

Every table comes from VizieR (CDS Strasbourg, or its CfA and IDIA mirrors) as tab-separated
text with all columns plus J2000 positions in decimal degrees (_RAJ2000, _DEJ2000), and is saved
as <out>/<catalogue id, "/" replaced by "_">.tsv. OpenNGC (NGC.csv, addendum.csv) comes from its
GitHub repository. Cosmicflows-4 is large; only the galaxies OpenNGC lists (by PGC number) are kept.

With --print the folder is also written to the log as a base64 tar.gz between SKY-TABLES-BEGIN
and SKY-TABLES-END lines, so the tables can be copied out of a CI log.
"""
import argparse
import base64
import csv
import io
import re
import sys
import tarfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

MIRRORS = [
    "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
    "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
    "https://vizier.idia.ac.za/viz-bin/asu-tsv",
]
OPENNGC = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/"

# (VizieR id, what it is). A catalogue id without a table name fetches all its tables.
TABLES = [
    ("B/psr/psr", "ATNF Pulsar Catalogue (Manchester+ 2005), current version"),
    ("J/ApJS/212/6/table9", "McGill Online Magnetar Catalog (Olausen & Kaspi 2014): positions"),
    ("J/ApJS/212/6/table10", "McGill Online Magnetar Catalog: spin and distance"),
    ("J/A+A/587/A61/tablea1", "BlackCAT (Corral-Santana+ 2016): sources"),
    ("J/A+A/587/A61/tablea4", "BlackCAT: orbits and masses"),
    ("J/ApJS/222/15/table12", "WATCHDOG (Tetarenko+ 2016): sources"),
    ("J/ApJS/222/15/table13", "WATCHDOG: distances, masses and orbits"),
    ("J/A+A/673/A114/clusters", "Open clusters from Gaia DR3 (Hunt & Reffert 2023)"),
    ("J/A+A/640/A1/table1", "Open clusters from Gaia DR2 (Cantat-Gaudin+ 2020)"),
    ("VII/202", "Milky Way globular clusters (Harris 1996, 2010 edition)"),
    ("J/MNRAS/478/1520/table2", "Globular cluster distances and masses (Baumgardt & Hilker 2018)"),
    ("J/A+A/656/A51/tablea1", "Planetary nebula central stars in Gaia EDR3 (Gonzalez-Santamaria+ 2021)"),
    ("J/A+A/656/A51/tablea2", "Planetary nebula distances from those parallaxes"),
    ("J/AJ/145/101/catalog", "Updated Nearby Galaxy Catalog (Karachentsev+ 2013)"),
    ("J/ApJ/944/94/table2", "Cosmicflows-4 galaxy distances (Tully+ 2023)"),
    ("VII/284", "Galactic supernova remnants (Green 2019)"),
    ("VII/220A/barnard", "Barnard's dark objects (Barnard 1927)"),
    ("VII/20", "Sharpless HII regions (Sharpless 1959)"),
    ("VI/42", "Constellation boundaries in B1875 coordinates (Roman 1987)"),
]
FILTER_PGC = {"J/ApJ/944/94/table2"}


def get(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "lichspec-catalogue-builder"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def vizier(source, timeout=240):
    q = urllib.parse.urlencode({
        "-source": source, "-out.all": "1", "-out.add": "_RAJ,_DEJ", "-oc.form": "dec",
        "-out.max": "unlimited",
    })
    errors = []
    for m in MIRRORS:
        t = time.time()
        try:
            text = get(f"{m}?{q}", timeout)
            if "#Table" not in text and "#RESOURCE" not in text:
                raise ValueError("no table in the answer: " + text[:200].replace("\n", " "))
            return text, m, time.time() - t
        except Exception as e:  # noqa: BLE001 - try the next mirror
            errors.append(f"{urllib.parse.urlparse(m).netloc}: {type(e).__name__} {str(e)[:160]}")
    raise RuntimeError("; ".join(errors))


def pgc_numbers(root):
    """PGC numbers of the OpenNGC galaxies (Identifiers column, e.g. "PGC 002557")."""
    out = set()
    for name in ("NGC.csv", "addendum.csv"):
        with open(root / name, encoding="utf-8") as fh:
            for row in csv.DictReader(fh, delimiter=";"):
                for m in re.finditer(r"PGC\s*0*(\d+)", row.get("Identifiers") or ""):
                    out.add(int(m.group(1)))
    return out


def keep_pgc(text, pgcs):
    """Keep the header lines and the data rows whose PGC column is in pgcs, per table."""
    out, header, pgc_i, kept, total = [], None, None, 0, 0
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            out.append(line)
            header, pgc_i = None, None
            continue
        if header is None:
            header = [h.strip() for h in line.split("\t")]
            pgc_i = next((i for i, h in enumerate(header) if h.upper() in ("PGC", "PGC1", "PGCID")), None)
            out.append(line)
            continue
        if set(line) <= set("-\t "):
            out.append(line)
            continue
        cells = line.split("\t")
        total += 1
        if pgc_i is None:
            if total <= 30:
                out.append(line)          # no PGC column: keep a sample to show the layout
            continue
        try:
            if int(float(cells[pgc_i])) in pgcs:
                out.append(line)
                kept += 1
        except (ValueError, IndexError):
            pass
    return "\n".join(out) + "\n", kept, total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="sky-tables")
    ap.add_argument("--print", action="store_true", help="write the folder to the log as base64 tar.gz")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for name in ("NGC.csv", "addendum.csv"):
        (out / name).write_text(get(OPENNGC + name, 120), encoding="utf-8")
    pgcs = pgc_numbers(out)
    print(f"OpenNGC: {len(pgcs)} PGC numbers", flush=True)

    failed = []
    for source, what in TABLES:
        try:
            text, mirror, dt = vizier(source)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {source} ({what}): {e}", flush=True)
            failed.append(source)
            continue
        note = ""
        if source in FILTER_PGC:
            text, kept, total = keep_pgc(text, pgcs)
            note = f", kept {kept} of {total} rows (PGC in OpenNGC)"
        path = out / (source.replace("/", "_") + ".tsv")
        path.write_text(text, encoding="utf-8")
        tables = re.findall(r"^#Table\s+(\S+)", text, flags=re.M)
        print(f"OK   {source} ({what}): {len(text) / 1024:.0f} KB from {urllib.parse.urlparse(mirror).netloc} "
              f"in {dt:.1f}s; tables {', '.join(tables) or '?'}{note}", flush=True)
        # the column header of every table, to check the build script reads the right ones
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            if ln.startswith("#Table"):
                j = i + 1
                while j < len(lines) and (lines[j].startswith("#") or not lines[j].strip()):
                    j += 1
                if j < len(lines):
                    print(f"     {ln.split()[1]} columns: {lines[j][:900]}", flush=True)

    if args.print:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
            tar.add(out, arcname=out.name)
        b64 = base64.b64encode(buf.getvalue()).decode()
        print(f"::group::sky tables archive ({len(buf.getvalue()) / 1024:.0f} KB gz)")
        print("SKY-TABLES-BEGIN")
        for i in range(0, len(b64), 4000):
            print("SKY-TABLES " + b64[i:i + 4000])
        print("SKY-TABLES-END")
        print("::endgroup::")
    if failed:
        print(f"{len(failed)} table(s) failed: {', '.join(failed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
