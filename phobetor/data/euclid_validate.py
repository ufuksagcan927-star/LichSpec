#!/usr/bin/env python3
"""Veri setindeki her kesitin dosyalarini kontrol eder: 12 katman, 1024x1024, etiketler cercevede, onizleme var."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits

out = Path(sys.argv[1] if len(sys.argv) > 1 else "euclid_v1")
bad, n = [], 0
names = ["SCI_VIS", "SCI_Y", "SCI_J", "SCI_H", "RMS_VIS", "RMS_Y", "RMS_J", "RMS_H", "FLAG_VIS", "FLAG_Y", "FLAG_J", "FLAG_H"]
for part in ("train", "val", "test"):
    for fp in sorted((out / part / "goruntuler").glob("*.fits")):
        n += 1
        ad = fp.stem
        try:
            with fits.open(fp) as h:
                got = [x.name for x in h[1:]]
                assert got == names, f"katmanlar {got}"
                for x in h[1:]:
                    assert x.data.shape == (1024, 1024), f"{x.name} {x.data.shape}"
                vis = h["SCI_VIS"].data
                assert np.isfinite(vis).mean() > 0.7, "VIS cok bos"
            lab = pd.read_csv(out / part / "etiketler" / f"{ad}.csv")
            assert len(lab) > 0, "etiket yok"
            assert lab.x.between(-0.5, 1023.5).all() and lab.y.between(-0.5, 1023.5).all(), "etiket cerceve disinda"
            assert lab.object_id.is_unique, "tekrarlayan kaynak"
            assert (out / part / "onizleme" / f"{ad}.jpg").exists(), "onizleme yok"
        except Exception as e:  # noqa: BLE001
            bad.append((part, ad, str(e)[:120]))
print(f"{n} kesit kontrol edildi, {len(bad)} sorunlu")
for b in bad:
    print(b)
# ayni nesne iki kesitte mi? (kesitler cakismamali)
ids = []
for part in ("train", "val", "test"):
    for lp in (out / part / "etiketler").glob("*.csv"):
        ids.append(pd.read_csv(lp, usecols=["object_id"]).object_id)
ids = pd.concat(ids)
print("birden fazla kesitte gorunen kaynak:", int(ids.duplicated().sum()))
