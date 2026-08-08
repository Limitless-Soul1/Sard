// UX ENDURANCE AUDIT — reading for a long time, and attacking the experience rather than correctness.
//
// The library audit proved Sard shows the right STRUCTURE. This asks a different question: does it
// stay pleasant? Latency distributions (not averages — a reader feels the p95), dropped frames while
// scrolling, whether annotations survive real navigation, and whether an hour of use leaves the app
// heavier, noisier or subtly wrong.
//
// WHAT A NUMBER HERE MEANS. A page turn is "done" when the reading position has actually changed and
// content is present — not when the call returns. Long tasks come from a PerformanceObserver inside
// the page, because per-second polling misses burst-shaped jank (a lesson this project paid for).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = snapshotDb("M:\\eRawy", "ux-endurance");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

let s;
const out = {};
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9916, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  try { await s.send("Performance.enable", {}); } catch { /* older protocol */ }
  const metrics = async () => {
    try { const m = await s.send("Performance.getMetrics", {});
      const g = (n) => m?.metrics?.find((x) => x.name === n)?.value ?? null;
      return { heapMB: +(g("JSHeapUsedSize") / 1048576).toFixed(1), nodes: g("Nodes"), listeners: g("JSEventListeners"), docs: g("Documents") };
    } catch { return null; }
  };
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // Instruments installed once, in the page, for the whole session.
  await s.evaluate(`(() => {
    window.__err = []; window.__long = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140)));
    window.addEventListener('unhandledrejection', e => window.__err.push('reject: ' + String(e.reason).slice(0,140)));
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] }); } catch {}
    return true; })()`);

  const POS = `(() => { const v = document.querySelector('.page-host foliate-view');
    const f = v?.lastLocation?.fraction; const c = v?.renderer?.getContents?.()?.[0];
    return JSON.stringify({ frac: typeof f === 'number' ? Math.round(f*1e7)/1e7 : null,
      idx: c?.index ?? null, len: (c?.doc?.body?.textContent||'').trim().length }); })()`;

  const backToLibrary = async () => {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(300);
  };
  const openByText = async (token) => {
    const ok = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(token)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!ok) return false;
    for (let k = 0; k < 120; k++) {
      const p = JSON.parse(await s.evaluate(POS));
      if (p.len > 0) return true;
      await sleep(250);
    }
    return false;
  };

  const base = await metrics();
  console.log(`baseline ${JSON.stringify(base)}\n`);

  // ---- 1. PAGE TURN: 80 consecutive turns. A reader feels the tail, so report the tail. --------
  console.log("=== 1. page turning (80 turns, الإخوة كارامازوف) ===");
  if (!(await openByText("الإخوة كارامازوف"))) throw new Error("could not open the test book");
  await sleep(1500);
  await s.evaluate(`(() => { window.__long = []; return true; })()`);
  const turns = [];
  for (let k = 0; k < 80; k++) {
    const b = JSON.parse(await s.evaluate(POS));
    const t = Date.now();
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    let moved = false;
    for (let w = 0; w < 50; w++) {
      const a = JSON.parse(await s.evaluate(POS));
      if (a.frac !== b.frac || a.idx !== b.idx) { moved = true; break; }
      await sleep(40);
    }
    turns.push({ ms: Date.now() - t, moved });
  }
  const tms = turns.filter((x) => x.moved).map((x) => x.ms);
  out.turn = { n: turns.length, failed: turns.filter((x) => !x.moved).length, p50: pct(tms, 0.5), p95: pct(tms, 0.95),
    max: Math.max(...tms), over250: tms.filter((x) => x > 250).length, longTasks: JSON.parse(await s.evaluate(`JSON.stringify(window.__long)`)) };
  console.log(`  p50 ${out.turn.p50} ms · p95 ${out.turn.p95} ms · max ${out.turn.max} ms · turns >250 ms: ${out.turn.over250} · failed ${out.turn.failed}`);
  console.log(`  long tasks during turning: ${out.turn.longTasks.length} (worst ${Math.max(0, ...out.turn.longTasks)} ms)`);

  // ---- 2. SCROLLING: sustained wheel scrolling, measured for jank -----------------------------
  console.log("\n=== 2. sustained scrolling (300 wheel events) ===");
  await s.evaluate(`(() => { window.__long = []; return true; })()`);
  const scrollT = Date.now();
  await s.evaluate(`(async () => { const d = document.querySelector('.reader-desk');
    for (let i = 0; i < 300; i++) {
      d?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 16));
    } return true; })()`);
  await sleep(2500);
  out.scroll = { ms: Date.now() - scrollT, longTasks: JSON.parse(await s.evaluate(`JSON.stringify(window.__long)`)),
    pos: JSON.parse(await s.evaluate(POS)) };
  out.scroll.over100 = out.scroll.longTasks.filter((x) => x > 100).length;
  console.log(`  ${out.scroll.ms} ms · long tasks ${out.scroll.longTasks.length} (>100 ms: ${out.scroll.over100}, worst ${Math.max(0, ...out.scroll.longTasks)} ms)`);

  // ---- 3. CHAPTER TRANSITIONS: cross 12 boundaries, each must land with content ---------------
  console.log("\n=== 3. chapter transitions (12 boundaries) ===");
  const trans = [];
  for (let k = 0; k < 12; k++) {
    const b = JSON.parse(await s.evaluate(POS));
    const t = Date.now();
    await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view');
      const c = v?.renderer?.getContents?.()?.[0]; v?.goTo?.(v.book.sections[(c?.index ?? 0) + 1]?.id ?? (c?.index ?? 0) + 1); return true; })()`);
    let a = null;
    for (let w = 0; w < 60; w++) { a = JSON.parse(await s.evaluate(POS)); if (a.idx !== b.idx && a.len > 0) break; await sleep(150); }
    trans.push({ from: b.idx, to: a?.idx ?? null, ms: Date.now() - t, len: a?.len ?? 0, ok: a?.idx === b.idx + 1 && a.len > 0 });
  }
  out.transitions = { n: trans.length, ok: trans.filter((x) => x.ok).length, empty: trans.filter((x) => x.len === 0).length,
    p95: pct(trans.map((x) => x.ms), 0.95), detail: trans };
  console.log(`  landed correctly: ${out.transitions.ok}/${trans.length} · empty on arrival: ${out.transitions.empty} · p95 ${out.transitions.p95} ms`);

  // ---- 4. ANNOTATIONS during real reading: create, navigate away, come back, verify -----------
  console.log("\n=== 4. bookmarks / highlights / notes ===");
  out.annotations = JSON.parse(await s.evaluate(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const v = document.querySelector('.page-host foliate-view');
    const bookId = [...document.querySelectorAll('*')].length && window.__sardBookId ? window.__sardBookId : null;
    const res = { bookIdFound: !!bookId };
    try {
      const cfi = v?.lastLocation?.cfi ?? 'epubcfi(/6/2!/4/2)';
      const id = bookId || 'ux-endurance-probe';
      const bm = await inv('bookmark_create', { bookId: id, cfi, label: 'ux probe', chapterLabel: 'ch', fraction: 0.1 });
      res.bookmark = !!bm;
      const hl = await inv('highlight_create', { bookId: id, cfi, color: 'yellow', excerpt: 'probe', chapterLabel: 'ch' });
      res.highlight = !!hl;
      res.bookmarksBack = (await inv('bookmarks_for_book', { bookId: id }) || []).length;
      res.highlightsBack = (await inv('highlights_for_book', { bookId: id }) || []).length;
      if (bm?.id) { await inv('bookmark_delete', { id: bm.id }); res.cleanedBookmark = true; }
      if (hl?.id) { await inv('highlight_delete', { id: hl.id }); res.cleanedHighlight = true; }
    } catch (e) { res.error = String(e).slice(0, 160); }
    return JSON.stringify(res); })()`));
  console.log(`  ${JSON.stringify(out.annotations)}`);

  // ---- 5. OPEN/CLOSE the same book 12 times: the classic leak shape ---------------------------
  console.log("\n=== 5. open/close the same book x12 ===");
  const cycles = [];
  for (let k = 0; k < 12; k++) {
    await backToLibrary();
    const t = Date.now();
    const ok = await openByText("الإخوة كارامازوف");
    cycles.push({ k, ms: Date.now() - t, ok, m: await metrics() });
  }
  await backToLibrary();
  out.cycles = { n: cycles.length, failed: cycles.filter((x) => !x.ok).length,
    openP50: pct(cycles.map((x) => x.ms), 0.5), openMax: Math.max(...cycles.map((x) => x.ms)),
    first: cycles[0].m, last: cycles[cycles.length - 1].m, detail: cycles.map((c) => c.m) };
  console.log(`  open p50 ${out.cycles.openP50} ms · max ${out.cycles.openMax} ms · failed ${out.cycles.failed}`);
  console.log(`  first cycle ${JSON.stringify(out.cycles.first)}`);
  console.log(`  last  cycle ${JSON.stringify(out.cycles.last)}`);

  // ---- 6. MANY DIFFERENT BOOKS: does the cost accumulate per book? ----------------------------
  console.log("\n=== 6. twelve different books in sequence ===");
  const keys = JSON.parse(await s.evaluate(`JSON.stringify([...document.querySelectorAll('.lib-card')]
    .map(c => (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)))`)).slice(0, 12);
  const seq = [];
  for (const key of keys) {
    await backToLibrary();
    const t = Date.now();
    const ok = await openByText(key);
    seq.push({ key: key.slice(0, 26), ms: Date.now() - t, ok, m: await metrics() });
    console.log(`  ${ok ? "ok " : "NO "} ${String(Date.now() - t).padStart(6)} ms  ${JSON.stringify(seq[seq.length-1].m)}  ${key.slice(0, 26)}`);
  }
  out.sequence = { n: seq.length, failed: seq.filter((x) => !x.ok).length, detail: seq };

  // ---- 7. AFTER ALL THAT: is the UI still coherent? -------------------------------------------
  await backToLibrary();
  await sleep(2500);
  out.final = { metrics: await metrics(), errors: JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 20))`)),
    ui: JSON.parse(await s.evaluate(`(() => ({
      cards: document.querySelectorAll('.lib-card').length,
      strayReader: !!document.querySelector('.page-host'),
      openPanels: document.querySelectorAll('.reader-panel.show, .settings-panel.show').length,
      overlays: document.querySelectorAll('.modal, .dialog, [class*=overlay]').length,
    })).call(null)`).then((r) => JSON.stringify(r)).catch(() => "{}")) };
  out.baseline = base;
  console.log(`\n=== 7. after the whole session ===`);
  console.log(`  baseline ${JSON.stringify(base)}`);
  console.log(`  final    ${JSON.stringify(out.final.metrics)}`);
  console.log(`  ui       ${JSON.stringify(out.final.ui)}`);
  console.log(`  errors   ${out.final.errors.length}: ${JSON.stringify(out.final.errors.slice(0, 6))}`);
} catch (e) {
  console.error("\nENDURANCE FAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/ux-endurance-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
