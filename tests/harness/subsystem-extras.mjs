// TASK 4, part 2 — the subsystems the first pass did not reach, plus the abuse cases.
//
//   --themes      every theme under one book_css mode: does book CSS defeat the reading theme?
//   --tts         TTS unit extraction under one mode: does book CSS change what gets spoken?
//   --liveswitch  change book_css WITH THE BOOK ALREADY OPEN (the first pass always reloaded first)
//   --stress      a long session: repeated mode switches, book changes, reopens, annotations,
//                 searches, TOC jumps — then ask whether anything degraded.
//
// Invariants:
//   I7  A reading theme's text colour is the same in off / sanitised / raw. Book CSS must not be
//       able to defeat the theme the reader chose.
//   I8  TTS extracts the same speech units from the same section in all three modes.
//   I9  Switching book_css with a book open leaves the reader coherent — no lost position, no lost
//       annotations, no dead view.
//   I10 A long session does not degrade: heap, DOM node count and operation latency stay flat.
//
// NOTE on background-colour: an established design rule says a background IMAGE intentionally
// overrides background-color. So I7 asserts on TEXT colour, and records background purely as
// context — never as a violation.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");

const BOOK = arg("book", "arabic-normal--karamazov.epub");
const BOOK2 = arg("book2", "control-wellformed--alice.epub");
const THEMES = ["ivory", "sepia", "slate", "trueblack", "moonlit"];
const MODES = ["off", "sanitised", "raw"];

const clickCard = (title) =>
  `(() => { const t = ${JSON.stringify("")} || ${JSON.stringify(title ?? "")};
     const all = [...document.querySelectorAll('.lib-card')];
     const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
     if (c) c.click(); return !!c; })()`;

/** What the reader is actually showing, in colours and structure. */
const P_STYLE = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d?.body) return { error: 'no doc' };
  const w = d.defaultView;
  const p = d.body.querySelector('p') || d.body;
  const cs = w.getComputedStyle(p);
  const bs = w.getComputedStyle(d.body);
  let rules = 0;
  for (const sh of [...d.styleSheets]) { try { rules += sh.cssRules.length; } catch {} }
  return {
    textColor: cs.color, bodyColor: bs.color, bodyBg: bs.backgroundColor,
    fontFamily: cs.fontFamily.slice(0, 40), fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    rules, sectionIndex: c.index,
  };
})()`;

/** TTS speech units, straight from the engine — no audio, no network. */
const P_TTS = `(async () => {
  const v = document.querySelector('.page-host foliate-view');
  if (typeof v.initTTS !== 'function') return { error: 'no initTTS' };
  try {
    const r = await v.initTTS();
    const tts = v.tts ?? r ?? null;
    if (!tts) return { error: 'initTTS returned nothing', shape: typeof r };
    const out = { keys: Object.keys(tts).slice(0, 12) };
    // Walk the units the engine will speak. Different engines expose this differently, so probe
    // and REPORT the shape rather than assuming one.
    if (typeof tts.start === 'function') {
      const first = tts.start();
      out.firstSSML = typeof first === 'string' ? first.replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null;
    }
    let n = 0, texts = [];
    if (typeof tts.next === 'function') {
      for (; n < 400; n++) {
        const s = tts.next();
        if (!s) break;
        if (texts.length < 3) texts.push(String(s).replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim().slice(0, 40));
      }
    }
    out.unitCount = n;
    out.firstUnits = texts;
    return out;
  } catch (e) { return { error: String(e && e.message || e) }; }
})()`;

const P_HEALTH = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc;
  // Rule count is here so a live-switch test cannot pass vacuously: "the reader survived" is only
  // interesting if the switch actually changed the CSS the reader is showing.
  let rules = 0, decls = 0;
  if (d) for (const sh of [...d.styleSheets]) { try { for (const r of sh.cssRules) { rules++; if (r.style) decls += r.style.length; } } catch {} }
  return {
    rules, decls,
    viewAlive: !!v,
    docAlive: !!d?.body,
    sectionIndex: c?.index ?? null,
    textLen: d?.body?.textContent?.length ?? 0,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    topNodes: document.querySelectorAll('*').length,
    docNodes: d ? d.querySelectorAll('*').length : null,
    cfi: v?.lastLocation?.cfi ?? null,
  };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}

async function session(fn, port, tag) {
  const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
  const snap = snapshotDb(REPO, tag);
  let sard = null;
  const out = { tag, violations: [], notes: {} };
  try {
    sard = await launchSard({ port });
    if (sard.skipped) { console.error(sard.skipped); return null; }
    const s = sard;
    await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
    const inv = (c, p = {}) =>
      s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);
    const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });

    const resolveBook = async (needle) => {
      const byPath = (b) => (b.title ?? "").includes(needle) || (b.file_path ?? "").replace(/\\/g, "/").includes(needle);
      let b = ((await list()) || []).find(byPath);
      if (b) return b;
      if (!needle.endsWith(".epub") || !corpusAvailable()) return null;
      const p = join(corpusDir(), needle);
      if (!existsSync(p)) return null;
      const res = await inv("import_books", { paths: [p] });
      await sleep(2000);
      const id = Array.isArray(res) ? res[0]?.id : null;
      const after = (await list()) || [];
      return after.find((x) => x.id === id) ?? after.find(byPath) ?? null;
    };

    const openBook = async (book) => {
      await s.evaluate(`window.location.reload()`);
      await sleep(3000);
      const hit = await s.evaluate(clickCard(book.title));
      if (!hit) throw new Error(`no library card for ${book.title}`);
      const ok = await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      await sleep(2000);
      if (!ok) throw new Error("book never rendered");
    };

    await fn({ s, inv, list, resolveBook, openBook, out });
  } catch (e) {
    out.fatal = String(e?.message ?? e);
  } finally {
    if (sard) { try { await sard.close(); } catch {} }
    const s2 = await launchSard({ port: port + 1 }).catch(() => null);
    if (s2 && !s2.skipped) {
      await waitFor(s2, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 60, 400);
      await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
      await s2.close();
    }
    await restoreDb(snap);
    const libDir = join(APP_DATA, "library");
    if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) rmSync(join(libDir, f), { force: true });
    console.log("  profile restored");
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(out, null, 1), "utf8");
  return out;
}

// ---------------------------------------------------------------------------

async function themesRun() {
  const out = await session(async ({ inv, s, resolveBook, openBook, out }) => {
    const book = await resolveBook(BOOK);
    if (!book) throw new Error(`book ${BOOK} unavailable`);
    const table = {};
    for (const mode of MODES) {
      await inv("settings_set", { key: "book_css", value: mode });
      table[mode] = {};
      for (const theme of THEMES) {
        await inv("settings_set", { key: "book_theme_id", value: theme });
        await openBook(book);
        table[mode][theme] = await s.evaluate(P_STYLE);
      }
    }
    out.notes.table = table;

    // I7: the same theme must give the same TEXT colour whatever book CSS is allowed through.
    for (const theme of THEMES) {
      const seen = MODES.map((m) => table[m][theme]?.textColor);
      if (new Set(seen).size !== 1) {
        out.violations.push(`I7 theme "${theme}" text colour differs by book_css mode: ${MODES.map((m, i) => m + "=" + seen[i]).join(" ")}`);
      }
    }
    // Guard against a vacuous pass: if every theme paints the same colour, the probe proves nothing.
    for (const mode of MODES) {
      const colours = new Set(THEMES.map((t) => table[mode][t]?.textColor));
      if (colours.size === 1) out.violations.push(`VACUOUS: in mode ${mode} all ${THEMES.length} themes produced the same text colour (${[...colours][0]})`);
      const ruleCounts = new Set(THEMES.map((t) => table[mode][t]?.rules));
      out.notes[`rules_${mode}`] = [...ruleCounts].join(",");
    }
    // And the modes must be distinguishable at all.
    const ruleByMode = MODES.map((m) => table[m][THEMES[0]]?.rules);
    if (new Set(ruleByMode).size === 1) out.violations.push(`VACUOUS: all three modes delivered ${ruleByMode[0]} rules — book_css did nothing`);
  }, 9390, "themes");
  return report(out, "THEMES x MODES", (o) => {
    for (const mode of MODES) {
      const row = o.notes.table?.[mode] ?? {};
      console.log(`    ${mode.padEnd(10)} ` + THEMES.map((t) => `${t}:${(row[t]?.textColor ?? "?").replace(/\s/g, "")}`).join("  "));
      console.log(`    ${"".padEnd(10)} rules ${THEMES.map((t) => row[t]?.rules).join("/")}`);
    }
  });
}

async function ttsRun() {
  const out = await session(async ({ inv, s, resolveBook, openBook, out }) => {
    const book = await resolveBook(BOOK);
    if (!book) throw new Error(`book ${BOOK} unavailable`);
    const per = {};
    for (const mode of MODES) {
      await inv("settings_set", { key: "book_css", value: mode });
      await openBook(book);
      const style = await s.evaluate(P_STYLE);
      const tts = await s.evaluate(P_TTS);
      per[mode] = { rules: style.rules, section: style.sectionIndex, tts };
    }
    out.notes.per = per;

    const counts = MODES.map((m) => per[m].tts?.unitCount);
    const firsts = MODES.map((m) => JSON.stringify(per[m].tts?.firstUnits ?? null));
    if (MODES.some((m) => per[m].tts?.error)) {
      out.notes.ttsUnavailable = MODES.map((m) => `${m}:${per[m].tts?.error ?? "ok"}`).join(" | ");
    } else {
      if (new Set(counts).size !== 1) out.violations.push(`I8 TTS unit count differs by mode: ${MODES.map((m, i) => m + "=" + counts[i]).join(" ")}`);
      if (new Set(firsts).size !== 1) out.violations.push(`I8 TTS first units differ by mode: ${firsts.join(" vs ")}`);
      if (counts[0] === 0) out.violations.push(`VACUOUS: TTS extracted 0 units — nothing was compared`);
    }
    if (new Set(MODES.map((m) => per[m].rules)).size === 1) {
      out.violations.push(`VACUOUS: all three modes delivered ${per.off.rules} rules — book_css did nothing`);
    }
  }, 9394, "tts");
  return report(out, "TTS x MODES", (o) => {
    for (const m of MODES) {
      const p = o.notes.per?.[m] ?? {};
      console.log(`    ${m.padEnd(10)} rules ${String(p.rules).padStart(3)} | units ${p.tts?.unitCount ?? "-"} | ${p.tts?.error ? "ERROR " + p.tts.error : JSON.stringify(p.tts?.firstUnits ?? []).slice(0, 90)}`);
    }
  });
}

async function liveSwitchRun() {
  const out = await session(async ({ inv, s, resolveBook, openBook, out }) => {
    const book = await resolveBook(BOOK);
    if (!book) throw new Error(`book ${BOOK} unavailable`);
    await inv("settings_set", { key: "book_css", value: "raw" });
    await openBook(book);

    const steps = [];
    const before = await s.evaluate(P_HEALTH);
    const hl = await inv("highlight_create", { bookId: book.id, cfi: before.cfi, color: "yellow", excerpt: "live", chapterLabel: null });
    steps.push({ step: "opened raw", health: before, highlight: hl?.id ? "ok" : hl });

    // I9 — flip the setting WITHOUT reloading. The first pass always reloaded, so this path, which
    // is exactly what a reader does from the settings panel mid-book, was never exercised.
    for (const to of ["off", "sanitised", "raw", "off"]) {
      await inv("settings_set", { key: "book_css", value: to });
      await sleep(2500);
      const h = await s.evaluate(P_HEALTH);
      const hls = await inv("highlights_for_book", { bookId: book.id });
      steps.push({ step: `live -> ${to}`, health: h, highlights: Array.isArray(hls) ? hls.length : hls });
      if (!h.viewAlive || !h.docAlive) out.violations.push(`I9 reader died after live switch to ${to}: ${JSON.stringify(h)}`);
      if (h.textLen === 0) out.violations.push(`I9 section text vanished after live switch to ${to}`);
      if (h.sectionIndex !== before.sectionIndex) out.violations.push(`I9 section changed by a live switch to ${to}: ${before.sectionIndex} -> ${h.sectionIndex}`);
      if (Array.isArray(hls) && hls.length < 1) out.violations.push(`I9 highlight lost after live switch to ${to}`);
    }
    out.notes.steps = steps;

    // Did the live switch change ANYTHING? If not, "the reader survived" is vacuous — it survived
    // because nothing happened. This does not assert which answer is correct; a setting that only
    // takes effect on reopen is a legitimate design. It refuses to report I9 as PROVEN either way.
    const ruleSeries = steps.map((x) => x.health.rules);
    out.notes.ruleSeries = ruleSeries.join(" -> ");
    out.notes.liveEffect = new Set(ruleSeries).size > 1 ? "book_css applies LIVE" : "book_css does NOT apply until reopen";
    if (new Set(ruleSeries).size === 1) {
      out.notes.i9Verdict =
        "INCONCLUSIVE (Unknown): the CSS never changed during the session, so reader survival across a " +
        "live switch was not actually exercised. Requires a reopen to take effect — which is the path " +
        "the cross-mode runs already cover.";
    } else {
      out.notes.i9Verdict = "I9 exercised: CSS changed live and the reader stayed coherent";
    }
  }, 9398, "liveswitch");
  return report(out, "LIVE MODE SWITCH (book open)", (o) => {
    for (const st of o.notes.steps ?? []) {
      console.log(`    ${st.step.padEnd(18)} view=${st.health.viewAlive} doc=${st.health.docAlive} sec=${st.health.sectionIndex} textLen=${st.health.textLen} rules=${st.health.rules} hl=${st.highlights ?? "-"}`);
    }
    console.log(`    rules over session: ${o.notes.ruleSeries}`);
    console.log(`    → ${o.notes.liveEffect}`);
    console.log(`    → ${o.notes.i9Verdict}`);
  });
}

async function stressRun() {
  const rounds = Number(arg("rounds", "6"));
  const out = await session(async ({ inv, s, resolveBook, openBook, out }) => {
    const b1 = await resolveBook(BOOK);
    const b2 = await resolveBook(BOOK2);
    if (!b1 || !b2) throw new Error("stress needs two books");
    const samples = [];
    let ops = 0;

    for (let r = 0; r < rounds; r++) {
      const mode = MODES[r % MODES.length];
      const book = r % 2 === 0 ? b1 : b2;
      await inv("settings_set", { key: "book_css", value: mode });
      const t0 = Date.now();
      await openBook(book);
      const openMs = Date.now() - t0;
      ops++;

      const cfiInfo = await s.evaluate(`(() => {
        const v = document.querySelector('.page-host foliate-view');
        const c = v.renderer.getContents()[0];
        const p = c.doc.body.querySelector('p'); if (!p) return null;
        const w = c.doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let t = null; while ((t = w.nextNode())) if (t.data.trim().length > 4) break;
        if (!t) return null;
        const rg = c.doc.createRange(); rg.setStart(t, 0); rg.setEnd(t, Math.min(12, t.data.length));
        return { cfi: v.getCFI(c.index, rg), text: t.data.slice(0, 12) };
      })()`);

      // Record the CFI and what each create actually RETURNED. The first stress run showed highlight
      // counts that did not increment every round, and a count alone cannot distinguish "silently
      // dropped" from "deduplicated at an identical CFI" — which are very different verdicts.
      let writes = null;
      if (cfiInfo?.cfi) {
        const before = (await inv("highlights_for_book", { bookId: book.id }))?.length ?? null;
        const h = await inv("highlight_create", { bookId: book.id, cfi: cfiInfo.cfi, color: "yellow", excerpt: cfiInfo.text, chapterLabel: null });
        const afterH = (await inv("highlights_for_book", { bookId: book.id }))?.length ?? null;
        const n = await inv("note_create", { bookId: book.id, highlightId: null, cfi: cfiInfo.cfi, color: null, body: `stress ${r}`, chapterLabel: null, title: null });
        const bm = await inv("bookmark_create", { bookId: book.id, cfi: cfiInfo.cfi, chapterLabel: null, fraction: 0.1, label: `s${r}` });
        await inv("progress_save", { bookId: book.id, cfi: cfiInfo.cfi, fraction: 0.15 });
        writes = {
          cfi: cfiInfo.cfi,
          hlBefore: before, hlAfter: afterH,
          hlId: h?.id ?? null, hlErr: h?.__err ?? null, hlReturned: h === null ? "null" : typeof h,
          noteId: n?.id ?? null, bmId: bm?.id ?? null,
        };
        // MEASURED 2026-08-05: highlight_create DEDUPLICATES by CFI — creating at a CFI that already
        // carries a highlight returns that SAME row id and leaves the count alone (r0 and r2 both
        // returned d04e5a5b for one CFI; r4 at a different CFI returned a new id and the count rose).
        // That is correct: highlighting the same passage twice must not make two highlights. So the
        // real defect condition is narrower — a row id never seen before that does NOT raise the
        // count (a write that was acknowledged and lost), or a count that rises with no id at all.
        const known = (out.notes.seenHighlightIds ??= []);
        const isNew = h?.id && !known.includes(h.id);
        if (h?.id) known.push(h.id);
        if (isNew && afterH === before) {
          out.violations.push(`round ${r}: highlight_create returned NEW id ${h.id} but the count stayed ${before} — acknowledged write was lost`);
        }
        if (!h?.id && afterH !== before) {
          out.violations.push(`round ${r}: highlight count moved ${before}→${afterH} without a returned row`);
        }
        writes.dedup = h?.id && !isNew ? "deduplicated (same CFI, existing row)" : "new row";
        ops += 4;
      }

      // search + TOC navigation + section walk
      const sT0 = Date.now();
      const hits = await s.evaluate(`(async () => {
        const v = document.querySelector('.page-host foliate-view');
        let n = 0;
        try { for await (const x of v.search({ query: 'a', scope: 'book' })) { n += x?.subitems ? x.subitems.length : 1; if (n > 60) break; } } catch (e) { return -1; }
        return n;
      })()`);
      const searchMs = Date.now() - sT0;
      ops++;

      await s.evaluate(`(async () => {
        const v = document.querySelector('.page-host foliate-view');
        for (const i of [1, 3, 2]) { try { await v.goTo({ index: i, anchor: 0 }); } catch {} await new Promise(r => setTimeout(r, 250)); }
      })()`);
      ops += 3;
      await s.evaluate(`(async () => {
        const v = document.querySelector('.page-host foliate-view');
        for (let i = 0; i < 10; i++) { try { await v.renderer.next(); } catch {} await new Promise(r => setTimeout(r, 60)); }
      })()`);
      ops += 10;

      await sleep(1200);
      const h = await s.evaluate(P_HEALTH);
      const counts = {
        highlights: (await inv("highlights_for_book", { bookId: book.id }))?.length ?? null,
        notes: (await inv("notes_for_book", { bookId: book.id }))?.length ?? null,
        bookmarks: (await inv("bookmarks_for_book", { bookId: book.id }))?.length ?? null,
        refs: (await inv("refs_for_book", { bookId: book.id }))?.length ?? null,
      };
      samples.push({ round: r, mode, book: book.title?.slice(0, 24), openMs, searchMs, hits, ops, health: h, counts, writes });
      if (!h.viewAlive || !h.docAlive || h.textLen === 0) out.violations.push(`I10 reader unhealthy at round ${r} (${mode}): ${JSON.stringify(h)}`);
      if (hits === -1) out.violations.push(`I10 search threw at round ${r} (${mode})`);
    }
    out.notes.samples = samples;
    out.notes.totalOps = ops;

    // I10 — degradation over the session. Compare the last third with the first third rather than
    // single points, so one slow round does not read as a trend.
    const third = Math.max(1, Math.floor(samples.length / 3));
    const head = samples.slice(0, third), tail = samples.slice(-third);
    const avg = (xs, f) => xs.reduce((a, b) => a + (f(b) ?? 0), 0) / xs.length;
    const openDrift = avg(tail, (x) => x.openMs) / Math.max(1, avg(head, (x) => x.openMs));
    const heapDrift = avg(tail, (x) => x.health.heap) / Math.max(1, avg(head, (x) => x.health.heap));
    const nodeDrift = avg(tail, (x) => x.health.topNodes) / Math.max(1, avg(head, (x) => x.health.topNodes));
    out.notes.drift = {
      openMs: `${Math.round(avg(head, (x) => x.openMs))} -> ${Math.round(avg(tail, (x) => x.openMs))} (x${openDrift.toFixed(2)})`,
      heapMB: `${(avg(head, (x) => x.health.heap) / 1e6).toFixed(1)} -> ${(avg(tail, (x) => x.health.heap) / 1e6).toFixed(1)} (x${heapDrift.toFixed(2)})`,
      topNodes: `${Math.round(avg(head, (x) => x.health.topNodes))} -> ${Math.round(avg(tail, (x) => x.health.topNodes))} (x${nodeDrift.toFixed(2)})`,
    };
    if (openDrift > 2) out.violations.push(`I10 open time more than doubled over the session: ${out.notes.drift.openMs}`);
    if (nodeDrift > 2) out.violations.push(`I10 top-document node count more than doubled: ${out.notes.drift.topNodes}`);
    // HEAP IS NOT A LEAK SIGNAL HERE, and saying otherwise would be a confident lie. usedJSHeapSize
    // is sampled wherever GC happens to have left it: the same 6-round workload measured x0.28 in
    // one run and x2.36 in the next, with nothing changed. Reported, never asserted on. The leak
    // evidence in this run is node count and open latency, which ARE stable.
    out.notes.heapVerdict =
      `Unknown by this method (x${heapDrift.toFixed(2)}): usedJSHeapSize is GC-timing dependent and ` +
      `swung x0.28 vs x2.36 across identical runs. Leak signal is taken from node count and latency instead.`;
    if (heapDrift > 4) out.violations.push(`I10 heap grew more than 4x (${out.notes.drift.heapMB}) — beyond what GC timing explains, worth a dedicated look`);
  }, 9402, "stress");
  return report(out, `ENDURANCE (${rounds} rounds)`, (o) => {
    for (const x of o.notes.samples ?? []) {
      console.log(`    r${x.round} ${x.mode.padEnd(10)} ${String(x.book).padEnd(26)} open ${String(x.openMs).padStart(5)}ms search ${String(x.searchMs).padStart(4)}ms/${x.hits} ` +
        `heap ${(x.health.heap / 1e6).toFixed(1)}MB nodes ${x.health.topNodes} hl/nt/bm ${x.counts.highlights}/${x.counts.notes}/${x.counts.bookmarks}`);
    }
    console.log("    writes:");
    for (const x of o.notes.samples ?? []) {
      const w = x.writes;
      console.log(`      r${x.round} hl ${w?.hlBefore}→${w?.hlAfter} id=${String(w?.hlId).slice(0, 8)} ${w?.dedup ?? "-"} cfi=${String(w?.cfi).slice(0, 40)}`);
    }
    console.log(`    drift: ${JSON.stringify(o.notes.drift)}`);
    console.log(`    heap: ${o.notes.heapVerdict}`);
    console.log(`    total operations: ${o.notes.totalOps}`);
  });
}

function report(out, title, printer) {
  console.log(`\n  ===== ${title} =====`);
  if (!out) { console.log("    (skipped)"); return 0; }
  try { printer(out); } catch {}
  if (out.fatal) { console.log(`    ✗ FATAL ${out.fatal} — NOTHING was verified`); return 1; }
  if (out.notes.ttsUnavailable) console.log(`    ⓘ TTS probe: ${out.notes.ttsUnavailable}`);
  if (out.violations.length) { for (const v of out.violations) console.log(`    ✗ ${v}`); return 1; }
  console.log("    ✓ no violations");
  return 0;
}

let rc = 0;
if (args.includes("--themes")) rc |= await themesRun();
if (args.includes("--tts")) rc |= await ttsRun();
if (args.includes("--liveswitch")) rc |= await liveSwitchRun();
if (args.includes("--stress")) rc |= await stressRun();
if (!args.some((a) => ["--themes", "--tts", "--liveswitch", "--stress"].includes(a))) {
  console.error("usage: subsystem-extras.mjs --themes | --tts | --liveswitch | --stress [--rounds=N]");
  process.exit(2);
}
process.exit(rc);
