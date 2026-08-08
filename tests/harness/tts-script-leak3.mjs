// TESTER REPORT — round 4. The decisive measurement, using ONLY the real pipeline's own numbers.
//
// Rounds 2 and 3 are void as evidence and are not reported:
//   round 2 read a STALE `trackStats()` count (it returns the retained set once a session owns units);
//   round 3 used a REPLICA of the extraction walk that does not reproduce the real unit count
//           (53 vs 71, 60 vs 70, 139 vs 137) — the real `segmentBlock` walks text nodes and builds
//           ranges, which my one-string-per-element approximation does not. A replica that cannot
//           reproduce the count cannot be trusted to name the unit index or its text.
//
// THIS round asks one question with no replica and no cache in the way:
//     does the ad <div> contribute a unit to the REAL read-aloud queue?
// Pressing Play rebuilds the units for the section on screen and publishes their number as the store's
// `total`. So: play -> record total -> stop -> remove the one ad node -> play -> record total -> stop
// -> put the node back -> play -> confirm the total returns. If the middle total is exactly one lower,
// that node is exactly one spoken unit.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-script-leak3-result.json";
const SECTIONS = [403, 700, 120];

const report = { startedAt: new Date().toISOString(), sections: [], verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "tts-script-leak3");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
/** Press the real control, wait for the queue to exist, read `total`, then stop. */
async function playAndCountTotal() {
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  let st = null;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    st = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
      return JSON.stringify({ status:q?.status, total:q?.total, active:q?.active }); })()`));
    if ((st.total ?? 0) > 0) break;
    if (st.status === "error") break;
    await sleep(700);
  }
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
  await sleep(1200);
  return st;
}

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9955, timeoutMs: 90_000 });
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

    const before = await playAndCountTotal();
    // Detach ONLY the ad container, remembering exactly where it was.
    const detached = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      const sc = d?.querySelector('script'); if (!sc) return { ok:false };
      const host = (sc.parentElement && sc.parentElement.tagName !== 'BODY') ? sc.parentElement : sc;
      window.__adNode = host; window.__adParent = host.parentNode; window.__adNext = host.nextSibling;
      const info = { ok:true, tag: host.tagName, id: host.getAttribute('id'),
        textLen: (host.textContent||'').length, text: (host.textContent||'').trim().slice(0,150) };
      host.remove(); return info; })()`);
    const without = await playAndCountTotal();
    await s.evaluate(`(() => { if (window.__adNode && window.__adParent) {
      window.__adParent.insertBefore(window.__adNode, window.__adNext || null); }
      window.__adNode=window.__adParent=window.__adNext=null; return true; })()`);
    await sleep(600);
    const after = await playAndCountTotal();

    const rec = { idx, totalWithAd: before?.total ?? null, totalWithoutAd: without?.total ?? null,
      totalRestored: after?.total ?? null, delta: (before?.total ?? 0) - (without?.total ?? 0),
      node: detached };
    report.sections.push(rec);
    console.log(`section ${idx}:  WITH ad total=${rec.totalWithAd}   WITHOUT ad total=${rec.totalWithoutAd}   DELTA=${rec.delta}   restored=${rec.totalRestored}`);
    console.log(`   removed node: <${String(detached.tag).toLowerCase()} id="${detached.id}"> textContent length=${detached.textLen}`);
    console.log(`   its text: «${detached.text}»`);
    console.log("");
  }

  const S = report.sections;
  report.verdicts.everyDeltaExactlyOne = S.length > 0 && S.every((r) => r.delta === 1);
  report.verdicts.restoredEverywhere = S.every((r) => r.totalRestored === r.totalWithAd);
  console.log(`removing the ad node removes EXACTLY one spoken unit, every section: ${report.verdicts.everyDeltaExactlyOne}`);
  console.log(`unit count returned after restoring the node:                        ${report.verdicts.restoredEverywhere}`);
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
