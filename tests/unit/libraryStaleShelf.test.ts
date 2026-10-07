// THE OLD SHELF FILTER CANNOT HIDE THE LIBRARY.
//
// `lib_shelf` is the shelf a reader last picked in the flat Library of 1.2.2 and earlier. The Library
// was rebuilt around the design surface and nothing has been able to pick or clear that value since —
// yet it was still restored on every launch and handed to `library_list_books` as the collection
// filter. A reader who updated while standing in a shelf saw «Library · N books» for one old shelf,
// for good: re-adding a hidden book answered «already in library» (de-duplication rightly asks the
// whole `books` table), a double-clicked book opened but never appeared, and a filter whose shelf had
// since been deleted showed «0 books». Restart, update and a reinstall that kept the database all
// carried it forward.
//
// The fix is that the stored value is never read. These assertions hold that, and hold the one write
// that retires the stored value on the first launch of a fixed build.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const LIB = read("src/features/library/Library.tsx");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(R, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(R, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("the obsolete lib_shelf filter", () => {
  it("is read by nothing in the application", () => {
    const readers = sources("src").filter((f) => /settingsGet\(\s*["']lib_shelf["']\s*\)/.test(read(f)));
    expect(readers).toEqual([]);
  });

  it("hydrates the Library with no shelf filter, whatever is stored", () => {
    const hydration = LIB.slice(LIB.indexOf("prefsCache = {"), LIB.indexOf("setView(prefsCache.view)"));
    expect(hydration).toMatch(/shelf:\s*null,/);
    expect(hydration).not.toMatch(/\bsh\b/);
  });

  it("retires the stored value: the persist effect writes the empty filter on first hydration", () => {
    // `shelf` starts null and nothing sets it to a shelf, so this writes "" over a stale value.
    expect(LIB).toContain('settingsSet("lib_shelf", shelf ?? "")');
  });

  it("the main list's collection filter can only ever be the in-session `shelf`, which nothing fills", () => {
    expect(LIB).toMatch(/libraryListBooks\(\{ sort, order, format, collection: shelf, search \}\)/);
    // The only writers of `shelf`: the hydration (always null now) and clearing it when its shelf is
    // deleted. No control sets it to a shelf.
    const setters = [...LIB.matchAll(/setShelf\(([^)]*)\)/g)].map((m) => m[1]);
    expect(setters.sort()).toEqual(["id", "prefsCache.shelf"].sort());
    expect(LIB).toMatch(/const pickShelf = \(id: string \| null\) => setShelf\(id\);/);
    const pickCalls = [...LIB.matchAll(/pickShelf\(([^)]*)\)/g)].map((m) => m[1]);
    expect(pickCalls).toEqual(["null"]);
  });
});
