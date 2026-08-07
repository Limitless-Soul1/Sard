#!/usr/bin/env node
// RESILIENCE-1 / WP-6 — the TOC & SPINE probe.
//
// Measures, per corpus book, the two things WP-6 acts on and the material it would act WITH:
//
//   flags     WP-2's `toc_degenerate` / `spine_fragmented`, read from the database — the real stored
//             values, not a re-derivation, so the gate tests the same numbers the product branches on.
//   toc       how many entries the reader is actually offered today.
//   headings  how many linear sections carry an h1–h6. This decides which of 6A's two tiers applies:
//             real headings are preferred, and a book with none must fall back to section labels.
//             Measuring it FIRST prevents building tier 1 on the assumption that it usually works.
//
//   node tests/harness/toc-shape.mjs
//
// ⚠ Drives the REAL app against the REAL profile — same snapshot/restore contract as the others.

import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!corpusAvailable()) {
  console.error("\n  corpus not available — set %SARD_CORPUS%\n");
  process.exit(1);
}
const manifest = readManifest();

const snap = snapshotDb(REPO, "toc");
console.log(`\n  db snapshot: ${snap}`);
let sard;
try {
  sard = await launchSard({ port: 9341 });
  if (sard.skipped) { await restoreDb(snap); console.error(sard.skipped); process.exit(1); }
  const s = sard;
  for (let i = 0; i < 80; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }

  const rows = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books',
        { sort: 'title', order: 'asc', format: null, collection: null, search: null })
       .then(r => r.map(b => ({ id: b.id, title: b.title, format: b.format,
                                deg: b.toc_degenerate, frag: b.spine_fragmented })))`,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  console.log("\n  book                                        spine   toc  degenerate  fragmented");
  console.log("  " + "-".repeat(84));
  let flagged = 0;
  for (const b of manifest.books) {
    if (b.format !== "epub") continue;
    const row = byId.get(b.sha256);
    const spine = b.traits?.spineCount ?? "?";
    const toc = b.traits?.tocEntries ?? "?";
    const deg = row ? (row.deg ? "YES" : "no") : "not in library";
    const frag = row ? (row.frag ? "YES" : "no") : "";
    if (row?.deg || row?.frag) flagged++;
    console.log(
      `  ${b.file.padEnd(42)} ${String(spine).padStart(5)} ${String(toc).padStart(5)}  ` +
        `${deg.padEnd(11)} ${frag}`,
    );
  }
  console.log(`\n  ${flagged} book(s) carry at least one structural flag.`);

  // ── IS THE HEADING DETECTOR EARNING ITS PLACE? ────────────────────────────────────────────────
  //
  // The detector exists to REJECT a heading set that is machine-generated. It is only worth its
  // complexity if two things are true across real books:
  //   1. it NEVER fires on a normal book (a false positive would delete a good contents list), and
  //   2. preferring headings is sometimes RIGHT — otherwise "always use text" is simpler and
  //      produces the same output, and the detector is dead weight.
  // Both are measured here, over every corpus book, not argued.
  if (process.argv.includes("--headings")) {
    console.log("\n  book                                        secs  headings  distinct  dominance  verdict");
    console.log("  " + "-".repeat(96));
    for (const b of manifest.books) {
      if (b.format !== "epub") continue;
      const row = byId.get(b.sha256);
      if (!row) continue;
      for (let i = 0; i < 12; i++) {
        if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break;
        await s.evaluate(`(() => { const x = document.querySelector('.rc-back'); if (x) x.click(); })()`);
        await sleep(500);
      }
      const opened = await s.evaluate(
        `(() => { const want = ${JSON.stringify("")} ; return true; })()`,
      );
      void opened;
      const clicked = await s.evaluate(
        `(() => { const want = ${JSON.stringify(row.title ?? "")}.trim();
           const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'').trim() === want);
           if (!c) return false; c.click(); return true; })()`,
      );
      if (!clicked) { console.log(`  ${b.file.padEnd(42)} could not open`); continue; }
      for (let i = 0; i < 80; i++) {
        if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break;
        await sleep(300);
      }
      await sleep(900);
      const r = await s.evaluate(
        `(async () => {
           const v = document.querySelector('.page-host foliate-view');
           const secs = v?.book?.sections ?? [];
           const heads = [];
           let n = 0;
           for (const sec of secs) {
             if (sec.linear === 'no') continue;
             n++;
             if (n > 400) break;
             let doc = null;
             try { doc = await sec.createDocument(); } catch { continue; }
             const h = doc?.body?.querySelector('h1,h2,h3,h4,h5,h6');
             const t = (h?.textContent || '').replace(/\\s+/g, ' ').trim();
             if (t) heads.push(t);
           }
           const strip = (x) => x.replace(/[0-9\\u0660-\\u0669\\u06F0-\\u06F9]+/g, '#').replace(/\\s+/g, ' ').trim();
           const forms = heads.map(strip);
           const counts = {};
           for (const f of forms) counts[f] = (counts[f] || 0) + 1;
           const top = Math.max(0, ...Object.values(counts));
           return { secs: n, heads: heads.length, distinct: new Set(forms).size,
                    dominance: heads.length ? top / heads.length : 0 };
         })()`,
      );
      const generated = r.heads >= 8 && r.dominance >= 0.9;
      console.log(
        `  ${b.file.padEnd(42)} ${String(r.secs).padStart(4)} ${String(r.heads).padStart(9)} ` +
          `${String(r.distinct).padStart(9)} ${r.dominance.toFixed(2).padStart(10)}  ${generated ? "GENERATED" : r.heads ? "real headings" : "(none)"}`,
      );
      await s.evaluate(`(() => { const x = document.querySelector('.rc-back'); if (x) x.click(); })()`);
      await sleep(600);
    }
  }

  // WHAT MATERIAL DOES 6A HAVE? Tier 1 prefers a real h1–h6 per section; tier 2 falls back to the
  // first ~40 characters of the section's text. Which tier a book lands on cannot be assumed — the
  // plan predicts "the Word book yields nothing", and that prediction is worth checking before any
  // code is written on top of it. Sections are read through foliate's own `createDocument()`, the
  // same call in-book search uses, so this measures what the product could actually reach.
  for (const flaggedId of rows.filter((r) => r.deg).map((r) => r.id)) {
    const file = manifest.books.find((b) => b.sha256 === flaggedId)?.file ?? flaggedId.slice(0, 12);
    const title = byId.get(flaggedId)?.title;
    // Return to the library first. A reader left open from the previous iteration hides the grid, so
    // the card lookup finds nothing and the book is reported as "could not open" — a harness fault
    // that reads exactly like a book fault.
    for (let i = 0; i < 12; i++) {
      if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break;
      await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
      await sleep(500);
    }
    const clicked = await s.evaluate(
      `(() => { const want = ${JSON.stringify(title)}.trim();
         const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'').trim() === want);
         if (!c) return false; c.click(); return true; })()`,
    );
    if (!clicked) { console.log(`\n  ${file}: could not open`); continue; }
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break;
      await sleep(300);
    }
    await sleep(1200);
    const probe = await s.evaluate(
      `(async () => {
         const v = document.querySelector('.page-host foliate-view');
         const secs = v?.book?.sections ?? [];
         let linear = 0, withHeading = 0, withText = 0, empty = 0;
         const samples = [];
         for (let i = 0; i < secs.length; i++) {
           const sec = secs[i];
           if (sec.linear === 'no') continue;
           linear++;
           let doc = null;
           try { doc = await sec.createDocument(); } catch { empty++; continue; }
           const h = doc?.body?.querySelector('h1,h2,h3,h4,h5,h6');
           const txt = (doc?.body?.textContent || '').replace(/\\s+/g, ' ').trim();
           if (h && (h.textContent || '').trim()) { withHeading++; if (samples.length < 3) samples.push('H: ' + h.textContent.trim().slice(0, 40)); }
           else if (txt) { withText++; if (samples.length < 3) samples.push('T: ' + txt.slice(0, 40)); }
           else empty++;
         }
         return { total: secs.length, linear, withHeading, withText, empty, samples };
       })()`,
    );
    console.log(`\n  ${file}`);
    console.log(`    sections ${probe.total} (linear ${probe.linear}) · with a heading ${probe.withHeading} · text-only ${probe.withText} · empty ${probe.empty}`);
    console.log(`    tier that applies: ${probe.withHeading > 0 ? "1 — real headings" : "2 — section labels"}`);
    for (const smp of probe.samples) console.log(`      ${smp}`);
    // THE SHAPE OF THE LABELS, not just their count. A detector for "auto-generated" headings has to
    // be designed against the real strings, and it has to be provably unable to match a genuine
    // chapter-title set — so collapse every heading by stripping its digits and see how many
    // DISTINCT forms remain. A converter emitting "Chapter-734 0" collapses to one form; real
    // chapter titles collapse to nearly as many forms as there are chapters.
    if (probe.withHeading > 0) {
      const shape = await s.evaluate(
        `(async () => {
           const v = document.querySelector('.page-host foliate-view');
           const secs = v?.book?.sections ?? [];
           const heads = [];
           for (const sec of secs) {
             if (sec.linear === 'no') continue;
             let doc = null;
             try { doc = await sec.createDocument(); } catch { continue; }
             const h = doc?.body?.querySelector('h1,h2,h3,h4,h5,h6');
             const txt = (h?.textContent || '').replace(/\\s+/g, ' ').trim();
             if (txt) heads.push(txt);
           }
           const stripped = heads.map(t => t.replace(/[0-9\\u0660-\\u0669\\u06F0-\\u06F9]+/g, '#').replace(/\\s+/g, ' ').trim());
           const counts = {};
           for (const f of stripped) counts[f] = (counts[f] || 0) + 1;
           const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
           return { heads: heads.length, distinctRaw: new Set(heads).size, distinctStripped: new Set(stripped).size, top,
                    first3: heads.slice(0, 3) };
         })()`,
      );
      console.log(`    headings ${shape.heads} · distinct raw ${shape.distinctRaw} · distinct after stripping digits ${shape.distinctStripped}`);
      for (const [form, n] of shape.top) console.log(`      ${String(n).padStart(4)} × "${form}"`);
    }
    // WP-6A END-TO-END: what does the Contents panel actually OFFER now? Read from the rendered
    // panel rather than from the module — a rule that is correct in isolation but never reaches the
    // UI is exactly the failure this is here to catch.
    await sleep(2500); // the spine walk runs off the critical path, after the book is readable
    await s.evaluate(`(() => { const b = document.querySelector('.rc-btns .rc-btn'); if (b) b.click(); })()`);
    await sleep(1500);
    const shown = await s.evaluate(
      `(() => {
         const rows = [...document.querySelectorAll('.reader-panel .toc-row')];
         const note = document.querySelector('.rp-synth-note');
         return {
           rows: rows.length,
           note: note ? note.textContent.trim() : null,
           first: rows.slice(0, 3).map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44)),
         };
       })()`,
    );
    console.log(`    CONTENTS PANEL -> ${shown.rows} row(s)`);
    console.log(`      note: ${shown.note ?? "(none - presented as the book's own)"}`);
    for (const r of shown.first) console.log(`      - ${r}`);

    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
    await sleep(700);
  }
  console.log(
    "\n  READ THIS AS: a book flagged `degenerate` is one where the Contents panel is useless today —\n" +
      "  WP-6A synthesises entries for exactly these, and must leave every other book untouched.\n",
  );
} finally {
  if (sard) await sard.close();
  await restoreDb(snap);
  console.log("  db restored from snapshot (profile untouched)\n");
}
