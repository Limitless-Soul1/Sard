#!/usr/bin/env node
// RESILIENCE-1 — the TTS TRACKING probe.
//
// Reported: for one book, Edge TTS speaks normally but the word/sentence highlight never appears.
// This measures the WHOLE synchronisation pipeline in the REAL binary, in document order, and
// reports the FIRST stage that diverges — rather than reasoning about which stage looks suspect.
//
// The pipeline, and what this checks at each stage:
//
//   1. chapter load        the renderer has a document with text
//   2. container scan      `doc.body.querySelectorAll(CONTAINER)` — the leaf-block walk's input
//   3. leaf selection      which of those survive the leaf / hidden / placeholder filters
//   4. segmentation        Intl.Segmenter yields speakable units
//   5. DOM mapping         each unit carries a live Range  ← the karaoke/spotlight prerequisite
//   6. geometry            those Ranges produce non-empty client rects to paint
//
// Stage 5 is the one the reader actually sees: `getChapterUnits` returns `{text, range}`, the TTS
// queue speaks `text`, and the overlay paints `range`. A unit with `range: null` is spoken and
// never highlighted — audible, invisible. That asymmetry is exactly the reported symptom, so the
// probe prints the null-range count per book instead of a pass/fail.
//
//   node tests/harness/tts-track.mjs                 # every corpus book + the reported one
//   node tests/harness/tts-track.mjs --book=<id>     # one book by library id
//
// ⚠ Drives the REAL app against the REAL profile — same snapshot/restore contract as
// byte-identity.mjs. See that file's header.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs"; // the ONE real-profile guard
import { corpusAvailable, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");

// The reported book — "داو الخالد العجيب", a .txt→EPUB conversion. Named here so the probe covers it
// even though it is not (yet) in the regression corpus.
const REPORTED = "2575c25387129084e7aa174a10d46aa0c7a3e1f54e311cf3d708e09aa8326030";



// ---------------------------------------------------------------------------
// The probe, evaluated INSIDE the app. It re-implements the product's own walk so it can report
// each stage separately — the product returns only the finished units, which is precisely what
// makes this failure invisible from the outside.
// ---------------------------------------------------------------------------

const PROBE_JS = `(() => {
  const view = document.querySelector('.page-host foliate-view');
  if (!view) return { error: 'no foliate-view' };
  const contents = view.renderer && view.renderer.getContents ? view.renderer.getContents() : null;
  const c = contents && contents[0];
  const doc = c && c.doc;
  if (!doc || !doc.body) return { error: 'no document' };

  // Transcribed from FoliateController.getChapterUnits — kept in sync deliberately, because the
  // point is to observe THAT walk, not an idealised one.
  const CONTAINER = "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article";
  const win = doc.defaultView;
  const norm = (s) => s.replace(/\\s+/g, " ").trim();
  const isHidden = (el) => {
    const cs = win && win.getComputedStyle(el);
    return !!cs && (cs.visibility === 'hidden' || cs.display === 'none');
  };
  const hasSpeech = (s) => /[\\p{L}\\p{N}]/u.test(s);

  const bodyText = norm(doc.body.textContent || "");
  const all = doc.body.querySelectorAll(CONTAINER);

  // Stage 3: which containers survive each filter, counted separately so a filter that eats
  // everything is distinguishable from a scan that found nothing to begin with.
  let leaves = 0, hidden = 0, placeholder = 0, empty = 0;
  for (const el of all) {
    if (el.querySelector(CONTAINER)) continue;      // not a leaf
    if (isHidden(el)) { hidden++; continue; }
    if (el.closest('.sard-title-ph')) { placeholder++; continue; }
    if (!(el.textContent || '').trim()) { empty++; continue; }
    leaves++;
  }

  // Stage 4/5 is measured from the PRODUCT (see the __sardTrackStats block below), not from here.
  // The walk below is kept only to report the container/leaf counts that FEED it.
  const Seg = Intl.Segmenter;
  const seg = Seg ? new Seg(doc.documentElement.lang || 'en', { granularity: 'sentence' }) : null;

  const units = [];
  const segmentBlock = (el) => {
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [], strs = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.length) { nodes.push(n); strs.push(n.data); }
    }
    if (!nodes.length) return;
    const full = strs.join("");
    if (!full.trim()) return;
    if (!seg) { const t = norm(full); if (hasSpeech(t)) units.push({ text: t, ranged: true }); return; }
    for (const part of seg.segment(full)) {
      const t = norm(part.segment);
      if (hasSpeech(t)) units.push({ text: t, ranged: true });
    }
  };

  let anyLeaf = false;
  for (const el of all) {
    if (!el.querySelector(CONTAINER) && !isHidden(el) && !el.closest('.sard-title-ph') && (el.textContent || '').trim()) {
      anyLeaf = true;
      segmentBlock(el);
    }
  }
  let fellBack = false;
  if (!anyLeaf) {
    // THE FALLBACK. Text is produced, ranges are not — "honest no-highlight" in the product's words.
    fellBack = true;
    if (hasSpeech(bodyText)) {
      if (seg) {
        for (const part of seg.segment(bodyText)) {
          const t = norm(part.segment);
          if (hasSpeech(t)) units.push({ text: t, ranged: false });
        }
      } else units.push({ text: bodyText, ranged: false });
    }
  }

  const ranged = units.filter(u => u.ranged).length;

  // What the chapter is actually built from, so the STRUCTURAL cause is visible and not inferred.
  const tags = {};
  for (const el of doc.body.querySelectorAll('*')) {
    tags[el.tagName.toLowerCase()] = (tags[el.tagName.toLowerCase()] || 0) + 1;
  }
  const topLevelText = [...doc.body.childNodes]
    .filter(n => n.nodeType === 3 && n.data.trim()).length;

  return {
    section: c.index,
    bodyChars: bodyText.length,
    containers: all.length,
    leaves, hidden, placeholder, empty,
    units: units.length,
    ranged,
    unranged: units.length - ranged,
    fellBack,
    topLevelText,
    tags: Object.entries(tags).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([k,v]) => k+':'+v).join(' '),
  };
})()`;


// The app boots asynchronously: the IPC bridge and the library grid appear after the window does.
// Probing before either exists reports a HARNESS fault as a book fault, so wait for both.
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
    if (state === "library") return state;
    // A reader left open by a previous session hides the library; go back to it.
    if (state === "reader") {
      await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("app never reached the library");
}

async function openBook(s, bookId) {
  const title = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books',
        { sort: 'date_added', order: 'desc', format: null, collection: null, search: null })
       .then(rows => (rows.find(b => b.id === ${JSON.stringify(bookId)}) || {}).title || null)
       .catch(e => 'IPC_ERROR: ' + e)`,
  );
  if (typeof title === "string" && title.startsWith("IPC_ERROR: ")) return { ok: false, reason: title };
  if (!title) return { ok: false, reason: "not in the library" };

  const clicked = await s.evaluate(
    `(() => {
       const want = ${JSON.stringify(title)}.trim();
       const cards = [...document.querySelectorAll('.lib-card')];
       const card = cards.find(c => (c.getAttribute('title') || '').trim() === want);
       if (!card) return false;
       card.click();
       return true;
     })()`,
  );
  if (!clicked) return { ok: false, reason: `no library card titled ${JSON.stringify(title)}` };

  // PIN THE SECTION, then wait for it to actually carry text.
  //
  // Both halves were learned the hard way. Without the pin, each book resumes at its own stored
  // position, so a run measures whichever chapter the reader last left — "Lord of the Mysteries"
  // reported 274 containers in one run and 0 in the next, from two different chapters, which makes
  // any before/after comparison meaningless. Without the text wait, the FIRST book probed after
  // launch returned an empty document and 0 units, and 0 units trivially satisfies "no unit lacks a
  // range" — a silent false pass, the worst possible outcome for a gate.
  for (let i = 0; i < 80; i++) {
    const state = await s.evaluate(
      `(() => {
         const v = document.querySelector('.page-host foliate-view');
         if (!v || !v.renderer || !v.renderer.getContents) return 'loading';
         const c = v.renderer.getContents();
         return (c && c[0] && c[0].doc && c[0].doc.body) ? 'ready' : 'loading';
       })()`,
    );
    if (state === "ready") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await s.evaluate(
    `(() => { const v = document.querySelector('.page-host foliate-view'); if (v) v.goToFraction(0.25); })()`,
  );
  // Then wait for the document to be STABLE, not merely non-empty. foliate swaps the content
  // document while a jump settles, so a single "has text" poll can be satisfied by a document that
  // is replaced microseconds later — measured: the probe then saw an empty <body>, reported 0 units,
  // and 0 units satisfies "no unit lacks a range" vacuously. Two consecutive polls agreeing on the
  // same section AND a non-zero length is the cheapest condition that excludes the swap.
  let last = null;
  for (let i = 0; i < 80; i++) {
    const now = await s.evaluate(
      `(() => {
         const v = document.querySelector('.page-host foliate-view');
         const c = v && v.renderer && v.renderer.getContents && v.renderer.getContents()[0];
         const d = c && c.doc;
         if (!d || !d.body) return null;
         return { section: c.index, chars: (d.body.textContent || '').trim().length };
       })()`,
    );
    if (now && now.chars > 0 && last && last.chars === now.chars && last.section === now.section) {
      return { ok: true, title, section: now.section };
    }
    last = now;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, reason: "document never settled with text" };
}

async function backToLibrary(s) {
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
  await new Promise((r) => setTimeout(r, 600));
}

const only = process.argv.find((a) => a.startsWith("--book="))?.slice(7);

if (!corpusAvailable()) {
  console.error("\n  corpus not available — set %SARD_CORPUS%\n");
  process.exit(1);
}
const manifest = readManifest();
// The reported book joined the corpus as `txt-converted--daw-alkhalid.epub`, so it arrives with the
// manifest; keep REPORTED only as a fallback for a profile whose corpus predates that entry.
const corpusIds = manifest.books.filter((b) => b.format === "epub").map((b) => b.sha256);
const ids = only ? [only] : corpusIds.includes(REPORTED) ? corpusIds : [REPORTED, ...corpusIds];

const snap = snapshotDb(REPO, "tts");
console.log(`\n  db snapshot: ${snap}`);
const failures = [];
let exitCode = 0;
let measured = 0; // books actually opened and probed — the guard against a pass over an empty set
let sard;
try {
  sard = await launchSard({ port: 9334 });
  if (sard.skipped) { restoreDb(snap); console.error(sard.skipped); process.exit(1); }
  const s = sard;
  await waitForApp(s);
  console.log(`  engine: ${(await s.evaluate("navigator.userAgent")).match(/Chrome\/[\d.]+/)?.[0] ?? "?"}\n`);
  console.log("  book                                         sec  cont  leaf  units  ranged  null    ms   structure");
  console.log("  " + "-".repeat(104));

  for (const id of ids) {
    const opened = await openBook(s, id);
    const label = (only ? id.slice(0, 12) : (manifest.books.find((b) => b.sha256 === id)?.file ?? "REPORTED: داو الخالد العجيب")).padEnd(42);
    if (!opened.ok) {
      console.log(`  ${label}  skipped — ${opened.reason}`);
      continue;
    }
    measured++;
    const r = await s.evaluate(PROBE_JS);
    // Stage 4/5 from the PRODUCT's own builder, so this cannot pass while the shipping code fails.
    // Timed, because the repaired path segments the WHOLE body as one block rather than many small
    // ones, and `locate()` is O(nodes) per lookup — a cost worth watching, not assuming.
    const t = await s.evaluate(
      `(typeof window.__sardTrackStats === 'function'
          ? (async () => { const t0 = performance.now();
                           const r = await window.__sardTrackStats();
                           return { ...r, ms: Math.round(performance.now() - t0) }; })()
          : Promise.resolve({ error: 'no __sardTrackStats hook' }))`,
    );
    if (r.error || t?.error) {
      console.log(`  ${label}  error — ${r.error ?? t.error}`);
      failures.push(`${label.trim()}: ${r.error ?? t.error}`);
    } else {
      const flag = t.unranged > 0 ? "  ⚠ spoken, never highlighted" : "";
      console.log(
        `  ${label}  ${String(r.section).padStart(4)}  ${String(r.containers).padStart(4)}  ${String(r.leaves).padStart(4)}  ` +
          `${String(t.units).padStart(5)}  ${String(t.ranged).padStart(6)}  ${String(t.unranged).padStart(4)}  ${String(t.ms ?? "?").padStart(4)}   ${r.tags}${flag}`,
      );
      if (r.containers === 0) {
        console.log(`  ${" ".repeat(42)}  no block container in this chapter — the body-walk path`);
      }
      // THE GATE. A unit the engine will speak but can never highlight is the reported defect.
      if (t.unranged > 0) failures.push(`${label.trim()}: ${t.unranged}/${t.units} units have no range`);
      // A chapter that produced NO units passes the range check vacuously, so it is failed outright:
      // `openBook` already guaranteed the document carries text before this point.
      if (t.units === 0) failures.push(`${label.trim()}: chapter carries text but produced 0 units`);
    }
    await backToLibrary(s);
  }
  console.log("");
  // A PASS OVER AN EMPTY SET IS NOT A PASS.
  //
  // `failures` is empty both when every book was measured and found sound, and when NOTHING was
  // measured at all — and the second printed the same green tick as the first. Measured: selecting a
  // book by filename (this flag takes a sha256) matched nothing, zero books were opened, and the
  // harness reported "every book produces units, and every unit carries a range". A harness that
  // passes when it measures nothing can certify anything.
  if (measured === 0) {
    console.error("  ✗ NOTHING was measured — 0 books were opened, so nothing was verified.");
    console.error(`     --book= selects by the corpus sha256; '${only ?? "(none given)"}' matched no book.\n`);
    exitCode = 1;
  } else if (failures.length) {
    console.error(`  ✗ ${failures.length} book(s) cannot be tracked:\n`);
    for (const f of failures) console.error(`      ${f}`);
    console.error("");
    exitCode = 1;
  } else {
    console.log(`  ✓ every book produces units, and every unit carries a range\n`);
  }
} finally {
  if (sard) await sard.close();
  await restoreDb(snap);
  console.log("  db restored from snapshot (profile untouched)\n");
}
process.exit(exitCode);
