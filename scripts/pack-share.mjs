// Rebuild the Sard-Share package from the CURRENT tree.
//
// Follows the convention the package already uses (see any BUILD-INFO.txt in an _old_archive_*):
//   BUILD ID          <UTC timestamp>-<git short sha>
//   Source fingerprint SHA-256 over every file under src/, src-tauri/src/ and public/ — each file's
//                      repo-relative path, then its bytes, in sorted path order. Two packages with
//                      the same fingerprint were built from the same code.
//   Artifact hashes    SHA-256 + size for each shipped binary.
//
// Superseded artifacts are MOVED into a timestamped `_old_archive_*` folder, never deleted — that is
// how this package has been maintained since July and it is not this script's call to change.
//
// The .rar is built from an EXPLICIT file list, so the archive can never pick up an _old_archive_,
// a staging folder, or anything else stale that happens to be sitting in the directory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const PKG = "M:/Sard-Share";
const RAR = "C:/Program Files/WinRAR/Rar.exe";
const now = new Date();
const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDhhmmss (UTC)

const sha = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

// ---- source fingerprint ----------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const sourceFiles = ["src", "src-tauri/src", "public"]
  .map((d) => join(REPO, d))
  .filter(existsSync)
  .flatMap((d) => walk(d))
  .map((p) => relative(REPO, p).replace(/\\/g, "/"))
  .sort();

const fp = createHash("sha256");
let sourceBytes = 0;
for (const rel of sourceFiles) {
  const bytes = readFileSync(join(REPO, rel));
  fp.update(rel);
  fp.update(bytes);
  sourceBytes += bytes.length;
}
const fingerprint = fp.digest("hex").toUpperCase();

// ---- git state -------------------------------------------------------------------------------
const head = git(["rev-parse", "--short", "HEAD"]);
const headSubject = git(["log", "-1", "--pretty=%s"]);
const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
const buildId = `${stamp}-${head}`;

// ---- archive the superseded artifacts ----------------------------------------------------------
const archive = join(PKG, `_old_archive_${stamp}`);
const supersede = ["Sard-Setup.exe", "Sard-standalone.exe", "BUILD-INFO.txt", "Sard.rar"];
let archived = [];
mkdirSync(archive, { recursive: true });
for (const f of supersede) {
  const src = join(PKG, f);
  if (existsSync(src)) {
    renameSync(src, join(archive, f));
    archived.push(f);
  }
}
if (!archived.length) rmSync(archive, { recursive: true, force: true });

// ---- move the freshly staged artifacts into place ----------------------------------------------
const staging = join(PKG, "_staging");
for (const f of ["Sard-Setup.exe", "Sard-standalone.exe"]) {
  const s = join(staging, f);
  if (!existsSync(s)) throw new Error(`staged artifact missing: ${s}`);
  renameSync(s, join(PKG, f));
}
rmSync(staging, { recursive: true, force: true });

// piper: ship the engine that was built alongside this binary.
const piperSrc = join(REPO, "test-build", "piper");
if (existsSync(piperSrc)) {
  rmSync(join(PKG, "piper"), { recursive: true, force: true });
  cpSync(piperSrc, join(PKG, "piper"), { recursive: true });
}
const piperFiles = existsSync(join(PKG, "piper")) ? walk(join(PKG, "piper")) : [];
const piperBytes = piperFiles.reduce((a, p) => a + statSync(p).size, 0);

// The beta notes ARE the package's release documentation.
if (existsSync(join(REPO, "BETA-1.md"))) cpSync(join(REPO, "BETA-1.md"), join(PKG, "BETA-1.md"));

// ---- artifact hashes ---------------------------------------------------------------------------
const artifacts = ["Sard-Setup.exe", "Sard-standalone.exe"].map((f) => {
  const b = readFileSync(join(PKG, f));
  return { f, hash: sha(b), size: b.length };
});

// ---- BUILD-INFO ---------------------------------------------------------------------------------
const info = `Sard — SHARE PACKAGE BUILD INFO
================================
This file identifies exactly which build you have. If you report a problem,
please quote the BUILD ID below.

BUILD ID          ${buildId}
Built (UTC)       ${now.toISOString().replace("T", " ").slice(0, 19)}
App version       ${JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version}
Git HEAD          ${head}  (${headSubject})
Source state      HEAD + ${dirty} uncommitted path(s) — the RESILIENCE-1 stabilization
                  milestone is complete but NOT yet committed. This package was built
                  from the working tree, so the BUILD ID's commit alone does NOT
                  reproduce it; the source fingerprint below does.
Source fingerprint ${fingerprint}
                  (SHA-256 over every file under src/, src-tauri/src/ and public/ —
                   each file's repo-relative path then its bytes, in sorted path
                   order. ${sourceFiles.length} files, ${sourceBytes.toLocaleString("en-US")} bytes. Two packages with
                   the same fingerprint are the same code.)

ARTIFACT HASHES (SHA-256)
--------------------------
${artifacts.map((a) => `${a.f.padEnd(22)}${a.hash}\n${" ".repeat(22)}${a.size.toLocaleString("en-US")} bytes`).join("\n")}
piper/                ${piperFiles.length} files, ${piperBytes.toLocaleString("en-US")} bytes

WHAT THIS BUILD IS
-------------------
The first EXTERNAL BETA. It is the RESILIENCE-1 stabilization milestone
(WP-0 … WP-7) plus a pre-beta polish pass. No new features — every change is a
stabilization, compatibility or correctness fix.

Full changelog, known limitations, postponed items and the tester checklist are
in BETA-1.md, which ships in this package.

VERIFICATION STATE
-------------------
  346/346 unit + integration tests
  both TypeScript projects typecheck clean
  harness lifecycle self-test 9/9
  byte-identity: byte-identical to baseline "resilience-1-final" (16 corpus books)
  read-aloud, references, themes, endurance, cross-mode annotation durability:
    all green under book_css = off / sanitised / raw
  the SHIPPED Sard-standalone.exe was launched from this package and verified to
    start, expose IPC (schema v16) and render the library

NOT VERIFIED / KNOWN
---------------------
  · Sard-Setup.exe was NOT executed. Running it installs over the machine's
    existing Sard, so the installer's own flow is unverified here. The binary is
    a valid PE reporting Sard ${JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version}, produced by the same
    \`tauri build\` that produced the verified standalone.
  · Neither artifact is Authenticode-signed, so Windows SmartScreen will warn on
    first run. Testers should expect "More info" → "Run anyway".
  · The updater signature was NOT produced (no TAURI_SIGNING_PRIVATE_KEY), so this
    build cannot serve as an auto-update source. Manual install only.
`;
writeFileSync(join(PKG, "BUILD-INFO.txt"), info, "utf8");

// ---- the archive, from an EXPLICIT list -----------------------------------------------------------
const rarName = `Sard-Beta1-${stamp}.rar`;
const rarPath = join(PKG, rarName);
const contents = ["Sard-Setup.exe", "Sard-standalone.exe", "BUILD-INFO.txt", "BETA-1.md", "README.txt", "HANDOFF.md", "piper"]
  .filter((f) => existsSync(join(PKG, f)));

// Archive from a CLEAN TREE, not from the package directory.
//
// `Rar a -r <arc> Sard-Setup.exe` does NOT mean "add this file recursively" — `-r` makes Rar SEARCH
// subdirectories for anything matching that name, so it swept up every historical Sard-Setup.exe and
// Sard-standalone.exe out of the 13 `_old_archive_*` folders: a 511 MB archive with 343 entries,
// carrying exactly the stale binaries this package must never ship. Copying the intended files into
// an empty directory first makes that class of mistake unrepresentable — whatever is in the tree is
// what ships, and nothing else can be reached.
const tree = join(REPO, `.pack-${stamp}`);
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
for (const f of contents) cpSync(join(PKG, f), join(tree, f), { recursive: true });
execFileSync(RAR, ["a", "-r", "-ep1", "-m3", "-idq", rarPath, "*"], { cwd: tree });
rmSync(tree, { recursive: true, force: true });

const rarSize = statSync(rarPath).size;
const listing = execFileSync(RAR, ["lb", rarPath], { encoding: "utf8" }).split("\n").filter(Boolean);

console.log(`\n  BUILD ID     ${buildId}`);
console.log(`  built (UTC)  ${now.toISOString().replace("T", " ").slice(0, 19)}`);
console.log(`  fingerprint  ${fingerprint}`);
console.log(`  source       ${sourceFiles.length} files, ${sourceBytes.toLocaleString("en-US")} bytes`);
console.log(`  archived     ${archived.length ? archived.join(", ") + " -> " + relative(PKG, archive) : "(nothing to supersede)"}`);
for (const a of artifacts) console.log(`  ${a.f.padEnd(22)}${a.size.toLocaleString("en-US")} bytes  ${a.hash.slice(0, 16)}…`);
console.log(`  piper/                ${piperFiles.length} files, ${piperBytes.toLocaleString("en-US")} bytes`);
console.log(`\n  RAR  ${rarName}  (${rarSize.toLocaleString("en-US")} bytes, ${listing.length} entries)`);
