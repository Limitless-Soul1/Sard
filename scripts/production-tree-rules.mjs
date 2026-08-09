// WHAT MAY LIVE ON `main` — ONE definition, imported by everything that needs it.
//
// Extracted from check-production-tree.mjs so the release script and the check cannot disagree. Two
// copies of this list would mean the gate and the thing it gates were describing different trees, and
// the release would pass a check it had already stopped satisfying.
//
// THE BOUNDARY THIS FILE DRAWS
// `develop` holds everything needed to build, test and verify the product. `main` holds the finished
// product and nothing else, so it reads as an ordinary public repository for an application.
// Excluding a path here does NOT delete it: it stays on `develop` in full, and it stays in the git
// history. Only the current tree published to `main` is filtered.
//
// WHY THE ROOT-DOCUMENT RULE IS AN ALLOWLIST
// A rule that names the files it knows about cannot hold: the next document is named something nobody
// predicted, does not match, and ships. Chasing suffixes loses that race by design.
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
  // THE PRIVATE WORKSPACE. `.gitignore` already stops it being committed, so in normal operation this
  // rule never fires — and that is exactly why it is here. An ignore rule protects only what has not
  // been added yet; a force-add, a stale index or a rule someone edits would slip straight past it.
  // This is the second, independent control, and it is the one the release actually consults.
  { re: /^private\//, why: "the private workspace — internal material, local only" },
  // Only the release workflow ships (PRODUCTION_ALWAYS below pins it, because CI runs it from `main`).
  // Every other workflow validates `develop`: it runs the unit suite, the harness rules and the gate
  // scripts, none of which the published tree carries, so on `main` it would be a workflow that could
  // only fail.
  { re: /^\.github\/workflows\/(?!release\.yml$)/, why: "a development-branch workflow — it validates develop, not the product" },
  { re: /^docs\/engineering\//, why: "internal engineering documents — how the product is built, not the product" },

  // ---- ROOT-LEVEL DOCUMENTS -------------------------------------------------------------------
  // The backstop described at the top of this file. Anything at the root that is not one of the
  // product's own documents (PRODUCTION_ALWAYS, checked first) is development material: reports,
  // studies, plans, checkpoints, status notes, tester instructions, scratch notes. Subdirectory
  // documents are NOT caught here — public/foliate-js/README.md
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
  // ALL of it. Tests, fixtures and their runner configuration are how the product is verified; they
  // are not part of the application a reader installs. Every one of these stays on `develop` and
  // remains runnable there — excluding a path from the published tree does not remove it.
  { re: /^tests\//, why: "testing infrastructure — tests, fixtures and test data" },
  { re: /^src-tauri\/tests\//, why: "testing infrastructure — Rust integration tests" },
  // Rust test modules that live INSIDE src/ rather than under tests/. Cargo allows both, so the
  // directory rule above cannot see them. They are `#[cfg(test)]`, so removing the file is safe for a
  // release build: cfg-stripping happens before the module file is resolved. Only `cargo test` needs
  // them, and that is not what `main` is for.
  { re: /^src-tauri\/src\/(?:.*\/)?(?:tests|[A-Za-z0-9_]+_tests)\.rs$/, why: "a Rust test module — testing infrastructure, not the product" },
  { re: /^(tsconfig\.test\.json|vitest\.config\.ts)$/, why: "testing infrastructure — test-runner configuration" },

  // ---- DEVELOPMENT AND RELEASE-OPERATION SCRIPTS ----------------------------------------------
  // The four scripts that DO ship are named in PRODUCTION_ALWAYS below, because CI runs them against
  // every published artifact. Everything else in scripts/ builds a test binary, packages a private
  // build, kills a stray process or publishes this very branch — all developer-machine operations
  // with no role in the product.
  { re: /^scripts\/pack-(diag|share|beta)[-.]?\w*\.mjs$/, why: "a packaging utility for non-release builds" },
  { re: /^scripts\/(build-test|copy-release|kill-sard|release-to-main|verify-main-buildable|production-tree|check-production-content|production-content-rules)\.mjs$/, why: "a development or release-operation script" },
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
  // The release workflow specifically — CI runs it from `main`, so it has to be there. Narrowed from
  // the whole directory once a second, development-only workflow existed.
  /^\.github\/workflows\/release\.yml$/,
  /^(README|BUILD|LICENSE|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|NOTICE|AUTHORS)(\.md|\.txt)?$/,
];

/**
 * THE ONLY npm SCRIPTS THAT MAY APPEAR IN THE PUBLISHED `package.json`.
 *
 * Excluding a path stops a FILE from shipping; it does nothing about the contents of a file that
 * legitimately ships. `package.json` is that case: most of its scripts point at paths the published
 * tree does not contain, so they neither run there nor belong there.
 *
 * The published manifest keeps only what genuinely runs there, and the list is derived from what
 * actually executes rather than from taste:
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
