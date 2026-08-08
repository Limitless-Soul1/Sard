// PDF STRESS AUDIT — the weakest area, attacked deliberately.
//
// WHAT A PDF PAGE IS HERE: foliate-fxl renders each page to a base64 PNG data URL inside
// `<div id="canvas"><img>`. That single fact drives most of what is worth attacking — a rasterised
// page can be blurry when zoomed, can fail to decode, and carries real memory per page.
//
// TRIAGE. Same discipline as the library audit:
//   PDF        the file declares/contains the problem (verified against the bytes in pdf-inventory)
//   SARD       Sard differs from what the file supports
//   UNCERTAIN  cannot be settled from the file alone
//
// Every number here is MEASURED in the real binary. Where an instrument could lie, it is stated.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// The corpus, with what the FILE is — read from the bytes beforehand, so a finding can be attributed.
// `match` MUST be unique to the PDF card. The library holds an EPUB *and* a PDF of the same title for
// several works, and matching on the title alone opened the EPUB of رسالة الغفران — which then looked
// like "the PDF never painted". Each token below appears in one card only, and `pages` is used after
// opening to prove the right book was opened.
const CORPUS = [
  // The CARD shows the metadata title, not the DB filename — "kotobati" appears nowhere on screen.
  // The EPUB «مقدمة ابن خلدون - الجزء الأول» also matches this token; the PDF card comes first and the
  // page-count guard below proves which one opened.
  { key: "مقدمة ابن خلدون", match: "مقدمة ابن خلدون", mb: 19.9, pages: 567, kind: "scanned, CCITT, per-page varying size", outline: true, fonts: 1 },
  { key: "الأمير الصغير", match: "Noor-Book", mb: 3.8, pages: 102, kind: "mixed text+image, JBIG2", outline: true, fonts: 108 },
  { key: "الداء والدواء", match: "_الكتاب", mb: 8.3, pages: 675, kind: "pure scan, no text layer, structure in ObjStm", outline: false, fonts: 0 },
  { key: "رسالة الغفران", match: "33102", mb: 4.7, pages: 202, kind: "text PDF", outline: false, fonts: 210 },
  { key: "فن الحرب", match: "24116", mb: 0.9, pages: 100, kind: "ENCRYPTED (/Encrypt present)", outline: false, fonts: 125 },
  { key: "697", match: "S697", mb: 40.3, pages: 967, kind: "very long scan, JBIG2+JPX, varying page size", outline: true, fonts: 0 },
];

const snap = snapshotDb("M:\\eRawy", "pdf-stress");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const results = [];

// CDP Performance metrics: the honest instrument for "does it leak" — heap, live nodes, listeners.
const metrics = async () => {
  try {
    const m = await s.send("Performance.getMetrics", {});
    const g = (n) => m?.metrics?.find((x) => x.name === n)?.value ?? null;
    return { heapMB: +(g("JSHeapUsedSize") / 1048576).toFixed(1), nodes: g("Nodes"), listeners: g("JSEventListeners"), docs: g("Documents") };
  } catch { return null; }
};

// Ink detection: a page that "loaded" but is blank is a real defect and an <img> cannot report it.
// Draw the page into a canvas and sample. data: URLs are same-origin, so this does not taint.
// NOT every PDF paints into an <img>: a text PDF may use a canvas or a text layer. Assuming <img>
// reported "never painted in 60 s" for a file the library audit had opened without trouble.
const INK = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  if (!d) return JSON.stringify({ img: false, why: 'no content document' });
  const im = d.querySelector('img');
  const can = d.querySelector('canvas');
  if (!im && can) {
    const rec = { img: true, surface: 'canvas', nw: can.width, nh: can.height, cw: can.clientWidth, ch: can.clientHeight, complete: true };
    try { const g = can.getContext('2d'); const px = g.getImageData(0, 0, Math.min(can.width, 400), Math.min(can.height, 400)).data;
      let ink = 0, n = 0; for (let i = 0; i < px.length; i += 4 * 13) { n++; if (px[i] < 235 || px[i+1] < 235 || px[i+2] < 235) ink++; }
      rec.inkRatio = +(ink / Math.max(1, n)).toFixed(4);
    } catch (e) { rec.inkErr = String(e).slice(0, 60); }
    return JSON.stringify(rec);
  }
  if (!im) return JSON.stringify({ img: false, why: 'no img/canvas',
    els: d.body ? d.body.querySelectorAll('*').length : -1,
    txt: (d.body?.textContent || '').trim().length,
    head: (d.body?.innerHTML || '').replace(/\\s+/g, ' ').slice(0, 120) });
  const rec = { img: true, surface: 'img', nw: im.naturalWidth, nh: im.naturalHeight, cw: im.clientWidth, ch: im.clientHeight, complete: im.complete };
  try {
    const c = d.createElement('canvas'); c.width = Math.min(im.naturalWidth, 400); c.height = Math.min(im.naturalHeight, 400);
    const g = c.getContext('2d'); g.drawImage(im, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let ink = 0, n = 0;
    for (let i = 0; i < px.length; i += 4 * 13) { n++; if (px[i] < 235 || px[i+1] < 235 || px[i+2] < 235) ink++; }
    rec.inkRatio = +(ink / Math.max(1, n)).toFixed(4);
  } catch (e) { rec.inkErr = String(e).slice(0, 60); }
  return JSON.stringify(rec);
})()`;

// A PDF has no section index on getContents() — it is null, which made every page turn look "stuck".
// The position a PDF actually carries is lastLocation.fraction, and the chrome renders it as "N / M".
const pageIdx = `(() => { const v = document.querySelector('.page-host foliate-view');
  const f = v?.lastLocation?.fraction;
  return typeof f === 'number' ? Math.round(f * 1e6) / 1e6 : null; })()`;

const pageLabel = `(() => { const e = document.querySelector('.rc-meta, .rc-pos, .rp-meta');
  return (e?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24); })()`;

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9910, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  try { await s.send("Performance.enable", {}); } catch { /* older protocol */ }
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // Collect page errors for the whole session rather than trusting a clean-looking screen.
  await s.evaluate(`(() => { if (window.__err) return true; window.__err = [];
    window.addEventListener('error', e => window.__err.push('error: ' + (e.message||'').slice(0,120)));
    window.addEventListener('unhandledrejection', e => window.__err.push('reject: ' + String(e.reason).slice(0,120)));
    const ce = console.error; console.error = (...a) => { window.__err.push('console: ' + a.map(String).join(' ').slice(0,120)); ce(...a); };
    return true; })()`);

  const baseline = await metrics();
  console.log(`baseline: ${JSON.stringify(baseline)}\n`);

  for (const spec of CORPUS) {
    if (ONLY && !spec.key.includes(ONLY)) continue;
    const rec = { ...spec, stages: {} };
    console.log(`\n=== ${spec.key}  (${spec.mb} MB · ${spec.pages} pages · ${spec.kind})`);

    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
    await s.evaluate(`(() => { window.__err = []; return true; })()`);

    // ---- OPEN: how long until a reader can actually see page 1? ----------------------------
    const t0 = Date.now();
    const found = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(spec.match)}));
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!found) { rec.error = "card not found"; results.push(rec); console.log("  CARD NOT FOUND"); continue; }

    let painted = false, lastInk = null;
    for (let k = 0; k < 200; k++) {   // 60s ceiling: a 40 MB scan is allowed to be slow, not infinite
      lastInk = JSON.parse(await s.evaluate(INK));
      if (lastInk.img && lastInk.complete && lastInk.nw > 0) { painted = true; rec.firstPage = lastInk; break; }
      await sleep(300);
    }
    rec.openMs = Date.now() - t0;
    if (!painted) {
      rec.stages.open = "NEVER PAINTED";
      rec.lastInk = lastInk;   // the probe's own reason — without it "never painted" is unactionable
      rec.viewState = JSON.parse(await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view');
        return JSON.stringify({ view: !!v, book: !!v?.book, sections: v?.book?.sections?.length ?? null,
          contents: v?.renderer?.getContents?.()?.length ?? null, reader: !!document.querySelector('.page-host'),
          toast: (document.querySelector('.pdf-toast')?.textContent || '').trim().slice(0, 120),
          body: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }); })()`));
      rec.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,6))`));
      console.log(`  OPEN: never painted in ${rec.openMs} ms\n    probe: ${JSON.stringify(lastInk)}\n    state: ${JSON.stringify(rec.viewState)}\n    errors: ${JSON.stringify(rec.errors)}`);
      results.push(rec); continue;
    }
    rec.pagesSeen = await s.evaluate(`document.querySelector('.page-host foliate-view')?.book?.sections?.length ?? null`);
    // Guard: prove the book that opened IS the PDF. Several works exist in the library as both an EPUB
    // and a PDF, and opening the wrong one produced a convincing but entirely false finding.
    if (rec.pagesSeen !== null && spec.pages > 0 && Math.abs(rec.pagesSeen - spec.pages) > Math.max(3, spec.pages * 0.02)) {
      rec.error = `WRONG BOOK OPENED — showed ${rec.pagesSeen} sections, the PDF has ${spec.pages} pages`;
      console.log(`  ${rec.error}`);
      results.push(rec); continue;
    }
    console.log(`  OPEN ${rec.openMs} ms · page1 ${rec.firstPage.nw}x${rec.firstPage.nh} ink=${rec.firstPage.inkRatio}`
      + ` · pages seen ${rec.pagesSeen} (file declares ${spec.pages})`);

    // ---- NAVIGATION: 20 turns, each timed, each checked for a painted page -------------------
    const turns = [];
    let blank = 0, stuck = 0;
    for (let k = 0; k < 20; k++) {
      const before = await s.evaluate(pageIdx);
      const t = Date.now();
      await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view'); v.next(); return true; })()`);
      let moved = false, r = null;
      for (let w = 0; w < 60; w++) {
        const idx = await s.evaluate(pageIdx);
        if (idx !== before) { r = JSON.parse(await s.evaluate(INK)); if (r.img && r.complete && r.nw > 0) { moved = true; break; } }
        await sleep(100);
      }
      const ms = Date.now() - t;
      if (!moved) stuck++; else if ((r.inkRatio ?? 1) < 0.001) blank++;
      turns.push({ ms, moved, ink: r?.inkRatio ?? null, nw: r?.nw ?? null });
    }
    const ok = turns.filter((x) => x.moved).map((x) => x.ms).sort((a, b) => a - b);
    rec.turn = { n: turns.length, stuck, blank, p50: ok[Math.floor(ok.length * 0.5)] ?? null,
      p95: ok[Math.floor(ok.length * 0.95)] ?? null, max: ok[ok.length - 1] ?? null };
    console.log(`  TURN x20: p50 ${rec.turn.p50} ms · p95 ${rec.turn.p95} ms · max ${rec.turn.max} ms · stuck ${stuck} · blank ${blank}`);

    // ---- ZOOM, by the routes a reader actually has ------------------------------------------
    // Reader.tsx:1744 gates Ctrl+Wheel off for PDFs (`!isPdf`) and :1745 turns the page instead, and
    // the PDF settings panel offers only invert + copy. So the question is not "does zoom re-render
    // sharply" but "can a reader magnify a scan at all", and how soft the fixed raster already is.
    const z0 = JSON.parse(await s.evaluate(INK));
    const idxBeforeZoom = await s.evaluate(pageIdx);
    await s.evaluate(`(() => { const d = document.querySelector('.reader-desk'); if (!d) return false;
      d.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }));
      return true; })()`);
    await sleep(2000);
    const z1 = JSON.parse(await s.evaluate(INK));
    const idxAfterZoom = await s.evaluate(pageIdx);
    rec.zoom = {
      natural: z0.nw, displayed: z0.cw,
      // >1 means the scan is being blown up past the resolution it was rasterised at — soft text.
      magnification: z0.nw ? +(z0.cw / z0.nw).toFixed(2) : null,
      ctrlWheelChangedRaster: z1.nw !== z0.nw,
      ctrlWheelTurnedPageInstead: idxAfterZoom !== idxBeforeZoom,
      zoomControlsInPdfPanel: await s.evaluate(`document.querySelectorAll('.sp-pdf .rs-seg-item, .sp-pdf button').length`),
      // "the page is 466 px wide" says nothing without the window it sits in. How much of the
      // available reading area does a scanned page actually use?
      viewport: JSON.parse(await s.evaluate(`(() => {
        const sheet = document.querySelector('.page-sheet'); const host = document.querySelector('.page-host');
        return JSON.stringify({ win: [innerWidth, innerHeight], dpr: devicePixelRatio,
          sheet: sheet ? [sheet.clientWidth, sheet.clientHeight] : null,
          host: host ? [host.clientWidth, host.clientHeight] : null }); })()`)),
    };
    rec.zoom.areaUsed = rec.zoom.viewport.host
      ? +((z0.cw * z0.ch) / (rec.zoom.viewport.host[0] * rec.zoom.viewport.host[1])).toFixed(3) : null;
    console.log(`  ZOOM: raster ${z0.nw}x${z0.nh} shown at ${z0.cw}x${z0.ch} (x${rec.zoom.magnification})`
      + ` · ctrl+wheel changed raster=${rec.zoom.ctrlWheelChangedRaster} turned page=${rec.zoom.ctrlWheelTurnedPageInstead}`
      + ` · controls in PDF panel=${rec.zoom.zoomControlsInPdfPanel}`);
    console.log(`  AREA: window ${rec.zoom.viewport.win} dpr ${rec.zoom.viewport.dpr} · reading area ${rec.zoom.viewport.host} · page uses ${(rec.zoom.areaUsed*100).toFixed(0)}% of it`);

    // ---- HAMMER: 30 turns with no waiting. Does it stay coherent or fall apart? ---------------
    const hIdx0 = await s.evaluate(pageIdx);
    const hT = Date.now();
    await s.evaluate(`(async () => { const v = document.querySelector('.page-host foliate-view');
      for (let i = 0; i < 30; i++) { try { v.next(); } catch {} await new Promise(r => setTimeout(r, 20)); } return true; })()`);
    await sleep(6000);
    const hIdx1 = await s.evaluate(pageIdx);
    const hr = JSON.parse(await s.evaluate(INK));
    rec.hammer = { from: hIdx0, to: hIdx1, ms: Date.now() - hT, painted: !!(hr.img && hr.complete && hr.nw > 0), ink: hr.inkRatio ?? null };
    console.log(`  HAMMER 30 rapid turns: ${hIdx0} -> ${hIdx1} in ${rec.hammer.ms} ms · recovered=${rec.hammer.painted} ink=${rec.hammer.ink}`);

    // ---- JUMP to the last page: the worst case for a 967-page scan ---------------------------
    const jT = Date.now();
    await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view');
      v.goToFraction ? v.goToFraction(0.999) : v.goTo(v.book.sections.length - 1); return true; })()`);
    let jOk = false, jr = null;
    for (let w = 0; w < 120; w++) { jr = JSON.parse(await s.evaluate(INK)); if (jr.img && jr.complete && jr.nw > 0) { jOk = true; break; } await sleep(250); }
    rec.jumpEnd = { ms: Date.now() - jT, ok: jOk, frac: await s.evaluate(pageIdx),
      label: await s.evaluate(pageLabel), ink: jr?.inkRatio ?? null };
    console.log(`  JUMP to last: ${rec.jumpEnd.ms} ms · landed "${rec.jumpEnd.label}" (frac ${rec.jumpEnd.frac}) · painted=${jOk} ink=${rec.jumpEnd.ink}`);

    // ---- outline / contents, and what this cost -----------------------------------------------
    rec.panelRows = await s.evaluate(`document.querySelectorAll('.toc-row, .toc-item, .reader-panel li, .reader-panel a').length`);
    rec.metrics = await metrics();
    rec.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 8))`));
    console.log(`  contents rows: ${rec.panelRows} (file has outline: ${spec.outline}) · ${JSON.stringify(rec.metrics)}`);
    if (rec.errors.length) console.log(`  ERRORS: ${JSON.stringify(rec.errors)}`);
    results.push(rec);
  }

  // ---- close everything and see whether the cost comes back --------------------------------
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  await sleep(3000);
  try { await s.evaluate(`(() => { if (window.gc) window.gc(); return true; })()`); } catch { /* no gc */ }
  await sleep(2000);
  const after = await metrics();
  console.log(`\nbaseline ${JSON.stringify(baseline)}\nafter all PDFs, back in library ${JSON.stringify(after)}`);
  results.push({ summary: true, baseline, after });
} catch (e) {
  console.error("\nPDF STRESS FAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-stress-result.json", JSON.stringify(results, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`raw evidence: tests/harness/pdf-stress-result.json`);
}
