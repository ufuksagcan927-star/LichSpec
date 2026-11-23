#!/usr/bin/env python3
"""
LichSpec / Phobetor - sade veri seti cikisi.

Butun kaynaklari (Hubble ACS, WFC3, DECaPS2, JWST) tek, sade bir klasore donusturur:

  <cikis>/
    train/  val/  test/  test_bozulmus/
      images/<ad>.png      16-bit gri tonlu resim (asinh germeli, 0-65535)
      labels/<ad>.csv      o resimdeki yildizlar: x, y (piksel, sol ust kose 0,0), parlaklik, kaynak
    index.csv              her resim: ad, bolum, teleskop, genislik, yukseklik, yildiz sayisi
    README.txt

Etiketlere sadece "yildiz" (is_star) ve resimde gercekten gorunen (detectable, SNR>5) kaynaklar girer.
PNG'de y ekseni yukaridan asagi oldugu icin FITS'teki y degerleri cevrilir.

Kullanim:
    python export_png.py --out "veri seti hazir" data_hst data_wfc3 data_decaps data_jwst
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from PIL import Image

SOURCES = {"data_hst": "hubble_acs", "data_wfc3": "hubble_wfc3", "data_decaps": "decaps2", "data_jwst": "jwst"}


def to_png16(img):
    d = np.asarray(img, dtype=np.float64)
    good = np.isfinite(d)
    if not good.any():
        return np.zeros(d.shape, np.uint16)
    v = d[good]
    lo, hi = np.percentile(v, 0.5), np.percentile(v, 99.95)
    x = np.clip((np.where(good, d, lo) - lo) / max(hi - lo, 1e-12), 0, 1)
    x = np.arcsinh(x * 50) / np.arcsinh(50)
    return np.flipud(np.round(x * 65535).astype(np.uint16))


def split_map(root: Path, ref_cells):
    s = root / "split.csv"
    if s.exists():
        df = pd.read_csv(s)
        return dict(zip(df.field, df.split))
    # ayrim dosyasi yoksa ACS'in gokyuzu hucresi eslemesini uygula
    f = pd.read_csv(root / "fields.csv")
    ra = f["s_ra"] if "s_ra" in f else f["ra"]
    dec = f["s_dec"] if "s_dec" in f else f["dec"]
    cell = (ra // 30).astype(int) * 10 + ((dec + 90) // 30).astype(int)
    return dict(zip(f.field, cell.map(ref_cells).fillna("train")))


def write(img, lab, name, part, out, src, rows):
    h, w = img.shape
    keep = lab
    if "is_star" in keep:
        keep = keep[keep.is_star.astype(str).str.lower().isin(["true", "1"])]
    if "detectable" in keep:
        keep = keep[keep.detectable.astype(str).str.lower().isin(["true", "1"])]
    mag = keep["g_mag"] if "g_mag" in keep else pd.Series(np.nan, index=keep.index)
    if "hst_mag" in keep:
        mag = mag.fillna(keep["hst_mag"])
    lab_out = pd.DataFrame(dict(
        x=keep.x.round(2), y=(h - 1 - keep.y).round(2),
        parlaklik_mag=mag.round(3),
        kaynak=keep.get("catalog", pd.Series("gaia", index=keep.index)).fillna("gaia"),
        gaia_id=keep.get("source_id", pd.Series("", index=keep.index)).where(
            keep.get("catalog", pd.Series("gaia", index=keep.index)).fillna("gaia") == "gaia", ""),
    ))
    (out / part / "images").mkdir(parents=True, exist_ok=True)
    (out / part / "labels").mkdir(parents=True, exist_ok=True)
    Image.fromarray(to_png16(img)).save(out / part / "images" / f"{name}.png", optimize=True)
    lab_out.to_csv(out / part / "labels" / f"{name}.csv", index=False)
    rows.append(dict(ad=name, bolum=part, teleskop=src, genislik=w, yukseklik=h, yildiz_sayisi=len(lab_out)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="veri seti hazir")
    ap.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ref = pd.read_csv(Path(a.dirs[0]).parent / "data_hst" / "split.csv") if not (Path(a.dirs[0]) / "split.csv").exists() \
        else pd.read_csv(Path([d for d in a.dirs if Path(d).name == "data_hst"][0]) / "split.csv")
    ref_cells = ref.groupby("cell").split.first().to_dict()
    rows = []
    for d in a.dirs:
        root = Path(d)
        src = SOURCES.get(root.name, root.name)
        sm = split_map(root, ref_cells)
        for lp in sorted((root / "labels").glob("*.csv")):
            name = lp.stem
            part = sm.get(name, "train")
            img = fits.getdata(root / "raw" / f"{name}.fits.gz")
            write(img, pd.read_csv(lp), name, part, out, src, rows)
            if part == "test":
                for dl in sorted((root / "labels_degraded").glob(f"{name}_d*.csv")):
                    dimg = fits.getdata(root / "degraded" / f"{dl.stem}.fits.gz")
                    write(dimg, pd.read_csv(dl), dl.stem, "test_bozulmus", out, src, rows)
        print(src, "tamam", flush=True)
    idx = pd.DataFrame(rows)
    idx.to_csv(out / "index.csv", index=False)
    summary = idx.groupby(["bolum", "teleskop"]).agg(resim=("ad", "count"), yildiz=("yildiz_sayisi", "sum"))
    (out / "README.txt").write_text(
        "LichSpec / Phobetor yildiz tespiti veri seti\n\n"
        "Klasorler: train (egitim), val (dogrulama), test, test_bozulmus (test resimlerinin bulanik/gurultulu kopyalari).\n"
        "Her klasorde images/ (16-bit PNG) ve labels/ (ayni adli CSV) var.\n"
        "CSV sutunlari: x, y = yildizin piksel konumu (sol ust kose 0,0); parlaklik_mag = parlaklik (kucuk sayi = parlak);\n"
        "kaynak = etiketin geldigi katalog (gaia / hsc / jwst_sep); gaia_id = Gaia DR3 kimligi (yildizin adini bulmak icin).\n"
        "Egitim resimlerinin bozulmus kopyalari yoktur: egitim sirasinda her seferinde rastgele bozulma uygulanmalidir.\n\n"
        + summary.to_string() + "\n")
    print(summary)


if __name__ == "__main__":
    main()
