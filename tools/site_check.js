/*
 * LichSpec site smoke test (Playwright).
 *
 *   node tools/site_check.js <site-url> [fits-file] [out-dir] [--aladin-local=<path to aladin.js>]
 *                            [--dump-shots=1] [--readme-shots=1]
 *
 * Loads the site, drags the view up through the zenith, checks the flat (gnomonic) view, the straight
 * horizon and the see-through ground with its opacity slider, tries the
 * search (typos, Turkish names, constellations, galaxies, nebulae, pulsars, black holes), opens the Andromeda
 * Galaxy card from its symbol on the sky, zooms into M67, waits for Gaia DR3 stars, clicks
 * one, checks the generated star card, uploads a FITS image and checks the plate solution. From inside
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
const IDIA = "https://vizier.idia.ac.za/viz-bin/asu-tsv";
const PROBES = [
  ["VizieR CDS Gaia DR3 cone", `${CDS}?-source=I/355/gaiadr3&-c=132.846%20%2B11.814&-c.rs=60&-out=Source,RA_ICRS,DE_ICRS,Gmag,BP-RP&-out.max=3&-sort=Gmag`],
  ["VizieR CfA Gaia DR3 cone", `${CFA}?-source=I/355/gaiadr3&-c=132.846%20%2B11.814&-c.rs=60&-out=Source,RA_ICRS,DE_ICRS,Gmag,BP-RP&-out.max=3&-sort=Gmag`],
  ["VizieR IDIA Gaia DR3 cone", `${IDIA}?-source=I/355/gaiadr3&-c=132.846%20%2B11.814&-c.rs=60&-out=Source,RA_ICRS,DE_ICRS,Gmag,BP-RP&-out.max=3&-sort=Gmag`],
  ["Gaia DR3 HiPS catalogue", "https://hipscat.cds.unistra.fr/HiPSCatService/I/355/gaiadr3/properties"],
  ["VizieR CfA Gaia DR3 by Source+position, all columns", `${CFA}?-source=I/355/gaiadr3&-c=132.84%20%2B11.80&-c.rs=900&Source=604917354477128448&-out.all=1&-out.max=1`],
  ["VizieR CfA Gaia DR3 paramp by Source+position", `${CFA}?-source=I/355/paramp&-c=132.84%20%2B11.80&-c.rs=900&Source=604917354477128448&-out.all=1&-out.max=1`],
  ["IRSA DSS2 HiPS", "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color/properties"],
  ["CDS Mellinger HiPS", "https://alasky.cds.unistra.fr/MellingerRGB/properties"],
];

const failures = [];
const log = (...a) => console.log(...a);

/** Small JPEG of the page written into the log as base64 lines ("SHOT <name> <i>/<n> <data>"), so the
 *  live rendering can be looked at even where the uploaded artifact cannot be downloaded. */
async function dumpShot(page, name, { full = false } = {}) {
  const png = await page.screenshot();
  const b64 = await page.evaluate(async ({ src, full }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + src;
    await img.decode();
    const c = document.createElement("canvas");
    const k = full ? 1 : 0.5;
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", full ? 0.84 : 0.62).split(",")[1];
  }, { src: png.toString("base64"), full });
  const n = Math.ceil(b64.length / 4000);
  for (let i = 0; i < n; i++) log(`SHOT ${name} ${i + 1}/${n} ${b64.slice(i * 4000, (i + 1) * 4000)}`);
}

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
    await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/aladin-lite@[^/]+\/dist\/aladin\.js$/,
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
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(outDir, "1_home.png") });

  log("\n== sky view (from the ground: flat camera-like projection, horizon, constellations)");
  const view = await page.evaluate(() => {
    const L = window.lichspec, a = L.aladin;
    const cv = document.querySelector(".sky-overlay");
    let groundAlpha = null;
    if (cv && cv.width) groundAlpha = cv.getContext("2d").getImageData(Math.floor(cv.width / 2), cv.height - 4, 1, 1).data[3];
    return {
      projection: a.view && a.view.projection && a.view.projection.label,
      status: document.querySelector("#sky-status").textContent,
      place: document.querySelector(".place-chip") && document.querySelector(".place-chip").innerText.replace(/\s+/g, " "),
      view: L.sky && L.sky.view(),
      groundAlpha,
      imagery: L.imagery,
      logoInCredits: !!document.querySelector("#aladin-logo-slot .aladin-logo-container"),
    };
  });
  log(JSON.stringify(view));
  if (view.projection !== "Tangential") failures.push("sky is not in the flat gnomonic (TAN) projection");
  if (!/bakıyorsun/.test(view.status)) failures.push("sky status does not say where you are looking");
  if (!view.groundAlpha) failures.push("ground/horizon overlay not drawn");
  if (flags["dump-shots"]) await dumpShot(page, "home");
  if (flags["readme-shots"]) await dumpShot(page, "readme_sky", { full: true });

  log("\n== looking up through the zenith with the horizon on");
  // Aladin's own drag works in RA/Dec; crossing the zenith used to flip "up" by 180° on every frame.
  const altAz = await page.evaluate(async () => {
    lichspec.sky.look(70, 0, 60);
    await new Promise((r) => setTimeout(r, 500));
    return lichspec.sky.altAzDrag;
  });
  const box = await page.locator("#aladin").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy - 150);
  await page.mouse.down();
  const alts = [];
  for (let i = 1; i <= 30; i++) {                    // drag down = look up
    await page.mouse.move(cx, cy - 150 + i * 12);
    await page.waitForTimeout(30);
    alts.push(await page.evaluate(() => lichspec.sky.view().alt));
  }
  await page.mouse.up();
  const rest = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(60);
    rest.push(await page.evaluate(() => [lichspec.sky.view().alt, lichspec.aladin.getRotation()]));
  }
  const flips = rest.slice(1).filter((r, i) => Math.abs(((r[1] - rest[i][1] + 540) % 360) - 180) > 5).length;
  log(`alt-az drag ${altAz} · highest alt ${Math.max(...alts).toFixed(2)}° · at rest alt ${rest[9][0].toFixed(2)}° rotation ${rest[9][1].toFixed(1)}° · flips after release: ${flips}`);
  if (!altAz) failures.push("alt-az drag is not installed");
  if (Math.max(...alts) < 89 || Math.max(...alts) > 90.001) failures.push("dragging up did not stop at the zenith");
  if (flips) failures.push("the view keeps flipping at the zenith");

  // The horizon is a straight line where Aladin projects it, and the ground is see-through by default:
  // the sky below the horizon shows; the "Yer" slider sets how much the ground covers (0 clear, 100 opaque).
  const ground = await page.evaluate(async () => {
    const sky = lichspec.sky, a = lichspec.aladin;
    const wait = () => new Promise((r) => setTimeout(r, 500));
    const alpha = () => { const cv = document.querySelector(".sky-overlay"); return cv.getContext("2d").getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * 0.85), 1, 1).data[3]; };
    const slide = (v) => { const el = document.querySelector("#ground-alpha"); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    sky.look(5, 180, 60);
    await wait();
    const lst = LichSky.lst(sky.now, sky.place.lon);
    const ys = [150, 180, 210].map((az) => { const e = LichSky.hor2eq(0, az, lst, sky.place.lat); const p = a.world2pix(e.ra, e.dec); return p ? p[1] : NaN; });
    const out = { horizonY: sky.horizonY(), aladinYs: ys, alphaDefault: alpha() };
    slide(100); await wait(); out.alpha100 = alpha();
    slide(0); await wait(); out.alpha0 = alpha();
    slide(30); await wait();
    return out;
  });
  log("horizon and ground looking 5° up:", JSON.stringify(ground));
  if (!ground.aladinYs.every((y) => Math.abs(y - ground.horizonY) < 2)) failures.push("the horizon line is not straight or not where the sky puts it");
  if (!(ground.alphaDefault > 40 && ground.alphaDefault < 120)) failures.push("the ground is not see-through by default");
  if (ground.alpha100 !== 255 || ground.alpha0 !== 0) failures.push("the ground slider does not set how much the ground covers");

  log("\n== search");
  for (const [q, want] of [["proxima centuri", "Proxima Centauri"], ["alfa erboğa", "Rigil Kentaurus"],
    ["kutup yıldızı", "Polaris"], ["betelguese", "Betelgeuse"], ["avcı", "Avcı"], ["wolf 359", "Wolf 359"]]) {
    await page.fill("#search-input", "");
    await page.type("#search-input", q, { delay: 10 });
    await page.waitForTimeout(250);
    const first = await page.evaluate(() => document.querySelector("#search-results li")?.firstChild?.textContent?.trim() || "");
    log(`  ${JSON.stringify(q)} → ${first}`);
    if (first !== want) failures.push(`search "${q}" gave "${first}", expected "${want}"`);
  }
  await page.fill("#search-input", "");
  await page.type("#search-input", "barnard", { delay: 10 });
  await page.waitForTimeout(250);
  await page.press("#search-input", "Enter");
  await page.waitForTimeout(1500);
  const picked = await page.evaluate(() => document.querySelector(".star-head h2")?.innerText);
  if (picked !== "Barnard's Star") failures.push(`Enter on "barnard" opened "${picked}"`);
  // A red dwarf: Gaia's RVS placeholder (4250 K, log g 1.5) must not turn it into a K giant.
  const chips = await page.evaluate(() => [...document.querySelectorAll(".chips .chip")].map((c) => c.textContent).join(" | "));
  log("Barnard's Star card:", chips);
  if (!/M tipi/.test(chips) || !/anakol/.test(chips)) failures.push(`Barnard's Star card says "${chips}", expected an M dwarf`);
  // Gaia DR3 live data must come from the Hipparcos cross-match: Barnard's Star moved 4′ since 1991.
  if (await page.$("#btn-gaia")) {
    await page.click("#btn-gaia");
    await page.waitForFunction(() => !/sorgulanıyor/.test(document.querySelector("#gaia-live").innerText), null, { timeout: 90000 }).catch(() => {});
    const live = await page.evaluate(() => document.querySelector("#gaia-live").innerText.replace(/\s+/g, " "));
    log("Barnard's Star, Gaia DR3 live:", live.slice(0, 300));
    if (!/4472832130942575872/.test(live) && !/başarısız|ulaşılamadı|zaman aşımı/.test(live)) {
      failures.push("Barnard's Star: Gaia DR3 live data is not the cross-matched source");
    }
  }
  if (flags["dump-shots"]) await dumpShot(page, "barnard");

  log("\n== deep sky: galaxies, nebulae, clusters, pulsars, black holes");
  await page.waitForFunction(() => window.lichspec.deep && window.lichspec.deep.ready, null, { timeout: 30000 }).catch(() => {});
  const deepCount = await page.evaluate(() => window.lichspec.deep.count);
  log("catalogue:", JSON.stringify(deepCount));
  if (!(deepCount.dso > 10000 && deepCount.compact > 3000)) failures.push(`the deep-sky catalogue did not load: ${JSON.stringify(deepCount)}`);
  for (const [q, want] of [["andromeda galaksisi", "Andromeda Galaksisi"], ["m42", "Orion Bulutsusu"], ["yengeç pulsarı", "Yengeç Pulsarı"],
    ["sgr a*", "Yay A*"], ["kuğu x-1", "Kuğu X-1"], ["hyadlar", "Hyadlar"], ["kara delik", "Yay A*"]]) {
    await page.fill("#search-input", "");
    await page.type("#search-input", q, { delay: 10 });
    await page.waitForTimeout(250);
    const first = await page.evaluate(() => document.querySelector("#search-results li")?.firstChild?.textContent?.trim() || "");
    log(`  ${JSON.stringify(q)} → ${first}`);
    if (first !== want) failures.push(`search "${q}" gave "${first}", expected "${want}"`);
  }
  await page.press("#search-input", "Escape");
  // a card opened from the sky: the Andromeda Galaxy is drawn in the middle of the view, a click next to its
  // centre opens its card (not on M42: the Trapezium star sits on its centre and a click there opens the star).
  // Barnard's Star was the last star in the middle of the screen. Aladin keeps a star's last screen position
  // once it is more than 90° away in the flat view, and a click there used to open Barnard's Star again.
  await page.evaluate(() => { document.querySelector("#search-input").blur(); lichspec.aladin.gotoRaDec(10.685, 41.269); lichspec.aladin.setFoV(8); });
  await page.waitForTimeout(1500);
  const m31 = await page.evaluate(() => { const p = lichspec.aladin.world2pix(10.72, 41.30); const b = document.querySelector("#aladin").getBoundingClientRect(); return p && [b.left + p[0], b.top + p[1]]; });
  if (m31) { await page.mouse.click(m31[0], m31[1]); await page.waitForTimeout(1200); }
  const deepCard = await page.evaluate(() => ({
    title: document.querySelector(".star-head h2")?.innerText,
    facts: [...document.querySelectorAll("dl.facts dt")].map((x) => x.innerText),
    sources: document.querySelectorAll("ul.sources li").length,
    narration: (document.querySelector(".narration")?.innerText || "").slice(0, 160),
  }));
  log("clicked M31:", JSON.stringify(deepCard));
  if (deepCard.title !== "Andromeda Galaksisi") failures.push(`a click on M31 opened "${deepCard.title}"`);
  else if (!deepCard.facts.includes("Uzaklık") || !deepCard.sources) failures.push("the Andromeda Galaxy card has no distance or no sources");
  if (flags["dump-shots"]) await dumpShot(page, "m31-card");
  await page.evaluate(() => { lichspec.aladin.gotoRaDec(83.82, -5.39); lichspec.aladin.setFoV(9); });
  await page.waitForTimeout(8000);
  log("zoomed into Orion (9°):", JSON.stringify(await page.evaluate(() => window.lichspec.imagery)));
  if (flags["dump-shots"]) await dumpShot(page, "orion9");

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

  await page.waitForFunction(() => window.lichspec && window.lichspec.gaiaMode, null, { timeout: 30000 }).catch(() => {});
  log("Gaia layer mode:", await page.evaluate(() => window.lichspec && window.lichspec.gaiaMode));

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
    if (flags["readme-shots"]) await dumpShot(page, "readme_gaia", { full: true });
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

  if (flags["readme-shots"]) {
    // README: a bright star's card (narration + measured values) over the whole of Orion, seen from the ground
    await page.evaluate(() => { const d = document.querySelector("#upload-dialog"); if (d.open) d.close(); });
    await page.evaluate(() => {
      lichspec.aladin.gotoRaDec(85.5, 1.0);
      lichspec.aladin.setFoV(32);
      lichspec.showStar(lichspec.STARS.find((s) => s.name === "Betelgeuse"), { goto: false });
    });
    await page.waitForTimeout(6000);
    await dumpShot(page, "readme_card", { full: true });
  }

  log("\n== console errors (" + consoleErrors.length + ")");
  consoleErrors.slice(0, 20).forEach((e) => log("  " + e));
  log("\n== failed requests (" + badRequests.length + ")");
  badRequests.slice(0, 30).forEach((e) => log("  " + e));
  await browser.close();
  log("\n== RESULT:", failures.length ? "FAIL\n - " + failures.join("\n - ") : "PASS");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
