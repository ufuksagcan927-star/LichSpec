# LichSpec Gökyüzü (prototip)

Tüm gökyüzünü gezip bir yıldıza tıklayınca o yıldızın ölçülmüş verilerini, Poltergeist ön tahminini ve Draugr anlatımını gösteren site. Fotoğraf yükleyince koordinatlar çözülür ve görüntüdeki yıldızlar tanınır.

## Çalıştırma

```bash
pip install -r server/requirements.txt
python server/app.py          # http://localhost:8000
```

JPG/PNG fotoğrafları çözmek için (ücretsiz) Astrometry.net API anahtarı gerekir:

```bash
export ASTROMETRY_API_KEY=...   # nova.astrometry.net → giriş yap → "API" sayfası
```

WCS başlığı olan FITS dosyaları anahtar olmadan, sunucuda anında çözülür.

## Yayınlamak (sunucusuz)

Site statik dosyalardan ibarettir (`web/`), sunucu olmadan da tam çalışır:

- **Netlify** (repo gizli kalabilir): app.netlify.com → *Add new site* → *Import an existing project* → GitHub → `LichSpec`. Ayarlar repodaki `netlify.toml` dosyasından gelir (yayın klasörü `web`).
- **GitHub Pages** (açık repo ya da GitHub Pro): *Settings → Pages → Source: GitHub Actions*. `main`'e her gönderimde `.github/workflows/pages.yml` siteyi yayınlar.

Statik çalışırken Gaia DR3 verisi tarayıcıdan doğrudan CDS'ten gelir: CDS'nin Gaia DR3 HiPS kataloğuna ulaşılabiliyorsa gökyüzü katmanı oradan (karolar, her ölçekte hızlı), ulaşılamıyorsa VizieR'in bir yansısından (CDS, Harvard CfA ya da IDIA; açılışta hangisi önce cevap verirse) görünen alanın en parlak 3.000 yıldızı sorgulanır. VizieR'de bu sorgu dairedeki bütün yıldızları taradığından yavaştır, bu yüzden o yolda alan galaktik enleme göre sınırlanır (Samanyolu düzleminde daha çok yakınlaşmak gerekir). FITS dosyaları tarayıcıda çözülür. JPG/PNG için kullanıcı fotoğrafını ücretsiz nova.astrometry.net'te çözdürüp oradan inen `new-image.fits` dosyasını yükler. `python server/app.py` ile açıldığında ise site bunu algılar ve Gaia sorgularını kendi sunucusu üzerinden yapar (ESA → Heidelberg yansısı geçişiyle), JPG/PNG'yi de Astrometry.net API'siyle doğrudan çözer.

`.github/workflows/site-check.yml` her değişiklikte önce veri servislerini yoklar (`tools/probe_services.py`: her VizieR yansısı için DNS, CORS, süre; Gaia sütun adları; alan sorgusunun süresi ve doğru sıralanıp sıralanmadığı), sonra siteyi gerçek internette statik olarak açıp gökyüzü, Gaia katmanı, yıldız kartı ve FITS çözümünü dener.

## Nasıl çalışıyor

| Parça | Ne yapar | Veri |
|---|---|---|
| Gökyüzü | Aladin Lite v3, HiPS karolarını akıtır; tüm gökyüzü siteye gömülmez, yalnızca ekrandaki karolar indirilir | DSS2, Mellinger, Pan-STARRS, SDSS, 2MASS, AllWISE |
| Parlak yıldız modeli | 15.397 yıldız (Hipparcos V < 7) haritada tıklanabilir, aranabilir, çevrimdışı | `web/data/bright_stars.json` |
| Kayıtlı tüm yıldızlar | 2,5°'nin altına yakınlaşınca görünen alandaki Gaia DR3 yıldızları (en parlak 3.000) akar; yakınlaştıkça daha sönükleri gelir. Böylece Gaia'nın 1,8 milyar yıldızının hepsine ulaşılır. Tıklanan yıldızın kartı, ölçülmüş tüm parametrelerinden (Teff, log g, [M/H], element oranları, FLAME kütle/yaş/ışınım gücü, dikine hız) otomatik oluşur | `web/js/data.js` (VizieR ya da `GET /api/gaia/field`, `GET /api/gaia/source/<id>`) |
| Gaia yansıları | ESA arşivi kapalıysa (ör. DR4 hazırlığı) Heidelberg ARI yansısına otomatik geçilir; sıra `GAIA_TAP_MIRRORS` ile değişir | `server/app.py` |
| Fotoğraf → yıldız | FITS WCS tarayıcıda çözülür (TAN/SIN, CD/PC/CROTA; astropy ile birebir doğrulandı); JPG/PNG için Astrometry.net. Ardından parlak katalog + Gaia DR3 eşleştirme, fotoğraf üzerinde işaretleme | `web/js/fits.js`, `POST /api/solve` |
| Draugr (şablon) | Yalnızca kartta bulunan ölçülmüş alanlardan Türkçe anlatım; olmayan veri hakkında cümle kurmaz | `web/js/draugr.js` |
| Poltergeist (ön sürüm) | Gaia RVS [M/H] → kütlece H/He/metal oranı; Gaia element oranları; tayf sınıfından beklenen çizgiler (açıkça "ölçülmedi" etiketli) | `web/js/draugr.js` |

## Kataloğu yeniden üretmek

```bash
npm pack d3-celestial@0.7.35 && tar xzf d3-celestial-0.7.35.tgz   # yıldız adları
python tools/build_bright_catalog.py --vmax 7.0 --names package/data/starnames.json
```

Kaynaklar: ESA Hipparcos Kataloğu (1997), Gaia DR3 `astrophysical_parameters` (Gaia Collaboration 2023), yıldız adları d3-celestial (BSD-3, O. Frohn).

## Bilinen sınırlar

- Astrometry.net yolu bu ortamda test edilemedi (ağ erişimi yoktu); kod nova API belgelerine göre yazıldı.
- CDS'nin Strasbourg sunucularına (VizieR, HiPS kataloğu) GitHub'ın test makinelerinden ulaşılamadı; site testleri VizieR'in Harvard CfA yansısıyla geçti. HiPS kataloğu yolu sahte (mock) bir CDS servisiyle denendi.
- Çok parlak yıldızlar (V < 3) Gaia'yı doyurduğu için Gaia parametreleri çoğunda yok; kart bu durumda Hipparcos ve B−V'den hesaplanan değerleri gösterir ve bunu etiketler.
- Çözüm işleri sunucu belleğinde tutulur (prototip).
