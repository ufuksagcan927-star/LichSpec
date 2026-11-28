#!/usr/bin/env python3
"""euclid_v1 icin ek resmi etiketler: galaksi ozellikleri ve kuasar uzakligi.

Her kesitin etiket dosyasina dokunmaz; yanina {bolum}/etiketler_ek/{ad}.csv yazar (object_id ile birlesir).
Kaynaklar (hepsi Euclid Q1 resmi kataloglari, IRSA IBE, karo basina):
  MER FINAL-MORPH-CAT   bicim: Sersic yaricapi / indeksi / eksen orani / acisi, CAS ve Gini-M20,
                        Galaxy Zoo Euclid (Zoobot) bicim oylari (sadece parlak galaksilerde dolu)
  PHZ PHYSPARAM         fotometrik kirmiziya kayma (uzaklik), yildiz kutlesi, yildiz olusum hizi
  PHZ PHYSPARAMQSO      kuasar kirmiziya kaymasi

    python euclid_ek_etiketler.py --data euclid_v1

Indirilen ham dosyalar islenip silinir (karo basina ~130 MB), sadece gereken sutunlar
_katalog_onbellek/ek_<karo>.parquet olarak kalir. Kesilirse kaldigi yerden devam eder.
"""
import argparse
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

from euclid_dataset import _download, _ibe_file, _read_cols

MORPH = {  # resmi sutun -> bizim sutun
    "SERSIC_SERSIC_VIS_RADIUS": "sersic_yaricap",          # yay saniyesi
    "SERSIC_SERSIC_VIS_INDEX": "sersic_indeks",
    "SERSIC_SERSIC_VIS_AXIS_RATIO": "eksen_orani",
    "SERSIC_ANGLE": "sersic_aci",                          # derece
    "SERSIC_VISNIR_FLAGS": "sersic_bayrak",
    "SERSIC_VISNIR_REDUCED_CHI2": "sersic_chi2",
    "CONCENTRATION": "konsantrasyon",
    "ASYMMETRY": "asimetri",
    "SMOOTHNESS": "puruzsuzluk",
    "GINI": "gini",
    "MOMENT_20": "m20",
    "SMOOTH_OR_FEATURED_SMOOTH": "gz_puruzsuz",
    "SMOOTH_OR_FEATURED_FEATURED_OR_DISK": "gz_ayrintili_disk",
    "SMOOTH_OR_FEATURED_ARTIFACT_STAR_ZOOM": "gz_yildiz_artefakt",
    "DISK_EDGE_ON_YES": "gz_yandan_evet",
    "DISK_EDGE_ON_NO": "gz_yandan_hayir",
    "HAS_SPIRAL_ARMS_YES": "gz_sarmal_evet",
    "HAS_SPIRAL_ARMS_NO": "gz_sarmal_hayir",
    "BAR_STRONG": "gz_cubuk_guclu",
    "BAR_WEAK": "gz_cubuk_zayif",
    "BAR_NO": "gz_cubuk_yok",
    "MERGING_MERGER": "gz_birlesme",
    "MERGING_MAJOR_DISTURBANCE": "gz_bozulma_buyuk",
    "MERGING_MINOR_DISTURBANCE": "gz_bozulma_kucuk",
    "MERGING_NONE": "gz_birlesme_yok",
    "HOW_ROUNDED_COMPLETELY": "gz_yuvarlak",
    "HOW_ROUNDED_IN_BETWEEN": "gz_yuvarlak_ara",
    "HOW_ROUNDED_CIGAR_SHAPED": "gz_puro",
    "SPIRAL_ARM_COUNT_1": "gz_kol_1",
    "SPIRAL_ARM_COUNT_2": "gz_kol_2",
    "SPIRAL_ARM_COUNT_3": "gz_kol_3",
    "SPIRAL_ARM_COUNT_4": "gz_kol_4",
    "SPIRAL_ARM_COUNT_MORE_THAN_4": "gz_kol_coklu",
    "SPIRAL_ARM_COUNT_CANT_TELL": "gz_kol_belirsiz",
}
PHYS = {
    "PHZ_PP_MEDIAN_REDSHIFT": "z_foto",
    "PHZ_PP_MEDIAN_STELLARMASS": "log_kutle",              # log10(Gunes kutlesi)
    "PHZ_PP_MEDIAN_SFR": "log_sfr",                        # log10(Gunes kutlesi / yil)
    "PHYS_PARAM_FLAGS": "fizik_bayrak",
    "QUALITY_FLAG": "fizik_kalite",
}
QSO = {"Z": "kuasar_z", "Missing-data-flag": "kuasar_veri_eksik"}
IBE = "https://irsa.ipac.caltech.edu/ibe/data/euclid/q1/catalogs"


def _clean(x):
    x = pd.Series(x)
    if x.dtype.kind == "f":
        x = x.where(np.isfinite(x) & (x > -98) & (np.abs(x) < 1e30))
    return x


def tile_extra(tile, cache):
    out = cache / f"ek_{tile}.parquet"
    if out.exists():
        return pd.read_parquet(out)
    tmp = cache / f"_ham_{tile}"
    tmp.mkdir(exist_ok=True)
    parts = []
    for folder, prefix, cols in (("MER_FINAL_CATALOG", "EUC_MER_FINAL-MORPH-CAT", MORPH),
                                 ("PHZ_PF_OUTPUT_FOR_L3", "EUC_PHZ_PHYSPARAM__", PHYS),
                                 ("PHZ_PF_OUTPUT_FOR_L3", "EUC_PHZ_PHYSPARAMQSO", QSO)):
        url = _ibe_file(folder, tile, prefix)
        p = _download(url, tmp / f"{prefix}.fits")
        raw = _read_cols(p, ["OBJECT_ID"] + list(cols))
        d = pd.DataFrame({"object_id": np.asarray(raw["OBJECT_ID"], dtype=np.int64)})
        for k, v in cols.items():
            d[v] = _clean(raw[k]).to_numpy() if not isinstance(raw[k], pd.arrays.IntegerArray) else raw[k]
        if folder == "PHZ_PF_OUTPUT_FOR_L3" and "z_foto" in d:
            r68 = _read_cols(p, ["PHZ_PP_68_REDSHIFT"])["PHZ_PP_68_REDSHIFT"]
            d["z_foto_alt"] = _clean(r68[:, 0]).to_numpy()
            d["z_foto_ust"] = _clean(r68[:, 1]).to_numpy()
        if "kuasar_z" in d:
            # "Missing-data-flag" Q1'de butun satirlarda acik (bazi dis bantlarin eksik oldugunu gosteriyor,
            # uydurulmus deger degil); kuasar olarak siniflananlarda Z 0.65-6 arasinda, fiziksel.
            # z = 0 basarisiz uydurma sayilir.
            d.loc[d.kuasar_z <= 0, "kuasar_z"] = np.nan
        parts.append(d.drop_duplicates("object_id").set_index("object_id"))
        os.remove(p)
    tmp.rmdir()
    df = parts[0].join(parts[1], how="outer").join(parts[2], how="outer").reset_index()
    df.to_parquet(out, index=False)
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    a = ap.parse_args()
    root = Path(a.data)
    cache = root / "_katalog_onbellek"
    cache.mkdir(exist_ok=True)
    idx = pd.read_csv(root / "index.csv")
    stats = []
    for i, (tile, g) in enumerate(idx.groupby("karo", sort=True)):
        t0 = time.time()
        ek = tile_extra(int(tile), cache).set_index("object_id")
        for _, r in g.iterrows():
            lab = pd.read_csv(root / r.bolum / "etiketler" / f"{r.ad}.csv", usecols=["object_id", "sinif"], low_memory=False)
            out = lab[["object_id"]].join(ek, on="object_id")
            od = root / r.bolum / "etiketler_ek"
            od.mkdir(exist_ok=True)
            out.to_csv(od / f"{r.ad}.csv", index=False, float_format="%.6g")
            gal = lab.sinif.to_numpy() == "galaksi"
            stats.append(dict(ad=r.ad, galaksi=int(gal.sum()),
                              z=int(out.z_foto.notna().to_numpy()[gal].sum()),
                              sersic=int(out.sersic_yaricap.notna().to_numpy()[gal].sum()),
                              zoobot=int(out.gz_puruzsuz.notna().to_numpy()[gal].sum()),
                              kuasar_z=int(out.kuasar_z.notna().to_numpy()[lab.sinif.to_numpy() == "kuasar"].sum())))
        print(f"[{i + 1}/{idx.karo.nunique()}] karo {tile}: {len(g)} kesit, {time.time() - t0:.0f} s", flush=True)
    s = pd.DataFrame(stats)
    s.to_csv(root / "etiketler_ek_ozet.csv", index=False)
    print(s.drop(columns="ad").sum().to_string())


if __name__ == "__main__":
    main()
