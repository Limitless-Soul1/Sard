// CHOOSING SEVERAL THINGS AT ONCE — the rules, stated once because the UI is written once.
//
// WHAT THIS PINS, and why the pure functions exist at all. Every list in Sard that offers selection
// asks the same four questions, and each one has a wrong answer that is easy to write and hard to
// see:
//
//   · «تحديد الكل» over a FILTERED list. "All" can only ever mean the rows on screen. Written
//     against the whole collection it silently takes rows the reader cannot see, and the first they
//     learn of it is that the delete took more than they chose.
//   · The PARTIAL state. Two of five chosen is neither "all" nor "none", and a control that shows
//     only a tick or an empty box makes the reader guess which way pressing it will go.
//   · A hidden choice, DROPPED. Ticking three, narrowing the filter, then taking all of what is left
//     must not quietly discard the three — a filter is a way of looking, not an instruction.
//   · A selection that OUTLIVES its rows. A row deleted elsewhere leaves its id behind, and the
//     count then says four over three rows.
//
// The bar and the ticks are React and are not tested here; these are the decisions underneath them,
// and they are the ones that would go wrong quietly.
import { describe, expect, it } from "vitest";

import {
  allStateOf,
  pruneTo,
  toggleAllIn,
  toggleIn,
} from "../../src/components/listSelection";

const set = (...ids: string[]) => new Set(ids);

describe("how much of what is on screen is chosen", () => {
  it("nothing chosen is none", () => {
    expect(allStateOf(["a", "b", "c"], set())).toBe("none");
  });

  it("every visible row chosen is all", () => {
    expect(allStateOf(["a", "b", "c"], set("a", "b", "c"))).toBe("all");
  });

  it("some of them is some — the state a plain checkbox cannot say", () => {
    expect(allStateOf(["a", "b", "c"], set("b"))).toBe("some");
    expect(allStateOf(["a", "b", "c"], set("a", "c"))).toBe("some");
  });

  it("an empty list is none, whatever is remembered from before", () => {
    // The filter has hidden everything. There is nothing to take, so «تحديد الكل» must not read as
    // though it were already done.
    expect(allStateOf([], set("a", "b"))).toBe("none");
  });

  it("chosen rows that are NOT on screen do not make it all", () => {
    // THE FILTER CASE. Three chosen, one still visible: the bar must not claim the visible list is
    // fully taken, because pressing «تحديد الكل» then would UNTICK the one row on screen.
    expect(allStateOf(["b"], set("a", "b", "c"))).toBe("all");
    expect(allStateOf(["b", "d"], set("a", "b", "c"))).toBe("some");
  });
});

describe("ticking one row", () => {
  it("adds it, and pressing again takes it back", () => {
    expect([...toggleIn(set(), "a")]).toEqual(["a"]);
    expect([...toggleIn(set("a"), "a")]).toEqual([]);
  });

  it("never mutates the set the caller is holding", () => {
    // React state: mutating in place is how a list stops re-rendering when the reader ticks a row.
    const before = set("a");
    const after = toggleIn(before, "b");
    expect([...before]).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});

describe("«تحديد الكل»", () => {
  it("takes every visible row when some or none are chosen", () => {
    expect([...toggleAllIn(["a", "b"], set())].sort()).toEqual(["a", "b"]);
    expect([...toggleAllIn(["a", "b"], set("a"))].sort()).toEqual(["a", "b"]);
  });

  it("gives them all back when they are all chosen — the same control, both ways", () => {
    expect([...toggleAllIn(["a", "b"], set("a", "b"))]).toEqual([]);
  });

  it("leaves a chosen row that the filter is hiding exactly where it was", () => {
    // Ticked «c», then narrowed the wall to a and b, then took all: c is still the reader's.
    const after = toggleAllIn(["a", "b"], set("c"));
    expect([...after].sort()).toEqual(["a", "b", "c"]);
  });

  it("and untaking the visible ones does not reach the hidden one either", () => {
    const after = toggleAllIn(["a", "b"], set("a", "b", "c"));
    expect([...after]).toEqual(["c"]);
  });

  it("over an empty list changes nothing rather than clearing the selection", () => {
    expect([...toggleAllIn([], set("a"))]).toEqual(["a"]);
  });
});

describe("a selection cannot outlive its rows", () => {
  it("forgets ids the collection no longer holds", () => {
    expect([...pruneTo(["a", "c"], set("a", "b", "c"))].sort()).toEqual(["a", "c"]);
  });

  it("keeps everything when nothing has gone", () => {
    expect([...pruneTo(["a", "b"], set("a", "b"))].sort()).toEqual(["a", "b"]);
  });

  it("empties when the collection does", () => {
    expect([...pruneTo([], set("a"))]).toEqual([]);
  });
});

describe("the lists that offer it all say it the same way", () => {
  // THE GUARD AGAINST THE ACTUAL RISK, which is not a wrong boolean — it is a second selection UI,
  // written for the next list because reaching for the shared one was marginally more work. Every
  // surface below goes through `listSelection`; a new one that does not will be doing so on purpose.
  const LISTS: [string, string][] = [
    ["src/features/reader/AnnotationsPanel.tsx", "notes, highlights, references, replacements, bookmarks"],
    ["src/features/photo/PhotoGallery.tsx", "saved photo cards"],
    ["src/features/library/Inbox.tsx", "the notes archive"],
    ["src/features/library/design/Chrome.tsx", "the library's own Select mode"],
    ["src/features/library/refs/RefsReps.tsx", "references and replacements"],
    ["src/features/library/BookmarksShelf.tsx", "the bookmarks shelf"],
  ];

  for (const [file, what] of LISTS) {
    it(what + " uses the shared primitive", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const src = readFileSync(resolve(__dirname, "../../", file), "utf8");
      expect(src, file + " does not import listSelection").toContain("components/listSelection");
    });
  }

  it("and there is exactly one file that defines it", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const root = resolve(__dirname, "../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        if (/export function useListSelection/.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    };
    walk(root);
    expect(hits.length).toBe(1);
  });
});

describe("every list that offers selection offers the right actions", () => {
  // THE DEFECT THIS PINS. The library could select books and then only MOVE them, while its own ⋯
  // menu had deleted a book all along — a collection whose bulk actions did not match its own
  // semantics. The rule is not "everything gets a delete": it is that a selection must offer what
  // the collection actually supports, which is why the bookmarks shelf is checked for a LIFT and
  // must NOT grow a delete.
  const read = async (file: string) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    return readFileSync(resolve(__dirname, "../../", file), "utf8");
  };

  const DELETES: [string, string][] = [
    ["src/features/reader/AnnotationsPanel.tsx", "notes, highlights, references, replacements, bookmarks"],
    ["src/features/photo/PhotoGallery.tsx", "saved photo cards"],
    ["src/features/library/Inbox.tsx", "the notes archive"],
    ["src/features/library/refs/RefsReps.tsx", "references and replacements"],
  ];

  for (const [file, what] of DELETES) {
    it(what + " can delete what is chosen", async () => {
      const src = await read(file);
      expect(src, "no delete action").toMatch(/key:\s*"delete"/);
      expect(src, "the action carries no mark").toMatch(/icon:\s*"trash"/);
    });
  }

  it("the library can delete the books that are chosen, through its own confirmation", async () => {
    const tray = await read("src/features/library/design/Menus.tsx");
    expect(tray, "the tray offers no deletion").toContain("onClick={onDelete}");
    const lib = await read("src/features/library/design/LibraryDesign.tsx");
    // ONE dialog for one book and for twenty: two would be two sets of words about the same
    // irreversible act, and only one of them would stay current.
    expect(lib).toContain("<ConfirmDeleteBook");
    expect(lib).toContain("books={deleting}");
    expect(lib).toContain("for (const book of books) await props.onDeleteBook(book);");
  });

  it("the bookmarks shelf LIFTS rather than deletes, because that is what its rows do", async () => {
    const src = await read("src/features/library/BookmarksShelf.tsx");
    expect(src).toMatch(/key:\s*"lift"/);
    // Its removal is reversible in place and commits when the reader leaves. A bulk delete here
    // would be a second, harsher meaning for one word.
    expect(src).not.toMatch(/key:\s*"delete"/);
  });

  it("the bar has a ground NO picture can reach through", async () => {
    const css = await read("src/styles/selection.css");
    const start = css.indexOf(".sel-enter,");
    const bar = css.slice(start, css.indexOf("}", start));
    // THE VISIBILITY DEFECT, pinned. The library can carry a photograph behind everything and the
    // surfaces over it are deliberately glassy, so a bar that names one token and trusts it to be
    // opaque is one theme away from letting the picture through the control that deletes things.
    // The ground is two layers: an opaque colour, and the chrome tint painted OVER it.
    expect(bar, "no opaque floor under the tint").toContain("background-color: var(--paper-bg);");
    expect(bar, "the chrome tint is not a layer above it")
      .toContain("background-image: linear-gradient(var(--chrome-bg), var(--chrome-bg));");
    // …and it takes no part in a parent's blending, and states its own lack of a blur.
    expect(bar).toContain("isolation: isolate;");
    expect(bar).toContain("backdrop-filter: none;");
    // …and an edge that can be SEEN. `--chrome-border` is a hairline at ten per cent, which is
    // invisible when the plate's fill is the same cream as the page under it — measured on the
    // cards shelf: opaque, and still indistinguishable. The edge is mixed with the text colour.
    expect(bar, "the edge is the hairline that could not be seen")
      .toContain("border: 1px solid color-mix(in srgb, var(--text) 20%, var(--chrome-border));");
    // ONE SURFACE, worn by the offer and by the toolbar it becomes.
    expect(css.slice(0, css.indexOf(".sel-bar.on {"))).toContain(".sel-enter,");
  });

  it("…and one height, so nothing moves when selection begins", async () => {
    // MEASURED before this, over a library background: the plate was 40px tall with the mode off
    // and 38px with it on, so the grid under it jumped two pixels on the press that turned
    // selection on. A fixed height with `border-box` is what makes both states the same object.
    const css = await read("src/styles/selection.css");
    const bar = css.slice(css.indexOf(".sel-bar {"), css.indexOf(".sel-enter,"));
    expect(bar).toContain("box-sizing: border-box;");
    expect(bar).toContain("height: var(--sel-h, 38px);");
    // …and the offer is the same height, so the row it sits in cannot change when it becomes one.
    expect(css.slice(css.indexOf(".sel-enter {"))).toContain("height: var(--sel-h, 38px);");
  });

  it("and the active state marks the EDGE rather than repainting the surface", async () => {
    // A control that changes colour to say it is active is also a control the reader has to
    // re-find — and a tinted ground is the one that can go translucent over a photograph. The
    // surface is declared ONCE, shared by the offer and the toolbar; the active rules may only
    // adjust the edge and the padding.
    const css = await read("src/styles/selection.css");
    const shared = css.indexOf(".sel-enter,");
    const after = css.slice(css.indexOf("}", css.indexOf(".sel-bar.on {", shared)), css.indexOf("/* THE OFFER, before"));
    expect(after).toContain("border-color:");
    expect(after, "an active rule repaints the ground").not.toContain("background-color:");
    expect(after, "an active rule repaints the ground").not.toContain("background-image:");
  });
  it("the gallery puts them in the page's OWN row of actions, not a second one", async () => {
    // THE SCATTERED-CONTROLS DEFECT. The bar had a strip of its own under the head, at the far edge,
    // so «أنشئ بطاقة مصوّرة» sat on one line and «تحديد» on another — one control above and another
    // below, which is what made the page read as improvised.
    const src = await read("src/features/photo/PhotoGallery.tsx");
    expect(src, "the bar has a strip of its own again").not.toContain("pg-tools");
    const head = src.slice(src.indexOf(`<header className="pg-head">`), src.indexOf("</header>"));
    expect(head, "the selection controls are not in the head").toContain("<SelectionBar");
    // …and the page's own action stands down while the reader is choosing, so the row holds one set.
    expect(head).toContain("{!sel.on && (");
    const css = await read("src/styles/selection.css");
    // A floor on the row, so hiding that action cannot change its height and move the grid.
    expect(css).toContain(".pg-head { min-height: 39px; --sel-h: 39px; }");
  });

  it("Escape leaves the mode, and only when nothing nearer has answered the key", async () => {
    const src = await read("src/components/listSelection.tsx");
    // ONE listener, at the shared layer, rather than one per list.
    expect(src).toContain(`window.addEventListener("keydown", onKey);`);
    // BUBBLE phase, deliberately: a dialog and the library's dismissal stack both claim Escape in
    // CAPTURE and stop it there, so "the dialog wins, otherwise the selection does" is true by
    // construction. A `true` third argument here would break that ordering silently.
    expect(src, "the listener captures, and would outrank an open dialog")
      .not.toContain(`addEventListener("keydown", onKey, true)`);
    expect(src).toContain("e.defaultPrevented");
    // It cancels; it never acts.
    expect(src).toContain("exitRef.current()");
  });
});
