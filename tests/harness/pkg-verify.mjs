// Verify a PACKAGED build end to end: drive the *installed* binary the way the tester will, open a
// PDF, save a diagnostic report, and confirm the stage ledger actually reached the file.
//
// The point is not to test the code — that was done against test-build/Sard.exe. The point is to test
// the ARTIFACT: that the exe the NSIS installer put on disk is instrumented, that Ctrl+Shift+D
// reaches its handler, and that Documents\Sard Diagnostics receives a readable report. A package can
// be broken in ways the source cannot (wrong exe bundled, assets missing from the installer).
//
// It drives the REAL profile, so the database is snapshotted before launch and restored on every
// exit path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSard, forceKillAll } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const EXE = join(process.env.LOCALAPPDATA ?? "", "Sard", "Sard.exe");
const REPORTS = join(process.env.USERPROFILE ?? "", "Documents", "Sard Diagnostics");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newestReport = () => {
  if (!existsSync(REPORTS)) return null;
  const f = readdirSync(REPORTS)
    .filter((n) => n.startsWith("sard-diag-") && n.endsWith(".txt"))
    .map((n) => ({ n, t: statSync(join(REPORTS, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return f ? { path: join(REPORTS, f.n), mtime: f.t } : null;
};

const before = newestReport();
const snap = snapshotDb(REPO, "pkg-verify");
if (!snap) {
  console.error("FATAL: could not snapshot the profile — refusing to run. NOTHING was verified.");
  process.exit(1);
}

let out = 1;
let s;
try {
  s = await launchSard({ exe: EXE, port: 9333, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  console.log(`launched  ${EXE}`);

  await sleep(6000);

  // Import the corpus PDF rather than depend on whatever is in the owner's library. Sard rewrites
  // file_path on import, so the book is identified by the id the import result gives back.
  const cardsBefore = await s.evaluate(
    `[...document.querySelectorAll('.lib-card')].map(c => c.getAttribute('title') || '')`,
  );
  const CORPUS = process.env.SARD_CORPUS ?? "M:/ProjectDocs/sard/Corpus";
  const pdfPath = join(CORPUS, "pdf-arabic--muqaddima.pdf");
  if (!existsSync(pdfPath)) throw new Error(`no corpus PDF at ${pdfPath}`);
  const res = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(pdfPath)}] }).catch(e => ({ __err: String(e) }))`,
  );
  const id = res?.imported?.[0]?.id ?? res?.books?.[0]?.id ?? res?.[0]?.id;
  console.log(`imported  ${pdfPath} -> id ${id ?? JSON.stringify(res).slice(0, 200)}`);
  if (id == null) throw new Error("import did not return a book id");

  // The library list does not refresh for an import made through the IPC directly (it is the UI's
  // own import flow that reloads it), so reload the view before looking for the new card. The reload
  // also restarts the diagnostic session, which is fine — recording begins at launch either way.
  await s.evaluate(`(() => { location.reload(); return true; })()`).catch(() => {});
  await sleep(9000);

  // The card carries only a display title, and importing an already-present book returns its existing
  // id, so ask the library for the row and match the card to that title. Never guess the title.
  await sleep(3000);
  const rows = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books', { sort: 'added', order: 'desc', format: 'pdf' }).catch(e => ({ __err: String(e) }))`,
  );
  const row = Array.isArray(rows) ? rows.find((b) => b.id === id) : null;
  console.log(`library   ${cardsBefore.length} cards; ${Array.isArray(rows) ? rows.length : "?"} PDFs; target title: ${row?.title ?? "NOT FOUND"}`);
  if (!row) throw new Error(`the PDF is not in the library list: ${JSON.stringify(rows).slice(0, 200)}`);
  const target = row.title;
  const hit = await s.evaluate(
    `(() => { const t = ${JSON.stringify(target)};
       const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t);
       if (!c) return false; c.click(); return true; })()`,
  );
  if (!hit) throw new Error("the new library card did not click");
  console.log("clicked   the PDF — waiting 35 s for the chain probe (fires at 15 s)");
  await sleep(35_000);

  // Open the SAME PDF a second time. The tester is asked to try twice, and the report's whole
  // attempt-comparison section depends on the first attempt surviving the second one.
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return true; })()`).catch(() => {});
  await sleep(3000);
  await s.evaluate(
    `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === ${JSON.stringify(target)});
       if (c) c.click(); return !!c; })()`,
  );
  console.log("opened    the SAME PDF a second time — waiting 20 s");
  await sleep(20_000);

  // Then an EPUB, in the SAME session: one report has to carry the PDF ledger, the EPUB rendering
  // ledger and the black-page autopsy together, because the tester presses the keys only once.
  const back = await s.evaluate(
    `(() => { const b = document.querySelector('.rc-back'); if (!b) return false; b.click(); return true; })()`,
  );
  console.log(`back      to the library via ${back ? ".rc-back" : "NO BACK BUTTON FOUND"}`);
  await sleep(3000);
  const epub = await s.evaluate(
    `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') !== ${JSON.stringify(target)});
       if (!c) return null; c.click(); return c.getAttribute('title') || '(untitled)'; })()`,
  );
  console.log(`opened    EPUB: ${epub ?? "NONE"}`);
  await sleep(10_000);

  // Export via the ON-SCREEN BUTTON, the path a tester is told to use.
  //
  // This deliberately no longer dispatches a synthetic KeyboardEvent at `window`. That is what this
  // check used to do, and it is why a build shipped in which the shortcut was dead the moment a book
  // was open: a synthetic event aimed at `window` bypasses focus routing and cannot reproduce the
  // failure a real keypress hits. Clicking the button exercises what the tester actually does.
  // Do NOT await — the handler ends in window.alert(), which blocks the renderer.
  const clicked = await s.evaluate(
    `(() => { const b = document.getElementById('sard-diag-export'); if (!b) return false; b.click(); return true; })()`,
  ).catch(() => false);
  if (!clicked) throw new Error("the on-screen export button is MISSING from the packaged build");
  console.log("clicked   the on-screen export button — waiting for the file");

  for (let i = 0; i < 20; i++) {
    const now = newestReport();
    if (now && (!before || now.mtime > before.mtime)) break;
    await sleep(1000);
  }
  const rep = newestReport();
  if (!rep || (before && rep.mtime <= before.mtime)) throw new Error("no NEW report was written");

  const txt = readFileSync(rep.path, "utf8");
  // The ledger prints "Stage N — name" with its verdict on the following line.
  const lines = txt.split("\n");
  const stageLines = lines.flatMap((l, i) =>
    // Single-digit stages are column-padded ("Stage  1 —"), so the space must be permissive; a
    // matcher that quietly skips half the ledger reports a healthy package as an empty one.
    /^Stage +\d+ —/.test(l) ? [`${l.trim()}  ::  ${(lines[i + 1] ?? "").trim()}`] : [],
  );
  console.log(`\nreport    ${rep.path}  (${txt.length.toLocaleString("en-US")} chars)`);
  console.log(`ledger    ${stageLines.length} stage lines:`);
  for (const l of stageLines) console.log(`   ${l.trim()}`);

  const probe = txt.includes("LINK 1") || txt.includes("CHAIN PROBE");
  console.log(`\nchain probe present: ${probe ? "YES" : "NO"}`);
  if (stageLines.length === 0) throw new Error("the report has NO stage ledger — the packaged exe is not the diagnostic build");

  // All three investigations must be in the ONE report the tester sends back.
  const renderIdx = txt.indexOf("EPUB RENDERING PIPELINE — STAGE LEDGER");
  const blackIdx = txt.indexOf("BLACK / BLANK PAGE — FORENSIC AUTOPSY");
  if (renderIdx < 0) throw new Error("the report has NO EPUB rendering ledger");
  if (blackIdx < 0) throw new Error("the report has NO black-page autopsy");
  const rSummary = lines.slice(lines.findIndex((l) => l.includes("EPUB RENDERING PIPELINE")))
    .filter((l) => /furthest stage completed|first stage that failed|stopped inside/.test(l)).slice(0, 3);
  console.log("\nEPUB rendering ledger:");
  for (const l of rSummary) console.log(`   ${l.trim()}`);
  // The attempt comparison must be present, and the recording must cover the WHOLE session — a
  // report that silently begins mid-session would misrepresent everything before it.
  const cmp = txt.includes("PDF ATTEMPT COMPARISON");
  const window = lines.slice(lines.findIndex((l) => l.includes("RECORDING WINDOW")))
    .filter((l) => /started \(app launch\)|exported|duration|events recorded|completeness/.test(l)).slice(0, 5);
  console.log(`\nattempt comparison present: ${cmp ? "YES" : "NO"}`);
  console.log("recording window:");
  for (const l of window) console.log(`   ${l.trim()}`);
  if (!cmp) throw new Error("the report has NO PDF attempt comparison");
  if (!window.some((l) => /COMPLETE —/.test(l))) throw new Error("the recording is not marked COMPLETE from launch to export");

  const verdict = lines[lines.findIndex((l) => l.includes("WHY THE PAGE LOOKS THE WAY IT DOES")) + 1] ?? "";
  console.log(`\nblack-page verdict:\n   ${verdict.trim().slice(0, 200)}`);
  if (!verdict.trim()) throw new Error("the autopsy produced no verdict line");
  out = 0;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try {
    execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await sleep(1500);
  const ok = await restoreDb(snap);
  console.log(`profile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
