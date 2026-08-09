// PUBLISH `develop` TO `main`, WITHOUT THE DEVELOPMENT-ONLY FILES — automatically, every time.
//
//   node scripts/release-to-main.mjs              # dry run: show exactly what would change
//   node scripts/release-to-main.mjs --commit     # do it
//
// WHY THIS EXISTS RATHER THAN `git merge`
//
// Git cannot permanently exclude paths from a merge. The usual suggestion — `.gitattributes` with
// `merge=ours` — DOES NOT WORK for this, and the reason is worth knowing before someone tries it
// again: a merge driver is only invoked when BOTH sides changed the same file. A file that exists on
// `develop` and has never existed on `main` is not a conflict at all; git simply adds it, and no
// driver is consulted. So a `merge=ours` attribute silently lets every new excluded document
// through. It would appear to work right up until the moment it mattered.
//
// `.gitignore` cannot help either: these files are TRACKED on `develop`, and gitignore does not apply
// to tracked files.
//
// The reliable approach is to stop treating `main` as a merge target and treat it as a PUBLISHED
// SNAPSHOT: take `develop`'s tree, drop the development-only paths, and commit that. Which is what a
// production branch honestly is — the tree we chose to ship, not a record of how we got there. The
// history of how we got there is on `develop`, in full, and stays there.
//
// The exclusion list is imported from production-tree-rules.mjs — the SAME list the gate uses — so the
// release and the check that guards it can never describe different trees.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { writeProductionTree, auditedTreeTrailer } from "./production-tree.mjs";

const REPO = resolve(import.meta.dirname, "..");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64e6, ...opts }).trim();
const COMMIT = process.argv.includes("--commit");
const SOURCE = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "develop";
const TARGET = process.argv.find((a) => a.startsWith("--to="))?.slice(5) ?? "main";

// ---- refuse to run on a tree that is not ready -------------------------------------------------
if (git(["status", "--porcelain"])) {
  console.error(`\n  the working tree has uncommitted changes — commit or stash them first.\n`);
  process.exit(1);
}
const current = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (current !== SOURCE) {
  console.error(`\n  run this from '${SOURCE}' (currently on '${current}').\n`);
  process.exit(1);
}

const sourceSha = git(["rev-parse", "--short", SOURCE]);

// THE tree — generated ONCE, here. Everything below audits, builds and commits this same object, so
// "we audited it", "we built it" and "we shipped it" are statements about one thing rather than three
// separately-constructed ones that only agree because their inputs did.
const production = writeProductionTree(SOURCE);
const { keep, drop } = production;
const files = [...keep, ...drop.keys()];

console.log(`\nRELEASE ${SOURCE} (${sourceSha}) -> ${TARGET}\n`);
console.log(`  ${files.length} files on ${SOURCE}`);
console.log(`  ${keep.length} kept · ${drop.size} excluded as development-only\n`);

const byReason = new Map();
for (const [f, why] of drop) byReason.set(why, [...(byReason.get(why) ?? []), f]);
for (const [why, list] of byReason) {
  console.log(`  EXCLUDED — ${why}  (${list.length})`);
  for (const f of list.slice(0, 5)) console.log(`      ${f}`);
  if (list.length > 5) console.log(`      … and ${list.length - 5} more`);
}

// ---- the one file whose CONTENTS are rewritten, not merely kept or dropped ----------------------
//
// Stated plainly because it is an exception to everything above: the published tree is otherwise a
// pure subset of the source tree. `package.json` is not, because dropping it is impossible (the build
// needs it) and shipping it verbatim published the whole internal tooling inventory. The transform is
// deliberately narrow — only the `scripts` block, only against an allowlist in
// production-tree-rules.mjs — and `dependencies` are copied untouched so the two manifests cannot
// disagree about what to install.
console.log(`\n  TRANSFORMED — package.json scripts`);
console.log(`      kept    (${production.pkgKept.length}): ${production.pkgKept.join(", ")}`);
console.log(`      removed (${production.pkgDropped.length}): ${production.pkgDropped.join(", ")}`);
console.log(`\n  production tree: ${production.tree}`);

if (!COMMIT) {
  console.log(`\n  DRY RUN. Nothing changed. Re-run with --commit to publish.\n`);
  process.exit(0);
}

// ---- GATE 1: is there internal material inside the files that ship? ------------------------------
//
// Runs FIRST, and against the tree object generated above rather than against `develop`. The path
// rules cannot see inside a file that legitimately ships, which is how v1.2.2 published a private
// machine path, four internal test modules and twenty-one development npm scripts while every check
// reported success. A failure here stops the release before anything is built or moved.
console.log(`\n  auditing the production tree for internal content…`);
execFileSync(process.execPath, [resolve(REPO, "scripts/check-production-content.mjs"), `--ref=${production.tree}`],
  { cwd: REPO, stdio: "inherit" });

// ---- GATE 2: does that same tree actually build? --------------------------------------------------
//
// The clean-tree rules decide what `main` CONTAINS. They cannot tell whether what is left still
// compiles, and those are different questions: v1.2.0 passed every clean-tree check, was published,
// and was tagged — and only then did CI find that the production tree could not resolve imports whose
// files the rules legitimately exclude. `develop` building is not evidence, because `develop` has
// every file. The SAME tree the content gate just audited is built here, before `main` moves.
console.log(`\n  checking the production tree builds…`);
execFileSync(process.execPath, [resolve(REPO, "scripts/verify-main-buildable.mjs"), `--ref=${production.tree}`],
  { cwd: REPO, stdio: "inherit" });

// ---- commit THAT tree — the one both gates just passed -------------------------------------------
//
// No reconstruction here. The tree object was generated once at the top and has been audited and built
// since; committing anything else would reintroduce the very gap these gates exist to close.
{
  const tree = production.tree;

  const parent = git(["rev-parse", "--verify", `refs/heads/${TARGET}`]);
  const message =
    `Release from ${SOURCE} (${sourceSha})\n\n` +
    `Published snapshot of ${SOURCE}, with ${drop.size} development-only file(s) excluded by\n` +
    `scripts/production-tree-rules.mjs — the same list the production-tree gate enforces.\n\n` +
    `Kept ${keep.length} files. The full development history stays on ${SOURCE}.\n\n` +
    // Recorded so CI can refuse a tree the gates never saw. CI cannot re-run the content gate — its
    // rules are development-only and must not ship — but it can recompute this commit's tree and
    // require it to be the one that passed. See production-tree.mjs for why identity, not re-derivation.
    `${auditedTreeTrailer(tree)}\n`;
  const commit = git(["commit-tree", tree, "-p", parent, "-m", message]);
  git(["update-ref", `refs/heads/${TARGET}`, commit, parent]);

  console.log(`\n  ${TARGET} updated -> ${commit.slice(0, 7)}`);
}

// ---- prove it, rather than assume it ------------------------------------------------------------
console.log(`\n  verifying ${TARGET}…`);
execFileSync(process.execPath, [resolve(REPO, "scripts/check-production-tree.mjs"), `--ref=${TARGET}`],
  { cwd: REPO, stdio: "inherit" });
console.log(`  push with:  git push origin ${TARGET}\n`);
