// VERIFY RAWY-291 — PDF zoom and reading appearances, in the real binary.
//
// The claim that matters is not "the number changed" but "the page gained RESOLUTION". foliate's
// pdf.js wrapper re-renders through pdf.js at the requested scale, so a genuine zoom raises the page
// image's INTRINSIC size (naturalWidth). A CSS magnification would leave it untouched and only stretch
// the displayed size — which is exactly the blurry behaviour this work exists to avoid. Both are
// measured, so the two cannot be confused.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = snapshotDb("M:\\eRawy", "pdf-zoom-theme");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = {};
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9920, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140)));
    return true; })()`);

  const PAGE = `(() => {
    const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc;
    const im = d?.querySelector('img');
    const desk = document.querySelector('.reader-desk');
    const host = document.querySelector('.page-host');
    return JSON.stringify({
      natural: im?.naturalWidth ?? null,          // rises only if pdf.js actually re-rendered
      shown: im ? Math.round(im.getBoundingClientRect().width) : null,
      zoomAttr: v?.renderer?.getAttribute?.('zoom') ?? null,
      deskClass: (desk?.className || ''),
      filter: host ? getComputedStyle(host).filter : null,
      deskBg: desk ? getComputedStyle(desk).backgroundColor : null,
      frac: v?.lastLocation?.fraction ?? null,
    }); })()`;

  const openPdf = async () => {
    await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes('Noor-Book')); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    for (let k = 0; k < 120; k++) { if (JSON.parse(await s.evaluate(PAGE)).natural) return true; await sleep(250); }
    return false;
  };
  const back = async () => {
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);
  };

  if (!(await openPdf())) throw new Error("PDF did not open");
  await sleep(2500);
  const atOpen = JSON.parse(await s.evaluate(PAGE));
  console.log(`open (default): zoom=${atOpen.zoomAttr} natural=${atOpen.natural} shown=${atOpen.shown}`);
  out.atOpen = atOpen;

  // ---- 1. Ctrl+Wheel zoom — the gesture that previously turned the page --------------------
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    await s.evaluate(`(() => { const d = document.querySelector('.reader-desk');
      d.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(260);
  }
  await sleep(1800);
  const zoomed = JSON.parse(await s.evaluate(PAGE));
  out.ctrlWheel = { before: atOpen, after: zoomed, ms: Date.now() - t0,
    reRendered: (zoomed.natural ?? 0) > (atOpen.natural ?? 0),
    pageStayed: Math.abs((zoomed.frac ?? 0) - (atOpen.frac ?? 0)) < 1e-6 };
  console.log(`ctrl+wheel in: zoom=${zoomed.zoomAttr} natural ${atOpen.natural} -> ${zoomed.natural}`
    + ` shown ${atOpen.shown} -> ${zoomed.shown} · RE-RENDERED=${out.ctrlWheel.reRendered} · page unchanged=${out.ctrlWheel.pageStayed}`);

  // ---- 2. Buttons: zoom out, fit width, fit page --------------------------------------------
  const clickPanel = async (sel) => {
    await s.evaluate(`(() => { const b = [...document.querySelectorAll('.rc-btn, .rc-icon, button')]
      .find(x => /pdf|options|إعداد|PDF/i.test((x.getAttribute('title')||'') + (x.getAttribute('aria-label')||''))); if (b) b.click(); return !!b; })()`);
    await sleep(600);
    const hit = await s.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
    await sleep(2200);
    return hit;
  };
  out.buttons = {};
  for (const [name, sel] of [["zoomOut", ".pdf-zoom-btn"], ["fitWidth", ".pdf-zoom-fit"], ["fitPage", ".pdf-zoom-fit:last-of-type"]]) {
    const hit = await clickPanel(sel);
    const st = JSON.parse(await s.evaluate(PAGE));
    out.buttons[name] = { clicked: hit, zoomAttr: st.zoomAttr, natural: st.natural, shown: st.shown };
    console.log(`  ${name.padEnd(9)} clicked=${hit} zoom=${st.zoomAttr} natural=${st.natural} shown=${st.shown}`);
  }

  // ---- 3. Themes: does the filter actually reach the page? ----------------------------------
  out.themes = {};
  for (const id of ["sepia", "night", "green", "ink", "normal"]) {
    await s.evaluate(`(() => { const b = document.querySelector('.pdf-chip-${id}'); if (b) b.click(); return !!b; })()`);
    await sleep(700);
    const st = JSON.parse(await s.evaluate(PAGE));
    out.themes[id] = { deskClass: st.deskClass.includes(`pdf-theme-${id}`), filter: st.filter, deskBg: st.deskBg };
    console.log(`  theme ${id.padEnd(7)} applied=${out.themes[id].deskClass} filter=${String(st.filter).slice(0, 52)} desk=${st.deskBg}`);
  }

  // ---- 4. Memory of the zoom for THIS document ----------------------------------------------
  await s.evaluate(`(() => { const b = document.querySelector('.pdf-chip-sepia'); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  for (let i = 0; i < 4; i++) {
    await s.evaluate(`(() => { const d = document.querySelector('.reader-desk');
      d.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(260);
  }
  await sleep(2000);
  const beforeClose = JSON.parse(await s.evaluate(PAGE));
  await back();
  await sleep(800);
  if (!(await openPdf())) throw new Error("reopen failed");
  await sleep(3500);
  const reopened = JSON.parse(await s.evaluate(PAGE));
  out.remembered = { before: beforeClose.zoomAttr, after: reopened.zoomAttr,
    kept: beforeClose.zoomAttr === reopened.zoomAttr, naturalBefore: beforeClose.natural, naturalAfter: reopened.natural,
    themeKept: reopened.deskClass.includes("pdf-theme-sepia") };
  console.log(`reopen: zoom ${beforeClose.zoomAttr} -> ${reopened.zoomAttr} · remembered=${out.remembered.kept}`
    + ` · theme kept=${out.remembered.themeKept}`);

  out.errors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 8))`));
  console.log(`page errors: ${out.errors.length} ${JSON.stringify(out.errors.slice(0, 3))}`);
} catch (e) {
  console.error("\nVERIFY FAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/pdf-zoom-theme-result.json", JSON.stringify(out, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
