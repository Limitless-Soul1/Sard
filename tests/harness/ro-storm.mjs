// THE RESIZEOBSERVER STORM — measured on the real binary, before and after the repair.
//
// Blink emits "ResizeObserver loop completed with undelivered notifications" ONCE PER FRAME while an
// observer still watches a node that has been detached from the document. It does NOT invoke the JS
// callback, which is why the storm is invisible to the app and shows up only as an error rate.
//
// The two defects (both confirmed in the vendored source):
//   paginator.js:572   #observer.observe(this.#container)    <- what is actually observed
//   paginator.js:1163  #observer.unobserve(this)             <- `this` was NEVER observed: a NO-OP
//   paginator.js:427   destroy() { if (this.document) ... }  <- guarded; measured at 0 calls
//
// So every book that is opened and left adds one permanently-observed detached node. The rate should
// therefore CLIMB with each open/close cycle — and that climb, not the absolute number, is the
// signature. A fix that removes the storm must show the rate flat at zero across the same cycles.
import { execFileSync } from "node:child_process";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "run";
const CYCLES = Number(process.argv.find((a) => a.startsWith("--cycles="))?.slice(9) ?? 5);

const snap = snapshotDb("M:\\eRawy", `ro-${LABEL}`);
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9470, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 120; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // The counter. Registered on `window` in the CAPTURE phase so nothing can swallow it first.
  await s.evaluate(`(() => {
    if (window.__ro) return true;
    window.__ro = { n: 0, total: 0, other: 0, since: performance.now() };
    window.addEventListener('error', (e) => {
      const m = String(e.message || '');
      if (m.includes('ResizeObserver loop')) { window.__ro.n++; window.__ro.total++; }
      else window.__ro.other++;
    }, true);
    return true;
  })()`);
  const reset = () => s.evaluate(`(() => { window.__ro.n = 0; window.__ro.other = 0; window.__ro.since = performance.now(); return true; })()`);
  const rate = async (ms) => {
    await reset();
    await sleep(ms);
    const r = JSON.parse(await s.evaluate(`(() => { const e = performance.now() - window.__ro.since;
      return JSON.stringify({ n: window.__ro.n, other: window.__ro.other, perSec: +(window.__ro.n / (e / 1000)).toFixed(1) }); })()`));
    return r;
  };

  const openBook = async () => {
    await s.evaluate(`(() => { const c = document.querySelector('.lib-card'); if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) return true;
      await sleep(250);
    }
    return false;
  };
  const backToLibrary = async () => {
    await s.evaluate(`(() => {
      const b = [...document.querySelectorAll('button, .rc-btn, [role=button]')]
        .find(x => /back|library|المكتبة|رجوع/i.test((x.getAttribute('title')||'') + ' ' + (x.textContent||'')));
      if (b) { b.click(); return 'clicked'; }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'escape';
    })()`);
    for (let i = 0; i < 60; i++) {
      if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0 && !document.querySelector('.page-host foliate-view')`)) return true;
      await sleep(250);
    }
    return false;
  };

  console.log(`\n=== ${LABEL.toUpperCase()} — ResizeObserver error rate ===\n`);
  const idle0 = await rate(3000);
  console.log(`  library, nothing opened yet : ${idle0.perSec}/s  (${idle0.n} in 3 s)`);

  for (let c = 1; c <= CYCLES; c++) {
    const opened = await openBook();
    if (!opened) { console.log(`  cycle ${c}: the book never opened — aborting`); break; }
    await sleep(1500);
    const inBook = await rate(3000);
    const left = await backToLibrary();
    await sleep(1500);
    const after = await rate(3000);
    console.log(
      `  cycle ${c}: reading ${String(inBook.perSec).padStart(6)}/s` +
      `   back in library ${String(after.perSec).padStart(6)}/s` +
      `${left ? "" : "   (could not return to the library)"}`,
    );
    if (!left) break;
  }

  const final = await rate(4000);
  console.log(`\n  FINAL, idle in the library : ${final.perSec}/s  (${final.n} in 4 s)`);
  const tot = await s.evaluate(`window.__ro.total`);
  console.log(`  SESSION TOTAL RO errors    : ${tot}`);
  console.log(`  other uncaught errors      : ${final.other}`);
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  console.log("\nprofile restored:", (await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY");
}
