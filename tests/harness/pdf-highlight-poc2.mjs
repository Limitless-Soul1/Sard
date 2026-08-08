// PDF SENTENCE HIGHLIGHTING — POC ROUND 2. Read-only; changes no product code.
//
// Round 1 answered stepping, playback tracking, pause, seek, page change and word-level. Two of its
// stages must be redone or extended:
//
//  1. THEME — VOID in round 1. It reported the SAME `imgFilter` for sepia, night, ink and normal, which
//     cannot be true; the selector never matched. The real route is: click the `.rc-btn` whose title
//     matches /PDF/i to open the PDF panel, then click `.pdf-chip-<id>` (pdf-acceptance.mjs:106-111).
//     And "the class is still on the span" is NOT the question — the question is whether the highlight
//     is still VISIBLE, given the theme paints a multiply tint via `#canvas::after`. That needs a
//     stacking test (`elementFromPoint`), not a class count.
//
//  2. ZOOM — round 1 found the marks GONE after a zoom (2 spans -> 0). That is the opposite of what was
//     measured before the accumulation fix, and it is a DIRECT CONSEQUENCE of it: the text layer is now
//     correctly cleared on every re-render, so marked nodes are destroyed rather than kept. This round
//     confirms that and asks the follow-on question the design depends on: does the UNIT COUNT stay
//     stable across zoom levels? If pdf.js splits spans differently at another scale, a re-derive by
//     unit INDEX could land on different text — which would be a correctness bug, not a cosmetic one.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/pdf-highlight-poc2-result.json";

const TOOLKIT = `(() => {
  const CLS = '__sard_hl_probe', STYLE_ID = 'sard-hl-probe-style';
  const normalizePdfText = (raw) => { if (!raw) return '';
    let s = raw; try { s = s.normalize('NFKC'); } catch (e) {}
    return s.replace(/\\u0640+/g,'').replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g,'')
      .replace(/\\uFFFD+/g,' ').replace(/(\\w)-\\s*\\n\\s*(\\w)/g,'$1$2')
      .replace(/[ \\t\\u00A0]+/g,' ').replace(/\\s*\\n\\s*/g,' ').trim(); };
  const stripPdfArtifacts = (s) => { if (!s) return '';
    let out = s.replace(/\\b(?:https?:\\/\\/|www\\.)[^\\s]+/gi,' ').replace(/\\b[\\w.-]+\\.(?:com|net|org|info)\\b/gi,' ');
    const tokens = out.split(/\\s+/).filter(Boolean);
    if (tokens.length > 12) { const freq = new Map();
      for (const t of tokens) freq.set(t,(freq.get(t)??0)+1);
      const spam = new Set([...freq].filter(([t,n])=>n>=6&&t.length>3&&n/tokens.length>0.25).map(([t])=>t));
      if (spam.size && spam.size < freq.size) out = tokens.filter(t=>!spam.has(t)).join(' '); }
    return out.replace(/\\s{2,}/g,' ').trim(); };
  const RE_LETTER = /\\p{L}/u;
  const speakable = (s) => { const c = stripPdfArtifacts(normalizePdfText(s)); return c.length >= 2 && RE_LETTER.test(c); };
  const pageDoc = () => document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc ?? null;
  const deriveUnits = (lang) => { const doc = pageDoc(); if (!doc) return null;
    const layer = doc.querySelector('.textLayer'); if (!layer) return null;
    const spans = [...layer.querySelectorAll('span')].filter(s=>!s.classList.contains('endOfContent'));
    const parts = []; let joined = '';
    for (const el of spans) { const clean = normalizePdfText(el.textContent ?? '');
      if (!clean || !speakable(clean)) continue;
      const start = joined.length ? joined.length + 1 : 0;
      joined = joined.length ? (joined + ' ' + clean) : clean;
      parts.push({ el, start, end: joined.length }); }
    if (!parts.length || !speakable(joined)) return { units: [], spanTotal: spans.length };
    const pieces = [];
    try { const seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
      for (const p of seg.segment(joined)) if (p.segment.trim()) pieces.push({ text: p.segment, start: p.index }); } catch (e) {}
    if (!pieces.length) pieces.push({ text: joined, start: 0 });
    const units = [];
    for (const p of pieces) { const text = stripPdfArtifacts(p.text); if (!speakable(text)) continue;
      const from = p.start, to = p.start + p.text.length;
      const hit = parts.filter(x => x.end > from && x.start < to);
      units.push({ text, spans: hit.map(h=>h.el) }); }
    return { units, spanTotal: spans.length }; };
  const ensureStyle = () => { const doc = pageDoc(); if (!doc) return false;
    let el = doc.getElementById(STYLE_ID);
    if (!el) { el = doc.createElement('style'); el.id = STYLE_ID; (doc.head||doc.documentElement).appendChild(el); }
    el.textContent = '.' + CLS + ' { background: rgba(255,214,0,0.38); border-radius: 3px; }';
    return true; };
  const markUnit = (i, lang) => { ensureStyle(); const doc = pageDoc();
    [...(doc?.querySelectorAll('.'+CLS)||[])].forEach(e=>e.classList.remove(CLS));
    const d = deriveUnits(lang); if (!d || !d.units[i]) return { ok:false, units: d?d.units.length:0 };
    d.units[i].spans.forEach(e=>e.classList.add(CLS));
    return { ok:true, units: d.units.length, marked: d.units[i].spans.length, text: d.units[i].text.slice(0,40) }; };
  /** Is the highlight actually VISIBLE, or painted over? Hit-test the middle of the first marked span. */
  const visibility = () => { const doc = pageDoc(); if (!doc) return null;
    const m = doc.querySelector('.'+CLS); if (!m) return { marked: 0 };
    const r = m.getBoundingClientRect();
    const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
    const top = doc.elementFromPoint(cx, cy);
    const cs = doc.defaultView.getComputedStyle(m);
    const canvas = doc.querySelector('#canvas');
    const tint = canvas ? doc.defaultView.getComputedStyle(canvas, '::after').backgroundColor : null;
    const img = doc.querySelector('#canvas img');
    return { marked: doc.querySelectorAll('.'+CLS).length,
      markBg: cs.backgroundColor, markZ: cs.zIndex, opacity: cs.opacity,
      topElementIsMark: !!(top && (top === m || m.contains(top) || top.classList?.contains(CLS))),
      topElementTag: top ? (top.tagName + '.' + (top.className||'').toString().slice(0,24)) : null,
      tint, imgFilter: img ? doc.defaultView.getComputedStyle(img).filter.slice(0,34) : null,
      layerZ: (() => { const l = doc.querySelector('.textLayer');
        return l ? doc.defaultView.getComputedStyle(l).zIndex : null; })() }; };
  const teardown = () => { const doc = pageDoc(); if (!doc) return false;
    [...(doc.querySelectorAll('.'+CLS)||[])].forEach(e=>e.classList.remove(CLS));
    doc.getElementById(STYLE_ID)?.remove(); return true; };
  window.__hlPoc = { deriveUnits, markUnit, visibility, teardown, CLS };
  return true;
})()`;

const report = { startedAt: new Date().toISOString(), stages: {}, verdicts: {}, violations: [] };
const snap = snapshotDb("M:\\eRawy", "pdf-hl-poc2");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9947, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
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
  await s.evaluate(TOOLKIT);

  // ===== A — UNIT STABILITY ACROSS ZOOM. The design re-derives by INDEX, so if the unit set changes
  //           shape at another scale, index N stops meaning the same sentence. =====================
  console.log("\n=== A · unit stability across zoom levels");
  const a = { levels: [] };
  for (const z of ["fit-page", "2", "3", "4", "fit-page"]) {
    await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom',${JSON.stringify(z)}); return true; })()`);
    await sleep(4200);
    const d = JSON.parse(await s.evaluate(`(() => { const d=window.__hlPoc.deriveUnits('ar');
      const real = null;
      return JSON.stringify({ units: d ? d.units.length : null, spanTotal: d ? d.spanTotal : null,
        texts: d ? d.units.map(u=>u.text.slice(0,26)) : [], perUnitSpans: d ? d.units.map(u=>u.spans.length) : [] }); })()`));
    const realUnits = JSON.parse(await s.evaluate(`(async()=>{ const r=await window.__sardPdfTts('ar'); return JSON.stringify({u:r?.units??0}); })()`));
    a.levels.push({ zoom: z, ...d, realUnits: realUnits.u });
    console.log(`  zoom ${String(z).padEnd(9)} spans=${d.spanTotal} units=${d.units} (real ${realUnits.u}) perUnitSpans=[${d.perUnitSpans.join(",")}]`);
  }
  const base = a.levels[0];
  a.unitCountStable = a.levels.every((l) => l.units === base.units);
  a.unitTextStable = a.levels.every((l) => JSON.stringify(l.texts) === JSON.stringify(base.texts));
  a.spanMappingStable = a.levels.every((l) => JSON.stringify(l.perUnitSpans) === JSON.stringify(base.perUnitSpans));
  console.log(`  unit COUNT stable across zoom: ${a.unitCountStable}`);
  console.log(`  unit TEXT  stable across zoom: ${a.unitTextStable}`);
  console.log(`  span mapping stable          : ${a.spanMappingStable}`);
  if (!a.unitTextStable) report.violations.push("unit TEXT changes with zoom — re-deriving by index would highlight the wrong sentence");
  report.stages.a_zoomStability = a;
  report.verdicts.unitTextStableAcrossZoom = a.unitTextStable;

  // ===== B — does a mark survive a re-render now that the layer is cleared? =======================
  console.log("\n=== B · mark lifetime across a real zoom (post accumulation-fix)");
  const b = {};
  b.marked = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(1,'ar'))`));
  b.before = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.visibility())`));
  await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','2'); return true; })()`);
  await sleep(4500);
  b.afterZoomNoAction = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.visibility())`));
  b.afterRedraw = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.markUnit(1,'ar'))`));
  b.styleSurvived = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return !!d?.getElementById('sard-hl-probe-style'); })()`);
  console.log(`  before zoom: ${b.before.marked} marked · after zoom, untouched: ${b.afterZoomNoAction.marked} · after re-derive: ${b.afterRedraw.marked}`);
  console.log(`  injected <style> survived the re-render: ${b.styleSurvived}`);
  report.stages.b_markLifetime = b;
  report.verdicts.marksLostOnZoom = b.afterZoomNoAction.marked === 0;
  report.verdicts.marksRecoverableAfterZoom = b.afterRedraw.ok === true;
  report.verdicts.styleSurvivesZoom = !!b.styleSurvived;

  await s.evaluate(`(() => { const r=document.querySelector('.page-host foliate-view')?.renderer; r?.setAttribute('zoom','fit-page'); return true; })()`);
  await sleep(3500);
  await s.evaluate(`window.__hlPoc.markUnit(1,'ar')`);

  // ===== C — THEMES, via the real chips, testing VISIBILITY not class presence ===================
  console.log("\n=== C · themes (real chips) — is the highlight still visible?");
  const c = { themes: [] };
  c.panelOpened = await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')].find(x=>/PDF/i.test(x.getAttribute('title')||''));
    if (b) { b.click(); return true; } return false; })()`);
  await sleep(900);
  for (const id of ["normal", "sepia", "night", "ink", "cream", "grey"]) {
    const clicked = await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${id}'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(1100);
    // re-apply after the theme change, exactly as the product would on a redraw callback
    await s.evaluate(`window.__hlPoc.markUnit(1,'ar')`);
    const v = JSON.parse(await s.evaluate(`JSON.stringify(window.__hlPoc.visibility())`));
    c.themes.push({ id, clicked, ...v });
    console.log(`  ${id.padEnd(7)} clicked=${clicked} marks=${v.marked} bg=${v.markBg} topIsMark=${v.topElementIsMark}`
      + ` tint=${String(v.tint).slice(0,22)} imgFilter=${String(v.imgFilter).slice(0,24)}`);
  }
  const distinctFilters = new Set(c.themes.map((t) => t.imgFilter)).size;
  const distinctTints = new Set(c.themes.map((t) => t.tint)).size;
  c.themesActuallyChanged = distinctFilters > 1 || distinctTints > 1;
  c.markVisibleEverywhere = c.themes.every((t) => t.marked > 0 && t.topElementIsMark);
  console.log(`  distinct filters=${distinctFilters} distinct tints=${distinctTints} -> themes really changed: ${c.themesActuallyChanged}`);
  console.log(`  highlight on top under every theme: ${c.markVisibleEverywhere}`);
  if (!c.themesActuallyChanged) report.violations.push("THEME STAGE VOID AGAIN — the chips did not change the page");
  report.stages.c_themes = c;
  report.verdicts.themesActuallyChanged = c.themesActuallyChanged;
  report.verdicts.highlightVisibleUnderAllThemes = c.themesActuallyChanged ? c.markVisibleEverywhere : null;

  await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-normal'); if (b) b.click(); return true; })()`);
  await sleep(800);
  await s.evaluate(`try { window.__hlPoc.teardown(); } catch(e){}`);
  const leftover = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    return (d?.querySelectorAll('.__sard_hl_probe').length ?? 0) + (d?.getElementById('sard-hl-probe-style')?1:0); })()`);
  console.log(`\nteardown leftover: ${leftover}`);
  report.stages.leftover = leftover;
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
