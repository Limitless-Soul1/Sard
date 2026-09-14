// Vista's furniture — the ten tokens, for all sixteen papers.
//
// SOURCE: a private design reference, the designer's returned specification of
// 2026-08-21. Every value below is theirs, transcribed mechanically from the rendered table rather
// than retyped, and checked back against it.
//
// WHY VISTA NEEDS ITS OWN TOKENS AT ALL. The rest of the library sets `--text` directly on the
// composited photograph, which is why `LIB_SCRIM_MIN` is 0.77 — a measured WCAG floor over an
// arbitrary image. Vista does not: no glyph in it ever touches the bare photograph, because every
// name, count and sentence sits on a piece of furniture with its own fill. That exemption was not
// taken on the design's word — it was measured, over an unbounded bed (any pixel from black to
// white beneath any furniture), and `--v-ink` clears 7.00:1 on all sixteen papers with no scrim.
//
// THE ONE RULE THAT TRAVELS WITH THE SET: `--v-recess-soft` is TEXT-FREE. It exists to fade an
// aperture into the photograph, and it is far too weak to read on — measured worst 1.03:1
// (Mulberry), below 2.10:1 on fifteen of the sixteen. No glyph may be painted on it.

import type { Theme } from "./tokens";

export interface VistaTokens {
  ink: string;
  mute: string;
  accent: string;
  edge: string;
  recess: string;
  recessSoft: string;
  chrome: string;
  lit: string;
  sill: string;
  scrim: string;
}

/**
 * The authored set. Nine dark papers, then seven light.
 *
 * Several of these are judgement rather than arithmetic — `--v-accent` throughout, `--v-edge`'s
 * colour, and the three dark papers whose `--v-lit` is white rather than their own ink — so the
 * table is authoritative and is never recomputed for a paper that appears in it.
 */
export const VISTA_TOKENS: Record<string, VistaTokens> = {
  moonlit: {
    ink: "#F5E8C8",
    mute: "#8FA6C8",
    accent: "#E6C77A",
    edge: "rgba(143,166,200,.16)",
    recess: "rgba(18,26,46,.90)",
    recessSoft: "rgba(18,26,46,.46)",
    chrome: "rgba(14,21,38,.90)",
    lit: "rgba(230,199,122,.46)",
    sill: "rgba(230,199,122,.16)",
    scrim: "rgba(11,16,33,.24)",
  },
  slate: {
    ink: "#CBD3D9",
    mute: "#A0AAB2",
    accent: "#C98A5E",
    edge: "rgba(255,255,255,.16)",
    recess: "rgba(34,42,49,.90)",
    recessSoft: "rgba(34,42,49,.46)",
    chrome: "rgba(26,33,39,.90)",
    lit: "rgba(255,255,255,.46)",
    sill: "rgba(255,255,255,.16)",
    scrim: "rgba(26,33,39,.24)",
  },
  trueblack: {
    ink: "#CFC8BA",
    mute: "#868278",
    accent: "#C98A5E",
    edge: "rgba(255,255,255,.16)",
    recess: "rgba(0,0,0,.90)",
    recessSoft: "rgba(0,0,0,.46)",
    chrome: "rgba(14,14,14,.90)",
    lit: "rgba(255,255,255,.46)",
    sill: "rgba(255,255,255,.16)",
    scrim: "rgba(0,0,0,.24)",
  },
  charcoal: {
    ink: "#DCD9D2",
    mute: "#9D9B94",
    accent: "#C98A5E",
    edge: "rgba(255,255,255,.16)",
    recess: "rgba(28,28,30,.90)",
    recessSoft: "rgba(28,28,30,.46)",
    chrome: "rgba(22,22,23,.90)",
    lit: "rgba(255,255,255,.46)",
    sill: "rgba(255,255,255,.16)",
    scrim: "rgba(22,22,23,.24)",
  },
  dusk: {
    ink: "#D8DEEC",
    mute: "#95A0B8",
    accent: "#8FA6D8",
    edge: "rgba(216,222,236,.16)",
    recess: "rgba(27,33,48,.90)",
    recessSoft: "rgba(27,33,48,.46)",
    chrome: "rgba(24,29,41,.90)",
    lit: "rgba(216,222,236,.46)",
    sill: "rgba(216,222,236,.16)",
    scrim: "rgba(24,29,41,.24)",
  },
  espresso: {
    ink: "#EADCC6",
    mute: "#A89680",
    accent: "#D49A6A",
    edge: "rgba(234,220,198,.16)",
    recess: "rgba(34,25,18,.90)",
    recessSoft: "rgba(34,25,18,.46)",
    chrome: "rgba(27,19,12,.90)",
    lit: "rgba(234,220,198,.46)",
    sill: "rgba(234,220,198,.16)",
    scrim: "rgba(27,19,12,.24)",
  },
  forestnight: {
    ink: "#D6E2D4",
    mute: "#8CA190",
    accent: "#82B08C",
    edge: "rgba(214,226,212,.16)",
    recess: "rgba(21,32,26,.90)",
    recessSoft: "rgba(21,32,26,.46)",
    chrome: "rgba(19,29,23,.90)",
    lit: "rgba(214,226,212,.46)",
    sill: "rgba(214,226,212,.16)",
    scrim: "rgba(19,29,23,.24)",
  },
  mulberry: {
    ink: "#E6D8E2",
    mute: "#AA90A4",
    accent: "#C189B0",
    edge: "rgba(230,216,226,.16)",
    recess: "rgba(34,22,32,.90)",
    recessSoft: "rgba(34,22,32,.46)",
    chrome: "rgba(28,19,26,.90)",
    lit: "rgba(230,216,226,.46)",
    sill: "rgba(230,216,226,.16)",
    scrim: "rgba(28,19,26,.24)",
  },
  nocturne: {
    ink: "#CFE0E0",
    mute: "#87A0A2",
    accent: "#5FA8A8",
    edge: "rgba(207,224,224,.16)",
    recess: "rgba(18,32,35,.90)",
    recessSoft: "rgba(18,32,35,.46)",
    chrome: "rgba(16,28,31,.90)",
    lit: "rgba(207,224,224,.46)",
    sill: "rgba(207,224,224,.16)",
    scrim: "rgba(16,28,31,.24)",
  },
  ivory: {
    ink: "#2B2521",
    mute: "#6B6155",
    accent: "#9C5A3C",
    edge: "rgba(43,37,33,.16)",
    recess: "rgba(245,238,221,.93)",
    recessSoft: "rgba(245,238,221,.62)",
    chrome: "rgba(234,224,202,.90)",
    lit: "rgba(43,37,33,.42)",
    sill: "rgba(43,37,33,.20)",
    scrim: "rgba(231,220,196,.16)",
  },
  ink: {
    ink: "#0E0D0A",
    mute: "#444038",
    accent: "#7A2E1E",
    edge: "rgba(0,0,0,.16)",
    recess: "rgba(255,255,255,.93)",
    recessSoft: "rgba(255,255,255,.62)",
    chrome: "rgba(251,250,245,.90)",
    lit: "rgba(14,13,10,.42)",
    sill: "rgba(14,13,10,.20)",
    scrim: "rgba(241,239,230,.16)",
  },
  linen: {
    ink: "#2A2925",
    mute: "#66645D",
    accent: "#9C5A3C",
    edge: "rgba(42,41,37,.16)",
    recess: "rgba(244,242,234,.93)",
    recessSoft: "rgba(244,242,234,.62)",
    chrome: "rgba(236,234,225,.90)",
    lit: "rgba(42,41,37,.42)",
    sill: "rgba(42,41,37,.20)",
    scrim: "rgba(236,234,225,.16)",
  },
  parchment: {
    ink: "#3A2E14",
    mute: "#6B5934",
    accent: "#8C5A24",
    edge: "rgba(58,46,20,.16)",
    recess: "rgba(240,226,190,.93)",
    recessSoft: "rgba(240,226,190,.62)",
    chrome: "rgba(231,215,176,.90)",
    lit: "rgba(58,46,20,.42)",
    sill: "rgba(58,46,20,.20)",
    scrim: "rgba(231,215,176,.16)",
  },
  rosequartz: {
    ink: "#3A2F30",
    mute: "#755F61",
    accent: "#A2545C",
    edge: "rgba(58,47,48,.16)",
    recess: "rgba(251,241,241,.93)",
    recessSoft: "rgba(251,241,241,.62)",
    chrome: "rgba(245,234,234,.90)",
    lit: "rgba(58,47,48,.42)",
    sill: "rgba(58,47,48,.20)",
    scrim: "rgba(245,234,234,.16)",
  },
  sage: {
    ink: "#2E342B",
    mute: "#5E6658",
    accent: "#4E6B4A",
    edge: "rgba(46,52,43,.16)",
    recess: "rgba(240,242,232,.93)",
    recessSoft: "rgba(240,242,232,.62)",
    chrome: "rgba(233,236,224,.90)",
    lit: "rgba(46,52,43,.42)",
    sill: "rgba(46,52,43,.20)",
    scrim: "rgba(233,236,224,.16)",
  },
  sepia: {
    ink: "#45382A",
    mute: "#635440",
    accent: "#7A4B2E",
    edge: "rgba(69,56,42,.16)",
    recess: "rgba(232,217,188,.93)",
    recessSoft: "rgba(232,217,188,.62)",
    chrome: "rgba(239,227,201,.90)",
    lit: "rgba(69,56,42,.42)",
    sill: "rgba(69,56,42,.20)",
    scrim: "rgba(239,227,201,.16)",
  },
};

// ---------------------------------------------------------------------------
// A seventeenth paper needs no designer
// ---------------------------------------------------------------------------

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (p: number[]): string =>
  "#" + p.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
const srgb = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (p: number[]): number => 0.2126 * srgb(p[0]) + 0.7152 * srgb(p[1]) + 0.0722 * srgb(p[2]);
const contrast = (a: number[], b: number[]): number => {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fill: number[], alpha: number, bed: number[]): number[] =>
  fill.map((c, i) => alpha * c + (1 - alpha) * bed[i]);
const rgba = (p: number[], a: string): string =>
  `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${a})`;

/** Black and white: a reader's photograph may put either under any piece of furniture. */
const BEDS = [[0, 0, 0], [255, 255, 255]];

/**
 * Lift a muted ink toward its text colour by the LEAST amount that clears 4.5:1 on the recess.
 *
 * The designer's own rule, and it reproduces all sixteen authored values exactly — which is why a
 * reader-made theme can be given tokens by the same arithmetic instead of being left to fall back
 * on a paper it does not resemble.
 */
function liftMuted(muted: string, text: string, paper: string, alpha: number): string {
  const m = hex(muted), t = hex(text), p = hex(paper);
  for (let k = 0; k <= 100; k++) {
    const mixed = m.map((c, i) => c + (t[i] - c) * (k / 100));
    const worst = Math.min(...BEDS.map((bed) => contrast(mixed, over(p, alpha, bed))));
    if (worst >= 4.5) return toHex(mixed);
  }
  return text;
}

/**
 * The tokens for any theme.
 *
 * A built-in paper returns the authored set untouched. Anything else — a reader's own theme — is
 * derived by the rule the specification states, so the set degrades to arithmetic rather than to a
 * wrong paper. The tokens that are judgement rather than arithmetic fall back to the theme's own
 * colours: the accent is the theme's accent, and the lit edge is its text.
 */
export function vistaTokensFor(theme: Theme): VistaTokens {
  const authored = VISTA_TOKENS[theme.id];
  if (authored) return authored;

  const c = theme.colors;
  const dark = theme.dark;
  const a = dark ? 0.9 : 0.93;
  const paper = hex(c.paperBg);
  const chrome = hex(c.chromeBg);
  const light = hex(c.text);
  return {
    ink: c.text,
    mute: liftMuted(c.muted, c.text, c.paperBg, a),
    accent: c.accent,
    edge: rgba(light, ".16"),
    recess: rgba(paper, dark ? ".90" : ".93"),
    recessSoft: rgba(paper, dark ? ".46" : ".62"),
    chrome: rgba(chrome, ".90"),
    lit: rgba(light, dark ? ".46" : ".42"),
    sill: rgba(light, dark ? ".16" : ".20"),
    scrim: rgba(chrome, dark ? ".24" : ".16"),
  };
}

/** Paint the set onto the document, beside the theme's own tokens. */
export function applyVistaTokens(set: (k: string, v: string) => void, theme: Theme): void {
  const v = vistaTokensFor(theme);
  set("--v-ink", v.ink);
  set("--v-mute", v.mute);
  set("--v-accent", v.accent);
  set("--v-edge", v.edge);
  set("--v-recess", v.recess);
  set("--v-recess-soft", v.recessSoft);
  set("--v-chrome", v.chrome);
  set("--v-lit", v.lit);
  set("--v-sill", v.sill);
  set("--v-scrim", v.scrim);
}
