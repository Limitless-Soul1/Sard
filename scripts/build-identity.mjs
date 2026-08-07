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
