// Prove the BLACK / BLANK PAGE autopsy actually diagnoses — not merely that it runs.
//
// A diagnostic that prints a confident paragraph is worthless unless each of its conclusions has
// been seen to fire for the right reason and NOT to fire for the wrong one. So this harness opens a
// real book in the real binary and then induces each failure mode in the live section document,
// exporting a report each time and checking which verdict the autopsy reached:
//
//   CONTROL        an untouched book              -> "TEXT IS PRESENT AND MEASURED AS VISIBLE"
//   BLACK ON BLACK ink forced to the page colour  -> "BLACK ON BLACK" + a measured contrast near 1
//   HIDDEN         visibility: hidden             -> "HIDDEN BY A COMPUTED STYLE — visibility: hidden"
//   COVERED        an opaque box over the text    -> "THE TEXT IS COVERED"
//   EMPTY          the body emptied               -> "THE DOCUMENT IS EMPTY"
//
// The control matters as much as the failures: if the autopsy shouted BLACK ON BLACK at a healthy
// page, every report from every tester would be worthless.
//
// Drives the REAL profile, so the database is snapshotted before launch and restored on every path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const REPORTS = join(process.env.USERPROFILE ?? "", "Documents", "Sard Diagnostics");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newest = () => {
  if (!existsSync(REPORTS)) return null;
  const f = readdirSync(REPORTS)
    .filter((n) => n.startsWith("sard-diag-") && n.endsWith(".txt"))
    .map((n) => ({ n, t: statSync(join(REPORTS, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return f ? { path: join(REPORTS, f.n), mtime: f.t } : null;
};

// Reach the section document from the page. foliate keeps it on the renderer's contents; the iframe
// is the fallback. Returns a live Document or null — never throws into the page.
const DOC = `(() => {
  const v = document.querySelector('foliate-view');
  const d = v?.renderer?.getContents?.()?.[0]?.doc;
  if (d) return d;
  const f = document.querySelector('.page-host iframe') || document.querySelector('iframe');
  return f?.contentDocument ?? null;
})()`;

/** Ctrl+Shift+D, then wait for a new report file and return its text. */
async function exportReport(s, prev) {
  await s.evaluate(
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown',
       { key: 'D', ctrlKey: true, shiftKey: true, bubbles: true })); return true; })()`,
  ).catch(() => {});
  for (let i = 0; i < 25; i++) {
    const n = newest();
    if (n && (!prev || n.mtime > prev.mtime)) {
      await sleep(400); // let the write finish
      return { text: readFileSync(n.path, "utf8"), stamp: n };
    }
    await sleep(1000);
  }
  throw new Error("no new report was written");
}

const verdictOf = (txt) => {
  const i = txt.indexOf("WHY THE PAGE LOOKS THE WAY IT DOES");
  if (i < 0) return "(no autopsy section in the report)";
  return txt.slice(i).split(/\r?\n/)[1]?.trim() ?? "(empty verdict)";
};

const snap = snapshotDb(REPO, "black-screen");
if (!snap) {
  console.error("FATAL: could not snapshot the profile — refusing to run. NOTHING was verified.");
  process.exit(1);
}

const results = [];
let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9337, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);

  // Open the first EPUB in the library. Any book will do — the autopsy measures the document, not
  // the title — so this deliberately does not depend on the corpus being present.
  const opened = await s.evaluate(
    `(() => { const c = [...document.querySelectorAll('.lib-card')][0]; if (!c) return null;
       c.click(); return c.getAttribute('title') || '(untitled)'; })()`,
  );
  if (!opened) throw new Error("the library has no books to open");
  console.log(`opened    ${opened}`);
  await sleep(9000);

  const ready = await s.evaluate(`(() => { const d = ${DOC}; return d ? (d.body?.textContent||'').trim().length : -1; })()`);
  console.log(`section   ${ready} characters of text in the document`);
  if (ready <= 0) throw new Error(`no section text to work with (got ${ready}) — cannot test the autopsy`);

  const cases = [
    ["CONTROL", `(() => true)()`, /MEASURED AS VISIBLE/],
    [
      // Inline + !important, because a STYLESHEET is not enough: Sard's own forced-ink rules have
      // higher specificity than `body *` and simply win. The first version of this probe injected a
      // sheet, the ink never changed, and the autopsy correctly reported the text as visible — the
      // test was wrong, not the tool. Inline !important is the one thing no author rule can outrank.
      "BLACK ON BLACK",
      `(() => { const d = ${DOC};
         d.documentElement.style.setProperty('background-color','rgb(0,0,0)','important');
         d.body.style.setProperty('background-color','rgb(0,0,0)','important');
         for (const e of d.body.querySelectorAll('*')) {
           e.style.setProperty('color','rgb(0,0,0)','important');
           e.style.setProperty('background-color','rgb(0,0,0)','important');
         }
         const p = d.body.querySelector('p') || d.body.firstElementChild;
         const cs = d.defaultView.getComputedStyle(p);
         return { color: cs.color, bg: cs.backgroundColor }; })()`,
      /BLACK ON BLACK/,
      // The damage must be PROVEN to have landed before the verdict means anything.
      (r) => r && r.color === "rgb(0, 0, 0)" && r.bg === "rgb(0, 0, 0)",
    ],
    [
      "HIDDEN",
      `(() => { const d = ${DOC}; const st = d.createElement('style'); st.id='__probe';
         st.textContent = 'body * { visibility: hidden !important; }';
         d.head.append(st); return true; })()`,
      /HIDDEN BY A COMPUTED STYLE/,
    ],
    [
      "COVERED",
      `(() => { const d = ${DOC}; const o = d.createElement('div'); o.id='__probe';
         o.setAttribute('style','position:fixed;inset:0;background:#000;z-index:2147483647');
         d.body.append(o); return true; })()`,
      /COVERED/,
    ],
    [
      "EMPTY",
      `(() => { const d = ${DOC}; d.body.innerHTML=''; return true; })()`,
      /DOCUMENT IS EMPTY/,
    ],
  ];

  let prev = newest();
  for (const [name, damage, expect, landed] of cases) {
    // Undo EVERYTHING the previous case did. Removing only the probe element was not enough: the
    // inline styles left by BLACK ON BLACK survived into the next case, and the autopsy — correctly,
    // since its verdicts are ordered by which failure comes first — kept naming the older condition.
    // Each case must start from a clean document or the test is measuring its own residue.
    await s.evaluate(
      `(() => { const d = ${DOC}; if (!d) return false;
         d.getElementById?.('__probe')?.remove();
         d.documentElement.style.removeProperty('background-color');
         d.body?.style.removeProperty('background-color');
         for (const e of d.body?.querySelectorAll('*') ?? []) {
           e.style.removeProperty('color'); e.style.removeProperty('background-color');
         }
         return true; })()`,
    ).catch(() => {});
    const applied = await s.evaluate(damage);
    if (landed && !landed(applied)) {
      results.push({ name, pass: false, verdict: `THE PROBE ITSELF DID NOT LAND — measured ${JSON.stringify(applied)}. No claim is made about the autopsy.` });
      console.log(`\nFAIL  ${name}\n      probe did not land: ${JSON.stringify(applied)}`);
      continue;
    }
    await sleep(1200);
    const { text, stamp } = await exportReport(s, prev);
    prev = stamp;
    const v = verdictOf(text);
    const pass = expect.test(v);
    results.push({ name, pass, verdict: v });
    console.log(`\n${pass ? "PASS" : "FAIL"}  ${name}`);
    console.log(`      ${v.slice(0, 240)}`);
    // Every export restarts nothing — recording continues — so the next case builds on this document.
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} verdicts correct`);
  out = bad.length === 0 ? 0 : 1;
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
