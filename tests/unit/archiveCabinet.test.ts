// THE CABINET'S ARITHMETIC — what a drawer face is allowed to claim.
//
// The face makes five factual claims about a book: how much was kept from it, in which inks, what the
// newest thing kept was, who wrote it, and when it was last opened. Every one is derived, so every one
// can be wrong in a way no type catches — a tally that counts a note twice, an ink spectrum that
// invents a colour a bare note never had, a "newest" that is merely the first row returned.
//
// This is the part with a right answer a browser is not needed to check. What it CANNOT prove is that
// the drawer looks right; that is checked by running the application.

import { describe, expect, it } from "vitest";

import { buildDrawers, letterOf, sortDrawers, tabHeight, MAX_TABS, TAB_MIN_H, TAB_MAX_H } from "../../src/features/library/archive/model";
import type { AnnoItem, BookRow } from "../../src/lib/ipc";
import { flattenInk, markStyle } from "../../src/features/library/archive/mark";
import { tabColor } from "../../src/features/library/archive/SlipWall";

const anno = (p: Partial<AnnoItem>): AnnoItem => ({
  id: p.id ?? "a1",
  kind: p.kind ?? "highlight",
  book_id: p.book_id ?? "b1",
  book_title: p.book_title ?? "A Book",
  file_path: p.file_path ?? "/x.epub",
  book_dir: p.book_dir ?? "ltr",
  chapter_label: p.chapter_label ?? "One",
  color: p.color ?? null,
  text: p.text ?? "some text",
  note: p.note ?? null,
  cfi: p.cfi ?? "epubcfi(/6/4)",
  created_at: p.created_at ?? 1000,
  note_id: p.note_id ?? null,
  tags: p.tags ?? [],
  note_title: p.note_title ?? null,
  // A mark the reader made himself names nobody; one that arrived in a deposit carries its sender.
  sender: p.sender ?? null,
});

const book = (p: Partial<BookRow>): BookRow =>
  ({
    id: p.id ?? "b1",
    file_path: p.file_path ?? "/x.epub",
    format: "epub",
    title: p.title ?? "A Book",
    author: p.author ?? "An Author",
    language: null,
    dir: p.dir ?? "ltr",
    cover_path: p.cover_path ?? null,
    added_at: 1,
    last_opened_at: p.last_opened_at ?? null,
    fraction: null,
    read_at: null,
    cover_fit: null,
  }) as BookRow;

describe("one drawer per book", () => {
  it("groups every mark under the book it came from", () => {
    const d = buildDrawers(
      [anno({ id: "1", book_id: "b1" }), anno({ id: "2", book_id: "b2" }), anno({ id: "3", book_id: "b1" })],
      [book({ id: "b1" }), book({ id: "b2", title: "Other" })],
    );
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.bookId === "b1")!.items).toHaveLength(2);
  });

  it("a book with nothing kept from it is not a drawer at all", () => {
    // The cabinet is the archive, not the library: a book nobody marked has no drawer to pull.
    const d = buildDrawers([anno({ book_id: "b1" })], [book({ id: "b1" }), book({ id: "b99", title: "Unread" })]);
    expect(d.map((x) => x.bookId)).toEqual(["b1"]);
  });

  it("takes author, cover and last-opened from the BOOK, which an annotation does not carry", () => {
    const d = buildDrawers(
      [anno({ book_id: "b1" })],
      [book({ id: "b1", author: "Written By", cover_path: "/c.png", last_opened_at: 555 })],
    );
    expect(d[0].author).toBe("Written By");
    expect(d[0].coverPath).toBe("/c.png");
    expect(d[0].lastOpenedAt).toBe(555);
  });

  it("survives a book the library list does not return", () => {
    // A row can outlive its join for one render. The face falls back to what the mark itself carries
    // rather than rendering a drawer with no name on it.
    const d = buildDrawers([anno({ book_id: "gone", book_title: "Still Named" })], []);
    expect(d[0].title).toBe("Still Named");
    expect(d[0].author).toBeNull();
  });
});

describe("the tally counts what the reader actually made", () => {
  it("separates highlights from notes by CONTENT, not by the raw kind", () => {
    // A highlight carrying a note arrives as kind "highlight" with a body folded in. Counting the raw
    // kind put that one passage in both columns on the surface this replaced.
    const d = buildDrawers(
      [
        anno({ id: "1", kind: "highlight", color: "amber" }),
        anno({ id: "2", kind: "note", text: "a thought" }),
        anno({ id: "3", kind: "highlight", color: "sky", note: "with a note" }),
      ],
      [book({})],
    );
    expect(d[0].highlights + d[0].notes).toBe(3);
    expect(d[0].highlights).toBeGreaterThan(0);
    expect(d[0].notes).toBeGreaterThan(0);
  });
});

describe("the ink spectrum is honest", () => {
  it("carries one entry per ink ACTUALLY used, most-used first", () => {
    const d = buildDrawers(
      [
        anno({ id: "1", color: "amber" }),
        anno({ id: "2", color: "sky" }),
        anno({ id: "3", color: "amber" }),
        anno({ id: "4", color: "amber" }),
      ],
      [book({})],
    );
    expect(d[0].inks.map((i) => i.color)).toEqual(["amber", "sky"]);
    expect(d[0].inks[0].count).toBe(3);
  });

  it("a bare note contributes no ink, because a note slip has no mark", () => {
    const d = buildDrawers(
      [anno({ id: "1", kind: "note", color: null }), anno({ id: "2", color: "amber" })],
      [book({})],
    );
    expect(d[0].inks).toHaveLength(1);
    expect(d[0].inks[0].color).toBe("amber");
  });

  it("a custom hex ink is an ink like any other", () => {
    const d = buildDrawers([anno({ color: "#B08968" })], [book({})]);
    expect(d[0].inks[0].color).toBe("#B08968");
  });
});

describe("the protruding tabs encode volume as well as palette", () => {
  it("the busiest ink gets the tallest tab and the rest scale under it", () => {
    expect(tabHeight(10, 10)).toBe(TAB_MAX_H);
    expect(tabHeight(0, 10)).toBe(TAB_MIN_H);
    expect(tabHeight(5, 10)).toBeGreaterThan(TAB_MIN_H);
    expect(tabHeight(5, 10)).toBeLessThan(TAB_MAX_H);
  });

  it("a single-ink drawer still shows a tab rather than a hairline", () => {
    expect(tabHeight(1, 1)).toBe(TAB_MAX_H);
  });

  it("no division by zero when a book has no inks at all", () => {
    expect(tabHeight(0, 0)).toBe(TAB_MIN_H);
  });

  it("the silhouette is capped, but the dot spectrum is not", () => {
    // More inks than the face can carry: the tabs are trimmed to what fits, and the spectrum below
    // still reports every one, so the face never under-reports what the book holds.
    const many = ["amber", "marigold", "coral", "rose", "purple", "sky", "teal", "green"];
    const d = buildDrawers(many.map((c, i) => anno({ id: String(i), color: c })), [book({})]);
    expect(d[0].inks.length).toBe(many.length);
    expect(d[0].inks.slice(0, MAX_TABS).length).toBe(MAX_TABS);
  });
});

describe("the newest mark is the one quoted on the face", () => {
  it("picks the most recent, not the first row returned", () => {
    const d = buildDrawers(
      [
        anno({ id: "old", text: "older", created_at: 100 }),
        anno({ id: "new", text: "newest", created_at: 900 }),
        anno({ id: "mid", text: "middle", created_at: 500 }),
      ],
      [book({})],
    );
    expect(d[0].latest!.text).toBe("newest");
  });

  it("quotes it with the ink it was marked in", () => {
    const d = buildDrawers([anno({ text: "marked", color: "teal", created_at: 900 })], [book({})]);
    expect(d[0].latest!.color).toBe("teal");
  });

  it("skips a mark with no text rather than quoting an empty line", () => {
    const d = buildDrawers(
      [anno({ id: "1", text: "   ", created_at: 900 }), anno({ id: "2", text: "real", created_at: 100 })],
      [book({})],
    );
    expect(d[0].latest!.text).toBe("real");
  });

  it("is null when the book holds nothing quotable", () => {
    const d = buildDrawers([anno({ text: "" })], [book({})]);
    expect(d[0].latest).toBeNull();
  });

  it("the wall behind the face is newest-first too", () => {
    const d = buildDrawers(
      [anno({ id: "a", created_at: 1 }), anno({ id: "b", created_at: 9 })],
      [book({})],
    );
    expect(d[0].items.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("the cabinet's order", () => {
  it("puts the most recently opened drawer first", () => {
    const d = sortDrawers(
      buildDrawers(
        [anno({ id: "1", book_id: "b1" }), anno({ id: "2", book_id: "b2" })],
        [book({ id: "b1", last_opened_at: 10 }), book({ id: "b2", title: "B", last_opened_at: 99 })],
      ),
      "en",
    );
    expect(d[0].bookId).toBe("b2");
  });

  it("a book never opened sits BELOW every book that has been", () => {
    // Never-opened must not sort as though it were opened at the epoch — the same two-tier rule the
    // profiles list uses for a هيئة never worn.
    const d = sortDrawers(
      buildDrawers(
        [anno({ id: "1", book_id: "b1" }), anno({ id: "2", book_id: "b2" })],
        [book({ id: "b1", last_opened_at: null }), book({ id: "b2", title: "B", last_opened_at: 1 })],
      ),
      "en",
    );
    expect(d.map((x) => x.bookId)).toEqual(["b2", "b1"]);
  });

  it("is total, so the grid cannot reshuffle between renders", () => {
    const build = () =>
      sortDrawers(
        buildDrawers(
          [anno({ id: "1", book_id: "b1", created_at: 5 }), anno({ id: "2", book_id: "b2", created_at: 5 })],
          [book({ id: "b1", title: "Alpha" }), book({ id: "b2", title: "Beta" })],
        ),
        "en",
      );
    expect(build().map((x) => x.bookId)).toEqual(build().map((x) => x.bookId));
  });
});

describe("a coverless book still gets a plate", () => {
  it("shows the first letter that actually draws something", () => {
    expect(letterOf("Moby-Dick")).toBe("M");
    expect(letterOf("  spaced")).toBe("S");
  });

  it("skips leading punctuation, which names no book", () => {
    expect(letterOf('"Quoted"')).toBe("Q");
    expect(letterOf("«مقتبس»")).toBe("م");
  });

  it("never renders an empty plate", () => {
    expect(letterOf("")).toBe("?");
    expect(letterOf("!!!")).toBe("?");
  });
});

describe("a slip's tab wears the annotation's own ink", () => {
  // The tab is the identifier for THIS annotation's colour, so it may not fall back to a generic
  // theme accent while the annotation has a colour of its own — and two different inks may never
  // resolve to the same tab.
  const hl = { amber: "#e8c36a", marigold: "#e7a867", coral: "#e2978d", rose: "#d98ca6",
    purple: "#bfa8d6", sky: "#9dc0d6", teal: "#8dc3ba", green: "#a8c98a" } as Record<string, string>;
  const ACCENT = "#9c5a3c";
  const at = (p: Partial<AnnoItem>) => tabColor(anno(p), hl as never, ACCENT);

  it("a highlight's tab is its stored slot, resolved against the live theme", () => {
    expect(at({ color: "amber" })).toBe(hl.amber);
    expect(at({ color: "teal" })).toBe(hl.teal);
  });

  it("a custom hex ink is carried through untouched", () => {
    expect(at({ color: "#B08968" })).toBe("#B08968");
  });

  it("a note that carries a colour wears that colour, not the accent", () => {
    expect(at({ kind: "note", color: "purple" })).toBe(hl.purple);
  });

  it("a note with no colour of its own falls back to the accent, as the reference does", () => {
    expect(at({ kind: "note", color: null })).toBe(ACCENT);
  });

  it("different inks never collapse to the same tab", () => {
    const seen = new Set(["amber", "marigold", "coral", "rose", "purple", "sky", "teal", "green"].map((c) => at({ color: c })));
    expect(seen.size).toBe(8);
  });
});

describe("a mark is flattened, so the glyphs are never faded with the ink", () => {
  // `opacity` is an ELEMENT property. Applied to the span that wraps the words it takes the text down
  // with the ink, which is what made a marked quotation read as a dark panel laid over the passage.
  // The mark is composited to one flat colour instead — the pixel the book produces, with the text
  // drawn over it at full contrast.
  it("multiply can only darken the ground", () => {
    const out = flattenInk({ fill: "#808080", blend: "multiply", opacity: 1 }, "#ffffff");
    expect(out).toBe("#808080");
    const onDark = flattenInk({ fill: "#808080", blend: "multiply", opacity: 1 }, "#000000");
    expect(onDark).toBe("#000000");
  });

  it("screen can only lighten it", () => {
    expect(flattenInk({ fill: "#808080", blend: "screen", opacity: 1 }, "#000000")).toBe("#808080");
    expect(flattenInk({ fill: "#808080", blend: "screen", opacity: 1 }, "#ffffff")).toBe("#ffffff");
  });

  it("strength mixes toward the ground, it does not fade the element", () => {
    const none = flattenInk({ fill: "#000000", blend: "multiply", opacity: 0 }, "#ffffff");
    expect(none).toBe("#ffffff");
    const half = flattenInk({ fill: "#000000", blend: "multiply", opacity: 0.5 }, "#ffffff");
    expect(half).toBe("#808080");
  });

  it("always returns an opaque colour — never a translucent one", () => {
    for (const g of ["#ffffff", "#1c1c1e", "#f5eedd"]) {
      const out = flattenInk({ fill: "#e8c36a", blend: "multiply", opacity: 0.72 }, g);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("different inks stay distinguishable on the same ground", () => {
    const ground = "#f5eedd";
    const seen = new Set(
      ["#e8c36a", "#8dc3ba", "#bfa8d6", "#e2978d"].map((ink) =>
        flattenInk({ fill: ink, blend: "multiply", opacity: 0.72 }, ground),
      ),
    );
    expect(seen.size).toBe(4);
  });

  it("a ground that is not a plain colour leaves the ink alone rather than blanking it", () => {
    expect(flattenInk({ fill: "#e8c36a", blend: "multiply", opacity: 0.72 }, "var(--paper-bg)")).toBe("#e8c36a");
  });

  it("the style it emits carries no blend and no opacity", () => {
    const st = markStyle({ fill: "#e8c36a", blend: "multiply", opacity: 0.72 }, "#f5eedd") as Record<string, unknown>;
    expect(st.mixBlendMode).toBeUndefined();
    expect(st.opacity).toBeUndefined();
    expect(String(st.background)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("direction belongs to the application, not to the content", () => {
  // A Latin title in an Arabic interface, or an English passage marked in an Arabic book, must not
  // turn its own block around inside an otherwise mirrored cabinet. The script still chooses the
  // FACE — that is typography — but never the direction.
  it("no archive component sets a direction from the text it is rendering", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["archive/Cabinet.tsx", "archive/SlipWall.tsx", "Inbox.tsx"]) {
      const src = readFileSync(new URL("../../src/features/library/" + f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/dir=\{[^}]*\?[^}]*"rtl"/);
      expect(src, f).not.toMatch(/dir="(rtl|ltr)"/);
    }
  });
});

describe("the Library's other shelves are not disturbed", () => {
  it("the archive owns its own class namespace", async () => {
    // The Bookmarks shelf and the READER's annotations panel both render `.inbox-*`. This surface must
    // not restyle them by sharing their names, so its own stylesheet may not define one.
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../../src/styles/archive.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/^\s*\.inbox-/m);
  });
});
