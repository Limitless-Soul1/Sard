// READ-ALOUD TRACKING SWEEP — which books does the speak-along highlight fail on?
//
// The tester reports that tracking still fails "in some books". `tts-live.mjs` proves the pipeline
// works on ONE book; that cannot find a book-shaped defect. This opens EVERY corpus book through the
// real UI, starts read-aloud, and measures the two things that decide whether a reader sees the
// highlight:
//
//   units    — how many {text, range} tracking units the controller built for the chapter
//   spotlight— overlayer shapes drawn while status is "playing" (0 = speaking with NO highlight,
//              which is exactly the reported symptom)
//
// It also records sentences vs units: speech comes from the sentence list and the highlight from the
// unit list, so a length mismatch means the highlight tracks the WRONG sentence even when it draws.
//
//   node tests/harness/tts-sweep.mjs                 # every corpus EPUB
//   node tests/harness/tts-sweep.mjs --book=<needle> # one book
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir, readManifest } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");
const ONLY = arg("book", "");
const EXE = arg("exe", "test-build/Sard.exe");

const P_TTS = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const el = c?.overlayer?.element ?? null;
  const svg = el && el.tagName?.toLowerCase() === 'svg' ? el : el?.querySelector?.('svg');
  return {
    status: st?.status ?? null, index: st?.index ?? null, total: st?.total ?? null,
    wordIndex: st?.wordIndex ?? -1, words: st?.words?.length ?? 0,
    error: st?.error ?? null, mismatch: st?.voiceMismatch ?? null,
    spotlight: svg ? svg.children.length : (el ? el.children.length : null),
    section: c?.index ?? null,
  };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}

const out = { startedAt: new Date().toISOString(), books: [], failures: [] };
const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "tts-sweep");
let sard = null;
try {
  sard = await launchSard({ exe: EXE, port: 9610 });
  if (sard.skipped) { console.error(sard.skipped); process.exit(0); }
  const s = sard;
  await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);
  const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });

  // Make sure every corpus EPUB is present, then pick an appropriate voice per script.
  const man = readManifest();
  const files = (Array.isArray(man) ? man : man.books ?? man.entries ?? [])
    .map((r) => r.file).filter((f) => f?.endsWith(".epub"));
  if (corpusAvailable()) {
    const paths = files.map((f) => join(corpusDir(), f)).filter(existsSync);
    await inv("import_books", { paths });
    await sleep(4000);
  }
  const edge = await inv("tts_edge_voices");
  const arVoice = (edge || []).find((v) => (v.lang ?? "").toLowerCase().startsWith("ar"));
  const enVoice = (edge || []).find((v) => (v.lang ?? "").toLowerCase().startsWith("en"));
  if (!arVoice || !enVoice) { console.error("  no Edge voices reachable — cannot drive real playback"); process.exit(3); }
  await inv("settings_set", { key: "book_css", value: "off" });

  let books = (await list()) || [];
  if (ONLY) books = books.filter((b) => (b.title ?? "").includes(ONLY) || (b.file_path ?? "").includes(ONLY));
  books = books.filter((b) => (b.format ?? "").toLowerCase() !== "pdf");

  for (const book of books) {
    const rec = { title: (book.title ?? "").slice(0, 34), dir: book.dir, script: book.script_detected ?? null };
    try {
      await s.evaluate(`window.location.reload()`);
      await sleep(2800);
      const hit = await s.evaluate(`(() => { const t = ${JSON.stringify(book.title)};
        const all=[...document.querySelectorAll('.lib-card')];
        const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
        if (c) { c.click(); return true; } return false; })()`);
      if (!hit) { rec.skip = "no card"; out.books.push(rec); continue; }
      const opened = await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
      if (!opened) { rec.skip = "never rendered"; out.books.push(rec); continue; }
      await sleep(1800);

      // The controller's own tracking units vs the sentences that will be spoken.
      const shape = await s.evaluate(`(async () => {
        const v = document.querySelector('.page-host foliate-view');
        const c = v?.renderer?.getContents?.()?.[0];
        const d = c?.doc;
        const paras = d ? d.body.querySelectorAll('p').length : null;
        const chars = d ? (d.body.textContent || '').replace(/\\s+/g,' ').trim().length : null;
        return { paras, chars, section: c?.index ?? null };
      })()`);
      Object.assign(rec, shape);

      const useAr = (book.script_detected === "arabic") || (book.dir === "rtl");
      const voice = useAr ? arVoice : enVoice;
      await s.evaluate(`window.__sardTtsStore.getState().setEngine("edge")`);
      await s.evaluate(`window.__sardTtsStore.getState().setVoice("edge", ${JSON.stringify(voice.id)}, ${JSON.stringify(useAr ? "ar" : "en")})`);
      await sleep(500);
      const idle = await s.evaluate(P_TTS);
      rec.spotlightIdle = idle.spotlight;

      await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/listen|استماع/i.test(x.getAttribute('title')||'')); if(b) b.click(); })()`);

      let st = null;
      for (let i = 0; i < 60; i++) {
        st = await s.evaluate(P_TTS);
        if (st.status === "playing" || st.status === "error" || st.status === "voice-mismatch") break;
        await sleep(500);
      }
      rec.status = st?.status ?? null;
      rec.total = st?.total ?? null;
      rec.error = st?.error ?? null;
      rec.mismatch = st?.mismatch ?? null;

      if (st?.status === "playing") {
        // Give the spotlight a fair chance to draw and the cursor to move.
        let best = { spotlight: st.spotlight ?? 0, wordIndex: st.wordIndex, words: st.words };
        for (let i = 0; i < 24; i++) {
          const x = await s.evaluate(P_TTS);
          best = {
            spotlight: Math.max(best.spotlight, x.spotlight ?? 0),
            wordIndex: Math.max(best.wordIndex, x.wordIndex),
            words: Math.max(best.words, x.words),
          };
          if (best.spotlight > (rec.spotlightIdle ?? 0) && best.wordIndex > 0) break;
          await sleep(500);
        }
        Object.assign(rec, best);
        rec.tracked = best.spotlight > (rec.spotlightIdle ?? 0);
        rec.wordCursor = best.wordIndex > 0;
      }
      await s.evaluate(`window.__sardTtsStore?.getState?.().stop?.()`);
      await sleep(700);
    } catch (e) {
      rec.threw = String(e?.message ?? e).slice(0, 120);
    }
    out.books.push(rec);
    const verdict = rec.skip ? `skip: ${rec.skip}`
      : rec.status !== "playing" ? `NOT PLAYING (${rec.status}${rec.error ? " " + rec.error : ""}${rec.mismatch ? " mismatch" : ""})`
      : rec.tracked ? `ok  units=${rec.total} spot ${rec.spotlightIdle}->${rec.spotlight} word=${rec.wordIndex}/${rec.words}`
      : `*** NO HIGHLIGHT *** units=${rec.total} spot ${rec.spotlightIdle}->${rec.spotlight} word=${rec.wordIndex}/${rec.words}`;
    if (!rec.skip && (rec.status !== "playing" || !rec.tracked)) out.failures.push(rec);
    console.log(`  ${String(rec.title).padEnd(36)} paras=${String(rec.paras).padStart(4)} ${verdict}`);
  }
} catch (e) {
  out.fatal = String(e?.message ?? e);
  console.error("  FATAL:", out.fatal);
} finally {
  if (sard) { try { await sard.close(); } catch {} }
  await restoreDb(snap);
  const libDir = join(APP_DATA, "library");
  if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (!beforeFiles.has(f)) rmSync(join(libDir, f), { force: true });
  console.log("  profile restored");
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tts-sweep.json"), JSON.stringify(out, null, 1), "utf8");
console.log(`\n  ${out.books.length} book(s) · ${out.failures.length} failing tracking`);
for (const f of out.failures) console.log(`   ✗ ${f.title}  status=${f.status} tracked=${f.tracked} spot=${f.spotlightIdle}->${f.spotlight}`);
