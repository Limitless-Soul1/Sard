// Copy the freshly built standalone release binary to a stable, easy-to-launch location
// (test-build/Sard.exe) so the owner always double-clicks the same path and each rebuild
// overwrites it. Run automatically by `npm run build:test` (RAWY-35). No dev server needed
// to RUN the result — the release binary embeds the frontend (tauri frontendDist = ../dist).
//
// RAWY-47: a running Sard.exe locks test-build\Sard.exe on Windows, so copyFileSync throws
// EBUSY/EPERM and the OLD binary silently stays in place — a "stale build" that looks rebuilt
// but runs old code (this is the most likely cause of the RAWY-46 "Rows toggle does nothing"
// report: the release binary tested was not actually the new one). Guard against it: close any
// running copy first, then FAIL LOUDLY if the overwrite still can't happen — never leave a
// stale binary masquerading as a fresh build.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src-tauri/target/release/sard.exe");
const outDir = resolve(root, "test-build");
const dest = resolve(outDir, "Sard.exe");

if (!existsSync(src)) {
  console.error(`Release binary not found: ${src}\nRun the release build first ('npm run tauri build').`);
  process.exit(1);
}

// Close any running instance so the fresh binary can overwrite test-build\Sard.exe.
if (process.platform === "win32") {
  try { execSync("taskkill /IM Sard.exe /F", { stdio: "ignore" }); } catch { /* not running */ }
  try { execSync("taskkill /IM sard.exe /F", { stdio: "ignore" }); } catch { /* not running */ }
}

mkdirSync(outDir, { recursive: true });
try {
  copyFileSync(src, dest);
} catch (e) {
  console.error(
    `\n[Sard] FAILED to overwrite ${dest} (${e.code || e.message}).\n` +
    `A running copy is still locking it. Close every Sard.exe and re-run 'npm run build:test'.\n` +
    `IMPORTANT: the app at ${dest} is STALE (old code) — do not test it.`,
  );
  process.exit(1);
}

// Prove freshness: the copied binary must match the just-built source (mtime + size), so a
// stale leftover can't be mistaken for the new build.
const s = statSync(src), d = statSync(dest);
if (d.size !== s.size) {
  console.error(`\n[Sard] Copy size mismatch (${d.size} != ${s.size}) — ${dest} may be stale. Re-run the build.`);
  process.exit(1);
}
const mb = (d.size / 1048576).toFixed(1);
console.log(`Copied fresh release binary -> ${dest} (${mb} MB, built ${s.mtime.toISOString()}). Launch it directly; no dev server needed.`);
