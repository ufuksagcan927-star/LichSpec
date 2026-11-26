/*
 * LichSearch — yıldız ve takımyıldız araması (çevrimdışı, yazım hatalarına dayanıklı).
 *
 * Her kaydın birkaç adı olur (özel ad, Türkçe ad, eş adlar, Bayer/Flamsteed adı takımyıldızın
 * Latince tamlayan hâli ya da Türkçe adıyla: "α Cen" → "Alpha Centauri", "Alfa Erboğa").
 * Adlar ve sorgu aynı biçime getirilir (küçük harf, Türkçe ve aksanlı harfler sadeleşir,
 * Yunan harfleri okunuşuyla yazılır, "yıldızı" → "star") ve sözcük sözcük karşılaştırılır.
 * Sözcük uzunluğuna göre 1–2 harflik yazım hatası kabul edilir ("proxima centuri" →
 * "Proxima Centauri", "betelguese" → "Betelgeuse"); son sözcük henüz yazılıyor olabilir.
 */
(function (global) {
  "use strict";

  const GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ζ": "zeta", "η": "eta",
    "θ": "theta", "ϑ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi",
    "ο": "omicron", "π": "pi", "ρ": "rho", "σ": "sigma", "ς": "sigma", "τ": "tau", "υ": "upsilon",
    "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega",
  };
  const SUP = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
  // Aynı şeyin farklı yazılışları tek biçime: Yunan harflerinin Türkçe okunuşları, katalog önekleri,
  // "yıldız(ı)" / "star".
  const SYN = {
    alfa: "alpha", gama: "gamma", teta: "theta", yota: "iota", jota: "iota", kapa: "kappa", lamda: "lambda",
    mi: "mu", ksi: "xi", omikron: "omicron", ro: "rho", ipsilon: "upsilon", ypsilon: "upsilon",
    fi: "phi", ki: "chi", khi: "chi",
    // SIMBAD kısaltmaları: "alf Ori", "eps Eri"
    alf: "alpha", bet: "beta", gam: "gamma", del: "delta", eps: "epsilon", zet: "zeta", tet: "theta",
    iot: "iota", kap: "kappa", lam: "lambda", omi: "omicron", sig: "sigma", ups: "upsilon", ome: "omega",
    gliese: "gj", gl: "gj", hipparcos: "hip",
    yildizi: "star", yildiz: "star", stars: "star",
  };

  /** Metni karşılaştırma sözcüklerine ayır. */
  function tokens(x) {
    let s = String(x == null ? "" : x).toLocaleLowerCase("tr-TR");
    s = s.replace(/[Ͱ-Ͽ]/g, (c) => (GREEK[c] ? " " + GREEK[c] + " " : " "));
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUP[c]);
    s = s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
    s = s.replace(/['’‘`´ʼ]/g, "");                       // Barnard's → barnards
    s = s.replace(/[^a-z0-9]+/g, " ");
    s = s.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");   // hip70890 → hip 70890
    return s.split(" ").filter(Boolean).map((t) => SYN[t] || t);
  }
  const norm = (x) => tokens(x).join(" ");

  /** Harf düzeltme uzaklığı (ekleme, silme, değiştirme, yan yana iki harfin yer değişmesi); max'ı aşınca erken çıkar. */
  function editDistance(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let p2 = new Array(lb + 1).fill(0), p1 = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) p1[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const t = p2; p2 = p1; p1 = cur; cur = t;
    }
    return p1[lb];
  }

  /** Sözcük uzunluğuna göre kabul edilen yazım hatası sayısı. */
  const allowed = (t) => (/^\d+$/.test(t) ? 0 : t.length <= 3 ? 0 : t.length <= 6 ? 1 : 2);

  /**
   * Arama dizini. items: [{ keys: [ad, ...], rank: sayı, ... }] (diğer alanlar sonuçta aynen döner).
   * rank eşit eşleşmeler arasında sırayı belirler (büyük olan önce).
   */
  function build(items) {
    const entries = [], vocab = new Set();
    for (const it of items) {
      const keys = [];
      for (const k of it.keys || []) {
        const t = tokens(k);
        if (!t.length) continue;
        const s = t.join(" ");
        if (keys.some((x) => x.s === s)) continue;
        keys.push({ s, t });
        t.forEach((w) => vocab.add(w));
      }
      if (keys.length) entries.push({ item: it, keys });
    }
    return { entries, vocab: [...vocab] };
  }

  /** Sorgu sözcüğüne uyan dağarcık sözcükleri → bedel (0 = aynı; küçük = iyi). */
  function wordMatches(index, w) {
    const m = new Map(), max = allowed(w), num = /^\d+$/.test(w);
    for (const v of index.vocab) {
      if (v === w) { m.set(v, 0); continue; }
      if (v.startsWith(w)) { m.set(v, num ? 0.6 : 0.3); continue; }     // henüz yazılıyor / kısaltma
      if (!max || /^\d+$/.test(v)) continue;
      let d = editDistance(w, v, max);
      if (d > max && v.length > w.length) d = editDistance(w, v.slice(0, w.length), max) + 0.3;
      if (d <= max + 0.3) m.set(v, d);
    }
    return m;
  }

  /**
   * En iyi eşleşmeler, en iyisi önce: [{ item, score, match, key }]. Hiçbir şey çıkmazsa son
   * sözcük atılıp yeniden denenir ("proxima centauri b" → Proxima Centauri).
   */
  function find(index, q, limit = 10) {
    let qt = tokens(q);
    for (let drop = 0; qt.length; drop++, qt = qt.slice(0, -1)) {
      const out = findTokens(index, qt, limit, drop * 150);
      if (out.length || drop >= 1) return out;
    }
    return [];
  }

  function findTokens(index, qt, limit, penalty) {
    const qs = qt.join(" ");
    const maps = qt.map((w) => wordMatches(index, w));
    const out = [];
    for (const e of index.entries) {
      let best = -Infinity, bestKey = null;
      for (const k of e.keys) {
        let sc;
        if (k.s === qs) sc = 1000;
        else if (k.s.startsWith(qs)) sc = 900 - Math.min(80, k.s.length - qs.length);
        else {
          // her sorgu sözcüğü adın ayrı bir sözcüğüyle eşleşmeli
          let cost = 0;
          const used = [];
          for (let i = 0; i < qt.length; i++) {
            let bj = -1, bc = Infinity;
            for (let j = 0; j < k.t.length; j++) {
              if (used.includes(j)) continue;
              const c = maps[i].get(k.t[j]);
              if (c !== undefined && c < bc) { bc = c; bj = j; }
            }
            if (bj < 0) { cost = -1; break; }
            used.push(bj);
            cost += bc;
          }
          if (cost < 0) continue;
          sc = 700 - 60 * cost - 4 * (k.t.length - qt.length);
        }
        if (sc > best) { best = sc; bestKey = k.s; }
      }
      if (bestKey !== null) out.push({ item: e.item, score: best - penalty + (e.item.rank || 0), match: best - penalty, key: bestKey });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  global.LichSearch = { tokens, norm, editDistance, build, find };
})(typeof window !== "undefined" ? window : globalThis);
