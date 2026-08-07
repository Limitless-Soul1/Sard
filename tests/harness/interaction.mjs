#!/usr/bin/env node
// RESILIENCE-1 / WP-4 — the READING INTERACTION probe.
//
// WP-4 rewrites the reader's layering, key routing, focus policy and position readout. Every one of
// those is a claim about the RUNNING app that prose cannot settle, so this measures them in the real
// binary — before the change, to establish what is actually broken, and after, as the gate.
//
// What it measures, and why each one is a number rather than an opinion:
//
//   geometry  Do the page-turn chevrons intersect an open panel's box? The reported defect ("the
//             nav buttons are hidden behind the Contents list") is a rectangle overlap, so it is
//             checked as one — in every {UI language} × {book direction} combination, because the
//             desk pads on the LEADING edge and that edge flips.
//   keys      After each way of reaching the reader (fresh open, toolbar click, panel open, TOC
//             jump, desk-margin click), does ArrowRight/ArrowLeft/Space actually turn the page?
//             Recorded as the resulting location, so "the key did nothing" is distinguishable from
//             "the key worked but the page looked similar".
//   coalesce  Two page-turns fired inside the engine's 100 ms lock: how many pages advanced?
//             foliate drops the second outright, so today the answer should be 1, not 2.
//   position  What foliate hands Sard on every relocate (`location`, `section`, `pageItem`) versus
//             what Sard keeps. WP-4F carries the discarded fields through to a readout.
//
//   node tests/harness/interaction.mjs                # measure, print a table
//   node tests/harness/interaction.mjs --gate         # exit 1 if an invariant is violated
//
// ⚠ Drives the REAL app against the REAL profile — same snapshot/restore contract as
// byte-identity.mjs. See that file's header.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs"; // the ONE real-profile guard
import { corpusAvailable, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const GATE = process.argv.includes("--gate");

// One LTR and one RTL book. Direction is the axis that matters here: the desk pads on the LEADING
// edge, the chrome is pinned LTR, and the chevrons follow the BOOK — so an RTL book with an Arabic
// UI is the combination where a leading-edge assumption breaks.
const LTR_BOOK = "control-wellformed--alice.epub";
const RTL_BOOK = "rtl-declared--red-rising.epub";



const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Page-level helpers, evaluated inside the app.
// ---------------------------------------------------------------------------

/** Rectangles of the chevrons and whichever panel is open, plus their overlap. */
const GEOMETRY_JS = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const overlap = (a, b) => (!a || !b) ? 0
    : Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const left = document.querySelector('.page-chevron-left');
  const right = document.querySelector('.page-chevron-right');
  // NOTE: no backticks anywhere inside these template literals — one in a comment terminates the
  // string and the file stops parsing. This has now cost three separate debugging rounds.
  // The panel element is ALWAYS in the DOM: it is hidden with a class, aria-hidden and inert rather
  // than unmounted. Selecting it without .show reports "panel open" for a CLOSED panel, which is how
  // the first run of this probe measured a 0px desk pad against an "open" panel.
  const panel = document.querySelector('.reader-panel.show');
  const lb = box(left), rb = box(right), pb = box(panel);
  // "Reachable" is the question a reader actually asks: is the button's own centre the topmost
  // element there? A button under a panel fails this even when the rectangles barely touch.
  const hit = (el) => { if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!(top && el.contains(top)); };
  return {
    panelOpen: !!panel,
    left: lb, right: rb, panel: pb,
    leftOverlap: overlap(lb, pb), rightOverlap: overlap(rb, pb),
    leftReachable: hit(left), rightReachable: hit(right),
    deskPadStart: getComputedStyle(document.querySelector('.reader-desk') || document.body).paddingLeft,
    dir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction,
  };
})()`;

/** Where the reader currently is, as a comparable string. */
const WHERE_JS = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  if (!v) return null;
  const c = v.renderer && v.renderer.getContents && v.renderer.getContents()[0];
  return {
    section: c ? c.index : -1,
    // renderer.page exists only in paged mode; in scrolled mode the scroll offset is the position.
    page: (v.renderer && typeof v.renderer.page === 'number') ? v.renderer.page : null,
    scroll: c && c.doc && c.doc.documentElement ? Math.round(c.doc.documentElement.scrollTop || 0) : 0,
    // The parent's own idea of progress — what the UI would show.
    fraction: (() => { const el = document.querySelector('.rc-progress-val, .rc-pos'); return el ? el.textContent.trim() : null; })(),
  };
})()`;

/** What foliate offers on relocate vs what the reader displays. Installed once, read after a turn. */
const INSTALL_RELOCATE_SPY = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  if (!v) return false;
  window.__ixRelocate = null;
  // Bind to THIS view element. Each open creates a new <foliate-view>, so a once-only install left
  // the listener on the previous book's element and captured nothing (measured: "detail keys: none").
  if (window.__ixSpyOn !== v) {
    window.__ixSpyOn = v;
    v.addEventListener('relocate', (e) => {
      const d = e.detail || {};
      window.__ixRelocate = {
        keys: Object.keys(d).sort(),
        cfi: d.cfi || null,
        fraction: typeof d.fraction === 'number' ? Number(d.fraction.toFixed(4)) : null,
        location: d.location ? { current: d.location.current, next: d.location.next, total: d.location.total } : null,
        section: d.section ? { current: d.section.current, total: d.section.total } : null,
        pageItem: d.pageItem ? (d.pageItem.label ?? String(d.pageItem)) : null,
        tocItem: d.tocItem ? (d.tocItem.label ?? null) : null,
      };
    });
  }
  return true;
})()`;

async function activeElement(s) {
  return s.evaluate(
    `(() => {
       const a = document.activeElement;
       if (!a) return 'none';
       const tag = a.tagName.toLowerCase();
       const cls = (a.getAttribute && a.getAttribute('class')) || '';
       if (tag === 'iframe') return 'iframe(reading)';
       return tag + (cls ? '.' + cls.split(/\\s+/)[0] : '');
     })()`,
  );
}

/** Send a real key through CDP so it takes the same path a reader's keypress does. */
async function pressKey(s, key) {
  const map = {
    ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight" },
    ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft" },
    Space: { windowsVirtualKeyCode: 32, code: "Space", text: " " },
  };
  const m = map[key];
  await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: key === "Space" ? " " : key, ...m });
  if (m.text) await s.send("Input.dispatchKeyEvent", { type: "char", text: m.text, key: " " });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: key === "Space" ? " " : key, ...m });
  // 450ms was not enough when a turn crosses a SECTION boundary (the new document must load and
  // paginate), which made two real page turns look like dead keys.
  await sleep(1100);
}

async function waitForApp(s, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await s.evaluate(
      `(() => {
         if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return 'no-ipc';
         if (document.querySelector('.reader-root')) return 'reader';
         return document.querySelectorAll('.lib-card').length > 0 ? 'library' : 'no-library';
       })()`,
    );
    if (state === "library") return;
    if (state === "reader") {
      await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
    }
    await sleep(400);
  }
  throw new Error("app never reached the library");
}

/**
 * Force the reading flow mode.
 *
 * THE CHEVRONS ONLY EXIST IN PAGED MODE (`showChevrons = isPaged || isPdf`, Reader.tsx), and this
 * profile reads in scrolled mode — so the first run of this probe found no chevrons at all and
 * reported "no overlap" for a control that was not on screen. That matters beyond the harness:
 * the reported defect "the nav buttons are hidden behind the Contents list" can ONLY happen in
 * paged mode, which did not paginate at all until NAV-1 was fixed. Measuring it now means measuring
 * it in the mode where it exists.
 */
async function setFlow(s, mode) {
  await s.evaluate(
    `(async () => {
       const get = (k) => window.__TAURI_INTERNALS__.invoke('settings_get', { key: k });
       const set = (k, v) => window.__TAURI_INTERNALS__.invoke('settings_set', { key: k, value: v });
       let style = {};
       try { style = JSON.parse(await get('reading_style') || '{}') || {}; } catch {}
       style.flowMode = ${JSON.stringify(mode)};
       await set('reading_style', JSON.stringify(style));
     })()`,
  );
}

async function setUiLang(s, lang) {
  // Through the app's own setting, not a DOM poke, so the whole UI re-renders exactly as it would
  // for a reader switching language.
  // The key is `ui_lang` (i18n/index.tsx). Writing 'lang' silently did nothing, and both passes ran
  // in whatever language was already stored — so a table headed "en" was measured in Arabic.
  await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'ui_lang', value: ${JSON.stringify(lang)} }).catch(() => {})`,
  );
  await s.evaluate(`window.location.reload()`);
  await sleep(2500);
  await waitForApp(s);
}

async function openBook(s, sha) {
  const title = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books',
        { sort: 'date_added', order: 'desc', format: null, collection: null, search: null })
       .then(rows => (rows.find(b => b.id === ${JSON.stringify(sha)}) || {}).title || null)
       .catch(e => 'IPC_ERROR: ' + e)`,
  );
  if (!title || String(title).startsWith("IPC_ERROR")) return { ok: false, reason: `not in library: ${title}` };
  const clicked = await s.evaluate(
    `(() => { const want = ${JSON.stringify(title)}.trim();
       const card = [...document.querySelectorAll('.lib-card')].find(c => (c.getAttribute('title') || '').trim() === want);
       if (!card) return false; card.click(); return true; })()`,
  );
  if (!clicked) return { ok: false, reason: "no card" };
  for (let i = 0; i < 80; i++) {
    const ready = await s.evaluate(
      `(() => { const v = document.querySelector('.page-host foliate-view');
         const c = v && v.renderer && v.renderer.getContents && v.renderer.getContents()[0];
         return !!(c && c.doc && c.doc.body && (c.doc.body.textContent || '').trim().length); })()`,
    );
    if (ready) { await sleep(700); return { ok: true, title }; }
    await sleep(250);
  }
  return { ok: false, reason: "never ready" };
}

/**
 * Put the book at a KNOWN place with room to move in both directions.
 *
 * Without this the answer to "did the key turn the page?" depended on wherever the book happened to
 * resume — at the end of a section a forward key legitimately does nothing, and the failing states
 * moved between runs (fresh open passed once, failed the next; the toolbar state did the opposite).
 * That is the same defect the TTS probe had before its sections were pinned: a measurement that is
 * not reproducible cannot support a claim either way.
 */
async function pinPosition(s, fraction = 0.25) {
  await s.evaluate(
    `(() => { const v = document.querySelector('.page-host foliate-view'); if (v) v.goToFraction(${fraction}); })()`,
  );
  await waitStable(s);
}

/**
 * Wait until the renderer stops moving — two consecutive identical (section, page) reads.
 *
 * A fixed sleep is not enough and produced a nonsense measurement: sampling "before" while a jump
 * was still settling recorded the OLD page, so one forward turn appeared to move BACKWARDS
 * (page 23 → 21) and the coalescing comparison became meaningless. Anything that samples a position
 * either side of an action has to know the position had stopped changing first.
 */
async function waitStable(s, tries = 24) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const now = await s.evaluate(
      `(() => { const v = document.querySelector('.page-host foliate-view');
                const c = v && v.renderer && v.renderer.getContents && v.renderer.getContents()[0];
                if (!c) return null;
                return { section: c.index, page: v.renderer.page ?? null }; })()`,
    );
    if (now && last && now.section === last.section && now.page === last.page) return now;
    last = now;
    await sleep(250);
  }
  return last;
}

const click = async (s, sel) => {
  const ok = await s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  await sleep(600);
  return ok;
};

/**
 * Bring the reading chrome on screen the way a reader does — by MOVING THE POINTER.
 *
 * A synthetic `new MouseEvent('mousemove')` is not sufficient and produced a wrong measurement: the
 * chrome stayed hidden for the first book of each language pass, so the Contents click landed on
 * nothing and the row was recorded against a closed panel. `useChromeOnIntent` reacts to genuine
 * pointer movement, so the probe dispatches real input through CDP and then CONFIRMS the chrome is
 * shown rather than assuming the gesture worked.
 */
async function revealChrome(s, tries = 6) {
  for (let i = 0; i < tries; i++) {
    // Two positions: a single event at a static point can be coalesced away as "no movement".
    for (const [x, y] of [[540, 320], [560, 340], [580, 300]]) {
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    }
    await sleep(350);
    const shown = await s.evaluate(
      `(() => {
         const root = document.querySelector('.reader-root');
         const chrome = document.querySelector('.reader-chrome');
         if (!root || !chrome) return false;
         // The bars are translated off-screen until shown; the class is the product's own signal.
         return chrome.classList.contains('show') && !root.classList.contains('chrome-hidden');
       })()`,
    );
    if (shown) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

if (!corpusAvailable()) {
  console.error("\n  corpus not available — set %SARD_CORPUS%\n");
  process.exit(1);
}
const manifest = readManifest();
const shaOf = (file) => manifest.books.find((b) => b.file === file)?.sha256;

const problems = [];
const snap = snapshotDb(REPO, "ix");
console.log(`\n  db snapshot: ${snap}`);
let sard;
try {
  sard = await launchSard({ port: 9336 });
  if (sard.skipped) { restoreDb(snap); console.error(sard.skipped); process.exit(1); }
  const s = sard;
  await waitForApp(s);
  await setFlow(s, "paged");
  console.log(`  engine: ${(await s.evaluate("navigator.userAgent")).match(/Chrome\/[\d.]+/)?.[0] ?? "?"}\n`);

  // ── 1. GEOMETRY, in all four combinations ────────────────────────────────────────────────────
  console.log("  ── chevrons vs an open panel ────────────────────────────────────────────────");
  console.log("  ui  book   panel        left-chevron      overlap  reachable   right-chevron     overlap  reachable");
  for (const lang of ["en", "ar"]) {
    await setUiLang(s, lang);
    for (const [dirLabel, file] of [["ltr", LTR_BOOK], ["rtl", RTL_BOOK]]) {
      const sha = shaOf(file);
      const opened = sha ? await openBook(s, sha) : { ok: false, reason: "not in manifest" };
      if (!opened.ok) { console.log(`  ${lang}  ${dirLabel}    skipped — ${opened.reason}`); continue; }
      // Show the chrome with REAL pointer movement. A synthetic MouseEvent was not enough — the
      // chrome stayed hidden for the first book of each language pass, so its Contents click did
      // nothing and the row was measured against a CLOSED panel (pad=0px). A measurement taken in
      // the wrong state is worse than a missing one, so the panel is now asserted open below.
      const revealed = await revealChrome(s);
      let clicked = await click(s, ".rc-btns .rc-btn");
      // Retry once. The first Contents click after a fresh open is sometimes absorbed (the chrome is
      // still settling), and one absorbed click turned a real measurement into a skipped row.
      if (!(await s.evaluate(`!!document.querySelector('.reader-panel.show')`))) {
        await revealChrome(s);
        clicked = await click(s, ".rc-btns .rc-btn");
      }
      const g = await s.evaluate(GEOMETRY_JS);
      if (!g.panelOpen) {
        const why = await s.evaluate(
          `(() => {
             const p = document.querySelector('.reader-panel');
             const btns = [...document.querySelectorAll('.rc-btns .rc-btn')].map(b => (b.getAttribute('title') || '?'));
             return { panelInDom: !!p, panelClass: p ? p.getAttribute('class') : null, buttons: btns };
           })()`,
        );
        console.log(
          `  ${lang}  ${dirLabel}    SKIPPED — panel did not open (revealed=${revealed} clicked=${clicked} ` +
            `panelClass=${why.panelClass} buttons=[${why.buttons.join("|")}])`,
        );
        problems.push(`${lang}/${dirLabel}: could not open the Contents panel to measure`);
        await click(s, ".rc-back");
        await sleep(400);
        continue;
      }
      const fmt = (b) => (b ? `${String(b.x).padStart(4)},${String(b.y).padStart(4)} ${b.w}×${b.h}` : "—".padEnd(16));
      console.log(
        `  ${lang}  ${dirLabel}    ${String(g.panelOpen).padEnd(5)} pad=${String(g.deskPadStart).padEnd(6)} ` +
          `${fmt(g.left)}  ${String(g.leftOverlap).padStart(6)}  ${String(g.leftReachable).padEnd(8)}  ` +
          `${fmt(g.right)}  ${String(g.rightOverlap).padStart(6)}  ${String(g.rightReachable)}`,
      );
      if (g.panelOpen) {
        if (g.leftOverlap > 0 || g.rightOverlap > 0) {
          problems.push(`${lang}/${dirLabel}: a chevron overlaps the open panel (${g.leftOverlap}px² / ${g.rightOverlap}px²)`);
        }
        if (g.leftReachable === false || g.rightReachable === false) {
          problems.push(`${lang}/${dirLabel}: a chevron is not clickable at its own centre while a panel is open`);
        }
      }
      await click(s, ".rc-back");
      await sleep(400);
    }
  }

  // ── 2. KEY ROUTING, per focus state ──────────────────────────────────────────────────────────
  await setUiLang(s, "en");
  const sha = shaOf(LTR_BOOK);
  console.log("\n  ── page-turn keys, by how the reader got there ──────────────────────────────");
  console.log("  state                 focus                 ArrowRight  Space   turned?");
  const states = [
    ["fresh open", async () => {}],
    ["after toolbar click", async () => { await click(s, ".rc-btns .rc-btn"); await click(s, ".rc-btns .rc-btn"); }],
    ["panel open", async () => { await click(s, ".rc-btns .rc-btn"); }],
    ["after a TOC jump", async () => {
      await click(s, ".rc-btns .rc-btn");
      await s.evaluate(`(() => { const a = document.querySelector('.reader-panel .toc-row'); if (a) a.click(); })()`);
      await sleep(700);
    }],
    ["after desk-margin click", async () => {
      await s.evaluate(`(() => { const d = document.querySelector('.reader-desk'); if (d) d.click(); })()`);
      await sleep(300);
    }],
  ];
  for (const [label, setup] of states) {
    const opened = await openBook(s, sha);
    if (!opened.ok) { console.log(`  ${label.padEnd(20)}  skipped — ${opened.reason}`); continue; }
    await s.evaluate(INSTALL_RELOCATE_SPY);
    await pinPosition(s); // a forward key must have somewhere to go
    await setup();
    await sleep(600); // let the setup gesture settle before sampling focus/position
    const focus = await activeElement(s);
    const before = await s.evaluate(WHERE_JS);
    await pressKey(s, "ArrowRight");
    const afterArrow = await s.evaluate(WHERE_JS);
    await pressKey(s, "Space");
    const afterSpace = await s.evaluate(WHERE_JS);
    const moved = (a, b) => !!a && !!b && (a.section !== b.section || a.page !== b.page || Math.abs(a.scroll - b.scroll) > 4);
    const arrowMoved = moved(before, afterArrow);
    const spaceMoved = moved(afterArrow, afterSpace);
    console.log(
      `  ${label.padEnd(20)}  ${String(focus).padEnd(20)}  ${String(arrowMoved).padEnd(10)}  ${String(spaceMoved).padEnd(6)}  ${arrowMoved || spaceMoved}`,
    );
    if (!arrowMoved) problems.push(`keys: ArrowRight does not turn the page "${label}"`);
    await click(s, ".rc-back");
    await sleep(300);
  }

  // ── 3. TURN COALESCING ───────────────────────────────────────────────────────────────────────
  console.log("\n  ── two rapid page-turns (inside the engine's 100 ms lock) ───────────────────");
  {
    const opened = await openBook(s, sha);
    if (opened.ok) {
      // A CONTROLLED A/B from the same pinned start, because "2 turns advanced N pages" means
      // nothing on its own — page numbers reset at a section boundary (a real two-page move once
      // measured as "-5"), and a section's page count varies. One turn is the control; two rapid
      // turns must move STRICTLY FURTHER, or the second was dropped.
      // COUNT COMPLETED TURNS, not page numbers.
      //
      // `renderer.page` proved not to be a monotonic counter across a re-pin — one forward turn read
      // as 23→21 and the next run read 21→23, i.e. the numbers were not comparable between runs and
      // the "2 > 1" conclusion drawn from them was worthless. Every COMPLETED turn emits exactly one
      // relocate, so counting relocates answers the actual question — "was the second turn honoured
      // or discarded?" — with no dependence on how pages happen to be numbered.
      // Measure by CFI. Three other units were tried and every one was confounded: `renderer.page`
      // is not comparable across a re-pin (one forward turn read 23→21), locations can tie inside a
      // section, and relocate FIRES SEVERAL TIMES PER TURN (a single turn emitted 4), so counting
      // events measures animation frames rather than turns. A CFI names a POSITION IN THE TEXT: if
      // the second turn was dropped, one turn and two turns land on the same CFI; if it was
      // honoured, they cannot.
      // Anchor on an exact CFI, captured once. `goToFraction(0.25)` is NOT reproducible to the page
      // — measured, it landed on page 23 then on 21 — so two runs anchored that way start in
      // different places and cannot be compared. A CFI names one position in the text exactly.
      await pinPosition(s);
      await s.evaluate(INSTALL_RELOCATE_SPY);
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view').next(); })()`);
      await sleep(1500);
      const anchorCfi = await s.evaluate(`(window.__ixRelocate && window.__ixRelocate.cfi) || null`);

      const endCfiAfter = async (n) => {
        if (anchorCfi) {
          await s.evaluate(
            `(() => { document.querySelector('.page-host foliate-view').goTo(${JSON.stringify(anchorCfi)}); })()`,
          );
          await waitStable(s);
        } else {
          await pinPosition(s);
        }
        const start = await s.evaluate(
          `(() => { const v = document.querySelector('.page-host foliate-view'); return v.renderer.getContents()[0]?.index + ':' + (v.renderer.page ?? '?'); })()`,
        );
        await s.evaluate(INSTALL_RELOCATE_SPY);
        await s.evaluate(
          `(() => { const v = document.querySelector('.page-host foliate-view');
                    for (let i = 0; i < ${n}; i++) v.next(); })()`,
        );
        await sleep(2500); // longer than the 100 ms lock plus a section load, so a replay has landed
        const cfi = await s.evaluate(`(window.__ixRelocate && window.__ixRelocate.cfi) || null`);
        return { start, cfi };
      };

      const runTurns = async (n) => {
        await pinPosition(s);
        await s.evaluate(INSTALL_RELOCATE_SPY);
        const from = await waitStable(s); // sample only once the pin has actually stopped moving
        // Issued in ONE task, so the second call lands while the first still holds the 100 ms lock.
        await s.evaluate(
          `(() => { const v = document.querySelector('.page-host foliate-view');
                    for (let i = 0; i < ${n}; i++) v.next(); })()`,
        );
        await sleep(1200);
        const to = await waitStable(s);
        const rel = await s.evaluate(`window.__ixRelocate`);
        return { from, to, loc: rel?.location?.current ?? null };
      };
      const a = await endCfiAfter(1);
      const b = await endCfiAfter(2);
      console.log(`  1 turn  from ${a.start} → ${a.cfi ? a.cfi.slice(0, 46) : "(no cfi)"}`);
      console.log(`  2 turns from ${b.start} → ${b.cfi ? b.cfi.slice(0, 46) : "(no cfi)"}`);
      if (a.start !== b.start) {
        // Do not draw a conclusion from two different starting points — say so instead.
        console.log(`  ⚠ the two runs started at different positions (${a.start} vs ${b.start}) — not comparable`);
        problems.push(`coalescing: could not pin the same start twice (${a.start} vs ${b.start})`);
      } else if (!a.cfi || !b.cfi) {
        problems.push("coalescing: no CFI reported — the probe cannot measure turns");
      } else if (a.cfi === b.cfi) {
        problems.push("coalescing: 1 turn and 2 turns landed on the SAME position — the second was dropped");
      } else {
        console.log("  ✓ two turns landed further than one — the second was honoured, not dropped");
      }
      await click(s, ".rc-back");
    }
  }

  // ── 3b. ARROW SEMANTICS — does → go FORWARD in reading order, in both directions? ────────────
  //
  // Reported from real reading: "the arrows are reversed". The unit here must be reading order, not
  // geometry — `location.current` is byte-derived and increases with the text, so it answers "did we
  // move forward in the BOOK?" without caring which way the pages visually slide. Both an LTR and an
  // RTL book are measured, because that is the axis the defect lives on.
  console.log("\n  ── arrow direction (→ must be FORWARD in reading order) ─────────────────────");
  console.log("  book   ArrowRight        ArrowLeft");
  for (const [dirLabel, file] of [["ltr", LTR_BOOK], ["rtl", RTL_BOOK]]) {
    const bsha = shaOf(file);
    const opened = bsha ? await openBook(s, bsha) : { ok: false, reason: "not in manifest" };
    if (!opened.ok) { console.log(`  ${dirLabel}    skipped — ${opened.reason}`); continue; }
    // Read the location from the relocate the PIN itself emits. The first version of this forced a
    // relocate with `v.next(); v.prev()`, which is both a poor sample and — now that turns coalesce
    // — a round trip whose second half replays on release, so it measured its own interference.
    // FRACTION, not location: a location spans ~1KB of text, so a single page turn can stay inside
    // one and read as "no move" — measured, LTR ArrowRight showed 32 → 32 for a turn that worked.
    // The relocate fraction is a float over the whole book and moves with every page.
    const locFromSpy = async () => (await s.evaluate(`window.__ixRelocate`))?.fraction ?? null;
    await s.evaluate(INSTALL_RELOCATE_SPY);
    await pinPosition(s);
    const before = await locFromSpy();
    await pressKey(s, "ArrowRight");
    const afterRight = await locFromSpy();
    const rightDelta = before !== null && afterRight !== null ? afterRight - before : null;
    await pressKey(s, "ArrowLeft");
    const afterLeft = await locFromSpy();
    const leftDelta = afterRight !== null && afterLeft !== null ? afterLeft - afterRight : null;
    const word = (d) => (d === null ? "?" : d > 0 ? "FORWARD" : d < 0 ? "BACKWARD" : "no move");
    console.log(`  ${dirLabel}    ${word(rightDelta).padEnd(16)}  ${word(leftDelta)}   (loc ${before} → ${afterRight} → ${afterLeft})`);
    // "no move" and "could not measure" are FAILURES here, not neutral outcomes: a page-turn key
    // that does nothing is the very complaint this section exists to catch, and letting it pass
    // silently is how a broken control reaches a reader with a green gate behind it.
    if (rightDelta === null || leftDelta === null) {
      problems.push(`arrows/${dirLabel}: could not measure arrow direction (no location reported)`);
    } else {
      if (rightDelta < 0) problems.push(`arrows/${dirLabel}: ArrowRight moved BACKWARD in reading order`);
      if (rightDelta === 0) problems.push(`arrows/${dirLabel}: ArrowRight did not move at all`);
      if (leftDelta > 0) problems.push(`arrows/${dirLabel}: ArrowLeft moved FORWARD in reading order`);
      if (leftDelta === 0) problems.push(`arrows/${dirLabel}: ArrowLeft did not move at all`);
    }
    await click(s, ".rc-back");
    await sleep(300);
  }

  // ── 4. WHAT RELOCATE OFFERS vs WHAT IS SHOWN ─────────────────────────────────────────────────
  console.log("\n  ── the relocate payload foliate provides ────────────────────────────────────");
  {
    const opened = await openBook(s, sha);
    if (opened.ok) {
      await s.evaluate(INSTALL_RELOCATE_SPY);
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view').next(); })()`);
      await sleep(900);
      const rel = await s.evaluate(`window.__ixRelocate`);
      console.log(`  detail keys : ${rel?.keys?.join(", ") ?? "(none captured)"}`);
      console.log(`  location    : ${rel?.location ? `${rel.location.current} / ${rel.location.total} (next ${rel.location.next})` : "—"}`);
      console.log(`  section     : ${rel?.section ? `${rel.section.current} / ${rel.section.total}` : "—"}`);
      console.log(`  pageItem    : ${rel?.pageItem ?? "— (book has no page-list)"}`);
      const shown = await s.evaluate(
        `(() => { const el = document.querySelector('.rc-pos, .rc-progress-val, .rc-progress');
                  return el ? el.textContent.trim() : '(no position readout in the chrome)'; })()`,
      );
      console.log(`  shown to the reader: ${shown}`);
      await click(s, ".rc-back");
    }
  }

  console.log("");
  if (problems.length) {
    console.log(`  ${GATE ? "✗" : "⚠"} ${problems.length} interaction problem(s):\n`);
    for (const p of problems) console.log(`      ${p}`);
    console.log("");
  } else {
    console.log("  ✓ no interaction problem detected\n");
  }
} finally {
  if (sard) await sard.close();
  await restoreDb(snap);
  console.log("  db restored from snapshot (profile untouched)\n");
}
process.exit(GATE && problems.length ? 1 : 0);
