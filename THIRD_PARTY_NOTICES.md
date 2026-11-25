# Third-party data and services

The LichSpec source code is MIT licensed (see [LICENSE](LICENSE)). The data below is not
ours and keeps its own terms.

## Data included in this repository

### `web/data/bright_stars.json`

Built by [`tools/build_bright_catalog.py`](tools/build_bright_catalog.py) from:

- **The Hipparcos Catalogue**, ESA 1997 (ESA SP-1200), read through the Gaia archive
  table `public.hipparcos`.
- **Gaia DR3** astrophysical parameters, Gaia Collaboration (2023), A&A 674, A1.
  Gaia data © ESA/Gaia/DPAC, licensed under
  [CC BY-SA 3.0 IGO](https://creativecommons.org/licenses/by-sa/3.0/igo/). Because the
  file contains Gaia DR3 values, `bright_stars.json` is shared under the same licence.
- **Star names** from `starnames.json` in [d3-celestial](https://github.com/ofrohn/d3-celestial)
  0.7.35, BSD-3-Clause, reproduced below.

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

### `docs/screenshots/`

Screenshots of the site. The sky imagery in them is DSS2 colour (STScI/NASA, HiPS by CDS).

## Services the site loads at runtime (not included here)

- [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) v3, CDS Strasbourg (GPL-3.0),
  loaded from jsDelivr.
- [VizieR](https://vizier.cds.unistra.fr/) (CDS Strasbourg) and its mirrors at Harvard CfA and
  IDIA. "This research has made use of the VizieR catalogue access tool, CDS, Strasbourg,
  France."
- Gaia DR3 HiPS catalogue (CDS).
- HiPS sky surveys built by CDS: DSS2 colour (STScI/NASA), SDSS9, 2MASS and AllWISE (tiles
  served by IRSA), plus Pan-STARRS DR1 and Axel Mellinger's Milky Way panorama
  (© A. Mellinger), served by CDS.
