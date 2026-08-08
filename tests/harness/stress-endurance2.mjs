// PRE-UPDATE STRESS round 3 — GAP 1 (Ibn Khaldun PDF) + GAP 2 (real endurance). TESTING TOOLING.
//
// SELECTION, corrected twice now. The library card exposes only class/role/tabindex/title — no id, no
// format — and the DISPLAYED title differs from the stored one ("مقدمة ابن خلدون" vs
// "kotobati - كتاب مقدمة ابن خلدون 1"). Two books share the displayed name, one EPUB and one PDF.
// So: enumerate EVERY card with that exact displayed title, open them ONE AT A TIME, and let the
// ENGINE decide which is the PDF (`isFixedLayout === true` + `.reader-desk.pdf-view`). Never position,
// never "first match", never inferring format from a title.
//
// GAP 2 refuses to run unless a reader document is open and identity-proven — the previous endurance
// attempt silently measured an idle library and is recorded as VOID.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/stress-endurance2-result.json";
const DISPLAY_TITLE = "مقدمة ابن خلدون";
const CYCLES = Number((process.argv.find((a) => a.startsWith("--cycles=")) ?? "--cycles=60").split("=")[1]);

const c = { zoomOps: 0, bursts: 0, themes: 0, turns: 0, jumps: 0, resizes: 0, immersive: 0, opens: 0, checks: 0, enduranceIters: 0 };
const report = { startedAt: new Date().toISOString(), commit: "3e0fc98", counters: c, findings: [], samples: [], gap1: null };
const fail = (w) => { report.findings.push({ sev: "PRODUCT BUG", w }); console.log(`  ✗ PRODUCT: ${w}`); };
const harn = (w) => { report.findings.push({ sev: "HARNESS BUG", w }); console.log(`  ⚠ HARNESS: ${w}`); };

const snap = snapshotDb("M:\\eRawy", "stress-end2");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const STATE = `(() => {
  const v = document.querySelector('.page-host foliate-view'); const r = v?.renderer;
  const d = r?.getContents?.()?.[0]?.doc; if (!d) return { err: 'no doc' };
  const layers = [...d.querySelectorAll('.textLayer')];
  const spans = layers.reduce((a,l)=>a+[...l.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length,0);
  const img = d.querySelector('#canvas img') || d.querySelector('#canvas canvas');
  const b = img ? img.getBoundingClientRect() : null;
  return { zoom: r?.getAttribute('zoom') ?? null, layerCount: layers.length, spans, renders: !!img,
    ar: b && b.height ? +(b.width/b.height).toFixed(3) : null, pageNodes: d.querySelectorAll('*').length,
    marks: d.querySelectorAll('.sard-pdf-reading').length,
    listen: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
    ttsActive: window.__sardTtsStore?.getState?.().active ?? null };
})()`;
const identity = async () => JSON.parse(await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view');
  return JSON.stringify({ fixedLayout: v?.isFixedLayout ?? null, sections: v?.book?.sections?.length ?? null,
    pdfView: !!document.querySelector('.reader-desk.pdf-view'), hasView: !!v }); })()`));
const toLibrary = async () => { await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(400); };
/** Open the Nth card carrying EXACTLY this displayed title. */
const openNth = async (title, n) => { await toLibrary();
  const ok = await s.evaluate(`(() => { const t=${JSON.stringify(title)};
    const all=[...document.querySelectorAll('.lib-card')].filter(x => (x.getAttribute('title')||'') === t);
    const c = all[${n}]; if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!ok) return false;
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(2800); c.opens++; return true; };
const openExactSingle = async (title) => { await toLibrary();
  const ok = await s.evaluate(`(() => { const t=${JSON.stringify(title)};
    const c=[...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t);
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!ok) return false;
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(2800); c.opens++; return true; };

const setZoom = async (z) => { c.zoomOps++; await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.renderer?.setAttribute('zoom',${JSON.stringify(String(z))}); return true; })()`); };
const nav = async (d) => { c.turns++; await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.${d}(); }catch(e){} })()`); };
const theme = async (t) => { c.themes++; await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${t}'); if (b) b.click(); return !!b; })()`); };
const jump = async (i) => { c.jumps++; await s.evaluate(`(async()=>{ const v=document.querySelector('.page-host foliate-view'); try{ await v.goTo(${i}); }catch(e){} })()`); };
const stat = async () => { c.checks++; return JSON.parse(await s.evaluate(`JSON.stringify(${STATE})`)); };
async function sample(label) {
  try { await s.send("HeapProfiler.collectGarbage"); } catch {}
  await sleep(700);
  const m = (await s.send("Performance.getMetrics")).metrics; const g = (n) => m.find((x) => x.name === n)?.value ?? 0;
  const st = await stat();
  const row = { label, heapMB: +(g("JSHeapUsedSize") / 1048576).toFixed(2), nodes: g("Nodes"),
    listeners: g("JSEventListeners"), docs: g("Documents"), frames: g("Frames"),
    pageNodes: st.pageNodes ?? null, spans: st.spans ?? null, docOpen: !st.err };
  report.samples.push(row);
  console.log(`  [${label}] heap=${row.heapMB}MB nodes=${row.nodes} listeners=${row.listeners} docs=${row.docs} frames=${row.frames} pageNodes=${row.pageNodes} spans=${row.spans} docOpen=${row.docOpen}`);
  return row;
}

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9973, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  await s.send("Performance.enable"); try { await s.send("HeapProfiler.enable"); } catch {}
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[];
    addEventListener('error', e => window.__err.push('ERR:'+(e.message||'').slice(0,140)));
    addEventListener('unhandledrejection', e => window.__err.push('REJ:'+String(e.reason).slice(0,140))); return true; })()`);

  // ---------- disambiguate candidates by ENGINE identity ----------
  const nCand = await s.evaluate(`[...document.querySelectorAll('.lib-card')].filter(x => (x.getAttribute('title')||'') === ${JSON.stringify(DISPLAY_TITLE)}).length`);
  console.log(`\n=== GAP 1 · candidates with displayed title "${DISPLAY_TITLE}": ${nCand}`);
  let pdfIdx = -1, probe = [];
  for (let i = 0; i < nCand; i++) {
    if (!(await openNth(DISPLAY_TITLE, i))) { probe.push({ i, opened: false }); continue; }
    const id = await identity();
    probe.push({ i, ...id });
    console.log(`  candidate ${i}: fixedLayout=${id.fixedLayout} pdfView=${id.pdfView} sections=${id.sections}`);
    if (id.fixedLayout === true && id.pdfView) { pdfIdx = i; break; }
  }
  report.candidateProbe = probe;
  if (pdfIdx < 0) { harn(`no candidate with displayed title "${DISPLAY_TITLE}" proved to be a PDF — GAP 1 remains uncovered`); }
  else {
    console.log(`  -> candidate ${pdfIdx} PROVEN to be the PDF`);
    const k = { candidateIndex: pdfIdx, steps: [] };
    for (let i = 0; i < 3; i++) { await nav("next"); await sleep(900); }
    await setZoom("fit-page"); await sleep(3000);
    const base = await stat(); k.baseline = base;
    console.log(`  baseline @${base.zoom}: spans=${base.spans} layers=${base.layerCount} ar=${base.ar} renders=${base.renders} nodes=${base.pageNodes}`);
    const check = async (tag) => { const a = await stat(); const bad = [];
      if (a.layerCount !== 1) bad.push(`layers=${a.layerCount}`);
      if (a.spans !== base.spans) bad.push(`spans ${base.spans}->${a.spans}`);
      if (!a.renders) bad.push("not rendering");
      if (base.ar && a.ar && Math.abs(a.ar - base.ar) > 0.01) bad.push(`AR ${base.ar}->${a.ar}`);
      if (a.marks > 0) bad.push(`${a.marks} PDF marks`);
      if (a.listen) bad.push("Listen control present");
      k.steps.push({ tag, ...a, bad });
      if (bad.length) fail(`Khaldun ${tag}: ${bad.join(", ")}`); else console.log(`  ${tag}: OK (spans=${a.spans} layers=${a.layerCount} renders=${a.renders})`);
      return a; };
    for (const z of ["1","2","3","4","6"]) { await setZoom(z); await sleep(2500); }
    for (const z of ["4","2","1","fit-page"]) { await setZoom(z); await sleep(2500); }
    await sleep(1200); await check("zoom ladder 1x-6x + reverse");
    for (let i = 0; i < 4; i++) { c.bursts++;
      for (const z of ["2","6","fit-width","3","fit-page","4","1","fit-page"]) { await setZoom(z); await sleep(80); }
      await sleep(5200); }
    await check("4 hostile zoom bursts");
    await setZoom("3"); await sleep(2200);
    for (const t of ["sepia","night","ink","cream","grey","warm","green","normal"]) { await theme(t); await sleep(220); }
    await setZoom("fit-page"); await sleep(3200); await check("8 themes while zoomed");
    for (let i = 0; i < 15; i++) { await nav("next"); await sleep(80); }
    await sleep(2500);
    const sec = (await identity()).sections || 20;
    await jump(Math.max(1, sec - 2)); await sleep(3000); await jump(3); await sleep(3000);
    await setZoom("fit-page"); await sleep(2200); await check("nav burst + distant jumps");
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false }); c.resizes++;
    await sleep(2200); await s.send("Emulation.clearDeviceMetricsOverride"); await sleep(2200);
    await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); c.immersive++;
    await sleep(1200); await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`);
    await sleep(1500); await check("resize + immersive");
    await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      for (const key of [' ','Enter','p','P','l','L']) { document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
        d?.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); } return true; })()`);
    await sleep(1500);
    const dis = await stat(); k.disabled = dis;
    if (dis.listen || dis.marks > 0 || dis.ttsActive === true) fail(`Khaldun disabled-state: listen=${dis.listen} marks=${dis.marks} ttsActive=${dis.ttsActive}`);
    else console.log(`  PDF read-aloud absent, hostile keys inert ✓`);
    await openNth(DISPLAY_TITLE, pdfIdx);
    if ((await identity()).fixedLayout !== true) fail("Khaldun reopen: identity lost");
    else console.log(`  close/reopen: identity preserved ✓`);
    report.gap1 = k;
  }

  // ---------- GAP 2 · endurance, gated on a proven open document ----------
  console.log(`\n=== GAP 2 · endurance, ${CYCLES} cycles`);
  let endOk = pdfIdx >= 0 ? await openNth(DISPLAY_TITLE, pdfIdx) : false;
  let gid = endOk ? await identity() : { fixedLayout: null };
  if (!endOk || gid.fixedLayout !== true) {
    harn("endurance NOT STARTED — no identity-proven reader document (previous round's numbers were VOID for exactly this reason)");
  } else {
    console.log(`  reader open and proven (sections=${gid.sections}) — starting`);
    const t0 = Date.now();
    await sample("start");
    const TH = ["sepia","night","ink","cream","grey","warm","green","normal"];
    let voided = 0;
    for (let i = 1; i <= CYCLES; i++) {
      c.enduranceIters++;
      await setZoom(i % 2 ? "3" : "2"); await sleep(150);
      await setZoom("6"); await sleep(150);
      await setZoom("fit-page"); await sleep(200);
      await theme(TH[i % TH.length]); await sleep(120);
      await nav("next"); await sleep(160);
      await nav("prev"); await sleep(160);
      if (i % 7 === 0) { await jump(3 + (i % 30)); await sleep(420); }
      if (i % 11 === 0) { await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); c.immersive++;
        await sleep(180); await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`); }
      if (i % 13 === 0) { await s.send("Emulation.setDeviceMetricsOverride", { width: 1000 + (i % 180), height: 700, deviceScaleFactor: 1, mobile: false });
        c.resizes++; await sleep(280); await s.send("Emulation.clearDeviceMetricsOverride"); }
      // every 10th cycle, assert the document is STILL open — an endurance run over nothing is void
      if (i % 10 === 0) {
        const chk = await stat();
        if (chk.err) { voided++; harn(`cycle ${i}: reader document vanished — re-opening`); await openNth(DISPLAY_TITLE, pdfIdx); }
        await sample(`cycle ${i}`);
      }
    }
    await sample("end");
    report.enduranceMs = Date.now() - t0;
    report.enduranceVoidedCycles = voided;
    const f = report.samples[0], l = report.samples[report.samples.length - 1];
    report.growth = { heapMB: +(l.heapMB - f.heapMB).toFixed(2), nodes: l.nodes - f.nodes,
      listeners: l.listeners - f.listeners, docs: l.docs - f.docs, frames: l.frames - f.frames };
    console.log(`\n  endurance: ${(report.enduranceMs / 60000).toFixed(1)} min · ${CYCLES} cycles · voided cycles=${voided}`);
    console.log(`  growth (GC forced, identical lifecycle point): heap ${report.growth.heapMB >= 0 ? "+" : ""}${report.growth.heapMB}MB · `
      + `nodes ${report.growth.nodes >= 0 ? "+" : ""}${report.growth.nodes} · listeners ${report.growth.listeners >= 0 ? "+" : ""}${report.growth.listeners} · `
      + `docs ${report.growth.docs >= 0 ? "+" : ""}${report.growth.docs} · frames ${report.growth.frames >= 0 ? "+" : ""}${report.growth.frames}`);
    console.log(`  per cycle: nodes ${(report.growth.nodes / CYCLES).toFixed(3)} · listeners ${(report.growth.listeners / CYCLES).toFixed(3)}`);
  }

  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0,25))`));
  console.log(`\npage errors: ${report.pageErrors.length}`);
  for (const e of [...new Set(report.pageErrors)].slice(0, 6)) console.log(`   ${e}`);
  console.log(`counters: ${JSON.stringify(c)}`);
  const bugs = report.findings.filter((x) => x.sev === "PRODUCT BUG").length;
  console.log(`\n${bugs === 0 ? "✓ no product bugs" : `✗ ${bugs} PRODUCT BUG(S)`}`);
} catch (e) { report.fatal = e.message; console.error("\nFATAL:", e.message); }
finally {
  try { if (s) await s.close(); } catch {}
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch {}
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
  if (report.findings.some((f) => f.sev === "PRODUCT BUG") || report.fatal) process.exitCode = 3;
}
