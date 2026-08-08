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
// driver is consulted. So `docs/engineering/** merge=ours` silently lets every new internal document
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
import { isDevelopmentOnly, productionPackageJson } from "./production-tree-rules.mjs";

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
const files = git(["ls-tree", "-r", "--name-only", SOURCE]).split("\n").filter(Boolean).map((f) => f.replace(/\\/g, "/"));

const keep = [];
const drop = new Map();
for (const f of files) {
  const hit = isDevelopmentOnly(f);
  if (hit) drop.set(f, hit.why);
  else keep.push(f);
}

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
const pkgSource = execFileSync("git", ["show", `${SOURCE}:package.json`], { cwd: REPO, encoding: "utf8" });
const pkgProduction = productionPackageJson(pkgSource);
console.log(`\n  TRANSFORMED — package.json scripts`);
console.log(`      kept    (${pkgProduction.kept.length}): ${pkgProduction.kept.join(", ")}`);
console.log(`      removed (${pkgProduction.dropped.length}): ${pkgProduction.dropped.join(", ")}`);

if (!COMMIT) {
  console.log(`\n  DRY RUN. Nothing changed. Re-run with --commit to publish.\n`);
  process.exit(0);
}

// ---- refuse to publish a tree that does not build ------------------------------------------------
//
// The clean-tree rules above decide what `main` CONTAINS. They cannot tell whether what is left still
// compiles, and those are different questions: v1.2.0 passed every clean-tree check, was published,
// and was tagged — and only then did CI find that the production tree could not resolve imports whose
// files the rules legitimately exclude. `develop` building is not evidence, because `develop` has
// every file. So the tree that is about to become `main` is built here, before `main` moves.
console.log(`\n  checking the production tree builds…`);
execFileSync(process.execPath, [resolve(REPO, "scripts/verify-main-buildable.mjs"), `--from=${SOURCE}`],
  { cwd: REPO, stdio: "inherit" });

// ---- build the target tree from the source tree, minus the exclusions ---------------------------
//
// Done with a temporary index so the working tree is never touched: a release must not depend on
// checking anything out, and must leave the developer exactly where they were.
const tmpIndex = resolve(REPO, ".git", "index.release-tmp");
const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
try {
  git(["read-tree", SOURCE], { env });
  if (drop.size) {
    // `--stdin` with NUL separation: paths contain non-ASCII and spaces.
    execFileSync("git", ["update-index", "--force-remove", "-z", "--stdin"],
      { cwd: REPO, env, input: [...drop.keys()].join("\0") + "\0" });
  }
  // Write the transformed manifest as a new blob and stage THAT in the temporary index, so the
  // rewrite lands in the published tree without the working copy ever changing.
  const pkgBlob = execFileSync("git", ["hash-object", "-w", "--stdin"],
    { cwd: REPO, input: pkgProduction.text, encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${pkgBlob},package.json`],
    { cwd: REPO, env });

  const tree = git(["write-tree"], { env });

  const parent = git(["rev-parse", "--verify", `refs/heads/${TARGET}`]);
  const message =
    `Release from ${SOURCE} (${sourceSha})\n\n` +
    `Published snapshot of ${SOURCE}, with ${drop.size} development-only file(s) excluded by\n` +
    `scripts/production-tree-rules.mjs — the same list the production-tree gate enforces.\n\n` +
    `Kept ${keep.length} files. The full development history stays on ${SOURCE}.\n`;
  const commit = git(["commit-tree", tree, "-p", parent, "-m", message]);
  git(["update-ref", `refs/heads/${TARGET}`, commit, parent]);

  console.log(`\n  ${TARGET} updated -> ${commit.slice(0, 7)}`);
} finally {
  try { execFileSync("cmd", ["/c", "del", "/q", tmpIndex.replace(/\//g, "\\")], { stdio: "ignore" }); } catch { /* fine */ }
}

// ---- prove it, rather than assume it ------------------------------------------------------------
console.log(`\n  verifying ${TARGET}…`);
execFileSync(process.execPath, [resolve(REPO, "scripts/check-production-tree.mjs"), `--ref=${TARGET}`],
  { cwd: REPO, stdio: "inherit" });
console.log(`  push with:  git push origin ${TARGET}\n`);
