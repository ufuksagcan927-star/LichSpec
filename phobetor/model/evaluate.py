#!/usr/bin/env python3
"""Egitilmis modeli test bolumunde (egitimde hic gorulmemis goruntuler) olcer.

    python evaluate.py --cache cache/euclid --run runs/euclid            (en_iyi.pt, bolum: test)

Sinif basina esikler dogrulama bolumunde secilir (dogrulama.json), test bolumunde sadece olculur; boylece
sonuc iyimser olmaz. Cikti (runs/... altinda):
  test.json               sinif basina kesinlik / duyarlilik / F1, karisiklik tablosu
  test_parlaklik.csv      sinif ve parlakliga gore duyarlilik
  test_ozellikler.csv     galaksi ozelliklerinde (uzaklik, kutle, boyut, bicim) hata
  test_goruntu.csv        goruntu basina sayilar
  test_goruntuler/*.png   tespit kaplamalari
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from common import IGN, class_names, finalize_config
from train import CacheSplit, build_model, full_report

COLORS = ["#2ecc71", "#e67e22", "#9b59b6", "#1abc9c", "#e84393"]


def load_model(path, device):
    s = torch.load(path, map_location=device, weights_only=False)
    cfg = finalize_config(s["cfg"])
    model = build_model(cfg, int(s["in_ch"]), device)
    model.load_state_dict(s["model"])
    model.eval()
    return model, cfg, s


def thresholds(run, cfg, s):
    vfile = Path(run) / "dogrulama.json"
    esik = json.loads(vfile.read_text(encoding="utf-8"))["ozet"]["esik"] if vfile.exists() else s["val"]["esik"]
    if not isinstance(esik, dict):  # eski tek sinifli model
        esik = {class_names(cfg)[0]: esik}
    return [float(esik[n]) for n in class_names(cfg)]


def overlay(path, x, lab, det, m, thr, cfg, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = class_names(cfg)
    img = np.asarray(x[0], dtype=np.float32)
    lo, hi = np.percentile(img, [1, 99.7])
    fig, ax = plt.subplots(figsize=(9, 9), dpi=110)
    ax.imshow(img, cmap="gray", origin="lower", vmin=lo, vmax=hi, interpolation="nearest")
    t = np.array([0.0] + list(thr), np.float32)
    keep = det[:, 2] >= t[det[:, 3].astype(int)] if len(det) else np.zeros(0, bool)
    tgt = m["tgt"]
    found = np.zeros(len(lab["cls"]), np.int64)
    found[tgt[keep & (tgt >= 0)]] = det[keep & (tgt >= 0), 3].astype(np.int64)
    for k, n in enumerate(names, start=1):
        p = lab["cls"] == k
        ok = p & (found == k)
        wrong = p & (found > 0) & (found != k)
        miss = p & (found == 0)
        col = COLORS[(k - 1) % len(COLORS)]
        ax.scatter(lab["x"][ok], lab["y"][ok], s=60, facecolors="none", edgecolors=col, lw=1.0, label=f"{n}: dogru")
        if wrong.any():
            ax.scatter(lab["x"][wrong], lab["y"][wrong], s=60, facecolors="none", edgecolors=col, lw=1.0, ls="--",
                       label=f"{n}: bulundu, sinif yanlis")
        ax.scatter(lab["x"][miss], lab["y"][miss], s=12, marker="s", facecolors="none", edgecolors=col, lw=0.6,
                   alpha=0.7, label=f"{n}: kacti")
    fp = det[keep & (tgt < 0) & ~m["ign"]]
    ax.scatter(fp[:, 0], fp[:, 1], s=40, marker="x", c="#e74c3c", lw=1.0, label="katalogda olmayan tespit")
    q = lab["cls"] == IGN
    ax.scatter(lab["x"][q], lab["y"][q], s=20, facecolors="none", edgecolors="#3498db", lw=0.5, alpha=0.5,
               label="yok sayilan")
    ax.set_title(title, fontsize=10)
    ax.legend(loc="upper right", fontsize=7, framealpha=0.7)
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
    ap.add_argument("--figures", type=int, default=6, help="kaplama resmi cizilecek goruntu sayisi")
    a = ap.parse_args()
    run = Path(a.run)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, cfg, s = load_model(run / a.model, device)
    split = CacheSplit(a.cache, a.split)
    thr = thresholds(run, cfg, s)
    stats = cfg.get("prop_stats", [])
    res, sm, rb, pe = full_report(model, split, cfg, device, run, a.split, thr=thr, stats=stats)
    names = class_names(cfg)
    t = np.array([0.0] + thr, np.float32)
    per = []
    for i, (det, m, lab) in enumerate(res):
        keep = det[:, 2] >= t[det[:, 3].astype(int)] if len(det) else np.zeros(0, bool)
        row = dict(ad=split.items[i]["name"])
        for k, n in enumerate(names, start=1):
            row[f"{n}_sayi"] = int((lab["cls"] == k).sum())
            ok = keep & (m["tgt"] >= 0)
            row[f"{n}_dogru"] = int((ok & (det[:, 3] == k) & (lab["cls"][np.maximum(m["tgt"], 0)] == k)).sum())
        row["katalogda_olmayan"] = int((keep & (m["tgt"] < 0) & ~m["ign"]).sum())
        per.append(row)
    pd.DataFrame(per).to_csv(run / f"{a.split}_goruntu.csv", index=False)
    out = dict(bolum=a.split, model=a.model, adim=s.get("step"), goruntu_sayisi=len(res), ozet=sm)
    (run / f"{a.split}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(out, indent=1, ensure_ascii=False))
    print(rb.to_string(index=False))
    if len(pe):
        print(pe.to_string(index=False))
    if a.figures:
        fd = run / f"{a.split}_goruntuler"
        fd.mkdir(exist_ok=True)
        for i in range(min(a.figures, len(res))):
            x, _, lab = split.get(i)
            det, m, _ = res[i]
            r = per[i]
            title = r["ad"] + ": " + ", ".join(f"{n} {r[f'{n}_dogru']}/{r[f'{n}_sayi']}" for n in names)
            overlay(fd / f"{r['ad']}.png", x, lab, det, m, thr, cfg, title)
        print(f"kaplama resimleri: {fd}")


if __name__ == "__main__":
    main()
