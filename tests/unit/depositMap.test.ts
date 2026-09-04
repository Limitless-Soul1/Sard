import { describe, expect, it } from "vitest";
import { bandCount, bandOf, buildMap, tallestBand, totalIn } from "../../src/features/deposit/model/map";
import { bindAll, boundCount, layerState, setLayer, toggleMark } from "../../src/features/deposit/model/bind";
import { emptySelection } from "../../src/features/deposit/model/manifest";
import type { DepositPlan, MarkSection } from "../../src/lib/ipc";

const mk = (id: string, kind: "highlight" | "note", section_index: number | null): MarkSection => ({
  kind,
  id,
  section: section_index === null ? null : `/6/${section_index * 2 + 2}`,
  section_index,
});

const plan = (spine: number | null, sections: MarkSection[]): DepositPlan => ({
  book: { hash: "h", format: "epub", title: null, author: null, language: null, dir: null, size_bytes: 0 },
  spine_count: spine,
  book_bytes: 0,
  cover_bytes: 0,
  book_source: null,
  cover_source: null,
  book_member: null,
  cover_member: null,
  sections,
  counts: { highlights: 0, notes: 0, references: 0, replacements: 0 },
});

const noneBound = { highlights: new Set<string>(), notes: new Set<string>(), references: new Set<string>(), replacements: new Set<string>() };

describe("the reading map", () => {
  it("draws twenty-four bars over a long book and one per section over a short one", () => {
    expect(bandCount(1432)).toBe(24);
    expect(bandCount(759)).toBe(24);
    expect(bandCount(9)).toBe(9); // never slivers of nothing
    expect(bandCount(1)).toBe(1);
    expect(bandCount(null)).toBe(0);
    expect(bandCount(0)).toBe(0);
  });

  it("puts the first and last section in the first and last bar", () => {
    expect(bandOf(0, 1432, 24)).toBe(0);
    expect(bandOf(1431, 1432, 24)).toBe(23);
    expect(bandOf(1432, 1432, 24)).toBe(23); // clamped, never past the end
  });

  it("counts every mark in its own stretch", () => {
    const m = buildMap({
      plan: plan(24, [mk("a", "highlight", 0), mk("b", "highlight", 23), mk("c", "note", 23)]),
      bound: noneBound,
      referenceIds: [],
      replacementIds: [],
    });
    expect(m.bands).toHaveLength(24);
    expect(m.bands[0].all.highlights).toBe(1);
    expect(m.bands[23].all.highlights).toBe(1);
    expect(m.bands[23].all.notes).toBe(1);
    expect(tallestBand(m)).toBe(2);
  });

  it("keeps a released layer's place — the band empties, it does not vanish", () => {
    const sections = [mk("a", "highlight", 0), mk("b", "highlight", 0)];
    const bound = buildMap({ plan: plan(4, sections), bound: { ...noneBound, highlights: new Set(["a", "b"]) }, referenceIds: [], replacementIds: [] });
    const released = buildMap({ plan: plan(4, sections), bound: noneBound, referenceIds: [], replacementIds: [] });
    expect(bound.bands[0].bound.highlights).toBe(2);
    expect(released.bands[0].bound.highlights).toBe(0);
    // the SHAPE is unchanged — this is what makes an unbound mark a hollow strip rather than a gap
    expect(released.bands[0].all.highlights).toBe(2);
    expect(released.bands).toHaveLength(bound.bands.length);
  });

  it("never guesses a sectionless mark onto a band", () => {
    const m = buildMap({
      plan: plan(10, [mk("a", "highlight", null), mk("b", "note", null), mk("c", "highlight", 5)]),
      bound: noneBound,
      referenceIds: [],
      replacementIds: [],
    });
    expect(m.sectionless.highlights).toBe(1);
    expect(m.sectionless.notes).toBe(1);
    expect(m.bands.reduce((n, b) => n + totalIn(b.all), 0)).toBe(1); // only the placed one
  });

  it("draws no bands at all when the spine could not be read", () => {
    const m = buildMap({ plan: plan(null, [mk("a", "highlight", 3)]), bound: noneBound, referenceIds: [], replacementIds: [] });
    expect(m.bands).toHaveLength(0);
    expect(m.sectionless.highlights).toBe(1); // still counted, still sendable
  });

  it("keeps references and replacements out of the bands — they belong to the whole book", () => {
    const m = buildMap({ plan: plan(8, []), bound: noneBound, referenceIds: ["r1", "r2"], replacementIds: ["p1"] });
    expect(m.wholeBook.references).toBe(2);
    expect(m.wholeBook.replacements).toBe(1);
    expect(m.bands.every((b) => totalIn(b.all) === 0)).toBe(true);
  });
});

describe("binding and unbinding", () => {
  const rows = {
    highlights: [{ id: "h1" }, { id: "h2" }],
    notes: [{ id: "n1" }],
    references: [{ id: "r1" }],
    replacements: [] as { id: string }[],
  };

  it("opens with everything bound", () => {
    const sel = bindAll(rows);
    expect(boundCount(sel)).toBe(4);
    expect(layerState(sel, "highlights", rows)).toBe("all");
    expect(layerState(sel, "replacements", rows)).toBe("none"); // an empty layer is not "all"
  });

  it("takes and releases a whole layer at once", () => {
    let sel = bindAll(rows);
    sel = setLayer(sel, "highlights", rows, false);
    expect(sel.highlights.size).toBe(0);
    expect(sel.notes.size).toBe(1); // the other layers are untouched
    sel = setLayer(sel, "highlights", rows, true);
    expect(layerState(sel, "highlights", rows)).toBe("all");
  });

  it("releases one slip without touching its layer", () => {
    let sel = bindAll(rows);
    sel = toggleMark(sel, "highlights", "h1");
    expect(sel.highlights.has("h1")).toBe(false);
    expect(sel.highlights.has("h2")).toBe(true);
    expect(layerState(sel, "highlights", rows)).toBe("some");
    sel = toggleMark(sel, "highlights", "h1");
    expect(layerState(sel, "highlights", rows)).toBe("all");
  });

  it("never mutates the selection it was given", () => {
    const sel = bindAll(rows);
    const before = new Set(sel.highlights);
    toggleMark(sel, "highlights", "h1");
    setLayer(sel, "highlights", rows, false);
    expect(sel.highlights).toEqual(before);
  });

  it("an empty selection is empty in every layer", () => {
    const sel = emptySelection();
    expect(boundCount(sel)).toBe(0);
  });
});
