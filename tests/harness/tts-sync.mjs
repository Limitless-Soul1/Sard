// READ-ALOUD SUSTAINED SYNC — does the highlight keep up, or does it drift/stall?
//
// `tts-sweep.mjs` proves the spotlight APPEARS on all 18 corpus books. That only tests sentence 1.
// The reported symptom ("tracking still fails in some books") is equally consistent with a highlight
// that starts correctly and then stalls, drifts, or lands on the wrong sentence.
//
// So sample over a long playback and correlate two independent observables:
//   index  — which sentence the ENGINE says it is speaking (the store)
//   markY  — the vertical position of the drawn spotlight (the overlayer)
//
// Tracking is healthy when both advance together. The failure signatures this separates:
//   · index advances, markY frozen        -> the highlight is STUCK (tracking dead, audio fine)
//   · index advances, markY jumps around  -> the highlight is on the WRONG sentence
//   · index frozen, audio continues       -> the engine cursor itself stalled
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { APP_DATA, snapshotDb, restoreDb } from "./profile.mjs";
import { corpusAvailable, corpusDir } from "../corpus/corpus-lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = join(REPO, "tests", "harness", "subsystem-runs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");
const SECONDS = Number(arg("seconds", "70"));
const EXE = arg("exe", "test-build/Sard.exe");
const BOOKS = arg("books", "karamazov,alice,daw-alkhalid,shawqiyyat,lord-of-mysteries").split(",");

const P = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  const v = document.querySelector('.page-host foliate-view');
  const c = v?.renderer?.getContents?.()?.[0];
  const el = c?.overlayer?.element ?? null;
  const svg = el && el.tagName?.toLowerCase() === 'svg' ? el : el?.querySelector?.('svg');
  const kids = svg ? [...svg.children] : [];
  // The spotlight's own geometry: first drawn shape's y, and how many shapes there are.
  let markY = null, markX = null;
  if (kids.length) {
    const b = kids[0].getBoundingClientRect ? kids[0].getBoundingClientRect() : null;
    if (b) { markY = Math.round(b.top); markX = Math.round(b.left); }
  }
  return {
    status: st?.status ?? null, index: st?.index ?? null, total: st?.total ?? null,
    wordIndex: st?.wordIndex ?? -1, words: st?.words?.length ?? 0,
    underruns: st?.underruns ?? null, abandoned: st?.abandoned ?? null,
    shapes: kids.length, markY, markX, section: c?.index ?? null,
  };
})()`;

async function waitFor(s, expr, tries, ms) {
  for (let i = 0; i < tries; i++) { if (await s.evaluate(expr)) return true; await sleep(ms); }
  return false;
}

const out = { startedAt: new Date().toISOString(), seconds: SECONDS, books: [] };
const beforeFiles = new Set(existsSync(join(APP_DATA, "library")) ? readdirSync(join(APP_DATA, "library")) : []);
const snap = snapshotDb(REPO, "tts-sync");
let sard = null;
try {
  sard = await launchSard({ exe: EXE, port: 9614 });
  if (sard.skipped) { console.error(sard.skipped); process.exit(0); }
  const s = sard;
  await waitFor(s, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 80, 400);
  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).catch(e => ({ __err: String(e) }))`);
  const list = () => inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null });

  const edge = await inv("tts_edge_voices");
  const ar = (edge || []).find((v) => (v.lang ?? "").toLowerCase().startsWith("ar"));
  const en = (edge || []).find((v) => (v.lang ?? "").toLowerCase().startsWith("en"));
  if (!ar || !en) { console.error("  no Edge voices"); process.exit(3); }
  await inv("settings_set", { key: "book_css", value: "off" });

  for (const needle of BOOKS) {
    let rows = (await list()) || [];
    let book = rows.find((b) => (b.file_path ?? "").replace(/\\/g, "/").includes(needle) || (b.title ?? "").includes(needle));
    if (!book && corpusAvailable()) {
      const cand = readdirSync(corpusDir()).find((f) => f.includes(needle) && f.endsWith(".epub"));
      if (cand) {
        const res = await inv("import_books", { paths: [join(corpusDir(), cand)] });
        await sleep(2000);
        const id = Array.isArray(res) ? res[0]?.id : null;
        book = ((await list()) || []).find((b) => b.id === id);
      }
    }
    if (!book) { console.log(`  ${needle}: unavailable`); continue; }

    await s.evaluate(`window.location.reload()`);
    await sleep(2800);
    await s.evaluate(`(() => { const t=${JSON.stringify(book.title)}; const all=[...document.querySelectorAll('.lib-card')];
      const c = all.find(x => (x.getAttribute('title')||'')===t) || all.find(x => (x.getAttribute('title')||'').includes(t)); if(c) c.click(); })()`);
    if (!await waitFor(s, `!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`, 90, 300)) {
      console.log(`  ${book.title}: never rendered`); continue;
    }
    await sleep(1800);

    const useAr = book.script_detected === "arabic" || book.dir === "rtl";
    const voice = useAr ? ar : en;
    await s.evaluate(`window.__sardTtsStore.getState().setEngine("edge")`);
    await s.evaluate(`window.__sardTtsStore.getState().setVoice("edge", ${JSON.stringify(voice.id)}, ${JSON.stringify(useAr ? "ar" : "en")})`);
    await sleep(400);
    await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/listen|استماع/i.test(x.getAttribute('title')||'')); if(b) b.click(); })()`);

    const samples = [];
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < SECONDS) {
      samples.push({ t: Math.round((Date.now() - t0) / 1000), ...(await s.evaluate(P)) });
      await sleep(1500);
    }
    await s.evaluate(`window.__sardTtsStore?.getState?.().stop?.()`);
    await sleep(600);

    const playing = samples.filter((x) => x.status === "playing" || x.status === "buffering");
    const idx = [...new Set(playing.map((x) => x.index))];
    const ys = [...new Set(playing.map((x) => x.markY).filter((y) => y != null))];
    const withMark = playing.filter((x) => x.shapes > 0).length;
    const rec = {
      title: book.title, section: samples.at(-1)?.section,
      samples: samples.length, playingSamples: playing.length,
      indexFrom: playing[0]?.index ?? null, indexTo: playing.at(-1)?.index ?? null,
      distinctIndices: idx.length, distinctMarkY: ys.length,
      markPresentPct: playing.length ? Math.round((withMark / playing.length) * 100) : 0,
      total: playing.at(-1)?.total ?? null,
      underruns: playing.at(-1)?.underruns ?? null, abandoned: playing.at(-1)?.abandoned ?? null,
      statuses: [...new Set(samples.map((x) => x.status))],
    };
    // The discriminator: sentences advanced but the highlight never moved.
    rec.verdict =
      rec.distinctIndices <= 1 ? "engine cursor never advanced (inconclusive for tracking)"
      : rec.distinctMarkY <= 1 ? "*** HIGHLIGHT STUCK — sentences advanced, spotlight did not ***"
      : rec.markPresentPct < 60 ? `*** HIGHLIGHT MISSING for ${100 - rec.markPresentPct}% of playback ***`
      : "tracking follows the sentences";
    out.books.push(rec);
    console.log(`  ${String(book.title).slice(0, 30).padEnd(32)} idx ${rec.indexFrom}->${rec.indexTo} (${rec.distinctIndices} distinct) · markY ${rec.distinctMarkY} distinct · mark present ${rec.markPresentPct}% · ${rec.verdict}`);
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
writeFileSync(join(OUT, "tts-sync.json"), JSON.stringify(out, null, 1), "utf8");
