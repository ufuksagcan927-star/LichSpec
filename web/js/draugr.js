/*
 * Draugr (şablon sürüm) — yalnızca ölçülmüş/katalog verilerinden Türkçe anlatım üretir.
 * Bir alan yoksa o cümle hiç yazılmaz; hiçbir değer uydurulmaz.
 * Türetilmiş (hesaplanmış) değerler "≈" ile ve kaynağı belirtilerek gösterilir.
 *
 * Poltergeist ön tahmini: tayf sınıfından beklenen tipik soğurma çizgileri.
 * Bu bir ölçüm değildir; gerçek Poltergeist modeli tayf üzerinden çalışacak.
 */
(function (global) {
  "use strict";

  const LY_PER_PC = 3.26156;
  const Z_SUN = 0.0134; // Asplund+2009 güneş metal kütle oranı

  const CLASS_INFO = {
    O: { name: "O tipi", color: "#9bb0ff", desc: "çok sıcak, mavi-mor", t: [30000, 50000] },
    B: { name: "B tipi", color: "#aabfff", desc: "sıcak, mavi-beyaz", t: [10000, 30000] },
    A: { name: "A tipi", color: "#cad7ff", desc: "beyaz", t: [7500, 10000] },
    F: { name: "F tipi", color: "#f8f7ff", desc: "sarımsı beyaz", t: [6000, 7500] },
    G: { name: "G tipi", color: "#fff4ea", desc: "sarı (Güneş gibi)", t: [5200, 6000] },
    K: { name: "K tipi", color: "#ffd2a1", desc: "turuncu", t: [3700, 5200] },
    M: { name: "M tipi", color: "#ffad60", desc: "kırmızı, soğuk", t: [2400, 3700] },
    C: { name: "karbon yıldızı", color: "#ff8a4c", desc: "karbonca zengin, kırmızı", t: [2500, 3500] },
    S: { name: "S tipi", color: "#ff9a5a", desc: "zirkonyumca zengin, kırmızı", t: [2500, 3500] },
    W: { name: "Wolf-Rayet", color: "#9bb0ff", desc: "çok sıcak, güçlü rüzgârlı", t: [30000, 200000] },
    D: { name: "beyaz cüce", color: "#e5ecff", desc: "çökmüş yıldız çekirdeği", t: [5000, 80000] },
  };

  // Spektral sınıfa göre beklenen baskın çizgiler (standart MK sınıflandırma ölçütleri).
  const LINES = {
    O: [["He II", "4686 Å — iyonlaşmış helyum, yalnızca en sıcak yıldızlarda"], ["He I", "4471 Å — nötr helyum"], ["N III, C III", "yüksek iyonlaşmış azot/karbon"], ["H (Balmer)", "zayıf; hidrojen büyük ölçüde iyonlaşmış"]],
    B: [["He I", "4026, 4471 Å — B2 civarında en güçlü"], ["H (Balmer)", "Hβ, Hγ, Hδ — geç B'ye doğru güçlenir"], ["Si II / Si III", "silisyum iyonları"], ["Mg II", "4481 Å — magnezyum"]],
    A: [["H (Balmer)", "Hα 6563, Hβ 4861 Å — A0'da en güçlü hidrojen çizgileri"], ["Ca II K", "3934 Å — zayıf, geç A'ya doğru belirginleşir"], ["Mg II", "4481 Å"], ["Fe II, Si II", "iyonlaşmış metaller"]],
    F: [["Ca II H & K", "3968 / 3934 Å — belirgin biçimde güçlü"], ["H (Balmer)", "A tipine göre zayıflamış"], ["Fe I, Fe II, Cr", "metal çizgileri artıyor"], ["CH G-bandı", "4300 Å — görünmeye başlar"]],
    G: [["Ca II H & K", "en güçlü çizgiler"], ["Fe I ve nötr metaller", "yüzlerce ince çizgi"], ["CH G-bandı", "4300 Å — karbon-hidrojen molekülü"], ["Mg b, Na I D", "5175 Å üçlüsü, 5890/5896 Å sodyum"]],
    K: [["Ca I", "4227 Å — nötr kalsiyum güçlü"], ["Fe I, Ti I", "nötr metaller baskın"], ["Na I D, Mg b", "sodyum ve magnezyum"], ["TiO", "geç K'da titanyum oksit bantları başlar"]],
    M: [["TiO bantları", "titanyum oksit — tayfı belirleyen moleküler bantlar"], ["VO, CaH", "vanadyum oksit, kalsiyum hidrür"], ["Ca I, Na I, K I", "nötr alkali/toprak alkali metaller"], ["H (Balmer)", "çok zayıf"]],
    C: [["C₂ Swan bantları", "karbon molekülü"], ["CN, CH", "siyanojen ve metilidin"], ["Na I D", "sodyum"]],
    S: [["ZrO bantları", "zirkonyum oksit"], ["LaO, YO", "s-süreci elementleri"], ["TiO", "zayıf"]],
    W: [["He II, N III–V veya C III–IV", "geniş salma çizgileri"]],
    D: [["H (Balmer) veya He I", "basınçla genişlemiş çizgiler (DA/DB)"]],
  };

  const LUM_CLASS = [
    ["0", "hiperdev"], ["Ia", "parlak süperdev"], ["Iab", "süperdev"], ["Ib", "süperdev"],
    ["III", "dev"], ["II", "parlak dev"], ["IV", "altdev"], ["VI", "altcüce"], ["V", "anakol (cüce)"], ["I", "süperdev"],
  ];

  function fmt(x, nd = 1) {
    if (x === null || x === undefined || !isFinite(x)) return "—";
    if (Math.abs(x) < 0.5 * Math.pow(10, -nd)) x = 0;
    return Number(x).toLocaleString("tr-TR", { minimumFractionDigits: nd, maximumFractionDigits: nd });
  }
  function fmtInt(x) {
    return x == null || !isFinite(x) ? "—" : Math.round(x).toLocaleString("tr-TR");
  }
  /** Uzaklık: yakın yıldızlarda bir ondalık (Proxima 4,2 ışık yılı), uzaktakilerde tam sayı. */
  function fmtDist(x) {
    return x != null && x < 10 ? fmt(x, 1) : fmtInt(x);
  }

  /** B-V → Teff (Ballesteros 2012, siyah cisim yaklaşımı). */
  function teffFromBV(bv) {
    if (bv == null || !isFinite(bv) || bv < -0.4 || bv > 2.2) return null;
    return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  }
  function classFromTeff(t) {
    if (!t) return null;
    if (t >= 30000) return "O";
    if (t >= 10000) return "B";
    if (t >= 7500) return "A";
    if (t >= 6000) return "F";
    if (t >= 5200) return "G";
    if (t >= 3700) return "K";
    return "M";
  }

  function parseSp(sp) {
    if (!sp) return { cls: null, lum: null };
    const s = sp.trim();
    let cls = null;
    // "DA2", "WC8", "C5,4", "kA2hA5mA7V"…
    const m = s.match(/^(?:sd|d|g|k[A-Z]\d?\S*?h)?([OBAFGKMCSWD])/);
    if (m) cls = m[1];
    let lum = null;
    // tayf alt tipinden (ör. "M1-2") sonraki ilk Roma rakamı grubu
    const rest = s.replace(/^[^OBAFGKMCSWD]*[OBAFGKMCSWD][\d.\-\/]*/, "");
    const lm = rest.match(/^\s*(?:\/)?(Iab|Ia0|Ia|Ib|III|II|IV|VI|V|I|0)/);
    if (lm) {
      const code = lm[1] === "Ia0" ? "0" : lm[1];
      const hit = LUM_CLASS.find(([c]) => c === code);
      if (hit) lum = { code: hit[0], name: hit[1] };
    }
    return { cls, lum };
  }

  /**
   * Gaia DR3 GSP-Spec (RVS tayfı) atmosfer değerlerini güvenilmez oldukları iki durumda yok say; kart o zaman
   * Gaia fotometrisine (GSP-Phot) ya da renge döner. İkisi de Gaia'nın kendi kalite bayraklarının tanımından
   * (Recio-Blanco ve ark. 2023, A&A 674, A29, Tablo C.5 ve C.8):
   *  - Tam olarak Teff = 4250 K ve log g = 1,5: KMgiantPar bayrağı (soğuk K/M devleri) konmuş yıldızların ortak
   *    değeri, ölçüm değil. Bu katalogda 300'ü aşkın yıldızda aynı; Barnard Yıldızı gibi kırmızı cüceler de içinde.
   *  - Teff ≤ 3500 K: model ızgarasının kenarı (extrapol bayrağı). Kırmızı cücelerde log g 3,5–4 ve [M/H] çok
   *    düşük çıkıyor (gerçekte log g ≈ 5).
   */
  const SPEC_KEYS = ["teff_s", "logg_s", "mh_s", "fem", "alpha", "ca", "mg", "si", "ti"];
  function cleanSpec(s) {
    if (s.teff_s == null || s.teff_s === "") return s;
    const teff = +s.teff_s, logg = s.logg_s == null || s.logg_s === "" ? null : +s.logg_s;
    const why = teff === 4250 && logg === 1.5 ? "fixed" : teff <= 3500 ? "edge" : null;
    if (!why) return s;
    s._spec_skip = { why, teff, logg };
    for (const k of SPEC_KEYS) delete s[k];
    return s;
  }

  /** Tüm türetilmiş büyüklükleri tek yerde hesapla. Kaynaklar `src` alanında. */
  function derive(s) {
    const d = { src: {} };
    const sp = parseSp(s.sp);
    d.cls = sp.cls;
    d.lum = sp.lum;

    // Uzaklık: Hipparcos paralaksı (yalnızca anlamlıysa)
    if (s.plx && s.plx > 0 && (!s.eplx || s.plx / s.eplx > 3)) {
      if (s.eplx && s.plx / s.eplx < 8) d.dist_err_pct = (100 * s.eplx) / s.plx;
      d.dist_pc = 1000 / s.plx;
      d.dist_ly = d.dist_pc * LY_PER_PC;
      d.src.dist = s._origin === "gaia" ? "Gaia DR3 paralaksı" : "Hipparcos paralaksı";
      if (s.v != null) {
        d.absmag = s.v - 5 * Math.log10(d.dist_pc / 10);
        d.lum_sun = Math.pow(10, -0.4 * (d.absmag - 4.83)); // görsel ışınım gücü, sönümleme ihmal
      }
    } else if (s.plx && s.plx > 0) {
      d.dist_uncertain = true;
    }

    // Sıcaklık: önce Gaia RVS tayfı (GSP-Spec), sonra Gaia GSP-Phot, sonra B-V
    if (s.teff_s) { d.teff = s.teff_s; d.src.teff = "Gaia DR3 RVS tayfı"; }
    else if (s.teff) { d.teff = s.teff; d.src.teff = "Gaia DR3 fotometri"; }
    else if (s.bv != null) { d.teff = teffFromBV(s.bv); d.teff_est = true; d.src.teff = "B−V renginden tahmin"; }
    else if (s.bprp != null && s.bprp > 0.39 && s.bprp < 1.5 && !s.dusty) {   // dusty: rengi kendi tozundan
      const C = s.bprp;
      d.teff = 5040 / (0.4929 + 0.5092 * C - 0.0353 * C * C); d.teff_est = true;
      d.src.teff = "BP−RP renginden tahmin (toz ihmal)";
    }

    // Işınım sınıfı tayf türünde yoksa ölçülen yüzey çekiminden (log g) kaba sınıf
    const logg = s.logg_s ?? s.logg;
    if (!d.lum && logg != null) {
      if (logg < 2.0) d.lum = { code: "III/I", name: "dev ya da süperdev (log g'den)" };
      else if (logg < 3.6) d.lum = { code: "III", name: "dev (log g'den)" };
      else if (logg >= 4.0) d.lum = { code: "V", name: "anakol (log g'den)" };
    }
    if (!d.cls) { d.cls = classFromTeff(d.teff); d.cls_est = !!d.cls; }
    d.info = CLASS_INFO[d.cls] || null;
    d.color = d.info ? d.info.color : "#ffffff";
    if (s.bv != null && !["C", "S", "W", "D"].includes(d.cls)) d.color = bvColor(s.bv);

    // Metal bolluğu: GSP-Spec > GSP-Phot
    if (s.mh_s != null) { d.mh = s.mh_s; d.src.mh = "Gaia DR3 RVS tayfı"; }
    else if (s.mh != null) { d.mh = s.mh; d.src.mh = "Gaia DR3 fotometri (kaba)"; }
    if (d.mh != null) {
      d.Z = Math.min(0.08, Z_SUN * Math.pow(10, d.mh));
      d.Y = 0.2485 + 1.4 * d.Z; // helyum zenginleşme ilişkisi (dY/dZ ≈ 1.4)
      d.X = 1 - d.Y - d.Z;
    }
    return d;
  }

  /** B-V → görüntü rengi (Mitchell Charity tablosuna yakın basit enterpolasyon). */
  function bvColor(bv) {
    const stops = [[-0.4, [155, 176, 255]], [0.0, [202, 215, 255]], [0.4, [248, 247, 255]], [0.65, [255, 244, 234]], [1.0, [255, 210, 161]], [1.5, [255, 173, 96]], [2.0, [255, 140, 60]]];
    bv = Math.max(-0.4, Math.min(2.0, bv));
    for (let i = 1; i < stops.length; i++) {
      if (bv <= stops[i][0]) {
        const [b0, c0] = stops[i - 1], [b1, c1] = stops[i];
        const t = (bv - b0) / (b1 - b0);
        const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return "rgb(255,140,60)";
  }

  function title(s) {
    return s.name || s.desig || (s.hip ? `HIP ${s.hip}` : s.gaia ? `Gaia DR3 ${s.gaia}` : "Yıldız");
  }

  const CON_TR = {
    And: "Andromeda", Ant: "Hava Tulumbası", Aps: "Cennet Kuşu", Aqr: "Kova", Aql: "Kartal", Ara: "Sunak", Ari: "Koç", Aur: "Arabacı", Boo: "Çoban", Cae: "Çelik Kalem", Cam: "Zürafa", Cnc: "Yengeç", CVn: "Av Köpekleri", CMa: "Büyük Köpek", CMi: "Küçük Köpek", Cap: "Oğlak", Car: "Karina", Cas: "Kraliçe", Cen: "Erboğa", Cep: "Kral", Cet: "Balina", Cha: "Bukalemun", Cir: "Pergel", Col: "Güvercin", Com: "Berenis'in Saçı", CrA: "Güney Tacı", CrB: "Kuzey Tacı", Crv: "Karga", Crt: "Kupa", Cru: "Güney Haçı", Cyg: "Kuğu", Del: "Yunus", Dor: "Kılıçbalığı", Dra: "Ejderha", Equ: "Tay", Eri: "Irmak", For: "Ocak", Gem: "İkizler", Gru: "Turna", Her: "Herkül", Hor: "Saat", Hya: "Suyılanı", Hyi: "Küçük Suyılanı", Ind: "Hintli", Lac: "Kertenkele", Leo: "Aslan", LMi: "Küçük Aslan", Lep: "Tavşan", Lib: "Terazi", Lup: "Kurt", Lyn: "Vaşak", Lyr: "Çalgı", Men: "Masa", Mic: "Mikroskop", Mon: "Tekboynuz", Mus: "Sinek", Nor: "Gönye", Oct: "Sekizlik", Oph: "Yılancı", Ori: "Avcı", Pav: "Tavus", Peg: "Kanatlı At", Per: "Kahraman", Phe: "Anka", Pic: "Ressam", Psc: "Balıklar", PsA: "Güney Balığı", Pup: "Pupa", Pyx: "Pusula", Ret: "Ağcık", Sge: "Ok", Sgr: "Yay", Sco: "Akrep", Scl: "Heykeltıraş", Sct: "Kalkan", Ser: "Yılan", Sex: "Sekstant", Tau: "Boğa", Tel: "Teleskop", Tri: "Üçgen", TrA: "Güney Üçgeni", Tuc: "Tukan", UMa: "Büyükayı", UMi: "Küçükayı", Vel: "Yelken", Vir: "Başak", Vol: "Uçan Balık", Vul: "Tilki",
  };

  /** Draugr anlatımı: yalnızca mevcut alanlardan paragraf listesi. */
  function narrate(s, d) {
    const p = [];
    const t = title(s);
    const con = s.con && CON_TR[s.con] ? `${CON_TR[s.con]} (${s.con}) takımyıldızında` : null;

    let first = `Şu an baktığın yıldız: <b>${t}</b>`;
    if (s.name && s.desig) first += ` (${s.desig})`;
    first += ".";
    if (con) first += ` ${cap(con)} yer alıyor.`;
    p.push(first);

    if (s.v != null) {
      const vis = s.v < 1 ? "gökyüzünün en parlak yıldızlarından biri" : s.v < 4.5 ? "şehirden bile çıplak gözle görülebilir" : s.v < 6.5 ? "karanlık bir gökyüzünde çıplak gözle görülebilir" : "dürbünle rahatça görülür";
      p.push(`Görünür parlaklığı V = ${fmt(s.v, 2)} kadir: ${vis}.`);
    } else if (s.g != null) {
      p.push(`Gaia G bandındaki parlaklığı ${fmt(s.g, 2)} kadir.`);
    }
    if (d.dist_ly) {
      const unc = d.dist_err_pct ? ` (ölçüm belirsizliği yüksek, ±%${fmtInt(d.dist_err_pct)})` : "";
      p.push(`Yaklaşık ${fmtDist(d.dist_ly)} ışık yılı (${fmtDist(d.dist_pc)} parsek) uzakta${unc}. Yani şu an gördüğün ışık yıldızdan yaklaşık ${fmtDist(d.dist_ly)} yıl önce yola çıktı.`);
    } else if (d.dist_uncertain) {
      p.push("Paralaks ölçümünün hata payı çok büyük olduğu için uzaklığı güvenilir biçimde bilinmiyor.");
    }

    if (d.cls && d.info) {
      let sTxt = `Tayf türü <b>${s.sp || d.info.name}</b>`;
      sTxt += s.sp ? `: ${d.info.desc} bir ${d.info.name} yıldız` : ` (${d.cls_est ? (d.teff_est ? "renginden tahmin" : "sıcaklığından tahmin") : ""})`;
      if (d.lum) sTxt += d.lum.name.includes("log g") ? `; ölçülen yüzey çekimine (log g) göre ${d.lum.name.replace(" (log g'den)", "")}` : `, ışınım sınıfı ${d.lum.code} → ${d.lum.name}`;
      sTxt += ".";
      if (d.teff) sTxt += ` Yüzey sıcaklığı ${d.teff_est ? "yaklaşık " : ""}${fmtInt(d.teff)} K (${d.src.teff}).`;
      p.push(sTxt);
    }
    if (d.lum_sun && d.absmag != null) {
      const L = d.lum_sun;
      // kırmızı cücelerde yüzde sıfıra yuvarlanmasın: iki anlamlı basamakla "0,000057 katı"
      const Ltxt = L >= 10 ? `Güneş'in görsel ışığının yaklaşık ${fmtInt(L)} katı` : L >= 1 ? `Güneş'in görsel ışığının yaklaşık ${fmt(L, 1)} katı`
        : L >= 0.01 ? `Güneş'in görsel ışığının yalnızca ~%${fmt(L * 100, 0)}'i`
          : `Güneş'in görsel ışığının yalnızca ${fmt(L, Math.min(8, 1 - Math.floor(Math.log10(L))))} katı`;
      p.push(`Uzaklığı ve parlaklığından mutlak kadiri ≈ ${fmt(d.absmag, 2)} çıkıyor: ${Ltxt} kadar ışık yayıyor (yıldızlararası toz ihmal edildi).`);
    }
    if (s.rad) p.push(`Gaia DR3'e göre yarıçapı Güneş'in ≈ ${fmt(s.rad, 1)} katı.`);
    if (s.mass != null || s.age != null || s.lumf != null) {
      const f = [];
      if (s.lumf != null) f.push(`Güneş'in ${s.lumf >= 10 ? fmtInt(s.lumf) : fmt(s.lumf, 2)} katı ışınım gücüne`);
      if (s.mass != null) f.push(`${fmt(s.mass, 2)} Güneş kütlesine`);
      if (s.age != null) f.push(`yaklaşık ${fmt(s.age, 1)} milyar yıllık bir yaşa`);
      p.push(`Gaia'nın evrim modeli (FLAME) bu yıldıza ${f.join(", ")} sahip diyor.`);
    }
    if (s.rv != null) p.push(`Bize ${s.rv < 0 ? "yaklaşıyor" : "uzaklaşıyor"}: saniyede ${fmt(Math.abs(s.rv), 1)} km (Gaia RVS dikine hızı).`);
    if (s.ruwe != null && s.ruwe > 1.4) p.push(`Gaia astrometrisinde sapma yüksek (RUWE = ${fmt(s.ruwe, 2)}); görünmeyen bir eşi olabilir.`);

    if (d.mh != null) {
      const rel = d.mh > 0.15 ? "Güneş'ten daha metal zengin" : d.mh < -0.5 ? "Güneş'e göre belirgin biçimde metal fakir — muhtemelen eski bir yıldız kuşağından" : d.mh < -0.15 ? "Güneş'ten biraz metal fakir" : "Güneş'e benzer metal bolluğunda";
      let m = `Kimyasal yapı: [M/H] = ${fmt(d.mh, 2)} (${d.src.mh}) → ${rel}.`;
      if (s.ca != null || s.mg != null) {
        const ab = [];
        if (s.mg != null) ab.push(`[Mg/Fe] = ${fmt(s.mg, 2)}`);
        if (s.ca != null) ab.push(`[Ca/Fe] = ${fmt(s.ca, 2)}`);
        if (s.ti != null) ab.push(`[Ti/Fe] = ${fmt(s.ti, 2)}`);
        m += ` Gaia RVS tayfında ölçülen element oranları: ${ab.join(", ")}.`;
      }
      p.push(m);
    }
    if (s.var) p.push(`${s._origin === "gaia" ? "Gaia" : "Hipparcos"} bu yıldızın parlaklığında değişim (değişen yıldız işareti) kaydetmiş.`);
    return p;
  }

  function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }

  // ---------------------------------------------------------------- derin gök ve kompakt cisimler
  const escH = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** "Açık yıldız kümesi" → "açık yıldız kümesi"; "HII bölgesi" olduğu gibi. */
  const lc = (t) => (/^[A-ZÇĞİÖŞÜ]{2}/.test(t) ? t : t.charAt(0).toLocaleLowerCase("tr-TR") + t.slice(1));
  const GAL_KIND = {
    "sarmal galaksi": "Sarmal kollarında genç, mavi yıldızlar ve gaz bulutları, ortasında yaşlı yıldızlardan bir şişkinlik var.",
    "çubuklu sarmal galaksi": "Ortasından geçen yıldızlardan bir çubuk var, sarmal kollar çubuğun uçlarından başlıyor (Samanyolu da böyle).",
    "zayıf çubuklu sarmal galaksi": "Ortasında belli belirsiz bir çubuk var; kolları genç yıldızlarla dolu.",
    "eliptik galaksi": "Yaşlı, kırmızımsı yıldızlardan oluşan, gazı az ve artık pek yıldız doğurmayan bir galaksi.",
    "cüce eliptik / küresel galaksi": "Küçük, sönük ve gazı az bir cüce galaksi; çoğu daha büyük bir galaksinin uydusudur.",
    "mercimek (lentiküler) galaksi": "Diski var ama sarmal kolları yok: sarmal ile eliptik galaksiler arasında bir tür.",
    "düzensiz galaksi": "Belirgin bir biçimi yok; çoğunlukla gaz bakımından zengin ve yeni yıldızlar doğuruyor.",
    "Macellan türü sarmal galaksi": "Tek kollu, düzensize yakın küçük bir sarmal: Büyük Macellan Bulutu bu türün örneği.",
  };
  const TYPE_TEXT = {
    ocl: "Aynı gaz bulutundan birlikte doğmuş, birbirine gevşekçe bağlı yıldızlardan oluşan bir küme; zamanla dağılıp gider.",
    gcl: "Yüz binlerce yaşlı yıldızın küre biçiminde sıkıca toplandığı bir küme. Küresel kümeler Samanyolu'nun en yaşlı yapılarındandır (çoğu 10 milyar yıldan yaşlı).",
    pn: "Güneş benzeri bir yıldızın ömrünün sonunda dışarı attığı gaz kabuğu. Adı eski teleskoplarda gezegen diski gibi görünmesinden gelir; gezegenlerle ilgisi yok.",
    neb: "Yakındaki genç ve sıcak yıldızların morötesi ışığıyla iyonlaşıp parlayan hidrojen bulutu: yeni yıldızların doğduğu bir bölge.",
    rfn: "Yakındaki yıldızların ışığını yansıtan bir toz bulutu; mavi ışık daha çok saçıldığı için genellikle mavi görünür.",
    drk: "Arkasındaki yıldızların ve parlak bulutsuların ışığını kesen soğuk bir toz ve molekül bulutu. Yeni yıldızlar böyle bulutların içinde doğar.",
    snr: "Bir yıldızın süpernova patlamasından geriye kalan, saniyede binlerce kilometre hızla genişleyen gaz kabuğu.",
  };

  /** Derin gök cismi anlatımı. c: LichDeep.card(o). */
  function narrateDeep(o, c) {
    const L = global.LichDeep, d = c.d, p = [];
    const con = o.con && CON_TR[o.con] ? `${CON_TR[o.con]} (${o.con}) takımyıldızında` : null;
    const ids = c.ids.slice(0, 2).join(", ");
    const kind = lc(d.hub || d.type);
    p.push(`Şu an baktığın cisim: <b>${escH(c.title)}</b>${ids ? ` (${escH(ids)})` : ""}. ${con ? cap(con) + " bir" : "Bir"} ${escH(kind)}.`);

    const mag = o.v ?? o.b;
    if (mag != null) {
      const vis = mag < 4 ? "karanlık bir gökyüzünde çıplak gözle kolayca görülür" : mag < 6 ? "karanlık bir gökyüzünde çıplak gözle soluk bir leke gibi seçilebilir"
        : mag < 9 ? "dürbünle görülebilir" : mag < 12 ? "küçük bir teleskopla görülebilir" : mag < 14.5 ? "orta boy bir teleskop ister"
          : "ancak büyük teleskoplarla ya da uzun pozlamalı fotoğraflarla görülür";
      const spread = o.a && o.a > 20 && mag < 9 ? "; ışığı geniş bir alana yayıldığı için bu sayının düşündürdüğünden sönük durur" : "";
      p.push(`Toplam parlaklığı ${fmt(mag, 1)} kadir: ${vis}${spread}.`);
    }
    if (o.a && o.a >= 15) {
      const k = o.a / 31;
      p.push(`Gökyüzünde ${L.fmtAngle(o.a)} boyunda: ${k >= 1.5 ? `dolunayın yaklaşık ${fmt(k, k >= 10 ? 0 : 1)} katı` : k >= 0.7 ? "aşağı yukarı dolunay kadar" : "dolunayın yaklaşık yarısı kadar"}.`);
    }
    if (d.ly) {
      const est = o.ds === "hubble";
      p.push(`${est ? "Kırmızıya kaymasından Hubble yasasıyla tahmin edilen uzaklığı" : "Uzaklığı"} ${L.fmtLy(d.ly)} (${escH(d.src ? d.src.short : "")}). Yani şu an gördüğün ışık oradan yaklaşık ${L.fmtYears(d.ly)} önce yola çıktı.`);
    }
    if (d.size_ly) {
      const mw = c.group === "gal" && d.size_ly > 3000 ? ` (Samanyolu'nun diski ~100 bin ışık yılı)` : "";
      p.push(`Bu uzaklıkta görünen boyu yaklaşık ${L.fmtLy(d.size_ly)} çapa karşılık geliyor${mw} (hesaplandı).`);
    }
    if (c.group === "gal") {
      if (d.hub && GAL_KIND[d.hub]) p.push(GAL_KIND[d.hub]);
      if (o.rv != null && o.rv < 0) p.push(`Bize saniyede ${fmtInt(-o.rv)} km hızla yaklaşıyor.`);
      else if (d.z) p.push(`Evrenin genişlemesiyle saniyede ${fmtInt(o.rv)} km hızla bizden uzaklaşıyor (kırmızıya kayma z ≈ ${L.fmtSig(d.z, 3)}).`);
      if (o.lm != null) p.push(`Toplam kütlesi Güneş'in yaklaşık ${L.fmtMass(10 ** o.lm)} katı${o.lhi != null ? `; bunun ${L.fmtMass(10 ** o.lhi)} Güneş kütlesi kadarı nötr hidrojen gazı` : ""} (${escH(L.source("ungc").short)}).`);
      if (o.bh) p.push(`Merkezinde Güneş'in yaklaşık ${L.fmtMass(o.bh[0])} katı kütlede süper kütleli bir kara delik var (${escH(o.bh[1])}).`);
    } else if (TYPE_TEXT[c.group]) {
      p.push(TYPE_TEXT[c.group] + (o.t === "Cl+N" ? " İçinde bu buluttan doğmuş bir yıldız kümesi var." : ""));
    }
    if (o.lit) p.push(`Bulutsuyu ${escH(o.lit)} kümesinin yıldızları aydınlatıyor; uzaklığı da o kümeden.`);
    if (c.group === "ocl" && (o.age != null || o.n)) {
      const young = o.age != null && o.age < 50 ? " Gökbilim ölçüsünde çok genç." : o.age != null && o.age > 1000 ? " Açık kümeler için yaşlı sayılır." : "";
      p.push(`Gaia DR3 verisine göre${o.age != null ? ` yaklaşık ${L.fmtYears(o.age * 1e6)} yaşında` : ""}${o.age != null && o.n ? ";" : ""}${o.n ? ` ${fmtInt(o.n)} üye yıldızı belirlenmiş` : ""} (${escH(L.source(o.ags || o.ds || "hr23").short)}).${young}`);
    }
    if (c.group === "gcl" && (o.mass || o.feh != null)) {
      const f = [];
      if (o.mass) f.push(`kütlesi Güneş'in yaklaşık ${L.fmtMass(o.mass)} katı`);
      if (o.feh != null) f.push(`metal bolluğu [Fe/H] = ${fmt(o.feh, 2)}, yani Güneş'in yaklaşık ${L.fmtSig(10 ** o.feh, 2)} katı kadar ağır element içeriyor`);
      p.push(cap(f.join("; ")) + ".");
    }
    if (c.group === "pn" && o.cs) p.push(`Ortadaki sıcak yıldız (${escH(o.cs)}${o.csv != null ? `, ${fmt(o.csv, 1)} kadir` : ""}) morötesi ışığıyla gazı parlatıyor; zamanla soğuyup beyaz cüceye dönüşecek.`);
    if (c.group === "snr") {
      const t = { S: "Kabuk türü: patlamanın şok dalgası parlak bir halka çiziyor.", F: "Dolu türü: içi, ortadaki pulsarın saçtığı parçacık rüzgârıyla parlıyor.", C: "Bileşik tür: hem genişleyen bir kabuk hem ortada pulsar rüzgârı var." }[o.snr];
      if (t) p.push(t);
      if (o.s1 != null) p.push(`1 GHz'te radyo akısı ${L.fmtSig(o.s1, 3)} Jy (${escH(L.source("green19").short)}).`);
    }
    if (o.host) p.push(`${escH(o.host)} içinde: Samanyolu'nun uydu galaksilerinden birinde.`);
    return p;
  }

  /** Kara delik ve nötron yıldızı anlatımı. */
  function narrateCompact(o, c) {
    const L = global.LichDeep, d = c.d, p = [];
    const con = o.con && CON_TR[o.con] ? ` ${CON_TR[o.con]} (${o.con}) takımyıldızı yönünde.` : "";
    p.push(`Şu an baktığın cisim: <b>${escH(c.title)}</b>${c.title.includes(o.id) ? "" : ` (${escH(o.id)})`}, bir ${escH(lc(d.type))}${o.cand ? " adayı" : ""}.${con}`);
    if (o.note) p.push(escH(o.note));
    if (o.k === "bh" || o.k === "smbh") {
      if (o.m) {
        const ref = o.src ? L.source(o.src).short : d.src ? d.src.short : "";
        p.push(`Kütlesi Güneş'in ${o.m_lim && o.m_lim.startsWith(">") ? "en az " : "yaklaşık "}${L.fmtMass(o.m)} katı${ref ? ` (${escH(ref)})` : ""}. Bu kütlenin olay ufku yarıçapı ${L.fmtHorizon(d)} (hesaplandı): bu sınırı geçen hiçbir şey, ışık bile geri dönemez.`);
      } else if (o.cand) {
        p.push("Kara delik adayı: X-ışını patlamalarının davranışı kara deliğe benziyor ama kütlesi henüz yoldaş yıldızın hareketinden ölçülmedi.");
      }
      if (o.pb && d.comp) p.push(`Yoldaşı (${escH(d.comp)}) ile ${o.pb < 1 ? `${L.fmtSig(o.pb * 24, 3)} saatte` : `${L.fmtSig(o.pb, 3)} günde`} bir dolanıyor${o.k === "bh" && !o.gaia ? "; yoldaştan çekilen gaz kara deliğin çevresinde ısınıp X-ışını saçıyor" : ""}.`);
    } else {
      if (o.k === "mag") p.push(`Bir magnetar: manyetik alanı${o.bs ? ` Dünya'nınkinin ~${L.sci(d.b_earth, 1)} katı` : " evrende bilinen en güçlü alanlardan"}. Alanın kendini yeniden düzenlemesi zaman zaman güçlü X ve gama ışını patlamalarına yol açıyor.`);
      else if (o.k === "ns") p.push(`Güneş'ten ağır ama yalnızca ~20 km çapında bir nötron yıldızı: büyük kütleli bir yıldızın süpernova patlamasında çöken, atom çekirdeği yoğunluğundaki çekirdeği.${o.P ? ` ${o.P < 1 ? `Saniyede ${L.fmtSig(d.rate, 3)} kez` : `${L.fmtSig(o.P, 3)} saniyede bir`} dönüyor.` : ""}`);
      else if (o.P && o.P < 0.03) p.push(`Bir milisaniye pulsarı: saniyede ${L.fmtSig(d.rate, 3)} kez dönüyor. Bir yoldaştan madde çekerek bu hıza çıkarılmış ("geri dönüştürülmüş") yaşlı bir nötron yıldızı.`);
      else if (o.P) p.push(`Bir pulsar: Güneş'ten ağır ama yalnızca ~20 km çapında, ${o.P < 1 ? `saniyede ${L.fmtSig(d.rate, 3)} kez` : `${L.fmtSig(o.P, 3)} saniyede bir`} dönen bir nötron yıldızı. Manyetik kutuplarından çıkan ışın demeti her dönüşte Dünya'yı süpürdüğü için atımlar hâlinde görünüyor.`);
      if (o.age && o.k !== "merger") p.push(`Dönmesinin yavaşlamasından hesaplanan karakteristik yaşı ~${L.fmtYears(o.age)}${o.edot ? `; her saniye kaybettiği dönme enerjisi Güneş'in toplam ışığının ~${L.sci(d.edot_sun, 2)} katı` : ""} (hesaplandı).`);
      if (o.pb) p.push(`Bir yoldaşla${d.comp ? ` (${escH(d.comp)})` : ""} ${o.pb < 1 ? `${L.fmtSig(o.pb * 24, 3)} saatte` : `${L.fmtSig(o.pb, 3)} günde`} bir dolanıyor.`);
      const where = d.assoc.filter((a) => a.kind === "SNR" || a.kind === "GC" || a.kind === "EXGAL" || a.kind === "PWN" || a.kind === "OC");
      if (where.length) p.push(`İlişkili olduğu yer: ${where.map((a) => escH(a.text)).join("; ")}.`);
    }
    if (d.ly) {
      const how = o.dk === "dm" ? "Radyo atımlarının yıldızlararası elektronlarda gecikmesinden (DM) kabaca tahmin edilen uzaklığı" : o.dk === "px" ? "Paralaksından ölçülen uzaklığı" : "Uzaklığı";
      p.push(`${how} ${L.fmtLy(d.ly)}.`);
    }
    if (o.lb != null) p.push(`Kırmızıya kayması z = ${L.fmtSig(o.z, 3)}: ışığı bize yaklaşık ${L.fmtSig(o.lb, 3)} milyar yılda ulaştı (hesaplandı).`);
    if (o.yr && o.ds === "atnf") p.push(`Keşif yayını: ${o.yr}.`);
    return p;
  }

  global.Draugr = { derive, cleanSpec, narrate, narrateDeep, narrateCompact, title, fmt, fmtInt, fmtDist, LINES, CLASS_INFO, bvColor, teffFromBV, CON_TR };
})(window);
