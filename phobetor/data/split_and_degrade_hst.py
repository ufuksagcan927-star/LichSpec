#!/usr/bin/env python3
"""
LichSpec / Phobetor - Hubble veri seti icin egitim/dogrulama/test ayrimi + sabit bozulmus test seti.

Ayrim GOKYUZU BOLGESINE gore yapilir (RA/Dec 30 derecelik hucreler): ayni bolgedeki alanlar
hep ayni kumeye duser, boylece model test alanlarini hic gormemis olur (ezber engellenir).

Egitim icin bozulma diskte saklanmaz: egitim sirasinda degrade.degrade() her seferinde farkli
rastgele bozulma uretir (sonsuz cesitlilik, disk tasarrufu). Dogrulama ve test icin ise
tekrarlanabilir olcum yapabilmek adina sabit tohumla her alandan --variants kopya diske yazilir.

Kullanim:
    python split_and_degrade_hst.py --data data_hst --variants 3
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from astropy.wcs import WCS

from degrade import degrade, snr_at


def make_split(fields, seed=7, frac=(0.8, 0.1, 0.1)):
    rng = np.random.default_rng(seed)
    cells = np.array(sorted(fields.cell.unique()))
    rng.shuffle(cells)
    # hucreleri, alan sayisi oranlari tutacak sekilde sirayla dagit
    counts = fields.groupby("cell").size()
    target = np.array(frac) * len(fields)
    have = np.zeros(3)
    assign = {}
    for c in cells:
        k = int(np.argmax(target - have))
        assign[c] = ["train", "val", "test"][k]
        have[k] += counts.get(c, 0)
    return fields.cell.map(assign)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data_hst")
    ap.add_argument("--variants", type=int, default=3)
    ap.add_argument("--seed", type=int, default=123)
    a = ap.parse_args()
    root = Path(a.data)
    f = pd.read_csv(root / "fields.csv")
    f = f[[(root / "labels" / f"{n}.csv").exists() for n in f.field]].reset_index(drop=True)
    f["split"] = make_split(f)
    f[["field", "target_name", "cls", "s_ra", "s_dec", "gal_b", "cell", "split"]].to_csv(root / "split.csv", index=False)
    print(f.split.value_counts().to_dict())

    (root / "degraded").mkdir(exist_ok=True)
    (root / "labels_degraded").mkdir(exist_ok=True)
    rng = np.random.default_rng(a.seed)
    meta = {}
    for row in f[f.split != "train"].itertuples():
        lab = pd.read_csv(root / "labels" / f"{row.field}.csv")
        with fits.open(root / "raw" / f"{row.field}.fits.gz") as h:
            img, hdr = h[0].data.astype(np.float32), h[0].header
        w = WCS(hdr, naxis=2)
        for i in range(a.variants):
            name = f"{row.field}_d{i}"
            if (root / "labels_degraded" / f"{name}.csv").exists():
                continue
            d, k, p = degrade(img, rng)
            nl = lab.copy()
            nl["x"] = (nl.x + 0.5) / k - 0.5
            nl["y"] = (nl.y + 0.5) / k - 0.5
            ny, nx = d.shape
            nl = nl[(nl.x >= 0) & (nl.x < nx - 1) & (nl.y >= 0) & (nl.y < ny - 1)].reset_index(drop=True)
            r = max(2.0, 1.5 * (1 + p["blur_sigma_px"] / k))
            nl["snr_est"] = snr_at(d, nl.x.values, nl.y.values, r) if len(nl) else []
            nl["detectable"] = nl.snr_est > 5
            h2 = (w[::k, ::k] if k > 1 else w).to_header()
            h2["ORBI_FLD"] = row.field
            h2["ORBI_DEG"] = json.dumps(p)[:68]
            fits.PrimaryHDU(d, header=h2).writeto(root / "degraded" / f"{name}.fits.gz", overwrite=True)
            nl.to_csv(root / "labels_degraded" / f"{name}.csv", index=False)
            p.update(field=row.field, split=row.split, shape=list(d.shape), n_labels=int(len(nl)),
                     n_detectable=int(nl.detectable.sum()))
            meta[name] = p
        print(row.field, row.split, flush=True)
    old = json.loads((root / "degraded_meta.json").read_text()) if (root / "degraded_meta.json").exists() else {}
    old.update(meta)
    (root / "degraded_meta.json").write_text(json.dumps(old, indent=1))


if __name__ == "__main__":
    main()
