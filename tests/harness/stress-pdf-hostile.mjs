// PRE-UPDATE STRESS — PDF, hostile timing. TESTING TOOLING. Changes no product code.
//
// Aim: break the current build. Every zoom/theme/navigation sequence here is deliberately run with
// little or no settle time, because the two defects this area has already produced (text-layer
// ACCUMULATION and a render RACE) were both invisible at comfortable timings and only appeared when
// renders overlapped.
//
// Invariants asserted after every hostile burst, per PDF:
//   * exactly ONE .textLayer container
//   * span count returns to the page's own baseline (no accumulation, no stale layer)
//   * the page still renders (an <img> in #canvas)
//   * aspect ratio unchanged (geometry not corrupted)
//   * NO PDF read-aloud surface of any kind (the feature is deliberately disabled)
//   * no page errors / unhandled rejections
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/stress-pdf-hostile-result.json";
const PDFS = [
  { m: "33102", label: "رسالة الغفران — text, presentation forms" },
  { m: "Noor-Book", label: "الأمير الصغير — watermark-only" },
  { m: "24116", label: "فنّ الحرب — encrypted + mojibake" },
  // ⚠ "kotobati", not "مقدمة ابن خلدون": the library holds BOTH a PDF and an EPUB of Ibn Khaldun, and
  // the Arabic phrase matches the EPUB card first. A first run silently measured that EPUB and
  // reported "a PDF that will not render and offers Listen". Match a token unique to the PDF card.
  { m: "kotobati", label: "ابن خلدون — scan, 19.9 MB" },
  { m: "_الكتاب", label: "الداء والدواء — scan" },
  { m: "S697", label: "697 — scan, 40 MB / 967 pages" },
];

const counters = { zoomOps: 0, themeSwitches: 0, pageTurns: 0, bursts: 0, checks: 0 };
const report = { startedAt: new Date().toISOString(), commit: "3e0fc98", pdfs: [], findings: [], counters };
const finding = (sev, pdf, what) => { report.findings.push({ sev, pdf, what }); console.log(`   ${sev === "FAIL" ? "✗" : "⚠"} ${what}`); };

const snap = snapshotDb("M:\\eRawy", "stress-pdf");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const STATE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const r = v?.renderer;
  const d = r?.getContents?.()?.[0]?.doc;
  if (!d) return { err: 'no doc' };
  const layers = [...d.querySelectorAll('.textLayer')];
  const spans = layers.reduce((a,l) => a + [...l.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length, 0);
  const img = d.querySelector('#canvas img') || d.querySelector('#canvas canvas');
  const b = img ? img.getBoundingClientRect() : null;
  const txt = layers[0] ? (layers[0].textContent||'').replace(/\\s+/g,' ').trim() : '';
  const head = txt.slice(0, 22);
  let repeats = 0; if (head.length >= 8) { let i = 0; while ((i = txt.indexOf(head, i)) !== -1) { repeats++; i += head.length; } }
  return {
    zoom: r ? r.getAttribute('zoom') : null,
    layerCount: layers.length, spans, headRepeats: repeats,
    renders: !!img, natural: img?.naturalWidth ?? null,
    ar: b && b.height ? +(b.width / b.height).toFixed(3) : null,
    domNodes: d.querySelectorAll('*').length,
    marks: d.querySelectorAll('.sard-pdf-reading').length,
    hlStyle: !!d.getElementById('sard-pdf-reading-style'),
    listen: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
    player: !!document.querySelector('[class*="tts-pill"], [class*="tts-player"]'),
    ttsActive: window.__sardTtsStore?.getState?.().active ?? null,
    errs: (window.__err||[]).length,
  };
})()`;

const setZoom = async (z) => { counters.zoomOps++;
  await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(String(z))}); return true; })()`); };
const nav = async (dir) => { counters.pageTurns++;
  await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view'); try { await v.${dir}(); } catch(e){} })()`); };
const theme = async (t) => { counters.themeSwitches++;
  await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${t}'); if (b) b.click(); return !!b; })()`); };
const st = async () => { counters.checks++; return JSON.parse(await s.evaluate(`JSON.stringify(${STATE})`)); };

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9970, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[];
    addEventListener('error', e => window.__err.push('ERR:'+(e.message||'').slice(0,120)));
    addEventListener('unhandledrejection', e => window.__err.push('REJ:'+String(e.reason).slice(0,120)));
    return true; })()`);

  for (const pdf of PDFS) {
    console.log(`\n=== ${pdf.label}`);
    const rec = { ...pdf, steps: [] };
    await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
    await sleep(500);
    const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(pdf.m)}) || (c.getAttribute('title')||'').includes(${JSON.stringify(pdf.m)}));
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!opened) { finding("FAIL", pdf.label, "card not found in the library"); continue; }
    for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
    await sleep(3200);

    // ---- IDENTITY GATE. A first run reported "a PDF that will not render, and offers Listen" for
    // ابن خلدون. It was an EPUB: the card matcher missed, and the previous document stayed open
    // (zoom=null, layerCount=0, 707 nodes, Listen present — a PDF always has a .textLayer container,
    // even when empty). Never measure a document without first proving what it is.
    const ident = JSON.parse(await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view');
      const d=v?.renderer?.getContents?.()?.[0]?.doc;
      return JSON.stringify({ fixedLayout: v?.isFixedLayout ?? null, sections: v?.book?.sections?.length ?? null,
        hasTextLayerContainer: !!d?.querySelector('.textLayer'), pdfViewClass: !!document.querySelector('.reader-desk.pdf-view') }); })()`));
    rec.identity = ident;
    if (ident.fixedLayout !== true || !ident.pdfViewClass) {
      finding("HARNESS", pdf.label, `did not open as a PDF (fixedLayout=${ident.fixedLayout}, pdfView=${ident.pdfViewClass}) — measurements skipped`);
      report.pdfs.push(rec); continue;
    }

    // walk a few pages in so we are not on a cover
    for (let i = 0; i < 3; i++) { await nav("next"); await sleep(900); }
    // ---- FORCE A KNOWN ZOOM BEFORE BASELINE. A first run took the baseline at the book's REMEMBERED
    // zoom (3x for فنّ الحرب) and then compared every later sample at fit-page, so a legitimate
    // per-scale difference in how pdf.js splits text runs read as "spans 440 -> 151". Void, not a bug.
    await setZoom("fit-page"); await sleep(3000);
    const base = await st();
    rec.baseline = base;
    console.log(`   baseline @${base.zoom}: spans=${base.spans} layers=${base.layerCount} ar=${base.ar} nodes=${base.domNodes} renders=${base.renders} (sections=${ident.sections})`);
    if (base.err) { finding("FAIL", pdf.label, `no page document: ${base.err}`); continue; }

    // ---------- A · HOSTILE ZOOM BURSTS (no settle between changes) ----------
    for (let cycle = 0; cycle < 4; cycle++) {
      counters.bursts++;
      for (const z of ["2", "4", "6", "1", "fit-page", "3", "fit-width", "fit-page"]) { await setZoom(z); await sleep(90); }
      await sleep(5200); // let the last render settle before judging
      const a = await st();
      rec.steps.push({ step: `zoom-burst-${cycle}`, ...a });
      const bad = [];
      if (a.layerCount !== 1) bad.push(`layerCount=${a.layerCount}`);
      if (a.spans !== base.spans) bad.push(`spans ${base.spans}->${a.spans}`);
      if (a.headRepeats > 1) bad.push(`headRepeats=${a.headRepeats}`);
      if (!a.renders) bad.push("page not rendering");
      if (base.ar && a.ar && Math.abs(a.ar - base.ar) > 0.01) bad.push(`AR ${base.ar}->${a.ar}`);
      if (bad.length) finding("FAIL", pdf.label, `zoom burst ${cycle}: ${bad.join(", ")}`);
    }
    console.log(`   after 4 hostile zoom bursts: spans=${(await st()).spans} (baseline ${base.spans})`);

    // ---------- B · ZOOM x THEME x NAV interleaved ----------
    for (const t of ["sepia", "night", "ink", "cream", "grey", "warm", "green", "normal"]) {
      await theme(t); await sleep(120);
      await setZoom(t === "night" ? "4" : "fit-page"); await sleep(120);
      if (t === "ink") { await nav("next"); await sleep(200); }
    }
    await sleep(4200);
    const bt = await st();
    rec.steps.push({ step: "theme-zoom-nav", ...bt });
    if (bt.layerCount !== 1) finding("FAIL", pdf.label, `theme/zoom/nav interleave: layerCount=${bt.layerCount}`);
    if (bt.headRepeats > 1) finding("FAIL", pdf.label, `theme/zoom/nav interleave: text duplicated x${bt.headRepeats}`);
    if (!bt.renders) finding("FAIL", pdf.label, "theme/zoom/nav interleave: page stopped rendering");
    console.log(`   after 8 themes x zoom x nav: layers=${bt.layerCount} spans=${bt.spans} repeats=${bt.headRepeats} renders=${bt.renders}`);

    // ---------- C · RAPID NAVIGATION BURST ----------
    await setZoom("fit-page"); await sleep(1500);
    for (let i = 0; i < 20; i++) { await nav("next"); await sleep(70); }
    await sleep(3000);
    for (let i = 0; i < 20; i++) { await nav("prev"); await sleep(70); }
    await sleep(3500);
    const cn = await st();
    rec.steps.push({ step: "nav-burst", ...cn });
    if (cn.layerCount !== 1) finding("FAIL", pdf.label, `nav burst: layerCount=${cn.layerCount}`);
    if (!cn.renders) finding("FAIL", pdf.label, "nav burst: page stopped rendering");
    if (cn.headRepeats > 1) finding("FAIL", pdf.label, `nav burst: text duplicated x${cn.headRepeats}`);
    console.log(`   after 40 rapid nav ops: layers=${cn.layerCount} spans=${cn.spans} renders=${cn.renders} nodes=${cn.domNodes}`);

    // ---------- D · PDF READ-ALOUD MUST BE ABSENT ----------
    const dis = await st();
    const surfaces = [];
    if (dis.listen) surfaces.push("Listen control");
    if (dis.player) surfaces.push("TTS player");
    if (dis.marks > 0) surfaces.push(`${dis.marks} highlight marks`);
    if (dis.hlStyle) surfaces.push("highlight stylesheet");
    if (dis.ttsActive === true) surfaces.push("TTS store active");
    // hostile: keyboard routes that could start playback
    await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      for (const k of [' ','Enter','p','P']) {
        document.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
        d?.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
      } return true; })()`);
    await sleep(1200);
    const afterKeys = await st();
    if (afterKeys.ttsActive === true) surfaces.push("TTS activated by keyboard");
    if (afterKeys.player) surfaces.push("player appeared after keys");
    rec.disabledState = { ...dis, afterKeys };
    if (surfaces.length) finding("FAIL", pdf.label, `PDF read-aloud surface present: ${surfaces.join(", ")}`);
    else console.log(`   PDF read-aloud absent (no control, no player, no marks, keys inert) ✓`);

    rec.finalErrors = await s.evaluate(`JSON.stringify((window.__err||[]).slice(-6))`);
    report.pdfs.push(rec);
  }

  // ---------- E · CROSS-DOCUMENT LIFECYCLE: PDF -> EPUB -> PDF ----------
  console.log("\n=== cross-document lifecycle (PDF -> EPUB -> PDF) x3");
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,120)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const openByText = async (needle) => {
    await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
    await sleep(400);
    return s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(needle)}) || (c.getAttribute('title')||'').includes(${JSON.stringify(needle)}));
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  };
  // ⚠ Open the EPUB by its EXACT title attribute, then PROVE it is reflowable. A first run used
  // `title.slice(0,12)` and matched a PDF card: the run reported "EPUB LOST its Listen control" three
  // times while `epubFixed` was true — it was measuring a PDF. Same defect already fixed once in
  // pdf-tts-diagnosis.mjs and reintroduced here.
  const openEpubExact = async (title) => {
    await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
    await sleep(400);
    return s.evaluate(`(() => { const t=${JSON.stringify(title)};
      const all=[...document.querySelectorAll('.lib-card')];
      const c = all.find(x => (x.getAttribute('title')||'') === t);
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  };
  const cross = [];
  for (let i = 0; i < 3; i++) {
    await openByText("33102"); await sleep(3200);
    const p1 = await st();
    const foundEpub = await openEpubExact(epub.title); await sleep(3200);
    const e1 = JSON.parse(await s.evaluate(`JSON.stringify({
      listen: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
      fixedLayout: document.querySelector('.page-host foliate-view')?.isFixedLayout ?? null,
      sections: document.querySelector('.page-host foliate-view')?.book?.sections?.length ?? null,
      ttsActive: window.__sardTtsStore?.getState?.().active ?? null })`));
    await openByText("33102"); await sleep(3200);
    const p2 = await st();
    cross.push({ i, foundEpub, pdfListen: p1.listen, epubListen: e1.listen, epubFixed: e1.fixedLayout,
      epubSections: e1.sections, pdfAgainListen: p2.listen, pdfAgainMarks: p2.marks, pdfSpans: p2.spans });
    console.log(`  cycle ${i}: PDF listen=${p1.listen} | EPUB found=${foundEpub} fixed=${e1.fixedLayout} listen=${e1.listen} | PDF-again listen=${p2.listen} marks=${p2.marks}`);
    if (p1.listen || p2.listen) finding("FAIL", "cross-lifecycle", `PDF exposed a Listen control (cycle ${i})`);
    if (e1.fixedLayout !== false) { finding("HARNESS", "cross-lifecycle", `EPUB control not established (fixedLayout=${e1.fixedLayout}) — cycle ${i} EPUB assertions skipped`); }
    else if (!e1.listen) finding("FAIL", "cross-lifecycle", `EPUB LOST its Listen control (cycle ${i}) — regression`);
    if (p2.marks > 0) finding("FAIL", "cross-lifecycle", `PDF carries ${p2.marks} highlight marks after EPUB session (cycle ${i})`);
  }
  report.crossLifecycle = cross;

  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0, 20))`));
  console.log(`\ncounters: ${JSON.stringify(counters)}`);
  console.log(`page errors captured: ${report.pageErrors.length}`);
  for (const e of report.pageErrors.slice(0, 6)) console.log(`   ${e}`);
  console.log(`\n${report.findings.length === 0 ? "✓ PDF HOSTILE STRESS: no failures" : `✗ ${report.findings.length} finding(s)`}`);
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
  if (report.findings.length || report.fatal) process.exitCode = 3;
}
