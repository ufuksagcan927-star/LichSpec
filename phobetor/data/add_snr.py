#!/usr/bin/env python3
"""Orijinal Hubble etiketlerine goruntuden olculen SNR ve 'detectable' (SNR>5) sutunu ekler.
HSC bazen baska filtrede/daha derin goruntude bulunan, bu kesitte gorunmeyen kaynaklar icerir;
egitimde detectable==True olanlari kullanmak modelin hayali yildiz gormesini engeller."""
import sys
from pathlib import Path
import numpy as np, pandas as pd
from astropy.io import fits
from degrade import snr_at

root = Path(sys.argv[1] if len(sys.argv) > 1 else "data_hst")
for p in sorted((root / "labels").glob("*.csv")):
    lab = pd.read_csv(p)
    if "snr_est" in lab.columns or not len(lab):
        continue
    d = fits.getdata(root / "raw" / f"{p.stem}.fits.gz").astype(np.float32)
    lab["snr_est"] = snr_at(d, lab.x.values, lab.y.values, 2.0)
    lab["detectable"] = lab.snr_est > 5
    lab.to_csv(p, index=False)
