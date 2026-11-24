#!/usr/bin/env python3
"""Bir veri seti klasorunu inceler ve ayar dosyasini (configs/*.json) doldurmak icin gereken her seyi yazar:
klasor agaci, bir FITS dosyasinin katmanlari (HDU), bir etiket dosyasinin sutunlari ve ilk satirlari.

    python inspect_data.py "D:/veri seti v2/phobetor_phast"
    python inspect_data.py "D:/veri seti v2/phobetor_phast" --config configs/phast.json   (ayari da dener)

Ciktiyi bir dosyaya kaydetmek icin sonuna  > inceleme.txt  ekle.
"""
import argparse
import glob
import os
from collections import Counter
from pathlib import Path

import numpy as np


def tree(root, depth=2):
    root = Path(root)
    print(f"\n== Klasor agaci: {root}")
    for cur, dirs, files in os.walk(root):
        rel = Path(cur).relative_to(root)
        lvl = len(rel.parts)
        if lvl > depth:
            dirs[:] = []
            continue
        dirs.sort()
        ext = Counter(Path(f).suffix.lower() or "(uzantisiz)" for f in files)
        size = sum(os.path.getsize(os.path.join(cur, f)) for f in files) / 1e6
        ex = ", ".join(f"{k}: {v}" for k, v in ext.most_common(6))
        print(f"{'  ' * lvl}{rel if lvl else '.'}/  [{len(files)} dosya, {size:.0f} MB; {ex}]")
        for f in sorted(files)[:3]:
            print(f"{'  ' * lvl}    {f}")


def show_fits(path):
    from astropy.io import fits
    print(f"\n== FITS ornegi: {path}")
    with fits.open(path) as h:
        h.info()
        for i, hdu in enumerate(h):
            hd = hdu.header
            keys = [k for k in ("EXTNAME", "BUNIT", "FILTER", "FILTER1", "FILTER2", "INSTRUME", "DETECTOR", "TELESCOP",
                                "EXPTIME", "PHOTFLAM", "PHOTZPT", "ZP", "MAGZERO", "GAIN", "CTYPE1", "CDELT1", "CD1_1",
                                "PC1_1") if k in hd]
            print(f"  [{i}] " + "  ".join(f"{k}={hd[k]}" for k in keys))
            if hdu.data is not None and hasattr(hdu.data, "shape") and hdu.data.ndim >= 2:
                d = np.asarray(hdu.data, dtype=np.float64)
                f = d[np.isfinite(d)]
                if f.size:
                    p = np.percentile(f, [0.1, 1, 50, 99, 99.9])
                    print(f"      boyut={d.shape} sonlu=%{100 * f.size / d.size:.1f} sifir=%{100 * np.mean(f == 0):.1f} "
                          f"yuzdelik(0.1,1,50,99,99.9)={np.round(p, 4).tolist()}")
                    if np.issubdtype(hdu.data.dtype, np.integer) and d.max() > 1:
                        bits = [b for b in range(32) if np.any((hdu.data.astype(np.int64) >> b) & 1)]
                        print(f"      tam sayi katman, acik bitler: {bits}")


def show_table(path):
    import pandas as pd
    print(f"\n== Etiket ornegi: {path}")
    if path.lower().endswith((".csv", ".txt")):
        d = pd.read_csv(path, low_memory=False)
    elif path.lower().endswith(".parquet"):
        d = pd.read_parquet(path)
    else:
        from astropy.table import Table
        d = Table.read(path).to_pandas()
    print(f"  {len(d)} satir, {len(d.columns)} sutun")
    for c in d.columns:
        s = d[c]
        line = f"  {c:<28} {str(s.dtype):<10} bos={int(s.isna().sum())}"
        if s.nunique(dropna=True) <= 12:
            line += f"  degerler={dict(s.value_counts(dropna=False).head(12))}"
        elif pd.api.types.is_numeric_dtype(s):
            line += f"  aralik=[{s.min():.4g}, {s.max():.4g}]"
        print(line)
    print("\n  ilk 3 satir:")
    print(d.head(3).T.to_string())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--config", default="")
    a = ap.parse_args()
    root = Path(a.root)
    tree(root)
    fits_files = sorted(glob.glob(str(root / "**" / "*.fits*"), recursive=True)) + \
        sorted(glob.glob(str(root / "**" / "*.fit"), recursive=True))
    tables = [f for f in sorted(glob.glob(str(root / "**" / "*"), recursive=True))
              if f.lower().endswith((".csv", ".parquet", ".ecsv")) or (f.lower().endswith(".fits") and "cat" in f.lower())]
    print(f"\nFITS dosyasi: {len(fits_files)}, tablo dosyasi: {len(tables)}")
    split_files = [f for f in tables if Path(f).stem.lower() in ("split", "splits", "bolum", "bolumler", "index", "liste")]
    for f in split_files:
        show_table(f)
    if fits_files:
        show_fits(fits_files[0])
    lab = [f for f in tables if f not in split_files]
    if lab:
        show_table(lab[0])
    if a.config:
        from common import load_config, read_image, read_labels
        cfg = load_config(a.config)
        print(f"\n== Ayar denemesi: {a.config}")
        split = cfg["splits"][0]
        files = sorted(glob.glob(str(root / cfg["image_glob"].format(split=split))))
        print(f"  '{cfg['image_glob'].format(split=split)}' -> {len(files)} goruntu")
        if files:
            from prepare import sample_name
            name = sample_name(files[0])
            lp = root / cfg["label_path"].format(split=split, name=name)
            print(f"  etiket: {lp} {'VAR' if lp.exists() else 'YOK'}")
            x, valid, flagged = read_image(files[0], cfg)
            print(f"  goruntu okundu: {x.shape}, gecerli %{100 * valid.mean():.1f}, bayrakli %{100 * flagged.mean():.1f}")
            if lp.exists():
                lab = read_labels(lp, cfg)
                n = len(lab["cls"])
                print(f"  etiket okundu: {n} kaynak, yildiz {(lab['cls'] == 1).sum()}, yok sayilan {(lab['cls'] == -1).sum()}, "
                      f"diger {(lab['cls'] == 0).sum()}")
                inside = (lab["x"] >= 0) & (lab["x"] < x.shape[2]) & (lab["y"] >= 0) & (lab["y"] < x.shape[1])
                print(f"  goruntu icinde kalan kaynak: %{100 * inside.mean():.1f}")
                # koordinat kurali kontrolu: yildizlarin isik merkezi etiketle ayni yerde mi?
                H, W = x.shape[1:]
                p = np.nonzero((lab["cls"] == 1) & inside)[0]
                if len(p):
                    img = x.max(0)
                    peak = []
                    for k in p:
                        ix, iy = int(np.floor(lab["x"][k] + 0.5)), int(np.floor(lab["y"][k] + 0.5))
                        if 3 <= ix < W - 3 and 3 <= iy < H - 3:
                            peak.append(img[iy - 1:iy + 2, ix - 1:ix + 2].max())
                    top = p[np.argsort(-np.array(peak + [0] * (len(p) - len(peak))))[:200]] if peak else []
                    dxs, dys = [], []
                    yy, xx = np.mgrid[-2:3, -2:3]
                    for k in top:
                        ix, iy = int(np.floor(lab["x"][k] + 0.5)), int(np.floor(lab["y"][k] + 0.5))
                        if not (3 <= ix < W - 3 and 3 <= iy < H - 3):
                            continue
                        b = np.clip(img[iy - 2:iy + 3, ix - 2:ix + 3] - np.median(img[max(0, iy - 6):iy + 7, max(0, ix - 6):ix + 7]), 0, None)
                        if b.sum() > 0:
                            dxs.append((b * xx).sum() / b.sum() + ix - lab["x"][k])
                            dys.append((b * yy).sum() / b.sum() + iy - lab["y"][k])
                    if dxs:
                        print(f"  parlak yildizlarda isik merkezi - etiket (piksel): dx={np.median(dxs):+.2f} dy={np.median(dys):+.2f} "
                              f"({len(dxs)} yildiz). 0'a yakin olmali; +-1 civarindaysa koordinatlar 1'den basliyor olabilir.")


if __name__ == "__main__":
    main()
