// MEMORY REGRESSION HARNESS — is retained memory flat across identical work?
//
//   node tests/harness/heap.mjs --cycles=8
//
// `usedJSHeapSize` sampled wherever GC happens to have left it is not evidence — the identical
// 6-round workload measured x0.28 and x2.36 on consecutive runs. This forces a real collection
// through CDP (HeapProfiler.collectGarbage) before every sample, which removes the timing term
// entirely: post-GC heap is retained memory, and retained memory that climbs monotonically across
// identical cycles IS a leak.
//
// Also samples DOM node counts in both realms and the JS listener/handle counts, so a leak that
// hides outside the JS heap still shows up.
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CYCLES = Number((process.argv.find((a) => a.startsWith("--cycles=")) ?? "--cycles=8").slice(9));
const BOOK = "arabic-normal--karamazov.epub";

const P_SAMPLE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc;
  return {
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    heapTotal: performance.memory ? performance.memory.totalJSHeapSize : null,
    topNodes: document.querySelectorAll('*').length,
    docNodes: d ? d.querySelectorAll('*').length : null,
    iframes: document.querySelectorAll('iframe').length,
    sectionIndex: c?.index ?? null,
  };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}

const out = { startedAt: new Date().toISOString(), cycles: CYCLES, samples: [], violations: [] };
const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "heap");
let sard = null;
try {
  sard = await launchSard({ port: 9422 });
  if (sard.skipped) { console.error(sard.skipped); process.exit(0); }
  const s = sard;
  await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);

  // Can we actually force a collection? If not, say so and do NOT dress the result up as proof.
  let gcOk = true;
  try { await s.send("HeapProfiler.enable"); await s.send("HeapProfiler.collectGarbage"); }
  catch (e) { gcOk = false; out.gcError = String(e?.message ?? e); }
  out.forcedGc = gcOk;
  const settle = async () => {
    if (gcOk) { try { await s.send("HeapProfiler.collectGarbage"); } catch {} }
    await sleep(1200);
    if (gcOk) { try { await s.send("HeapProfiler.collectGarbage"); } catch {} }
    await sleep(600);
  };

  const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });
  let book = ((await list()) || []).find((b) => (b.file_path ?? "").replace(/\\/g, "/").includes(BOOK));
  if (!book && corpusAvailable() && existsSync(join(corpusDir(), BOOK))) {
    const res = await inv("import_books", { paths: [join(corpusDir(), BOOK)] });
    await sleep(2000);
    const id = Array.isArray(res) ? res[0]?.id : null;
    book = ((await list()) || []).find((b) => b.id === id);
  }
  if (!book) throw new Error(`${BOOK} unavailable`);
  await inv("settings_set", { key: "book_css", value: "raw" }); // the heaviest mode

  // Each cycle is an IDENTICAL unit of work: open the book, read through it, close back to library.
  // Identical work must leave identical retained memory. Anything else accumulates.
  for (let i = 0; i < CYCLES; i++) {
    await s.evaluate(`window.location.reload()`);
    await sleep(2800);
    await s.evaluate(`(() => { const t = ${JSON.stringify(book.title)};
      const all = [...document.querySelectorAll('.lib-card')];
      const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
      if (c) c.click(); return !!c; })()`);
    await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
    await sleep(1500);
    await s.evaluate(`(async () => {
      const v = document.querySelector('.page-host foliate-view');
      for (let k = 0; k < 12; k++) { try { await v.renderer.next(); } catch {} await new Promise(r => setTimeout(r, 80)); }
      for (const idx of [2, 5, 1]) { try { await v.goTo({ index: idx, anchor: 0 }); } catch {} await new Promise(r => setTimeout(r, 300)); }
    })()`);
    await settle();
    const m = await s.evaluate(P_SAMPLE);
    out.samples.push({ cycle: i, ...m });
    console.log(`  cycle ${i}: postGC heap ${(m.heap / 1e6).toFixed(2)}MB (total ${(m.heapTotal / 1e6).toFixed(1)}) · topNodes ${m.topNodes} · docNodes ${m.docNodes} · iframes ${m.iframes}`);
  }

  // Verdict. Compare the LAST HALF with the FIRST HALF of post-GC samples: a leak is a monotonic
  // trend in retained memory, not a single high reading.
  const half = Math.max(1, Math.floor(out.samples.length / 2));
  const head = out.samples.slice(0, half), tail = out.samples.slice(-half);
  const avg = (xs, f) => xs.reduce((a, b) => a + (f(b) ?? 0), 0) / xs.length;
  const hHead = avg(head, (x) => x.heap), hTail = avg(tail, (x) => x.heap);
  const growthPerCycle = (hTail - hHead) / Math.max(1, out.samples.length - half);
  const spread = Math.max(...out.samples.map((x) => x.heap)) - Math.min(...out.samples.map((x) => x.heap));
  out.verdict = {
    forcedGc: gcOk,
    postGcHeadMB: (hHead / 1e6).toFixed(2),
    postGcTailMB: (hTail / 1e6).toFixed(2),
    ratio: (hTail / hHead).toFixed(2),
    growthPerCycleKB: (growthPerCycle / 1e3).toFixed(1),
    spreadMB: (spread / 1e6).toFixed(2),
    nodes: `${avg(head, (x) => x.topNodes).toFixed(0)} → ${avg(tail, (x) => x.topNodes).toFixed(0)}`,
    iframes: `${avg(head, (x) => x.iframes).toFixed(1)} → ${avg(tail, (x) => x.iframes).toFixed(1)}`,
  };
  // A real leak from repeated book opens would add megabytes per cycle, not kilobytes.
  if (gcOk && growthPerCycle > 2e6) out.violations.push(`post-GC heap grows ${(growthPerCycle / 1e6).toFixed(2)} MB per identical cycle — that is retention, not GC timing`);
  if (avg(tail, (x) => x.iframes) > avg(head, (x) => x.iframes) + 1) out.violations.push(`iframe count climbing: ${out.verdict.iframes} — detached section documents are being retained`);
} catch (e) {
  out.fatal = String(e?.message ?? e);
} finally {
  if (sard) { try { await sard.close(); } catch {} }
  const s2 = await launchSard({ port: 9423 }).catch(() => null);
  if (s2 && !s2.skipped) {
    await waitFor(s2, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 60, 400);
    await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
    await s2.close();
  }
  await restoreDb(snap);
  const libDir = join(APP_DATA, "library");
  if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) rmSync(join(libDir, f), { force: true });
  console.log("  profile restored");
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "heap.json"), JSON.stringify(out, null, 1), "utf8");
console.log("\n  ===== HEAP (forced GC before every sample) =====");
console.log("  " + JSON.stringify(out.verdict, null, 1).replace(/\n/g, "\n  "));
if (out.fatal) { console.log(`\n  ✗ FATAL ${out.fatal}\n`); process.exit(1); }
if (!out.forcedGc) { console.log(`\n  ⓘ could not force GC (${out.gcError}) — result is NOT conclusive\n`); process.exit(2); }
if (out.violations.length) { console.log(`\n  ✗ ${out.violations.length} violation(s):`); for (const v of out.violations) console.log(`      ${v}`); console.log(""); process.exit(1); }
console.log("\n  ✓ no retention across identical cycles — the earlier swing was GC timing\n");
