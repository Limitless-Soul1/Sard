// ONE SOURCE OF TRUTH FOR THE REFERENCE MARK'S APPEARANCE.
//
// The mark under a referenced word is drawn on four surfaces — the book page, the reading drawer's
// sample, the هيئة editor's sample, and the هيئة preview's page. Four surfaces is exactly the shape
// in which a styling value acquires four slightly different answers, and the failure is quiet: the
// control sets one mark and the page draws another, and nobody can say which is wrong.
//
// THE INVARIANT THESE TESTS HOLD, stated once:
//
//     ProfileData.refs            the AUTHORED value, and the only persisted one
//            ↓  readingPatch      activation, the same route every هيئة-owned reading field takes
//     reading_style (one row)     the reader's live reading state, shared by every reading field
//            ↓  resolveRefRule    the ONE resolver, in the engine
//     page · drawer sample · editor sample · preview
//
// and, for a draft that has not been activated yet:
//
//     refStyleFor(profile, readerStyle)   the ONE derivation the editor surfaces share
//
// None of this is proved by reading a diagram, so each leg below is pinned against the real files.
// They are deliberately source-level: what they guard is that a FUTURE change cannot quietly add a
// fifth answer, and no runtime assertion can see that.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every .ts/.tsx under src/, so "only in this file" can be asserted rather than assumed. */
function sources(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir + "/" + name;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}
const ALL = sources();
const holding = (needle: string) => ALL.filter((f) => read(f).includes(needle));

describe("the mark has ONE resolver", () => {
  it("the design's geometry is written down in exactly one file", () => {
    // thickness, gap and clearance. If these ever appear anywhere else, a second surface has started
    // computing the mark instead of asking for it.
    for (const constant of ["thickEm", "gapEm", "offsetEm"]) {
      expect(holding(constant), constant).toEqual(["src/reader-engine/refRule.ts"]);
    }
  });

  it("and the resolver is defined once", () => {
    expect(holding("export function resolveRefRule")).toEqual(["src/reader-engine/refRule.ts"]);
    expect(holding("export function refRuleBars")).toEqual(["src/reader-engine/refRule.ts"]);
  });

  it("every surface that DRAWS the mark asks that resolver for it", () => {
    // The page, the reading drawer's + هيئة editor's shared control, and the preview page.
    for (const f of [
      "src/reader-engine/FoliateController.ts",
      "src/features/reader/RefRuleControls.tsx",
      "src/features/profiles/editor/stage/BookFace.tsx",
    ]) {
      expect(read(f), f).toContain("resolveRefRule");
      // From the engine's own module, wherever the importer sits in the tree.
      expect(read(f), f).toMatch(/from "[^"]*(reader-engine\/)?refRule"/);
    }
  });

  it("nobody draws the strokes from numbers of their own", () => {
    // The bar geometry is the resolver's too — a surface positioning its own rules would be the same
    // second answer arriving by a different door. Every file that PLACES a stroke (it converts the
    // resolver's top-down y into a CSS bottom) must have got that stroke from `refRuleBars`.
    const placing = holding("-(b.y + b.height)");
    expect(placing.length).toBeGreaterThan(0);
    for (const f of placing) expect(read(f), f).toContain("refRuleBars(");
  });
});

describe("the mark has ONE persisted source", () => {
  const model = read("src/features/profiles/model/profile.ts");

  it("the هيئة carries exactly one reference block", () => {
    expect(model).toContain("refs: ProfileRefs | null;");
    // Not three loose fields on ProfileData, and not a second block beside it.
    expect(model).not.toContain("refRuleColor: string | null;");
  });

  it("its shape is the engine's own, so it cannot drift from what is drawn", () => {
    expect(model).toContain("export type ProfileRefs = typeof REF_RULE_DEFAULTS;");
    expect(model).toContain("export const REF_KEYS: readonly (keyof ProfileRefs)[] = REF_RULE_KEYS;");
  });

  it("and exactly one function writes it into the reader's style", () => {
    // `readingPatch` is the activation route every هيئة-owned reading field takes. A second writer
    // would be a second way for the live row and the هيئة to disagree.
    const writers = ALL.filter((f) => /out\[k\] = refs\[k\]/.test(read(f)));
    expect(writers).toEqual(["src/features/profiles/model/profile.ts"]);
    expect(model).toContain("const refs = p.data.refs ?? REF_RULE_DEFAULTS;");
    expect(model).toContain("for (const k of REF_KEYS) out[k] = refs[k];");
  });

  it("there is no per-book reference style to disagree with it", () => {
    // The removed per-book scope must not come back — for this field or any other. It is named in
    // prose (the model's header explains what a هيئة does NOT carry), so the property to hold is that
    // nothing ever WRITES such a row.
    for (const f of ALL) {
      expect(read(f), f).not.toMatch(/settingsSet\(\s*[`"']book_style/);
    }
  });
});

describe("the editor derives, it does not copy", () => {
  it("one function answers 'what mark does this هيئة imply'", () => {
    expect(holding("export function refStyleFor")).toEqual(["src/features/profiles/model/profile.ts"]);
  });

  it("and both editor surfaces use it rather than composing their own", () => {
    const preview = read("src/features/profiles/editor/stage/BookFace.tsx");
    const section = read("src/features/profiles/editor/RefsSection.tsx");
    expect(preview).toContain("refStyleFor(profile, readerStyle)");
    expect(section).toContain("refStyleFor(draft, readerStyle)");
    // THE DEFECT THIS PINS. These two each spread the block over the reader's style inline, in two
    // different shapes that agreed by arithmetic rather than by construction. Neither may do so again.
    for (const src of [preview, section]) {
      expect(src).not.toMatch(/\.\.\.readerStyle,\s*\.\.\.\(?\s*(profile\.data\.)?refs/);
    }
  });

  it("the control the هيئة editor shows IS the reader's own control", () => {
    // Not a copy of it — one component, so the two surfaces cannot offer different swatches, ranges
    // or wording for the same value.
    expect(holding("export function RefRuleControls")).toEqual(["src/features/reader/RefRuleControls.tsx"]);
    expect(read("src/features/profiles/editor/RefsSection.tsx")).toContain("RefRuleControls");
    expect(read("src/features/reader/ReadingSettings.tsx")).toContain("RefRuleControls");
  });
});

describe("the mark's APPEARANCE and a book's REFERENCES are different things", () => {
  it("the هيئة model knows nothing about reference content", () => {
    const model = read("src/features/profiles/model/profile.ts");
    // No book id, no phrase, no note, no CFI — a هيئة styles the mark and never says which words wear it.
    for (const content of ["refsForBook", "refSave", "refDelete", "refsAll", "phraseFold"]) {
      expect(model, content).not.toContain(content);
    }
  });

  it("and the reference DATA path knows nothing about the mark's styling", () => {
    const store = read("src/features/reader/referencesStore.ts");
    for (const styling of ["refRuleColor", "refRuleWeight", "refRuleOffset", "resolveRefRule"]) {
      expect(store, styling).not.toContain(styling);
    }
  });
});
