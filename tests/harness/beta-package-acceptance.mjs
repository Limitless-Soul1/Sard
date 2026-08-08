// EXTERNAL BETA — acceptance against the INSTALLED application.
//
// Not the dev build, not `test-build\Sard.exe`: this drives the executable a tester will actually run,
// from the location the installer put it. Everything a tester can see is checked here, because the
// build being correct in the repo says nothing about what came out of the ZIP.
//
// Launched with the debug port from THIS process only (D55 — the port opens solely when the launching
// process sets the variable, which is why it appears in no shipped artifact).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/beta-package-acceptance-result.json";
const EXE = "C:\\Users\\Administrator\\AppData\\Local\\Sard\\Sard.exe";
const EXPECTED = [1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.75, 2];

const report = { startedAt: new Date().toISOString(), exe: EXE, cases: {}, violations: [] };
const fail = (m) => { report.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const snap = snapshotDb("M:\\eRawy", "beta-acceptance");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: EXE, port: 9951, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160))); return true; })()`);

  // ===== 1 · identity ==========================================================================
  console.log("\n=== 1 · identity");
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const libCount = Array.isArray(books) ? books.length : -1;
  const title = await s.evaluate(`document.title`);
  report.cases.identity = { libCount, title };
  console.log(`  window.title="${title}" · library rows=${libCount}`);
  // Reading the SAME profile is what proves the bundle identifier is com.sard.app: that directory is
  // resolved from the identifier with no override, so a different id would show an EMPTY library.
  if (libCount > 0) pass(`reads the com.sard.app profile (${libCount} books) — production identifier`);
  else fail(`library empty (${libCount}) — the installed build is not using the com.sard.app profile`);

  // ===== 2 · no developer or diagnostic surface ================================================
  console.log("\n=== 2 · developer surface");
  const dev = JSON.parse(await s.evaluate(`JSON.stringify({
    diagGlobals: ['__sardDiag','diagStart','__sardStageLedger','__sardRenderDiag'].filter(k => k in window),
    ttsDebugOn: window.__sardTtsStore?.getState?.().debug ?? null,
    debugReadout: !!document.querySelector('.tts-pill-pos'),
    redButtons: [...document.querySelectorAll('button')].filter(b => {
      const c = getComputedStyle(b).backgroundColor.match(/\\d+/g);
      return c && +c[0] > 170 && +c[1] < 70 && +c[2] < 70;
    }).length,
    bodyText: document.body.innerText.slice(0, 0),
  })`));
  report.cases.devSurface = dev;
  console.log(`  diag globals=${JSON.stringify(dev.diagGlobals)} ttsDebug=${dev.ttsDebugOn} debugReadout=${dev.debugReadout} redButtons=${dev.redButtons}`);
  if (dev.diagGlobals.length === 0) pass("no diagnostic globals on window"); else fail(`diagnostic globals present: ${dev.diagGlobals}`);
  if (dev.ttsDebugOn !== true) pass("TTS diagnostics OFF by default"); else fail("TTS diagnostics are ON by default");
  if (!dev.debugReadout) pass("no debug readout rendered"); else fail("a debug readout is rendered");
  if (dev.redButtons === 0) pass("no red diagnostic buttons"); else fail(`${dev.redButtons} red button(s) found`);

  // ===== 3 · PDF read-aloud must be unavailable ================================================
  console.log("\n=== 3 · PDF read-aloud unavailable");
  const pdfOpened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (pdfOpened) {
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
    await sleep(3000);
    for (let p = 0; p < 4; p++) { await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`); await sleep(1500); }
    const pdf = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      return JSON.stringify({
        listen: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
        marks: d ? d.querySelectorAll('.sard-pdf-reading').length : null,
        spans: d ? d.querySelectorAll('.textLayer span').length : null,
        renders: !!d?.querySelector('#canvas img') }); })()`));
    report.cases.pdf = pdf;
    console.log(`  listen=${pdf.listen} marks=${pdf.marks} textLayerSpans=${pdf.spans} pageRenders=${pdf.renders}`);
    if (!pdf.listen) pass("PDF offers no read-aloud control"); else fail("PDF still offers read-aloud");
    if (!pdf.marks) pass("no PDF highlighting active"); else fail(`PDF highlight marks present: ${pdf.marks}`);
    if (pdf.renders) pass("PDF still renders normally (reading unaffected)"); else fail("PDF failed to render");
  } else fail("test PDF not found in the library");

  // ===== 4 · EPUB reading + read-aloud ==========================================================
  console.log("\n=== 4 · EPUB reading and read-aloud");
  await s.evaluate(`(() => { const b=document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(600);
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format ?? "").toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!epub) throw new Error("no EPUB in the library");
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(250); }
  await sleep(2500);
  const read = JSON.parse(await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view');
    const d=v?.renderer?.getContents?.()?.[0]?.doc;
    return JSON.stringify({ isFixedLayout: v?.isFixedLayout ?? null, sections: v?.book?.sections?.length ?? null,
      chars: d?.body ? d.body.innerText.replace(/\\s+/g,' ').trim().length : 0 }); })()`));
  report.cases.epubRead = { title: epub.title, ...read };
  console.log(`  "${epub.title}" · sections=${read.sections} · rendered chars=${read.chars}`);
  if (read.isFixedLayout === false && read.chars > 200) pass("EPUB renders text");
  else fail(`EPUB did not render properly: ${JSON.stringify(read)}`);

  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  let play = null;
  const dl = Date.now() + 75_000;
  while (Date.now() < dl) {
    play = JSON.parse(await s.evaluate(`(() => { const st=window.__sardTtsStore?.getState?.();
      let m=null; try { m=window.__sardTtsStats?.().media ?? null; } catch(e){}
      return JSON.stringify({ status: st?.status, total: st?.total, rate: m?m.rate:null,
        paused: m?m.paused:null, readyState: m?m.readyState:null }); })()`));
    if (play.readyState === 4 || play.status === "error") break;
    await sleep(900);
  }
  report.cases.epubTts = play;
  console.log(`  read-aloud: status=${play.status} readyState=${play.readyState} paused=${play.paused}`);
  if (play.status === "playing" && play.readyState === 4 && play.paused === false) pass("EPUB read-aloud plays");
  else fail(`EPUB read-aloud failed: ${JSON.stringify(play)}`);

  // ===== 5 · THE SPEED MENU — the reason this Beta exists =======================================
  console.log("\n=== 5 · TTS speed menu");
  await s.evaluate(`document.querySelector('.tts-speed-chip')?.click()`);
  await sleep(500);
  const menu = JSON.parse(await s.evaluate(`(() => { const m=document.querySelector('.tts-speed-menu');
    const opts = m ? [...m.querySelectorAll('.tts-speed-opt')] : [];
    return JSON.stringify({ open: !!m, count: opts.length,
      values: opts.map(o => o.querySelector('.tts-speed-val')?.textContent.trim() ?? ''),
      checks: opts.filter(o => !!o.querySelector('.tts-speed-check svg')).length }); })()`));
  const parsed = menu.values.map((v) => Number(String(v).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, "")));
  report.cases.menu = { ...menu, parsed };
  console.log(`  options: ${JSON.stringify(menu.values)}`);
  console.log(`  parsed:  ${JSON.stringify(parsed)}`);
  if (menu.open) pass("dropdown opens (not a cycling button)"); else fail("dropdown did not open");
  if (JSON.stringify(parsed) === JSON.stringify(EXPECTED)) pass("all 11 approved speeds, in order");
  else fail(`speeds ${JSON.stringify(parsed)} != ${JSON.stringify(EXPECTED)}`);
  if (Math.max(...parsed) === 2) pass("maximum is 2× — nothing above"); else fail(`max is ${Math.max(...parsed)}`);
  if (menu.checks === 1) pass("exactly one checkmark"); else fail(`${menu.checks} checkmarks`);

  const applied = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    await s.evaluate(`(() => { if (!document.querySelector('.tts-speed-menu')) document.querySelector('.tts-speed-chip')?.click(); return true; })()`);
    await sleep(320);
    await s.evaluate(`(() => { const o=[...document.querySelectorAll('.tts-speed-opt')][${i}]; if (o) o.click(); return !!o; })()`);
    await sleep(850);
    const r = JSON.parse(await s.evaluate(`(() => { const st=window.__sardTtsStore?.getState?.();
      let m=null; try { m=window.__sardTtsStats?.().media ?? null; } catch(e){}
      return JSON.stringify({ store: st?.speed, rate: m?m.rate:null,
        chip: document.querySelector('.tts-speed-chip')?.textContent.trim() ?? null,
        open: !!document.querySelector('.tts-speed-menu') }); })()`));
    applied.push({ want: EXPECTED[i], ...r });
    const ok = Math.abs((r.rate ?? -1) - EXPECTED[i]) < 1e-6 && Math.abs((r.store ?? -1) - EXPECTED[i]) < 1e-6;
    console.log(`  ${String(EXPECTED[i]).padEnd(5)} store=${r.store} audioRate=${r.rate} chip="${r.chip}"${ok ? "" : "  <-- MISMATCH"}`);
    if (!ok) fail(`speed ${EXPECTED[i]}: store=${r.store} rate=${r.rate}`);
    if (r.open) fail(`speed ${EXPECTED[i]}: menu stayed open`);
  }
  report.cases.applied = applied;
  if (applied.every((a) => Math.abs(a.rate - a.want) < 1e-6)) pass("every speed reached the audio element exactly");
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);

  report.cases.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,10))`));
  if (report.cases.pageErrors.length) console.log(`\n  page errors: ${JSON.stringify(report.cases.pageErrors).slice(0,220)}`);
  console.log(`\n${report.violations.length === 0 ? "✓ BETA PACKAGE ACCEPTANCE: PASS" : `✗ FAILED — ${report.violations.length} violation(s)`}`);
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
