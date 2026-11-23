#!/usr/bin/env python3
"""Renkli JWST alanlarini sade veri seti yapisina (train/val/test, images + labels) ekler.
Ayrim ACS ile ayni gokyuzu hucresi eslemesini kullanir."""
import argparse, shutil
from pathlib import Path
import numpy as np, pandas as pd
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="data_jwst_mb")
ap.add_argument("--ref", default="data_hst/split.csv")
ap.add_argument("--out", default="veri seti hazir")
a = ap.parse_args()
src, out = Path(a.src), Path(a.out)
cells = pd.read_csv(a.ref).groupby("cell").split.first().to_dict()
f = pd.read_csv(src / "fields.csv")
rows = []
for r in f.itertuples():
    lp = src / "labels" / f"{r.field}.csv"
    if not lp.exists():
        continue
    part = cells.get(int(r.s_ra // 30) * 10 + int((r.s_dec + 90) // 30), "train")
    lab = pd.read_csv(lp)
    lab = lab[lab.is_star.astype(str).str.lower().isin(["true", "1"]) & lab.detectable.astype(str).str.lower().isin(["true", "1"])]
    im = Image.open(src / "rgb" / f"{r.field}.png")
    h = im.size[1]
    mag = lab.g_mag if "g_mag" in lab else np.nan
    o = pd.DataFrame(dict(x=lab.x.round(2), y=(h - 1 - lab.y).round(2), parlaklik_mag=np.round(mag, 3),
                          kaynak=lab.catalog, gaia_id=lab.source_id.where(lab.catalog == "gaia", "")))
    for d in ("images", "labels"):
        (out / part / d).mkdir(parents=True, exist_ok=True)
    shutil.copy(src / "rgb" / f"{r.field}.png", out / part / "images" / f"{r.field}.png")
    o.to_csv(out / part / "labels" / f"{r.field}.csv", index=False)
    rows.append(dict(ad=r.field, bolum=part, teleskop="jwst_renkli", genislik=im.size[0], yukseklik=h, yildiz_sayisi=len(o)))
idx = pd.DataFrame(rows)
ip = out / "index.csv"
if ip.exists():
    old = pd.read_csv(ip)
    idx = pd.concat([old[~old.ad.isin(idx.ad)], idx])
idx.to_csv(ip, index=False)
print(idx[idx.teleskop == "jwst_renkli"].groupby("bolum").agg(resim=("ad", "count"), yildiz=("yildiz_sayisi", "sum")))
