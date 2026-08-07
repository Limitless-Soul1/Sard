// THE GATE — an artifact does not leave this machine until it has proved which kind it is.
//
//   node scripts/verify-artifact.mjs --kind=release --exe=src-tauri/target/release/Sard.exe
//   node scripts/verify-artifact.mjs --kind=diag    --exe=src-tauri/target/release/sard-diag.exe
//
// Exit 0 = the artifact IS what it claims. Any other exit = it is not, and nothing may ship.
//
// WHY THIS IS AN ARTIFACT CHECK AND NOT A SOURCE CHECK
// On 2026-08-07 a user ran a diagnostic build believing it was the public release. Every source-level
// intention was correct: no diagnostic file had ever been committed, CI had run once, and the
// published installer verified byte-for-byte against its minisign signature. The defect was that
// nothing ever asked the FINISHED FILE what it was. Intentions are not evidence. This asks the bytes.
//
// THE CANARY, AND WHY AN ABSENCE IS NOT AUTOMATICALLY GOOD NEWS
// An earlier attempt to tell Sard builds apart searched a Tauri installer for frontend strings and
// found none — in the diagnostic build OR the release. The conclusion "they are the same" was wrong:
// Tauri COMPRESSES the embedded web assets, so the search was reading nothing at all. A test that
// cannot fail is not a test.
//
// So before any absence is believed, this verifier proves the search WORKS on this exact file by
// requiring strings that every Sard build contains. If the canary is missing, the file is compressed,
// packed or unreadable, and the run FAILS as UNUSABLE rather than passing on a meaningless zero. That
// distinction — "clean" versus "I could not look" — is the whole reason this file exists.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { KINDS, extractBuildId, kindOf } from "./build-identity.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const REPO = resolve(import.meta.dirname, "..");
const problems = [];
const notes = [];
const ok = (m) => notes.push(`  PASS  ${m}`);
const bad = (m) => { problems.push(m); notes.push(`  FAIL  ${m}`); };

/** Count occurrences of `needle` in `buf`, in both plain and UTF-16LE encodings. */
function countIn(buf, needle) {
  let n = 0;
  for (const enc of ["latin1", "utf8", "utf16le"]) {
    const nb = Buffer.from(needle, enc);
    if (!nb.length) continue;
    let i = 0;
    while ((i = buf.indexOf(nb, i)) !== -1) { n++; i += nb.length; }
  }
  return n;
}

/**
 * The Windows VERSION RESOURCE of a PE file — the fields shown under Properties → Details.
 *
 * Returns null off Windows or if the resource cannot be read, and the caller reports that as
 * "not verified" rather than as a pass. A check that silently degrades into a pass is not a check.
 */
function peVersionInfo(file) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
       `$v=(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo; ` +
       `Write-Output ($v.ProductName + "\`n" + $v.ProductVersion + "\`n" + $v.FileVersion)`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split(/\r?\n/);
    return { ProductName: (out[0] || "").trim(), ProductVersion: (out[1] || "").trim(), FileVersion: (out[2] || "").trim() };
  } catch {
    return null;
  }
}

// Strings present in EVERY Sard executable regardless of kind. Their job is not to identify the
// build — it is to prove that string search can see inside this file at all.
const EXE_CANARIES = ["rustls", "sqlite3", "tauri"];
// The same idea for the web bundle: markers of ordinary product code, which is in both kinds.
const BUNDLE_CANARIES = ["foliate", "useReader", "epubcfi"];

function verifyBinary(kind, exePath) {
  const p = resolve(REPO, exePath);
  if (!existsSync(p)) return bad(`the executable does not exist: ${p}`);
  const buf = readFileSync(p);
  const mb = (statSync(p).size / 1048576).toFixed(1);
  notes.push(`  ---- executable: ${exePath} (${mb} MB) ----`);

  const canary = EXE_CANARIES.filter((c) => countIn(buf, c) > 0);
  if (!canary.length) {
    return bad(
      `UNUSABLE: none of the canaries ${EXE_CANARIES.join("/")} were found, so this file's strings ` +
        `cannot be read (packed or compressed?) and NO absence measured in it means anything`,
    );
  }
  ok(`the search can read this file (canaries found: ${canary.join(", ")})`);

  for (const m of kind.forbiddenMarkers) {
    const n = countIn(buf, m);
    if (n > 0) bad(`a ${kind.label} build contains the forbidden marker ${JSON.stringify(m)} (${n}x)`);
    else ok(`no diagnostic marker ${JSON.stringify(m)}`);
  }
  for (const m of kind.requiredMarkers) {
    const n = countIn(buf, m);
    if (n > 0) ok(`carries its required marker ${JSON.stringify(m)} (${n}x)`);
    else bad(`a ${kind.label} build is MISSING its required marker ${JSON.stringify(m)}`);
  }

  // IDENTITY comes from the PE VERSION RESOURCE, not from a string search.
  //
  // The first version of this check searched the bytes for "com.sard.diag" and reported it MISSING —
  // a false accusation against a build that was correct. The compiler had split the literal into
  // 8-byte MOV immediates ("com.sard" + "ard.diag"), and "1.1.0-diag" into "1.1.0-di" + "ag", so no
  // contiguous copy of either existed anywhere in the file. A search that cannot see the thing it is
  // looking for reports an absence, and an absence read as evidence is how this whole incident began.
  //
  // The version resource has none of that fragility: Windows writes it, Windows reads it, and it is
  // the same field a user sees under file Properties → Details. So the automated check and the check
  // a suspicious person can do by hand are now the SAME check.
  const info = peVersionInfo(p);
  if (!info) {
    notes.push("  NOTE  PE version resource unreadable (non-Windows host?) — identity not verified here");
  } else {
    notes.push(`  ---- version resource: ProductName=${JSON.stringify(info.ProductName)} ProductVersion=${JSON.stringify(info.ProductVersion)} ----`);
    if (info.ProductName === kind.productName) ok(`ProductName is ${JSON.stringify(kind.productName)}`);
    else bad(`ProductName is ${JSON.stringify(info.ProductName)} but this kind requires ${JSON.stringify(kind.productName)}`);

    // THE VERSION SUFFIX, checked generically across every kind rather than against a hardcoded
    // "-diag". With three kinds (release · beta · diag) a hardcoded suffix silently stopped checking
    // anything the moment a second suffixed kind existed: a BETA build with no `-beta` would have
    // passed, and a RELEASE carrying `-beta` would have passed too.
    const ver = String(info.ProductVersion || "");
    const wrongSuffix = Object.values(KINDS)
      .filter((k) => k.versionSuffix && k.id !== kind.id)
      .find((k) => ver.includes(k.versionSuffix));
    if (kind.versionSuffix && !ver.includes(kind.versionSuffix)) {
      bad(`a ${kind.label} build must carry a ${kind.versionSuffix} version; this one reports ${JSON.stringify(ver)}`);
    } else if (wrongSuffix) {
      bad(`this ${kind.label} artifact carries ${wrongSuffix.versionSuffix} — the version of a ${wrongSuffix.label} build`);
    } else if (!kind.versionSuffix && /-(beta|diag|alpha|rc)/i.test(ver)) {
      bad(`a plain RELEASE must carry no pre-release suffix; this one reports ${JSON.stringify(ver)}`);
    } else {
      ok(`ProductVersion ${JSON.stringify(ver)} matches this kind`);
    }

    // "Identifies as another kind" can only be judged on kinds that use a DIFFERENT product name.
    // Beta and release deliberately share "Sard" — that is the whole point of a Beta being the
    // product rather than a separate application — so comparing names alone would fail every Beta.
    const impostor = Object.values(KINDS)
      .find((k) => k.id !== kind.id && k.productName !== kind.productName && info.ProductName === k.productName);
    if (impostor) bad(`this artifact identifies as a different kind (${impostor.label})`);
  }

  // THE BUILD ID. An artifact that cannot say which build it is cannot be supported: every report it
  // produces starts with an unanswerable question, which is exactly the position the 2026-08-07
  // investigation was in. Its prefix is also a second, independent statement of the artifact's kind.
  const id = extractBuildId(buf);
  if (!id) {
    bad("carries NO build id — it was compiled outside the build scripts, so no report it produces can identify it");
  } else {
    const wantPrefix = { diag: "DIAG", beta: "BETA", release: "REL" }[kind.id];
    if (id.startsWith(wantPrefix)) ok(`carries a build id: ${id}`);
    else bad(`build id ${id} declares the wrong kind (expected a ${wantPrefix}- prefix)`);
  }

  // The updater endpoint is the difference between "a diagnostic build someone ran once" and "a
  // diagnostic build that installed itself permanently and then reported itself up to date".
  const endpoint = "releases/latest/download/latest.json";
  const hasEndpoint = countIn(buf, endpoint) > 0;
  if (kind.updater && !hasEndpoint) bad("a RELEASE build has no updater endpoint — existing installs would never see an update");
  else if (!kind.updater && hasEndpoint) bad("a DIAGNOSTIC build carries the PUBLIC updater endpoint — it could install itself over a real Sard");
  else ok(kind.updater ? "carries the public updater endpoint (release)" : "carries NO updater endpoint (diagnostic)");
}

function verifyBundle(kind, distDir) {
  const dir = resolve(REPO, distDir, "assets");
  if (!existsSync(dir)) return bad(`no web bundle at ${dir} — run the frontend build first`);
  const js = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => resolve(dir, f));
  if (!js.length) return bad(`no .js in ${dir}`);
  const buf = Buffer.concat(js.map((f) => readFileSync(f)));
  notes.push(`  ---- web bundle: ${js.length} file(s), ${(buf.length / 1024).toFixed(0)} KB ----`);

  const canary = BUNDLE_CANARIES.filter((c) => countIn(buf, c) > 0);
  if (!canary.length) return bad(`UNUSABLE: no canary found in the web bundle — an absence here would mean nothing`);
  ok(`the search can read the web bundle (canaries: ${canary.join(", ")})`);

  // Validated 2026-08-07 by building both kinds and measuring: release 0 / diag 2, 5, 3 respectively.
  // ONE KIND CARRIES INSTRUMENTATION; EVERY OTHER KIND MUST NOT.
  //
  // This used to branch on `release` and `diag` by name, so when `beta` was added it matched neither
  // and fell through to the `else` — which reports a PASS and, worse, printed "web bundle carries
  // __sardDiag" while asserting nothing at all. A Beta could have shipped the entire diagnostic
  // frontend and this would have said VERIFIED. It is the third check in this file to fail OPEN when
  // a third kind appeared, which is a pattern rather than an accident: a rule written as "if A … else
  // if B …" quietly stops covering anything the moment a C exists.
  //
  // Phrased as a property of the KIND instead: diagnostics belong to diagnostic builds, full stop.
  const FRONTEND_DIAG = ["__sardDiag", "diagStart", "NOT ENTERED"];
  const mustCarry = kind.id === "diag";
  for (const m of FRONTEND_DIAG) {
    const n = countIn(buf, m);
    if (!mustCarry && n > 0) bad(`the ${kind.label} web bundle contains ${JSON.stringify(m)} (${n}x) — the diagnostic modules were not substituted`);
    else if (mustCarry && n === 0) bad(`the ${kind.label} web bundle is missing ${JSON.stringify(m)} — its instrumentation did not make it in`);
    else ok(`web bundle ${mustCarry ? "carries" : "free of"} ${JSON.stringify(m)}`);
  }
}

// ---- run ---------------------------------------------------------------------------------------
let kind;
try {
  kind = kindOf(args.kind);
} catch (e) {
  console.error(`\nverify-artifact: ${e.message}\n`);
  process.exit(2);
}

console.log(`\nVERIFYING that this artifact is: ${kind.label}\n`);
if (args.exe) verifyBinary(kind, args.exe);
const skipDist = args.dist === false || args.dist === "false" || args.dist === "no";
if (!skipDist) verifyBundle(kind, typeof args.dist === "string" ? args.dist : "dist");
if (!args.exe) notes.push("  NOTE  no --exe given; only the web bundle was checked");

console.log(notes.join("\n"));
if (problems.length) {
  console.error(
    `\n  ARTIFACT REJECTED — ${problems.length} problem(s):\n` +
      problems.map((p) => `    - ${p}`).join("\n") +
      `\n\n  Nothing may be packaged, uploaded or shared from this build.\n`,
  );
  process.exit(1);
}
console.log(`\n  VERIFIED: this artifact is ${kind.label}, and is safe to package under that name.\n`);
