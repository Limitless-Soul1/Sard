// THE TEXT READABILITY TOOLKIT — the rules, without a DOM.
//
// What this pins is the part that has to be right for the feature to be worth having: each treatment
// is a different KIND of thing rather than the same wash three times, every control makes a real
// difference, a colour the reader picks is honoured, and the whole thing round-trips through a saved
// document so a card reopens as it was left.
//
// It also pins what the treatment must NOT do: reach for a `filter`, a `backdrop-filter` or any other
// property that a `foreignObject` rasterisation drops. The card is exported by rasterising the very
// same DOM (`html-to-image`), so a property the editor honours and the export does not would make the
// PNG disagree with what the reader was looking at — which is worse than having no feature.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEGIBILITY_STRENGTH,
  LEGIBILITY_MODES,
  backingColor,
  backingStyle,
  isLegibility,
  isLegibilityShape,
  type Legibility,
} from "../../src/features/photo/legibility";
import {
  parseComposition,
  serializeComposition,
  type Composition,
  type TextStyle,
} from "../../src/features/photo/composition";

const PALE = "#F5EEDD";
const INK = "#2B2521";

/** The common case: dark ink on pale paper, with whatever the test is actually varying on top. */
const on = (mode: Legibility, extra: Record<string, unknown> = {}) =>
  backingStyle({ mode, textColor: INK, paper: PALE, strength: 0.6, ...extra });

describe("the derived colour is made of the card's own material", () => {
  it("backs dark ink with the card's pale paper rather than an invented grey", () => {
    expect(backingColor(INK, PALE)).toBe(PALE);
  });

  it("backs pale text with black, because the paper would not separate it", () => {
    expect(backingColor("#F7F4EE", "#FBF9F4")).toBe("#000000");
  });

  it("backs near-black text with white when the card's paper is also near-black", () => {
    expect(backingColor("#12100E", "#0B0A09")).toBe("#ffffff");
  });

  it("answers for an rgb() colour as well as a hex, since theme values arrive both ways", () => {
    expect(backingColor("rgb(20, 18, 16)", PALE)).toBe(PALE);
  });
});

describe("every treatment is nothing at zero, and its own kind of thing above it", () => {
  for (const mode of LEGIBILITY_MODES) {
    it(`${mode} draws nothing at strength 0`, () => {
      expect(on(mode, { strength: 0 })).toEqual({});
    });
  }

  it("none draws nothing at any strength", () => {
    expect(on("none", { strength: 1 })).toEqual({});
  });

  it("halo is light on the glyphs and nothing behind them — the picture stays whole", () => {
    // NOTHING BEHIND THEM, stated against every property that could put something there. This once
    // named `padding`, which the treatments stopped being able to return when the air around the
    // words became a painted spread — so the claim was being made against a property that no longer
    // exists, which is a claim about nothing. A halo is `textShadow` and only `textShadow`.
    const s = on("halo");
    expect(s.textShadow).toBeTruthy();
    expect(s.background).toBeUndefined();
    expect(s.boxShadow).toBeUndefined();
    expect(s.borderRadius).toBeUndefined();
    expect(s.inner).toBeUndefined();
  });

  it("the veil has no edge at all — no radius, no fitted width, nothing to read as a panel", () => {
    const s = on("veil");
    expect(s.background).toContain("radial-gradient");
    expect(s.background).toContain("rgba(245, 238, 221, 0)"); // it reaches full transparency
    expect(s.borderRadius).toBeUndefined();
    expect(s.inlineSize).toBeUndefined();
  });

  it("the plate DOES have an edge — that is what separates it from the veil", () => {
    const s = on("plate");
    expect(s.background).toBeTruthy();
    expect(s.borderRadius).toBeTruthy();
    expect(s.inlineSize).toBe("fit-content");
    expect(s.maxInlineSize).toBe("100%");
  });

  it("centres the plate under centred words and leaves it at the start otherwise", () => {
    expect(on("plate", { align: "center" }).marginInline).toBe("auto");
    expect(on("plate", { align: "start" }).marginInline).toBeUndefined();
    expect(on("plate", { align: "justify" }).marginInline).toBeUndefined();
  });

  it("grows with strength rather than switching on at a threshold", () => {
    const alpha = (s: string) => Number((s.match(/rgba\([^)]*?,\s*([\d.]+)\)/) ?? [])[1] ?? 0);
    expect(alpha(on("halo", { strength: 0.9 }).textShadow ?? "")).toBeGreaterThan(
      alpha(on("halo", { strength: 0.2 }).textShadow ?? ""));
  });

  it("clamps a strength outside 0..1 instead of producing nonsense", () => {
    expect(on("halo", { strength: 5 })).toEqual(on("halo", { strength: 1 }));
    expect(on("halo", { strength: -3 })).toEqual({});
  });
});

describe("the controls each make a real difference", () => {
  it("softness changes how far a halo's light carries", () => {
    const widest = (s: string) => Math.max(...[...s.matchAll(/([\d.]+)em/g)].map((m) => Number(m[1])));
    expect(widest(on("halo", { softness: 1 }).textShadow ?? "")).toBeGreaterThan(
      widest(on("halo", { softness: 0 }).textShadow ?? ""));
  });

  it("a soft halo adds a third, fainter bloom that a close one does not", () => {
    const rings = (s: string) => (s.match(/rgba\(/g) ?? []).length;
    expect(rings(on("halo", { softness: 1 }).textShadow ?? "")).toBeGreaterThan(
      rings(on("halo", { softness: 0 }).textShadow ?? ""));
  });

  it("softness changes where a veil begins to dissolve", () => {
    expect(on("veil", { softness: 0 }).background).not.toBe(on("veil", { softness: 1 }).background);
  });

  it("softness changes a plate's radius and the air around the words", () => {
    const firm = on("plate", { softness: 0 });
    const soft = on("plate", { softness: 1 });
    expect(firm.borderRadius).not.toBe(soft.borderRadius);
    // The air is the shadow's spread, not padding — see "a treatment is PAINTED, never laid out".
    expect(firm.boxShadow).not.toBe(soft.boxShadow);
  });

  it("a chosen colour is used instead of the derived one, in every treatment", () => {
    expect(on("plate", { color: "#3A2A18" }).background).toContain("58, 42, 24");
    expect(on("halo", { color: "#3A2A18" }).textShadow).toContain("58, 42, 24");
    expect(on("veil", { color: "#3A2A18" }).background).toContain("58, 42, 24");
  });

  it("clearing the colour returns to the derived answer", () => {
    expect(on("plate", { color: null })).toEqual(on("plate"));
    expect(on("plate", { color: "" })).toEqual(on("plate"));
  });

  it("a per-line plate is an INLINE treatment, because a block has only one box", () => {
    const s = on("plate", { shape: "lines" });
    expect(s.inner?.display).toBe("inline");
    expect(s.inner?.boxDecorationBreak).toBe("clone");
    expect(s.inner?.WebkitBoxDecorationBreak).toBe("clone");
    // and it must NOT also paint the block, or every line would sit on a slab as well
    expect(s.background).toBeUndefined();
  });

  it("a block plate paints the block and asks for no inline span", () => {
    const s = on("plate", { shape: "block" });
    expect(s.inner).toBeUndefined();
    expect(s.background).toBeTruthy();
  });

  it("shape is a plate idea only — a veil and a halo ignore it", () => {
    expect(on("veil", { shape: "lines" }).inner).toBeUndefined();
    expect(on("halo", { shape: "lines" }).inner).toBeUndefined();
  });

  it("knows which shape names it can honour", () => {
    expect(isLegibilityShape("lines")).toBe(true);
    expect(isLegibilityShape("ribbon")).toBe(false);
  });
});

describe("a treatment is PAINTED, never laid out", () => {
  // THE DEFECT THIS PINS. The air around the words was `padding`, which is part of the box — so with
  // `box-sizing: border-box` it came out of the CONTENT width. Moving the SOFTNESS control therefore
  // narrowed the text: a word near a wrapping boundary dropped to the next line, and because the
  // auto-fit measures the element's own scroll size the fitted font size moved with it. A visual
  // control was re-typesetting the card.
  //
  // Nothing a treatment returns may take part in layout. `background`, `border-radius`, `box-shadow`
  // and `text-shadow` are all painted outside the layout algorithm; `padding`, `border`, `margin`,
  // `font-*`, `line-height`, `letter-spacing`, `width` and `height` are not.
  const LAYOUT_PROPS = [
    "padding", "paddingTop", "paddingLeft", "paddingInline", "paddingBlock",
    "border", "borderWidth", "margin", "marginTop", "marginBlock",
    "font", "fontSize", "fontFamily", "lineHeight", "letterSpacing", "wordSpacing",
    "width", "height", "blockSize", "boxSizing", "transform", "zoom", "textIndent",
  ];

  for (const mode of LEGIBILITY_MODES) {
    it(`${mode} sets no property that can move a line`, () => {
      for (const softness of [0, 0.25, 0.5, 0.75, 1]) {
        const st = on(mode, { softness, strength: 0.8, shape: "lines" }) as Record<string, unknown>;
        for (const prop of LAYOUT_PROPS) {
          expect(st[prop], `${mode} at softness ${softness} set ${prop}`).toBeUndefined();
        }
        const inner = (st.inner ?? {}) as Record<string, unknown>;
        for (const prop of LAYOUT_PROPS) {
          expect(inner[prop], `${mode} (per-line) at softness ${softness} set ${prop}`).toBeUndefined();
        }
      }
    });
  }

  it("moving softness across its whole range leaves the box untouched", () => {
    // The three that CAN size a box are the plate's fitted width and its two companions, and none of
    // them may depend on softness — only on the shape, which is a separate control.
    const box = (softness: number) => {
      const st = on("plate", { softness }) as Record<string, unknown>;
      return { inlineSize: st.inlineSize, maxInlineSize: st.maxInlineSize, marginInline: st.marginInline };
    };
    const first = box(0);
    for (const softness of [0.2, 0.4, 0.6, 0.8, 1]) expect(box(softness)).toEqual(first);
  });

  it("but softness still changes what is PAINTED, or it would be a dead control", () => {
    const painted = (mode: Legibility, softness: number) => {
      const st = on(mode, { softness }) as Record<string, unknown>;
      return JSON.stringify([st.textShadow, st.background, st.borderRadius, st.boxShadow, st.inner]);
    };
    for (const mode of ["halo", "veil", "plate"] as const) {
      expect(painted(mode, 0), mode).not.toBe(painted(mode, 1));
    }
  });

  it("the air around a plate is a shadow spread, not padding", () => {
    const s = on("plate", { softness: 1 });
    expect(s.boxShadow).toBeTruthy();
    // a spread term (the fourth length) is what carries the plate out past the words
    expect(s.boxShadow).toMatch(/em\s+[\d.]+em\s+rgba/);
  });

  it("a per-line plate spreads too, because inline padding moves line breaks", () => {
    const s = on("plate", { shape: "lines", softness: 1 });
    expect(s.inner?.boxShadow).toBeTruthy();
  });
});

describe("it renders the same in the editor and in the exported PNG", () => {
  const FORBIDDEN = /(^|[^-])filter|backdrop|mix-blend|clip-path/i;
  for (const mode of LEGIBILITY_MODES) {
    it(`${mode} uses only properties a rasterised card keeps`, () => {
      const css = JSON.stringify(on(mode, { strength: 1, align: "center", shape: "lines" }));
      expect(css).not.toMatch(FORBIDDEN);
    });
  }
});

describe("the choice survives being saved and reopened", () => {
  const docWith = (style: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      canvas: { w: 1080, h: 1350, dir: "rtl" },
      ground: { kind: "theme", themeId: "ivory" },
      preset: "minimal",
      elements: [{ id: "e1", kind: "quote", text: "كلمات", placement: { rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 } }, style }],
    });
  /** The document, parsed. A fixture that does not parse is a broken fixture, not a result. */
  const parsed = (json: string): Composition => {
    const comp = parseComposition(json);
    if (!comp) throw new Error("the fixture document did not parse");
    return comp;
  };
  /**
   * The first element's style, as the text style it actually is.
   *
   * Narrowed rather than cast: only a text element carries a `style`, so `in` is what proves this
   * one is a text element, and a fixture that stopped producing one says so instead of failing
   * somewhere later. Typing the answer `TextStyle` rather than a bag of unknowns is the point of
   * doing it this way — a control misspelled in an assertion below now fails to compile, where
   * before it would have read `undefined` and passed.
   */
  const styleOf = (json: string): TextStyle => {
    const el = parsed(json).elements[0];
    if (!("style" in el)) throw new Error(`expected a text element, found ${el.kind}`);
    return el.style;
  };

  it("round-trips every control", () => {
    const src = docWith({
      legibility: "plate", legibilityStrength: 0.7, legibilitySoftness: 0.25,
      legibilityColor: "#3A2A18", legibilityShape: "lines",
    });
    const first = styleOf(src);
    expect(first.legibility).toBe("plate");
    expect(first.legibilityStrength).toBeCloseTo(0.7);
    expect(first.legibilitySoftness).toBeCloseTo(0.25);
    expect(first.legibilityColor).toBe("#3A2A18");
    expect(first.legibilityShape).toBe("lines");
    const again = styleOf(serializeComposition(parsed(src)));
    expect(again).toEqual(first);
  });

  it("leaves a card saved before the feature exactly as it was", () => {
    const st = styleOf(docWith({ align: "center" }));
    expect(st.legibility).toBeUndefined();
    expect(on(st.legibility ?? "none", { strength: DEFAULT_LEGIBILITY_STRENGTH })).toEqual({});
  });

  it("refuses a treatment or shape name it does not know", () => {
    const st = styleOf(docWith({ legibility: "hologram", legibilityShape: "ribbon" }));
    expect(st.legibility).toBeUndefined();
    expect(st.legibilityShape).toBeUndefined();
    expect(isLegibility("hologram")).toBe(false);
  });

  it("clamps strength and softness that arrive out of range in a document", () => {
    const st = styleOf(docWith({ legibility: "veil", legibilityStrength: 9, legibilitySoftness: -4 }));
    expect(st.legibilityStrength).toBe(1);
    expect(st.legibilitySoftness).toBe(0);
  });
});
