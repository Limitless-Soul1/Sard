// THE ONE DECISION THE MEASURE MAKES, AND THE ONE IT MUST NEVER MAKE.
//
// `renderTypography` is consumed by the reading surface AND by the profile editor's specimen, so a
// change here moves both — which is the point. What it must never do is hand tracking to RTL text:
// Arabic letters join, and letter-spacing does not open such a line, it severs it into disconnected
// shapes. The reader has always withheld it; this pins that behaviour now that a second surface
// depends on the same function.
import { describe, expect, it } from "vitest";

import { ARABIC_DEFAULTS, renderTypography } from "../../src/reader-engine/injectedCss";

const style = (over: Partial<typeof ARABIC_DEFAULTS> = {}) => ({ ...ARABIC_DEFAULTS, ...over });

describe("tracking is withheld from Arabic, and only from Arabic", () => {
  it("an RTL surface never receives tracking, at any requested value", () => {
    for (const px of [0.25, 1, 2, 3]) {
      const r = renderTypography(style({ letterSpacing: px }), { rtl: true });
      expect(r.letterSpacingPx, `${px}px`).toBe(0);
      expect(r.trackingWithheld, `${px}px`).toBe(true);
    }
  });

  it("an LTR surface receives exactly what was asked for", () => {
    for (const px of [0.25, 1, 2, 3]) {
      const r = renderTypography(style({ letterSpacing: px }), { rtl: false });
      expect(r.letterSpacingPx, `${px}px`).toBe(px);
      expect(r.trackingWithheld, `${px}px`).toBe(false);
    }
  });

  // "Withheld" must mean the SETTING was refused, not that it happened to be zero — the note in the
  // editor is shown on that flag, and showing it at zero would explain a limit nobody hit.
  it("zero tracking on Arabic is not reported as withheld", () => {
    const r = renderTypography(style({ letterSpacing: 0 }), { rtl: true });
    expect(r.letterSpacingPx).toBe(0);
    expect(r.trackingWithheld).toBe(false);
  });
});

describe("every other property passes through to both surfaces unchanged", () => {
  it("carries the values it is given", () => {
    const r = renderTypography(
      style({ zoom: 1.4, fontWeight: 700, lineHeight: 2.1, paragraphSpacing: 24, align: "center" }),
      { rtl: true },
    );
    expect(r.zoom).toBe(1.4);
    expect(r.fontWeight).toBe(700);
    expect(r.lineHeight).toBe(2.1);
    expect(r.paragraphSpacingPx).toBe(24);
    expect(r.textAlign).toBe("center");
  });

  // The indent is a boolean at the model and a length at the surface; the reader's own value is
  // 1.5em, and a preview that chose its own would drift the moment either changed.
  it("the first-line indent is the reader's own length, or an explicit zero", () => {
    expect(renderTypography(style({ firstLineIndent: true }), { rtl: true }).textIndent).toBe("1.5em");
    expect(renderTypography(style({ firstLineIndent: false }), { rtl: true }).textIndent).toBe("0");
  });

  // Direction must change tracking and NOTHING else — a preview showing two scripts renders the same
  // style twice, and any other divergence would be a difference the reader never asked for.
  it("direction changes tracking alone", () => {
    const s = style({ letterSpacing: 2, zoom: 1.3, lineHeight: 2.2, paragraphSpacing: 8, align: "end" });
    const { letterSpacingPx: _a, trackingWithheld: _b, ...rtl } = renderTypography(s, { rtl: true });
    const { letterSpacingPx: _c, trackingWithheld: _d, ...ltr } = renderTypography(s, { rtl: false });
    expect(rtl).toEqual(ltr);
  });
});
