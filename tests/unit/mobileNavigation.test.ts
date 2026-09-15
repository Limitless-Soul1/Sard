// The mobile back stack's four rules, pinned.
//
// Android will close the application mid-book if Back is not answered deterministically, and the
// failure mode is silent: it looks like a crash to the reader. The rules live in pure functions
// precisely so they can be held to account here, with no device and no DOM.

import { describe, it, expect } from "vitest";
import {
  activePlace,
  deserialise,
  drawerOpen,
  initialNav,
  openDrawer,
  openPlace,
  openSheet,
  openSheetEntry,
  pop,
  push,
  readerBeneath,
  replace,
  serialise,
  top,
  type NavState,
  type Screen,
} from "../../src/features-mobile/app/navigation";

const BOOK = { id: "b1", filePath: "/books/one.epub" };
const reader: Screen = { kind: "reader", book: BOOK };
const sheet = (s: "contents" | "search" | "notes"): Screen => ({ kind: "sheet", sheet: s });

const stackOf = (...s: Screen[]): NavState => ({ stack: s });

describe("the stack starts and stays valid", () => {
  it("opens on the library", () => {
    expect(top(initialNav())).toEqual({ kind: "library" });
  });

  it("never pops the last entry — an unconsumed Back is what leaves the app", () => {
    // `null` is the signal the bridge forwards to the platform. If this ever returned an empty stack
    // instead, the shell would render nothing and the reader would see a blank screen.
    expect(pop(initialNav())).toBeNull();
  });

  it("pops exactly one entry per Back, in the order they were opened", () => {
    let n = push(push(initialNav(), reader), sheet("contents"));
    n = pop(n)!;
    expect(top(n)).toEqual(reader);
    n = pop(n)!;
    expect(top(n)).toEqual({ kind: "library" });
    expect(pop(n)).toBeNull();
  });
});

describe("rule 1 — the reading position is never a stack entry", () => {
  it("popping a sheet returns to the SAME reader entry, not a new one", () => {
    const n = push(push(initialNav(), reader), sheet("search"));
    const back = pop(n)!;
    // Identity, not just shape: a fresh `{kind:"reader"}` would re-mount the reader and re-navigate
    // the book, which is precisely what rule 1 forbids.
    expect(top(back)).toBe(reader);
  });

  it("finds the reader beneath any number of sheets", () => {
    const n = push(push(push(initialNav(), reader), sheet("notes")), sheet("contents"));
    expect(readerBeneath(n)).toBe(reader);
  });

  it("reports no reader when none is open", () => {
    expect(readerBeneath(push(initialNav(), sheet("search")))).toBeNull();
  });
});

describe("the drawer is an entry, so Back closes it and nothing else", () => {
  it("opens onto the library and leaves the library underneath", () => {
    const n = openDrawer(initialNav());
    expect(drawerOpen(n)).toBe(true);
    expect(n.stack).toHaveLength(2);
    expect(n.stack[0]).toEqual({ kind: "library" });
  });

  it("closes on one Back, and the SECOND Back is what leaves the app", () => {
    // This is the Gate-2 contract, and the reason the drawer is deliberately NOT bound to the edge
    // gesture: Android delivers an edge swipe as Back, so a drawer opened by it would make the first
    // Back at the root a no-op — exactly the defect the emulator found and this fix removed.
    const opened = openDrawer(initialNav());
    const closed = pop(opened)!;
    expect(drawerOpen(closed)).toBe(false);
    expect(top(closed)).toEqual({ kind: "library" });
    expect(pop(closed)).toBeNull();
  });

  it("opening twice is a no-op, so a double tap cannot demand two Backs", () => {
    const once = openDrawer(initialNav());
    expect(openDrawer(once)).toBe(once);
  });

  it("root Back still leaves the app when no drawer is open", () => {
    expect(pop(initialNav())).toBeNull();
  });
});

describe("places are reached from the drawer, and Back returns to the library", () => {
  it("consumes the drawer rather than burying it", () => {
    const n = openPlace(openDrawer(initialNav()), "settings");
    expect(n.stack).toEqual([{ kind: "library" }, { kind: "settings" }]);
    // Back goes home, not back into the menu the reader has already finished with.
    expect(top(pop(n)!)).toEqual({ kind: "library" });
  });

  it("cannot grow the stack however many places are chosen", () => {
    let n = initialNav();
    for (const p of ["highlights", "bookmarks", "settings", "highlights"] as const) {
      n = openPlace(openDrawer(n), p);
    }
    expect(n.stack).toHaveLength(2);
  });

  it("choosing the library from the drawer returns to a bare root", () => {
    const n = openPlace(openDrawer(initialNav()), "library");
    expect(n.stack).toEqual([{ kind: "library" }]);
    expect(pop(n)).toBeNull();
  });

  it("is a no-op when the library is already the whole stack", () => {
    const n = initialNav();
    expect(openPlace(n, "library")).toBe(n);
  });

  it("reports the deepest place as active, even under a reader and sheets", () => {
    const n = push(push(openPlace(initialNav(), "bookmarks"), reader), sheet("notes"));
    expect(activePlace(n)).toBe("bookmarks");
  });

  it("keeps reporting the place beneath while the drawer is open, so the row stays lit", () => {
    expect(activePlace(openDrawer(openPlace(initialNav(), "highlights")))).toBe("highlights");
  });
});

describe("a sheet over the reader — the hub", () => {
  const hub: Screen = { kind: "sheet", sheet: "hub" };

  it("adds exactly one entry, and Back dismisses only the sheet", () => {
    const n = openSheetEntry(push(initialNav(), reader), "hub");
    expect(n.stack).toHaveLength(3);
    expect(top(n)).toEqual(hub);
    const back = pop(n)!;
    // Rule 1 — the SAME reader entry, not a fresh one, or the book would re-open and lose its place.
    expect(top(back)).toBe(reader);
  });

  it("cannot stack duplicates, so one gesture never costs two Backs", () => {
    const once = openSheetEntry(push(initialNav(), reader), "hub");
    expect(openSheetEntry(once, "hub")).toBe(once);
    expect(openSheetEntry(once, "hub").stack).toHaveLength(3);
  });

  it("keeps the reader reachable underneath so the shell can keep rendering it", () => {
    const n = openSheetEntry(push(initialNav(), reader), "hub");
    expect(readerBeneath(n)).toBe(reader);
    expect(openSheet(n)).toBe("hub");
  });

  it("Reader → Hub → Back → Reader → Back → Library", () => {
    let n = openSheetEntry(push(initialNav(), reader), "hub");
    n = pop(n)!;
    expect(top(n)).toBe(reader);
    n = pop(n)!;
    expect(top(n)).toEqual({ kind: "library" });
    expect(pop(n)).toBeNull(); // and the next Back leaves the app
  });

  it("reports no sheet when the reader is bare", () => {
    expect(openSheet(push(initialNav(), reader))).toBeNull();
  });
});

describe("replace — the Photo Card flow", () => {
  it("swaps the top entry so Back cannot reopen work that is already saved", () => {
    const composer: Screen = { kind: "sheet", sheet: "book-details" };
    const gallery: Screen = { kind: "sheet", sheet: "notes" };
    const n = replace(push(push(initialNav(), reader), composer), gallery);
    expect(top(n)).toBe(gallery);
    expect(top(pop(n)!)).toBe(reader); // the composer is gone, not buried
  });
});

describe("rule 4 — the stack survives a killed WebView", () => {
  it("round-trips", () => {
    const n = push(push(openPlace(initialNav(), "bookmarks"), reader), sheet("contents"));
    expect(deserialise(serialise(n))).toEqual(n);
  });

  it("carries enough to reopen the right book after a process death", () => {
    const restored = deserialise(serialise(push(initialNav(), reader)));
    const r = top(restored) as Extract<Screen, { kind: "reader" }>;
    expect(r.book.id).toBe("b1");
    expect(r.book.filePath).toBe("/books/one.epub");
  });

  it("falls back to the root rather than throwing on anything unusable", () => {
    // A restore that throws would cost the reader their library as well as their place. Every one of
    // these must land on a working shell.
    for (const bad of [null, "", "not json", "{}", "[]", '[{"kind":"nonsense"}]', '"a string"']) {
      expect(deserialise(bad)).toEqual(initialNav());
    }
  });

  it("refuses a stack that does not start at a place", () => {
    // The bottom of the stack is what Back finally reaches; a reader there would be unescapable.
    expect(deserialise(JSON.stringify([reader, sheet("search")]))).toEqual(initialNav());
  });

  it("never restores an open drawer — a menu the reader did not ask to reopen", () => {
    const raw = JSON.stringify([{ kind: "library" }, { kind: "drawer" }]);
    expect(deserialise(raw)).toEqual(initialNav());
  });

  it("drops unrecognised entries from an otherwise valid stack", () => {
    const raw = JSON.stringify([{ kind: "library" }, { kind: "from-a-newer-build" }, reader]);
    expect(deserialise(raw).stack).toEqual([{ kind: "library" }, reader]);
  });
});

describe("push does not mutate", () => {
  it("leaves the previous state intact, so React sees a new object", () => {
    const before = stackOf({ kind: "library" });
    const after = push(before, reader);
    expect(before.stack).toHaveLength(1);
    expect(after.stack).toHaveLength(2);
    expect(after).not.toBe(before);
  });
});
