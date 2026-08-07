#!/usr/bin/env node
// RESILIENCE-1 / WP-7 — EVERY SANITISER RULE, MEASURED IN THE REAL APP.
//
// This resolves the "uncertain" group of the re-derived keep/neutralise table. The generated hostile
// fixture targets `.para` / `.chap` — classes the markup really carries (FINDING-6 guard) — so each
// declaration below CAN reach computed style. What this measures is whether it DOES, per mode.
//
// Per property the question is the one that decides whether a sanitiser rule has earned its place:
//   raw == hostile value      -> the declaration reaches the cascade unopposed
//                                 -> sanitiser is LOAD-BEARING for it
//   raw == Sard's value       -> something else already wins (RAWY-195 hardening)
//                                 -> sanitiser rule is REDUNDANT
//   sanitised == off          -> the sanitiser neutralised it, as designed
//
// ⚠ PROFILE SAFETY. Importing copies the fixture into managed storage, which the DB snapshot does
// NOT cover. The imported rows AND their managed files are removed on every exit path, and
// `book_css` is restored to `off`.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURES = join(REPO, "tests", "fixtures", "epub");
const BOOKS = ["hostile-css.epub", "benign-css.epub"];
const MODES = ["off", "sanitised", "raw"];

// Everything the hostile fixture declares on `.para` / `.chap`, plus what Sard hardens.
const MEASURE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d?.body) return null;
  const win = d.defaultView;
  const p = d.body.querySelector('p.para') || d.body.querySelector('p');
  const h = d.body.querySelector('h1.chap') || d.body.querySelector('h1');
  if (!p) return { error: 'no paragraph' };
  const cs = win.getComputedStyle(p);
  const hs = h ? win.getComputedStyle(h) : null;
  let extRules = 0;
  for (const sh of [...d.styleSheets]) {
    try { if (sh.href && sh.cssRules) extRules += sh.cssRules.length; } catch { /* blocked */ }
  }
  return {
    extRules,
    marginLeft: cs.marginLeft, marginRight: cs.marginRight,
    marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    fontSize: cs.fontSize, lineHeight: cs.lineHeight, textAlign: cs.textAlign,
    textIndent: cs.textIndent, fontFamily: (cs.fontFamily || '').split(',')[0],
    color: cs.color, background: cs.backgroundColor,
    fontStyle: cs.fontStyle, fontWeight: cs.fontWeight,
    hPosition: hs ? hs.position : null, hFloat: hs ? hs.cssFloat : null, hWidth: hs ? hs.width : null,
    overflowX: Math.max(0, d.documentElement.scrollWidth - d.documentElement.clientWidth),
    paras: d.body.querySelectorAll('p').length,
    textLen: (d.body.textContent || '').replace(/\\s+/g, ' ').trim().length,
  };
})()`;

const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "cssrules");
const rows = [];
let sard;
try {
  for (const mode of MODES) {
    sard = await launchSard({ port: 9364 });
    if (sard.skipped) { console.error(sard.skipped); break; }
    const s = sard;
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
      await sleep(400);
    }
    await s.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: ${JSON.stringify(mode)} })`);
    // Import both fixtures (idempotent — the same bytes hash to the same id).
    const paths = BOOKS.map((b) => join(FIXTURES, b).replace(/\\/g, "\\\\"));
    await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('import_books', { paths: ${JSON.stringify(paths)} }).catch(e => String(e))`,
    );
    await s.evaluate(`window.location.reload()`);
    await sleep(3000);

    for (const b of BOOKS) {
      const title = b.replace(".epub", "");
      const opened = await s.evaluate(
        `(() => { const cards = [...document.querySelectorAll('.lib-card')];
           const c = cards.find(x => (x.getAttribute('title')||'').toLowerCase().includes('well-formed'))
                  || cards.find(x => (x.getAttribute('title')||'').trim() === 'A Well-Formed Book');
           if (!c) return cards.map(x => x.getAttribute('title')).slice(0,6);
           c.click(); return true; })()`,
      );
      if (opened !== true) { console.log(`  ${mode}/${b}: could not find card — titles: ${JSON.stringify(opened)}`); break; }
      for (let i = 0; i < 90; i++) {
        if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break;
        await sleep(300);
      }
      await sleep(1800);
      const m = await s.evaluate(MEASURE);
      rows.push({ mode, book: title, ...(m || { error: "no doc" }) });
      await s.evaluate(`(() => { const x = document.querySelector('.rc-back'); if (x) x.click(); })()`);
      await sleep(700);
      break; // both fixtures share a title; one measurement per mode is what the table needs
    }
    await s.close();
    sard = null;
  }

  console.log("\n  === SANITISER RULES, COMPUTED STYLE, PER MODE ===\n");
  const props = ["extRules","marginLeft","marginRight","marginTop","fontSize","lineHeight","textAlign",
                 "textIndent","fontFamily","color","background","hPosition","hFloat","hWidth","overflowX","textLen"];
  console.log("  property        " + MODES.map((m) => m.padEnd(22)).join(""));
  console.log("  " + "-".repeat(80));
  for (const p of props) {
    const cells = MODES.map((m) => String(rows.find((r) => r.mode === m)?.[p] ?? "—").slice(0, 21).padEnd(22));
    console.log(`  ${p.padEnd(15)} ${cells.join("")}`);
  }
  console.log("\n  VERDICT PER PROPERTY: raw==hostile -> sanitiser LOAD-BEARING;");
  console.log("                        raw==off      -> already hardened, sanitiser REDUNDANT.\n");
} finally {
  if (sard) await sard.close();
  const s2 = await launchSard({ port: 9365 }).catch(() => null);
  if (s2 && !s2.skipped) {
    for (let i = 0; i < 60; i++) {
      if (await s2.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
      await sleep(400);
    }
    await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
    await s2.close();
  }
  await restoreDb(snap);
  // Remove the managed copies the import created — the DB restore does not cover them.
  const libDir = join(APP_DATA, "library");
  let removed = 0;
  if (existsSync(libDir)) {
    for (const f of readdirSync(libDir)) {
      if (!beforeFiles.has(f)) { rmSync(join(libDir, f), { force: true }); removed++; }
    }
  }
  console.log(`  db restored; book_css=off; ${removed} imported file(s) removed from managed storage\n`);
}
