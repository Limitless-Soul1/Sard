// THE RENDERING LEDGER MUST DESCRIBE ONE BOOK — the falsification test for two Priority-2 defects.
//
// `renderDiagReset()` existed but was called from nowhere, so one ledger described a whole session:
//
//   STALE REASONS         opening a PDF marks stages 2-14 NOT OBSERVABLE with "this book is a PDF".
//                         Open an EPUB next and `meta.reason` is never cleared — only assigned into
//                         — so the report tells the next investigator "this book is a PDF" about an
//                         EPUB, and any stage the EPUB did not re-enter stays NOT OBSERVABLE for it.
//   SESSION-SPAN TIMINGS  the ledger's `t0` was set when the module loaded, so every stage timestamp
//                         read "milliseconds since the app started". A tester who opens the failing
//                         book ten minutes in produced a ledger where every stage read ~600000 ms.
//
// Both are the same root cause, so both are measured here against the SAME reset.
//
// The order matters: PDF FIRST, then EPUB. That is the sequence a tester performs when reproducing
// the two reported symptoms in one session, and it is the sequence that produced the stale reason.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };
const REPORTS = join(process.env.USERPROFILE, "Documents", "Sard Diagnostics");
const PDF = process.argv.find((a) => a.startsWith("--pdf="))?.slice(6) ?? "M:/روايات/697.pdf";

const newestReport = () => {
  if (!existsSync(REPORTS)) return null;
  const f = readdirSync(REPORTS).filter((x) => x.startsWith("sard-diag-") && x.endsWith(".txt"))
    .map((x) => ({ x, t: statSync(join(REPORTS, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return f ? join(REPORTS, f.x) : null;
};

let s;
try {
  s = await launchSard({ exe: "src-tauri/target/release/sard-diag.exe", port: 9476, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  await sleep(2500);

  const exportReport = async (label) => {
    const before = newestReport();
    await s.evaluate(`(async () => { try { return String(await window.__sardDiag.save()); } catch (e) { return 'THREW: ' + e.message; } })()`);
    for (let i = 0; i < 40; i++) {
      const f = newestReport();
      if (f && f !== before) return readFileSync(f, "utf8");
      await sleep(250);
    }
    throw new Error(`${label}: no new report appeared`);
  };
  const epubLedger = (t) => {
    const i = t.indexOf("EPUB RENDERING PIPELINE");
    if (i < 0) return "(no EPUB ledger in the report)";
    const j = t.indexOf("BLACK / BLANK PAGE", i);
    return t.slice(i, j > 0 ? j : i + 3000);
  };
  // Every "at <n>ms" the ledger prints for a stage. These are what a session-span t0 inflates.
  const stageTimes = (led) => [...led.matchAll(/(\d+)\s*ms/g)].map((m) => Number(m[1]));

  const importAndOpen = async (path, what) => {
    const r = await s.evaluate(`(async () => { try {
        return JSON.stringify(await window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(path)}] })).slice(0, 160);
      } catch (e) { return 'THREW: ' + e.message; } })()`);
    console.log(`   import ${what}: ${r}`);
    // A restart is how the library re-reads itself; the diag build's own profile makes this safe.
    return r;
  };

  // ---- get both books into the diagnostic build's OWN library ---------------------------------
  await importAndOpen(PDF, "the PDF");
  await s.evaluate(`(async () => { try { await window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(join(process.env.APPDATA, "com.sard.app", "sample.epub"))}] }); } catch {} })()`);
  await sleep(2000);
  try { await s.close(); } catch { /* already gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "sard-diag.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(2500);
  s = await launchSard({ exe: "src-tauri/target/release/sard-diag.exe", port: 9477, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 1`)) break; await sleep(400); }
  const titles = JSON.parse(await s.evaluate(`JSON.stringify([...document.querySelectorAll('.lib-card')].map(c => (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)))`));
  console.log("   library:", JSON.stringify(titles));
  ok("both a PDF and an EPUB are in the diagnostic library", titles.length >= 2, `${titles.length} card(s)`);

  const openNth = async (n) => {
    await s.evaluate(`(() => { const c = document.querySelectorAll('.lib-card')[${n}]; if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 100; i++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) { await sleep(3000); return true; }
      await sleep(300);
    }
    return false;
  };
  const back = async () => {
    await s.evaluate(`(() => { const b = [...document.querySelectorAll('button, .rc-btn, [role=button]')]
      .find(x => /back|library|المكتبة|رجوع/i.test((x.getAttribute('title')||'') + ' ' + (x.textContent||'')));
      if (b) { b.click(); return 1; } window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 0; })()`);
    for (let i = 0; i < 60; i++) { if (await s.evaluate(`!document.querySelector('.page-host foliate-view')`)) { await sleep(1200); return true; } await sleep(250); }
    return false;
  };
  const pdfIdx = titles.findIndex((t) => /697|pdf/i.test(t));
  const epubIdx = titles.findIndex((_, i) => i !== pdfIdx);

  // ---- 1. THE PDF FIRST — this is what plants the stale reason --------------------------------
  console.log("\n1. Open the PDF (the EPUB ledger is legitimately marked NOT OBSERVABLE)");
  ok("the PDF opened", await openNth(pdfIdx >= 0 ? pdfIdx : 0));
  const ledPdf = epubLedger(await exportReport("pdf"));
  ok("while a PDF is open, the EPUB ledger says so", /this book is a PDF/.test(ledPdf),
     "this reason is CORRECT here — the defect is that it used to survive the next book");
  await back();

  // ---- 2. NOW AN EPUB — the reason must be gone ------------------------------------------------
  console.log("\n2. Now open the EPUB — the PDF reason must NOT survive");
  const sessionAgeBefore = Number(await s.evaluate(`Math.round(performance.now())`));
  ok("the EPUB opened", await openNth(epubIdx >= 0 ? epubIdx : 1));
  const rep2 = await exportReport("epub");
  const led2 = epubLedger(rep2);
  console.log("   " + led2.split("\n").filter(Boolean).slice(0, 8).map((l) => l.trimEnd()).join("\n   "));
  ok("the stale \"this book is a PDF\" reason is GONE", !/this book is a PDF/.test(led2),
     "the ledger now describes the EPUB that is actually open");

  // ---- 3. TIMINGS must be book-relative, not session-relative ----------------------------------
  console.log("\n3. Stage timings must measure THIS open, not the whole session");
  const times = stageTimes(led2);
  const worst = times.length ? Math.max(...times) : -1;
  console.log(`   session age at open: ${sessionAgeBefore} ms · largest stage time in the ledger: ${worst} ms`);
  ok("stage times are far below the session age (they measure the open, not the app's life)",
     worst >= 0 && worst < sessionAgeBefore / 2,
     `${worst} ms vs a ${sessionAgeBefore} ms session`);
  ok("stage times are plausible for opening one book (< 60 s)", worst >= 0 && worst < 60_000, `${worst} ms`);
} catch (e) {
  console.error("\nHARNESS FAILED:", e.message);
  fail.push("harness: " + e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "sard-diag.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1200);
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
