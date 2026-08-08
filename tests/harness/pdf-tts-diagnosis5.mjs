// PDF READ-ALOUD — DIAGNOSIS ROUND 5: the race gate.
//
// Round 4 is a SINGLE pass through the zoom ladder. The defect this round exists to catch was
// INTERMITTENT — the `zoom 2` step measured 86 spans on one run and 58 on the next — so one clean pass
// is not evidence that a race is gone. This drives the full cycle (fit -> 2 -> 3 -> 4 -> fit) repeatedly
// and fails if ANY sample in ANY cycle deviates from the baseline span/unit count.
//
// It then does the thing the whole investigation is about: presses `استماع` AFTER the zoom cycling and
// proves the page is spoken ONCE — units at baseline, and real playback through `__sardTtsStats()`.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-diagnosis5-result.json";
const CYCLES = Number((process.argv.find((a) => a.startsWith("--cycles=")) ?? "--cycles=4").split("=")[1]);

const P_LAYERS = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const r = v?.renderer; const d = r?.getContents?.()?.[0]?.doc;
  if (!d) return null;
  const layers = [...d.querySelectorAll('.textLayer')];
  const cnt = (el) => el ? [...el.querySelectorAll('span')].filter(x=>!x.classList.contains('endOfContent')).length : 0;
  const first = layers[0] || null;
  const txt = first ? (first.textContent||'').replace(/\\s+/g,' ').trim() : '';
  const img = d.querySelector('#canvas img') || d.querySelector('img');
  return { zoom: r ? r.getAttribute('zoom') : null, layerCount: layers.length,
    spansFirst: cnt(first), spansAll: layers.reduce((a,l)=>a+cnt(l),0), chars: txt.length,
    naturalWidth: img && img.naturalWidth ? img.naturalWidth : null,
    headRepeats: (() => { const h = txt.slice(0,24); if (h.length < 8) return null;
      let n=0,i=0; while ((i = txt.indexOf(h,i)) !== -1) { n++; i += h.length; } return n; })() };
})()`;

const U = `(async()=>{ try { const r=await window.__sardPdfTts('ar');
  return JSON.stringify({ units:r?.units??0, withRange:r?.withRange??0, chars:(r?.text||'').length }); }
  catch(e){ return JSON.stringify({err:String(e).slice(0,120)}); } })()`;

const P_PROBE = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  let s = null; try { s = window.__sardTtsStats ? window.__sardTtsStats() : null; } catch(e) { s = null; }
  return { t: Date.now(),
    store: st ? { status: st.status, index: st.index, total: st.total, underruns: st.underruns,
      abandoned: st.abandoned, retryAttempt: st.retryAttempt,
      lastFailure: st.lastFailure ? String(st.lastFailure).slice(0,180) : null,
      error: st.error ? String(st.error).slice(0,180) : null } : null,
    media: s?.media ?? null, blobs: s?.blobs ?? null };
})()`;

const report = { startedAt: new Date().toISOString(), cycles: CYCLES, samples: [], violations: [], verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "pdf-tts-diag5");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9945, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160)));
    window.addEventListener('unhandledrejection',e=>window.__err.push('REJECT: '+String(e.reason).slice(0,160))); return true; })()`);

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

  const sample = async (label) => {
    const l = JSON.parse(await s.evaluate(`JSON.stringify(${P_LAYERS})`));
    const u = JSON.parse(await s.evaluate(U));
    const row = { label, ...l, units: u.units, withRange: u.withRange };
    report.samples.push(row);
    return row;
  };
  const setZoom = async (z, waitMs) => {
    await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(String(z))}); return !!r; })()`);
    await sleep(waitMs);
  };

  const base = await sample("baseline");
  console.log(`\nbaseline: spans=${base.spansFirst} units=${base.units} chars=${base.chars} headRepeats=${base.headRepeats}`);
  const EXP_SPANS = base.spansFirst, EXP_UNITS = base.units;

  console.log(`\n=== ${CYCLES} cycles of  fit-page -> 2 -> 3 -> 4 -> fit-page`);
  for (let c = 1; c <= CYCLES; c++) {
    const row = [];
    // Deliberately VARY the settle time: a race that only shows at one timing is not fixed.
    for (const [z, w] of [[2, 4500], [3, 2500], [4, 4500], ["fit-page", 2500]]) {
      await setZoom(z, w);
      const r = await sample(`cycle${c}:${z}`);
      row.push(`${z}=${r.spansFirst}/${r.units}`);
      if (r.spansFirst !== EXP_SPANS || r.units !== EXP_UNITS || r.headRepeats !== 1 || r.layerCount !== 1) {
        report.violations.push(`cycle ${c} @ zoom ${z}: spans=${r.spansFirst} (want ${EXP_SPANS}) `
          + `units=${r.units} (want ${EXP_UNITS}) headRepeats=${r.headRepeats} layers=${r.layerCount}`);
      }
    }
    console.log(`  cycle ${c}: ${row.join("  ")}`);
  }

  // A deliberately HOSTILE burst: four zoom changes with no settle time at all, which is the
  // condition a real user creates with a ctrl+wheel gesture. This is where overlap is guaranteed.
  console.log("\n=== hostile burst (no settle between changes)");
  for (const z of [2, 3, 4, "fit-page"]) {
    await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(String(z))}); return true; })()`);
    await sleep(120);
  }
  await sleep(7000);
  const burst = await sample("after-burst");
  console.log(`  after burst: spans=${burst.spansFirst} units=${burst.units} headRepeats=${burst.headRepeats} layers=${burst.layerCount}`);
  if (burst.spansFirst !== EXP_SPANS || burst.units !== EXP_UNITS || burst.headRepeats !== 1) {
    report.violations.push(`hostile burst: spans=${burst.spansFirst} units=${burst.units} headRepeats=${burst.headRepeats}`);
  }

  // ---- the point of all of it: is the page spoken ONCE after the zoom cycling? ----
  console.log("\n=== read-aloud after zoom cycling");
  const click = await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) { b.click(); return {ok:true}; }
    return { ok:false }; })()`);
  const play = { click, samples: [] };
  if (click.ok) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const p = await s.evaluate(P_PROBE);
      play.samples.push(p);
      if ((p.store?.index ?? 0) >= 1 && p.media?.readyState >= 2) break;
      await sleep(900);
    }
    const last = play.samples.at(-1);
    play.final = last?.store; play.finalMedia = last?.media;
    play.everPlaying = play.samples.some((p) => p.media && p.media.paused === false);
    play.maxReadyState = Math.max(0, ...play.samples.map((p) => p.media?.readyState ?? 0));
    play.maxIndex = Math.max(0, ...play.samples.map((p) => p.store?.index ?? 0));
    console.log(`  total units=${play.final?.total} (want ${EXP_UNITS}) · status=${play.final?.status} `
      + `· readyState=${play.maxReadyState} · everPlaying=${play.everPlaying} · index reached ${play.maxIndex}`);
    console.log(`  underruns=${play.final?.underruns} abandoned=${play.final?.abandoned} lastFailure=${play.final?.lastFailure ?? "none"}`);
    if (play.final?.total !== EXP_UNITS) report.violations.push(`player total=${play.final?.total}, want ${EXP_UNITS} — the page would be spoken more than once`);
    if (!play.everPlaying) report.violations.push("never reached actual playback");
    if (play.maxReadyState < 4) report.violations.push(`readyState only reached ${play.maxReadyState}`);
    if ((play.final?.underruns ?? 0) !== 0) report.violations.push(`underruns=${play.final?.underruns}`);
    if ((play.final?.abandoned ?? 0) !== 0) report.violations.push(`abandoned=${play.final?.abandoned}`);
    if (play.final?.lastFailure) report.violations.push(`lastFailure=${play.final.lastFailure}`);
    await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
  } else report.violations.push("read-aloud button not found");
  report.playback = play;

  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,12))`));
  report.verdicts.raceFixed = report.violations.length === 0;
  console.log(`\nviolations: ${report.violations.length}`);
  for (const v of report.violations) console.log(`  ✗ ${v}`);
  if (!report.violations.length) console.log(`  ✓ ${CYCLES} cycles + hostile burst + playback — all clean`);
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
