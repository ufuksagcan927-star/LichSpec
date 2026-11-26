/*
 * LichSolve — bir gece fotoğrafının gökyüzünde nereye baktığını, yalnızca fotoğraftaki yıldızların
 * desenine bakarak bulur ("kör astrometri"). Telefon ve fotoğraf makinesi görüntüleri (geniş açı)
 * için yazıldı; sunucu ya da dış servis kullanmaz, LichSpec'in parlak yıldız kataloğuyla çalışır.
 *
 * Yöntem (yıldız izleyicilerdeki "kayıp uzay" çözümüne benzer):
 *   1. Kameranın odak uzaklığı (görüş açısı) bilinmiyor: olası değerler tek tek denenir; EXIF'te
 *      35 mm karşılığı odak varsa önce o denenir.
 *   2. Her odak için en parlak ~12 yıldızın birbirine açısal uzaklıkları hesaplanır. Katalogda aynı
 *      uzaklıklara sahip üçgenler aranır (ayna görüntüsü elenir).
 *   3. Her aday üçgen için kamera yönü bulunur, diğer parlak yıldızların tahmin edilen yerinde katalog
 *      yıldızı var mı diye bakılır; geçenler bütün görüntüyle doğrulanır (rastlantı olasılığı < 1e-9).
 *   4. Kabul edilen çözümde yön, odak, mercek bozulması (k1, k2) ve optik merkez en küçük kareler
 *      yöntemiyle eşleşen bütün yıldızlara uydurulur.
 *
 * Kamera modeli: düzlemsel (gnomonik) izdüşüm + radyal bozulma. Görüntü x sağa, y aşağı.
 */
(function (global) {
  "use strict";
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // ------------------------------------------------------------------ vektör yardımcıları
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
  const sep = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
  const radec2v = (ra, dec) => { const a = ra * D2R, d = dec * D2R, c = Math.cos(d); return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)]; };
  const v2radec = (v) => [((Math.atan2(v[1], v[0]) * R2D) % 360 + 360) % 360, Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D];
  const mulRv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const mulRtv = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  const det3 = (a, b, c) => dot(a, cross(b, c));

  /** Simetrik 4x4 matrisin en büyük özdeğerinin özvektörü (Jacobi yöntemi). */
  function topEigen4(A) {
    const a = A.map((r) => r.slice());
    const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let sweep = 0; sweep < 30; sweep++) {
      let off = 0;
      for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
      if (off < 1e-22) break;
      for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    let best = 0;
    for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
    return [V[0][best], V[1][best], V[2][best], V[3][best]];
  }

  /** u_i ≈ R s_i olacak dönme matrisi (Horn'un kuaterniyon yöntemi, ağırlıklı). R satır düzeninde 9 sayı. */
  function attitude(us, ss, ws) {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < us.length; i++) {
      const w = ws ? ws[i] : 1, s = ss[i], u = us[i];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w * s[r] * u[c];
    }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [
      [xx + yy + zz, yz - zy, zx - xz, xy - yx],
      [yz - zy, xx - yy - zz, xy + yx, zx + xz],
      [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
      [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ];
    const [w, x, y, z] = topEigen4(N);
    return [
      w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
    ];
  }

  /** Küçük bir dönme vektörü (radyan) ile R'yi soldan döndür: R' = exp([w]x) R */
  function rotate(R, w) {
    const th = Math.hypot(w[0], w[1], w[2]);
    if (th < 1e-15) return R.slice();
    const k = [w[0] / th, w[1] / th, w[2] / th], c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    const Q = [
      c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
      k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
      k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C,
    ];
    const out = new Array(9);
    for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) out[r * 3 + col] = Q[r * 3] * R[col] + Q[r * 3 + 1] * R[3 + col] + Q[r * 3 + 2] * R[6 + col];
    return out;
  }

  // ------------------------------------------------------------------ katalog
  /** Parlak yıldız kataloğu: parlaklığa göre sıralı, kuzey-güney şeritlerine bölünmüş hızlı arama ızgarası. */
  function Catalog(stars, maxMag = 6.5) {
    const list = stars.filter((s) => typeof s.v === "number" && s.v <= maxMag && isFinite(s.ra) && isFinite(s.dec))
      .slice().sort((a, b) => a.v - b.v);
    this.stars = list;
    this.n = list.length;
    this.u = list.map((s) => radec2v(s.ra, s.dec));
    this.mag = Float64Array.from(list, (s) => s.v);
    this.band = 2;                       // derece
    this.nb = 180 / this.band;
    this.bands = [];
    for (let b = 0; b < this.nb; b++) {
      const lo = -90 + b * this.band, hi = lo + this.band;
      const c = Math.cos(Math.min(Math.abs(lo), Math.abs(hi)) * D2R);
      const nra = Math.max(1, Math.floor((360 * c) / this.band));
      this.bands.push({ nra, cells: Array.from({ length: nra }, () => []) });
    }
    list.forEach((s, i) => {
      const b = Math.min(this.nb - 1, Math.floor((s.dec + 90) / this.band));
      const B = this.bands[b];
      B.cells[Math.min(B.nra - 1, Math.floor((s.ra / 360) * B.nra))].push(i);
    });
    this.pairCache = new Map();
  }

  /** u yönüne r (radyan) içindeki, parlaklığı maxMag'den parlak yıldızlar için cb(i, cosAçı). */
  Catalog.prototype.cone = function (u, r, maxMag, cb) {
    const [ra, dec] = v2radec(u);
    const rd = r * R2D, cosR = Math.cos(r);
    const b0 = Math.max(0, Math.floor((dec - rd + 90) / this.band)), b1 = Math.min(this.nb - 1, Math.floor((dec + rd + 90) / this.band));
    for (let b = b0; b <= b1; b++) {
      const B = this.bands[b];
      const lo = -90 + b * this.band, hi = lo + this.band;
      const maxAbs = Math.max(Math.abs(lo), Math.abs(hi));
      let c0 = 0, c1 = B.nra - 1;
      if (maxAbs < 89.5) {
        const w = rd / Math.cos(maxAbs * D2R);
        if (2 * w < 360) { c0 = Math.floor(((ra - w) / 360) * B.nra); c1 = Math.floor(((ra + w) / 360) * B.nra); }
      }
      if (c1 - c0 + 1 > B.nra) { c0 = 0; c1 = B.nra - 1; }
      for (let cc = c0; cc <= c1; cc++) {
        const cell = B.cells[((cc % B.nra) + B.nra) % B.nra];
        for (let t = 0; t < cell.length; t++) {
          const i = cell[t];
          if (this.mag[i] > maxMag) break;      // hücre parlaklığa göre sıralı
          const d = dot(u, this.u[i]);
          if (d >= cosR) cb(i, d);
        }
      }
    }
  };

  Catalog.prototype.nearest = function (u, r, maxMag) {
    let best = -1, bd = -2;
    this.cone(u, r, maxMag, (i, d) => { if (d > bd) { bd = d; best = i; } });
    return best;
  };

  Catalog.prototype.countBrighter = function (m) {
    let lo = 0, hi = this.n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.mag[mid] <= m) lo = mid + 1; else hi = mid; }
    return lo;
  };

  /** k en parlak yıldızın, maxSep'ten (radyan) yakın bütün çiftleri; açıya göre kovalara ayrılmış. */
  Catalog.prototype.pairs = function (k, maxSep) {
    // komşu odak değerleri aynı listeyi kullansın: k ~%25'lik, açı 5°'lik basamaklara yuvarlanır
    k = Math.min(this.n, Math.round(60 * Math.pow(1.25, Math.ceil(Math.log(k / 60) / Math.log(1.25) - 1e-9))));
    maxSep = Math.min(Math.PI, Math.ceil((maxSep * R2D) / 5 - 1e-9) * 5 * D2R);
    const key = k + "|" + Math.round(maxSep * R2D);
    if (this.pairCache.has(key)) return this.pairCache.get(key);
    const cosMax = Math.cos(maxSep);
    const A = [], B = [], S = [];
    if (k > 400 && maxSep < 40 * D2R) {
      // dar alan, derin katalog: her yıldızın yalnızca yakın komşuları (ızgarayla)
      const mk = this.mag[k - 1];
      for (let i = 0; i < k; i++) {
        const ui = this.u[i];
        this.cone(ui, maxSep, mk, (j) => { if (j > i && j < k) { A.push(i); B.push(j); S.push(sep(ui, this.u[j])); } });
      }
    } else {
      for (let i = 0; i < k; i++) {
        const ui = this.u[i];
        for (let j = i + 1; j < k; j++) {
          const d = dot(ui, this.u[j]);
          if (d >= cosMax) { A.push(i); B.push(j); S.push(sep(ui, this.u[j])); }
        }
      }
    }
    const bw = 0.05 * D2R, nbin = Math.ceil(maxSep / bw) + 1;
    const start = new Int32Array(nbin + 1);
    for (const s of S) start[Math.min(nbin - 1, Math.floor(s / bw)) + 1]++;
    for (let i = 0; i < nbin; i++) start[i + 1] += start[i];
    const fill = start.slice(0, nbin);
    const a = new Int32Array(S.length), b = new Int32Array(S.length), s = new Float64Array(S.length);
    for (let t = 0; t < S.length; t++) {
      const bin = Math.min(nbin - 1, Math.floor(S[t] / bw)), p = fill[bin]++;
      a[p] = A[t]; b[p] = B[t]; s[p] = S[t];
    }
    const out = { a, b, s, start, bw, nbin, k };
    // bellek sınırı (telefonlar): önbellekte toplam en çok ~3 milyon çift
    let total = S.length;
    for (const v of this.pairCache.values()) total += v.s.length;
    if (total > 3e6 || this.pairCache.size > 12) this.pairCache.clear();
    this.pairCache.set(key, out);
    return out;
  };

  /** lo..hi (radyan) arasındaki çiftleri bul. */
  function pairsInRange(P, lo, hi, out) {
    const b0 = Math.max(0, Math.floor(lo / P.bw)), b1 = Math.min(P.nbin - 1, Math.floor(hi / P.bw));
    for (let t = P.start[b0]; t < P.start[b1 + 1]; t++) {
      const s = P.s[t];
      if (s >= lo && s <= hi) out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------------ kamera modeli
  /** rpix: bozulma teriminin geçerli olduğu en büyük uzaklık (piksel, optik merkezden). Ötesinde bozulma
   *  sabit tutulur; yoksa çok uzaktaki noktalar polinom yüzünden görüntünün ortasına geri katlanır. */
  function Camera(R, f, cx, cy, k1 = 0, k2 = 0, rpix = Infinity) {
    Object.assign(this, { R, f, cx, cy, k1, k2, rpix });
  }
  /** gök birim vektörü → piksel; kameranın arkasındaysa null */
  Camera.prototype.project = function (s) {
    const v = mulRv(this.R, s);
    if (v[2] <= 1e-6) return null;
    const xn = v[0] / v[2], yn = v[1] / v[2], r2 = Math.min(xn * xn + yn * yn, (this.rpix / this.f) ** 2);
    const k = 1 + this.k1 * r2 + this.k2 * r2 * r2;
    return [this.cx + this.f * xn * k, this.cy + this.f * yn * k];
  };
  Camera.prototype.ray = function (x, y) {
    const xd = (x - this.cx) / this.f, yd = (y - this.cy) / this.f;
    let xn = xd, yn = yd;
    for (let it = 0; it < 8 && (this.k1 || this.k2); it++) {
      const r2 = xn * xn + yn * yn, k = 1 + this.k1 * r2 + this.k2 * r2 * r2;
      xn = xd / k; yn = yd / k;
    }
    return unit([xn, yn, 1]);
  };
  Camera.prototype.sky = function (x, y) { return mulRtv(this.R, this.ray(x, y)); };
  Camera.prototype.pix2world = function (x, y) { return v2radec(this.sky(x, y)); };
  Camera.prototype.world2pix = function (ra, dec) { return this.project(radec2v(ra, dec)); };

  // ------------------------------------------------------------------ doğrulama ve iyileştirme
  function logBinomTail(n, k, p) {
    // log10 P(X >= k), X ~ Bin(n, p); küçük olasılıklar için toplam
    if (k <= 0) return 0;
    if (p <= 0) return -Infinity;
    const lgam = (x) => {   // Lanczos
      const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
        12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
      if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgam(1 - x);
      x -= 1; let a = c[0]; const t = x + g + 0.5;
      for (let i = 1; i < 9; i++) a += c[i] / (x + i);
      return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
    };
    let sum = -Infinity;
    for (let j = k; j <= n; j++) {
      const lt = lgam(n + 1) - lgam(j + 1) - lgam(n - j + 1) + j * Math.log(p) + (n - j) * Math.log1p(-p);
      sum = sum === -Infinity ? lt : Math.max(sum, lt) + Math.log1p(Math.exp(-Math.abs(sum - lt)));
    }
    return sum / Math.LN10;
  }

  /**
   * Kamera modeliyle katalog yıldızlarını görüntüye düşür, en yakın tespitlerle eşleştir.
   * Döner: {pairs: [[detIndex, catIndex, dx, dy]], nCat}
   */
  function matchAll(ctx, cam, maxMag, radius, nDet) {
    const { cat, det, W, H } = ctx;
    const n = Math.min(nDet, det.length);
    // görüntüdeki katalog yıldızları
    const center = cam.sky(W / 2, H / 2);
    const half = Math.atan(Math.hypot(W, H) / 2 / cam.f) * 1.15 + 0.01;
    const proj = [];
    cat.cone(center, Math.min(half, Math.PI * 0.75), maxMag, (i) => {
      const p = cam.project(cat.u[i]);
      if (p && p[0] >= -2 && p[1] >= -2 && p[0] <= W + 1 && p[1] <= H + 1) proj.push([i, p[0], p[1]]);
    });
    // basit ızgara: tespitler
    const cell = Math.max(8, radius * 2), gw = Math.ceil(W / cell) + 1, grid = new Map();
    for (let d = 0; d < n; d++) {
      const key = Math.floor(det[d].y / cell) * gw + Math.floor(det[d].x / cell);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(d);
    }
    // her katalog yıldızı için en yakın tespit; her tespit en fazla bir yıldıza (önce parlak yıldız)
    proj.sort((p, q) => cat.mag[p[0]] - cat.mag[q[0]]);
    const used = new Uint8Array(n), out = [];
    const r2 = radius * radius;
    for (const [i, x, y] of proj) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      let best = -1, bd = r2;
      for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
        const L = grid.get(yy * gw + xx);
        if (!L) continue;
        for (const d of L) {
          if (used[d]) continue;
          const dd = (det[d].x - x) ** 2 + (det[d].y - y) ** 2;
          if (dd < bd) { bd = dd; best = d; }
        }
      }
      if (best >= 0) { used[best] = 1; out.push([best, i, det[best].x - x, det[best].y - y]); }
    }
    return { pairs: out, nCat: proj.length };
  }

  /** Rastlantıyla bu kadar eşleşme çıkma olasılığının log10'u. */
  function significance(ctx, m, nCat, radius, nDet) {
    const p = Math.min(0.5, (nCat * Math.PI * radius * radius) / (ctx.W * ctx.H));
    return logBinomTail(Math.min(nDet, ctx.det.length), m, p);
  }

  /** Eşleşmelere Gauss-Newton ile kamera uydur. free: hangi parametreler serbest. */
  function refit(ctx, cam, pairs, free) {
    const { cat, det } = ctx;
    let c = new Camera(cam.R.slice(), cam.f, cam.cx, cam.cy, cam.k1, cam.k2, cam.rpix);
    const names = ["wx", "wy", "wz", "lf"].concat(free);
    const resid = (cm) => {
      const r = [];
      for (const [d, i] of pairs) {
        const p = cm.project(cat.u[i]);
        if (!p) { r.push(1e3, 1e3); continue; }
        r.push(p[0] - det[d].x, p[1] - det[d].y);
      }
      return r;
    };
    const apply = (base, dp) => {
      const R = rotate(base.R, [dp[0], dp[1], dp[2]]);
      const out = new Camera(R, base.f * Math.exp(dp[3]), base.cx, base.cy, base.k1, base.k2, base.rpix);
      names.forEach((nm, j) => {
        if (j < 4) return;
        if (nm === "k1") out.k1 += dp[j];
        else if (nm === "k2") out.k2 += dp[j];
        else if (nm === "cx") out.cx += dp[j];
        else if (nm === "cy") out.cy += dp[j];
      });
      return out;
    };
    const steps = { wx: 1e-6, wy: 1e-6, wz: 1e-6, lf: 1e-6, k1: 1e-5, k2: 1e-5, cx: 0.05, cy: 0.05 };
    let r0 = resid(c), cost = r0.reduce((s, v) => s + v * v, 0), lambda = 1e-3;
    for (let it = 0; it < 12; it++) {
      const np = names.length, m = r0.length;
      const J = names.map((nm, j) => {
        const dp = new Array(np).fill(0); dp[j] = steps[nm];
        const r1 = resid(apply(c, dp));
        return r1.map((v, t) => (v - r0[t]) / steps[nm]);
      });
      // normal denklemler
      const A = Array.from({ length: np }, () => new Array(np).fill(0)), g = new Array(np).fill(0);
      for (let a = 0; a < np; a++) {
        for (let b = a; b < np; b++) { let s = 0; for (let t = 0; t < m; t++) s += J[a][t] * J[b][t]; A[a][b] = A[b][a] = s; }
        let s = 0; for (let t = 0; t < m; t++) s += J[a][t] * r0[t]; g[a] = -s;
      }
      let improved = false;
      for (let tries = 0; tries < 6; tries++) {
        const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
        const dp = solveLinear(M, g);
        if (!dp) { lambda *= 10; continue; }
        const cand = apply(c, dp), r1 = resid(cand), c1 = r1.reduce((s, v) => s + v * v, 0);
        if (c1 < cost) { c = cand; r0 = r1; improved = cost - c1 > 1e-9 * cost; cost = c1; lambda = Math.max(1e-7, lambda / 5); break; }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { cam: c, rms: Math.sqrt(cost / Math.max(1, r0.length)) };
  }

  function solveLinear(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-300) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x.every(isFinite) ? x : null;
  }

  // ------------------------------------------------------------------ üçgen arama
  /** İki görüntü noktası (merkeze göre piksel) arasındaki açı, odak f için. */
  function pixAngle(p, q, f) {
    return sep(unit([p[0], p[1], f]), unit([q[0], q[1], f]));
  }

  function solidAngle(W, H, f) {
    const a = Math.atan(W / 2 / f), b = Math.atan(H / 2 / f);
    return 4 * Math.asin(Math.sin(a) * Math.sin(b));
  }

  /**
   * Bir odak değeri için üçgen eşleştirme. Bulursa {cam, ...} döner.
   * Üçgenin en az adayı olan kenarı odağı sabitler; diğer iki kenar bu odakla dar bir toleransta aranır.
   */
  function tryFocal(ctx, f, rel, budget, stats) {
    const { cat, det, W, H, N } = ctx;
    const cx = (W - 1) / 2, cy = (H - 1) / 2;
    const omega = solidAngle(W, H, f);
    // görüntüye düşmesi beklenen katalog yıldızı sayısı ~ hedef olacak şekilde parlaklık sınırı
    const target = Math.max(18, 3 * N);
    let k = Math.round((target * 4 * Math.PI) / omega);
    k = Math.max(60, Math.min(cat.n, k));
    const mlim = cat.mag[k - 1];
    const diag = 2 * Math.atan(Math.hypot(W, H) / 2 / f);
    const P = cat.pairs(k, Math.min(diag, 110 * D2R) + 1 * D2R);
    const pts = det.slice(0, N).map((d) => [d.x - cx, d.y - cy]);
    const U = pts.map((p) => unit([p[0], p[1], f]));
    const pixAng = 1 / f;                                    // radyan/piksel (merkezde)
    const minSide = Math.max(1.0 * D2R, 0.04 * diag);
    const info = new Map();                                  // görüntü çifti → açı, eğim, adaylar
    const pairInfo = (i, j) => {
      const key = i * 64 + j;
      if (info.has(key)) return info.get(key);
      const d = sep(U[i], U[j]);
      const d2 = pixAngle(pts[i], pts[j], f * 1.001);
      const slope = (d2 - d) / (0.001 * f);                // dθ/df (< 0)
      const tol = d * rel + 4 * pixAng + 0.02 * D2R;
      const list = pairsInRange(P, d - tol, d + tol, []);
      const map = new Map();
      for (const t of list) {
        const a = P.a[t], b = P.b[t];
        if (!map.has(a)) map.set(a, []);
        if (!map.has(b)) map.set(b, []);
        map.get(a).push(b, t); map.get(b).push(a, t);
      }
      const o = { d, slope, list, map };
      info.set(key, o);
      return o;
    };
    // Dördüncü yıldız: üçgenin dışındaki parlak yıldızlardan biri için katalogda p, q ve c'ye doğru
    // uzaklıklarda bir yıldız olmalı. Yalnızca uzaklık tablolarıyla yapılır (kamera yönü hesaplanmadan),
    // rastlantısal üçgen eşleşmelerinin çoğunu ucuzca eler.
    const fourthFits = (A, B, C, p, q, c, fq) => {
      for (let D = 0; D < N; D++) {
        if (D === A || D === B || D === C) continue;
        const e = pairInfo(Math.min(A, D), Math.max(A, D));
        const L = e.map.get(p);
        if (!L) continue;
        const dAD = e.d + e.slope * (fq - f), tAD = 0.008 * dAD + 3 / fq + 0.02 * D2R;
        const dBD = pixAngle(pts[B], pts[D], fq), dCD = pixAngle(pts[C], pts[D], fq);
        const tBD = 0.008 * dBD + 3 / fq + 0.02 * D2R, tCD = 0.008 * dCD + 3 / fq + 0.02 * D2R;
        const bLo = Math.cos(dBD + tBD), bHi = Math.cos(Math.max(0, dBD - tBD));
        const cLo = Math.cos(dCD + tCD), cHi = Math.cos(Math.max(0, dCD - tCD));
        const uq = cat.u[q], uc = cat.u[c];
        for (let z = 0; z < L.length; z += 2) {
          const x = L[z];
          if (x === q || x === c || Math.abs(P.s[L[z + 1]] - dAD) > tAD) continue;
          const ux = cat.u[x];
          const dq = uq[0] * ux[0] + uq[1] * ux[1] + uq[2] * ux[2];
          if (dq < bLo || dq > bHi) continue;
          const dc = uc[0] * ux[0] + uc[1] * ux[1] + uc[2] * ux[2];
          if (dc < cLo || dc > cHi) continue;
          return true;
        }
      }
      return false;
    };
    for (let kk = 2; kk < N; kk++) for (let jj = 1; jj < kk; jj++) for (let ii = 0; ii < jj; ii++) {
      if (budget.left() <= 0) return null;
      const dij = sep(U[ii], U[jj]), dik = sep(U[ii], U[kk]), djk = sep(U[jj], U[kk]);
      if (Math.min(dij, dik, djk) < minSide) continue;
      if (Math.abs(det3(U[ii], U[jj], U[kk])) < 1e-5) continue;          // neredeyse doğrusal
      const e = [pairInfo(ii, jj), pairInfo(ii, kk), pairInfo(jj, kk)];
      if (!e[0].list.length || !e[1].list.length || !e[2].list.length) continue;
      // en az adaylı kenar A-B olsun, üçüncü köşe C
      let A, B, C, eAB, eAC, eBC;
      const m = e.indexOf(e.reduce((x, y) => (y.list.length < x.list.length ? y : x)));
      if (m === 0) { A = ii; B = jj; C = kk; eAB = e[0]; eAC = e[1]; eBC = e[2]; }
      else if (m === 1) { A = ii; B = kk; C = jj; eAB = e[1]; eAC = e[0]; eBC = e[2]; }
      else { A = jj; B = kk; C = ii; eAB = e[2]; eAC = e[0]; eBC = e[1]; }
      // kenar bilgileri sıralı çiftler için; A<C değilse aynı açı geçerli
      const chi = Math.sign(det3(U[A], U[B], U[C]));
      for (const t of eAB.list) {
        const sAB = P.s[t];
        const fpq = f + (sAB - eAB.d) / eAB.slope;
        const dAC = eAC.d + eAC.slope * (fpq - f), dBC = eBC.d + eBC.slope * (fpq - f);
        const tAC = 0.008 * dAC + 3 / fpq + 0.02 * D2R, tBC = 0.008 * dBC + 3 / fpq + 0.02 * D2R;
        const bcLo = Math.cos(dBC + tBC), bcHi = Math.cos(Math.max(0, dBC - tBC));
        for (let o = 0; o < 2; o++) {
          const p = o ? P.b[t] : P.a[t], q = o ? P.a[t] : P.b[t];
          const L1 = eAC.map.get(p);
          if (!L1) continue;
          const uq = cat.u[q];
          for (let z = 0; z < L1.length; z += 2) {
            const c = L1[z];
            if (c === q || Math.abs(P.s[L1[z + 1]] - dAC) > tAC) continue;
            const uc = cat.u[c], dqc = uq[0] * uc[0] + uq[1] * uc[1] + uq[2] * uc[2];
            if (dqc < bcLo || dqc > bcHi) continue;
            if (Math.sign(det3(cat.u[p], cat.u[q], cat.u[c])) !== chi) continue;   // ayna görüntüsü
            if (!fourthFits(A, B, C, p, q, c, fpq)) continue;
            if (stats) stats.tested++;
            const res = checkTriangle(ctx, [A, B, C], [p, q, c], pts, fpq, mlim);
            if (res) return Object.assign(res, { f0: f, mlim });
          }
        }
      }
    }
    return null;
  }

  /** Aday üçgeni dene: yönü bul, diğer parlak yıldızlarla hızlı kontrol, sonra tam doğrulama. */
  function checkTriangle(ctx, I, C, pts, f, mlim) {
    const { cat, det, W, H, N } = ctx;
    const S = C.map((c) => cat.u[c]);
    const U = I.map((i) => unit([pts[i][0], pts[i][1], f]));
    const R = attitude(U, S);
    const cam = new Camera(R, f, (W - 1) / 2, (H - 1) / 2, 0, 0, 0.6 * Math.hypot(W, H));
    // diğer en parlak yıldızlar: tahmin edilen yerde katalog yıldızı var mı?
    let hit = 0, tried = 0;
    for (let l = 0; l < N && tried < 8; l++) {
      if (I.includes(l)) continue;
      tried++;
      const s = cam.sky(det[l].x, det[l].y);
      let off = 0;
      for (const x of S) off = Math.max(off, sep(x, s));
      const r = 5 / f + 0.015 * off + 0.03 * D2R;
      if (cat.nearest(s, r, mlim + 1.0) >= 0) hit++;
      if (hit >= 2) break;
    }
    if (hit < Math.min(2, Math.max(1, tried - 3))) return null;
    // tam doğrulama
    const nDet = Math.min(det.length, Math.max(40, 3 * N));
    const radius = Math.max(3, 0.012 * Math.hypot(W, H));
    const magV = Math.min(6.5, mlim + 1.5);
    const m = matchAll(ctx, cam, magV, radius, nDet);
    const logp = significance(ctx, m.pairs.length, m.nCat, radius, nDet);
    if (m.pairs.length < 6 || logp > -9) return null;
    return { cam, logp, nMatch: m.pairs.length };
  }

  /** Kabul edilen çözümü bütün yıldızlarla iyileştir. */
  function polish(ctx, cam0) {
    const { W, H, det } = ctx;
    const diag = Math.hypot(W, H);
    let cam = cam0, radius = Math.max(3, 0.012 * diag), result = null, prevRms = Infinity;
    const nDet = Math.min(det.length, 400);
    for (let it = 0; it < 8; it++) {
      const m = matchAll(ctx, cam, 6.5, radius, nDet);
      if (m.pairs.length < 4) break;
      // Üçgenden gelen ilk çözümün odağı birkaç yüzde kaymış olabilir: önce yalnızca yön ve odak,
      // eşleşmeler oturunca mercek bozulması, en son optik merkez serbest bırakılır.
      const free = [];
      if (prevRms < 3 && m.pairs.length >= 10) free.push("k1");
      if (prevRms < 1.5 && m.pairs.length >= 30) free.push("k2", "cx", "cy");
      const fit = refit(ctx, cam, m.pairs, free);
      // akıl dışı bozulma ya da merkez kaymasını reddet
      const c = fit.cam;
      const r2max = (diag / 2 / c.f) ** 2;
      const kEdge = Math.abs(c.k1 * r2max + c.k2 * r2max * r2max);
      if (kEdge > 0.25 || Math.abs(c.cx - (W - 1) / 2) > 0.2 * W || Math.abs(c.cy - (H - 1) / 2) > 0.2 * H) {
        const fit2 = refit(ctx, cam, m.pairs, m.pairs.length >= 10 ? ["k1"] : []);
        cam = fit2.cam; result = { pairs: m.pairs, rms: fit2.rms };
      } else { cam = c; result = { pairs: m.pairs, rms: fit.rms }; }
      radius = Math.max(2, Math.min(radius, 4 * result.rms + 1.5));
      prevRms = result.rms;
    }
    const m = matchAll(ctx, cam, 6.5, radius, nDet);
    const logp = significance(ctx, m.pairs.length, m.nCat, radius, nDet);
    return { cam, pairs: m.pairs, radius, logp, rms: result ? result.rms : NaN };
  }

  /**
   * Çizgiler (uçak ve uydu izleri, fotoğrafa çizilmiş çizgiler, iki fotoğrafı ayıran kenar) birkaç piksel
   * arayla dizilmiş ve çoğu zaman yıldızlardan parlak ölçülen tespitler verir. (1) En az iki komşusu çok
   * yakın olan tespitler; (2) en parlak 40 tespitten en az 6'sının ±0,8 piksel içinde dizildiği doğruların
   * üstündeki tespitler sıranın sonuna alınır: üçgen kurmakta kullanılmazlar, doğrulamada yine sayılırlar.
   * Rastgele 40 yıldızdan 6'sının böyle dizilme olasılığı yaklaşık %1'dir.
   */
  function demoteChains(det, W, H) {
    const rc = Math.max(4, 0.008 * Math.max(W, H)), cell = rc;
    const grid = new Map();
    const key = (gx, gy) => gx * 100003 + gy;
    det.forEach((d, i) => {
      const k = key(Math.floor(d.x / cell), Math.floor(d.y / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    const late = new Uint8Array(det.length);
    det.forEach((d, i) => {
      const gx = Math.floor(d.x / cell), gy = Math.floor(d.y / cell);
      let n = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const j of grid.get(key(gx + a, gy + b)) || []) {
          if (j !== i && Math.hypot(det[j].x - d.x, det[j].y - d.y) <= rc) n++;
        }
      }
      if (n >= 2) late[i] = 1;
    });
    for (let round = 0; round < 8; round++) {
      const top = [];
      for (let i = 0; i < det.length && top.length < 40; i++) if (!late[i]) top.push(i);
      let best = null, bestN = 5;
      for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) {
        const p = det[top[a]], q = det[top[b]];
        const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy);
        if (L < 2 * rc) continue;
        const nx = -dy / L, ny = dx / L, c = nx * p.x + ny * p.y;
        let n = 0;
        for (const t of top) if (Math.abs(nx * det[t].x + ny * det[t].y - c) <= 0.8) n++;
        if (n > bestN) { bestN = n; best = [nx, ny, c]; }
      }
      if (!best) break;
      const [nx, ny, c] = best;
      det.forEach((d, i) => { if (Math.abs(nx * d.x + ny * d.y - c) <= 1.2) late[i] = 1; });
    }
    const keep = [], rest = [];
    det.forEach((d, i) => (late[i] ? rest : keep).push(d));
    return keep.concat(rest);
  }

  /**
   * Çöz. det: [{x, y, flux}] (parlaklığa göre sıralanacak), W, H: görüntü boyutu (piksel).
   * opts.focal35: EXIF 35 mm karşılığı odak (mm), opts.timeLimitMs, opts.onProgress(text).
   */
  function solve(catalog, detections, W, H, opts = {}) {
    const t0 = Date.now();
    const limit = opts.timeLimitMs || 45000;
    const det = demoteChains(detections.slice().sort((a, b) => b.flux - a.flux), W, H);
    if (det.length < 5) return { ok: false, reason: "few_stars", nDet: det.length };
    const N = Math.min(opts.nTriangle || 12, det.length);
    const ctx = { cat: catalog, det, W, H, N };
    const budget = { left: () => limit - (Date.now() - t0) };
    const longSide = Math.max(W, H), diag = Math.hypot(W, H);
    // odak ızgarası: uzun kenar boyunca 6°–130° görüş açısı, %4 adım
    const step = 0.04;
    const fMin = longSide / 2 / Math.tan(65 * D2R), fMax = longSide / 2 / Math.tan(3 * D2R);
    const grid = [];
    for (let f = fMin; f <= fMax; f *= 1 + step) grid.push(f);
    // önce en olası: EXIF varsa o, yoksa telefonların ana kamerası (~67° uzun kenar)
    const fPrior = opts.focal35 ? (opts.focal35 * diag) / 43.27 : longSide / 2 / Math.tan(33.5 * D2R);
    grid.sort((a, b) => Math.abs(Math.log(a / fPrior)) - Math.abs(Math.log(b / fPrior)));
    let tried = 0;
    const stats = { tested: 0 };
    // iki tur: önce en parlak 8 yıldızın üçgenleri (hızlı), bulunamazsa 14 yıldız
    const passes = N > 8 ? [8, Math.min(14, det.length)] : [N];
    for (const n of passes) {
      ctx.N = n;
      for (const f of grid) {
        if (budget.left() <= 0) break;
        tried++;
        if (opts.onProgress && tried % 4 === 1) opts.onProgress(tried, grid.length * passes.length);
        const r = tryFocal(ctx, f, step / 2 + 0.012, budget, stats);
        if (!r) continue;
        const p = polish(ctx, r.cam);
        if (p.pairs.length < 6 || p.logp > -9) continue;
        const cam = p.cam;
        const center = cam.pix2world((W - 1) / 2, (H - 1) / 2);
        const hfov = 2 * Math.atan(W / 2 / cam.f) * R2D, vfov = 2 * Math.atan(H / 2 / cam.f) * R2D;
        return {
          ok: true, cam, center, hfov, vfov, pairs: p.pairs, rms: p.rms, logp: p.logp, radius: p.radius,
          focalsTried: tried, tested: stats.tested, ms: Date.now() - t0, nDet: det.length, det,
          pixscale: (3600 * R2D) / cam.f,
        };
      }
    }
    return { ok: false, reason: budget.left() <= 0 ? "timeout" : "no_match", focalsTried: tried, tested: stats.tested, ms: Date.now() - t0, nDet: det.length };
  }

  // ------------------------------------------------------------------ Web Worker
  // Sayfa donmasın diye çözüm ayrı bir iş parçacığında çalışır: new Worker("js/solve.js").
  if (typeof window === "undefined" && typeof importScripts === "function") {
    let catalog = null;
    self.onmessage = (e) => {
      const m = e.data;
      try {
        if (m.type === "catalog") {
          catalog = new Catalog(m.stars.map(([hip, ra, dec, v]) => ({ hip, ra, dec, v })), 6.5);
          self.postMessage({ type: "ready", n: catalog.n });
        } else if (m.type === "solve") {
          const r = solve(catalog, m.det, m.W, m.H, Object.assign({}, m.opts, {
            onProgress: (a, b) => self.postMessage({ type: "progress", tried: a, total: b }),
          }));
          if (r.ok) {
            const c = r.cam;
            r.cam = { R: c.R, f: c.f, cx: c.cx, cy: c.cy, k1: c.k1, k2: c.k2, rpix: c.rpix };
            r.pairs = r.pairs.map(([d, i, dx, dy]) => [d, catalog.stars[i].hip, dx, dy]);
          }
          self.postMessage({ type: "result", result: r });
        }
      } catch (err) {
        self.postMessage({ type: "error", message: String((err && err.message) || err) });
      }
    };
  }

  global.LichSolve = { Catalog, Camera, solve, attitude, radec2v, v2radec, sep, logBinomTail };
})(typeof window !== "undefined" ? window : globalThis);
