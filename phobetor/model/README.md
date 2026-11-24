# Phobetor modeli: görüntüde yıldız bulma

Phobetor bir gökyüzü görüntüsü (FITS) alır ve içindeki yıldızların piksel konumlarını verir. Galaksiler,
kuasarlar, kozmik ışınlar ve kamera hataları yıldız sayılmaz.

Her kamera için ayrı bir mod eğitilir; şimdilik iki mod var:

| Mod | Veri | Ayar dosyası |
|---|---|---|
| Euclid | `euclid_v1` (436 kesit, VIS + Y + J + H, resmi Euclid Q1 katalog etiketleri) | `configs/euclid.json` |
| Hubble (PHAST) | `phobetor_phast` (ACS, Andromeda, resmi PHAST katalog etiketleri) | `configs/phast.json` |

Etiketlerin hepsi resmi kataloglardan gelir; kod hiçbir etiketi değiştirmez ya da uydurmaz. Ayar dosyası
yalnızca hangi resmi etiketin "yıldız", hangisinin "yok say" olarak kullanılacağını seçer.

## Nasıl çalışıyor

- **Giriş:** her bant ayrı bir kanal. Piksel değeri, gürültüye bölünüp (S/N) `asinh` ile sıkıştırılır;
  böylece sönük yıldız da parlak yıldız da aynı ölçekte görünür ve kameralar arası parlaklık birimi farkı
  ortadan kalkar. Gürültü katmanı yoksa gürültü görüntünün kendisinden (MAD) tahmin edilir.
- **Ağ:** tam çözünürlüklü küçük bir U-Net. Her piksel için "burada bir yıldız merkezi var" olasılığını
  ve merkezin piksel içindeki kaymasını (alt piksel konum) verir.
- **Kayıp:** CenterNet odak kaybı. "Yok say" kaynakların çevresi, verisiz pikseller ve kamera hata
  bayrağı taşıyan pikseller (Euclid: hayalet, doyma, taşma...) kayba girmez. Bayraklı pikseller ağa yine
  de aynen gösterilir, çünkü gerçek fotoğraflarda bu hatalar olacak ve ağın onları görmeye alışması
  gerekiyor.
- **Ölçüm:** tespitler en yakın yıldıza (2 piksel içinde) eşlenir. Kesinlik = doğru tespit / bütün tespitler,
  duyarlılık = bulunan yıldız / bütün yıldızlar. Eşik doğrulama bölümünde seçilir, test bölümünde
  yalnızca ölçülür. Parlaklığa göre duyarlılık tablosu da yazılır.

## Kurulum (Windows, NVIDIA ekran kartı)

1. Python 3.11 ya da 3.12 kur (python.org, kurulumda "Add to PATH" işaretli).
2. Bu klasörde bir komut penceresi aç ve PyTorch'u CUDA ile kur. Doğru komutu
   https://pytorch.org/get-started/locally/ sayfası verir (Stable, Windows, Pip, Python, CUDA seç). Örnek:
   ```
   pip install torch --index-url https://download.pytorch.org/whl/cu128
   ```
3. Diğer paketler:
   ```
   pip install -r requirements.txt
   ```
4. Ekran kartının görüldüğünü kontrol et (`True` yazmalı):
   ```
   python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
   ```

## Euclid modu

Veri: `euclid_v1` klasörü (yaklaşık 3,7 GB). Proje kütüphanesinden indirilebilir ya da
`phobetor/data/euclid_dataset.py` ile yeniden üretilebilir (aynı karolar, aynı sonuç).

```
python prepare.py --config configs/euclid.json --data "D:/veri seti v2/euclid_v1" --cache cache/euclid
python train.py --cache cache/euclid --out runs/euclid --steps 20000 --batch 16
python evaluate.py --cache cache/euclid --run runs/euclid
```

- `prepare.py` görüntüleri bir kez normalize edip `cache/` altına yazar (yaklaşık 3,5 GB). Yarıda
  kesilirse aynı komutla kaldığı yerden devam eder.
- `train.py` her 1000 adımda doğrulama yapar, en iyi modeli `runs/euclid/en_iyi.pt` olarak kaydeder.
  Yarıda kesilirse sonuna `--resume` ekleyip aynı komutla devam eder. Ekran kartı belleği yetmezse
  `--batch 8` ya da `--crop 192` kullan.
- `evaluate.py` test bölümünü ölçer: `runs/euclid/test.json` (özet), `test_parlaklik.csv` (parlaklığa göre),
  `test_goruntu.csv` (görüntü başına) ve `test_goruntuler/` (yeşil = bulunan yıldız, kırmızı = kaçan,
  sarı çarpı = yanlış tespit, mavi = yok sayılan belirsiz kaynak).

Euclid'de "yıldız" = Euclid fotometrik sınıflandırmasında (PHZ) yıldız ve görünür bantta (VIS) da
tespit edilmiş kaynak. Yalnızca kızılötesinde tespit edilen "yıldız"ların bir kısmı kızılötesi çizgi
hatalarının üstünde olduğu için yok sayılır; PHZ sınıfı belirsiz olanlar da yok sayılır.

## Hubble (PHAST) modu

PHAST klasörünün dosya düzeni bu kod yazılırken bilinmiyordu; `configs/phast.json` içindeki katman ve
sütun adları tahmin. Önce klasörü incele:

```
python inspect_data.py "D:/veri seti v2/phobetor_phast" > phast_inceleme.txt
```

Çıktıdaki FITS katman adlarına (HDU) ve etiket sütunlarına göre `configs/phast.json` dosyasını düzelt:

| Alan | Anlamı |
|---|---|
| `bands` | görüntü katmanları (ad ya da sıra numarası), örn. `["F475W", "F814W"]` ya da `[1, 2]` |
| `noise` | gürültü katmanları (yoksa `null`, gürültü görüntüden tahmin edilir) |
| `noise_kind` | `"rms"` (standart sapma) ya da `"weight"` (ters varyans) |
| `image_glob`, `label_path` | görüntü ve etiket dosyalarının yolu; `{split}` = train/val/test, `{name}` = görüntü adı |
| `x_col`, `y_col` | etiketteki piksel koordinatı sütunları (0'dan başlayan, x = sütun, y = satır) |
| `positive` | yıldız sayılacak satırlar (pandas sorgusu), örn. `"f814w_gst == 1"` |
| `ignore` | kayıpta yok sayılacak satırlar, örn. kalite bayrağı geçmeyen kaynaklar |
| `mag_col` | parlaklık tablosu için sütun |

Sonra ayarı dene; görüntünün ve etiketin okunduğunu, kaynakların görüntünün içine düştüğünü yazar:

```
python inspect_data.py "D:/veri seti v2/phobetor_phast" --config configs/phast.json
```

Doğruysa Euclid ile aynı üç komut:

```
python prepare.py --config configs/phast.json --data "D:/veri seti v2/phobetor_phast" --cache cache/phast
python train.py --cache cache/phast --out runs/phast --steps 20000 --batch 16
python evaluate.py --cache cache/phast --run runs/phast
```

PHAST çok kalabalık bir alan (karo başına on binlerce yıldız); eşleştirme yarıçapı bu yüzden 1,5 piksel.

## Yeni görüntüde yıldız bulma

```
python predict.py --model runs/euclid/en_iyi.pt --out tahminler goruntu.fits
```

Her görüntü için `tahminler/<ad>_yildizlar.csv` yazılır: `x, y, skor` ve FITS'te gök koordinatı varsa
`ra, dec`. Görüntü, modelin eğitildiği kamerayla aynı katmanlara sahip olmalı.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `common.py` | ayar, normalizasyon, etiket kuralları, eğitim hedefleri, tepe bulma, eşleştirme ve ölçüm |
| `net.py` | U-Net ve kayıp fonksiyonları |
| `prepare.py` | veri setini eğitim önbelleğine çevirir |
| `train.py` | eğitim ve doğrulama |
| `evaluate.py` | test ölçümü ve kaplama resimleri |
| `predict.py` | yeni görüntülerde tahmin |
| `inspect_data.py` | yeni bir veri setinin düzenini gösterir, ayar dosyasını dener |
