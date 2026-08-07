#!/usr/bin/env node
// RESILIENCE-1 / WP-7 — THE THREE MODES, IN THE REAL APPLICATION.
//
// This is a FALSIFICATION test, not a validation pass. The sanitiser's entire rationale is that
// `word-generated--a4` carries `margin: 0 369pt 0 -84.8pt`, and that in a ~600px column the negative
// left margin pushes content outside the box where foliate's `overflow: hidden` clips it away.
//
// If `raw` does NOT clip that book, the rationale is WRONG and the design needs re-examining. That
// is the outcome this harness is built to detect — it is looking for evidence against WP-7, not for.
//
// Measured per (book × mode), from the live rendered document:
//   marginLeft/Right  the computed margin actually reaching the frame  (raw must show the pt values)
//   textLen           visible text length            (a drop between modes = content lost)
//   overflowX         scrollWidth > clientWidth      (content pushed outside the column)
//   pages/columns     foliate's own pagination       (a collapse means fragmentation broke)
//   sheets            external sheets contributing rules
//
//   node tests/harness/css-modes.mjs
//
// ⚠ Drives the REAL app against the REAL profile. Restores book_css to `off` on every exit path.

import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = ["off", "sanitised", "raw"];

// The hostile book first, then two controls with real stylesheets.
// CORRECTED: the hostile `margin: 0 369pt 0 -84.8pt` lives in unknown-title, NOT a4 (a4 only has
// `margin: 0 5pt`). The first run of this harness targeted a4 and therefore could never have
// detected clipping — an invalid falsification test, and a reminder to verify the fixture carries
// the defect before drawing conclusions from its absence.
const BOOKS = ["word-generated--unknown-title.epub", "word-generated--a4.epub", "control-wellformed--alice.epub"];

const MEASURE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d?.body) return null;
  const win = d.defaultView;
  const ps = [...d.body.querySelectorAll('p')];
  const cs = ps.length ? win.getComputedStyle(ps[0]) : null;
  // Distinct horizontal positions = how many columns the content actually occupies.
  const lefts = new Set(ps.map(p => Math.round(p.getBoundingClientRect().left)));
  let reachable = 0;
  for (const sh of [...d.styleSheets]) {
    try { if (sh.href && sh.cssRules) reachable += sh.cssRules.length; } catch { /* blocked */ }
  }
  return {
    section: c.index,
    // COUNT OF <p> ELEMENTS — not a count of logical paragraphs. A book may structure its text with
    // <div> and carry no <p> at all: measured, poetry-rtl--shawqiyyat has 208 <div> and 1 <p> per
    // section, and this number read as 1. That was filed as a paragraph-extraction defect (FINDING-5)
    // and was an artifact of the name. The reading pipeline handles it correctly — 192 units, 192
    // with ranges, 0 null. Keep the name honest so the same false finding cannot be filed again.
    pTags: ps.length,
    textLen: (d.body.textContent || '').replace(/\\s+/g, ' ').trim().length,
    marginLeft: cs ? cs.marginLeft : null,
    marginRight: cs ? cs.marginRight : null,
    fontSize: cs ? cs.fontSize : null,
    textAlign: cs ? cs.textAlign : null,
    overflowX: Math.max(0, d.documentElement.scrollWidth - d.documentElement.clientWidth),
    pages: v.renderer.pages ?? null,
    columns: lefts.size,
    externalRules: reachable,
  };
})()`;

if (!corpusAvailable()) { console.error("\n  corpus not available\n"); process.exit(1); }
const manifest = readManifest();
const shaOf = (f) => manifest.books.find((b) => b.file === f)?.sha256;

const snap = snapshotDb(REPO, "cssmodes");
const findings = [];
let sard;
try {
  for (const mode of MODES) {
    sard = await launchSard({ port: 9360 });
    if (sard.skipped) { console.error(sard.skipped); break; }
    const s = sard;
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
      await sleep(400);
    }
    await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: ${JSON.stringify(mode)} })`,
    );
    await s.evaluate(`window.location.reload()`);
    await sleep(3000);

    console.log(`\n  ── book_css = ${mode} ${"─".repeat(58 - mode.length)}`);
    console.log("  book                                   <p>tags  textLen  marginLeft  overflowX  pages  cols  extRules");
    for (const file of BOOKS) {
      const id = shaOf(file);
      if (!id) { console.log(`  ${file.padEnd(38)} not in manifest`); continue; }
      for (let i = 0; i < 12; i++) {
        if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break;
        await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
        await sleep(500);
      }
      const title = await s.evaluate(
        `window.__TAURI_INTERNALS__.invoke('library_list_books', { sort:'title', order:'asc', format:null, collection:null, search:null })
           .then(r => (r.find(b => b.id === ${JSON.stringify(id)}) || {}).title || '')`,
      );
      const ok = await s.evaluate(
        `(() => { const want = ${JSON.stringify(String(title))}.trim();
           const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'').trim() === want);
           if (!c) return false; c.click(); return true; })()`,
      );
      if (!ok) { console.log(`  ${file.padEnd(38)} could not open`); continue; }
      for (let i = 0; i < 90; i++) {
        if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break;
        await sleep(300);
      }
      await sleep(1500);
      await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view'); if (v) v.goToFraction(0.25); })()`);
      await sleep(2000);
      const m = await s.evaluate(MEASURE);
      if (!m) { console.log(`  ${file.padEnd(38)} no document`); continue; }
      console.log(
        `  ${file.padEnd(38)} ${String(m.pTags).padStart(7)} ${String(m.textLen).padStart(8)} ` +
          `${String(m.marginLeft).padStart(11)} ${String(m.overflowX).padStart(10)} ` +
          `${String(m.pages).padStart(6)} ${String(m.columns).padStart(5)} ${String(m.externalRules).padStart(9)}`,
      );
      findings.push({ mode, file, ...m });
      await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
      await sleep(700);
    }
    await s.close();
    sard = null;
  }

  // ── the falsification check ──────────────────────────────────────────────────────────────────
  console.log("\n  ── ANALYSIS ────────────────────────────────────────────────────────────────");
  for (const file of BOOKS) {
    const byMode = Object.fromEntries(findings.filter((f) => f.file === file).map((f) => [f.mode, f]));
    if (!byMode.off || !byMode.raw) continue;
    const dText = byMode.raw.textLen - byMode.off.textLen;
    const dOver = byMode.raw.overflowX - byMode.off.overflowX;
    console.log(`  ${file}`);
    console.log(`    textLen  off=${byMode.off.textLen}  sanitised=${byMode.sanitised?.textLen ?? "?"}  raw=${byMode.raw.textLen}   (raw-off ${dText})`);
    console.log(`    margin   off=${byMode.off.marginLeft}  sanitised=${byMode.sanitised?.marginLeft ?? "?"}  raw=${byMode.raw.marginLeft}`);
    console.log(`    overflow off=${byMode.off.overflowX}  sanitised=${byMode.sanitised?.overflowX ?? "?"}  raw=${byMode.raw.overflowX}   (raw-off ${dOver})`);
    console.log(`    extRules off=${byMode.off.externalRules}  sanitised=${byMode.sanitised?.externalRules ?? "?"}  raw=${byMode.raw.externalRules}`);
  }
  console.log(
    "\n  READ THIS AS: for word-generated--a4, `raw` was PREDICTED to show a negative/pt margin and\n" +
      "  overflow. If it does not, the sanitiser's stated rationale is wrong and must be re-examined.\n",
  );
} finally {
  if (sard) await sard.close();
  // Restore the shipping default before touching the profile back.
  const s2 = await launchSard({ port: 9361 }).catch(() => null);
  if (s2 && !s2.skipped) {
    for (let i = 0; i < 60; i++) {
      if (await s2.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
      await sleep(400);
    }
    await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
    await s2.close();
  }
  await restoreDb(snap);
  console.log("  db restored; book_css back to off\n");
}
