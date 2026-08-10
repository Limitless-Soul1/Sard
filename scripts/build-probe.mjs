#!/usr/bin/env node
// PROBE-ONLY (throwaway branch): build the runtime gate's page into dist/.
//
// It has to run INSIDE `npm run build`, not around it. `tauri build` invokes `beforeBuildCommand`
// and `vite build` empties dist/ when it does — so a probe bundle written before the Tauri build is
// deleted by it, and one written after is never embedded, because `generate_context!` reads dist at
// Rust compile time. Between those two is the only moment that works.
//
// Inert unless SARD_BUILD_PROBE=1, so an ordinary build is untouched.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

if (process.env.SARD_BUILD_PROBE !== "1") process.exit(0);

const ROOT = join(import.meta.dirname, "..");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(VITE)) {
  console.error("[probe] vite not found — run `npm ci`");
  process.exit(1);
}
console.log("[probe] building the runtime gate page");
execFileSync(process.execPath, [VITE, "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SARD_BUILD_TARGET: "probe" },
});
