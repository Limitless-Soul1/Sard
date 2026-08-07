// TASK 4 — the subsystem regression campaign. Every subsystem is guilty until it proves otherwise.
//
// The question is NOT "does search work?". It is "does WP-7 book CSS change what search, CFI,
// resume, highlights, notes, bookmarks, references, TTS, memory or performance do?". So every probe
// runs under all three `book_css` modes and the results are compared ACROSS modes, not judged in
// isolation. A subsystem passes only if it is mode-INVARIANT where it must be.
//
// The invariants this file exists to falsify:
//   I1  A CFI is content-addressed. The SAME paragraph must produce the SAME CFI in off, sanitised
//       and raw — otherwise a highlight made in one mode is lost or misplaced in another, which is
//       silent user-data corruption.
//   I2  A CFI round-trips: goTo(cfi) lands on the text the CFI was taken from.
//   I3  Search is over text, not layout: same query → same match count and same match CFIs.
//   I4  Annotations persist across a mode change and still draw.
//   I5  Resume returns to the saved position.
//   I6  Pagination is stable: the same book paginates the same way unless the CSS legitimately
//       changed it. (FINDING-10: byte-identity has only ever seen scrolled flow, so this probe
//       drives PAGINATED explicitly. It restores the setting; it does not touch any baseline.)
//
// Usage:  node tests/harness/subsystem.mjs --mode=off|sanitised|raw [--flow=scrolled|paginated]
//         node tests/harness/subsystem.mjs --compare        (diff the three saved runs)
//
// Real profile, therefore: snapshot before, restore on EVERY exit path, remove imported files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const FIXTURES = join(REPO, "tests", "fixtures", "epub");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A REAL book, not a fixture. Measured 2026-08-05: the `hostile-css` fixture's opening section holds
// exactly ONE paragraph, which is far too thin to test CFI identity, search or resume — the first
// run produced a single CFI and zero search hits. Alice carries three external stylesheets, 26
// paragraphs in section 0 and enough prose for search, so the subsystems get real work to do.
// Overridable, because Sard is Arabic-first: the same battery must run against an RTL book, whose
// shaping, direction and fonts are where CSS damage would actually hurt this product's users.
const BOOK_MATCH = (process.argv.find((a) => a.startsWith("--book=")) ?? "--book=Alice").slice(7);
const SEARCH_TERM = (process.argv.find((a) => a.startsWith("--term=")) ?? "--term=Alice").slice(7);

// The renderer's flow VALUE is "paged" — measured: writing "paginated" leaves the renderer scrolled,
// because `scrolledMode = flow !== "paged"`. The renderer ATTRIBUTE that results is "paginated",
// which is what the layout probe reports; the two vocabularies are not the same and conflating them
// cost the first run a false anomaly.
const FLOW_VALUES = { paged: "paginated", scrolled: "scrolled" };

/**
 * Select by TITLE or by FILE PATH. Arabic titles cannot be typed as an ASCII needle, and the corpus
 * filenames (`arabic-normal--karamazov.epub`) can — so the RTL books are reachable by path while
 * `--book=Alice` still works by title. The card is then clicked by the book's OWN exact title,
 * whatever script it is in.
 */
const matchBook = (b) =>
  (b.title ?? "").includes(BOOK_MATCH) || (b.file_path ?? "").replace(/\\/g, "/").includes(BOOK_MATCH);

/**
 * If the needle names a corpus file, return its path so the run can import it rather than depend on
 * whatever happens to be in the owner's library. Corpus books are third-party works living outside
 * the repo at %SARD_CORPUS% — only ever read locally, never copied in.
 */
function corpusPathFor(needle) {
  if (!needle.endsWith(".epub") || !corpusAvailable()) return null;
  const p = join(corpusDir(), needle);
  return existsSync(p) ? p : null;
}

/** Click the library card for an EXACT title (falls back to substring), returning whether it hit. */
const clickCard = (title) =>
  `(() => { const t = ${JSON.stringify(title ?? "")};
     const all = [...document.querySelectorAll('.lib-card')];
     const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
     if (c) c.click(); return !!c; })()`;

const args = process.argv.slice(2);
const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");

// ---------------------------------------------------------------------------
// In-page probes. Each returns plain JSON. None of them reads our source — every
// answer is taken from the running document.
// ---------------------------------------------------------------------------

const P_VIEW = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  if (!v) return { error: 'no foliate-view' };
  const c = v.renderer?.getContents?.()?.[0];
  if (!c?.doc?.body) return { error: 'no section document' };
  return { ok: true, index: c.index };
})()`;

// I1 + I2. Take a CFI for the first text of the first three paragraphs, and record the text it
// covers so a cross-mode comparison can tell "same CFI" from "same paragraph".
const P_CFI = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v.renderer.getContents()[0];
  const doc = c.doc, index = c.index;
  const out = [];
  const paras = [...doc.body.querySelectorAll('p')];
  for (const i of [0, 1, 2, 5]) {
    const p = paras[i];
    if (!p) continue;
    // First descendant text node with real content — hostile CSS can wrap text in spans.
    const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let t = null;
    while ((t = walker.nextNode())) if (t.data.trim().length > 4) break;
    if (!t) continue;
    const r = doc.createRange();
    r.setStart(t, 0);
    r.setEnd(t, Math.min(16, t.data.length));
    let cfi = null;
    try { cfi = v.getCFI(index, r); } catch (e) { cfi = 'ERROR: ' + e.message; }
    out.push({ para: i, text: t.data.slice(0, 16), cfi });
  }
  return { sectionIndex: index, paraCount: paras.length, cfis: out };
})()`;

const P_LAYOUT = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v.renderer.getContents()[0];
  const doc = c.doc, win = doc.defaultView;
  const r = win.getComputedStyle(doc.documentElement);
  const b = win.getComputedStyle(doc.body);
  const size = v.renderer.getAttribute('flow') === 'scrolled'
    ? { scrollHeight: doc.documentElement.scrollHeight }
    : { scrollWidth: doc.documentElement.scrollWidth };
  return {
    flow: v.renderer.getAttribute('flow'),
    columnWidth: r.columnWidth, columnGap: r.columnGap, overflow: r.overflow,
    bodyMaxWidth: b.maxWidth, bodyZoom: b.zoom,
    ...size,
    // Page/column arithmetic, the thing byte-identity has never measured in paginated flow.
    columns: v.renderer.getAttribute('flow') === 'scrolled' ? 0
      : Math.round(doc.documentElement.scrollWidth / (parseFloat(r.columnWidth) + parseFloat(r.columnGap) || 1)),
  };
})()`;

// I5 — where does the reader think it is, in the app's own terms?
const P_WHERE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const l = v.lastLocation ?? null;
  const c = v.renderer?.getContents?.()?.[0];
  return {
    cfi: l?.cfi ?? null,
    fraction: l?.fraction ?? null,
    sectionIndex: c?.index ?? null,
    // First visible-ish text, so "same fraction" can be told from "same place".
    firstText: c?.doc?.body?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 40) ?? null,
  };
})()`;

/** goTo a CFI and report where we landed — the I2 round-trip. */
const goToAndReport = (cfi) => `(async () => {
  const v = document.querySelector('.page-host foliate-view');
  try { await v.goTo(${JSON.stringify(cfi)}); } catch (e) { return { error: String(e) }; }
  await new Promise(r => setTimeout(r, 900));
  const c = v.renderer.getContents()[0];
  const l = v.lastLocation ?? null;
  // Measured: view.resolveCFI does NOT return a Range — its toString() is "[object Object]".
  // Take whatever it is and pull text out of the shape it actually has, reporting the shape too so
  // a future change is visible rather than silently degrading to null.
  let atText = null, shape = null;
  try {
    const res = await v.resolveCFI(${JSON.stringify(cfi)});
    shape = res == null ? 'null' : (res instanceof Range ? 'Range' : Object.keys(res).join('+'));
    const rng = res instanceof Range ? res : (res?.range instanceof Range ? res.range : null);
    if (rng) atText = rng.toString().slice(0, 16);
    else if (res && res.anchor != null) {
      // Measured: resolveCFI returns { index, anchor }. The anchor may be a function of the section
      // document, a Range, or a node — resolve every shape and SAY which one, so I2 can never be
      // quietly reported as "unverified null" again.
      // (No backticks in this string: it lives inside a template literal.)
      const a = typeof res.anchor === 'function' ? res.anchor(c?.doc) : res.anchor;
      const kind = a == null ? 'null'
        : a instanceof Range ? 'Range'
        : a.nodeType === 3 ? 'Text'
        : a.nodeType === 1 ? 'Element<' + a.tagName.toLowerCase() + '>'
        : typeof a;
      shape += '(anchor->' + kind + (kind === 'object' ? '[' + Object.keys(a).join(',') + ']' : '') + ')';
      // A plain object here is foliate's {node, offset} / range-like shape; try both before giving up.
      if (kind === 'object') {
        const n = a.node ?? a.startContainer ?? a.container ?? null;
        if (n?.nodeType === 3) atText = n.data.slice(0, 16);
        else if (n?.nodeType === 1) atText = (n.textContent || '').replace(/^\\s+/, '').slice(0, 16);
        else if (typeof a.toString === 'function' && a.toString() !== '[object Object]') atText = a.toString().slice(0, 16);
      }
      if (a instanceof Range) atText = a.toString().slice(0, 16);
      else if (a?.nodeType === 3) atText = a.data.slice(0, 16);
      else if (a?.nodeType === 1) atText = (a.textContent || '').replace(/^\\s+/, '').slice(0, 16);
      else if (a && typeof a === 'object' && a.node) atText = (a.node.textContent || '').slice(0, 16);
    }
  } catch (e) { shape = 'threw: ' + e.message; }
  return { landedSection: c?.index ?? null, cfi: l?.cfi ?? null, atText, resolveShape: shape };
})()`;

// ---------------------------------------------------------------------------

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) {
    if (await s.evaluate(expr)) return true;
    await sleep(ms);
  }
  return false;
}

async function run(mode, flow) {
  mkdirSync(OUT, { recursive: true });
  const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
  const snap = snapshotDb(REPO, `subsys-${mode}`);
  const result = { mode, flow, startedAt: new Date().toISOString(), probes: {}, anomalies: [] };
  const note = (k, v) => { result.probes[k] = v; };
  const anomaly = (what, detail) => { result.anomalies.push({ what, detail }); console.log(`    ⚠ ${what}: ${JSON.stringify(detail)}`); };

  let sard = null;
  try {
    sard = await launchSard({ port: 9380 });
    if (sard.skipped) { console.error(sard.skipped); return null; }
    const s = sard;
    const ready = await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
    if (!ready) throw new Error("Tauri IPC never became available");
    const inv = async (cmd, payload = {}) =>
      s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)}).catch(e => ({ __err: String(e) }))`);

    result.engine = await s.evaluate(`navigator.userAgentData?.brands?.map(b => b.brand + '/' + b.version).join(',') ?? navigator.appVersion`);

    // ---- settings under test -------------------------------------------------
    await inv("settings_set", { key: "book_css", value: mode });
    // flowMode is a FIELD INSIDE the `reading_style` JSON blob, not a key of its own — read,
    // patch, write back, or every other typography setting is destroyed. The db snapshot in
    // `finally` is what makes writing to the real profile safe here.
    const styleRaw = await inv("settings_get", { key: "reading_style" });
    const style = typeof styleRaw === "string" && styleRaw ? JSON.parse(styleRaw) : {};
    result.styleBefore = { flowMode: style.flowMode, zoom: style.zoom, lineHeight: style.lineHeight };
    style.flowMode = flow;
    await inv("settings_set", { key: "reading_style", value: JSON.stringify(style) });
    note("settingsEcho", {
      book_css: await inv("settings_get", { key: "book_css" }),
      flowMode: JSON.parse(await inv("settings_get", { key: "reading_style" })).flowMode,
    });

    // ---- open ----------------------------------------------------------------
    const t0 = Date.now();
    await s.evaluate(`window.location.reload()`);
    await sleep(3000);

    const books = await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });
    let book = Array.isArray(books) ? books.find(matchBook) : null;
    if (!book) {
      // Same resolution as the cross-mode run: import from the corpus and identify the book by the
      // id the import result returns, since Sard rewrites file_path on import.
      const p = corpusPathFor(BOOK_MATCH) ?? join(FIXTURES, "hostile-css.epub");
      const res = await inv("import_books", { paths: [p] });
      await sleep(2000);
      const id = Array.isArray(res) ? res[0]?.id : null;
      const again = await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });
      book = (again || []).find((b) => b.id === id) ?? (again || []).find(matchBook);
    }
    if (!book) throw new Error(`test book "${BOOK_MATCH}" not in library`);
    result.book = { title: book.title, dir: book.dir, language: book.language };
    result.bookId = book.id;

    await s.evaluate(
      clickCard(book.title),
    );
    const opened = await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
    note("openMs", Date.now() - t0);
    if (!opened) throw new Error("book never rendered");
    await sleep(1500);

    const v = await s.evaluate(P_VIEW);
    if (v?.error) throw new Error(`view probe: ${v.error}`);

    // ---- IS THE MODE EVEN LIVE? ---------------------------------------------
    // Without this, "all three modes agree" is unfalsifiable: it reads as "book CSS is harmless"
    // when it may only mean the hook never fired for this book. Every invariant below is
    // conditional on the modes being observably different HERE.
    note("modeEffect", await s.evaluate(`(() => {
      const v = document.querySelector('.page-host foliate-view');
      const d = v.renderer.getContents()[0].doc;
      let rules = 0, decls = 0, sheets = 0, sample = [];
      for (const sh of [...d.styleSheets]) {
        let rs = null;
        try { rs = sh.cssRules; } catch { continue; }
        sheets++;
        for (const r of rs || []) {
          rules++;
          if (r.style) decls += r.style.length;
          if (sample.length < 6 && r.selectorText && !/^:root:root/.test(r.selectorText)) {
            sample.push(r.selectorText.slice(0, 40) + '{' + (r.style ? r.style.length : 0) + '}');
          }
        }
      }
      return { sheets, rules, decls, sample };
    })()`));

    // ---- I6 layout / pagination ---------------------------------------------
    note("layout", await s.evaluate(P_LAYOUT));
    if (result.probes.layout?.flow !== FLOW_VALUES[flow]) {
      anomaly("flow setting did not reach the renderer", { wanted: FLOW_VALUES[flow], got: result.probes.layout });
    }

    // ---- I1 CFI identity -----------------------------------------------------
    const cfi = await s.evaluate(P_CFI);
    note("cfi", cfi);
    if (!cfi?.cfis?.length) anomaly("no CFIs could be taken", cfi);
    for (const c of cfi.cfis ?? []) if (String(c.cfi).startsWith("ERROR")) anomaly("getCFI threw", c);

    // ---- I2 round-trip -------------------------------------------------------
    const trips = [];
    for (const c of (cfi.cfis ?? []).slice(0, 2)) {
      const landed = await s.evaluate(goToAndReport(c.cfi));
      trips.push({ from: c, landed });
      if (landed?.error) anomaly("goTo(cfi) failed", { cfi: c.cfi, landed });
      else if (landed.atText && c.text && !c.text.startsWith(landed.atText.slice(0, 8))) {
        anomaly("CFI resolved to different text", { expected: c.text, got: landed.atText, cfi: c.cfi });
      }
    }
    note("cfiRoundTrip", trips);

    // ---- I3 search (through the app's own path) ------------------------------
    const searchT0 = Date.now();
    const search = await s.evaluate(`(async () => {
      const v = document.querySelector('.page-host foliate-view');
      const hits = [];
      try {
        for await (const r of v.search({ query: ${JSON.stringify(SEARCH_TERM)}, scope: 'book' })) {
          if (r?.subitems) for (const s of r.subitems) hits.push({ cfi: s.cfi, excerpt: (s.excerpt?.pre ?? '') + '|' + (s.excerpt?.match ?? '') });
          else if (r?.cfi) hits.push({ cfi: r.cfi, excerpt: '' });
          if (hits.length > 80) break;
        }
      } catch (e) { return { error: String(e) }; }
      return { count: hits.length, first: hits.slice(0, 5) };
    })()`);
    note("search", { ...search, ms: Date.now() - searchT0 });
    if (search?.error) anomaly("search threw", search);

    // ---- I4 annotations: highlight / note / bookmark round-trip --------------
    const anchor = cfi.cfis?.[0]?.cfi;
    if (anchor) {
      const hl = await inv("highlight_create", { bookId: book.id, cfi: anchor, color: "yellow", excerpt: "probe", chapterLabel: null });
      const nt = await inv("note_create", { bookId: book.id, highlightId: null, cfi: anchor, color: null, body: "probe note", chapterLabel: null, title: null });
      const bm = await inv("bookmark_create", { bookId: book.id, cfi: anchor, chapterLabel: null, fraction: 0.1, label: "probe" });
      note("annotationsCreated", {
        highlight: hl?.__err ?? (hl?.id ? "ok" : hl),
        note: nt?.__err ?? (nt?.id ? "ok" : nt),
        bookmark: bm?.__err ?? (bm?.id ? "ok" : bm),
      });
      // Re-read from the database — creation returning an object is not persistence.
      note("annotationsPersisted", {
        highlights: (await inv("highlights_for_book", { bookId: book.id }))?.length ?? null,
        notes: (await inv("notes_for_book", { bookId: book.id }))?.length ?? null,
        bookmarks: (await inv("bookmarks_for_book", { bookId: book.id }))?.length ?? null,
      });
      // And does it DRAW? Persistence without rendering is a silent loss.
      await s.evaluate(`window.location.reload()`);
      await sleep(2500);
      await s.evaluate(
        clickCard(book.title),
      );
      await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      await sleep(2500);
      // Measured: the overlayer is NOT in the section document — it is a property ON the contents
      // object (`contents[0].overlayer`). Looking for `.overlayer` in the doc returns 0 whether the
      // annotation drew or not, which would have made a real loss indistinguishable from success.
      const drawn = await s.evaluate(`(() => {
        const v = document.querySelector('.page-host foliate-view');
        const c = v?.renderer?.getContents?.()?.[0];
        if (!c) return { error: 'no contents' };
        const ov = c.overlayer;
        if (!ov) return { hasOverlayer: false, note: 'contents has no overlayer' };
        const el = ov.element ?? null;
        const svg = el?.tagName?.toLowerCase?.() === 'svg' ? el : el?.querySelector?.('svg');
        return {
          hasOverlayer: true,
          overlayerKeys: Object.keys(ov),
          elementTag: el?.tagName?.toLowerCase?.() ?? null,
          drawnShapes: svg ? svg.children.length : (el ? el.children.length : -1),
          inDoc: !!(el && c.doc?.contains?.(el)),
        };
      })()`);
      note("annotationDrawn", drawn);
    }

    // ---- I5 resume -----------------------------------------------------------
    const target = cfi.cfis?.[2]?.cfi ?? cfi.cfis?.[1]?.cfi ?? anchor;
    if (target) {
      await s.evaluate(goToAndReport(target));
      const before = await s.evaluate(P_WHERE);
      await inv("progress_save", { bookId: book.id, cfi: before.cfi ?? target, fraction: before.fraction ?? 0.2 });
      const saved = await inv("progress_get", { bookId: book.id });
      await s.evaluate(`window.location.reload()`);
      await sleep(2500);
      await s.evaluate(
        clickCard(book.title),
      );
      await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      await sleep(2500);
      const after = await s.evaluate(P_WHERE);
      note("resume", { savedCfi: saved?.cfi ?? null, before, after });
      if (before.sectionIndex != null && after.sectionIndex !== before.sectionIndex) {
        anomaly("resume landed in a different section", { before: before.sectionIndex, after: after.sectionIndex });
      }
    }

    // ---- references ----------------------------------------------------------
    const refs = await inv("refs_for_book", { bookId: book.id });
    note("refs", Array.isArray(refs) ? { count: refs.length } : refs);

    // ---- memory growth over repeated navigation ------------------------------
    const mem = await s.evaluate(`(async () => {
      const v = document.querySelector('.page-host foliate-view');
      const m = () => performance.memory ? performance.memory.usedJSHeapSize : null;
      const start = m();
      const t0 = performance.now();
      for (let i = 0; i < 24; i++) {
        try { await v.renderer.next(); } catch {}
        await new Promise(r => setTimeout(r, 60));
      }
      const navMs = performance.now() - t0;
      for (let i = 0; i < 24; i++) {
        try { await v.renderer.prev(); } catch {}
        await new Promise(r => setTimeout(r, 60));
      }
      await new Promise(r => setTimeout(r, 1200));
      return { startHeap: start, endHeap: m(), navMsFor24: Math.round(navMs) };
    })()`);
    note("memory", mem);

    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.fatal = String(e?.message ?? e);
    console.error(`\n  ✗ ${mode}/${flow}: ${result.fatal}`);
  } finally {
    // Always put the app and the profile back, on every exit path.
    if (sard) { try { await sard.close(); } catch {} }
    const s2 = await launchSard({ port: 9381 }).catch(() => null);
    if (s2 && !s2.skipped) {
      await waitFor(s2, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 60, 400);
      await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
      await s2.close();
    }
    await restoreDb(snap);
    const libDir = join(APP_DATA, "library");
    let removed = 0;
    if (existsSync(libDir)) {
      for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) { rmSync(join(libDir, f), { force: true }); removed++; }
    }
    console.log(`  profile restored; ${removed} imported file(s) removed`);
  }

  const file = join(OUT, `${mode}-${flow}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1), "utf8");
  console.log(`  → ${file}`);
  return result;
}

// ---------------------------------------------------------------------------

function compare(flow) {
  const modes = ["off", "sanitised", "raw"];
  const runs = {};
  for (const m of modes) {
    const f = join(OUT, `${m}-${flow}.json`);
    if (!existsSync(f)) { console.error(`  missing run: ${f}`); return 2; }
    runs[m] = JSON.parse(readFileSync(f, "utf8"));
  }
  const violations = [];
  const base = runs.off;

  // GUARD FIRST: if the three modes delivered the same CSS, every "invariant holds" below is
  // vacuous — it would prove only that nothing happened. Say so loudly rather than pass.
  const eff = modes.map((m) => runs[m].probes.modeEffect ?? {});
  const distinct = new Set(eff.map((e) => `${e.sheets}/${e.rules}/${e.decls}`));
  if (distinct.size === 1) {
    violations.push(
      `VACUOUS: all three modes delivered identical CSS (${[...distinct][0]} sheets/rules/decls) — ` +
        `the book_css setting had NO observable effect on this book, so no invariant below was actually exercised`,
    );
  }

  // I1: CFIs must be identical across modes — this is the data-safety invariant.
  for (const m of ["sanitised", "raw"]) {
    const a = base.probes.cfi?.cfis ?? [];
    const b = runs[m].probes.cfi?.cfis ?? [];
    if (a.length !== b.length) violations.push(`I1 CFI count off=${a.length} ${m}=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].cfi !== b[i].cfi) violations.push(`I1 CFI[${i}] off=${a[i].cfi} ${m}=${b[i].cfi} (text "${a[i].text}" vs "${b[i].text}")`);
      if (a[i].text !== b[i].text) violations.push(`I1 CFI[${i}] anchors DIFFERENT TEXT off="${a[i].text}" ${m}="${b[i].text}"`);
    }
    // I3: search is over text.
    const sa = base.probes.search?.count, sb = runs[m].probes.search?.count;
    if (sa !== sb) violations.push(`I3 search count off=${sa} ${m}=${sb}`);
    const fa = base.probes.search?.first?.[0]?.cfi, fb = runs[m].probes.search?.first?.[0]?.cfi;
    if (fa !== fb) violations.push(`I3 first hit CFI off=${fa} ${m}=${fb}`);
    // Section/paragraph structure must not change — the DOM is the same book.
    if (base.probes.cfi?.paraCount !== runs[m].probes.cfi?.paraCount) {
      violations.push(`I- paragraph count off=${base.probes.cfi?.paraCount} ${m}=${runs[m].probes.cfi?.paraCount}`);
    }
  }

  console.log(`\n  ===== cross-mode comparison (flow=${flow}) =====\n`);
  for (const m of modes) {
    const r = runs[m];
    const L = r.probes.layout ?? {};
    console.log(`  ${m.padEnd(10)} open ${String(r.probes.openMs).padStart(5)}ms | flow ${L.flow} cols ${L.columns} colW ${L.columnWidth} | ` +
      `paras ${r.probes.cfi?.paraCount} | search ${r.probes.search?.count} in ${r.probes.search?.ms}ms | ` +
      `heap ${Math.round((r.probes.memory?.startHeap ?? 0) / 1e6)}→${Math.round((r.probes.memory?.endHeap ?? 0) / 1e6)}MB | ` +
      `anomalies ${r.anomalies.length}${r.ok ? "" : "  FATAL: " + r.fatal}`);
    for (const a of r.anomalies) console.log(`      ⚠ ${a.what}: ${JSON.stringify(a.detail).slice(0, 160)}`);
  }
  console.log("");
  if (violations.length === 0) {
    console.log("  ✓ no cross-mode invariant violations\n");
    return 0;
  }
  console.log(`  ✗ ${violations.length} invariant violation(s):\n`);
  for (const v of violations) console.log(`      ${v}`);
  console.log("");
  return 1;
}

/**
 * THE REAL I4. The per-mode runs above each start from a restored database, so no annotation ever
 * crosses a mode boundary — they prove "a highlight works in mode X", not "a highlight SURVIVES the
 * user changing the setting", which is the case that would silently corrupt real reading data.
 *
 * One launch: anchor a highlight in mode A, switch to mode B, reopen, and demand that the same CFI
 * still resolves to the same text and still draws.
 */
async function crossMode(from, to, flow) {
  mkdirSync(OUT, { recursive: true });
  const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
  const snap = snapshotDb(REPO, `cross-${from}-${to}`);
  const out = { from, to, flow, steps: {}, violations: [] };
  let sard = null;
  try {
    sard = await launchSard({ port: 9386 });
    if (sard.skipped) { console.error(sard.skipped); return null; }
    const s = sard;
    await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
    const inv = (c, p = {}) =>
      s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);

    const styleRaw = await inv("settings_get", { key: "reading_style" });
    const style = typeof styleRaw === "string" && styleRaw ? JSON.parse(styleRaw) : {};
    style.flowMode = flow;
    await inv("settings_set", { key: "reading_style", value: JSON.stringify(style) });

    // Resolve the book BEFORE opening: the card must be clicked by its own exact title, which for an
    // Arabic book cannot be written as an ASCII needle.
    const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });
    let book = ((await list()) || []).find(matchBook);
    if (!book) {
      const p = corpusPathFor(BOOK_MATCH);
      if (!p) throw new Error(`test book "${BOOK_MATCH}" not in library and not in the corpus`);
      // Sard COPIES an imported book into its own library directory, so after import the corpus
      // filename is gone from file_path and `matchBook` can never hit again. Identify it by what it
      // actually is now: the newest row that was not there a moment ago.
      // Sard COPIES an imported book into its own library directory, so after import the corpus
      // filename is gone from file_path and `matchBook` can never hit again. The import RESULT
      // carries the id in both cases — and "already in your library" is the common one here, since
      // the corpus books get imported once and stay.
      const res = await inv("import_books", { paths: [p] });
      await sleep(2000);
      const id = Array.isArray(res) ? res[0]?.id : null;
      const after = (await list()) || [];
      book = after.find((b) => b.id === id) ?? after.find(matchBook);
      if (!book) out.importDiag = { corpusPath: p, importResult: res, libraryCount: after.length };
    }
    if (!book) throw new Error(`test book "${BOOK_MATCH}" could not be imported`);
    out.book = { title: book.title, path: book.file_path, dir: book.dir, language: book.language };

    const open = async (mode) => {
      await inv("settings_set", { key: "book_css", value: mode });
      await s.evaluate(`window.location.reload()`);
      await sleep(3000);
      const hit = await s.evaluate(clickCard(book.title));
      if (!hit) throw new Error(`library card not found for ${book.title}`);
      const ok = await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      await sleep(2200);
      if (!ok) throw new Error(`book never rendered in mode ${mode}`);
    };

    // --- A: anchor in `from` ---
    await open(from);
    const a = await s.evaluate(P_CFI);
    const anchor = a.cfis?.[1] ?? a.cfis?.[0];
    if (!anchor) throw new Error("no CFI could be anchored");
    const hlBefore = (await inv("highlights_for_book", { bookId: book.id }))?.length ?? 0;
    const created = await inv("highlight_create", { bookId: book.id, cfi: anchor.cfi, color: "yellow", excerpt: anchor.text, chapterLabel: null });
    out.steps.anchored = { mode: from, cfi: anchor.cfi, text: anchor.text, created: created?.id ? "ok" : created, effect: await s.evaluate(`(() => {
      const d = document.querySelector('.page-host foliate-view').renderer.getContents()[0].doc;
      let n = 0; for (const sh of [...d.styleSheets]) { try { n += sh.cssRules.length; } catch {} } return n;
    })()`) };

    // --- B: reopen in `to` and demand the anchor still means the same thing ---
    await open(to);
    const b = await s.evaluate(P_CFI);
    const same = b.cfis?.find((c) => c.cfi === anchor.cfi);
    const resolved = await s.evaluate(goToAndReport(anchor.cfi));
    const drawn = await s.evaluate(`(() => {
      const c = document.querySelector('.page-host foliate-view').renderer.getContents()[0];
      const el = c.overlayer?.element ?? null;
      const svg = el?.tagName?.toLowerCase?.() === 'svg' ? el : el?.querySelector?.('svg');
      return { hasOverlayer: !!c.overlayer, shapes: svg ? svg.children.length : -1 };
    })()`);
    const hlAfter = (await inv("highlights_for_book", { bookId: book.id }))?.length ?? 0;
    out.steps.reopened = {
      mode: to, cfiStillProduced: !!same, textThere: same?.text ?? null,
      resolved, drawn, highlightsBefore: hlBefore, highlightsAfter: hlAfter,
      effect: await s.evaluate(`(() => {
        const d = document.querySelector('.page-host foliate-view').renderer.getContents()[0].doc;
        let n = 0; for (const sh of [...d.styleSheets]) { try { n += sh.cssRules.length; } catch {} } return n;
      })()`),
    };

    if (out.steps.anchored.effect === out.steps.reopened.effect) {
      out.violations.push(`VACUOUS: ${from} and ${to} delivered the same rule count (${out.steps.anchored.effect}) — the mode change did nothing`);
    }
    if (!same) out.violations.push(`the anchored paragraph no longer produces the same CFI in ${to}`);
    else if (same.text !== anchor.text) out.violations.push(`CFI ${anchor.cfi} anchors "${anchor.text}" in ${from} but "${same.text}" in ${to}`);
    if (hlAfter !== hlBefore + 1) out.violations.push(`highlight count ${hlBefore} → ${hlAfter} (expected +1) after switching to ${to}`);
    if (drawn.shapes <= 0) out.violations.push(`highlight did not DRAW in ${to} (shapes=${drawn.shapes})`);
    if (resolved?.atText && anchor.text && !anchor.text.trim().startsWith(resolved.atText.trim().slice(0, 8))) {
      out.violations.push(`resolveCFI in ${to} gives "${resolved.atText}", anchored on "${anchor.text}"`);
    }
  } catch (e) {
    out.fatal = String(e?.message ?? e);
  } finally {
    if (sard) { try { await sard.close(); } catch {} }
    await restoreDb(snap);
    const libDir = join(APP_DATA, "library");
    if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) rmSync(join(libDir, f), { force: true });
    console.log("  profile restored");
  }
  writeFileSync(join(OUT, `cross-${from}-to-${to}-${flow}.json`), JSON.stringify(out, null, 1), "utf8");
  console.log(`\n  ${from} → ${to} (${flow})`);
  console.log(`    anchored : ${out.steps.anchored?.cfi} = ${JSON.stringify(out.steps.anchored?.text)} (${out.steps.anchored?.effect} rules)`);
  console.log(`    reopened : sameCFI=${out.steps.reopened?.cfiStillProduced} drawn=${JSON.stringify(out.steps.reopened?.drawn)} ` +
    `highlights ${out.steps.reopened?.highlightsBefore}→${out.steps.reopened?.highlightsAfter} (${out.steps.reopened?.effect} rules)`);
  // A run that DIED proves nothing. Reporting "survived" here because the violations array happened
  // to be empty would be the exact false-green this campaign exists to find.
  if (out.fatal) { console.log(`    ✗ FATAL ${out.fatal} — NOTHING was verified`); return 1; }
  if (out.violations.length) { for (const v of out.violations) console.log(`    ✗ ${v}`); return 1; }
  console.log("    ✓ annotation survived the mode change intact");
  return 0;
}

const flow = arg("flow", "paged");
if (args.includes("--crossmode")) {
  const rc = await crossMode(arg("from", "off"), arg("to", "raw"), flow);
  process.exit(rc ?? 1);
}
if (args.includes("--compare")) process.exit(compare(flow));
const mode = arg("mode", "");
if (!["off", "sanitised", "raw"].includes(mode)) {
  console.error("usage: subsystem.mjs --mode=off|sanitised|raw [--flow=paginated|scrolled] | --compare [--flow=…]");
  process.exit(2);
}
console.log(`\n  ===== subsystem probe: book_css=${mode}, flow=${flow} =====`);
const r = await run(mode, flow);
process.exit(r?.ok ? 0 : 1);
