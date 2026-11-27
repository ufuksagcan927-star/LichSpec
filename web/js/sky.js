/* LichSpec Gökyüzü — dünyadan bakış.
 *
 * Gökyüzü gözlemcinin bulunduğu yerden, bir fotoğraf makinesinin vizöründen bakılıyormuş gibi çizilir:
 * gnomonik (TAN) izdüşüm, düz çizgiler düz kalır, ufuk her zaman düz bir çizgidir (stereografik
 * izdüşümde ufuk geniş açıda kubbe gibi eğrilir, "kürenin içindeymiş gibi" görünür). Yukarısı her
 * zaman başucu, aşağıda yarı saydam yer ve ufuk, ufukta yönler (K, D, G, B), gökyüzünde takımyıldız
 * çizgileri ve adları. Ufuk ve yön çizimi gözlemcinin konumuna ve saatine göre hesaplanır.
 *
 * Aladin Lite'ın kendi çizimine dokunulmaz: takımyıldız çizgileri, adları, derin gök simgeleri (katman
 * olarak, deepsky.js), yer, ufuk ve yönler gökyüzünün üstünde tıklamayı geçiren ayrı bir tuvalde (canvas)
 * çizilir.
 */
(function (global) {
  "use strict";
  const R = Math.PI / 180;
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  const norm360 = (x) => ((x % 360) + 360) % 360;

  // ------------------------------------------------------------------ astronomi
  function julian(date) { return date.getTime() / 86400000 + 2440587.5; }
  /** Greenwich ortalama yıldız zamanı (derece). */
  function gmst(date) { return norm360(280.46061837 + 360.98564736629 * (julian(date) - 2451545.0)); }
  /** Yerel yıldız zamanı (derece); lon doğu pozitif. */
  function lst(date, lon) { return norm360(gmst(date) + lon); }

  /** Ekvatoral → yatay. az kuzeyden doğuya doğru (K=0, D=90, G=180, B=270). */
  function eq2hor(ra, dec, LST, lat) {
    const H = (LST - ra) * R, d = dec * R, p = lat * R;
    const alt = Math.asin(clamp1(Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(H)));
    const az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(H));
    return { alt: alt / R, az: norm360(az / R) };
  }
  /** Yatay → ekvatoral. */
  function hor2eq(alt, az, LST, lat) {
    const a = alt * R, A = az * R, p = lat * R;
    const dec = Math.asin(clamp1(Math.sin(a) * Math.sin(p) + Math.cos(a) * Math.cos(p) * Math.cos(A)));
    const H = Math.atan2(-Math.sin(A) * Math.cos(a), Math.sin(a) * Math.cos(p) - Math.cos(a) * Math.sin(p) * Math.cos(A));
    return { ra: norm360(LST - H / R), dec: dec / R };
  }
  /** 2. noktanın 1. noktaya göre konum açısı (kuzeyden doğuya, derece). */
  function posAngle(ra1, de1, ra2, de2) {
    const dA = (ra2 - ra1) * R, d1 = de1 * R, d2 = de2 * R;
    return Math.atan2(Math.sin(dA) * Math.cos(d2), Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dA)) / R;
  }
  /** Gök koordinatından birim vektör; iki birim vektörün iç çarpımı. */
  function unit(ra, dec) {
    const a = ra * R, d = dec * R;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  }
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  function angSep(ra1, de1, ra2, de2) {
    const c = Math.sin(de1 * R) * Math.sin(de2 * R) + Math.cos(de1 * R) * Math.cos(de2 * R) * Math.cos((ra1 - ra2) * R);
    return Math.acos(clamp1(c)) / R;
  }
  const DIR8 = ["kuzey", "kuzeydoğu", "doğu", "güneydoğu", "güney", "güneybatı", "batı", "kuzeybatı"];
  const dirName = (az) => DIR8[Math.round(norm360(az) / 45) % 8];

  // ------------------------------------------------------------------ konum
  // Açılışta izin istemeden saat diliminden bir şehir seçilir; "Konumum" düğmesi gerçek konumu alır.
  const TZ_PLACES = {
    "Europe/Istanbul": ["İstanbul", 41.01, 28.98], "Asia/Istanbul": ["İstanbul", 41.01, 28.98],
    "Asia/Nicosia": ["Lefkoşa", 35.19, 33.38], "Europe/Nicosia": ["Lefkoşa", 35.19, 33.38], "Asia/Baku": ["Bakü", 40.41, 49.87],
    "Europe/Berlin": ["Berlin", 52.52, 13.40], "Europe/Amsterdam": ["Amsterdam", 52.37, 4.90], "Europe/Brussels": ["Brüksel", 50.85, 4.35],
    "Europe/Vienna": ["Viyana", 48.21, 16.37], "Europe/Paris": ["Paris", 48.86, 2.35], "Europe/London": ["Londra", 51.51, -0.13],
    "Europe/Stockholm": ["Stockholm", 59.33, 18.07], "Europe/Moscow": ["Moskova", 55.76, 37.62], "Europe/Athens": ["Atina", 37.98, 23.73],
    "America/New_York": ["New York", 40.71, -74.01], "America/Chicago": ["Chicago", 41.88, -87.63], "America/Denver": ["Denver", 39.74, -104.99],
    "America/Los_Angeles": ["Los Angeles", 34.05, -118.24], "America/Sao_Paulo": ["São Paulo", -23.55, -46.63],
    "Asia/Tokyo": ["Tokyo", 35.68, 139.69], "Asia/Kolkata": ["Delhi", 28.61, 77.21], "Asia/Dubai": ["Dubai", 25.20, 55.27],
    "Australia/Sydney": ["Sidney", -33.87, 151.21], "Africa/Johannesburg": ["Johannesburg", -26.20, 28.05],
  };
  function defaultPlace() {
    try {
      const saved = JSON.parse(localStorage.getItem("lichspec.place") || "null");
      if (saved && isFinite(saved.lat) && isFinite(saved.lon)) return saved;
    } catch (_) { /* kayıt yoksa saat dilimi */ }
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { /* yok */ }
    const p = TZ_PLACES[tz];
    if (p) return { name: p[0], lat: p[1], lon: p[2] };
    // bilinmeyen saat dilimi: boylam saat farkından, enlem orta kuzey
    const lon = Math.max(-180, Math.min(180, -new Date().getTimezoneOffset() / 4));
    return { name: "tahmini konum", lat: 40, lon };
  }

  // ------------------------------------------------------------------ görünüm
  /**
   * aladin: Aladin örneği; el: #aladin kutusu; cons: constellations.json; names: {kısaltma: Türkçe ad}
   * Dönüş: denetleyici (ufuk/takımyıldız açma-kapama, konum, yatay koordinata git, durum metni).
   */
  /**
   * Gnomonik bir görünümde w×h piksellik kutunun uzun kenarı `deg` derece görsün diye Aladin'e verilecek
   * görüş alanı. Aladin 3.9 görüş alanını kutunun genişliği boyunca tutar; dik telefonda genişlik kısa kenardır.
   */
  function fovForBox(deg, w, h) {
    w = Math.max(1, w || 1); h = Math.max(1, h || 1);
    return w >= h ? deg : (2 * Math.atan(Math.tan((Math.min(170, deg) / 2) * R) * (w / h))) / R;
  }

  function create(aladin, el, cons, names, opts = {}) {
    const state = {
      place: defaultPlace(),
      horizon: opts.horizon !== false,
      lines: opts.lines !== false,
      groundAlpha: opts.groundAlpha ?? 0.3,   // yerin örtücülüğü: 0 saydam, 1 opak
      now: new Date(),
      onChange: opts.onChange || (() => {}),
    };

    // takımyıldız çizgileri: uç noktaları birim vektör olarak, her biri ayrı bir parça
    const segs = [];
    for (const pl of cons.lines) {
      for (let i = 0; i + 3 < pl.length; i += 2) {
        const a = unit(pl[i], pl[i + 1]), b = unit(pl[i + 2], pl[i + 3]);
        segs.push({ a, b, len: Math.acos(clamp1(dot(a, b))) / R });
      }
    }

    // yer, ufuk, yönler ve takımyıldız adları: üstteki tuval
    const canvas = document.createElement("canvas");
    canvas.className = "sky-overlay";
    canvas.setAttribute("aria-hidden", "true");
    el.insertAdjacentElement("afterend", canvas);
    const ctx = canvas.getContext("2d");

    const LST = () => lst(state.now, state.place.lon);
    const altaz = (ra, dec) => eq2hor(ra, dec, LST(), state.place.lat);
    const toRaDec = (alt, az) => hor2eq(alt, az, LST(), state.place.lat);

    // ---------------------------------------------------------------- yerden bakış gezinmesi
    // Ufuk açıkken bakış yönü (yükseklik, yön açısı) olarak tutulur: sürükleyince yön açısı ve yükseklik
    // değişir, yükseklik başucunda (90°) ve ayakucunda (−90°) durur. Böylece başucundan geçerken
    // görüntü ters dönmez (Aladin'in kendi sürüklemesi ekvator koordinatlarında çalışır; başucunu
    // aşınca "yukarısı" 180° döner ve sürükleme yön değiştirip ileri geri sıçrar).
    const ALT_MIN = -90, ALT_MAX = 90;
    const nav = { alt: null, az: null, ra: null, dec: null };

    /** Aladin'in merkezinden bakış yönünü günceller; başucunda ve ayakucunda yön açısı tanımsız olduğundan son değer kalır. */
    function syncNav() {
      const [ra, dec] = aladin.getRaDec();
      const h = altaz(ra, dec);
      nav.alt = h.alt;
      if (Math.abs(h.alt) < 89.5 || nav.az == null) nav.az = h.az;
      nav.ra = ra;
      nav.dec = dec;
    }

    /** Ekranın yukarısı: bakılan noktadan yükseklik artan yöne (başucunda bile tanımlı). */
    function uprightRotation() {
      const a = nav.alt * R, A = nav.az * R, d = 0.01;
      const c = [Math.cos(a) * Math.cos(A), Math.cos(a) * Math.sin(A), Math.sin(a)];
      const u = [-Math.sin(a) * Math.cos(A), -Math.sin(a) * Math.sin(A), Math.cos(a)];
      const p = c.map((ci, i) => ci * Math.cos(d) + u[i] * Math.sin(d));
      const up = toRaDec(Math.asin(clamp1(p[2])) / R, Math.atan2(p[1], p[0]) / R);
      return -posAngle(nav.ra, nav.dec, up.ra, up.dec);
    }

    function keepUpright() {
      const want = state.horizon ? uprightRotation() : 0;
      const d = norm360(want - aladin.getRotation() + 180) - 180;
      if (Math.abs(d) > 0.02) aladin.setRotation(norm360(want + 180) - 180);
    }

    /** Bakış yönünü (yükseklik, yön açısı) uygula. */
    function applyNav() {
      nav.alt = Math.max(ALT_MIN, Math.min(ALT_MAX, nav.alt));
      nav.az = norm360(nav.az);
      const e = toRaDec(nav.alt, nav.az);
      nav.ra = e.ra;
      nav.dec = e.dec;
      aladin.gotoRaDec(e.ra, e.dec);
      keepUpright();
      dirty = true;
    }

    /** Ekran merkezinde bir pikselin kaç derece olduğu. */
    function degPerPx() {
      const w = el.clientWidth, h = el.clientHeight;
      const a = aladin.pix2world(w / 2, h / 2), b = aladin.pix2world(w / 2 + 10, h / 2);
      if (a && b && isFinite(a[0]) && isFinite(b[0])) {
        const s = angSep(a[0], a[1], b[0], b[1]) / 10;
        if (s > 0 && isFinite(s)) return s;
      }
      return aladin.getFov()[0] / Math.max(1, w);
    }

    // Aladin sürüklemeyi wasm.goFromTo(önceki x, y, şimdiki x, y) ile yapar (aladin-lite 3.9.4, sürüm
    // sabit). Ufuk açıkken bu çağrı yerden bakış gezinmesine çevrilir; tıklama ve nesne seçimi Aladin'de
    // kalır. İşlev bulunmazsa Aladin'in kendi sürüklemesi kullanılır.
    const wasm = aladin.view && aladin.view.wasm;
    const nativeGoFromTo = wasm && typeof wasm.goFromTo === "function" ? wasm.goFromTo.bind(wasm) : null;
    const altAzDrag = !!nativeGoFromTo;
    if (altAzDrag) {
      wasm.goFromTo = function (x1, y1, x2, y2) {
        if (!state.horizon) return nativeGoFromTo(x1, y1, x2, y2);
        syncNav();
        const k = degPerPx();
        nav.alt += (y2 - y1) * k;                                        // aşağı çek: yukarı bak
        nav.az -= ((x2 - x1) * k) / Math.max(0.05, Math.cos(Math.max(ALT_MIN, Math.min(ALT_MAX, nav.alt)) * R));
        applyNav();
      };
    }
    function setInertia(on) {
      try { if (wasm && typeof wasm.setInertia === "function") wasm.setInertia(on); } catch (_) { /* eski sürüm */ }
    }

    function project(ra, dec) {
      const p = aladin.world2pix(ra, dec);
      if (!p) return null;
      const x = p[0], y = p[1];
      if (!isFinite(x) || !isFinite(y)) return null;
      return [Math.max(-2e5, Math.min(2e5, x)), Math.max(-2e5, Math.min(2e5, y))];
    }

    /**
     * Gnomonik ölçek s: teğet düzlemde bir birimin piksel karşılığı. Merkezden θ uzaktaki nokta ekranın
     * ortasından s·tan θ piksel ötededir. Aladin'in kendi izdüşümünden ölçülür (merkezle 2° ötesindeki
     * nokta), böylece Aladin görüş alanını hangi kenara göre tutarsa tutsun doğru kalır.
     */
    function tanScale(w, h) {
      const c = aladin.pix2world(w / 2, h / 2);
      if (c && isFinite(c[0]) && isFinite(c[1])) {
        const p0 = aladin.world2pix(c[0], c[1]), p1 = aladin.world2pix(c[0], c[1] > 0 ? c[1] - 2 : c[1] + 2);
        if (p0 && p1) {
          const s = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / Math.tan(2 * R);
          if (s > 0 && isFinite(s)) return s;
        }
      }
      return w / 2 / Math.tan((Math.min(170, aladin.getFov()[0]) / 2) * R);   // Aladin 3.9: genişlik boyunca
    }
    /** Ekranın uzun kenarının gördüğü açı (derece): "görüş alanı" olarak gösterilen ve eşiklerde kullanılan. */
    function longFov(w = el.clientWidth, h = el.clientHeight) {
      return (2 * Math.atan(Math.max(w, h) / 2 / tanScale(w, h))) / R;
    }
    const fovFor = (deg) => fovForBox(deg, el.clientWidth, el.clientHeight);

    /**
     * Yer ve ufuk. Gnomonik izdüşümde ufuk (gökyüzünde bir büyük çember) ekranda düz bir çizgidir ve
     * görünüm hep dik tutulduğu için yataydır: ekranın ortası ufkun a° üstündeyse çizgi ortanın
     * tan(a)·s piksel altındadır. Yer yarı saydamdır: altındaki gökyüzü, yıldızlar ve çizgiler görünür,
     * ne kadar örteceği ayarlanabilir.
     */
    function horizonY(w, h) {
      const a = Math.max(-89.9, Math.min(89.9, nav.alt));
      return h / 2 + Math.tan(a * R) * tanScale(w, h);
    }

    function drawGround(w, h) {
      const y = horizonY(w, h);
      if (y > h + 10) return;                                            // ufuk ekranın altında
      const top = Math.max(-10, y);
      if (state.groundAlpha > 0) {
        // ufka yakın yer biraz daha açık: ufuk çizgisi yumuşak dursun
        const g = ctx.createLinearGradient(0, y, 0, y + 60);
        g.addColorStop(0, `rgba(11, 17, 14, ${(state.groundAlpha * 0.8).toFixed(3)})`);
        g.addColorStop(1, `rgba(11, 17, 14, ${state.groundAlpha.toFixed(3)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, top, w, h + 10 - top);
      }
      if (y < -10) return;                                               // ufuk ekranın üstünde
      // ufuk çizgisi: yumuşak bir parıltı + ince çizgi
      ctx.beginPath();
      ctx.moveTo(-10, y);
      ctx.lineTo(w + 10, y);
      ctx.strokeStyle = "rgba(255, 190, 110, 0.18)";
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 196, 120, 0.85)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    function drawCardinals(w, h) {
      const main = [["K", 0], ["D", 90], ["G", 180], ["B", 270]];
      const mid = [["KD", 45], ["GD", 135], ["GB", 225], ["KB", 315]];
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [lab, az, big] of [...main.map((m) => [...m, true]), ...mid.map((m) => [...m, false])]) {
        const e = toRaDec(-1.2, az);
        const p = project(e.ra, e.dec);
        if (!p || p[0] < -20 || p[1] < -20 || p[0] > w + 20 || p[1] > h + 20) continue;
        ctx.font = big ? "700 17px system-ui, sans-serif" : "600 12px system-ui, sans-serif";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(lab, p[0], p[1] + (big ? 12 : 9));
        ctx.fillStyle = big ? "#ffcf7a" : "rgba(255, 207, 122, 0.75)";
        ctx.fillText(lab, p[0], p[1] + (big ? 12 : 9));
      }
    }

    /**
     * Takımyıldız çizgileri. Gnomonik izdüşüm bakış merkezinden 90°'den uzak noktaları gösteremez; ucu o
     * yanda kalan bir çizgi merkezden 85°'de kesilir (büyük çember ekranda düz çizgidir, kesilen ucu ekranın
     * çok dışındadır). Görüş alanından uzak parçalar hiç izdüşürülmez.
     */
    const CLIP = Math.cos(85 * R);
    function drawLines(w, h) {
      const [ra0, dec0] = aladin.getRaDec();
      const c = unit(ra0, dec0);
      const s = tanScale(w, h);
      const radius = Math.atan(Math.hypot(w, h) / 2 / s) / R;           // ekranın köşesine açı
      ctx.beginPath();
      for (const g of segs) {
        const da = dot(c, g.a), db = dot(c, g.b);
        if (da < CLIP && db < CLIP) continue;
        const near = Math.acos(clamp1(Math.max(da, db))) / R;
        if (near > radius + g.len + 1) continue;                         // ekrana hiç değmez
        const p = da < CLIP ? clipArc(c, g.b, g.a) : g.a;
        const q = db < CLIP ? clipArc(c, g.a, g.b) : g.b;
        const P = projectVec(p), Q = projectVec(q);
        if (!P || !Q) continue;
        ctx.moveTo(P[0], P[1]);
        ctx.lineTo(Q[0], Q[1]);
      }
      ctx.strokeStyle = "rgba(150, 175, 255, 0.5)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    /** a'dan (merkeze 85°'den yakın) b'ye (uzak) giden yay üzerinde merkeze tam 85° olan nokta. */
    function clipArc(c, a, b) {
      let lo = 0, hi = 1, v = a;
      for (let k = 0; k < 30; k++) {
        const t = (lo + hi) / 2;
        const x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]), z = a[2] + t * (b[2] - a[2]);
        const n = Math.hypot(x, y, z) || 1;
        if ((c[0] * x + c[1] * y + c[2] * z) / n >= CLIP) { lo = t; v = [x / n, y / n, z / n]; } else hi = t;
      }
      return v;
    }
    function projectVec(v) {
      const p = aladin.world2pix(norm360(Math.atan2(v[1], v[0]) / R), Math.asin(clamp1(v[2])) / R);
      return p && isFinite(p[0]) && isFinite(p[1]) ? p : null;
    }

    function drawNames(w, h, fov) {
      const maxRank = fov > 110 ? 1 : fov > 70 ? 2 : 3;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `500 ${fov > 100 ? 11 : 12}px system-ui, sans-serif`;
      for (const [abbr, ra, dec, rank] of cons.labels) {
        if (rank > maxRank) continue;
        if (state.horizon && state.groundAlpha > 0.85 && altaz(ra, dec).alt < -2) continue;   // opak yerin altı
        const p = project(ra, dec);
        if (!p || p[0] < -60 || p[1] < -20 || p[0] > w + 60 || p[1] > h + 20) continue;
        const t = (names[abbr] || abbr).toLocaleUpperCase("tr-TR");
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(5, 8, 20, 0.7)";
        ctx.strokeText(t, p[0], p[1]);
        ctx.fillStyle = "rgba(165, 185, 255, 0.78)";
        ctx.fillText(t, p[0], p[1]);
      }
    }

    /** Katmanların (deepsky.js) çizerken kullandığı görünüm bilgisi. */
    const layers = [];
    function layerView(w, h) {
      const [ra0, dec0] = aladin.getRaDec();
      const s = tanScale(w, h);
      return {
        w, h, c: unit(ra0, dec0), radius: Math.atan(Math.hypot(w, h) / 2 / s) / R, fov: longFov(w, h),
        project, altaz, horizon: state.horizon, groundAlpha: state.groundAlpha,
      };
    }

    let lastKey = "", dirty = true;
    function frame() {
      if (state.horizon) { syncNav(); keepUpright(); }
      const [ra, dec] = aladin.getRaDec();
      const fov = aladin.getFov()[0];
      const w = el.clientWidth, h = el.clientHeight;
      const rot = aladin.getRotation();
      const key = `${ra.toFixed(5)},${dec.toFixed(5)},${fov.toFixed(4)},${rot.toFixed(3)},${w}x${h}`;
      if (key !== lastKey || dirty) {
        lastKey = key;
        dirty = false;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
          canvas.style.width = w + "px";
          canvas.style.height = h + "px";
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (state.lines) { drawLines(w, h); drawNames(w, h, longFov(w, h)); }
        if (layers.length) {                                             // derin gök simgeleri: yerin altında kalırsa yer örter
          const v = layerView(w, h);
          for (const fn of layers) {
            try { fn(ctx, v); } catch (e) { console.error("LichSky katmanı:", e); }
          }
        }
        if (state.horizon) { drawGround(w, h); drawCardinals(w, h); }
        state.onChange(api.view());
      }
      requestAnimationFrame(frame);
    }

    // gökyüzü dakikada ~0,25° döner: ufku dakikada bir güncelle
    setInterval(() => { state.now = new Date(); dirty = true; }, 30000);

    const api = {
      get place() { return state.place; },
      get horizon() { return state.horizon; },
      get lines() { return state.lines; },
      get groundAlpha() { return state.groundAlpha; },
      get now() { return state.now; },
      altaz, toRaDec, dirName,
      setHorizon(on) {
        state.horizon = !!on;
        setInertia(!state.horizon);   // yerden bakışta kaydırma eylemsizliği Aladin'in ekvator sürüklemesini sürdürürdü
        if (!on) aladin.setRotation(0);
        else { syncNav(); keepUpright(); }
        dirty = true;
      },
      /** Yerin örtücülüğü: 0 tamamen saydam, 1 opak. */
      setGround(alpha) {
        state.groundAlpha = Math.max(0, Math.min(1, +alpha || 0));
        dirty = true;
      },
      setLines(on) {
        state.lines = !!on;
        dirty = true;
      },
      setPlace(p, remember = true) {
        state.place = p;
        if (remember) try { localStorage.setItem("lichspec.place", JSON.stringify(p)); } catch (_) { /* gizli pencere */ }
        dirty = true;
      },
      /** Ufukta (yükseklik, yön) noktasına bak; fov: ekranın uzun kenarının göreceği açı. */
      look(alt, az, fov) {
        if (fov) aladin.setFoV(fovFor(fov));
        nav.alt = alt;
        nav.az = az;
        if (state.horizon) applyNav();
        else { const e = toRaDec(alt, az); aladin.gotoRaDec(e.ra, e.dec); }
        dirty = true;
      },
      /** Bakılan yön ve görüş alanı, durum satırı için. */
      view() {
        const [ra, dec] = aladin.getRaDec();
        const h = altaz(ra, dec);
        const az = state.horizon && nav.az != null && Math.abs(h.alt) >= 89.5 ? nav.az : h.az;   // başucunda son yön
        return { ra, dec, alt: h.alt, az, dir: dirName(az), fov: longFov() };
      },
      redraw() { dirty = true; },
      /** Gökyüzü tuvaline çizen katman ekle: fn(ctx, görünüm) her yeniden çizimde, yerden önce çağrılır. */
      addLayer(fn) { layers.push(fn); dirty = true; },
      /** Uzun kenarın gördüğü açı; uzun kenarda `deg` derece için Aladin'e verilecek görüş alanı. */
      longFov() { return longFov(); },
      fovFor(deg) { return fovFor(deg); },
      /** Testler için: yerden bakış sürüklemesi etkin mi; ufuk çizgisinin ekrandaki yüksekliği. */
      get altAzDrag() { return altAzDrag; },
      horizonY() { return horizonY(el.clientWidth, el.clientHeight); },
    };
    if (state.horizon) { setInertia(false); syncNav(); }
    requestAnimationFrame(frame);
    return api;
  }

  global.LichSky = { create, eq2hor, hor2eq, lst, gmst, posAngle, angSep, dirName, defaultPlace, fovFor: fovForBox };
})(window);
