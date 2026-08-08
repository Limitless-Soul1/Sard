// GENERATING THE PRODUCTION TREE — one implementation, used by everything that needs it.
//
// The release, the content gate and the build gate all have to operate on the SAME tree. When each
// built its own, "we audited it", "we built it" and "we shipped it" were three separate claims about
// three separately-constructed objects, and only their inputs made them agree. That is the shape of
// mistake that ships an unverified artifact, so the construction lives here and the callers pass the
// resulting SHA to each other.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { isDevelopmentOnly, productionPackageJson } from "./production-tree-rules.mjs";

const REPO = resolve(import.meta.dirname, "..");
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64e6, ...opts }).trim();

/**
 * Build the tree that `source` would publish, and return it.
 *
 * Writes a real tree object into the object database — cheap, unreferenced, and collected by `git gc`
 * if nothing ends up pointing at it. Uses a temporary index so the working tree is never touched: a
 * release must not depend on checking anything out, and must leave the developer where they were.
 *
 * @returns {{ tree: string, keep: string[], drop: Map<string,string>, pkgKept: string[], pkgDropped: string[] }}
 */
export function writeProductionTree(source = "develop") {
  const files = git(["ls-tree", "-r", "--name-only", source])
    .split("\n").filter(Boolean).map((f) => f.replace(/\\/g, "/"));

  const keep = [];
  const drop = new Map();
  for (const f of files) {
    const hit = isDevelopmentOnly(f);
    if (hit) drop.set(f, hit.why); else keep.push(f);
  }

  const pkg = productionPackageJson(
    execFileSync("git", ["show", `${source}:package.json`], { cwd: REPO, encoding: "utf8", maxBuffer: 8e6 }),
  );

  const tmpIndex = resolve(REPO, ".git", `index.prodtree-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(["read-tree", source], { env });
    if (drop.size) {
      // NUL-separated: paths contain non-ASCII and spaces.
      execFileSync("git", ["update-index", "--force-remove", "-z", "--stdin"],
        { cwd: REPO, env, input: [...drop.keys()].join("\0") + "\0" });
    }
    // The one file whose CONTENTS are rewritten rather than kept or dropped. Everything else in the
    // published tree is byte-identical to `source`.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"],
      { cwd: REPO, input: pkg.text, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},package.json`],
      { cwd: REPO, env });

    return { tree: git(["write-tree"], { env }), keep, drop, pkgKept: pkg.kept, pkgDropped: pkg.dropped };
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch { /* fine */ }
  }
}
