<p align="center">
  <img src="assets/brand/logo_512.png" alt="LichSpec logo" width="200">
</p>

<h1 align="center">LichSpec</h1>

<p align="center">
  AI system that identifies stars in space images, infers their composition from spectra, and explains the results.
</p>

---

## About

LichSpec takes high-resolution space images from telescopes and satellites, splits them region by region and star by star, and works out which star each source is and which elements and compounds its light reveals. The target accuracy is **97%**.

The name comes from the pulsar **Lich (PSR B1257+12)**, the first star found to host exoplanets. Its three planets give the project's models their names:

| Model | Role |
|---|---|
| **Phobetor** | Image processing: detects and segments stars in space images and identifies them. |
| **Poltergeist** | Spectroscopy: predicts the elements and materials present from a source's spectrum. |
| **Draugr** | Commentator: an LLM that explains the findings of Phobetor and Poltergeist in plain language. |

## Logo

The logo shows Lich at the center with its three planets on a single orbit, each in its model's colour: Phobetor purple, Poltergeist cyan, Draugr pink.

Brand files live in [`assets/brand/`](assets/brand/):

| File | Use |
|---|---|
| `logo.svg` | Logo with a transparent background (README, website) |
| `logo_black_bg.svg` | Logo on a black background |
| `logo_512.png`, `icon_192.png`, `apple-touch-icon.png` | App and web icons |
| `favicon.ico` | Browser tab icon |
| `social_preview.png` | 1280×640 GitHub social preview image |
