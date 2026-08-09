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
import { writeProductionTree } from "./production-tree.mjs";

const REPO = resolve(import.meta.dirname, "..");
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64e6, ...opts }).trim();

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const SOURCE = arg("from") ?? "develop";
const REF = arg("ref");
const KEEP = process.argv.includes("--keep");

// The scratch tree lives INSIDE the repository, and deliberately so: Node and Vite find
// `node_modules` by walking up from the project directory, so a tree extracted to the system temp
// directory cannot resolve a single dependency. It is gitignored, and removed on every exit path.
const OUT = resolve(REPO, ".release-check");

console.log(`\nPRODUCTION-BUILD CHECK — ${REF ? `tree ${REF}` : `the tree '${SOURCE}' would publish`}\n`);

// A caller that has already generated and audited the tree passes it in, so what is built here is
// provably the same object. Generating it again would leave room for the audited tree and the built
// tree to differ, which is precisely what must not be possible.
let tree = REF;
if (!tree) {
  const built = writeProductionTree(SOURCE);
  tree = built.tree;
  console.log(`  ${built.keep.length + built.drop.size} files on ${SOURCE} · ${built.keep.length} kept · ${built.drop.size} excluded`);
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
  // a drive-letter colon as a remote host and reports "Cannot connect to M: resolve failed".
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
