#!/usr/bin/env python3
"""Genis alan veri seti kontrolu: bolum / sinif sayilari, etiket tutarliligi ve ornek kaplama resmi.
    python genis_kontrol.py --data genis_v1 --out genis_v1/ozet
"""
import argparse, glob
from pathlib import Path
import numpy as np, pandas as pd
from astropy.io import fits
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse

COL = {"galaksi": "#f39c12", "acik_kume": "#3498db", "kuresel_kume": "#9b59b6", "gezegenimsi_bulutsu": "#2ecc71",
       "salma_bulutsusu": "#e74c3c", "bulutsu": "#e84393", "yansima_bulutsusu": "#00cec9", "supernova_kalintisi": "#fdcb6e",
       "kume_ve_bulutsu": "#ff7675", "yok_say": "#bbbbbb"}


def rgb(path):
    with fits.open(path) as h:
        b = [np.asarray(h[k].data, np.float32) for k in ("DSS_KIZILOTESI", "DSS_KIRMIZI", "DSS_MAVI")]
    out = []
    for a in b:
        if not np.isfinite(a).any():
            out.append(np.zeros_like(a)); continue
        lo, hi = np.nanpercentile(a, [5, 99.9])
        out.append(np.clip(np.arcsinh((a - lo) / max(hi - lo, 1e-6) * 5) / np.arcsinh(5), 0, 1))
    return np.nan_to_num(np.stack(out, -1))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=12); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--isaretle", action="store_true", help="bolumler arasi nesnelere baska_bolumde sutunu ekle")
    a = ap.parse_args(); root, out = Path(a.data), Path(a.out); out.mkdir(parents=True, exist_ok=True)
    idx = pd.read_csv(root / "index.csv")
    labs, problems = [], []
    for _, r in idx.iterrows():
        p = root / r.bolum / "etiketler" / f"{r.ad}.csv"
        if not (root / r.bolum / "goruntuler" / f"{r.ad}.fits").exists() or not p.exists():
            problems.append(f"{r.ad}: dosya eksik"); continue
        L = pd.read_csv(p); L["alan"] = r.ad; L["bolum"] = r.bolum; labs.append(L)
        if not L.hedef.any():
            problems.append(f"{r.ad}: hedef nesne etiketlerde yok")
        if ((L.x < -0.5) | (L.x > r.boyut - 0.5) | (L.y < -0.5) | (L.y > r.boyut - 0.5)).any():
            problems.append(f"{r.ad}: goruntu disinda etiket")
    L = pd.concat(labs, ignore_index=True)
    tab = pd.crosstab(L.sinif, L.bolum, margins=True, margins_name="toplam")
    tab.to_csv(out / "sinif_bolum_sayilari.csv")
    # ayni nesne birden fazla bolumde mi? (alanlar arasi sizinti)
    multi = L.groupby("ad").bolum.nunique()
    leak = multi[multi > 1]
    print(tab.to_string()); print(f"\n{len(idx)} alan, {len(L)} etiket, {len(problems)} sorun, birden fazla bolumde gorunen nesne: {len(leak)}")
    print("eksik bant:", idx.eksik_bant.fillna("").ne("").sum(), "alan")
    (out / "sorunlar.txt").write_text("\n".join(problems), encoding="utf-8")
    leak.to_csv(out / "bolumler_arasi_nesneler.csv")
    if a.isaretle:
        # etiket degismez; yalnizca "baska_bolumde" sutunu eklenir (ayar dosyasi bunlari yok sayar)
        for _, r in idx.iterrows():
            p = root / r.bolum / "etiketler" / f"{r.ad}.csv"
            d = pd.read_csv(p)
            d["baska_bolumde"] = d.ad.isin(leak.index)
            d.to_csv(p, index=False)
        print("baska_bolumde sutunu yazildi:", int(L.ad.isin(leak.index).sum()), "etiket")
    rng = np.random.default_rng(a.seed)
    pick = []
    for s in ["gezegenimsi_bulutsu", "salma_bulutsusu", "yansima_bulutsusu", "supernova_kalintisi", "bulutsu", "kume_ve_bulutsu", "kuresel_kume", "acik_kume", "galaksi"]:
        c = idx[idx.sinif == s]
        if len(c):
            pick.append(c.iloc[rng.integers(len(c))])
    while len(pick) < a.n:
        pick.append(idx.iloc[rng.integers(len(idx))])
    fig, axs = plt.subplots(3, 4, figsize=(16, 12.5), dpi=100)
    for ax, r in zip(axs.ravel(), pick):
        ax.imshow(rgb(root / r.bolum / "goruntuler" / f"{r.ad}.fits"), origin="lower")
        lab = pd.read_csv(root / r.bolum / "etiketler" / f"{r.ad}.csv")
        for _, o in lab.iterrows():
            c = COL.get(o.sinif, "w")
            maj = o.buyuk_eksen_px if np.isfinite(o.buyuk_eksen_px) else 12
            mi = o.kucuk_eksen_px if np.isfinite(o.kucuk_eksen_px) else maj
            ax.add_patch(Ellipse((o.x, o.y), mi, maj, angle=o.aci_derece if np.isfinite(o.aci_derece) else 0, fill=False, ec=c, lw=1.0))
            ax.text(o.x, o.y + maj / 2 + 4, f"{o.ad} {o.sinif}", color=c, fontsize=6, ha="center")
        ax.set_title(f"{r.ad} ({r.bolum}, {r.alan_yaydk:.0f}', {r.olcek:.1f}\"/px)", fontsize=8); ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("Genis alan veri seti: DSS2 (kizilotesi / kirmizi / mavi) + OpenNGC etiketleri", fontsize=10)
    fig.tight_layout(); fig.savefig(out / "ozet_kontrol.png"); print("resim:", out / "ozet_kontrol.png")


if __name__ == "__main__":
    main()
