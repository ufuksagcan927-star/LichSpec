/*
 * LichSpec photo check (Playwright).
 *
 *   node tools/photo_check.js <site-url> <photo-dir> [--dump-shots=1] [--force-wasm=1]
 *                             [--aladin-local=<aladin.js>] [--ort-local=<onnxruntime-web dist dir>]
 *
 * Uploads every photo listed in <photo-dir>/cases.json (tools/make_test_photos.py) to the site the way a
 * visitor would. In the page, Phobetor (onnxruntime-web) finds the stars and LichSolve matches the star
 * pattern against the bright-star catalogue. Checks that the photo lands where it was taken. Prints one
 * line per photo; exits 1 if a photo marked must_solve is not solved or lands in the wrong place.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [url, dir] = args;
if (!url || !dir) { console.error("usage: node tools/photo_check.js <site-url> <photo-dir>"); process.exit(2); }
const cases = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));

const D2R = Math.PI / 180;
function sepDeg(ra1, de1, ra2, de2) {
  const c = Math.sin(de1 * D2R) * Math.sin(de2 * D2R) + Math.cos(de1 * D2R) * Math.cos(de2 * D2R) * Math.cos((ra1 - ra2) * D2R);
  return Math.acos(Math.min(1, Math.max(-1, c))) / D2R;
}

async function dumpShot(page, name) {
  const png = await page.screenshot();
  const b64 = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = "data:image/png;base64," + src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.round(img.width / 2); c.height = Math.round(img.height / 2);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.62).split(",")[1];
  }, png.toString("base64"));
  const n = Math.ceil(b64.length / 4000);
  for (let i = 0; i < n; i++) console.log(`SHOT ${name} ${i + 1}/${n} ${b64.slice(i * 4000, (i + 1) * 4000)}`);
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  if (flags["force-wasm"] === "1") await page.addInitScript(() => { window.LICH_FORCE_WASM = true; });
  if (flags["aladin-local"]) {
    await page.route("https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js",
      (r) => r.fulfill({ path: flags["aladin-local"], contentType: "application/javascript" }));
  }
  if (flags["ort-local"]) {
    await page.route(/https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/.*/, (r) => {
      const f = path.join(flags["ort-local"], r.request().url().split("/dist/")[1].split("?")[0]);
      if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: "not found" });
      r.fulfill({ path: f, contentType: f.endsWith(".wasm") ? "application/wasm" : "application/javascript", headers: { "access-control-allow-origin": "*" } });
    });
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && /phobetor|solve|onnx|ort|wasm|worker/i.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.lichspec && window.lichspec.STARS.length > 0, null, { timeout: 90000 });

  const failures = [];
  let shots = 0;
  console.log(`== photo check: ${cases.length} photos`);
  for (const c of cases) {
    const file = path.join(dir, c.file);
    if (!fs.existsSync(file)) { console.log(`- ${c.file}: missing, skipped`); continue; }
    const t0 = Date.now();
    await page.evaluate(() => { const d = document.querySelector("#upload-dialog"); if (!d.open) d.showModal(); });
    await page.setInputFiles("#file", file);
    let r;
    try {
      await page.waitForFunction((name) => {
        const s = window.lichspec.lastSolve;
        const err = document.querySelector("#upload-status");
        return (s && s.file === name && !document.querySelector("#solve-result").hidden) || (err && err.classList.contains("error") && !err.hidden);
      }, path.basename(file), { timeout: 240000, polling: 500 });
      r = await page.evaluate(() => {
        const s = window.lichspec.lastSolve, err = document.querySelector("#upload-status");
        if (err.classList.contains("error") && !err.hidden) return { error: err.innerText };
        return {
          status: s.status, phobetor: s.phobetor, solver: s.solver, center: s.center, fov: s.fov, size: [s.width, s.height],
          stars: (s.stars || []).length, names: (s.stars || []).slice(0, 8).map((x) => x.name || x.desig || "HIP " + x.hip),
          constellations: s.cons ? s.cons.labels.map((l) => l[0]) : [], meta: document.querySelector("#solve-meta").innerText.replace(/\s*\n\s*/g, " | "),
        };
      });
    } catch (e) {
      r = { error: "timeout: " + e.message.split("\n")[0] };
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let ok = false, where = "";
    if (r.error) where = "ERROR " + r.error;
    else if (r.status !== "solved") where = `not solved (${r.solver && r.solver.reason})`;
    else {
      const d = sepDeg(r.center.ra, r.center.dec, c.expect.ra, c.expect.dec);
      ok = d <= c.expect.within_deg;
      where = `centre ${r.center.ra.toFixed(2)} ${r.center.dec.toFixed(2)} (off ${d.toFixed(2)}°, allowed ${c.expect.within_deg}°)`
        + ` fov ${r.fov.h.toFixed(1)}°×${r.fov.v.toFixed(1)}°${c.expect.fov ? ` (asked ${c.expect.fov}°)` : ""}`
        + ` | ${r.stars} stars named, rms ${r.solver.rms.toFixed(2)} px, solver ${(r.solver.ms / 1000).toFixed(1)} s`;
    }
    const ph = r.phobetor ? `Phobetor ${r.phobetor.n} stars (${r.phobetor.backend}, ${(r.phobetor.ms / 1000).toFixed(1)} s)` : "";
    console.log(`- ${ok ? "OK  " : c.must_solve ? "FAIL" : "miss"} ${c.file} [${c.kind}] ${secs} s | ${ph} | ${where}`);
    if (r.names && r.names.length) console.log(`      stars: ${r.names.join(", ")} | constellations: ${r.constellations.join(", ")}`);
    if (c.source) console.log(`      source: ${c.source}`);
    if (!ok && c.must_solve) failures.push(c.file);
    if (flags["dump-shots"] === "1" && ok && shots < 3 && (shots === 0 || !c.kind.startsWith("synthetic"))) {
      await dumpShot(page, "photo_" + c.file.replace(/\.\w+$/, ""));
      shots++;
    }
    await page.evaluate(() => document.querySelector("#upload-dialog").close());
  }
  if (errors.length) console.log("\n== page errors\n  " + errors.slice(0, 15).join("\n  "));
  console.log(`\n== PHOTO RESULT: ${failures.length ? "FAIL (" + failures.join(", ") + ")" : "PASS"}`);
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
