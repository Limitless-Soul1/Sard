#!/usr/bin/env node
// Restore named fields of `reading_style` in the real profile.
//
// WHY THIS EXISTS. The app-driving harnesses share the owner's real profile, and a run that leaves a
// STRAY Sard process behind can end with two instances holding the same database — the second one
// writing its stale in-memory reading style over the first's. Observed for real: zoom drifted 2 →
// 2.5 and lineHeight 2.1 → 2.6, which the byte-identity fingerprint then reported as 1,517
// "rendering differences" that were nothing of the kind. Its `config:` line named the true cause in
// two lines, which is exactly why that capture exists.
//
//   node tests/harness/set-style.mjs zoom=2 lineHeight=2.1 flowMode=scrolled
import { launchSard } from "./cdp.mjs";

const args = process.argv.slice(2).map((a) => a.split("="));
if (!args.length || args.some(([k, v]) => !k || v === undefined)) {
  console.error("usage: set-style.mjs key=value [key=value …]");
  process.exit(1);
}
const sard = await launchSard({ port: 9342 });
try {
  for (let i = 0; i < 80; i++) {
    if (await sard.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const raw = await sard.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'reading_style' })`);
  const style = raw ? JSON.parse(raw) : {};
  const before = {};
  for (const [k, v] of args) {
    before[k] = style[k];
    style[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  await sard.evaluate(
    `window.__TAURI_INTERNALS__.invoke('settings_set', { key: 'reading_style', value: ${JSON.stringify(
      JSON.stringify(style),
    )} })`,
  );
  const after = JSON.parse(await sard.evaluate(`window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'reading_style' })`));
  for (const [k] of args) console.log(`  ${k}: ${before[k]} → ${after[k]}`);
} finally {
  await sard.close();
}
