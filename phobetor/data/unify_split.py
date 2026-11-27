#!/usr/bin/env python3
"""
LichSpec / Phobetor - ek kaynaklari (WFC3, DECaPS2, JWST) ACS ile AYNI gokyuzu bolgesi ayrimina baglar.

Her alanin 30x30 derecelik hucresi bulunur ve data_hst/split.csv'deki hucre -> train/val/test
eslemesi uygulanir. Boylece bir test bolgesindeki hicbir alan, hangi teleskoptan gelirse gelsin,
egitime girmez. Dogrulama/test alanlari icin sabit bozulmus kopyalar da uretilir.

Kullanim:
    python unify_split.py --ref data_hst --data data_wfc3 data_decaps data_jwst --variants 3
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from astropy.wcs import WCS

from degrade import degrade, snr_at


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="data_hst")
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--variants", type=int, default=3)
    ap.add_argument("--seed", type=int, default=321)
    a = ap.parse_args()
    ref = pd.read_csv(Path(a.ref) / "split.csv")
    cell_map = ref.groupby("cell").split.first().to_dict()
    rng = np.random.default_rng(a.seed)
    for d in a.data:
        root = Path(d)
        f = pd.read_csv(root / "fields.csv")
        ra = f["s_ra"] if "s_ra" in f else f["ra"]
        dec = f["s_dec"] if "s_dec" in f else f["dec"]
        f["ra_"], f["dec_"] = ra, dec
        f["cell"] = (ra // 30).astype(int) * 10 + ((dec + 90) // 30).astype(int)
        f = f[[(root / "labels" / f"{n}.csv").exists() for n in f.field]].reset_index(drop=True)
        f["split"] = f.cell.map(cell_map).fillna("train")
        f[["field", "ra_", "dec_", "cell", "split"]].rename(columns={"ra_": "ra", "dec_": "dec"}).to_csv(
            root / "split.csv", index=False)
        print(d, f.split.value_counts().to_dict(), flush=True)
        (root / "degraded").mkdir(exist_ok=True)
        (root / "labels_degraded").mkdir(exist_ok=True)
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
                dimg, k, p = degrade(img, rng)
                nl = lab.copy()
                nl["x"] = (nl.x + 0.5) / k - 0.5
                nl["y"] = (nl.y + 0.5) / k - 0.5
                ny, nx = dimg.shape
                nl = nl[(nl.x >= 0) & (nl.x < nx - 1) & (nl.y >= 0) & (nl.y < ny - 1)].reset_index(drop=True)
                r = max(2.0, 1.5 * (1 + p["blur_sigma_px"] / k))
                nl["snr_est"] = snr_at(dimg, nl.x.values, nl.y.values, r) if len(nl) else []
                nl["detectable"] = nl.snr_est > 5
                h2 = (w[::k, ::k] if k > 1 else w).to_header()
                h2["ORBI_FLD"] = row.field
                h2["ORBI_DEG"] = json.dumps(p)[:68]
                fits.PrimaryHDU(dimg, header=h2).writeto(root / "degraded" / f"{name}.fits.gz", overwrite=True)
                nl.to_csv(root / "labels_degraded" / f"{name}.csv", index=False)
                p.update(field=row.field, split=row.split, shape=list(dimg.shape), n_labels=int(len(nl)))
                meta[name] = p
        (root / "degraded_meta.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
