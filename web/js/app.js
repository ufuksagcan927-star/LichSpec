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

  let aladin, starCat, gaiaCat, footprintLayer;
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
      fov: 100,
      target: "05 35 17.3 -05 23 28",   // Orion
      projection: "SIN",   // küre görünümü: sürükleyerek 360° döndürülür
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
      else if (obj && obj.data && obj.data.gaia) { clickedObject = true; openGaiaStar(obj.data.gaia); }
      else if (obj && obj.data && (obj.data.Source || obj.data.source_id)) {   // HiPS kataloğundan gelen satır
        clickedObject = true;
        const g = LichData.fromVizier(obj.data);
        if (g.source_id) openGaiaStar(g);
      }
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
    aladin.on("positionChanged", () => { upd(); scheduleGaia(); });
    aladin.on("zoomChanged", () => { upd(); scheduleGaia(); });
    upd();
    initGaiaLayer();
  }

  // -------------------------------------------------------------- Gaia DR3 akışı
  // Açılışta hangi yolun çalıştığına bakılır:
  //  - "hips":  CDS'nin Gaia DR3 HiPS kataloğu. Karolar hazır sıralı geldiği için her ölçekte
  //             hızlı; yakınlaştıkça daha sönük yıldızların karoları iner.
  //  - "field": görünen alanın en parlak yıldızları tek sorguyla (sunucu varsa sunucudan, yoksa
  //             VizieR yansısından). VizieR'de geniş alan yavaş olduğu için alan sınırlı.
  const GAIA_N = 3000;            // alan sorgusunda en parlak N yıldız
  const GAIA_HIPS_MAX_FOV = 10;   // HiPS katmanı bundan geniş görünümde gizli
  let gaiaMode = null;            // "hips" | "field"; karar verilene kadar null
  let gaiaHips = null;
  let gaiaTimer = null, gaiaSeq = 0;
  const gaiaBadge = () => $("#gaia-status");

  async function initGaiaLayer() {
    let hips = false;
    try { hips = await LichData.hipsAvailable(); } catch (_) { /* yoksa alan sorgusu */ }
    if (hips) {
      gaiaHips = A.catalogHiPS(LichData.GAIA_HIPS, { name: "Gaia DR3 (1,8 milyar yıldız)", shape: drawGaiaHips, sourceSize: 8, color: "#8be9ef", onClick: null });
      aladin.addCatalog(gaiaHips);
    } else {
      gaiaCat = A.catalog({ name: "Gaia DR3 (1,8 milyar yıldız)", shape: drawGaia, sourceSize: 8, color: "#8be9ef", onClick: null });
      aladin.addCatalog(gaiaCat);
    }
    gaiaMode = hips ? "hips" : "field";
    scheduleGaia();
  }

  function scheduleGaia() {
    clearTimeout(gaiaTimer);
    if (!gaiaMode) return;   // initGaiaLayer karar verince çağırır
    gaiaTimer = setTimeout(gaiaMode === "hips" ? updateGaiaHips : loadGaiaField, 600);
  }

  function drawGaia(source, ctx) {
    const g = source.data.gaia;
    const m = g.phot_g_mean_mag ?? 18;
    const r = Math.max(1.1, Math.min(5, 4.6 - 0.22 * (m - 8)));
    ctx.beginPath();
    ctx.arc(source.x, source.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = g._c || (g._c = g.bp_rp != null ? D.bvColor(0.85 * g.bp_rp - 0.05) : "#cfe3ff");
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGaiaHips(source, ctx) {
    const d = source.data;
    if (source._g === undefined) {
      source._g = parseFloat(d.Gmag ?? d.phot_g_mean_mag);
      const c = parseFloat(d["BP-RP"] ?? d.bp_rp);
      source._c = isFinite(c) ? D.bvColor(0.85 * c - 0.05) : "#cfe3ff";
    }
    const m = isFinite(source._g) ? source._g : 18;
    const r = Math.max(1.1, Math.min(5, 4.6 - 0.22 * (m - 8)));
    ctx.beginPath();
    ctx.arc(source.x, source.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = source._c;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function updateGaiaHips() {
    const fov = aladin.getFov()[0];
    const badge = gaiaBadge();
    if (fov > GAIA_HIPS_MAX_FOV) {
      gaiaHips.hide();
      badge.textContent = `Gaia DR3'ün 1,8 milyar yıldızını görmek için ${D.fmt(GAIA_HIPS_MAX_FOV, 0)}°'nin altına yakınlaş`;
      badge.className = "gaia-status hint";
      return;
    }
    gaiaHips.show();
    const n = hipsSourcesInView();
    badge.textContent = n
      ? `Gaia DR3: bu görünümde ${n.toLocaleString("tr-TR")} yıldız yüklü · yakınlaştıkça daha sönükleri gelir`
      : "Gaia DR3 karoları yükleniyor…";
    badge.className = n ? "gaia-status ok" : "gaia-status busy";
    if (!n) { clearTimeout(gaiaTimer); gaiaTimer = setTimeout(updateGaiaHips, 1500); }
  }

  /** HiPS katmanında şu an ekranda olan yıldız sayısı (tüm gökyüzü karoları hariç). */
  function hipsSourcesInView() {
    const src = gaiaHips && gaiaHips.getSources ? gaiaHips.getSources() : [];
    const el = $("#aladin"), w = el.clientWidth, h = el.clientHeight;
    let n = 0;
    for (const s of src) {
      const p = aladin.world2pix(s.ra, s.dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= w && p[1] <= h) n++;
    }
    return n;
  }

  // Son yüklenen alan: görünüm bu dairenin içinde kaldıkça yeniden sorgulanmaz.
  let gaiaLoaded = null;   // { ra, dec, r, complete }

  async function loadGaiaField() {
    const fov = aladin.getFov();
    const badge = gaiaBadge();
    const [ra, dec] = aladin.getRaDec();
    const view = Math.max(0.005, 0.5 * Math.hypot(fov[0], fov[1]));   // görünümün yarı köşegeni
    const maxR = LichData.maxFieldRadius(ra, dec);
    if (view * 1.15 > maxR) {
      if (gaiaLoaded) { gaiaCat.removeAll(); gaiaLoaded = null; }
      gaiaSeq++;
      const need = fov[0] * maxR / (view * 1.15);
      badge.textContent = `Gaia DR3'ün 1,8 milyar yıldızını görmek için görüş alanı ${need >= 1 ? D.fmt(need, 1) + "°" : D.fmt(need * 60, 0) + "′"} olana dek yakınlaş`;
      badge.className = "gaia-status hint";
      return;
    }
    if (gaiaLoaded) {
      const inside = angSep(ra, dec, gaiaLoaded.ra, gaiaLoaded.dec) + view <= gaiaLoaded.r * 1.001;
      // içeride kaldıkça ve çok yakınlaşılmadıkça (ya da alanın hepsi zaten yüklüyse) yeniden sorgu yok
      if (inside && (gaiaLoaded.complete || view > gaiaLoaded.r / 2.2)) return;
    }
    const r = Math.min(maxR, view * 1.3);
    const seq = ++gaiaSeq;
    badge.textContent = "Gaia DR3 bu alan için sorgulanıyor…";
    badge.className = "gaia-status busy";
    try {
      const res = await LichData.field(ra, dec, r, GAIA_N);
      if (seq !== gaiaSeq) return;               // daha yeni bir istek var
      const src = res.sources;
      gaiaLoaded = { ra, dec, r, complete: res.complete };
      gaiaCat.removeAll();
      gaiaCat.addSources(src.map((g) => A.source(g.ra, g.dec, { gaia: g, name: `Gaia DR3 ${g.source_id}` })));
      const n = src.length, N = n.toLocaleString("tr-TR");
      const faint = n ? src.reduce((m, g) => Math.max(m, g.phot_g_mean_mag ?? 0), 0) : null;
      badge.textContent = res.complete
        ? `Gaia DR3: bu alandaki ${N} yıldızın hepsi`
        : `Gaia DR3: bu alanın en parlak ${N} yıldızı (G ≤ ${D.fmt(faint, 1)}) · daha sönükler için yakınlaş`;
      badge.className = "gaia-status ok";
    } catch (e) {
      if (seq !== gaiaSeq) return;
      badge.textContent = "Gaia DR3'e şu an ulaşılamıyor: " + e.message;
      badge.className = "gaia-status err";
    }
  }

  /** Gaia yıldızına tıklanınca: önce elimizdeki satırla kartı aç, sonra tüm parametreleri getir. */
  async function openGaiaStar(g) {
    showStar(gaiaToStar(g), { goto: false, pending: true });
    try {
      const full = await LichData.source(g.source_id, g.ra, g.dec);
      const cur = $("#panel-body").dataset.gaia;
      if (cur === String(g.source_id)) showStar(gaiaToStar({ ...g, ...full }), { goto: false, keepScroll: true });
    } catch (e) {
      const el = $("#gaia-detail-status");
      if (el) el.textContent = "Ayrıntılı Gaia parametreleri alınamadı: " + e.message;
    }
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
    // önce 0,1 saniyeye yuvarla, sonra böl: "60.0s" gibi taşmalar olmaz
    const t = Math.round((((ra % 360) + 360) % 360) / 15 * 36000) % (24 * 36000);
    const hh = Math.floor(t / 36000), mm = Math.floor((t % 36000) / 600), ss = (t % 600) / 10;
    return `${hh}h ${String(mm).padStart(2, "0")}m ${ss.toFixed(1).padStart(4, "0")}s`;
  }
  function dms(dec) {
    const sg = dec < 0 ? "−" : "+", t = Math.round(Math.abs(dec) * 3600);
    const d = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${sg}${d}° ${String(m).padStart(2, "0")}′ ${String(s).padStart(2, "0")}″`;
  }

  // -------------------------------------------------------------- yıldız kartı
  function showStar(s, { goto = true, pending = false, keepScroll = false } = {}) {
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
    if (s.lumf != null) fact("Işınım gücü", `${D.fmt(s.lumf, s.lumf < 10 ? 2 : 0)} L☉`, "Gaia FLAME");
    if (s.mass != null) fact("Kütle", `${D.fmt(s.mass, 2)} M☉`, "Gaia FLAME");
    if (s.age != null) fact("Yaş", `${D.fmt(s.age, 1)} milyar yıl`, "Gaia FLAME");
    if (s.rv != null) fact("Dikine hız", `${D.fmt(s.rv, 1)} km/s ${s.rv < 0 ? "(yaklaşıyor)" : "(uzaklaşıyor)"}`, "Gaia RVS");
    if (s.pmra != null && s.pmdec != null) fact("Öz hareket", `${D.fmt(Math.hypot(s.pmra, s.pmdec), 1)} mas/yıl`, "Gaia DR3");
    if (s.ruwe != null && s.ruwe > 1.4) fact("RUWE", `${D.fmt(s.ruwe, 2)} (çift yıldız olabilir)`, "Gaia DR3");

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

      ${s._origin === "gaia" ? "" : `<div class="section">
        <h3>Gaia DR3 canlı <span class="tag phob">arşiv</span></h3>
        <div id="gaia-live"><button class="btn" id="btn-gaia" type="button">Gaia DR3'ten güncel veriyi getir</button></div>
      </div>`}
    `;
    if ($("#btn-gaia")) $("#btn-gaia").onclick = () => loadGaia(s.ra, s.dec, 30, $("#gaia-live"), s);
    body.dataset.gaia = s._origin === "gaia" ? String(s.gaia) : "";
    if (pending) body.insertAdjacentHTML("afterbegin", `<p class="note" id="gaia-detail-status">Gaia DR3'ten bu yıldızın tüm ölçümleri getiriliyor…</p>`);
    if (!keepScroll) body.parentElement.scrollTop = 0;
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
      const src = await LichData.cone(ra, dec, rArcsec);
      if (!src.length) { el.innerHTML = `<p class="muted">Bu noktada Gaia DR3 kaynağı bulunamadı.</p>`; return; }
      if (star) {
        // Hipparcos konumu 1991 çağında; yüksek öz hareketli yıldızlar Gaia'da (2016) birkaç ″ kaymış olabilir.
        // 30″ içindeki en parlak kaynağı al.
        let g = src.slice().sort((a, b) => (a.phot_g_mean_mag ?? 99) - (b.phot_g_mean_mag ?? 99))[0];
        try {
          g = { ...g, ...(await LichData.source(g.source_id, g.ra, g.dec)), sep_arcsec: g.sep_arcsec };
        } catch (_) { /* alan satırıyla devam */ }
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
      el.querySelectorAll("tr.pick").forEach((tr) => tr.onclick = () => openGaiaStar(src[+tr.dataset.i]));
    } catch (e) {
      el.innerHTML = `<p class="error">Gaia sorgusu başarısız: ${esc(e.message)}</p>`;
    }
  }

  /** Gaia satırını yıldız kartı alan adlarına çevir (yalnızca var olanlar). */
  function gaiaToStar(g) {
    const s = { ra: g.ra, dec: g.dec, gaia: g.source_id, _origin: "gaia" };
    const map = {
      bp_rp: "bprp", teff_gspphot: "teff", logg_gspphot: "logg", mh_gspphot: "mh", radius_gspphot: "rad",
      teff_gspspec: "teff_s", logg_gspspec: "logg_s", mh_gspspec: "mh_s", fem_gspspec: "fem", alphafe_gspspec: "alpha",
      cafe_gspspec: "ca", mgfe_gspspec: "mg", sife_gspspec: "si", tife_gspspec: "ti", radial_velocity: "rv",
      pmra: "pmra", pmdec: "pmdec", ruwe: "ruwe", lum_flame: "lumf", mass_flame: "mass", age_flame: "age",
      phot_g_mean_mag: "g",
    };
    for (const [k, v] of Object.entries(map)) if (g[k] != null && g[k] !== "") s[v] = g[k];
    if (g.parallax != null && g.parallax_error) { s.plx = g.parallax; s.eplx = g.parallax_error; }
    if (g.spectraltype_esphs) s.sp = String(g.spectraltype_esphs).trim();
    if (g.phot_variable_flag === "VARIABLE") s.var = "1";
    // Gaia G kadiri V ile aynı değil; V alanı boş bırakılır, kart G'yi ayrıca gösterir.
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
      status.textContent = `"${f.name}" okunuyor ve koordinatları çözülüyor…`;
      try {
        const head = new Uint8Array(await f.slice(0, 6).arrayBuffer());
        const gz = head[0] === 0x1f && head[1] === 0x8b;
        const headTxt = String.fromCharCode(...head);
        if (gz || LichFits.isFits(f.name, headTxt)) {
          try {
            const j = await LichFits.solve(f, { stars: STARS, fieldBright: LichData.fieldBright });
            status.hidden = true;
            renderSolve(j);
            return;
          } catch (e) {
            if (e.code !== "NO_WCS") throw e;
            if (LichData.mode !== "server") { showNeedsSolver(true); return; }
          }
        }
        if (LichData.mode !== "server") { showNeedsSolver(false); return; }
        await solveOnServer(f);
      } catch (e) {
        status.className = "upload-status error";
        status.textContent = e.message;
      }
    }

    // Statik barındırmada JPG/PNG için koordinat çözücü yok: kullanıcıyı ücretsiz
    // Astrometry.net sitesine yönlendir; oradan inen WCS'li FITS burada anında çözülür.
    function showNeedsSolver(isFitsWithoutWcs) {
      status.className = "upload-status";
      status.innerHTML = `
        <p style="margin:0 0 6px"><b>${isFitsWithoutWcs ? "Bu FITS dosyasında gökyüzü koordinatı yok." : "JPG/PNG fotoğrafların koordinatını bulmak için yıldız deseni çözücüsü gerekiyor."}</b></p>
        <ol style="margin:0;padding-left:20px">
          <li>Fotoğrafını ücretsiz <a href="https://nova.astrometry.net/upload" target="_blank" rel="noopener">nova.astrometry.net/upload</a> sayfasına yükle (üyelik gerekmez).</li>
          <li>Çözüm bitince sonuç sayfasındaki <b>new-image.fits</b> dosyasını indir.</li>
          <li>O dosyayı buraya bırak: yıldızlar anında tanınır ve işaretlenir.</li>
        </ol>`;
    }

    async function solveOnServer(f) {
      const fd = new FormData();
      fd.append("file", f);
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
    img.src = pv.url || `data:${pv.mime};base64,${pv.data}`;
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
      else { gotoStar(it, Math.max(0.05, j.radius_deg * 1.2)); openGaiaStar(it); }
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
    await LichData.detect();
    $("#drop-hint").textContent = LichData.mode === "server"
      ? "FITS (WCS başlıklı) tarayıcında anında çözülür. JPG/PNG için Astrometry.net kullanılır; birkaç dakika sürebilir."
      : "WCS başlıklı FITS dosyaları tarayıcında anında çözülür. JPG/PNG için ücretsiz Astrometry.net'ten çözülmüş FITS'i yükleyebilirsin.";
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
    window.lichspec = { aladin, STARS, showStar, renderSolve, get gaiaMode() { return gaiaMode; }, data: LichData };
  }
  main();
})();
