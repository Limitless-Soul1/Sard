// SYNTHETIC TOC — does a generated chapter row actually navigate?
//
// Reported: for a book whose own contents are unusable, Sard generates the chapter list correctly but
// none of the rows do anything when clicked, no row is highlighted as current, and the panel does not
// scroll to the current chapter.
//
// This measures the whole path rather than reasoning about it: which rows exist, whether the DOM says
// they are clickable, what happens to the RENDERED SECTION when one is really clicked, and whether an
// active row is ever marked. Nothing here is inferred from our source — every answer is read from the
// running application.
//
// Drives the REAL profile: snapshot before launch, restore on every exit path.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What is on screen right now: the section index the renderer is showing, plus a fingerprint of the
// visible text so navigation can be proven even if the engine exposes no index.
const WHERE = `(() => {
  const v = document.querySelector('foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const doc = c?.doc;
  const txt = (doc?.body?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return {
    index: c?.index ?? null,
    heading: (doc?.body?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    text: txt.slice(0, 80),
    chars: txt.length,
  };
})()`;

const ROWS = `(() => {
  const rows = [...document.querySelectorAll('.toc-row')];
  return {
    count: rows.length,
    active: rows.filter(r => r.classList.contains('active')).length,
    disabled: rows.filter(r => r.disabled).length,
    first: rows.slice(0, 6).map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)),
    synthNote: !!document.querySelector('.rp-synth-note'),
  };
})()`;

const snap = snapshotDb(REPO, "toc-synth");
if (!snap) {
  console.error("FATAL: could not snapshot the profile — refusing to run. NOTHING was verified.");
  process.exit(1);
}

let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9347, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);

  // Find a book Sard itself has FLAGGED as having unusable contents. Never pick by title — the flag
  // is the only thing that decides whether the synthetic path runs at all.
  const books = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books', { sort: 'added', order: 'desc' }).catch(e => ({ __err: String(e) }))`,
  );
  if (!Array.isArray(books)) throw new Error(`library_list_books failed: ${JSON.stringify(books).slice(0, 200)}`);
  const flagged = books.filter((b) => b.toc_degenerate === 1 || b.tocDegenerate === 1);
  console.log(`library   ${books.length} books; flagged tocDegenerate: ${flagged.length}`);
  for (const b of flagged.slice(0, 5)) console.log(`   • ${b.title}`);
  const want = (process.argv.find((a) => a.startsWith("--title=")) ?? "").slice(8);
  const target = want ? flagged.find((b) => b.title.includes(want)) ?? books.find((b) => b.title.includes(want)) : flagged[0];
  if (!target) throw new Error("no book in the library is flagged tocDegenerate — cannot exercise the synthetic TOC");

  const opened = await s.evaluate(
    `(() => { const t = ${JSON.stringify("")} ; const c = [...document.querySelectorAll('.lib-card')]
       .find(x => (x.getAttribute('title')||'') === ${JSON.stringify(target.title)});
       if (!c) return false; c.click(); return true; })()`,
  );
  if (!opened) throw new Error(`could not find the library card for ${target.title}`);
  console.log(`opened    ${target.title}`);
  await sleep(12_000); // the synthetic TOC is built off the critical path — give it time

  // Open the contents panel the way a reader does.
  // Open it the way a reader does, and PROVE it opened. Rows exist in the DOM even when the panel is
  // closed — measured: with the panel shut, all 116 rows sat at left = -292, entirely off-screen, and
  // a harness that only counted rows happily "opened" a panel nobody could see or click.
  const panel = await s.evaluate(
    `(() => { const b = [...document.querySelectorAll('.rc-btn')]
         .find(x => /contents|فهرس|المحتويات/i.test(x.getAttribute('title') || ''));
       if (!b) return 'NOT FOUND';
       if (!b.classList.contains('on')) b.click();
       return 'rc-btn'; })()`,
  );
  await sleep(2500);
  let rows = await s.evaluate(ROWS);
  const onScreen = await s.evaluate(
    `(() => { const r = document.querySelector('.toc-row'); if (!r) return null;
       const b = r.getBoundingClientRect();
       return { left: Math.round(b.left), right: Math.round(b.right), visible: b.right > 0 && b.left < innerWidth }; })()`,
  );
  console.log(`panel     control: ${panel}; first row box ${JSON.stringify(onScreen)}`);
  if (!onScreen?.visible) throw new Error(`the contents panel is not on screen: ${JSON.stringify(onScreen)}`);
  console.log(
    `panel     opened via ${panel}; ${rows.count} rows, ${rows.disabled} disabled, ${rows.active} marked active` +
      `\n          synthesised note shown: ${rows.synthNote}` +
      `\n          first rows: ${JSON.stringify(rows.first)}`,
  );
  if (!rows.count) throw new Error("the contents panel shows no rows at all");

  // THE MEASUREMENT: click a row far from the current position and see whether the rendered section
  // actually changes. A real click, so nothing about the handler is bypassed.
  const before = await s.evaluate(WHERE);
  console.log(`\nbefore    ${JSON.stringify(before)}`);
  // Pick a row that is genuinely ON SCREEN and is not the current one. Choosing by ordinal alone was
  // wrong: now that the panel scrolls the active row into view, a low-numbered row sits above the
  // viewport and the click lands on nothing — measured, elementFromPoint returned (nothing) and no
  // handler fired, which looks exactly like a dead row but is a broken test.
  const clicked = await s.evaluate(
    `(() => { const rows = [...document.querySelectorAll('.toc-row')];
       // "Visible" means the browser's own hit test lands inside this row — the only definition that
       // matters for a click, and the one that caught the earlier bad target.
       const vis = rows.map((r, i) => ({ r, i, box: r.getBoundingClientRect() }))
         .filter(x => !x.r.classList.contains('active') && x.box.width > 0 && x.box.height > 0)
         .filter(x => { const el = document.elementFromPoint(x.box.left + x.box.width/2, x.box.top + x.box.height/2);
                        return !!el && (el === x.r || x.r.contains(el)); });
       const pick = vis[vis.length - 1] ?? vis[0];
       if (!pick) {
         const act = rows.findIndex(r => r.classList.contains('active'));
         const near = rows.slice(Math.max(0, act - 1), act + 3).map(r => {
           const b = r.getBoundingClientRect();
           const el = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
           return { top: Math.round(b.top), left: Math.round(b.left),
                    hit: el ? el.tagName + '.' + String(el.className).split(' ')[0] : '(null)',
                    isRowOrChild: !!el && (el === r || r.contains(el)) };
         });
         return { none: true, rows: rows.length, active: act, viewport: innerHeight, near };
       }
       return { row: pick.i, disabled: !!pick.r.disabled,
                text: (pick.r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40),
                x: Math.round(pick.box.left + pick.box.width/2),
                y: Math.round(pick.box.top + pick.box.height/2) }; })()`,
  );
  if (!clicked || clicked.none) throw new Error(`no visible, non-active contents row to click: ${JSON.stringify(clicked)}`);
  const clickTarget = clicked.row;
  console.log(`clicking  row #${clickTarget} "${clicked?.text}" (DOM disabled: ${clicked?.disabled})`);
  // What is actually under the pointer, and does the row's own handler run? A click that lands on
  // something else, or a handler that runs and is then undone, look identical from the outside.
  const hit = await s.evaluate(
    `(() => { const el = document.elementFromPoint(${clicked.x}, ${clicked.y});
       window.__rowClicks = 0;
       document.querySelectorAll('.toc-row').forEach(r => r.addEventListener('click', () => window.__rowClicks++, true));
       return el ? el.tagName + '.' + String(el.className).split(' ')[0] : '(nothing)'; })()`,
  );
  console.log(`   element under the pointer: ${hit}`);
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: clicked.x, y: clicked.y, button: "left", clickCount: 1 });
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clicked.x, y: clicked.y, button: "left", clickCount: 1 });
  // Sample continuously: a jump that happens and is then undone is invisible to a single late read.
  const trace = [];
  for (let i = 0; i < 14; i++) {
    await sleep(300);
    const w = await s.evaluate(WHERE);
    if (!trace.length || trace[trace.length - 1].index !== w.index) trace.push({ ms: (i + 1) * 300, index: w.index });
  }
  console.log(`   row click handlers fired: ${await s.evaluate(`window.__rowClicks`)}`);
  console.log(`   position trace after the click: ${JSON.stringify(trace)}`);
  const after = await s.evaluate(WHERE);
  console.log(`after     ${JSON.stringify(after)}`);

  const moved = before.index !== after.index || before.text !== after.text;
  const rowsAfter = await s.evaluate(ROWS);
  // Every behaviour the owner listed, checked separately — "it moved" is not the whole requirement.
  const scroll = await s.evaluate(
    `(() => { const el = document.querySelector('.toc-row.active');
       if (!el) return { active: false };
       const box = el.closest('[class*=scroll], .rp-body, .rp-scroll') ?? el.parentElement;
       const r = el.getBoundingClientRect(), b = box?.getBoundingClientRect();
       return { active: true, inView: !!b && r.top >= b.top - 2 && r.bottom <= b.bottom + 2,
                rowTop: Math.round(r.top), boxTop: Math.round(b?.top ?? -1), boxBottom: Math.round(b?.bottom ?? -1) }; })()`,
  );
  const activeAfter = await s.evaluate(
    `[...document.querySelectorAll('.toc-row')].findIndex(r => r.classList.contains('active'))`,
  );
  const checks = [
    ["every generated chapter is clickable", clicked?.disabled === false],
    ["clicking navigates", moved],
    // Self-consistent and needs no knowledge of spine indices: if navigation and current-chapter
    // detection are both right, clicking row k must leave row k as the current row.
    ["clicking row k makes row k the current chapter", activeAfter === clickTarget],
    ["current chapter is detected", rowsAfter.active > 0],
    ["the active row is highlighted", rowsAfter.active === 1],
    ["the panel scrolled the active row into view", scroll.active && scroll.inView === true],
  ];
  console.log("\nRESULT");
  for (const [what, ok] of checks) console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}`);
  console.log(
    `   (landed on section ${after.index}, clicked row #${clickTarget}; ` +
      `${rowsAfter.active} row(s) active; scroll ${JSON.stringify(scroll)})`,
  );
  if (checks.some(([, ok]) => !ok)) console.log("\n   NOT ALL BEHAVIOURS PASS — the synthetic TOC is not yet equivalent to a native one.");

  // What does the click handler actually receive? Read the row's own props path by calling the same
  // entry point the UI calls, with the href the panel holds — measured, not assumed.
  const hrefProbe = await s.evaluate(
    `(() => { const r = [...document.querySelectorAll('.toc-row')][${clickTarget}];
       const key = r && Object.keys(r).find(k => k.startsWith('__reactProps$'));
       const props = key ? r[key] : null;
       return { hasProps: !!props, disabled: props?.disabled ?? null }; })()`,
  );
  console.log(`   react props on the row: ${JSON.stringify(hrefProbe)}`);

  // WHY: call the engine three ways and see which one actually moves. foliate's view.goTo() resolves
  // a TARGET (a number, a {fraction}, a CFI, or an href string); the renderer's goTo() takes an
  // already-resolved {index, anchor}. Passing the resolved shape to the resolver is the suspect.
  console.log("\n--- which call shape actually navigates? ---");
  const shapes = [
    ["view.goTo({index, anchor:0})  (what goToSection does today)", `v.goTo({ index: 30, anchor: 0 })`],
    ["view.goTo(30)                 (a number target)", `v.goTo(30)`],
    ["view.renderer.goTo({index:30, anchor:0})", `v.renderer.goTo({ index: 30, anchor: 0 })`],
  ];
  for (const [label, call] of shapes) {
    await s.evaluate(`(() => { const v = document.querySelector('foliate-view'); v.goTo(0); return true; })()`).catch(() => {});
    await sleep(2500);
    const b = await s.evaluate(WHERE);
    const err = await s.evaluate(
      `(async () => { const v = document.querySelector('foliate-view');
         try { const r = await ${call}; return { threw: false, returned: r === undefined ? 'undefined' : JSON.stringify(r).slice(0,80) }; }
         catch (e) { return { threw: true, error: String(e).slice(0, 120) }; } })()`,
    );
    await sleep(2500);
    const a = await s.evaluate(WHERE);
    console.log(
      `   ${label}\n      index ${b.index} -> ${a.index}   moved: ${b.index !== a.index || b.text !== a.text ? "YES" : "NO"}   ${JSON.stringify(err)}`,
    );
  }
  out = 0;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try {
    execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await sleep(1500);
  const ok = await restoreDb(snap);
  console.log(`profile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
