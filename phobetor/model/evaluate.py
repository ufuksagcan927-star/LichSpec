#!/usr/bin/env python3
"""Egitilmis modeli test bolumunde (egitimde hic gorulmemis goruntuler) olcer.

    python evaluate.py --cache cache/euclid --run runs/euclid            (en_iyi.pt, bolum: test)

Esik dogrulama bolumunde secilir (dogrulama.json), test bolumunde sadece olculur; boylece sonuc
iyimser olmaz. Cikti: runs/.../test.json, test_parlaklik.csv, test_goruntuler/*.png (tespit kaplamalari).
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from common import IGN, POS, recall_by_mag, summarize
from net import PhobetorNet
from train import CacheSplit, evaluate_split


def load_model(path, device):
    s = torch.load(path, map_location=device, weights_only=False)
    cfg = s["cfg"]
    model = PhobetorNet(int(s["in_ch"]), base=int(cfg["base_channels"])).to(device)
    model.load_state_dict(s["model"])
    model.eval()
    return model, cfg, s


def overlay(path, x, lab, det, state, hit, thr, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    img = np.asarray(x[0], dtype=np.float32)
    lo, hi = np.percentile(img, [1, 99.7])
    fig, ax = plt.subplots(figsize=(9, 9), dpi=110)
    ax.imshow(img, cmap="gray", origin="lower", vmin=lo, vmax=hi, interpolation="nearest")
    p = lab["cls"] == POS
    keep = det[:, 2] >= thr
    d, st = det[keep], state[keep]
    found = (hit >= thr) & (hit > 0)
    px, py = lab["x"][p], lab["y"][p]
    ax.scatter(px[found], py[found], s=60, facecolors="none", edgecolors="#2ecc71", lw=1.0, label="bulunan yildiz")
    ax.scatter(px[~found], py[~found], s=60, facecolors="none", edgecolors="#e74c3c", lw=1.2, label="kacan yildiz")
    fp = d[st == 0]
    ax.scatter(fp[:, 0], fp[:, 1], s=40, marker="x", c="#f1c40f", lw=1.0, label="yanlis tespit")
    q = lab["cls"] == IGN
    ax.scatter(lab["x"][q], lab["y"][q], s=25, facecolors="none", edgecolors="#3498db", lw=0.6, alpha=0.6,
               label="yok sayilan (belirsiz)")
    ax.set_title(title, fontsize=10)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.7)
    ax.set_xticks([]), ax.set_yticks([])
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--run", required=True, help="egitim klasoru (en_iyi.pt burada)")
    ap.add_argument("--model", default="en_iyi.pt")
    ap.add_argument("--split", default="test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--figures", type=int, default=6, help="kaplama resmi cizilecek goruntu sayisi")
    a = ap.parse_args()
    run = Path(a.run)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, cfg, s = load_model(run / a.model, device)
    split = CacheSplit(a.cache, a.split)
    vfile = run / "dogrulama.json"
    thr = json.loads(vfile.read_text(encoding="utf-8"))["ozet"]["esik"] if vfile.exists() else s["val"]["esik"]
    res = evaluate_split(model, split, cfg, device, limit=a.limit)
    sm = summarize(res, thr=thr)
    best = summarize(res)  # bilgi icin: test bolumunde en iyi esik (secimde kullanilmaz)
    rb = recall_by_mag(res, cfg, thr)
    per = []
    for i, (det, st, hit, _) in enumerate(res):
        k = det[:, 2] >= thr
        per.append(dict(ad=split.items[i]["name"], yildiz=len(hit), bulunan=int(((hit >= thr) & (hit > 0)).sum()),
                        yanlis=int(((st == 0) & k).sum())))
    out = dict(bolum=a.split, model=a.model, adim=s.get("step"), esik_dogrulamadan=thr, sonuc=sm,
               bilgi_test_en_iyi_esik=best, goruntu_sayisi=len(res))
    (run / f"{a.split}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    rb.to_csv(run / f"{a.split}_parlaklik.csv", index=False)
    import pandas as pd
    pd.DataFrame(per).to_csv(run / f"{a.split}_goruntu.csv", index=False)
    print(json.dumps(out, indent=1, ensure_ascii=False))
    print(rb.to_string(index=False))
    if a.figures:
        fd = run / f"{a.split}_goruntuler"
        fd.mkdir(exist_ok=True)
        for i in range(min(a.figures, len(res))):
            x, _, lab = split.get(i)
            det, st, hit, _ = res[i]
            r = per[i]
            overlay(fd / f"{r['ad']}.png", x, lab, det, st, hit, thr,
                    f"{r['ad']}: {r['bulunan']}/{r['yildiz']} yildiz bulundu, {r['yanlis']} yanlis tespit (esik {thr:.3f})")
        print(f"kaplama resimleri: {fd}")


if __name__ == "__main__":
    main()
