// PDF READ-ALOUD — extraction quality against the real corpus, in the real binary.
//
// The bar is NOT "units were produced". It is: would a listener hear their book? So for every file
// this reports the units built, whether each carries a RANGE (highlighting), and the legibility of the
// text that would actually be SPOKEN — after repair — alongside the document verdict Sard reaches.
// A file that yields confident-sounding gibberish must show up here as unusable, not as a success.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORPUS = [
  { key: "الأمير الصغير", match: "Noor-Book", expect: "watermark only — expect unusable" },
  { key: "رسالة الغفران", match: "33102", expect: "presentation forms — the repair case" },
  { key: "فن الحرب", match: "24116", expect: "encrypted + mojibake — expect unusable" },
  { key: "مقدمة ابن خلدون", match: "مقدمة ابن خلدون", expect: "scan — expect no text" },
  { key: "697", match: "S697", expect: "scan — expect no text" },
  { key: "الداء والدواء", match: "_الكتاب", expect: "scan — expect no text" },
];

const snap = snapshotDb("M:\\eRawy", "pdf-tts");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = [];
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9924, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140))); return true; })()`);

  // Score what would be SPOKEN. Presentation forms surviving into this string means repair failed.
  const SCORE = `(txt) => { const c=[...txt];
    const letters=c.filter(x=>/\\p{L}/u.test(x));
    const good=letters.filter(x=>/[\\u0600-\\u06FF]|[A-Za-z]/.test(x)).length;
    const pres=c.filter(x=>/[\\uFB50-\\uFDFF\\uFE70-\\uFEFF]/.test(x)).length;
    const words=txt.split(' ').filter(Boolean);
    return { chars:c.length, legible: letters.length? +(good/letters.length).toFixed(3):0,
      presLeft: c.length? +(pres/c.length).toFixed(4):0,
      meanWordLen: words.length? +(words.reduce((a,w)=>a+w.length,0)/words.length).toFixed(1):0 }; }`;

  for (const spec of CORPUS) {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
    const ok = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(spec.match)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!ok) { console.log(`${spec.key}: card not found`); continue; }
    for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(250); }
    await sleep(3000);

    // Walk a few pages, asking the controller for units exactly as read-aloud does.
    const rec = { ...spec, pages: [] };
    for (let p = 0; p < 4; p++) {
      const r = JSON.parse(await s.evaluate(`(async () => {
        let r = null;
        try { r = await window.__sardPdfTts('ar'); } catch (e) { return JSON.stringify({ err: String(e).slice(0,120) }); }
        if (!r) return JSON.stringify({ err: 'no debug surface' });
        const score = (${SCORE});
        return JSON.stringify({ units: r.units, withRange: r.withRange,
          sample: r.text.slice(0, 100), ...score(r.text) }); })()`));
      rec.pages.push(r);
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
      await sleep(1500);
    }
    rec.verdict = JSON.parse(await s.evaluate(`(async () => { try { const r = await window.__sardPdfTts('ar'); return JSON.stringify(r ? r.verdict : null); } catch (e) { return JSON.stringify({ err: String(e).slice(0,90) }); } })()`));
    const spoke = rec.pages.filter((p) => (p.units ?? 0) > 0);
    rec.pagesWithUnits = spoke.length;
    rec.meanLegible = spoke.length ? +(spoke.reduce((a, p) => a + p.legible, 0) / spoke.length).toFixed(3) : 0;
    rec.presLeft = spoke.length ? +(spoke.reduce((a, p) => a + p.presLeft, 0) / spoke.length).toFixed(4) : 0;
    rec.rangesOk = spoke.length ? spoke.every((p) => p.withRange === p.units) : null;
    out.push(rec);
    console.log(`\n=== ${spec.key}  (${spec.expect})`);
    console.log(`  pages with units: ${rec.pagesWithUnits}/4 · legible=${rec.meanLegible} · presentation forms left=${rec.presLeft}`
      + ` · every unit has a highlight range=${rec.rangesOk}`);
    console.log(`  verdict: ${JSON.stringify(rec.verdict)}`);
    if (spoke[0]?.sample) console.log(`  would speak: ${spoke[0].sample.slice(0, 88)}`);
  }
  out.push({ errors: JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 8))`)) });
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-tts-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
