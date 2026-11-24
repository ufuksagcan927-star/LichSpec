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

## Nasıl çalışıyor

| Parça | Ne yapar | Veri |
|---|---|---|
| Gökyüzü | Aladin Lite v3, HiPS karolarını akıtır; tüm gökyüzü siteye gömülmez, yalnızca ekrandaki karolar indirilir | DSS2, Mellinger, Pan-STARRS, SDSS, 2MASS, AllWISE |
| Parlak yıldız modeli | 15.397 yıldız (Hipparcos V < 7) haritada tıklanabilir, aranabilir, çevrimdışı | `web/data/bright_stars.json` |
| Sönük yıldızlar | Boş bir noktaya tıklayınca Gaia DR3 canlı sorgulanır (sunucu üzerinden, ESA TAP'ta CORS yok) | `GET /api/gaia/cone` |
| Fotoğraf → yıldız | FITS WCS ya da Astrometry.net ile koordinat çözümü, ardından katalog + Gaia DR3 eşleştirme, fotoğraf üzerinde işaretleme | `POST /api/solve` |
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
- Çok parlak yıldızlar (V < 3) Gaia'yı doyurduğu için Gaia parametreleri çoğunda yok; kart bu durumda Hipparcos ve B−V'den hesaplanan değerleri gösterir ve bunu etiketler.
- Çözüm işleri sunucu belleğinde tutulur (prototip).
