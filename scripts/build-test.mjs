// One-command TEST build (RAWY-TOOLING). Runs the whole thing in ONE process, on purpose: the cargo PATH
// fallback below has to be in effect when `tauri build` runs, and a shell `a && b && c` chain can't share
// an env change between steps — so this orchestrator replaced that chain.
//
// Steps: cargo preflight (+ standard rustup fallback) -> close any running Sard -> `tauri build
// --no-bundle` -> copy the exe into test-build\.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, delimiter } from "node:path";
import { buildId, kindOf } from "./build-identity.mjs";

const root = resolve(import.meta.dirname, "..");
const step = (cmd) => {
  try {
    execSync(cmd, { stdio: "inherit", cwd: root, env: process.env });
  } catch {
    process.exit(1); // the child already printed its own error above — don't dump a Node stack on top
  }
};

// ---- cargo preflight --------------------------------------------------------------------------------
// Tauri shells out to `cargo`, so cargo MUST be resolvable. rustup normally puts it on PATH via
// %USERPROFILE%\.cargo\bin, but if a shell didn't pick that up, `tauri build` dies with an opaque
// "failed to run 'cargo metadata' ... program not found". Detect that up front, fall back to the STANDARD
// rustup location, and if cargo is truly nowhere, fail with a one-line, actionable message.
function cargoOnPath() {
  try {
    execSync(process.platform === "win32" ? "where cargo" : "command -v cargo", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!cargoOnPath()) {
  const cargoHome = process.env.CARGO_HOME || resolve(process.env.USERPROFILE || process.env.HOME || "", ".cargo");
  const binDir = resolve(cargoHome, "bin");
  const cargoExe = resolve(binDir, process.platform === "win32" ? "cargo.exe" : "cargo");
  if (existsSync(cargoExe)) {
    process.env.PATH = binDir + delimiter + (process.env.PATH || "");
    console.log(`[Sard] cargo isn't on your PATH — using the rustup default "${binDir}" for this build.`);
    console.log(`[Sard] To fix it for every shell: add "${binDir}" to your PATH, then open a NEW terminal.`);
  } else {
    console.error(
      "\n[Sard] BUILD ABORTED — Rust/cargo not found on PATH.\n" +
      "  Install Rust from https://rustup.rs, or add  %USERPROFILE%\\.cargo\\bin  to your PATH,\n" +
      "  then open a NEW terminal and re-run  npm run build:test .\n" +
      `  (checked PATH and the rustup default: ${cargoExe})`,
    );
    process.exit(1);
  }
}

// ---- tests ------------------------------------------------------------------------------------------
// RESILIENCE-1 / WP-0: the everyday loop runs the unit + fixture + corpus-definition suite BEFORE
// spending two minutes on a Rust build. These are fast (~0.6 s) and pure — they launch nothing and
// touch no profile. The slower end-to-end checks stay opt-in and are run per work package rather
// than per build, because they drive the real application and need a built binary.
step("npm test"); // typechecks tests/ then runs the suite

// ---- build ------------------------------------------------------------------------------------------
// THE BUILD ID, generated once here and handed to both halves: build.rs re-emits it for Rust, Vite
// defines it for the frontend. Set BEFORE the build so both pick up the same value in one pass — a
// second call would produce a second timestamp and a permanent, meaningless "MISMATCH" in every
// report. This is a test build, so it is stamped REL like any non-diagnostic build; the id records
// the git sha plus the number of uncommitted paths, which is the honest description of a tree Sard
// actually builds from.
process.env.SARD_BUILD_ID = buildId(kindOf("release"), { cwd: root });
console.log(`[Sard] BUILD ID  ${process.env.SARD_BUILD_ID}`);

step("node scripts/kill-sard.mjs");    // close any running Sard (incl. Sard-standalone) or abort loudly
step("npx tauri build --no-bundle");   // fast standalone release, NO installer (Share needs the FULL build)
step("node scripts/copy-release.mjs"); // copy Sard.exe into test-build\
