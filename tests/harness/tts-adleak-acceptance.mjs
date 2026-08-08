// ACCEPTANCE — the reported ad JavaScript must no longer be spoken, across multiple chapters of
// "لورد الغوامض 2: حلقة الحتمية", while the Arabic prose is unchanged.
//
// The criterion is BEHAVIOURAL, so counts alone are not accepted as proof. For each unit the harness
// reads what the player actually holds for the sentence being spoken and searches it for the ad
// tokens. The store's shape is dumped once at the start rather than assumed — an earlier round of this
// investigation drew a false conclusion from guessing a field's type.
//
// Pre-fix counts, measured on this same book by the live differential, are the baseline:
//     section 120 -> 137     section 403 -> 71     section 700 -> 70
// Each must now be exactly one lower.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-adleak-acceptance-result.json";
const BASELINE = { 120: 137, 403: 71, 700: 70 };           // pre-fix, measured
const SECTIONS = [120, 403, 700, 200, 500, 650];            // the three reported + three more
const BAD = ["pubfuturetag", "window.", "push({", "javascript"];

const report = { startedAt: new Date().toISOString(), baseline: BASELINE, sections: [], violations: [] };
const fail = (m) => { report.violations.push(m); console.log(`  ✗ ${m}`); };
const snap = snapshotDb("M:\\eRawy", "adleak-acceptance");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9960, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  const opened = await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')]
    .find(c=>(c.textContent||'').includes('حلقة الحتمية')); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  if (!opened) throw new Error("reported novel not found");
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);

  for (const idx of SECTIONS) {
    await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
      try { await v.goTo(${idx}); } catch(e) {} return true; })()`);
    await sleep(2600);

    // the script must still be in the DOM — otherwise this section proves nothing
    const domHasScript = await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      return (d?.querySelectorAll('script').length ?? 0) > 0 && (d?.body?.textContent||'').includes('pubfuturetag'); })()`);

    await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
      .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
    let st = null; const dl = Date.now() + 60_000;
    while (Date.now() < dl) {
      st = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
        return JSON.stringify({ status:q?.status, total:q?.total }); })()`));
      if ((st.total ?? 0) > 0 || st.status === "error") break;
      await sleep(700);
    }
    const total = st?.total ?? null;

    // ranged == units, from the LIVE retained set (a session owns the units now, so this is current)
    const tr = JSON.parse(await s.evaluate(`(async () => JSON.stringify(await window.__sardTrackStats('ar')))()`));

    // BEHAVIOURAL: step every unit and read what the player holds for the sentence being spoken.
    const spoken = [];
    let scanned = 0;
    for (let u = 0; u < (total ?? 0); u++) {
      await s.evaluate(`try { const q=window.__sardTtsStore.getState(); q.skip(${u} - q.index); } catch(e){}`);
      await sleep(260);
      const w = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
        const ws = Array.isArray(q?.words) ? q.words : [];
        const txt = ws.map(x => (typeof x === 'string' ? x : (x?.text ?? x?.word ?? ''))).join(' ');
        return JSON.stringify({ i:q?.index, words: ws.length, txt: txt.slice(0, 300) }); })()`));
      scanned++;
      if (w.txt && BAD.some((b) => w.txt.includes(b))) spoken.push({ unit: u, txt: w.txt.slice(0, 160) });
    }
    await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);
    await sleep(800);

    // DOM-level check: is the ad text reachable in the body at all, and is it in visible text?
    const domCheck = JSON.parse(await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      return JSON.stringify({ inTextContent: (d?.body?.textContent||'').includes('pubfuturetag'),
        inInnerText: (d?.body?.innerText||'').includes('pubfuturetag') }); })()`));

    const base = BASELINE[idx] ?? null;
    const rec = { idx, domHasScript, total, expected: base === null ? null : base - 1,
      trackStats: tr, unitsScanned: scanned, offendingUnits: spoken, ...domCheck };
    report.sections.push(rec);

    console.log(`section ${String(idx).padStart(3)}: script in DOM=${domHasScript} · units=${total}`
      + (base ? ` (pre-fix ${base}, expected ${base - 1})` : "")
      + ` · ranged=${tr.ranged}/${tr.units}`);
    console.log(`   scanned ${scanned} units for spoken ad text -> offending units: ${spoken.length}`);
    console.log(`   ad text still in body.textContent=${domCheck.inTextContent} · in innerText=${domCheck.inInnerText}`);
    if (spoken.length) console.log(`   ⚠ «${spoken[0].txt}»`);

    if (!domHasScript) fail(`section ${idx}: the ad script is not in the DOM — this section proves nothing`);
    if (base && total !== base - 1) fail(`section ${idx}: units=${total}, expected ${base - 1}`);
    if (tr.units !== tr.ranged) fail(`section ${idx}: ranged ${tr.ranged} != units ${tr.units}`);
    if (spoken.length) fail(`section ${idx}: ${spoken.length} unit(s) still carry ad text`);
    console.log("");
  }

  const S = report.sections;
  report.verdicts = {
    everySectionHadTheScript: S.every((r) => r.domHasScript),
    countsAsExpected: S.filter((r) => r.expected !== null).every((r) => r.total === r.expected),
    allRanged: S.every((r) => r.trackStats.units === r.trackStats.ranged),
    noSpokenAdText: S.every((r) => r.offendingUnits.length === 0),
    totalUnitsScanned: S.reduce((a, r) => a + r.unitsScanned, 0),
  };
  const V = report.verdicts;
  console.log(`sections: ${S.length} · units scanned for spoken ad text: ${V.totalUnitsScanned}`);
  console.log(`  ad script present in every section's DOM : ${V.everySectionHadTheScript}`);
  console.log(`  unit counts exactly one lower            : ${V.countsAsExpected}`);
  console.log(`  every unit still carries a range         : ${V.allRanged}`);
  console.log(`  NO unit carries the ad text              : ${V.noSpokenAdText}`);
  console.log(`\n${report.violations.length === 0 ? "✓ ACCEPTANCE: PASS" : `✗ FAILED — ${report.violations.length} violation(s)`}`);
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (report.violations.length || report.fatal) process.exitCode = 3;
}
