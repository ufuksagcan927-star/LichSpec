/* LichSpec Gökyüzü — dünyadan bakış.
 *
 * Gökyüzü içeriden, gözlemcinin bulunduğu yerden görüldüğü gibi çizilir: stereografik izdüşüm
 * (planetaryum programlarının kullandığı), yukarısı her zaman başucu, aşağıda yer ve ufuk, ufukta
 * yönler (K, D, G, B), gökyüzünde takımyıldız çizgileri ve adları. Ufuk ve yön çizimi gözlemcinin
 * konumuna ve saatine göre hesaplanır.
 *
 * Aladin Lite'ın kendi çizimine dokunulmaz: takımyıldız çizgileri Aladin katmanı, yer/ufuk/yazılar
 * gökyüzünün üstünde tıklamayı geçiren ayrı bir tuvalde (canvas).
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
  function create(aladin, el, cons, names, opts = {}) {
    const state = {
      place: defaultPlace(),
      horizon: opts.horizon !== false,
      lines: opts.lines !== false,
      now: new Date(),
      onChange: opts.onChange || (() => {}),
    };

    // takımyıldız çizgileri: Aladin çizer (yer tuvalinin altında kalır)
    const lineLayer = A.graphicOverlay({ color: "rgba(150,175,255,0.5)", lineWidth: 1.2, name: "Takımyıldız çizgileri" });
    aladin.addOverlay(lineLayer);
    const polys = cons.lines.map((pl) => {
      const pts = [];
      for (let i = 0; i < pl.length; i += 2) pts.push([pl[i], pl[i + 1]]);
      return A.polyline(pts);
    });
    lineLayer.addFootprints ? lineLayer.addFootprints(polys) : polys.forEach((p) => lineLayer.add(p));
    if (!state.lines) lineLayer.hide();

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
    // değişir, yükseklik başucunda (90°) durur. Böylece başucundan geçerken görüntü ters dönmez
    // (Aladin'in kendi sürüklemesi ekvator koordinatlarında çalışır; başucunu aşınca "yukarısı"
    // 180° döner ve sürükleme yön değiştirip ileri geri sıçrar).
    const ALT_MIN = -60, ALT_MAX = 90;
    const nav = { alt: null, az: null, ra: null, dec: null };

    /** Aladin'in merkezinden bakış yönünü günceller; başucunda yön açısı tanımsız olduğundan son değer kalır. */
    function syncNav() {
      const [ra, dec] = aladin.getRaDec();
      const h = altaz(ra, dec);
      nav.alt = h.alt;
      if (h.alt < 89.5 || nav.az == null) nav.az = h.az;
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

    // Aladin sürüklemeyi wasm.goFromTo(önceki x, y, şimdiki x, y) ile yapar (aladin-lite 3.6.5, sürüm
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
        nav.az -= ((x2 - x1) * k) / Math.max(0.05, Math.cos(Math.min(ALT_MAX, nav.alt) * R));
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

    const projectHor = (alt, az) => { const e = toRaDec(alt, az); return project(e.ra, e.dec); };

    /** Üç noktadan geçen çember [cx, cy, r]; noktalar bir doğru üzerindeyse null. */
    function circle3(a, b, c) {
      const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      if (Math.abs(d) < 1e-9) return null;
      const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
      const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
      const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
      return [ux, uy, Math.hypot(a[0] - ux, a[1] - uy)];
    }

    /**
     * Yer ve ufuk. Stereografik izdüşümde ufuk (gökyüzünde bir büyük çember) ekranda tam bir çember ya da
     * doğrudur: bakılan yöndeki üç ufuk noktasından çizilir, bu yüzden ufuk her yakınlaşmada pürüzsüzdür ve
     * ufka tam yatay bakarken de (çember doğruya döner) yer doğru tarafta kalır. Yer opaktır.
     */
    function drawGround(w, h) {
      const az0 = nav.az;
      const p1 = projectHor(0, az0 - 40), p2 = projectHor(0, az0), p3 = projectHor(0, az0 + 40);
      const g = projectHor(-5, az0);                                     // kesin yerde bir nokta
      if (!p1 || !p2 || !p3 || !g) return;
      const BIG = 1e6;
      const c = circle3(p1, p2, p3);
      const horizonPath = () => {
        ctx.beginPath();
        if (c && c[2] < 2e5) ctx.arc(c[0], c[1], c[2], 0, 2 * Math.PI);
        else {
          let dx = p3[0] - p1[0], dy = p3[1] - p1[1];
          const n = Math.hypot(dx, dy) || 1;
          dx /= n; dy /= n;
          ctx.moveTo(p2[0] - dx * BIG, p2[1] - dy * BIG);
          ctx.lineTo(p2[0] + dx * BIG, p2[1] + dy * BIG);
        }
      };
      ctx.beginPath();
      if (c && c[2] < 2e5) {
        const inside = Math.hypot(g[0] - c[0], g[1] - c[1]) < c[2];
        if (!inside) ctx.rect(-BIG, -BIG, 2 * BIG, 2 * BIG);           // yer çemberin dışı (gökyüzüne bakılıyor)
        ctx.arc(c[0], c[1], c[2], 0, 2 * Math.PI);
      } else {
        // ufka tam yatay bakılıyor: ufuk bir doğru, yer onun g tarafındaki yarım düzlem
        let dx = p3[0] - p1[0], dy = p3[1] - p1[1];
        const n = Math.hypot(dx, dy) || 1;
        dx /= n; dy /= n;
        let nx = -dy, ny = dx;
        if ((g[0] - p2[0]) * nx + (g[1] - p2[1]) * ny < 0) { nx = -nx; ny = -ny; }
        ctx.moveTo(p2[0] - dx * BIG, p2[1] - dy * BIG);
        ctx.lineTo(p2[0] + dx * BIG, p2[1] + dy * BIG);
        ctx.lineTo(p2[0] + dx * BIG + nx * BIG, p2[1] + dy * BIG + ny * BIG);
        ctx.lineTo(p2[0] - dx * BIG + nx * BIG, p2[1] - dy * BIG + ny * BIG);
        ctx.closePath();
      }
      ctx.fillStyle = "rgb(11, 17, 14)";
      ctx.fill("evenodd");
      // ufuk çizgisi: yumuşak bir parıltı + ince çizgi
      horizonPath();
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

    function drawNames(w, h, fov) {
      const maxRank = fov > 140 ? 1 : fov > 70 ? 2 : 3;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `500 ${fov > 100 ? 11 : 12}px system-ui, sans-serif`;
      for (const [abbr, ra, dec, rank] of cons.labels) {
        if (rank > maxRank) continue;
        if (state.horizon && altaz(ra, dec).alt < -2) continue;
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
        if (state.lines) drawNames(w, h, fov);
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
      get now() { return state.now; },
      altaz, toRaDec, dirName,
      setHorizon(on) {
        state.horizon = !!on;
        setInertia(!state.horizon);   // yerden bakışta kaydırma eylemsizliği Aladin'in ekvator sürüklemesini sürdürürdü
        if (!on) aladin.setRotation(0);
        else { syncNav(); keepUpright(); }
        dirty = true;
      },
      setLines(on) {
        state.lines = !!on;
        on ? lineLayer.show() : lineLayer.hide();
        dirty = true;
      },
      setPlace(p, remember = true) {
        state.place = p;
        if (remember) try { localStorage.setItem("lichspec.place", JSON.stringify(p)); } catch (_) { /* gizli pencere */ }
        dirty = true;
      },
      /** Ufukta (yükseklik, yön) noktasına bak. */
      look(alt, az, fov) {
        if (fov) aladin.setFoV(fov);
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
        const az = state.horizon && nav.az != null && h.alt >= 89.5 ? nav.az : h.az;   // başucunda son yön
        return { ra, dec, alt: h.alt, az, dir: dirName(az), fov: aladin.getFov()[0] };
      },
      redraw() { dirty = true; },
      /** Testler için: yerden bakış sürüklemesi etkin mi. */
      get altAzDrag() { return altAzDrag; },
    };
    if (state.horizon) { setInertia(false); syncNav(); }
    requestAnimationFrame(frame);
    return api;
  }

  global.LichSky = { create, eq2hor, hor2eq, lst, gmst, posAngle, angSep, dirName, defaultPlace };
})(window);
