// PDF READ-ALOUD — STAGED DIAGNOSIS. Read-only: this harness changes no product code and no settings
// that it does not restore.
//
// WHY THIS EXISTS. The previous investigation concluded "no audio" from `document.querySelectorAll('audio')`
// returning []. That probe is BLIND BY CONSTRUCTION: tts.ts:930 records that the playback pool is built with
// `new Audio()` and is never attached to the DOM, so the query matches nothing whether or not audio is
// sounding. Every conclusion drawn from it is void. This harness uses the product's own instruments instead:
//   `window.__sardTtsStats()`      — blob accounting, playRejections, live media element (readyState, paused,
//                                    currentTime, isBlob). The ONLY way to observe the pool.
//   `window.__sardTtsStore`        — status, index, total, underruns, abandoned, lastFailure, retryAttempt.
//   `window.__sardPdfTts(lang)`    — units/ranges/verdict through the REAL controller.
//
// THE CONTROL COMES FIRST. EPUB read-aloud runs in the SAME process, SAME session, SAME network. If EPUB
// also fails, the failure is not PDF-specific and every PDF-shaped hypothesis is unfounded. An absence is
// only evidence once the instrument is proven able to see (HANDBOOK §3.1).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-diagnosis-result.json";

// The two instruments, sampled together so a store state and a media state always share a timestamp.
const P_PROBE = `(() => {
  const st = window.__sardTtsStore?.getState?.();
  let stats = null;
  try { stats = window.__sardTtsStats ? window.__sardTtsStats() : null; } catch (e) { stats = { err: String(e).slice(0,120) }; }
  return {
    t: Date.now(),
    store: st ? {
      active: st.active, status: st.status, index: st.index, total: st.total,
      wordIndex: st.wordIndex, words: st.words?.length ?? 0,
      underruns: st.underruns, abandoned: st.abandoned,
      lastFailure: st.lastFailure ? String(st.lastFailure).slice(0, 220) : null,
      retryAttempt: st.retryAttempt, error: st.error ? String(st.error).slice(0, 220) : null,
      mismatch: st.voiceMismatch ?? null,
    } : { err: 'no __sardTtsStore' },
    stats: stats,
  };
})()`;

const report = { startedAt: new Date().toISOString(), stages: {}, verdicts: {}, notes: [] };
const snap = snapshotDb("M:\\eRawy", "pdf-tts-diagnosis");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
/** Poll the probe until `pred` or the budget runs out. Returns every sample, not just the last. */
async function watch(sess, label, ms, everyMs, pred) {
  const samples = [];
  const deadline = Date.now() + ms;
  let hit = false;
  while (Date.now() < deadline) {
    const p = await sess.evaluate(P_PROBE);
    samples.push(p);
    if (pred && pred(p)) { hit = true; break; }
    await sleep(everyMs);
  }
  return { label, hit, samples, sampleCount: samples.length };
}

/** Click the read-aloud control the way a reader does. Reports what it saw if it cannot find it. */
const CLICK_LISTEN = `(() => {
  const btns = [...document.querySelectorAll('.rc-btn')];
  const b = btns.find(x => /listen|استماع|قراءة/i.test((x.getAttribute('title') || '')));
  if (b) { b.click(); return { ok: true, title: b.getAttribute('title') }; }
  return { ok: false, titles: btns.map(x => x.getAttribute('title')).filter(Boolean).slice(0, 14) };
})()`;

const openLibrary = async () => {
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
  await sleep(500);
};
const openCardMatching = async (needle) =>
  s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
    .find(c => (c.textContent||'') .includes(${JSON.stringify(needle)}) || (c.getAttribute('title')||'').includes(${JSON.stringify(needle)}));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9941, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,160)));
    window.addEventListener('unhandledrejection', e => window.__err.push('REJECT: ' + String(e.reason).slice(0,160)));
    return true; })()`);

  const inv = (c, p = {}) =>
    s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e => ({ __err: String(e).slice(0,200) }))`);

  // ================= STAGE 0 — CAPABILITY. Decides whether any later stage can mean anything. ========
  console.log("\n=== STAGE 0 · capability");
  const edge = await inv("tts_edge_voices");
  const voices = Array.isArray(edge?.ok) ? edge.ok : null;
  const s0 = {
    edgeVoiceCount: voices ? voices.length : null,
    edgeError: edge?.__err ?? null,
    arabicVoices: voices ? voices.filter((v) => /^ar/i.test(v.locale ?? v.lang ?? "")).length : null,
    engineSetting: (await inv("settings_get", { key: "tts_engine" }))?.ok ?? null,
    voiceSetting: (await inv("settings_get", { key: "tts_voice" }))?.ok ?? null,
    ttsLang: (await inv("settings_get", { key: "tts_lang" }))?.ok ?? null,
    instruments: await s.evaluate(`JSON.stringify({
      store: typeof window.__sardTtsStore, stats: typeof window.__sardTtsStats,
      pdfTts: typeof window.__sardPdfTts, trackStats: typeof window.__sardTrackStats })`),
  };
  report.stages.s0_capability = s0;
  console.log(`  edge voices: ${s0.edgeVoiceCount ?? "FETCH FAILED"} (arabic ${s0.arabicVoices ?? "-"}) · err=${s0.edgeError ?? "none"}`);
  console.log(`  instruments: ${s0.instruments}`);
  const edgeReachable = !!(voices && voices.length);
  report.verdicts.edgeReachable = edgeReachable;
  if (!edgeReachable) {
    report.notes.push("Edge voice list unreachable — NO synthesis of any kind can succeed in this environment. "
      + "A PDF-specific conclusion cannot be drawn from a silent player here.");
  }

  // ================= STAGE 1 — EPUB CONTROL, same process/session/network ============================
  //
  // ⚠ HOW THE CONTROL IS CHOSEN, AND WHY IT IS NOT A HEURISTIC.
  // This used to pick "the first card whose text does not contain 'pdf'". That is wrong twice over:
  // the library grid RE-ORDERS once books have been opened (a recorded instrumentation lesson), and
  // card text is CONTENT, not identity — it once selected `فنّ الحرب_24116_Foulabook.com_`, a PDF,
  // and reported it as the EPUB control. A control that is not the format it claims proves nothing.
  //
  // Identity now comes from two independent sources that are both the product's own:
  //   SELECT  `library_list_books`.format — the value in Sard's database, not the UI.
  //   ASSERT  `foliate-view.isFixedLayout` — the ENGINE's own determination, set from
  //           `book.rendition.layout === 'pre-paginated'` (view.js:253). A PDF is always true here.
  // Selection is also sorted by id so grid order, open history and `sort`/`order` cannot move it.
  console.log("\n=== STAGE 1 · EPUB control");
  const s1 = {};
  const WANT_EPUB = (process.argv.find((a) => a.startsWith("--epub=")) ?? "--epub=").split("=").slice(1).join("=");

  // `--reorder` deliberately churns the grid before selecting, because the profile is restored between
  // runs and would otherwise hide an ordering dependency. Opening books is exactly what re-sorts the
  // library, so this reproduces the condition the old heuristic failed under.
  if (process.argv.includes("--reorder")) {
    s1.reorder = { before: null, after: null, opened: [] };
    const cardTitles = `[...document.querySelectorAll('.lib-card')].map(c => c.getAttribute('title')||'').slice(0,6)`;
    s1.reorder.before = await s.evaluate(`JSON.stringify(${cardTitles})`);
    for (const nth of [3, 1, 5]) {
      const t = await s.evaluate(`(() => { const all=[...document.querySelectorAll('.lib-card')];
        const c = all[${nth}]; if (!c) return null; const t = c.getAttribute('title')||''; c.click(); return t; })()`);
      if (!t) continue;
      s1.reorder.opened.push(t);
      for (let k = 0; k < 60; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')`)) break; await sleep(250); }
      await sleep(1200);
      await openLibrary();
    }
    s1.reorder.after = await s.evaluate(`JSON.stringify(${cardTitles})`);
    s1.reorder.gridChanged = s1.reorder.before !== s1.reorder.after;
    console.log(`  reorder: opened ${s1.reorder.opened.length} book(s) · grid order changed = ${s1.reorder.gridChanged}`);
  }
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  if (!Array.isArray(books)) {
    s1.err = `library_list_books failed: ${JSON.stringify(books).slice(0, 160)}`;
  } else {
    const epubs = books
      .filter((b) => String(b.format ?? "").toLowerCase() === "epub")
      .sort((a, b) => String(a.id).localeCompare(String(b.id))); // deterministic, order-independent
    s1.epubsInLibrary = epubs.length;
    const pick = WANT_EPUB
      ? epubs.find((b) => (b.title ?? "").includes(WANT_EPUB) || (b.file_path ?? "").includes(WANT_EPUB))
      : epubs[0];
    if (!pick) {
      s1.err = WANT_EPUB
        ? `no EPUB matching "${WANT_EPUB}" among ${epubs.length} EPUB(s): ${epubs.map((b) => b.title).slice(0, 8).join(" | ")}`
        : `NO EPUB IN THE LIBRARY at all (${books.length} book(s), formats: ${[...new Set(books.map((b) => b.format))].join(",")})`;
    } else {
      s1.control = { id: pick.id, title: pick.title, format: pick.format, path: (pick.file_path ?? "").slice(-60) };
      console.log(`  control (from library_list_books): "${pick.title}" · format=${pick.format} · ${epubs.length} EPUB(s) available`);
      await openLibrary();
      // Open by EXACT title attribute, the same way tts-live.mjs does — never by position.
      s1.clickedCard = await s.evaluate(`(() => { const t = ${JSON.stringify(pick.title ?? "")};
        const all = [...document.querySelectorAll('.lib-card')];
        const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
        if (c) { c.scrollIntoView({block:'center'}); c.click(); return true; } return false; })()`);
      if (!s1.clickedCard) s1.err = `card for "${pick.title}" not found in the grid`;
      else s1.opened = pick.title;
    }
  }
  if (s1.err) {
    // FAIL LOUDLY. Silently falling back to another document is what produced the original defect.
    report.notes.push(`STAGE 1 CONTROL UNAVAILABLE — ${s1.err}`);
    report.verdicts.epubControlEstablished = false;
    console.error(`  ✗ EPUB CONTROL NOT ESTABLISHED — ${s1.err}`);
    console.error(`  ✗ No EPUB comparison is possible; any PDF-specific conclusion from this run is UNSOUND.`);
  }
  if (s1.opened) {
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(250); }
    await sleep(2500);

    // ---- REGRESSION ASSERTION: the thing we opened must actually be reflowable EPUB. -------------
    // `isFixedLayout` is the engine's own flag (view.js:253, from `rendition.layout`), so this is
    // independent of the database `format` used to select — two sources, not one restated.
    s1.identity = JSON.parse(await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view');
      return JSON.stringify({
        isFixedLayout: v?.isFixedLayout ?? null,
        renditionLayout: v?.book?.rendition?.layout ?? null,
        sections: v?.book?.sections?.length ?? null,
        hasTextLayer: !!v?.renderer?.getContents?.()?.[0]?.doc?.querySelector?.('.textLayer'),
        pdfViewClass: !!document.querySelector('.reader-desk.pdf-view'),
      }); })()`));
    const isEpub = s1.identity.isFixedLayout === false
      && s1.identity.renditionLayout !== "pre-paginated"
      && s1.identity.hasTextLayer === false
      && s1.identity.pdfViewClass === false;
    s1.controlIsEpub = isEpub;
    report.verdicts.epubControlEstablished = isEpub;
    console.log(`  identity: isFixedLayout=${s1.identity.isFixedLayout} layout=${s1.identity.renditionLayout}`
      + ` sections=${s1.identity.sections} textLayer=${s1.identity.hasTextLayer} pdfViewClass=${s1.identity.pdfViewClass}`);
    if (!isEpub) {
      const msg = `STAGE 1 CONTROL IS NOT EPUB — opened "${s1.opened}" but the engine reports `
        + JSON.stringify(s1.identity) + `. Selection said format=${s1.control?.format}.`;
      report.notes.push(msg);
      console.error(`  ✗ ${msg}`);
      console.error(`  ✗ Refusing to report this as an EPUB control.`);
      s1.abortedNotEpub = true;
    } else {
      console.log(`  ✓ control confirmed EPUB (reflowable, ${s1.identity.sections} sections, no text layer)`);
    }

    s1.unitsFromController = await s.evaluate(`(async () => { try {
      const u = await window.__sardTrackStats('ar'); return JSON.stringify(u).slice(0, 400); } catch (e) { return 'ERR ' + String(e).slice(0,140); } })()`);
    s1.beforeClick = await s.evaluate(P_PROBE);
    s1.click = s1.abortedNotEpub ? { ok: false, skipped: "identity assertion failed" } : await s.evaluate(CLICK_LISTEN);
    console.log(`  book: ${s1.opened} · listen click: ${JSON.stringify(s1.click).slice(0, 160)}`);
    if (s1.click.ok) {
      // 40 s: comfortably past the 12 s Rust deadline + the 500/1500/4500 ms ladder.
      s1.watch = await watch(s, "epub", 40_000, 700,
        (p) => p.stats?.media?.readyState >= 2 || p.store?.status === "error" || p.store?.status === "voice-mismatch");
      const last = s1.watch.samples[s1.watch.samples.length - 1];
      s1.finalStore = last?.store; s1.finalStats = last?.stats;
      s1.everPlayed = s1.watch.samples.some((p) => p.stats?.media && p.stats.media.paused === false);
      s1.everHadBlob = s1.watch.samples.some((p) => (p.stats?.blobs?.created ?? 0) > 0);
      s1.maxReadyState = Math.max(0, ...s1.watch.samples.map((p) => p.stats?.media?.readyState ?? 0));
      console.log(`  EPUB: status=${s1.finalStore?.status} blobsCreated=${s1.finalStats?.blobs?.created} `
        + `maxReadyState=${s1.maxReadyState} everPlaying=${s1.everPlayed} lastFailure=${s1.finalStore?.lastFailure ?? "none"}`);
      await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch (e) {}`);
      await sleep(800);
    }
  }
  report.stages.s1_epub_control = s1;
  report.verdicts.epubProducesAudio = !!s1.everPlayed;

  // ================= STAGE 2 — PDF: units, ranges, verdict (extraction stages) =======================
  console.log("\n=== STAGE 2 · PDF extraction (رسالة الغفران)");
  const s2 = { pages: [] };
  await openLibrary();
  s2.opened = await openCardMatching("33102");
  if (!s2.opened) { s2.err = "رسالة الغفران card not found"; console.log("  " + s2.err); }
  else {
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
    await sleep(3500);
    // Walk forward until a page yields units — the handoff records page 4+ as the text-bearing region.
    for (let p = 0; p < 8; p++) {
      const r = await s.evaluate(`(async () => { try {
        const r = await window.__sardPdfTts('ar');
        const v = document.querySelector('.page-host foliate-view');
        const d = v?.renderer?.getContents?.()?.[0]?.doc;
        const layer = d?.querySelector('.textLayer');
        return JSON.stringify({ units: r?.units ?? 0, withRange: r?.withRange ?? 0,
          sample: (r?.text ?? '').slice(0, 90), verdict: r?.verdict ?? null,
          spans: layer ? layer.querySelectorAll('span').length : null,
          docIsIframe: !!(d && d.defaultView && d.defaultView !== window) });
      } catch (e) { return JSON.stringify({ err: String(e).slice(0,140) }); } })()`);
      const rec = JSON.parse(r);
      s2.pages.push(rec);
      console.log(`  page ${p}: units=${rec.units} withRange=${rec.withRange} spans=${rec.spans} iframe=${rec.docIsIframe}`);
      if (rec.units > 0) { s2.textPageIndex = p; break; }
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
      await sleep(1800);
    }
    s2.speakable = await s.evaluate(`(() => { try { return !!document.querySelector('.page-host foliate-view') && true; } catch(e){ return null; } })()`);
  }
  report.stages.s2_pdf_extraction = s2;
  report.verdicts.pdfUnitsBuilt = (s2.pages.at(-1)?.units ?? 0) > 0;

  // ================= STAGE 3 — PDF playback through the real control ================================
  console.log("\n=== STAGE 3 · PDF playback");
  const s3 = {};
  if (report.verdicts.pdfUnitsBuilt) {
    s3.beforeClick = await s.evaluate(P_PROBE);
    s3.click = await s.evaluate(CLICK_LISTEN);
    console.log(`  listen click: ${JSON.stringify(s3.click).slice(0, 200)}`);
    if (s3.click.ok) {
      s3.watch = await watch(s, "pdf", 45_000, 700,
        (p) => p.stats?.media?.readyState >= 2 || p.store?.status === "error" || p.store?.status === "voice-mismatch");
      const last = s3.watch.samples[s3.watch.samples.length - 1];
      s3.finalStore = last?.store; s3.finalStats = last?.stats;
      s3.everPlayed = s3.watch.samples.some((p) => p.stats?.media && p.stats.media.paused === false);
      s3.everHadBlob = s3.watch.samples.some((p) => (p.stats?.blobs?.created ?? 0) > 0);
      s3.maxReadyState = Math.max(0, ...s3.watch.samples.map((p) => p.stats?.media?.readyState ?? 0));
      s3.statusTimeline = s3.watch.samples.map((p) => `${((p.t - s3.watch.samples[0].t) / 1000).toFixed(1)}s:${p.store?.status}/r${p.store?.retryAttempt ?? "-"}`);
      console.log(`  PDF: status=${s3.finalStore?.status} blobsCreated=${s3.finalStats?.blobs?.created} `
        + `maxReadyState=${s3.maxReadyState} everPlaying=${s3.everPlayed}`);
      console.log(`  lastFailure: ${s3.finalStore?.lastFailure ?? "none"}`);
      console.log(`  timeline: ${s3.statusTimeline.join(" ")}`);
    }
  } else {
    s3.skipped = "no units on the open page — playback not attempted";
    console.log("  " + s3.skipped);
  }
  report.stages.s3_pdf_playback = s3;
  report.verdicts.pdfProducesAudio = !!s3.everPlayed;

  // ================= STAGE 4 — HIGHLIGHTING FEASIBILITY (structural, no product change) =============
  console.log("\n=== STAGE 4 · highlighting feasibility");
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch (e) {}`);
  await sleep(700);
  const s4 = JSON.parse(await s.evaluate(`(async () => { try {
    const v = document.querySelector('.page-host foliate-view');
    const c = v?.renderer?.getContents?.()?.[0];
    const d = c?.doc;
    if (!d) return JSON.stringify({ err: 'no page document' });
    const layer = d.querySelector('.textLayer');
    const spans = layer ? [...layer.querySelectorAll('span')].filter(x => !x.classList.contains('endOfContent')) : [];
    // Can a span be marked without touching product code? Prove it by doing it and undoing it.
    let markable = false, markErr = null;
    try {
      if (spans[0]) { spans[0].classList.add('__probe_mark'); markable = spans[0].classList.contains('__probe_mark'); spans[0].classList.remove('__probe_mark'); }
    } catch (e) { markErr = String(e).slice(0, 120); }
    // Does the overlayer exist on this fixed-layout path? (the EPUB highlight surface)
    const overlayerInDoc = !!c?.overlayer?.element;
    // Range ownership: are unit ranges owned by THIS iframe document?
    const r = await window.__sardPdfTts('ar');
    return JSON.stringify({
      spanCount: spans.length,
      firstSpanText: spans[0] ? (spans[0].textContent||'').slice(0, 40) : null,
      spanHasRects: spans[0] ? (spans[0].getBoundingClientRect().width > 0) : null,
      markable, markErr, overlayerInDoc,
      units: r?.units ?? 0, withRange: r?.withRange ?? 0,
      docIsIframe: d.defaultView !== window,
      styleInjectable: !!d.head,
    });
  } catch (e) { return JSON.stringify({ err: String(e).slice(0,160) }); } })()`));
  console.log(`  spans=${s4.spanCount} markable=${s4.markable} overlayerInDoc=${s4.overlayerInDoc} styleInjectable=${s4.styleInjectable}`);

  // ---- zoom rebuild: does the text layer survive a zoom change? (identity of the span nodes) -------
  const beforeZoom = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp = d?.querySelectorAll('.textLayer span'); if (!sp || !sp[0]) return null;
    window.__probeSpan = sp[0]; return { n: sp.length, text: (sp[0].textContent||'').slice(0,30) }; })()`);
  await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view'); if (v) v.setAttribute('zoom','2'); return true; })()`);
  await sleep(3000);
  const afterZoom = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const sp = d?.querySelectorAll('.textLayer span');
    return { n: sp ? sp.length : null, sameNode: !!(window.__probeSpan && sp && sp[0] === window.__probeSpan),
      probeStillConnected: !!(window.__probeSpan && window.__probeSpan.isConnected) }; })()`);
  s4.zoom = { beforeZoom, afterZoom };
  console.log(`  zoom: spans ${beforeZoom?.n} -> ${afterZoom?.n} · same node=${afterZoom?.sameNode} · old node still connected=${afterZoom?.probeStillConnected}`);
  await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view'); if (v) v.setAttribute('zoom','fit-page'); return true; })()`);
  await sleep(2000);

  // ---- page change: is the next page a different document object? ---------------------------------
  const docBefore = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    window.__probeDoc = d; return !!d; })()`);
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
  await sleep(2500);
  const docAfter = await s.evaluate(`(() => { const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return { sameDoc: d === window.__probeDoc, hasLayer: !!d?.querySelector('.textLayer'),
      spans: d ? d.querySelectorAll('.textLayer span').length : null }; })()`);
  s4.pageChange = { docBefore, docAfter };
  console.log(`  page change: same document object=${docAfter?.sameDoc} · new page spans=${docAfter?.spans}`);
  report.stages.s4_highlighting = s4;

  report.stages.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 12))`));
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  const restored = await restoreDb(snap);
  console.log(`\nprofile restored: ${restored ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
  // The control is load-bearing: without a confirmed EPUB there is nothing to compare the PDF
  // against, so this exits non-zero rather than printing a green-looking run. The profile has already
  // been restored above, so exiting here cannot leave the library damaged.
  if (report.verdicts.epubControlEstablished === false) {
    console.error("\nEXIT 3 — EPUB control not established. PDF results in this run are uncontrolled.");
    process.exitCode = 3;
  }
}
