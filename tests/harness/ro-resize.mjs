// DID THE REPAIR BREAK RESIZING? — the falsification test for SARD LOCAL PATCH 9.
//
// The two observers exist to re-lay-out the book when its box changes: the Paginator's watches the
// container and calls render(), the View's watches the section body and calls expand(). The patch
// replaced two broken teardown calls with disconnect(). Removing an observer at destroy() should be
// invisible while a book is open — but "should be" is not evidence, and an observer that has been
// disconnected too eagerly produces a book that silently stops reflowing, which is a far worse defect
// than the error rate it was fixing.
//
// Source reading says it is safe: no View is reused after destroy() (`#createView()` constructs a new
// one, and Paginator.destroy() nulls the field). This measures it instead of trusting that.
//
// The decisive case is #4: leave a book, open another, THEN resize. That exercises a view created
// after a destroy() ran — the exact path the patch changed.
import { execFileSync } from "node:child_process";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };

const snap = snapshotDb("M:\\eRawy", "ro-regression");
if (!snap) { console.error("FATAL: could not snapshot"); process.exit(1); }
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9471, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 120; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const openBook = async (nth = 0) => {
    await s.evaluate(`(() => { const c = document.querySelectorAll('.lib-card')[${nth}]; if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) { await sleep(2000); return true; }
      await sleep(250);
    }
    return false;
  };
  const backToLibrary = async () => {
    await s.evaluate(`(() => { const b = [...document.querySelectorAll('button, .rc-btn, [role=button]')]
      .find(x => /back|library|المكتبة|رجوع/i.test((x.getAttribute('title')||'') + ' ' + (x.textContent||'')));
      if (b) { b.click(); return 1; } window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 0; })()`);
    for (let i = 0; i < 60; i++) {
      if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0 && !document.querySelector('.page-host foliate-view')`)) { await sleep(1200); return true; }
      await sleep(250);
    }
    return false;
  };
  // The engine's own layout numbers. `viewSize` is the full laid-out extent — it is what changes when
  // the box changes, and it is computed by the very render()/expand() the observers trigger.
  const layout = () => s.evaluate(`(() => {
    const v = document.querySelector('.page-host foliate-view');
    const r = v?.renderer;
    const d = r?.getContents?.()?.[0]?.doc;
    return JSON.stringify({
      viewSize: r?.viewSize ?? null, size: r?.size ?? null,
      pages: r?.pages ?? null, flow: r?.getAttribute?.('flow') ?? null,
      bodyW: d ? Math.round(d.body.getBoundingClientRect().width) : null,
      innerW: window.innerWidth, innerH: window.innerHeight,
    }); })()`).then(JSON.parse);

  const setViewport = async (w, h) => {
    await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(2200); // the observer fires, then render()/expand() runs
  };
  const clearViewport = () => s.send("Emulation.clearDeviceMetricsOverride", {});

  // ── 1. SCROLLED: does a resize still re-lay-out the book? ────────────────────────────────────
  console.log("\n1. SCROLLED — a viewport resize must still re-lay-out the section");
  if (!(await openBook(0))) throw new Error("the reader never opened");
  const a0 = await layout();
  await setViewport(760, 700);
  const a1 = await layout();
  ok("the engine re-laid-out after shrinking the viewport",
     a1.viewSize !== a0.viewSize || a1.bodyW !== a0.bodyW,
     `viewSize ${a0.viewSize} -> ${a1.viewSize}, bodyW ${a0.bodyW} -> ${a1.bodyW}`);
  await setViewport(1280, 760);
  const a2 = await layout();
  ok("and again after growing it", a2.viewSize !== a1.viewSize || a2.bodyW !== a1.bodyW,
     `viewSize ${a1.viewSize} -> ${a2.viewSize}, bodyW ${a1.bodyW} -> ${a2.bodyW}`);

  // ── 2. PAGED: re-pagination is the most expensive thing the observer drives ──────────────────
  console.log("\n2. PAGED — a resize must still RE-PAGINATE");
  await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => x.querySelector('.ico-cols')); if (b) b.click(); return !!b; })()`);
  await sleep(1400);
  await s.evaluate(`(() => { const seg = document.querySelector('.rs-seg, .seg, [class*="seg"]');
    const o = seg ? [...seg.querySelectorAll('button')] : []; if (o[1]) o[1].click(); return true; })()`);
  await sleep(4000);
  const p0 = await layout();
  ok("switched into paged", p0.flow === "paginated", `flow=${p0.flow}`);
  await setViewport(820, 700);
  const p1 = await layout();
  ok("page count / extent changed on resize", p1.pages !== p0.pages || p1.viewSize !== p0.viewSize,
     `pages ${p0.pages} -> ${p1.pages}, viewSize ${p0.viewSize} -> ${p1.viewSize}`);
  await setViewport(1280, 760);
  const p2 = await layout();
  ok("and back", p2.pages !== p1.pages || p2.viewSize !== p1.viewSize,
     `pages ${p1.pages} -> ${p2.pages}, viewSize ${p1.viewSize} -> ${p2.viewSize}`);

  // ── 3. The VIEW observer's own job: content growth via a style change ────────────────────────
  console.log("\n3. The View observer — a font-size change must still expand the layout");
  await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => x.querySelector('.ico-aa')); if (b) b.click(); return !!b; })()`);
  await sleep(1300);
  const ZI = await s.evaluate(`[...document.querySelectorAll('.rs-slider')].findIndex(x => x.min === '0.8' && x.max === '2.5')`);
  const setZoom = (v) => s.evaluate(`(() => { const el = [...document.querySelectorAll('.rs-slider')][${ZI}];
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, String(${v}));
    el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setZoom(1.0); await sleep(2500);
  const z0 = await layout();
  await setZoom(1.8); await sleep(3000);
  const z1 = await layout();
  ok("a larger font produced a larger laid-out extent", z1.viewSize > z0.viewSize,
     `viewSize ${z0.viewSize} -> ${z1.viewSize}`);
  await setZoom(1.2); await sleep(2500);

  // ── 4. THE DECISIVE ONE: a view created AFTER a destroy() must still resize ──────────────────
  console.log("\n4. After leaving a book and opening another — the path the patch changed");
  ok("returned to the library (a destroy() ran)", await backToLibrary());
  const reopened = await openBook(1);
  ok("a second book opened", reopened);
  if (reopened) {
    await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => x.querySelector('.ico-cols')); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
    await s.evaluate(`(() => { const seg = document.querySelector('.rs-seg, .seg, [class*="seg"]');
      const o = seg ? [...seg.querySelectorAll('button')] : []; if (o[0]) o[0].click(); return true; })()`);
    await sleep(3000);
    const b0 = await layout();
    await setViewport(780, 680);
    const b1 = await layout();
    ok("the NEW view still re-lays-out on resize", b1.viewSize !== b0.viewSize || b1.bodyW !== b0.bodyW,
       `viewSize ${b0.viewSize} -> ${b1.viewSize}, bodyW ${b0.bodyW} -> ${b1.bodyW}`);
    await setViewport(1280, 760);
    const b2 = await layout();
    ok("and again", b2.viewSize !== b1.viewSize || b2.bodyW !== b1.bodyW,
       `viewSize ${b1.viewSize} -> ${b2.viewSize}`);
  }
  await clearViewport();
} catch (e) {
  console.error("\nFAILED:", e.message); fail.push("harness: " + e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  console.log("\nprofile restored:", (await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY");
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
