/*
 * LichPhobetor — Phobetor yıldız bulma modelini tarayıcıda çalıştırır (onnxruntime-web).
 *
 * Model: Euclid Q1 görüntüleriyle eğitilmiş U-Net (models/phobetor_euclid.onnx, 4,7 milyon parametre;
 * tools/export_phobetor_onnx.py ile PyTorch'tan çevrildi). Her pikselin bir yıldız merkezi olma
 * olasılığını ve merkezin piksel içindeki kaymasını verir.
 *
 * Telefon/fotoğraf makinesi görüntüsü için: sRGB → doğrusal parlaklık; gökyüzü arka planı ve gürültüsü
 * 32 piksellik hücrelerde ölçülür; girdi = asinh((parlaklık − arka plan) / gürültü / 3), eğitimdeki
 * normalizasyonun aynısı. Euclid'in 4 bandına aynı parlaklık verilir. Eşik 0,10: Euclid'de seçilen 0,63
 * eşiği yıldızı galaksiden ayırmak içindi; gece fotoğrafında galaksi neredeyse yok, deneme görüntülerinde
 * 0,10 eşiği yanlış tespit vermeden en çok yıldızı buldu (bkz. web/README.md).
 *
 * Görüntü bellek için 256 satırlık şeritlerle (32 piksel bindirmeli) işlenir. WebGPU varsa onu, yoksa
 * WebAssembly'yi kullanır. Hiçbir veri bir sunucuya gönderilmez.
 */
(function (global) {
  "use strict";
  const ORT_VERSION = "1.31.1";
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const MODEL_URL = "models/phobetor_euclid.onnx";
  const THRESHOLD = 0.10;
  const STRETCH = 3.0;
  const STRIP = 256, PAD = 32;

  let sessionPromise = null;
  let backend = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Yapay zekâ çalıştırıcısı yüklenemedi (internet bağlantısını kontrol et)."));
      document.head.appendChild(s);
    });
  }

  async function fetchModel(onStatus) {
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error(`Phobetor modeli indirilemedi (HTTP ${r.status}).`);
    const total = +(r.headers.get("content-length") || 0);
    if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader(), parts = [];
    let got = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (onStatus && Date.now() - last > 150) {
        last = Date.now();
        const mb = (got / 1e6).toFixed(1);
        onStatus(total && got <= total ? `Phobetor modeli indiriliyor… ${Math.round((100 * got) / total)}% (${mb} MB, yalnızca ilk seferde)` : `Phobetor modeli indiriliyor… ${mb} MB`);
      }
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }

  async function createSession(model, ep) {
    const ort = global.ort;
    return ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: "all" });
  }

  /** Modeli ve çalıştırıcıyı (bir kez) yükle. */
  function init(onStatus) {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      onStatus && onStatus("Tarayıcıda model çalıştırıcısı (onnxruntime-web) yükleniyor…");
      if (!global.ort) await loadScript(ORT_BASE + "ort.min.js");
      const ort = global.ort;
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = global.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      ort.env.logLevel = "error";
      const model = await fetchModel(onStatus);
      onStatus && onStatus("Phobetor hazırlanıyor…");
      const eps = (navigator.gpu && !global.LICH_FORCE_WASM) ? ["webgpu", "wasm"] : ["wasm"];
      let lastErr = null;
      for (const ep of eps) {
        try {
          const session = await createSession(model, ep);
          backend = ep;
          return { session, model };
        } catch (e) { lastErr = e; console.warn("Phobetor:", ep, "başlatılamadı", e); }
      }
      throw new Error("Phobetor bu tarayıcıda başlatılamadı: " + (lastErr && lastErr.message));
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
    return sessionPromise;
  }

  // ------------------------------------------------------------------ görüntü
  /** Dosyayı çöz (EXIF yönüne göre döndürülmüş), uzun kenarı en fazla maxSide piksel olacak şekilde küçült. */
  async function loadImage(file, maxSide) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // bazı tarayıcılar seçenekleri desteklemiyor ya da biçimi açamıyor: <img> ile dene
      bmp = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file), im = new Image();
        im.onload = () => { resolve(im); setTimeout(() => URL.revokeObjectURL(url), 1000); };
        im.onerror = () => reject(new Error("Bu görüntü biçimi tarayıcında açılamadı; JPG ya da PNG olarak kaydedip tekrar dene."));
        im.src = url;
      });
    }
    const w0 = bmp.naturalWidth || bmp.width, h0 = bmp.naturalHeight || bmp.height;
    const k = Math.min(1, maxSide / Math.max(w0, h0));
    const W = Math.max(16, Math.round(w0 * k)), H = Math.max(16, Math.round(h0 * k));
    // büyük küçültmeyi yarıya indirerek yap (alan ortalamasına yakın, yıldızlar kaybolmaz)
    let src = bmp, sw = w0, sh = h0;
    while (sw / 2 >= W * 1.05 && sh / 2 >= H * 1.05) {
      const c = document.createElement("canvas");
      c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
      const cx = c.getContext("2d");
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
      cx.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, W, H);
    if (bmp.close) bmp.close();
    return { canvas, pixels: ctx.getImageData(0, 0, W, H).data, W, H, origW: w0, origH: h0, scale: k };
  }

  /** sRGB baytları → doğrusal parlaklık; ayrıca piksel doymuş mu (herhangi bir kanal ≥ 250). */
  function luminance(img) {
    const { pixels: data, W, H } = img;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 255; lut[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    const L = new Float32Array(W * H), sat = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      L[i] = 0.2126 * lut[r] + 0.7152 * lut[g] + 0.0722 * lut[b];
      sat[i] = r >= 250 || g >= 250 || b >= 250 ? 1 : 0;
    }
    return { L, sat };
  }

  /** Gökyüzü arka planı ve gürültüsü: hücrelerde sigma-kırpmalı ortalama/std, 3x3 medyan, doğrusal ara değer. */
  function background(L, W, H, cell = 32) {
    const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
    const bg = new Float32Array(nx * ny), sg = new Float32Array(nx * ny);
    const buf = new Float32Array(cell * cell);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let n = 0;
      for (let y = j * cell; y < Math.min(H, (j + 1) * cell); y++) for (let x = i * cell; x < Math.min(W, (i + 1) * cell); x++) buf[n++] = L[y * W + x];
      const v = buf.subarray(0, n).slice().sort();
      let m = v[n >> 1];
      const dev = Float32Array.from(v, (x) => Math.abs(x - m)).sort();
      let s = 1.4826 * dev[n >> 1];
      // 8 bitlik görüntüde gürültü bir basamaktan küçük olabilir: MAD sıfıra düşer; en yakın %80'in std'si alt sınır
      const k80 = Math.max(1, Math.floor(0.8 * n));
      let s2 = 0;
      for (let t = 0; t < k80; t++) s2 += dev[t] * dev[t];
      s = Math.max(s, Math.sqrt(s2 / k80) / 0.665);
      for (let it = 0; it < 3; it++) {
        let c = 0, sum = 0, sq = 0;
        const lim = 3 * Math.max(s, 1e-7);
        for (let t = 0; t < n; t++) { const x = v[t]; if (Math.abs(x - m) < lim) { c++; sum += x; sq += x * x; } }
        if (c < 20) break;
        m = sum / c;
        s = Math.sqrt(Math.max(0, sq / c - m * m)) / 0.9866;
      }
      bg[j * nx + i] = m; sg[j * nx + i] = s;
    }
    const med3 = (a) => {
      const out = new Float32Array(a.length), w = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        w.length = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const jj = Math.min(ny - 1, Math.max(0, j + dj)), ii = Math.min(nx - 1, Math.max(0, i + di));
          w.push(a[jj * nx + ii]);
        }
        w.sort((p, q) => p - q);
        out[j * nx + i] = w[4];
      }
      return out;
    };
    const B = med3(bg), S = med3(sg);
    const bgFull = new Float32Array(W * H), sgFull = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const gy = Math.min(ny - 1, Math.max(0, (y + 0.5) / cell - 0.5));
      const j0 = Math.floor(gy), j1 = Math.min(ny - 1, j0 + 1), ty = gy - j0;
      for (let x = 0; x < W; x++) {
        const gx = Math.min(nx - 1, Math.max(0, (x + 0.5) / cell - 0.5));
        const i0 = Math.floor(gx), i1 = Math.min(nx - 1, i0 + 1), tx = gx - i0;
        const o = y * W + x;
        bgFull[o] = (B[j0 * nx + i0] * (1 - tx) + B[j0 * nx + i1] * tx) * (1 - ty) + (B[j1 * nx + i0] * (1 - tx) + B[j1 * nx + i1] * tx) * ty;
        sgFull[o] = (S[j0 * nx + i0] * (1 - tx) + S[j0 * nx + i1] * tx) * (1 - ty) + (S[j1 * nx + i0] * (1 - tx) + S[j1 * nx + i1] * tx) * ty;
      }
    }
    const sorted = Float32Array.from(S).sort();
    return { bg: bgFull, sg: sgFull, noise: sorted[sorted.length >> 1] };
  }

  /** Modelin girdisi: asinh(S/N / 3), eğitimdeki normalizasyon. */
  function normalize(L, back, W, H) {
    const floor = Math.max(back.noise * 0.25, 1e-6);
    const x = new Float32Array(W * H);
    for (let i = 0; i < x.length; i++) {
      let z = (L[i] - back.bg[i]) / Math.max(back.sg[i], floor);
      z = z < -50 ? -50 : z;
      x[i] = Math.asinh(z / STRETCH);
    }
    return x;
  }

  /** Bir şeridi çalıştır: satır y0..y1 (bindirme dahil), genişlik 16'nın katına kenar tekrarıyla doldurulur. */
  async function runStrip(session, x, W, H, y0, y1) {
    const ort = global.ort;
    const h = y1 - y0, Hp = Math.ceil(h / 16) * 16, Wp = Math.ceil(W / 16) * 16;
    const plane = Hp * Wp, buf = new Float32Array(4 * plane);
    for (let yy = 0; yy < Hp; yy++) {
      const sy = Math.min(H - 1, y0 + Math.min(yy, h - 1));
      for (let xx = 0; xx < Wp; xx++) buf[yy * Wp + xx] = x[sy * W + Math.min(W - 1, xx)];
    }
    buf.copyWithin(plane, 0, plane);
    buf.copyWithin(2 * plane, 0, 2 * plane);
    const out = await session.run({ x: new ort.Tensor("float32", buf, [1, 4, Hp, Wp]) });
    const heat = out.heat.data, off = out.offset.data;
    return { heat, off, Wp, Hp, plane };
  }

  /**
   * Görüntüdeki yıldızları bul. img: loadImage'in döndürdüğü nesne.
   * Döner: {det: [{x, y, score, flux, sat}], backend, ms, threshold, noise}
   */
  async function detect(img, { onStatus } = {}) {
    let { session } = await init(onStatus);
    const { W, H } = img;
    const t0 = performance.now();
    const { L, sat } = luminance(img);
    const back = background(L, W, H);
    const x = normalize(L, back, W, H);
    const heat = new Float32Array(W * H), ox = new Float32Array(W * H), oy = new Float32Array(W * H);
    const strips = [];
    for (let y = 0; y < H; y += STRIP) strips.push(y);
    for (let s = 0; s < strips.length; s++) {
      const ya = strips[s], yb = Math.min(H, ya + STRIP);
      const y0 = Math.max(0, ya - PAD), y1 = Math.min(H, yb + PAD);
      onStatus && onStatus(`Phobetor yıldızları arıyor… (${s + 1}/${strips.length}, ${backend === "webgpu" ? "WebGPU" : "WebAssembly"})`);
      await new Promise((r) => setTimeout(r, 16));   // durum yazısı ekrana çıksın
      let r;
      try {
        r = await runStrip(session, x, W, H, y0, y1);
      } catch (e) {
        if (backend !== "webgpu") throw e;
        // WebGPU çalışırken hata: WebAssembly ile yeniden dene
        console.warn("Phobetor: WebGPU hatası, WebAssembly'ye geçiliyor", e);
        const st = await init(onStatus);
        st.session = await createSession(st.model, "wasm");
        backend = "wasm";
        session = st.session;
        r = await runStrip(session, x, W, H, y0, y1);
      }
      for (let y = ya; y < yb; y++) {
        const ry = y - y0;
        for (let xx = 0; xx < W; xx++) {
          const o = y * W + xx, q = ry * r.Wp + xx;
          heat[o] = r.heat[q]; ox[o] = r.off[q]; oy[o] = r.off[r.plane + q];
        }
      }
    }
    // 3x3 yerel tepe, eşik üstü
    const det = [];
    for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
      const o = y * W + xx, h = heat[o];
      if (!(h >= THRESHOLD)) continue;          // NaN de elenir
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const yy = y + dy, xq = xx + dx;
        if (yy < 0 || yy >= H || xq < 0 || xq >= W) continue;
        const n = heat[yy * W + xq];
        if (n > h || (n === h && (dy < 0 || (dy === 0 && dx < 0)))) { peak = false; break; }
      }
      if (!peak) continue;
      // ışık: 7x7 kutuda arka planı çıkarılmış toplam
      let flux = 0, s = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const yy = y + dy, xq = xx + dx;
        if (yy < 0 || yy >= H || xq < 0 || xq >= W) continue;
        const q = yy * W + xq;
        flux += L[q] - back.bg[q];
        s |= sat[q];
      }
      det.push({ x: xx + ox[o], y: y + oy[o], score: h, flux, sat: !!s });
    }
    const out = measureSaturated(det, L, sat, back.bg, W, H);
    out.sort((a, b) => b.flux - a.flux);
    return { det: out, backend, ms: Math.round(performance.now() - t0), threshold: THRESHOLD, noise: back.noise };
  }

  /**
   * Doymuş (kırpılmış) yıldızlar. Parlak yıldızların çekirdeği 255'te kesilir: 7x7 kutudaki ışık hepsinde
   * aynı çıkar ve "en parlak yıldızlar" sıralaması bozulur (uzun pozlamalı ya da üst üste yığılmış
   * fotoğraflarda yüzlerce yıldız doyar). Doymuş bölge bulunur (4-komşu, en çok 60 piksel öteye);
   * ışık, bölgenin büyüklüğüyle genişleyen dairesel bir açıklıkta ölçülür (doymuş alan + hale);
   * konum bölgenin ağırlık merkezi olur. Aynı doymuş bölgeye düşen ikinci tespit (halka, ışın) atılır.
   */
  function measureSaturated(det, L, sat, bg, W, H) {
    const owner = new Int32Array(W * H);
    const keep = new Uint8Array(det.length).fill(1);
    const order = [];
    for (let i = 0; i < det.length; i++) if (det[i].sat) order.push(i);
    order.sort((a, b) => det[b].score - det[a].score);
    const stack = [];
    let id = 0;
    for (const i of order) {
      const d = det[i];
      const x0 = Math.round(d.x), y0 = Math.round(d.y);
      let seed = -1, best = Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const q = y * W + x, r2 = dx * dx + dy * dy;
        if (sat[q] && r2 < best) { best = r2; seed = q; }
      }
      if (seed < 0) continue;
      if (owner[seed]) { keep[i] = 0; continue; }
      id++;
      const sx0 = seed % W, sy0 = (seed / W) | 0;
      let n = 0, sx = 0, sy = 0;
      stack.length = 0;
      stack.push(seed);
      owner[seed] = id;
      while (stack.length) {
        const q = stack.pop(), x = q % W, y = (q / W) | 0;
        n++; sx += x; sy += y;
        for (let k = 0; k < 4; k++) {
          const xn = x + (k === 0 ? 1 : k === 1 ? -1 : 0), yn = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (xn < 0 || yn < 0 || xn >= W || yn >= H || Math.abs(xn - sx0) > 60 || Math.abs(yn - sy0) > 60) continue;
          const qn = yn * W + xn;
          if (!sat[qn] || owner[qn]) continue;
          owner[qn] = id;
          stack.push(qn);
        }
      }
      if (n >= 3) { d.x = sx / n; d.y = sy / n; }
      const R = Math.min(40, Math.ceil(3 + 2.5 * Math.sqrt(n / Math.PI)));
      const cx = Math.round(d.x), cy = Math.round(d.y);
      let flux = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const q = y * W + x;
        flux += L[q] - bg[q];
      }
      d.flux = Math.max(d.flux, flux);
      d.satArea = n;
    }
    return det.filter((_, i) => keep[i]);
  }

  // ------------------------------------------------------------------ EXIF (odak, tarih)
  /** JPEG EXIF'inden 35 mm karşılığı odak, odak, kamera ve çekim zamanı. Bulamazsa {}. */
  async function readExif(file) {
    try {
      const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (buf.getUint16(0) !== 0xffd8) return {};
      let p = 2;
      while (p + 4 < buf.byteLength) {
        const marker = buf.getUint16(p), len = buf.getUint16(p + 2);
        if (marker === 0xffe1 && buf.getUint32(p + 4) === 0x45786966) return parseTiff(buf, p + 10);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        p += 2 + len;
      }
    } catch (_) { /* EXIF yok ya da bozuk */ }
    return {};
  }

  function parseTiff(dv, t0) {
    const le = dv.getUint16(t0) === 0x4949;
    const u16 = (o) => dv.getUint16(t0 + o, le), u32 = (o) => dv.getUint32(t0 + o, le);
    const out = {};
    const readIfd = (off, want) => {
      const n = u16(off), res = {};
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        if (!want.includes(tag)) continue;
        const valOff = (type === 2 && cnt > 4) || type === 5 ? u32(e + 8) : e + 8;
        if (type === 3) res[tag] = u16(e + 8);
        else if (type === 4) res[tag] = u32(e + 8);
        else if (type === 5) res[tag] = u32(valOff) / (u32(valOff + 4) || 1);
        else if (type === 2) { let s = ""; for (let k = 0; k < cnt - 1; k++) s += String.fromCharCode(dv.getUint8(t0 + valOff + k)); res[tag] = s.trim(); }
      }
      return res;
    };
    const ifd0 = readIfd(u32(4), [0x010f, 0x0110, 0x8769]);
    if (ifd0[0x010f]) out.make = ifd0[0x010f];
    if (ifd0[0x0110]) out.model = ifd0[0x0110];
    if (ifd0[0x8769]) {
      const ex = readIfd(ifd0[0x8769], [0xa405, 0x920a, 0x9003, 0x829a, 0xa002, 0xa003, 0xa20e, 0xa20f, 0xa210]);
      if (ex[0xa405]) { out.focal35 = ex[0xa405]; out.focal35From = "exif"; }
      if (ex[0x920a]) out.focal = ex[0x920a];
      if (ex[0x9003]) out.date = ex[0x9003];
      if (ex[0x829a]) out.exposure = ex[0x829a];
      // Fotoğraf makineleri (ör. Canon) 35 mm karşılığını yazmaz; algılayıcı boyu odak düzlemi
      // çözünürlüğünden bulunur: genişlik (mm) = piksel sayısı / (piksel / birim) × birim.
      if (!out.focal35 && out.focal && ex[0xa002] && ex[0xa20e]) {
        const unit = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 }[ex[0xa210] || 2];
        const w = (ex[0xa002] / ex[0xa20e]) * unit;
        const h = ex[0xa003] && ex[0xa20f] ? (ex[0xa003] / ex[0xa20f]) * unit : (w * 2) / 3;
        if (unit && w > 3 && w < 60 && h > 2 && h < 60) {
          out.focal35 = Math.round((out.focal * 43.27) / Math.hypot(w, h));
          out.focal35From = "sensor";
          out.sensorMm = [+w.toFixed(1), +h.toFixed(1)];
        }
      }
      // yalnızca gerçek odak varsa: fotoğraf makinesi (APS-C, 1,5x) varsayımıyla bir başlangıç tahmini
      if (!out.focal35 && out.focal >= 10) { out.focal35 = Math.round(out.focal * 1.5); out.focal35From = "guess"; }
    }
    return out;
  }

  global.LichPhobetor = {
    init, detect, loadImage, readExif,
    get backend() { return backend; },
    THRESHOLD, ORT_VERSION,
  };
})(window);
