// UX INVESTIGATION — "first click on a Contents entry only reveals the chrome". READ-ONLY probe.
//
// Hypothesis to test, NOT assume: `useChromeOnIntent` registers a global window `pointerdown -> wake()`
// (useChromeOnIntent.ts:177). It is PASSIVE, so it cannot swallow the event. But `wake()` sets
// visible=true, the chrome bars animate in, and if that RE-LAYS-OUT the Contents panel the row slides
// out from under the pointer — and a `click` only fires when pointerdown and pointerup land on the same
// element. That would produce exactly "the first click does nothing but show the bars".
//
// So the probe measures the ROW'S RECT across the wake, and then whether a real click navigates.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/probe-toc-immersive-result.json";
const report = { startedAt: new Date().toISOString(), commit: "3e0fc98", steps: {} };
const snap = snapshotDb("M:\\eRawy", "toc-immersive");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9974, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,120)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title)};
    const c=[...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === t);
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);
  const id = JSON.parse(await s.evaluate(`JSON.stringify({ fixedLayout: document.querySelector('.page-host foliate-view')?.isFixedLayout ?? null })`));
  if (id.fixedLayout !== false) throw new Error(`control is not a reflowable EPUB (fixedLayout=${id.fixedLayout})`);
  console.log(`control EPUB: "${epub.title}"`);

  // open Contents
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/contents|المحتويات|فهرس/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  await sleep(1400);

  // force the immersive/hidden-chrome state the report describes: scroll DOWN inside the reading area
  await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    d?.dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true})); return true; })()`);
  await sleep(2000);

  const CHROME = `(() => {
    const top = document.querySelector('.rc-top'), bot = document.querySelector('.rc-bottom');
    const cs = (e) => e ? getComputedStyle(e) : null;
    const t = cs(top), b = cs(bot);
    return { topOpacity: t?.opacity ?? null, topTransform: t?.transform ?? null,
      botOpacity: b?.opacity ?? null, scrolledAway: document.documentElement.classList.contains('scrolled-away')
        || !!document.querySelector('.scrolled-away'),
      rootClasses: document.documentElement.className.slice(0,80) };
  })()`;
  const ROW = `(() => {
    const rows=[...document.querySelectorAll('.toc-row')];
    const target = rows[8] || rows[rows.length-1];
    if (!target) return { err:'no rows' };
    const r = target.getBoundingClientRect();
    const panel = document.querySelector('.reader-panel.rp-lead');
    const pr = panel ? panel.getBoundingClientRect() : null;
    const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
    const under = document.elementFromPoint(cx, cy);
    return { rows: rows.length, idx: 8, top:+r.top.toFixed(1), left:+r.left.toFixed(1),
      h:+r.height.toFixed(1), cx, cy,
      panelTop: pr ? +pr.top.toFixed(1) : null, panelH: pr ? +pr.height.toFixed(1) : null,
      elementUnderCentreIsRow: !!(under && (under === target || target.contains(under))),
      underTag: under ? under.className?.toString().slice(0,40) : null,
      label: (target.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40) };
  })()`;

  report.steps.chromeHidden = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  const before = JSON.parse(await s.evaluate(`JSON.stringify(${ROW})`));
  report.steps.rowBefore = before;
  console.log(`\nchrome state: ${JSON.stringify(report.steps.chromeHidden)}`);
  console.log(`row[8] before: top=${before.top} panelTop=${before.panelTop} panelH=${before.panelH} label="${before.label}"`);

  // fire ONLY pointerdown (what the global wake listener reacts to), then re-measure geometry
  const secBefore = await s.evaluate(`document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.index ?? null`);
  await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')]; const t=rows[8]||rows[rows.length-1];
    const r=t.getBoundingClientRect();
    t.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2)}));
    return true; })()`);
  await sleep(700);
  const after = JSON.parse(await s.evaluate(`JSON.stringify(${ROW})`));
  report.steps.rowAfterPointerDown = after;
  report.steps.chromeAfter = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  const shifted = Math.abs((after.top ?? 0) - (before.top ?? 0));
  console.log(`row[8] after pointerdown: top=${after.top} (shift ${shifted.toFixed(1)}px) · still under original centre=${after.elementUnderCentreIsRow}`);
  console.log(`chrome after: ${JSON.stringify(report.steps.chromeAfter)}`);
  report.steps.rowShiftPx = +shifted.toFixed(1);

  // now a REAL first click from the hidden-chrome state: re-establish it, then click once
  await s.evaluate(`(() => { const d=document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    d?.dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true})); return true; })()`);
  await sleep(2000);
  const sec0 = await s.evaluate(`document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.index ?? null`);
  const chromeAtClick = JSON.parse(await s.evaluate(`JSON.stringify(${CHROME})`));
  await s.evaluate(`(() => { const rows=[...document.querySelectorAll('.toc-row')]; const t=rows[8]||rows[rows.length-1]; t.click(); return true; })()`);
  await sleep(2600);
  const sec1 = await s.evaluate(`document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.index ?? null`);
  report.steps.firstClick = { chromeAtClick, sectionBefore: sec0, sectionAfter: sec1, navigated: sec0 !== sec1 };
  console.log(`\nFIRST .click() from hidden chrome: section ${sec0} -> ${sec1} · navigated=${sec0 !== sec1}`);
  console.log(`  (a synthetic .click() bypasses pointerdown/up pairing — this isolates the HANDLER from the geometry)`);

  report.steps.secBefore = secBefore;
  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0,6))`));
} catch (e) { report.fatal = e.message; console.error("FATAL:", e.message); }
finally {
  try { if (s) await s.close(); } catch {}
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch {}
  await sleep(1400);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED"}`);
  console.log(`result: ${OUT}`);
}
