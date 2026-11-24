/* LichSpec Gökyüzü — tüm gökyüzü gezgini + yıldız kartı + fotoğraftan yıldız bulma */
(function () {
  "use strict";
  const D = window.Draugr;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Gökyüzü görüntüleri: HiPS (çok çözünürlüklü karo) — tüm gökyüzü sunucudan akıtılır, siteye gömülmez.
  const SURVEYS = [
    { id: "dss", label: "DSS2 renkli (optik)", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color", cds: "CDS/P/DSS2/color" },
    { id: "mellinger", label: "Mellinger (geniş alan)", cds: "CDS/P/Mellinger/color" },
    { id: "panstarrs", label: "Pan-STARRS DR1 (derin)", cds: "CDS/P/PanSTARRS/DR1/color-z-zg-g" },
    { id: "sdss", label: "SDSS9 renkli", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/SDSS/DR9/color", cds: "CDS/P/SDSS9/color" },
    { id: "2mass", label: "2MASS (kızılötesi)", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color", cds: "CDS/P/2MASS/color" },
    { id: "wise", label: "AllWISE (orta kızılötesi)", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1", cds: "CDS/P/allWISE/color" },
  ];

  let aladin, starCat, footprintLayer;
  let STARS = [];          // nesne dizisi
  let byHip = new Map();
  let lastSolve = null;

  // -------------------------------------------------------------- katalog
  async function loadCatalog() {
    const r = await fetch("data/bright_stars.json");
    const j = await r.json();
    const cols = j.meta.cols;
    STARS = j.stars.map((row) => {
      const o = {};
      cols.forEach((c, i) => { if (row[i] !== null) o[c] = row[i]; });
      return o;
    });
    STARS.forEach((s) => byHip.set(s.hip, s));
    $("#star-count").textContent = STARS.length.toLocaleString("tr-TR");
  }

  function starRadius(v) {
    // parlak yıldız = büyük nokta
    return Math.max(1.4, Math.min(9, 5.2 - 0.62 * v));
  }

  function drawStar(source, ctx) {
    const s = source.data.star;
    const r = starRadius(s.v ?? 6.5);
    const col = s._color || (s._color = s.bv != null ? D.bvColor(s.bv) : "#ffffff");
    ctx.beginPath();
    ctx.arc(source.x, source.y, r + 2.2, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(source.x, source.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = col;
    ctx.fill();
    if (s.name && (s.v ?? 9) < 2.6) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "rgba(232,234,246,0.85)";
      ctx.fillText(s.name, source.x + r + 4, source.y + 4);
    }
  }

  // -------------------------------------------------------------- gökyüzü
  async function initSky() {
    await A.init;
    const sv = SURVEYS[0];
    aladin = A.aladin("#aladin", {
      survey: sv.url || sv.cds,
      fov: 55,
      target: "05 35 17.3 -05 23 28",   // Orion
      projection: "MOL",
      cooFrame: "ICRSd",
      showReticle: false,
      showCooGridControl: true,
      showSimbadPointerControl: true,
      showLayersControl: true,
      showFullscreenControl: false,
      showShareControl: false,
      showContextMenu: true,
      showFrame: true,
      showProjectionControl: true,
    });

    starCat = A.catalog({ name: "LichSpec parlak yıldızlar", shape: drawStar, sourceSize: 14, color: "#ffffff", onClick: null });
    aladin.addCatalog(starCat);
    starCat.addSources(STARS.map((s) => A.source(s.ra, s.dec, { star: s, name: D.title(s) })));

    footprintLayer = A.graphicOverlay({ color: "#19c9d4", lineWidth: 2, name: "Yüklenen fotoğraf" });
    aladin.addOverlay(footprintLayer);

    let clickedObject = false;
    aladin.on("objectClicked", (obj) => {
      if (obj && obj.data && obj.data.star) { clickedObject = true; showStar(obj.data.star, { goto: false }); }
    });
    aladin.on("click", (e) => {
      if (!e || e.isDragging) return;
      // nesneye tıklandıysa objectClicked ilgilenir; boş gökyüzü → en yakın yıldız / Gaia
      setTimeout(() => {
        if (clickedObject) { clickedObject = false; return; }
        if (e.ra != null && e.dec != null) showPoint(e.ra, e.dec);
      }, 0);
    });

    const status = $("#sky-status");
    const upd = () => {
      const [ra, dec] = aladin.getRaDec();
      const fov = aladin.getFov()[0];
      status.textContent = `RA ${D.fmt(ra, 3)}°  Dec ${D.fmt(dec, 3)}°  ·  görüş alanı ${fov >= 1 ? D.fmt(fov, 1) + "°" : D.fmt(fov * 60, 1) + "′"}`;
    };
    aladin.on("positionChanged", upd);
    aladin.on("zoomChanged", upd);
    upd();
  }

  function setSurvey(id) {
    const sv = SURVEYS.find((x) => x.id === id);
    if (!sv) return;
    aladin.setBaseImageLayer(aladin.newImageSurvey(sv.url || sv.cds));
  }

  function gotoStar(s, fov = 6) {
    aladin.gotoRaDec(s.ra, s.dec);
    if (aladin.getFov()[0] > fov) aladin.setFoV(fov);
  }

  // -------------------------------------------------------------- yardımcılar
  function angSep(ra1, de1, ra2, de2) {
    const r = Math.PI / 180;
    const c = Math.sin(de1 * r) * Math.sin(de2 * r) + Math.cos(de1 * r) * Math.cos(de2 * r) * Math.cos((ra1 - ra2) * r);
    return Math.acos(Math.min(1, Math.max(-1, c))) / r;
  }
  function nearestStar(ra, dec, maxDeg) {
    let best = null, bd = maxDeg;
    for (const s of STARS) {
      if (Math.abs(s.dec - dec) > bd) continue;
      const d = angSep(ra, dec, s.ra, s.dec);
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { star: best, sep: bd } : null;
  }
  function hms(ra) {
    const h = ra / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
    return `${hh}h ${String(mm).padStart(2, "0")}m ${ss.toFixed(1).padStart(4, "0")}s`;
  }
  function dms(dec) {
    const sg = dec < 0 ? "−" : "+", a = Math.abs(dec), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
    return `${sg}${d}° ${String(m).padStart(2, "0")}′ ${s.toFixed(0).padStart(2, "0")}″`;
  }

  // -------------------------------------------------------------- yıldız kartı
  function showStar(s, { goto = true } = {}) {
    if (goto) gotoStar(s);
    const d = D.derive(s);
    const body = $("#panel-body");
    const cat = s._origin === "gaia" ? "Gaia DR3" : "Hipparcos";
    const ids = s._origin === "gaia" ? [] : [s.desig && s.name ? s.desig : null, s.hip ? `HIP ${s.hip}` : null, s.hd ? `HD ${s.hd}` : null, s.gaia ? `Gaia DR3 ${s.gaia}` : null].filter(Boolean);

    const facts = [];
    const fact = (k, v, src) => facts.push(`<dt>${k}</dt><dd>${v}${src ? `<span class="src">${esc(src)}</span>` : ""}</dd>`);
    fact("Koordinat", `${hms(s.ra)} &nbsp; ${dms(s.dec)}`);
    if (s.v != null) fact("Parlaklık (V)", `${D.fmt(s.v, 2)} kadir`, "Hipparcos");
    if (s.g != null) fact("Parlaklık (G)", `${D.fmt(s.g, 2)} kadir`, "Gaia DR3");
    if (s.bprp != null) fact("Renk (BP−RP)", D.fmt(s.bprp, 2), "Gaia DR3");
    if (s.bv != null) fact("Renk (B−V)", D.fmt(s.bv, 2), "Hipparcos");
    if (d.dist_ly) fact("Uzaklık", `${D.fmtInt(d.dist_ly)} ışık yılı`, d.src.dist);
    if (s.sp) fact("Tayf türü", esc(s.sp), s._origin === "gaia" ? "Gaia ESP-HS (yalnız sınıf)" : "Hipparcos");
    if (d.teff) fact("Sıcaklık", `${d.teff_est ? "≈ " : ""}${D.fmtInt(d.teff)} K`, d.src.teff);
    if (s.logg_s ?? s.logg) fact("Yüzey çekimi", `log g = ${D.fmt(s.logg_s ?? s.logg, 2)}`, s.logg_s != null ? "Gaia RVS" : "Gaia fotometri");
    if (s.rad) fact("Yarıçap", `${D.fmt(s.rad, 2)} R☉`, "Gaia DR3");
    if (d.absmag != null) fact("Mutlak kadir", `≈ ${D.fmt(d.absmag, 2)}`, "hesaplandı");

    // Poltergeist bölümü
    const lines = (D.LINES[d.cls] || []).map(([el, desc]) => `<li><b>${esc(el)}</b><span>${esc(desc)}</span></li>`).join("");
    let comp = "";
    if (d.X != null) {
      const pct = (x) => (x * 100).toFixed(1);
      comp = `
        <div class="bar" title="Kütlece bileşim (yaklaşık)">
          <span style="width:${pct(d.X)}%;background:#7a4dff"></span>
          <span style="width:${pct(d.Y)}%;background:#19c9d4"></span>
          <span style="width:${Math.max(0.6, d.Z * 100)}%;background:#ff4f9a"></span>
        </div>
        <div class="bar-legend"><span><i style="background:#7a4dff"></i>H %${pct(d.X)}</span><span><i style="background:#19c9d4"></i>He %${pct(d.Y)}</span><span><i style="background:#ff4f9a"></i>Metaller %${(d.Z * 100).toFixed(2)}</span></div>
        <p class="note">Kütlece yüzey bileşimi, ölçülen [M/H] = ${D.fmt(d.mh, 2)} değerinden hesaplandı (${esc(d.src.mh)}; Z☉ = 0,0134, ΔY/ΔZ ≈ 1,4).</p>`;
    }
    const abund = [["[Fe/M]", s.fem], ["[α/Fe]", s.alpha], ["[Mg/Fe]", s.mg], ["[Ca/Fe]", s.ca], ["[Si/Fe]", s.si], ["[Ti/Fe]", s.ti]].filter(([, v]) => v != null);
    const abundHtml = abund.length ? `<dl class="facts" style="margin-top:10px">${abund.map(([k, v]) => `<dt>${k}</dt><dd>${D.fmt(v, 2)}<span class="src">Gaia RVS</span></dd>`).join("")}</dl>` : "";

    const glow = d.color;
    body.innerHTML = `
      <div class="star-head">
        <div class="star-dot" style="background:radial-gradient(circle at 40% 40%, #fff, ${glow} 55%, transparent 72%);--glow:${glow}88"></div>
        <div>
          <h2${D.title(s).length > 22 ? ' style="font-size:16px"' : ""}>${esc(D.title(s))}</h2>
          <div class="ids">${ids.map(esc).join(" · ")}</div>
        </div>
      </div>
      <div class="chips">
        ${d.info ? `<span class="chip">${esc(d.info.name)}${d.cls_est ? " (tahmini)" : ""}</span>` : ""}
        ${d.lum ? `<span class="chip">${esc(d.lum.name)}</span>` : ""}
        ${s.con && D.CON_TR[s.con] ? `<span class="chip">${esc(D.CON_TR[s.con])}</span>` : ""}
        ${s.var ? `<span class="chip est">değişen yıldız</span>` : ""}
      </div>

      <div class="section">
        <h3>Anlatım <span class="tag draugr">Draugr · şablon</span></h3>
        <div class="narration">${D.narrate(s, d).map((p) => `<p>${p}</p>`).join("")}</div>
      </div>

      <div class="section">
        <h3>Ölçülen veriler</h3>
        <dl class="facts">${facts.join("")}</dl>
      </div>

      <div class="section">
        <h3>Madde tahmini <span class="tag polter">Poltergeist · ön sürüm</span></h3>
        ${comp}
        ${abundHtml}
        ${lines ? `<p class="note" style="margin:10px 0 6px">${esc(d.info?.name || "")} bir yıldızın tayfında beklenen baskın çizgiler:</p><ul class="lines">${lines}</ul>` : ""}
        <p class="note">Çizgi listesi tayf sınıfından beklenen tipik imzalardır, bu yıldızın tayfından ölçülmedi. Poltergeist modeli bağlandığında burası gerçek tayf ölçümüyle dolacak.</p>
      </div>

      <div class="section">
        <h3>Gaia DR3 canlı <span class="tag phob">arşiv</span></h3>
        <div id="gaia-live"><button class="btn" id="btn-gaia" type="button">Gaia DR3'ten güncel veriyi getir</button></div>
      </div>
    `;
    $("#btn-gaia").onclick = () => loadGaia(s.ra, s.dec, 30, $("#gaia-live"), s);
    body.parentElement.scrollTop = 0;
  }

  function showPoint(ra, dec) {
    const fov = aladin.getFov()[0];
    const near = nearestStar(ra, dec, Math.max(0.05, fov / 60)); // ekranın ~1/60'ı tolerans
    if (near) { showStar(near.star, { goto: false }); return; }
    const r = Math.min(120, Math.max(3, (fov * 3600) / 150)); // tıklama toleransı (yay saniyesi)
    const body = $("#panel-body");
    body.innerHTML = `
      <h2 style="margin:0 0 4px">Seçilen nokta</h2>
      <div class="muted">${hms(ra)} &nbsp; ${dms(dec)}</div>
      <p class="muted">Burada modellenmiş parlak yıldız yok. Gaia DR3'te ${D.fmt(r, 0)}″ yarıçap içinde aranıyor…</p>
      <div id="gaia-live"></div>`;
    loadGaia(ra, dec, r, $("#gaia-live"), null);
  }

  async function loadGaia(ra, dec, rArcsec, el, star) {
    el.innerHTML = `<p class="loading">Gaia DR3 sorgulanıyor…</p>`;
    try {
      const res = await fetch(`api/gaia/cone?ra=${ra}&dec=${dec}&r=${rArcsec}`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || res.statusText);
      if (!j.sources.length) { el.innerHTML = `<p class="muted">Bu noktada Gaia DR3 kaynağı bulunamadı.</p>`; return; }
      const src = j.sources;
      if (star) {
        // Hipparcos konumu 1991 çağında; yüksek öz hareketli yıldızlar Gaia'da (2016) birkaç ″ kaymış olabilir.
        // 30″ içindeki en parlak kaynağı al.
        const g = src.slice().sort((a, b) => (a.phot_g_mean_mag ?? 99) - (b.phot_g_mean_mag ?? 99))[0];
        const rows = [];
        const f = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
        f("Kaynak", `Gaia DR3 ${esc(g.source_id)} <span class="src">${D.fmt(g.sep_arcsec, 2)}″ uzakta</span>`);
        if (g.phot_g_mean_mag != null) f("G kadir", D.fmt(g.phot_g_mean_mag, 3));
        if (g.bp_rp != null) f("BP−RP", D.fmt(g.bp_rp, 3));
        if (g.parallax != null) f("Paralaks", `${D.fmt(g.parallax, 3)} ± ${D.fmt(g.parallax_error, 3)} mas`);
        if (g.radial_velocity != null) f("Dikine hız", `${D.fmt(g.radial_velocity, 1)} km/s`);
        if (g.teff_gspphot != null) f("Teff (GSP-Phot)", `${D.fmtInt(g.teff_gspphot)} K`);
        if (g.spectraltype_esphs) f("Tayf (ESP-HS)", esc(g.spectraltype_esphs));
        el.innerHTML = `<dl class="facts">${rows.join("")}</dl>
          <p class="note">Çok parlak yıldızlar (V &lt; 3) Gaia dedektörlerini doyurur; bu yüzden bazılarında Gaia parametreleri eksik ya da güvenilmezdir.</p>`;
        return;
      }
      el.innerHTML = `
        <table class="gaia"><thead><tr><th>Gaia DR3</th><th>G</th><th>BP−RP</th><th>Teff</th><th>uzaklık</th></tr></thead>
        <tbody>${src.slice(0, 12).map((g, i) => `<tr class="pick" data-i="${i}">
          <td>…${esc(String(g.source_id).slice(-7))}</td><td>${D.fmt(g.phot_g_mean_mag, 2)}</td><td>${D.fmt(g.bp_rp, 2)}</td>
          <td>${g.teff_gspphot ? D.fmtInt(g.teff_gspphot) : "—"}</td><td>${D.fmt(g.sep_arcsec, 1)}″</td></tr>`).join("")}</tbody></table>
        <p class="note">Bir satıra tıkla: o Gaia kaynağı için yıldız kartı açılır.</p>`;
      el.querySelectorAll("tr.pick").forEach((tr) => tr.onclick = () => showStar(gaiaToStar(src[+tr.dataset.i]), { goto: false }));
    } catch (e) {
      el.innerHTML = `<p class="error">Gaia sorgusu başarısız: ${esc(e.message)}</p>`;
    }
  }

  /** Gaia satırını yıldız kartı alan adlarına çevir (yalnızca var olanlar). */
  function gaiaToStar(g) {
    const s = { ra: g.ra, dec: g.dec, gaia: g.source_id, _origin: "gaia" };
    if (g.bp_rp != null) s.bprp = g.bp_rp;
    if (g.parallax != null && g.parallax_error) { s.plx = g.parallax; s.eplx = g.parallax_error; }
    if (g.teff_gspphot != null) s.teff = g.teff_gspphot;
    if (g.logg_gspphot != null) s.logg = g.logg_gspphot;
    if (g.mh_gspphot != null) s.mh = g.mh_gspphot;
    if (g.mh_gspspec != null) s.mh_s = g.mh_gspspec;
    if (g.fem_gspspec != null) s.fem = g.fem_gspspec;
    if (g.alphafe_gspspec != null) s.alpha = g.alphafe_gspspec;
    if (g.radius_gspphot != null) s.rad = g.radius_gspphot;
    if (g.spectraltype_esphs) s.sp = g.spectraltype_esphs.trim();
    // Gaia G kadiri V ile aynı değil; kart G'yi ayrıca gösteriyor, V alanını boş bırakıyoruz.
    s.g = g.phot_g_mean_mag;
    return s;
  }

  // -------------------------------------------------------------- arama
  function initSearch() {
    const input = $("#search-input"), list = $("#search-results");
    let hits = [];
    const norm = (x) => (x || "").toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "");
    const GREEK = { alpha: "α", alfa: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω" };

    function find(q) {
      q = q.trim();
      if (!q) return [];
      const coord = q.match(/^(-?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/);
      if (coord) return [{ coord: [+coord[1], +coord[2]] }];
      const hip = q.match(/^hip\s*(\d+)$/i);
      if (hip) { const s = byHip.get(+hip[1]); return s ? [s] : []; }
      const hd = q.match(/^hd\s*(\d+)$/i);
      if (hd) return STARS.filter((s) => s.hd === +hd[1]);
      let nq = norm(q);
      for (const [k, v] of Object.entries(GREEK)) nq = nq.replace(new RegExp("^" + k + "\\b"), v);
      const out = [];
      for (const s of STARS) {
        const n = norm(s.name), dsg = norm(s.desig);
        if ((n && n.startsWith(nq)) || (dsg && dsg.startsWith(nq))) out.push(s);
        if (out.length >= 30) break;
      }
      if (out.length < 8) for (const s of STARS) {
        if (out.includes(s)) continue;
        if ((s.name && norm(s.name).includes(nq)) || (s.desig && norm(s.desig).includes(nq))) out.push(s);
        if (out.length >= 30) break;
      }
      return out.slice(0, 10);
    }
    function render() {
      if (!hits.length) { list.hidden = true; return; }
      list.innerHTML = hits.map((h, i) => h.coord
        ? `<li data-i="${i}">Koordinata git <small>${h.coord[0]}°, ${h.coord[1]}°</small></li>`
        : `<li data-i="${i}">${esc(D.title(h))}<small>${esc([h.name ? h.desig : null, "V " + D.fmt(h.v, 2)].filter(Boolean).join(" · "))}</small></li>`).join("");
      list.hidden = false;
    }
    function pick(h) {
      list.hidden = true;
      if (!h) return;
      if (h.coord) { aladin.gotoRaDec(h.coord[0], h.coord[1]); aladin.setFoV(2); showPoint(h.coord[0], h.coord[1]); }
      else showStar(h);
    }
    input.addEventListener("input", () => { hits = find(input.value); render(); });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) pick(hits[+li.dataset.i]); });
    $("#search").addEventListener("submit", (e) => { e.preventDefault(); pick(hits[0]); });
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
    document.querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => { const s = STARS.find((x) => x.name === b.dataset.goto); if (s) showStar(s); });
  }

  // -------------------------------------------------------------- fotoğraf yükleme
  function initUpload() {
    const dlg = $("#upload-dialog"), drop = $("#drop"), file = $("#file"), status = $("#upload-status");
    $("#btn-upload").onclick = () => dlg.showModal();
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    file.addEventListener("change", () => { if (file.files[0]) upload(file.files[0]); });
    $("#btn-show-on-sky").onclick = () => { dlg.close(); if (lastSolve) showSolveOnSky(lastSolve); };

    async function upload(f) {
      $("#solve-result").hidden = true;
      status.hidden = false;
      status.className = "upload-status";
      status.textContent = `"${f.name}" yükleniyor ve koordinatları çözülüyor…`;
      const fd = new FormData();
      fd.append("file", f);
      try {
        let j = await (await fetch("api/solve", { method: "POST", body: fd })).json();
        const t0 = Date.now(), lid = j.id;
        while (j.status === "queued" || j.status === "solving") {
          status.textContent = `Astrometry.net yıldız desenini eşleştiriyor… (${Math.round((Date.now() - t0) / 1000)} sn) — genelde 1–5 dk sürer.`;
          await new Promise((r) => setTimeout(r, 5000));
          j = await (await fetch(`api/solve/${lid}`)).json();
        }
        if (j.status !== "solved") throw new Error(j.error || "çözülemedi");
        status.hidden = true;
        renderSolve(j);
      } catch (e) {
        status.className = "upload-status error";
        status.textContent = e.message;
      }
    }
  }

  function solvedStarTitle(x) {
    if (x.src === "bright") return D.title(x);
    return `Gaia DR3 …${String(x.source_id).slice(-7)}`;
  }

  function renderSolve(j) {
    lastSolve = j;
    const pv = j.preview;
    const img = $("#photo"), svg = $("#photo-marks"), list = $("#solve-list");
    img.src = `data:${pv.mime};base64,${pv.data}`;
    const W = Math.round(j.width * pv.scale), H = Math.round(j.height * pv.scale);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const toPng = (x, y) => [x * pv.scale, (pv.y_flipped ? j.height - 1 - y : y) * pv.scale];

    // Parlak katalog yıldızları + Gaia'nın en parlak 40 kaynağı (parlak yıldızla çakışanlar hariç)
    const items = j.stars.map((s) => ({ ...s }));
    const gaia = j.gaia.filter((g) => !items.some((s) => Math.hypot(s.x - g.x, s.y - g.y) * j.pixscale_arcsec < 3)).slice(0, 40);
    gaia.forEach((g) => items.push(g));

    svg.innerHTML = items.map((it, i) => {
      const [px, py] = toPng(it.x, it.y);
      const mag = it.src === "bright" ? it.v : it.phot_g_mean_mag;
      const r = Math.max(5, Math.min(22, 18 - 1.1 * (mag ?? 14))) * Math.max(0.6, W / 900);
      const label = it.src === "bright" && i < 15 ? `<text x="${px + r + 3}" y="${py + 4}">${esc(D.title(it))}</text>` : "";
      return `<circle class="${it.src}" data-i="${i}" cx="${px}" cy="${py}" r="${r}"></circle>${label}`;
    }).join("");

    list.innerHTML = items.map((it, i) => {
      const mag = it.src === "bright" ? `V ${D.fmt(it.v, 2)}` : `G ${D.fmt(it.phot_g_mean_mag, 2)}`;
      const extra = it.src === "bright" ? [it.sp, it.desig && it.name ? it.desig : null].filter(Boolean).join(" · ") : [it.teff_gspphot ? `${D.fmtInt(it.teff_gspphot)} K` : null, it.spectraltype_esphs].filter(Boolean).join(" · ");
      return `<li data-i="${i}"><span>${esc(solvedStarTitle(it))}</span><span class="kind ${it.src}">${it.src === "bright" ? "LichSpec" : "Gaia"}</span><small>${mag}${extra ? " · " + esc(extra) : ""}</small></li>`;
    }).join("") || `<li><small>Görüntü alanında tanınan yıldız yok.</small></li>`;

    const select = (i) => {
      svg.querySelectorAll("circle").forEach((c) => c.classList.toggle("active", +c.dataset.i === i));
      list.querySelectorAll("li").forEach((l) => l.classList.toggle("active", +l.dataset.i === i));
      const it = items[i];
      $("#upload-dialog").close();
      showSolveOnSky(j, false);
      if (it.src === "bright") showStar(byHip.get(it.hip) || it);
      else { const s = gaiaToStar(it); gotoStar(s, Math.max(0.05, j.radius_deg * 1.2)); showStar(s, { goto: false }); }
    };
    svg.querySelectorAll("circle").forEach((c) => c.onclick = () => select(+c.dataset.i));
    list.querySelectorAll("li[data-i]").forEach((l) => l.onclick = () => select(+l.dataset.i));

    const fovTxt = j.radius_deg * 2 >= 1 ? `${D.fmt(j.radius_deg * 2, 2)}°` : `${D.fmt(j.radius_deg * 120, 1)}′`;
    $("#solve-meta").innerHTML = `
      <span>Merkez <b>${hms(j.center.ra)} ${dms(j.center.dec)}</b></span>
      <span>Alan çapı <b>${fovTxt}</b></span>
      <span>Ölçek <b>${D.fmt(j.pixscale_arcsec, 3)}″/piksel</b></span>
      <span>Tanınan: <b>${j.stars.length}</b> parlak yıldız, <b>${j.gaia.length}</b> Gaia kaynağı</span>
      <span>Çözüm: <b>${j.source === "fits-wcs" ? "FITS başlığındaki WCS" : "Astrometry.net"}</b></span>
      ${j.gaia_error ? `<span class="error">${esc(j.gaia_error)}</span>` : ""}`;
    $("#solve-result").hidden = false;
  }

  function showSolveOnSky(j, setView = true) {
    footprintLayer.removeAll();
    footprintLayer.add(A.polygon(j.corners.map(([a, b]) => [a, b])));
    if (setView) {
      aladin.gotoRaDec(j.center.ra, j.center.dec);
      aladin.setFoV(Math.max(0.05, j.radius_deg * 3));
      const near = j.stars[0];
      if (near) showStar(byHip.get(near.hip) || near, { goto: false });
    }
  }

  // -------------------------------------------------------------- başlat
  async function main() {
    const sel = $("#survey");
    sel.innerHTML = SURVEYS.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("");
    initUpload();
    try {
      await loadCatalog();
    } catch (e) {
      $("#sky-status").textContent = "Yıldız kataloğu yüklenemedi: " + e.message;
      return;
    }
    initSearch();
    const ready = await new Promise((res) => {
      if (window.A) return res(true);
      window.addEventListener("aladin-ready", () => res(true), { once: true });
      setTimeout(() => res(!!window.A), 20000);
    });
    if (!ready) {
      $("#sky-status").textContent = "Aladin Lite yüklenemedi (internet bağlantısını kontrol et).";
      return;
    }
    try {
      await initSky();
    } catch (e) {
      $("#sky-status").textContent = "Gökyüzü başlatılamadı: " + e;
      return;
    }
    sel.onchange = () => setSurvey(sel.value);
    $("#toggle-stars").onchange = (e) => (e.target.checked ? starCat.show() : starCat.hide());
    window.lichspec = { aladin, STARS, showStar, renderSolve };
  }
  main();
})();
