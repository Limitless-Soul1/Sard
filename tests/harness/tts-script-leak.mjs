// TESTER REPORT — "read-aloud spoke code-like text mid-chapter". Investigation harness, READ-ONLY.
//
// The novel's every content document carries an ad-network tag:
//     <div id="pf-12454-1"><script>window.pubfuturetag = window.pubfuturetag || []; …</script></div>
// read aloud: "window dot pub-future-tag" — the tester's "window dot pup futer tage".
//
// ROUND 1 WAS VOID AND IS NOT REPORTED: it read `__sardTrackStats().units` as an array of unit texts.
// That field is a COUNT (FoliateController.trackStats returns {section, units, ranged, unranged,
// rebuilt}), so `Array.isArray` failed and every section reported 0 units — an absence produced
// entirely by the instrument. Two independent measurements replace it:
//
//   A. DIFFERENTIAL, using ONLY the real controller's own numbers. Ask `trackStats()` for the unit
//      count with the ad <div> in place, remove that one node, ask again, then put it back. If the
//      count falls by exactly one, that node contributed exactly one spoken unit. No replica involved.
//
//   B. REPLICA of the extraction walk, to recover the unit TEXT — gated on reproducing the real unit
//      count first, so a divergent replica cannot be used to claim anything.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-script-leak-result.json";
const NEEDLE = "pubfuturetag";
const SAMPLE_SECTIONS = [3, 50, 120, 250, 403, 700];

// Replica of getChapterUnits' EPUB branch (FoliateController.ts): leaf containers, skip hidden,
// require textContent, segment each with Intl.Segmenter. Used only for TEXT, and only once its unit
// count matches the real controller's.
const REPLICA = `(() => {
  const v = document.querySelector('.page-host foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  if (!d?.body) return null;
  const CONTAINER = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article';
  const win = d.defaultView;
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  const isHidden = (el) => { const cs = win?.getComputedStyle(el);
    return !!cs && (cs.visibility === 'hidden' || cs.display === 'none'); };
  const seg = new Intl.Segmenter('ar', { granularity: 'sentence' });
  const out = [];
  for (const el of d.body.querySelectorAll(CONTAINER)) {
    if (el.querySelector(CONTAINER)) continue;
    if (isHidden(el)) continue;
    if (el.closest('.sard-title-ph')) continue;
    const raw = el.textContent ?? '';
    if (!raw.trim()) continue;
    for (const p of seg.segment(norm(raw))) { const t = norm(p.segment); if (t) out.push(t); }
  }
  return out;
})()`;

const report = { startedAt: new Date().toISOString(), sections: [], verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "tts-script-leak");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9953, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const book = (Array.isArray(books) ? books : []).find((b) => String(b.title ?? "").includes("حلقة الحتمية") && String(b.title).includes("لورد"));
  if (!book) throw new Error("reported novel not found");
  console.log(`book: "${book.title}"`);
  report.book = { id: book.id, title: book.title };

  await s.evaluate(`(() => { const t=${JSON.stringify(book.title)};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);
  report.spineSections = await s.evaluate(`document.querySelector('.page-host foliate-view')?.book?.sections?.length ?? null`);
  console.log(`sections in spine: ${report.spineSections}\n`);

  for (const idx of SAMPLE_SECTIONS) {
    if (report.spineSections != null && idx >= report.spineSections) continue;
    await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
      try { await v.goTo(${idx}); } catch(e) { try { await v.renderer.goTo({ index: ${idx} }); } catch(e2) {} } return true; })()`);
    await sleep(2600);

    // ---- A · DIFFERENTIAL on the REAL controller's unit count -------------------------------
    const withAd = JSON.parse(await s.evaluate(`(async () => JSON.stringify(await window.__sardTrackStats('ar')))()`));
    const detached = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      const sc = d?.querySelector('script'); if (!sc) return 0;
      const host = sc.parentElement && sc.parentElement.tagName !== 'BODY' ? sc.parentElement : sc;
      window.__adNode = host; window.__adParent = host.parentNode; window.__adNext = host.nextSibling;
      host.remove(); return 1; })()`);
    const withoutAd = JSON.parse(await s.evaluate(`(async () => JSON.stringify(await window.__sardTrackStats('ar')))()`));
    // put it back exactly where it was — the page must be left as found
    await s.evaluate(`(() => { if (window.__adNode && window.__adParent) {
      window.__adParent.insertBefore(window.__adNode, window.__adNext || null); }
      window.__adNode = window.__adParent = window.__adNext = null; return true; })()`);
    const restored = JSON.parse(await s.evaluate(`(async () => JSON.stringify(await window.__sardTrackStats('ar')))()`));

    // ---- B · REPLICA for the TEXT, gated on matching the real count -------------------------
    const rep = await s.evaluate(REPLICA);
    const texts = Array.isArray(rep) ? rep : [];
    const replicaMatches = texts.length === withAd.units;
    const hits = texts.map((t, i) => ({ i, t })).filter((x) => x.t.includes(NEEDLE));
    const dom = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      const sc = d?.querySelector('script'); const par = sc?.parentElement;
      const visible = d?.body ? d.body.innerText : '';
      return JSON.stringify({
        scriptDisplay: sc ? d.defaultView.getComputedStyle(sc).display : null,
        containerTag: par?.tagName ?? null, containerId: par?.getAttribute('id') ?? null,
        containerDisplay: par ? d.defaultView.getComputedStyle(par).display : null,
        containerVisibility: par ? d.defaultView.getComputedStyle(par).visibility : null,
        containerIsLeaf: par ? !par.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article') : null,
        needleVisibleToReader: visible.includes(${JSON.stringify(NEEDLE)}),
      }); })()`));

    const rec = { idx, real: withAd, realWithoutAd: withoutAd, realRestored: restored, detached,
      delta: withAd.units - withoutAd.units, replicaCount: texts.length, replicaMatches,
      hitCount: hits.length, hitIndex: hits[0]?.i ?? null, hitText: hits[0]?.t?.slice(0, 220) ?? null, ...dom };
    report.sections.push(rec);

    console.log(`section ${String(idx).padStart(3)} · real units WITH ad=${withAd.units}  WITHOUT ad=${withoutAd.units}  DELTA=${rec.delta}  (restored=${restored.units})`);
    console.log(`   container <${String(dom.containerTag).toLowerCase()} id="${dom.containerId}"> display=${dom.containerDisplay} visibility=${dom.containerVisibility} isLeaf=${dom.containerIsLeaf} · script display=${dom.scriptDisplay}`);
    console.log(`   replica units=${texts.length} matches real=${replicaMatches} · units containing "${NEEDLE}"=${hits.length} · visible to reader=${dom.needleVisibleToReader}`);
    if (hits.length) console.log(`   UNIT #${hits[0].i} AS SPOKEN: «${hits[0].t.slice(0, 160)}»`);
    console.log("");
  }

  const secs = report.sections;
  report.verdicts.sampled = secs.length;
  report.verdicts.everyDeltaIsOne = secs.length > 0 && secs.every((r) => r.delta === 1);
  report.verdicts.replicaFaithfulEverywhere = secs.every((r) => r.replicaMatches);
  report.verdicts.spokenInEverySection = secs.every((r) => r.hitCount > 0);
  report.verdicts.neverVisibleToReader = secs.every((r) => r.needleVisibleToReader === false);
  report.verdicts.restoredCleanly = secs.every((r) => r.realRestored.units === r.real.units);
  console.log(`sampled sections: ${report.verdicts.sampled}`);
  console.log(`removing the ad node drops EXACTLY one unit, every time: ${report.verdicts.everyDeltaIsOne}`);
  console.log(`replica reproduced the real unit count everywhere:      ${report.verdicts.replicaFaithfulEverywhere}`);
  console.log(`script text present in the spoken units, every section: ${report.verdicts.spokenInEverySection}`);
  console.log(`never present in what the reader can see:               ${report.verdicts.neverVisibleToReader}`);
  console.log(`page restored to its original unit count:               ${report.verdicts.restoredCleanly}`);
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
