#!/usr/bin/env node
// WP-0 (RESILIENCE-1) — (re)build the corpus manifest by measuring the real books on disk.
//
// Curated data (tags, notes, provenance, retired flags) is PRESERVED from the existing manifest;
// only the measured traits and the hash are rewritten. A new file with no tags is a hard error —
// an untagged book contributes to no coverage slot and would silently look like coverage.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { corpusDir, MANIFEST_PATH, pickTraits, readManifest, sha256, slotCoverage } from "./corpus-lib.mjs";

const { describeEpub } = await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "epub-read.mjs")).href);

const dir = corpusDir();
const prev = readManifest();
const prevByFile = new Map(prev.books.map((b) => [b.file, b]));

const files = readdirSync(dir)
  .filter((f) => /\.(epub|pdf)$/i.test(f))
  .sort();

const books = [];
const untagged = [];

for (const file of files) {
  const buf = readFileSync(join(dir, file));
  const old = prevByFile.get(file);
  const tags = old?.tags ?? [];
  if (tags.length === 0) untagged.push(file);

  const isPdf = /\.pdf$/i.test(file);
  books.push({
    file,
    sha256: sha256(buf),
    bytes: buf.length,
    format: isPdf ? "pdf" : "epub",
    title: old?.title ?? null,
    note: old?.note ?? null,
    tags,
    ...(old?.retired ? { retired: true, retiredReason: old.retiredReason ?? null } : {}),
    // A PDF has no OPF/spine/TOC to measure with an EPUB reader; recording `null` is honest, and
    // the verifier skips trait comparison for it rather than inventing a shape.
    traits: isPdf ? null : pickTraits(describeEpub(buf)),
  });
}

if (untagged.length) {
  console.error(`\n✗ ${untagged.length} corpus file(s) have no coverage tags:\n`);
  for (const f of untagged) console.error(`    ${f}`);
  console.error(`\nAdd a "tags" array to each entry in ${MANIFEST_PATH} and re-run.`);
  console.error(`An untagged book covers no slot — it would look like coverage without being any.\n`);
  process.exit(1);
}

const next = { ...prev, generated: new Date().toISOString().slice(0, 10), books };
writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");

const { covered, gaps, untracked } = slotCoverage(next);
console.log(`\n  ${books.length} books · ${(books.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(1)} MB`);
console.log(`  corpus dir: ${dir}`);
console.log(`\n  slot coverage:`);
for (const slot of Object.keys(next.slots)) {
  const n = covered.get(slot) ?? 0;
  console.log(`    ${n > 0 ? "✓" : "✗"} ${slot.padEnd(22)} ${n > 0 ? `${n} book(s)` : "GAP"}`);
}
if (untracked.length) console.log(`\n  ⚠ tags used but not declared in \`slots\`: ${untracked.join(", ")}`);
if (gaps.length) console.log(`\n  ${gaps.length} gap(s) — see \`gaps\` in the manifest for what is needed.`);
console.log(`\n  → ${MANIFEST_PATH}\n`);
