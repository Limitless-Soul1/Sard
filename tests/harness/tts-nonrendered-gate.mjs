// REGRESSION GATE — non-rendered element text must never reach the TTS queue.
//
// WHY A HARNESS AND NOT A UNIT TEST. `segmentBlock` is a DOM walk over a real Range implementation.
// The vitest suite runs with `environment: node` DELIBERATELY (vitest.config.ts) and the project owns
// no DOM library; `tests/unit/ttsUnitStructure.test.ts` states the rule outright — approximating
// Chromium's Range behaviour "would test the approximation, not the product". So the gate runs against
// the real binary, where `segmentBlock`, `Intl.Segmenter` and `Range` are the ones that ship.
//
// THE FIXTURE is injected into a real chapter document, so the real controller walks it. Each block is
// designed to contribute a KNOWN number of units, which makes the expected total exact rather than
// approximate:
//
//   <p>prose 1</p>                          -> 1 unit   (must always survive)
//   <div><script>…ad tag…</script></div>     -> 1 unit BEFORE the fix, 0 AFTER
//   <p>prose 2</p>                          -> 1 unit   (must always survive)
//   <div><style>…css…</style></div>          -> 1 unit BEFORE the fix, 0 AFTER
//   <div><noscript>visible</noscript></div>  -> 1 unit   (MUST SURVIVE — it renders in this build)
//   <p>prose 3</p>                          -> 1 unit   (must always survive)
//
//   EXPECTED TOTAL:  6 before the fix   ->   4 after the fix
//
// The count is read from the store's `total`, which is published when the real read-aloud control
// builds the queue for the section on screen — not from any replica.
//
// The document is restored by navigating away and back, which re-parses it from the EPUB.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-nonrendered-gate-result.json";
const EXPECT_BEFORE = 6;
const EXPECT_AFTER = 4;

const AD = 'window.pubfuturetag = window.pubfuturetag || [];window.pubfuturetag.push({unit: "x", id: "pf-1"})';
const CSS = ".probe-a { color: red; font-weight: bold }";
const P1 = "الجملة الأولى ظاهرة على الصفحة.";
const P2 = "الجملة الثانية ظاهرة أيضا.";
const P3 = "الجملة الثالثة تختم الفقرة.";
const NOS = "نص داخل نوسكربت مرئي للقارئ.";

const report = { startedAt: new Date().toISOString(), expectBefore: EXPECT_BEFORE, expectAfter: EXPECT_AFTER, verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "nonrendered-gate");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9957, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!epub) throw new Error("no EPUB in the library");
  console.log(`host book: "${epub.title}"`);
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);
  await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
    try { await v.goTo(5); } catch(e) {} return true; })()`);
  await sleep(2500);

  // ---- install the controlled fixture into the real chapter document ------------------------
  const installed = JSON.parse(await s.evaluate(`(() => {
    const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    if (!d?.body) return JSON.stringify({ ok:false });
    d.body.innerHTML =
      '<p>${P1}</p>' +
      '<div id="ad"><scr' + 'ipt>${AD}</scr' + 'ipt></div>' +
      '<p>${P2}</p>' +
      '<div id="cssblk"><sty' + 'le>${CSS}</sty' + 'le></div>' +
      '<div id="nos"><noscript>${NOS}</noscript></div>' +
      '<p>${P3}</p>';
    const win = d.defaultView;
    const disp = (sel) => { const e = d.querySelector(sel); return e ? win.getComputedStyle(e).display : null; };
    return JSON.stringify({ ok:true,
      scriptDisplay: disp('#ad script'), styleDisplay: disp('#cssblk style'), noscriptDisplay: disp('#nos noscript'),
      visibleText: (d.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 160) });
  })()`));
  console.log(`fixture installed: script display=${installed.scriptDisplay} style=${installed.styleDisplay} noscript=${installed.noscriptDisplay}`);
  console.log(`reader sees: «${installed.visibleText}»`);
  report.fixture = installed;

  // The reader must see the three prose lines AND the noscript line, and nothing else.
  const sees = (t) => installed.visibleText.includes(t);
  report.verdicts.noscriptVisibleToReader = sees("نوسكربت");
  report.verdicts.scriptNotVisible = !installed.visibleText.includes("pubfuturetag");
  report.verdicts.styleNotVisible = !installed.visibleText.includes("color");

  // ---- ask the REAL pipeline how many units this document yields ----------------------------
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  let st = null;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    st = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
      return JSON.stringify({ status:q?.status, total:q?.total, index:q?.index }); })()`));
    if ((st.total ?? 0) > 0) break;
    if (st.status === "error") break;
    await sleep(700);
  }
  report.observedTotal = st?.total ?? null;
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
  await sleep(900);

  // restore the document by re-parsing it from the EPUB
  await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
    try { await v.goTo(6); await v.goTo(5); } catch(e) {} return true; })()`);
  await sleep(2500);
  report.documentRestored = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return !d?.getElementById('ad'); })()`);

  const t = report.observedTotal;
  console.log(`\nunits produced by the fixture: ${t}`);
  console.log(`  expected BEFORE the fix: ${EXPECT_BEFORE}   (prose 3 + noscript 1 + script 1 + style 1)`);
  console.log(`  expected AFTER  the fix: ${EXPECT_AFTER}   (prose 3 + noscript 1)`);
  report.verdicts.matchesUnfixed = t === EXPECT_BEFORE;
  report.verdicts.matchesFixed = t === EXPECT_AFTER;
  console.log(`\n  noscript visible to reader : ${report.verdicts.noscriptVisibleToReader}`);
  console.log(`  script NOT visible         : ${report.verdicts.scriptNotVisible}`);
  console.log(`  style  NOT visible         : ${report.verdicts.styleNotVisible}`);
  console.log(`  document restored          : ${report.documentRestored}`);
  console.log(`\n  ${t === EXPECT_AFTER ? "GREEN — non-rendered text is excluded"
    : t === EXPECT_BEFORE ? "RED — non-rendered text IS reaching the queue (expected before the fix)"
    : `INDETERMINATE — ${t} units, neither ${EXPECT_BEFORE} nor ${EXPECT_AFTER}`}`);
  if (t !== EXPECT_AFTER) process.exitCode = 3;
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
  process.exitCode = 3;
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
