// PDF SENTENCE HIGHLIGHTING — READ-ONLY PROOF OF CONCEPT. Changes NO product code.
//
// WHAT THIS IS AND IS NOT. Everything below runs in the harness, in the page, at runtime. Nothing here
// is an implementation proposal in code form — it exists to answer whether the proposed architecture
// (mark the text-layer spans the active unit covers, with a class, inside the page iframe) actually
// survives the lifecycle. Where it reproduces product logic it says so, and it CROSS-VALIDATES that
// replica against the real pipeline before drawing a single conclusion from it — the governing document
// requires a probe to exercise the real path or be labelled synthetic.
//
// THE REPLICA. `pdfPageUnits()` is a private method; the harness cannot reach its Range objects. So the
// harness re-derives units with the same algorithm (normalize -> filter -> join -> Intl.Segmenter ->
// map back to spans) and then CHECKS that its unit count and text match what the REAL controller
// reports through `window.__sardPdfTts`. If they diverge, the replica is wrong and every later result
// is void — so that check gates everything.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-highlight-poc-result.json";

// ---------------------------------------------------------------------------------------------
// The in-page toolkit. A faithful replica of `normalizePdfText` / `stripPdfArtifacts` /
// `hasSpeakableText` / `pdfPageUnits`, plus the mark/clear primitives the real design would use.
// ---------------------------------------------------------------------------------------------
const TOOLKIT = `(() => {
  if (window.__hlPoc) return true;
  const CLS = '__sard_hl_probe';
  const STYLE_ID = 'sard-hl-probe-style';

  // --- replica of src/lib/pdfText.ts -----------------------------------------------------------
  const normalizePdfText = (raw) => {
    if (!raw) return '';
    let s = raw;
    try { s = s.normalize('NFKC'); } catch (e) {}
    return s
      .replace(/\\u0640+/g, '')
      .replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '')
      .replace(/\\uFFFD+/g, ' ')
      .replace(/(\\w)-\\s*\\n\\s*(\\w)/g, '$1$2')
      .replace(/[ \\t\\u00A0]+/g, ' ')
      .replace(/\\s*\\n\\s*/g, ' ')
      .trim();
  };
  const stripPdfArtifacts = (s) => {
    if (!s) return '';
    let out = s.replace(/\\b(?:https?:\\/\\/|www\\.)[^\\s]+/gi, ' ')
               .replace(/\\b[\\w.-]+\\.(?:com|net|org|info)\\b/gi, ' ');
    const tokens = out.split(/\\s+/).filter(Boolean);
    if (tokens.length > 12) {
      const freq = new Map();
      for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
      const spam = new Set([...freq].filter(([t, n]) => n >= 6 && t.length > 3 && n / tokens.length > 0.25).map(([t]) => t));
      if (spam.size && spam.size < freq.size) out = tokens.filter((t) => !spam.has(t)).join(' ');
    }
    return out.replace(/\\s{2,}/g, ' ').trim();
  };
  const RE_LETTER = /\\p{L}/u;
  const hasSpeakableText = (s) => { const c = stripPdfArtifacts(normalizePdfText(s)); return c.length >= 2 && RE_LETTER.test(c); };

  const pageDoc = () => document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc ?? null;

  // --- replica of FoliateController.pdfPageUnits, returning SPANS instead of Ranges ------------
  const deriveUnits = (lang) => {
    const doc = pageDoc(); if (!doc) return null;
    const layer = doc.querySelector('.textLayer'); if (!layer) return null;
    const spans = [...layer.querySelectorAll('span')].filter(s => !s.classList.contains('endOfContent'));
    const parts = []; let joined = '';
    for (const el of spans) {
      const clean = normalizePdfText(el.textContent ?? '');
      if (!clean || !hasSpeakableText(clean)) continue;
      const start = joined.length ? joined.length + 1 : 0;
      joined = joined.length ? (joined + ' ' + clean) : clean;
      parts.push({ el, text: clean, start, end: joined.length });
    }
    if (!parts.length || !hasSpeakableText(joined)) return { units: [], spanTotal: spans.length };
    const pieces = [];
    try {
      const seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
      for (const p of seg.segment(joined)) if (p.segment.trim()) pieces.push({ text: p.segment, start: p.index });
    } catch (e) {}
    if (!pieces.length) pieces.push({ text: joined, start: 0 });
    const units = [];
    for (const p of pieces) {
      const text = stripPdfArtifacts(p.text);
      if (!hasSpeakableText(text)) continue;
      const from = p.start, to = p.start + p.text.length;
      const hit = parts.filter(x => x.end > from && x.start < to);
      units.push({ text, spans: hit.map(h => h.el), spanCount: hit.length });
    }
    return { units, spanTotal: spans.length };
  };

  const ensureStyle = () => {
    const doc = pageDoc(); if (!doc) return false;
    let el = doc.getElementById(STYLE_ID);
    if (!el) {
      el = doc.createElement('style'); el.id = STYLE_ID;
      (doc.head || doc.documentElement).appendChild(el);
    }
    // Deliberately the SIMPLEST possible paint, and deliberately NOT a filter: the theme owns filters.
    el.textContent = '.' + CLS + ' { background: rgba(255, 214, 0, 0.38); border-radius: 3px; }';
    return true;
  };

  const clearMarks = () => {
    const doc = pageDoc(); if (!doc) return 0;
    const marked = [...doc.querySelectorAll('.' + CLS)];
    marked.forEach(e => e.classList.remove(CLS));
    return marked.length;
  };

  /** THE PROPOSED PRIMITIVE: mark unit \`i\`, re-deriving spans from the CURRENT DOM every time. */
  const markUnit = (i, lang) => {
    ensureStyle();
    const cleared = clearMarks();
    const d = deriveUnits(lang);
    if (!d || !d.units[i]) return { ok: false, cleared, units: d ? d.units.length : 0 };
    for (const el of d.units[i].spans) el.classList.add(CLS);
    return { ok: true, cleared, units: d.units.length, marked: d.units[i].spans.length,
             text: d.units[i].text.slice(0, 44) };
  };

  const markedReport = () => {
    const doc = pageDoc(); if (!doc) return null;
    const els = [...doc.querySelectorAll('.' + CLS)];
    const first = els[0];
    const cs = first ? doc.defaultView.getComputedStyle(first) : null;
    const r = first ? first.getBoundingClientRect() : null;
    return { count: els.length,
      text: els.map(e => e.textContent).join(' ').slice(0, 44),
      background: cs ? cs.backgroundColor : null,
      visibleBox: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null };
  };

  const teardown = () => {
    const doc = pageDoc(); if (!doc) return false;
    clearMarks();
    doc.getElementById(STYLE_ID)?.remove();
    return true;
  };

  window.__hlPoc = { deriveUnits, markUnit, clearMarks, markedReport, ensureStyle, teardown,
                     normalizePdfText, CLS };
  return true;
})()`;

const report = { startedAt: new Date().toISOString(), stages: {}, verdicts: {}, violations: [] };
const snap = snapshotDb("M:\\eRawy", "pdf-hl-poc");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const install = async () => s.evaluate(TOOLKIT);
const marked = async () => JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markedReport())`));

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9946, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160))); return true; })()`);

  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')].find(c=>(c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("رسالة الغفران not found");
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
  await sleep(3500);
  for (let p = 0; p < 8; p++) {
    const u = JSON.parse(await s.evaluate(`(async()=>{ const r=await window.__sardPdfTts('ar'); return JSON.stringify({u:r?.units??0}); })()`));
    if (u.u >= 5) break;
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(1800);
  }
  await install();

  // ===== GATE 0 — is the replica faithful? Everything downstream depends on this. ==============
  console.log("\n=== GATE 0 · replica vs the real pipeline");
  const g0 = JSON.parse(await s.evaluate(`(async () => {
    const real = await window.__sardPdfTts('ar');
    const mine = window.__hlPoc.deriveUnits('ar');
    const realText = (real?.text || '').replace(/\\s+/g,' ').trim();
    const myText = mine.units.map(u => u.text).join(' ').replace(/\\s+/g,' ').trim();
    return JSON.stringify({ realUnits: real?.units ?? 0, replicaUnits: mine.units.length,
      textIdentical: realText === myText, realLen: realText.length, myLen: myText.length,
      everyUnitHasSpans: mine.units.every(u => u.spanCount > 0),
      spansPerUnit: mine.units.map(u => u.spanCount) });
  })()`));
  console.log(`  real units=${g0.realUnits} replica units=${g0.replicaUnits} · text identical=${g0.textIdentical}`);
  console.log(`  spans per unit: [${g0.spansPerUnit.join(", ")}] · every unit has spans=${g0.everyUnitHasSpans}`);
  report.stages.g0_replica = g0;
  const replicaOk = g0.realUnits === g0.replicaUnits && g0.textIdentical && g0.everyUnitHasSpans;
  report.verdicts.replicaFaithful = replicaOk;
  if (!replicaOk) {
    report.violations.push("REPLICA DIVERGES from the real pipeline — no conclusion below is sound");
    console.error("  ✗ replica diverges; aborting the behavioural stages");
  }

  if (replicaOk) {
    // ===== A — sentence stepping 0 -> 1 -> 2, statically ======================================
    console.log("\n=== A · marking each unit in turn");
    const a = [];
    for (let i = 0; i < g0.replicaUnits; i++) {
      const m = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(${i}, 'ar'))`));
      const r = await marked();
      a.push({ i, ...m, rendered: r });
      console.log(`  unit ${i}: marked ${m.marked} span(s) · cleared ${m.cleared} · bg=${r.background} · «${(m.text||'').slice(0,34)}»`);
      if (r.count !== m.marked) report.violations.push(`unit ${i}: marked ${m.marked} but DOM shows ${r.count}`);
      if (!/rgba?\(/.test(r.background || "")) report.violations.push(`unit ${i}: highlight not painted (bg=${r.background})`);
    }
    // Exclusivity: does marking a new unit remove the previous one?
    const exclusivity = a.slice(1).every((x) => x.cleared > 0);
    report.stages.a_stepping = { units: a, exclusiveAdvance: exclusivity };
    report.verdicts.exclusiveAdvance = exclusivity;
    console.log(`  previous mark always cleared on advance: ${exclusivity}`);

    // ===== B — LIVE playback: does re-deriving on the store index track real audio? ============
    console.log("\n=== B · live playback tracking");
    const b = { samples: [] };
    b.click = await s.evaluate(`(() => { const x=[...document.querySelectorAll('.rc-btn')]
      .find(y=>/listen|استماع|قراءة/i.test((y.getAttribute('title')||''))); if (x) { x.click(); return {ok:true}; } return {ok:false}; })()`);
    if (b.click.ok) {
      const deadline = Date.now() + 75_000;
      let lastIndex = -1;
      while (Date.now() < deadline) {
        const st = JSON.parse(await s.evaluate(`(() => { const st=window.__sardTtsStore?.getState?.();
          let media=null; try { media = window.__sardTtsStats?.().media ?? null; } catch(e){}
          return JSON.stringify({ status: st?.status, index: st?.index, total: st?.total,
            paused: media ? media.paused : null, readyState: media ? media.readyState : null }); })()`));
        if (st.index !== lastIndex && st.index != null) {
          // This is exactly what the product would do: unit index changed -> re-derive -> mark.
          const m = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(${st.index}, 'ar'))`));
          const r = await marked();
          b.samples.push({ index: st.index, status: st.status, marked: m.marked, domCount: r.count, text: r.text });
          console.log(`  index ${st.index} (${st.status}): marked ${m.marked} span(s) · «${(r.text||'').slice(0,34)}»`);
          lastIndex = st.index;
        }
        if (st.index >= 2 && st.readyState === 4) break;
        await sleep(700);
      }
      b.indicesSeen = [...new Set(b.samples.map((x) => x.index))];
      b.trackedAdvance = b.indicesSeen.length >= 2;
      console.log(`  indices tracked during playback: [${b.indicesSeen.join(", ")}] · advanced=${b.trackedAdvance}`);

      // ===== C — pause / resume =================================================================
      console.log("\n=== C · pause / resume");
      await s.evaluate(`try { window.__sardTtsStore.getState().toggle(); } catch(e){}`);
      await sleep(1800);
      const pausedState = JSON.parse(await s.evaluate(`JSON.stringify({ status: window.__sardTtsStore.getState().status })`));
      const pausedMark = await marked();
      console.log(`  paused: status=${pausedState.status} · mark still present=${pausedMark.count > 0} (${pausedMark.count} span(s))`);
      await s.evaluate(`try { window.__sardTtsStore.getState().toggle(); } catch(e){}`);
      await sleep(2200);
      const resumedMark = await marked();
      report.stages.c_pause = { pausedState, pausedMark, resumedMark };
      report.verdicts.markSurvivesPause = pausedMark.count > 0;
      if (pausedMark.count === 0) report.violations.push("mark disappeared on pause");

      // ===== D — seek ===========================================================================
      console.log("\n=== D · seek");
      await s.evaluate(`try { window.__sardTtsStore.getState().skip(1); } catch(e){}`);
      await sleep(2500);
      const seekIdx = JSON.parse(await s.evaluate(`JSON.stringify({ i: window.__sardTtsStore.getState().index })`));
      const seekMark = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(window.__sardTtsStore.getState().index, 'ar'))`));
      const seekDom = await marked();
      console.log(`  after skip(1): index=${seekIdx.i} · marked ${seekMark.marked} span(s) · «${(seekDom.text||'').slice(0,34)}»`);
      report.stages.d_seek = { seekIdx, seekMark, seekDom };
      report.verdicts.seekRemaps = seekMark.ok === true;

      // ===== E — ZOOM while TTS is active =======================================================
      console.log("\n=== E · zoom while playing");
      const beforeZoom = await marked();
      await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','2.5'); return true; })()`);
      await sleep(5000);
      const afterZoomRaw = await marked();          // did the class survive the re-render?
      const idxNow = JSON.parse(await s.evaluate(`JSON.stringify({ i: window.__sardTtsStore.getState().index })`));
      const afterZoomRedraw = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(window.__sardTtsStore.getState().index, 'ar'))`));
      const afterZoomDom = await marked();
      console.log(`  before zoom: ${beforeZoom.count} span(s) · immediately after: ${afterZoomRaw.count} · after re-derive: ${afterZoomDom.count}`);
      console.log(`  style survived re-render: ${afterZoomRaw.background ? "yes (" + afterZoomRaw.background + ")" : "n/a"}`);
      report.stages.e_zoom = { beforeZoom, afterZoomRaw, idxNow, afterZoomRedraw, afterZoomDom };
      report.verdicts.zoomNeedsRedraw = afterZoomRaw.count !== beforeZoom.count;
      report.verdicts.zoomRecoverable = afterZoomDom.count > 0;
      await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','fit-page'); return true; })()`);
      await sleep(3000);
      await s.evaluate(`window.__hlPoc.markUnit(window.__sardTtsStore.getState().index, 'ar')`);

      // ===== F — THEME switch while marked ======================================================
      console.log("\n=== F · theme switch while marked");
      const f = { themes: [] };
      for (const theme of ["sepia", "night", "ink", "normal"]) {
        await s.evaluate(`(() => { const b=[...document.querySelectorAll('[data-theme-id], .theme-swatch, .rc-btn')]
          .find(x => (x.getAttribute('data-theme-id')||'') === ${JSON.stringify(theme)}); if (b) { b.click(); return true; } return false; })()`);
        await sleep(1200);
        const st = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
          const themeStyle = d?.getElementById('sard-pdf-theme');
          const hlStyle = d?.getElementById('sard-hl-probe-style');
          const m = [...(d?.querySelectorAll('.__sard_hl_probe')||[])];
          const cs = m[0] ? d.defaultView.getComputedStyle(m[0]) : null;
          return JSON.stringify({ themeStyleExists: !!themeStyle, hlStyleExists: !!hlStyle,
            markCount: m.length, markBg: cs ? cs.backgroundColor : null,
            imgFilter: (() => { const img = d?.querySelector('#canvas img');
              return img ? d.defaultView.getComputedStyle(img).filter.slice(0,40) : null; })() }); })()`));
        f.themes.push({ theme, ...st });
        console.log(`  ${theme.padEnd(7)} themeStyle=${st.themeStyleExists} hlStyle=${st.hlStyleExists} marks=${st.markCount} bg=${st.markBg} imgFilter=${String(st.imgFilter).slice(0,26)}`);
      }
      report.stages.f_theme = f;
      report.verdicts.markSurvivesThemeSwitch = f.themes.every((t) => t.markCount > 0);
      report.verdicts.themeAndHighlightCoexist = f.themes.every((t) => t.hlStyleExists);

      // ===== G — PAGE CHANGE and return =========================================================
      console.log("\n=== G · page change and return");
      await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
      await sleep(900);
      const beforePage = await marked();
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
      await sleep(2800);
      await install(); // the toolkit lives on `window`, but the STYLE lives per page document
      const onNewPage = await marked();
      const newPageDerive = JSON.parse(await s.evaluate(`(() => { const d=window.__hlPoc.deriveUnits('ar'); return JSON.stringify({ units: d ? d.units.length : null }); })()`));
      const remarkNew = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(0, 'ar'))`));
      console.log(`  next page: stale marks=${onNewPage.count} · units here=${newPageDerive.units} · re-mark unit 0 -> ${remarkNew.marked} span(s)`);
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.prev(); return true; })()`);
      await sleep(2800);
      await install();
      const backAgain = await marked();
      const backDerive = JSON.parse(await s.evaluate(`(() => { const d=window.__hlPoc.deriveUnits('ar'); return JSON.stringify({ units: d ? d.units.length : null }); })()`));
      console.log(`  returned: stale marks=${backAgain.count} · units=${backDerive.units}`);
      report.stages.g_pageChange = { beforePage, onNewPage, newPageDerive, remarkNew, backAgain, backDerive };
      report.verdicts.pageChangeDropsMarks = onNewPage.count === 0;
      report.verdicts.pageChangeRemappable = remarkNew.ok === true;
    }
    report.stages.b_playback = b;
  }

  // ===== H — WORD LEVEL: is character mapping recoverable through the repair? ==================
  console.log("\n=== H · word-level feasibility (character mapping through the repair)");
  const h = JSON.parse(await s.evaluate(`(() => {
    const d = window.__hlPoc.deriveUnits('ar'); if (!d) return JSON.stringify({ err: 'no units' });
    const doc = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const spans = [...(doc?.querySelectorAll('.textLayer span')||[])].filter(x=>!x.classList.contains('endOfContent'));
    let rawTotal = 0, cleanTotal = 0, changed = 0, samples = [];
    for (const el of spans) {
      const raw = el.textContent ?? '';
      const clean = window.__hlPoc.normalizePdfText(raw);
      rawTotal += [...raw].length; cleanTotal += [...clean].length;
      if ([...raw].length !== [...clean].length) {
        changed++;
        if (samples.length < 4) samples.push({ rawLen: [...raw].length, cleanLen: [...clean].length,
          raw: raw.slice(0, 22), clean: clean.slice(0, 22) });
      }
    }
    return JSON.stringify({ spans: spans.length, rawTotal, cleanTotal, spansWithLengthChange: changed,
      deltaChars: rawTotal - cleanTotal, samples });
  })()`));
  console.log(`  spans=${h.spans} raw chars=${h.rawTotal} repaired chars=${h.cleanTotal} (delta ${h.deltaChars})`);
  console.log(`  spans whose length CHANGED under repair: ${h.spansWithLengthChange}/${h.spans}`);
  for (const s2 of h.samples || []) console.log(`    ${s2.rawLen} -> ${s2.cleanLen}  «${s2.raw}» -> «${s2.clean}»`);
  report.stages.h_wordLevel = h;
  report.verdicts.charMappingBroken = (h.spansWithLengthChange ?? 0) > 0;

  // ---- leave the page exactly as found ----
  await s.evaluate(`try { window.__hlPoc.teardown(); } catch(e){}`);
  const leftover = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return (d?.querySelectorAll('.__sard_hl_probe').length ?? 0) + (d?.getElementById('sard-hl-probe-style') ? 1 : 0); })()`);
  report.stages.teardownLeftover = leftover;
  console.log(`\nteardown leftover artifacts: ${leftover}`);

  report.stages.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,10))`));
  console.log(`violations: ${report.violations.length}`);
  for (const v of report.violations) console.log(`  ✗ ${v}`);
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
}
