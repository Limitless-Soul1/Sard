// DOES THE PRODUCTION TREE ACTUALLY BUILD?
//
//   node scripts/verify-main-buildable.mjs          # check the tree `develop` would publish
//   node scripts/verify-main-buildable.mjs --from=main
//
// Exit 0 = the tree that would become `main` typechecks and bundles. Any other exit = it does not,
// and no release may be cut from it.
//
// WHY THIS EXISTS
// `check-production-tree.mjs` answers "is this tree CLEAN?". Nothing answered "does this tree BUILD?",
// and those are different questions with different failure modes. The v1.2.0 release proved it: the
// production-tree gate passed, the tree was published to `main`, the tag was pushed — and only then
// did CI discover that `tsc` could not resolve imports whose files the production tree legitimately
// excludes. The clean-tree check could not have caught it, because the tree was clean. It just could
// not compile.
//
// The failure class is general, not specific to that one bug: ANY file the exclusion rules remove can
// turn out to be something the build still needed. A rule about what a tree CONTAINS can never answer
// that. Only building it can.
//
// So this builds the real thing. It reconstructs the exact tree the release would publish — same rules
// module, same plumbing — writes it out, and runs the production build against it. Not `develop`'s
// build: `develop` has every file, so it succeeds in cases where the published tree fails, which is
// precisely how v1.2.0 got as far as it did.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { isDevelopmentOnly, productionPackageJson } from "./production-tree-rules.mjs";

const REPO = resolve(import.meta.dirname, "..");
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64e6, ...opts }).trim();

const SOURCE = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? "develop";
const KEEP = process.argv.includes("--keep");

// The scratch tree lives INSIDE the repository, and deliberately so: Node and Vite find
// `node_modules` by walking up from the project directory, so a tree extracted to the system temp
// directory cannot resolve a single dependency. It is gitignored, and removed on every exit path.
const OUT = resolve(REPO, ".release-check");

console.log(`\nPRODUCTION-BUILD CHECK — the tree '${SOURCE}' would publish\n`);

// ---- reconstruct the published tree, exactly as release-to-main.mjs does ------------------------
const files = git(["ls-tree", "-r", "--name-only", SOURCE]).split("\n").filter(Boolean).map((f) => f.replace(/\\/g, "/"));
const drop = files.filter((f) => isDevelopmentOnly(f));
console.log(`  ${files.length} files on ${SOURCE} · ${files.length - drop.length} kept · ${drop.length} excluded`);

const tmpIndex = resolve(REPO, ".git", "index.buildcheck-tmp");
const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
let tree;
try {
  git(["read-tree", SOURCE], { env });
  if (drop.length) {
    execFileSync("git", ["update-index", "--force-remove", "-z", "--stdin"],
      { cwd: REPO, env, input: drop.join("\0") + "\0" });
  }
  // The release rewrites package.json's scripts for the published tree, so this must too — otherwise
  // the gate would build a tree that is not the one that ships, and "it builds" would be an answer to
  // the wrong question.
  const pkgText = productionPackageJson(
    execFileSync("git", ["show", `${SOURCE}:package.json`], { cwd: REPO, encoding: "utf8" }),
  ).text;
  const pkgBlob = execFileSync("git", ["hash-object", "-w", "--stdin"],
    { cwd: REPO, input: pkgText, encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${pkgBlob},package.json`],
    { cwd: REPO, env });

  tree = git(["write-tree"], { env });
} finally {
  try { rmSync(tmpIndex, { force: true }); } catch { /* fine */ }
}
console.log(`  production tree: ${tree}`);

// ---- write it out and build it -------------------------------------------------------------------
const cleanup = () => { if (!KEEP) try { rmSync(OUT, { recursive: true, force: true }); } catch { /* fine */ } };
let failed = null;
try {
  cleanup();
  mkdirSync(OUT, { recursive: true });
  // `git archive` streams the tree; tar writes it. Neither touches the working tree.
  // `git archive` streams a tar of the tree straight into the scratch directory. Done with git's own
  // `--output` plus a separate extract rather than a shell pipe, so it does not depend on which shell
  // happens to be running this and so a failure in either half is reported instead of swallowed.
  // RELATIVE paths, from the repository root. An absolute Windows path here does not work: tar reads
  // the drive colon in `M:\...` as a remote host and reports "Cannot connect to M: resolve failed".
  const tarRel = ".git/release-check.tar";
  try {
    git(["archive", "--format=tar", `--output=${tarRel}`, tree]);
    execFileSync("tar", ["-x", "-f", tarRel, "-C", ".release-check"], { cwd: REPO, stdio: "pipe" });
  } finally {
    try { rmSync(resolve(REPO, tarRel), { force: true }); } catch { /* fine */ }
  }
  if (!existsSync(resolve(OUT, "package.json"))) throw new Error("the extracted tree has no package.json");

  // The tool's own JS entry point is run with this Node, rather than going through `npx` and a shell.
  // No PATH lookup, no shell quoting, no deprecation warning about arguments passed alongside
  // `shell: true` — and the extracted tree needs no node_modules of its own, because both resolve
  // from the repository above it.
  const run = (label, bin, args) => {
    process.stdout.write(`  ${label} … `);
    try {
      execFileSync(process.execPath, [resolve(REPO, bin), ...args],
        { cwd: OUT, encoding: "utf8", stdio: "pipe", maxBuffer: 64e6 });
      console.log("PASS");
    } catch (e) {
      console.log("FAIL");
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      // The first lines are the ones that name the missing module or the type error.
      console.log(out.split("\n").slice(0, 25).map((l) => `      ${l}`).join("\n"));
      throw new Error(`${label} failed`);
    }
  };

  run("typecheck (tsc)", "node_modules/typescript/bin/tsc", ["--noEmit", "-p", "tsconfig.json"]);
  run("bundle (vite build)", "node_modules/vite/bin/vite.js", ["build"]);
} catch (e) {
  failed = e;
  // Report the cause. An earlier version swallowed it and printed only "this tree does not build",
  // which is the least useful thing a gate can say.
  const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
  if (!/^(typecheck|bundle)/.test(e.message ?? "")) {
    console.log(`  ERROR  ${e.message}`);
    if (detail) console.log(detail.split("\n").slice(0, 15).map((l) => `      ${l}`).join("\n"));
  }
} finally {
  if (KEEP) console.log(`\n  scratch tree kept at ${OUT}`);
  else cleanup();
}

if (failed) {
  console.error(
    `\n  THIS TREE DOES NOT BUILD. Do not publish it to main and do not tag a release from it.\n` +
      `  The cause is above. It is almost always a file the production-tree rules exclude that the\n` +
      `  build still needs — check scripts/production-tree-rules.mjs against the missing path.\n`,
  );
  process.exit(1);
}
console.log(`\n  The production tree builds. It is safe to publish and tag.\n`);
