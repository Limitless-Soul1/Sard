// The translation source extraction — everything about it that can be checked without a browser.
//
// This runner has no DOM, deliberately (vitest.config.ts). So the leaf rule itself — which elements are
// paragraphs, their paths and their atoms — is verified only in a real WebView2, outside this suite. What is
// checked here is plain strings and data: the whitespace set and the collapse, the sentence split, how a
// section is assembled from its leaves, and that the output is the edition store's input, field for field.
//
// The sentence cases run on NODE's segmenter data, not WebView2's, so they keep to boundaries every version
// agrees on. The tests named `synthetic_…` pin what happens with the characters where Python's and
// JavaScript's whitespace differ. No measured book contains one: they document the behaviour; they are NOT
// validation in a real WebView2 runtime.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACTION_ID, LEAF_SELECTOR, assembleSection, collapse, sentencesOf, type Atoms, type Leaf } from "../../src/features/translation/source/extract";

const REPO = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(REPO, path), "utf8");
const cp = (n: number): string => String.fromCodePoint(n);
const NONE: Atoms = { a: 0, br: 0, img: 0, noteref: 0 };

/** Every code point that `collapse` treats as whitespace, over the whole of Unicode. */
function collapsedSet(): number[] {
  const out: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) if (collapse("a" + cp(c) + "b") === "a b") out.push(c);
  return out;
}

const expand = (ranges: [number, number][]): number[] => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** The edition store's `PYTHON_WHITESPACE`, read from its source. */
function rustWhitespace(): number[] {
  const src = read("src-tauri/src/translation/editions.rs");
  const m = src.match(/pub const PYTHON_WHITESPACE: \[\(u32, u32\); (\d+)\] = \[([\s\S]*?)\];/);
  expect(m, "PYTHON_WHITESPACE in editions.rs").not.toBeNull();
  const ranges = [...m![2].matchAll(/\((0x[0-9A-Fa-f]+),\s*(0x[0-9A-Fa-f]+)\)/g)].map((r): [number, number] => [parseInt(r[1], 16), parseInt(r[2], 16)]);
  expect(ranges.length, "every declared range was read").toBe(Number(m![1]));
  return expand(ranges);
}

/** The `pub` field names of a Rust struct in the edition store. */
function rustFields(struct: string): string[] {
  const src = read("src-tauri/src/translation/editions.rs");
  const m = src.match(new RegExp(`pub struct ${struct} \\{([\\s\\S]*?)\\n\\}`));
  expect(m, `struct ${struct} in editions.rs`).not.toBeNull();
  return [...m![1].matchAll(/^\s*pub (\w+):/gm)].map((f) => f[1]).sort();
}

describe("the whitespace set", () => {
  const PYTHON_3_12 = expand([
    [0x09, 0x0d], [0x1c, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680],
    [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
  ]);
  const collapsed = collapsedSet();

  it("is exactly Python 3.12.0's 29 code points, over the whole of Unicode", () => {
    expect(PYTHON_3_12).toHaveLength(29);
    expect(collapsed).toEqual(PYTHON_3_12);
  });

  it("is the very set the edition store's input contract is checked with", () => {
    expect(rustWhitespace()).toEqual(collapsed);
  });

  it("is not JavaScript's \\s: U+001C–001F and U+0085 are Python's only, U+FEFF is JavaScript's only", () => {
    const js: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) if (/^\s$/u.test(cp(c))) js.push(c);
    expect(collapsed.filter((c) => !js.includes(c))).toEqual([0x1c, 0x1d, 0x1e, 0x1f, 0x85]);
    expect(js.filter((c) => !collapsed.includes(c))).toEqual([0xfeff]);
  });
});

describe("collapse", () => {
  it("makes every run of whitespace one space and strips the ends", () => {
    expect(collapse("  Once \t\n upon  a   time.  ")).toBe("Once upon a time.");
    expect(collapse("a\r\nb")).toBe("a b");
    expect(collapse("")).toBe("");
    expect(collapse(" 　  ")).toBe("");
  });

  it("changes nothing that is already collapsed", () => {
    for (const t of ["Once upon a time.", "a b", "x", "Der Bär — 熊 — دب."]) expect(collapse(collapse(t))).toBe(collapse(t));
    expect(collapse("Once upon a time.")).toBe("Once upon a time.");
  });

  it("synthetic_python_only_whitespace_becomes_a_space_and_is_stripped_at_the_ends", () => {
    // U+001C–001F and U+0085 are whitespace to the pipeline's contract but not to JavaScript, so `trim()`
    // alone would keep them. Not seen in any measured book.
    for (const c of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) {
      expect(collapse("a" + cp(c) + "b"), c.toString(16)).toBe("a b");
      expect(collapse(cp(c) + "a" + cp(c)), c.toString(16)).toBe("a");
      expect((cp(c) + "a").trim(), c.toString(16)).not.toBe("a");
    }
  });

  it("synthetic_feff_is_text_to_the_contract_so_it_is_kept", () => {
    // U+FEFF is not whitespace to the pipeline's contract, so the text keeps it wherever it is. Not seen in
    // any measured book.
    expect(collapse("a﻿b")).toBe("a﻿b");
    expect(collapse("﻿a")).toBe("﻿a");
  });
});

describe("sentencesOf", () => {
  it("splits at sentence ends, trimmed, empties dropped", () => {
    expect(sentencesOf("One. Two.")).toEqual(["One.", "Two."]);
    expect(sentencesOf("  One.   Two.  ")).toEqual(["One.", "Two."]);
    expect(sentencesOf("No end")).toEqual(["No end"]);
    expect(sentencesOf("")).toEqual([]);
    expect(sentencesOf(" 　 ")).toEqual([]);
  });

  it("covers its collapsed text, sentence by sentence, with one space between them", () => {
    for (const t of ["He came. She left! Did he? Yes.", "  Spaced out.\tAgain.  ", "One line"]) {
      expect(sentencesOf(t).join(" "), t).toBe(collapse(t));
    }
  });

  it("synthetic_feff_at_a_sentence_edge_is_trimmed_from_the_sentence_but_not_from_the_text", () => {
    // JavaScript's `trim()` removes U+FEFF; the contract's whitespace does not. So the sentences no longer
    // cover the text, and the edition store keeps such a paragraph as one that breaks the contract — never
    // sent. Not seen in any measured book; not validated in a real WebView2 runtime.
    const text = collapse("﻿One.");
    expect(text).toBe("﻿One.");
    expect(sentencesOf(text)).toEqual(["One."]);
    expect(sentencesOf(text).join(" ")).not.toBe(text);
  });

  it("synthetic_a_segment_that_trims_to_nothing_is_dropped", () => {
    // After the collapse only U+FEFF can make a segment empty: the contract keeps it as text, `trim()` removes it.
    expect(sentencesOf("﻿")).toEqual([]);
  });
});

describe("assembleSection", () => {
  const leaf = (path: number[], tag: string, raw: string, atoms: Atoms = NONE): Leaf => ({ path, tag, atoms, raw });

  it("collapses each leaf, keeps document order, and drops and counts the ones left empty", () => {
    const atoms: Atoms = { a: 2, br: 1, img: 0, noteref: 1 };
    const s = assembleSection(4, { id: "OEBPS/ch1.xhtml" }, "application/xhtml+xml", [
      leaf([0], "h1", "  Chapter\n One "),
      leaf([1], "p", " 　   "),
      leaf([2, 0], "li", "First.  Second.", atoms),
    ], false);
    expect(s).toEqual({
      index: 4, href: "OEBPS/ch1.xhtml", linear: true, content_type: "application/xhtml+xml",
      leaves: 3, dropped_empty: 1, body_fallback: false,
      paragraphs: [
        { path: [0], tag: "h1", atoms: NONE, text: "Chapter One", sentences: ["Chapter One"] },
        { path: [2, 0], tag: "li", atoms, text: "First. Second.", sentences: ["First.", "Second."] },
      ],
    });
  });

  it("reads `linear` as foliate does: only \"no\" is non-linear", () => {
    const linear = (v: string | null | undefined) => assembleSection(0, { id: "a.xhtml", linear: v }, "text/html", [], false).linear;
    expect(linear(undefined)).toBe(true);
    expect(linear(null)).toBe(true);
    expect(linear("yes")).toBe(true);
    expect(linear("no")).toBe(false);
  });

  it("keeps the body fallback as one leaf with an empty path, and a section with no text as no leaves", () => {
    const body = assembleSection(1, { id: "b.xhtml" }, "application/xhtml+xml", [leaf([], "body", "Just text.")], true);
    expect(body).toMatchObject({ leaves: 1, dropped_empty: 0, body_fallback: true, paragraphs: [{ path: [], tag: "body", text: "Just text." }] });
    const empty = assembleSection(2, { id: "c.xhtml" }, "application/xhtml+xml", [], true);
    expect(empty).toMatchObject({ leaves: 0, dropped_empty: 0, body_fallback: true, paragraphs: [] });
  });

  it("is the edition store's input, field for field", () => {
    const s = assembleSection(0, { id: "a.xhtml" }, "application/xhtml+xml", [leaf([0], "p", "Text.")], false);
    expect(Object.keys(s).sort()).toEqual(rustFields("SectionInput"));
    expect(Object.keys(s.paragraphs[0]).sort()).toEqual(rustFields("ParagraphInput"));
    // The store refuses a section whose paragraphs are not its leaves less the dropped ones.
    expect(s.paragraphs.length).toBe(s.leaves - s.dropped_empty);
  });
});

describe("the extraction's identity", () => {
  it("names the rules it applies; any change to them needs a new one", () => {
    expect(EXTRACTION_ID).toBe("leafblocks-1/pyws-3.12.0-ucd15/segmenter-en-1/atoms-1");
  });

  it("finds paragraphs with exactly read-aloud's selector", () => {
    const m = read("src/reader-engine/FoliateController.ts").match(/const CONTAINER = "([^"]+)";/);
    expect(m, "read-aloud's selector in FoliateController.ts").not.toBeNull();
    expect(LEAF_SELECTOR).toBe(m![1]);
  });
});
