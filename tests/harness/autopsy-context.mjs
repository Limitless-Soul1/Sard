// STATES 2 AND 3 — the half that needs a book in the diagnostic build's own library.
//
// The book was imported by the previous run (the diag profile is separate: com.sard.diag), so this
// launches fresh, opens it, and checks the two remaining required answers:
//
//   2. a book open                    -> a REAL verdict about the section on screen
//   3. library, AFTER closing a book  -> NOT APPLICABLE, NOT a verdict about the closed book
//
// State 3 is the one that matters. `surface` and `lastDoc` are deliberately never cleared — a tester
// who exports after a failure may have nothing else left — so after closing a book the previous
// section is STILL REACHABLE. It used to be adopted as the displayed document and judged with
// confidence MEASURED. It must now be found, marked DETACHED, and refused as evidence.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };
const REPORTS = join(process.env.USERPROFILE, "Documents", "Sard Diagnostics");
const newestReport = () => {
  if (!existsSync(REPORTS)) return null;
  const f = readdirSync(REPORTS).filter((x) => x.startsWith("sard-diag-") && x.endsWith(".txt"))
    .map((x) => ({ x, t: statSync(join(REPORTS, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return f ? join(REPORTS, f.x) : null;
};

let s;
try {
  s = await launchSard({ exe: "src-tauri/target/release/sard-diag.exe", port: 9475, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  await sleep(3000);
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  const cards = await s.evaluate(`document.querySelectorAll('.lib-card').length`);
  ok("the diagnostic build's library has the imported book", cards > 0, `${cards} card(s)`);

  const exportReport = async (label) => {
    const before = newestReport();
    const r = await s.evaluate(`(async () => { try { return String(await window.__sardDiag.save()); }
      catch (e) { return 'THREW: ' + e.message; } })()`);
    for (let i = 0; i < 40; i++) {
      const f = newestReport();
      if (f && f !== before) return readFileSync(f, "utf8");
      await sleep(250);
    }
    throw new Error(`${label}: no new report appeared (save returned ${r})`);
  };
  const autopsyOf = (t) => {
    const i = t.indexOf("BLACK / BLANK PAGE");
    if (i < 0) return "(no autopsy section)";
    const j = t.indexOf("RESOURCES THAT FAILED", i);
    return t.slice(i, j > 0 ? j : i + 2200);
  };
  const show = (a) => console.log("   | " + a.split("\n").map((l) => l.trim()).filter(Boolean).slice(3, 13).join("\n   | "));

  // ── 2 ────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n2. A BOOK OPEN — a real verdict is required");
  await s.evaluate(`(() => { const c = document.querySelector('.lib-card'); if (c) c.click(); return !!c; })()`);
  let opened = false;
  for (let i = 0; i < 120; i++) {
    if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) { opened = true; break; }
    await sleep(300);
  }
  ok("the book opened", opened);
  if (!opened) throw new Error("cannot test states 2 and 3 without an open book");
  await sleep(4500);
  const a2 = autopsyOf(await exportReport("state 2"));
  show(a2);
  ok("does NOT say NOT APPLICABLE while a book is on screen", !/NOT APPLICABLE/.test(a2));
  // "NO SECTION DOCUMENT" is DELIBERATELY NOT accepted here. The first version of this assertion
  // listed it as a valid verdict, and so it passed while the report claimed "NO SECTION DOCUMENT IS
  // ON SCREEN" for a book that was visibly rendering — a false negative in the attachment test,
  // waved through by a test that accepted too much. A book that renders must produce a verdict ABOUT
  // ITS TEXT.
  ok("issues a verdict about the text that is actually rendering",
     /TEXT IS PRESENT|BLACK ON BLACK|TEXT IS HIDDEN|TEXT LAYS OUT|THE TEXT IS COVERED|HAS NO <body>|DOCUMENT IS EMPTY/.test(a2),
     (a2.match(/\[MEASURED\][^\n]{0,90}/) ?? ["(no verdict line)"])[0]);
  ok("does NOT claim the section is off screen while it is rendering",
     !/NO SECTION DOCUMENT IS ON SCREEN|all \d+ document\(s\) found are detached/.test(a2));
  ok("names a live displayed document", /describes the DISPLAYED document: #\d+/.test(a2));
  ok("measures the reading surface", /host size/.test(a2));
  const docs2 = Number((a2.match(/SECTION DOCUMENTS FOUND: (\d+)/) ?? [])[1] ?? 0);
  ok("at least one section document was found", docs2 > 0, `${docs2}`);

  // ── 3 — THE DECISIVE ONE ─────────────────────────────────────────────────────────────────────
  console.log("\n3. LIBRARY AFTER CLOSING — the stale document must be found but NOT judged");
  await s.evaluate(`(() => { const b = [...document.querySelectorAll('button, .rc-btn, [role=button]')]
    .find(x => /back|library|المكتبة|رجوع/i.test((x.getAttribute('title')||'') + ' ' + (x.textContent||'')));
    if (b) { b.click(); return 1; } window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 0; })()`);
  let left = false;
  for (let i = 0; i < 60; i++) {
    if (await s.evaluate(`!document.querySelector('.page-host foliate-view')`)) { left = true; break; }
    await sleep(250);
  }
  ok("returned to the library", left);
  await sleep(2500);
  const a3 = autopsyOf(await exportReport("state 3"));
  show(a3);
  ok("says NOT APPLICABLE rather than judging the closed book", /NOT APPLICABLE/.test(a3));
  ok("no confident verdict about the previous book",
     !/\[MEASURED\][^\n]*(BLACK ON BLACK|TEXT IS PRESENT|TEXT IS HIDDEN|TEXT LAYS OUT)/.test(a3));
  const docs3 = Number((a3.match(/SECTION DOCUMENTS FOUND: (\d+)/) ?? [])[1] ?? 0);
  console.log(`   (documents still reachable after closing: ${docs3})`);
  if (docs3 > 0) {
    ok("a still-reachable document is labelled DETACHED, not treated as displayed",
       /DETACHED, no longer on screen/.test(a3) || /all \d+ document\(s\) found are detached/.test(a3),
       "this is the exact stale-document path the fix targets");
  } else {
    console.log("   NOTE: nothing was left reachable, so the DETACHED labelling was not exercised here.");
  }
} catch (e) {
  console.error("\nHARNESS FAILED:", e.message);
  fail.push("harness: " + e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "sard-diag.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1200);
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
