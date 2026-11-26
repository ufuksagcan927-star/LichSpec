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
