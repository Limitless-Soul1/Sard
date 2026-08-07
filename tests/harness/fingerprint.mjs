// The SAME source fingerprint the packager computes, so "is the tester's build current?" is a
// measurement rather than a memory of what was in the tree at packaging time.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const files = ["src", "src-tauri/src", "public"]
  .map((d) => join(REPO, d)).filter(existsSync).flatMap((d) => walk(d))
  .map((p) => relative(REPO, p).replace(/\\/g, "/")).sort();

const fp = createHash("sha256");
let bytes = 0;
for (const rel of files) {
  const b = readFileSync(join(REPO, rel));
  fp.update(rel);
  fp.update(b);
  bytes += b.length;
}
console.log(`current fingerprint : ${fp.digest("hex").toUpperCase()}`);
console.log(`${files.length} files, ${bytes.toLocaleString("en-US")} bytes`);
