// RESILIENCE-1 / WP-4F — what the position readout is allowed to say.
//
// The reported issue was "there is no page counter". These tests pin the DECISION, because the
// tempting fix (synthesise a page count) is the one that must never be made: Sard's typography
// controls would move it under the reader, and a number that changes when you drag a slider is
// worse than no number. A book's REAL printed page is shown as a page; everything else is shown as
// a location, and says so.

import { describe, expect, it } from "vitest";
import { isForwardConsistent, positionReadout } from "../../src/reader-engine/position";

const id = (n: number) => String(n);

describe("WP-4F — which tier is chosen", () => {
  it("prefers the book's REAL printed page when it ships a page-list", () => {
    const r = positionReadout({ location: { current: 5, total: 129 }, pageLabel: "42" }, id);
    expect(r).toEqual({ kind: "page", current: "42", total: null, labelKey: "reader.pos.page" });
  });

  it("shows a page label VERBATIM — front matter is not renumbered", () => {
    // A roman-numeral label is the edition's own; turning "xii" into 12 would misstate the book.
    const r = positionReadout({ location: { current: 2, total: 129 }, pageLabel: "xii" }, id);
    expect(r?.current).toBe("xii");
  });

  it("falls back to a location, and NAMES it a location", () => {
    const r = positionReadout({ location: { current: 5, total: 129 }, pageLabel: null }, id);
    expect(r?.kind).toBe("location");
    expect(r?.labelKey).toBe("reader.pos.location");
    expect(r?.total).toBe("129");
  });

  it("counts locations from 1 — foliate's index is 0-based, readers are not", () => {
    expect(positionReadout({ location: { current: 0, total: 129 }, pageLabel: null }, id)?.current).toBe("1");
  });

  it("shows NOTHING rather than inventing a number", () => {
    expect(positionReadout({ location: null, pageLabel: null }, id)).toBeNull();
    expect(positionReadout({ location: { current: 0, total: 0 }, pageLabel: null }, id)).toBeNull();
    expect(positionReadout({ location: { current: NaN, total: 10 }, pageLabel: null }, id)).toBeNull();
  });

  it("treats a blank page label as absent, not as a page called ''", () => {
    const r = positionReadout({ location: { current: 3, total: 20 }, pageLabel: "   " }, id);
    expect(r?.kind).toBe("location");
  });

  it("never reports a location beyond the total", () => {
    // A relocate at the very end can report current === total with a 0-based index; +1 would
    // produce "130 of 129", which reads as a bug to anyone who notices it.
    const r = positionReadout({ location: { current: 129, total: 129 }, pageLabel: null }, id);
    expect(r?.current).toBe("129");
  });

  it("formats through the caller's locale formatter, both numbers", () => {
    const arabic = (n: number) => n.toLocaleString("ar-EG");
    const r = positionReadout({ location: { current: 4, total: 129 }, pageLabel: null }, arabic);
    expect(r?.current).toBe(arabic(5));
    expect(r?.total).toBe(arabic(129));
  });
});

describe("WP-4F — the readout must not go backwards while reading forwards", () => {
  it("accepts a forward move", () => {
    expect(isForwardConsistent(
      { location: { current: 4, total: 129 }, pageLabel: null },
      { location: { current: 5, total: 129 }, pageLabel: null },
    )).toBe(true);
  });

  it("rejects a backward move on the same scale", () => {
    // This is the shape of the mistake worth catching: plumbing the wrong field through looks
    // perfectly fine in a screenshot and only shows up as a counter that stutters.
    expect(isForwardConsistent(
      { location: { current: 5, total: 129 }, pageLabel: null },
      { location: { current: 4, total: 129 }, pageLabel: null },
    )).toBe(false);
  });

  it("does not cry foul when the scale itself was re-based", () => {
    // A re-layout can change `total`; comparing across two different scales proves nothing.
    expect(isForwardConsistent(
      { location: { current: 90, total: 129 }, pageLabel: null },
      { location: { current: 10, total: 40 }, pageLabel: null },
    )).toBe(true);
  });

  it("says nothing when there is nothing to compare", () => {
    expect(isForwardConsistent({ location: null, pageLabel: null }, { location: { current: 1, total: 9 }, pageLabel: null })).toBe(true);
  });
});

describe("WP-4F — both locales define every key the readout can return", () => {
  it("is defined in en and ar", async () => {
    const en = (await import("../../src/i18n/locales/en")).en as Record<string, string>;
    const ar = (await import("../../src/i18n/locales/ar")).ar as Record<string, string>;
    for (const k of ["reader.pos.page", "reader.pos.location"]) {
      expect(en[k], `en is missing ${k}`).toBeTruthy();
      expect(ar[k], `ar is missing ${k}`).toBeTruthy();
    }
    // The location string must carry BOTH placeholders, or the total silently vanishes at runtime.
    for (const loc of [en, ar]) {
      expect(loc["reader.pos.location"]).toContain("{n}");
      expect(loc["reader.pos.location"]).toContain("{t}");
      expect(loc["reader.pos.page"]).toContain("{n}");
    }
  });
});
