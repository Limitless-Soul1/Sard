// RESILIENCE-1 (NAV-2) — which TOC entry is the reader inside?
//
// THE REPORTED DEFECT. In Alice, the first two TOC entries could never become the active section,
// however often they were clicked. Both causes are here, and both were MEASURED on the real app:
//
//   1. foliate's `TOCProgress.getProgress` (progress.js:38-55) returns the entry before the first
//      anchor BELOW the viewport, and otherwise falls through to `items[items.length - 1]`. When
//      several anchors are visible at once it therefore always reports the LAST of them. Alice's
//      front matter is three headings inside ~530 px of one document, so the answer was always
//      "Contents" — from anywhere in the section.
//
//   2. The first attempt at a fix compared anchors against a COLLAPSED range at the visible start.
//      That works in scrolled flow (a TOC jump scrolls the anchor to the top, so the two coincide)
//      and fails in paged flow, where a column begins mid-content. Measured at page 4: the visible
//      range spans document nodes #47 → #63 while the heading is #62 — after the range START though
//      plainly on that page. Every anchor read as "not reached" and the highlight stuck on entry 0.
//
// THE RULE: first anchor VISIBLE on the current page → else the last anchor PASSED → else the
// section's first entry. Compared against the WHOLE visible range, which is what foliate reports.

import { describe, it, expect } from "vitest";
import { pickActiveTocEntry, type AnchorPosition, type TocSectionEntry } from "../../src/reader-engine/FoliateController";

/** Alice's front matter, in TOC order. */
const ALICE: TocSectionEntry[] = [
  { href: "f.xhtml#pgepubid00000", label: "Alice’s Adventures in Wonderland", fragment: "pgepubid00000" },
  { href: "f.xhtml#pgepubid00001", label: "THE MILLENNIUM FULCRUM EDITION 3.0", fragment: "pgepubid00001" },
  { href: "f.xhtml#pgepubid00002", label: "Contents", fragment: "pgepubid00002" },
];

/** Map a fragment to where it sits relative to the viewport. */
const from = (m: Record<string, AnchorPosition>) => (fragment: string) => m[fragment] ?? "missing";
const label = (e: TocSectionEntry | null) => e?.label ?? null;

// The EXACT values measured page by page through Alice section 1 in paged flow (tests/… probe
// nav4). Anchor document positions: #62, #68, #73. This table IS the regression case.
const MEASURED_PAGED: { page: number; cmp: [AnchorPosition, AnchorPosition, AnchorPosition]; expect: string }[] = [
  { page: 1, cmp: ["ahead", "ahead", "ahead"], expect: "Alice’s Adventures in Wonderland" },
  { page: 2, cmp: ["ahead", "ahead", "ahead"], expect: "Alice’s Adventures in Wonderland" },
  { page: 3, cmp: ["ahead", "ahead", "ahead"], expect: "Alice’s Adventures in Wonderland" },
  { page: 4, cmp: ["visible", "ahead", "ahead"], expect: "Alice’s Adventures in Wonderland" },
  { page: 5, cmp: ["passed", "visible", "visible"], expect: "THE MILLENNIUM FULCRUM EDITION 3.0" },
  { page: 6, cmp: ["passed", "passed", "passed"], expect: "Contents" },
  { page: 7, cmp: ["passed", "passed", "passed"], expect: "Contents" },
];

describe("paged flow — the measured pages of Alice section 1", () => {
  for (const { page, cmp, expect: want } of MEASURED_PAGED) {
    it(`page ${page}: [${cmp.join(", ")}] → "${want}"`, () => {
      const m = { pgepubid00000: cmp[0], pgepubid00001: cmp[1], pgepubid00002: cmp[2] };
      expect(label(pickActiveTocEntry(ALICE, from(m)))).toBe(want);
    });
  }

  it("EVERY entry becomes active at some point while paging through", () => {
    // The whole point of the report: entries 0 and 1 must be reachable, not just "Contents".
    const seen = new Set(
      MEASURED_PAGED.map(({ cmp }) =>
        label(pickActiveTocEntry(ALICE, from({ pgepubid00000: cmp[0], pgepubid00001: cmp[1], pgepubid00002: cmp[2] }))),
      ),
    );
    expect(seen).toEqual(new Set(ALICE.map((e) => e.label)));
  });

  it("never goes backwards while paging forward", () => {
    let last = -1;
    for (const { cmp, page } of MEASURED_PAGED) {
      const a = pickActiveTocEntry(ALICE, from({ pgepubid00000: cmp[0], pgepubid00001: cmp[1], pgepubid00002: cmp[2] }));
      const i = ALICE.findIndex((e) => e.href === a?.href);
      expect(i, `page ${page}`).toBeGreaterThanOrEqual(last);
      last = i;
    }
  });
});

describe("the two bugs this rule replaces", () => {
  it("does NOT prefer the last visible anchor (foliate's fallback)", () => {
    // Page 5 shows anchors 1 AND 2. foliate answers "Contents"; the reader is looking at the
    // edition line at the top of that page.
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "passed", pgepubid00001: "visible", pgepubid00002: "visible" })))).toBe(
      "THE MILLENNIUM FULCRUM EDITION 3.0",
    );
  });

  it("treats an anchor that is VISIBLE but after the range start as reached", () => {
    // The collapsed-start mistake. On page 4 anchor 0 is in plain view (`0`), and must be selected.
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "visible", pgepubid00001: "ahead", pgepubid00002: "ahead" })))).toBe(
      "Alice’s Adventures in Wonderland",
    );
  });
});

describe("scrolled flow — a TOC jump puts the anchor at the top", () => {
  it("selects the clicked entry for each of the three", () => {
    // Measured: clicking row N makes anchor N the range start, earlier anchors passed, later ones
    // still ahead or also visible.
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "visible", pgepubid00001: "ahead", pgepubid00002: "ahead" })))).toBe(ALICE[0].label);
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "passed", pgepubid00001: "visible", pgepubid00002: "visible" })))).toBe(ALICE[1].label);
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "passed", pgepubid00001: "passed", pgepubid00002: "visible" })))).toBe(ALICE[2].label);
  });

  it("reports the section's first entry before any anchor is on screen", () => {
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "ahead", pgepubid00001: "ahead", pgepubid00002: "ahead" })))).toBe(ALICE[0].label);
  });

  it("reports the last passed anchor when reading beyond them all", () => {
    expect(label(pickActiveTocEntry(ALICE, from({ pgepubid00000: "passed", pgepubid00001: "passed", pgepubid00002: "passed" })))).toBe(ALICE[2].label);
  });
});

describe("when position cannot decide, intent does", () => {
  // Alice's edition line and "Contents" are 182 px apart and ALWAYS land in the same column, so in
  // paged flow they are simultaneously and equally on screen. Position cannot separate them — a
  // page cannot scroll within itself — so whichever one position prefers, the other becomes
  // unclickable. `FoliateController.refineTocEntry` therefore prefers the entry the reader actually
  // asked for, and only while its anchor is still visible.
  //
  // This models that tiebreak over the same measured page-5 state, so the reasoning is pinned even
  // though the controller owns the wiring.
  const PAGE_5: Record<string, AnchorPosition> = {
    pgepubid00000: "passed",
    pgepubid00001: "visible",
    pgepubid00002: "visible",
  };

  const withIntent = (requestedHref: string | null) => {
    const requested = requestedHref ? ALICE.find((e) => e.href === requestedHref) : undefined;
    if (requested && from(PAGE_5)(requested.fragment) === "visible") return requested;
    return pickActiveTocEntry(ALICE, from(PAGE_5));
  };

  it("selects the requested entry when several share the page", () => {
    expect(label(withIntent(ALICE[2].href))).toBe("Contents");
    expect(label(withIntent(ALICE[1].href))).toBe("THE MILLENNIUM FULCRUM EDITION 3.0");
  });

  it("falls back to position when the request is for an entry NOT on screen", () => {
    // Entry 0 is behind the reader on page 5 — the request is stale and must not pin the highlight.
    expect(label(withIntent(ALICE[0].href))).toBe("THE MILLENNIUM FULCRUM EDITION 3.0");
  });

  it("falls back to position when there is no request at all", () => {
    expect(label(withIntent(null))).toBe("THE MILLENNIUM FULCRUM EDITION 3.0");
  });
});

describe("robustness", () => {
  it("returns null for an empty section", () => {
    expect(pickActiveTocEntry([], () => "passed")).toBeNull();
  });

  it("skips an anchor missing from the document rather than assuming it was reached", () => {
    // Common in converted books: a TOC pointing at an id the section does not contain. Treating it
    // as reached would jump the highlight past where the reader is.
    const m: Record<string, AnchorPosition> = { pgepubid00000: "passed", pgepubid00001: "missing", pgepubid00002: "ahead" };
    expect(label(pickActiveTocEntry(ALICE, from(m)))).toBe("Alice’s Adventures in Wonderland");
  });

  it("falls back to the first entry when NO anchor resolves", () => {
    expect(label(pickActiveTocEntry(ALICE, () => "missing"))).toBe(ALICE[0].label);
  });

  it("stops walking at the first unreached anchor — document order is the contract", () => {
    const asked: string[] = [];
    pickActiveTocEntry(ALICE, (f) => {
      asked.push(f);
      return f === "pgepubid00000" ? "passed" : "ahead";
    });
    expect(asked).toEqual(["pgepubid00000", "pgepubid00001"]); // never asked about the third
  });

  it("handles a single-entry section", () => {
    expect(label(pickActiveTocEntry([ALICE[0]], () => "ahead"))).toBe(ALICE[0].label);
    expect(label(pickActiveTocEntry([ALICE[0]], () => "visible"))).toBe(ALICE[0].label);
  });
});
