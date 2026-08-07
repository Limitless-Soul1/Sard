// Package a BETA build as a ZIP containing ONE installer, for external testers.
//
//   npm run pack:beta            # uses the version already in tauri.beta.conf.json
//
// EXPECTED OUTPUT
//   M:/Sard-Beta/Sard-BETA-<stamp>-<sha>.zip
//     └── Sard-BETA-Setup.exe
//
// A Beta is THE PRODUCT, MARKED — not a separate application. Same product name, same executable,
// same bundle identifier, so it replaces a tester's Sard and they keep reading their own library.
// What differs is that it says so, in the two places a person looks: the window title reads
// "Sard — BETA" and the version carries `-beta`.
//
// ⚠ BEFORE EACH BETA, BUMP THE PRE-RELEASE NUMBER in src-tauri/tauri.beta.conf.json
// (1.2.0-beta.1 → 1.2.0-beta.2 …). Two Betas sharing a version cannot be told apart by a tester, and
// the updater cannot order them. The base version must also stay ABOVE the published release: the
// updater compares semver, and `1.1.0-beta.1` is LOWER than the published `1.1.0`, so it would have
// offered every tester an "update" back to the public build and quietly pulled them off the Beta.
//
// The build itself is NOT run here — it is run deliberately, with its own build id:
//
//   SARD_BUILD_ID=BETA-$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD) \
//     npx tauri build --config src-tauri/tauri.beta.conf.json
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractBuildId, kindOf } from "./build-identity.mjs";

const REPO = resolve(import.meta.dirname, "..");
const OUT = "M:/Sard-Beta";
const NSIS_DIR = join(REPO, "src-tauri/target/release/bundle/nsis");
const EXE = join(REPO, "src-tauri/target/release/sard.exe");
const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();

if (!existsSync(EXE)) { console.error(`\n  no build at ${EXE}\n`); process.exit(1); }

// THE GATE. Verifies BEFORE anything is staged, and its exit code stops the script: a Beta that
// carries instrumentation, or the wrong version suffix, or no build id, never reaches a tester.
console.log("Verifying the binary before packaging anything…\n");
execFileSync(process.execPath,
  [join(REPO, "scripts/verify-artifact.mjs"), "--kind=beta", "--exe=src-tauri/target/release/sard.exe", "--dist=false"],
  { cwd: REPO, stdio: "inherit" });

const setupSrc = existsSync(NSIS_DIR)
  ? readdirSync(NSIS_DIR).filter((f) => f.endsWith("-setup.exe")).map((f) => join(NSIS_DIR, f))[0]
  : null;
if (!setupSrc) {
  console.error(`\n  no NSIS installer in ${NSIS_DIR}\n  build WITHOUT --no-bundle so the installer is produced.\n`);
  process.exit(1);
}

const kind = kindOf("beta");
const buildId = extractBuildId(readFileSync(EXE));
if (!buildId) { console.error("\n  the binary carries no BUILD ID — rebuild with SARD_BUILD_ID set.\n"); process.exit(1); }
if (!buildId.startsWith("BETA-")) {
  console.error(`\n  build id ${buildId} is not a BETA id — rebuild with SARD_BUILD_ID=BETA-...\n`);
  process.exit(1);
}

// Stage into an EMPTY directory rather than zipping a folder in place: pack-share.mjs records the run
// where archiving by pattern swept 511 MB of stale binaries out of sibling folders. What is not
// deliberately staged cannot ship by accident — and this ZIP must contain exactly one file.
const stamp = buildId.split("-")[1];
const short = buildId.split("-")[2];
const stage = join(OUT, `stage-beta-${stamp}`);
mkdirSync(OUT, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const setupBytes = readFileSync(setupSrc);
writeFileSync(join(stage, kind.setupName), setupBytes);

const zipPath = join(OUT, `Sard-BETA-${stamp}-${short}.zip`);
rmSync(zipPath, { force: true });
execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`],
  { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

const zipBytes = readFileSync(zipPath);
console.log(`\n  BETA PACKAGE READY\n`);
console.log(`    zip        ${zipPath}`);
console.log(`    contains   ${kind.setupName}   (one file, nothing else)`);
console.log(`    zip size   ${(zipBytes.length / 1048576).toFixed(1)} MB`);
console.log(`    zip sha256 ${sha(zipBytes)}`);
console.log(`    exe sha256 ${sha(setupBytes)}`);
console.log(`    build id   ${buildId}\n`);
console.log(`  Testers will see:  window title "Sard — BETA",  version ${JSON.parse(readFileSync(join(REPO, "src-tauri/tauri.beta.conf.json"), "utf8")).version}\n`);
