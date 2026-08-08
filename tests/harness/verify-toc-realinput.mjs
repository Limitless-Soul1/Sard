// RAWY-298 verification with REAL input. The previous attempt's CDP input never reached the window;
// this one calls `Page.bringToFront` first and PROVES input is landing with a sentinel before it makes
// any claim. If the sentinel fails, every later case is reported INCONCLUSIVE rather than as a result.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/verify-toc-realinput-result.json";
const R = { startedAt: new Date().toISOString(), cases: {}, violations: [], inputWorks: null };
const fail = (m) => { R.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);
const snap = snapshotDb("M:\\eRawy", "toc-realinput");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const CHROME = `(() => { const t=document.querySelector('.rc-top'); const cs=t?getComputedStyle(t):null;
  const m=cs?cs.transform:null; const dy = m && m.startsWith('matrix') ? +m.split(',')[5].replace(')','').trim() : 0;
  return { dy, hidden: dy < -10 }; })()`;
const SEC = `document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.index ?? null`;

async function click(x, y) {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sleep(40);
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(70);
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function key(k, code, vk) {
  await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
  await s.send("Input.dispatchKeyEvent", { type: "char", text: k === "Enter" ? "\r" : " " });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
const hide = async () => { await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
  d?.dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true})); return true; })()`); await sleep(1700); };
const openContents = async () => { const isOpen = await s.evaluate(`!!document.querySelector('.reader-panel.rp-lead:not(.search-panel).show')`);
  if (!isOpen) { await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/contents|المحتويات|فهرس/i.test((x.getAttribute('title')||''))); if (b) b.click(); return true; })()`); await sleep(1300); } };
const rowAt = async (i) => JSON.parse(await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')]; const t=rows[${i}];
  if (!t) return JSON.stringify({err:1}); const r=t.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
    indent: parseInt(t.style.paddingInlineStart||'0',10), label:(t.textContent||'').replace(/\\s+/g,' ').trim().slice(0,26) }); })()`));

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9976, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  try { await s.send("Page.enable"); await s.send("Page.bringToFront"); } catch (e) { console.log(`bringToFront: ${e.message}`); }
  await sleep(900);

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,120)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epubs = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const openBook = async (title) => { await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
    await sleep(400);
    const ok = await s.evaluate(`(() => { const t=${JSON.stringify(title)};
      const c=[...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t);
      if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!ok) return false;
    for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
    await sleep(2300);
    return (await s.evaluate(`document.querySelector('.page-host foliate-view')?.isFixedLayout === false`)); };

  if (!(await openBook(epubs[0].title))) throw new Error("control EPUB failed to open as reflowable");
  console.log(`control EPUB: "${epubs[0].title}"`);
  await openContents();

  // ---- SENTINEL: does injected input reach the window at all? ----
  // Top-edge pointer move is a documented reveal path (TOP_REVEAL_PX). If the chrome does not react,
  // input is not landing and nothing below may be reported as a result.
  await hide();
  const beforeS = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 300, button: "none" });
  await sleep(200);
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 12, button: "none" });
  await sleep(900);
  const afterS = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  R.inputWorks = beforeS.hidden && !afterS.hidden;
  R.cases.sentinel = { beforeS, afterS, inputWorks: R.inputWorks };
  console.log(`\nSENTINEL top-edge reveal: hidden ${beforeS.hidden} -> ${afterS.hidden} · INPUT REACHES WINDOW = ${R.inputWorks}`);

  if (!R.inputWorks) {
    console.log("\n  INCONCLUSIVE — injected input still does not reach the WebView2 window.");
    console.log("  Cases 1-4 cannot be executed programmatically; they need a human at the machine.");
  } else {
    // ---- CASE 1 · real mouse, first click navigates, chrome stays hidden ----
    console.log("\n=== CASE 1 · real mouse click on a Contents row");
    const c1 = [];
    for (const idx of [9, 4, 14]) {
      await openContents(); await hide();
      const b = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
      const s0 = await s.evaluate(SEC); const r = await rowAt(idx);
      if (r.err) continue;
      await click(r.x, r.y); await sleep(2300);
      const s1 = await s.evaluate(SEC); const a = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
      const rec = { row: idx, label: r.label, s0, s1, navigated: s0 !== s1, chromeHiddenBefore: b.hidden, chromeHiddenAfter: a.hidden };
      c1.push(rec);
      console.log(`  row ${idx} "${r.label}": ${s0} -> ${s1} · navigated=${rec.navigated} · chrome hidden after=${a.hidden}`);
      if (!rec.navigated) fail(`CASE 1 row ${idx}: first click did not navigate`);
      if (!a.hidden) fail(`CASE 1 row ${idx}: chrome was revealed by the Contents click`);
    }
    R.cases.case1 = c1;
    if (c1.length && c1.every((x) => x.navigated && x.chromeHiddenAfter)) pass("CASE 1 PASS");

    // ---- CASE 2 · keyboard Enter and Space ----
    console.log("\n=== CASE 2 · keyboard activation");
    const c2 = {};
    for (const [k, code, vk, name] of [["Enter", "Enter", 13, "Enter"], [" ", "Space", 32, "Space"]]) {
      await openContents(); await hide();
      const s0 = await s.evaluate(SEC);
      const target = name === "Enter" ? 11 : 6;
      await s.evaluate(`(() => { [...document.querySelectorAll('.toc-row')][${target}]?.focus(); return true; })()`);
      await sleep(300);
      await key(k, code, vk); await sleep(2300);
      const s1 = await s.evaluate(SEC);
      c2[name] = { s0, s1, navigated: s0 !== s1 };
      console.log(`  ${name} on focused row ${target}: ${s0} -> ${s1} · navigated=${s0 !== s1}`);
      if (s0 === s1) fail(`CASE 2 ${name}: keyboard activation did not navigate`);
    }
    R.cases.case2 = c2;
    if (Object.values(c2).every((x) => x.navigated)) pass("CASE 2 PASS");

    // ---- CASE 3 · reading area still reveals the chrome ----
    console.log("\n=== CASE 3 · reading-area click reveals chrome");
    await hide();
    const b3 = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
    const pt = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.reader-desk'); const r=d.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width*0.72), y: Math.round(r.top + r.height*0.62) }); })()`));
    await click(pt.x, pt.y); await sleep(1200);
    const a3 = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
    R.cases.case3 = { b3, a3, revealed: b3.hidden && !a3.hidden };
    console.log(`  desk click: hidden ${b3.hidden} -> ${a3.hidden} (dy ${b3.dy} -> ${a3.dy})`);
    if (!R.cases.case3.revealed) fail("CASE 3: reading-area click no longer reveals the chrome");
    else pass("CASE 3 PASS");

    // ---- CASE 4 · nested TOC ----
    console.log("\n=== CASE 4 · nested Contents entries");
    let nestedBook = null;
    for (const b of epubs.slice(0, 12)) {
      if (!(await openBook(b.title))) continue;
      await openContents();
      const info = JSON.parse(await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')];
        const ind = rows.map(r => parseInt(r.style.paddingInlineStart||'0',10));
        const child = ind.findIndex(v => v > 11); const parent = child > 0 ? ind.slice(0, child).lastIndexOf(11) : -1;
        return JSON.stringify({ rows: rows.length, child, parent, levels: [...new Set(ind)].slice(0,5) }); })()`));
      if (info.child >= 0 && info.parent >= 0) { nestedBook = { title: b.title, ...info }; break; }
    }
    if (!nestedBook) { console.log("  no EPUB with nested Contents found in the first 12 — CASE 4 NOT COVERED"); R.cases.case4 = { covered: false }; }
    else {
      console.log(`  nested book: "${nestedBook.title}" (child row ${nestedBook.child}, parent row ${nestedBook.parent}, indents ${JSON.stringify(nestedBook.levels)})`);
      const res = [];
      for (const [kind, idx] of [["parent", nestedBook.parent], ["child", nestedBook.child]]) {
        await openContents(); await hide();
        const s0 = await s.evaluate(SEC); const r = await rowAt(idx);
        await click(r.x, r.y); await sleep(2300);
        const s1 = await s.evaluate(SEC); const a = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
        res.push({ kind, idx, s0, s1, navigated: s0 !== s1, chromeHidden: a.hidden });
        console.log(`  ${kind} row ${idx} "${r.label}": ${s0} -> ${s1} · navigated=${s0 !== s1} · chrome hidden=${a.hidden}`);
        if (s0 === s1) fail(`CASE 4 ${kind}: nested entry did not navigate on the first click`);
      }
      R.cases.case4 = { covered: true, book: nestedBook.title, res };
      if (res.every((x) => x.navigated)) pass("CASE 4 PASS");
    }
  }
  console.log(`\n${!R.inputWorks ? "INCONCLUSIVE (input not landing)" : R.violations.length === 0 ? "✓ ALL CASES PASS" : `✗ ${R.violations.length} violation(s)`}`);
} catch (e) { R.fatal = e.message; console.error("FATAL:", e.message); }
finally {
  try { if (s) await s.close(); } catch {}
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch {}
  await sleep(1400);
  writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`profile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED"}`);
}
