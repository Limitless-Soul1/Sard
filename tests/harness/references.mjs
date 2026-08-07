// REFERENCES REGRESSION HARNESS — create · load · match/render · update · delete, in all three
// `book_css` modes, on a Latin and an Arabic book.
//
// Two measured facts this encodes, both of which cost a false alarm to learn:
//   1. References are USER-CREATED (a phrase + a note, via `ref_save`), NOT auto-extracted
//      footnotes. Every corpus book reports 0 references, and that is correct, not a defect.
//   2. They are drawn on the foliate OVERLAYER, not through the CSS Custom Highlight registry —
//      which is empty in the section realm. The registry is still sampled below purely to keep that
//      correction visible.
//
//   node tests/harness/references.mjs
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = ["off", "sanitised", "raw"];
const BOOKS = [
  { file: "control-wellformed--alice.epub", label: "Alice (latin)" },
  { file: "arabic-normal--karamazov.epub", label: "Karamazov (arabic)" },
];

// Same transformation as src/lib/references.ts foldPhrase. If this drifts, the reference simply will
// not match and the test FAILS loudly — it cannot pass on a wrong fold.
const TASHKIL_TATWEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const foldPhrase = (s) =>
  s.normalize("NFKC").replace(TASHKIL_TATWEEL, "").replace(/[آأإٱ]/g, "ا").replace(/ى/g, "ي")
    .replace(/ة/g, "ه").toLowerCase().replace(/\s+/g, " ").trim();

/** A phrase that really occurs in the rendered section, plus how often. */
const P_PICK = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d?.body) return { error: 'no doc' };
  const paras = [...d.body.querySelectorAll('p')];
  for (const p of paras) {
    const t = (p.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t.length < 40) continue;
    // CONSECUTIVE words, straight out of the text — filtering short words out first produced
    // "was beginning get", a phrase that occurs zero times, and the reference then had nothing to
    // match. The phrase must be a literal substring of what is rendered.
    const words = t.split(' ');
    if (words.length < 6) continue;
    const phrase = words.slice(1, 4).join(' ');
    if (phrase.length < 8) continue;
    const hay = (d.body.textContent || '').replace(/\\s+/g, ' ');
    return { phrase, occurrences: hay.split(phrase).length - 1, sectionIndex: c.index };
  }
  return { error: 'no suitable phrase' };
})()`;

/**
 * What the reference renderer actually produced.
 *
 * MEASURED CORRECTION: references do NOT use the CSS Custom Highlight registry — that registry is
 * empty in the section realm. They are drawn on the foliate OVERLAYER, via
 * `overlayer.add("sard-ref:<section>:<i>", …, drawRefRule)`. The first probe looked at
 * `CSS.highlights` and reported "nothing rendered" for a reference that may well have drawn: a
 * harness defect that would have been filed as a product bug.
 */
const P_RENDER = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d) return { error: 'no doc' };
  const win = d.defaultView;
  const reg = win.CSS && win.CSS.highlights ? win.CSS.highlights : null;
  const names = [];
  if (reg) { try { for (const [k] of reg) names.push(k); } catch {} }

  const ov = c.overlayer;
  const el = ov?.element ?? null;
  const svg = el && el.tagName && el.tagName.toLowerCase() === 'svg' ? el : (el ? el.querySelector('svg') : null);
  const kids = svg ? [...svg.children] : (el ? [...el.children] : []);
  return {
    registered: names,                 // kept, to prove the Custom Highlight path is NOT the one
    hasOverlayer: !!ov,
    drawnShapes: kids.length,
    shapeTags: [...new Set(kids.map(k => k.tagName.toLowerCase()))].slice(0, 6),
    shapeFills: [...new Set(kids.map(k => k.getAttribute('fill') || k.getAttribute('stroke') || ''))].slice(0, 6),
    sectionIndex: c.index,
  };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}

const out = { startedAt: new Date().toISOString(), books: {}, violations: [] };
const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "refs-test");
let sard = null;
try {
  sard = await launchSard({ port: 9418 });
  if (sard.skipped) { console.error(sard.skipped); process.exit(0); }
  const s = sard;
  await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);
  const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });

  for (const spec of BOOKS) {
    let book = ((await list()) || []).find((b) => (b.file_path ?? "").replace(/\\/g, "/").includes(spec.file));
    if (!book && corpusAvailable() && existsSync(join(corpusDir(), spec.file))) {
      const res = await inv("import_books", { paths: [join(corpusDir(), spec.file)] });
      await sleep(2000);
      const id = Array.isArray(res) ? res[0]?.id : null;
      book = ((await list()) || []).find((b) => b.id === id);
    }
    if (!book) { out.violations.push(`${spec.label}: unavailable`); continue; }

    const openIn = async (mode) => {
      await inv("settings_set", { key: "book_css", value: mode });
      await s.evaluate(`window.location.reload()`);
      await sleep(3000);
      await s.evaluate(`(() => { const t = ${JSON.stringify(book.title)};
        const all = [...document.querySelectorAll('.lib-card')];
        const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
        if (c) c.click(); return !!c; })()`);
      await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      await sleep(2500);
    };

    const rec = { title: book.title, perMode: {} };
    // Pick the phrase ONCE, in `off`, so all three modes reference the identical text.
    await openIn("off");
    const pick = await s.evaluate(P_PICK);
    if (pick.error) { out.violations.push(`${spec.label}: ${pick.error}`); continue; }
    rec.phrase = pick.phrase;
    rec.occurrences = pick.occurrences;
    if (pick.occurrences < 1) out.violations.push(`${spec.label}: chosen phrase occurs ${pick.occurrences} times — the test would prove nothing`);
    // The overlayer also carries stored highlights, so "did the reference draw" is a DELTA, not an
    // absolute count. Baseline it before the reference exists.
    rec.shapesNoRef = (await s.evaluate(P_RENDER)).drawnShapes;
    const fold = foldPhrase(pick.phrase);
    const wc = fold ? fold.split(" ").length : 0;
    rec.fold = fold;

    // CREATE
    const saved = await inv("ref_save", { bookId: book.id, phrase: pick.phrase, phraseFold: fold, wordCount: wc, note: "probe reference" });
    rec.created = saved?.id ? "ok" : saved;
    if (!saved?.id) out.violations.push(`${spec.label}: ref_save did not return a row: ${JSON.stringify(saved).slice(0, 120)}`);

    for (const mode of MODES) {
      await openIn(mode);
      // LOAD
      const rows = await inv("refs_for_book", { bookId: book.id });
      const mine = Array.isArray(rows) ? rows.find((r) => r.id === saved?.id) : null;
      // RENDER
      const render = await s.evaluate(P_RENDER);
      let rules = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view').renderer.getContents()[0].doc;
        let n = 0; for (const sh of [...d.styleSheets]) { try { n += sh.cssRules.length; } catch {} } return n; })()`);
      rec.perMode[mode] = {
        rowCount: Array.isArray(rows) ? rows.length : rows,
        found: !!mine, note: mine?.note ?? null, phrase: mine?.phrase ?? null, fold: mine?.phrase_fold ?? null,
        wordCount: mine?.word_count ?? null,
        render, rules,
      };
      if (!mine) out.violations.push(`${spec.label}/${mode}: the saved reference did not load back`);
      if (mine && mine.phrase_fold !== fold) out.violations.push(`${spec.label}/${mode}: stored fold "${mine.phrase_fold}" != "${fold}"`);
      if (render.error) out.violations.push(`${spec.label}/${mode}: render probe: ${render.error}`);
      if (!render.error && render.drawnShapes <= rec.shapesNoRef) {
        out.violations.push(
          `${spec.label}/${mode}: reference stored but NOTHING drew — overlayer shapes ${rec.shapesNoRef} (no ref) → ${render.drawnShapes} (with ref)`,
        );
      }
    }

    // Invariance across modes.
    const ranges = MODES.map((m) => rec.perMode[m]?.render?.drawnShapes);
    if (new Set(ranges).size !== 1) out.violations.push(`${spec.label}: rendered reference ranges differ by mode: ${MODES.map((m, i) => m + "=" + ranges[i]).join(" ")}`);
    const ruleSet = new Set(MODES.map((m) => rec.perMode[m]?.rules));
    if (ruleSet.size === 1) out.violations.push(`${spec.label}: VACUOUS — all modes delivered ${[...ruleSet][0]} rules`);

    // UPDATE (re-save is the edit path) then DELETE.
    const updated = await inv("ref_save", { bookId: book.id, phrase: pick.phrase, phraseFold: fold, wordCount: wc, note: "edited note" });
    const afterUpdate = await inv("refs_for_book", { bookId: book.id });
    rec.update = {
      returnedId: updated?.id ?? null, sameId: updated?.id === saved?.id,
      count: Array.isArray(afterUpdate) ? afterUpdate.length : afterUpdate,
      note: Array.isArray(afterUpdate) ? afterUpdate.find((r) => r.id === updated?.id)?.note : null,
    };
    if (rec.update.note !== "edited note") out.violations.push(`${spec.label}: re-save did not update the note (got ${JSON.stringify(rec.update.note)})`);
    if (Array.isArray(afterUpdate) && Array.isArray(await inv("refs_for_book", { bookId: book.id })) && rec.update.count !== 1) {
      out.violations.push(`${spec.label}: re-save produced ${rec.update.count} rows, expected 1 (edit, not duplicate)`);
    }

    const del = await inv("ref_delete", { id: saved?.id });
    const afterDel = await inv("refs_for_book", { bookId: book.id });
    rec.deleted = { ok: del === true, remaining: Array.isArray(afterDel) ? afterDel.length : afterDel };
    if (rec.deleted.remaining !== 0) out.violations.push(`${spec.label}: after delete ${rec.deleted.remaining} reference(s) remain`);

    out.books[spec.label] = rec;
  }
} catch (e) {
  out.fatal = String(e?.message ?? e);
} finally {
  if (sard) { try { await sard.close(); } catch {} }
  const s2 = await launchSard({ port: 9419 }).catch(() => null);
  if (s2 && !s2.skipped) {
    await waitFor(s2, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 60, 400);
    await s2.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'book_css', value: 'off' })`);
    await s2.close();
  }
  await restoreDb(snap);
  const libDir = join(APP_DATA, "library");
  let removed = 0;
  if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) { rmSync(join(libDir, f), { force: true }); removed++; }
  console.log(`  profile restored; ${removed} file(s) removed`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "references.json"), JSON.stringify(out, null, 1), "utf8");
console.log("\n  ===== REFERENCES x MODES =====");
for (const [label, r] of Object.entries(out.books)) {
  console.log(`\n  ${label}  phrase=${JSON.stringify(r.phrase)} (x${r.occurrences} in section)`);
  console.log(`    fold=${JSON.stringify(r.fold)}  created=${r.created}`);
  for (const m of MODES) {
    const p = r.perMode[m] ?? {};
    console.log(`    ${m.padEnd(10)} rows=${p.rowCount} found=${p.found} shapes=${r.shapesNoRef}→${p.render?.drawnShapes} tags=${JSON.stringify(p.render?.shapeTags)} customHL=${JSON.stringify(p.render?.registered)} rules=${p.rules}`);
  }
  console.log(`    update: sameId=${r.update?.sameId} count=${r.update?.count} note=${JSON.stringify(r.update?.note)}`);
  console.log(`    delete: ok=${r.deleted?.ok} remaining=${r.deleted?.remaining}`);
}
if (out.fatal) { console.log(`\n  ✗ FATAL ${out.fatal} — NOTHING verified\n`); process.exit(1); }
if (out.violations.length) { console.log(`\n  ✗ ${out.violations.length} violation(s):`); for (const v of out.violations) console.log(`      ${v}`); console.log(""); process.exit(1); }
console.log("\n  ✓ references: create, load, render, update, delete — all mode-invariant\n");
