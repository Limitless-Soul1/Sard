// THREE THINGS THE LIBRARY GOT WRONG, and the rules that now make each of them unrepresentable.
//
// Each block names the symptom the reader reported, then asserts the rule that answers it — stated
// as the answer a caller gets, so an implementation that reaches it another way keeps passing and
// one that quietly restores the old behaviour does not.
//
//   1. Pressing and holding a book ALREADY IN THE LIBRARY raised «أفلِت لإضافة الكتب» — the overlay
//      that answers a file arriving from outside — instead of lifting the book to be re-arranged.
//   2. A library nobody had sorted opened in «الأحدث قراءةً», so it re-shuffled itself by the clock
//      every time a book was opened, and an order arranged by hand was invisible until the reader
//      found the sort menu.
//   3. In Covers, every landing place was drawn as a short wide bar — measured 108×56 — beside
//      covers 108×162, because the place was being stamped with the Details ROW class.
import { describe, expect, it } from "vitest";
import {
  externalDragState,
  type DragDropPayload,
  type ExternalDrag,
} from "../../src/features/library/externalDrag";
import {
  DEFAULT_SORT,
  DESIGN_SORTS,
  DESIGN_VIEWS,
  presentAfterFiling,
  restoredSort,
  slotClassFor,
  type DesignView,
} from "../../src/features/library/design/model";

/** Fold a whole gesture through the rule, the way the webview delivers one. */
const run = (events: DragDropPayload[]): ExternalDrag =>
  events.reduce<ExternalDrag>((d, e) => externalDragState(d, e), null);

const FILE = "C:/books/al-muqaddima.epub";

describe("a drag is an import only if it brought files", () => {
  it("raises the overlay for a file arriving from outside, and counts what arrived", () => {
    expect(run([{ type: "enter", paths: [FILE] }])).toEqual({ count: 1 });
    expect(run([{ type: "enter", paths: [FILE, "C:/books/kalila.epub"] }])).toEqual({ count: 2 });
  });

  it("keeps it up while the file is moved about, and puts it away when the file leaves", () => {
    expect(run([{ type: "enter", paths: [FILE] }, { type: "over" }])).toEqual({ count: 1 });
    expect(run([{ type: "enter", paths: [FILE] }, { type: "over" }, { type: "over" }])).toEqual({ count: 1 });
    expect(run([{ type: "enter", paths: [FILE] }, { type: "leave" }])).toBeNull();
    expect(run([{ type: "enter", paths: [FILE] }, { type: "drop", paths: [FILE] }])).toBeNull();
  });

  // THE DEFECT ITSELF. A press-and-hold on a book already in the library sent the webview a drag
  // that carried NOTHING — there were no files, because no file was arriving. `over` answered it by
  // conjuring an overlay out of nothing (`d ?? { count: 0 }`), so the reader was told to drop a book
  // they already owned into the library it was already in, and the press was spent on saying so.
  it("raises nothing at all for a drag that carries no files", () => {
    expect(run([{ type: "enter", paths: [] }])).toBeNull();
    expect(run([{ type: "enter", paths: [] }, { type: "over" }])).toBeNull();
    expect(run([{ type: "enter", paths: [] }, { type: "over" }, { type: "over" }, { type: "over" }])).toBeNull();
  });

  it("and `over` on its own never invents one, whatever came before it", () => {
    // A drag that began inside the page is not announced to us at all; the first thing we may see
    // of it is an `over`. It says where a pointer is and nothing about where the drag came from.
    expect(run([{ type: "over" }])).toBeNull();
    expect(run([{ type: "leave" }, { type: "over" }])).toBeNull();
    expect(run([{ type: "drop", paths: [] }, { type: "over" }])).toBeNull();
  });

  it("an import already offered survives the moves, and only a leave or a drop ends it", () => {
    const held = run([{ type: "enter", paths: [FILE] }, { type: "over" }, { type: "over" }]);
    expect(externalDragState(held, { type: "over" })).toBe(held);
    expect(externalDragState(held, { type: "leave" })).toBeNull();
    expect(externalDragState(held, { type: "drop", paths: [FILE] })).toBeNull();
  });
});

describe("the order a library opens in", () => {
  it("is the shelf's own order when the reader has never chosen", () => {
    expect(DEFAULT_SORT).toBe("shelf");
    expect(restoredSort(null)).toBe("shelf");
    expect(restoredSort(undefined)).toBe("shelf");
    expect(restoredSort("")).toBe("shelf");
  });

  it("is the reader's own choice whenever there is one, and every criterion counts as one", () => {
    for (const s of [...DESIGN_SORTS, "shelf"]) expect(restoredSort(s)).toBe(s);
  });

  // A stored choice must never be quietly replaced — not by the default, and not by a value this
  // build happens not to recognise. What `restoredSort` decides is what to SHOW; nothing here
  // writes, so a reader who never opens the sort control never acquires a preference they did not
  // make, and a reader who did keeps theirs across a build that has never heard of it.
  it("falls back to the shelf's order for a value this build does not know, without adopting it", () => {
    expect(restoredSort("chronoflux")).toBe("shelf");
    expect(restoredSort("date_read")).toBe("shelf"); // the older Library's vocabulary
    expect(restoredSort("SHELF")).toBe("shelf"); // and never by accident of case
  });
});

describe("the shape of a landing place", () => {
  // Grid and Details are the two views whose places are drawn by the stylesheet.
  it("is the card class in Grid and the row class in Details", () => {
    expect(slotClassFor("grid")).toBe("libd-cardslot");
    expect(slotClassFor("details")).toBe("libd-rowslot");
  });

  // THE DEFECT ITSELF. The fallback knew only «grid or not», so Covers, Spines and Vista were all
  // stamped with the ROW class — `height: 56px` and a 12px side margin — which beat the inline
  // `aspect-ratio: 2/3` those views size their own places with. Measured in Covers before the fix:
  // places 108×56 beside covers 108×162. A view that draws its own place must get NO class here,
  // or the stylesheet reshapes it behind the view's back.
  it("is left to the view itself everywhere a view draws its own", () => {
    for (const v of ["covers", "spines", "vista"] as DesignView[]) {
      expect(slotClassFor(v)).toBeUndefined();
    }
  });

  it("never hands the row class to anything but Details", () => {
    const rowed = DESIGN_VIEWS.filter((v) => slotClassFor(v) === "libd-rowslot");
    expect(rowed).toEqual(["details"]);
  });
});


describe("the run an ordering write is judged against, after a book has just been filed", () => {
  // THE DEFECT. Filing a book on another shelf is two writes: membership, then position. The second
  // was handed the destination run AS DRAWN — drawn before the first write, and therefore naming
  // every book of that shelf except the one just filed. `view_order_reorder` rewrites a run whole
  // from what it is handed and refuses a book that run does not contain, so one gesture produced
  // three wrong things at once, measured in the running application: the book was filed and then
  // left at the END of its new shelf instead of where it was aimed; «تعذّر حفظ هذا التغيير. لم
  // يتغيّر شيء» was shown for a change that had happened; and «book … is not in this run» was
  // thrown behind it.
  const DRAWN = ["c15", "d20", "d23", "e28"];

  it("puts the filed book into the run, where the filing put it", () => {
    // The filing names no neighbour, so it appends: the book joins the drawn run at its end.
    expect(presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: "d20", rankWritten: true }))
      .toEqual(["c15", "d20", "d23", "e28", "a01"]);
  });

  // THE ONE THAT FAILS IF THE DRAWN RUN IS HANDED OVER UNCHANGED. A stale run does not contain the
  // book; anything that returns it as it stands is sending the defect back.
  it("never hands over a run that does not contain the book being placed", () => {
    const out = presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: "d20", rankWritten: true });
    expect(out).toBeDefined();
    expect(out).toContain("a01");
    expect(out).not.toEqual(DRAWN);
  });

  it("leaves a run alone when the filing wrote no position", () => {
    // Nothing changed: the book was already on that shelf, at its own place, and the drawn run
    // already says where. Moving it to the end here would invent a move nobody asked for.
    const drawn = ["c15", "a01", "d23"];
    expect(presentAfterFiling({ drawn, bookId: "a01", before: "d23", rankWritten: false })).toEqual(drawn);
  });

  // «I CANNOT DESCRIBE THIS RUN» IS A REAL ANSWER, and not the same as an empty one: an empty run
  // tells the backend to fall back to its own stored rows, so a run missing the neighbour the
  // reader aimed at is worse than sending nothing — the write would be judged against it.
  it("declines when the neighbour aimed at is not in the run", () => {
    expect(presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: "k65", rankWritten: true })).toBeUndefined();
  });

  it("declines when the book is not in the run and no position was written", () => {
    expect(presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: "d20", rankWritten: false })).toBeUndefined();
  });

  it("accepts the end of a run, where there is no neighbour to name", () => {
    expect(presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: null, rankWritten: true }))
      .toEqual(["c15", "d20", "d23", "e28", "a01"]);
  });

  it("keeps every other book, and keeps them in the order they were drawn in", () => {
    const out = presentAfterFiling({ drawn: DRAWN, bookId: "a01", before: "c15", rankWritten: true })!;
    expect(out.filter((id) => id !== "a01")).toEqual(DRAWN);
    expect(new Set(out).size).toBe(out.length);
  });

  it("does not leave a second copy behind when the book was already drawn in that run", () => {
    // A re-filing of a book the run already shows: it moves to where the filing put it, once.
    const drawn = ["c15", "a01", "d23"];
    expect(presentAfterFiling({ drawn, bookId: "a01", before: "d23", rankWritten: true }))
      .toEqual(["c15", "d23", "a01"]);
  });
});
