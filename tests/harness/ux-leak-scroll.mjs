// THREE THINGS THE ENDURANCE RUN COULD NOT SETTLE.
//
// 1. LEAK. Node/listener counts oscillated (1414 -> 3695 -> 1414 ...), which is sampling at different
//    moments of a load, not a leak curve. Retention is only real if it survives garbage collection, so
//    here every sample is taken at the SAME lifecycle point (back in the library, no book open) with
//    HeapProfiler.collectGarbage forced first. Growth that survives that is a leak; growth that does
//    not is just uncollected garbage.
// 2. SCROLLING. The previous scroll test had no "before" position, so "0 long tasks" could equally have
//    meant "nothing scrolled". Position is now recorded before and after, and the flow mode is read
//    rather than assumed — the desk's wheel handler returns early in paged mode.
// 3. ANNOTATIONS. The probe used an invented bookId and hit a foreign-key constraint — a harness fault.
//    The real id is read from the library row that is actually open.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new DatabaseSync(process.env.APPDATA + "/com.sard.app/sard.db", { readOnly: true });
const BOOK = db.prepare("select id,title from books where title like '%كارامازوف%' limit 1").get();
console.log(`test book: ${BOOK.title} (${BOOK.id.slice(0, 12)})`);

const snap = snapshotDb("M:\\eRawy", "ux-leak-scroll");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = {};
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9918, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  try { await s.send("Performance.enable", {}); } catch {}
  const gcThenMetrics = async () => {
    try { await s.send("HeapProfiler.collectGarbage", {}); } catch {}
    await sleep(1200);
    try { await s.send("HeapProfiler.collectGarbage", {}); } catch {}
    await sleep(800);
    const m = await s.send("Performance.getMetrics", {});
    const g = (n) => m?.metrics?.find((x) => x.name === n)?.value ?? null;
    return { heapMB: +(g("JSHeapUsedSize") / 1048576).toFixed(1), nodes: g("Nodes"), listeners: g("JSEventListeners"), docs: g("Documents") };
  };
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__long = []; window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140)));
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] }); } catch {}
    return true; })()`);

  const POS = `(() => { const v = document.querySelector('.page-host foliate-view');
    const c = v?.renderer?.getContents?.()?.[0];
    return JSON.stringify({ frac: v?.lastLocation?.fraction ?? null, idx: c?.index ?? null,
      flow: v?.renderer?.getAttribute?.('flow') ?? null, scrolled: !!v?.renderer?.scrolled,
      len: (c?.doc?.body?.textContent||'').trim().length }); })()`;
  const back = async () => {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
  };
  const open = async () => {
    await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes('كارامازوف')); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    for (let k = 0; k < 120; k++) { if (JSON.parse(await s.evaluate(POS)).len > 0) return true; await sleep(250); }
    return false;
  };

  // ---- 1. LEAK: same lifecycle point, GC forced, 10 cycles ----------------------------------
  console.log("\n=== leak test: open+close x10, measured in the library after forced GC ===");
  const samples = [await gcThenMetrics()];
  console.log(`  cycle  0 (before opening anything) ${JSON.stringify(samples[0])}`);
  for (let k = 1; k <= 10; k++) {
    if (!(await open())) { console.log("  open failed"); break; }
    await sleep(900);
    await s.evaluate(`(async () => { const v = document.querySelector('.page-host foliate-view');
      for (let i = 0; i < 5; i++) { v?.next(); await new Promise(r => setTimeout(r, 250)); } return true; })()`);
    await sleep(1200);
    await back();
    const m = await gcThenMetrics();
    samples.push(m);
    console.log(`  cycle ${String(k).padStart(2)} ${JSON.stringify(m)}`);
  }
  const d = (f) => samples[samples.length - 1][f] - samples[0][f];
  out.leak = { samples, deltaHeapMB: +d("heapMB").toFixed(1), deltaNodes: d("nodes"), deltaListeners: d("listeners"), deltaDocs: d("docs"),
    perCycleNodes: +(d("nodes") / (samples.length - 1)).toFixed(1), perCycleListeners: +(d("listeners") / (samples.length - 1)).toFixed(1) };
  console.log(`  after ${samples.length - 1} cycles: heap ${d("heapMB") > 0 ? "+" : ""}${d("heapMB").toFixed(1)} MB · nodes ${d("nodes") > 0 ? "+" : ""}${d("nodes")}`
    + ` · listeners ${d("listeners") > 0 ? "+" : ""}${d("listeners")} · documents ${d("docs") > 0 ? "+" : ""}${d("docs")}`);
  console.log(`  per cycle: ${out.leak.perCycleNodes} nodes, ${out.leak.perCycleListeners} listeners`);

  // ---- 2. SCROLLING, with a before and an after ---------------------------------------------
  console.log("\n=== scrolling ===");
  await open(); await sleep(1500);
  const modeBefore = JSON.parse(await s.evaluate(POS));
  console.log(`  mode: flow=${modeBefore.flow} scrolled=${modeBefore.scrolled}`);
  await s.evaluate(`(() => { window.__long = []; return true; })()`);
  const t0 = Date.now();
  await s.evaluate(`(async () => { const d = document.querySelector('.reader-desk');
    for (let i = 0; i < 240; i++) { d?.dispatchEvent(new WheelEvent('wheel', { deltaY: 140, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 16)); } return true; })()`);
  await sleep(2500);
  const after = JSON.parse(await s.evaluate(POS));
  const longs = JSON.parse(await s.evaluate(`JSON.stringify(window.__long)`));
  out.scroll = { mode: modeBefore.flow, scrolled: modeBefore.scrolled, before: modeBefore, after,
    moved: after.frac !== modeBefore.frac || after.idx !== modeBefore.idx,
    ms: Date.now() - t0, longTasks: longs, over100: longs.filter((x) => x > 100).length, worst: Math.max(0, ...longs) };
  console.log(`  position ${modeBefore.idx}/${modeBefore.frac} -> ${after.idx}/${after.frac} · MOVED=${out.scroll.moved}`);
  console.log(`  ${out.scroll.ms} ms · long tasks ${longs.length} (>100 ms: ${out.scroll.over100}, worst ${out.scroll.worst} ms)`);

  // ---- 3. ANNOTATIONS with the real book id --------------------------------------------------
  console.log("\n=== annotations (real book id) ===");
  out.annotations = JSON.parse(await s.evaluate(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke; const id = ${JSON.stringify(BOOK.id)};
    const v = document.querySelector('.page-host foliate-view');
    const cfi = v?.lastLocation?.cfi || 'epubcfi(/6/4!/4/2)';
    const r = { cfiUsed: String(cfi).slice(0, 40) };
    try {
      const bm = await inv('bookmark_create', { bookId: id, cfi, label: 'probe', chapterLabel: 'ch', fraction: 0.12 });
      r.bookmarkCreated = !!bm?.id;
      const hl = await inv('highlight_create', { bookId: id, cfi, color: 'yellow', excerpt: 'probe excerpt', chapterLabel: 'ch' });
      r.highlightCreated = !!hl?.id;
      r.bookmarksReadBack = (await inv('bookmarks_for_book', { bookId: id }) || []).length;
      r.highlightsReadBack = (await inv('highlights_for_book', { bookId: id }) || []).length;
      r.deletedBookmark = bm?.id ? await inv('bookmark_delete', { id: bm.id }) : null;
      r.deletedHighlight = hl?.id ? await inv('highlight_delete', { id: hl.id }) : null;
      r.bookmarksAfterDelete = (await inv('bookmarks_for_book', { bookId: id }) || []).length;
      r.highlightsAfterDelete = (await inv('highlights_for_book', { bookId: id }) || []).length;
    } catch (e) { r.error = String(e).slice(0, 200); }
    return JSON.stringify(r); })()`));
  console.log(`  ${JSON.stringify(out.annotations)}`);
  out.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 10))`));
  console.log(`  page errors this run: ${out.errors.length} ${JSON.stringify(out.errors.slice(0, 4))}`);
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch {}
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch {}
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/ux-leak-scroll-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
