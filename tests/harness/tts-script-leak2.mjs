// TESTER REPORT — round 3. Validate the replica against the LIVE read-aloud pipeline.
//
// Round 2's differential was VOID and is not reported: `trackStats()` rebuilds units only when no TTS
// session owns them (`ttsUnitsIndex >= 0` -> it returns the RETAINED set). Once the first call had
// built a set, every later call returned that same stale count — 169 for six chapters of visibly
// different lengths — so both the DELTA and the "replica mismatch" were measuring nothing.
//
// The route that cannot go stale is PLAYBACK: pressing the real read-aloud control builds the units
// for the section on screen and publishes their number as the store's `total`. So:
//   * replica count == store total   -> the replica reproduces the real unit set for this section
//   * replica unit #N is the ad script -> the real pipeline therefore holds that unit too
//   * skip to N and the player reports index N, still playing -> that unit is genuinely in the queue
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-script-leak2-result.json";
const NEEDLE = "pubfuturetag";
const SECTIONS = [403, 700, 120];

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
const snap = snapshotDb("M:\\eRawy", "tts-script-leak2");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9954, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const book = (Array.isArray(books) ? books : []).find((b) => String(b.title ?? "").includes("حلقة الحتمية") && String(b.title).includes("لورد"));
  if (!book) throw new Error("reported novel not found");
  report.book = { id: book.id, title: book.title };
  console.log(`book: "${book.title}"\n`);

  await s.evaluate(`(() => { const t=${JSON.stringify(book.title)};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);

  for (const idx of SECTIONS) {
    await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
      try { await v.goTo(${idx}); } catch(e) { try { await v.renderer.goTo({ index: ${idx} }); } catch(e2) {} } return true; })()`);
    await sleep(2800);

    const texts = (await s.evaluate(REPLICA)) ?? [];
    const hit = texts.map((t, i) => ({ i, t })).find((x) => x.t.includes(NEEDLE)) ?? null;

    // LIVE: press the real control; the store's `total` is the real unit count for THIS section.
    await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
      .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
    let st = null;
    const dl = Date.now() + 70_000;
    while (Date.now() < dl) {
      st = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
        return JSON.stringify({ status:q?.status, index:q?.index, total:q?.total, active:q?.active }); })()`));
      if (st.total > 0 && (st.status === "playing" || st.status === "buffering")) break;
      if (st.status === "error") break;
      await sleep(800);
    }

    // Skip to the predicted unit and confirm the queue really has it there.
    let atHit = null;
    if (hit && st?.total > hit.i) {
      await s.evaluate(`try { window.__sardTtsStore.getState().skip(${hit.i} - window.__sardTtsStore.getState().index); } catch(e){}`);
      await sleep(2500);
      atHit = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
        const c=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0];
        const el=c?.overlayer?.element; const svg = el && (el.tagName?.toLowerCase()==='svg' ? el : el.querySelector('svg'));
        return JSON.stringify({ index:q?.index, status:q?.status, spotlightShapes: svg ? svg.children.length : null }); })()`));
    }
    await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
    await sleep(900);

    const rec = { idx, replicaCount: texts.length, liveTotal: st?.total ?? null, liveStatus: st?.status ?? null,
      countsAgree: texts.length === (st?.total ?? -1), hitIndex: hit?.i ?? null,
      hitText: hit?.t?.slice(0, 200) ?? null, atHit };
    report.sections.push(rec);
    console.log(`section ${idx}: replica units=${rec.replicaCount} · LIVE store total=${rec.liveTotal} · agree=${rec.countsAgree}`);
    console.log(`   ad-script unit index = ${rec.hitIndex} of ${rec.replicaCount}`);
    if (atHit) console.log(`   after skip -> store index=${atHit.index} status=${atHit.status} spotlightShapes=${atHit.spotlightShapes}`);
    console.log("");
  }

  const S = report.sections;
  report.verdicts.replicaMatchesLiveEverywhere = S.length > 0 && S.every((r) => r.countsAgree);
  report.verdicts.adUnitPresentEverywhere = S.every((r) => r.hitIndex !== null);
  report.verdicts.skipLandedOnAdUnit = S.every((r) => r.atHit && r.atHit.index === r.hitIndex);
  console.log(`replica count == live store total, every section: ${report.verdicts.replicaMatchesLiveEverywhere}`);
  console.log(`ad-script unit present in every sampled section:  ${report.verdicts.adUnitPresentEverywhere}`);
  console.log(`skipping to that index landed on it:              ${report.verdicts.skipLandedOnAdUnit}`);
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
