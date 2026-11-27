/* LichSpec Gökyüzü — tüm gökyüzü gezgini + yıldız kartı + fotoğraftan yıldız bulma */
(function () {
  "use strict";
  const D = window.Draugr;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Gökyüzü görüntüleri: HiPS (çok çözünürlüklü karo) — sunucudan akıtılır, siteye gömülmez.
  // Geniş bakışta Mellinger'in tüm gökyüzü fotoğrafı (Samanyolu gözle görüldüğü gibi); yakınlaştıkça
  // DSS2 renkli plaka taramaları yavaşça üstüne biner. Seçenek yok: tek, gerçekçi bir görünüm.
  const WIDE_HIPS = "https://alasky.cds.unistra.fr/MellingerRGB";
  const DETAIL_HIPS = "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color";
  const DETAIL_FROM = 40, DETAIL_FULL = 12;   // görüş alanı (derece): DSS2 bu aralıkta belirir

  let aladin, starCat, gaiaCat, footprintLayer, sky;
  let STARS = [];          // nesne dizisi
  let CONS = null;         // takımyıldız çizgileri ve ad konumları
  let byHip = new Map();
  let lastSolve = null;
  let magLimit = 6;        // görüş alanına göre çizilen en sönük yıldız
  let selected = null;     // kartı açık yıldız: gökyüzünde halkayla gösterilir

  // -------------------------------------------------------------- katalog
  async function loadCatalog() {
    const r = await fetch("data/bright_stars.json");
    const j = await r.json();
    const objects = (cols, rows, base) => rows.map((row) => {
      const o = { ...base };
      cols.forEach((c, i) => { if (row[i] !== null) o[c] = row[i]; });
      return o;
    });
    // Hipparcos satırları + Hipparcos'ta olmayan ünlü yıldızlar (Wolf 359, TRAPPIST-1…: doğrudan Gaia DR3)
    STARS = objects(j.meta.cols, j.stars, {}).concat(objects(j.meta.extra_cols || [], j.extra || [], { _origin: "gaia" }));
    STARS.forEach((s) => { D.cleanSpec(s); if (s.hip) byHip.set(s.hip, s); });
    // Adı yazılan parlak yıldızlardan biri daha parlak bir komşusunun dibindeyse (α Cen A/B) adı yazılmaz
    const labelled = STARS.filter((s) => s.name && s.v < 2.6).sort((a, b) => a.v - b.v);
    labelled.forEach((s, i) => { if (labelled.slice(0, i).some((b) => angSep(s.ra, s.dec, b.ra, b.dec) < 0.05)) s._nolabel = true; });
    $("#star-count").textContent = STARS.length.toLocaleString("tr-TR");
  }

  async function loadConstellations() {
    const r = await fetch("data/constellations.json");
    CONS = await r.json();
  }

  function starRadius(v) {
    // parlak yıldız = büyük nokta
    return Math.max(1.4, Math.min(9, 5.2 - 0.62 * v));
  }

  /** Geniş bakışta yalnızca gözle görülebilecek kadar parlak yıldızlar; yakınlaştıkça hepsi
   * (kataloğun sönük yıldızları adı olanlar: Proxima Centauri, Barnard Yıldızı…). */
  function updateMagLimit(fov) {
    magLimit = fov > 100 ? 5.0 : fov > 60 ? 5.6 : fov > 25 ? 6.3 : fov > 8 ? 9 : 99;
  }

  function drawStar(source, ctx) {
    const s = source.data.star;
    const mag = s.v ?? s.g ?? 6.5;   // Gaia'dan gelenlerde V yok, G var
    if (mag > magLimit && s !== selected) return;
    const r = starRadius(mag);
    if (s === selected) {
      ctx.beginPath();
      ctx.arc(source.x, source.y, r + 7, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(25, 201, 212, 0.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const col = s._color || (s._color = s.bv != null ? D.bvColor(s.bv) : "#ffffff");
    ctx.beginPath();
    ctx.arc(source.x, source.y, r + 2.2, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(source.x, source.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = col;
    ctx.fill();
    if (s.name && (s.v ?? 9) < 2.6 && !s._nolabel) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "rgba(232,234,246,0.85)";
      ctx.fillText(s.name, source.x + r + 4, source.y + 4);
    }
  }

  // -------------------------------------------------------------- gökyüzü
  /**
   * En geniş görüş alanı (derece), ekranın uzun kenarı boyunca. Gnomonik izdüşümde kenarlar açı
   * büyüdükçe gerilir (120°'de kenarda 4 kat), daha genişi balık gözü gibi durur. Aladin 3.9 görüş
   * alanını genişlik boyunca tutar; LichSky.fovFor uzun kenar açısını ona çevirir.
   */
  const MAX_FOV = 120;
  const boxFov = (deg) => { const b = $("#aladin"); return LichSky.fovFor(deg, b.clientWidth, b.clientHeight); };
  /** Ekranın uzun kenarının gördüğü açı: durum satırında "görüş alanı" ve eşiklerde kullanılan. */
  const longFov = () => (sky ? sky.longFov() : aladin.getFov()[0]);

  /** Yerin örtücülüğü (0–1): kaydedilmiş tercih, yoksa %30. */
  const GROUND_DEFAULT = 0.3;
  function savedGround() {
    try {
      const v = localStorage.getItem("lichspec.ground");
      if (v != null && v !== "" && isFinite(+v)) return Math.max(0, Math.min(1, +v));
    } catch (_) { /* gizli pencere */ }
    return GROUND_DEFAULT;
  }
  function setGround(alpha, remember = true) {
    sky.setGround(alpha);
    $("#ground-alpha").value = Math.round(sky.groundAlpha * 100);
    if (remember) try { localStorage.setItem("lichspec.ground", String(sky.groundAlpha)); } catch (_) { /* gizli pencere */ }
  }

  /**
   * Aladin 3.9 gnomonik izdüşümde, köşelerinden biri bakış merkezinden 90°'den uzakta kalan bir çokgeni
   * (yüklenen fotoğrafın çerçevesi gibi) çizerken hata verip çizim döngüsünü durduruyor. Böyle bir
   * çokgen o an çizilmez, gökyüzü donmaz.
   */
  function guardPolygons() {
    try {
      const proto = Object.getPrototypeOf(A.polygon([[0, 0], [1, 0], [1, 1]]));
      if (!proto || proto.lichGuard || typeof proto.draw !== "function") return;
      const draw = proto.draw;
      proto.draw = function (ctx, ...rest) {
        try { return draw.call(this, ctx, ...rest); } catch (_) { ctx.beginPath(); return false; }
      };
      proto.lichGuard = true;
    } catch (_) { /* başka bir Aladin sürümü */ }
  }

  async function initSky() {
    await A.init;
    // Açılışta gözlemcinin yerinden güneye, ufkun 35° üstüne bakılır.
    const place = LichSky.defaultPlace();
    const start = LichSky.hor2eq(35, 180, LichSky.lst(new Date(), place.lon), place.lat);
    const box = $("#aladin");
    const long0 = box.clientHeight > box.clientWidth ? 80 : 90;   // uzun kenar boyunca; dik telefonda dikey
    const fov0 = boxFov(long0);
    aladin = A.aladin("#aladin", {
      survey: WIDE_HIPS,
      fov: fov0,
      target: `${start.ra.toFixed(4)} ${start.dec >= 0 ? "+" : ""}${start.dec.toFixed(4)}`,
      // Gnomonik (TAN) izdüşüm: fotoğraf makinesinin vizöründen bakar gibi, düz çizgiler düz, ufuk
      // düz bir çizgi. Küre kenarı hiç görünmez; seçenek düğmesi yok.
      projection: "TAN",
      cooFrame: "ICRSd",
      showReticle: false,
      showCooGridControl: false,
      showSimbadPointerControl: false,
      showLayersControl: false,
      showFullscreenControl: false,
      showShareControl: false,
      showContextMenu: false,
      showFrame: false,
      showCooLocation: false,
      showProjectionControl: false,
      showSettingsControl: false,
      showStatusBar: false,
      showZoomControl: false,             // yakınlaşma tekerlek ve iki parmakla; görüş alanı durum satırında
      showFov: false,
      backgroundColor: "rgb(5, 7, 16)",   // karo gelmeyen yer gri değil, gece karası
    });
    aladin.setFoVRange(0.002, boxFov(MAX_FOV));
    updateMagLimit(long0);
    guardPolygons();
    // Aladin 3.9 tuvalini önce pencere boyunda kurar, az sonra kutuya oturturken ölçeği korur ve görüş
    // alanı daralır: ilk yeniden boyutlanmadan sonra başlangıç görüş alanı yeniden verilir. Kutunun
    // biçimi değişince (telefonu çevirmek) en geniş görüş alanı da yeniden hesaplanır.
    let firstResize = true;
    const fitBox = () => {
      const max = boxFov(MAX_FOV);
      aladin.setFoVRange(0.002, max);
      if (firstResize) { firstResize = false; aladin.setFoV(fov0); }
      else if (aladin.getFov()[0] > max + 0.01) aladin.setFoV(max);
      if (sky) sky.redraw();
    };
    aladin.on("resizeChanged", () => setTimeout(fitBox, 50));
    setTimeout(() => { if (firstResize) fitBox(); }, 800);
    // Mellinger CDS'den gelir; CDS'ye ulaşılamazsa geniş bakışta da DSS2 (IRSA) kullanılır.
    reachable(WIDE_HIPS + "/properties", 7000).then((ok) => {
      if (ok) return;
      wideFailed = true;
      if (detailOn) { aladin.removeImageLayer("detail"); detailOn = false; }
      aladin.setBaseImageLayer(DETAIL_HIPS);
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
        if (e.ra == null || e.dec == null) return;
        if (!pickDeep(e.ra, e.dec)) showPoint(e.ra, e.dec);
      }, 0);
    });

    // Ufuk, yer, yönler, takımyıldızlar
    sky = LichSky.create(aladin, $("#aladin"), CONS, D.CON_TR, { onChange: updateStatus, groundAlpha: savedGround() });
    sky.addLayer(LichDeep.layer);                 // galaksiler, bulutsular, kümeler, kara delikler, pulsarlar
    moveAladinLogo();

    aladin.on("positionChanged", () => scheduleGaia());
    aladin.on("zoomChanged", () => { updateImagery(); scheduleGaia(); });
    updateImagery();
    updatePlace();
    setInterval(updatePlace, 30000);
    initGaiaLayer();
  }

  /** Durum satırı: ufuk açıkken nereye baktığın, kapalıyken gök koordinatı. */
  function updateStatus(v) {
    const fovTxt = v.fov >= 1 ? D.fmt(v.fov, v.fov >= 10 ? 0 : 1) + "°" : D.fmt(v.fov * 60, 1) + "′";
    $("#sky-status").textContent = sky && sky.horizon
      ? `${cap(v.dir)} yönüne, ufkun ${D.fmt(Math.abs(v.alt), 0)}° ${v.alt >= 0 ? "üstüne" : "altına"} bakıyorsun · görüş alanı ${fovTxt}`
      : `RA ${D.fmt(v.ra, 2)}°  Dec ${D.fmt(v.dec, 2)}° · görüş alanı ${fovTxt}`;
  }
  const cap = (t) => t.charAt(0).toLocaleUpperCase("tr-TR") + t.slice(1);

  function updatePlace() {
    if (!sky) return;
    const p = sky.place;
    const t = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    $("#place-name").textContent = p.name;
    $("#place-time").textContent = t;
  }

  async function reachable(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return (await fetch(url, { signal: ctl.signal })).ok; } catch (_) { return false; } finally { clearTimeout(t); }
  }

  /** Yakınlaştıkça DSS2 ayrıntı katmanını görünür yap; geniş bakışta karolarını hiç indirme. */
  let detailOn = false, wideFailed = false;
  function updateImagery() {
    const fov = aladin.getFov()[0];
    updateMagLimit(longFov());
    if (wideFailed) return;   // taban zaten DSS2
    const op = fov >= DETAIL_FROM ? 0 : fov <= DETAIL_FULL ? 1 : (DETAIL_FROM - fov) / (DETAIL_FROM - DETAIL_FULL);
    if (op > 0 && !detailOn) { aladin.setOverlayImageLayer(DETAIL_HIPS, "detail"); detailOn = true; }
    if (detailOn && fov > DETAIL_FROM + 5) { aladin.removeImageLayer("detail"); detailOn = false; return; }
    if (detailOn) {
      const l = aladin.getOverlayImageLayer("detail");
      if (l && l.setOpacity) l.setOpacity(op);
    }
  }

  /** Aladin Lite logosu gökyüzünün köşesinden kaynak notunun yanına taşınır (bağlantısıyla birlikte). */
  function moveAladinLogo() {
    const logo = document.querySelector("#aladin .aladin-logo-container");
    const slot = $("#aladin-logo-slot");
    if (!logo || !slot) return;
    slot.appendChild(logo);
    // Aladin boyut sınıfını yalnızca kendi kutusundaki logoya verir; burada büyük logo sabit kalsın.
    const l = logo.querySelector(".aladin-logo");
    if (l) { l.classList.remove("aladin-logo-small"); l.classList.add("aladin-logo-large"); }
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
    const fov = longFov();
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
    badge.textContent = LichData.mode === "server"
      ? "Gaia DR3 bu alan için sorgulanıyor…"
      : "Gaia DR3 bu alan için sorgulanıyor… (10–20 sn sürebilir)";
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

  function gotoStar(s, fov = 6) {
    const note = belowHorizon(s.ra, s.dec);
    aladin.gotoRaDec(s.ra, s.dec);
    if (aladin.getFov()[0] > fov) aladin.setFoV(fov);
    return note;
  }

  /**
   * Gidilen yer şu an ufkun altındaysa yer açık kalır, altındaki gökyüzü yerin içinden görünür; yer
   * neredeyse opaksa yarı saydama indirilir. Dönüş: kartta gösterilecek not (ufkun üstündeyse boş).
   */
  function belowHorizon(ra, dec) {
    if (!sky || !sky.horizon) return "";
    const alt = sky.altaz(ra, dec).alt;
    if (alt >= 0) return "";
    const lowered = sky.groundAlpha > 0.6;
    if (lowered) setGround(GROUND_DEFAULT, false);
    const lat = sky.place.lat;
    const never = 90 - Math.abs(lat - dec) < 0;                     // en yükseğe çıktığında bile ufkun altında
    return `<p class="note horizon-note">Şu an ufkun ${D.fmt(-alt, 0)}° altında, onu yerin içinden görüyorsun${lowered ? " (yer yarı saydama alındı)" : ""}.`
      + (never ? ` Bulunduğun enlemden (${D.fmt(Math.abs(lat), 0)}° ${lat >= 0 ? "K" : "G"}) hiç doğmaz.` : "") + `</p>`;
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

  /** Gaia RVS tayfı değerleri neden kullanılmadı (Draugr.cleanSpec). */
  function specSkipNote({ why, teff, logg }) {
    const val = `${D.fmtInt(teff)} K${logg != null ? ` ve log g ${D.fmt(logg, 2)}` : ""}`;
    return why === "fixed"
      ? `Gaia RVS tayfının verdiği ${val} kullanılmadı: bu, Gaia'nın soğuk K ve M yıldızlarına koyduğu ortak sabit değer, ölçüm değil.`
      : `Gaia RVS tayfının verdiği ${val} kullanılmadı: 3.500 K ve altında Gaia'nın tayf modeli güvenilir aralığının dışında kalıyor (kırmızı cücelerde yüzey çekimini ve metal bolluğunu çoğu zaman çok düşük buluyor).`;
  }

  // -------------------------------------------------------------- yıldız kartı
  function showStar(s, { goto = true, pending = false, keepScroll = false } = {}) {
    select(s);
    const hid = goto ? gotoStar(s) : "";
    const d = D.derive(s);
    const body = $("#panel-body");
    const ids = (s._origin === "gaia"
      ? [s.name && s.gaia ? `Gaia DR3 ${s.gaia}` : null]
      : [s.desig && s.name ? s.desig : null, s.hip ? `HIP ${s.hip}` : null, s.hd ? `HD ${s.hd}` : null, s.gaia ? `Gaia DR3 ${s.gaia}` : null]).filter(Boolean);
    // diğer adları: Türkçe ad, yaygın adlar, Gliese / değişen yıldız adları
    const aka = [s.tr, ...(s.alias || [])].filter((x) => x && x !== s.name && x !== s.desig).slice(0, 6);

    const facts = [];
    const fact = (k, v, src) => facts.push(`<dt>${k}</dt><dd>${v}${src ? `<span class="src">${esc(src)}</span>` : ""}</dd>`);
    if (sky) {
      const h = sky.altaz(s.ra, s.dec);
      fact(`Şu an (${esc(sky.place.name)})`, h.alt > 0
        ? `ufkun ${D.fmt(h.alt, 0)}° üstünde, ${sky.dirName(h.az)} yönünde`
        : `ufkun altında, şu an görünmüyor`, "hesaplandı");
    }
    fact("Koordinat", `${hms(s.ra)} &nbsp; ${dms(s.dec)}`);
    if (s.v != null) fact("Parlaklık (V)", `${D.fmt(s.v, 2)} kadir`, "Hipparcos");
    if (s.g != null) fact("Parlaklık (G)", `${D.fmt(s.g, 2)} kadir`, "Gaia DR3");
    if (s.bprp != null) fact("Renk (BP−RP)", D.fmt(s.bprp, 2), "Gaia DR3");
    if (s.bv != null) fact("Renk (B−V)", D.fmt(s.bv, 2), "Hipparcos");
    if (d.dist_ly) fact("Uzaklık", `${D.fmtDist(d.dist_ly)} ışık yılı`, d.src.dist);
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
          ${aka.length ? `<div class="aka">${aka.map(esc).join(" · ")}</div>` : ""}
          <div class="ids">${ids.map(esc).join(" · ")}</div>
        </div>
      </div>
      ${hid}
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
        ${s._spec_skip ? `<p class="note">${specSkipNote(s._spec_skip)}</p>` : ""}
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

  // -------------------------------------------------------------- derin gök kartı
  /**
   * Tıklanan yerde bir derin gök simgesi varsa kartını aç. Simgenin tam üstüne (10 piksel) tıklanmadıysa ve
   * yakında görünen parlak bir yıldız varsa yıldız öncelikli: büyük bir kümenin ya da bulutsunun içindeki
   * yıldızlar seçilebilsin.
   */
  function pickDeep(ra, dec) {
    if (!LichDeep.ready || !LichDeep.on) return false;
    const p = aladin.world2pix(ra, dec);
    if (!p) return false;
    const h = LichDeep.hit(p[0], p[1]);
    if (!h) return false;
    if (h.dist > 10) {
      const near = nearestStar(ra, dec, Math.max(0.05, aladin.getFov()[0] / 60));
      if (near && (near.star.v ?? near.star.g ?? 99) <= magLimit) return false;
    }
    showDeep(h.obj, { goto: false });
    return true;
  }

  function gotoDeep(o) {
    const note = belowHorizon(o.ra, o.dec);
    aladin.gotoRaDec(o.ra, o.dec);
    // galaksi ya da bulutsu ekranın ~üçte birini kaplasın; noktasal cisimlerde 3°
    const want = o.kind === "dso" ? (o.a ? Math.max(0.25, Math.min(90, (o.a / 60) * 3)) : 1.5) : 3;
    const now = longFov();
    if (now > want * 1.05 || now < want / 4) aladin.setFoV(boxFov(want));
    return note;
  }

  function showDeep(o, { goto = true } = {}) {
    select(null);
    LichDeep.select(o);
    if (sky) sky.redraw();
    const hid = goto ? gotoDeep(o) : "";
    const c = LichDeep.card(o);
    const facts = [];
    const fact = (k, v, src) => facts.push(`<dt>${k}</dt><dd>${v}${src ? `<span class="src">${esc(src)}</span>` : ""}</dd>`);
    if (sky) {
      const h = sky.altaz(o.ra, o.dec);
      fact(`Şu an (${esc(sky.place.name)})`, h.alt > 0 ? `ufkun ${D.fmt(h.alt, 0)}° üstünde, ${sky.dirName(h.az)} yönünde` : "ufkun altında, şu an görünmüyor", "hesaplandı");
    }
    fact("Koordinat", `${hms(o.ra)} &nbsp; ${dms(o.dec)}`);
    for (const [k, v, src] of c.facts) fact(esc(k), v, src);
    const narr = o.kind === "dso" ? D.narrateDeep(o, c) : D.narrateCompact(o, c);
    const body = $("#panel-body");
    body.innerHTML = `
      <div class="star-head">
        <canvas class="deep-icon" width="92" height="92" aria-hidden="true"></canvas>
        <div>
          <h2${c.title.length > 22 ? ' style="font-size:16px"' : ""}>${esc(c.title)}</h2>
          ${c.aka.length ? `<div class="aka">${c.aka.map(esc).join(" · ")}</div>` : ""}
          ${c.ids.length ? `<div class="ids">${c.ids.slice(0, 8).map(esc).join(" · ")}</div>` : ""}
        </div>
      </div>
      ${hid}
      <div class="chips">
        ${c.chips.map((x) => `<span class="chip${x === "aday" ? " est" : ""}">${esc(x)}</span>`).join("")}
        ${o.con && D.CON_TR[o.con] ? `<span class="chip">${esc(D.CON_TR[o.con])}</span>` : ""}
      </div>
      <div class="section">
        <h3>Anlatım <span class="tag draugr">Draugr · şablon</span></h3>
        <div class="narration">${narr.map((p) => `<p>${p}</p>`).join("")}</div>
      </div>
      <div class="section">
        <h3>Ölçülen veriler</h3>
        <dl class="facts">${facts.join("")}</dl>
      </div>
      <div class="section">
        <h3>Kaynaklar</h3>
        <ul class="sources">${LichDeep.sources(o).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>`;
    LichDeep.drawIcon($(".deep-icon", body), o);
    body.querySelectorAll("[data-deep]").forEach((a) => a.onclick = (e) => { e.preventDefault(); const h = LichDeep.byId(a.dataset.deep); if (h) showDeep(h); });
    body.parentElement.scrollTop = 0;
  }

  function showPoint(ra, dec) {
    if (LichDeep.selected) { LichDeep.select(null); if (sky) sky.redraw(); }
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
      let g = null;
      if (star && star.gaia) {
        // Hipparcos–Gaia DR3 eşleşmesi katalogda var: kaynak doğrudan kimliğiyle alınır. Kimliğin taşıdığı
        // konumun (~2000) çevresinde aranır; yarıçap hücre payı (60″) artı yıldızın 1991'den o konuma
        // kaymasının iki katı, çünkü öz hareketi büyük yıldızlar 2016'ya kadar yine kayar (Barnard Yıldızı:
        // 1991'den 2016'ya 4,3′). 10′'lik sabit bir daire VizieR'de yarım dakikayı aşabiliyordu.
        try {
          const [ira, idec] = LichData.idPosition(star.gaia);
          const r = Math.min(600, 60 + 2 * angSep(ra, dec, ira, idec) * 3600);
          g = await LichData.source(star.gaia, ira, idec, Math.round(r));
          g.sep_arcsec = angSep(ra, dec, g.ra, g.dec) * 3600;
          g.matched = true;
        } catch (e) {
          // Ağ hatasında yanındaki başka bir yıldızı göstermektense hata yazılır; kimlik orada yoksa en parlak komşuya bakılır.
          if (!/bulunamadı/.test(e.message)) throw e;
          g = null;
        }
      }
      if (!g) {
        const src = await LichData.cone(ra, dec, rArcsec);
        if (!src.length) { el.innerHTML = `<p class="muted">Bu noktada Gaia DR3 kaynağı bulunamadı.</p>`; return; }
        if (!star) { renderGaiaList(src, el); return; }
        // eşleşme yoksa 30″ içindeki en parlak kaynak
        g = src.slice().sort((a, b) => (a.phot_g_mean_mag ?? 99) - (b.phot_g_mean_mag ?? 99))[0];
        try {
          g = { ...g, ...(await LichData.source(g.source_id, g.ra, g.dec)), sep_arcsec: g.sep_arcsec };
        } catch (_) { /* alan satırıyla devam */ }
      }
      const rows = [];
      const f = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
      f("Kaynak", `Gaia DR3 ${esc(g.source_id)} <span class="src">${g.matched
        ? `Hipparcos eşleşmesi${g.sep_arcsec > 3 ? `, 1991'den 2016'ya ${g.sep_arcsec >= 120 ? D.fmt(g.sep_arcsec / 60, 1) + "′" : D.fmt(g.sep_arcsec, 0) + "″"} kaymış` : ""}`
        : `${D.fmt(g.sep_arcsec, 2)}″ uzakta`}</span>`);
      if (g.phot_g_mean_mag != null) f("G kadir", D.fmt(g.phot_g_mean_mag, 3));
      if (g.bp_rp != null) f("BP−RP", D.fmt(g.bp_rp, 3));
      if (g.parallax != null) f("Paralaks", `${D.fmt(g.parallax, 3)} ± ${D.fmt(g.parallax_error, 3)} mas`);
      if (g.radial_velocity != null) f("Dikine hız", `${D.fmt(g.radial_velocity, 1)} km/s`);
      if (g.teff_gspphot != null) f("Teff (GSP-Phot)", `${D.fmtInt(g.teff_gspphot)} K`);
      if (g.spectraltype_esphs) f("Tayf (ESP-HS)", esc(g.spectraltype_esphs));
      el.innerHTML = `<dl class="facts">${rows.join("")}</dl>
        <p class="note">Çok parlak yıldızlar (V &lt; 3) Gaia dedektörlerini doyurur; bu yüzden bazılarında Gaia parametreleri eksik ya da güvenilmezdir.</p>`;
    } catch (e) {
      el.innerHTML = `<p class="error">Gaia sorgusu başarısız: ${esc(e.message)}</p>`;
    }
  }

  /** Bir noktanın çevresindeki Gaia kaynakları: tıklanabilir tablo. */
  function renderGaiaList(src, el) {
    el.innerHTML = `
      <table class="gaia"><thead><tr><th>Gaia DR3</th><th>G</th><th>BP−RP</th><th>Teff</th><th>uzaklık</th></tr></thead>
      <tbody>${src.slice(0, 12).map((g, i) => `<tr class="pick" data-i="${i}">
        <td>…${esc(String(g.source_id).slice(-7))}</td><td>${D.fmt(g.phot_g_mean_mag, 2)}</td><td>${D.fmt(g.bp_rp, 2)}</td>
        <td>${g.teff_gspphot ? D.fmtInt(g.teff_gspphot) : "—"}</td><td>${D.fmt(g.sep_arcsec, 1)}″</td></tr>`).join("")}</tbody></table>
      <p class="note">Bir satıra tıkla: o Gaia kaynağı için yıldız kartı açılır.</p>`;
    el.querySelectorAll("tr.pick").forEach((tr) => tr.onclick = () => openGaiaStar(src[+tr.dataset.i]));
  }

  /** Gaia satırını yıldız kartı alan adlarına çevir (yalnızca var olanlar). */
  function gaiaToStar(g) {
    // Dışarıdan gelen metin alanları sayfaya HTML olarak girer: yalnızca beklenen karakterler kalsın.
    const s = { ra: g.ra, dec: g.dec, gaia: String(g.source_id ?? "").replace(/\D/g, ""), _origin: "gaia" };
    const map = {
      bp_rp: "bprp", teff_gspphot: "teff", logg_gspphot: "logg", mh_gspphot: "mh", radius_gspphot: "rad",
      teff_gspspec: "teff_s", logg_gspspec: "logg_s", mh_gspspec: "mh_s", fem_gspspec: "fem", alphafe_gspspec: "alpha",
      cafe_gspspec: "ca", mgfe_gspspec: "mg", sife_gspspec: "si", tife_gspspec: "ti", radial_velocity: "rv",
      pmra: "pmra", pmdec: "pmdec", ruwe: "ruwe", lum_flame: "lumf", mass_flame: "mass", age_flame: "age",
      phot_g_mean_mag: "g",
    };
    for (const [k, v] of Object.entries(map)) if (g[k] != null && g[k] !== "") s[v] = g[k];
    if (g.parallax != null && g.parallax_error) { s.plx = g.parallax; s.eplx = g.parallax_error; }
    if (g.spectraltype_esphs) s.sp = String(g.spectraltype_esphs).replace(/[^A-Za-z0-9 +\-./]/g, "").trim();
    if (g.phot_variable_flag === "VARIABLE") s.var = "1";
    // Gaia G kadiri V ile aynı değil; V alanı boş bırakılır, kart G'yi ayrıca gösterir.
    return D.cleanSpec(s);
  }

  // -------------------------------------------------------------- arama
  /**
   * Aranabilen her şey: adı ya da Bayer/Flamsteed adı olan yıldızlar (Türkçe ad, eş adlar,
   * "α Cen" → "Alpha Centauri" / "Alfa Erboğa") ve takımyıldızlar (Türkçe, Latince, tamlayan, kısaltma).
   */
  function searchItems() {
    const CN = (CONS && CONS.names) || {};
    // "Proxima Centauri" → "Proxima Erboğa", "VY Canis Majoris" → "VY Büyük Köpek"
    const gens = Object.entries(CN).filter(([abbr]) => D.CON_TR[abbr]).map(([abbr, n]) => [" " + n[1], D.CON_TR[abbr]]);
    const turkish = (k) => { for (const [g, tr] of gens) if (k.endsWith(g)) return k.slice(0, -g.length) + " " + tr; return null; };
    const items = [];
    for (const s of STARS) {
      const keys = [s.name, s.tr, ...(s.alias || [])];
      keys.push(...keys.filter(Boolean).map(turkish));
      const m = s.desig && s.desig.match(/^(.+?)\s+([A-Za-z]{2,3})$/);
      if (s.desig) keys.push(s.desig);
      if (m && CN[m[2]]) keys.push(`${m[1]} ${CN[m[2]][1]}`);
      if (m && D.CON_TR[m[2]]) keys.push(`${m[1]} ${D.CON_TR[m[2]]}`);
      if (!keys.some(Boolean)) continue;
      // eşit eşleşmede önce adı olan, sonra parlak yıldız
      items.push({ kind: "star", star: s, keys: keys.filter(Boolean), rank: (s.name ? 12 : 0) - Math.min(14, s.v ?? s.g ?? 14) });
    }
    const seen = new Set();
    for (const [abbr, ra, dec] of (CONS && CONS.labels) || []) {
      if (seen.has(abbr)) continue;
      seen.add(abbr);
      const n = CN[abbr] || [];
      items.push({ kind: "con", abbr, ra, dec, keys: [D.CON_TR[abbr], n[0], n[1], abbr].filter(Boolean), rank: 20 });
    }
    // galaksiler, bulutsular, kümeler (M31, NGC 224, Andromeda Galaksisi…), kara delikler ve pulsarlar
    for (const it of LichDeep.searchItems()) items.push(it);
    return items;
  }

  /** Kartı açık yıldızı işaretle (gökyüzünde halka) ve yeniden çizdir. */
  function select(s) {
    selected = s;
    if (s && LichDeep.selected) { LichDeep.select(null); if (sky) sky.redraw(); }
    try { aladin.view.requestRedraw(); } catch (_) { /* bir sonraki karede çizilir */ }
  }

  /** Takımyıldızı ortala ve kartında en parlak yıldızlarını listele. */
  function showConstellation(c) {
    select(null);
    const n = ((CONS && CONS.names) || {})[c.abbr] || [];
    const members = STARS.filter((s) => s.con === c.abbr && s.v != null).sort((a, b) => a.v - b.v);
    // görüş alanı: ad noktasından en uzak parlak yıldızına göre
    const far = members.filter((s) => s.v < 4.5).reduce((m, s) => Math.max(m, angSep(c.ra, c.dec, s.ra, s.dec)), 0);
    const hid = belowHorizon(c.ra, c.dec);
    aladin.gotoRaDec(c.ra, c.dec);
    aladin.setFoV(Math.max(25, Math.min(100, 2.6 * far || 45)));
    const h = sky ? sky.altaz(c.ra, c.dec) : null;
    const top = members.slice(0, 8);
    const body = $("#panel-body");
    body.innerHTML = `
      <h2 style="margin:0 0 2px">${esc(D.CON_TR[c.abbr] || n[0] || c.abbr)}</h2>
      <div class="ids">${esc([n[0], c.abbr, "takımyıldız"].filter(Boolean).join(" · "))}</div>
      ${hid}
      ${h ? `<p class="muted">Şu an (${esc(sky.place.name)}): ${h.alt > 0 ? `ufkun ${D.fmt(h.alt, 0)}° üstünde, ${sky.dirName(h.az)} yönünde` : "ufkun altında, şu an görünmüyor"}.</p>` : ""}
      ${top.length ? `<div class="section"><h3>En parlak yıldızları</h3><ul class="pick-list">${top.map((s, i) => `<li data-i="${i}">${esc(D.title(s))}<small>${esc([s.name ? s.desig : null, "V " + D.fmt(s.v, 2)].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul></div>` : ""}`;
    body.querySelectorAll("li[data-i]").forEach((li) => li.onclick = () => showStar(top[+li.dataset.i]));
    body.parentElement.scrollTop = 0;
  }

  /**
   * Arama sonuçları. Sorguda sayı yoksa derin gök cisimlerinin yalnızca "Barnard 33", "Sharpless 276" gibi
   * katalog adlarıyla eşleşmesi geriye düşer: "barnard" Barnard Yıldızı'nı, "barnard 33" Atbaşı Bulutsusu'nu bulur.
   */
  function searchIndex(index, q, limit = 10) {
    const digit = /\d/.test(q);
    return LichSearch.find(index, q, 40)
      .map((r) => (!digit && r.item.kind === "deep" && /\d/.test(r.key) ? { ...r, score: r.score - 60 } : r))
      .sort((x, y) => y.score - x.score).slice(0, limit);
  }

  function initSearch() {
    const input = $("#search-input"), list = $("#search-results");
    let hits = [], sel = 0, index = null;
    const getIndex = () => index || (index = LichSearch.build(searchItems()));
    const starHit = (s) => ({ kind: "star", star: s });

    function find(q) {
      q = q.trim();
      if (!q) return [];
      const coord = q.match(/^(-?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/);
      if (coord) return [{ coord: [+coord[1], +coord[2]] }];
      const hip = q.match(/^hip\s*(\d+)$/i);
      if (hip) { const s = byHip.get(+hip[1]); return s ? [starHit(s)] : []; }
      const hd = q.match(/^hd\s*(\d+)$/i);
      if (hd) return STARS.filter((s) => s.hd === +hd[1]).map(starHit);
      const gaia = q.match(/^gaia\s*(?:dr3)?\s*(\d{6,})$/i);
      if (gaia) return STARS.filter((s) => s.gaia === gaia[1]).map(starHit);
      return searchIndex(getIndex(), q, 10).map((r) => r.item);
    }
    function label(h) {
      if (h.coord) return `Koordinata git <small>${h.coord[0]}°, ${h.coord[1]}°</small>`;
      if (h.kind === "con") {
        const n = ((CONS && CONS.names) || {})[h.abbr] || [];
        return `${esc(D.CON_TR[h.abbr] || n[0] || h.abbr)}<small>${esc([n[0], "takımyıldız"].filter(Boolean).join(" · "))}</small>`;
      }
      if (h.kind === "deep") {
        const o = h.obj, t = LichDeep.title(o);
        const kind = o.kind === "dso" ? LichDeep.TYPE[o.t] || o.t : LichDeep.KIND[o.k] || o.k;
        const id = o.kind === "dso" ? [o.M ? `M${o.M}` : null, LichDeep.shortId(o.id)].find((x) => x && x !== t) : o.tr ? o.id : null;
        return `${esc(t)}<small>${esc([id, kind].filter(Boolean).join(" · "))}</small>`;
      }
      const s = h.star;
      const sub = [s.tr && s.tr !== s.name ? s.tr : null, s.name ? s.desig : null,
        s.v != null ? "V " + D.fmt(s.v, 2) : s.g != null ? "G " + D.fmt(s.g, 1) : null];
      return `${esc(D.title(s))}<small>${esc(sub.filter(Boolean).join(" · "))}</small>`;
    }
    function render() {
      if (!hits.length) { list.hidden = true; return; }
      list.innerHTML = hits.map((h, i) => `<li data-i="${i}" role="option"${i === sel ? ' aria-selected="true"' : ""}>${label(h)}</li>`).join("");
      list.hidden = false;
    }
    function pick(h) {
      list.hidden = true;
      if (!h) return;
      if (h.coord) {
        belowHorizon(h.coord[0], h.coord[1]);
        aladin.gotoRaDec(h.coord[0], h.coord[1]); aladin.setFoV(2); showPoint(h.coord[0], h.coord[1]);
      } else if (h.kind === "con") showConstellation(h);
      else if (h.kind === "deep") showDeep(h.obj);
      else showStar(h.star);
    }
    input.addEventListener("focus", () => setTimeout(getIndex, 0), { once: true });   // dizin ilk odakta kurulur
    LichDeep.onReady(() => {                       // derin gök verisi gelince dizin yeniden kurulur
      index = null;
      if (input.value.trim() && document.activeElement === input) { hits = find(input.value); sel = 0; render(); }
    });
    input.addEventListener("input", () => { hits = find(input.value); sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (list.hidden || !hits.length || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      render();
    });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) pick(hits[+li.dataset.i]); });
    $("#search").addEventListener("submit", (e) => { e.preventDefault(); pick(hits[sel] || find(input.value)[0]); });
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
      await LichDeep.load().catch(() => null);      // fotoğrafa düşen galaksi, bulutsu… için
      status.hidden = false;
      status.className = "upload-status";
      status.textContent = `"${f.name}" okunuyor ve koordinatları çözülüyor…`;
      try {
        const head = new Uint8Array(await f.slice(0, 6).arrayBuffer());
        const gz = head[0] === 0x1f && head[1] === 0x8b;
        const headTxt = String.fromCharCode(...head);
        if (gz || LichFits.isFits(f.name, headTxt)) {
          try {
            const j = await LichFits.solve(f, {
              stars: STARS, fieldBright: LichData.fieldBright, deep: (q) => LichDeep.inField(q),
              maxRadius: (ra, dec) => 1.3 * LichData.maxFieldRadius(ra, dec),
            });
            status.hidden = true;
            renderSolve(j);
            return;
          } catch (e) {
            if (e.code !== "NO_WCS") throw e;
            if (LichData.mode !== "server") { showNeedsSolver(true); return; }
          }
        }
        await solvePhoto(f);
      } catch (e) {
        console.error(e);
        status.hidden = false;
        status.className = "upload-status error";
        status.textContent = e.message;
      }
    }

    // JPG/PNG gece fotoğrafı: Phobetor yıldızları tarayıcıda bulur, LichSolve deseni kataloğla eşleştirir.
    async function solvePhoto(f) {
      const say = (t) => { status.hidden = false; status.className = "upload-status"; status.textContent = t; };
      say("Fotoğraf açılıyor…");
      const exifP = LichPhobetor.readExif(f);
      await LichPhobetor.init(say);
      const maxSide = LichPhobetor.backend === "webgpu" ? 1280 : 800;
      say("Fotoğraf hazırlanıyor…");
      const img = await LichPhobetor.loadImage(f, maxSide);
      const ph = await LichPhobetor.detect(img, { onStatus: say });
      const exif = await exifP;
      let sol = { ok: false, reason: "few_stars", nDet: ph.det.length };
      if (ph.det.length >= 5) {
        say(`Phobetor ${ph.det.length.toLocaleString("tr-TR")} yıldız buldu. Yıldız deseni gökyüzü kataloğuyla eşleştiriliyor…`);
        sol = await solveInWorker(ph.det, img.W, img.H, { focal35: exif.focal35 }, (a, b) =>
          say(`Phobetor ${ph.det.length.toLocaleString("tr-TR")} yıldız buldu. Yıldız deseni kataloğla eşleştiriliyor… (olası görüş açılarının ${a}/${b} kadarı denendi)`));
      }
      if (!sol.ok && LichData.mode === "server") { await solveOnServer(f); return; }
      status.hidden = true;
      renderSolve(photoResult(f, img, ph, sol, exif));
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

  // -------------------------------------------------------------- fotoğraf çözümü (Phobetor + LichSolve)
  let solveWorker = null;
  function solveInWorker(det, W, H, opts, onProgress) {
    const plain = det.map((d) => ({ x: d.x, y: d.y, flux: d.flux }));
    return new Promise((resolve, reject) => {
      let w;
      try {
        if (!solveWorker) {
          solveWorker = new Worker("js/solve.js");
          solveWorker.postMessage({ type: "catalog", stars: STARS.filter((s) => s.v != null && s.v <= 6.5).map((s) => [s.hip, s.ra, s.dec, s.v]) });
        }
        w = solveWorker;
      } catch (e) {
        // Worker açılamadı (ör. dosyadan açılan sayfa): ana iş parçacığında çöz
        const cat = new LichSolve.Catalog(STARS, 6.5);
        const r = LichSolve.solve(cat, plain, W, H, opts);
        if (r.ok) { const c = r.cam; r.cam = { R: c.R, f: c.f, cx: c.cx, cy: c.cy, k1: c.k1, k2: c.k2, rpix: c.rpix }; r.pairs = r.pairs.map(([d, i, dx, dy]) => [d, cat.stars[i].hip, dx, dy]); }
        resolve(r);
        return;
      }
      const done = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); };
      const onMsg = (e) => {
        const m = e.data;
        if (m.type === "progress") onProgress && onProgress(m.tried, m.total);
        else if (m.type === "result") { done(); resolve(m.result); }
        else if (m.type === "error") { done(); reject(new Error("Eşleştirme hatası: " + m.message)); }
      };
      const onErr = (e) => { done(); solveWorker = null; reject(new Error("Eşleştirici başlatılamadı: " + (e.message || "bilinmeyen hata"))); };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", onErr);
      w.postMessage({ type: "solve", det: plain, W, H, opts });
    });
  }

  /** Phobetor tespitleri + eşleştirme sonucunu sonuç penceresinin beklediği biçime getir. */
  function photoResult(f, img, ph, sol, exif) {
    const W = img.W, H = img.H;
    const j = {
      status: sol.ok ? "solved" : "failed", source: "phobetor", file: f.name,
      width: W, height: H, preview: { url: img.canvas.toDataURL("image/jpeg", 0.9), scale: 1, y_flipped: false },
      phobetor: { n: ph.det.length, backend: ph.backend, ms: ph.ms, threshold: ph.threshold },
      solver: { ms: sol.ms, focalsTried: sol.focalsTried, reason: sol.reason },
      exif, detections: ph.det, stars: [], gaia: [],
    };
    if (!sol.ok) return j;
    const c = sol.cam;
    const cam = new LichSolve.Camera(c.R, c.f, c.cx, c.cy, c.k1, c.k2, c.rpix || 0.6 * Math.hypot(W, H));
    const [ra0, dec0] = cam.pix2world((W - 1) / 2, (H - 1) / 2);
    const border = [], n = 10;
    for (let i = 0; i < n; i++) border.push([(i / n) * (W - 1), 0]);
    for (let i = 0; i < n; i++) border.push([W - 1, (i / n) * (H - 1)]);
    for (let i = 0; i < n; i++) border.push([(1 - i / n) * (W - 1), H - 1]);
    for (let i = 0; i < n; i++) border.push([0, (1 - i / n) * (H - 1)]);
    const corners = border.map(([x, y]) => cam.pix2world(x, y));
    const radius = Math.max(...corners.map(([a, b]) => angSep(ra0, dec0, a, b)));
    const matched = new Set();
    for (const [d, hip] of sol.pairs) {
      const s = byHip.get(hip), p = sol.det[d];
      if (!s || !p) continue;
      matched.add(Math.round(p.x * 8) + "," + Math.round(p.y * 8));
      j.stars.push({ ...s, src: "bright", x: p.x, y: p.y });
    }
    // En parlak yıldızların çekirdeği doyunca Phobetor onları bazen kaçırır ya da halesinde bulur. Çözüm
    // belli olduğu için fotoğrafa düşen en parlak yıldızlar (V ≤ 1,5) eşleşmemişse hesaplanan yerinde
    // gösterilir (kesik çizgili halka). Daha sönükler gösterilmez: ağaç ya da bina arkasında kalmış olabilirler.
    const have = new Set(j.stars.map((s) => s.hip));
    for (const s of STARS) {
      if (!(s.v <= 1.5) || have.has(s.hip)) continue;
      const p = cam.world2pix(s.ra, s.dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= W - 1 && p[1] <= H - 1) j.stars.push({ ...s, src: "bright", x: p[0], y: p[1], predicted: true });
    }
    j.stars.sort((a, b) => (a.v ?? 99) - (b.v ?? 99));
    j.detections = ph.det.map((d) => ({ ...d, matched: matched.has(Math.round(d.x * 8) + "," + Math.round(d.y * 8)) }));
    // takımyıldız çizgileri ve adları (düzlemsel izdüşümde büyük daireler doğru çizgidir)
    const lim = 4 * Math.max(W, H), ok = (p) => p && Math.abs(p[0]) < lim && Math.abs(p[1]) < lim;
    const segs = [];
    for (const line of CONS ? CONS.lines : []) {
      let prev = null;
      for (let i = 0; i < line.length; i += 2) {
        const p = cam.world2pix(line[i], line[i + 1]);
        if (ok(p) && ok(prev)) segs.push([prev[0], prev[1], p[0], p[1]]);
        prev = p;
      }
    }
    const labels = [], shown = new Set();
    for (const [abbr, ra, dec] of CONS ? CONS.labels : []) {
      const p = cam.world2pix(ra, dec);
      if (p && p[0] > W * 0.03 && p[1] > H * 0.04 && p[0] < W * 0.97 && p[1] < H * 0.97) {
        labels.push([D.CON_TR[abbr] || abbr, p[0], p[1]]);
        shown.add(abbr);
      }
    }
    // Dar açılı fotoğrafta takımyıldızın ad konumu çoğu zaman çerçevenin dışında kalır: tanınan
    // yıldızların en az %15'i bir takımyıldızdansa adı o yıldızların ortasına, yıldız adlarından uzağa yazılır.
    const byCon = new Map();
    for (const s of j.stars) if (s.con) byCon.set(s.con, (byCon.get(s.con) || []).concat([s]));
    const named = j.stars.slice(0, 15);
    const fsz = Math.max(12, W / 62);
    [...byCon.entries()].filter(([abbr, list]) => !shown.has(abbr) && list.length >= Math.max(4, 0.15 * j.stars.length))
      .sort((a, b) => b[1].length - a[1].length).slice(0, 3).forEach(([abbr, list]) => {
        const med = (v) => v.slice().sort((a, b) => a - b)[v.length >> 1];
        const mx = med(list.map((s) => s.x)), my = med(list.map((s) => s.y));
        for (const dy of [0, -0.07, 0.07, -0.14, 0.14, -0.21, 0.21]) {
          const y = Math.min(H * 0.95, Math.max(H * 0.05, my + dy * H));
          if (named.every((s) => Math.abs(s.y - y) > 1.6 * fsz || Math.abs(s.x - mx) > 5 * fsz)) {
            labels.push([D.CON_TR[abbr] || abbr, mx, y]);
            break;
          }
        }
      });
    j.deep = LichDeep.inField({
      ra0, dec0, radius, W, H, world2pix: (a, b) => cam.world2pix(a, b), pixscale: (3600 * 180) / Math.PI / cam.f,
      fovDeg: Math.max(sol.hfov || 0, sol.vfov || 0) || 2 * radius,
    });
    Object.assign(j, {
      center: { ra: ra0, dec: dec0 }, radius_deg: radius, pixscale_arcsec: (3600 * 180) / Math.PI / cam.f,
      corners, cons: { segs, labels },
      cam: { R: c.R, f: c.f, cx: c.cx, cy: c.cy, k1: c.k1, k2: c.k2, rpix: cam.rpix },
      fov: { h: sol.hfov, v: sol.vfov }, solver: { ...j.solver, rms: sol.rms, logp: sol.logp, matched: sol.pairs.length },
    });
    return j;
  }

  function solvedStarTitle(x) {
    if (x.src === "bright") return D.title(x);
    return `Gaia DR3 …${String(x.source_id).slice(-7)}`;
  }

  function renderSolve(j) {
    lastSolve = j;
    const photo = j.source === "phobetor", solved = j.status === "solved";
    const pv = j.preview;
    const img = $("#photo"), svg = $("#photo-marks"), list = $("#solve-list");
    img.src = pv.url || `data:${pv.mime};base64,${pv.data}`;
    const W = Math.round(j.width * pv.scale), H = Math.round(j.height * pv.scale);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const toPng = (x, y) => [x * pv.scale, (pv.y_flipped ? j.height - 1 - y : y) * pv.scale];
    const k = Math.max(0.6, W / 900);          // işaret boyu, görüntü genişliğine göre
    const fs = Math.max(12, W / 62);            // yazı boyu (görüntü birimiyle)

    // Parlak katalog yıldızları + Gaia'nın en parlak 40 kaynağı (parlak yıldızla çakışanlar hariç).
    // Geniş açılı fotoğrafta yüzlerce yıldız tanınır: listede en parlak 150'si, halkayla en parlak 60'ı.
    const items = (j.stars || []).slice(0, photo ? 150 : Infinity).map((s) => ({ ...s }));
    const gaia = (j.gaia || []).filter((g) => !items.some((s) => Math.hypot(s.x - g.x, s.y - g.y) * j.pixscale_arcsec < 3)).slice(0, 40);
    gaia.forEach((g) => items.push(g));

    let marks = "";
    if (photo && j.cons) {
      // fotoğrafın üstüne takımyıldız çizgileri ve adları
      marks += `<g class="cons">${j.cons.segs.map(([x1, y1, x2, y2]) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"></line>`).join("")}`
        + `${j.cons.labels.map(([t, x, y]) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${(fs * 0.9).toFixed(1)}" text-anchor="middle">${esc(t.toLocaleUpperCase("tr-TR"))}</text>`).join("")}</g>`;
    }
    if (photo) {
      // Phobetor'un bulup kataloğa oturtulamayan noktaları: sönük yıldız, gezegen, uçak, lamba…
      marks += `<g class="det">${(j.detections || []).filter((d) => !d.matched).map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${(2.6 * k).toFixed(1)}"></circle>`).join("")}</g>`;
    }
    marks += items.map((it, i) => {
      const [px, py] = toPng(it.x, it.y);
      const mag = it.src === "bright" ? it.v : it.phot_g_mean_mag;
      const r = photo
        ? (i < 60 ? (mag < 1 ? 13 : mag < 2 ? 10.5 : mag < 3 ? 8.5 : mag < 4 ? 7 : 5.5) : 3.2) * Math.max(0.5, W / 1000)
        : Math.max(5, Math.min(22, 18 - 1.1 * (mag ?? 14))) * k;
      const label = it.src === "bright" && i < 15 ? `<text x="${(px + r + 3).toFixed(1)}" y="${(py + fs * 0.35).toFixed(1)}" font-size="${fs.toFixed(1)}">${esc(D.title(it))}</text>` : "";
      return `<circle class="${it.src}${photo && i >= 60 ? " minor" : ""}${it.predicted ? " predicted" : ""}" data-i="${i}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}"></circle>${label}`;
    }).join("");
    // derin gök: galaksi, bulutsu, küme, pulsar, kara delik… (yıldız halkalarının altında, tıklanabilir).
    // Gerçek boyuyla çizilir; fotoğraftan büyükler soluk, ortalarında küçük bir artı. Adlar yıldız adlarının
    // ve birbirlerinin üstüne binmez.
    const deep = solved ? (j.deep || []).slice(0, 40) : [];
    const boxes = [];
    const tw = (t, size) => 0.56 * size * t.length;
    items.forEach((it, i) => {
      if (it.src !== "bright" || i >= 15) return;
      const [px, py] = toPng(it.x, it.y), t = D.title(it);
      boxes.push([px, py - fs * 0.7, px + 14 * k + tw(t, fs), py + fs * 0.6]);
    });
    const free = (b) => !boxes.some((q) => q[0] < b[2] && b[0] < q[2] && q[1] < b[3] && b[1] < q[3]);
    let deepMarks = "";
    deep.forEach((d, i) => {
      const o = d.obj, [px, py] = toPng(d.x, d.y), col = LichDeep.COLOR[o._g];
      const point = o.kind === "compact" || !d.rpx;
      const r = point ? 7 * k : Math.max(9 * k, d.rpx * pv.scale), huge = r > 0.35 * Math.min(W, H);
      const attrs = `class="g-${o._g}${huge ? " huge" : ""}" data-d="${i}" style="stroke:rgb(${col})"`;
      const P = (v) => v.toFixed(1);
      if (d.maj) {
        const ang = (Math.atan2(pv.y_flipped ? -d.maj[1] : d.maj[1], d.maj[0]) * 180) / Math.PI;
        deepMarks += `<ellipse ${attrs} cx="${P(px)}" cy="${P(py)}" rx="${P(r)}" ry="${P(Math.max(3 * k, r * d.ratio))}" transform="rotate(${P(ang)} ${P(px)} ${P(py)})"></ellipse>`;
      } else {
        deepMarks += `<circle ${attrs} cx="${P(px)}" cy="${P(py)}" r="${P(r)}"></circle>`;
        if (o._g === "bh" || o._g === "smbh") deepMarks += `<circle class="core" cx="${P(px)}" cy="${P(py)}" r="${P(r * 0.55)}"></circle>`;
      }
      const big = r > 14 * k;
      if (big) {                                 // büyük cismin ortası: küçük artı, adı onun yanında
        const c = 5 * k;
        deepMarks += `<path class="mid" style="stroke:rgb(${col})" d="M${P(px - c)} ${P(py)}H${P(px + c)}M${P(px)} ${P(py - c)}V${P(py + c)}"></path>`;
      }
      if (i >= 18) return;
      const t = LichDeep.label(o), size = fs * 0.9;
      const lx = px + (big ? 7 * k : r + 4), ly = py + size * 0.35;
      const box = [lx, ly - size * 0.85, lx + tw(t, size), ly + size * 0.25];
      if (!free(box)) return;
      boxes.push(box);
      deepMarks += `<text x="${P(lx)}" y="${P(ly)}" font-size="${P(size)}" style="fill:rgb(${col})">${esc(t)}</text>`;
    });
    svg.innerHTML = (deepMarks ? `<g class="deep">${deepMarks}</g>` : "") + marks;

    if (photo && !solved) {
      list.innerHTML = `
        <li><small><b>Neden olabilir?</b> Fotoğrafta belirgin yıldız az olabilir (en az 8–10 iyi olur), görüntü kırpılmış,
        bükülmüş ya da çok işlenmiş olabilir; ay, bulut, sokak lambası ve uçak ışıkları da deseni bozar.</small></li>
        <li><small>Orijinal dosyayı yüklemek en iyisi: içindeki odak bilgisi eşleştirmeyi kolaylaştırır. Ön planda yıldızlardan parlak
        ışıklar (ev, sokak lambası) varsa yalnızca o kısmı kırpıp yeniden denemek işe yarayabilir.</small></li>
        <li><small>Başka bir yol: fotoğrafı ücretsiz <a href="https://nova.astrometry.net/upload" target="_blank" rel="noopener">nova.astrometry.net</a>'e yükle, oradan inen <b>new-image.fits</b> dosyasını buraya bırak.</small></li>`;
    } else {
      const deepLis = deep.map((d, i) => `<li data-d="${i}"><span>${esc(LichDeep.title(d.obj))}</span>`
        + `<span class="kind deep" style="--c:${LichDeep.COLOR[d.obj._g]}">${esc(LichDeep.shortKind(d.obj))}</span>`
        + `<small>${esc(LichDeep.brief(d.obj))}</small></li>`).join("");
      list.innerHTML = (deep.length ? `<li class="head">Derin gök</li>${deepLis}<li class="head">Yıldızlar</li>` : "") + items.map((it, i) => {
        const mag = it.src === "bright" ? `V ${D.fmt(it.v, 2)}` : `G ${D.fmt(it.phot_g_mean_mag, 2)}`;
        const extra = it.src === "bright" ? [it.sp, it.desig && it.name ? it.desig : null].filter(Boolean).join(" · ") : [it.teff_gspphot ? `${D.fmtInt(it.teff_gspphot)} K` : null, it.spectraltype_esphs].filter(Boolean).join(" · ");
        return `<li data-i="${i}"><span>${esc(solvedStarTitle(it))}</span><span class="kind ${it.src}">${it.src === "bright" ? "LichSpec" : "Gaia"}</span><small>${mag}${extra ? " · " + esc(extra) : ""}${it.predicted ? " · yeri hesaplandı (Phobetor bulamadı)" : ""}</small></li>`;
      }).join("") || `<li><small>Görüntü alanında tanınan yıldız yok.</small></li>`;
    }

    const select = (i) => {
      svg.querySelectorAll("circle[data-i]").forEach((c) => c.classList.toggle("active", +c.dataset.i === i));
      list.querySelectorAll("li").forEach((l) => l.classList.toggle("active", +l.dataset.i === i));
      const it = items[i];
      $("#upload-dialog").close();
      showSolveOnSky(j, false);
      if (it.src === "bright") showStar(byHip.get(it.hip) || it);
      else { gotoStar(it, Math.max(0.05, j.radius_deg * 1.2)); openGaiaStar(it); }
    };
    svg.querySelectorAll("circle[data-i]").forEach((c) => c.onclick = () => select(+c.dataset.i));
    list.querySelectorAll("li[data-i]").forEach((l) => l.onclick = () => select(+l.dataset.i));
    const selectDeep = (i) => {
      $("#upload-dialog").close();
      showSolveOnSky(j, false);
      showDeep(deep[i].obj);
    };
    svg.querySelectorAll("[data-d]").forEach((c) => c.onclick = () => selectDeep(+c.dataset.d));
    list.querySelectorAll("li[data-d]").forEach((l) => l.onclick = () => selectDeep(+l.dataset.d));

    const meta = [];
    if (photo) {
      const ph = j.phobetor;
      const n = ph.n.toLocaleString("tr-TR");
      meta.push(`<span>Phobetor: <b>${n} yıldız</b> buldu (${ph.backend === "webgpu" ? "WebGPU" : "WebAssembly"}, ${D.fmt(ph.ms / 1000, 1)} sn)</span>`);
    }
    if (solved) {
      const fovTxt = photo ? `${D.fmt(j.fov.h, 1)}° × ${D.fmt(j.fov.v, 1)}°`
        : j.radius_deg * 2 >= 1 ? `${D.fmt(j.radius_deg * 2, 2)}°` : `${D.fmt(j.radius_deg * 120, 1)}′`;
      meta.push(`<span>Merkez <b>${hms(j.center.ra)} ${dms(j.center.dec)}</b></span>`);
      meta.push(`<span>${photo ? "Görüş alanı" : "Alan çapı"} <b>${fovTxt}</b></span>`);
      const nPred = photo ? j.stars.filter((s) => s.predicted).length : 0, nRec = j.stars.length - nPred;
      meta.push(photo ? `<span>Tanınan: <b>${nRec.toLocaleString("tr-TR")}</b> yıldız${j.stars.length > items.length ? ` (listede en parlak ${items.length} tanesi)` : ""}${nPred ? ` · ${nPred} parlak yıldız hesaplanan yerinde` : ""}</span>`
        : `<span>Ölçek <b>${D.fmt(j.pixscale_arcsec, 3)}″/piksel</b></span>`);
      if (!photo) meta.push(`<span>Tanınan: <b>${j.stars.length}</b> parlak yıldız, <b>${j.gaia.length}</b> Gaia kaynağı${j.gaia_radius_deg ? ` (Gaia: görüntünün ortasındaki ${D.fmt(j.gaia_radius_deg * 2, 2)}° çaplı alan)` : ""}</span>`);
      if (deep.length) {
        const kinds = [...new Set(deep.map((d) => LichDeep.shortKind(d.obj)))];
        meta.push(`<span>Derin gök: <b>${deep.length}</b> cisim (${esc(kinds.slice(0, 5).join(", "))}${kinds.length > 5 ? "…" : ""})</span>`);
      }
      meta.push(`<span>Çözüm: <b>${j.source === "fits-wcs" ? "FITS başlığındaki WCS" : photo ? "yıldız deseni eşleştirme (tarayıcında)" : "Astrometry.net"}</b>${photo ? ` · ortalama sapma ${D.fmt(j.solver.rms, 1)} piksel` : ""}</span>`);
    } else if (photo) {
      meta.push(`<span class="error">${j.solver.reason === "few_stars"
        ? `Deseni eşleştirmek için en az 5 yıldız gerekiyor; bu fotoğrafta ${j.phobetor.n} tane bulundu.`
        : "Yıldız deseni gökyüzü kataloğuyla eşleşmedi."}</span>`);
    }
    if (j.gaia_error) meta.push(`<span class="error">${esc(j.gaia_error)}</span>`);
    $("#solve-meta").innerHTML = meta.join("");
    $("#btn-show-on-sky").hidden = !solved;
    $("#solve-result").hidden = false;
  }

  function showSolveOnSky(j, setView = true) {
    footprintLayer.removeAll();
    footprintLayer.add(A.polygon(j.corners.map(([a, b]) => [a, b])));
    // fotoğraftaki bölge şu an ufkun altındaysa yerin içinden görünür (yer opaksa yarı saydama iner)
    belowHorizon(j.center.ra, j.center.dec);
    if (setView) {
      aladin.gotoRaDec(j.center.ra, j.center.dec);
      aladin.setFoV(Math.min(boxFov(MAX_FOV), Math.max(0.05, j.radius_deg * (j.source === "phobetor" ? 2.4 : 3))));
      const near = j.stars[0];
      if (near) showStar(byHip.get(near.hip) || near, { goto: false });
    }
  }

  // -------------------------------------------------------------- başlat
  /**
   * Yer ayarı: kayıtlı değer. Dar ekranda Yer ayarı ve Derin gök düğmesi üst çubuk yerine gökyüzünün
   * köşesinde durur (çubuk telefonda bir satır daha uzamasın).
   */
  function initGroundControl() {
    const ctl = $("#ground-alpha"), label = ctl.closest("label"), slot = $("#ground-slot");
    const deepLabel = $("#toggle-deep").closest("label");
    ctl.value = Math.round(savedGround() * 100);
    const narrow = matchMedia("(max-width: 860px)");
    const place = () => {
      if (narrow.matches) slot.append(label, deepLabel);
      else {
        $("#toggle-horizon").closest("label").after(label);
        $("#toggle-stars").closest("label").after(deepLabel);
      }
      slot.hidden = !narrow.matches;
    };
    place();
    narrow.addEventListener ? narrow.addEventListener("change", place) : narrow.addListener(place);
  }

  async function main() {
    document.querySelectorAll(".deep-legend canvas[data-g]").forEach((c) => LichDeep.legendIcon(c, c.dataset.g));
    initGroundControl();
    initUpload();
    try {
      await Promise.all([loadCatalog(), loadConstellations()]);
    } catch (e) {
      $("#sky-status").textContent = "Yıldız kataloğu yüklenemedi: " + e.message;
      return;
    }
    initSearch();
    await LichData.detect();

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
    $("#toggle-stars").onchange = (e) => (e.target.checked ? starCat.show() : starCat.hide());
    $("#toggle-lines").onchange = (e) => sky.setLines(e.target.checked);
    $("#toggle-deep").onchange = (e) => { LichDeep.setOn(e.target.checked); sky.redraw(); };
    LichDeep.load().then((n) => {
      sky.redraw();
      const el = $("#deep-count");
      if (el) el.textContent = (n.dso + n.compact).toLocaleString("tr-TR");
    }).catch((e) => console.error("Derin gök kataloğu yüklenemedi:", e));
    document.querySelectorAll("[data-deep-goto]").forEach((b) => b.onclick = () => LichDeep.load().then(() => {
      const o = LichDeep.byId(b.dataset.deepGoto);
      if (o) showDeep(o);
    }));
    const groundCtl = $("#ground-alpha");
    groundCtl.oninput = () => setGround(groundCtl.value / 100);
    $("#toggle-horizon").onchange = (e) => {
      sky.setHorizon(e.target.checked);
      groundCtl.disabled = !e.target.checked;
      groundCtl.closest("label").classList.toggle("off", !e.target.checked);
    };
    $("#btn-locate").onclick = locate;
    window.lichspec = {
      aladin, STARS, showStar, renderSolve, sky, data: LichData,
      search: (q) => searchIndex(LichSearch.build(searchItems()), q, 10).map((r) => (r.item.kind === "con" ? r.item.abbr : r.item.kind === "deep" ? LichDeep.title(r.item.obj) : D.title(r.item.star))),
      deep: LichDeep, showDeep,
      get gaiaMode() { return gaiaMode; },
      get imagery() { return { wide: wideFailed ? "DSS2 (Mellinger unreachable)" : "Mellinger", detail: detailOn }; },
      get lastSolve() { return lastSolve; },
    };
  }

  /** Tarayıcıdan gerçek konumu iste (yalnızca düğmeye basınca). */
  function locate() {
    const btn = $("#btn-locate");
    if (!navigator.geolocation) { btn.textContent = "Konum yok"; return; }
    btn.disabled = true;
    btn.textContent = "Konum alınıyor…";
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      sky.setPlace({ name: "Konumun", lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
      updatePlace();
      btn.disabled = false;
      btn.textContent = "Konumum";
    }, () => {
      btn.disabled = false;
      btn.textContent = "Konum izni yok";
      setTimeout(() => (btn.textContent = "Konumum"), 3000);
    }, { timeout: 15000, maximumAge: 600000 });
  }
  main();
})();
