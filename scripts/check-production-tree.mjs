// THE PRODUCTION-TREE CHECK — is this tree fit to be `main`?
//
//   node scripts/check-production-tree.mjs            # the current working tree
//   node scripts/check-production-tree.mjs --ref=main # a branch, without checking it out
//
// Exit 0 = every tracked file belongs in the released product. Any other exit = it does not, and the
// merge does not happen.
//
// WHY A SCRIPT AND NOT A CHECKLIST
// `main` is the answer to "what is in the build our users are running", and that answer is only cheap
// while `main` contains nothing else. A checklist protects that for exactly as long as everyone
// remembers to read it. The 2026-08-07 incident was not caused by anyone being careless — it was
// caused by two files that were correct in every respect except that nothing could tell them apart.
// So the rule about what may live on `main` is written here, where it can be run, rather than only in
// WORKFLOW.md where it can be skimmed.
//
// THE DISTINCTION THIS FILE EXISTS TO GET RIGHT
// "Mentions diagnostics" and "IS diagnostics" are not the same thing, and treating them as the same
// would break the release build:
//
//   src/lib/diagOff.ts        PRODUCTION. The no-op stub a release build compiles AGAINST. Remove it
//                             from `main` and the release build fails to resolve its imports.
//   scripts/verify-artifact.mjs
//   scripts/build-identity.mjs  PRODUCTION. CI runs the verifier against every published artifact, so
//                             both must exist on `main`. They contain no instrumentation — they are
//                             the thing that PROVES there is none.
//   src/lib/diag.ts, pdfDiag, renderDiag, stageLedger, src-tauri/src/diag_startup.rs
//                             DEVELOPMENT ONLY. These are the instrumentation itself.
//
// A rule that deletes the safety equipment along with the hazard is not a safety rule.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

/**
 * FILES THAT MUST NEVER REACH `main`.
 *
 * Each entry is a regex over the repo-relative, forward-slashed path, plus the reason it is excluded
 * — because an exclusion whose reason is lost is an exclusion someone eventually overrides.
 */
const DEVELOPMENT_ONLY = [
  { re: /^WORKFLOW\.md$/, why: "the development workflow — a laboratory document, not part of the product" },
  { re: /^CHECKPOINT-.*\.md$/, why: "an investigation checkpoint" },
  { re: /^(BETA-\d+|REMEDIATION_PLAN|PROJECT_MASTER_SUMMARY|NEXT_STAGE_STUDY)\.md$/, why: "an internal plan or status note" },
  { re: /_(STUDY|INVESTIGATION|PLAN)\.md$/, why: "an investigation report" },
  { re: /^DIAG-README\.txt$/, why: "the diagnostic package's tester instructions" },
  { re: /^src\/lib\/(diag|pdfDiag|renderDiag|stageLedger)\.ts$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/src\/diag_startup\.rs$/, why: "diagnostic instrumentation" },
  { re: /^src-tauri\/tauri\.diag\.conf\.json$/, why: "the diagnostic build's identity overlay" },
  { re: /^scripts\/pack-(diag|share)\.mjs$/, why: "a packaging utility for non-release builds" },
  { re: /^tests\/harness\//, why: "an investigation harness — reusable ones belong in the external toolkit" },
];

/**
 * Explicitly PRODUCTION, even though a pattern above might otherwise catch them. Listed first and
 * checked first, so the safety equipment can never be swept out with the hazard.
 */
const PRODUCTION_ALWAYS = [
  /^src\/lib\/diagOff\.ts$/,
  /^scripts\/(verify-artifact|build-identity)\.mjs$/,
  /^\.github\/workflows\//,
  /^(README|BUILD|LICENSE|CHANGELOG)(\.md)?$/,
];

const ref = typeof args.ref === "string" ? args.ref : null;
const files = execFileSync(
  "git",
  ref ? ["ls-tree", "-r", "--name-only", ref] : ["ls-files"],
  { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split(/\r?\n/)
  .map((f) => f.trim().replace(/\\/g, "/"))
  .filter(Boolean);

const offenders = [];
for (const f of files) {
  if (PRODUCTION_ALWAYS.some((re) => re.test(f))) continue;
  const hit = DEVELOPMENT_ONLY.find((d) => d.re.test(f));
  if (hit) offenders.push({ f, why: hit.why });
}

const what = ref ? `ref '${ref}'` : "the working tree";
console.log(`\nPRODUCTION-TREE CHECK — ${what}: ${files.length} tracked file(s)\n`);

if (!offenders.length) {
  console.log("  No development-only files found. This tree is fit for main.\n");
  process.exit(0);
}

// Grouped by reason, so a big first cleanup reads as a handful of decisions rather than a wall.
const byReason = new Map();
for (const o of offenders) byReason.set(o.why, [...(byReason.get(o.why) ?? []), o.f]);
console.log(`  ${offenders.length} file(s) must NOT be merged into main:\n`);
for (const [why, list] of byReason) {
  console.log(`  ${why}:`);
  for (const f of list.slice(0, 8)) console.log(`      ${f}`);
  if (list.length > 8) console.log(`      … and ${list.length - 8} more`);
  console.log("");
}
console.error(
  `  This tree is NOT fit for main. Exclude these from the merge (see WORKFLOW.md), or, if one of\n` +
    `  them genuinely belongs in the released product, add it to PRODUCTION_ALWAYS with the reason.\n`,
);
process.exit(1);
