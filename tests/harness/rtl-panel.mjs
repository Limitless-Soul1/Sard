// PPC-4 — the panel's CONTENT must mirror; its BOX must not move.
//
// RAWY-32 pins the settings drawer to the physical right edge with `right`/`translateX` rather than
// logical insets, precisely so the UI language cannot move it. That is what makes carrying `dir` on
// the aside safe — but "the CSS says so" is not a measurement, and the whole reason PPC-4 was filed
// as risky is that a direction change was assumed to disturb drawer placement (RAWY-89).
//
// So: assert the box is where it was, and the content flows the other way.
import { execFileSync } from "node:child_process";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };

const snap = snapshotDb("M:\\eRawy", "ppc4");
if (!snap) { console.error("FATAL: could not snapshot"); process.exit(1); }
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9481, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 120; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { const c = document.querySelector('.lib-card'); if (c) c.click(); return !!c; })()`);
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break; await sleep(300); }
  await sleep(2500);

  // IDEMPOTENT. The chrome buttons TOGGLE, so calling this twice for the same panel closes it — and a
  // closed drawer is still measurable, just translated off-screen. The first version of this harness
  // did exactly that and measured the size slider inside a panel sitting at x=1133..1484, outside a
  // 1100px viewport. The geometry it reported was internally consistent and completely useless.
  const openTab = async (ico, wantSel) => {
    const already = wantSel ? await s.evaluate(`!!document.querySelector('${wantSel}')`) : false;
    if (!already) {
      await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => x.querySelector('.${ico}')); if (b) b.click(); return !!b; })()`);
      await sleep(1400);
    }
  };
  const box = (sel) => s.evaluate(`(() => { const e = document.querySelector('${sel}');
    if (!e) return 'missing'; const r = e.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
      dir: getComputedStyle(e).direction, vw: window.innerWidth }); })()`).then((x) => x === "missing" ? null : JSON.parse(x));

  console.log("\n1. The settings drawer stays pinned to the PHYSICAL right edge");
  await openTab("ico-aa", ".settings-panel.show");
  const sp = await box(".settings-panel.show");
  ok("the settings panel is open and measurable", !!sp, JSON.stringify(sp));
  if (sp) {
    ok("its right edge is the viewport's right edge (unmoved by direction)", Math.abs(sp.right - sp.vw) <= 1,
       `right=${sp.right} vs viewport ${sp.vw}`);
    ok("its content direction is now RTL (the PPC-4 fix)", sp.dir === "rtl", `direction=${sp.dir}`);
  }

  console.log("\n2. RAWY-89's pin is untouched");
  const rr = await box(".reader-root");
  ok("the reading area is still pinned LTR", rr?.dir === "ltr", `direction=${rr?.dir}`);
  ok("the reading area still spans the window", rr && rr.left === 0 && Math.abs(rr.right - rr.vw) <= 1,
     `left=${rr?.left} right=${rr?.right}`);

  console.log("\n3. The chapters drawer still docks LEFT, opposite the settings drawer");
  await openTab("ico-lines", ".reader-panel.rp-lead.show");
  const cp = await box(".reader-panel.rp-lead.show");
  ok("the chapters panel opened on the left edge", cp && cp.left === 0, JSON.stringify(cp));
  ok("it did not collide with the settings drawer", cp && sp && cp.right <= sp.left,
     `chapters right=${cp?.right}, settings left=${sp?.left}`);

  console.log("\n4. The size slider reads small→large in reading order");
  await openTab("ico-aa", ".settings-panel.show");
  console.log("   " + await s.evaluate(`(() => {
    const row = [...document.querySelectorAll('.rs-slider-row')].find(r => { const s = r.querySelector('.rs-slider'); return s && s.min === '0.8'; });
    if (!row) return 'size row not found';
    const caps = [...row.querySelectorAll('.rs-slider-cap')].map(c => ({ t: (c.textContent||'').trim(), x: Math.round(c.getBoundingClientRect().left) }));
    return 'caps: ' + JSON.stringify(caps) + '  rowDir=' + getComputedStyle(row).direction;
  })()`));
  const capOrder = JSON.parse(await s.evaluate(`(() => {
    const row = [...document.querySelectorAll('.rs-slider-row')].find(r => { const s = r.querySelector('.rs-slider'); return s && s.min === '0.8'; });
    const caps = [...row.querySelectorAll('.rs-slider-cap')].map(c => ({ t: (c.textContent||'').trim(), x: c.getBoundingClientRect().left }));
    return JSON.stringify(caps); })()`));
  if (capOrder.length >= 2) {
    // In RTL the FIRST cap (the small "A") must sit further RIGHT than the second.
    ok("the leading (small) cap sits on the right, as Arabic reads", capOrder[0].x > capOrder[1].x,
       `small at x=${Math.round(capOrder[0].x)}, large at x=${Math.round(capOrder[1].x)}`);
  } else {
    console.log(`   NOTE: only ${capOrder.length} cap(s) on the size row — order not asserted`);
  }
} catch (e) {
  console.error("\nFAILED:", e.message); fail.push("harness: " + e.message);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  console.log("\nprofile restored:", (await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY");
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
