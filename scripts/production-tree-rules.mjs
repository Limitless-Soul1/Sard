// WHAT MAY LIVE ON `main` — ONE definition, imported by everything that needs it.
//
// Extracted from check-production-tree.mjs so the release script and the check cannot disagree. Two
// copies of this list would mean the gate and the thing it gates were describing different trees, and
// the release would pass a check it had already stopped satisfying.

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
  { re: /^CHECKPOINT-.*\.md$/, why: "an investigation checkpoint" },
  { re: /^(BETA-\d+|REMEDIATION_PLAN|PROJECT_MASTER_SUMMARY|NEXT_STAGE_STUDY)\.md$/, why: "an internal plan or status note" },
  { re: /_(STUDY|INVESTIGATION|PLAN)\.md$/, why: "an investigation report" },
  { re: /^DIAG-README\.txt$/, why: "the diagnostic package's tester instructions" },
  { re: /^src\/lib\/(diag|pdfDiag|renderDiag|stageLedger)\.ts$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/src\/diag_startup\.rs$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/tauri\.(diag|beta)\.conf\.json$/, why: "a non-release build's identity overlay (diagnostic or private Beta)" },
  { re: /^scripts\/pack-(diag|share|beta)[-.]?\w*\.mjs$/, why: "a packaging utility for non-release builds" },
  { re: /^tests\/harness\//, why: "an investigation harness — reusable ones belong in the external toolkit" },
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
 *
 * A rule that deletes the safety equipment along with the hazard is not a safety rule.
 */
export const PRODUCTION_ALWAYS = [
  /^src\/lib\/diagOff\.ts$/,
  /^scripts\/(verify-artifact|build-identity|production-tree-rules|check-production-tree)\.mjs$/,
  /^\.github\/workflows\//,
  /^(README|BUILD|LICENSE|CHANGELOG)(\.md)?$/,
];

/** True when a repo-relative path must be kept out of `main`. */
export function isDevelopmentOnly(path) {
  const f = path.replace(/\\/g, "/");
  if (PRODUCTION_ALWAYS.some((re) => re.test(f))) return null;
  return DEVELOPMENT_ONLY.find((d) => d.re.test(f)) ?? null;
}
