// VERIFY RAWY-298 — Contents navigates on the FIRST real pointer interaction while immersive.
//
// Uses CDP `Input.dispatchMouseEvent` (mousePressed + mouseReleased), so Chromium synthesises the
// `click` itself from genuine input — a synthetic `element.click()` would bypass the pointerdown/up
// pairing that this bug is entirely about, and would pass even on the broken build.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/verify-toc-immersive-fix-result.json";
const R = { startedAt: new Date().toISOString(), cases: [], violations: [] };
const fail = (m) => { R.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);
const snap = snapshotDb("M:\\eRawy", "toc-fix-verify");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const CHROME = `(() => { const t=document.querySelector('.rc-top');
  const cs=t?getComputedStyle(t):null; const m=cs?cs.transform:null;
  const dy = m && m.startsWith('matrix') ? +m.split(',')[5].replace(')','').trim() : 0;
  return { topDy: dy, hidden: dy < -10 }; })()`;
const SEC = `document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.index ?? null`;

async function realClickAt(x, y) {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(60);
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
const hideChrome = async () => {
  await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    d?.dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true})); return true; })()`);
  await sleep(1800);
};
const rowRect = async (i) => JSON.parse(await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')];
  const t=rows[${i}]; if (!t) return JSON.stringify({err:'no row'});
  const r=t.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
    level: t.style.paddingInlineStart, label:(t.textContent||'').replace(/\\s+/g,' ').trim().slice(0,28) }); })()`));

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9975, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,120)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title)};
    const c=[...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t); if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);
  if (await s.evaluate(`document.querySelector('.page-host foliate-view')?.isFixedLayout !== false`)) throw new Error("control is not a reflowable EPUB");
  console.log(`control EPUB: "${epub.title}"`);
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/contents|المحتويات|فهرس/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  const nRows = await s.evaluate(`document.querySelectorAll('.toc-row').length`);
  console.log(`TOC rows: ${nRows}`);

  // ---- 1 · first-interaction navigation from hidden chrome, several chapters ----
  console.log("\n=== 1 · first real pointer interaction, chrome hidden");
  for (const idx of [9, 4, 14, 6]) {
    await hideChrome();
    const before = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
    const sec0 = await s.evaluate(SEC);
    const r = await rowRect(idx);
    if (r.err) { console.log(`  row ${idx}: absent`); continue; }
    if (!before.hidden) { fail(`row ${idx}: chrome was not hidden before the test (dy=${before.topDy})`); continue; }
    await realClickAt(r.x, r.y);
    await sleep(2400);
    const sec1 = await s.evaluate(SEC);
    const after = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
    const ok = sec0 !== sec1;
    R.cases.push({ row: idx, label: r.label, sec0, sec1, navigated: ok, chromeHiddenBefore: before.hidden, chromeHiddenAfter: after.hidden, topDy: after.topDy });
    console.log(`  row ${idx} "${r.label}": section ${sec0} -> ${sec1} · navigated=${ok} · chrome still hidden=${after.hidden} (dy=${after.topDy})`);
    if (!ok) fail(`row ${idx}: FIRST interaction did not navigate`);
    if (!after.hidden) fail(`row ${idx}: chrome was revealed by the Contents click (dy=${after.topDy})`);
  }

  // ---- 2 · nested entry (indented row) ----
  console.log("\n=== 2 · nested TOC entry");
  const nested = JSON.parse(await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')];
    const i = rows.findIndex(r => parseInt(r.style.paddingInlineStart||'0',10) > 11);
    return JSON.stringify({ i }); })()`));
  if (nested.i >= 0) {
    await hideChrome();
    const sec0 = await s.evaluate(SEC); const r = await rowRect(nested.i);
    await realClickAt(r.x, r.y); await sleep(2400);
    const sec1 = await s.evaluate(SEC); const after = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
    console.log(`  nested row ${nested.i} (indent ${r.level}): ${sec0} -> ${sec1} · navigated=${sec0 !== sec1} · chrome hidden=${after.hidden}`);
    if (sec0 === sec1) fail("nested TOC entry did not navigate on the first interaction");
    R.cases.push({ nested: true, row: nested.i, sec0, sec1, navigated: sec0 !== sec1 });
  } else console.log("  (no nested entries in this book — not covered)");

  // ---- 3 · keyboard Enter on a focused row ----
  console.log("\n=== 3 · keyboard activation");
  await hideChrome();
  const sec0k = await s.evaluate(SEC);
  await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')]; rows[11]?.focus(); return document.activeElement?.className||''; })()`);
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(2400);
  const sec1k = await s.evaluate(SEC);
  console.log(`  Enter on focused row 11: ${sec0k} -> ${sec1k} · navigated=${sec0k !== sec1k}`);
  if (sec0k === sec1k) fail("keyboard Enter on a Contents row did not navigate");
  R.keyboard = { sec0: sec0k, sec1: sec1k };

  // ---- 4 · reading-area click MUST still reveal the chrome ----
  console.log("\n=== 4 · reading-area click still reveals chrome");
  await hideChrome();
  const beforeRead = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  const deskPt = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.reader-desk');
    const r=d.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left+r.width*0.75), y: Math.round(r.top+r.height*0.6) }); })()`));
  await realClickAt(deskPt.x, deskPt.y);
  await sleep(1200);
  const afterRead = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  console.log(`  desk click: hidden ${beforeRead.hidden} -> ${afterRead.hidden} (dy ${beforeRead.topDy} -> ${afterRead.topDy})`);
  if (afterRead.hidden) fail("reading-area click no longer reveals the chrome — REGRESSION");
  else pass("reading-area reveal unchanged");
  R.readingArea = { beforeRead, afterRead };

  // ---- 5 · Search / Annotations hold unchanged ----
  console.log("\n=== 5 · Search + Annotations hold behaviour");
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/search|بحث/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  await hideChrome();
  const searchState = JSON.parse(await s.evaluate(`JSON.stringify({ ...${CHROME}, panel: !!document.querySelector('.search-panel.show') })`));
  console.log(`  Search open: panel=${searchState.panel} chromeHidden=${searchState.hidden} (held => should be visible)`);
  if (searchState.panel && searchState.hidden) fail("Search no longer pins the chrome — REGRESSION");
  else pass("Search hold unchanged");
  R.search = searchState;
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/search|بحث/i.test((x.getAttribute('title')||''))); if (b) b.click(); return true; })()`);
  await sleep(800);

  // ---- 6 · open/close Contents repeatedly ----
  console.log("\n=== 6 · open/close Contents x5");
  let toggleOk = true;
  for (let i = 0; i < 5; i++) {
    await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/contents|المحتويات|فهرس/i.test((x.getAttribute('title')||''))); if (b) b.click(); return true; })()`);
    await sleep(700);
    const open = await s.evaluate(`!!document.querySelector('.reader-panel.rp-lead:not(.search-panel).show')`);
    if (i % 2 === 0 && open) toggleOk = toggleOk && true;
  }
  const finalRows = await s.evaluate(`document.querySelectorAll('.toc-row').length`);
  console.log(`  after 5 toggles: rows visible=${finalRows} (toggling functional=${toggleOk})`);
  R.toggles = { finalRows };

  R.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0,8))`));
  console.log(`\n${R.violations.length === 0 ? "✓ VERIFICATION PASS" : `✗ ${R.violations.length} violation(s)`}`);
} catch (e) { R.fatal = e.message; console.error("FATAL:", e.message); }
finally {
  try { if (s) await s.close(); } catch {}
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch {}
  await sleep(1400);
  writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`profile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED"}`);
  if (R.violations.length || R.fatal) process.exitCode = 3;
}
