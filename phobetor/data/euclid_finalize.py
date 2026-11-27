#!/usr/bin/env python3
"""Euclid v1 veri seti: index.csv, ozet tablolari ve README.md uretir.

Kullanim: python euclid_finalize.py euclid_v1 euclid_tiles_q1.csv
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits

out = Path(sys.argv[1] if len(sys.argv) > 1 else "euclid_v1")
tiles = pd.read_csv(sys.argv[2] if len(sys.argv) > 2 else "euclid_tiles_q1.csv")
tmap = tiles.set_index("tile")
rows = []
for part in ("train", "val", "test"):
    for lp in sorted((out / part / "etiketler").glob("*.csv")):
        name = lp.stem
        tile = int(name.split("_")[1])
        lab = pd.read_csv(lp, usecols=["sinif", "vis_det"])
        n = lab.sinif.value_counts().to_dict()
        t = tmap.loc[tile]
        with fits.open(out / part / "goruntuler" / f"{name}.fits") as h:
            kap = {b: float(np.mean(np.isfinite(h[f"SCI_{b}"].data) & (h[f"SCI_{b}"].data != 0))) for b in ("VIS", "Y", "J", "H")}
        rows.append(dict(ad=name, bolum=part, alan=t.alan, karo=tile, gal_l=round(t.l, 3), gal_b=round(t.b, 3),
                         kaynak=len(lab), yildiz=n.get("yildiz", 0),
                         yildiz_vis=int(((lab.sinif == "yildiz") & (lab.vis_det == 1)).sum()),
                         galaksi=n.get("galaksi", 0), kuasar=n.get("kuasar", 0),
                         kuresel_kume=n.get("kuresel_kume", 0), belirsiz=n.get("belirsiz", 0),
                         sahte=n.get("sahte", 0), sadece_nir=int((lab.vis_det == 0).sum()),
                         kapsama_vis=round(kap["VIS"], 4), kapsama_nir=round(min(kap["Y"], kap["J"], kap["H"]), 4)))
idx = pd.DataFrame(rows)
idx.to_csv(out / "index.csv", index=False)

ozet = idx.groupby("bolum").agg(kesit=("ad", "count"), karo=("karo", "nunique"), kaynak=("kaynak", "sum"),
                                 yildiz=("yildiz", "sum"), yildiz_vis=("yildiz_vis", "sum"),
                                 galaksi=("galaksi", "sum"), kuasar=("kuasar", "sum"),
                                 belirsiz=("belirsiz", "sum"), sahte=("sahte", "sum"))
ozet = ozet.reindex(["train", "val", "test"])
ozet.loc["toplam"] = ozet.sum()
ozet["karo"] = ozet["karo"].astype(int)
ozet.loc["toplam", "karo"] = idx.karo.nunique()
alan = idx.groupby("alan").agg(kesit=("ad", "count"), yildiz_ort=("yildiz", "mean"),
                               yildiz_vis_ort=("yildiz_vis", "mean"), kaynak_ort=("kaynak", "mean")).round(1)

size_gb = sum(p.stat().st_size for p in out.rglob("*") if p.is_file() and not p.parts[-2].startswith("_")) / 1e9

txt = f"""# LichSpec / Phobetor: Euclid yıldız tespiti veri seti (v1)

Euclid uydusunun (ESA) Q1 sürümünden **{len(idx)} kesit**, {idx.karo.nunique()} karodan. Toplam boyut yaklaşık {size_gb:.1f} GB.
**Tek uydu, aynı iki kamera (VIS + NISP), aynı 4 bant, aynı işlem hattı.** Bütün görüntüler aynı yöne bakar (kuzey yukarı, doğu sol; FITS dizisinde satır 0 güneydir).
Etiketlerin hepsi Euclid'in kendi resmi kataloglarından geliyor (MER + PHZ). Hiçbiri sonradan üretilmedi, tahmin edilmedi veya elle doldurulmadı.

## Klasörler

```
train/ val/ test/
  goruntuler/<ad>.fits   1024×1024 piksel, 0.1″/piksel (102″×102″), 12 katman (aşağıda)
  etiketler/<ad>.csv     karedeki HER kaynak, resmi katalogdan
  onizleme/<ad>.jpg      sadece bakmak için renkli resim (mavi=VIS, yeşil=Y+J, kırmızı=H)
kontrol/                 her karonun ilk kesiti, etiketleri çizilmiş hâlde (göz kontrolü için)
ozet/                    özet kontrol resimleri (alan başına örnekler, yıldızların yakın görünümü)
index.csv                her kesit: bölüm, alan, karo, galaktik konum, sınıf sayıları, kapsama
euclid_tiles_q1.csv      kullanılan karolar ve bölüm ataması
euclid_dataset.py        bu seti üreten betik (daha fazla kesit için)
euclid_validate.py       dosya bütünlüğü kontrolü
euclid_figures.py        özet kontrol resimleri
euclid_finalize.py       index.csv ve bu README'yi üreten betik
```

Kontrol resimlerinde: camgöbeği halka = yıldız, turuncu = galaksi, mor = kuasar, gri = belirsiz, kırmızı çarpı = sahte.
Önizlemelerde bazı yıldızların merkezi koyu mavi görünür: VIS görüntüsü kızılötesinden çok daha keskin olduğu için merkez pikselde mavi baskın kalıyor. Bu yalnızca renkli önizlemenin görünüşü; FITS verisinde sorun yok.
JPG önizlemeler FITS dizisiyle aynı satır sırasındadır (satır 0 üstte), yani gökyüzüne göre baş aşağı görünür. Etiketlerin x, y değerleri hem FITS dizisine hem JPG'ye birebir uyar.

### FITS katmanları (hepsi aynı piksel ızgarasında)
| Katman | İçerik |
|---|---|
| SCI_VIS, SCI_Y, SCI_J, SCI_H | Arka planı çıkarılmış bilimsel görüntü. AB kadir = MAGZERO − 2.5·log10(toplam piksel değeri); MAGZERO her katmanın başlığında (VIS 24.6, NIR yaklaşık 30). |
| RMS_VIS … RMS_H | Piksel başına gürültü (1σ). Sinyal/gürültü hesabı için. Kapsanmayan piksellerde çok büyük değer (1e16) bulunur. |
| FLAG_VIS … FLAG_H | Euclid'in kendi piksel bayrak haritası (bit maskesi). Ayrıntı aşağıda. |

Sıkıştırma: SCI katmanları gürültünün 1/16'sı adımla, RMS katmanları 1/4 adımla (göreli hata %0.5'in altında) FITS RICE ile; FLAG katmanları kayıpsız (GZIP).
Okumak için: `astropy.io.fits.open(dosya)["SCI_VIS"].data`.
Bantlar: VIS (görünür, 550–900 nm), Y, J, H (yakın kızılötesi, 0.95–2.0 µm). Kızılötesi bantların keskinliği VIS'ten düşük.

### FLAG haritaları
{{FLAG_NOTU}}

## Etiket sütunları (önemli olanlar)
- `x`, `y`: piksel konumu (0'dan başlar, piksel merkezi tam sayı). Numpy'da `dizi[round(y), round(x)]`.
- `sinif`: **yildiz / galaksi / kuasar / kuresel_kume / belirsiz / sahte**
  - Euclid PHZ sınıflandırmasından: 1→yildiz, 2→galaksi, 4→kuasar, 8→kuresel_kume (Q1'de bu sınıf hiç atanmamış, sette yok). Birden fazla sınıfa uyan (ör. 3 = yıldız+galaksi) ya da sınıflanamayan (0, −1) → belirsiz.
  - Katalogda `spurious_flag = 1` olanlar → sahte (kamera hatası, kırınım çizgisi, yansıma, kozmik ışın vb.).
- `vis_det`: 1 = kaynak VIS görüntüsünde bulunmuş; 0 = yalnızca kızılötesi (NIR) birleşik görüntüde bulunmuş.
- `phz_classification`, `phz_star_prob`, `phz_gal_prob`, `phz_qso_prob`, `phz_glob_cl_prob`: PHZ sınıfı ve sınıf olasılıkları.
- `point_like_prob`: şekle göre nokta kaynak olma olasılığı. `spurious_prob`: sahte kaynak olasılığı.
- `det_quality_flag`: tespit kalitesi bayrakları (0 = sorunsuz). `flag_vis` … `flag_h`: kaynağın piksellerindeki bayrak bitleri.
- `gaia_id`: Gaia DR3 eşleşmesi (varsa); yıldızın kimliğini ve adını bulmak için. `gaia_match_quality`: eşleşme kalitesi.
- `flux_*` / `fluxerr_*`: akı (µJy). `mag_vis`, `mag_y`, `mag_j`, `mag_h`: AB kadir (akı ≤ 0 ise boş).
- Şekil ve karışma: `fwhm`, `ellipticity`, `semimajor_axis`, `position_angle`, `kron_radius`, `segmentation_area`, `mu_max`, `mumax_minus_mag`, `mag_stargal_sep`, `blended_prob`, `deblended_flag`.
- Diğer: `she_flag`, `binary_flag`, `variable_flag`, `point_like_flag`, `extended_prob`.

## Eğitim önerisi
- **Pozitif (yıldız):** `sinif == "yildiz"` **ve** `vis_det == 1`.
- **Negatif (yıldız değil):** `galaksi`, `kuasar`, `kuresel_kume`, `sahte`.
- **Kayıpta yok say:** `belirsiz` ve `vis_det == 0` olan yıldızlar. Yalnızca kızılötesinde bulunan kaynakların bir kısmı uydu izleri ve kızılötesi kamera izleri boyunca dizilmiş sahte tespitlerdir; katalog bunların hepsini `sahte` olarak işaretlememiş. Bu kural etiketleri değiştirmez, sadece hangi resmi etiketin eğitimde kullanılacağını seçer.
- FLAG haritasında işaretli pikseller (özellikle doymuş merkezler) kayıpta maskelenebilir.
- Her kesitte VIS ve kızılötesi bantların en az %95'i dolu. Boş kalan küçük kısımlar çoğunlukla parlak yıldız merkezleri ve taşma çizgileridir (Euclid bunları sıfırlar). `index.csv`'de `kapsama_vis` ve `kapsama_nir` sütunları var.
- `index.csv`'deki `sadece_nir` (yalnızca kızılötesinde bulunan kaynak sayısı) kesitteki kızılötesi izlerin iyi bir göstergesidir. `sadece_nir / kaynak` oranı 0.35'in üstünde olan {(idx.sadece_nir / idx.kaynak > 0.35).sum()} kesitte kızılötesi izleri gözle görülüyor; istenirse bunlar eğitimden çıkarılabilir.
- Bölümler gökyüzü bölgesine göre ayrıldı (2°×2° hücreler): aynı bölge hem eğitimde hem testte yok. Aynı karodaki kesitler birbiriyle çakışmaz (merkezler arası en az 0.1°, kesit 0.028°).

## Özet
{ozet.to_markdown()}

`yildiz_vis` = VIS'te de bulunan yıldızlar (önerilen pozitifler).

Alan bazında (kesit başına ortalama):
{alan.to_markdown()}

## Dürüst sınırlamalar
- Euclid Q1 alanları (EDF-Kuzey, EDF-Fornax, EDF-Güney) galaksi ağırlıklı; yıldızlar kaynakların küçük bir kısmı. EDF-Kuzey (galaktik enlem yaklaşık +30°) en yıldızca zengin olanı.
- Çok parlak (doymuş) yıldızlar katalogda çoğu zaman "belirsiz" kalır; bazen yanlış sınıflanabilir. Çevrelerindeki kırınım çizgileri ve yansımalar `sahte` olarak işaretlidir.
- Görüntü kapsaması %95'in altında kalan 12 kesit (boş şeritler, görüntü kenarları) setten çıkarıldı.
- Bazı kesitlerde uydu izleri ve kızılötesi kamera izleri var. Bunlar gerçek veride de karşılaşılacak şeyler; model bunları yıldız sanmamayı öğrenmeli (bkz. eğitim önerisi).
- PHZ sınıflandırması sönük kaynaklarda (VIS 24.5 kadirden sönük) daha belirsizdir; `phz_star_prob` ve `mag_vis` ile eşik koyulabilir.
- Q1'deki 352 karonun 36'sında PHZ sınıflandırma dosyası yok. İlk listedeki 11 karo bu yüzden aynı gökyüzü bölgesinden (yoksa aynı bölüme ait başka bir bölgeden) tam kapsanan bir karoyla değiştirildi. Kenardaki karolar kısmen kapsandığı için bazılarından 8'den az kesit çıktı.
- Derinlik tek geçişli Euclid geniş tarama derinliğinde; NASA'nın binlerce pozlu derin alanları kadar derin değil.
- Euclid DR1 (Ekim 2026) daha geniş ve daha yıldızca zengin alanlar içeriyor, ama IRSA'da DR1 için kesit servisi henüz yok; tüm karoyu (bant başına 1.5 GB) indirmek gerekiyor.

## Kaynak
Euclid Quick Release Q1 (ESA / Euclid Consortium, Mart 2025), NASA/IPAC IRSA üzerinden.
Görüntüler: MER mozaikleri (BGSUB-MOSAIC, RMS, FLAG), IRSA kesit servisiyle.
Kataloglar: karo başına resmi dosyalar, `MER_FINAL_CATALOG/<karo>/EUC_MER_FINAL-CAT_*.fits` ve `PHZ_PF_OUTPUT_FOR_L3/<karo>/EUC_PHZ_CLASSCAT_*.fits`
(IRSA'daki `euclid_q1_mer_catalogue` ve `euclid_q1_phz_classification` tablolarının kaynağı).
Kullanırken Euclid Q1 makalelerine atıf yapılmalı (ör. "Euclid Quick Data Release (Q1): Data release overview", arXiv:2503.15302).
"""
flag_note = (out / "_flag_notu.md").read_text() if (out / "_flag_notu.md").exists() else \
    "Bit anlamları Euclid MER belgelerinde tanımlıdır. Kızılötesi haritalarda bazı bitler her pikselde açıktır; bu yüzden 'sıfır = temiz' varsayılmamalı."
(out / "README.md").write_text(txt.replace("{FLAG_NOTU}", flag_note.strip()))
print(ozet)
print(alan)
