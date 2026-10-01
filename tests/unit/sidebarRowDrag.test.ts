// THE RULES THE SIDEBAR'S REORDER DRAG MUST NOT BREAK.
//
// The arithmetic is `rowShift.test.ts` and `dropIndex.test.ts`; this is about the WIRING, which is
// where a reorder gesture does its real damage. A drag that moved a shelf with the case command
// would file it among the cases; one that handed a shelf the wrong sibling list would move it past
// rows it is not a sibling of; one that armed the unshelved run would offer to reorder something
// that is not a collection at all. None of those is visible in the arithmetic.
//
// The suite runs in `node` with no DOM, deliberately (see vitest.config.ts), so the wiring is read
// from the source the way `unfiledCase.test.ts` reads the tree it is about. What a real pointer
// does is answered by the runtime pass, not here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CHROME = read("src/features/library/design/Chrome.tsx");
const DESIGN = read("src/features/library/design/LibraryDesign.tsx");
const DRAG = read("src/features/library/design/rowDrag.ts");

describe("what the drag is allowed to move", () => {
  it("sends a case to the case command and a shelf to the shelf one — never crossed", () => {
    // One gesture, two destinations, chosen by what the row IS. Crossing them would change an
    // item's parentage, which no reorder may do.
    expect(CHROME).toContain("if (caseIdSet.has(id)) props.onPlaceCase(id, toIndex);");
    expect(CHROME).toContain("else props.onPlaceShelf(id, toIndex);");
  });

  it("gives every shelf the siblings it is actually ordered among", () => {
    // A shelf moves among the shelves of its case, or among the loose ones — the scope
    // `shelf_reorder` documents. Handing it the whole library would let a drag walk it out of its
    // case without ever calling the command that re-files one.
    expect(CHROME).toContain("c.shelves.map((sh) => shelfRow(sh, c.shelves.map((x) => x.id)))");
    expect(CHROME).toContain("props.loose.map((sh) => shelfRow(sh, props.loose.map((x) => x.id)))");
  });

  it("never arms the unshelved run, which is not a collection", () => {
    // It is still drawn, and still a drop destination for books — it simply has no order of its own
    // to set, so it is passed no siblings and `draggable` is false by construction.
    expect(CHROME).toContain("{props.unshelved && shelfRow(props.unshelved)}");
    expect(CHROME).toContain("const draggable = siblings != null && siblings.length > 1 && !isVirtualShelf(s.id);");
  });

  it("gives the cases their own list, and only that", () => {
    expect(CHROME).toContain("rowDrag.begin(e, c.id, props.cases.map((x) => x.id))");
  });
});

describe("the order it writes", () => {
  it("writes through the commands that already existed", () => {
    // No second ordering system: the drag calls `shelf_reorder` / `case_reorder` exactly as the ⋯
    // menu's «move» does, so the two routes cannot produce different orders.
    expect(DESIGN).toContain("shelfReorder(id, at)");
    expect(DESIGN).toContain("caseReorder(id, at)");
    // …and the hook itself knows no command at all — it is handed one.
    expect(DRAG).not.toMatch(/Reorder\(|invoke\(/);
  });

  it("keeps the ⋯ menu's move as the path that needs no pointer", () => {
    // Dragging is now the natural way, not the only way. Removing these would leave a reader who
    // cannot drag with no way to reorder anything.
    expect(CHROME).toContain("onMoveUp={() => props.onMoveCase(c.id, -1)}");
    expect(CHROME).toContain("onMoveDown={() => props.onMoveCase(c.id, 1)}");
    expect(CHROME).toContain("onMove={(d) => props.onMoveShelf(s.id, d)}");
  });

  it("commits once, on release, and not while the pointer is moving", () => {
    // A commit per frame would write a row's order dozens of times across one drag.
    const commits = DRAG.match(/commit\.current\(/g) ?? [];
    expect(commits).toHaveLength(1);
    expect(DRAG).toContain("const up = () => finish(true);");
  });

  it("does not commit when the row was put back where it started", () => {
    expect(DRAG).toContain("if (commitIt && st.at !== st.from) {");
  });

  it("does not commit when the drag is cancelled", () => {
    // Escape and a cancelled pointer both finish WITHOUT committing.
    expect(DRAG).toContain("const cancel = () => finish(false);");
    expect(DRAG).toContain('if (e.key === "Escape") finish(false);');
  });
});

describe("the gesture's edges", () => {
  it("leaves a press that never travelled as a click", () => {
    expect(DRAG).toContain("if (Math.abs(e.clientY - st.startY) < DRAG_THRESHOLD_PX) return;");
  });

  it("eats the click that ends a drag, so a shelf row does not also navigate", () => {
    expect(DRAG).toContain("spent.current = true;");
    expect(CHROME).toContain("onClickCapture={draggable ? rowDrag.onClickCapture : undefined}");
  });

  it("takes every window listener back off again", () => {
    for (const ev of ["pointermove", "pointerup", "pointercancel", "keydown"]) {
      expect(DRAG).toContain(`window.addEventListener("${ev}"`);
      expect(DRAG).toContain(`window.removeEventListener("${ev}"`);
    }
    expect(DRAG).toContain("scroller.stop();");
  });

  it("answers only the primary button", () => {
    expect(DRAG).toContain("if (e.button !== 0) return;");
  });
});

describe("the motion", () => {
  it("honours prefers-reduced-motion in every place it animates", () => {
    // Three: the neighbours making way, the settle after a cancelled drag, and the FLIP after a
    // commit. A decorative animation left on in one of them is the one a reader would still see.
    const guards = DRAG.match(/prefersReducedMotion\(\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(4); // the definition plus its three uses
    expect(DRAG).toContain("if (prefersReducedMotion()) { clearAll(); return; }");
  });

  it("moves rows with transforms only, which the compositor can carry", () => {
    // No `top`/`left`/`margin` animation: those are layout, and a list that relayouts on every
    // pointermove is the jerk this interaction exists to avoid.
    expect(DRAG).toContain("translateY(");
    expect(DRAG).not.toMatch(/style\.(top|left|marginTop)\s*=/);
  });

  it("leaves the row the pointer is holding unanimated", () => {
    // The dragged row is set to follow directly; easing the thing in the hand is what reads as lag.
    expect(DRAG).toContain('self.style.transition = "none";');
  });

  it("shares one settle with the tray that already had this interaction", () => {
    expect(DRAG).toContain("export const SETTLE_MS = 190;");
    expect(DRAG).toContain('export const SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";');
    const TRAY = read("src/features/reader/PhotoBasketTray.tsx");
    expect(TRAY).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
  });
});

describe("what it must not disturb", () => {
  it("adds no dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(names).not.toContain("react-dnd");
    expect(names).not.toContain("@dnd-kit/core");
    expect(names).not.toContain("react-beautiful-dnd");
    expect(names).not.toContain("framer-motion");
    expect(names).not.toContain("sortablejs");
  });

  it("reuses the sidebar's existing landing arithmetic and its auto-scroll", () => {
    expect(DRAG).toContain('import { dropIndex } from "./model";');
    expect(DRAG).toContain("createEdgeScroller");
    expect(DRAG).toContain("scrollableAncestor");
  });

  it("does not touch collapse state", () => {
    // Reordering is not expanding. Nothing in the drag may write the open set.
    expect(DRAG).not.toMatch(/collapse|openCases|setCollapsed/i);
  });
});
