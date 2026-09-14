// A CONTROL AND THE PANEL IT OPENS MUST MEET ON THE SAME EDGE.
//
// The defect this guards was not a wrong coordinate — it was a rule with no single owner. RAWY-32
// said a panel docks on the same physical side as the button that opens it, but the side lived in
// the stylesheet (`rp-lead` / `rp-trail`) while the button's side lived in the toolbar's markup, so
// the two could disagree and did: Contents and Search opened panels on the left from buttons on the
// right, for as long as the bar had only a right-hand control group.
//
// These tests hold the DECLARATION honest. They cannot see the rendered bar — this suite runs in
// `node` with no DOM on purpose (see vitest.config.ts: a fake DOM "would invite tests that pass in a
// fake DOM and lie about WebView2"), and where a control physically lands is a layout question that
// only the running application can answer. That check is done by looking at it. What is testable
// here is that there is ONE statement of the rule and that the dock class follows it, so the two
// halves cannot silently drift apart again.
import { describe, it, expect } from "vitest";
import {
  READER_PANEL_SIDE,
  docksLeft,
  panelDockClass,
  type ReaderPanel,
} from "../../src/features/reader/panelSides";

const ALL: ReaderPanel[] = ["contents", "search", "notes", "settings"];

describe("the reading panels' sides", () => {
  it("names a side for every panel a toolbar control opens", () => {
    for (const p of ALL) expect(READER_PANEL_SIDE[p]).toMatch(/^(left|right)$/);
    // Exhaustive on purpose: a new panel added to the union without an entry fails here rather than
    // acquiring a side by accident, which is how the original mismatch survived.
    expect(Object.keys(READER_PANEL_SIDE).sort()).toEqual([...ALL].sort());
  });

  it("puts Contents and Search on the same edge as each other", () => {
    // They share one dock — opening either closes the other — so a split between them would be a
    // control pointing at a panel that is not there.
    expect(READER_PANEL_SIDE.contents).toBe(READER_PANEL_SIDE.search);
    expect(docksLeft("contents")).toBe(true);
    expect(docksLeft("search")).toBe(true);
  });

  it("keeps Notes and the settings slide-over on the opposite edge", () => {
    // A left panel and a right panel coexist; that is the reason two edges exist at all.
    expect(READER_PANEL_SIDE.notes).toBe("right");
    expect(READER_PANEL_SIDE.settings).toBe("right");
    expect(READER_PANEL_SIDE.notes).not.toBe(READER_PANEL_SIDE.contents);
  });

  it("derives the dock class from the side, and only from the side", () => {
    for (const p of ALL) {
      expect(panelDockClass(p)).toBe(READER_PANEL_SIDE[p] === "left" ? "rp-lead" : "rp-trail");
    }
    // The historical names are PHYSICAL despite reading as logical ones. Pinned literally, because
    // a future rename that flipped their meaning would silently reverse every panel in the reader.
    expect(panelDockClass("contents")).toBe("rp-lead");
    expect(panelDockClass("notes")).toBe("rp-trail");
  });

  it("decides nothing from the reading or interface direction", () => {
    // The whole reason this is correct in Arabic AND English is that it never asks which is in use:
    // the chrome is pinned `direction: ltr` and the panels use physical `left`/`right`, so a control
    // and its panel meet on the same screen edge in both. A direction-sensitive answer here would be
    // the follow-direction model RAWY-32 already replaced.
    const source = String(panelDockClass) + String(docksLeft);
    expect(source).not.toMatch(/rtl|ltr|dir\b|lang/i);
  });
});
