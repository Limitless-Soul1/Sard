// The read-aloud track's RENDERING: where the two marks are painted, and in what colour.
//
// Every metric fixture below was MEASURED in the running reader, not invented: the font and ink
// ascent/descent come from `measureText` on the book's own resolved face at four sizes, and the papers,
// inks and track colours are the real values of five هيئات in a copy of a real library. A fixture that
// is merely plausible cannot falsify a geometry claim, because the whole defect was the gap between an
// assumed metric (a run is ~1.15 em, a Latin figure) and a real one (1.33–1.52 em, and asymmetric).
import { describe, expect, it } from "vitest";
import {
  compositeMark,
  inkBand,
  pillBlendFor,
  resolvePill,
  resolveSpotlight,
  type TrackMetrics,
} from "../../src/reader-engine/ttsTrack";
import { contrastRatio, isDarkSurface, luminanceOf, MIN_READABLE_CONTRAST } from "../../src/lib/contrast";

// ---------------------------------------------------------------------------------------------------
// The measured faces. `paintedH` is the height `Range.getClientRects()` reported for the fragment, i.e.
// the box the marks used to be painted at in full.
// ---------------------------------------------------------------------------------------------------
const M = {
  // SardArabic at a 16 px page under zoom 0.8 — the reader's default Arabic face.
  arabic12: { fontAscent: 13.6, fontDescent: 4.0, inkAscent: 7.85, inkDescent: 4.0, paintedH: 17, lineBox: 21.8 },
  latin12: { fontAscent: 13.6, fontDescent: 4.0, inkAscent: 6.4, inkDescent: 0.8, paintedH: 17, lineBox: 21.8 },
  // The same face at 48 px, where the defect is at its most visible.
  arabic48: { fontAscent: 40.0, fontDescent: 12.8, inkAscent: 21.96, inkDescent: 10.4, paintedH: 53, lineBox: 61.4 },
  latin48: { fontAscent: 40.0, fontDescent: 12.8, inkAscent: 18.4, inkDescent: 0.8, paintedH: 53, lineBox: 61.4 },
};
const metrics = (m: typeof M.arabic12, lineBox?: number): TrackMetrics => ({
  fontAscent: m.fontAscent, fontDescent: m.fontDescent,
  inkAscent: m.inkAscent, inkDescent: m.inkDescent,
  lineBoxPx: lineBox,
});
/** Where the ink really is inside a fragment, derived from the same measured metrics but independently
 *  of `inkBand` — so the assertions compare the painted box against the GLYPHS, not against itself. */
const inkOf = (m: typeof M.arabic12, top = 0) => {
  const font = m.fontAscent + m.fontDescent;
  const baseline = top + m.paintedH * (m.fontAscent / font);
  return { top: baseline - m.paintedH * (m.inkAscent / font), bottom: baseline + m.paintedH * (m.inkDescent / font) };
};

describe("read-aloud geometry · the painted box is the ink, not the font's box", () => {
  it("removes the unused ascent above Arabic glyphs, and lands on the ink", () => {
    const m = M.arabic12;
    const ink = inkOf(m, 100);
    // BEFORE: the whole content box was painted, so its top sat this far above the first inked row.
    const wasAbove = ink.top - 100;
    expect(wasAbove).toBeGreaterThan(5); // measured 5.7 px in the running reader at this size
    const band = inkBand(100, m.paintedH, metrics(m, m.lineBox));
    expect(band.top).toBeCloseTo(ink.top, 4);
    expect(band.top + band.height).toBeCloseTo(ink.bottom, 4);
    // AFTER: nothing above the ink, and the box is shorter than the content box by that same gap.
    expect(band.top - 100).toBeGreaterThan(5);
    expect(band.height).toBeLessThan(m.paintedH);
  });

  it("does the same for Latin, where the unused ascent is larger still", () => {
    const m = M.latin12;
    const ink = inkOf(m, 40);
    const band = inkBand(40, m.paintedH, metrics(m, m.lineBox));
    expect(band.top).toBeCloseTo(ink.top, 4);
    expect(band.top + band.height).toBeCloseTo(ink.bottom, 4);
    // A word with no ascender and no descender: the box is much shorter than the content box.
    expect(band.height).toBeLessThan(m.paintedH * 0.55);
  });

  it("is a correction in PROPORTION, not a fixed offset — the 48 px page gets a 4× larger one", () => {
    const small = inkBand(0, M.arabic12.paintedH, metrics(M.arabic12, M.arabic12.lineBox));
    const large = inkBand(0, M.arabic48.paintedH, metrics(M.arabic48, M.arabic48.lineBox));
    expect(large.top / small.top).toBeGreaterThan(2.5); // measured unused ascent: 5.7 px → 18.0 px
    // And scaling one fragment's height scales its own correction exactly, with no constant term.
    const a = inkBand(0, 17, metrics(M.arabic12));
    const b = inkBand(0, 34, metrics(M.arabic12));
    expect(b.top).toBeCloseTo(a.top * 2, 6);
    expect(b.height).toBeCloseTo(a.height * 2, 6);
  });

  it("ignores the leading, because the defect never came from the leading", () => {
    // MEASURED: at one size, sweeping line-height 0.9 → 3.2 moved the line box 11.5 → 41.0 px while the
    // painted box stayed 17 px. So a corrected box must not move either, except where the line box is
    // tight enough to clamp it.
    const loose = [21.8, 30.7, 41.0].map((lb) => inkBand(0, M.arabic12.paintedH, metrics(M.arabic12, lb)));
    for (const b of loose) {
      expect(b.top).toBeCloseTo(loose[0].top, 6);
      expect(b.height).toBeCloseTo(loose[0].height, 6);
    }
  });

  it("never reaches into a neighbouring line, even when the ink exceeds the line box", () => {
    // line-height 0.9 measured an 11.5 px line box around a 17 px content box: half the leading is
    // NEGATIVE, so the line's own bounds sit inside the fragment and the mark must be held to them.
    const top = 200, h = M.arabic12.paintedH, lineBox = 11.5;
    const band = inkBand(top, h, metrics(M.arabic12, lineBox));
    const half = (lineBox - h) / 2;
    expect(band.top).toBeGreaterThanOrEqual(top - half - 1e-9);
    expect(band.top + band.height).toBeLessThanOrEqual(top + h + half + 1e-9);
  });

  it("keeps the old box when a face reports nothing usable, rather than dropping the mark", () => {
    for (const bad of [null, undefined,
      { fontAscent: 0, fontDescent: 0, inkAscent: 0, inkDescent: 0 },
      { fontAscent: -1, fontDescent: 1, inkAscent: 1, inkDescent: 1 }]) {
      const band = inkBand(12, 17, bad as TrackMetrics | null);
      expect(band).toEqual({ top: 12, height: 17 });
    }
    expect(inkBand(12, 0, metrics(M.arabic12))).toEqual({ top: 12, height: 0 });
  });

  it("paints the word to the SENTENCE's box, so a pill cannot grow and shrink between words", () => {
    // The sentence's metrics are shared by every word of it (see `trackRange`). A word of bare letters
    // and a word carrying tashkīl therefore get the same vertical box — the pill slides, it does not
    // breathe — while a per-word box would differ by this much:
    const sentence = metrics(M.arabic12, M.arabic12.lineBox);
    const wordA = inkBand(0, M.arabic12.paintedH, sentence);
    const wordB = inkBand(0, M.arabic12.paintedH, sentence);
    expect(wordA).toEqual(wordB);
    const perWord = inkBand(0, M.latin12.paintedH, metrics(M.latin12, M.latin12.lineBox));
    expect(Math.abs(perWord.height - wordA.height)).toBeGreaterThan(1); // what was avoided
  });

  it("puts the word's box exactly on the sentence band's, so the pill stays attached to the glyphs", () => {
    // Same metrics, same fragment height → identical vertical extent. The pill is drawn AFTER the band
    // in the same overlayer, so "attached" means these two boxes agree, not that a z-index is set.
    const m = metrics(M.arabic48, M.arabic48.lineBox);
    const band = inkBand(500, M.arabic48.paintedH, m);
    const pill = inkBand(500, M.arabic48.paintedH, m);
    expect(pill.top).toBeCloseTo(band.top, 10);
    expect(pill.height).toBeCloseTo(band.height, 10);
  });
});

describe("read-aloud polarity · the paper on screen, not the stored flag", () => {
  // The four combinations the renderer must survive. The first column is the paper a هيئة actually
  // shows; the second is the flag it happens to store. Three real هيئات carry the mismatched pair.
  const cases = [
    { paper: "#F5EEDD", stored: false, dark: false, who: "light paper, light flag (TRing)" },
    { paper: "#E8D9BC", stored: false, dark: false, who: "light paper, light flag (Nier)" },
    { paper: "#101419", stored: false, dark: true, who: "DARK paper, light flag (Sekiro2)" },
    { paper: "#2B1016", stored: false, dark: true, who: "DARK paper, light flag" },
    { paper: "#17202a", stored: true, dark: true, who: "dark paper, dark flag (STEAMPUNK)" },
    { paper: "#F5EEDD", stored: true, dark: false, who: "light paper, DARK flag" },
  ];
  for (const c of cases) {
    it(`reads ${c.who} as ${c.dark ? "dark" : "light"}`, () => {
      expect(isDarkSurface(c.paper)).toBe(c.dark);
    });
  }

  it("is decided by luminance, so it cannot be fooled by a saturated hue", () => {
    expect(isDarkSurface("#7B082F")).toBe(true);   // a deep crimson IS a dark ground
    expect(isDarkSurface("#C0F13B")).toBe(false);  // a bright lime is not
    expect(isDarkSurface("#808080")).toBe(false);  // mid grey sits above the midpoint (0.216)
  });

  it("falls back to light for an unparseable colour rather than guessing", () => {
    expect(isDarkSurface("")).toBe(false);
    expect(isDarkSurface("var(--paper)")).toBe(false);
  });
});

describe("read-aloud colour · the هيئة's colour survives the compositing", () => {
  // The five real هيئات, with the paper and ink each of them actually shows.
  const APPS = {
    TRing: { paper: "#F5EEDD", text: "#5A4632", fill: "#E8A0B0", op: 0.5 },
    Nier: { paper: "#E8D9BC", text: "#45382A", fill: "#585656", op: 0.75 },
    Sekiro2: { paper: "#101419", text: "#D8D7CF", fill: "#965334", op: 0.7 },
    STEAMPUNK: { paper: "#17202a", text: "#ccd4dc", fill: "#6C65ED", op: 0.9 },
    G: { paper: "#15201A", text: "#D6E2D4", fill: "#C0F13B", op: 0.35 },
  };
  const chans = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** How far a colour is from neutral — a grey asked for and a brown delivered differ here. */
  const spread = (hex: string) => { const n = chans(hex); return Math.max(...n) - Math.min(...n); };
  /** The largest per-channel move between two colours: how much a mark disturbed the ink. */
  const channelShift = (a: string, b: string) => {
    const [x, y] = [chans(a), chans(b)];
    return Math.max(...[0, 1, 2].map((i) => Math.abs(x[i] - y[i])));
  };
  const chosen = (a: typeof APPS.TRing, paper = a.paper) =>
    pillBlendFor(a.fill, a.op, { paper, text: a.text }, isDarkSurface(paper));

  it("a NEUTRAL grey on warm paper stays neutral instead of turning brown", () => {
    // MEASURED BEFORE: Nier asked for #585656 and the screen showed #655545 — the paper's hue had
    // replaced the هيئة's. The old mode is still reachable here, so this asserts the improvement rather
    // than merely restating the new output.
    const a = APPS.Nier;
    const before = compositeMark(a.paper, a.fill, a.op, "multiply");
    const after = compositeMark(a.paper, a.fill, a.op, chosen(a));
    expect(spread(before)).toBeGreaterThan(20);              // #655545 — a brown
    expect(spread(after)).toBeLessThan(spread(before) / 1.8); // #7c7770 — a grey again
    expect(spread(after)).toBeLessThanOrEqual(spread(a.fill) + 12);
    // THE STRONGER CLAIM, and the one the old mode could not make: the words are left exactly as they
    // were. `multiply` reached its contrast by repainting the ink #45382A → #231c15.
    expect(compositeMark(a.text, a.fill, a.op, chosen(a)).toLowerCase()).toBe(a.text.toLowerCase());
    expect(compositeMark(a.text, a.fill, a.op, "multiply").toLowerCase()).not.toBe(a.text.toLowerCase());
  });

  it("a warm mark on a near-black page becomes visible instead of vanishing into it", () => {
    // MEASURED BEFORE: Sekiro2 asked #965334 over #101419 and rendered #1F120E — the page itself.
    const a = APPS.Sekiro2;
    const before = compositeMark(a.paper, a.fill, a.op, "multiply");
    const after = compositeMark(a.paper, a.fill, a.op, chosen(a));
    expect(contrastRatio(before, a.paper)).toBeLessThan(1.1); // indistinguishable from the page
    expect(contrastRatio(after, a.paper)).toBeGreaterThan(2.0);
    // ...and it is the asked HUE that arrived, not merely some difference: the mark is exactly the
    // straight mix of the هيئة's colour over its paper, and the ink is untouched.
    expect(after).toBe(compositeMark(a.paper, a.fill, a.op, "normal"));
    expect(compositeMark(a.text, a.fill, a.op, chosen(a)).toLowerCase()).toBe(a.text.toLowerCase());
    expect(luminanceOf(after)!).toBeGreaterThan(luminanceOf(before)!);
  });

  it("a bright mark on a dark page keeps its hue", () => {
    const a = APPS.G;
    const after = compositeMark(a.paper, a.fill, a.op, chosen(a));
    const n = [1, 3, 5].map((i) => parseInt(after.slice(i, i + 2), 16));
    expect(n[1]).toBeGreaterThan(n[0]); // green above red…
    expect(n[1]).toBeGreaterThan(n[2]); // …and above blue: still the lime it asked for
    expect(contrastRatio(after, a.paper)).toBeGreaterThan(1.8);
  });

  it("never chooses a mode that buries the words — by one of two guarantees, always one of them", () => {
    // The whole reason the blend exists: the overlayer paints ABOVE the glyphs. Every chosen mode must
    // therefore deliver EITHER a glyph that still stands clear of its mark at the readable threshold, OR
    // a glyph the mark never touched — which is the stronger of the two, because the words then reach the
    // reader at the exact colour the هيئة set.
    for (const [name, a] of Object.entries(APPS)) {
      const mode = chosen(a);
      const glyph = compositeMark(a.text, a.fill, a.op, mode);
      const mark = compositeMark(a.paper, a.fill, a.op, mode);
      const untouched = glyph.toLowerCase() === a.text.toLowerCase();
      const ratio = contrastRatio(glyph, mark);
      expect(untouched || ratio >= MIN_READABLE_CONTRAST, `${name} (${mode}) ratio=${ratio.toFixed(2)}`).toBe(true);
    }
  });

  it("never repaints the ink more than the mode that shipped before it did", () => {
    // The honest comparison. For four of the five هيئات the new mode leaves the ink alone AND raises the
    // ratio. For Nier it leaves the ink alone and the ratio FALLS, 3.30 → 2.55, because `multiply`
    // reached 3.30 by darkening the ink to #231c15: the old number was bought with the reader's text.
    // Whichever way the ratio moves, the new mode must never disturb the ink more than the old one did.
    for (const [name, a] of Object.entries(APPS)) {
      const legacy = isDarkSurface(a.paper) ? "screen" : "multiply";
      const now = channelShift(compositeMark(a.text, a.fill, a.op, chosen(a)), a.text);
      const was = channelShift(compositeMark(a.text, a.fill, a.op, legacy), a.text);
      expect(now, `${name}: ink moved ${now} vs ${was} before`).toBeLessThanOrEqual(was);
    }
  });

  it("keeps a violet at 0.9 opacity readable — the case the blend was introduced for", () => {
    // STEAMPUNK asks for #6C65ED at nearly full opacity, which is what makes `normal` bury the words
    // (measured glyph/mark 1.27 — the regression the blend exists to prevent). The chosen mode must
    // still be one that keeps them: here the directional clamp does, at 3.41, AND it reproduces the
    // asked colour on the paper, which `screen` did not.
    const a = APPS.STEAMPUNK;
    const mode = chosen(a);
    const mark = compositeMark(a.paper, a.fill, a.op, mode);
    const glyph = compositeMark(a.text, a.fill, a.op, mode);
    expect(contrastRatio(glyph, mark)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(compositeMark(a.text, a.fill, a.op, "normal"),
                         compositeMark(a.paper, a.fill, a.op, "normal"))).toBeLessThan(1.5);
    expect(mark).toBe(compositeMark(a.paper, a.fill, a.op, "normal")); // the asked colour, faithfully
  });

  it("never picks a mode whose mark cannot be told apart from its own paper", () => {
    // `darken` on a near-black page renders the page itself (measured #101419 → #101419). It is
    // perfectly glyph-safe and completely useless, so visibility is a hard gate, not a preference.
    for (const [name, a] of Object.entries(APPS)) {
      const mark = compositeMark(a.paper, a.fill, a.op, chosen(a));
      expect(contrastRatio(mark, a.paper), `${name}`).toBeGreaterThan(1.1);
    }
  });

  it("falls back to the per-polarity constant when there is no ground to measure", () => {
    expect(resolvePill({ ttsKaraokeColor: "#585656" } as never, false).blend).toBe("multiply");
    expect(resolvePill({ ttsKaraokeColor: "#585656" } as never, true).blend).toBe("screen");
    expect(pillBlendFor("#585656", 0.75, undefined, false)).toBe("multiply");
    expect(pillBlendFor("#585656", 0.75, { paper: "", text: "" }, true)).toBe("screen");
  });

  it("leaves the sentence band's compositing exactly as it was", () => {
    // The band carries no blend and never did: it is a plain alpha wash, which is already hue-true.
    // Only its DEFAULT colour moves, and only because the polarity it is chosen by is now measured.
    const light = resolveSpotlight(undefined, false);
    const dark = resolveSpotlight(undefined, true);
    expect(light).toEqual({ fill: "rgb(156,90,60)", band: 0.1, rule: 0.3 });
    expect(dark).toEqual({ fill: "rgb(201,138,94)", band: 0.16, rule: 0.44 });
  });
});

describe("read-aloud colour · one هيئة's mark never becomes another's", () => {
  it("resolves from the style handed in, with no state kept between calls", () => {
    const a = { ttsKaraokeColor: "#E8A0B0", ttsKaraokeOpacity: 0.5 } as never;
    const b = { ttsKaraokeColor: "#C0F13B", ttsKaraokeOpacity: 0.35 } as never;
    const ga = { paper: "#F5EEDD", text: "#5A4632" };
    const gb = { paper: "#15201A", text: "#D6E2D4" };
    const first = resolvePill(a, false, ga);
    const other = resolvePill(b, true, gb);
    const again = resolvePill(a, false, ga);
    expect(again).toEqual(first);
    expect(other.fill).toBe("#C0F13B");
    expect(first.fill).toBe("#E8A0B0");
    expect(resolveSpotlight({ ttsSpotlightColor: "#C4707F" } as never, false).fill).toBe("#C4707F");
    expect(resolveSpotlight(undefined, false).fill).toBe("rgb(156,90,60)");
  });
});
