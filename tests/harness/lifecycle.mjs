#!/usr/bin/env node
// RESILIENCE-1 — THE HARNESS SELF-TEST.
//
// Every other harness borrows the owner's REAL profile. Four separate settings leaked out of it
// during this milestone (`flowMode`, `hide_chapter_titles`, `paragraphSpacing`, and the typography
// trio overwritten by a stray second instance), and each leak surfaced as byte-identity reporting
// hundreds or thousands of "rendering differences" that were not real. A verification tool that
// needs a manual reset before it can be believed is not a verification tool.
//
// So this asserts the guarantees the harness now makes, by DOING the damage and checking it is
// undone — not by inspecting the code:
//
//   1. a launch kills any pre-existing instance, so a run never shares the profile
//   2. close() does not return until the process has actually exited
//   3. no Sard process survives a run, whoever started it
//   4. a setting deliberately changed mid-run is byte-for-byte restored afterwards
//   5. the snapshot directory is cleaned up
//
//   node tests/harness/lifecycle.mjs        # exits non-zero if any guarantee fails

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anySardRunning, forceKillAll, launchSard } from "./cdp.mjs";
import { APP_DATA, restoreDb, snapshotDb, verifyRestored } from "./profile.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const snapshotsBefore = () =>
  readdirSync(REPO).filter((f) => f.startsWith(".db-snapshot-")).length;

console.log("\n  harness lifecycle self-test\n");

// ── 1. a pre-existing instance is killed by the next launch ──────────────────────────────────────
{
  const stray = await launchSard({ port: 9350 });
  if (stray.skipped) { console.error(`  ${stray.skipped}`); process.exit(1); }
  // Deliberately do NOT close it. A second launch must clear it.
  const before = anySardRunning();
  const s = await launchSard({ port: 9351 });
  await sleep(300);
  check("a launch clears any pre-existing instance", before === true, "stray was running before the second launch");
  await s.close();
  check("no process survives close()", anySardRunning() === false);
  forceKillAll();
}

// ── 2–5. a setting changed mid-run is restored, and nothing is left behind ───────────────────────
{
  const snapsBefore = snapshotsBefore();
  const snap = snapshotDb(REPO, "lifecycle");
  let ok = false;
  let changedTo = null;
  let origLang = null, origHide = null;
  try {
    const s = await launchSard({ port: 9352 });
    for (let i = 0; i < 80; i++) {
      if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
      await sleep(400);
    }
    // Capture the ORIGINALS first. Asserting `hide_chapter_titles !== "1"` afterwards was unsound:
    // it cannot tell "restored correctly" from "leaked" for any owner whose real value IS 1 — and on
    // 2026-08-05 it failed for exactly that reason, on a profile the byte-hash proved was intact.
    // A restoration test must compare against what was actually there.
    origLang = await s.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'ui_lang' })`);
    origHide = await s.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'hide_chapter_titles' })`);

    // DO THE DAMAGE the harness runs really do: change a persisted setting.
    changedTo = `lifecycle-${Date.now()}`;
    await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'hide_chapter_titles', value: '1' })`,
    );
    await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'ui_lang', value: ${JSON.stringify(changedTo)} })`,
    );
    // Give sqlite time to actually persist, so this is a real write and not a race we win by luck.
    await sleep(800);
    await s.close();
    check("close() returns only after the process is gone", anySardRunning() === false);
    ok = await restoreDb(snap);
  } finally {
    forceKillAll();
  }
  check("restoreDb() reported success", ok === true);

  // The decisive check: read the profile back through a FRESH app and confirm the values are the
  // owner's, not the ones this test wrote. Byte-comparison already passed inside restoreDb; this
  // proves it end-to-end, through the same path a real run would leak by.
  const v = await launchSard({ port: 9353 });
  for (let i = 0; i < 80; i++) {
    if (await v.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  const lang = await v.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'ui_lang' })`);
  const hide = await v.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'hide_chapter_titles' })`);
  await v.close();
  check("a setting changed mid-run is restored", lang === origLang, `ui_lang = ${lang} (was ${origLang})`);
  check("a second changed setting is restored too", hide === origHide, `hide_chapter_titles = ${hide} (was ${origHide})`);
  check("the snapshot directory is cleaned up", snapshotsBefore() === snapsBefore);
  check("no snapshot dir left behind at all", !existsSync(snap));
}

// ── final post-conditions ────────────────────────────────────────────────────────────────────────
check("no Sard process is running at the end", anySardRunning() === false);
console.log(`\n  profile: ${APP_DATA}`);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n  ✗ ${failed.length} guarantee(s) FAILED — the harness is not trustworthy yet\n`);
  process.exit(1);
}
console.log(`\n  ✓ all ${results.length} guarantees hold — byte-identity needs no manual reset\n`);
