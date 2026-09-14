// THE DATE AND THE TIME A CARD CARRIES — the two stamps, and the two ways a card comes into being.
//
// THE DEFECT. A card made from a passage draws its stamps in the footer of the preset layout it was
// lifted into. A card made from «أنشئ بطاقة مصوّرة» has no preset layout — that is its whole
// blankness — so the branch that draws that footer is skipped for it. Switching «التاريخ» on
// therefore did everything except the last step: the switch was recorded in the document, the
// string was formatted, the inspector showed the reader the very characters it would print, and the
// card printed none of them. Measured in the running composer, both stamps on: the canvas drew
// «” · كلماتك هنا. · Sard سَرْد» and nothing else.
//
// The rendering fix belongs to the composer and is verified in the running application. What is
// held here is the part a test can hold: that the two paths share ONE data model, that a blank
// card's documented creation default is not quietly changed into a new product rule, and that a
// stamp a reader switched on survives being written to disk and read back.
import { describe, expect, it } from "vitest";
import {
  newCustomComposition,
  parseComposition,
  serializeComposition,
  type Composition,
} from "../../src/features/photo/composition";
import { formatCardDate, formatCardTime } from "../../src/features/photo/photo";

const blank = () => newCustomComposition("ivory", "portrait", "كلماتك هنا.");

describe("a blank card's creation default", () => {
  // A BLANK CARD IS BLANK OF THE BOOK, NOT OF SARD. There is no book behind it, so every part that
  // would name one starts off — and the date and the time are among them, deliberately. This is the
  // existing product rule, written down here so that making the stamps WORK cannot slide into
  // making them APPEAR, which is a different decision and nobody's to take by accident.
  it("starts with no date and no time, and with the mark", () => {
    const meta = blank().preset.meta;
    expect(meta.date).toBe(false);
    expect(meta.time).toBe(false);
    expect(meta.title).toBe(false);
    expect(meta.chapter).toBe(false);
    expect(meta.author).toBe(false);
    expect(meta.brand).toBe(true);
  });

  it("is a custom composition, which is what says it has no preset furniture", () => {
    expect(blank().custom).toBe(true);
  });
});

describe("a stamp a reader switched on", () => {
  const withStamps = (): Composition => {
    const c = blank();
    return { ...c, preset: { ...c.preset, meta: { ...c.preset.meta, date: true, time: true } } };
  };

  // THE ROUND TRIP. A card is written as a document and read back as one; a stamp that did not
  // survive that would come back off, and the reader would find the card they saved is not the card
  // they get. Both halves are asserted, because a default of `false` makes a dropped field look
  // exactly like a deliberate "off".
  it("is still on after the card is written and read again", () => {
    const back = parseComposition(serializeComposition(withStamps()));
    expect(back).not.toBeNull();
    expect(back!.preset.meta.date).toBe(true);
    expect(back!.preset.meta.time).toBe(true);
    expect(back!.custom).toBe(true);
  });

  it("and one left off is still off", () => {
    const c = withStamps();
    const only = { ...c, preset: { ...c.preset, meta: { ...c.preset.meta, time: false } } };
    const back = parseComposition(serializeComposition(only))!;
    expect(back.preset.meta.date).toBe(true);
    expect(back.preset.meta.time).toBe(false);
  });

  it("survives a blank card that was never given one", () => {
    const back = parseComposition(serializeComposition(blank()))!;
    expect(back.preset.meta.date).toBe(false);
    expect(back.preset.meta.time).toBe(false);
  });
});

describe("what a stamp prints", () => {
  // ONE FORMATTER FOR BOTH PATHS. A card made from a passage and a card made from nothing print the
  // same characters for the same moment; a second implementation for one of them is exactly what
  // this is here to prevent.
  const at = new Date(Date.UTC(2026, 8, 13, 9, 42));

  it("is a real date and a real time, in the interface's language", () => {
    for (const lang of ["ar", "en"]) {
      expect(formatCardDate(at, lang).length).toBeGreaterThan(0);
      expect(formatCardTime(at, lang).length).toBeGreaterThan(0);
      expect(formatCardDate(at, lang)).toContain("2026");
    }
  });

  it("never prints an empty stamp for a valid moment", () => {
    expect(formatCardDate(at, "ar").trim()).not.toBe("");
    expect(formatCardTime(at, "ar").trim()).not.toBe("");
  });
});
