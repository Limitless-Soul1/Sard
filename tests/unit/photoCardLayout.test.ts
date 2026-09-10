// WHAT THE PHOTO CARD PROMISES ABOUT ITS OWN LAYOUT.
//
// Five faults were measured in the running editor, and each of them was a layout rule that existed
// in one place and not in the other. This suite pins the rules, not the pixels: the numbers here are
// relationships — this box is the height of its text, this band is clear of that mark — so a change
// of format, type size or margin cannot make them pass for the wrong reason.
//
// The rendered result is verified in the running application; what is pinned here is the arithmetic
// underneath it, which is the part that can be wrong without anyone noticing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  autoLayout, defaultRectFor, defaultStyleFor, quoteRegion,
} from "../../src/features/photo/autoLayout";
import {
  brandBand, newCustomComposition, parseComposition, type Preset,
} from "../../src/features/photo/composition";
import { addRoleLaidOut, seedComposition } from "../../src/features/photo/compositions";
import { DEFAULT_META } from "../../src/features/photo/photo";
import { isText, MIN_SIZE } from "../../src/features/photo/elements";
import type { Composition, Rect } from "../../src/features/photo/composition";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

const composer = read("src/features/photo/PhotoComposer.tsx");
const inspector = read("src/features/photo/Inspector.tsx");
const layers = read("src/features/photo/CardLayers.tsx");
const overlay = read("src/features/photo/CardOverlay.tsx");
const ar = read("src/i18n/locales/ar.ts");
const en = read("src/i18n/locales/en.ts");

const CANVAS = { format: "portrait" as const, w: 1080, h: 1350 };
const preset = (over: Partial<Preset> = {}): Preset =>
  ({ style: "minimal", textSize: "m", meta: { ...DEFAULT_META }, ...over }) as Preset;

/** The text elements of a laid-out card, narrowed — the only kind these rules are about. */
const texts = (els: Composition["elements"]) => els.filter(isText);

/**
 * Do two rects share any AREA? The whole of "these must not collide", said once.
 *
 * The tolerance is what makes it mean that. The credit stack is laid out to end exactly at the top
 * of the mark's reserved band — that is the design, not a near miss — so its last line and the band
 * share an edge, and in floating point that edge lands a few parts in 10^16 on the wrong side. A
 * shared edge is not a collision; `EPS` is far below one card pixel (1/1350 ≈ 7e-4) and far above
 * that noise, so a real overlap of even a fifth of a pixel still fails.
 */
const EPS = 1e-6;
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x + EPS < b.x + b.w && b.x + EPS < a.x + a.w
  && a.y + EPS < b.y + b.h && b.y + EPS < a.y + a.h;

describe("«ملء البطاقة» is gone", () => {
  it("no control offers it, in either language", () => {
    // The KEY, not the prefix: `photo.fit.autoNow` is a different string and legitimately stays —
    // it is the note a card saved under the old option still shows in place of a size.
    expect(inspector).not.toMatch(/photo\.fit\.auto(?!Now)/);
    expect(composer).not.toMatch(/photo\.fit\.auto(?!Now)/);
    expect(ar).not.toContain('"photo.fit.auto"');
    expect(en).not.toContain('"photo.fit.auto"');
    expect(ar).not.toContain("ملء البطاقة");
  });

  it("…and a card that was saved using it still opens exactly as it was", () => {
    // THE DISTINCTION THAT MATTERS. The option is withdrawn; the `size: null` it wrote is not, or
    // every card made while it existed would re-size itself on the next open.
    const doc = parseComposition(JSON.stringify({
      v: 3,
      canvas: CANVAS,
      preset: preset(),
      ground: { kind: "theme" },
      elements: [{
        id: "q", kind: "quote", text: "وَقَفَ الضَّوءُ",
        placement: { rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.4 } },
        style: { size: null, lineHeight: 1.6 },
      }],
    }));
    const q = doc?.elements.find((e) => e.kind === "quote");
    expect(q).toBeTruthy();
    expect(q && "style" in q ? q.style.size : "missing").toBeNull();
  });

  it("the auto-fit path is still what draws such a card", () => {
    // `size == null` is what selects the bisect in the renderer; it is the reader of the old value.
    expect(layers).toContain("style.size === null");
  });
});

describe("a text box is the height of its text", () => {
  it("the measurement is reported in BOTH directions, not only on overflow", () => {
    // THE REGRESSION. It fired only when the words overflowed, so a box that had once been tall
    // stayed tall for ever — measured in the editor: 85px of box around 29px of text.
    const i = layers.indexOf("if (!auto) {");
    const body = layers.slice(i, layers.indexOf("return;", i));
    expect(body).toContain("onNeedsRoom");
    expect(body).not.toMatch(/scrollHeight > box\.clientHeight \+ 1/);
  });

  it("an empty field measures one line, never nothing", () => {
    // A zero-height element cannot be seen, selected or typed into.
    const i = layers.indexOf("if (!auto) {");
    const body = layers.slice(i, layers.indexOf("return;", i));
    expect(body).toContain("lineHeight");
    expect(body).toMatch(/scrollHeight > 0/);
  });

  it("the box rounds UP, because it clips", () => {
    // The box is `overflow: hidden`: a height a fraction short takes a descender or a kasra off.
    const i = layers.indexOf("if (!auto) {");
    expect(layers.slice(i, layers.indexOf("return;", i))).toMatch(/need \+ \d/);
  });

  it("the composer shrinks as well as grows, and never below the grab floor", () => {
    const i = composer.indexOf("const fitToText");
    const body = composer.slice(i, composer.indexOf("}, []);", i));
    expect(body).toContain("MIN_SIZE");
    // An absolute difference decides whether anything happens, not "is it bigger" — that asymmetry
    // WAS the bug, and a box that only grew is what left 85px of rectangle around 29px of text.
    expect(body).toMatch(/Math\.abs\(h - rect\.h\)/);
    expect(body).not.toMatch(/want <= rect\.h/);
    expect(composer).not.toContain("growToFit");
  });

  it("a new text field arrives one line tall, not a fifth of the card", () => {
    for (const part of ["text", "chapter", "author", "attribution"] as const) {
      const rect = defaultRectFor(part, "portrait");
      const style = defaultStyleFor(part, "portrait");
      // One line of its own type, converted from a width-fraction to a height-fraction.
      const line = (style.size ?? 0) * (style.lineHeight ?? 1.6) * (CANVAS.w / CANVAS.h);
      expect(rect.h, part).toBeCloseTo(line, 5);
      // …and that is far below what a "long empty rectangle" would be.
      expect(rect.h, part).toBeLessThan(0.09);
    }
  });

  it("only the measure is draggable on text whose size is the reader's", () => {
    // A height handle on a box that follows its text is a control that snaps back.
    expect(overlay).toContain('g.grip === "is" || g.grip === "ie"');
    expect(overlay).toContain("el.style.size != null");
  });
});

describe("the Sard mark has a face, and it is a property", () => {
  it("the mark is no longer drawn in a hard-coded constant", () => {
    expect(composer).toContain("brandFamily(p.brandFont");
    // Both halves take the same choice — it is one lockup, not two runs of text.
    const i = composer.indexOf("brandFamily(p.brandFont");
    expect(composer.slice(i, i + 700)).toMatch(/brandFamily\(p\.brandFont[\s\S]*brandFamily\(p\.brandFont/);
  });

  it("Sard's own face is always behind the choice", () => {
    // A Latin-only family has nothing to draw «سَرْد» with.
    const i = composer.indexOf("const brandFamily");
    expect(composer.slice(i, i + 600)).toMatch(/chosen \? .*fallback.* : fallback/);
  });

  it("the value reaches CSS verbatim, because the faces ARE css values", () => {
    // Quoting it made `"var(--ar-font)"` — a family name that does not exist — and the mark
    // silently kept the face it had. Measured in the editor before the fix.
    const i = composer.indexOf("const brandFamily");
    expect(composer.slice(i, i + 600)).not.toMatch(/\\"\$\{chosen\}\\"/);
  });

  it("a saved document cannot smuggle a declaration in through it", () => {
    const bad = ["a; color: red", "a{b}", 'a", x', "a/*b*/c", "a<b>"];
    for (const v of bad) {
      const doc = parseComposition(JSON.stringify({
        v: 3, canvas: CANVAS, ground: { kind: "theme" }, elements: [],
        preset: { ...preset(), brandFont: v },
      })) as Composition | null;
      expect(doc?.preset.brandFont, v).toBeUndefined();
    }
    const ok = parseComposition(JSON.stringify({
      v: 3, canvas: CANVAS, ground: { kind: "theme" }, elements: [],
      preset: { ...preset(), brandFont: "var(--ar-font)" },
    })) as Composition | null;
    expect(ok?.preset.brandFont).toBe("var(--ar-font)");
  });

  it("choosing a face is offered once, and named in both languages", () => {
    for (const k of ["photo.brand.font", "photo.brand.fontOwn"]) {
      expect(ar, k).toContain(`"${k}"`);
      expect(en, k).toContain(`"${k}"`);
    }
    // One control. No weight, no spacing, no second family for the Arabic half.
    expect(composer).not.toContain("brandWeight");
    expect(composer).not.toContain("brandFontArabic");
  });
});

describe("the mark and the credit cannot occupy the same band", () => {
  it("the mark claims a band, and it is measured from the mark", () => {
    const small = brandBand(preset({ brandSize: 0.02 }), { brand: true }, 1080, 1350);
    const big = brandBand(preset({ brandSize: 0.09 }), { brand: true }, 1080, 1350);
    expect(big).toBeGreaterThan(small);
    // Nothing is reserved "just in case": a small mark costs the card very little.
    expect(small).toBeLessThan(0.12);
  });

  it("no mark, no band — the card gets its whole foot back", () => {
    expect(brandBand(preset(), { brand: false }, 1080, 1350)).toBe(0);
  });

  it("a mark the reader placed themselves claims nothing", () => {
    // They positioned it against the composition they can see; reserving as well would overrule it.
    expect(brandBand(preset({ brandPos: { x: 0.4, y: 0.5 } }), { brand: true }, 1080, 1350)).toBe(0);
  });

  it("the credit stack lays out ABOVE the band", () => {
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    const laid = autoLayout({
      format: "portrait", w: CANVAS.w, h: CANVAS.h, reserveBottom: band,
      text: { quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ", title: "أليس في بلاد العجائب",
        chapter: "الفصل الأوّل", author: "لويس كارول" },
    });
    for (const el of laid.elements) {
      const bottom = el.placement.rect.y + el.placement.rect.h;
      expect(bottom, el.origin).toBeLessThanOrEqual(1 - band + 0.001);
    }
  });

  it("…and without a mark it uses that room instead of leaving a hole", () => {
    const of = (band: number) => autoLayout({
      format: "portrait", w: CANVAS.w, h: CANVAS.h, reserveBottom: band,
      text: { quote: "وَقَفَ الضَّوءُ", author: "لويس كارول" },
    }).elements.find((e) => e.origin === "author")!.placement.rect;
    const withMark = of(brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h));
    const without = of(0);
    expect(without.y).toBeGreaterThan(withMark.y);
  });

  it("every combination the report names lays out without a collision", () => {
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    // The mark's own rect, in the same fractions: it sits at the foot, inset by its baseline.
    const markH = band;
    const mark: Rect = { x: 0, y: 1 - markH, w: 1, h: markH };
    const CASES: Record<string, Record<string, string>> = {
      "logo + author": { author: "لويس كارول" },
      "logo + chapter": { chapter: "الفصل الأوّل: في الجُحر" },
      "logo + author + chapter": { author: "لويس كارول", chapter: "الفصل الأوّل" },
      "logo + attribution": { attribution: "أليس في بلاد العجائب — لويس كارول" },
      "a long author": { author: "عبد الرّحمن بن محمّد بن خلدون الحضرمي الإشبيلي" },
      "a long Arabic attribution": {
        attribution: "من الطبعة الأولى الصادرة عن دار النشر في القاهرة، بمراجعة لغويّة وتحقيق كامل",
      },
      "every line at once": {
        title: "أليس في بلاد العجائب", chapter: "الفصل الأوّل", author: "لويس كارول",
        attribution: "ترجمة: عبد الله",
      },
    };
    for (const [name, text] of Object.entries(CASES)) {
      const laid = autoLayout({
        format: "portrait", w: CANVAS.w, h: CANVAS.h, reserveBottom: band,
        text: { quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ، ثُمَّ مالَ على الوَرَقِ.", ...text },
      });
      for (const el of laid.elements) {
        expect(overlaps(el.placement.rect, mark), `${name} · ${el.origin} on the mark`).toBe(false);
      }
      // …and the credit lines do not sit on each other either.
      const rects = laid.elements.map((e) => ({ o: e.origin, r: e.placement.rect }));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(overlaps(rects[i].r, rects[j].r), `${name} · ${rects[i].o} on ${rects[j].o}`).toBe(false);
        }
      }
    }
  });

  it("a small card keeps the rule", () => {
    for (const format of ["square", "portrait", "story", "landscape"] as const) {
      const band = brandBand(preset(), { brand: true }, 1080, 1080);
      const laid = autoLayout({
        format, w: 1080, h: 1080, reserveBottom: band,
        text: { quote: "وَقَفَ الضَّوءُ", author: "لويس كارول", chapter: "الفصل الأوّل" },
      });
      for (const el of laid.elements) {
        expect(el.placement.rect.y + el.placement.rect.h, format).toBeLessThanOrEqual(1 - band + 0.001);
      }
    }
  });
});

describe("adding a credit line makes room for it", () => {
  const seed = () => seedComposition("calm", {
    quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ", title: "أليس في بلاد العجائب",
    chapter: "الفصل الأوّل", author: "لويس كارول",
  }, CANVAS, brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h));

  it("the newcomer does not land on the line below it", () => {
    // MEASURED IN THE EDITOR: switching «إسناد» on dropped the attribution through the author.
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    const before = seed();
    const after = addRoleLaidOut(before, "calm", "attribution", "ترجمة: عبد الله", CANVAS, {
      quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ", title: "أليس في بلاد العجائب",
      chapter: "الفصل الأوّل", author: "لويس كارول", attribution: "ترجمة: عبد الله",
    }, band);
    expect(after.length).toBe(before.length + 1);
    const laid = texts(after);
    for (let i = 0; i < laid.length; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        expect(overlaps(laid[i].placement.rect, laid[j].placement.rect),
          `${laid[i].origin} on ${laid[j].origin}`).toBe(false);
      }
    }
  });

  it("a line the reader has moved is left exactly where they put it", () => {
    // Ownership by comparison: an element that is no longer where the layout put it is theirs.
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    const before = seed().map((el) =>
      el.origin === "author"
        ? { ...el, placement: { ...el.placement, rect: { ...el.placement.rect, x: 0.42, y: 0.33 } } }
        : el);
    const after = addRoleLaidOut(before, "calm", "attribution", "ترجمة", CANVAS, {}, band);
    const author = texts(after).find((e) => e.origin === "author");
    expect(author).toBeTruthy();
    expect(author!.placement.rect.x).toBeCloseTo(0.42, 5);
    expect(author!.placement.rect.y).toBeCloseTo(0.33, 5);
  });

  it("…and an untouched line does move, or nothing could make room", () => {
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    const before = seed();
    const authorBefore = texts(before).find((e) => e.origin === "author")!;
    const after = addRoleLaidOut(before, "calm", "attribution", "ترجمة: عبد الله", CANVAS, {
      quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ", title: "أليس في بلاد العجائب",
      chapter: "الفصل الأوّل", author: "لويس كارول", attribution: "ترجمة: عبد الله",
    }, band);
    const authorAfter = texts(after).find((e) => e.id === authorBefore.id)!;
    expect(authorAfter.placement.rect.y).not.toBeCloseTo(authorBefore.placement.rect.y, 4);
  });

  it("a height that fits its slot survives the move; one that exceeds it does not", () => {
    // The layout owns WHERE a credit line sits and how much room it has; the text owns how tall it
    // actually is WITHIN that. A hugged line is smaller than its slot and comes through untouched.
    const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
    const settled = 0.03; // one line of credit type — comfortably inside the slot
    const before = seed().map((el) =>
      el.origin === "author" ? { ...el, placement: { ...el.placement, rect: { ...el.placement.rect, h: settled } } } : el);
    const after = addRoleLaidOut(before, "calm", "attribution", "ترجمة", CANVAS, {}, band);
    const author = texts(after).find((e) => e.origin === "author")!;
    expect(author.placement.rect.h).toBeCloseTo(settled, 6);

    // …and a box far taller than its slot is brought back to it, or a re-composed quote keeps the
    // height it had when it owned more of the card and lands on the credit below it.
    const swollen = seed().map((el) =>
      el.origin === "quote" ? { ...el, placement: { ...el.placement, rect: { ...el.placement.rect, h: 0.9 } } } : el);
    const laid = texts(addRoleLaidOut(swollen, "calm", "attribution", "ترجمة", CANVAS, {}, band));
    const quote = laid.find((e) => e.origin === "quote")!;
    expect(quote.placement.rect.h).toBeLessThan(0.9);
  });
});

describe("a role you switch on is a place you can see and type into", () => {
  const css = read("src/styles/global.css");
  const rule = (sel: string) => {
    const i = css.indexOf(sel + " {");
    if (i < 0) return "";
    const open = css.indexOf("{", i);
    return css.slice(open + 1, css.indexOf("}", open));
  };

  it("an empty text element is drawn — in the EDITOR, which is not what gets exported", () => {
    // THE FAULT. An element with no words paints no ink, so a role switched on for a book that has
    // no author left a box that was present, correctly placed, selectable — and invisible. Measured
    // in the editor: 425×27 at (608,766), `innerScroll` 0, nothing on the card.
    expect(overlay).toContain("pc-ov-ghost");
    expect(overlay).toMatch(/!el\.text\.trim\(\)/);
    // It lives in the overlay, which is a SIBLING of the card — see that file's own header. That
    // placement, not a filter, is what keeps it out of the artwork.
    expect(layers).not.toContain("pc-ov-ghost");
    expect(composer).not.toContain("pc-ov-ghost");
  });

  it("…and it says which role it is, in the words the rail uses", () => {
    expect(composer).toContain("const emptyLabel");
    // The SAME list the rail is built from, so the thing switched on and the thing that appears
    // cannot come to be named differently.
    const i = composer.indexOf("const emptyLabel");
    expect(composer.slice(i, i + 420)).toContain("LITERARY_ROLES.find");
  });

  it("the affordance is a chip, not the element's whole measure", () => {
    // A credit line's measure is the card's full text column. Drawing the affordance across it made
    // an empty role read as a wide empty bar — which is what a reader looking at it called too big.
    expect(rule(".pc-ov-ghost")).toContain("display: flex");
    const chip = rule(".pc-ov-ghost i");
    expect(chip).toContain("white-space: nowrap");
    expect(chip).toMatch(/padding:\s*\d/);
    expect(chip).not.toContain("inline-size: 100%");
  });

  it("…and the element's own box stands down while it is empty", () => {
    // Otherwise a second rectangle the width of the column is drawn around the chip.
    const quiet = rule(".pc-ov-el.empty, .pc-ov-el.empty.on, .pc-ov-el.empty:hover");
    expect(quiet).toContain("border-color: transparent");
    expect(quiet).toContain("background: transparent");
    expect(overlay).toMatch(/isText\(el\) && !el\.text\.trim\(\) \? " empty"/);
  });

  it("no resize handles until there are words to measure", () => {
    // An empty element has no measure worth dragging; the handles come back with the text.
    expect(overlay).toMatch(/!\(isText\(el\) && !el\.text\.trim\(\)\)/);
  });

  it("an empty element still paints nothing on the card itself", () => {
    // The lifecycle's other end: the reader may leave a role empty, and the artwork must not carry
    // a placeholder, a box or a rule where their words were going to be.
    expect(layers).not.toContain("placeholder");
    const i = layers.indexOf("function FitText");
    const body = layers.slice(i, layers.indexOf("export function ElementsLayer", i));
    expect(body).not.toMatch(/text \|\| ["'`]/);
  });
});

describe("an empty role still has somewhere to be", () => {
  const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
  const words = {
    quote: "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ", title: "أليس في بلاد العجائب",
    chapter: "الفصل الأوّل", author: "لويس كارول",
  };

  it("a credit slot is never smaller than an element may be", () => {
    // MEASURED: small credit type estimates shorter than `MIN_SIZE`, so two neighbouring EMPTY roles
    // were each floored to more than their slot and sat on top of each other.
    const laid = autoLayout({ format: "portrait", w: CANVAS.w, h: CANVAS.h, reserveBottom: band, text: words });
    for (const el of laid.elements) {
      if (el.origin === "quote") continue;
      expect(el.placement.rect.h, el.origin).toBeGreaterThanOrEqual(MIN_SIZE - 1e-9);
    }
  });

  it("a role that is ON the card but empty is laid out, not skipped", () => {
    // The pass arranges TEXT and skips an empty part — right for a part nobody asked for, wrong for
    // one the reader has switched on and not yet typed into. `present` is how the two are told
    // apart, and it has to be an input: from the text alone they are the same empty string.
    const bare = autoLayout({ format: "portrait", w: CANVAS.w, h: CANVAS.h,
      text: { quote: words.quote, author: "" } });
    expect(bare.elements.some((e) => e.origin === "author")).toBe(false);

    const asked = autoLayout({ format: "portrait", w: CANVAS.w, h: CANVAS.h,
      text: { quote: words.quote, author: "" }, present: ["author"] });
    const author = asked.elements.find((e) => e.origin === "author");
    expect(author, "an empty role that is on the card gets a line of the stack").toBeTruthy();
    expect(author!.placement.rect.h).toBeGreaterThanOrEqual(MIN_SIZE - 1e-9);
  });

  it("…and a part nobody asked for still takes no room", () => {
    // The contract this must not break: a book with no chapter does not get an empty chapter line
    // sitting on the card waiting to be noticed and deleted.
    const laid = autoLayout({ format: "portrait", w: CANVAS.w, h: CANVAS.h,
      text: { quote: words.quote, title: words.title, chapter: "  ", author: "" } });
    expect(laid.elements.map((e) => e.origin)).toEqual(["quote", "title"]);
  });

  it("…and the reader's own words come back, including none at all", () => {
    // The space is for the LAYOUT only; it must never become the element's content.
    const src = read("src/features/photo/compositions.ts");
    const i = src.indexOf("export function applyComposition");
    expect(src.slice(i)).toMatch(/text: had\.text/);
  });

  it("a newcomer sits where nobody is sitting", () => {
    // Once text has been edited, an element is no longer where any layout would put it, so it is
    // (correctly) left alone — and the seat the stack offers the newcomer was never vacated.
    // Measured: an empty «المؤلف» and an empty «إسناد» both at y=758.
    const seeded = seedComposition("calm", words, CANVAS, band);
    // Empty every role, the way clearing their text does.
    const emptied = seeded.map((el) => (el.origin && el.origin !== "quote" ? { ...el, text: "" } : el));
    const after = addRoleLaidOut(emptied, "calm", "attribution", "", CANVAS, {}, band);
    const laid = texts(after);
    for (let i = 0; i < laid.length; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        expect(overlaps(laid[i].placement.rect, laid[j].placement.rect),
          `${laid[i].origin} on ${laid[j].origin}`).toBe(false);
      }
    }
  });

  it("every combination of roles lands clear of the others and of the mark", () => {
    const mark: Rect = { x: 0, y: 1 - band, w: 1, h: band };
    const SETS: string[][] = [
      ["author"], ["chapter"], ["attribution"], ["title"],
      ["author", "chapter"],
      ["author", "chapter", "attribution"],
      ["title", "author", "chapter", "attribution"],
    ];
    for (const set of SETS) {
      let els: Composition["elements"] = seedComposition("calm", { quote: words.quote }, CANVAS, band);
      for (const part of set) {
        // Empty, which is the state a role arrives in when the book has nothing for it.
        els = addRoleLaidOut(els, "calm", part as never, "", CANVAS, {}, band);
      }
      const laid = texts(els);
      for (let i = 0; i < laid.length; i++) {
        expect(overlaps(laid[i].placement.rect, mark), `${set.join("+")} · ${laid[i].origin} on the mark`)
          .toBe(false);
        for (let j = i + 1; j < laid.length; j++) {
          expect(overlaps(laid[i].placement.rect, laid[j].placement.rect),
            `${set.join("+")} · ${laid[i].origin} on ${laid[j].origin}`).toBe(false);
        }
      }
    }
  });
});

describe("a quote sits in its room, not at the top of it", () => {
  const SHORT = "الضَّوءُ وَقَفَ.";
  const ONE_LINE = "وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ، ثُمَّ مالَ على الوَرَقِ.";
  const MEDIUM = "في المساءِ، حينَ يَهدَأُ البيتُ، تُفتَحُ الصَّفحةُ كما يُفتَحُ شُبّاكٌ على حديقةٍ؛ فتَمُرُّ الكلماتُ واحدةً واحدةً.";
  const LONG = "في المساءِ، حينَ يَهدَأُ البيتُ وتَخفُتُ أصواتُ الطَّريق، تُفتَحُ الصَّفحةُ كما يُفتَحُ شُبّاكٌ على حديقةٍ؛ فتَمُرُّ الكلماتُ واحدةً واحدةً، ولا يَبقى في الغُرفةِ شيءٌ سِوى صوتِ الوَرَقِ وهو يُقلَّب، حتّى يَنتهي الفصلُ ولا يَنتبهَ أحدٌ أنَّ اللَّيلَ قد جاء.";
  const MIXED = "قال Lewis Carroll إنَّ الوقتَ لا يُقاسُ بالساعاتِ — it is measured by what you notice.";
  const DIACRITICS = "وَقَفَ الضَّوْءُ عِنْدَ الشُّبَّاكِ، ثُمَّ مَالَ عَلَى الوَرَقِ الأَبْيَضِ.";

  const DIMS = { square: [1080, 1080], portrait: [1080, 1350], landscape: [1440, 1080] } as const;

  /** A card laid out from a book quote, with the credit the book gives it and the mark at the foot. */
  const card = (format: keyof typeof DIMS, quote: string, extra: Record<string, string> = {}) => {
    const [w, h] = DIMS[format];
    const band = brandBand(preset(), { brand: true }, w, h);
    const laid = autoLayout({ format, w, h, reserveBottom: band,
      text: { quote, author: "لويس كارول", chapter: "الفصل الأوّل", ...extra } });
    const q = laid.elements.find((e) => e.origin === "quote")!.placement.rect;
    const credit = laid.elements.filter((e) => e.origin !== "quote").map((e) => e.placement.rect);
    const creditTop = credit.length ? Math.min(...credit.map((r) => r.y)) : 1 - band;
    return {
      quote: q, credit, band, creditTop,
      /** Air over the passage, and air under it before the credit begins. */
      above: q.y,
      below: creditTop - (q.y + q.h),
      mark: { x: 0, y: 1 - band, w: 1, h: band } as Rect,
    };
  };

  it("there is at least as much air above the passage as below it", () => {
    // THE FAULT, AS ONE NUMBER. Pinned to the top of its room the quote had 0.090 of air above and
    // 0.156 below — the ratio the reader saw as "stuck at the top with a huge gap underneath".
    // Sharing the room's slack the way `bias` always claimed to puts it at 1.3–1.9 instead.
    for (const format of ["square", "portrait", "landscape"] as const) {
      for (const [name, q] of Object.entries({ SHORT, ONE_LINE, MEDIUM, LONG, MIXED, DIACRITICS })) {
        const c = card(format, q);
        expect(c.above, `${format} · ${name}`).toBeGreaterThan(c.below);
      }
    }
  });

  it("…and a short passage sits lower than one that fills the room", () => {
    // A passage that fills its room starts at the top of it, because there is no slack to share. A
    // short one has slack, and the slack is what it is given. If both started at the same place,
    // nothing was being shared — which is exactly what `quoteTop = roomTop` did to every card.
    const FILLING = LONG + " " + LONG;
    for (const format of ["square", "portrait", "landscape"] as const) {
      const short = card(format, SHORT).quote;
      const filling = card(format, FILLING).quote;
      expect(short.y, format).toBeGreaterThan(filling.y + 0.03);
    }
  });

  it("the passage never runs into the credit or the mark", () => {
    for (const format of ["square", "portrait", "landscape"] as const) {
      for (const [name, q] of Object.entries({ SHORT, ONE_LINE, MEDIUM, LONG, MIXED, DIACRITICS })) {
        const c = card(format, q);
        expect(overlaps(c.quote, c.mark), `${format} · ${name} · on the mark`).toBe(false);
        for (const r of c.credit) {
          expect(overlaps(c.quote, r), `${format} · ${name} · on the credit`).toBe(false);
        }
        expect(c.below, `${format} · ${name} · air before the credit`).toBeGreaterThan(0);
      }
    }
  });

  it("…including with every credit line and the mark present at once", () => {
    for (const format of ["square", "portrait", "landscape"] as const) {
      const c = card(format, MEDIUM, { title: "أليس في بلاد العجائب", attribution: "ترجمة: عبد الله" });
      expect(overlaps(c.quote, c.mark), format).toBe(false);
      for (const r of c.credit) expect(overlaps(c.quote, r), format).toBe(false);
      // …and the credit lines do not sit on each other either.
      for (let i = 0; i < c.credit.length; i++) {
        for (let j = i + 1; j < c.credit.length; j++) {
          expect(overlaps(c.credit[i], c.credit[j]), format).toBe(false);
        }
      }
    }
  });

  it("the whole passage stays on the card", () => {
    for (const format of ["square", "portrait", "landscape"] as const) {
      for (const q of [SHORT, LONG, MIXED]) {
        const c = card(format, q);
        expect(c.quote.y).toBeGreaterThanOrEqual(0);
        expect(c.quote.y + c.quote.h).toBeLessThanOrEqual(1);
      }
    }
  });

  it("the box follows the words around its CENTRE, so it cannot walk upward", () => {
    // A metadata line belongs to a stack built downward from a known edge and keeps its top. A
    // quote is the opposite: the composition chose a point for it to sit around. Anchoring by the
    // top is what collapsed the box onto the text and left the ink 0.112 of the card too high.
    const i = composer.indexOf("const fitToText");
    const body = composer.slice(i, composer.indexOf("}, []);", i));
    expect(body).toMatch(/el\.kind === "quote"/);
    // The centre it had is what the new box is built around — not its top edge.
    expect(body).toMatch(/const centre = rect\.y \+ rect\.h \/ 2/);
    expect(body).toMatch(/centre - h \/ 2/);
  });

  it("a quote keeps its height handles, because its box is a room", () => {
    // The measure-only rule is for text whose box follows its words. A quote's height is a real
    // thing to drag and stays where it is dragged to.
    expect(overlay).toMatch(/el\.kind !== "quote" && el\.style\.size != null/);
  });
});

describe("a new card carries the Sard mark", () => {
  const blank = () => newCustomComposition("ivory", "portrait", "كلماتٌ من عندي");

  it("«أنشئ بطاقة مصوّرة» makes a card that already has it", () => {
    expect(blank().preset.meta.brand).toBe(true);
  });

  it("…and still names no book, because there is no book behind it", () => {
    const m = blank().preset.meta;
    expect(m.title).toBe(false);
    expect(m.chapter).toBe(false);
    expect(m.author).toBe(false);
    expect(m.date).toBe(false);
    expect(m.time).toBe(false);
  });

  it("it is a CREATION default: a saved card that says off stays off", () => {
    // The proof that nothing re-applies it. A document is the reader's answer, and parsing one must
    // never improve on it.
    const off = parseComposition(JSON.stringify({
      v: 3, canvas: CANVAS, ground: { kind: "theme" }, elements: [],
      preset: { ...preset(), meta: { ...DEFAULT_META, brand: false } },
    })) as Composition | null;
    expect(off?.preset.meta.brand).toBe(false);

    // …and one that says on stays on.
    const on = parseComposition(JSON.stringify({
      v: 3, canvas: CANVAS, ground: { kind: "theme" }, elements: [],
      preset: { ...preset(), meta: { ...DEFAULT_META, brand: true } },
    })) as Composition | null;
    expect(on?.preset.meta.brand).toBe(true);
  });

  it("every new card gets it, not just the first", () => {
    // A default held in a module-level variable would answer this differently the second time.
    expect(blank().preset.meta.brand).toBe(true);
    expect(blank().preset.meta.brand).toBe(true);
  });

  it("the mark it carries is the existing one, with its band and its face", () => {
    // No second logo system: the same `meta.brand` the rail switches, the same `brandBand` the
    // layout reserves against, and `brandFont` still absent until the reader chooses one.
    const c = blank();
    expect(c.preset.brandFont).toBeUndefined();
    expect(brandBand(c.preset, c.preset.meta, c.canvas.w, c.canvas.h)).toBeGreaterThan(0);
  });
});

describe("an edited quote stays in its room", () => {
  // THE FAULT. The initial composition was always safe: the pass sizes the quote to the room it
  // has. EDITING is the other half — by then the size is the reader's, so the box gives way — and
  // nothing bounded it. Measured in the editor: a 13-line passage at the reader's 42px took a box
  // the size of the WHOLE CARD, 0.392 of the card past its room, over all four credit lines and the
  // mark. `quoteRegion` is the same answer the composing pass works out for itself, made available
  // to the editor so both obey one definition of "the room".
  const band = brandBand(preset(), { brand: true }, CANVAS.w, CANVAS.h);
  const quote: Rect = { x: 0.1, y: 0.15, w: 0.8, h: 0.4 };
  const credit: Rect[] = [
    { x: 0.1, y: 0.70, w: 0.8, h: 0.06 },
    { x: 0.1, y: 0.78, w: 0.8, h: 0.04 },
  ];

  it("the room stops above the credit", () => {
    const room = quoteRegion("portrait", quote, credit, band);
    expect(room.bottom).toBeLessThan(credit[0].y);
    expect(room.top).toBeGreaterThan(0);
  });

  it("…and above the mark's band when there is no credit", () => {
    const room = quoteRegion("portrait", quote, [], band);
    expect(room.bottom).toBeLessThanOrEqual(1 - band);
  });

  it("…and takes the whole foot back when there is neither", () => {
    const withNothing = quoteRegion("portrait", quote, [], 0);
    const withMark = quoteRegion("portrait", quote, [], band);
    expect(withNothing.bottom).toBeGreaterThan(withMark.bottom);
  });

  it("something ABOVE the quote raises the room's floor rather than lowering its ceiling", () => {
    const above: Rect = { x: 0.1, y: 0.02, w: 0.8, h: 0.06 };
    const room = quoteRegion("portrait", quote, [above], band);
    expect(room.top).toBeGreaterThanOrEqual(above.y + above.h);
    expect(room.bottom).toBeLessThanOrEqual(1 - band);
  });

  it("a room squeezed to nothing still hands back something usable", () => {
    // Better a small room the caller can reason about than a negative one it cannot.
    const crowded: Rect[] = [{ x: 0.1, y: 0.085, w: 0.8, h: 0.5 }];
    const room = quoteRegion("portrait", { x: 0.1, y: 0.05, w: 0.8, h: 0.02 }, crowded, band);
    expect(room.bottom - room.top).toBeGreaterThanOrEqual(MIN_SIZE - 1e-9);
  });

  it("every format keeps the quote clear of the credit and the mark", () => {
    for (const format of ["square", "portrait", "landscape"] as const) {
      const [w, h] = { square: [1080, 1080], portrait: [1080, 1350], landscape: [1440, 1080] }[format];
      const b = brandBand(preset(), { brand: true }, w, h);
      const room = quoteRegion(format, quote, credit, b);
      const clamped: Rect = { ...quote, y: room.top, h: room.bottom - room.top };
      for (const r of credit) expect(overlaps(clamped, r), format).toBe(false);
      expect(overlaps(clamped, { x: 0, y: 1 - b, w: 1, h: b }), format).toBe(false);
    }
  });

  it("the editor clamps to that room, and keeps the reader's size", () => {
    const i = composer.indexOf("const fitToText");
    const body = composer.slice(i, composer.indexOf("}, []);", i));
    expect(body).toContain("quoteRegion(");
    expect(body).toContain("brandBand(");
    // The height gives way; the SIZE is never touched here.
    expect(body).not.toMatch(/style:\s*\{[^}]*size/);
    expect(body).toMatch(/Math\.min\(want, roomH\)/);
  });

  it("…and bails on the FINAL geometry, or a clamped quote renders for ever", () => {
    // Measured: bailing on `want` — the height the words asked for — meant a passage asking for
    // more than its room was clamped to the same height on every measurement and written back as a
    // new array each time. The editor rendered until the card disappeared.
    const i = composer.indexOf("const fitToText");
    const body = composer.slice(i, composer.indexOf("}, []);", i));
    expect(body).toMatch(/Math\.abs\(h - rect\.h\)[\s\S]{0,60}Math\.abs\(y - rect\.y\)/);
  });

  it("when the room cannot hold it, Sard says so instead of spoiling the card", () => {
    // The size stays the reader's and the composition stays intact, so the only honest thing left
    // is to tell them what to do about it.
    for (const l of [ar, en]) expect(l).toContain('"photo.quote.tooLong"');
    expect(composer).toContain("photo.quote.tooLong");
    // …through the editor's existing notice, which clears itself.
    const i = composer.indexOf("photo.quote.tooLong");
    expect(composer.slice(i - 60, i + 40)).toContain("flash(");
  });
});

describe("the unsaved-changes question is a dialog", () => {
  it("it is asked on Sard's dialog layer, not inside the editor's box", () => {
    // MEASURED: as an absolutely positioned div inside `.pcx-modal`, its backdrop covered 1502x938
    // of a 1600x1000 window and the desk around it stayed live.
    expect(composer).toContain("createPortal(");
    expect(composer).toContain("pf-dialog-scrim");
    expect(composer).toContain("document.body");
    expect(composer).not.toContain('className="pcx-ask"');
    expect(composer).not.toContain("pcx-ask-card");
  });

  it("it uses the shared behaviour rather than a second implementation of it", () => {
    expect(composer).toContain("useDialog(");
    expect(composer).toContain("useScrimDismiss(");
  });

  it("Escape and a press outside both mean STAY", () => {
    const i = composer.indexOf("function AskBeforeLeaving");
    const body = composer.slice(i, i + 2000);
    expect(body).toContain("useDialog({ onDismiss: onStay })");
    expect(body).toContain("useScrimDismiss(onStay)");
  });

  it("it sits above the composer's own scrim", () => {
    const css = read("src/styles/global.css");
    const i = css.indexOf(".pcx-ask-scrim");
    const z = /z-index:\s*(\d+)/.exec(css.slice(i, i + 120));
    expect(z).not.toBeNull();
    // The composer's scrim is 90; the question must be over it.
    expect(Number(z![1])).toBeGreaterThan(90);
  });
});
