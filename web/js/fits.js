/*
 * LichFits — FITS dosyasını tamamen tarayıcıda okur, WCS (koordinat) bilgisini çözer,
 * önizleme görüntüsü üretir ve alandaki yıldızları bulur. Sunucu gerekmez.
 *
 * Desteklenen: BITPIX 8/16/32/-32/-64, gzip'li .fits.gz, ilk 2B görüntü HDU'su,
 * TAN / SIN / TPV / TAN-SIP projeksiyonları (SIP/TPV bozulma terimleri yok sayılır,
 * küçük alanlarda etkisi birkaç piksel), CD / PC+CDELT / CDELT+CROTA2 matrisleri.
 */
(function (global) {
  "use strict";
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const BLOCK = 2880, CARD = 80;

  async function readFile(file) {
    let buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf, 0, 2);
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("Bu tarayıcı .gz açamıyor; dosyayı açıp .fits olarak yükle.");
      const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      buf = await new Response(ds).arrayBuffer();
    }
    return buf;
  }

  function parseValue(s) {
    s = s.trim();
    if (s.startsWith("'")) {
      // tırnak içindeki metin; '' kaçışı
      let out = "", i = 1;
      while (i < s.length) {
        if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } break; }
        out += s[i++];
      }
      return out.trimEnd();
    }
    const v = s.split("/")[0].trim();
    if (v === "T") return true;
    if (v === "F") return false;
    const n = Number(v.replace(/D/i, "E"));
    return isFinite(n) && v !== "" ? n : v;
  }

  /** offset'ten başlayan bir başlığı oku; {h, dataStart} döner. */
  function readHeader(buf, offset) {
    const h = {};
    const dec = new TextDecoder("ascii");
    let pos = offset;
    while (pos + BLOCK <= buf.byteLength) {
      const block = dec.decode(new Uint8Array(buf, pos, BLOCK));
      pos += BLOCK;
      for (let c = 0; c < BLOCK; c += CARD) {
        const card = block.slice(c, c + CARD);
        const key = card.slice(0, 8).trim();
        if (key === "END") return { h, dataStart: pos };
        if (card.slice(8, 10) === "= " && key) h[key] = parseValue(card.slice(10));
      }
    }
    throw new Error("FITS başlığı okunamadı (END bulunamadı)");
  }

  function dataBytes(h) {
    const naxis = h.NAXIS | 0;
    if (!naxis) return 0;
    let n = 1;
    for (let k = 1; k <= naxis; k++) n *= h["NAXIS" + k] | 0;
    const pc = h.PCOUNT | 0, gc = h.GCOUNT || 1;
    return (Math.abs(h.BITPIX) / 8) * gc * (pc + n);
  }

  /** İlk 2B görüntü HDU'sunu bul. Birincil başlıktaki anahtarlar eksikleri doldurur. */
  function findImage(buf) {
    let offset = 0, primary = null, compressedSeen = false;
    for (let hdu = 0; hdu < 16 && offset < buf.byteLength; hdu++) {
      const { h, dataStart } = readHeader(buf, offset);
      if (hdu === 0) {
        if (h.SIMPLE !== true) throw new Error("Bu bir FITS dosyası değil.");
        primary = h;
      }
      if (h.ZIMAGE === true) compressedSeen = true;
      const isImage = hdu === 0 || h.XTENSION === "IMAGE";
      if (isImage && (h.NAXIS | 0) >= 2 && (h.NAXIS1 | 0) > 1 && (h.NAXIS2 | 0) > 1) {
        const merged = hdu === 0 ? h : { ...primary, ...h };
        return { h: merged, dataStart, w: h.NAXIS1 | 0, hgt: h.NAXIS2 | 0, bitpix: h.BITPIX | 0 };
      }
      offset = dataStart + Math.ceil(dataBytes(h) / BLOCK) * BLOCK;
    }
    if (compressedSeen) throw new Error("Sıkıştırılmış (fpack) FITS desteklenmiyor; dosyayı açıp düz FITS olarak yükle.");
    throw new Error("FITS dosyasında 2 boyutlu görüntü bulunamadı.");
  }

  function readPixels(buf, img) {
    const { dataStart, w, hgt, bitpix, h } = img;
    const n = w * hgt;
    const dv = new DataView(buf, dataStart);
    const out = new Float32Array(n);
    const bs = typeof h.BSCALE === "number" ? h.BSCALE : 1;
    const bz = typeof h.BZERO === "number" ? h.BZERO : 0;
    const blank = typeof h.BLANK === "number" ? h.BLANK : null;
    const bpp = Math.abs(bitpix) / 8;
    if (dataStart + n * bpp > buf.byteLength) throw new Error("FITS verisi eksik (dosya kesilmiş olabilir).");
    for (let i = 0; i < n; i++) {
      let v;
      switch (bitpix) {
        case 8: v = dv.getUint8(i); break;
        case 16: v = dv.getInt16(i * 2); break;
        case 32: v = dv.getInt32(i * 4); break;
        case -32: v = dv.getFloat32(i * 4); break;
        case -64: v = dv.getFloat64(i * 8); break;
        default: throw new Error("Desteklenmeyen BITPIX: " + bitpix);
      }
      out[i] = blank !== null && bitpix > 0 && v === blank ? NaN : v * bs + bz;
    }
    return out;
  }

  /** Başlıktan WCS kur; çözülemezse null. Pikseller 0 tabanlı (FITS'in 1 tabanlısı - 1). */
  function makeWcs(h) {
    const c1 = String(h.CTYPE1 || ""), c2 = String(h.CTYPE2 || "");
    let lonAxis = 1;
    if (c1.startsWith("DEC") && c2.startsWith("RA")) lonAxis = 2;
    else if (!(c1.startsWith("RA") && c2.startsWith("DEC"))) return null;
    const proj = (lonAxis === 1 ? c1 : c2).slice(5, 8);
    if (!["TAN", "SIN", "TPV", "TPD"].includes(proj)) return null;
    const crpix = [h.CRPIX1, h.CRPIX2], crval = [h.CRVAL1, h.CRVAL2];
    if (![...crpix, ...crval].every((x) => typeof x === "number")) return null;

    // doğrusal dönüşüm (CD matrisi, derece/piksel)
    let cd;
    if (typeof h.CD1_1 === "number" || typeof h.CD2_2 === "number") {
      cd = [[h.CD1_1 || 0, h.CD1_2 || 0], [h.CD2_1 || 0, h.CD2_2 || 0]];
    } else if (typeof h.CDELT1 === "number" && typeof h.CDELT2 === "number") {
      const pc = (i, j) => {
        const a = h[`PC${i}_${j}`], b = h[`PC00${i}00${j}`];
        return typeof a === "number" ? a : typeof b === "number" ? b : (i === j ? 1 : 0);
      };
      const hasPc = ["PC1_1", "PC1_2", "PC2_1", "PC2_2", "PC001001", "PC001002", "PC002001", "PC002002"].some((k) => typeof h[k] === "number");
      if (hasPc) {
        cd = [[h.CDELT1 * pc(1, 1), h.CDELT1 * pc(1, 2)], [h.CDELT2 * pc(2, 1), h.CDELT2 * pc(2, 2)]];
      } else {
        const rho = (h.CROTA2 || h.CROTA1 || 0) * D2R;
        cd = [[h.CDELT1 * Math.cos(rho), -h.CDELT2 * Math.sin(rho)], [h.CDELT1 * Math.sin(rho), h.CDELT2 * Math.cos(rho)]];
      }
    } else return null;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (!det) return null;
    const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];

    const a0 = crval[lonAxis - 1] * D2R, d0 = crval[2 - lonAxis] * D2R;
    const phiP = (typeof h.LONPOLE === "number" ? h.LONPOLE : 180) * D2R;
    const sinD0 = Math.sin(d0), cosD0 = Math.cos(d0);
    const sin = proj === "SIN";

    function pix2world(x, y) {
      const u = x + 1 - crpix[0], v = y + 1 - crpix[1];
      let X = cd[0][0] * u + cd[0][1] * v, Y = cd[1][0] * u + cd[1][1] * v;   // derece
      if (lonAxis === 2) [X, Y] = [Y, X];
      const R = Math.hypot(X, Y);
      const phi = Math.atan2(X, -Y);
      const theta = sin ? Math.acos(Math.min(1, R * D2R)) : Math.atan2(R2D, R);
      const st = Math.sin(theta), ct = Math.cos(theta), dphi = phi - phiP;
      const ra = a0 + Math.atan2(-ct * Math.sin(dphi), st * cosD0 - ct * sinD0 * Math.cos(dphi));
      const dec = Math.asin(Math.max(-1, Math.min(1, st * sinD0 + ct * cosD0 * Math.cos(dphi))));
      return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
    }

    function world2pix(ra, dec) {
      const a = ra * D2R, d = dec * D2R;
      const sd = Math.sin(d), cdd = Math.cos(d), da = a - a0;
      const phi = phiP + Math.atan2(-cdd * Math.sin(da), sd * cosD0 - cdd * sinD0 * Math.cos(da));
      const theta = Math.asin(Math.max(-1, Math.min(1, sd * sinD0 + cdd * cosD0 * Math.cos(da))));
      if (theta <= 0) return [NaN, NaN];   // görüntünün arka yarıküresi
      const R = sin ? Math.cos(theta) * R2D : R2D / Math.tan(theta);
      let X = R * Math.sin(phi), Y = -R * Math.cos(phi);
      if (lonAxis === 2) [X, Y] = [Y, X];
      const u = inv[0][0] * X + inv[0][1] * Y, v = inv[1][0] * X + inv[1][1] * Y;
      return [u + crpix[0] - 1, v + crpix[1] - 1];
    }

    return { pix2world, world2pix, pixscale: Math.sqrt(Math.abs(det)) * 3600, proj };
  }

  /** asinh germeli önizleme; FITS'te satır 0 altta olduğu için dikey çevrilir. */
  function render(px, w, h, maxSide = 1400) {
    const k = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
    const W = Math.floor(w / k), H = Math.floor(h / k);
    // yüzdelikler için örnekle
    const step = Math.max(1, Math.floor((w * h) / 400000));
    const sample = [];
    for (let i = 0; i < px.length; i += step) if (isFinite(px[i])) sample.push(px[i]);
    sample.sort((a, b) => a - b);
    const q = (p) => sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] : 0;
    const lo = q(0.05), hi = q(0.997), span = Math.max(hi - lo, 1e-9), A = Math.asinh(10);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const im = ctx.createImageData(W, H);
    for (let Y = 0; Y < H; Y++) {
      const srcRow0 = (h - 1) - Y * k;   // dikey çevirme
      for (let X = 0; X < W; X++) {
        let s = 0, c = 0;
        for (let dy = 0; dy < k; dy++) {
          const row = srcRow0 - dy;
          if (row < 0) continue;
          const base = row * w + X * k;
          for (let dx = 0; dx < k; dx++) { const v = px[base + dx]; if (isFinite(v)) { s += v; c++; } }
        }
        let t = c ? (s / c - lo) / span : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const g = Math.round((Math.asinh(t * 10) / A) * 255);
        const o = (Y * W + X) * 4;
        im.data[o] = im.data[o + 1] = im.data[o + 2] = g; im.data[o + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    return { url: canvas.toDataURL("image/jpeg", 0.9), scale: 1 / k };
  }

  function angSep(ra1, de1, ra2, de2) {
    const c = Math.sin(de1 * D2R) * Math.sin(de2 * D2R) + Math.cos(de1 * D2R) * Math.cos(de2 * D2R) * Math.cos((ra1 - ra2) * D2R);
    return Math.acos(Math.min(1, Math.max(-1, c))) * R2D;
  }

  /**
   * Dosyayı çöz. opts.stars: parlak yıldız kataloğu (nesne dizisi),
   * opts.fieldBright(ra, dec, rDeg, top): alandaki en parlak Gaia kaynakları.
   */
  async function solve(file, opts) {
    const buf = await readFile(file);
    const img = findImage(buf);
    const wcs = makeWcs(img.h);
    if (!wcs) {
      const e = new Error("Bu FITS dosyasında gökyüzü koordinatı (WCS) yok.");
      e.code = "NO_WCS";
      throw e;
    }
    const { w, hgt } = img;
    const px = readPixels(buf, img);
    const pv = render(px, w, hgt);

    const [ra0, dec0] = wcs.pix2world((w - 1) / 2, (hgt - 1) / 2);
    const corners = [[0, 0], [w - 1, 0], [w - 1, hgt - 1], [0, hgt - 1]].map(([x, y]) => wcs.pix2world(x, y));
    const radius = Math.max(...corners.map(([a, b]) => angSep(ra0, dec0, a, b)));
    const onImage = (x, y) => isFinite(x) && isFinite(y) && x >= 0 && y >= 0 && x <= w - 1 && y <= hgt - 1;

    const stars = [];
    for (const s of opts.stars || []) {
      if (Math.abs(s.dec - dec0) > radius + 0.01) continue;
      if (angSep(ra0, dec0, s.ra, s.dec) > radius) continue;
      const [x, y] = wcs.world2pix(s.ra, s.dec);
      if (onImage(x, y)) stars.push({ ...s, src: "bright", x, y });
    }
    stars.sort((a, b) => (a.v ?? 99) - (b.v ?? 99));

    let gaia = [], gaiaErr = null;
    try {
      const rows = await opts.fieldBright(ra0, dec0, Math.min(radius, 3), 150);
      for (const g of rows) {
        const [x, y] = wcs.world2pix(g.ra, g.dec);
        if (onImage(x, y)) gaia.push({ ...g, src: "gaia", x, y });
      }
    } catch (e) {
      gaiaErr = "Gaia sorgusu başarısız: " + e.message;
    }

    return {
      status: "solved", source: "fits-wcs",
      center: { ra: ra0, dec: dec0 }, radius_deg: radius, pixscale_arcsec: wcs.pixscale,
      width: w, height: hgt, corners,
      preview: { url: pv.url, scale: pv.scale, y_flipped: true },
      stars, gaia, gaia_error: gaiaErr,
    };
  }

  const isFits = (name, head) => /\.(fits?|fts)(\.gz)?$/i.test(name || "") || (head && head.startsWith("SIMPLE"));

  global.LichFits = { solve, makeWcs, readHeader, findImage, isFits };
})(window);
