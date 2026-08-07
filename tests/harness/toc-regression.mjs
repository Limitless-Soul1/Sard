// WP-6B REGRESSION — every EPUB in the library, checked against what its FILE declares.
//
// The comparison is deliberately not "before vs after". A previous build is a moving reference and
// proves only that nothing changed; it cannot prove the result was ever right. Instead each book's
// displayed contents are compared with the navigation the file itself contains, read independently
// from the zip:
//
//   nav document with >=2 entries   -> those entries must be displayed, and nothing generated
//   otherwise NCX with >=2 entries  -> those entries must be displayed, and nothing generated
//   otherwise                       -> generated contents, and the panel must say so
//
// A book that fails this is either a regression or a defect that predates WP-6B; either way it is
// reported with both numbers so the difference is visible rather than inferred.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";
import { inspectEpub } from "./epub-nav.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
const books = db.prepare("SELECT title, file_path, format, toc_degenerate FROM books ORDER BY title").all()
  .filter((b) => (b.format ?? "").toLowerCase() === "epub" && existsSync(b.file_path));

// What the FILE says the contents should be.
const expected = new Map();
for (const b of books) {
  try {
    const r = inspectEpub(b.file_path);
    const nav = r.navDoc.tocLinks ?? 0, ncx = r.ncx.navPoints ?? 0;
    expected.set(b.title, nav >= 2 ? { source: "nav", n: nav } : ncx >= 2 ? { source: "ncx", n: ncx } : { source: "generated", n: null });
  } catch {
    expected.set(b.title, { source: "unreadable", n: null });
  }
}

const snap = snapshotDb(REPO, "toc-regression");
if (!snap) { console.error("FATAL: could not snapshot the profile. NOTHING was verified."); process.exit(1); }

let out = 1;
let s;
const rows = [];
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9359, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);

  for (const b of books) {
    const exp = expected.get(b.title);
    if (exp.source === "unreadable") { rows.push({ title: b.title, verdict: "SKIP (file unreadable)" }); continue; }
    const opened = await s.evaluate(
      `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === ${JSON.stringify(b.title)});
         if (!c) return false; c.click(); return true; })()`,
    );
    if (!opened) { rows.push({ title: b.title, verdict: "SKIP (no card)" }); continue; }

    // Wait for the contents to SETTLE — a list that is still being replaced is not an answer.
    let last = -1, stable = 0, note = false;
    for (let i = 0; i < 20 && stable < 3; i++) {
      await sleep(700);
      const st = await s.evaluate(
        `(() => ({ n: document.querySelectorAll('.toc-row').length, note: !!document.querySelector('.rp-synth-note') }))()`,
      );
      if (st.n === last) stable++; else { last = st.n; stable = 0; }
      note = st.note;
    }
    const got = { n: last, generated: note };
    const ok =
      exp.source === "generated" ? got.generated === true && got.n > 0
      : got.generated === false && got.n === exp.n;
    rows.push({
      title: b.title, flagged: b.toc_degenerate === 1, expSource: exp.source, expN: exp.n,
      gotN: got.n, gotGenerated: got.generated, ok,
    });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${String(b.title).slice(0, 34).padEnd(34)} ` +
        `file: ${exp.source}${exp.n != null ? `(${exp.n})` : ""}`.padEnd(16) +
        ` shown: ${got.n}${got.generated ? " GENERATED" : ""}`,
    );
    await s.evaluate(`(() => { const x = document.querySelector('.rc-back'); if (x) x.click(); return true; })()`).catch(() => {});
    await sleep(1500);
  }

  const checked = rows.filter((r) => r.ok !== undefined);
  const bad = checked.filter((r) => !r.ok);
  console.log(`\n${checked.length - bad.length}/${checked.length} books match what their file declares`);
  for (const r of bad) console.log(`   FAIL ${r.title}: file ${r.expSource}(${r.expN}) vs shown ${r.gotN}${r.gotGenerated ? " generated" : ""}`);
  out = bad.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  const ok = await restoreDb(snap);
  console.log(`profile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
