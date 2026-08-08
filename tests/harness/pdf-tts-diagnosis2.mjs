// PDF READ-ALOUD — DIAGNOSIS ROUND 2: attack the round-1 results before believing them.
//
// Round 1 found PDF read-aloud PLAYING (readyState 4, blob, paused=false) and found the text-layer spans
// SURVIVING a zoom (same node object). The second result contradicts the handoff, which states pdf.js
// rebuilds the text layer on every zoom re-render. Exactly one of them is wrong, and a span survival
// measured while the zoom silently did nothing would be worthless.
//
// So this round proves the ZOOM ACTUALLY RE-RENDERED before it reports anything about span identity —
// by measuring the rendered page bitmap, not by trusting that setting an attribute did something.
// It also drives sustained playback on a TEXT-RICH page, because round 1's page carried a single unit
// and "index never advanced past 0" is unfalsifiable with a total of 1.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-diagnosis2-result.json";

const P_PROBE = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  let stats = null;
  try { stats = window.__sardTtsStats ? window.__sardTtsStats() : null; } catch (e) { stats = { err: String(e).slice(0,120) }; }
  return { t: Date.now(),
    store: st ? { status: st.status, index: st.index, total: st.total, wordIndex: st.wordIndex,
      underruns: st.underruns, abandoned: st.abandoned, retryAttempt: st.retryAttempt,
      lastFailure: st.lastFailure ? String(st.lastFailure).slice(0,200) : null,
      error: st.error ? String(st.error).slice(0,200) : null } : null,
    media: stats?.media ?? null, blobs: stats?.blobs ?? null, playRejections: stats?.playRejections ?? null };
})()`;

// The page geometry, as actually rendered. This is what proves a zoom did something.
const P_GEOM = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  if (!d) return null;
  const img = d.querySelector('#canvas img') || d.querySelector('#canvas canvas') || d.querySelector('img,canvas');
  const layer = d.querySelector('.textLayer');
  const b = img ? img.getBoundingClientRect() : null;
  return {
    zoomAttr: v.getAttribute('zoom'),
    imgTag: img ? img.tagName : null,
    naturalWidth: img && img.naturalWidth ? img.naturalWidth : null,
    boxW: b ? Math.round(b.width) : null, boxH: b ? Math.round(b.height) : null,
    layerW: layer ? Math.round(layer.getBoundingClientRect().width) : null,
    spans: layer ? [...layer.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length : null,
    scrollH: d.documentElement ? d.documentElement.scrollHeight : null,
  };
})()`;

const CLICK_LISTEN = `(() => {
  const btns = [...document.querySelectorAll('.rc-btn')];
  const b = btns.find(x => /listen|استماع|قراءة/i.test((x.getAttribute('title') || '')));
  if (b) { b.click(); return { ok: true, title: b.getAttribute('title') }; }
  return { ok: false, titles: btns.map(x => x.getAttribute('title')).filter(Boolean).slice(0,14) };
})()`;

const report = { startedAt: new Date().toISOString(), stages: {}, verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "pdf-tts-diag2");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
async function watch(sess, ms, everyMs, pred) {
  const samples = []; const deadline = Date.now() + ms; let hit = false;
  while (Date.now() < deadline) {
    const p = await sess.evaluate(P_PROBE); samples.push(p);
    if (pred && pred(p)) { hit = true; break; }
    await sleep(everyMs);
  }
  return { hit, samples };
}

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9942, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160)));
    window.addEventListener('unhandledrejection',e=>window.__err.push('REJECT: '+String(e.reason).slice(0,160))); return true; })()`);

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,200)}))`);
  const edge = await inv("tts_edge_voices");
  report.stages.edgeVoices = Array.isArray(edge?.ok) ? edge.ok.length : String(edge?.__err).slice(0, 120);
  console.log(`\nedge voices: ${report.stages.edgeVoices}`);

  // open رسالة الغفران and walk to a TEXT-RICH page (round 1: page 3 carried 47 spans)
  await s.evaluate(`(() => { const b=document.querySelector('.rc-back'); if(b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(500);
  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("رسالة الغفران not found");
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(3500);

  let rich = null;
  for (let p = 0; p < 8; p++) {
    const r = JSON.parse(await s.evaluate(`(async () => { try { const r = await window.__sardPdfTts('ar');
      const g = ${P_GEOM}; return JSON.stringify({ units: r?.units ?? 0, withRange: r?.withRange ?? 0, spans: g?.spans ?? 0 }); }
      catch (e) { return JSON.stringify({ err: String(e).slice(0,120) }); } })()`));
    console.log(`  page ${p}: units=${r.units} spans=${r.spans}`);
    if (r.units >= 2) { rich = { page: p, ...r }; break; }
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }
  report.stages.richPage = rich;
  console.log(`  text-rich page: ${JSON.stringify(rich)}`);

  // ============ STAGE A — ZOOM: prove the re-render happened, THEN judge span identity ============
  console.log("\n=== STAGE A · zoom re-render + span identity");
  const a = {};
  a.before = JSON.parse(await s.evaluate(`JSON.stringify(${P_GEOM})`));
  // Tag EVERY span with an index and a marker class, so identity is checked on all of them, not one.
  a.tagged = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(d?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    window.__probeSpans = sp; sp.forEach((x,i)=>{ x.setAttribute('data-probe', String(i)); x.classList.add('__probe_mark'); });
    return sp.length; })()`);
  await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view'); v.setAttribute('zoom','3'); return true; })()`);
  await sleep(4000);
  a.after = JSON.parse(await s.evaluate(`JSON.stringify(${P_GEOM})`));
  a.identity = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(d?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    const survivors = sp.filter(x=>x.hasAttribute('data-probe')).length;
    const oldStillConnected = (window.__probeSpans||[]).filter(x=>x.isConnected).length;
    const marksSurvived = sp.filter(x=>x.classList.contains('__probe_mark')).length;
    return JSON.stringify({ nowSpans: sp.length, survivorsWithProbeAttr: survivors,
      oldNodesStillConnected: oldStillConnected, oldCount: (window.__probeSpans||[]).length, marksSurvived }); })()`));
  // The honest question: did the bitmap actually change size?
  a.reRendered = !!(a.before && a.after && (a.after.boxW !== a.before.boxW || a.after.naturalWidth !== a.before.naturalWidth));
  console.log(`  box ${a.before?.boxW}x${a.before?.boxH} -> ${a.after?.boxW}x${a.after?.boxH} · natural ${a.before?.naturalWidth} -> ${a.after?.naturalWidth}`);
  console.log(`  RE-RENDER ACTUALLY HAPPENED: ${a.reRendered}`);
  console.log(`  identity: ${JSON.stringify(a.identity)}`);
  report.stages.a_zoom = a;
  report.verdicts.zoomReRendered = a.reRendered;
  report.verdicts.spansSurviveZoom = a.reRendered && a.identity.survivorsWithProbeAttr === a.identity.nowSpans && a.identity.nowSpans > 0;

  // restore zoom, then clean the probe attributes off (leave no trace in the page)
  await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view'); v.setAttribute('zoom','fit-page'); return true; })()`);
  await sleep(2500);
  await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    [...(d?.querySelectorAll('[data-probe]')||[])].forEach(x=>{ x.removeAttribute('data-probe'); x.classList.remove('__probe_mark'); });
    window.__probeSpans=null; return true; })()`);

  // ============ STAGE B — SUSTAINED PLAYBACK on a multi-unit page =================================
  console.log("\n=== STAGE B · sustained playback (multi-unit page)");
  const b = {};
  b.unitsNow = JSON.parse(await s.evaluate(`(async()=>{ const r=await window.__sardPdfTts('ar'); return JSON.stringify({units:r?.units??0,withRange:r?.withRange??0,verdict:r?.verdict??null}); })()`));
  b.click = await s.evaluate(CLICK_LISTEN);
  console.log(`  units=${b.unitsNow.units} withRange=${b.unitsNow.withRange} · click=${JSON.stringify(b.click).slice(0,120)}`);
  if (b.click.ok) {
    // 75 s, watching for the sentence index to ADVANCE beyond the first unit.
    b.watch = await watch(s, 75_000, 900, (p) => (p.store?.index ?? 0) >= 2);
    const last = b.watch.samples.at(-1);
    b.final = last?.store; b.finalMedia = last?.media; b.finalBlobs = last?.blobs;
    b.maxIndex = Math.max(0, ...b.watch.samples.map((p) => p.store?.index ?? 0));
    b.everPlaying = b.watch.samples.some((p) => p.media && p.media.paused === false);
    b.maxReadyState = Math.max(0, ...b.watch.samples.map((p) => p.media?.readyState ?? 0));
    b.distinctBlobs = Math.max(0, ...b.watch.samples.map((p) => p.blobs?.created ?? 0));
    b.timeline = b.watch.samples.map((p) => `${((p.t - b.watch.samples[0].t)/1000).toFixed(1)}:${p.store?.status}/i${p.store?.index}/u${p.store?.underruns}/a${p.store?.abandoned}`);
    console.log(`  maxIndex=${b.maxIndex}/${b.final?.total} everPlaying=${b.everPlaying} readyState=${b.maxReadyState} blobsCreated=${b.distinctBlobs}`);
    console.log(`  underruns=${b.final?.underruns} abandoned=${b.final?.abandoned} lastFailure=${b.final?.lastFailure ?? "none"}`);
    console.log(`  timeline: ${b.timeline.slice(0, 24).join(" ")}`);
  }
  report.stages.b_playback = b;
  report.verdicts.pdfSustainedPlayback = !!b.everPlaying && b.maxIndex >= 1;

  // ============ STAGE C — RANGE USABILITY for highlighting =======================================
  console.log("\n=== STAGE C · range → span resolution");
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
  await sleep(900);
  const c = JSON.parse(await s.evaluate(`(async () => { try {
    const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc;
    // Rebuild units through the REAL controller and inspect what each range actually selects.
    const r = await window.__sardPdfTts('ar');
    // We cannot reach the controller's Range objects from here, so reproduce the resolution question:
    // for each text-layer span, can a Range be built and can spans be recovered from it?
    const spans = [...(d?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    let rangeOk = false, recovered = 0, rangeErr = null;
    try {
      if (spans.length >= 2) {
        const rg = d.createRange(); rg.setStartBefore(spans[0]); rg.setEndAfter(spans[Math.min(2, spans.length-1)]);
        rangeOk = true;
        const frag = rg.cloneContents();
        recovered = frag.querySelectorAll('span').length;
        // Does the range expose client rects we could draw from, if we ever wanted to?
        var rects = rg.getClientRects ? rg.getClientRects().length : 0;
      }
    } catch (e) { rangeErr = String(e).slice(0,140); }
    return JSON.stringify({ units: r?.units ?? 0, withRange: r?.withRange ?? 0, spanCount: spans.length,
      rangeOk, spansRecoverableFromRange: recovered, rangeClientRects: typeof rects === 'number' ? rects : null,
      rangeErr, cssHighlightApi: typeof CSS !== 'undefined' && !!CSS.highlights });
  } catch (e) { return JSON.stringify({ err: String(e).slice(0,160) }); } })()`));
  console.log(`  ${JSON.stringify(c)}`);
  report.stages.c_ranges = c;

  // ============ STAGE D — PAGE CHANGE while a mark is applied ====================================
  console.log("\n=== STAGE D · page change and mark lifetime");
  const d = {};
  d.marked = await s.evaluate(`(() => { const doc=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(doc?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    if (!sp.length) return 0; sp[0].classList.add('__probe_mark'); window.__markedDoc = doc; return sp.length; })()`);
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
  await sleep(2800);
  d.after = JSON.parse(await s.evaluate(`(() => { const doc=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(doc?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    return JSON.stringify({ sameDoc: doc === window.__markedDoc, spans: sp.length,
      marksOnNewPage: sp.filter(x=>x.classList.contains('__probe_mark')).length,
      oldDocStillAlive: !!(window.__markedDoc && window.__markedDoc.querySelector('.textLayer')) }); })()`));
  console.log(`  ${JSON.stringify(d.after)}`);
  report.stages.d_pageChange = d;

  report.stages.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,12))`));
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
}
