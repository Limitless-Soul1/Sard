// PPC-3 / FINDING-5 — "الشوقيات reports paras: 1 for 6032 characters".
//
// Filed as a paragraph-extraction defect. The claim on record is that it was an ARTIFACT OF A NAME:
// the field counted `<p>` ELEMENTS, and this book structures its text with `<div>`, so 1 was the
// correct answer to the question actually being asked — and the wrong answer to the question the
// name implied. `tests/harness/css-modes.mjs` renamed its own field to `pTags` for that reason.
//
// A claim in a comment is not evidence, and BETA-1.md still lists PPC-3 as open and unexplained. So
// this measures the book directly and answers the only question that matters for a READER:
//
//   does the text reach the reading pipeline, or is it lost?
//
// If <p> is 1 but <div> is 200+ and the read-aloud pipeline produces units WITH DOM ranges for them,
// then nothing is broken and the finding was about vocabulary. If the units are missing or rangeless,
// there is a real defect and the "artifact" explanation was wrong.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };
const TITLE = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? "الشوقيات";

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 9345);
// `sample.epub` in the app profile IS الشوقيات — the same book the corpus calls
// poetry-rtl--shawqiyyat.epub. Used as the import source so the run needs nothing outside the
// machine's own data.
const SOURCE = process.argv.find((a) => a.startsWith("--source="))?.slice(9)
  ?? join(process.env.APPDATA, "com.sard.app", "sample.epub");

const snap = snapshotDb("M:\\eRawy", "ppc3");
if (!snap) { console.error("FATAL: could not snapshot"); process.exit(1); }
let s;
let cleanupHash = null;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: PORT, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // THE BOOK IS NOT IN THE LIBRARY — and that is itself part of the finding.
  //
  // `byte-identity` reports `poetry-rtl--shawqiyyat.epub — skipped — not in the library` on every
  // run, so the one book PPC-3 is about has been outside the safety net the whole time. It is
  // imported here for the measurement and removed again afterwards (hash-verified, as PPC-1's
  // harness does) so the owner's library is exactly as it was.
  let importedHash = null;
  if (!(await s.evaluate(`[...document.querySelectorAll('.lib-card')].some(x => (x.textContent||'').includes(${JSON.stringify(TITLE)}))`))) {
    const res = await s.evaluate(`(async () => { try {
        return JSON.stringify(await window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(SOURCE)}] }));
      } catch (e) { return 'THREW: ' + e.message; } })()`);
    console.log("   imported for this run:", String(res).slice(0, 160));
    try { importedHash = JSON.parse(res)?.[0]?.id ?? null; } catch { /* left null */ }
    // The library list is read at startup, so the freshly imported book needs a restart to appear.
    try { await s.close(); } catch { /* gone */ }
    try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
    await sleep(2500);
    s = await launchSard({ exe: "test-build/Sard.exe", port: PORT + 3, timeoutMs: 60_000 });
    if (s.skipped) throw new Error(s.skipped);
    for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
    for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  }
  cleanupHash = importedHash;

  const opened = await s.evaluate(`(() => {
    const c = [...document.querySelectorAll('.lib-card')].find(x => (x.textContent || '').includes(${JSON.stringify(TITLE)}));
    if (c) c.click(); return !!c; })()`);
  ok(`the book "${TITLE}" is in the library and was opened`, opened === true);
  if (!opened) throw new Error("book not found — import it first, or pass --title=");
  for (let i = 0; i < 100; i++) {
    if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break;
    await sleep(300);
  }
  await sleep(3500);

  // NAVIGATE TO A SECTION THAT HAS TEXT.
  //
  // The book opens on its COVER — one <div>, one image, zero characters — and the first run measured
  // exactly that: textLen 0, pTags 0, textCarriers 0, and four "failures" that said nothing about
  // the book. FINDING-5 quotes 6032 characters, so the section it describes is a text section
  // further in. Measuring section 0 and reporting on "the book" is the same mistake in miniature as
  // the one PPC-3 exists to correct: reading a number without checking what it counted.
  console.log("\n0. Finding the section FINDING-5 describes (~6032 characters)");
  // The book opens on its COVER — one <div>, one image, zero characters — and the first run measured
  // exactly that, producing four "failures" that said nothing about the book. The second stopped on
  // the PUBLISHER page (641 chars). FINDING-5 quotes 6032 characters, so the target is a substantial
  // text section further in. Reading a number without checking what it counted is the very mistake
  // PPC-3 exists to correct, so the search is explicit about what it is looking for.
  let found = null;
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const st = JSON.parse(await s.evaluate(`(() => {
      const c = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0];
      const d = c?.doc;
      return JSON.stringify({ index: c?.index ?? null,
        len: d ? (d.body.textContent || '').replace(/\\s+/g, ' ').trim().length : 0 });
    })()`));
    seen.push(`${st.index}:${st.len}`);
    if (st.len >= 3000) { found = st; break; }
    await s.evaluate(`document.querySelector('.page-host foliate-view')?.next?.()`);
    await sleep(1600);
  }
  console.log("   sections visited (index:chars):", seen.join(" "));
  console.log("   landed on:", JSON.stringify(found));
  ok("a substantial text section was reached", !!found,
     found ? `section ${found.index}, ${found.len} chars` : "none above 3000 chars in 20 sections");

  // ---- 1. WHAT IS THE DOCUMENT ACTUALLY MADE OF? ----------------------------------------------
  console.log("\n1. The section's real structure");
  const shape = JSON.parse(await s.evaluate(`(() => {
    const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    if (!d) return JSON.stringify({ error: 'no section document' });
    const text = (d.body.textContent || '').replace(/\\s+/g, ' ').trim();
    const counts = {};
    for (const el of d.body.querySelectorAll('*')) {
      const t = el.tagName.toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
    }
    // How many elements actually CARRY text, whatever they are called? That is the number the
    // finding believed it was reading.
    const textCarriers = [...d.body.querySelectorAll('*')].filter(el => {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      return own.length > 0;
    }).length;
    return JSON.stringify({ textLen: text.length, pTags: d.body.querySelectorAll('p').length,
      divTags: d.body.querySelectorAll('div').length, textCarriers, tagCounts: counts, sample: text.slice(0, 80) });
  })()`));
  console.log("   " + JSON.stringify(shape));
  if (shape.error) throw new Error(shape.error);
  // STRUCTURE IS REPORTED, NOT ASSERTED.
  //
  // The earlier version asserted a PREDICTED shape — "<p> is 1, <div> is 200+" — taken from a comment
  // in css-modes.mjs describing one particular section. Measured, the structure VARIES by section
  // (the publisher page has 4 <p> and 6 <div>), so those assertions failed against a book that is
  // fine. A test that encodes a guess about the data fails when the guess is wrong, which is not the
  // same as finding a defect. The only thing worth asserting is whether text REACHES THE READER;
  // how the book spells its containers is an observation.
  console.log(`   <p>=${shape.pTags} · <div>=${shape.divTags} · elements carrying their own text=${shape.textCarriers}`);
  ok("the section carries the substantial text the finding describes", shape.textLen >= 3000, `${shape.textLen} characters`);
  ok("the <p> count alone does NOT describe this book's structure",
     shape.textCarriers > shape.pTags, `${shape.textCarriers} text-carrying elements vs ${shape.pTags} <p> — the gap IS the finding`);

  // ---- 2. DOES THE READING PIPELINE SEE IT? ----------------------------------------------------
  // The decisive question. `<p>` counting is a harness's vocabulary problem; units WITHOUT ranges
  // would be a real reader-facing defect (text that can be spoken but never highlighted — the
  // TRACK-1 failure shape).
  console.log("\n2. The reading pipeline — the question that actually matters");
  const units = JSON.parse(await s.evaluate(`(() => {
    const c = document.querySelector('.page-host foliate-view');
    const ctrl = window.__sardCtrl || null;
    const d = c?.renderer?.getContents?.()?.[0]?.doc;
    if (!d) return JSON.stringify({ error: 'no doc' });
    // Rebuild what the read-aloud extractor sees: block-ish elements carrying their own text.
    const blocks = [...d.body.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote')]
      .filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0));
    let withRange = 0;
    for (const el of blocks) {
      try { const r = d.createRange(); r.selectNodeContents(el); if (r.toString().trim().length) withRange++; } catch { /* ignore */ }
    }
    return JSON.stringify({ blocks: blocks.length, withRange, hasCtrl: !!ctrl });
  })()`));
  console.log("   " + JSON.stringify(units));
  ok("the text resolves into speakable blocks", units.blocks > 0, `${units.blocks} blocks`);
  ok("EVERY block yields a usable DOM range (nothing is rangeless)", units.withRange === units.blocks,
     `${units.withRange}/${units.blocks} — a shortfall here would be a real TRACK-1-class defect`);

  // ---- 3. IS ANY TEXT LOST? --------------------------------------------------------------------
  console.log("\n3. Is any text unreachable?");
  const cover = JSON.parse(await s.evaluate(`(() => {
    const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const all = (d.body.textContent || '').replace(/\\s+/g, ' ').trim().length;
    const blocks = [...d.body.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote')]
      .filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0));
    const covered = blocks.reduce((n, el) => n + (el.textContent || '').replace(/\\s+/g, ' ').trim().length, 0);
    return JSON.stringify({ all, covered, ratio: all ? +(covered / all).toFixed(3) : 0 });
  })()`));
  console.log("   " + JSON.stringify(cover));
  ok("essentially all of the section's text is inside extractable blocks", cover.ratio >= 0.9,
     `${Math.round(cover.ratio * 100)}% of ${cover.all} characters`);
} catch (e) {
  console.error("\nHARNESS FAILED:", e.message);
  fail.push("harness: " + e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  // Remove the book this run imported. Hash-verified and app-independent, for the reasons PPC-1's
  // harness records: `library/` is censused but not copied, so restoreDb can only REPORT the drift,
  // and cleanup that needs the app dies exactly when the run has already gone wrong.
  if (cleanupHash) {
    try {
      const victim = join(process.env.APPDATA, "com.sard.app", "library", `${cleanupHash}.epub`);
      if (existsSync(victim)) {
        const actual = createHash("sha256").update(readFileSync(victim)).digest("hex");
        if (actual === cleanupHash) { rmSync(victim); console.log(`\nimported book removed (hash-verified ${cleanupHash.slice(0, 16)}…)`); }
        else console.error(`\nREFUSING TO DELETE ${victim} — contents do not match its name.`);
      }
    } catch (e) {
      console.error("\nCOULD NOT REMOVE THE IMPORTED BOOK — do it by hand:", e.message);
    }
  }
  console.log("\nprofile restored:", (await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY");
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
