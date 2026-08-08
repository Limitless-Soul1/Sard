// WHAT MAY LIVE ON `main` — ONE definition, imported by everything that needs it.
//
// Extracted from check-production-tree.mjs so the release script and the check cannot disagree. Two
// copies of this list would mean the gate and the thing it gates were describing different trees, and
// the release would pass a check it had already stopped satisfying.
//
// THE BOUNDARY THIS FILE DRAWS
// `develop` is the complete development environment: product source, tests, fixtures, harnesses,
// investigation tools, studies, reports, internal documentation and throwaway utilities. All of it is
// kept, because it is how the product is built and verified. `main` is the finished product and
// nothing else — it must read as an ordinary public repository for an application, not as somebody's
// laboratory. Excluding a path here does NOT delete it; it stays on `develop` in full, and it stays in
// the git history. Only the current tree published to `main` is filtered.
//
// WHY THE ROOT-DOCUMENT RULE IS AN ALLOWLIST
// Every leak this file has had came from the same shape: a rule that named the development files it
// knew about, and a new file whose name did not match. `_STUDY.md$` did not catch
// `BACKGROUND_MEDIA_STUDY_2_READABILITY.md`, `STRESS_TEST_3e0fc98.md`, `LIBRARY_COMPATIBILITY_AUDIT.md`
// or `PDF_FEATURES_RAWY-291.md`, and each of those would have been published. Chasing suffixes cannot
// win, because the next report will be named something nobody predicted.
//
// So the root-level rule is inverted. A public product repository has a small, boring set of top-level
// documents — README, BUILD, LICENSE, CHANGELOG and their usual companions. Those are listed in
// PRODUCTION_ALWAYS. EVERY OTHER root-level .md or .txt is development material by default, and a new
// investigation report is excluded the moment it is created, without anyone editing this file.
// The named patterns below are kept anyway: they still catch report-shaped names in SUBDIRECTORIES,
// and each one records the reason its class is excluded, which an allowlist alone cannot express.

/**
 * FILES THAT MUST NEVER REACH `main`.
 *
 * Each entry is a regex over the repo-relative, forward-slashed path, plus the reason it is excluded
 * — because an exclusion whose reason is lost is an exclusion someone eventually overrides.
 */
export const DEVELOPMENT_ONLY = [
  // ONE DIRECTORY, ONE RULE. Every internal engineering document — handbook, workflow, notes,
  // checklists, lessons — lives under docs/engineering/, so a single pattern covers all of them and a
  // new one is protected the moment it is created. A per-file pattern only protects the files
  // someone remembered to list.
  //
  // `docs/` is PARTLY production: docs/screenshots/ is referenced by the public README and must ship,
  // so the exclusion is scoped to the engineering subtree rather than to docs/.
  { re: /^docs\/engineering\//, why: "internal engineering documents — how the product is built, not the product" },

  // ---- ROOT-LEVEL DOCUMENTS -------------------------------------------------------------------
  // The backstop described at the top of this file. Anything at the root that is not one of the
  // product's own documents (PRODUCTION_ALWAYS, checked first) is development material: reports,
  // studies, plans, checkpoints, status notes, tester instructions, scratch notes. Subdirectory
  // documents are NOT caught here — public/foliate-js/README.md and the Piper LICENSES/README.md
  // belong to shipped third-party code and must travel with it.
  { re: /^[^/]+\.(md|txt)$/i, why: "a root-level document that is not one of the product's own README/BUILD/LICENSE/CHANGELOG/NOTICE" },

  // Report-shaped names ANYWHERE in the tree, not only at the root. These are what the allowlist
  // above cannot see, and they are listed individually so each class carries its reason.
  { re: /_(STUDY|INVESTIGATION|PLAN|AUDIT|REPORT|FINDINGS|READABILITY|POSTMORTEM|POST_MORTEM)\.md$/i, why: "an investigation report" },
  { re: /_(FIX|NOTES|SUMMARY|HANDOFF|CHECKLIST|AGENDA)\.md$/i, why: "an internal working note" },
  { re: /^(STRESS_TEST|PDF_FEATURES|CHECKPOINT|BETA|REMEDIATION|NEXT_STAGE)[-_]/i, why: "an investigation or internal plan, by its naming convention" },
  { re: /^CHECKPOINT-.*\.md$/, why: "an investigation checkpoint" },
  { re: /^(BETA-\d+|REMEDIATION_PLAN|PROJECT_MASTER_SUMMARY|NEXT_STAGE_STUDY)\.md$/, why: "an internal plan or status note" },
  { re: /^DIAG-README\.txt$/, why: "the diagnostic package's tester instructions" },

  // ---- TESTING INFRASTRUCTURE -----------------------------------------------------------------
  // ALL of it. Unit tests, fixtures, the corpus, the CDP harnesses and the runner configuration are
  // how the product is verified; they are not part of the application a reader installs, and a public
  // product repository does not carry its author's laboratory. Every one of these stays on `develop`
  // and remains runnable there — excluding a path from the published tree does not remove it.
  { re: /^tests\//, why: "testing infrastructure — unit tests, fixtures, corpus and investigation harnesses" },
  { re: /^src-tauri\/tests\//, why: "testing infrastructure — Rust integration tests" },
  // Rust test modules that live INSIDE src/ rather than under tests/. Cargo allows both, so the
  // directory rule above cannot see these — and four of them reached a public release carrying
  // internal work-package names, references to the owner's live library, and a hardcoded path to a
  // machine-local corpus directory. They are `#[cfg(test)]`, so a release build never compiles them:
  // removing the file is safe because cfg-stripping happens before the module file is resolved.
  // Only `cargo test` needs them, and that is not something `main` is for.
  { re: /^src-tauri\/src\/(?:.*\/)?(?:tests|[A-Za-z0-9_]+_tests)\.rs$/, why: "a Rust test module — testing infrastructure, not the product" },
  { re: /^(tsconfig\.test\.json|vitest\.config\.ts)$/, why: "testing infrastructure — test-runner configuration" },

  // ---- DEVELOPMENT AND RELEASE-OPERATION SCRIPTS ----------------------------------------------
  // The four scripts that DO ship are named in PRODUCTION_ALWAYS below, because CI runs them against
  // every published artifact. Everything else in scripts/ builds a test binary, packages a private
  // build, kills a stray process or publishes this very branch — all developer-machine operations
  // with no role in the product.
  { re: /^scripts\/pack-(diag|share|beta)[-.]?\w*\.mjs$/, why: "a packaging utility for non-release builds" },
  { re: /^scripts\/(build-test|copy-release|kill-sard|release-to-main|verify-main-buildable)\.mjs$/, why: "a development or release-operation script" },
  { re: /^build-test\.bat$/, why: "a development build shortcut" },

  // ---- DIAGNOSTIC INSTRUMENTATION -------------------------------------------------------------
  { re: /^src\/lib\/(diag|pdfDiag|renderDiag|stageLedger)\.ts$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/src\/diag_startup\.rs$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/tauri\.(diag|beta)\.conf\.json$/, why: "a non-release build's identity overlay (diagnostic or private Beta)" },
];

/**
 * Explicitly PRODUCTION, even though a pattern above might otherwise catch them. Checked FIRST, so
 * the safety equipment can never be swept out with the hazard.
 *
 * "Mentions diagnostics" and "IS diagnostics" are not the same thing, and treating them as the same
 * would break the release build:
 *
 *   src/lib/diagOff.ts            the no-op stub a release build compiles AGAINST — remove it and the
 *                                 release build fails to resolve its imports
 *   scripts/verify-artifact.mjs   what PROVES an artifact carries no instrumentation; CI runs it
 *   scripts/build-identity.mjs    the identity register the verifier reads
 *   scripts/check-production-tree.mjs, production-tree-rules.mjs
 *                                 CI runs the gate on the published tree, so the gate must be in it
 *
 * A rule that deletes the safety equipment along with the hazard is not a safety rule.
 *
 * The last entry is the ALLOWLIST of the product's own root-level documents, and it is what makes the
 * root-document rule above safe to state as a blanket exclusion. Add to it only a document that
 * genuinely belongs in a public product repository — every addition widens the boundary.
 */
export const PRODUCTION_ALWAYS = [
  /^src\/lib\/diagOff\.ts$/,
  /^scripts\/(verify-artifact|build-identity|production-tree-rules|check-production-tree)\.mjs$/,
  /^\.github\/workflows\//,
  /^(README|BUILD|LICENSE|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|NOTICE|AUTHORS)(\.md|\.txt)?$/,
];

/**
 * THE ONLY npm SCRIPTS THAT MAY APPEAR IN THE PUBLISHED `package.json`.
 *
 * Excluding a path stops a FILE from shipping; it does nothing about internal material inside a file
 * that legitimately ships. `package.json` is exactly that case: 21 of its 34 scripts named harnesses,
 * corpus tooling, diagnostic and Beta packaging, and the private release mechanism — every one of them
 * pointing at a path the production tree does not contain. All of it was published.
 *
 * So the published `package.json` keeps only what genuinely runs there, and the list is derived from
 * what actually executes rather than from taste:
 *
 *   build           `tauri.conf.json` sets beforeBuildCommand: "npm run build"
 *   tauri           tauri-action's entry point — it runs `npm run tauri build`
 *   dev, preview    the ordinary entry points a reader of a public repository expects
 *   verify:release  runs scripts/verify-artifact.mjs, which ships and which CI runs against every
 *                   published artifact
 *
 * `name`, `version`, `dependencies` and `devDependencies` are never touched, so the published
 * manifest cannot drift from the real one — which is why this is a transform and not a second file.
 * Adding an entry here publishes it; add only what the public repository genuinely needs.
 */
export const PRODUCTION_SCRIPTS = ["dev", "build", "preview", "tauri", "verify:release"];

/**
 * The published `package.json`, given the source one. Returns the serialised text.
 *
 * Only the `scripts` block changes. Key order within it is preserved, so the diff between the two
 * trees stays readable.
 */
export function productionPackageJson(sourceText) {
  const pkg = JSON.parse(sourceText);
  const kept = {};
  const dropped = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (PRODUCTION_SCRIPTS.includes(name)) kept[name] = cmd;
    else dropped.push(name);
  }
  pkg.scripts = kept;
  return { text: JSON.stringify(pkg, null, 2) + "\n", kept: Object.keys(kept), dropped };
}

/** True when a repo-relative path must be kept out of `main`. */
export function isDevelopmentOnly(path) {
  const f = path.replace(/\\/g, "/");
  if (PRODUCTION_ALWAYS.some((re) => re.test(f))) return null;
  return DEVELOPMENT_ONLY.find((d) => d.re.test(f)) ?? null;
}
