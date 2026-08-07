// WP-0 (RESILIENCE-1) — the fixture generator's self-test.
//
// A fixture generator nobody checks is a liability: a fixture that quietly stops carrying its defect
// turns every test built on it into a false pass. So each fixture is read back with an INDEPENDENT
// reader (tests/lib/epub-read.mjs) and asserted to differ from the control in exactly the intended
// way — and, just as importantly, to be IDENTICAL to the control everywhere else.
//
// This file tests the test infrastructure. It touches no product code.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — .mjs test helper, intentionally untyped (it is an independent observer)
import { generateAll, FIXTURES } from "./generate.mjs";
// @ts-expect-error — .mjs test helper
import { describeEpub, zipEntries } from "../lib/epub-read.mjs";

let dir: string;
const desc: Record<string, any> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sard-fixtures-"));
  generateAll(dir);
  for (const name of Object.keys(FIXTURES)) {
    desc[name] = describeEpub(join(dir, `${name}.epub`));
  }
  return () => rmSync(dir, { recursive: true, force: true });
});

describe("fixture generator", () => {
  it("emits every declared fixture", () => {
    expect(Object.keys(desc).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it("gives every fixture a `proves` line naming the defect and the work that needs it", () => {
    for (const [name, f] of Object.entries(FIXTURES as Record<string, { proves: string }>)) {
      expect(f.proves, `${name} must document what it proves`).toBeTruthy();
      // The control is the one fixture that legitimately belongs to no package.
      if (name !== "control-wellformed") {
        // `WP-n` for planned work; `NAV-n` / `TRACK-n` for a defect found mid-milestone and fixed
        // out of band (the milestone already carries NAV-1..3 that way). The rule is TRACEABILITY —
        // every fixture must say which investigation it belongs to — not the WP prefix itself.
        expect(f.proves, `${name} must name the work it belongs to`).toMatch(/(WP|NAV|TRACK)-\d/);
      }
    }
  });
});

describe("control-wellformed", () => {
  it("is a readable EPUB with correct metadata, a nav TOC and no defects", () => {
    const c = desc["control-wellformed"];
    expect(c.readable).toBe(true);
    expect(c.mimetype).toBe("application/epub+zip");
    expect(c.mimetypeStored).toBe(true);
    expect(c.mimetypeBom).toBe(false);
    expect(c.hasMetadataBlock).toBe(true);
    expect(c.title).toBe("A Well-Formed Book");
    expect(c.creator).toBe("Test Author");
    expect(c.language).toBe("en");
    expect(c.epubVersion).toBe("3.0");
    expect(c.spineCount).toBe(3);
    expect(c.tocSource).toBe("nav");
    expect(c.tocEntries).toBe(3);
    expect(c.cssFiles).toBe(0);
    expect(c.arabicRatio).toBe(0);
  });

  it("puts `mimetype` first in the archive, as the specification requires", () => {
    const entries = zipEntries(readFileSync(join(dir, "control-wellformed.epub")));
    expect(entries[0].name).toBe("mimetype");
  });
});

// Each case: the fields that MUST differ from the control, and nothing else may.
const ISOLATION: Record<string, Record<string, unknown>> = {
  "bom-mimetype": { mimetypeBom: true },
  "compressed-mimetype": { mimetypeStored: false },
  "trailing-newline-mimetype": {}, // trims to the same value — the point is that it stays acceptable
  "no-metadata-block": { hasMetadataBlock: false, title: null, creator: null, language: null },
  "utf16-opf": { opfEncoding: "UTF-16", tocSource: "none", tocEntries: 0 },
  "cp1256-opf": {
    opfEncoding: "windows-1256",
    title: "كتاب عربي",
    creator: "مؤلف عربي",
    language: "ar",
    tocSource: "none",
    tocEntries: 0,
    spineCount: 6,
    arabicRatio: 1,
  },
  "placeholder-title": { title: "Unknown", creator: "word", producer: "calibre (9.9.0) [https://calibre-ebook.com]" },
  "ncx-single-entry": { epubVersion: "2.0", tocSource: "ncx", tocEntries: 1, spineCount: 40 },
  "no-toc-at-all": { tocSource: "none", tocEntries: 0 },
  "nested-toc": { tocEntries: 3 }, // 2 top-level + 1 nested — nesting must survive
  "fragmented-spine": { epubVersion: "2.0", tocSource: "ncx", tocEntries: 1, spineCount: 80 },
  "arabic-tagged-en": { title: "مكتوب بالعربية", spineCount: 8, tocSource: "none", tocEntries: 0, arabicRatio: 1 },
  "hostile-css": { cssFiles: 1 },
  "benign-css": { cssFiles: 1 },
  "truncated-zip": { readable: false },
};

describe("each fixture isolates exactly one defect", () => {
  for (const [name, expectedDiff] of Object.entries(ISOLATION)) {
    it(`${name}: differs from the control only where declared`, () => {
      const control = desc["control-wellformed"];
      const f = desc[name];

      // 1. Every declared difference is present.
      for (const [k, v] of Object.entries(expectedDiff)) {
        expect(f[k], `${name}.${k}`).toEqual(v);
      }

      // 2. Nothing ELSE differs. This is the half that catches a generator drifting: a fixture that
      //    accidentally also changes the language or drops the TOC would silently broaden whatever
      //    test consumes it. An unreadable fixture is exempt from the field-by-field comparison
      //    because there is nothing to read.
      //
      //    DERIVED fields are excluded from equality and checked by invariant below instead.
      //    `manifestCount` is the case in point: adding a stylesheet or changing the section count
      //    necessarily moves it, so pinning it to a literal would be a second copy of the same fact
      //    — the "a dimension written twice desyncs" trap. `bytes` is derived for the same reason.
      if (f.readable) {
        const DERIVED = new Set(["bytes", "manifestCount"]);
        for (const k of Object.keys(control)) {
          if (DERIVED.has(k) || k in expectedDiff) continue;
          expect(f[k], `${name}.${k} changed but was not declared`).toEqual(control[k]);
        }
      }
    });
  }

  it("manifestCount is exactly the sum of its parts, for every fixture", () => {
    // The invariant that replaces pinning `manifestCount` per fixture: one manifest item per spine
    // document, plus one each for the nav doc, the NCX and the stylesheet when present. If the
    // generator ever emits an item nothing references — or drops one something does — this fails.
    for (const [name, f] of Object.entries(desc)) {
      if (!f.readable) continue;
      const expected =
        f.spineCount + (f.tocSource === "nav" ? 1 : 0) + (f.tocSource === "ncx" ? 1 : 0) + f.cssFiles;
      expect(f.manifestCount, `${name}.manifestCount`).toBe(expected);
    }
  });
});

describe("defect-specific properties the work packages depend on", () => {
  it("bom-mimetype really carries the U+FEFF bytes that Rust's trim() will not strip", () => {
    // Verified against the real compiler: '\u{feff}'.is_whitespace() === false, so
    // `mimetype.trim() != "application/epub+zip"` rejects this book today (books/mod.rs:164).
    const raw = readFileSync(join(dir, "bom-mimetype.epub"));
    const entries = zipEntries(raw);
    const mt = entries.find((e: any) => e.name === "mimetype");
    const start = mt.lho + 30 + Buffer.from("mimetype").length;
    expect([...raw.subarray(start, start + 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("fragmented-spine matches the reported book's shape: many sections, tiny median", () => {
    const f = desc["fragmented-spine"];
    expect(f.spineCount).toBeGreaterThan(60); // the WP-2E threshold
    expect(f.bytes / f.spineCount).toBeLessThan(4096); // tiny median section
  });

  it("hostile-css carries BOTH a negative margin and an absolute pt margin", () => {
    // These are the two declarations that make WP-7 dangerous without a sanitiser: foliate sets
    // `overflow: hidden` on the column (paginator.js:333), so overflowing content is CLIPPED AWAY.
    const css = (FIXTURES as any)["hostile-css"].spec.css as string;
    expect(css).toMatch(/margin:[^;]*-\d/); // a negative margin
    expect(css).toMatch(/\d+pt/); // an absolute pt length
  });

  it("benign-css carries only relative units and emphasis the sanitiser must keep", () => {
    const css = (FIXTURES as any)["benign-css"].spec.css as string;
    expect(css).not.toMatch(/-\d+(\.\d+)?(pt|px|cm|in)/); // no negative lengths
    expect(css).not.toMatch(/\d+pt/); // no absolute pt
    expect(css).toMatch(/font-style|font-weight|text-transform/); // real emphasis to preserve
  });

  it("truncated-zip is genuinely unreadable, not merely odd", () => {
    expect(desc["truncated-zip"].readable).toBe(false);
  });
});
