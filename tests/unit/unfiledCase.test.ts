// The synthesised case that makes an unfiled shelf manageable.
//
// A shelf outside every case must never become an object the reader can see and cannot manage.
// The management panel reaches those shelves by being handed a case node that does not exist in
// the database, so the rules that node has to obey are worth pinning down: it carries exactly the
// loose shelves, it counts DISTINCT books, and it is recognisable as the synthesised one.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ShelfItem, ShelfNode } from "../../src/lib/ipc";
import { hasUnfiledContent, unfiledCase, UNFILED_CASE_ID } from "../../src/features/library/design/model";

const shelf = (id: string, name: string, over: Partial<ShelfNode> = {}): ShelfNode => ({
  id,
  name,
  ink: null,
  case_id: null,
  order_rule: "hand",
  auto_rule: null,
  collapsed: false,
  count: 0,
  categories: [],
  ...over,
});

const item = (book_id: string): ShelfItem =>
  ({ book_id, category_id: null, position: 0 }) as unknown as ShelfItem;

describe("the unfiled group as a case", () => {
  it("carries exactly the loose shelves, in the order given", () => {
    const loose = [shelf("a", "Poetry"), shelf("b", "Essays")];
    const node = unfiledCase("Not in a case", loose, {});
    expect(node.shelves.map((s) => s.id)).toEqual(["a", "b"]);
    expect(node.name).toBe("Not in a case");
  });

  it("counts a book once even when it sits on two unfiled shelves", () => {
    // The 42-reported-as-43 mistake: summing the shelf totals instead of counting books.
    const loose = [shelf("a", "Poetry"), shelf("b", "Essays")];
    const items = { a: [item("b1"), item("b2")], b: [item("b2"), item("b3")] };
    expect(unfiledCase("x", loose, items).count).toBe(3);
  });

  it("counts nothing when the shelves are empty, rather than guessing from shelf.count", () => {
    // `shelf.count` is the backend's number for a real shelf; the synthesised node must not
    // inherit a stale one, or an emptied shelf keeps reporting its old total.
    const loose = [shelf("a", "Poetry", { count: 9 })];
    expect(unfiledCase("x", loose, {}).count).toBe(0);
  });

  it("survives a shelf with no membership loaded yet", () => {
    // `items` is filled asynchronously, so the first render legitimately has no entry.
    const node = unfiledCase("x", [shelf("a", "Poetry"), shelf("b", "Essays")], { a: [item("b1")] });
    expect(node.count).toBe(1);
    expect(node.shelves).toHaveLength(2);
  });

  it("is empty and inert when there are no loose shelves at all", () => {
    const node = unfiledCase("x", [], {});
    expect(node.count).toBe(0);
    expect(node.shelves).toEqual([]);
  });

  it("is identifiable as synthesised, and carries no colour of its own", () => {
    // The panel keys the case-specific controls — rename, ink, delete — off this identity.
    const node = unfiledCase("x", [shelf("a", "Poetry")], {});
    expect(node.id).toBe(UNFILED_CASE_ID);
    expect(node.ink).toBeNull();
  });

  it("does not collide with a real case id", () => {
    // Real ids come from the database; the sentinel is deliberately not a valid one.
    expect(UNFILED_CASE_ID.startsWith("__")).toBe(true);
  });
});

// ==================================================================================================
// «خارج الخزائن» AS A GROUP THE READER CAN FIND
// ==================================================================================================
//
// THE DEFECT. The heading was rendered on `loose.length > 0`, while the «خارج الأرفف» run below it
// was rendered on the group's COLLAPSE state. The two disagreed, and a library with unshelved books
// and no loose shelves drew that run at the very end of the tree with no heading over it — a row
// belonging to nothing, and nothing able to collapse it.
//
// Alongside it, two reasons the heading was hard to see at all, both measured on the rendered
// Library before the change: it was set as a Latin small-caps caption — 9.84px, `uppercase`, and
// 1.38px of letter-spacing over Arabic, which has no capitals and whose cursive joins tracking pulls
// apart — in `--faint`, the ink Sard uses for counts and disabled text; and its children hung on
// nothing, `margin-inline-start: 0px` with `border-inline-start-width: 0px`, where every case in the
// same tree ties its shelves to its title with a 22px indent and a 1px rail.
//
// The membership rule is a function and is tested as one. The rest lives in JSX with no DOM in this
// suite, so it is pinned as SHAPE — the same way `legacyLook` and `quietNamesAndTexture` pin theirs.
const CHROME = readFileSync(
  join(import.meta.dirname, "..", "..", "src/features/library/design/Chrome.tsx"),
  "utf8",
);
/** Just the unfiled group's JSX — from its own comment to the creation actions that follow it. */
const GROUP = CHROME.slice(
  CHROME.indexOf("Shelves in no case"),
  CHROME.indexOf("THE TWO WAYS TO MAKE A PLACE"),
);

describe("what belongs to the unfiled group", () => {
  const sh = (id: string) => shelf(id, id);

  it("counts a loose shelf as content", () => {
    expect(hasUnfiledContent([sh("a")], null)).toBe(true);
  });

  it("counts the unshelved run as content, which is the case that was orphaned", () => {
    // No loose shelves at all, and the group still has something to show: this is exactly the
    // library that used to render «خارج الأرفف» with no heading above it.
    expect(hasUnfiledContent([], sh("unshelved"))).toBe(true);
  });

  it("counts both together", () => {
    expect(hasUnfiledContent([sh("a")], sh("unshelved"))).toBe(true);
  });

  it("is empty when there is genuinely nothing — no placeholder heading", () => {
    // A cabinets-only library must not grow a heading standing over nothing.
    expect(hasUnfiledContent([], null)).toBe(false);
    expect(hasUnfiledContent([], undefined)).toBe(false);
  });
});

describe("the unfiled group's heading and its children", () => {
  it("shows the heading on CONTENT, not on loose shelves alone", () => {
    expect(GROUP).toContain("{hasUnfiled && (");
    expect(CHROME).toContain("const hasUnfiled = hasUnfiledContent(props.loose, props.unshelved);");
  });

  it("no longer lets the unshelved run render outside the group", () => {
    // `(looseOpen || props.loose.length === 0)` was the escape hatch that produced the orphan: it
    // forced the run visible precisely when there was no heading to own it.
    expect(GROUP).not.toMatch(/looseOpen \|\| props\.loose\.length === 0/);
  });

  it("hangs BOTH kinds of content on one rail, inside one collapsible", () => {
    // Whatever else changes, these two must stay in the same container: that container is what
    // makes the heading their parent rather than a caption above them.
    const rail = GROUP.indexOf("{looseOpen && (");
    const loose = GROUP.indexOf("{props.loose.map(shelfRow)}");
    const run = GROUP.indexOf("{props.unshelved && shelfRow(props.unshelved)}");
    expect(rail).toBeGreaterThan(-1);
    expect(loose).toBeGreaterThan(rail);
    expect(run).toBeGreaterThan(loose);
  });

  it("uses the CASE's own connector, so the group reads like the rest of the tree", () => {
    // Not a new device: a case ties its shelves to its title with the same indent and the same
    // connector, and the two groupings must keep using ONE of them or they stop matching.
    //
    // The connector is now drawn by `.libd-shelfgroup` rather than by an inline border — it fades
    // at its foot and takes the cabinet's ink at its head, neither of which a single `border`
    // declaration can express. What this pins is unchanged: both groups reach for the same indent
    // and the same class, so neither can drift from the other.
    expect(GROUP).toContain("marginInlineStart: 22");
    expect(GROUP).toContain("libd-shelfgroup");
    const caseBlock = CHROME.slice(0, CHROME.indexOf("Shelves in no case"));
    expect(caseBlock).toContain("marginInlineStart: 22");
    expect(caseBlock).toContain("libd-shelfgroup");
    // …and the class really is what draws it, so "they share a connector" is not vacuous.
    const css = readFileSync(
      join(import.meta.dirname, "..", "..", "src/styles/library-design.css"), "utf8");
    expect(css).toMatch(/\.libd-shelfgroup::before\s*\{[^}]*inset-inline-start: 0/);
  });

  it("stays a group and not a cabinet", () => {
    // The distinction the design insists on: no colour bar, no grip, no disc. If this group ever
    // grew them, «not in a cabinet» would look like one more cabinet.
    expect(GROUP).not.toContain("onPlaceCase");
    expect(GROUP).not.toMatch(/borderInlineStart: `3px solid/);
    expect(GROUP).not.toContain('Icon name="grip"');
  });

  it("keeps collapsing through the cases' own open set", () => {
    // Collapse state is not a second mechanism: the group answers to `openCases` under the shared
    // synthetic id, so it persists exactly the way a cabinet's does.
    expect(CHROME).toContain("const looseOpen = props.openCases.has(UNFILED_CASE_ID);");
    expect(GROUP).toContain("props.onToggleCase(UNFILED_CASE_ID)");
    expect(GROUP).toContain("aria-expanded={looseOpen}");
  });
});

describe("no label in the Library tree sets Arabic as tracked capitals", () => {
  // `.libd-place-cat` and `fieldLabel` both record why: Arabic has no capitals for `text-transform`
  // to reach, and letter-spacing pulls its cursive joins apart. BOTH of this tree's labels were
  // still doing it — «الخزائن» above the list and «خارج الخزائن» inside it — which is why the two
  // words naming the Library's groupings were the least legible text in it. "Make it brighter"
  // would not have fixed what was actually wrong.
  const LABEL = CHROME.slice(CHROME.indexOf("const treeLabel ="), CHROME.indexOf("const ctlBtn ="));

  it("has ONE treatment, chosen from the script of the words themselves", () => {
    expect(LABEL).toContain('const arabic = scriptOf(text) === "arabic";');
    expect(LABEL).toContain('letterSpacing: arabic ? "normal" : ".14em"');
    expect(LABEL).toContain('textTransform: arabic ? "none" : "uppercase"');
    // Arabic gets its own face and its own size — a stack led by the Latin face is how the label
    // ended up rendering through a fallback.
    expect(LABEL).toContain("labelFaceFor(text)");
    expect(LABEL).toContain('arabic ? ".75rem" : ".625rem"');
  });

  it("is what BOTH of the tree's groupings use", () => {
    expect(CHROME).toContain('treeLabel(t("lib.cases"))');
    expect(GROUP).toContain("...treeLabel(unfiledLabel)");
  });

  it("leaves neither label able to track or uppercase Arabic on its own", () => {
    // The regression is someone re-inlining the caption treatment at either site.
    const cases = CHROME.slice(CHROME.indexOf('{t("lib.cases")}') - 400, CHROME.indexOf('{t("lib.cases")}'));
    for (const [where, src] of [["the group heading", GROUP], ["the «الخزائن» caption", cases]] as const) {
      expect(src, where).not.toMatch(/letterSpacing: "\.\d+em"/);
      expect(src, where).not.toMatch(/textTransform: "uppercase"/);
    }
  });

  it("gives the group heading the ink of a heading, not of its own children", () => {
    // Measured across the tree: a shelf row is .75rem/500 in `--mut`. A heading at .75rem/600 in
    // `--mut` was separated from the rows it parents by weight alone.
    expect(GROUP).toContain('color: unfiledActive ? "var(--acc)" : "var(--txt)"');
    expect(GROUP).not.toMatch(/color: unfiledActive \? "var\(--acc\)" : "var\(--(faint|mut)\)"/);
  });

  it("keeps the caption quieter than the heading, since only one of them heads anything", () => {
    // `treeLabel` deliberately carries no colour: «الخزائن» is a static caption above the list and
    // stays `--faint`; the group heading is a row that owns other rows.
    expect(LABEL).not.toContain("color:");
    expect(CHROME).toContain('{ ...treeLabel(t("lib.cases")), color: "var(--faint)" }');
  });
});
