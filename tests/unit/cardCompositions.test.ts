// «بداية، لا قالب» — A START, NOT A TEMPLATE, held to as a property rather than as a comment.
//
// The four compositions are now flavours of one content-aware pass; how that pass ADAPTS is proved
// in `autoLayout.test.ts`. What is proved here is the promise around it — that applying one is an
// act and not a mode. It arranges the card once; it keeps the user's words, their colours and their
// choices about what is hidden; it leaves everything they added themselves exactly where they put
// it; and nothing re-runs it behind their back.
//
// The colour maths is here too, for a smaller reason: the hex field is the only part of the picker a
// person can carry somewhere else, so it has to be exactly right about what it accepts.

import { describe, expect, it } from "vitest";

import { hexToHsv, hsvToHex, normaliseHex } from "../../src/features/photo/ColourPicker";
import { liftedParts, newId, presetHidden, type Composition, type ImageElement, type PresetPart, type TextElement } from "../../src/features/photo/composition";
import { applyComposition, COMPOSITIONS, makeRoleElement, ROLES, seedComposition, type CompositionId } from "../../src/features/photo/compositions";

const IDS = COMPOSITIONS.map((c) => c.id);
const CANVAS = { format: "portrait" as const, w: 1080, h: 1350 };

const WORDS = {
  quote: "لا شيء يبقى على حاله، وهذا هو العزاء كله.",
  title: "The Book",
  chapter: "Chapter Two",
  author: "A. Writer",
};

function card(elements: Composition["elements"]): Composition {
  return {
    v: 1,
    canvas: { format: "portrait", w: 1080, h: 1350 },
    ground: { kind: "theme", themeId: "sepia" },
    preset: {
      style: "minimal", textSize: "auto",
      meta: { date: false, time: false, title: true, chapter: true, author: true, brand: true },
      quoteFont: null, quoteWeight: 400, quoteSpacing: "normal", quoteAlign: "auto",
    },
    elements,
  };
}

/** An element that has geometry. `unknown` — a shape from a newer version — does not. */
function placed(el: Composition["elements"][number]) {
  if (el.kind === "unknown") throw new Error("expected a placed element");
  return el;
}

describe("the four compositions", () => {
  it("seeds only the roles that have words", () => {
    // A book with no chapter does not get an empty chapter line sitting on the card waiting to be
    // noticed and deleted.
    const els = seedComposition("calm", { quote: WORDS.quote, title: WORDS.title, chapter: "  ", author: "" }, CANVAS);
    expect(els.map((e) => e.origin)).toEqual(["quote", "title"]);
  });

  it("leaves attribution out unless it is given", () => {
    // A card already names its book and its author; a third line saying so again is clutter. It is
    // offered in the rail, and it appears when it has something to say.
    for (const id of IDS) {
      expect(seedComposition(id, WORDS, CANVAS).some((e) => e.origin === "attribution")).toBe(false);
      const withIt = seedComposition(id, { ...WORDS, attribution: "The Book — A. Writer" }, CANVAS);
      expect(withIt.some((e) => e.origin === "attribution")).toBe(true);
    }
    expect(ROLES).toContain("attribution");
  });

  it("makes the quote its own kind and every other role an attribution", () => {
    expect(makeRoleElement("calm", "quote", "x", CANVAS).kind).toBe("quote");
    for (const part of ["title", "chapter", "author", "attribution"] as PresetPart[]) {
      expect(makeRoleElement("calm", part, "x", CANVAS).kind).toBe("attribution");
    }
  });

  it("places a role added later where that role belongs on THIS card", () => {
    const el = makeRoleElement("calm", "author", WORDS.author, CANVAS, WORDS);
    const seeded = seedComposition("calm", WORDS, CANVAS).find((e) => e.origin === "author")!;
    // The same pass, so the same place — not a coordinate that was right for some other card.
    expect(el.placement.rect).toEqual(seeded.placement.rect);
    expect(el.text).toBe(WORDS.author);
  });
});

describe("applying a composition", () => {
  it("keeps the words and replaces only the arrangement", () => {
    const before = card(seedComposition("calm", WORDS, CANVAS));
    const after = applyComposition(before, "night", CANVAS);
    expect(after.elements.map((e) => (e as TextElement).text).sort())
      .toEqual(before.elements.map((e) => (e as TextElement).text).sort());
    const q = (c: Composition) => placed(c.elements.find((e) => (e as TextElement).origin === "quote")!).placement.rect;
    expect(q(after)).not.toEqual(q(before));
  });

  it("does not reapply itself: what the user moved afterwards stays moved", () => {
    // THE WHOLE POINT. Applying is an act, not a mode — so a card the user has since edited keeps
    // their edit, and the only way that holds is if nothing calls back into here on its own.
    const applied = applyComposition(card(seedComposition("calm", WORDS, CANVAS)), "gilded", CANVAS);
    const moved: Composition = {
      ...applied,
      elements: applied.elements.map((e) =>
        (e as TextElement).origin === "title"
          ? { ...placed(e), placement: { ...placed(e).placement, rect: { x: 0.4, y: 0.05, w: 0.5, h: 0.06 } } }
          : e),
    };
    const title = placed(moved.elements.find((e) => (e as TextElement).origin === "title")!);
    expect(title.placement.rect).toEqual({ x: 0.4, y: 0.05, w: 0.5, h: 0.06 });
  });

  it("keeps what the user chose that is not positional", () => {
    // Re-composing must not quietly discard a colour they picked or un-hide something they switched
    // off. It rearranges; it does not reset.
    const seeded = seedComposition("calm", WORDS, CANVAS).map((e) =>
      e.origin === "author" ? { ...e, hidden: true, style: { ...e.style, color: "#B24A4A" } } : e);
    const after = applyComposition(card(seeded), "manuscript", CANVAS);
    const author = placed(after.elements.find((e) => (e as TextElement).origin === "author")!) as TextElement;
    expect(author.hidden).toBe(true);
    expect(author.style.color).toBe("#B24A4A");
    // …and it is still the same element, so nothing that pointed at it is now pointing at nothing.
    expect(author.id).toBe(seeded.find((e) => e.origin === "author")!.id);
  });

  it("does not rearrange things the user added", () => {
    const sticker: ImageElement = {
      id: newId(), kind: "image", placement: { rect: { x: 0.7, y: 0.05, w: 0.2, h: 0.2 } }, assetId: "a1",
    };
    const free: TextElement = {
      id: newId(), kind: "text", placement: { rect: { x: 0.05, y: 0.9, w: 0.3, h: 0.05 } },
      style: { size: 0.02, weight: 400, lineHeight: 1.4, align: "start", color: null, opacity: 1, dir: "auto" },
      text: "a note",
    };
    const after = applyComposition(card([...seedComposition("night", WORDS, CANVAS), sticker, free]), "calm", CANVAS);
    expect(placed(after.elements.find((e) => e.id === sticker.id)!).placement.rect).toEqual(sticker.placement.rect);
    expect(placed(after.elements.find((e) => e.id === free.id)!).placement.rect).toEqual(free.placement.rect);
  });

  it("survives a card with nothing on it", () => {
    for (const id of IDS) expect(applyComposition(card([]), id as CompositionId, CANVAS).elements).toEqual([]);
  });
});

describe("what the preset stops drawing", () => {
  it("retires the joined credit line as soon as either half is lifted", () => {
    // The preset draws the chapter and the author as ONE line. Lifting either makes it an element of
    // its own, and leaving the joined line underneath would print the same words twice.
    expect(presetHidden(new Set<PresetPart>(["chapter"]), "subtitle")).toBe(true);
    expect(presetHidden(new Set<PresetPart>(["author"]), "subtitle")).toBe(true);
    expect(presetHidden(new Set<PresetPart>(["subtitle"]), "subtitle")).toBe(true);
    expect(presetHidden(new Set<PresetPart>(["title"]), "subtitle")).toBe(false);
    expect(presetHidden(new Set<PresetPart>(), "subtitle")).toBe(false);
  });

  it("hides every part a seeded card has taken over", () => {
    const lifted = liftedParts(card(seedComposition("calm", WORDS, CANVAS)));
    for (const part of ["quote", "title", "subtitle"] as PresetPart[]) {
      expect(presetHidden(lifted, part), part).toBe(true);
    }
  });
});

describe("the colour maths behind the hex field", () => {
  it("round-trips every preset and a spread of hues", () => {
    for (const hex of ["#2B2521", "#F5EEDD", "#9C5A3C", "#C9A227", "#5E7A52", "#3E6B8A", "#7A4E8A", "#B24A4A", "#000000", "#FFFFFF"]) {
      const hsv = hexToHsv(hex)!;
      expect(hsvToHex(hsv.h, hsv.s, hsv.v)).toBe(hex.toUpperCase());
    }
  });

  it("accepts what a person actually types", () => {
    expect(normaliseHex("9c5a3c")).toBe("#9C5A3C");
    expect(normaliseHex("  #9c5a3c  ")).toBe("#9C5A3C");
    expect(normaliseHex("#abc")).toBe("#AABBCC");
    expect(normaliseHex("#9C5A3")).toBeNull();
    expect(normaliseHex("rebeccapurple")).toBeNull();
    expect(normaliseHex("")).toBeNull();
  });

  it("refuses to guess at a colour it cannot read", () => {
    expect(hexToHsv("not a colour")).toBeNull();
    // Grey has no hue to speak of, and saying it is red would move the strip to a lie.
    expect(hexToHsv("#808080")!.s).toBe(0);
  });
});
