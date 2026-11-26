# LichSpec Gökyüzü (prototip)

Tüm gökyüzünü gezip bir yıldıza tıklayınca o yıldızın ölçülmüş verilerini, Poltergeist ön tahminini ve Draugr anlatımını gösteren site. Gece fotoğrafı yükleyince Phobetor içindeki yıldızları tarayıcıda bulur, yıldız deseni gökyüzüyle eşleştirilir ve fotoğraftaki yıldızlar ile takımyıldızlar adlarıyla işaretlenir.

## Çalıştırma

```bash
pip install -r server/requirements.txt
python server/app.py          # http://localhost:8000
```

JPG/PNG fotoğraflar ve WCS başlıklı FITS dosyaları anahtarsız, tarayıcıda çözülür. Sunucu modunda tarayıcıdaki
eşleştirme bir fotoğrafı çözemezse isteğe bağlı olarak Astrometry.net API'si denenir; bunun için (ücretsiz) anahtar:

```bash
export ASTROMETRY_API_KEY=...   # nova.astrometry.net → giriş yap → "API" sayfası
```

## Yayınlamak (sunucusuz)

Site statik dosyalardan ibarettir (`web/`), sunucu olmadan da tam çalışır:

- **Netlify** (repo gizli kalabilir): app.netlify.com → *Add new site* → *Import an existing project* → GitHub → `LichSpec`. Ayarlar repodaki `netlify.toml` dosyasından gelir (yayın klasörü `web`).
- **GitHub Pages** (açık repo ya da GitHub Pro): *Settings → Pages → Source: GitHub Actions*. `main`'e her gönderimde `.github/workflows/pages.yml` siteyi yayınlar.

Statik çalışırken Gaia DR3 verisi tarayıcıdan doğrudan CDS'ten gelir: CDS'nin Gaia DR3 HiPS kataloğuna ulaşılabiliyorsa gökyüzü katmanı oradan (karolar, her ölçekte hızlı), ulaşılamıyorsa VizieR'in bir yansısından (CDS, Harvard CfA ya da IDIA; açılışta hangisi önce cevap verirse) görünen alanın en parlak 3.000 yıldızı sorgulanır. VizieR'de bu sorgu dairedeki bütün yıldızları taradığından yavaştır, bu yüzden o yolda alan galaktik enleme göre sınırlanır (Samanyolu düzleminde daha çok yakınlaşmak gerekir). FITS ve JPG/PNG dosyaları tarayıcıda çözülür (aşağıda). `python server/app.py` ile açıldığında site bunu algılar ve Gaia sorgularını kendi sunucusu üzerinden yapar (ESA → Heidelberg yansısı geçişiyle); tarayıcıdaki eşleştirme bir fotoğrafı çözemezse Astrometry.net API'sini dener.

`.github/workflows/site-check.yml` her değişiklikte önce veri servislerini yoklar (`tools/probe_services.py`: her VizieR yansısı için DNS, CORS, süre; Gaia sütun adları; alan sorgusunun süresi ve doğru sıralanıp sıralanmadığı), sonra siteyi gerçek internette statik olarak açıp gökyüzü, Gaia katmanı, yıldız kartı ve FITS çözümünü dener. Ardından `tools/photo_check.js` yapay test fotoğraflarını ve Wikimedia Commons'taki serbest lisanslı gerçek gece fotoğraflarını (yalnızca test sırasında indirilir, depoya girmez) siteye bir ziyaretçi gibi yükleyip Phobetor'un yıldız bulmasını ve fotoğrafın gökyüzünde doğru yere oturmasını denetler.

## Nasıl çalışıyor

| Parça | Ne yapar | Veri |
|---|---|---|
| Gökyüzü | Aladin Lite v3, HiPS karolarını akıtır; tüm gökyüzü siteye gömülmez, yalnızca ekrandaki karolar indirilir. Tek görünüm: gökyüzüne yerden, içeriden bakılır (stereografik izdüşüm, planetaryumlardaki gibi). Geniş bakışta Mellinger'in tüm gökyüzü fotoğrafı, yakınlaştıkça (40° → 12°) DSS2 yavaşça üstüne biner | Mellinger, DSS2 |
| Ufuk ve takımyıldızlar | Gözlemcinin yerine ve saatine göre yer, ufuk çizgisi, yönler (K, D, G, B); yukarısı hep başucu. Konum açılışta saat diliminden (İstanbul vb.), "Konumum" düğmesiyle tarayıcıdan alınır. Takımyıldız çizgileri ve Türkçe adları. Yıldız kartı yıldızın şu an ufkun kaç derece üstünde ve hangi yönde olduğunu yazar. Sürükleyince bakış baş çevirir gibi yükseklik ve yönde döner, başucundan geçerken görüntü ters dönmez; ufkun altındaki yer opaktır | `web/js/sky.js`, `web/data/constellations.json` |
| Parlak yıldız modeli | 15.504 yıldız haritada tıklanabilir, çevrimdışı: V 7'den parlak bütün Hipparcos yıldızları ve bilinen sönük yıldızlar (Proxima Centauri, Barnard Yıldızı, Wolf 359, TRAPPIST-1, Teegarden Yıldızı, UY Scuti …) | `web/data/bright_stars.json` |
| Arama | Yıldız ve takımyıldız adları çevrimdışı aranır: özel ad, Türkçe ad (Kutup Yıldızı, Demirkazık, Avcı), Bayer adı Yunan harfiyle ya da okunuşuyla (α Cen, Alfa Erboğa, alf Ori), Flamsteed numarası, HIP, HD, Gliese, Gaia DR3 kimliği, koordinat. Sözcük başına 1–2 harflik yazım hatası kabul edilir ("proxima centuri", "betelguese"). Ufkun altındaki bir yıldız seçilince yer gizlenir ve bu kartta yazılır | `web/js/search.js` |
| Kayıtlı tüm yıldızlar | 2,5°'nin altına yakınlaşınca görünen alandaki Gaia DR3 yıldızları (en parlak 3.000) akar; yakınlaştıkça daha sönükleri gelir. Böylece Gaia'nın 1,8 milyar yıldızının hepsine ulaşılır. Tıklanan yıldızın kartı, ölçülmüş tüm parametrelerinden (Teff, log g, [M/H], element oranları, FLAME kütle/yaş/ışınım gücü, dikine hız) otomatik oluşur | `web/js/data.js` (VizieR ya da `GET /api/gaia/field`, `GET /api/gaia/source/<id>`) |
| Gaia yansıları | ESA arşivi kapalıysa (ör. DR4 hazırlığı) Heidelberg ARI yansısına otomatik geçilir; sıra `GAIA_TAP_MIRRORS` ile değişir | `server/app.py` |
| Fotoğraf → yıldız | JPG/PNG gece fotoğrafı: Phobetor yıldızları tarayıcıda bulur, yıldız deseni parlak yıldız kataloğuyla eşleştirilir (kör astrometri), fotoğrafın üstüne yıldız adları, takımyıldız çizgileri ve adları çizilir. FITS WCS tarayıcıda çözülür (TAN/SIN, CD/PC/CROTA; astropy ile birebir doğrulandı), ardından parlak katalog + Gaia DR3 eşleştirme | `web/js/phobetor.js`, `web/js/solve.js`, `web/js/fits.js`, `web/models/phobetor_euclid.onnx` |
| Draugr (şablon) | Yalnızca kartta bulunan ölçülmüş alanlardan Türkçe anlatım; olmayan veri hakkında cümle kurmaz | `web/js/draugr.js` |
| Poltergeist (ön sürüm) | Gaia RVS [M/H] → kütlece H/He/metal oranı; Gaia element oranları; tayf sınıfından beklenen çizgiler (açıkça "ölçülmedi" etiketli) | `web/js/draugr.js` |

## Fotoğraftan yıldız bulma: Phobetor tarayıcıda

Gece fotoğrafı (telefon ya da fotoğraf makinesi, JPG/PNG) yüklenince her şey ziyaretçinin tarayıcısında olur: fotoğraf hiçbir sunucuya gitmez, ücretli ya da anahtarlı bir servis yoktur.

1. **Phobetor yıldızları bulur.** Euclid Q1 görüntüleriyle eğitilen model (`en_iyi.pt`, 4,7 milyon parametre, Euclid test bölümünde kesinlik 0,90, duyarlılık 0,76) `tools/export_phobetor_onnx.py` ile ONNX'e çevrildi: `web/models/phobetor_euclid.onnx`, 9,4 MB, ağırlıklar float16, hesap float32. Çeviri, numpy ile ayrıca yazılmış bir ileri geçişle karşılaştırıldı (fark < 3·10⁻⁷). Tarayıcıda [onnxruntime-web](https://onnxruntime.ai/) 1.31.1 ile, varsa WebGPU'da, yoksa WebAssembly'de çalışır (`web/js/phobetor.js`). Fotoğraf uzun kenarı 1280 (WebGPU) ya da 800 piksel (WebAssembly) olacak şekilde küçültülür, sRGB'den doğrusal parlaklığa çevrilir, gökyüzü arka planı ve gürültüsü 32 piksellik hücrelerde ölçülür ve model eğitimdeki normalizasyonla (asinh(S/N / 3)) beslenir; Euclid'in dört bandına aynı parlaklık verilir. Çekirdeği 255'te kırpılmış (doymuş) çok parlak yıldızlar ayrıca ölçülür: Phobetor Euclid görüntülerinde böyle yıldız görmediği için bunları ya hiç bulmuyor ya da halesini birkaç parça sanıyor. Konum olarak kırpılmış çekirdeğin ağırlık merkezi, parlaklık olarak geniş bir açıklıktaki toplam ışık alınır, aynı yıldızın hale parçaları silinir.
2. **Yıldız deseni gökyüzüyle eşleştirilir** (`web/js/solve.js`, sayfa donmasın diye ayrı bir iş parçacığında). Odak uzaklığı bilinmediği için olası görüş açıları (6°–130°) sırayla denenir: önce EXIF'ten çıkan açı (35 mm karşılığı odak; bunu yazmayan fotoğraf makinelerinde odak uzaklığı ve sensör boyutu), EXIF yoksa telefonların ana kamerası (~67°). En parlak yıldızların açısal uzaklıklarından üçgenler kurulur, katalogda aynı üçgen aranır (ayna görüntüleri elenir) ve dördüncü bir yıldızın da tutması gerekir. Aday kamera yönü diğer parlak yıldızlarla denetlenir, sonra bütün görüntüyle doğrulanır: bu kadar eşleşmenin rastlantıyla çıkma olasılığı 10⁻⁹'dan büyükse çözüm reddedilir. Uçak ve uydu izleri, düz bir çizgi üstünde dizilen noktalar ve sıkışık ışık kümeleri üçgenlere alınmaz. Kabul edilen çözümde kamera yönü, odak, mercek bozulması ve optik merkez bütün eşleşen yıldızlara adım adım uydurulur. 45 saniyede çözüm bulunamazsa arama durur.
3. Fotoğrafın üstüne tanınan yıldızlar (en parlak 15'i adıyla), takımyıldız çizgileri ve Türkçe adları çizilir. Phobetor'un bulamadığı çok parlak yıldızlar (V ≤ 1,5; örneğin doymuş ya da bulutun, ağacın arkasında kalmış) çözümden hesaplanan yerlerinde kesikli halkayla gösterilir ve listede "yeri hesaplandı" diye yazar. Phobetor'un bulup katalogla eşleşmeyen noktaları (sönük yıldız, gezegen, uçak, lamba) küçük sarı halkayla gösterilir. Bir yıldıza tıklayınca gökyüzünde fotoğrafın kapladığı alan ve yıldızın kartı açılır.

### Ölçülen sonuçlar

Gerçekçi yapay telefon fotoğraflarıyla ölçüldü (`tools/make_test_photos.py`): parlak yıldız kataloğundan çizilirler; mercek, yıldız profili, gökyüzü parlaması ve eğimi, foton ve okuma gürültüsü, telefonun gürültü azaltması, sRGB tonu, JPEG sıkıştırması, bazılarında ön planda karanlık yer ve iz bırakan yıldızlar vardır. Yedincisi birleştirilmiş (stack) bir fotoğraf makinesi pozudur: V 5'ten parlak bütün yıldızların çekirdeği 255'te kırpılmıştır. Doğru cevap bilindiği için sonuç kesin ölçülebiliyor.

Phobetor, ilk altı fotoğrafta (1024 piksellik görüntüler, eşik 0,10; "görünür yıldız" = S/N > 7):

| Fotoğraf | Bulunan görünür yıldız | Tespitlerden yıldız olan |
|---|---|---|
| Avcı (Orion), karanlık gökyüzü, ana kamera | %90 | %100 |
| Büyükayı, şehir ışığı, ön planda yer | %50 (V < 3 olanların hepsi) | %91 |
| Boğa ve Ülker, 3x tele, dikey | %97 | %99 |
| Kuğu, ultra geniş açı (100°), mercek bozulması | %90 | %100 |
| Kraliçe, iz bırakan yıldızlar | %71 | %97 |
| Akrep, yoğun gürültü azaltma, JPEG | %56 | %72 |

- Euclid'de seçilen 0,63 eşiğiyle aynı fotoğraflarda görünür yıldızların yalnızca %5–24'ü bulunuyordu. Euclid görüntülerinde sönük kaynakların çoğu galaksi olduğundan model sönük noktalara "yıldız" demekten çekiniyor. Gece fotoğrafında galaksi neredeyse olmadığından eşik 0,10'a indirildi.
- Parlak yıldızların (V < 3) hepsini her fotoğrafta buldu; eşleştirme için gereken de bu.
- Karşılaştırma için klasik bir bulucu (Gauss süzgeci + 5σ tepe) daha çok sönük yıldız buluyor ama zor fotoğraflarda (şehir ışığı, yoğun gürültü azaltma) tespitlerinin yalnızca %12–18'i yıldız. Phobetor bu fotoğraflarda çok daha güvenilir.
- Telefon fotoğraflarıyla ince ayar (fine-tune) yapılırsa sönük yıldızlarda da iyileşmesi beklenir.

Eşleştirme: 7 yapay fotoğrafın 7'si çözüldü. Merkez hatası en fazla 0,03°, görüş açısı hatası %0,3'ün altında; eşleşen yıldızların %95–100'ü doğru yıldız. Süre: ana kamera açısında 0,1 saniyenin altında, tele ve ultra geniş açıda 0,5–1,5 saniye. Rastgele noktalardan oluşan 6 sahte "fotoğrafta" yanlış çözüm çıkmadı.

Tarayıcıda (WebAssembly, tek iş parçacığı, 800 piksel) Phobetor bir fotoğrafı 5–8 saniyede işliyor; WebGPU'lu cihazlarda çok daha hızlı. İlk kullanımda model (9,4 MB) ve onnxruntime-web (sıkıştırılmış yaklaşık 7 MB) bir kez iner.

### Gerçek fotoğraflar

`site-check` her çalışmada Wikimedia Commons'tan 11 serbest lisanslı gece fotoğrafı indirip siteye yükler (yalnızca test için; depoya girmez, lisansı ve yazarı sonuçla birlikte yazdırılır). Bunlarda yalnızca hangi takımyıldızın çekildiği bilinir; denetlenen, çözümün o takımyıldıza düşmesi ve kadrajdaki parlak yıldızların bulunup adlandırılmasıdır.

| Fotoğraf | Görüş alanı | Kadrajdaki V ≤ 3,5 yıldızlardan bulunan |
|---|---|---|
| Avcı, dar alan | 16° × 24° | 11 / 11 |
| Avcı, 40 mm objektif | 44° × 31° | 18 / 18 |
| Avcı, Büyük Kanyon | 36° × 25° | 12 / 13 |
| Avcı, dikey, geniş açı | 58° × 73° | 29 / 34 |
| Kraliçe (Cassiopeia) | 25° × 26° | 6 / 6 |
| Akrep, Bali | 68° × 53° | 35 / 46 |
| Akrep | 26° × 22° | 14 / 15 |
| Kuğu ve Samanyolu | 25° × 17° | 4 / 4 |
| Avcı, aynı alan yan yana iki kez, birinin üstünde çizilmiş çizgiler | – | çözülemedi |
| Avcı, evin üstünde (ön planda ev ışıkları) | – | çözülemedi |
| Büyükayı, ince bulut, ön planda sokak ve ev ışıkları | – | çözülemedi |

- 11 fotoğrafın 8'i çözüldü; bunlarda kadrajdaki V 3,5'ten parlak 147 yıldızın 129'u bulundu ve adlandırıldı. Kaçanların çoğu ufka çok yakın ya da ön planın arkasında.
- Çözülemeyen üçünden biri tek bir fotoğraf değil (aynı alanın yan yana iki kopyası). Diğer ikisinde ev ve sokak ışıkları yıldızlardan parlak: eşleştirme en parlak noktalardan başladığı için ışıklar üçgenlere giriyor ve 45 saniyelik süre doluyor. Kırpmanın etkisi Phobetor'un bu iki fotoğraftaki tespitleri üzerinde denendi: evli fotoğrafın ışıklı alt kısmı kesilince 1,3 saniyede çözüldü, bulutlu fotoğraf kesilince de çözülmedi.
- Tarayıcıda (WebAssembly) Phobetor fotoğraf başına 5–8 saniye, eşleştirme 0,1–2,5 saniye sürdü.

## Kataloğu yeniden üretmek

```bash
npm pack d3-celestial@0.7.35 && tar xzf d3-celestial-0.7.35.tgz   # yıldız adları, takımyıldızlar, sınırlar
python tools/build_bright_catalog.py --vmax 7.0 --d3 package/data
# ESA arşivi kapalıyken (ör. DR4 hazırlığı): var olan dosyanın V < 7 satırları korunur, adlar yenilenir,
# eksik adlı yıldızlar Hipparcos yeni indirgemesinden (Heidelberg ARI) eklenir
python tools/build_bright_catalog.py --base web/data/bright_stars.json --d3 package/data
python tools/build_constellations.py package/data web/data/constellations.json
```

Phobetor modelini yeniden çevirmek (PyTorch gerekmez; `pip install onnx onnxruntime numpy`):

```bash
python tools/export_phobetor_onnx.py en_iyi.pt web/models/phobetor_euclid.onnx --check
```

Kaynaklar: ESA Hipparcos Kataloğu (1997) ve yeni indirgemesi (van Leeuwen 2007, Heidelberg ARI üzerinden), Gaia DR3 `astrophysical_parameters` ve Hipparcos dışındaki birkaç ünlü yıldız için `gaia_source` (Gaia Collaboration 2023), yıldız adları, takımyıldızlar ve takımyıldız sınırları d3-celestial (BSD-3, O. Frohn; çizgiler IAU ve Sky & Telescope haritalarından, sınırlar Davenhall ve Leggett 1989).

## Bilinen sınırlar

- Phobetor telefon fotoğrafı görmeden (Euclid ile) eğitildi; sönük yıldızlarda temkinli. Gerçek fotoğraf denemeleri Wikimedia Commons'taki serbest lisanslı fotoğraflarla yapılıyor (yukarıda); telefonla çekildiği bilinen bir gece fotoğrafıyla henüz denenmedi.
- Ön planda yıldızlardan parlak ışıklar (ev, sokak lambası) olan fotoğraflar çoğu zaman çözülemiyor; ışıklı kısım kırpılırsa şans artar. Bulut, uzun pozlamadaki yıldız izleri ve üstüne çizim yapılmış ya da birleştirilmiş (kolaj) görüntüler de çözümü bozabilir.
- Eşleştirme parlak yıldız kataloğuyla (V ≤ 6,5) yapılır: görüş alanı 6°'den dar (teleskop) fotoğraflarda yeterince parlak yıldız olmayabilir; bunlar için WCS başlıklı FITS ya da Astrometry.net.
- Ayna görüntüsü (ön kamera) ve çok kırpılmış ya da bükülmüş fotoğraflar çözülemeyebilir. Gezegenler, Ay ve uçak/uydu izleri katalogda yok.
- Sunucudaki Astrometry.net yolu bu ortamda test edilemedi (ağ erişimi yoktu); kod nova API belgelerine göre yazıldı.
- CDS'nin Strasbourg sunucularına (VizieR, HiPS kataloğu) GitHub'ın test makinelerinden ulaşılamadı; site testleri VizieR'in Harvard CfA yansısıyla geçti. HiPS kataloğu yolu sahte (mock) bir CDS servisiyle denendi.
- Arama yalnızca gömülü kataloğun 15.504 yıldızını ve 88 takımyıldızı bilir. Adı olmayan sönük bir yıldıza koordinatla (ör. `269.45 4.67`) gidilip yakınlaşılır; kartı Gaia DR3'ten gelir.
- Çok parlak yıldızlar (V < 3) Gaia'yı doyurduğu için Gaia parametreleri çoğunda yok; kart bu durumda Hipparcos ve B−V'den hesaplanan değerleri gösterir ve bunu etiketler.
- Çözüm işleri sunucu belleğinde tutulur (prototip).
