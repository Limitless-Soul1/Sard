// WHY DOES Ctrl+Shift+D NOT WORK ON THE TESTERS' MACHINES?
//
// Both testers report the diagnostic export shortcut does nothing, which makes the whole diagnostic
// build useless. This harness measures the ENTIRE chain rather than assuming any link in it:
//
//   1. is the listener installed at all?
//   2. does a REAL key press reach the top-level window?
//   3. does the handler's condition match the event?
//   4. does the handler run to completion (report written)?
//
// It uses CDP `Input.dispatchKeyEvent`, which enters through the browser's real input pipeline and is
// therefore ROUTED BY FOCUS. This distinction is the whole point: the verification I ran before
// shipping dispatched a synthetic `KeyboardEvent` directly at `window`, which bypasses focus routing
// entirely and so could never have detected a focus-related failure. That earlier "proof" that the
// shortcut worked was not a proof of anything a tester would experience.
//
// Drives the REAL profile: snapshot before launch, restore on every exit path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const REPORTS = join(process.env.USERPROFILE ?? "", "Documents", "Sard Diagnostics");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reportCount = () =>
  existsSync(REPORTS) ? readdirSync(REPORTS).filter((n) => n.startsWith("sard-diag-") && n.endsWith(".txt")).length : 0;

// Probes installed in the page. They observe; they never handle the shortcut themselves.
//  - __keys  : every keydown that REACHES the top-level window (capture phase, so nothing can hide it)
//  - __alerts: the handler's own completion signal — it ends in window.alert() on success or failure
const PROBE = `(() => {
  window.__keys = [];
  window.__alerts = [];
  window.addEventListener('keydown', (e) => window.__keys.push(
    { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, target: (e.target && e.target.tagName) || '?' }), true);
  window.alert = (m) => { window.__alerts.push(String(m).slice(0, 60)); };
  return true;
})()`;

const STATE = `(() => ({
  keys: window.__keys.length,
  alerts: window.__alerts.length,
  lastKey: window.__keys[window.__keys.length - 1] ?? null,
  lastAlert: window.__alerts[window.__alerts.length - 1] ?? null,
  activeTag: document.activeElement ? document.activeElement.tagName : '(none)',
  activeCls: (document.activeElement && typeof document.activeElement.className === 'string')
    ? document.activeElement.className.slice(0, 40) : '',
  iframes: document.querySelectorAll('iframe').length,
}))()`;

/** Send a REAL key chord through the browser input pipeline, routed to whatever has focus. */
async function press(s, { key, code, keyCode = 68 }) {
  const mods = 2 | 8; // Ctrl (2) + Shift (8)
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: mods, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: mods, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
}

/** A real mouse click at a point, so focus moves the way a user's click moves it. */
async function click(s, x, y) {
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const snap = snapshotDb(REPO, "shortcut-chain");
if (!snap) {
  console.error("FATAL: could not snapshot the profile — refusing to run. NOTHING was verified.");
  process.exit(1);
}

const rows = [];
let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9341, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);
  await s.evaluate(PROBE);

  // LINK 1 — is the listener installed at all?
  const installed = await s.evaluate(
    `(() => { const ev = window.__sardDiag?.events?.() ?? [];
       return { armed: !!window.__sardDiag, installed: ev.some(e => /save shortcut installed/.test(e.msg)), events: ev.length }; })()`,
  );
  console.log(`LINK 1  listener installed: ${installed.installed}   (__sardDiag present: ${installed.armed}, ${installed.events} events)`);

  const run = async (label, prep) => {
    if (prep) await prep();
    await sleep(600);
    const before = await s.evaluate(STATE);
    const filesBefore = reportCount();
    await press(s, { key: "D", code: "KeyD" });
    await sleep(2500);
    const after = await s.evaluate(STATE);
    const row = {
      label,
      reachedWindow: after.keys > before.keys,
      handlerRan: after.alerts > before.alerts,
      wroteFile: reportCount() > filesBefore,
      focus: `${before.activeTag}${before.activeCls ? "." + before.activeCls : ""}`,
      lastKey: after.lastKey,
    };
    rows.push(row);
    console.log(
      `\n${label}\n   focus at press      ${row.focus}` +
        `\n   reached top window  ${row.reachedWindow ? "YES" : "NO"}` +
        `\n   handler ran         ${row.handlerRan ? "YES" : "NO"}` +
        `\n   report written      ${row.wroteFile ? "YES" : "NO"}` +
        `\n   event seen          ${JSON.stringify(row.lastKey)}`,
    );
    return row;
  };

  await run("CASE A — library, nothing opened");

  await run("CASE B — book open, focus in the app chrome", async () => {
    await s.evaluate(`(() => { const c = document.querySelector('.lib-card'); if (c) c.click(); return true; })()`);
    await sleep(9000);
    await s.evaluate(`(() => { document.body.focus?.(); return true; })()`);
  });

  // The reading iframe lives inside <foliate-view>'s CLOSED shadow root: `el.shadowRoot` is null and
  // no amount of walking the DOM will reach it. The only handle is the section document the renderer
  // hands out — which is exactly how the application itself reaches it — and from that document,
  // `defaultView.frameElement` gives back the iframe.
  const SECTION_DOC = `(document.querySelector('foliate-view')?.renderer?.getContents?.()?.[0]?.doc ?? null)`;

  await run("CASE C — book open, focus INSIDE the reading iframe (a real click on the page)", async () => {
    // Put a counter inside the section document itself, so we can see WHERE the event went instead
    // of only seeing that it did not arrive.
    const probed = await s.evaluate(
      `(() => { const d = ${SECTION_DOC}; if (!d) return null;
         const f = d.defaultView?.frameElement; if (!f) return 'no frameElement';
         d.__keys = [];
         d.addEventListener('keydown', (e) => d.__keys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey }), true);
         const r = f.getBoundingClientRect();
         return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`,
    );
    if (!probed || typeof probed === "string") throw new Error(`cannot reach the reading iframe: ${probed}`);
    await click(s, probed.x, probed.y);
    await sleep(800);
  });

  const inside = await s.evaluate(
    `(() => { const d = ${SECTION_DOC};
       return { iframeSaw: d?.__keys?.length ?? -1, last: d?.__keys?.[d.__keys.length - 1] ?? null,
                parentActive: document.activeElement?.tagName ?? '(none)',
                insideActive: d?.activeElement?.tagName ?? '(unreachable)' }; })()`,
  );
  console.log(
    `   WHERE THE EVENT WENT: the iframe document saw ${inside.iframeSaw} keydown(s), last ${JSON.stringify(inside.last)}` +
      `\n   parent document.activeElement = ${inside.parentActive} (a shadow host reports itself, focus is really inside it)` +
      `\n   iframe document.activeElement = ${inside.insideActive}`,
  );

  // CASE D — a NON-LATIN KEYBOARD LAYOUT. Sard's users are Arabic readers; with an Arabic layout
  // active, the physical D key reports a layout character in `event.key` while `event.code` stays
  // "KeyD". The handler tests `event.key`, so this is the exact shape that would silently fail.
  await run("CASE D — same physical key, Arabic layout character in event.key", async () => {
    await s.evaluate(`(() => { const c = document.querySelector('.rc-back'); if (c) c.click(); return true; })()`);
    await sleep(2500);
  });
  rows.pop(); // that run pressed a Latin D; the real case D is below
  const beforeD = await s.evaluate(STATE);
  const filesD = reportCount();
  await press(s, { key: "ي", code: "KeyD" }); // what Windows delivers with the Arabic layout active
  await sleep(2500);
  const afterD = await s.evaluate(STATE);
  const rowD = {
    label: "CASE D — Arabic layout (key='ي', code='KeyD')",
    reachedWindow: afterD.keys > beforeD.keys,
    handlerRan: afterD.alerts > beforeD.alerts,
    wroteFile: reportCount() > filesD,
    focus: beforeD.activeTag,
    lastKey: afterD.lastKey,
  };
  rows.push(rowD);
  console.log(
    `\n${rowD.label}\n   reached top window  ${rowD.reachedWindow ? "YES" : "NO"}` +
      `\n   handler ran         ${rowD.handlerRan ? "YES" : "NO"}` +
      `\n   report written      ${rowD.wroteFile ? "YES" : "NO"}` +
      `\n   event seen          ${JSON.stringify(rowD.lastKey)}`,
  );

  // CASE E — the fallback that must depend on nothing: a real mouse click on the visible button,
  // with a book open, no keyboard involved at all.
  const btn = await s.evaluate(
    `(() => { const b = document.getElementById('sard-diag-export'); if (!b) return null;
       const r = b.getBoundingClientRect();
       return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: b.textContent.slice(0, 40),
                visible: r.width > 0 && r.height > 0 }; })()`,
  );
  if (!btn) {
    rows.push({ label: "CASE E — on-screen export button", reachedWindow: false, handlerRan: false, wroteFile: false });
    console.log("\nCASE E — on-screen export button\n   THE BUTTON IS NOT PRESENT");
  } else {
    await s.evaluate(`(() => { const c = document.querySelector('.lib-card'); if (c) c.click(); return true; })()`);
    await sleep(9000);
    const beforeE = await s.evaluate(STATE);
    const filesE = reportCount();
    await click(s, btn.x, btn.y);
    await sleep(3000);
    const afterE = await s.evaluate(STATE);
    const rowE = {
      label: "CASE E — on-screen export button, book open, NO keyboard",
      reachedWindow: true,
      handlerRan: afterE.alerts > beforeE.alerts,
      wroteFile: reportCount() > filesE,
    };
    rows.push(rowE);
    console.log(
      `\n${rowE.label}\n   button present      YES (${btn.text.trim()}), visible ${btn.visible}` +
        `\n   handler ran         ${rowE.handlerRan ? "YES" : "NO"}` +
        `\n   report written      ${rowE.wroteFile ? "YES" : "NO"}`,
    );
  }

  console.log("\n================ SUMMARY ================");
  for (const r of rows) {
    console.log(
      `${r.handlerRan ? "WORKS  " : "BROKEN "} ${r.label}` +
        `  [reached window: ${r.reachedWindow ? "yes" : "NO"}, handler: ${r.handlerRan ? "yes" : "NO"}]`,
    );
  }
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
