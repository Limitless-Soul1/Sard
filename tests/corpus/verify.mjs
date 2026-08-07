#!/usr/bin/env node
// WP-0 (RESILIENCE-1) — verify the local corpus against the manifest.
//
// Two independent checks, in this order:
//   1. INTEGRITY  — every non-retired book is present and its SHA-256 is unchanged.
//   2. TRAITS     — re-measured structure matches what was recorded at admission.
//
// (2) is the one that earns the corpus its keep. It fails on a parser change that alters how a book
// is READ, before any rendering is involved — so the diff points at the cause instead of at a
// mysterious visual difference three packages later.
//
// A machine with no corpus SKIPS with a clear message and exit code 0. It must never look like a pass.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { corpusDir, diffTraits, pickTraits, readManifest, sha256, slotCoverage } from "./corpus-lib.mjs";

const { describeEpub } = await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "epub-read.mjs")).href);

const dir = corpusDir();
const manifest = readManifest();

if (!existsSync(dir)) {
  console.log(`\n  ⓘ SKIPPED — no corpus at ${dir}`);
  console.log(`     Set SARD_CORPUS, or see tests/corpus/README.md to populate it.`);
  console.log(`     This is a SKIP, not a pass: corpus checks did not run.\n`);
  process.exit(0);
}

const problems = [];
const ok = [];

for (const book of manifest.books) {
  if (book.retired) continue;
  const path = join(dir, book.file);
  if (!existsSync(path)) {
    problems.push({ file: book.file, kind: "missing", detail: "not present in the corpus directory" });
    continue;
  }
  const buf = readFileSync(path);
  const hash = sha256(buf);
  if (hash !== book.sha256) {
    problems.push({
      file: book.file,
      kind: "hash",
      detail: `expected ${book.sha256.slice(0, 16)}… got ${hash.slice(0, 16)}…  (the file changed — the corpus is meant to be immutable)`,
    });
    continue;
  }
  if (book.format === "epub" && book.traits) {
    const diffs = diffTraits(book.traits, pickTraits(describeEpub(buf)));
    if (diffs.length) {
      problems.push({ file: book.file, kind: "traits", detail: diffs.join("\n        ") });
      continue;
    }
  }
  ok.push(book.file);
}

// Files on disk that the manifest does not know about — an untracked book contributes no coverage
// and, worse, may be silently relied on by a manual sweep.
const known = new Set(manifest.books.map((b) => b.file));
const stray = readdirSync(dir)
  .filter((f) => /\.(epub|pdf)$/i.test(f))
  .filter((f) => !known.has(f));

const { covered, gaps } = slotCoverage(manifest);

console.log(`\n  corpus: ${dir}`);
console.log(`  ${ok.length}/${manifest.books.filter((b) => !b.retired).length} books verified (hash + traits)`);

if (stray.length) {
  console.log(`\n  ⚠ ${stray.length} file(s) on disk are not in the manifest:`);
  for (const f of stray) console.log(`      ${f}`);
  console.log(`    Run \`npm run corpus:build-manifest\` and give each one coverage tags.`);
}

if (gaps.length) {
  console.log(`\n  ⓘ ${gaps.length} coverage gap(s) — documented, not failures:`);
  for (const g of gaps) console.log(`      ${g}: ${manifest.gaps?.[g] ?? "(no note)"}`);
}

console.log(`\n  slots covered: ${covered.size}/${Object.keys(manifest.slots).length}`);

if (problems.length) {
  console.error(`\n  ✗ ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`    [${p.kind}] ${p.file}\n        ${p.detail}\n`);
  process.exit(1);
}

console.log(`\n  ✓ corpus intact\n`);
