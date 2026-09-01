// AN ARABIC CHARACTER NEVER FALLS OUT OF ARABIC.
//
// A reader may choose any Arabic face, and an Arabic face need not cover the whole Arabic block. A
// valid EPUB may use any of it. Measured on a real library: the chosen face `thmanyah serif display`
// has no glyph for FARSI YEH (U+06CC), KEHEH (U+06A9) or GAF (U+06AF) — read from its own cmap — and
// a valid book used all three, 2054 / 346 / 19 times.
//
// The stack was `'SardArabic', 'SardLatin', serif`. `SardLatin` does not claim the Arabic range, so
// those characters skipped both declared faces and landed on the generic `serif` — Times New Roman on
// Windows. Each one was drawn in a different design at different metrics, AND the shaping run was
// split at both of its edges, so the letters around it lost their joining context too. The same book
// renders correctly in other readers only because their fonts happen to cover the codepoints.
//
// The fix is a rung, not a rewrite: a bundled Arabic face, claiming the same unicode-range, placed
// below the reader's own choice. Nothing about the book's text is touched — no normalization, no
// character mapping, no repair. This guards the shape of that arrangement.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "..", "src/reader-engine/injectedCss.ts"),
  "utf8",
);

describe("the reading stack always ends in an Arabic face, never a generic one", () => {
  it("every font stack the book sees carries the Arabic net", () => {
    // Both the book's own text and the reveal placeholder are set in book type, so both need it.
    const stacks = [...SRC.matchAll(/font-family: '(?:SardArabic)'[^;]*;/g)].map((m) => m[0]);
    const chains = stacks.filter((s) => s.includes("serif"));
    expect(chains.length).toBeGreaterThanOrEqual(2);
    for (const chain of chains) expect(chain).toContain("'SardArabicFallback'");
  });

  it("and the net sits after the reader's own choice, so that choice always wins", () => {
    for (const chain of [...SRC.matchAll(/font-family: '(?:SardArabic)'[^;]*serif[^;]*;/g)].map((m) => m[0])) {
      expect(chain.indexOf("'SardArabic'")).toBeLessThan(chain.indexOf("'SardArabicFallback'"));
      expect(chain.indexOf("'SardArabicFallback'")).toBeLessThan(chain.indexOf("serif"));
    }
  });

  it("the net is a real bundled face, declared with the Arabic range", () => {
    const at = SRC.indexOf("font-family: 'SardArabicFallback'");
    expect(at).toBeGreaterThan(-1);
    // A fixed window, not up to the next "}" — the rule's own value carries ${...} interpolations
    // whose closing brace would end the slice before the descriptors are reached.
    const face = SRC.slice(SRC.lastIndexOf("@font-face", at), at + 320);
    // bundled, so it needs no network and cannot fail to arrive
    expect(face).toContain("ARABIC_FONTS.notoNaskh.regular");
    // the same range the primary claims — otherwise it would never be consulted for these characters
    expect(face).toContain("unicode-range: ${ARABIC_RANGE}");
  });

  it("the range it claims actually contains the characters that exposed the gap", () => {
    const m = /const ARABIC_RANGE =\s*\n?\s*"([^"]+)"/.exec(SRC);
    expect(m).not.toBeNull();
    const ranges = m![1].split(",").map((r) => r.trim());
    const covers = (cp: number) =>
      ranges.some((r) => {
        const [lo, hi] = r.replace(/U\+/g, "").split("-");
        return cp >= parseInt(lo, 16) && cp <= parseInt(hi ?? lo, 16);
      });
    // ی FARSI YEH, ک KEHEH, گ GAF — the three this book used that the chosen face could not draw
    expect(covers(0x06cc)).toBe(true);
    expect(covers(0x06a9)).toBe(true);
    expect(covers(0x06af)).toBe(true);
  });

  it("nothing in the reading pipeline rewrites the book's characters", () => {
    // The fix is a font rung. If a normalization ever appears here, the book is being edited rather
    // than rendered, which is the thing this change deliberately did NOT do.
    expect(SRC).not.toMatch(/\\u06CC/);
    expect(SRC).not.toMatch(/normalize\(["']NF/);
    expect(SRC).not.toMatch(/replace\([^)]*ی/);
  });
});
