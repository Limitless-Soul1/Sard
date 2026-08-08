// THE PRODUCTION-CONTENT GATE — is there internal material INSIDE the files that ship?
//
//   node scripts/check-production-content.mjs --ref=<tree>   # scan an already-generated tree
//   node scripts/check-production-content.mjs                # generate the tree from `develop`, then scan
//
// Exit 0 = every shipped file is clean. Any other exit = it is not, and the release does not happen.
//
// WHY THIS EXISTS, SEPARATELY FROM THE PATH CHECK
// `check-production-tree.mjs` answers "is an excluded FILE present?". It passed on the tree that became
// v1.2.2 — which shipped a private machine path in a source comment, four internal test modules under a
// path no rule named, and twenty-one npm scripts naming harnesses, packaging tools and the private
// release mechanism. A gate that passes on a contaminated tree is not a gate, so this one reads what is
// inside the files rather than only what they are called.
//
// It runs BEFORE the build and before anything can be published, against the exact tree that will ship.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CONTENT_RULES, scanText, scanPackageJson, isVendored } from "./production-content-rules.mjs";
import { PRODUCTION_SCRIPTS } from "./production-tree-rules.mjs";
import { writeProductionTree } from "./production-tree.mjs";

const REPO = resolve(import.meta.dirname, "..");
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const SOURCE = arg("from") ?? "develop";

// A caller that has already built the tree passes it in, so the tree audited here is provably the same
// object the build and the release use. Generating it again would leave room for them to differ.
const tree = arg("ref") ?? writeProductionTree(SOURCE).tree;

console.log(`\nPRODUCTION-CONTENT CHECK — tree ${tree}\n`);

const files = execFileSync("git", ["ls-tree", "-r", "--name-only", tree], {
  cwd: REPO, encoding: "utf8", maxBuffer: 64e6,
}).split(/\r?\n/).map((f) => f.trim()).filter(Boolean);

// One `cat-file --batch` for the whole tree: 700 separate spawns is slow enough on Windows that people
// stop running the gate, and a gate nobody runs protects nothing.
const scanned = files.filter((f) => !isVendored(f));
// `input` is a Buffer and no `encoding` is set, so git's output comes back as raw bytes — the only way
// to find each payload's end by the byte count in its header. Passing a string with encoding:"buffer"
// makes Node try to decode the INPUT as "buffer" and throw.
const batch = execFileSync("git", ["cat-file", "--batch"], {
  cwd: REPO,
  input: Buffer.from(scanned.map((f) => `${tree}:${f}`).join("\n") + "\n", "utf8"),
  maxBuffer: 512e6,
});

// Parse `<sha> <type> <size>\n<payload>\n`, in the order the paths were sent.
const contents = new Map();
let at = 0;
for (const path of scanned) {
  const nl = batch.indexOf(0x0a, at);
  if (nl < 0) break;
  const header = batch.subarray(at, nl).toString("utf8");
  const size = Number(header.split(" ")[2]);
  if (!Number.isFinite(size)) { at = nl + 1; continue; }
  contents.set(path, batch.subarray(nl + 1, nl + 1 + size));
  at = nl + 1 + size + 1;
}

const violations = [];
for (const path of scanned) {
  const buf = contents.get(path);
  if (!buf) continue;
  // A NUL byte means binary, whatever the extension claims. Reading it as text produces noise.
  if (buf.includes(0)) continue;
  const text = buf.toString("utf8");
  for (const v of scanText(path, text)) violations.push({ path, ...v });
  if (path === "package.json") {
    for (const v of scanPackageJson(text, PRODUCTION_SCRIPTS, new Set(files))) violations.push({ path, ...v });
  }
}

console.log(`  ${files.length} file(s) in the tree · ${scanned.length} scanned · ${files.length - scanned.length} vendored (not scanned)`);
console.log(`  ${CONTENT_RULES.length + 1} rule(s) applied\n`);

if (!violations.length) {
  console.log("  No forbidden content found. This tree is fit to publish.\n");
  process.exit(0);
}

// Grouped by rule, because one bad habit usually produces several hits and they are fixed together.
const byRule = new Map();
for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
console.log(`  ${violations.length} violation(s):\n`);
for (const [rule, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  [${rule}] ${list[0].why}  (${list.length})`);
  for (const v of list.slice(0, 12)) console.log(`      ${v.path}${v.line ? `:${v.line}` : ""}  ${v.text}`);
  if (list.length > 12) console.log(`      … and ${list.length - 12} more`);
  console.log("");
}
console.error(
  `  THIS TREE CARRIES INTERNAL MATERIAL. It must not be published.\n` +
    `  Fix the file, or — if the match is legitimate — add a narrow, reasoned exemption to\n` +
    `  scripts/production-content-rules.mjs. Do not widen a rule to make a real hit disappear.\n`,
);
process.exit(1);
