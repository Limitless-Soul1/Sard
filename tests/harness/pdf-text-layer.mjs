// CAN A PDF BE READ ALOUD? — the feasibility measurement, before any architecture is proposed.
//
// TTS needs TEXT. A PDF may carry a text layer, and pdf.js exposes it (`page.getTextContent()`), but
// two things decide whether it is usable:
//   1. Does the page have a text layer at all? Four of the six library PDFs have ZERO fonts — they are
//      scans, and no amount of engineering extracts text from a picture without OCR.
//   2. Where a layer EXISTS, is it faithful? FoliateController already warns that Arabic PDFs commonly
//      embed subset fonts with a broken/missing ToUnicode CMap, which yields text that looks like text
//      to code and is gibberish to a human — the worst possible input for read-aloud.
//
// This measures both, per file, on real pages, and scores legibility so the answer is not a guess.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORPUS = [
  { key: "الأمير الصغير", match: "Noor-Book", fonts: 108, note: "mixed text+image" },
  { key: "رسالة الغفران", match: "33102", fonts: 210, note: "text PDF" },
  { key: "فن الحرب", match: "24116", fonts: 125, note: "text PDF, encrypted" },
  { key: "مقدمة ابن خلدون", match: "مقدمة ابن خلدون", fonts: 1, note: "scan (expect nothing)" },
  { key: "697", match: "S697", fonts: 0, note: "scan (expect nothing)" },
  { key: "الداء والدواء", match: "_الكتاب", fonts: 0, note: "scan (expect nothing)" },
];

const snap = snapshotDb("M:\\eRawy", "pdf-text-layer");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = [];
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9922, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // Legibility scoring. Arabic text with a broken CMap typically decodes into the private-use area or
  // into unrelated Latin/symbol codepoints, and loses word spacing. Real Arabic prose has a high ratio
  // of Arabic letters, sane word lengths, and spaces.
  const SAMPLE = `(() => {
    const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc;
    const layer = d?.querySelector('.textLayer');
    const spans = layer ? [...layer.querySelectorAll('span')] : [];
    const text = spans.map(x => x.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
    const chars = [...text];
    const arabic = chars.filter(c => /[\\u0600-\\u06FF]/.test(c)).length;
    const latin = chars.filter(c => /[A-Za-z]/.test(c)).length;
    const pua = chars.filter(c => { const n = c.codePointAt(0); return n >= 0xE000 && n <= 0xF8FF; }).length;
    const words = text.split(' ').filter(Boolean);
    return JSON.stringify({
      hasLayer: !!layer, spans: spans.length, chars: chars.length,
      arabicRatio: chars.length ? +(arabic / chars.length).toFixed(3) : 0,
      latinRatio: chars.length ? +(latin / chars.length).toFixed(3) : 0,
      puaRatio: chars.length ? +(pua / chars.length).toFixed(3) : 0,
      words: words.length, meanWordLen: words.length ? +(words.reduce((a, w) => a + w.length, 0) / words.length).toFixed(1) : 0,
      sample: text.slice(0, 90),
    }); })()`;

  for (const spec of CORPUS) {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
    const ok = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(spec.match)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!ok) { console.log(`${spec.key}: card not found`); continue; }
    for (let k = 0; k < 120; k++) { if (JSON.parse(await s.evaluate(SAMPLE)).hasLayer) break; await sleep(250); }
    await sleep(2500);

    // Sample several pages: a title page proves nothing about the body.
    const pages = [];
    for (let p = 0; p < 5; p++) {
      pages.push(JSON.parse(await s.evaluate(SAMPLE)));
      await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
      await sleep(1400);
    }
    const withText = pages.filter((p) => p.chars > 40);
    const rec = { ...spec, pagesSampled: pages.length, pagesWithText: withText.length,
      meanChars: withText.length ? Math.round(withText.reduce((a, p) => a + p.chars, 0) / withText.length) : 0,
      arabicRatio: withText.length ? +(withText.reduce((a, p) => a + p.arabicRatio, 0) / withText.length).toFixed(3) : 0,
      puaRatio: withText.length ? +(withText.reduce((a, p) => a + p.puaRatio, 0) / withText.length).toFixed(3) : 0,
      meanWordLen: withText.length ? +(withText.reduce((a, p) => a + p.meanWordLen, 0) / withText.length).toFixed(1) : 0,
      sample: withText[0]?.sample ?? pages[0]?.sample ?? "" };
    // A usable layer: most pages carry text, it is mostly Arabic letters, almost nothing lands in the
    // private-use area, and words are word-shaped rather than one giant run.
    rec.usable = rec.pagesWithText >= 3 && rec.arabicRatio > 0.5 && rec.puaRatio < 0.02 && rec.meanWordLen > 1.5 && rec.meanWordLen < 14;
    out.push(rec);
    console.log(`${spec.key.padEnd(18)} fonts=${String(spec.fonts).padStart(3)} pagesWithText=${rec.pagesWithText}/5`
      + ` chars~${String(rec.meanChars).padStart(5)} arabic=${rec.arabicRatio} pua=${rec.puaRatio} wordLen=${rec.meanWordLen}`
      + `  => ${rec.usable ? "USABLE" : "NOT USABLE"}`);
    if (rec.sample) console.log(`    sample: ${rec.sample.slice(0, 78)}`);
  }
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-text-layer-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
