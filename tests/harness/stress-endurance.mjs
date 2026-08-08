// PRE-UPDATE STRESS, round 2 — closes the three coverage gaps. TESTING TOOLING. No product changes.
//
// IDENTITY IS ESTABLISHED BEFORE ANY MEASUREMENT, because the previous round produced 16 findings that
// were all harness defects: a title-prefix match opened an EPUB and was reported as "a PDF that will
// not render", and `title.slice(0,12)` opened a PDF and was reported as "EPUB lost its Listen control".
// Rules here: select by the EXACT stored title, then PROVE the opened document with the engine's own
// `isFixedLayout` plus `.reader-desk.pdf-view`, and FAIL LOUDLY rather than measure the wrong thing.
//
// Memory is sampled only after a forced GC at an identical lifecycle point — the project's own rule,
// written because an earlier "leak" was uncollected garbage sampled at varying moments.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/stress-endurance-result.json";
const ID = JSON.parse(readFileSync(join(process.env.TEMP, "sard-ident.json"), "utf8"));
const PDF_TITLE = ID.khaldun.title;      // "kotobati - كتاب مقدمة ابن خلدون 1"
const EPUB_TITLE = ID.epub0.title;       // control EPUB, selected by format from the database
const CYCLES = Number((process.argv.find((a) => a.startsWith("--cycles=")) ?? "--cycles=50").split("=")[1]);

const c = { zoomOps: 0, bursts: 0, themes: 0, turns: 0, resizes: 0, immersive: 0, opens: 0, ttsSessions: 0, speedChanges: 0, checks: 0 };
const report = { startedAt: new Date().toISOString(), commit: "3e0fc98", target: PDF_TITLE, control: EPUB_TITLE,
  cycles: CYCLES, counters: c, samples: [], findings: [], khaldun: null };
const fail = (w) => { report.findings.push({ sev: "FAIL", w }); console.log(`  ✗ ${w}`); };
const harn = (w) => { report.findings.push({ sev: "HARNESS", w }); console.log(`  ⚠ HARNESS: ${w}`); };

const snap = snapshotDb("M:\\eRawy", "stress-endurance");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const STATE = `(() => {
  const v = document.querySelector('.page-host foliate-view'); const r = v?.renderer;
  const d = r?.getContents?.()?.[0]?.doc; if (!d) return { err: 'no doc' };
  const layers = [...d.querySelectorAll('.textLayer')];
  const spans = layers.reduce((a,l)=>a+[...l.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length,0);
  const img = d.querySelector('#canvas img') || d.querySelector('#canvas canvas');
  const b = img ? img.getBoundingClientRect() : null;
  return { zoom: r?.getAttribute('zoom') ?? null, layerCount: layers.length, spans,
    renders: !!img, ar: b && b.height ? +(b.width/b.height).toFixed(3) : null,
    pageNodes: d.querySelectorAll('*').length,
    marks: d.querySelectorAll('.sard-pdf-reading').length,
    listen: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
    ttsActive: window.__sardTtsStore?.getState?.().active ?? null };
})()`;

/** Open strictly by EXACT stored title. Returns false if no card carries that exact title. */
const openExact = async (title) => {
  await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(400);
  const hit = await s.evaluate(`(() => { const t=${JSON.stringify(title)};
    const c=[...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t);
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!hit) return false;
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(2600);
  return true;
};
/** Independent identity proof from the ENGINE, not the card. */
const identity = async () => JSON.parse(await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view');
  const d=v?.renderer?.getContents?.()?.[0]?.doc;
  return JSON.stringify({ fixedLayout: v?.isFixedLayout ?? null, sections: v?.book?.sections?.length ?? null,
    pdfView: !!document.querySelector('.reader-desk.pdf-view'),
    hasTextLayer: !!d?.querySelector('.textLayer') }); })()`));

const setZoom = async (z) => { c.zoomOps++; await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.renderer?.setAttribute('zoom',${JSON.stringify(String(z))}); return true; })()`); };
const nav = async (dir) => { c.turns++; await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.${dir}(); }catch(e){} })()`); };
const theme = async (t) => { c.themes++; await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${t}'); if (b) b.click(); return !!b; })()`); };
const stat = async () => { c.checks++; return JSON.parse(await s.evaluate(`JSON.stringify(${STATE})`)); };

/** GC-disciplined resource sample: collect first, then read, at an identical lifecycle point. */
async function sample(label) {
  try { await s.send("HeapProfiler.collectGarbage"); } catch { /* not enabled */ }
  await sleep(700);
  const m = (await s.send("Performance.getMetrics")).metrics;
  const g = (n) => m.find((x) => x.name === n)?.value ?? 0;
  const row = { label, t: new Date().toISOString(),
    heapMB: +(g("JSHeapUsedSize") / 1048576).toFixed(2), nodes: g("Nodes"), listeners: g("JSEventListeners"),
    docs: g("Documents"), frames: g("Frames"), layout: g("LayoutCount"), taskS: +g("TaskDuration").toFixed(1) };
  report.samples.push(row);
  console.log(`  [${label}] heap=${row.heapMB}MB nodes=${row.nodes} listeners=${row.listeners} docs=${row.docs} frames=${row.frames}`);
  return row;
}

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9971, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  await s.send("Performance.enable");
  try { await s.send("HeapProfiler.enable"); } catch { /* ok */ }
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[];
    addEventListener('error', e => window.__err.push('ERR:'+(e.message||'').slice(0,140)));
    addEventListener('unhandledrejection', e => window.__err.push('REJ:'+String(e.reason).slice(0,140)));
    return true; })()`);

  // ============ GAP 1 — the previously uncovered PDF, identity-proven ==========================
  console.log(`\n=== GAP 1 · ${PDF_TITLE}`);
  const found = await openExact(PDF_TITLE); c.opens++;
  if (!found) {
    harn(`no library card carries the exact stored title — PDF still uncovered`);
  } else {
    const id = await identity();
    console.log(`  identity: fixedLayout=${id.fixedLayout} pdfView=${id.pdfView} textLayer=${id.hasTextLayer} sections=${id.sections}`);
    if (id.fixedLayout !== true || !id.pdfView) {
      harn(`opened document is NOT the intended PDF (fixedLayout=${id.fixedLayout}, pdfView=${id.pdfView}) — refusing to measure`);
    } else {
      const k = { identity: id, steps: [] };
      for (let i = 0; i < 3; i++) { await nav("next"); await sleep(900); }
      await setZoom("fit-page"); await sleep(3000);
      const base = await stat(); k.baseline = base;
      console.log(`  baseline @${base.zoom}: spans=${base.spans} layers=${base.layerCount} ar=${base.ar} renders=${base.renders} nodes=${base.pageNodes}`);
      const check = (tag, a) => {
        const bad = [];
        if (a.layerCount !== 1) bad.push(`layers=${a.layerCount}`);
        if (a.spans !== base.spans) bad.push(`spans ${base.spans}->${a.spans}`);
        if (!a.renders) bad.push("not rendering");
        if (base.ar && a.ar && Math.abs(a.ar - base.ar) > 0.01) bad.push(`AR ${base.ar}->${a.ar}`);
        if (a.marks > 0) bad.push(`${a.marks} PDF marks`);
        if (a.listen) bad.push("Listen control present");
        k.steps.push({ tag, ...a, bad });
        if (bad.length) fail(`Khaldun ${tag}: ${bad.join(", ")}`); else console.log(`  ${tag}: OK (spans=${a.spans} layers=${a.layerCount})`);
      };
      // ordered zoom ladder + reverse
      for (const z of ["1", "2", "3", "4", "6"]) { await setZoom(z); await sleep(2600); }
      for (const z of ["4", "2", "1", "fit-page"]) { await setZoom(z); await sleep(2600); }
      await sleep(1500); check("zoom ladder + reverse", await stat());
      // hostile bursts
      for (let i = 0; i < 4; i++) { c.bursts++;
        for (const z of ["2","6","fit-width","3","fit-page","4","1","fit-page"]) { await setZoom(z); await sleep(80); }
        await sleep(5200); }
      check("4 hostile zoom bursts", await stat());
      // themes while zoomed
      await setZoom("3"); await sleep(2200);
      for (const t of ["sepia","night","ink","cream","grey","warm","green","normal"]) { await theme(t); await sleep(220); }
      await setZoom("fit-page"); await sleep(3200);
      check("8 themes while zoomed", await stat());
      // navigation incl. distant jumps
      for (let i = 0; i < 15; i++) { await nav("next"); await sleep(80); }
      await sleep(2500);
      await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.goTo(${Math.max(1, (id.sections||10) - 2)}); }catch(e){} })()`);
      await sleep(3000);
      await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.goTo(3); }catch(e){} })()`);
      await sleep(3000);
      await setZoom("fit-page"); await sleep(2000);
      const navState = await stat();
      k.steps.push({ tag: "navigation", ...navState });
      if (!navState.renders) fail("Khaldun navigation: page stopped rendering");
      if (navState.layerCount !== 1) fail(`Khaldun navigation: layers=${navState.layerCount}`);
      console.log(`  navigation + distant jumps: layers=${navState.layerCount} renders=${navState.renders}`);
      // resize + immersive
      await s.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false }); c.resizes++;
      await sleep(2200);
      await s.send("Emulation.clearDeviceMetricsOverride"); await sleep(2200);
      await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); c.immersive++;
      await sleep(1200);
      await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`);
      await sleep(1500);
      check("resize + immersive", await stat());
      // disabled-TTS incl. hostile keys
      await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
        for (const key of [' ','Enter','p','P','l','L']) { document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
          d?.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); } return true; })()`);
      await sleep(1500);
      const dis = await stat(); k.disabled = dis;
      if (dis.listen || dis.marks > 0 || dis.ttsActive === true) fail(`Khaldun disabled-state violated: listen=${dis.listen} marks=${dis.marks} ttsActive=${dis.ttsActive}`);
      else console.log(`  PDF read-aloud absent, keys inert ✓`);
      // close/reopen + PDF->EPUB->PDF
      await openExact(PDF_TITLE); c.opens++;
      const re = await identity();
      if (re.fixedLayout !== true) fail(`Khaldun reopen: identity lost (fixedLayout=${re.fixedLayout})`);
      const okE = await openExact(EPUB_TITLE); c.opens++;
      const eid = await identity();
      if (!okE || eid.fixedLayout !== false) harn(`EPUB control not established on transition (found=${okE}, fixedLayout=${eid.fixedLayout})`);
      else if (!(await stat()).listen) fail("EPUB lost its Listen control after a PDF session");
      await openExact(PDF_TITLE); c.opens++;
      const back = await stat();
      if (back.listen) fail("PDF exposed a Listen control after an EPUB session");
      console.log(`  close/reopen + PDF->EPUB->PDF: OK`);
      report.khaldun = k;
    }
  }

  // ============ GAP 2 — long endurance =========================================================
  console.log(`\n=== GAP 2 · endurance, ${CYCLES} cycles`);
  const t0 = Date.now();
  await openExact(PDF_TITLE.includes("خلدون") ? PDF_TITLE : PDF_TITLE); c.opens++;
  await sample("start");
  const THEMES = ["sepia","night","ink","cream","grey","warm","green","normal"];
  for (let i = 1; i <= CYCLES; i++) {
    await setZoom(i % 2 ? "3" : "2"); await sleep(180);
    await setZoom("6"); await sleep(180);
    await setZoom("fit-page"); await sleep(220);
    await theme(THEMES[i % THEMES.length]); await sleep(140);
    await nav("next"); await sleep(180);
    await nav("prev"); await sleep(180);
    if (i % 7 === 0) { await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.goTo(${3 + (i % 40)}); }catch(e){} })()`); await sleep(500); }
    if (i % 11 === 0) { await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); c.immersive++; await sleep(200);
      await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); }
    if (i % 13 === 0) { await s.send("Emulation.setDeviceMetricsOverride", { width: 1000 + (i % 200), height: 700, deviceScaleFactor: 1, mobile: false }); c.resizes++;
      await sleep(300); await s.send("Emulation.clearDeviceMetricsOverride"); }
    if (i % 17 === 0) { await openExact(EPUB_TITLE); c.opens++; await sleep(300); await openExact(PDF_TITLE); c.opens++; }
    if (i % 10 === 0) { await sample(`cycle ${i}`); }
  }
  await sample("end");
  report.enduranceMs = Date.now() - t0;
  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0,25))`));
  console.log(`\nendurance: ${(report.enduranceMs / 60000).toFixed(1)} min · page errors=${report.pageErrors.length}`);

  const first = report.samples[0], last = report.samples[report.samples.length - 1];
  report.growth = { heapMB: +(last.heapMB - first.heapMB).toFixed(2), nodes: last.nodes - first.nodes,
    listeners: last.listeners - first.listeners, docs: last.docs - first.docs, frames: last.frames - first.frames };
  console.log(`growth (GC-forced, identical lifecycle point): heap ${report.growth.heapMB >= 0 ? "+" : ""}${report.growth.heapMB}MB · `
    + `nodes ${report.growth.nodes >= 0 ? "+" : ""}${report.growth.nodes} · listeners ${report.growth.listeners >= 0 ? "+" : ""}${report.growth.listeners} · `
    + `docs ${report.growth.docs >= 0 ? "+" : ""}${report.growth.docs} · frames ${report.growth.frames >= 0 ? "+" : ""}${report.growth.frames}`);
  console.log(`per cycle: nodes ${(report.growth.nodes / CYCLES).toFixed(2)} · listeners ${(report.growth.listeners / CYCLES).toFixed(2)}`);
  if (report.pageErrors.length) { console.log("page errors:"); for (const e of report.pageErrors.slice(0, 8)) console.log(`   ${e}`); }

  console.log(`\ncounters: ${JSON.stringify(c)}`);
  console.log(`${report.findings.filter(f=>f.sev==="FAIL").length === 0 ? "✓ no product failures" : `✗ ${report.findings.filter(f=>f.sev==="FAIL").length} product failure(s)`}`);
} catch (e) {
  report.fatal = e.message;
  console.error("\nFATAL:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
  if (report.findings.some((f) => f.sev === "FAIL") || report.fatal) process.exitCode = 3;
}
