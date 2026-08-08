// RAWY-293 — the three reported failures, tested the way they were REPORTED: end to end, in use.
//
// The previous verification passed while all three were broken, which is the useful lesson here:
//   · themes were checked on 5 of 8, and by reading back the class rather than the painted result;
//   · zoom was never SCROLLED, only applied;
//   · read-aloud was never asked whether a control existed for a reader to press.
// So each check below measures the thing a reader would notice, not the thing the code intends.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEMES = ["normal", "sepia", "warm", "cream", "green", "grey", "night", "ink"];
// A scanned book and a text book: a filter can be fine on one and ruin the other.
const BOOKS = [
  { key: "الأمير الصغير (mixed)", match: "Noor-Book" },
  { key: "697 (pure scan)", match: "S697" },
];

const snap = snapshotDb("M:\\eRawy", "pdf-fixes");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = { themes: {}, zoom: {}, tts: {} };
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9926, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140))); return true; })()`);

  const open = async (match) => {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
    const ok = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(match)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!ok) return false;
    for (let k = 0; k < 120; k++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view img, .page-host foliate-view')`)) break;
      await sleep(250);
    }
    await sleep(3000);
    return true;
  };
  const openPdfPanel = async () => {
    await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')]
      .find(x => /PDF/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
    await sleep(700);
  };

  // ---- 1. THEMES: does the PAINTED page change, for all eight, on two kinds of PDF? -----------
  for (const book of BOOKS) {
    if (!(await open(book.match))) { console.log(`${book.key}: not found`); continue; }
    await openPdfPanel();
    const rows = [];
    for (const id of THEMES) {
      const clicked = await s.evaluate(`(() => { const b = document.querySelector('.pdf-chip-${id}');
        if (b) b.click(); return !!b; })()`);
      await sleep(700);
      // The painted result: the filter the PAGE carries, and the colour behind it. `filter` is read
      // from `.page-host` because that is the element the rule targets — reading the desk's class
      // proves only that a class was set, which is exactly how this passed while broken.
      const st = JSON.parse(await s.evaluate(`(() => {
        const host = document.querySelector('.page-host');
        const desk = document.querySelector('.reader-desk');
        const cs = host ? getComputedStyle(host) : null;
        const ds = desk ? getComputedStyle(desk) : null;
        return JSON.stringify({
          filter: cs ? cs.filter : null,
          deskBg: ds ? ds.backgroundColor : null,
          deskInline: desk ? (desk.getAttribute('style') || '').slice(0, 80) : null,
          cls: desk ? (desk.className || '').toString().slice(0, 60) : null,
        }); })()`));
      const changesPage = !!st.filter && st.filter !== "none";
      rows.push({ id, clicked, changesPage, filter: st.filter, deskBg: st.deskBg, deskInline: st.deskInline });
    }
    out.themes[book.key] = rows;
    console.log(`\n=== THEMES · ${book.key}`);
    for (const r of rows) {
      const verdict = r.id === "normal" ? (r.changesPage ? "UNEXPECTED filter" : "ok (no filter by design)") : (r.changesPage ? "WORKS" : "NO EFFECT");
      console.log(`  ${r.id.padEnd(7)} click=${r.clicked ? "y" : "n"} ${verdict.padEnd(24)} filter=${String(r.filter).slice(0, 40)} desk=${r.deskBg}`);
    }
    if (rows[0]?.deskInline) console.log(`  desk inline style: ${rows[0].deskInline}`);
  }

  // ---- 2. ZOOM: can an enlarged page be read all the way down without turning? -----------------
  await open("Noor-Book");
  const wheel = async (dy) => {
    await s.evaluate(`(() => { const d = document.querySelector('.reader-desk');
      d.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(220);
  };
  const state = `(() => { const v = document.querySelector('.page-host foliate-view');
    const r = v?.renderer;
    return JSON.stringify({ frac: v?.lastLocation?.fraction ?? null, zoom: r?.getAttribute?.('zoom') ?? null,
      scrollTop: r?.scrollTop ?? null, maxScroll: r ? r.scrollHeight - r.clientHeight : null }); })()`;
  for (const z of [2, 4, 6]) {
    await s.evaluate(`(() => { const v = document.querySelector('.page-host foliate-view');
      v.renderer.setAttribute('zoom', '${z}'); return true; })()`);
    await sleep(2600);
    await s.evaluate(`(() => { const r = document.querySelector('.page-host foliate-view').renderer; r.scrollTop = 0; return true; })()`);
    await sleep(300);
    const start = JSON.parse(await s.evaluate(state));
    // Scroll down repeatedly: the page must move under us, and the PAGE must not change until the
    // bottom is reached. This is exactly the reported failure.
    let turnedEarly = false, scrolled = 0;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const before = JSON.parse(await s.evaluate(state));
      await wheel(200);
      const after = JSON.parse(await s.evaluate(state));
      if (after.scrollTop > before.scrollTop) scrolled++;
      const atBottom = before.maxScroll != null && before.scrollTop >= before.maxScroll - 1;
      if (after.frac !== before.frac && !atBottom) { turnedEarly = true; break; }
    }
    const end = JSON.parse(await s.evaluate(state));
    out.zoom[`${z}x`] = { maxScroll: start.maxScroll, scrolledSteps: scrolled, turnedEarly,
      reachedBottom: end.maxScroll != null && end.scrollTop >= end.maxScroll - 2, endFrac: end.frac, startFrac: start.frac };
    console.log(`\n=== ZOOM ${z}x · scrollable extent ${start.maxScroll}px · scrolled on ${scrolled}/${steps} notches`
      + ` · turned page early=${turnedEarly} · reached bottom=${out.zoom[`${z}x`].reachedBottom}`);
  }
  // And at fit-page, paging must still work exactly as before.
  await s.evaluate(`(() => { document.querySelector('.page-host foliate-view').renderer.setAttribute('zoom', 'fit-page'); return true; })()`);
  await sleep(2200);
  const f0 = JSON.parse(await s.evaluate(state));
  await wheel(200);
  await sleep(700);
  const f1 = JSON.parse(await s.evaluate(state));
  out.zoom.fitPageStillTurns = f1.frac !== f0.frac;
  console.log(`=== ZOOM fit-page · one notch still turns the page: ${out.zoom.fitPageStillTurns}`);

  // ---- 3. TTS: is there a control a reader can press, and does pressing it start speech? -------
  const ttsBtn = `[...document.querySelectorAll('.rc-btn')].find(x => /listen|استمع|قراءة/i.test((x.getAttribute('title')||'')))`;
  out.tts.controlOnTextPdf = await s.evaluate(`!!(${ttsBtn})`);
  console.log(`\n=== TTS · Listen control present on a text PDF: ${out.tts.controlOnTextPdf}`);
  if (out.tts.controlOnTextPdf) {
    await s.evaluate(`(() => { const b = ${ttsBtn}; if (b) b.click(); return !!b; })()`);
    await sleep(6000);
    out.tts.afterPress = JSON.parse(await s.evaluate(`(() => ({
      player: !!document.querySelector('.tts-player, .tts-pill, [class*=tts]'),
      rootPlaying: document.querySelector('.reader-root')?.className.includes('tts-playing') ?? false,
      status: (document.querySelector('.tts-player, .tts-pill')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 80),
    })).call(null)`).then((r) => JSON.stringify(r)).catch(() => "{}"));
    console.log(`  after pressing: ${JSON.stringify(out.tts.afterPress)}`);
  }
  // The scan must NOT offer it — a dead button is worse than an absent one.
  await open("S697");
  await sleep(2500);
  out.tts.controlOnScan = await s.evaluate(`!!(${ttsBtn})`);
  console.log(`  Listen control present on a pure scan (should be false): ${out.tts.controlOnScan}`);

  out.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 8))`));
  console.log(`\npage errors: ${out.errors.length} ${JSON.stringify(out.errors.slice(0, 3))}`);
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-fixes-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
