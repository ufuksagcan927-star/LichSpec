/*
 * LichSpec site smoke test (Playwright).
 *
 *   node tools/site_check.js <site-url> [fits-file] [out-dir] [--aladin-local=<path to aladin.js>]
 *
 * Loads the site, zooms into M67, waits for Gaia DR3 stars, clicks one, checks the
 * generated star card, uploads a FITS image and checks the plate solution. From inside
 * the browser it also probes every external data service the static site depends on, so
 * a missing CORS header shows up here. Prints a report; exits 1 if a core step fails.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [url, fitsPath, outDir = "site-check-out"] = args;
if (!url) { console.error("usage: node tools/site_check.js <url> [fits] [out-dir]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const CFA = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv";
const CDS = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv";
const PROBES = [
  ["VizieR CDS Gaia DR3 cone", `${CDS}?-source=I/355/gaiadr3&-c=132.846%20%2B11.814&-c.rs=60&-out=Source,RA_ICRS,DE_ICRS,Gmag,BP-RP&-out.max=3&-sort=Gmag`],
  ["VizieR CfA Gaia DR3 cone", `${CFA}?-source=I/355/gaiadr3&-c=132.846%20%2B11.814&-c.rs=60&-out=Source,RA_ICRS,DE_ICRS,Gmag,BP-RP&-out.max=3&-sort=Gmag`],
  ["VizieR CfA Gaia DR3 by Source+position, all columns", `${CFA}?-source=I/355/gaiadr3&-c=132.84%20%2B11.80&-c.rs=900&Source=604917354477128448&-out.all=1&-out.max=1`],
  ["VizieR CfA Gaia DR3 paramp by Source+position", `${CFA}?-source=I/355/paramp&-c=132.84%20%2B11.80&-c.rs=900&Source=604917354477128448&-out.all=1&-out.max=1`],
  ["IRSA DSS2 HiPS", "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color/properties"],
  ["CDS Mellinger HiPS", "https://alasky.cds.unistra.fr/MellingerRGB/properties"],
];

const failures = [];
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  const badRequests = [];
  page.on("requestfailed", (r) => badRequests.push(`${r.failure() && r.failure().errorText} ${r.url().slice(0, 160)}`));
  page.on("response", (r) => { if (r.status() >= 400) badRequests.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`); });
  if (flags["aladin-local"]) {
    await page.route("https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js",
      (r) => r.fulfill({ path: flags["aladin-local"], contentType: "application/javascript" }));
  }

  log("== load", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.lichspec && window.lichspec.aladin, null, { timeout: 45000 })
    .catch(() => failures.push("sky did not initialise"));
  const mode = await page.evaluate(() => window.lichspec && window.lichspec.data.mode);
  log("mode:", mode);
  const order = await page.evaluate(() => window.lichspec && window.lichspec.data.mirrors && window.lichspec.data.mirrors()).catch((e) => String(e));
  log("VizieR mirror order:", JSON.stringify(order));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(outDir, "1_home.png") });

  log("\n== external services, fetched from inside the page (CORS)");
  for (const [name, u] of PROBES) {
    const r = await page.evaluate(async (u) => {
      const t0 = performance.now();
      try {
        const res = await fetch(u);
        const t = await res.text();
        return { ok: res.ok, status: res.status, ms: performance.now() - t0, head: t.replace(/^#.*\n/gm, "").slice(0, 1500) };
      } catch (e) { return { ok: false, ms: performance.now() - t0, error: String(e) }; }
    }, u);
    log(`- ${name}: ${r.ok ? "OK" : "FAIL"} ${r.status || ""} ${(r.ms / 1000).toFixed(1)}s ${r.error || ""}`);
    if (r.head) log("    " + r.head.replace(/[ ]+/g, " ").replace(/\n+/g, " ⏎ ").slice(0, 1500));
  }

  log("\n== Gaia layer at M67");
  await page.evaluate(() => { lichspec.aladin.gotoRaDec(132.846, 11.814); lichspec.aladin.setFoV(0.5); });
  let nGaia = 0;
  const tGaia = Date.now();
  for (let i = 0; i < 60 && !nGaia; i++) {
    await page.waitForTimeout(1500);
    nGaia = await page.evaluate(() => {
      const cats = lichspec.aladin.view.catalogs || [];
      const g = cats.find((c) => /Gaia DR3/.test(c.name));
      return g && g.getSources ? g.getSources().length : 0;
    });
  }
  log("gaia sources loaded:", nGaia, `after ${((Date.now() - tGaia) / 1000).toFixed(1)}s`, "| badge:", await page.textContent("#gaia-status"));
  if (!nGaia) failures.push("no Gaia sources loaded at M67");
  const sample = await page.evaluate(() => {
    const g = (lichspec.aladin.view.catalogs || []).find((c) => /Gaia DR3/.test(c.name));
    const s = g && g.getSources ? g.getSources() : [];
    return s.length ? { keys: Object.keys(s[0].data), first: s[0].data } : null;
  });
  if (sample) log("source columns:", JSON.stringify(sample.keys), "\nfirst:", JSON.stringify(sample.first).slice(0, 600));

  log("\n== click a Gaia star");
  const target = await page.evaluate(() => {
    const g = (lichspec.aladin.view.catalogs || []).find((c) => /Gaia DR3/.test(c.name));
    const src = g ? g.getSources() : [];
    const mag = (s) => parseFloat(s.data.Gmag ?? (s.data.gaia && s.data.gaia.phot_g_mean_mag));
    const rect = document.querySelector("#aladin").getBoundingClientRect();
    let best = null;
    for (const s of src) {
      const p = lichspec.aladin.world2pix(s.ra, s.dec);
      if (!p || p[0] < 60 || p[1] < 160 || p[0] > rect.width - 60 || p[1] > rect.height - 60) continue;
      const m = mag(s);
      if (isFinite(m) && (!best || m < best.m)) best = { m, x: rect.left + p[0], y: rect.top + p[1], ra: s.ra, dec: s.dec };
    }
    return best;
  });
  if (target) {
    await page.mouse.click(target.x, target.y);
    const tCard = Date.now();
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !document.querySelector("#gaia-detail-status") ||
      /alınamadı/.test(document.querySelector("#gaia-detail-status").textContent), null, { timeout: 60000 }).catch(() => {});
    log(`card details after ${((Date.now() - tCard) / 1000).toFixed(1)}s`);
    const card = await page.evaluate(() => ({
      title: document.querySelector(".star-head h2")?.innerText,
      detail: document.querySelector("#gaia-detail-status")?.innerText || "",
      narration: document.querySelector(".narration")?.innerText,
      facts: document.querySelector("dl.facts")?.innerText,
    }));
    log("card title:", card.title, "| detail status:", card.detail);
    log(card.narration);
    log(card.facts);
    if (!card.title || !/Gaia/.test(card.title)) failures.push("Gaia star card did not open");
    await page.screenshot({ path: path.join(outDir, "2_gaia_card.png") });
  } else {
    failures.push("no clickable Gaia star found");
  }

  if (fitsPath) {
    log("\n== FITS upload:", fitsPath);
    await page.click("#btn-upload");
    await page.setInputFiles("#file", fitsPath);
    await page.waitForFunction(() => !document.querySelector("#solve-result").hidden ||
      document.querySelector("#upload-status").classList.contains("error"), null, { timeout: 90000 }).catch(() => {});
    const res = await page.evaluate(() => ({
      meta: document.querySelector("#solve-meta")?.innerText,
      status: document.querySelector("#upload-status")?.innerText,
      items: document.querySelectorAll("#solve-list li[data-i]").length,
    }));
    log("solve:", res.meta || res.status, "| list items:", res.items);
    if (!res.meta) failures.push("FITS solve failed: " + res.status);
    await page.screenshot({ path: path.join(outDir, "3_fits.png") });
  }

  log("\n== console errors (" + consoleErrors.length + ")");
  consoleErrors.slice(0, 20).forEach((e) => log("  " + e));
  log("\n== failed requests (" + badRequests.length + ")");
  badRequests.slice(0, 30).forEach((e) => log("  " + e));
  await browser.close();
  log("\n== RESULT:", failures.length ? "FAIL\n - " + failures.join("\n - ") : "PASS");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
