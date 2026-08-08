// PDF READ-ALOUD DISABLED — product-level verification (temporary state, 2026-08-08).
//
// Proves the DISABLED surface, not the absence of the code. PDF read-aloud is switched off through
// `PDF_TTS_ENABLED` in src/lib/pdfText.ts; the implementation is intentionally preserved. This harness
// asserts a reader can reach none of it, and that EPUB read-aloud is untouched.
//
// Deliberately checks a text PDF, NOT a scan: a scan would show no control even with the feature ON,
// so it cannot tell "disabled" from "no text layer". رسالة الغفران is the document that DID play.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-tts-disabled-result.json";
const report = { startedAt: new Date().toISOString(), cases: {}, violations: [] };
const fail = (m) => { report.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const snap = snapshotDb("M:\\eRawy", "pdf-tts-disabled");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9949, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160))); return true; })()`);

  // ===== PDF — the document that used to play ==================================================
  console.log("\n=== PDF (رسالة الغفران — the document that DID play)");
  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("رسالة الغفران not found");
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(3500);
  // walk to the page that produced 5 units, so this is the strongest possible case
  for (let p = 0; p < 8; p++) {
    const u = JSON.parse(await s.evaluate(`(async()=>{ try { const r=await window.__sardPdfTts('ar'); return JSON.stringify({u:r?.units??0}); } catch(e){ return JSON.stringify({u:0}); } })()`));
    if (u.u >= 5) { report.cases.reachedTextPage = p; break; }
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }

  const pdf = JSON.parse(await s.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.rc-btn')];
    const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return JSON.stringify({
      listenButton: btns.some(x => /listen|استماع|قراءة/i.test((x.getAttribute('title')||''))),
      chromeTitles: btns.map(x => x.getAttribute('title')).filter(Boolean),
      player: !!document.querySelector('.tts-player, [class*="tts-player"]'),
      ttsPlayingClass: !!document.querySelector('.reader-root.tts-playing'),
      highlightSpans: d ? d.querySelectorAll('.sard-pdf-reading').length : null,
      highlightStyle: d ? !!d.getElementById('sard-pdf-reading-style') : null,
      themeStyle: d ? !!d.getElementById('sard-pdf-theme') : null,
      textLayerSpans: d ? d.querySelectorAll('.textLayer span').length : null,
      ttsActive: window.__sardTtsStore?.getState?.().active ?? null,
    }); })()`));
  report.cases.pdf = pdf;
  console.log(`  chrome buttons: ${JSON.stringify(pdf.chromeTitles)}`);
  if (!pdf.listenButton) pass("no Listen control on a text PDF"); else fail("Listen control still present on a PDF");
  if (!pdf.player) pass("no read-aloud player rendered"); else fail("read-aloud player rendered for a PDF");
  if (pdf.highlightSpans === 0) pass("no highlight spans"); else fail(`highlight spans present: ${pdf.highlightSpans}`);
  if (pdf.highlightStyle === false) pass("no highlight stylesheet injected into the page"); else fail("highlight stylesheet injected");
  if (pdf.ttsActive !== true) pass("TTS store inactive"); else fail("TTS store is active on a PDF");
  // The PDF must still be a working PDF: theme sheet present, text layer intact.
  if (pdf.themeStyle) pass("PDF theme still applied (unrelated behaviour intact)"); else fail("PDF theme stylesheet missing");
  if (pdf.textLayerSpans > 0) pass(`text layer intact (${pdf.textLayerSpans} spans) — extraction preserved`);
  else fail("text layer empty — extraction may have regressed");

  // the settings-panel note must be gone too
  const note = JSON.parse(await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.rc-btn')].find(x => /PDF/i.test(x.getAttribute('title')||''));
    if (b) b.click();
    return JSON.stringify({ opened: !!b }); })()`));
  await sleep(1000);
  const noteState = JSON.parse(await s.evaluate(`JSON.stringify({
    ttsNote: !!document.querySelector('.sp-pdf-tts'),
    themeChips: document.querySelectorAll('[class*="pdf-chip-"]').length })`));
  report.cases.settingsPanel = { ...note, ...noteState };
  if (!noteState.ttsNote) pass("PDF settings panel shows no read-aloud note");
  else fail("PDF settings panel still shows the read-aloud note");
  if (noteState.themeChips > 0) pass(`PDF theme chips still present (${noteState.themeChips}) — panel otherwise unchanged`);
  else fail("PDF theme chips missing — the panel regressed");

  // the implementation must still be REACHABLE (preserved, not deleted)
  const preserved = JSON.parse(await s.evaluate(`(async () => { try {
    const r = await window.__sardPdfTts('ar');
    return JSON.stringify({ units: r?.units ?? 0, withRange: r?.withRange ?? 0, verdictReason: r?.verdict?.reason ?? null });
  } catch (e) { return JSON.stringify({ err: String(e).slice(0,120) }); } })()`));
  report.cases.implementationPreserved = preserved;
  console.log(`  extraction still works: units=${preserved.units} withRange=${preserved.withRange}`);
  if (preserved.units > 0 && preserved.withRange === preserved.units) pass("unit derivation + ranges still functional (dormant, not deleted)");
  else fail(`extraction/units regressed: ${JSON.stringify(preserved)}`);

  // ===== EPUB — must be completely unaffected ==================================================
  console.log("\n=== EPUB control (must be unchanged)");
  await s.evaluate(`(() => { const b=document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length>0`)) break; await sleep(250); }
  await sleep(600);
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format ?? "").toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!epub) fail("no EPUB in the library — EPUB control could not be established");
  else {
    await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
      const all=[...document.querySelectorAll('.lib-card')];
      const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
      if (c) c.click(); return !!c; })()`);
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(250); }
    await sleep(2500);
    const ident = JSON.parse(await s.evaluate(`(() => { const v=document.querySelector('.page-host foliate-view');
      return JSON.stringify({ isFixedLayout: v?.isFixedLayout ?? null, sections: v?.book?.sections?.length ?? null,
        listenButton: [...document.querySelectorAll('.rc-btn')].some(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))) }); })()`));
    console.log(`  control "${epub.title}" · isFixedLayout=${ident.isFixedLayout} sections=${ident.sections} listen=${ident.listenButton}`);
    if (ident.isFixedLayout === false) pass("control is a real EPUB"); else fail(`control is not EPUB: ${JSON.stringify(ident)}`);
    if (ident.listenButton) pass("EPUB still offers Listen"); else fail("EPUB LOST its Listen control — regression");
    if (ident.listenButton) {
      await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
        .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return true; })()`);
      const deadline = Date.now() + 60_000;
      let last = null;
      while (Date.now() < deadline) {
        last = JSON.parse(await s.evaluate(`(() => { const st=window.__sardTtsStore?.getState?.();
          let m=null; try { m=window.__sardTtsStats?.().media ?? null; } catch(e){}
          return JSON.stringify({ status: st?.status, index: st?.index, total: st?.total,
            paused: m?m.paused:null, readyState: m?m.readyState:null,
            lastFailure: st?.lastFailure ? String(st.lastFailure).slice(0,120) : null }); })()`));
        if (last.readyState === 4 || last.status === "error") break;
        await sleep(800);
      }
      report.cases.epubPlayback = last;
      console.log(`  EPUB playback: status=${last.status} readyState=${last.readyState} paused=${last.paused} total=${last.total}`);
      if (last.status === "playing" && last.readyState === 4 && last.paused === false) pass("EPUB read-aloud plays normally");
      else fail(`EPUB read-aloud did not play: ${JSON.stringify(last)}`);
      // and the EPUB spotlight must still draw
      const spot = await s.evaluate(`(() => { const c=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0];
        const el=c?.overlayer?.element; if (!el) return null;
        const svg = el.tagName?.toLowerCase()==='svg' ? el : el.querySelector('svg');
        return svg ? svg.children.length : el.children.length; })()`);
      report.cases.epubSpotlight = spot;
      if (spot > 0) pass(`EPUB sentence spotlight still drawing (${spot} shape(s))`); else fail(`EPUB spotlight not drawn (${spot})`);
      await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
    }
  }

  report.cases.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,10))`));
  console.log(`\n${report.violations.length === 0 ? "✓ PDF TTS DISABLED, EPUB INTACT: PASS" : `✗ FAILED — ${report.violations.length} violation(s)`}`);
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
  if (report.violations.length || report.fatal) process.exitCode = 3;
}
