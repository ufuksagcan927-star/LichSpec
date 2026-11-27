#!/usr/bin/env python3
"""Egitilmis modelle yeni FITS goruntulerinde nesne bulur ve siniflar; her goruntu icin bir CSV yazar:
x, y (piksel), FITS'te gok koordinati (WCS) varsa ra, dec; sinif, skor, sinif olasiliklari ve
(modelde varsa) galaksi ozellikleri (uzaklik, kutle, boyut, bicim oylari).

    python predict.py --model runs/euclid/en_iyi.pt --out tahminler goruntu1.fits goruntu2.fits

Goruntunun katmanlari egitimdeki ayar dosyasiyla ayni olmalidir (ayni kamera, ayni bantlar).
Esikler verilmezse dogrulama bolumunde secilen sinif esikleri kullanilir.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from common import _inv_tf, class_names, decode, read_image
from evaluate import load_model, thresholds
from prepare import sample_name
from train import predict_full


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--thr", type=float, default=0.0, help="butun siniflar icin tek esik (verilmezse dogrulamadakiler)")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, cfg, s = load_model(a.model, device)
    names = class_names(cfg)
    K = len(names)
    thr = [a.thr] * K if a.thr else thresholds(Path(a.model).parent, cfg, s)
    t = np.array([0.0] + thr, np.float32)
    props, stats = cfg.get("props", []), cfg.get("prop_stats", [])
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in a.files:
        x, valid, _ = read_image(f, cfg)
        heat, off, pmap = predict_full(model, x, device)
        heat[:, ~valid] = 0.0
        det = decode(heat, off, pmap, thr=min(thr))
        det = det[det[:, 2] >= t[det[:, 3].astype(int)]]
        d = pd.DataFrame(dict(x=det[:, 0], y=det[:, 1], sinif=[names[int(c) - 1] for c in det[:, 3]], skor=det[:, 2]))
        for k, n in enumerate(names):
            d[f"olasilik_{n}"] = det[:, 4 + k]
        for j, pr in enumerate(props):
            v = det[:, 4 + K + j]
            if pr.get("kind", "reg") == "frac":
                v = 1 / (1 + np.exp(-v))
            else:
                v = _inv_tf(v * stats[j]["std"] + stats[j]["mean"], pr.get("tf", "none")) / float(pr.get("scale", 1.0))
            ok = np.isin(d.sinif, pr.get("classes", names))
            d[pr["ad"]] = np.where(ok, v, np.nan)
        try:
            from astropy.io import fits
            from astropy.wcs import WCS
            with fits.open(f) as h:
                b = cfg["bands"][0]
                hdr = h[b].header if isinstance(b, str) else h[int(b)].header
            w = WCS(hdr)
            if w.has_celestial and len(d):
                ra, dec = w.celestial.wcs_pix2world(d.x.to_numpy(), d.y.to_numpy(), 0)
                d.insert(2, "ra", ra)
                d.insert(3, "dec", dec)
        except Exception as e:  # WCS yoksa sadece piksel koordinati yazilir
            print(f"  {f}: gok koordinati yok ({e.__class__.__name__})")
        d = d.sort_values("skor", ascending=False)
        p = out / f"{sample_name(f)}_nesneler.csv"
        d.to_csv(p, index=False, float_format="%.6g")
        counts = ", ".join(f"{n} {int((d.sinif == n).sum())}" for n in names)
        print(f"{f}: {len(d)} nesne ({counts}) -> {p}")


if __name__ == "__main__":
    main()
