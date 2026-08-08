// PDF READ-ALOUD — DIAGNOSIS ROUND 4: characterise the text-layer accumulation found in round 3.
//
// Round 3 PROVED a real re-render (540x720 -> 1350x1800) and found the span count going 47 -> 141 with all
// 47 originals still connected, and the unit count going 5 -> 25. That is not a rebuild; it looks like
// ACCUMULATION. If it is, PDF read-aloud speaks duplicated text after any zoom, and every highlighting
// design that indexes spans is built on sand.
//
// The question round 3 cannot answer: `pdfPageUnits` reads `doc.querySelector('.textLayer')` — the FIRST
// layer only — while the round-3 probe counted spans across ALL of them. So "141 spans" may be several
// layers or one grown layer, and those imply different fixes. This round separates them, then tests
// whether the duplication accumulates per zoom and whether a page change clears it.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-diagnosis4-result.json";

// Separate FIRST-layer counts (what the product reads) from ALL-layer counts (what round 3 measured).
const P_LAYERS = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const r = v?.renderer;
  const d = r?.getContents?.()?.[0]?.doc;
  if (!d) return null;
  const layers = [...d.querySelectorAll('.textLayer')];
  const first = layers[0] || null;
  const cnt = (el) => el ? [...el.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length : 0;
  const img = d.querySelector('#canvas img') || d.querySelector('img') || d.querySelector('canvas');
  const firstText = first ? (first.textContent||'').replace(/\\s+/g,' ').trim() : '';
  return {
    zoom: r ? r.getAttribute('zoom') : null,
    naturalWidth: img && img.naturalWidth ? img.naturalWidth : null,
    layerCount: layers.length,
    spansFirstLayer: cnt(first),
    spansAllLayers: layers.reduce((a,l)=>a+cnt(l),0),
    firstLayerChars: firstText.length,
    firstLayerHead: firstText.slice(0, 60),
    // Does the first layer contain the same opening phrase more than once? The direct duplication test.
    headRepeats: (() => { const h = firstText.slice(0, 24); if (h.length < 8) return null;
      let n = 0, i = 0; while ((i = firstText.indexOf(h, i)) !== -1) { n++; i += h.length; } return n; })(),
    canvasImgs: d.querySelectorAll('#canvas img, #canvas canvas').length,
  };
})()`;

const U = `(async()=>{ try { const r=await window.__sardPdfTts('ar');
  return JSON.stringify({ units:r?.units??0, withRange:r?.withRange??0, chars:(r?.text||'').length,
    head:(r?.text||'').slice(0,50) }); } catch(e){ return JSON.stringify({err:String(e).slice(0,120)}); } })()`;

const report = { startedAt: new Date().toISOString(), steps: [], verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "pdf-tts-diag4");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const snapshot = async (label) => {
  const layers = JSON.parse(await s.evaluate(`JSON.stringify(${P_LAYERS})`));
  const units = JSON.parse(await s.evaluate(U));
  const row = { label, ...layers, units: units.units, withRange: units.withRange, unitChars: units.chars };
  report.steps.push(row);
  console.log(`  ${label.padEnd(22)} zoom=${String(row.zoom).padEnd(8)} layers=${row.layerCount} `
    + `spans(first/all)=${row.spansFirstLayer}/${row.spansAllLayers} chars=${row.firstLayerChars} `
    + `headRepeats=${row.headRepeats} units=${row.units} unitChars=${row.unitChars}`);
  return row;
};

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9944, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("رسالة الغفران not found");
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(3500);
  for (let p = 0; p < 8; p++) {
    const u = JSON.parse(await s.evaluate(U));
    if (u.units >= 5) break;
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }

  const setZoom = async (z, waitMs = 5000) => {
    await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(String(z))}); return !!r; })()`);
    await sleep(waitMs);
  };

  console.log("\n=== accumulation across successive zooms");
  const base = await snapshot("baseline");
  await setZoom(2); await snapshot("zoom 2");
  await setZoom(3); await snapshot("zoom 3");
  await setZoom(4); await snapshot("zoom 4");
  await setZoom("fit-page"); const back = await snapshot("back to fit-page");

  console.log("\n=== does a page change clear it?");
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
  await sleep(2800);
  const nextPage = await snapshot("next page");
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.prev(); return true; })()`);
  await sleep(2800);
  const backPage = await snapshot("back to the page");

  report.verdicts.accumulatesOnZoom = base && back ? back.spansFirstLayer > base.spansFirstLayer : null;
  report.verdicts.unitsInflated = base && back ? back.units > base.units : null;
  report.verdicts.pageChangeClears = nextPage && backPage
    ? backPage.spansFirstLayer <= base.spansFirstLayer * 1.05 : null;
  report.verdicts.duplicateTextInFirstLayer = back ? (back.headRepeats ?? 0) > 1 : null;

  console.log(`\naccumulates on zoom      : ${report.verdicts.accumulatesOnZoom}`);
  console.log(`unit count inflated      : ${report.verdicts.unitsInflated}  (${base?.units} -> ${back?.units})`);
  console.log(`duplicate text in layer  : ${report.verdicts.duplicateTextInFirstLayer} (head repeats ${back?.headRepeats})`);
  console.log(`re-opening the page fixes: ${report.verdicts.pageChangeClears}`);
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
