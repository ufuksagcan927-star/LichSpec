# LichSpec / Phobetor: yıldız tespiti veri seti (v0.2)

Bu klasördeki betikler, LichSpec projesinin görüntü/yıldız modeli **Phobetor** için eğitim ve test verisini hazırlar. Veri iki bölümden oluşur. Görüntü ve etiket dosyaları (yaklaşık 6 GB) repoya eklenmez, aşağıdaki komutlarla yeniden üretilebilir.

1. **`data_hst/` (ana veri):** gökyüzünün her bölgesine yayılmış 634 Hubble alanı. Etiketler Gaia DR3'ten ve Hubble Source Catalog'dan (HSC) alınır.
2. **`data/` (pilot):** 4 alan için aynı bölgenin SDSS, Pan-STARRS, Legacy Survey ve Hubble görüntüleri. Gerçek düşük kaliteli teleskoplarla karşılaştırma yapmak için kullanılır.

---

## 1. Hubble ana veri seti (`data_hst/`)

### Nasıl seçildi
- MAST'tan Hubble ACS/WFC'nin F606W/F814W filtreleriyle çektiği bütün HAP alanları listelendi. Birbirine 3'ten yakın olanlar birleştirilince **6.821 tekil alan** çıktı (`all_hap_fields.csv`).
- Gökyüzü 30°×30°'lik 72 bölgeye bölündü ve her bölgeden alan alındı. Adayların yarısı yıldızca zengin alanlardan seçildi: yıldız kümeleri, yıldız hedefleri, |b|<15° galaktik düzlem. 700 adaydan 634'ünde Hubble'ın hazır mozaiği vardı.
- Hedef türlerinin dağılımı: 258 galaksi, 109 yıldız, 87 yıldız kümesi, 58 galaksi kümesi, 27 yıldızlararası ortam ve diğerleri. 204 alan galaktik düzleme yakın.

### Ne var
| | |
|---|---|
| Görüntü | 1500×1500 px, 0.04"/px (yaklaşık 1'×1'), F606W öncelikli, electrons/s, WCS'li `raw/<alan>.fits.gz` |
| Etiket | `labels/<alan>.csv`: `catalog` (gaia/hsc), `source_id`, `x`, `y`, `ra`, `dec`, `g_mag`, `bp_rp`, `hst_mag`, `ci`, `is_star`, `snr_est`, `detectable` |
| Toplam etiket | 43.885 Gaia + 797.880 HSC kaynağı. Bunların **395 bini görüntüde net görülen (SNR>5) nokta kaynak/yıldız** |
| Ayrım | `split.csv`: 508 eğitim, 60 doğrulama, 66 test alanı |
| Bozulmuş test | `degraded/` + `labels_degraded/`: doğrulama ve test alanlarının her birinden 3 sabit bozulmuş kopya (378 görüntü) |
| Kontrol | `skymap.png` (alanların gökyüzü haritası), `sample.png` (örnek alan) |

### Ezberi önleyen iki karar
- **Ayrım gökyüzü bölgesine göre yapılır.** Aynı 30°'lik bölgedeki alanlar hep aynı kümeye düşer. Böylece test alanlarını ve onların komşularını model eğitimde hiç görmez.
- **Eğitim görüntülerinin bozulmuş kopyaları diske yazılmaz.** Eğitim sırasında `degrade.degrade()` her seferinde yeni ve rastgele bir bozulma üretir: bulanıklık, büyük piksel, gürültü, gökyüzü gradyanı, kozmik ışın, uydu izi ve 8-bit sıkıştırma. Model aynı bozuk görüntüyü iki kez görmez. Sabit bozulmuş kopyalar yalnızca doğrulama ve test için tutulur, böylece sonuçlar tekrarlanabilir.

### Etiketleri kullanırken
- `is_star`: Gaia'da paralaks/özdevinim ya da galaksi olmama, HSC'de ise konsantrasyon indeksi 0.75<CI<1.35 (nokta kaynak).
- `detectable` (SNR>5): HSC bazen başka filtrede ya da daha derin bir görüntüde bulunmuş, bu kesitte görünmeyen kaynaklar içerir. HSC nokta kaynaklarının %73'ü bu kesitte görünüyor. **Eğitimde `is_star & detectable` kullanmayı öneriyorum.** Aksi halde model boş yerde yıldız "görmeyi" öğrenir.
- 22 alanda hiç etiket yok (boş ya da çok sönük alanlar). Bunlar "yıldız yok" örneği olarak işe yarar.
- Gaia kaynaklarının `source_id` değeri, sonraki adımda yıldızın bilimsel adını bulmak için (SIMBAD eşleştirmesi) doğrudan kullanılabilir.

### Yeniden üretmek
```bash
pip install -r requirements.txt
python hst_survey.py select --n 700 --out data_hst
python hst_survey.py fetch  --out data_hst --workers 4      # kesilirse kaldığı yerden devam eder
python add_snr.py data_hst
python split_and_degrade_hst.py --data data_hst --variants 3
python make_skymap.py data_hst
```

---

## 2. Pilot çoklu arşiv seti (`data/`)

| Alan | Konum (RA, Dec) | Neden seçildi | Arşivler |
|---|---|---|---|
| `m67` | 132.846, +11.814 | Açık yıldız kümesi, orta yoğunluk | SDSS, Pan-STARRS, Legacy, Hubble |
| `m3_out` | 205.548, +28.395 | Küresel küme M3, çok kalabalık | SDSS, Pan-STARRS, Legacy, Hubble |
| `s82_a` | 20.000, +0.000 | SDSS Stripe 82, seyrek, bol galaksi | SDSS, Pan-STARRS, Legacy |
| `cosmos` | 150.100, +2.200 | COSMOS, seyrek, derin | SDSS, Pan-STARRS, Legacy |

15 orijinal görüntü (yer teleskopları 6'×6', r bandı) ve 60 bozulmuş kopya var. Etiketler yalnızca Gaia'dan alındı.

Klasik algoritmanın (SEP, 5σ) Gaia yıldızlarını bulma oranı:

| Alan | SDSS | Pan-STARRS | Legacy | Hubble |
|---|---|---|---|---|
| m67 | 0.88 | 0.91 | 0.92 | 1.00 |
| m3_out (kalabalık) | 0.16 | 0.20 | 0.37 | 1.00 |
| s82_a | 0.69 | 1.00 | 1.00 | – |
| cosmos | 0.95 | 0.97 | 0.97 | – |

Phobetor'un asıl geçmesi gereken çıta bu: kalabalık alanlar ve parlak, doymuş yıldızların çevresi.

```bash
python build_dataset.py --out data
python degrade.py --data data --variants 6 --seed 42
python make_montage.py data
```

## Notlar
- Gaia sorguları önce Heidelberg ARI aynasına (gaia.ari.uni-heidelberg.de), sonra ESA arşivine gider.
- FITS başlıklarındaki `ORBI_*` anahtarları projenin eski adından kaldı. Veriyi yeniden üretmemek için değiştirilmedi.

---

## 3. Ek yüksek kaliteli kaynaklar

| Klasör | Betik | İçerik |
|---|---|---|
| `data_wfc3/` | `hst_survey.py --instrument WFC3/UVIS --prefix wfc3 --exclude data_hst/fields.csv` | ACS setiyle çakışmayan 400 Hubble WFC3/UVIS alanı (Gaia + HSC etiketli) |
| `data_decaps/` | `decaps_survey.py --n 150` | DECaPS2 güney Samanyolu düzlemi, kalabalık yıldız alanları (4.4'×4.4', r bandı, Gaia etiketli) |
| `data_jwst/` | `jwst_survey.py select/fetch --n 30` | JWST NIRCam F200W pilotu. Mozaiğin yalnızca 2000×2000 px'lik kesiti HTTP aralık isteğiyle okunur. Gaia + `jwst_sep` (temiz JWST görüntüsünde SNR>10 nokta kaynak, yarı otomatik etiket) |

```bash
python hst_survey.py select --n 400 --instrument WFC3/UVIS --prefix wfc3 --exclude data_hst/fields.csv --out data_wfc3
python hst_survey.py fetch --out data_wfc3 --workers 4
python decaps_survey.py --n 150 --out data_decaps --workers 4
python jwst_survey.py select --n 30 --out data_jwst
python jwst_survey.py fetch --out data_jwst --workers 3
```

DECaPS2 ve JWST, MAST kesit servisini kullanmadığı için hızlı iner (her biri yaklaşık 10-20 dakika). Hubble (ACS/WFC3) indirmeleri MAST'ın o anki yoğunluğuna bağlı olarak birkaç saat sürebilir.
