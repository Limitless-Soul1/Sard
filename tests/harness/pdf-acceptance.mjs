// PDF ACCEPTANCE — the interactions themselves, not the settings behind them.
//
// Page identity is tracked by lastLocation.fraction before and after EVERY wheel notch, so a premature
// page turn is caught at the notch that caused it rather than inferred at the end. Audio cannot be
// heard from automation: playback is reported by pipeline state, and anything that needs ears is
// marked UNVERIFIED rather than passed.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = snapshotDb("M:\\eRawy", "pdf-acceptance");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }
let s;
const R = {};
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9934, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140))); return true; })()`);

  const open = async (tok) => {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
    await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')].find(c => (c.textContent||'').includes(${JSON.stringify(tok)}));
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    await sleep(8000);
  };
  const ST = `(() => { const v = document.querySelector('.page-host foliate-view'); const r = v.renderer;
    return JSON.stringify({ frac: v.lastLocation?.fraction ?? null, top: Math.round(r.scrollTop),
      max: Math.round(r.scrollHeight - r.clientHeight), zoom: r.getAttribute('zoom') }); })()`;
  const wheel = async (dy) => {
    await s.evaluate(`(() => { document.querySelector('.reader-desk')
      .dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(200);
  };
  const setZoom = async (z) => {
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view').renderer.setAttribute('zoom','${z}'); return true; })()`);
    await sleep(3000);
  };

  // ---- 1. zoom + scroll, both directions, both books --------------------------------------
  R.scroll = {};
  for (const book of [{ n: "mixed (Noor-Book)", t: "Noor-Book" }, { n: "scan (697)", t: "S697" }]) {
    await open(book.t);
    for (const z of ["4", "6"]) {
      await setZoom(z);
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view').renderer.scrollTop = 0; return true; })()`);
      await sleep(400);
      const start = JSON.parse(await s.evaluate(ST));
      let premature = 0, notches = 0, reachedBottom = false;
      for (let i = 0; i < 60; i++) {
        const b = JSON.parse(await s.evaluate(ST));
        const atBottom = b.top >= b.max - 1;
        await wheel(220); notches++;
        const a = JSON.parse(await s.evaluate(ST));
        if (a.frac !== b.frac && !atBottom) premature++;         // turned while content remained
        if (a.top >= a.max - 1 && a.frac === start.frac) { reachedBottom = true; break; }
        if (a.frac !== b.frac) break;                            // legitimately turned at the bottom
      }
      // reverse: back up to the very top of the same page
      let revPremature = 0, reachedTop = false;
      const midFrac = JSON.parse(await s.evaluate(ST)).frac;
      for (let i = 0; i < 60; i++) {
        const b = JSON.parse(await s.evaluate(ST));
        const atTop = b.top <= 1;
        await wheel(-220);
        const a = JSON.parse(await s.evaluate(ST));
        if (a.frac !== b.frac && !atTop) revPremature++;
        if (a.top <= 1 && a.frac === midFrac) { reachedTop = true; break; }
        if (a.frac !== b.frac) break;
      }
      // after the extent is exhausted, one more notch must still turn the page
      await s.evaluate(`(() => { const r = document.querySelector('.page-host foliate-view').renderer;
        r.scrollTop = r.scrollHeight - r.clientHeight; return true; })()`);
      await sleep(400);
      const beforeTurn = JSON.parse(await s.evaluate(ST));
      await wheel(220); await sleep(900);
      const afterTurn = JSON.parse(await s.evaluate(ST));
      const key = `${book.n} @ ${z}00%`;
      R.scroll[key] = { extent: start.max, notches, premature, reachedBottom, revPremature, reachedTop,
        turnsWhenExhausted: afterTurn.frac !== beforeTurn.frac };
      console.log(`${key}: extent ${start.max}px · ${notches} notches · premature ${premature}`
        + ` · bottom ${reachedBottom} · rev-premature ${revPremature} · top ${reachedTop}`
        + ` · turns when exhausted ${R.scroll[key].turnsWhenExhausted}`);
    }
  }

  // ---- 2. themes while zoomed to 400% ------------------------------------------------------
  await open("Noor-Book");
  await setZoom("4");
  const geo0 = JSON.parse(await s.evaluate(ST));
  const PAGE = `(() => { const v = document.querySelector('.page-host foliate-view');
    const d = v.renderer.getContents?.()?.[0]?.doc; const im = d?.querySelector('img');
    const cv = d?.querySelector('#canvas');
    const ir = im?.getBoundingClientRect();
    return JSON.stringify({ box: ir ? [Math.round(ir.width), Math.round(ir.height)] : null,
      ar: ir && ir.height ? +(ir.width/ir.height).toFixed(3) : null,
      filter: im ? d.defaultView.getComputedStyle(im).filter : null,
      tint: cv ? d.defaultView.getComputedStyle(cv, '::after').backgroundColor : null,
      desk: getComputedStyle(document.querySelector('.reader-desk')).backgroundColor }); })()`;
  await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => /PDF/i.test(x.getAttribute('title')||'')); if (b) b.click(); return !!b; })()`);
  await sleep(700);
  R.themes = {};
  const seen = new Set();
  for (const id of ["normal", "sepia", "warm", "cream", "green", "grey", "night", "ink"]) {
    await s.evaluate(`(() => { const b = document.querySelector('.pdf-chip-${id}'); if (b) b.click(); return !!b; })()`);
    await sleep(900);
    const p = JSON.parse(await s.evaluate(PAGE));
    const g = JSON.parse(await s.evaluate(ST));
    const sig = `${p.filter}|${p.tint}`;
    R.themes[id] = { ...p, extent: g.max, distinct: !seen.has(sig) };
    seen.add(sig);
    console.log(`  theme ${id.padEnd(7)} box ${JSON.stringify(p.box)} AR ${p.ar} extent ${g.max}`
      + ` desk ${p.desk} filter ${String(p.filter).slice(0, 26)} tint ${p.tint}`);
  }
  R.themeGeometryStable = Object.values(R.themes).every((t) => t.ar === R.themes.normal.ar && t.extent === R.themes.normal.extent);
  R.surroundStable = new Set(Object.values(R.themes).map((t) => t.desk)).size === 1;
  R.themesDistinct = Object.values(R.themes).filter((t) => t.distinct).length;
  // still scrollable and coherent after switching
  await wheel(220); await sleep(400);
  R.scrollAfterTheme = JSON.parse(await s.evaluate(ST));

  // ---- 3. TTS on the text PDF ---------------------------------------------------------------
  await open("33102");
  for (let i = 0; i < 3; i++) { await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`); await sleep(1800); }
  R.tts = { units: await s.evaluate(`(async () => { const r = await window.__sardPdfTts('ar'); return r ? r.units : -1; })()`),
    withRange: await s.evaluate(`(async () => { const r = await window.__sardPdfTts('ar'); return r ? r.withRange : -1; })()`) };
  const btn = `[...document.querySelectorAll('.rc-btn')].find(x => /استماع|listen/i.test(x.getAttribute('title')||''))`;
  R.tts.buttonPresent = await s.evaluate(`!!(${btn})`);
  if (R.tts.buttonPresent) {
    await s.evaluate(`(() => { const b = ${btn}; if (b) b.click(); return !!b; })()`);
    await sleep(9000);
    R.tts.afterPress = JSON.parse(await s.evaluate(`(() => JSON.stringify({
      rootPlaying: document.querySelector('.reader-root')?.className.includes('tts-playing') ?? false,
      player: !!document.querySelector('.tts-player, .tts-pill'),
      playerText: (document.querySelector('.tts-player, .tts-pill')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,70),
      highlightNodes: (() => { const v = document.querySelector('.page-host foliate-view');
        const d = v?.renderer?.getContents?.()?.[0]?.doc;
        return d ? d.querySelectorAll('.sard-reading, .sard-word, [class*=reading]').length : -1; })(),
    }))()`));
    await sleep(6000);
    R.tts.later = JSON.parse(await s.evaluate(`(() => JSON.stringify({
      rootPlaying: document.querySelector('.reader-root')?.className.includes('tts-playing') ?? false,
      frac: document.querySelector('.page-host foliate-view')?.lastLocation?.fraction ?? null }))()`));
  }
  console.log(`\nTTS: units ${R.tts.units} (ranges ${R.tts.withRange}) button ${R.tts.buttonPresent}`);
  console.log(`  after press: ${JSON.stringify(R.tts.afterPress)}`);
  console.log(`  later:       ${JSON.stringify(R.tts.later)}`);
  // the scan must explain itself rather than offer a dead control
  await open("S697");
  await sleep(2000);
  R.tts.buttonOnScan = await s.evaluate(`!!(${btn})`);
  R.tts.scanNotice = await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => /PDF/i.test(x.getAttribute('title')||'')); if (b) b.click(); return true; })()`)
    .then(() => sleep(700)).then(() => s.evaluate(`(document.querySelector('.sp-pdf-tts')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,120)`));
  console.log(`  scan: button ${R.tts.buttonOnScan} · notice "${R.tts.scanNotice}"`);
  R.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,6))`));
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-acceptance-result.json", JSON.stringify(R, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
