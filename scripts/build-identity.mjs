// THE BUILD IDENTITY REGISTER — one definition of what a Sard build IS.
//
// WHY THIS FILE EXISTS
// On 2026-08-07 a user downloaded a diagnostic build believing it was the public release. The
// investigation cleared GitHub entirely: the published installer verified byte-for-byte against its
// minisign signature, CI had run exactly once, and no diagnostic source had ever been committed. The
// build reached them through a stale Google Drive link that newer diagnostic uploads had landed in.
//
// The channel was the delivery, but it was not the DEFECT. The defect was that the two builds were
// indistinguishable once separated from the folder they were built into:
//
//     installer filename   Sard-Setup.exe    ==   Sard-Setup.exe
//     productName          Sard              ==   Sard
//     version              1.1.0             ==   1.1.0
//     identifier           com.sard.app      ==   com.sard.app
//     updater endpoint     public GitHub     ==   public GitHub
//
// Every one of those is a chance to notice, and every one of them was spent. A diagnostic build
// installed OVER the release, into the same directory, under the same name, sharing its profile, and
// then told the updater it was current — so nothing would ever repair it. The same collision, running
// the other way, is why a tester once installed the diagnostic package and got a build with no
// diagnostics in it: two files called Sard-Setup.exe cannot be told apart by anyone, in either
// direction.
//
// So identity is no longer a folder convention. It is data, here, read by the packaging scripts, the
// Tauri config overlay, and the verifier that refuses to let a mislabelled artifact leave the machine.
// A safeguard that depends on remembering is not a safeguard.

/**
 * The two — and only two — kinds of build this project produces.
 *
 * `markers` are the strings the VERIFIER looks for in the compiled binary. They are Rust string
 * literals and command names, which live uncompressed in the executable's read-only data. That
 * matters: an earlier attempt to tell builds apart by searching for FRONTEND strings found nothing in
 * either, because Tauri compresses the embedded web assets. A discriminator that has not been
 * validated against a known-positive is not evidence, so `verify-artifact.mjs` proves each marker
 * fires on the build that should have it before it trusts an absence anywhere else.
 */
export const KINDS = {
  release: {
    id: "release",
    label: "PUBLIC RELEASE",
    productName: "Sard",
    mainBinaryName: "Sard",
    identifier: "com.sard.app",
    versionSuffix: "",
    // The public update channel. Only a release build may carry it: an updater inside a diagnostic
    // build is a diagnostic build that can silently become permanent.
    updater: true,
    // A release must contain NONE of these. The check is an assertion about the artifact, not about
    // anyone's intent when they started the build.
    forbiddenMarkers: [
      "FRONTEND HANDSHAKE",
      "ENTIRELY OLDER THAN",
      "diag_startup_mark",
      "diag_probe_assets",
      "SARD DIAGNOSTIC BUILD",
    ],
    requiredMarkers: [],
    // Artifact names. `Sard-Setup.exe` keeps the name every existing download link already uses.
    setupName: "Sard-Setup.exe",
    standaloneName: "Sard-standalone.exe",
    tauriConfigOverlay: null, // the base tauri.conf.json IS the release identity
    cargoFeatures: [],
  },

  diag: {
    id: "diag",
    label: "DIAGNOSTIC (NEVER FOR RELEASE)",
    productName: "Sard Diagnostic",
    mainBinaryName: "sard-diag",
    identifier: "com.sard.diag",
    versionSuffix: "-diag",
    updater: false,
    forbiddenMarkers: [],
    // A diagnostic build that has lost its instrumentation is the tester's wasted week that started
    // this whole investigation. It must PROVE it is instrumented, not merely claim it.
    requiredMarkers: ["FRONTEND HANDSHAKE", "diag_startup_mark", "SARD DIAGNOSTIC BUILD"],
    // Deliberately unlike the release name in a way that survives being copied, renamed by a browser,
    // or listed in a cloud folder next to it. The date stamp is filled in by the packaging script.
    setupName: "Sard-DIAG-{stamp}-Setup.exe",
    standaloneName: "sard-diag-{stamp}.exe",
    tauriConfigOverlay: "src-tauri/tauri.diag.conf.json",
    cargoFeatures: ["diag"],
  },
};

/** The kind a name refers to, or a hard failure — never a silent default to `release`. */
export function kindOf(name) {
  const k = KINDS[String(name || "").trim()];
  if (!k) {
    throw new Error(
      `unknown build kind ${JSON.stringify(name)} — expected one of: ${Object.keys(KINDS).join(", ")}`,
    );
  }
  return k;
}

/** `1.1.0` + the kind's suffix. The version a build reports is part of its identity, not cosmetics. */
export function versionFor(kind, baseVersion) {
  return `${baseVersion}${kind.versionSuffix}`;
}

/** Artifact filename with the `{stamp}` placeholder resolved. */
export function artifactName(template, stamp) {
  return template.replace("{stamp}", stamp);
}

/** UTC `YYYYMMDDhhmmss`, the stamp convention every Sard package has used since July. */
export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * THE BUILD ID — one string that identifies exactly which build someone is running.
 *
 * `<KIND>-<utc stamp>-<git short sha>[+N]`, where `+N` counts uncommitted paths. Sard's public
 * artifacts are built from the WORKING TREE, not from a commit, so a sha alone would be a half-truth:
 * `dd23765+76` says "this is dd23765 plus 76 changes you cannot see from the history", which is the
 * honest thing to say and exactly what BUILD-INFO.txt has always recorded.
 *
 * Generated ONCE per build and passed to both halves of the app through `SARD_BUILD_ID`:
 * `build.rs` re-emits it for Rust, Vite defines it for the frontend. One value, two consumers, and a
 * report that prints both — so "did the frontend of THIS executable actually run?" becomes a
 * comparison rather than an argument. That question cost the installer investigation days.
 */
export function buildId(kind, { cwd = process.cwd() } = {}) {
  const { execFileSync } = requireChildProcess();
  const git = (args) => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); } catch { return ""; }
  };
  const sha = git(["rev-parse", "--short", "HEAD"]) || "nogit";
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const prefix = kind.id === "diag" ? "DIAG" : "REL";
  return `${prefix}-${utcStamp()}-${sha}${dirty ? `+${dirty}` : ""}`;
}

/**
 * The shape `buildId()` produces: `REL-20260807031743-8174cff+10`.
 *
 * NO TRAILING `\b`. The first version had one and silently truncated the id, dropping `+12` from
 * `DIAG-20260807032144-8174cff+12`: the compiler packs string literals into .rdata with no separator,
 * so the id is immediately followed by the next literal — here the `S` of "Sard Diagnostics". `\b`
 * between `2` and `S` does not hold (both are word characters), so the pattern backtracked, gave up
 * the `+12`, and matched a shorter id that ended at a `+`. BUILD-INFO.txt would then have recorded a
 * build id the app never reports, which is the precise disagreement this whole mechanism exists to
 * prevent.
 *
 * Residual hazard, stated rather than hidden: with no trailing anchor, a sha could over-capture if
 * the byte after the id happened to be a hex digit. The consequence is limited to the extracted
 * string used for paperwork — the MATCH/MISMATCH check in the report compares the two injected
 * constants directly and never goes through this pattern.
 */
export const BUILD_ID_RE = /\b(REL|DIAG)-\d{14}-[0-9a-f]{7,40}(?:\+\d+)?/;

/**
 * Read the BUILD ID back OUT of a compiled binary.
 *
 * The packaging scripts run AFTER the build, so they cannot generate the id the binary carries —
 * generating a second one would put a different timestamp in BUILD-INFO.txt than the app reports,
 * and a package whose paperwork disagrees with its contents is how the 2026-08-07 confusion started.
 * So the id is EXTRACTED, and BUILD-INFO.txt states what the executable will actually say.
 *
 * Returns null when the binary carries none, which means it was built outside the build scripts. The
 * caller must treat that as a failure rather than substituting something plausible.
 */
export function extractBuildId(buf) {
  const m = buf.toString("latin1").match(BUILD_ID_RE);
  return m ? m[0] : null;
}

// `getBuiltinModule` rather than a top-level import, so this module stays usable from contexts that
// only want the identity table and never shell out.
function requireChildProcess() {
  return globalThis.process?.getBuiltinModule
    ? { execFileSync: globalThis.process.getBuiltinModule("node:child_process").execFileSync }
    : { execFileSync: () => { throw new Error("child_process unavailable"); } };
}
