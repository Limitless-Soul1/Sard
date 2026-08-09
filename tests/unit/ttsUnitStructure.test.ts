// TRACK-1 — "Edge TTS speaks, but nothing is ever highlighted."
//
// Reported against "داو الخالد العجيب" and reproduced: 112 speakable units, 0 DOM ranges.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The defect lives in a DOM walk, and this suite runs on Node
// with no DOM — so the end-to-end proof is `tests/harness/tts-track.mjs`, which measures the REAL
// binary through the product's own `__sardTrackStats` hook and fails the run if any unit lacks a
// range. What IS pinned here is the *input condition* that routes a chapter down the repaired path,
// because that is a property of the FILE and needs no browser: a chapter with no block-level
// container. Adding a DOM library just to re-approximate Chromium's Range behaviour would test the
// approximation, not the product.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — .mjs helper, intentionally untyped (same convention as tests/corpus)
import { describeEpub, zipEntries, zipRead, decodeXml } from "../lib/epub-read.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "epub");

// The selector `FoliateController.getChapterUnits` scans with. Transcribed deliberately: if a future
// change adds `td` or `dd` to the product, this copy must be updated in the same commit, and the
// mismatch is exactly what the reviewer should notice.
const CONTAINER_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div", "section", "article"];
const HAS_CONTAINER = new RegExp(`<\\s*(${CONTAINER_TAGS.join("|")})[\\s>/]`, "i");

type ZipEntry = { name: string };

function chapterDocs(file: string): string[] {
  const buf = readFileSync(file);
  const entries: ZipEntry[] = zipEntries(buf) ?? [];
  return entries
    .filter((e: ZipEntry) => /\.x?html?$/i.test(e.name) && !/nav\.x?html?$/i.test(e.name))
    .map((e: ZipEntry) => decodeXml(zipRead(buf, e)) as string | null)
    .filter((s: string | null): s is string => typeof s === "string" && s.length > 0);
}

describe("TRACK-1 — the no-block-container chapter shape", () => {
  const fixture = join(FIXTURES, "no-block-containers.epub");

  it("the fixture really has NO block container in any chapter", () => {
    // Without this the fixture could drift into ordinary markup and silently stop covering anything.
    const docs = chapterDocs(fixture);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(HAS_CONTAINER.test(d), "a chapter grew a block container — the fixture stopped covering TRACK-1").toBe(false);
    }
  });

  it("the fixture still carries real, speakable text", () => {
    // The failure mode is "spoken but untrackable", so a fixture with NO text would pass the range
    // check vacuously while proving nothing.
    for (const d of chapterDocs(fixture)) {
      const text = d.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      expect(text.length).toBeGreaterThan(80);
      expect(/[\p{L}\p{N}]/u.test(text)).toBe(true);
    }
  });

  it("its paragraphs are INLINE elements, which is what defeats the block scan", () => {
    const joined = chapterDocs(fixture).join("");
    expect(joined).toMatch(/<span/i);
    expect(joined).toMatch(/<br/i);
  });

  it("the control fixture is unaffected — it has block containers as always", () => {
    // Proves the assertion above can fail: run it against a normal book and it does.
    for (const d of chapterDocs(join(FIXTURES, "control-wellformed.epub"))) {
      expect(HAS_CONTAINER.test(d)).toBe(true);
    }
  });

  it("the fixture is a readable EPUB, not merely a well-shaped one", () => {
    const d = describeEpub(readFileSync(fixture));
    expect(d.readable).toBe(true);
    expect(d.spineCount).toBeGreaterThan(0);
  });
});

describe("TRACK-1 — the reported book, when the corpus is present", () => {
  // `SARD_CORPUS` or nothing — no hardcoded default. Unset means the corpus is absent, and these
  // cases skip.
  const corpus = process.env.SARD_CORPUS ?? "";
  const book = corpus === "" ? "" : join(corpus, "txt-converted--daw-alkhalid.epub");
  const present = book !== "" && existsSync(book);

  it.skipIf(!present)("every one of its chapters lacks a block container", () => {
    // The measured claim from the investigation, pinned so a future "it was only one chapter"
    // reading of this report cannot take hold.
    const docs = chapterDocs(book);
    expect(docs.length).toBeGreaterThan(50);
    const withContainer = docs.filter((d) => HAS_CONTAINER.test(d));
    expect(withContainer.length).toBe(0);
  });

  it.skipIf(!present)("and every one of them carries text that TTS will speak", () => {
    const docs = chapterDocs(book);
    const empty = docs.filter((d) => !/[\p{L}\p{N}]/u.test(d.replace(/<[^>]*>/g, " ")));
    expect(empty.length).toBe(0);
  });
});
