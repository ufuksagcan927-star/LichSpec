/*
 * LichData — Gaia DR3 erişim katmanı.
 *
 * İki çalışma biçimi var:
 *  - "server": site `python server/app.py` ile açıldıysa Gaia sorguları kendi sunucumuz
 *    üzerinden gider (ESA -> Heidelberg yansısı geçişi orada).
 *  - "static": site GitHub Pages / Netlify gibi statik bir yerde açıldıysa sorgular doğrudan
 *    tarayıcıdan CDS VizieR'e (ya da yansısına) gider. VizieR tarayıcı isteklerine izin
 *    veriyor (CORS); ESA ve diğer Gaia arşivleri vermiyor.
 *
 * Her iki yolda da dönen satırlar aynı alan adlarını kullanır (Gaia arşivindeki adlar:
 * source_id, ra, dec, phot_g_mean_mag, bp_rp, parallax, teff_gspphot, ...), böylece
 * uygulamanın geri kalanı veri nereden gelirse gelsin aynı kalır.
 */
(function (global) {
  "use strict";

  let mode = "static";

  // VizieR'in birbirinin aynısı yansıları. Hepsi tarayıcı isteklerine (CORS) izin veriyor.
  // Açılışta hepsine küçük bir istek atılır, ilk cevap veren öne alınır; biri düşerse
  // sıradakine geçilir.
  const VIZIER = [
    "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
    "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
  ];
  const T_MAIN = "I/355/gaiadr3";   // Gaia DR3 ana kaynak tablosu (1,8 milyar)
  const T_PARAM = "I/355/paramp";   // Gaia DR3 astrofiziksel parametreler (FLAME, GSP-Spec…)

  // VizieR sütun adı -> Gaia arşivi sütun adı. Bir alan için birden çok aday ad olabilir;
  // ilk bulunan kullanılır.
  const MAP = {
    source_id: ["Source", "GaiaDR3", "DR3Name"],
    ra: ["RA_ICRS", "RAdeg", "_RA"],
    dec: ["DE_ICRS", "DEdeg", "_DE"],
    phot_g_mean_mag: ["Gmag"],
    phot_bp_mean_mag: ["BPmag"],
    phot_rp_mean_mag: ["RPmag"],
    bp_rp: ["BP-RP"],
    parallax: ["Plx"],
    parallax_error: ["e_Plx"],
    pmra: ["pmRA"],
    pmdec: ["pmDE"],
    radial_velocity: ["RV"],
    ruwe: ["RUWE"],
    teff_gspphot: ["Teff"],
    logg_gspphot: ["logg"],
    mh_gspphot: ["[Fe/H]", "[M/H]"],
    distance_gspphot: ["Dist"],
    radius_gspphot: ["Rad"],
    lum_flame: ["Lum-Flame", "LumFlame", "Lum"],
    mass_flame: ["Mass-Flame", "MassFlame", "Mass"],
    age_flame: ["Age-Flame", "AgeFlame", "Age"],
    teff_gspspec: ["Teff-S", "TeffS"],
    logg_gspspec: ["logg-S", "loggS"],
    mh_gspspec: ["[M/H]-S", "[M/H]S"],
    fem_gspspec: ["[Fe/M]-S", "[Fe/M]S"],
    alphafe_gspspec: ["[alpha/Fe]-S", "[alpha/Fe]S"],
    cafe_gspspec: ["[Ca/Fe]-S", "[Ca/Fe]S"],
    mgfe_gspspec: ["[Mg/Fe]-S", "[Mg/Fe]S"],
    sife_gspspec: ["[Si/Fe]-S", "[Si/Fe]S"],
    tife_gspspec: ["[Ti/Fe]-S", "[Ti/Fe]S"],
    spectraltype_esphs: ["SpType-ELS", "SpTypeELS", "SpType"],
    phot_variable_flag: ["VarFlag"],
  };
  const NUMERIC_KEEP_STRING = new Set(["source_id", "spectraltype_esphs", "phot_variable_flag"]);

  /** VizieR/HiPS satırını Gaia arşivi alan adlarına çevir. */
  function fromVizier(row) {
    const out = {};
    for (const [key, names] of Object.entries(MAP)) {
      for (const n of names) {
        if (row[n] === undefined) continue;
        const raw = String(row[n]).trim();
        if (raw === "" || raw === "NaN") break;
        if (NUMERIC_KEEP_STRING.has(key)) out[key] = raw;
        else {
          const f = parseFloat(raw);
          if (isFinite(f)) out[key] = f;
        }
        break;
      }
    }
    return out;
  }

  /** VizieR asu-tsv çıktısını [{sütun: değer}] dizisine çevir. */
  function parseTsv(text) {
    const lines = text.split(/\r?\n/);
    let i = 0;
    const skip = () => { while (i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === "")) i++; };
    skip();
    if (i >= lines.length) return [];
    const header = lines[i++].split("\t").map((h) => h.trim());
    // birimler ve "-----" satırını atla
    while (i < lines.length && !/^[-\t ]+$/.test(lines[i])) {
      if (lines[i].startsWith("#") || lines[i].trim() === "") return [];
      i++;
    }
    i++;
    const rows = [];
    for (; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.trim() === "" || ln.startsWith("#")) break;
      const cells = ln.split("\t");
      const o = {};
      header.forEach((h, k) => { o[h] = cells[k] !== undefined ? cells[k].trim() : ""; });
      rows.push(o);
    }
    return rows;
  }

  const PING = new URLSearchParams({
    "-source": T_MAIN, "-c": "0 +0", "-c.rs": "120", "-out": "Source", "-out.max": "1",
  }).toString();
  let mirrorsP = null;

  /** Yansıları hıza göre sırala: ilk cevap veren başa geçer. */
  function mirrors() {
    if (mirrorsP) return mirrorsP;
    mirrorsP = new Promise((resolve) => {
      let left = VIZIER.length, done = false;
      const finish = (first) => {
        if (done) return;
        done = true;
        resolve(first ? [first, ...VIZIER.filter((b) => b !== first)] : VIZIER.slice());
      };
      setTimeout(() => finish(null), 8000);
      for (const base of VIZIER) {
        fetch(`${base}?${PING}`)
          .then((r) => (r.ok ? r.text() : ""))
          .then((t) => { if (/^\s*\d{8,}/m.test(t)) finish(base); else if (--left === 0) finish(null); })
          .catch(() => { if (--left === 0) finish(null); });
      }
    });
    return mirrorsP;
  }

  async function vizier(params, timeoutMs = 30000) {
    const qs = new URLSearchParams(params).toString();
    const order = await mirrors();
    let lastErr;
    for (const base of order.slice()) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}?${qs}`, { signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const txt = await r.text();
        clearTimeout(t);
        if (order[0] !== base) { order.splice(order.indexOf(base), 1); order.unshift(base); }
        return parseTsv(txt);
      } catch (e) {
        clearTimeout(t);
        lastErr = e.name === "AbortError" ? new Error("zaman aşımı") : e;
      }
    }
    throw new Error("VizieR'e ulaşılamadı (" + (lastErr && lastErr.message) + ")");
  }

  function sepArcsec(ra1, de1, ra2, de2) {
    const r = Math.PI / 180;
    const c = Math.sin(de1 * r) * Math.sin(de2 * r) + Math.cos(de1 * r) * Math.cos(de2 * r) * Math.cos((ra1 - ra2) * r);
    return (Math.acos(Math.min(1, Math.max(-1, c))) / r) * 3600;
  }

  const coo = (ra, dec) => `${(+ra).toFixed(6)} ${dec >= 0 ? "+" : ""}${(+dec).toFixed(6)}`;
  const CONE_COLS = "Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,Plx,e_Plx,Teff,logg,[Fe/H],RV";

  async function getJson(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  /** Bir noktanın çevresindeki Gaia kaynakları (yakından uzağa). r: yay saniyesi. */
  async function cone(ra, dec, rArcsec, top = 25) {
    if (mode === "server") {
      const j = await getJson(`api/gaia/cone?ra=${ra}&dec=${dec}&r=${rArcsec}`);
      return j.sources;
    }
    const rows = await vizier({
      "-source": T_MAIN, "-c": coo(ra, dec), "-c.rs": String(rArcsec),
      "-out": CONE_COLS, "-out.max": String(top), "-sort": "Gmag",
    });
    return rows.map(fromVizier)
      .filter((g) => g.ra != null && g.dec != null)
      .map((g) => ({ ...g, sep_arcsec: sepArcsec(ra, dec, g.ra, g.dec) }))
      .sort((a, b) => a.sep_arcsec - b.sep_arcsec);
  }

  const FIELD_COLS = "Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,Plx,e_Plx";

  /**
   * Statik barındırmada geniş alanlarda VizieR'in tüm alanı taraması uzun sürer; alan
   * büyüdükçe bir parlaklık sınırı konur (yakınlaştıkça kalkar). Dönen yıldızlar yine
   * "bu sınırdan parlak olanların en parlakları"dır.
   */
  function fieldMagLimit(rDeg) {
    if (rDeg > 1.2) return 15;
    if (rDeg > 0.6) return 17;
    if (rDeg > 0.3) return 19;
    return null;
  }

  /**
   * Görünen alandaki en parlak `n` Gaia DR3 yıldızı.
   * Dönen: { sources, gmax (konan parlaklık sınırı ya da null), complete (alandaki her şey geldi mi) }
   */
  async function field(ra, dec, rDeg, n = 3000) {
    if (mode === "server") {
      const j = await getJson(`api/gaia/field?ra=${(+ra).toFixed(5)}&dec=${(+dec).toFixed(5)}&r=${(+rDeg).toFixed(4)}&n=${n}`);
      return { sources: j.sources, gmax: null, complete: j.complete !== false && j.sources.length < n };
    }
    const gmax = fieldMagLimit(rDeg);
    const params = {
      "-source": T_MAIN, "-c": coo(ra, dec), "-c.rd": (+rDeg).toFixed(4),
      "-out": FIELD_COLS, "-out.max": String(n), "-sort": "Gmag",
    };
    if (gmax) params.Gmag = `<${gmax}`;
    const rows = await vizier(params, 45000);
    const sources = rows.map(fromVizier).filter((g) => g.ra != null && g.dec != null && g.source_id);
    return { sources, gmax, complete: !gmax && sources.length < n };
  }

  /** Bir alandaki en parlak `top` Gaia kaynağı (fotoğraf eşleştirmesi için). r: derece. */
  async function fieldBright(ra, dec, rDeg, top = 150) {
    if (mode === "server") {
      const j = await getJson(`api/gaia/field?ra=${ra}&dec=${dec}&r=${rDeg}&n=${Math.max(100, top)}`);
      return j.sources.slice(0, top);
    }
    const rows = await vizier({
      "-source": T_MAIN, "-c": coo(ra, dec), "-c.rd": (+rDeg).toFixed(4),
      "-out": CONE_COLS, "-out.max": String(top), "-sort": "Gmag",
    }, 45000);
    return rows.map(fromVizier).filter((g) => g.ra != null && g.dec != null);
  }

  /** Tek bir Gaia kaynağının tüm ölçülmüş parametreleri. ra/dec biliniyorsa sorgu hızlanır. */
  async function source(id, ra, dec) {
    if (mode === "server") return (await getJson(`api/gaia/source/${id}`)).source;
    const pos = ra != null && dec != null ? { "-c": coo(ra, dec), "-c.rs": "5" } : {};
    const q = (table) => vizier({ "-source": table, ...pos, "Source": String(id), "-out.all": "1", "-out.max": "1" });
    const [main, par] = await Promise.all([q(T_MAIN), q(T_PARAM).catch(() => [])]);
    if (!main.length) throw new Error("kaynak bulunamadı");
    // Ana tablo ve parametre tablosunda aynı adlı sütunlar (Teff, logg…) farklı şeyler
    // olabilir; ana tablonun GSP-Phot değerleri önce gelsin, parametre tablosu eksikleri doldursun.
    const a = fromVizier(main[0]);
    const b = par.length ? fromVizier(par[0]) : {};
    for (const [k, v] of Object.entries(b)) if (a[k] === undefined) a[k] = v;
    return a;
  }

  async function detect() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch("api/health", { cache: "no-store", signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) mode = "server";
      }
    } catch (_) { /* statik barındırma */ }
    return mode;
  }

  global.LichData = {
    detect, cone, field, fieldBright, source, fromVizier, parseTsv, mirrors,
    get mode() { return mode; },
  };
})(window);
