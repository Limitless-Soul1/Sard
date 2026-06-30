// Copy the freshly built standalone release binary to a stable, easy-to-launch location
// (test-build/Sard.exe) so the owner always double-clicks the same path and each rebuild
// overwrites it. Run automatically by `npm run build:test` (RAWY-35). No dev server needed
// to RUN the result — the release binary embeds the frontend (tauri frontendDist = ../dist).
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src-tauri/target/release/sard.exe");
const outDir = resolve(root, "test-build");
const dest = resolve(outDir, "Sard.exe");

if (!existsSync(src)) {
  console.error(`Release binary not found: ${src}\nRun the release build first ('npm run tauri build').`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
const mb = (statSync(dest).size / 1048576).toFixed(1);
console.log(`Copied release binary -> ${dest} (${mb} MB). Launch it directly; no dev server needed.`);
