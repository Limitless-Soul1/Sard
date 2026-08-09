// RESILIENCE-1 / WP-3 — the display rule: the DATABASE names a book, never the file.
//
// These tests pin the RULE, not the plumbing. The bug they exist to prevent is a surface quietly
// going back to `FoliateController.title` (the file's `dc:title`) — which is how a book renamed in
// the library kept its old embedded name in the reading chrome and on every shared photo card.

import { describe, expect, it } from "vitest";
import {
  displayAuthorOrUnknown,
  displayTitle,
  hintMeta,
  resolveBookMeta,
  titleIsGuess,
  titleProvenanceKey,
} from "../../src/lib/bookMeta";
import type { BookRow } from "../../src/lib/ipc";

// A row shaped like `library_list_books` returns it: `title`/`author` are already the COALESCE'd
// EFFECTIVE values, so an override is indistinguishable here — which is the point of the design.
function row(over: Partial<BookRow> = {}): BookRow {
  return {
    id: "b1",
    file_path: "C:\\books\\x.epub",
    title: "The Book",
    author: "An Author",
    language: "en",
    dir: "ltr",
    format: "epub",
    cover_path: null,
    added_at: 0,
    read_at: null,
    fraction: null,
    cfi: null,
    cover_fit: null,
    meta_provenance: null,
    ...over,
  } as BookRow;
}

const t = ((k: string) => k) as never; // identity: assert on the KEY, not on a translation

describe("WP-3 — resolveBookMeta", () => {
  it("passes the row's effective values straight through", () => {
    const m = resolveBookMeta(row());
    expect(m.title).toBe("The Book");
    expect(m.author).toBe("An Author");
    expect(m.language).toBe("en");
  });

  it("treats an empty or whitespace-only field as MISSING, not as a value", () => {
    // A book whose OPF carries `<dc:creator>   </dc:creator>` must not render a blank author line
    // that looks like a rendering bug. Missing is a state; the empty string is not.
    const m = resolveBookMeta(row({ title: "   ", author: "" }));
    expect(m.title).toBeNull();
    expect(m.author).toBeNull();
  });

  it("reads WP-2's per-field provenance", () => {
    const m = resolveBookMeta(row({ meta_provenance: '{"title":"filename","author":"default"}' }));
    expect(m.titleFrom).toBe("filename");
    expect(m.authorFrom).toBe("default");
  });

  it("survives a corrupt or unknown provenance blob instead of throwing", () => {
    // This column is written by a Rust struct today, but a hand-edited database, a partial write or
    // a future producer value must degrade to "assume the file said so" — never break the library.
    for (const blob of ["not json", "{}", "[]", '{"title":"martian"}', "null"]) {
      expect(resolveBookMeta(row({ meta_provenance: blob })).titleFrom).toBe("declared");
    }
  });

  it("treats a row with NO provenance as declared (rows imported before WP-2)", () => {
    expect(resolveBookMeta(row()).titleFrom).toBe("declared");
  });
});

describe("WP-3 — what a surface displays", () => {
  it("substitutes chrome for a missing title and never the word Unknown", () => {
    expect(displayTitle({ title: null }, t)).toBe("meta.untitledBook");
    expect(displayTitle({ title: "Real" }, t)).toBe("Real");
  });

  it("substitutes chrome for a missing author", () => {
    expect(displayAuthorOrUnknown({ author: null }, t)).toBe("meta.unknownAuthor");
    expect(displayAuthorOrUnknown({ author: "Real" }, t)).toBe("Real");
  });

  it("marks a fallen-back title as a GUESS, so it is never presented as fact", () => {
    // The reported book's `dc:title` is the literal string "Unknown"; WP-2 falls past it to the file
    // name. The reader is told that, and can correct it.
    expect(titleIsGuess({ titleFrom: "declared" })).toBe(false);
    expect(titleIsGuess({ titleFrom: "filename" })).toBe(true);
    expect(titleProvenanceKey({ titleFrom: "declared" })).toBeNull();
    expect(titleProvenanceKey({ titleFrom: "filename" })).toBe("meta.titleFrom.filename");
    expect(titleProvenanceKey({ titleFrom: "inferred" })).toBe("meta.titleFrom.inferred");
    expect(titleProvenanceKey({ titleFrom: "default" })).toBe("meta.titleFrom.default");
  });
});

describe("WP-3 — the hint is a fallback, not an authority", () => {
  it("carries what the launching surface showed", () => {
    const m = hintMeta("b1", "Shown Title", "Shown Author");
    expect(m.title).toBe("Shown Title");
    expect(m.author).toBe("Shown Author");
  });

  it("normalises blanks the same way a real row does", () => {
    const m = hintMeta("b1", "  ", null);
    expect(m.title).toBeNull();
    expect(m.author).toBeNull();
  });
});

describe("WP-3 — every i18n key this module can return actually exists", () => {
  // The resolver returns KEYS, so a typo would render as raw dotted text in the UI rather than fail
  // a build. Checking against the real locale files also proves Arabic was not left behind.
  it("is defined in both locales", async () => {
    const en = (await import("../../src/i18n/locales/en")).en as Record<string, string>;
    const ar = (await import("../../src/i18n/locales/ar")).ar as Record<string, string>;
    const keys = [
      "meta.untitledBook",
      "meta.unknownAuthor",
      "meta.titleGuess",
      "meta.titleFrom.inferred",
      "meta.titleFrom.filename",
      "meta.titleFrom.default",
    ];
    for (const k of keys) {
      expect(en[k], `en is missing ${k}`).toBeTruthy();
      expect(ar[k], `ar is missing ${k}`).toBeTruthy();
    }
  });

  it("left no caller behind on the retired reader.untitledBook key", async () => {
    // WP-3 collapsed two keys for one concept into one. A stale caller would silently render the
    // key name itself, so this asserts the retirement was complete.
    const { readFileSync } = await import("node:fs");
    const { globSync } = await import("node:fs");
    const files = globSync("src/**/*.{ts,tsx}");
    // Guard against a VACUOUS pass: an empty sweep would satisfy the assertion below while proving
    // nothing. `displayTitle` is what the retired key's callers were moved onto, so it must be seen.
    expect(files.length).toBeGreaterThan(50);
    const read = files.map((f: string) => readFileSync(f, "utf8"));
    expect(read.some((s) => s.includes("displayTitle"))).toBe(true);
    const offenders = files.filter((_f: string, i: number) => read[i].includes('"reader.untitledBook"'));
    expect(offenders).toEqual([]);
  });
});
