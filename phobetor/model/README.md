# Phobetor modeli: görüntüde yıldız, galaksi ve kuasar bulma

Phobetor bir gökyüzü görüntüsü (FITS) alır, içindeki nesneleri bulur ve sınıflar: yıldız, galaksi ya da
kuasar (merkezindeki kara deliği besleyen gazın parladığı uzak galaksi çekirdeği). Galaksiler için
özelliklerini de tahmin eder: uzaklık (kırmızıya kayma), yıldız kütlesi, yıldız oluşum hızı, boyut,
şekil ve Galaxy Zoo biçim oyları (sarmal mı, pürüzsüz mü, birleşme var mı, yandan mı görünüyor).
Kozmik ışınlar ve kamera hataları hiçbir sınıfa girmez.

Her kamera için ayrı bir mod eğitilir:

| Mod | Veri | Ayar dosyası |
|---|---|---|
| Euclid, çok sınıflı | `euclid_v1` + `etiketler_ek/` (resmi Euclid Q1 katalogları) | `configs/euclid_cok_sinif.json` |
| Euclid, sadece yıldız | `euclid_v1` | `configs/euclid.json` |
| Hubble (PHAST) | `phobetor_phast` (ACS, Andromeda, resmi PHAST katalog etiketleri) | `configs/phast.json` |

Etiketlerin hepsi resmi kataloglardan gelir; kod hiçbir etiketi değiştirmez ya da uydurmaz. Ayar dosyası
yalnızca hangi resmi etiketin hangi sınıf, hangisinin "yok say" olarak kullanılacağını seçer.

Görülemeyen şeyler bilerek dışarıda: kara deliğin kendisi ve nötron yıldızları görünür ışıkta
fotoğrafta görünmez (kara delik ancak kuasar / aktif galaksi çekirdeği olarak görünür). Nebulalar Euclid'in
derin alanlarında neredeyse yok; onlar için Samanyolu'na bakan geniş açılı görüntüler gerekiyor.

## Nasıl çalışıyor

- **Giriş:** her bant ayrı bir kanal. Piksel değeri, gürültüye bölünüp (S/N) `asinh` ile sıkıştırılır;
  böylece sönük yıldız da parlak yıldız da aynı ölçekte görünür ve kameralar arası parlaklık birimi farkı
  ortadan kalkar. Gürültü katmanı yoksa gürültü görüntünün kendisinden (MAD) tahmin edilir.
- **Ağ:** tam çözünürlüklü küçük bir U-Net. Her piksel ve her sınıf için "burada bu sınıftan bir nesnenin
  merkezi var" olasılığını, merkezin piksel içindeki kaymasını (alt piksel konum) ve nesnenin
  özelliklerini verir. Özellikler nesnenin merkez pikselinde okunur.
- **Kayıp:** CenterNet odak kaybı, her sınıf ayrı normalize edilir (az sayıdaki yıldız ve kuasar, çok
  sayıdaki galaksinin gölgesinde kalmasın). Özelliklerde ölçeklenmiş Huber kaybı, oy oranlarında yumuşak
  ikili çapraz entropi; her özellik yalnızca resmi değeri olan nesnelerde kayba girer. "Yok say" kaynakların çevresi, verisiz pikseller ve kamera hata
  bayrağı taşıyan pikseller (Euclid: hayalet, doyma, taşma...) kayba girmez. Bayraklı pikseller ağa yine
  de aynen gösterilir, çünkü gerçek fotoğraflarda bu hatalar olacak ve ağın onları görmeye alışması
  gerekiyor.
- **Ölçüm:** tespitler en yakın etiketli nesneye eşlenir (yıldız ve kuasar 2, galaksi 3 piksel içinde).
  Bir tespit k sınıfı için doğru sayılır: ağ "k" dedi ve nesnenin resmi sınıfı k. Sınıf başına kesinlik,
  duyarlılık ve F1, karışıklık tablosu (hangi sınıf hangisiyle karışıyor), sınıf ve parlaklığa göre
  duyarlılık ve özellik hataları yazılır (uzaklıkta astronomide alışılmış ölçü: NMAD(Δz/(1+z)) ve
  |Δz|/(1+z) > 0,15 olan aykırı oranı). Eşikler sınıf başına doğrulama bölümünde seçilir, test bölümünde
  yalnızca ölçülür.

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
hatalarının üstünde olduğu için yok sayılır; PHZ sınıfı belirsiz olanlar da yok sayılır. Gaia
eşleşmesi olduğu hâlde PHZ'nin "galaksi" dediği kaynaklar da yok sayılır: bunların çoğu ışığı doymuş
parlak yıldızlar (PHZ renkleri doymuş pikselden ölçemediği için yanlış sınıflıyor). Bu kaynakların
etiketi değiştirilmez; ağa ne "yıldız" ne "yıldız değil" diye öğretilir, ölçümde de sayılmazlar.

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

## Euclid çok sınıflı mod

Ek etiketler (galaksi özellikleri, kuasar uzaklığı) `euclid_v1` klasörüne bir kez eklenir; mevcut
etiket dosyalarına dokunulmaz, yanlarına `etiketler_ek/` yazılır (62 karo, yaklaşık 1 saat indirme).
Betik, veri setini üreten `phobetor/data/euclid_dataset.py` ile aynı klasörde çalışır. Hazır
`etiketler_ek/` klasörü proje kütüphanesindeki `euclid_v1` içinde de var.

```
python ../data/euclid_ek_etiketler.py --data "D:/veri seti v2/euclid_v1"
python prepare.py --config configs/euclid_cok_sinif.json --data "D:/veri seti v2/euclid_v1" --cache cache/euclid_cok
python train.py --cache cache/euclid_cok --out runs/euclid_cok --steps 20000 --batch 16
python evaluate.py --cache cache/euclid_cok --run runs/euclid_cok
```

Galaxy Zoo biçim oyları Euclid kataloğunda yalnızca parlak galaksilerde var (kesit başına 1-2 galaksi);
bu yüzden biçim tahmini az örnekle öğreniliyor ve ölçümü de az örneğe dayanıyor.

## Yeni görüntüde nesne bulma

```
python predict.py --model runs/euclid_cok/en_iyi.pt --out tahminler goruntu.fits
```

Her görüntü için `tahminler/<ad>_nesneler.csv` yazılır: `x, y`, FITS'te gök koordinatı varsa `ra, dec`,
`sinif`, `skor`, sınıf olasılıkları ve galaksilerde özellikler. Görüntü, modelin eğitildiği kamerayla
aynı katmanlara sahip olmalı.

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
