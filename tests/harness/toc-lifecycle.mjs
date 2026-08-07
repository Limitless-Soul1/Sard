// WHEN does the contents list change, and from what to what?
//
// Reported: a book opens showing ONE contents entry, and after some reading the list suddenly holds
// hundreds or thousands. This samples the row count every second from the moment the book opens, so
// the transition is timed rather than described.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (process.argv.find((a) => a.startsWith("--title=")) ?? "--title=Infinite").slice(8);

const snap = snapshotDb(REPO, "toc-lifecycle");
if (!snap) { console.error("FATAL: could not snapshot the profile. NOTHING was verified."); process.exit(1); }

let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9351, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);
  const books = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_list_books', { sort: 'added', order: 'desc' }).catch(e => ({ __err: String(e) }))`,
  );
  const b = Array.isArray(books) ? books.find((x) => x.title.includes(want)) : null;
  if (!b) throw new Error(`no book matching ${want}`);
  console.log(`book      ${b.title}  (toc_degenerate=${b.toc_degenerate})`);

  const t0 = Date.now();
  await s.evaluate(
    `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === ${JSON.stringify(b.title)});
       if (c) c.click(); return !!c; })()`,
  );
  // Open the contents panel as soon as the reader exists, then watch.
  for (let i = 0; i < 20; i++) {
    const ok = await s.evaluate(
      `(() => { const x = [...document.querySelectorAll('.rc-btn')].find(y => /contents|فهرس|المحتويات/i.test(y.getAttribute('title')||''));
         if (!x) return false; if (!x.classList.contains('on')) x.click(); return true; })()`,
    );
    if (ok) break;
    await sleep(500);
  }
  console.log(`panel     opened at ${Date.now() - t0} ms\n`);

  let last = -1;
  let stable = 0;
  for (let i = 0; i < 180; i++) {
    // Stop once the list has settled: the question is WHEN it changes, not how long it then sits
    // still. Ending early also keeps the profile-restore path in `finally` reachable, which killing
    // the process from outside would skip.
    if (last > 1 && stable >= 5) { console.log(`  (settled at ${last} rows)`); break; }
    const n = await s.evaluate(
      `(() => { const r = [...document.querySelectorAll('.toc-row')];
         return { n: r.length, first: (r[0]?.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 34),
                  synth: !!document.querySelector('.rp-synth-note') }; })()`,
    );
    if (n.n !== last) {
      console.log(`[${String(Date.now() - t0).padStart(6)} ms]  rows = ${String(n.n).padStart(5)}   synthesised-note: ${n.synth}   first row: "${n.first}"`);
      last = n.n;
      stable = 0;
    } else {
      stable++;
    }
    await sleep(1000);
  }
  out = 0;
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
