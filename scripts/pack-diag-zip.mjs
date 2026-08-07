// Package the DIAGNOSTIC build as a SELF-CONTAINED ZIP for a tester.
//
//   node scripts/pack-diag-zip.mjs
//
// A ZIP, deliberately, and NOT an installer. An installer is the shape that caused the 2026-08-07
// incident: it writes into the system, it can land on top of a real Sard, and once it has run there
// is nothing left on disk that says which build the person is actually running. A folder they
// extract and delete does none of that — it is reversible by dragging it to the bin.
//
// The identity work this depends on (scripts/build-identity.mjs) means the package cannot be
// confused with a release: different product name, different executable name, different bundle
// identifier and therefore a different profile, no updater at all, and a filename that carries its
// kind and its build stamp so it stays self-describing after any number of copies and downloads.
//
// NOTHING IS PACKAGED THAT HAS NOT BEEN VERIFIED. `verify-artifact.mjs` runs first and its exit code
// gates the whole script: it reads the PE version resource, requires the instrumentation markers,
// and refuses an executable carrying the public updater endpoint. A package built from an
// unverified binary is exactly the thing this pipeline exists to prevent.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { extractBuildId, kindOf, utcStamp } from "./build-identity.mjs";

const REPO = resolve(import.meta.dirname, "..");
const OUT = "M:/Sard-Diagnostic";
const EXE_SRC = join(REPO, "src-tauri/target/release/sard-diag.exe");
// The name the tester double-clicks. Spelled the way the app identifies itself, so the file, the
// window title, the Task Manager entry and Properties → Details all say the same thing.
const EXE_NAME = "Sard Diagnostic.exe";
const PIPER_SRC = join(REPO, "test-build", "piper");

const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();
const git = (a) => { try { return execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim(); } catch { return ""; } };
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
};

if (!existsSync(EXE_SRC)) {
  console.error(`\n  no diagnostic binary at ${EXE_SRC}\n  build it first:\n` +
    `    SARD_BUILD_KIND=diag SARD_BUILD_ID=DIAG-... npx tauri build --config src-tauri/tauri.diag.conf.json --features diag --no-bundle\n`);
  process.exit(1);
}

// ---- THE GATE, before anything is staged -------------------------------------------------------
console.log("Verifying the binary before packaging anything…\n");
execFileSync(process.execPath, [join(REPO, "scripts/verify-artifact.mjs"), "--kind=diag",
  "--exe=src-tauri/target/release/sard-diag.exe", "--dist=false"], { cwd: REPO, stdio: "inherit" });

const kind = kindOf("diag");
const exeBytes = readFileSync(EXE_SRC);
const buildId = extractBuildId(exeBytes);
if (!buildId) {
  console.error("\n  the binary carries no BUILD ID — rebuild with SARD_BUILD_ID set.\n");
  process.exit(1);
}
const stamp = utcStamp();
const zipName = `Sard-DIAG-${stamp}.zip`;
const stageDir = join(OUT, `stage-${stamp}`);

// ---- stage into an EMPTY directory --------------------------------------------------------------
// Copying the intended files into a clean directory first, rather than zipping a folder in place, is
// the lesson pack-share.mjs records: archiving by pattern once swept 511 MB of stale binaries out of
// sibling folders. What is not deliberately staged cannot be shipped by accident.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
writeFileSync(join(stageDir, EXE_NAME), exeBytes);

// Piper is the bundled read-aloud engine. `--no-bundle` produces a bare executable, so anything the
// app expects beside it has to be staged by hand — without this the tester gets a build whose
// read-aloud fails for a packaging reason and reports it as a bug.
let piperFiles = 0, piperBytes = 0;
if (existsSync(PIPER_SRC)) {
  cpSync(PIPER_SRC, join(stageDir, "piper"), { recursive: true });
  for (const f of walk(join(stageDir, "piper"))) { piperFiles++; piperBytes += statSync(f).size; }
} else {
  console.warn(`\n  ⚠ no piper engine at ${PIPER_SRC} — read-aloud will not work in this package.`);
}

// ---- README -------------------------------------------------------------------------------------
writeFileSync(join(stageDir, "README.txt"), `SARD DIAGNOSTIC BUILD — FOR TESTING ONLY
==============================================================================

WHAT THIS IS
  A DIAGNOSTIC (laboratory) build of Sard. It is instrumented to record evidence
  about problems we cannot reproduce on our own machines.

  It is NOT a production build.
  It is NOT the app you should read books with day to day.
  Please do NOT share or redistribute it.

HOW TO RUN IT
  1. Extract this ZIP anywhere you like (Desktop is fine).
  2. Run "${EXE_NAME}".

  There is no installer and nothing is installed. To remove it, delete the
  extracted folder.

IT WILL NOT TOUCH YOUR NORMAL SARD
  This build has its own identity and its own separate storage:

    name        Sard Diagnostic      (the normal app is "Sard")
    version     1.1.0-diag           (the normal app is 1.1.0)
    storage     %APPDATA%\\com.sard.diag
                (the normal app uses %APPDATA%\\com.sard.app — untouched)

  It cannot install itself, cannot update itself, and cannot replace or modify a
  normal Sard installation. You can run it with Sard installed; they do not see
  each other.

  Because its storage is separate, its library starts EMPTY. Please import the
  book you are reproducing the problem with.

WHAT IT RECORDS
  A diagnostic timeline, written only when you ask for it. Nothing is sent
  anywhere — it writes files to your Documents folder and you choose what to send.

  To export a report:
    * click the red EXPORT button at the bottom-left of any screen, or
    * press Ctrl+Shift+D

  Reports are written to:  Documents\\Sard Diagnostics

WHEN YOU REPORT A PROBLEM
  Please send the exported .txt file, and quote this line from BUILD-INFO.txt:

    BUILD ID   ${buildId}

  That tells us exactly which build produced the report, which is the first thing
  we need to know and the thing we have most often been missing.

REQUIREMENTS
  Windows 10 or 11 with the Microsoft Edge WebView2 runtime, which is present by
  default on up-to-date Windows. If the window opens empty, that runtime is
  missing or out of date.
`);

// ---- BUILD-INFO ---------------------------------------------------------------------------------
const head = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
const srcFiles = ["src", "src-tauri/src", "public"].map((d) => join(REPO, d)).filter(existsSync)
  .flatMap((d) => walk(d)).map((p) => relative(REPO, p).replace(/\\/g, "/")).sort();
const fp = createHash("sha256");
let srcBytes = 0;
for (const rel of srcFiles) { const b = readFileSync(join(REPO, rel)); fp.update(rel); fp.update(b); srcBytes += b.length; }

writeFileSync(join(stageDir, "BUILD-INFO.txt"), `SARD — DIAGNOSTIC PACKAGE BUILD INFO
==============================================================================
This file identifies exactly which build you have. If you report a problem,
please quote the BUILD ID below.

BUILD ID           ${buildId}
Packaged (UTC)     ${new Date().toISOString().replace("T", " ").slice(0, 19)}
Kind               ${kind.label}
Product name       ${kind.productName}
Executable         ${EXE_NAME}
Bundle identifier  ${kind.identifier}      (the release build uses com.sard.app)
Version            1.1.0${kind.versionSuffix}
Updater            NONE — this build cannot install or update anything
Git HEAD           ${head}${dirty ? `  (+ ${dirty} uncommitted path(s))` : ""}

Source fingerprint ${fp.digest("hex").toUpperCase()}
                   (SHA-256 over every file under src/, src-tauri/src/ and
                    public/ — each file's repo-relative path then its bytes, in
                    sorted path order. ${srcFiles.length} files, ${srcBytes.toLocaleString("en-US")} bytes.
                    Two packages with the same fingerprint are the same code.)

ARTIFACT HASHES (SHA-256)
--------------------------
${EXE_NAME.padEnd(22)} ${sha(exeBytes)}
${" ".repeat(22)} ${exeBytes.length.toLocaleString("en-US")} bytes
piper/                 ${piperFiles} files, ${piperBytes.toLocaleString("en-US")} bytes

VERIFICATION PERFORMED BEFORE PACKAGING
----------------------------------------
scripts/verify-artifact.mjs --kind=diag  passed. It read the executable's PE
version resource and confirmed:

  * it identifies as "Sard Diagnostic", NOT "Sard"
  * its version carries the -diag suffix
  * it carries the diagnostic instrumentation markers
  * it carries NO updater endpoint, so it cannot install itself over anything
  * it carries a real BUILD ID

The verifier also proves it can READ the file (canary strings) before believing
any absence, so a "clean" result cannot come from an unreadable binary.

WHY A ZIP AND NOT AN INSTALLER
-------------------------------
An installer writes into the system and can land on top of a real Sard. This
package is extracted and deleted. Combined with the separate bundle identifier,
a diagnostic build cannot replace, modify or be mistaken for the production app.
`);

// ---- zip ------------------------------------------------------------------------------------------
const zipPath = join(OUT, zipName);
rmSync(zipPath, { force: true });
execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`],
  { stdio: "inherit" });
rmSync(stageDir, { recursive: true, force: true });

const zipBytes = readFileSync(zipPath);
console.log(`\n  PACKAGE READY\n`);
console.log(`    file      ${zipPath}`);
console.log(`    size      ${(zipBytes.length / 1048576).toFixed(1)} MB`);
console.log(`    sha256    ${sha(zipBytes)}`);
console.log(`    build id  ${buildId}\n`);
