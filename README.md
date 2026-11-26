<p align="center">
  <img src="web/assets/logo.svg" alt="LichSpec logo" width="120">
</p>

<h1 align="center">LichSpec</h1>

<p align="center">
  AI system that identifies stars in space images (Phobetor), infers their composition from spectra (Poltergeist), and explains the results (Draugr).
</p>

<p align="center">
  <b><a href="https://ufuksagcan927-star.github.io/LichSpec/">Live sky explorer</a></b> ·
  <a href="web/README.md">Türkçe ayrıntılar</a> ·
  <a href="LICENSE">MIT licence</a>
</p>

---

## The sky explorer

A browser app for the whole sky as you would see it from where you stand: look around, click any star and
get a card built from its measured data, or drop in a night photo from your phone and see which stars and
constellations are in it.

| | |
|---|---|
| ![Whole-sky view with named bright stars](docs/screenshots/sky.jpg) | ![Gaia DR3 stars streamed into the open cluster M67, with a star card](docs/screenshots/gaia-m67.jpg) |
| **Whole sky.** 15,397 bright stars (Hipparcos V < 7) modelled offline with Gaia DR3 parameters and proper names; clickable and searchable. | **All 1.8 billion Gaia DR3 stars.** Zoom in and the brightest stars of the visible field stream in; the card shows temperature, gravity, chemistry, FLAME mass/age, radial velocity. |
| ![Star card for γ Lep with narration and measured values](docs/screenshots/star-card.jpg) | ![Photo upload: a FITS image solved in the browser with Gaia stars marked](docs/screenshots/photo-solve.jpg) |
| **Star card.** Every value names its source. Draugr (template version) narrates only what was measured; Poltergeist (preview) turns [M/H] into H/He/metal mass fractions. | **Photo → stars.** Night photos (JPG/PNG): Phobetor finds the stars in the browser and the star pattern is matched to the sky; star names and constellation figures are drawn on the photo. FITS images with a WCS header are solved too (matches astropy to 1e-10″). |

### How it works

- **One view, from the ground.** The sky is drawn from inside, the way a planetarium does it (stereographic projection), with the observer's horizon, ground and compass points worked out for their place and time, and the constellation figures with Turkish names (`web/js/sky.js`).
- **Sky imagery** streams as HiPS tiles through [Aladin Lite v3](https://aladin.cds.unistra.fr/AladinLite/): Axel Mellinger's all-sky photograph when zoomed out, DSS2 fading in as you zoom; nothing is embedded in the site.
- **Gaia DR3** comes straight from the browser: CDS's Gaia HiPS catalogue when it answers, otherwise one "brightest 3,000 in this field" query to a VizieR mirror (CDS, Harvard CfA or IDIA, whichever answers first). Field size on that path is capped by galactic latitude, because the query scans every star in the circle.
- **Phobetor in the browser.** The star detector trained on Euclid Q1 is exported to ONNX without PyTorch (`tools/export_phobetor_onnx.py`, checked against an independent numpy forward pass) and runs in the visitor's browser with onnxruntime-web, on WebGPU when available, otherwise WebAssembly (`web/js/phobetor.js`). Nothing is uploaded anywhere.
- **Blind star-pattern matching** (`web/js/solve.js`, in a Web Worker): unknown focal length is searched (EXIF first), triangles of the brightest stars are matched by angular distance against the bright-star catalogue, each candidate is verified against the whole image (false-match probability < 1e-9), then attitude, focal length, lens distortion and optical centre are fitted to all matched stars. On realistic synthetic phone photos (main camera, 3x tele, 100° ultrawide, city sky with only 13 stars, trailed stars, heavy noise reduction) all six were solved to within 0.03°; see [web/README.md](web/README.md) for the measured detection rates.
- **No server needed.** The site is static files (`web/`). An optional Flask server (`server/app.py`) adds a Gaia TAP proxy with ESA → Heidelberg failover and an Astrometry.net fallback for photos the browser cannot solve.
- **FITS/WCS in JavaScript** (`web/js/fits.js`): TAN and SIN projections, CD / PC / CDELT+CROTA matrices, gzip, BSCALE/BZERO, asinh preview stretch.
- **Tested on the real internet.** [`site-check`](.github/workflows/site-check.yml) probes every data service (DNS, CORS, latency, column names), then opens the static site in Playwright and checks the sky, the Gaia layer, a star card and a FITS solve. [`photo_check.js`](tools/photo_check.js) then uploads synthetic phone-like photos and real sky images (Mellinger cut-outs from CDS hips2fits, freely licensed Orion photos from Wikimedia Commons) and checks that each lands at the right place on the sky.

### Run it

```bash
cd web && python -m http.server 8080          # static, same as the hosted site
# or, with the optional server:
pip install -r server/requirements.txt && python server/app.py   # http://localhost:8000
```

Deployment: GitHub Pages (`.github/workflows/pages.yml`, Settings → Pages → Source: GitHub Actions) or Netlify (`netlify.toml`, publish folder `web`).

## The models

The name comes from the pulsar **Lich (PSR B1257+12)**, the first star found to host planets. Its three planets name the models:

| Model | Role | Status |
|---|---|---|
| **Phobetor** | Detects, segments and identifies stars in space images | Euclid mode trained (test precision 0.90, recall 0.76); runs in the browser on uploaded photos. A phone-photo fine-tune would help faint stars |
| **Poltergeist** | Predicts elements and compounds from a source's spectrum | Preview in the star card ([M/H] → composition, expected lines labelled "not measured") |
| **Draugr** | Explains the findings in plain language | Template narration from measured fields; LLM version planned |

## Data and credits

Gaia data © ESA/Gaia/DPAC (CC BY-SA 3.0 IGO); the Hipparcos Catalogue (ESA 1997); star names and constellation figures from d3-celestial (BSD-3-Clause; figures after the IAU and Sky & Telescope charts); Aladin Lite, VizieR and HiPS by CDS, Strasbourg. Details and full notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

Code: [MIT](LICENSE). The bundled star catalogue (`web/data/bright_stars.json`) contains Gaia DR3 values and is shared under CC BY-SA 3.0 IGO, as described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
