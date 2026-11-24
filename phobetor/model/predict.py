#!/usr/bin/env python3
"""Egitilmis modelle yeni FITS goruntulerinde yildiz bulur; her goruntu icin bir CSV yazar
(x, y piksel; FITS'te gok koordinati (WCS) varsa ra, dec; skor).

    python predict.py --model runs/euclid/en_iyi.pt --out tahminler goruntu1.fits goruntu2.fits

Goruntunun katmanlari egitimdeki ayar dosyasiyla ayni olmalidir (ayni kamera, ayni bantlar).
Esik verilmezse dogrulama bolumunde secilen esik kullanilir.
"""
import argparse
import json
from pathlib import Path

import pandas as pd
import torch

from common import decode, read_image
from evaluate import load_model
from prepare import sample_name
from train import predict_full


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--thr", type=float, default=0.0)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, cfg, s = load_model(a.model, device)
    thr = a.thr
    if not thr:
        vfile = Path(a.model).parent / "dogrulama.json"
        thr = json.loads(vfile.read_text(encoding="utf-8"))["ozet"]["esik"] if vfile.exists() else s["val"]["esik"]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in a.files:
        x, valid, _ = read_image(f, cfg)
        heat, off = predict_full(model, x, device)
        heat[~valid] = 0.0
        det = decode(heat, off, thr=thr)
        d = pd.DataFrame(dict(x=det[:, 0], y=det[:, 1], skor=det[:, 2]))
        try:
            from astropy.io import fits
            from astropy.wcs import WCS
            with fits.open(f) as h:
                b = cfg["bands"][0]
                hdr = h[b].header if isinstance(b, str) else h[int(b)].header
            w = WCS(hdr)
            if w.has_celestial and len(d):
                ra, dec = w.celestial.wcs_pix2world(d.x.to_numpy(), d.y.to_numpy(), 0)
                d["ra"], d["dec"] = ra, dec
        except Exception as e:  # WCS yoksa sadece piksel koordinati yazilir
            print(f"  {f}: gok koordinati yok ({e.__class__.__name__})")
        d = d.sort_values("skor", ascending=False)
        p = out / f"{sample_name(f)}_yildizlar.csv"
        d.to_csv(p, index=False, float_format="%.6g")
        print(f"{f}: {len(d)} yildiz (esik {thr:.3f}) -> {p}")


if __name__ == "__main__":
    main()
