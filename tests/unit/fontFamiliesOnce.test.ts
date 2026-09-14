// ONE IMPORTED FONT FAMILY IS ONE CHOICE.
//
// THE BUG THIS PINS. `fonts::import` records a row per FILE and derives the family from the file stem
// with weight words stripped (`family_from_stem` drops "regular", "bold", …), so importing a face's
// Regular and Bold — an ordinary thing to do — writes TWO `custom_fonts` rows under a single family
// name. Every font picker built its options straight from those rows and keyed each option on the
// family name, so two options carried the same React key.
//
// MEASURED in the running app: a library with five imported fonts held two rows for one family, and
// React logged "Encountered two children with the same key, `thmanyahserifdisplay`" 86 times in a
// single session — a warning React itself describes as unsupported behaviour that "may cause children
// to be duplicated and/or omitted". The reader was also offered the same font twice, and both entries
// resolved to the same face, because `customFontUrl` matches by family and takes the first row.
//
// THE FIX. Pickers list a family once, keeping the first row — the same row `customFontUrl` resolves
// to, so what is chosen is what renders. The font LIBRARY still lists every file: each is separately
// removable, and that list keys on the row id, which is unique.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { familiesOnce } from "../../src/lib/fonts";

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

describe("familiesOnce", () => {
  it("keeps one row per family, in the order they arrived", () => {
    const rows = [
      { id: "a", family_name: "Rakwa" },
      { id: "b", family_name: "Lateef OT" },
      { id: "c", family_name: "Rakwa" },
    ];
    expect(familiesOnce(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps the FIRST row of a family — the one customFontUrl resolves to", () => {
    // customFontUrl does `custom.find(c => c.family_name === family)`, so the picker must offer the
    // row that lookup will return, or the reader picks one file and the page renders another.
    const rows = [{ id: "first", family_name: "X" }, { id: "second", family_name: "X" }];
    expect(familiesOnce(rows)[0].id).toBe("first");
  });

  it("leaves a list with no duplicates completely alone", () => {
    const rows = [{ id: "a", family_name: "A" }, { id: "b", family_name: "B" }];
    expect(familiesOnce(rows)).toEqual(rows);
  });

  it("handles the empty list", () => {
    expect(familiesOnce([])).toEqual([]);
  });

  it("does not treat different families as the same", () => {
    const rows = [{ id: "a", family_name: "Amiri" }, { id: "b", family_name: "amiri" }];
    expect(familiesOnce(rows)).toHaveLength(2);
  });
});

describe("every picker that keys options on the family name deduplicates first", () => {
  // The defect lived at the CALL SITES, not in the helper, so this is what actually guards it: a new
  // picker that maps `custom` straight into options would reintroduce the duplicate key.
  const sites: [string, string][] = [
    ["src/features/reader/ReadingSettings.tsx", "the book font pickers"],
    ["src/features/photo/PhotoComposer.tsx", "the photo card font picker"],
    ["src/features/settings/GlobalSettings.tsx", "the global book font options"],
    ["src/lib/fonts.ts", "the UI font choices"],
  ];
  for (const [file, what] of sites) {
    it(what + " (" + file.split("/").pop() + ") maps a deduplicated list", () => {
      const src = read(file);
      expect(src, file + " should import or define familiesOnce").toContain("familiesOnce");
      // No raw `custom…​.map(` feeding an option list: every such map must go through the helper.
      const raw = src.match(/\.\.\.(customFonts|custom|get\(\)\.custom)\.map\(/g) || [];
      expect(raw, file + " still maps the raw font rows into options: " + raw.join(", ")).toEqual([]);
    });
  }

  it("the font LIBRARY still lists every imported file, keyed by row id", () => {
    // Deduplicating there would hide a file the reader can no longer remove.
    const gs = read("src/features/settings/GlobalSettings.tsx");
    expect(gs).toMatch(/custom\.map\(\(c\) => \(\s*<div key=\{c\.id\}/);
  });
});
