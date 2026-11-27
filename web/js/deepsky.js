/*
 * LichSpec derin gök — galaksiler, bulutsular, yıldız kümeleri, kara delikler ve nötron yıldızları.
 *
 * data/deep_sky.json: OpenNGC'nin bütün NGC/IC cisimleri ve eki (Messier'ler, Macellan Bulutları…),
 * Samanyolu süpernova kalıntıları (Green 2019), Barnard karanlık bulutsuları ve Sharpless HII bölgeleri;
 * uzaklık, yaş, kütle gibi değerler yayımlanmış kataloglardan (kaynakları kartta yazar).
 * data/compact.json: ATNF Pulsar Kataloğu, McGill magnetarları, BlackCAT ve WATCHDOG kara delik
 * çiftleri ve kaynaklarıyla elle yazılmış ünlüler (Sgr A*, M87*, Kuğu X-1, Gaia BH1–3…).
 * İkisini de tools/build_sky_objects.py üretir.
 *
 * Bu dosya simgeleri gökyüzü tuvaline çizer (sky.js katmanı), tıklanan simgeyi bulur, arama kayıtlarını
 * ve kart bilgilerini hazırlar, çözülen fotoğrafa düşen cisimleri listeler. Hiçbir değer uydurulmaz:
 * kartta yalnızca katalogda olan alanlar yazılır; hesaplananlar "hesaplandı" diye işaretlenir.
 */
(function (global) {
  "use strict";
  const R = Math.PI / 180;
  const LY_PER_PC = 3.26156;
  const L_SUN = 3.828e33;          // erg/s
  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- türler
  const TYPE = {
    G: "Galaksi", GPair: "Galaksi çifti", GTrpl: "Galaksi üçlüsü", GGroup: "Galaksi grubu",
    OCl: "Açık yıldız kümesi", GCl: "Küresel yıldız kümesi", "Cl+N": "Bulutsulu yıldız kümesi", "*Ass": "Yıldız birliği",
    PN: "Gezegenimsi bulutsu", HII: "HII bölgesi (salma bulutsusu)", EmN: "Salma bulutsusu", RfN: "Yansıma bulutsusu",
    Neb: "Bulutsu", SNR: "Süpernova kalıntısı", DrkN: "Karanlık bulutsu", "*": "Yıldız", "**": "Çift yıldız",
    Ast: "Yıldız öbeği (asterizm)",
  };
  const KIND = {
    bh: "Kara delik", smbh: "Süper kütleli kara delik", psr: "Pulsar (nötron yıldızı)", mag: "Magnetar (nötron yıldızı)",
    ns: "Nötron yıldızı", merger: "Nötron yıldızı birleşmesi",
  };
  /** Simge ve renk grubu. */
  function group(o) {
    if (o.kind === "compact") return o.k === "ns" ? "psr" : o.k;
    switch (o.t) {
      case "G": case "GPair": case "GTrpl": case "GGroup": return "gal";
      case "OCl": case "*Ass": case "Ast": case "*": case "**": return "ocl";
      case "GCl": return "gcl";
      case "PN": return "pn";
      case "RfN": return "rfn";
      case "SNR": return "snr";
      case "DrkN": return "drk";
      default: return "neb";                                    // HII, EmN, Neb, Cl+N
    }
  }
  const COLOR = {
    gal: "255,165,125", ocl: "255,226,120", gcl: "255,196,80", pn: "110,230,170", neb: "255,112,160", rfn: "130,180,255",
    snr: "200,145,255", drk: "175,180,200", bh: "255,150,60", smbh: "255,205,90", psr: "90,220,255", mag: "255,95,220",
    merger: "255,215,90",
  };
  const GROUP_NAME = {
    gal: "galaksi", ocl: "açık küme", gcl: "küresel küme", pn: "gezegenimsi bulutsu", neb: "salma bulutsusu / HII bölgesi",
    rfn: "yansıma bulutsusu", snr: "süpernova kalıntısı", drk: "karanlık bulutsu", bh: "kara delik", smbh: "süper kütleli kara delik",
    psr: "pulsar / nötron yıldızı", mag: "magnetar", merger: "nötron yıldızı birleşmesi",
  };

  const SHORT = {
    gal: "galaksi", ocl: "açık küme", gcl: "küresel küme", pn: "gezegenimsi bulutsu", neb: "bulutsu", rfn: "yansıma bulutsusu",
    snr: "süpernova kalıntısı", drk: "karanlık bulutsu", bh: "kara delik", smbh: "kara delik", psr: "pulsar", mag: "magnetar",
    ns: "nötron yıldızı", merger: "birleşme",
  };
  /** Listelerdeki kısa tür adı. */
  const shortKind = (o) => SHORT[o.kind === "compact" ? o.k : o._g] || o._g;

  // ---------------------------------------------------------------- veri
  let DSO = [], COMPACT = [], ALL = [], SOURCES = {}, META = {};
  let ready = false, loading = null;
  const listeners = [];

  /** OpenNGC adı → okunur ad: NGC0224 → NGC 224, IC0434 → IC 434, Mel022 → Mel 22 (build_sky_objects.short). */
  function shortId(n) {
    const m = /^(NGC|IC|Mel|HCG|PGC|UGC|ESO|MWSC|Cl|C|B|H)(0*)(\d.*)$/.exec(n || "");
    if (!m) return n;
    if (m[1] === "ESO") return "ESO " + n.slice(3);
    return `${m[1]} ${m[3]}`;
  }
  function unit(ra, dec) {
    const a = ra * R, d = dec * R;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  }

  /** Görüş alanına göre hangi cisimlerin çizileceği: küçük puan = önemli. */
  function score(o) {
    if (o.kind === "compact") {
      if (o.note || o.k === "smbh" || o.k === "merger") return 1;
      if (o.k === "bh") return o.cand ? 10 : 7.5;
      if (o.k === "mag") return 9;
      if (o.k === "ns") return 9;
      return 11.8;                                              // pulsarlar
    }
    if (o.M) return 0;
    if (o.tr) return 1;
    if (o.C) return 2.5;
    const mag = o.v ?? o.b, a = o.a || 0;
    if (mag != null) return Math.max(3, mag - 1.5 * Math.log10(Math.max(1, a)));
    return Math.max(4, 14.5 - 2.5 * Math.log10(Math.max(1, a)));   // parlaklığı yok: boyuna göre
  }
  const maxScore = (fov) => (fov > 100 ? 2.6 : fov > 60 ? 4 : fov > 35 ? 7 : fov > 18 ? 9 : fov > 9 ? 11 : fov > 4 ? 13 : fov > 1.5 ? 15 : 99);

  function title(o) {
    if (o.kind === "compact") return o.tr || o.id;
    return o.tr || (o.M ? `M${o.M}` : shortId(o.id));
  }
  /** Gökyüzünde yazılan kısa ad. */
  function label(o) {
    if (o.kind === "compact") return o.tr && o.tr.length <= 22 ? o.tr : o.id.replace(/^PSR /, "");
    if (o.M) return o.tr && o.tr.length <= 18 ? (o.tr.startsWith(`M${o.M}`) ? o.tr : `M${o.M} ${o.tr}`) : `M${o.M}`;
    if (o.tr && o.tr.length <= 24) return o.tr;
    return shortId(o.id);
  }
  /** Kartın başlığı dışındaki katalog adları. */
  function catalogIds(o) {
    if (o.kind === "compact") return [o.tr ? o.id : null].filter(Boolean);
    const ids = [o.M ? `M${o.M}` : null, shortId(o.id), ...(o.ngc || []), ...(o.ic || []), o.C ? `C ${o.C}` : null, ...(o.ids || [])];
    const t = title(o), seen = new Set();
    return ids.filter((x) => x && x !== t && !seen.has(x) && seen.add(x));
  }

  function prepare(o) {
    o.dec = o.de;
    o._u = unit(o.ra, o.de);
    o._g = group(o);
    o._s = score(o);
    o._title = title(o);
    o._label = label(o);
    return o;
  }

  function load() {
    if (loading) return loading;
    loading = Promise.all([fetch("data/deep_sky.json").then((r) => r.json()), fetch("data/compact.json").then((r) => r.json())])
      .then(([a, b]) => {
        const cols = a.columns;
        DSO = a.objects.map((row) => {
          const o = { kind: "dso" };
          cols.forEach((c, i) => { if (row[i] != null) o[c] = row[i]; });
          const ext = row[cols.length];
          if (ext && typeof ext === "object") Object.assign(o, ext);
          return prepare(o);
        });
        COMPACT = b.objects.map((x) => prepare({ ...x, kind: "compact" }));
        SOURCES = Object.assign({}, a.meta && a.meta.sources, b.meta && b.meta.sources);
        META = { atnf: b.meta && b.meta.atnf_version };
        ALL = DSO.concat(COMPACT).sort((x, y) => x._s - y._s);
        const hosts = new Map(DSO.map((o) => [o.id, o]));
        for (const c of COMPACT) if (c.host && hosts.has(c.host)) c._host = hosts.get(c.host);
        ready = true;
        listeners.splice(0).forEach((f) => { try { f(); } catch (_) { /* dinleyici hatası */ } });
        return { dso: DSO.length, compact: COMPACT.length };
      });
    return loading;
  }
  function onReady(f) { if (ready) f(); else listeners.push(f); }

  // ---------------------------------------------------------------- çizim
  let drawn = [];                  // son karede çizilenler: tıklama için
  let selected = null;
  const state = { on: true };

  /** Bir noktanın ekrandaki kuzey ve doğu birim vektörleri (gökyüzü ekranda aynalı olabilir). */
  function axes(v, o, p) {
    const k = 0.02;
    const n = v.project(o.ra, Math.min(89.999, o.de + k)), e = v.project(o.ra + k / Math.max(0.02, Math.cos(o.de * R)), o.de);
    if (!n || !e) return null;
    const nx = n[0] - p[0], ny = n[1] - p[1], ex = e[0] - p[0], ey = e[1] - p[1];
    const ln = Math.hypot(nx, ny) || 1, le = Math.hypot(ex, ey) || 1;
    return { n: [nx / ln, ny / ln], e: [ex / le, ey / le], pxPerDeg: ln / k };
  }

  function strokeStyle(ctx, g, alpha) { ctx.strokeStyle = `rgba(${COLOR[g]},${alpha})`; }

  /** Simge: x, y merkez; r piksel yarıçap (gerçek boyut ya da en küçük simge boyu). */
  function drawSymbol(ctx, o, x, y, r, ax) {
    const g = o._g;
    ctx.save();
    ctx.lineWidth = 1.4;
    strokeStyle(ctx, g, 0.92);
    ctx.fillStyle = `rgba(${COLOR[g]},0.95)`;
    ctx.beginPath();
    switch (g) {
      case "gal": {
        let rx = r, ry = Math.max(2.5, r * Math.min(1, (o.bx || o.a || 1) / (o.a || 1)));
        if (!o.a) ry = rx * 0.55;
        let rot = 0;
        if (ax && o.pa != null) {
          const pa = o.pa * R;
          const ux = ax.n[0] * Math.cos(pa) + ax.e[0] * Math.sin(pa), uy = ax.n[1] * Math.cos(pa) + ax.e[1] * Math.sin(pa);
          rot = Math.atan2(uy, ux);
        } else if (ax) rot = Math.atan2(ax.n[1], ax.n[0]);
        ctx.ellipse(x, y, rx, ry, rot, 0, 2 * Math.PI);
        ctx.stroke();
        break;
      }
      case "ocl":
        ctx.setLineDash([3, 3]);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
        break;
      case "gcl":
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
        ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
        ctx.stroke();
        break;
      case "pn":
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * r, y + dy * r); ctx.lineTo(x + dx * (r + 4), y + dy * (r + 4)); }
        ctx.stroke();
        break;
      case "neb": case "rfn": case "drk": {
        if (g === "drk") ctx.setLineDash([4, 3]);
        let q = r;
        if (r > 12) {                                           // büyük bulutsu: gerçek boyu soluk bir halka, ortada küçük simge
          strokeStyle(ctx, g, 0.38);
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          strokeStyle(ctx, g, 0.92);
          q = 5;
        }
        ctx.rect(x - q, y - q, 2 * q, 2 * q);
        ctx.stroke();
        break;
      }
      case "snr":
        ctx.setLineDash([6, 3]);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, 2 * Math.PI);
        ctx.fill();
        break;
      case "bh": case "smbh": {
        const ring = g === "smbh" ? 9 : 7;
        ctx.arc(x, y, ring + 3, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${COLOR[g]},0.16)`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, ring - 2, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(0,0,0,0.92)";
        ctx.fill();
        ctx.beginPath();
        if (o.cand) ctx.setLineDash([3, 2]);
        ctx.lineWidth = 2;
        ctx.arc(x, y, ring, 0, 2 * Math.PI);
        ctx.stroke();
        break;
      }
      case "psr": case "mag": {
        ctx.arc(x, y, g === "mag" ? 2.8 : 2.3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.lineWidth = 1.2;
        const rays = g === "mag" ? [0, 45, 90, 135, 180, 225, 270, 315] : [30, 210];
        for (const d of rays) {
          const c = Math.cos(d * R), s = Math.sin(d * R), l = g === "mag" ? (d % 90 ? 4.5 : 7) : 8;
          ctx.moveTo(x + c * 3.5, y - s * 3.5);
          ctx.lineTo(x + c * l, y - s * l);
        }
        ctx.stroke();
        if (o.k === "ns") { ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.stroke(); }
        break;
      }
      case "merger": {
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4, l = i % 2 ? 3 : 8;
          ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * l, y + Math.sin(a) * l);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      default:
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
    }
    ctx.restore();
    return g === "pn" ? r + 4 : g === "bh" || g === "smbh" ? 10 : g === "merger" ? 8 : g === "psr" || g === "mag" ? 7 : r;
  }

  const MIN_R = { gal: 5, ocl: 6, gcl: 5.5, pn: 4, neb: 5.5, rfn: 5.5, snr: 6, drk: 5.5 };

  /**
   * sky.js katmanı. v: { w, h, c (bakış merkezi birim vektörü), radius (merkezden köşeye açı, derece),
   * fov (uzun kenar açısı), project(ra, dec), altaz(ra, dec), horizon, groundAlpha }
   */
  function layer(ctx, v) {
    drawn = [];
    if (!ready || !state.on) return;
    const lim = maxScore(v.fov), labLim = Math.min(lim - 2, lim > 14 ? 13 : lim);
    const cosR = Math.cos(Math.min(89, v.radius + 0.5) * R);
    const maxDraw = 700, maxLabels = v.w * v.h > 9e5 ? 140 : 80;
    const boxes = [];
    let nLab = 0;
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";                                     // sky.js takımyıldız adlarını ortalıyor
    ctx.setLineDash([]);

    function drawOne(o) {
      const c = v.c, u = o._u;
      if (c[0] * u[0] + c[1] * u[1] + c[2] * u[2] < cosR) return;
      if (v.horizon && v.groundAlpha > 0.85 && v.altaz(o.ra, o.de).alt < -0.5) return;   // opak yerin altında
      const p = v.project(o.ra, o.de);
      if (!p || p[0] < -60 || p[1] < -60 || p[0] > v.w + 60 || p[1] > v.h + 60) return;
      const g = o._g;
      let r = MIN_R[g] || 6, ax = null;
      if (o.kind === "dso") {
        ax = g === "gal" || (o.a && o.a > 3) ? axes(v, o, p) : null;
        if (ax && o.a) r = Math.min(4000, Math.max(r, ((o.a / 2) / 60) * ax.pxPerDeg));
      }
      const hr = drawSymbol(ctx, o, p[0], p[1], r, ax);
      drawn.push({ o, x: p[0], y: p[1], r: hr });
      if (o === selected) {
        ctx.beginPath();
        if (hr <= 30) ctx.arc(p[0], p[1], hr + 6, 0, 2 * Math.PI);
        else for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {   // büyük cisim: ortasına nişangâh
          ctx.moveTo(p[0] + dx * 9, p[1] + dy * 9);
          ctx.lineTo(p[0] + dx * 20, p[1] + dy * 20);
        }
        ctx.strokeStyle = "rgba(25, 201, 212, 0.95)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // ad: önemli olanlar, birbirinin üstüne binmeden
      if ((o._s > labLim && o !== selected) || nLab >= maxLabels) return;
      const t = o._label, tw = ctx.measureText(t).width;
      // küçük simgenin sağına; büyük cismin (halkası 30 pikselden büyük) adı ortasının hemen sağ üstüne
      const big = hr > 30, lx = p[0] + (big ? 10 : hr + 4), ly = p[1] - (big ? 14 : 0);
      const box = [lx - 2, ly - 7, lx + tw + 2, ly + 7];
      if (box[2] < 0 || box[0] > v.w || box[3] < 0 || box[1] > v.h) return;
      if (o !== selected && boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) return;
      boxes.push(box);
      nLab++;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(4, 6, 14, 0.8)";
      ctx.strokeText(t, lx, ly);
      ctx.fillStyle = `rgba(${COLOR[g]},0.95)`;
      ctx.fillText(t, lx, ly);
    }

    if (selected) drawOne(selected);                            // seçili cisim her zaman (adıyla)
    for (const o of ALL) {
      if (o._s > lim || drawn.length >= maxDraw) break;
      if (o !== selected) drawOne(o);
    }
    ctx.restore();
  }

  /** Ekran noktasındaki cisim (son karede çizilenlerden). */
  function hit(x, y) {
    let best = null, bd = Infinity;
    for (const d of drawn) {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist > Math.max(9, Math.min(d.r, 45))) continue;
      const w = dist - (d.o.kind === "compact" ? 3 : 0);       // üst üste binince küçük/kompakt olan
      if (w < bd) { bd = w; best = d; }
    }
    return best ? { obj: best.o, dist: Math.hypot(best.x - x, best.y - y) } : null;
  }

  // ---------------------------------------------------------------- arama
  const TYPE_WORDS = {
    gal: ["galaksi", "gökada", "galaxy"], ocl: ["açık küme", "yıldız kümesi"], gcl: ["küresel küme", "yıldız kümesi"],
    pn: ["gezegenimsi bulutsu", "bulutsu", "nebula"], neb: ["bulutsu", "nebula"], rfn: ["bulutsu", "nebula"],
    snr: ["süpernova kalıntısı", "süpernova", "bulutsu"], drk: ["karanlık bulutsu", "bulutsu"],
    bh: ["kara delik", "black hole"], smbh: ["kara delik", "süper kütleli kara delik", "black hole"],
    psr: ["pulsar", "nötron yıldızı", "neutron star"], ns: ["nötron yıldızı", "neutron star"], mag: ["magnetar", "nötron yıldızı", "neutron star"],
    merger: ["nötron yıldızı", "kilonova"],
  };
  function searchItems() {
    if (!ready) return [];
    const items = [];
    for (const o of DSO) {
      const keys = [o.tr, ...(o.en || []), shortId(o.id), ...(o.ngc || []), ...(o.ic || [])];
      if (o.M) keys.push(`M${o.M}`, `Messier ${o.M}`);
      if (o.C) keys.push(`C ${o.C}`, `Caldwell ${o.C}`);
      for (const x of o.ids || []) {
        keys.push(x);
        const sh = /^Sh2-(\d+)$/.exec(x) || /^Sh2-(\d+)$/.exec(o.id);
        if (sh) keys.push(`Sharpless ${sh[1]}`);
        const b = /^B (\d+\w*)$/.exec(x);
        if (b) keys.push(`Barnard ${b[1]}`);
      }
      const sh = /^Sh2-(\d+)$/.exec(o.id), b = /^B (\d+\w*)$/.exec(o.id);
      if (sh) keys.push(`Sharpless ${sh[1]}`);
      if (b) keys.push(`Barnard ${b[1]}`);
      const famous = o.M || o.tr;
      if (famous) keys.push(...TYPE_WORDS[o._g]);
      // yıldızlarla aynı ölçek (adı olan yıldız 12 − kadir): eşit eşleşmede ünlü yıldız ve Messier'ler önce
      const rank = o.M ? 8 : o.tr ? 2 : o.C ? 1 : (o.en && o.en.length) ? 0 : -2 - Math.min(16, o.v ?? o.b ?? 15);
      items.push({ kind: "deep", obj: o, keys: keys.filter(Boolean), rank });
    }
    for (const o of COMPACT) {
      const keys = [o.id, o.tr, ...(o.alias || [])];
      if (o.note || o.k === "smbh") keys.push(...TYPE_WORDS[o.k === "ns" ? "ns" : o._g]);
      if (o.id.startsWith("PSR ")) keys.push(o.id.slice(4));
      const rank = o.note || o.k === "smbh" ? 8 : o.k === "bh" ? (o.cand ? -4 : 1) : o.k === "mag" ? 0 : -9;
      items.push({ kind: "deep", obj: o, keys: keys.filter(Boolean), rank });
    }
    return items;
  }

  // ---------------------------------------------------------------- biçim
  const fmt = (x, nd = 1) => (x == null || !isFinite(x) ? "—" : Number(x).toLocaleString("tr-TR", { minimumFractionDigits: nd, maximumFractionDigits: nd }));
  /** n anlamlı basamağa yuvarla. */
  const sig = (x, n = 3) => (x === 0 || !isFinite(x) ? x : +x.toPrecision(n));
  const fmtSig = (x, n = 3) => sig(x, n).toLocaleString("tr-TR", { maximumFractionDigits: 6 });
  const SUPS = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  function sci(x, n = 2) {
    if (x == null || !isFinite(x)) return "—";
    if (x === 0) return "0";
    const e = Math.floor(Math.log10(Math.abs(x)));
    if (e >= -2 && e <= 5) return fmtSig(x, n);
    const m = x / 10 ** e;
    return `${fmt(m, n - 1)} × 10${String(e).replace(/./g, (c) => SUPS[c])}`;
  }
  function fmtLy(ly) {
    if (ly >= 1e9) return `${fmtSig(ly / 1e9, 3)} milyar ışık yılı`;
    if (ly >= 1e6) return `${fmtSig(ly / 1e6, 3)} milyon ışık yılı`;
    if (ly >= 1e4) return `${fmtSig(ly, 3)} ışık yılı`;
    return `${fmtSig(ly, ly < 100 ? 2 : 3)} ışık yılı`;
  }
  function fmtYears(y) {
    if (y >= 1e9) return `${fmtSig(y / 1e9, 3)} milyar yıl`;
    if (y >= 1e6) return `${fmtSig(y / 1e6, 3)} milyon yıl`;
    if (y >= 1e3) return `${fmtSig(y / 1e3, 3)} bin yıl`;
    return `${fmtSig(y, 3)} yıl`;
  }
  function fmtMass(m) {
    if (m >= 1e9) return `${fmtSig(m / 1e9, 3)} milyar`;
    if (m >= 1e6) return `${fmtSig(m / 1e6, 3)} milyon`;
    return fmtSig(m, m >= 100 ? 3 : 3);
  }
  /** Schwarzschild yarıçapı: "≈ 63 km", "≈ 12,7 milyon km (0,085 AU)", "≈ 130 AU (Güneş–Dünya uzaklığının 130 katı)". */
  function fmtHorizon(d) {
    if (d.rs_au >= 0.5) return `≈ ${fmtSig(d.rs_au, 2)} AU (Güneş–Dünya uzaklığının ${fmtSig(d.rs_au, 2)} katı)`;
    if (d.rs_km >= 1e6) return `≈ ${fmtSig(d.rs_km / 1e6, 3)} milyon km (${fmtSig(d.rs_au, 2)} AU)`;
    return `≈ ${fmtSig(d.rs_km, 2)} km`;
  }
  function fmtAngle(arcmin) {
    if (arcmin >= 60) return `${fmtSig(arcmin / 60, 3)}°`;
    if (arcmin >= 1) return `${fmtSig(arcmin, 3)}′`;
    return `${fmtSig(arcmin * 60, 3)}″`;
  }
  /** Kaynak anahtarı → kısa ad ve tam künye. */
  function source(key) {
    const full = SOURCES[key] || key || "";
    if (key === "hubble") return { short: "Hubble yasasıyla tahmin", full };
    if (key === "lit") return { short: "yayın", full };
    const short = full.split(/,| \(/)[0];
    return { short, full };
  }

  const HUBBLE = [
    [/^dE|^dSph|^dS0/, "cüce eliptik / küresel galaksi"], [/^E/, "eliptik galaksi"], [/^S0|^SA0|^SB0|^SAB0/, "mercimek (lentiküler) galaksi"],
    [/^SB[abcd]|^SBm/, "çubuklu sarmal galaksi"], [/^SAB/, "zayıf çubuklu sarmal galaksi"], [/^S[abcd]|^SA[abcd]/, "sarmal galaksi"],
    [/^Sm|^SAm/, "Macellan türü sarmal galaksi"], [/^I|^Im|^IB|^IAB|^dIrr/, "düzensiz galaksi"],
  ];
  function hubbleName(h) {
    if (!h) return null;
    for (const [re, n] of HUBBLE) if (re.test(h)) return n;
    return null;
  }
  const BINCOMP = {
    MS: "anakol yıldızı", NS: "nötron yıldızı", CO: "karbon-oksijen beyaz cüce", ONeMg: "oksijen-neon-magnezyum beyaz cüce",
    He: "helyum beyaz cüce", UL: "çok hafif bir yoldaş (≲ 0,08 Güneş kütlesi) ya da gezegen",
    HeT: "helyum beyaz cüce (üçlü sistem)", ULT: "çok hafif yoldaş (üçlü sistem)",
  };
  function companion(c) {
    if (!c) return null;
    const parts = c.split(",").map((x) => {
      const unsure = /\(\?\)/.test(x), k = x.replace(/\(\?\)/, "").trim();
      return BINCOMP[k] ? BINCOMP[k] + (unsure ? " (belirsiz)" : "") : null;
    }).filter(Boolean);
    return parts.length ? parts.join(" ya da ") : c;            // ATNF kodu değilse tayf türü / açıklama
  }
  const PSR_TYPE = {
    HE: "radyo dışında X ya da gama ışınında da atım veriyor", NRAD: "radyoda atım görülmüyor",
    AXP: "anormal X-ışını pulsarı (magnetar)", RRAT: "ara sıra tek tek atım veriyor (RRAT)",
    XINS: "yalnızca yüzeyinin ısıl X-ışınıyla parlayan yalnız nötron yıldızı",
  };
  function psrTypes(t) {
    return (t || "").split(",").map((x) => { const k = x.replace(/\(\?\)/, ""); return PSR_TYPE[k] ? PSR_TYPE[k] + (x.includes("(?)") ? " (belirsiz)" : "") : null; }).filter(Boolean);
  }
  const ASSOC = { SNR: "süpernova kalıntısı", PWN: "pulsar rüzgârı bulutsusu", GC: "küresel küme", OC: "açık küme", EXGAL: "başka galaksi", GRS: "gama ışını kaynağı", XRS: "X-ışını kaynağı", OPT: "görünür ışıkta karşılığı" };
  function associations(a) {
    const out = [];
    for (const x of (a || "").split(",")) {
      const m = /^([A-Z]+):(.+)$/.exec(x.trim());
      if (!m || !ASSOC[m[1]]) continue;
      const name = m[2].replace(/_/g, " ").replace(/\(\?\)$/, " (?)");
      const nm = m[1] === "EXGAL" ? ({ LMC: "Büyük Macellan Bulutu", SMC: "Küçük Macellan Bulutu" }[name] || name) : name;
      out.push({ kind: m[1], text: `${ASSOC[m[1]]}: ${nm}` });
    }
    return out;
  }
  const SNR_TYPE = { S: "kabuk (genişleyen bir halka)", F: "dolu (ortadaki pulsarın rüzgârıyla dolu bulutsu)", C: "bileşik (kabuk ve ortada pulsar rüzgârı)" };
  const DMETH = { TRGB: "kırmızı dev kolunun ucu", Cep: "Sefeid değişenleri", TF: "Tully–Fisher bağıntısı", SN: "süpernova", SBF: "yüzey parlaklığı dalgalanması", mem: "grup üyeliği", h: "Hubble yasası", RR: "RR Lyrae yıldızları", PNLF: "gezegenimsi bulutsu ışınım işlevi", txt: "yayın", BS: "en parlak yıldızlar", FP: "temel düzlem", maser: "su maseri", GCLF: "küresel kümeler", sbf: "yüzey parlaklığı dalgalanması" };
  const DIST_KIND = { px: "radyo / optik paralaks", ind: "bağımsız ölçüm (ATNF)", dm: "dağılma ölçüsünden, YMW16 elektron modeli (kaba)", atnf: "ATNF" };

  /** Türetilmiş değerler (kart ve anlatım için). */
  function derive(o) {
    const d = {};
    if (o.d) {
      d.pc = o.d;
      d.ly = o.d * LY_PER_PC;
      if (o.d_e) d.ly_e = o.d_e * LY_PER_PC;
    }
    if (o.kind === "dso") {
      d.type = TYPE[o.t] || o.t;
      d.hub = hubbleName(o.hub);
      if (d.ly && o.a) d.size_ly = d.ly * (o.a / 60) * R;
      if (o.rv != null && Math.abs(o.rv) > 600) d.z = o.rv / 299792.458;
      d.src = o.ds ? source(o.ds) : null;
    } else {
      d.type = KIND[o.k] || o.k;
      if (o.k === "psr" && o.P && o.P < 0.03) d.type = "Milisaniye pulsarı (nötron yıldızı)";
      if (o.m) {
        d.rs_km = 2.953 * o.m;                                   // Schwarzschild yarıçapı
        d.rs_au = d.rs_km / 1.496e8;
      }
      if (o.P) d.rate = 1 / o.P;
      if (o.edot) d.edot_sun = o.edot / L_SUN;
      if (o.bs) d.b_earth = o.bs / 0.5;
      d.types = psrTypes(o.ty);
      d.assoc = associations(o.as);
      d.comp = companion(o.comp);
      d.src = o.ds && o.ds !== "lit" ? source(o.ds) : null;
      // dönme değerleri: ATNF'den mi (elle yazılmış kayda eklenmiş olabilir), McGill'den mi, yayından mı
      const also = o.also || [];
      d.spinSrc = o.ds === "atnf" || also.includes("atnf") ? "ATNF" : o.ds === "mcgill" ? "McGill" : o.src ? source(o.src).short : "";
      if (o.d && !o.dk && !o.src) d.distSrc = o.ds === "atnf" && also.includes("mcgill") ? "McGill" : d.src && d.src.short;
    }
    return d;
  }

  /** Kartın "Ölçülen veriler" satırları: [başlık, değer (HTML), kaynak]. */
  function facts(o, d) {
    const f = [];
    const add = (k, v, s) => { if (v != null && v !== "") f.push([k, v, s || ""]); };
    if (o.kind === "dso") {
      add("Tür", esc(d.type + (d.hub ? ` · ${d.hub} (${o.hub})` : o.hub ? ` · ${o.hub}` : "")), o.src ? source(o.src).short : "OpenNGC");
      if (o.v != null) add("Parlaklık (V)", `${fmt(o.v, 1)} kadir`, "OpenNGC");
      else if (o.b != null) add("Parlaklık (B)", `${fmt(o.b, 1)} kadir`, "OpenNGC");
      if (o.a) add("Görünen boyut", o.bx && Math.abs(o.bx - o.a) > 0.01 ? `${fmtAngle(o.a)} × ${fmtAngle(o.bx)}` : fmtAngle(o.a), o.src ? source(o.src).short : "OpenNGC");
      if (o.sb != null) add("Yüzey parlaklığı", `${fmt(o.sb, 1)} kadir/yay saniyesi²`, "OpenNGC");
      if (d.ly) add("Uzaklık", `${o.ds === "hubble" ? "≈ " : ""}${fmtLy(d.ly)}${d.ly_e ? ` (± ${fmtLy(d.ly_e).replace(" ışık yılı", "")})` : ""}`, d.src && d.src.short + (o.dmt ? `, ${DMETH[o.dmt] || o.dmt}` : ""));
      if (d.size_ly) add("Gerçek boyu", `≈ ${fmtLy(d.size_ly)} çapında`, "hesaplandı");
      if (o.rv != null) add("Dikine hız", `${fmt(o.rv, 0)} km/s ${o.rv < 0 ? "(yaklaşıyor)" : "(uzaklaşıyor)"}${d.z ? ` · z ≈ ${fmtSig(d.z, 3)}` : ""}`, "OpenNGC");
      if (o.age != null) add("Yaş", fmtYears(o.age * 1e6), source(o.ags || "hr23").short);
      if (o.n) add("Üye yıldız", `${o.n.toLocaleString("tr-TR")} (Gaia'da belirlenen)`, source(o.ags || o.ds || "hr23").short);
      if (o.mass) add("Kütle", `${fmtMass(o.mass)} Güneş kütlesi`, source("bh18").short);
      if (o.feh != null) add("Metal bolluğu", `[Fe/H] = ${fmt(o.feh, 2)} (Güneş'in ~${fmtSig(10 ** o.feh, 2)} katı)`, source("harris").short);
      if (o.lm != null) add("Toplam kütle", `≈ ${fmtMass(10 ** o.lm)} Güneş kütlesi (Holmberg yarıçapı içinde)`, source("ungc").short);
      if (o.lhi != null) add("Nötr hidrojen", `≈ ${fmtMass(10 ** o.lhi)} Güneş kütlesi`, source("ungc").short);
      if (o.cs) add("Merkez yıldızı", `${esc(o.cs)}${o.csv != null ? ` (V ${fmt(o.csv, 1)})` : ""}`, "OpenNGC");
      if (o.bh) add("Merkezdeki kara delik", `${fmtMass(o.bh[0])} Güneş kütlesi`, o.bh[1]);
      if (o.host) add("Bulunduğu yer", esc(o.host), "OpenNGC");
      if (o.lit) add("Aydınlatan küme", esc(o.lit), "");
      if (o.snr) add("Kalıntı türü", esc(SNR_TYPE[o.snr] || o.snr), source("green19").short);
      if (o.s1 != null) add("Radyo akısı (1 GHz)", `${fmtSig(o.s1, 3)} Jy`, source("green19").short);
      if (o.shb) add("Parlaklık sınıfı", `${o.shb} (1 sönük – 3 parlak)`, source("sharpless59").short);
    } else {
      const ref = o.src ? source(o.src).short : d.src ? d.src.short : "";
      const calc = o.ds === "mcgill" ? "McGill" : "hesaplandı";          // McGill bu değerleri kendisi veriyor
      const lim = (k) => (o.lim && o.lim[k] ? o.lim[k] + " " : "");
      add("Tür", esc(d.type + (o.cand ? " adayı" : "")), d.src && d.src.short);
      if (o.m) {
        const ml = o.m_lim === ">" || o.m_lim === ">=" || o.m_lim === ">~" ? "> " : o.m_lim === "<" || o.m_lim === "<=" ? "< " : "";
        add("Kütle", `${ml}${fmtMass(o.m)}${o.me ? ` ± ${fmtMass(o.me)}` : ""}${o.m_hi ? `–${fmtMass(o.m_hi)}` : ""} Güneş kütlesi`, ref);
        add("Olay ufku yarıçapı", fmtHorizon(d), "hesaplandı");
      }
      if (d.ly) add("Uzaklık", `${o.d_lim === ">" ? "> " : o.d_lim === "<" ? "< " : ""}${fmtLy(d.ly)}${d.ly_e ? ` (± ${fmtLy(d.ly_e).replace(" ışık yılı", "")})` : ""}${o.d_hi ? ` – ${fmtLy(o.d_hi * LY_PER_PC)}` : ""}`,
        o.dk ? DIST_KIND[o.dk] : o.src ? source(o.src).short : d.distSrc);
      if (o.z != null) add("Kırmızıya kayma", `z = ${fmtSig(o.z, 4)}`, o.src && source(o.src).short);
      if (o.lb != null) add("Işığın yolculuğu", `${fmtSig(o.lb, 3)} milyar yıl (geriye bakış zamanı)`, "hesaplandı (ΛCDM)");
      if (o.P) add("Dönme dönemi", o.P < 1 ? `${fmtSig(o.P * 1000, 4)} ms (saniyede ${fmtSig(d.rate, 3)} tur)` : `${fmtSig(o.P, 4)} s`, d.spinSrc);
      if (o.Pd != null) add("Yavaşlama (Ṗ)", `${lim("Pd")}${sci(o.Pd, 3)} s/s`, d.spinSrc);
      if (o.age && o.k !== "bh") add("Karakteristik yaş", `${lim("age")}${fmtYears(o.age)}`, calc === "McGill" ? calc : "hesaplandı (P / 2Ṗ)");
      if (o.bs) add("Yüzey manyetik alanı", `${lim("bs")}${sci(o.bs, 2)} gauss (Dünya'nınkinin ~${sci(d.b_earth, 1)} katı)`, calc);
      if (o.edot) add("Dönme gücü kaybı (Ė)", `${lim("edot")}${sci(o.edot, 2)} erg/s (Güneş ışığının ~${sci(d.edot_sun, 2)} katı)`, calc);
      if (o.dm != null) add("Dağılma ölçüsü (DM)", `${fmtSig(o.dm, 4)} pc/cm³`, "ATNF");
      if (o.pb) add("Yörünge dönemi", `${o.pb_lim ? o.pb_lim + " " : ""}${o.pb < 1 ? `${fmtSig(o.pb * 24, 3)} saat` : `${fmtSig(o.pb, 4)} gün`}`, ref);
      if (d.comp) add("Yoldaş", esc(d.comp), ref);
      if (o.mc) add("Yoldaş kütlesi", `≈ ${fmtSig(o.mc, 2)} Güneş kütlesi (medyan, i = 60°)`, "hesaplandı");
      if (o.ngl) add("Ani hızlanma (glitch)", `${o.ngl} kez`, "ATNF");
      if (o.s14 != null) add("Radyo akısı (1400 MHz)", `${fmtSig(o.s14, 3)} mJy`, "ATNF");
      for (const t of d.types) add("Özellik", esc(t), "ATNF");
      for (const a of d.assoc) add("İlişkili", esc(a.text), "ATNF");
      if (o.yr && o.ds === "atnf") add("Keşif yayını", String(o.yr), "ATNF");
      if (o.host && o._host) add("Barındığı galaksi", `<a href="#" data-deep="${esc(o.host)}">${esc(title(o._host))}</a>`, "");
    }
    return f;
  }

  /** Kartın başlık kısmı ve kaynak notu için. */
  function card(o) {
    const d = derive(o);
    const aka = o.kind === "dso" ? (o.en || []).filter((x) => x !== o.tr).slice(0, 4) : (o.alias || []).slice(0, 6);
    const chips = [d.type];
    if (o.kind === "dso" && d.hub) chips.push(d.hub);
    if (o.cand) chips.push("aday");
    return { title: o._title, aka, ids: catalogIds(o), chips, facts: facts(o, d), d, color: `rgb(${COLOR[o._g]})`, group: o._g };
  }

  const cap = (t) => (t ? t.charAt(0).toLocaleUpperCase("tr-TR") + t.slice(1) : t);
  /** Listelerde bir satırlık özet: "M31 · Sarmal galaksi · 2,51 milyon ışık yılı · V 3,4". */
  function brief(o) {
    const d = derive(o), parts = [];
    const id = catalogIds(o)[0];
    if (id && o.kind === "dso") parts.push(id);
    if (o.kind === "dso") {
      parts.push(cap(d.hub || d.type));
      if (d.ly) parts.push((o.ds === "hubble" ? "≈ " : "") + fmtLy(d.ly));
      const mag = o.v ?? o.b;
      if (mag != null) parts.push(`${o.v != null ? "V" : "B"} ${fmt(mag, 1)}`);
      if (o.a) parts.push(fmtAngle(o.a));
    } else {
      parts.push(d.type + (o.cand ? " adayı" : ""));
      if (o.m) parts.push(`${o.m_lim && o.m_lim.startsWith(">") ? "> " : o.m_lim && o.m_lim.startsWith("<") ? "< " : ""}${fmtMass(o.m)} Güneş kütlesi`);
      if (o.P) parts.push(o.P < 1 ? `${fmtSig(o.P * 1000, 3)} ms` : `${fmtSig(o.P, 3)} s`);
      if (d.ly) parts.push(fmtLy(d.ly));
    }
    return parts.join(" · ");
  }

  /** Bir cismi kimliğiyle bul ("NGC0224", "PSR J0534+2200", "Sgr A*"). */
  function byId(id) {
    return DSO.find((o) => o.id === id) || COMPACT.find((o) => o.id === id) || null;
  }

  // ---------------------------------------------------------------- fotoğraf
  /**
   * Çözülmüş bir fotoğrafa düşen cisimler. world2pix(ra, dec) → [x, y] (görüntü pikseli); W, H görüntü
   * boyu; fovDeg fotoğrafın uzun kenarının gördüğü açı (hangi cisimlerin listeleneceği buna göre).
   */
  function inField({ ra0, dec0, radius, world2pix, W, H, pixscale, fovDeg }) {
    if (!ready) return [];
    const lim = Math.min(99, maxScore(fovDeg) + 1);
    const c = unit(ra0, dec0), cosR = Math.cos(Math.min(89, radius + 0.2) * R);
    const out = [];
    for (const o of ALL) {
      if (o._s > lim) break;
      const u = o._u;
      if (c[0] * u[0] + c[1] * u[1] + c[2] * u[2] < cosR) continue;
      const p = world2pix(o.ra, o.de);
      if (!p || !isFinite(p[0]) || !isFinite(p[1]) || p[0] < 0 || p[1] < 0 || p[0] > W - 1 || p[1] > H - 1) continue;
      const rpx = o.kind === "dso" && o.a ? ((o.a / 2) * 60) / pixscale : 0;
      // uzun eksenin görüntüdeki yönü (yalnızca belirgin basık galaksi ve bulutsular için)
      let maj = null;
      if (o.kind === "dso" && o.a && o.bx && o.pa != null && o.bx < 0.85 * o.a && rpx > 4) {
        const k = 0.02, pn = world2pix(o.ra, Math.min(89.999, o.de + k)), pe = world2pix(o.ra + k / Math.max(0.02, Math.cos(o.de * R)), o.de);
        if (pn && pe && isFinite(pn[0] + pn[1] + pe[0] + pe[1])) {
          const nx = pn[0] - p[0], ny = pn[1] - p[1], ex = pe[0] - p[0], ey = pe[1] - p[1];
          const ln = Math.hypot(nx, ny) || 1, le = Math.hypot(ex, ey) || 1, pa = o.pa * R;
          maj = [(nx / ln) * Math.cos(pa) + (ex / le) * Math.sin(pa), (ny / ln) * Math.cos(pa) + (ey / le) * Math.sin(pa)];
        }
      }
      out.push({ obj: o, x: p[0], y: p[1], rpx, maj, ratio: maj ? o.bx / o.a : 1 });
      if (out.length >= 60) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- kart: kaynaklar ve simge
  /** Kartın "Kaynaklar" listesi: değerleri veren katalog ve yayınların tam künyesi (düz metin). */
  function sources(o) {
    const out = [];
    const add = (t) => { if (t && !out.includes(t)) out.push(t); };
    const cite = (k) => (k === "atnf" && META.atnf ? `${SOURCES.atnf}, sürüm ${META.atnf}` : SOURCES[k] || null);
    if (o.kind === "dso") {
      add(cite(o.src || "openngc"));                            // cismin kendisi: OpenNGC ya da eklendiği katalog
      if (o.ds && o.ds !== "hubble") add(cite(o.ds) || o.ds);   // uzaklık
      if (o.age != null || o.n) add(cite(o.ags || (o.ds === "cg20" ? "cg20" : "hr23")));
      if (o.mass) add(cite("bh18"));
      if (o.feh != null) add(cite("harris"));
      if (o.lm != null || o.lhi != null) add(cite("ungc"));
      if (o.snr || o.s1 != null) add(cite("green19"));
      if (o.shb) add(cite("sharpless59"));
      if (o.bh) add(o.bh[1]);
      if (o.src) add(cite("openngc"));                          // NGC/IC adları ve türü yine OpenNGC'den
    } else {
      if (o.src) add(o.src);
      if (o.ds && o.ds !== "lit") add(cite(o.ds));
      for (const k of o.also || []) add(cite(k));
    }
    if (o.con && (o.kind === "compact" || o.src)) add(cite("roman87"));   // takımyıldızı IAU sınırlarından bulundu
    return out;
  }

  /** Kartın başındaki simge (gökyüzündekiyle aynı; kuzey yukarıda, doğu solda). */
  function drawIcon(canvas, o) {
    if (!canvas || !canvas.getContext || !o) return;
    const ctx = canvas.getContext("2d"), k = canvas.width / 46, big = o.kind === "compact" ? 1.7 : 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(k, k);
    const glow = ctx.createRadialGradient(23, 23, 1, 23, 23, 23);
    glow.addColorStop(0, `rgba(${COLOR[o._g]},0.30)`);
    glow.addColorStop(1, `rgba(${COLOR[o._g]},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 46, 46);
    ctx.scale(big, big);
    const r = { gal: 16, ocl: 13, gcl: 12, pn: 9, neb: 11, rfn: 11, drk: 11, snr: 13 }[o._g] || 12;
    drawSymbol(ctx, o, 23 / big, 23 / big, r, { n: [0, -1], e: [-1, 0], pxPerDeg: 0 });
    ctx.restore();
  }

  /** Simge açıklaması için bir grubun örnek simgesi. */
  const SAMPLE = {
    gal: { a: 10, bx: 4.2, pa: 55 }, psr: { kind: "compact", k: "psr" }, mag: { kind: "compact", k: "mag" },
    bh: { kind: "compact", k: "bh" }, smbh: { kind: "compact", k: "smbh" }, merger: { kind: "compact", k: "merger" },
  };
  function legendIcon(canvas, g) {
    drawIcon(canvas, Object.assign({ kind: "dso", _g: g }, SAMPLE[g] || {}));
  }

  global.LichDeep = {
    load, onReady, get ready() { return ready; }, get count() { return { dso: DSO.length, compact: COMPACT.length }; },
    layer, hit, searchItems, card, brief, shortKind, sources, drawIcon, legendIcon, title, label, derive, byId, inField, shortId, group, TYPE, KIND, COLOR, GROUP_NAME,
    fmtLy, fmtYears, fmtMass, fmtAngle, fmtHorizon, sci, fmtSig, source,
    get selected() { return selected; }, select(o) { selected = o || null; },
    get on() { return state.on; }, setOn(v) { state.on = !!v; },
    get atnfVersion() { return META.atnf; },
  };
})(window);
