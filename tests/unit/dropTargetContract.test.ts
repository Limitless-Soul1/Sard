import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE PLACE DECIDES WHAT A LANDING PLACE MEANS.
 *
 * A release does not call a handler — it hit-tests the point under the pointer and reads the
 * `data-drop-*` attributes it finds. So those attributes ARE the contract, and a component that
 * writes them by hand is writing a second implementation of it.
 *
 * Two did. `ViewVista` and `ViewGrouped` each built their own ordering gap and stamped it with
 * `data-drop-shelf` — the MEMBERSHIP attribute. `dropTarget` looks for `data-drop-section` first,
 * found none, matched `data-drop-shelf`, and called an ordering gap a MOVE. `moveToShelf` then
 * returned early because the book was already in that container, so the drag did nothing at all.
 *
 * Measured on a real library, on the very same element:
 *
 *     RELEASED on the slot  ->  position 0 -> 0    no message
 *     CLICKED  the slot     ->  position 0 -> 5    «تم تغيير ترتيب الكتاب»
 *
 * The gap was right; only the release misread it. And it read as intermittent, because whether the
 * mistaken move did nothing or actually refiled the book depended on which container the carried
 * book happened to be in.
 *
 * This guard makes that unrepresentable rather than merely fixed: a view describes how a gap LOOKS
 * and asks `orderGap` to draw it. A view that cannot emit the attributes cannot emit the wrong ones.
 */

/** The two places allowed to name a shelf as a destination, and why each is a real one. */
const MOVE_TARGETS: Record<string, string> = {
  "src/features/library/design/Chrome.tsx":
    "the sidebar's shelf rows — a named shelf the reader can see and aimed at",
  "src/features/library/design/ViewVista.tsx":
    "the shelf PREVIEW in the scene — dropping onto a drawn shelf, which is a move by intention",
};

/** Only the owner of the contract may draw an ordering gap. */
const CONTRACT_OWNER = "src/features/library/design/LibraryDesign.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full.split("\\").join("/"));
  }
  return out;
}

/** Attributes as they are actually WRITTEN in JSX — comments about them do not count. */
function emitted(text: string): string[] {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return [...withoutComments.matchAll(/(data-drop-[a-z]+)\s*=/g)].map((m) => m[1]);
}

describe("the landing-place contract", () => {
  const files = walk("src");

  it("lets only the contract owner draw an ordering gap", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === CONTRACT_OWNER) continue;
      if (emitted(readFileSync(file, "utf8")).includes("data-drop-section")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lets only the two documented surfaces name a shelf as a destination", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === CONTRACT_OWNER || file in MOVE_TARGETS) continue;
      const attrs = emitted(readFileSync(file, "utf8"));
      if (attrs.some((a) => a !== "data-drop-section")) offenders.push(`${file}: ${attrs.join(" ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer names a shelf is a stale claim about the code, and the
    // next reader would believe it. Each one has to still be doing the thing it is excused for.
    for (const [file, why] of Object.entries(MOVE_TARGETS)) {
      const attrs = emitted(readFileSync(file, "utf8"));
      expect(attrs, `${file} is exempted (${why}) but names no shelf`).toContain("data-drop-shelf");
    }
  });

  it("has exactly one reader of the contract, and it looks for order first", () => {
    // If `data-drop-shelf` were tested first, every ordering gap in the grouped formats would be a
    // move again — which is precisely the bug. The order of these two lookups is load-bearing.
    const owner = readFileSync(CONTRACT_OWNER, "utf8");
    const section = owner.indexOf('closest("[data-drop-section]")');
    const shelf = owner.indexOf('closest("[data-drop-shelf]")');
    expect(section).toBeGreaterThan(-1);
    expect(shelf).toBeGreaterThan(-1);
    expect(section).toBeLessThan(shelf);

    const readers = files.filter((f) => /closest\("\[data-drop-/.test(readFileSync(f, "utf8")));
    expect(readers).toEqual([CONTRACT_OWNER]);
  });
});
