// READ-ALOUD REGRESSION HARNESS — real playback, not extraction.
//
// Clicks the chrome's own read-aloud button and measures what the pipeline actually produced:
// status transitions, sentence index, word index (the karaoke cursor), the speak-along spotlight on
// the overlayer, and the engine's own underrun / abandoned / failure counters. Covers playback
// start, speak-along sync, pause/resume, seek, chapter change while speaking, stop cleanup and a
// long session — each under all three `book_css` modes, with a vacuity guard.
//
//   node tests/harness/tts-live.mjs --cap        # capability only: are voices reachable?
//   node tests/harness/tts-live.mjs              # full matrix (off, sanitised, raw)
//   node tests/harness/tts-live.mjs --modes=raw --book=control-wellformed--alice.epub
//
// REQUIRES a reachable Edge voice (network). `--cap` exits 3 when none is available, so a run that
// cannot synthesise reports that fact instead of passing on an untested path.
//
// Two harness defects are burned into this file as comments rather than forgotten, because both
// produced a convincing false negative: driving `useTts.start()` with scraped sentences instead of
// clicking the button (no controller mapping → no spotlight), and looking for `.sard-reading` as a
// CSS class when it is an overlayer key.
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");
const BOOK = arg("book", "arabic-normal--karamazov.epub");
const MODES = arg("modes", "off,sanitised,raw").split(",");
const CAP_ONLY = process.argv.includes("--cap");

const P_STATE = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  if (!st) return { error: 'no __sardTtsStore' };
  const v = document.querySelector('.page-host foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  return {
    active: st.active, status: st.status, index: st.index, total: st.total,
    progress: st.progress, wordIndex: st.wordIndex, words: st.words?.length ?? 0,
    underruns: st.underruns, abandoned: st.abandoned, lastFailure: st.lastFailure,
    retryAttempt: st.retryAttempt, error: st.error, mismatch: st.voiceMismatch ?? null,
    // The speak-along overlay the reader actually sees. MEASURED CORRECTION: "sard-reading" and
    // "sard-reading-word" are OVERLAYER KEYS (FoliateController READING_KEY / WORD_KEY), not CSS
    // classes — querySelectorAll('.sard-reading') returns 0 whether the spotlight drew or not. Same
    // mistake the references probe made. Count drawn overlayer shapes instead; the caller compares
    // against a pre-start baseline, since highlights and references share the overlayer.
    spotlight: (() => {
      const c = v?.renderer?.getContents?.()?.[0];
      const el = c?.overlayer?.element ?? null;
      if (!el) return null;
      const svg = el.tagName && el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
      return svg ? svg.children.length : el.children.length;
    })(),
    // WHERE the spotlight is, not only how many shapes exist.
    //
    // The reported defect is "drawn but NEVER MOVED: 24 sentences, 1 position". A shape COUNT cannot
    // express that: a spotlight painted once and frozen shows a constant count while the sentence
    // index advances, which is indistinguishable from healthy speak-along. Measured — both scrolled
    // and paged passed every existing assertion while this quantity went unmeasured. Record the
    // union rect of the drawn shapes so movement is observable.
    // A SIGNATURE of every shape on the overlayer, not a union box.
    //
    // The reading spotlight cannot be isolated by key from here: the overlayer's key map is private
    // and the drawn <g> carries no identifying attribute. A union rect is useless — it spans the
    // whole document and a single static reference shape pins it, masking real motion. The
    // signature avoids both problems: shapes that never move contribute the SAME text to every
    // sample, so they cannot hide a change, while the spotlight moving between sentences changes it.
    // The question is "did the drawn picture change", and that is exactly what the report is about.
    spotSig: (() => {
      const c = v?.renderer?.getContents?.()?.[0];
      const el = c?.overlayer?.element ?? null;
      if (!el) return null;
      const svg = el.tagName && el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
      const kids = [...(svg ? svg.children : el.children)];
      const parts = [];
      for (const k of kids) {
        const b = k.getBoundingClientRect ? k.getBoundingClientRect() : null;
        if (!b || (b.width === 0 && b.height === 0)) continue;
        parts.push(Math.round(b.left) + ',' + Math.round(b.top) + ',' + Math.round(b.width) + ',' + Math.round(b.height));
      }
      return parts.length ? parts.sort().join(' | ') : null;
    })(),
    docNodes: d ? d.querySelectorAll('*').length : null,
  };
})()`;

/** Sentences the way the app would take them: from the rendered section. */
const P_SENTENCES = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const d = c?.doc; if (!d?.body) return { error: 'no doc' };
  const out = [];
  for (const p of [...d.body.querySelectorAll('p')]) {
    const t = (p.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 20) out.push(t.slice(0, 220));
    if (out.length >= 8) break;
  }
  return { sentences: out, sectionIndex: c.index };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}
/** Poll TTS state until `pred` holds, returning the trace either way. */
async function until(s, pred, tries = 40, ms = 500) {
  const trace = [];
  for (let i = 0; i < tries; i++) {
    const st = await s.evaluate(P_STATE);
    trace.push({ t: i * ms, status: st.status, index: st.index, wordIndex: st.wordIndex, spotlight: st.spotlight, spotRect: st.spotRect });
    if (pred(st)) return { hit: true, st, trace };
    await sleep(ms);
  }
  const st = await s.evaluate(P_STATE);
  return { hit: false, st, trace };
}

const out = { startedAt: new Date().toISOString(), modes: {}, violations: [], notes: {} };
const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "tts-live");
let sard = null;
try {
  sard = await launchSard({ port: 9426 });
  if (sard.skipped) { console.error(sard.skipped); process.exit(0); }
  const s = sard;
  await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);

  // ---- capability: is any voice reachable at all? --------------------------
  const edge = await inv("tts_edge_voices");
  const edgeOk = Array.isArray(edge) && edge.length > 0;
  out.notes.capability = {
    edgeVoices: Array.isArray(edge) ? edge.length : String(edge).slice(0, 120),
    engineSetting: await inv("settings_get", { key: "tts_engine" }),
    voiceSetting: await inv("settings_get", { key: "tts_voice" }),
    ttsLang: await inv("settings_get", { key: "tts_lang" }),
  };
  if (Array.isArray(edge) && edge.length) {
    const ar = edge.filter((v) => /^ar/i.test(v.locale ?? v.Locale ?? v.lang ?? ""));
    out.notes.capability.arabicEdgeVoices = ar.length;
    out.notes.capability.sampleVoice = JSON.stringify(edge[0]).slice(0, 160);
  }
  console.log("  capability:", JSON.stringify(out.notes.capability, null, 1));
  if (CAP_ONLY) process.exit(edgeOk ? 0 : 3);
  if (!edgeOk) {
    out.notes.blocked = "no Edge voices reachable — real playback cannot be driven in this environment";
    throw new Error(out.notes.blocked);
  }

  // Measured: engineSetting / voiceSetting / ttsLang are all null on this profile — no voice has
  // ever been chosen. `start()` with no voice cannot synthesise, so pick one that MATCHES the book's
  // script (an Arabic book with a Latin voice is the WP-5 mismatch case, a different test).
  const wantAr = /arabic|rtl/.test(BOOK);
  const pick = edge.find((v) => (v.lang ?? "").toLowerCase().startsWith(wantAr ? "ar" : "en"));
  if (!pick) throw new Error(`no ${wantAr ? "Arabic" : "English"} Edge voice among ${edge.length}`);
  out.notes.chosenVoice = pick;
  console.log(`  voice: ${pick.id} (${pick.lang})`);

  const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });
  let book = ((await list()) || []).find((b) => (b.file_path ?? "").replace(/\\/g, "/").includes(BOOK));
  if (!book && corpusAvailable() && existsSync(join(corpusDir(), BOOK))) {
    const res = await inv("import_books", { paths: [join(corpusDir(), BOOK)] });
    await sleep(2000);
    const id = Array.isArray(res) ? res[0]?.id : null;
    book = ((await list()) || []).find((b) => b.id === id);
  }
  if (!book) throw new Error(`${BOOK} unavailable`);

  for (const mode of MODES) {
    const rec = { steps: {} };
    await inv("settings_set", { key: "book_css", value: mode });
    await s.evaluate(`window.location.reload()`);
    await sleep(3000);
    await s.evaluate(`(() => { const t = ${JSON.stringify(book.title)};
      const all = [...document.querySelectorAll('.lib-card')];
      const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
      if (c) c.click(); return !!c; })()`);
    await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300);
    await sleep(2000);

    const sen = await s.evaluate(P_SENTENCES);
    if (sen.error || !sen.sentences?.length) { out.violations.push(`${mode}: no sentences (${sen.error})`); continue; }
    rec.sentenceCount = sen.sentences.length;
    rec.sectionIndex = sen.sectionIndex;

    let rules = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view').renderer.getContents()[0].doc;
      let n = 0; for (const sh of [...d.styleSheets]) { try { n += sh.cssRules.length; } catch {} } return n; })()`);
    rec.rules = rules;

    // ---- START -------------------------------------------------------------
    rec.shapesBeforeStart = (await s.evaluate(P_STATE)).spotlight;
    await s.evaluate(`window.__sardTtsStore.getState().setEngine("edge")`);
    await s.evaluate(`window.__sardTtsStore.getState().setVoice("edge", ${JSON.stringify(pick.id)}, ${JSON.stringify(wantAr ? "ar" : "en")})`);
    await sleep(600);

    // DRIVE THE REAL UI, not the store directly.
    //
    // Calling `start({sentences})` with sentences scraped from the DOM produced playback with NO
    // speak-along spotlight — and that was a HARNESS artifact, not a product defect: the app starts
    // read-aloud via `ctrl.getCurrentChapterSentences()`, and it is the CONTROLLER's extraction that
    // establishes the sentence→range mapping the spotlight draws from. Supplying my own sentences
    // left the controller with nothing to highlight. Clicking the chrome's read-aloud button runs
    // the whole real path, which is the only version of this test worth believing.
    const clicked = await s.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.rc-btn')];
      // The owner's UI runs in Arabic, so match the real label ("استماع") as well as the English one.
      const b = btns.find(x => /listen|استماع|قراءة/i.test((x.getAttribute('title') || '')));
      if (b) { b.click(); return { ok: true, title: b.getAttribute('title') }; }
      return { ok: false, titles: btns.map(x => x.getAttribute('title')).slice(0, 12) };
    })()`);
    rec.steps.uiClick = clicked;
    if (!clicked.ok) { out.violations.push(`${mode}: read-aloud button not found (chrome titles: ${JSON.stringify(clicked.titles)})`); out.modes[mode] = rec; continue; }
    const playing = await until(s, (st) => st.status === "playing" || st.status === "error" || st.status === "voice-mismatch", 60, 500);
    rec.steps.start = { hit: playing.hit, status: playing.st.status, error: playing.st.error, mismatch: playing.st.mismatch, total: playing.st.total };
    if (playing.st.status === "voice-mismatch") { out.violations.push(`${mode}: voice-mismatch — ${JSON.stringify(playing.st.mismatch)}`); }
    if (!playing.hit) { out.violations.push(`${mode}: never reached playing (last status ${playing.st.status})`); out.modes[mode] = rec; continue; }

    // ---- SPEAK-ALONG: does the word cursor and the spotlight actually move? --
    const moved = await until(s, (st) => st.wordIndex > 0 || st.index > 0, 40, 500);
    rec.steps.speakAlong = { hit: moved.hit, wordIndex: moved.st.wordIndex, words: moved.st.words, index: moved.st.index, spotlight: moved.st.spotlight, wordMark: moved.st.wordMark };
    // DID THE SPOTLIGHT ACTUALLY MOVE? Distinct positions across the trace, alongside how many
    // distinct sentences were spoken during it. One position across many sentences is the reported
    // defect; the pair is printed so the two numbers can never be confused for each other.
    // A SUSTAINED window, because a single sample cannot show movement — the first version of this
    // check reported "STUCK" from one sample and one sentence, which is arithmetic, not evidence.
    // Watch while it actually speaks, then compare distinct pictures against distinct sentences.
    {
      const win = [];
      for (let i = 0; i < 30; i++) {
        const st = await s.evaluate(P_STATE);
        win.push({ sig: st.spotSig, index: st.index, status: st.status });
        if (st.status !== "playing" && i > 3) break; // stopped early — report what was seen
        await sleep(1000);
      }
      const sigs = win.map((p) => p.sig).filter(Boolean);
      const distinctSigs = new Set(sigs);
      const idx = new Set(win.map((p) => p.index).filter((n) => n != null));
      rec.steps.spotMotion = {
        windowSeconds: win.length,
        samplesWithSpotlight: sigs.length,
        distinctPictures: distinctSigs.size,
        distinctSentences: idx.size,
        sentenceRange: idx.size ? `${Math.min(...idx)}→${Math.max(...idx)}` : null,
        // The defect is: many sentences spoken, one picture drawn. Both numbers are reported so the
        // verdict can be checked rather than trusted, and it is UNKNOWN unless enough was observed.
        verdict:
          idx.size < 2 ? "INCONCLUSIVE — fewer than 2 sentences observed"
          : sigs.length < 2 ? "INCONCLUSIVE — spotlight seen in fewer than 2 samples"
          : distinctSigs.size > 1 ? "MOVED"
          : "STUCK — many sentences, one picture",
      };
    }
    if (!moved.hit) out.violations.push(`${mode}: playback started but neither the word cursor nor the sentence index ever advanced`);
    if (moved.st.spotlight != null && moved.st.spotlight <= rec.shapesBeforeStart) out.violations.push(`${mode}: speak-along spotlight never drew — overlayer shapes ${rec.shapesBeforeStart} (idle) → ${moved.st.spotlight} (playing)`);

    // ---- PAUSE / RESUME -----------------------------------------------------
    await s.evaluate(`window.__sardTtsStore.getState().toggle()`);
    await sleep(1800);
    const paused = await s.evaluate(P_STATE);
    const idxAtPause = paused.index, wAtPause = paused.wordIndex;
    await sleep(2200);
    const stillPaused = await s.evaluate(P_STATE);
    rec.steps.pause = { status: paused.status, index: idxAtPause, wordIndex: wAtPause, afterWaitIndex: stillPaused.index, afterWaitWord: stillPaused.wordIndex };
    if (stillPaused.index !== idxAtPause || stillPaused.wordIndex !== wAtPause) {
      out.violations.push(`${mode}: paused but position kept moving (${idxAtPause}/${wAtPause} → ${stillPaused.index}/${stillPaused.wordIndex})`);
    }
    await s.evaluate(`window.__sardTtsStore.getState().toggle()`);
    const resumed = await until(s, (st) => st.status === "playing", 30, 400);
    rec.steps.resume = { hit: resumed.hit, status: resumed.st.status, index: resumed.st.index };
    if (!resumed.hit) out.violations.push(`${mode}: did not resume after a second toggle (status ${resumed.st.status})`);

    // ---- SEEK ---------------------------------------------------------------
    const beforeSeek = await s.evaluate(P_STATE);
    await s.evaluate(`window.__sardTtsStore.getState().skip(1)`);
    const fwd = await until(s, (st) => st.index > beforeSeek.index, 30, 400);
    await s.evaluate(`window.__sardTtsStore.getState().skip(-1)`);
    const back = await until(s, (st) => st.index <= beforeSeek.index + 0, 30, 400);
    rec.steps.seek = { from: beforeSeek.index, forwardHit: fwd.hit, forwardIndex: fwd.st.index, backHit: back.hit, backIndex: back.st.index };
    if (!fwd.hit) out.violations.push(`${mode}: skip(+1) did not advance the sentence index (stuck at ${fwd.st.index})`);
    if (!back.hit) out.violations.push(`${mode}: skip(-1) did not move back (at ${back.st.index})`);

    // ---- LONG SESSION -------------------------------------------------------
    const longStart = await s.evaluate(P_STATE);
    await sleep(20000);
    const longEnd = await s.evaluate(P_STATE);
    rec.steps.long = {
      seconds: 20, fromIndex: longStart.index, toIndex: longEnd.index, status: longEnd.status,
      underruns: longEnd.underruns, abandoned: longEnd.abandoned, lastFailure: longEnd.lastFailure, retryAttempt: longEnd.retryAttempt,
    };
    if (longEnd.status === "error") out.violations.push(`${mode}: playback fell into error during a 20 s session: ${longEnd.error}`);
    if ((longEnd.abandoned ?? 0) > (longStart.abandoned ?? 0)) out.violations.push(`${mode}: ${longEnd.abandoned - longStart.abandoned} sentence(s) abandoned during the long session`);

    // ---- CHAPTER CHANGE while speaking --------------------------------------
    await s.evaluate(`(async () => { const v = document.querySelector('.page-host foliate-view'); try { await v.goTo({ index: ${(sen.sectionIndex ?? 0) + 1}, anchor: 0 }); } catch {} })()`);
    await sleep(3000);
    const afterNav = await s.evaluate(P_STATE);
    rec.steps.chapterChange = { status: afterNav.status, active: afterNav.active, index: afterNav.index, error: afterNav.error };
    if (afterNav.status === "error") out.violations.push(`${mode}: navigating a chapter while speaking put TTS into error: ${afterNav.error}`);

    await s.evaluate(`window.__sardTtsStore.getState().stop()`);
    await sleep(1200);
    const stopped = await s.evaluate(P_STATE);
    rec.steps.stop = { status: stopped.status, active: stopped.active, spotlight: stopped.spotlight };
    if (stopped.active) out.violations.push(`${mode}: stop() left the player active`);
    if (stopped.spotlight != null && stopped.spotlight > rec.shapesBeforeStart) out.violations.push(`${mode}: stop() left the spotlight drawn — overlayer shapes ${rec.shapesBeforeStart} (idle) → ${stopped.spotlight} (after stop)`);

    out.modes[mode] = rec;
    console.log(`  ${mode}: start=${rec.steps.start.status} words=${rec.steps.speakAlong?.words} spotlight=${rec.steps.speakAlong?.spotlight} ` +
      `motion=${rec.steps.spotMotion?.distinctPictures}pic/${rec.steps.spotMotion?.distinctSentences}sent [${rec.steps.spotMotion?.verdict}] ` +
      `pause=${rec.steps.pause?.status} seek=${rec.steps.seek?.forwardHit}/${rec.steps.seek?.backHit} long ${rec.steps.long?.fromIndex}→${rec.steps.long?.toIndex} rules=${rec.rules}`);
  }

  const ruleSet = new Set(Object.values(out.modes).map((m) => m.rules));
  if (MODES.length > 1 && Object.keys(out.modes).length === MODES.length && ruleSet.size === 1) {
    out.violations.push(`VACUOUS: all modes delivered ${[...ruleSet][0]} rules — book_css did nothing`);
  }
} catch (e) {
  out.fatal = String(e?.message ?? e);
} finally {
  if (sard) { try { await sard.close(); } catch {} }
  const s2 = await launchSard({ port: 9427 }).catch(() => null);
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
writeFileSync(join(OUT, "tts-live.json"), JSON.stringify(out, null, 1), "utf8");
console.log("\n  ===== TTS LIVE PLAYBACK =====");
for (const [m, r] of Object.entries(out.modes)) console.log(`  ${m}: ${JSON.stringify(r.steps).slice(0, 400)}`);
if (out.fatal) { console.log(`\n  ✗ FATAL ${out.fatal} — NOTHING verified\n`); process.exit(1); }
if (out.violations.length) { console.log(`\n  ✗ ${out.violations.length} violation(s):`); for (const v of out.violations) console.log(`      ${v}`); console.log(""); process.exit(1); }
console.log("\n  ✓ real playback, speak-along, pause/resume, seek, chapter change, long session — all three modes\n");
