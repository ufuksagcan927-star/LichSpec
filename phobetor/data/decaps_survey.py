#!/usr/bin/env python3
"""
LichSpec / Phobetor - DECaPS2 kalabalik Samanyolu alanlari.

DECaPS2 (DECam Galactic Plane Survey), guney galaktik duzlemi (|b|<10) derin ve keskin
(~1") goruntuluyor. Hubble setinin zayif kaldigi cok kalabalik yildiz alanlarini doldurmak icin
Legacy Survey kesit servisinden r bandi kesitler alinir, Gaia DR3 ile etiketlenir.
Galaktik duzlemde arka plan galaksisi ihmal edilebilir oldugu icin tum Gaia kaynaklari yildiz sayilir.

Kullanim:
    python decaps_survey.py --n 150 --out data_decaps --workers 4
"""
import argparse
import io
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import http_get, make_labels, query_gaia  # noqa: E402
from degrade import snr_at  # noqa: E402

PIX = 0.262
SIZE = 1000  # px -> 4.4'


def pick_fields(n, seed=0):
    rng = np.random.default_rng(seed)
    # l: 240..365 (360'i asan kisim 0..5), b: -10..10, yogunluga gore cesitlilik icin duzgun dagilim
    l = rng.uniform(240, 365, n * 3) % 360
    b = rng.uniform(-9.5, 9.5, n * 3)
    c = SkyCoord(l=l * u.deg, b=b * u.deg, frame="galactic").icrs
    df = pd.DataFrame(dict(gal_l=l, gal_b=b, ra=c.ra.deg, dec=c.dec.deg))
    return df


def fetch(ra, dec):
    r = http_get("https://www.legacysurvey.org/viewer/fits-cutout",
                 dict(ra=ra, dec=dec, layer="decaps2", pixscale=PIX, bands="r", size=SIZE))
    with fits.open(io.BytesIO(r.content)) as h:
        data = h[0].data.astype(np.float32)
        hdr = h[0].header.copy()
    if data.ndim == 3:
        data = data[0]
    data[data == 0] = np.nan
    cov = float(np.isfinite(data).mean())
    if cov < 0.8:
        raise RuntimeError(f"DECaPS2 kapsami yok/eksik ({cov:.2f})")
    hdr["ORBI_BND"] = "r"
    hdr["ORBI_UNI"] = "nanomaggies"
    hdr["ORBI_EPO"] = 2018.0
    hdr["ORBI_SRV"] = "decaps2"
    return data, hdr


def process(row, out):
    name = row.field
    done = out / "labels" / f"{name}.csv"
    if done.exists():
        return "var"
    data, hdr = fetch(row.ra, row.dec)
    rad = SIZE * PIX / 3600 / np.sqrt(2) + 0.003
    gaia = query_gaia(row.ra, row.dec, rad, out / "gaia" / f"{name}.parquet")
    lab = make_labels(data, hdr, gaia, crowded=True)
    lab["snr_est"] = snr_at(data, lab.x.values, lab.y.values, 3.0) if len(lab) else []
    lab["detectable"] = lab.snr_est > 5
    hdr["ORBI_FLD"] = name
    fits.PrimaryHDU(data, header=hdr).writeto(out / "raw" / f"{name}.fits.gz", overwrite=True)
    lab.to_csv(done, index=False)
    return f"gaia={len(lab)} gorunur={int(lab.detectable.sum())}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--out", default="data_decaps")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("raw", "labels", "gaia"):
        (out / s).mkdir(parents=True, exist_ok=True)
    fp = out / "fields.csv"
    if not fp.exists():
        f = pick_fields(a.n)
        f["field"] = [f"dcp{i:04d}" for i in range(len(f))]
        f.to_csv(fp, index=False)
    f = pd.read_csv(fp)
    ok = 0
    log = open(out / "fetch_log.txt", "a")
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {}
        it = iter(f.itertuples())
        # n basarili alana ulasana kadar adaylari sirayla dene
        for r in [next(it) for _ in range(min(a.workers * 2, len(f)))]:
            futs[ex.submit(process, r, out)] = r.field
        while futs:
            for fu in as_completed(list(futs)):
                name = futs.pop(fu)
                try:
                    msg = fu.result()
                    ok += 1
                except Exception as e:
                    msg = "HATA: " + str(e)[:120]
                    if "kapsami" not in str(e):
                        (out / "errors.txt").open("a").write(f"{name}\n{traceback.format_exc()}\n")
                line = f"[ok={ok}] {name} {msg}"
                print(line, flush=True)
                log.write(line + "\n")
                log.flush()
                if ok + len(futs) < a.n:
                    nxt = next(it, None)
                    if nxt is not None:
                        futs[ex.submit(process, nxt, out)] = nxt.field
                break
    print(f"Bitti: {ok} alan")


if __name__ == "__main__":
    main()
