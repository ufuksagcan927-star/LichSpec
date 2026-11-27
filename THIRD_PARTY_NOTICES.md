# Third-party data and services

The LichSpec source code is MIT licensed (see [LICENSE](LICENSE)). The data below is not
ours and keeps its own terms.

## Data included in this repository

### `web/data/bright_stars.json`

Built by [`tools/build_bright_catalog.py`](tools/build_bright_catalog.py) from:

- **The Hipparcos Catalogue**, ESA 1997 (ESA SP-1200), read through the Gaia archive
  table `public.hipparcos`.
- **Hipparcos, the New Reduction of the Raw Data**, F. van Leeuwen (2007), A&A 474, 653,
  read through the Gaia mirror of the Astronomisches Rechen-Institut, Heidelberg (table
  `hipparcos`): positions and parallaxes of named stars fainter than V 7 (Proxima Centauri,
  Barnard's Star, ...).
- **Gaia DR3** astrophysical parameters, the `hipparcos2_best_neighbour` cross-match and, for a
  few famous stars that are not in Hipparcos (Wolf 359, TRAPPIST-1, UY Scuti, ...), `gaia_source`
  positions, photometry and astrometry. Gaia Collaboration (2023), A&A 674, A1.
  Gaia data © ESA/Gaia/DPAC, licensed under
  [CC BY-SA 3.0 IGO](https://creativecommons.org/licenses/by-sa/3.0/igo/). Because the
  file contains Gaia DR3 values, `bright_stars.json` is shared under the same licence.
- **Star names and designations** from `starnames.json`, the V magnitudes and B−V colours of
  those fainter named stars from `stars.14.json` (XHIP, Anderson & Francis 2012), and the
  constellation boundaries from `constellations.bounds.json` (Davenhall & Leggett 1989, used to
  find the constellation of stars without a Bayer or Flamsteed name), all in
  [d3-celestial](https://github.com/ofrohn/d3-celestial) 0.7.35, BSD-3-Clause, reproduced below.
  The other common names and catalogue designations (`ALIASES`, `FAMOUS` in the build script)
  are the standard names of those stars.

> This work has made use of data from the European Space Agency (ESA) mission Gaia
> (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis
> Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the
> DPAC has been provided by national institutions, in particular the institutions
> participating in the Gaia Multilateral Agreement.

#### d3-celestial licence

```
Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### `web/data/constellations.json`

Built by [`tools/build_constellations.py`](tools/build_constellations.py) from `constellations.lines.json` and
`constellations.json` (label positions, Latin names and genitives) in
[d3-celestial](https://github.com/ofrohn/d3-celestial) 0.7.35 (BSD-3-Clause, licence text above). d3-celestial drew the stick figures after the IAU constellation charts (IAU and Sky & Telescope,
Roger Sinnott and Rick Fienberg). The Turkish names are ours (`web/js/draugr.js`).

### `web/data/deep_sky.json` and `web/data/compact.json`

Built by [`tools/build_sky_objects.py`](tools/build_sky_objects.py) from the tables that
[`tools/fetch_sky_tables.py`](tools/fetch_sky_tables.py) downloads. Every card in the site names the
source of each value.

- **OpenNGC** by Mattia Verga, <https://github.com/mattiaverga/OpenNGC>, licensed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/): all NGC and IC objects and the
  addendum (positions, types, magnitudes, sizes, position angles, Hubble types, radial velocities,
  identifiers, planetary nebula central stars). `deep_sky.json` is a database derived from OpenNGC and
  is shared under the same licence, CC BY-SA 4.0. The Turkish names and the added values below are part
  of it.
- Read through [VizieR](https://vizier.cds.unistra.fr/) (CDS, Strasbourg):
  open clusters from Hunt & Reffert 2023, A&A 673, A114 (Gaia DR3) and Cantat-Gaudin et al. 2020,
  A&A 640, A1 (Gaia DR2); globular cluster distances and masses from Baumgardt & Hilker 2018,
  MNRAS 478, 1520, and metallicities from Harris 1996, AJ 112, 1487 (2010 edition, VII/202);
  planetary nebula distances from the Gaia EDR3 parallaxes of their central stars,
  González-Santamaría et al. 2021, A&A 656, A51; nearby galaxies from the Updated Nearby Galaxy
  Catalog, Karachentsev, Makarov & Kaisina 2013, AJ 145, 101; galaxy distances from Cosmicflows-4,
  Tully et al. 2023, ApJ 944, 94; Galactic supernova remnants from Green 2019, J. Astrophys. Astron.
  40, 36 (VII/284); dark nebulae from Barnard 1927 (VII/220A); HII regions from Sharpless 1959,
  ApJS 4, 257 (VII/20); constellation boundaries from Roman 1987, PASP 99, 695 (VI/42).
- `compact.json`: the **ATNF Pulsar Catalogue**, Manchester et al. 2005, AJ 129, 1993,
  <https://www.atnf.csiro.au/research/pulsar/psrcat/>, version 2.9.0 (`psrcat.db` from ATNF's psrcat
  package; distances derived from the dispersion measure from VizieR's copy, B/psr); the **McGill Online
  Magnetar Catalog**, Olausen & Kaspi 2014, ApJS 212, 6; **BlackCAT**, Corral-Santana et al. 2016,
  A&A 587, A61; **WATCHDOG**, Tetarenko et al. 2016, ApJS 222, 15.
- The distances of a few famous nebulae, the masses of central black holes and the well-known black
  holes and neutron stars written into the build script come from the papers named in it and in each
  record (`meta.sources` and the `src` fields), e.g. GRAVITY Collaboration 2022 (Sgr A*), Event Horizon
  Telescope 2019 (M87*), Miller-Jones et al. 2021 (Cygnus X-1), El-Badry et al. 2023 and Gaia
  Collaboration 2024 (Gaia BH1–3), Menten et al. 2007 (Orion Nebula), Pietrzyński et al. 2019 (LMC).

### `web/models/phobetor_euclid.onnx`

LichSpec's own Phobetor model (MIT, like the code), converted from the trained checkpoint by
[`tools/export_phobetor_onnx.py`](tools/export_phobetor_onnx.py). It was trained on public Euclid Q1 data
(ESA/Euclid/Euclid Consortium); no Euclid images are included.

### `docs/screenshots/`

Screenshots of the site. The sky imagery in them is DSS2 colour (STScI/NASA, HiPS by CDS).

## Services the site loads at runtime (not included here)

- [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) v3, CDS Strasbourg (GPL-3.0),
  loaded from jsDelivr.
- [ONNX Runtime Web](https://onnxruntime.ai/) 1.31.1, Microsoft (MIT), loaded from jsDelivr only when a
  photo is uploaded, to run Phobetor in the browser.
- [VizieR](https://vizier.cds.unistra.fr/) (CDS Strasbourg) and its mirrors at Harvard CfA and
  IDIA. "This research has made use of the VizieR catalogue access tool, CDS, Strasbourg,
  France."
- Gaia DR3 HiPS catalogue (CDS).
- HiPS sky surveys built by CDS: Axel Mellinger's all-sky Milky Way photograph (© A. Mellinger,
  served by CDS) and DSS2 colour (STScI/NASA, tiles served by IRSA).
