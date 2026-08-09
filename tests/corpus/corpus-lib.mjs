// WP-0 (RESILIENCE-1) — shared corpus plumbing for the builder, the verifier and the vitest suite.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-check
const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, "corpus.manifest.json");

/**
 * Where the book files live. Outside the repo by design — see README.md.
 *
 * `SARD_CORPUS` or nothing. There is deliberately no default: a hardcoded fallback bakes one
 * machine's directory layout into the repository, and every other machine — including every CI
 * runner — then fails on a path that was only ever right for one person. Callers guard with
 * `corpusAvailable()`, so an unset variable means SKIP, never a wrong path and never a hard failure.
 */
export function corpusDir() {
  return process.env.SARD_CORPUS || "";
}

export function corpusAvailable() {
  const d = corpusDir();
  return d !== "" && existsSync(d) && readdirSync(d).some((f) => /\.(epub|pdf)$/i.test(f));
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The traits recorded in the manifest and re-checked on every verify.
 *
 * DELIBERATELY NARROW. Every field here is a structural fact that a parser change could alter and
 * that a reader would notice — not an incidental detail. Adding a volatile field would make the
 * corpus cry wolf; adding none would make it useless.
 */
export const TRACKED_TRAITS = [
  "readable",
  "mimetype",
  "mimetypeStored",
  "mimetypeBom",
  "epubVersion",
  "hasMetadataBlock",
  "title",
  "creator",
  "language",
  "ppd",
  "spineCount",
  "manifestCount",
  "tocEntries",
  "tocSource",
  "cssFiles",
  "arabicRatio",
];

export function pickTraits(desc) {
  const out = {};
  for (const k of TRACKED_TRAITS) out[k] = desc[k];
  return out;
}

/** Compare two trait objects → a list of human-readable differences (empty = identical). */
export function diffTraits(expected, actual) {
  const diffs = [];
  for (const k of TRACKED_TRAITS) {
    const e = expected?.[k];
    const a = actual?.[k];
    if (JSON.stringify(e) !== JSON.stringify(a)) {
      diffs.push(`${k}: manifest ${JSON.stringify(e)} → measured ${JSON.stringify(a)}`);
    }
  }
  return diffs;
}

/** Every slot named by any book, plus the declared slot list → what is covered and what is not. */
export function slotCoverage(manifest) {
  const covered = new Map();
  for (const b of manifest.books) {
    if (b.retired) continue;
    for (const t of b.tags) covered.set(t, (covered.get(t) ?? 0) + 1);
  }
  const gaps = Object.keys(manifest.slots).filter((s) => !covered.has(s));
  const untracked = [...covered.keys()].filter((t) => !(t in manifest.slots));
  return { covered, gaps, untracked };
}
