// A COMPOSITION REARRANGES THE CARD. IT DOES NOT UNDO THE READER'S TYPOGRAPHY.
//
// THE DEFECT THIS PINS. `applyComposition` lays every role out again and writes the result back, and
// the merge kept exactly two things from what was there: the colour and the face. Everything else the
// reader had set — the size, the alignment, the line height, the tracking, the readability treatment
// and its colour, the stroke — was replaced by whatever the layout pass had computed.
//
// So the sequence in the report reads: customise the text, choose a second composition, and the
// customisation is gone. An act the reader takes to be decorative destroyed their work, silently,
// with no way back but to do it all again.
//
// THE RULE NOW IS OWNERSHIP, and it is the only rule that can be right here: a composition owns the
// arrangement — where things sit and the sizes and spacing it works out from the words — and the
// reader owns whatever they set by hand. `own` is the record, written at the one door every control
// goes through (`updateStyle`), so a knob added later is owned without anyone remembering to say so.
import { describe, expect, it } from "vitest";

import { applyComposition } from "../../src/features/photo/compositions";
import { updateStyle } from "../../src/features/photo/elements";
import { newCustomComposition, type Composition, type TextElement } from "../../src/features/photo/composition";

const cardOf = (): Composition => newCustomComposition("ivory", "portrait", "قِف بنا نبكِ من ذكرى حبيبٍ ومنزلِ");
const quoteOf = (c: Composition): TextElement =>
  c.elements.find((e): e is TextElement => e.kind === "quote")!;

describe("what a composition may change", () => {
  it("still rearranges a card nobody has customised", () => {
    // The feature must not have been made safe by being made useless.
    const before = cardOf();
    const after = applyComposition(before, "gilded");
    const a = quoteOf(before).placement.rect;
    const b = quoteOf(after).placement.rect;
    expect([a.x, a.y, a.w, a.h]).not.toEqual([b.x, b.y, b.w, b.h]);
  });

  it("keeps the element's identity, so nothing else that refers to it breaks", () => {
    const before = cardOf();
    const after = applyComposition(before, "night");
    expect(quoteOf(after).id).toBe(quoteOf(before).id);
    expect(quoteOf(after).text).toBe(quoteOf(before).text);
  });
});

describe("what a composition may NOT change — the reader's own", () => {
  /** A card whose quote has been worked on the way the report describes. */
  const customised = (): Composition => {
    let c = cardOf();
    const id = quoteOf(c).id;
    c = updateStyle(c, id, { family: "amiri", size: 0.062, align: "end" });
    c = updateStyle(c, id, { color: "#3B2A1A", lineHeight: 2.1, letterSpacing: 0.04 });
    c = updateStyle(c, id, { legibility: "halo", legibilityStrength: 0.8, legibilityColor: "#FFEFD5" });
    c = updateStyle(c, id, { strokeWidth: 0.05, strokeColor: "#1A1008" });
    return c;
  };

  it("records every property as it is set", () => {
    const own = quoteOf(customised()).own ?? [];
    for (const k of [
      "family", "size", "align", "color", "lineHeight", "letterSpacing",
      "legibility", "legibilityStrength", "legibilityColor", "strokeWidth", "strokeColor",
    ]) {
      expect(own, k + " was not recorded").toContain(k);
    }
  });

  it("survives ONE change of composition", () => {
    const after = quoteOf(applyComposition(customised(), "manuscript")).style;
    expect(after.family).toBe("amiri");
    expect(after.size).toBe(0.062);
    expect(after.align).toBe("end");
    expect(after.color).toBe("#3B2A1A");
    expect(after.lineHeight).toBe(2.1);
    expect(after.letterSpacing).toBe(0.04);
    expect(after.legibility).toBe("halo");
    expect(after.legibilityStrength).toBe(0.8);
    expect(after.legibilityColor).toBe("#FFEFD5");
    expect(after.strokeWidth).toBe(0.05);
    expect(after.strokeColor).toBe("#1A1008");
  });

  it("and survives a SECOND, and a third — the record travels with the element", () => {
    // The failure mode this catches: keeping the style but dropping `own`, so the next composition
    // is free to undo what this one was careful to preserve.
    let c = customised();
    for (const id of ["manuscript", "gilded", "night", "calm"] as const) c = applyComposition(c, id);
    const q = quoteOf(c);
    expect(q.style.size).toBe(0.062);
    expect(q.style.legibility).toBe("halo");
    expect(q.style.strokeWidth).toBe(0.05);
    expect(q.own).toContain("size");
  });

  it("a rotation the reader applied is not straightened", () => {
    let c = customised();
    const id = quoteOf(c).id;
    c = {
      ...c,
      elements: c.elements.map((e) =>
        e.id === id && e.kind !== "unknown"
          ? { ...e, placement: { ...e.placement, rotate: -7 } }
          : e),
    };
    expect(quoteOf(applyComposition(c, "gilded")).placement.rotate).toBe(-7);
  });

  it("auto-fit is a CHOICE about size, not the absence of one", () => {
    // `size: null` means "let this fit itself". Preserving by truthiness would drop it and pin the
    // text at whatever the layout pass measured, which is the opposite of what the reader asked for.
    let c = cardOf();
    c = updateStyle(c, quoteOf(c).id, { size: null });
    expect(quoteOf(applyComposition(c, "night")).style.size).toBeNull();
  });

  it("but the composition still places it, because placement was never the reader's here", () => {
    const c = customised();
    const before = quoteOf(c).placement.rect;
    const after = quoteOf(applyComposition(c, "gilded")).placement.rect;
    expect([after.x, after.y, after.w, after.h]).not.toEqual([before.x, before.y, before.w, before.h]);
  });
});

describe("a card saved before the record existed", () => {
  // BACKWARD COMPATIBILITY, and it is a real requirement rather than a courtesy: such a card has no
  // `own`, and inventing one would either freeze the layout pass out of properties it has always set
  // or claim the reader made choices they never made. The older rule stands for it, unchanged.
  const legacy = (): Composition => {
    const c = cardOf();
    const q = quoteOf(c);
    return {
      ...c,
      elements: c.elements.map((e) =>
        e.id === q.id
          ? { ...q, own: undefined, style: { ...q.style, family: "amiri", color: "#402A12", size: 0.09, align: "end" } }
          : e),
    };
  };

  it("keeps its face and its colour, exactly as it always did", () => {
    const after = quoteOf(applyComposition(legacy(), "gilded")).style;
    expect(after.family).toBe("amiri");
    expect(after.color).toBe("#402A12");
  });

  it("and lets the composition set the rest, exactly as it always did", () => {
    const after = quoteOf(applyComposition(legacy(), "gilded")).style;
    expect(after.size).not.toBe(0.09);
  });

  it("starts keeping the reader's choices as soon as they make one", () => {
    let c = legacy();
    c = updateStyle(c, quoteOf(c).id, { size: 0.071 });
    expect(quoteOf(applyComposition(c, "night")).style.size).toBe(0.071);
  });
});
