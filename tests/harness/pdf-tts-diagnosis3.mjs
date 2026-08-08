// PDF READ-ALOUD — DIAGNOSIS ROUND 3: the zoom question, done on the RIGHT element.
//
// Round 2's zoom stage was an INSTRUMENT DEFECT and is void: it set the `zoom` attribute on
// <foliate-view>, but `FoliateController.setPdfZoom` sets it on `view.renderer` (FoliateController.ts:3549).
// Nothing re-rendered, so "the spans survived" measured nothing at all. This round sets the attribute
// where the product sets it, PROVES the bitmap changed size before drawing any conclusion, and only then
// asks whether the text-layer span nodes and any marks applied to them survive.
//
// It also profiles per-unit text length, because round 2 measured 18 s to first audio on a cold socket
// against 7 s for EPUB, and synthesis time is known to track sentence length (~0.37-0.45x audio duration,
// RAWY-265). Attributing that gap to "PDF" without the lengths would be a guess.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-diagnosis3-result.json";

// Geometry read from the rendered page. `renderer` is where the zoom attribute lives.
const P_GEOM = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const r = v?.renderer;
  const d = r?.getContents?.()?.[0]?.doc;
  if (!d) return null;
  const img = d.querySelector('#canvas img') || d.querySelector('img') || d.querySelector('canvas');
  const layer = d.querySelector('.textLayer');
  const b = img ? img.getBoundingClientRect() : null;
  const lb = layer ? layer.getBoundingClientRect() : null;
  return {
    zoomOnRenderer: r ? r.getAttribute('zoom') : null,
    zoomOnView: v ? v.getAttribute('zoom') : null,
    imgTag: img ? img.tagName : null,
    naturalWidth: img && img.naturalWidth ? img.naturalWidth : null,
    boxW: b ? Math.round(b.width) : null, boxH: b ? Math.round(b.height) : null,
    layerW: lb ? Math.round(lb.width) : null, layerH: lb ? Math.round(lb.height) : null,
    spans: layer ? [...layer.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length : null,
    scrollH: d.documentElement ? d.documentElement.scrollHeight : null,
  };
})()`;

const report = { startedAt: new Date().toISOString(), stages: {}, verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "pdf-tts-diag3");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9943, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // open رسالة الغفران, walk to the 5-unit page
  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("رسالة الغفران not found");
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(3500);
  for (let p = 0; p < 8; p++) {
    const u = JSON.parse(await s.evaluate(`(async()=>{ const r=await window.__sardPdfTts('ar'); return JSON.stringify({u:r?.units??0}); })()`));
    if (u.u >= 5) { report.stages.landedOnPage = p; break; }
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }

  // ---------- unit length profile: what is actually being sent to the engine, per unit ----------
  const lens = JSON.parse(await s.evaluate(`(async () => { const r = await window.__sardPdfTts('ar');
    const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc;
    const layer = d?.querySelector('.textLayer');
    // __sardPdfTts joins unit texts; re-segment the same way only to report LENGTHS, not to re-implement.
    return JSON.stringify({ units: r?.units ?? 0, totalChars: (r?.text||'').length,
      rawLayerChars: (layer?.textContent||'').length,
      first120: (r?.text||'').slice(0,120) }); })()`));
  report.stages.unitProfile = lens;
  console.log(`\nunits=${lens.units} totalChars=${lens.totalChars} rawLayerChars=${lens.rawLayerChars}`);
  console.log(`mean chars/unit = ${lens.units ? Math.round(lens.totalChars / lens.units) : 0}`);

  // ================= ZOOM, ON THE RENDERER — the element the product uses =========================
  console.log("\n=== ZOOM (renderer element)");
  const z = {};
  z.before = JSON.parse(await s.evaluate(`JSON.stringify(${P_GEOM})`));
  console.log(`  before: zoomOnRenderer=${z.before?.zoomOnRenderer} box=${z.before?.boxW}x${z.before?.boxH} natural=${z.before?.naturalWidth} spans=${z.before?.spans}`);

  // Tag every span so identity is judged across ALL of them, and mark them so mark-survival is judged too.
  z.tagged = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(d?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    window.__probeSpans = sp; window.__probeDoc = d;
    sp.forEach((x,i)=>{ x.setAttribute('data-probe', String(i)); x.classList.add('__probe_mark'); });
    return sp.length; })()`);

  // THE REAL CALL SITE: renderer.setAttribute('zoom', …)
  await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','3'); return !!r; })()`);
  await sleep(5000);
  z.after = JSON.parse(await s.evaluate(`JSON.stringify(${P_GEOM})`));
  console.log(`  after:  zoomOnRenderer=${z.after?.zoomOnRenderer} box=${z.after?.boxW}x${z.after?.boxH} natural=${z.after?.naturalWidth} spans=${z.after?.spans}`);

  // Did the bitmap actually change? This gates every conclusion below.
  z.reRendered = !!(z.before && z.after && (z.after.boxW !== z.before.boxW || z.after.naturalWidth !== z.before.naturalWidth));
  console.log(`  RE-RENDER PROVEN: ${z.reRendered}`);

  z.identity = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp=[...(d?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    const old = window.__probeSpans || [];
    return JSON.stringify({
      sameDocObject: d === window.__probeDoc,
      nowSpans: sp.length, oldCount: old.length,
      withProbeAttr: sp.filter(x=>x.hasAttribute('data-probe')).length,
      marksSurvived: sp.filter(x=>x.classList.contains('__probe_mark')).length,
      oldNodesStillConnected: old.filter(x=>x.isConnected).length,
      firstIsSameObject: !!(old[0] && sp[0] === old[0]),
    }); })()`));
  console.log(`  identity: ${JSON.stringify(z.identity)}`);
  report.stages.zoom = z;
  report.verdicts.zoomReRenderProven = z.reRendered;
  report.verdicts.spansSurviveRealZoom = z.reRendered ? (z.identity.withProbeAttr === z.identity.nowSpans && z.identity.nowSpans > 0) : null;
  report.verdicts.marksSurviveRealZoom = z.reRendered ? (z.identity.marksSurvived === z.identity.nowSpans && z.identity.nowSpans > 0) : null;

  // clean up the probe attributes wherever they still are
  await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    [...(d?.querySelectorAll('[data-probe]')||[])].forEach(x=>{ x.removeAttribute('data-probe'); x.classList.remove('__probe_mark'); });
    (window.__probeSpans||[]).forEach(x=>{ try{ x.removeAttribute('data-probe'); x.classList.remove('__probe_mark'); }catch(e){} });
    window.__probeSpans=null; window.__probeDoc=null;
    const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','fit-page'); return true; })()`);
  await sleep(3000);

  // ---------- do units/ranges still resolve after a real zoom? ----------
  const afterZoomUnits = JSON.parse(await s.evaluate(`(async()=>{ try { const r=await window.__sardPdfTts('ar');
    return JSON.stringify({ units:r?.units??0, withRange:r?.withRange??0 }); } catch(e){ return JSON.stringify({err:String(e).slice(0,120)}); } })()`));
  report.stages.unitsAfterZoom = afterZoomUnits;
  console.log(`  units after zoom round-trip: ${JSON.stringify(afterZoomUnits)}`);
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
