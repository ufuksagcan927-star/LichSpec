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

    /** Görünümü başucu yukarıda kalacak biçimde döndürür (ufuk açıkken). */
    function keepUpright(ra, dec) {
      let want = 0;
      if (state.horizon) {
        const z = { ra: LST(), dec: state.place.lat };            // başucu noktası
        if (angSep(ra, dec, z.ra, z.dec) < 0.3) return;            // tam başucunda yön tanımsız
        want = -posAngle(ra, dec, z.ra, z.dec);
      }
      const cur = aladin.getRotation();
      let d = norm360(want - cur + 180) - 180;
      if (Math.abs(d) > 0.02) aladin.setRotation(norm360(want + 180) - 180);
    }

    function project(ra, dec) {
      const p = aladin.world2pix(ra, dec);
      if (!p) return null;
      const x = p[0], y = p[1];
      if (!isFinite(x) || !isFinite(y)) return null;
      return [Math.max(-2e5, Math.min(2e5, x)), Math.max(-2e5, Math.min(2e5, y))];
    }

    function drawGround(w, h, centerAlt) {
      const pts = [];
      for (let az = 0.5; az < 360; az += 2) {
        const e = toRaDec(0, az);
        const p = project(e.ra, e.dec);
        if (p) pts.push(p);
      }
      if (pts.length < 8) return;
      ctx.beginPath();
      // merkez gökyüzündeyse yer ufuk çemberinin dışıdır (stereografik izdüşümde ters kutup sonsuzda)
      if (centerAlt > 0) ctx.rect(-3e5, -3e5, 6e5, 6e5);
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = "rgba(12, 20, 16, 0.86)";
      ctx.fill("evenodd");
      // ufuk çizgisi: yumuşak bir parıltı + ince çizgi
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
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
      const [ra, dec] = aladin.getRaDec();
      const fov = aladin.getFov()[0];
      const w = el.clientWidth, h = el.clientHeight;
      if (state.horizon) keepUpright(ra, dec);
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
        const centerAlt = altaz(ra, dec).alt;
        if (state.lines) drawNames(w, h, fov);
        if (state.horizon) { drawGround(w, h, centerAlt); drawCardinals(w, h); }
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
        if (!on) aladin.setRotation(0);
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
        const e = toRaDec(alt, az);
        aladin.gotoRaDec(e.ra, e.dec);
        if (fov) aladin.setFoV(fov);
        dirty = true;
      },
      /** Bakılan yön ve görüş alanı, durum satırı için. */
      view() {
        const [ra, dec] = aladin.getRaDec();
        const h = altaz(ra, dec);
        return { ra, dec, alt: h.alt, az: h.az, dir: dirName(h.az), fov: aladin.getFov()[0] };
      },
      redraw() { dirty = true; },
    };
    requestAnimationFrame(frame);
    return api;
  }

  global.LichSky = { create, eq2hor, hor2eq, lst, gmst, posAngle, angSep, dirName, defaultPlace };
})(window);
