import { describe, expect, it } from "vitest";
import { bandCount, bandOf, bandSpan, buildMap, tallestBand, totalIn } from "../../src/features/deposit/model/map";
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
  it("draws twenty-four bars whatever the book, or none at all", () => {
    // FIXED BY THE DESIGN, not derived from the data and not responsive. A short book leaves its
    // trailing bands with no chapters in them rather than making the map narrower.
    expect(bandCount(1432)).toBe(24);
    expect(bandCount(759)).toBe(24);
    expect(bandCount(9)).toBe(24);
    expect(bandCount(1)).toBe(24);
    expect(bandCount(null)).toBe(0); // no spine, no map
    expect(bandCount(0)).toBe(0);
  });

  it("gives each band a ceil-sized run of chapters, the last one short", () => {
    expect(bandSpan(1432, 24)).toBe(60); // 24 x 60 = 1440, so only the last band is short
    expect(bandSpan(48, 24)).toBe(2);
    expect(bandSpan(15, 24)).toBe(1);
    const m = buildMap({ plan: plan(1432, []), bound: noneBound });
    expect([m.bands[0].from, m.bands[0].to]).toEqual([0, 59]); // chapters 1-60
    expect([m.bands[23].from, m.bands[23].to]).toEqual([1380, 1431]); // 1381-1432, cut to the end
  });

  it("draws a band the book never reaches, and gives it no chapter number", () => {
    // Twenty-four is fixed, so fifteen chapters run out nine bands early. `to < from` is how the
    // view knows there is no such chapter to name under that stretch.
    const m = buildMap({ plan: plan(15, []), bound: noneBound });
    expect(m.bands).toHaveLength(24);
    expect([m.bands[14].from, m.bands[14].to]).toEqual([14, 14]);
    expect(m.bands[15].to).toBeLessThan(m.bands[15].from);
    expect(m.bands[23].to).toBeLessThan(m.bands[23].from);
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
    });
    expect(m.bands).toHaveLength(24);
    expect(m.bands[0].all.highlights).toBe(1);
    expect(m.bands[23].all.highlights).toBe(1);
    expect(m.bands[23].all.notes).toBe(1);
    expect(tallestBand(m)).toBe(2);
  });

  it("keeps a released layer's place — the band empties, it does not vanish", () => {
    const sections = [mk("a", "highlight", 0), mk("b", "highlight", 0)];
    const bound = buildMap({ plan: plan(4, sections), bound: { ...noneBound, highlights: new Set(["a", "b"]) } });
    const released = buildMap({ plan: plan(4, sections), bound: noneBound });
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
    });
    expect(m.sectionless.highlights).toBe(1);
    expect(m.sectionless.notes).toBe(1);
    expect(m.bands.reduce((n, b) => n + totalIn(b.all), 0)).toBe(1); // only the placed one
  });

  it("draws no bands at all when the spine could not be read", () => {
    const m = buildMap({ plan: plan(null, [mk("a", "highlight", 3)]), bound: noneBound });
    expect(m.bands).toHaveLength(0);
    expect(m.sectionless.highlights).toBe(1); // still counted, still sendable
  });

  it("puts a reference and a replacement in the band of the chapter they were made in", () => {
    // THE DESIGN STACKS ALL FOUR KINDS INTO THE SAME BANDS. This test used to assert the opposite —
    // that these two were kept out of the map because they "belong to the whole book" — which was
    // true only while Sard did not record where they were made. Now that a rule carries the place
    // its selection stood in, it is a mark like any other and lands in that chapter's band.
    const m = buildMap({
      plan: plan(8, [
        { kind: "reference", id: "r1", section: "s1", section_index: 0 },
        { kind: "replacement", id: "p1", section: "s8", section_index: 7 },
      ]),
      bound: noneBound,
    });
    expect(m.bands[0].all.references).toBe(1);
    expect(m.bands[7].all.replacements).toBe(1); // eight chapters, one to a band
    expect(m.sectionless.references).toBe(0);
  });

  it("stacks all four kinds into one column when they share a stretch", () => {
    // THE CASE THE MAP EXISTS FOR. Sixty chapters to a band, so chapters 481-540 are band 8 — three
    // highlights, two notes, four references and one replacement there make ONE column of FOUR
    // segments, not four columns and not four rows.
    const at = (kind: MarkSection["kind"], id: string, ch: number): MarkSection => ({
      kind,
      id,
      section: `/6/${ch}`,
      section_index: ch,
    });
    const m = buildMap({
      plan: plan(1432, [
        at("highlight", "h1", 481), at("highlight", "h2", 500), at("highlight", "h3", 539),
        at("note", "n1", 482), at("note", "n2", 538),
        at("reference", "r1", 485), at("reference", "r2", 486), at("reference", "r3", 487), at("reference", "r4", 488),
        at("replacement", "p1", 520),
      ]),
      bound: noneBound,
    });
    const b = m.bands[8];
    expect([b.from, b.to]).toEqual([480, 539]);
    expect(b.all).toEqual({ highlights: 3, notes: 2, references: 4, replacements: 1 });
    // and nowhere else
    expect(m.bands.filter((x) => totalIn(x.all) > 0)).toHaveLength(1);
    expect(totalIn(m.sectionless)).toBe(0);
  });

  it("leaves a rule with no place unplaced rather than guessing one", () => {
    // A reference made before Sard recorded the place, or typed into the library rather than taken
    // from a page, has no chapter that is true of it. It is counted apart, never drawn at a guess.
    const m = buildMap({
      plan: plan(8, [{ kind: "reference", id: "r1", section: null, section_index: null }]),
      bound: noneBound,
    });
    expect(m.sectionless.references).toBe(1);
    expect(m.bands.every((b) => b.all.references === 0)).toBe(true);
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
