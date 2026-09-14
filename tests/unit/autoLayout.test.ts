// THE EVIDENCE THAT IT IS A LAYOUT AND NOT A TABLE.
//
// The whole claim being made is that different content produces a different card. That is falsifiable
// and it is what these check: a four-word line and a four-hundred-character paragraph must not come
// back with the same type size, the same shape, or the same arrangement — and nothing may overlap or
// leave the card in either case.
//
// The two properties that matter most are the ones a coordinate table cannot have:
//   · MONOTONICITY — the longer the passage, the smaller the type, with no exceptions in between.
//   · NON-COLLISION — for every combination of present roles, at every format, in both scripts.

import { describe, expect, it } from "vitest";

import { autoLayout, defaultRectFor, defaultStyleFor, isArabicText, type Flavour } from "../../src/features/photo/autoLayout";
import type { TextElement } from "../../src/features/photo/composition";
import type { CardFormat } from "../../src/features/photo/photo";

const FORMATS: CardFormat[] = ["square", "portrait", "story", "landscape"];
const DIMS: Record<CardFormat, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
  landscape: { w: 1440, h: 1080 },
};

const ONE_LINE = "Nothing stays as it was.";
const SHORT = "The quote font is now its own choice — set the card's face apart from the book.";
const MEDIUM = SHORT + " " + SHORT;
const LONG = new Array(5).fill(SHORT).join(" ");
const HUGE = new Array(12).fill(SHORT).join(" ");

const AR_SHORT = "لا شيء يبقى على حاله، وهذا هو العزاء كله.";
const AR_LONG = new Array(8).fill(AR_SHORT).join(" ");

const BOOK = { title: "The Book", chapter: "Chapter Two", author: "A. Writer" };

function lay(quote: string, format: CardFormat = "portrait", extra: Record<string, string> = BOOK, flavour: Flavour = "calm") {
  return autoLayout({ format, ...DIMS[format], text: { quote, ...extra }, flavour });
}

function overlaps(a: TextElement, b: TextElement) {
  const p = a.placement.rect;
  const q = b.placement.rect;
  const x = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
  const y = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
  // A shared edge is not a collision; a real overlap of more than a hairline is.
  return x > 0.002 && y > 0.004;
}

describe("the automatic composition adapts to the content", () => {
  it("gives a shorter passage bigger type, without exception", () => {
    // THE CENTRAL CLAIM. A table of coordinates cannot do this; it is the reason the size is solved
    // rather than assigned.
    const sizes = [ONE_LINE, SHORT, MEDIUM, LONG, HUGE].map((q) => lay(q).quoteSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `#${i} (${sizes[i]}) should be smaller than #${i - 1} (${sizes[i - 1]})`)
        .toBeLessThan(sizes[i - 1]);
    }
    // And the span is a real one, not three decimal places apart.
    expect(sizes[0] / sizes[sizes.length - 1]).toBeGreaterThan(2.4);
  });

  it("changes the SHAPE of the card, not only the size", () => {
    const shapes = [ONE_LINE, SHORT, MEDIUM, LONG, HUGE].map((q) => lay(q).archetype);
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(4);
    expect(shapes[0]).toBe("display");
    expect(shapes[shapes.length - 1]).toBe("dense");
    // A dramatic card floats its words above the optical centre; a dense one runs the full column.
    // Both start at the margin — the credit is pinned to the foot, so the quote's ROOM is the same
    // and what changes is how much of it the box claims.
    const short = lay(ONE_LINE).elements[0].placement.rect;
    const long = lay(HUGE).elements[0].placement.rect;
    expect(long.h).toBeGreaterThan(short.h);
    expect(short.y + short.h).toBeLessThan(long.y + long.h);
    // And the type is set differently, not merely smaller: tight for display, open for dense.
    expect(lay(ONE_LINE).elements[0].style.lineHeight!).toBeLessThan(lay(HUGE).elements[0].style.lineHeight!);
  });

  it("never lets anything overlap, whatever the card is made of", () => {
    const combos: Record<string, string>[] = [
      BOOK,
      { title: BOOK.title },
      { author: BOOK.author },
      {},
      { ...BOOK, attribution: "The Book — A. Writer" },
      { title: "A Very Long Title That Simply Refuses To Stop Before The Edge Of The Card", chapter: BOOK.chapter, author: BOOK.author },
      { ...BOOK, author: "Abu al-Walid Muhammad ibn Ahmad ibn Rushd al-Qurtubi" },
      { title: "الأجنحة المتكسرة", chapter: "الحزن الأخرس", author: "جبران خليل جبران" },
    ];
    for (const format of FORMATS) {
      for (const quote of [ONE_LINE, SHORT, MEDIUM, LONG, HUGE, AR_SHORT, AR_LONG]) {
        for (const meta of combos) {
          const { elements } = lay(quote, format, meta);
          for (let i = 0; i < elements.length; i++) {
            for (let j = i + 1; j < elements.length; j++) {
              expect(overlaps(elements[i], elements[j]),
                `${format} / ${elements[i].origin} over ${elements[j].origin} (quote ${quote.length} chars)`).toBe(false);
            }
          }
        }
      }
    }
  });

  it("never sets the quote so large that it overflows its own box", () => {
    // THE DEFECT THIS GUARDS. The size solve packs text continuously; real text breaks into whole
    // lines, and a passage wanting 4.2 lines takes five. Five lines at the solved size was taller
    // than the box solved for, and the first line clipped against the top edge of the card.
    const advance = (t: string) => (isArabicText(t) ? 0.42 : 0.5);
    for (const format of FORMATS) {
      const { w, h } = DIMS[format];
      for (const quote of [ONE_LINE, SHORT, MEDIUM, LONG, HUGE, AR_SHORT, AR_LONG]) {
        const r = autoLayout({ format, w, h, text: { quote, ...BOOK } });
        const el = r.elements[0];
        const box = el.placement.rect;
        const size = el.style.size!;
        const perLine = Math.max(1, box.w / (size * advance(quote)));
        const lines = Math.max(1, Math.ceil(quote.length / perLine));
        // In the pixels the browser will draw: a size is a fraction of the card's WIDTH, and the
        // renderer sets `fontSize = size * cardWidth`. Working in px rather than in fractions is
        // deliberate — the fraction form is exactly where the layout had the conversion inverted,
        // and a test that repeats the code's arithmetic cannot catch the code's arithmetic.
        const textPx = lines * (size * w) * el.style.lineHeight!;
        const boxPx = box.h * h;
        expect(textPx, `${format}, ${quote.length} chars: ${textPx.toFixed(0)}px of text in a ${boxPx.toFixed(0)}px box`)
          .toBeLessThanOrEqual(boxPx + 1);
      }
    }
  });

  it("gives the quote a size that USES the room, not a third of it", () => {
    // The mirror of the overflow test. A layout can also be wrong by being timid, and it was: the
    // same inverted conversion made a story card reserve 1130px of height for 630px of text, so the
    // quote sat small in the middle of a card that had room for half as much again.
    for (const format of FORMATS) {
      const { w, h } = DIMS[format];
      for (const quote of [MEDIUM, LONG, HUGE, AR_LONG]) {
        const r = autoLayout({ format, w, h, text: { quote, ...BOOK } });
        const el = r.elements[0];
        const size = el.style.size!;
        const advance = isArabicText(quote) ? 0.42 : 0.5;
        const lines = Math.max(1, Math.ceil(quote.length / Math.max(1, el.placement.rect.w / (size * advance))));
        const used = (lines * (size * w) * el.style.lineHeight!) / (el.placement.rect.h * h);
        expect(used, `${format}, ${quote.length} chars fills ${(used * 100).toFixed(0)}% of its box`)
          .toBeGreaterThan(0.6);
      }
    }
  });

  it("keeps every element on the card", () => {
    for (const format of FORMATS) {
      for (const quote of [ONE_LINE, MEDIUM, HUGE, AR_LONG]) {
        for (const el of lay(quote, format).elements) {
          const r = el.placement.rect;
          expect(r.x, format).toBeGreaterThanOrEqual(0);
          expect(r.y, format).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w, format).toBeLessThanOrEqual(1.0001);
          expect(r.y + r.h, `${format} bottom, ${quote.length} chars`).toBeLessThanOrEqual(1.0001);
        }
      }
    }
  });

  it("gives each format its own arrangement rather than one scaled layout", () => {
    // The same words on a story and on a landscape must not come back as the same rectangle.
    const byFormat = FORMATS.map((f) => lay(MEDIUM, f));
    const rects = byFormat.map((r) => JSON.stringify(r.elements[0].placement.rect));
    expect(new Set(rects).size).toBe(FORMATS.length);
    // Each one also SETS it differently. Deliberately not an ordering between two named formats:
    // the size steps down until the whole lines fit, and which format crosses a line boundary first
    // depends on the passage — so "landscape is always smaller than story" is a fact about one
    // string, not a law about the layout. Asserting it made the whole-line fix look like a
    // regression when it was the thing that stopped a quote clipping off the top of the card.
    expect(new Set(byFormat.map((r) => r.quoteSize)).size).toBeGreaterThanOrEqual(3);
  });

  it("spends the room a missing credit frees", () => {
    const withAll = lay(MEDIUM, "portrait", BOOK);
    const bare = lay(MEDIUM, "portrait", {});
    expect(bare.elements).toHaveLength(1);
    // No awkward empty metadata band: the quote takes the space instead.
    expect(bare.elements[0].placement.rect.h).toBeGreaterThan(withAll.elements[0].placement.rect.h);
    expect(bare.quoteSize).toBeGreaterThan(withAll.quoteSize);
  });

  it("reflows a long title instead of letting it swell", () => {
    const short = lay(MEDIUM, "portrait", { title: "Sand" });
    const long = lay(MEDIUM, "portrait", { title: "A Very Long Title That Simply Refuses To Stop Before The Edge Of The Card" });
    const sizeOf = (r: ReturnType<typeof lay>) => r.elements.find((e) => e.origin === "title")!.style.size!;
    expect(sizeOf(long)).toBeLessThan(sizeOf(short));
    // And it is given the height it needs for the second line.
    const hOf = (r: ReturnType<typeof lay>) => r.elements.find((e) => e.origin === "title")!.placement.rect.h;
    expect(hOf(long)).toBeGreaterThan(hOf(short));
  });

  it("measures Arabic as Arabic", () => {
    expect(isArabicText(AR_SHORT)).toBe(true);
    expect(isArabicText(SHORT)).toBe(false);
    // The same character count in Arabic occupies less line, so it earns a larger size.
    const latin = autoLayout({ format: "portrait", ...DIMS.portrait, text: { quote: "x".repeat(AR_LONG.length) } });
    const arabic = autoLayout({ format: "portrait", ...DIMS.portrait, text: { quote: AR_LONG } });
    expect(arabic.quoteSize).toBeGreaterThan(latin.quoteSize);
  });

  it("gives every flavour the same content a different arrangement", () => {
    const flavours: Flavour[] = ["calm", "manuscript", "gilded", "night"];
    const seen = flavours.map((f) => JSON.stringify(lay(MEDIUM, "portrait", BOOK, f).elements.map((e) => e.placement.rect)));
    expect(new Set(seen).size).toBe(flavours.length);
    expect(lay(MEDIUM, "portrait", BOOK, "calm").elements[0].style.align).toBe("center");
    expect(lay(MEDIUM, "portrait", BOOK, "manuscript").elements[0].style.align).toBe("start");
  });

  it("orders the card the way it reads", () => {
    const { elements } = lay(MEDIUM, "portrait", { ...BOOK, attribution: "x — y" });
    expect(elements.map((e) => e.origin)).toEqual(["quote", "title", "chapter", "author", "attribution"]);
    // And each one sits below the one before it.
    for (let i = 1; i < elements.length; i++) {
      expect(elements[i].placement.rect.y).toBeGreaterThanOrEqual(elements[i - 1].placement.rect.y);
    }
  });

  it("gives every text a real size — never zero and never absent", () => {
    for (const format of FORMATS) {
      for (const el of lay(MEDIUM, format).elements) {
        expect(typeof el.style.size, format).toBe("number");
        expect(el.style.size!, format).toBeGreaterThan(0.015);
      }
    }
  });
});

describe("what a hand-built card starts from", () => {
  it("puts a newly added part somewhere sensible, not at the origin", () => {
    for (const part of ["quote", "title", "chapter", "author", "attribution", "text", "image"] as const) {
      const r = defaultRectFor(part, "portrait");
      expect(r.x, part).toBeGreaterThan(0);
      expect(r.y, part).toBeGreaterThan(0);
      expect(r.x + r.w, part).toBeLessThanOrEqual(1.0001);
      expect(r.y + r.h, part).toBeLessThanOrEqual(1.0001);
    }
    // In reading order, so a card built by hand has the same bones as a generated one.
    const y = (p: "quote" | "title" | "chapter" | "author") => defaultRectFor(p, "portrait").y;
    expect(y("quote")).toBeLessThan(y("title"));
    expect(y("title")).toBeLessThan(y("chapter"));
    expect(y("chapter")).toBeLessThan(y("author"));
  });

  it("gives it a real size from the start", () => {
    for (const part of ["quote", "title", "chapter", "author", "attribution", "text"] as const) {
      const st = defaultStyleFor(part, "portrait");
      expect(st.size, part).toBeGreaterThan(0.015);
      expect(st.size, part).toBeLessThan(0.2);
    }
    expect(defaultStyleFor("title", "portrait").weight).toBe(700);
    expect(defaultStyleFor("quote", "portrait").size!).toBeGreaterThan(defaultStyleFor("author", "portrait").size!);
  });
});
