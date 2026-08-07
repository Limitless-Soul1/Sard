#!/usr/bin/env node
// Set a plain settings key in the real profile.
//
// Companion to set-style.mjs, and needed for the same reason: the app-driving harnesses share the
// owner's real profile, and a run that toggles a setting can leave it toggled when a stray process
// survives the restore. Observed with `hide_chapter_titles`, which then made byte-identity report 54
// "rendering differences" that were only the hidden-title feature doing its job.
//
//   node tests/harness/set-flag.mjs hide_chapter_titles 0
import { launchSard } from "./cdp.mjs";

const [key, value] = process.argv.slice(2);
if (!key || value === undefined) {
  console.error("usage: set-flag.mjs <key> <value>");
  process.exit(1);
}
const sard = await launchSard({ port: 9346 });
try {
  for (let i = 0; i < 80; i++) {
    if (await sard.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const before = await sard.evaluate(
    `window.__TAURI_INTERNALS__.invoke('settings_get', { key: ${JSON.stringify(key)} })`,
  );
  await sard.evaluate(
    `window.__TAURI_INTERNALS__.invoke('settings_set', { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })`,
  );
  const after = await sard.evaluate(
    `window.__TAURI_INTERNALS__.invoke('settings_get', { key: ${JSON.stringify(key)} })`,
  );
  console.log(`  ${key}: ${before} → ${after}`);
} finally {
  await sard.close();
}
