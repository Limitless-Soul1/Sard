// TTS SPEED MENU (RAWY-296) — verification against the real binary.
//
// The bar is not "the menu renders". It is: does choosing a speed actually change the RATE THE AUDIO
// PLAYS AT? So every option is clicked during real playback and the resulting `mediaEl.playbackRate` is
// read back through `__sardTtsStats()` — the product's own instrument. A menu that looked right while
// the audio kept its old rate would pass any DOM-only check.
//
// EPUB, because PDF read-aloud is currently disabled at the product level.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-speed-menu-result.json";
const EXPECTED = [1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.75, 2];

const report = { startedAt: new Date().toISOString(), cases: {}, violations: [] };
const fail = (m) => { report.violations.push(m); console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const snap = snapshotDb("M:\\eRawy", "tts-speed-menu");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

const MENU = `(() => {
  const wrap = document.querySelector('.tts-speed-wrap');
  const chip = wrap?.querySelector('.tts-speed-chip');
  const menu = wrap?.querySelector('.tts-speed-menu');
  const opts = menu ? [...menu.querySelectorAll('.tts-speed-opt')] : [];
  const cs = menu ? getComputedStyle(menu) : null;
  const chipR = chip ? chip.getBoundingClientRect() : null;
  const menuR = menu ? menu.getBoundingClientRect() : null;
  return {
    hasWrap: !!wrap, hasChip: !!chip, open: !!menu,
    chipLabel: chip ? chip.textContent.trim() : null,
    chipExpanded: chip ? chip.getAttribute('aria-expanded') : null,
    count: opts.length,
    values: opts.map(o => o.querySelector('.tts-speed-val')?.textContent.trim() ?? ''),
    selected: opts.filter(o => o.getAttribute('aria-selected') === 'true')
                  .map(o => o.querySelector('.tts-speed-val')?.textContent.trim()),
    withCheckGlyph: opts.filter(o => !!o.querySelector('.tts-speed-check svg')).length,
    role: menu ? menu.getAttribute('role') : null,
    dir: menu ? menu.getAttribute('dir') : null,
    // The menu must open UPWARD (the pill sits near the bottom) and stay on screen.
    opensUpward: !!(chipR && menuR && menuR.bottom <= chipR.top + 1),
    onScreen: !!(menuR && menuR.left >= 0 && menuR.right <= window.innerWidth && menuR.top >= 0),
    zIndex: cs ? cs.zIndex : null,
  };
})()`;

const RATE = `(() => { const st = window.__sardTtsStore?.getState?.();
  let m = null; try { m = window.__sardTtsStats?.().media ?? null; } catch(e){}
  return { storeSpeed: st?.speed ?? null, rate: m ? m.rate : null, status: st?.status,
    paused: m ? m.paused : null, readyState: m ? m.readyState : null,
    preservesPitch: m ? m.preservesPitch : null }; })()`;

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9950, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err=[]; window.addEventListener('error',e=>window.__err.push((e.message||'').slice(0,160))); return true; })()`);

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format ?? "").toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!epub) throw new Error("no EPUB in the library");
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 120; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(250); }
  await sleep(2500);
  const isEpub = await s.evaluate(`document.querySelector('.page-host foliate-view')?.isFixedLayout === false`);
  if (!isEpub) throw new Error("control is not a reflowable EPUB");
  console.log(`\ncontrol: "${epub.title}" (EPUB)`);

  // start playback so there is a real media element to read the rate from
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  let ready = null;
  const dl = Date.now() + 70_000;
  while (Date.now() < dl) {
    ready = JSON.parse(await s.evaluate(`JSON.stringify(${RATE})`));
    if (ready.readyState === 4) break;
    await sleep(900);
  }
  report.cases.playback = ready;
  console.log(`playback: status=${ready.status} readyState=${ready.readyState} rate=${ready.rate}`);
  if (ready.readyState !== 4) fail(`playback never reached readyState 4 (${JSON.stringify(ready)})`);

  // ===== 1 · the menu opens and lists exactly the approved set ==================================
  console.log("\n=== 1 · menu contents");
  const closed = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
  if (closed.hasChip && !closed.open) pass("chip present, menu closed initially");
  else fail(`initial state wrong: ${JSON.stringify(closed)}`);
  await s.evaluate(`document.querySelector('.tts-speed-chip')?.click()`);
  await sleep(500);
  const open = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
  report.cases.menu = open;
  console.log(`  values: ${JSON.stringify(open.values)}`);
  console.log(`  role=${open.role} dir=${open.dir} upward=${open.opensUpward} onScreen=${open.onScreen} aria-expanded=${open.chipExpanded}`);
  if (open.open) pass("menu opens on click"); else fail("menu did not open");
  if (open.count === EXPECTED.length) pass(`${open.count} options`); else fail(`expected ${EXPECTED.length} options, got ${open.count}`);
  // Compare NUMERICALLY: the label may carry Arabic-Indic digits and a × suffix.
  const nums = open.values.map((v) => Number(String(v).replace(/[^\d.]/g, "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))));
  const parsed = open.values.map((v) => {
    const ascii = String(v).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, "");
    return Number(ascii);
  });
  report.cases.parsedValues = parsed;
  console.log(`  parsed: ${JSON.stringify(parsed)}`);
  if (JSON.stringify(parsed) === JSON.stringify(EXPECTED)) pass("values match the approved list exactly, in order");
  else fail(`values ${JSON.stringify(parsed)} != ${JSON.stringify(EXPECTED)}`);
  const maxV = Math.max(...parsed.filter((n) => Number.isFinite(n)));
  if (maxV === 2) pass("maximum is 2× — nothing above it"); else fail(`maximum is ${maxV}, expected 2`);
  if (parsed.every((n) => n <= 2)) pass("no option exceeds 2×"); else fail("an option exceeds 2×");
  if (open.selected.length === 1 && open.withCheckGlyph === 1) pass(`exactly one option marked selected (${open.selected[0]})`);
  else fail(`selection indicator wrong: selected=${JSON.stringify(open.selected)} checks=${open.withCheckGlyph}`);
  if (open.opensUpward && open.onScreen) pass("menu opens upward and stays on screen"); else fail("menu placement wrong");
  void nums;

  // ===== 2 · every speed reaches the audio element =============================================
  console.log("\n=== 2 · each speed applied to the real audio");
  const applied = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    const want = EXPECTED[i];
    const openNow = await s.evaluate(`(() => { if (!document.querySelector('.tts-speed-menu')) document.querySelector('.tts-speed-chip')?.click(); return true; })()`);
    void openNow;
    await sleep(350);
    const clicked = await s.evaluate(`(() => { const opts=[...document.querySelectorAll('.tts-speed-opt')];
      const o = opts[${i}]; if (!o) return false; o.click(); return true; })()`);
    await sleep(900);
    const r = JSON.parse(await s.evaluate(`JSON.stringify(${RATE})`));
    const m = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
    applied.push({ want, clicked, storeSpeed: r.storeSpeed, rate: r.rate, chipLabel: m.chipLabel, menuOpen: m.open, status: r.status });
    const rateOk = Math.abs((r.rate ?? -1) - want) < 1e-6;
    const storeOk = Math.abs((r.storeSpeed ?? -1) - want) < 1e-6;
    console.log(`  ${String(want).padEnd(5)} store=${r.storeSpeed} rate=${r.rate} chip="${m.chipLabel}" menuClosed=${!m.open} ${rateOk && storeOk ? "" : "  <-- MISMATCH"}`);
    if (!clicked) fail(`option ${want}: not clickable`);
    if (!storeOk) fail(`speed ${want}: store holds ${r.storeSpeed}`);
    if (!rateOk) fail(`speed ${want}: audio playbackRate is ${r.rate}`);
    if (m.open) fail(`speed ${want}: menu stayed open after selection`);
    if (r.preservesPitch === false) fail(`speed ${want}: preservesPitch turned off`);
  }
  report.cases.applied = applied;
  if (applied.every((a) => Math.abs(a.rate - a.want) < 1e-6)) pass("all 11 speeds reached the audio element exactly");

  // ===== 3 · outside click closes, and does not change the speed ===============================
  console.log("\n=== 3 · dismissal");
  const before = JSON.parse(await s.evaluate(`JSON.stringify(${RATE})`));
  await s.evaluate(`document.querySelector('.tts-speed-chip')?.click()`);
  await sleep(400);
  const opened2 = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
  // a pointerdown well away from the chip — the capture-phase listener should take it
  await s.evaluate(`(() => { const el = document.querySelector('.reader-desk') || document.body;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: Math.round(r.left + 12), clientY: Math.round(r.top + 12) }));
    return true; })()`);
  await sleep(500);
  const afterOutside = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
  const rateAfter = JSON.parse(await s.evaluate(`JSON.stringify(${RATE})`));
  report.cases.dismissal = { opened2: opened2.open, afterOutside: afterOutside.open, before, rateAfter };
  if (opened2.open && !afterOutside.open) pass("clicking outside closes the menu");
  else fail(`outside click did not close (open before=${opened2.open} after=${afterOutside.open})`);
  if (Math.abs((rateAfter.rate ?? 0) - (before.rate ?? -1)) < 1e-6) pass("dismissing changed no speed");
  else fail(`speed changed on dismissal: ${before.rate} -> ${rateAfter.rate}`);
  // Escape
  await s.evaluate(`document.querySelector('.tts-speed-chip')?.click()`);
  await sleep(400);
  await s.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const afterEsc = JSON.parse(await s.evaluate(`JSON.stringify(${MENU})`));
  report.cases.escape = afterEsc.open;
  if (!afterEsc.open) pass("Escape closes the menu"); else fail("Escape did not close the menu");

  // ===== 4 · playback survived all of it ========================================================
  console.log("\n=== 4 · playback integrity");
  const end = JSON.parse(await s.evaluate(`(() => { const st=window.__sardTtsStore?.getState?.();
    let m=null; try { m=window.__sardTtsStats?.().media ?? null; } catch(e){}
    return JSON.stringify({ status: st?.status, underruns: st?.underruns, abandoned: st?.abandoned,
      lastFailure: st?.lastFailure ? String(st.lastFailure).slice(0,140) : null,
      paused: m?m.paused:null, readyState: m?m.readyState:null }); })()`));
  report.cases.integrity = end;
  console.log(`  status=${end.status} underruns=${end.underruns} abandoned=${end.abandoned} lastFailure=${end.lastFailure ?? "none"}`);
  if (end.status === "playing" || end.status === "paused") pass("still in a healthy playback state");
  else fail(`playback degraded to "${end.status}"`);
  if (end.lastFailure) fail(`a failure was recorded: ${end.lastFailure}`);
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);

  report.cases.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0,10))`));
  if (report.cases.pageErrors.length) console.log(`  page errors: ${JSON.stringify(report.cases.pageErrors).slice(0,200)}`);
  console.log(`\n${report.violations.length === 0 ? "✓ SPEED MENU: PASS" : `✗ FAILED — ${report.violations.length} violation(s)`}`);
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
  if (report.violations.length || report.fatal) process.exitCode = 3;
}
