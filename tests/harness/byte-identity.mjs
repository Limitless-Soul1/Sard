#!/usr/bin/env node
// WP-0 (RESILIENCE-1) — the byte-identity harness.
//
// THE MILESTONE'S CENTRAL SAFETY NET. RESILIENCE-1's stated goal is "preserving existing behaviour
// for valid books". Without this, that is an assertion; with it, it is a check that fails a build.
//
// It opens each corpus book in the REAL Sard binary and records a render fingerprint — the computed
// values Sard's injected CSS and foliate's pagination actually produce. `baseline` writes it;
// `compare` re-measures and diffs. Any difference on a well-formed book is a regression until
// someone explains otherwise.
//
//   node tests/harness/byte-identity.mjs baseline           # record
//   node tests/harness/byte-identity.mjs compare            # re-measure + diff (exit 1 on drift)
//   node tests/harness/byte-identity.mjs baseline --tag=pre-wp4
//
// ⚠ IT DRIVES THE REAL APP AGAINST THE REAL PROFILE. Tauri resolves app data from the bundle
// identifier with no environment override, so there is no isolated profile. Opening a book writes
// reading progress, `last_opened_at`, `seen_start` and `chapters_read`. The harness therefore
// snapshots the database before it starts and RESTORES it afterwards — the project's own
// `.db-snapshot-*` convention, which `.gitignore` already covers. Restore happens on every exit
// path, including a crash.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs"; // the ONE real-profile guard
import { corpusAvailable, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT_DIR = join(REPO, "tests", "harness", "fingerprints");

// ---------------------------------------------------------------------------
// Database snapshot / restore — the guard that makes this safe to run.
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// The fingerprint, as evaluated inside the app.
// ---------------------------------------------------------------------------

// Deliberately narrow and deliberately ORDERED. Every property here is one Sard's injected CSS
// sets, or one a book's own stylesheet would set if WP-7 let it through — i.e. exactly the surface
// where a rendering regression would appear. Geometry that legitimately varies with window size
// (widths, offsets) is excluded: it would make the harness cry wolf.
//
// ⚠ THIS SAMPLE IS THE WP-7 GATE — not the `sheets` field. Measured on the v1.1.0 baseline: every
// book's external <link> stylesheets ARE listed in `document.styleSheets` (Alice 3, the Word book 2,
// and so on, matching each book's CSS file count exactly) even though none of their rules reach
// computed style. The sheet objects exist and are inert. So `sheets` looks IDENTICAL before and
// after the CSP change, and anyone verifying stage 7.1 by counting sheets would conclude wrongly.
// Only computed style can answer "did the book's CSS apply".
export const TRACKED_PROPS = [
  "direction",
  "textAlign",
  "fontSize",
  "lineHeight",
  "fontWeight",
  "fontFamily",
  "letterSpacing",
  "textIndent",
  "marginBlockStart",
  "marginBlockEnd",
  "color",
  "backgroundColor",
];

const FINGERPRINT_JS = `(() => {
  const view = document.querySelector('.page-host foliate-view');
  if (!view) return { error: 'no foliate-view' };
  const contents = view.renderer && view.renderer.getContents ? view.renderer.getContents() : null;
  if (!contents || !contents[0] || !contents[0].doc) return { error: 'no section document' };
  const c0Index = contents[0].index;
  const doc = contents[0].doc;
  const win = doc.defaultView;
  const props = ${JSON.stringify(TRACKED_PROPS)};

  // A fixed, document-ordered sample. Capped so a 1400-section book costs the same as a 4-section
  // one, and so the fingerprint is a comparable size for every book.
  const nodes = [...doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div')].slice(0, 40);
  const sample = nodes.map((el, i) => {
    const cs = win.getComputedStyle(el);
    const o = { i, tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '' };
    for (const p of props) o[p] = cs[p];
    return o;
  });

  const rootCs = win.getComputedStyle(doc.documentElement);
  const bodyCs = win.getComputedStyle(doc.body);

  // LAYOUT, not just typography. Added after the paged-mode fragmentation defect: the fingerprint
  // tracked computed STYLE only, so a bug that collapsed every chapter into one unbreakable column
  // — clipping ~97% of it — produced a byte-IDENTICAL fingerprint. It could not have caught the
  // bug, and could not see the fix either.
  //   * pages   - how many pages foliate believes this section has.
  //   * columns - how many DISTINCT horizontal positions the paragraphs actually occupy. In paged
  //                 mode a multi-page section MUST be > 1; 1 means the content did not fragment.
  // Measured on Alice chapter I: before the fix pages=3 / columns=1 (20,331px clipped inside 624px);
  // after, pages=9 / columns=23.
  const paras = [...doc.body.querySelectorAll('p')];
  const columnLefts = new Set(paras.map(p => Math.round(p.getBoundingClientRect().left)));
  const renderer = view.renderer;

  return {
    sampledSection: c0Index,
    sectionCount: view.book && view.book.sections ? view.book.sections.length : null,
    tocCount: view.book && view.book.toc ? view.book.toc.length : null,
    bookDir: (view.book && view.book.dir) || null,
    layout: {
      flow: renderer.getAttribute('flow'),
      pages: renderer.pages,
      columns: columnLefts.size,
      paragraphs: paras.length,
    },
    // Sard's own document-level assertions — the injected direction and zoom, and foliate's columns.
    root: { direction: rootCs.direction, columnWidth: rootCs.columnWidth, columnGap: rootCs.columnGap, overflow: rootCs.overflow },
    body: { direction: bodyCs.direction, zoom: bodyCs.zoom, backgroundColor: bodyCs.backgroundColor, color: bodyCs.color, maxWidth: bodyCs.maxWidth },
    // How many stylesheets reached the section document. 0 external sheets is the v1.1.0 state that
    // WP-7 deliberately changes; recording it makes that change visible rather than incidental.
    sheets: [...doc.styleSheets].map(s => (s.href ? 'external' : 'inline')),
    sampleCount: sample.length,
    sample,
  };
})()`;

// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the app is genuinely usable, rather than assuming it is because the CDP target exists.
 *
 * The target appears as soon as WebView2 has a document — BEFORE Tauri's init script defines
 * `__TAURI_INTERNALS__` and long before React has rendered the library. Evaluating too early gave
 * `TypeError: Cannot read properties of undefined (reading 'invoke')` on the first book while a
 * plain `navigator.userAgent` had already succeeded, which is exactly the shape of a readiness bug.
 */
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
    // A reader left open from a previous session hides the library; go back to it.
    if (state === "reader") {
      await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); })()`);
    }
    await wait(400);
  }
  throw new Error("the app never reached a usable library state");
}

/** Open a book by its id (= the SHA-256 of its bytes, which is also the corpus manifest key). */
async function openBook(s, bookId) {
  // Resolve id → displayed title through Sard's own IPC, then click the card carrying that title.
  // `.lib-card` already exposes `title={title}` (Library.tsx), so this needs no product change —
  // a test hook added to shipping markup would be a product change, which WP-0 must not make.
  //
  // The argument shape is FLAT and every field is required — transcribed from `libraryListBooks`
  // in src/lib/ipc.ts rather than guessed. (It was guessed once, as `{ args: {} }`, and failed.)
  const title = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books',
        { sort: 'date_added', order: 'desc', format: null, collection: null, search: null })
       .then(rows => (rows.find(b => b.id === ${JSON.stringify(bookId)}) || {}).title || null)
       .catch(e => 'IPC_ERROR: ' + e)`,
  );
  if (typeof title === "string" && title.startsWith("IPC_ERROR: ")) {
    return { ok: false, reason: title };
  }
  if (!title) return { ok: false, reason: "not in the library" };

  // Match on the TRIMMED title. The card renders the DISPLAY value while this lookup holds the
  // STORED one, and WP-3 proved they can differ by surrounding whitespace (the owner's library holds
  // an override typed as "الأنمساخ "). Comparing raw text made the harness assert a product decision
  // it has no business asserting — its job here is only to open the right book.
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

  // Wait for the reader to reach a terminal state rather than sleeping a fixed time: a 10 MB book
  // takes far longer than a 140 KB one, and a fixed sleep would either be slow or flaky.
  for (let i = 0; i < 120; i++) {
    await wait(250);
    const state = await s.evaluate(
      `(() => {
         if (document.querySelector('.reader-error-overlay')) return 'error';
         const v = document.querySelector('.page-host foliate-view');
         if (!v || !v.renderer || !v.renderer.getContents) return 'loading';
         const c = v.renderer.getContents();
         return (c && c[0] && c[0].doc && c[0].doc.body && c[0].doc.body.childNodes.length) ? 'ready' : 'loading';
       })()`,
    );
    if (state === "ready") {
      // PIN THE SAMPLED POSITION. A book opens at its stored resume position, so the fingerprint
      // otherwise describes wherever the reader happened to stop — and a diff then reports
      // "layout.paragraphs 39 → 137", which is a DIFFERENT SECTION, not a rendering change. Seen
      // for real once reading moved between two captures. Navigating to a fixed fraction makes the
      // sample depend only on the book and the code.
      await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view'); v.goToFraction(0.25); })()`);
      await wait(1500);
      return { ok: true, title };
    }
    if (state === "error") {
      const detail = await s.evaluate(`(document.querySelector('.reader-error-detail')||{}).textContent || ''`);
      return { ok: false, reason: `reader error: ${detail}` };
    }
  }
  return { ok: false, reason: "timed out waiting for the reader" };
}

/**
 * The RENDERING CONFIGURATION in force — the settings that legitimately change what a book looks
 * like without any code changing.
 *
 * WHY THIS EXISTS (found during WP-1). A capture taken after the reading background's page-opacity
 * setting changed reported `body.backgroundColor: rgba(0,0,0,0) → rgb(0,0,0)` on ALL FIFTEEN books
 * — a perfect impersonation of a catastrophic rendering regression, produced by a slider. WP-1 was
 * cleared only by rebuilding the pre-WP-1 binary and re-measuring, which is far too expensive to be
 * the routine answer.
 *
 * A comparison is only meaningful between captures taken under the SAME configuration, so the
 * configuration is now recorded and `diff` reports a mismatch as CONFIGURATION DRIFT rather than as
 * a code regression. The gate must never let a settings change look like a bug — or, worse, let a
 * real bug hide inside one.
 */
async function readConfig(s) {
  // FINDING-11 (2026-08-05). `hide_chapter_titles` was missing from this list and it CHANGES
  // RENDERING: with it on, headings compute to font-size 0px. A compare against a baseline captured
  // under the other value reported 64 "rendering differences"; flipping the flag removed 50 of them,
  // measured. This list is hand-maintained, which is exactly how `paragraphSpacing` was missed
  // before — any setting that can alter a tracked property MUST be recorded here, or a settings
  // change masquerades as a code regression and a real regression can hide inside one.
  // `hide_first_line` (RAWY-69) is INDEPENDENT of `hide_chapter_titles` and hides a different set of
  // elements — `.sard-chapter-heading:not(.sard-revealed)`, the detected leading "first line".
  // Measured: it accounted for the last 14 differences after the other flag explained 50.
  const keys = ["theme_id", "book_theme_id", "theme_mode", "bg_enabled", "bg_reading_id", "bg_reading_params", "reading_style", "hide_chapter_titles", "hide_first_line"];
  const out = {};
  for (const k of keys) {
    const v = await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('settings_get', { key: ${JSON.stringify(k)} }).catch(() => null)`,
    );
    // The two JSON blobs are reduced to the fields that actually reach the page, so an unrelated
    // edit (a focal point, a bookmark colour) does not invalidate every stored baseline.
    if (k === "bg_reading_params") {
      let p = {};
      try {
        p = v ? JSON.parse(v) : {};
      } catch {
        /* a corrupt blob is reported as its raw value below */
      }
      out.pageOpacity = String(p.pageOpacity ?? "unset");
      out.bgPresence = String(p.presence ?? "unset");
    } else if (k === "reading_style") {
      let p = {};
      try {
        p = v ? JSON.parse(v) : {};
      } catch {
        /* ditto */
      }
      for (const f of ["zoom", "lineHeight", "marginPx", "align", "arabicFont", "latinFont", "fontWeight", "flowMode"]) {
        out[f] = String(p[f] ?? "unset");
      }
    } else {
      out[k] = String(v ?? "unset");
    }
  }
  return out;
}

async function closeBook(s) {
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  await wait(600);
}

/**
 * FORCE the reading flow for this capture (PPC-2).
 *
 * The capture used to READ `flowMode` and record it, never set it — so which flow got measured was
 * whatever the owner's profile happened to hold, and it held `scrolled` every time. All 16 baseline
 * books were therefore captured in scrolled mode, where `layout.pages` and `layout.columns` are
 * inert: the two fields added specifically to catch a pagination collapse were never once measured
 * in the mode that can collapse. NAV-1 — paged mode never paginating at all, ~97% of every chapter
 * clipped and unreachable — went out in a build while this net reported byte-identical.
 *
 * Writing the mode makes a paged baseline reproducible instead of a coincidence. It edits the real
 * `reading_style`, which is safe because `snapshotDb`/`restoreDb` already bracket the whole run —
 * the same guard that lets the harness open books at all.
 */
async function forceFlow(s, flow) {
  const applied = await s.evaluate(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const raw = await inv('settings_get', { key: 'reading_style' }).catch(() => null);
    let style = {};
    try { style = raw ? JSON.parse(raw) : {}; } catch { style = {}; }
    if (style.flowMode === ${JSON.stringify(flow)}) return 'already ' + ${JSON.stringify(flow)};
    style.flowMode = ${JSON.stringify(flow)};
    await inv('settings_set', { key: 'reading_style', value: JSON.stringify(style) });
    return 'set to ' + ${JSON.stringify(flow)};
  })()`);
  return applied;
}

async function capture({ tag, flow }) {
  if (!corpusAvailable()) return { skipped: "no corpus — see tests/corpus/README.md" };
  const manifest = readManifest();
  const books = manifest.books.filter((b) => !b.retired && b.format === "epub");

  const snapshot = snapshotDb(REPO, "harness");
  console.log(`  db snapshot: ${snapshot}`);
  let s;
  const out = { tag, capturedAt: new Date().toISOString(), engine: null, books: {} };
  try {
    s = await launchSard({ port: 9333 });
    if (s.skipped) {
      await restoreDb(snapshot);
      return { skipped: s.skipped };
    }
    out.engine = (await s.evaluate("navigator.userAgent")).match(/Chrome\/[\d.]+/)?.[0] ?? "unknown";
    await waitForApp(s);
    // BEFORE readConfig, so the recorded configuration is the one actually measured under. A flow
    // written after the config was read would make every capture claim a mode it did not use.
    if (flow) console.log(`  flow: ${await forceFlow(s, flow)}`);
    out.config = await readConfig(s);
    console.log(`  engine: ${out.engine}`);
    console.log(`  config: ${Object.entries(out.config).map(([k, v]) => `${k}=${v}`).join(" · ")}\n`);

    for (const book of books) {
      process.stdout.write(`  ${book.file.padEnd(44)}`);
      const opened = await openBook(s, book.sha256);
      if (!opened.ok) {
        out.books[book.file] = { error: opened.reason };
        console.log(`skipped — ${opened.reason}`);
        continue;
      }
      out.books[book.file] = await s.evaluate(FINGERPRINT_JS);
      const fp = out.books[book.file];
      console.log(fp.error ? `error — ${fp.error}` : `${fp.sampleCount} elements · ${fp.sectionCount} sections`);
      await closeBook(s);
    }
  } finally {
    if (s && !s.skipped) await s.close();
    await restoreDb(snapshot);
    console.log(`\n  db restored from snapshot (profile untouched)`);
  }
  return { data: out };
}

function fingerprintPath(tag) {
  return join(OUT_DIR, `${tag}.json`);
}

/**
 * Compare two captures → a list of human-readable differences (empty = byte-identical).
 *
 * Exported so it can be unit-tested offline. A drift detector that has only ever been observed
 * saying "no drift" is not a detector; `harness.test.ts` feeds it known differences and asserts it
 * finds each one.
 */
export function diff(a, b) {
  const problems = [];

  // CONFIGURATION FIRST, and reported with its own prefix. A capture taken under different reading
  // settings is not comparable — saying "regression" would be a confident lie, and letting it pass
  // silently would let a real regression hide behind a settings change.
  // THE ENGINE, for exactly the same reason — and this one was missed until 2026-08-05, when a
  // compare against the previous day's baseline reported 15 differences while silently running on
  // Chrome/151 against a Chrome/150 capture. WebView2 updates itself, out of our control, between
  // any two runs. A harness whose entire premise is "a difference means OUR code changed" has to
  // say so when the renderer underneath it changed instead; otherwise it hands us a confident lie.
  if ((a.engine ?? null) !== (b.engine ?? null)) {
    problems.push(`ENGINE ${a.engine ?? "unrecorded"} → ${b.engine ?? "unrecorded"} (WebView2 changed, not our code — re-baseline)`);
  }

  const ca = a.config ?? null;
  const cb = b.config ?? null;
  if (ca && cb) {
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      if (ca[k] !== cb[k]) problems.push(`CONFIG ${k}: ${ca[k]} → ${cb[k]} (not a code change — re-baseline)`);
    }
  } else if (!!ca !== !!cb) {
    problems.push("CONFIG: one capture predates configuration recording — re-baseline before trusting a comparison");
  }

  const files = new Set([...Object.keys(a.books), ...Object.keys(b.books)]);
  for (const f of files) {
    const x = a.books[f];
    const y = b.books[f];
    if (!x || !y) {
      problems.push(`${f}: present in only one capture`);
      continue;
    }
    if (x.error || y.error) {
      if (x.error !== y.error) problems.push(`${f}: error changed: ${x.error ?? "none"} → ${y.error ?? "none"}`);
      continue;
    }
    for (const k of ["sampledSection", "sectionCount", "tocCount", "bookDir", "sampleCount"]) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) problems.push(`${f}: ${k} ${JSON.stringify(x[k])} → ${JSON.stringify(y[k])}`);
    }
    for (const group of ["root", "body", "layout"]) {
      for (const k of Object.keys(x[group] ?? {})) {
        if (x[group][k] !== y[group]?.[k]) problems.push(`${f}: ${group}.${k} ${x[group][k]} → ${y[group]?.[k]}`);
      }
    }
    if (JSON.stringify(x.sheets) !== JSON.stringify(y.sheets)) {
      problems.push(`${f}: stylesheets ${JSON.stringify(x.sheets)} → ${JSON.stringify(y.sheets)}`);
    }
    const n = Math.min(x.sample?.length ?? 0, y.sample?.length ?? 0);
    for (let i = 0; i < n; i++) {
      for (const p of TRACKED_PROPS) {
        if (x.sample[i][p] !== y.sample[i][p]) {
          problems.push(`${f}: [${i}] <${x.sample[i].tag} class="${x.sample[i].cls}"> ${p}: ${x.sample[i][p]} → ${y.sample[i][p]}`);
        }
      }
    }
  }
  return problems;
}

/**
 * FINDING-2 — NEVER LOSE A ONE-SHOT DIVERGENCE AGAIN.
 *
 * One compare reported 3 differences; nine later runs were clean. By then the console had scrolled,
 * the run was not repeatable, and the evidence was gone — so the finding could never be classified
 * beyond "Unknown". An intermittent divergence is precisely the one worth preserving, because that
 * first failure may be the only record of it that will ever exist.
 *
 * So a failing compare writes the COMPLETE diff to disk before printing anything. Three rules:
 *   - unsliced — the console shows 60 problems, the file always holds every one;
 *   - timestamped, never overwritten — two intermittent failures are two pieces of evidence, and
 *     the second must not erase the first;
 *   - both sides of every affected book, verbatim, so the file can be re-diffed later without the
 *     original captures still being on disk.
 *
 * Exported and pure-ish (its only effect is the write) so `harness.test.ts` can prove it captures a
 * known difference offline — the same reason `diff` is exported. Never throws: this runs on a path
 * that is already failing, and losing the exit code to a disk error would be worse than losing the
 * dump. Returns the path written, or null.
 */
export function dumpDiff({ tag, baseline, current, problems, dir = OUT_DIR, now = Date.now() }) {
  // Only the books actually implicated — a full 15-book capture buries 3 differences in noise.
  // `diff` prefixes every book problem with the filename, which is what makes this selectable.
  const names = [...new Set([...Object.keys(baseline.books ?? {}), ...Object.keys(current.books ?? {})])];
  const affected = names.filter((f) => problems.some((p) => p.startsWith(`${f}:`)));

  const payload = {
    tag,
    comparedAt: new Date(now).toISOString(),
    problemCount: problems.length,
    problems, // COMPLETE — never the 60 the console shows
    engine: { baseline: baseline.engine ?? null, current: current.engine ?? null },
    // Keep both configs verbatim. This is the line that turned "111 rendering regressions" into
    // "someone left zoom at 2.5" — a settings drift must stay one glance away from a real one.
    config: { baseline: baseline.config ?? null, current: current.config ?? null },
    capturedAt: { baseline: baseline.capturedAt ?? null, current: current.capturedAt ?? null },
    books: Object.fromEntries(
      affected.map((f) => [f, { baseline: baseline.books?.[f] ?? null, current: current.books?.[f] ?? null }]),
    ),
  };

  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `diff-${tag}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 1), "utf8");
    return path;
  } catch (e) {
    console.error(`  ⚠ could not write the diff dump — the evidence is lost: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------

// Everything below is the CLI. It is guarded so `diff` (and the constants) can be imported by
// harness.test.ts without launching the app — importing a module must never have side effects.
const IS_CLI = process.argv[1]?.replace(/\\/g, "/").endsWith("byte-identity.mjs");
if (!IS_CLI) {
  // Imported as a library: stop here.
} else {
await runCli();
}

async function runCli() {
const mode = process.argv[2] ?? "compare";
const tagArg = process.argv.find((a) => a.startsWith("--tag="))?.slice(6);
const tag = tagArg ?? "baseline";
// PPC-2: which reading FLOW to capture under. Explicit, because leaving it to the profile is what
// left every baseline in scrolled mode with the pagination fields inert.
const flowArg = process.argv.find((a) => a.startsWith("--flow="))?.slice(7);
if (flowArg && !["scrolled", "paged"].includes(flowArg)) {
  console.error(`--flow must be "scrolled" or "paged" (got ${JSON.stringify(flowArg)})`);
  process.exit(2);
}

if (!["baseline", "compare", "list"].includes(mode)) {
  console.error(`usage: byte-identity.mjs <baseline|compare|list> [--tag=NAME] [--flow=scrolled|paged]`);
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

if (mode === "list") {
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")) : [];
  console.log(files.length ? files.map((f) => `  ${f}`).join("\n") : "  (no fingerprints captured yet)");
  process.exit(0);
}

const res = await capture({ tag, flow: flowArg });
if (res.skipped) {
  console.log(`\n  ⓘ SKIPPED — ${res.skipped}`);
  console.log(`     This is a SKIP, not a pass.\n`);
  process.exit(0);
}

if (mode === "baseline") {
  writeFileSync(fingerprintPath(tag), JSON.stringify(res.data, null, 2) + "\n", "utf8");
  const n = Object.values(res.data.books).filter((b) => !b.error).length;
  console.log(`\n  ✓ baseline "${tag}": ${n} book(s) fingerprinted → ${fingerprintPath(tag)}\n`);
  process.exit(0);
}

const basePath = fingerprintPath(tag);
if (!existsSync(basePath)) {
  console.error(`\n  ✗ no baseline "${tag}" — run \`node tests/harness/byte-identity.mjs baseline\` first\n`);
  process.exit(2);
}
const problems = diff(JSON.parse(readFileSync(basePath, "utf8")), res.data);
if (problems.length === 0) {
  console.log(`\n  ✓ byte-identical to baseline "${tag}"\n`);
  process.exit(0);
}
const dumpPath = dumpDiff({ tag, baseline: JSON.parse(readFileSync(basePath, "utf8")), current: res.data, problems });

console.error(`\n  ✗ ${problems.length} rendering difference(s) vs baseline "${tag}":\n`);
for (const p of problems.slice(0, 60)) console.error(`      ${p}`);
if (problems.length > 60) console.error(`      … and ${problems.length - 60} more`);
if (dumpPath) console.error(`\n  full evidence written to:\n      ${dumpPath}`);
console.error("");
process.exit(1);
}
