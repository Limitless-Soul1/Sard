// PDF SENTENCE HIGHLIGHTING — ACCEPTANCE GATE (RAWY-295).
//
// This drives the PRODUCT's own implementation. It contains NO replica of `pdfDeriveUnits` and no
// marking logic of its own: it presses the real read-aloud control, lets the real controller paint, and
// observes `.sard-pdf-reading` in the real page document. The two PoC harnesses that preceded it used a
// replica to STUDY the design; this one exists to prove the shipped code, and a replica here would only
// be able to prove that the harness agrees with itself.
//
// It is the regression gate for the whole feature. Every case below is one the investigation named.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-highlight-acceptance-result.json";
const CLS = "sard-pdf-reading";

/** Everything about the highlight, read from the REAL page document. */
const HL = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  if (!d) return { err: 'no page doc' };
  const marks = [...d.querySelectorAll('.${CLS}')];
  const first = marks[0];
  const cs = first ? d.defaultView.getComputedStyle(first) : null;
  const r = first ? first.getBoundingClientRect() : null;
  const page = d.querySelector('#canvas img') || d.querySelector('#canvas canvas');
  const pr = page ? page.getBoundingClientRect() : null;
  const top = (() => { if (!r || !r.width) return null;
    const el = d.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
    return el ? !!(el === first || first.contains(el) || el.classList?.contains('${CLS}')) : null; })();
  return {
    count: marks.length,
    text: marks.map(m => m.textContent).join(' ').replace(/\\s+/g,' ').trim().slice(0, 46),
    bg: cs ? cs.backgroundColor : null,
    styleInHead: !!d.getElementById('sard-pdf-reading-style'),
    themeStyleInHead: !!d.getElementById('sard-pdf-theme'),
    topmost: top,
    // Containment: the mark must sit inside the rendered page rectangle, never over the surround.
    insidePage: !!(r && pr && r.left >= pr.left - 2 && r.right <= pr.right + 2
                          && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2),
    deskBg: getComputedStyle(document.querySelector('.reader-desk')).backgroundColor,
    layerSpans: d.querySelectorAll('.textLayer span').length,
  };
})()`;

const TTS = `(() => { const st = window.__sardTtsStore?.getState?.();
  let m = null; try { m = window.__sardTtsStats?.().media ?? null; } catch(e){}
  return { status: st?.status, index: st?.index, total: st?.total, active: st?.active,
    underruns: st?.underruns, abandoned: st?.abandoned,
    lastFailure: st?.lastFailure ? String(st.lastFailure).slice(0,160) : null,
    paused: m ? m.paused : null, readyState: m ? m.readyState : null }; })()`;

const report = { startedAt: new Date().toISOString(), cases: {}, violations: [] };
const snap = snapshotDb("M:\\eRawy", "pdf-hl-acc");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

const fail = (m) => { report.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

let s;
const hl = async () => JSON.parse(await s.evaluate(`JSON.stringify(${HL})`));
const tts = async () => JSON.parse(await s.evaluate(`JSON.stringify(${TTS})`));

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9948, timeoutMs: 90_000 });
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
    const u = JSON.parse(await s.evaluate(`(async()=>{ const r=await window.__sardPdfTts('ar'); return JSON.stringify({u:r?.units??0}); })()`));
    if (u.u >= 5) break;
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }
  const deskBefore = (await hl()).deskBg;

  // ===== 1 · idle: nothing painted before playback ==============================================
  console.log("\n=== 1 · idle");
  const idle = await hl();
  report.cases.idle = idle;
  if (idle.count === 0) pass(`no highlight before playback (layer has ${idle.layerSpans} spans)`);
  else fail(`highlight present before playback: ${idle.count}`);

  // ===== 2 · playback: does the highlight follow the unit index? ================================
  console.log("\n=== 2 · playback follows the sentence index");
  const clicked = await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) { b.click(); return true; } return false; })()`);
  if (!clicked) fail("read-aloud control not found");
  const seen = new Map();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const t = await tts();
    if (t.index != null && !seen.has(t.index)) {
      const h = await hl();
      seen.set(t.index, { status: t.status, marks: h.count, text: h.text, topmost: h.topmost, insidePage: h.insidePage });
      console.log(`  index ${t.index} (${t.status}): ${h.count} span(s) · topmost=${h.topmost} · inside page=${h.insidePage} · «${h.text.slice(0,32)}»`);
    }
    if ((t.index ?? 0) >= 2 && t.readyState === 4) break;
    await sleep(700);
  }
  report.cases.playback = { indices: [...seen.keys()], detail: [...seen.entries()] };
  const idxs = [...seen.keys()];
  if (idxs.length >= 2) pass(`highlight tracked indices [${idxs.join(", ")}]`); else fail(`only tracked [${idxs.join(", ")}]`);
  for (const [i, v] of seen) {
    if (v.marks === 0) fail(`index ${i}: no highlight painted`);
    if (v.insidePage === false) fail(`index ${i}: highlight escaped the page rectangle`);
    if (v.topmost === false) fail(`index ${i}: highlight painted over`);
  }
  // Distinct sentences must produce distinct marked text, or it is painted once and frozen.
  const texts = new Set([...seen.values()].map((v) => v.text));
  if (texts.size >= 2) pass(`marked text CHANGED between sentences (${texts.size} distinct)`);
  else fail(`marked text never changed across ${seen.size} sentences — frozen highlight`);

  // ===== 3 · pause / resume =====================================================================
  console.log("\n=== 3 · pause / resume");
  await s.evaluate(`try { window.__sardTtsStore.getState().toggle(); } catch(e){}`);
  await sleep(2000);
  const paused = await tts(); const pausedHl = await hl();
  console.log(`  paused: status=${paused.status} · marks=${pausedHl.count} · «${pausedHl.text.slice(0,32)}»`);
  if (pausedHl.count > 0) pass("highlight survives pause"); else fail("highlight lost on pause");
  await s.evaluate(`try { window.__sardTtsStore.getState().toggle(); } catch(e){}`);
  await sleep(2500);
  const resumedHl = await hl();
  if (resumedHl.count > 0) pass("highlight present after resume"); else fail("highlight lost on resume");
  report.cases.pauseResume = { paused, pausedHl, resumedHl };

  // ===== 4 · seek ===============================================================================
  console.log("\n=== 4 · seek");
  const beforeSeek = await hl();
  await s.evaluate(`try { window.__sardTtsStore.getState().skip(1); } catch(e){}`);
  await sleep(3000);
  const afterSeek = await hl(); const seekT = await tts();
  console.log(`  skip(1) -> index ${seekT.index} · marks=${afterSeek.count} · «${afterSeek.text.slice(0,32)}»`);
  if (afterSeek.count > 0 && afterSeek.text !== beforeSeek.text) pass("highlight moved on seek");
  else fail(`seek did not move the highlight (before «${beforeSeek.text.slice(0,20)}» after «${afterSeek.text.slice(0,20)}»)`);
  report.cases.seek = { beforeSeek, afterSeek, index: seekT.index };

  // ===== 5 · ZOOM — the text layer is rebuilt; the highlight must come back on its own ==========
  console.log("\n=== 5 · zoom rebuilds the layer");
  // ⚠ PAUSE FIRST. The first version of this stage let playback continue through four 5 s waits, so the
  // sentence index legitimately advanced mid-test and the harness reported the highlight "moving to
  // different text" — an instrument defect, not a product one. Freezing the index is what makes
  // "the highlight must not move" a meaningful assertion, and the index is now recorded at every step
  // so a drift is visible rather than inferred.
  const zt = await tts();
  if (zt.status === "playing") { await s.evaluate(`try { window.__sardTtsStore.getState().toggle(); } catch(e){}`); await sleep(1800); }
  const z = { steps: [] };
  const preZoom = await hl();
  const preIdx = (await tts()).index;
  console.log(`  frozen at index ${preIdx} (${(await tts()).status}) · «${preZoom.text.slice(0,28)}» · ${preZoom.count} span(s)`);
  for (const level of ["2", "4", "6", "fit-page"]) {
    await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(level)}); return true; })()`);
    await sleep(5000); // the re-render plus the observer's re-apply
    const h = await hl();
    const t = await tts();
    z.steps.push({ level, index: t.index, ...h });
    console.log(`  zoom ${level.padEnd(9)} idx=${t.index} marks=${h.count} spans=${h.layerSpans} topmost=${h.topmost} inside=${h.insidePage} «${h.text.slice(0,28)}»`);
    if (h.count === 0) fail(`zoom ${level}: highlight did not return after the layer rebuild`);
    if (t.index !== preIdx) fail(`zoom ${level}: the TTS index moved (${preIdx} -> ${t.index}) — this step's comparison is void`);
    else if (h.text !== preZoom.text) fail(`zoom ${level}: highlight moved to different text at the SAME index («${h.text.slice(0,24)}» vs «${preZoom.text.slice(0,24)}»)`);
    if (h.insidePage === false) fail(`zoom ${level}: highlight escaped the page rectangle`);
    if (h.layerSpans !== preZoom.layerSpans) fail(`zoom ${level}: span count ${h.layerSpans} != baseline ${preZoom.layerSpans} — accumulation returned`);
  }
  report.cases.zoom = { preZoom, preIdx, ...z };

  // ===== 6 · THEMES — including the case the investigation could not prove =====================
  console.log("\n=== 6 · themes (switch alone must not destroy the highlight)");
  const th = { themes: [] };
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/PDF/i.test(x.getAttribute('title')||''));
    if (b) b.click(); return !!b; })()`);
  await sleep(900);
  const beforeTheme = await hl();
  for (const id of ["normal", "sepia", "warm", "cream", "green", "grey", "night", "ink"]) {
    const ok = await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${id}'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(1100);
    // ⚠ NOTHING is re-applied here on purpose. The question is whether the SWITCH ITSELF preserves it.
    const h = await hl();
    const themeFilter = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      const i=d?.querySelector('#canvas img'); return i ? d.defaultView.getComputedStyle(i).filter.slice(0,30) : null; })()`);
    th.themes.push({ id, clicked: ok, filter: themeFilter, ...h });
    console.log(`  ${id.padEnd(7)} marks=${h.count} topmost=${h.topmost} bg=${h.bg} filter=${String(themeFilter).slice(0,24)}`);
    if (!ok) fail(`theme chip ${id} not found`);
    if (h.count !== beforeTheme.count) fail(`theme ${id}: mark count ${h.count} != ${beforeTheme.count} — the switch disturbed the highlight`);
    if (h.text !== beforeTheme.text) fail(`theme ${id}: marked text changed on a theme switch`);
    if (h.topmost === false) fail(`theme ${id}: highlight painted over by the theme`);
    if (h.deskBg !== deskBefore) fail(`theme ${id}: reader desk changed (${h.deskBg} vs ${deskBefore})`);
  }
  const distinctFilters = new Set(th.themes.map((t) => t.filter)).size;
  if (distinctFilters > 1) pass(`themes genuinely changed (${distinctFilters} distinct filters) and the highlight survived every switch`);
  else fail(`themes did not change (${distinctFilters} distinct filter) — this stage proves nothing`);
  report.cases.themes = { beforeTheme, ...th, distinctFilters };
  await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-normal'); if (b) b.click(); return true; })()`);
  await sleep(700);

  // ===== 7 · page change and return =============================================================
  console.log("\n=== 7 · page change / return");
  const beforePage = await hl();
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
  await sleep(3200);
  const nextPage = await hl();
  console.log(`  next page: marks=${nextPage.count} spans=${nextPage.layerSpans} «${nextPage.text.slice(0,28)}»`);
  if (nextPage.text === beforePage.text && nextPage.count > 0) fail("the previous page's highlight LEAKED to the next page");
  else pass("no highlight leaked across the page change");
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.prev(); return true; })()`);
  await sleep(3200);
  const backPage = await hl();
  console.log(`  returned:  marks=${backPage.count} spans=${backPage.layerSpans} «${backPage.text.slice(0,28)}»`);
  report.cases.pageChange = { beforePage, nextPage, backPage };

  // ===== 8 · stop clears ========================================================================
  console.log("\n=== 8 · stop");
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
  await sleep(1500);
  const stopped = await hl(); const stoppedT = await tts();
  console.log(`  stopped: active=${stoppedT.active} marks=${stopped.count}`);
  if (stopped.count === 0) pass("highlight cleared on stop"); else fail(`highlight left behind after stop: ${stopped.count}`);
  report.cases.stop = { stopped, stoppedT };

  // ===== 9 · scan PDF stays honestly unavailable ================================================
  console.log("\n=== 9 · scan with no text layer");
  await s.evaluate(`(() => { const b=document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(600);
  const scanOpened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('S697'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (scanOpened) {
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
    await sleep(3500);
    const scan = JSON.parse(await s.evaluate(`(() => { const btns=[...document.querySelectorAll('.rc-btn')];
      const listen = btns.find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||'')));
      const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      return JSON.stringify({ listenButton: !!listen, marks: d ? d.querySelectorAll('.${CLS}').length : null,
        spans: d ? d.querySelectorAll('.textLayer span').length : null }); })()`));
    console.log(`  scan: listen button=${scan.listenButton} · spans=${scan.spans} · marks=${scan.marks}`);
    if (scan.listenButton) fail("scan offers read-aloud — a dead control");
    else pass("scan correctly offers no read-aloud");
    if (scan.marks) fail(`scan has ${scan.marks} highlight(s)`);
    report.cases.scan = scan;
  } else console.log("  (scan fixture not found — skipped)");

  report.cases.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,12))`));
  if (report.cases.pageErrors.length) console.log(`  page errors: ${JSON.stringify(report.cases.pageErrors).slice(0,200)}`);

  console.log(`\n${report.violations.length === 0 ? "✓ PDF HIGHLIGHTING ACCEPTANCE: PASS" : `✗ FAILED — ${report.violations.length} violation(s)`}`);
  for (const v of report.violations) console.log(`   ${v}`);
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
  if (report.violations.length || report.fatal) process.exitCode = 3;
}
