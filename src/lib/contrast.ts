// WCAG contrast ratio between two colours (RAWY-40) — used to guard the per-book text-colour
// control so an ink too faint to read on the current paper is flagged.

type RGB = [number, number, number];

function parseHex(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// RAWY-200: also accept `rgb(r,g,b)`, because the built-in TTS-track defaults are stored that way
// (READING_SPOTLIGHT/READING_PILL). A user-picked colour is `#rrggbb`; both must parse for the guard.
function parseColor(c: string): RGB | null {
  const m = c.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return parseHex(c);
}

// RAWY-200: composite a translucent foreground over an opaque background (the TTS spotlight band is a
// colour laid over the paper at `alpha`; the reader's text then sits on THAT). Returns the effective
// opaque colour, so the contrast guard can check the book's ink against what the band actually renders.
export function compositeOver(fg: string, alpha: number, bg: string): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return bg;
  const a = Math.max(0, Math.min(1, alpha));
  const mix = (i: number) => Math.round(f[i] * a + b[i] * (1 - a));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(0))}${hex(mix(1))}${hex(mix(2))}`;
}

// RAWY-265 (Phase 3): THE EFFECTIVE PAPER — what a contrast guard must model once the page can be
// translucent.
//
// With page opacity below 1 the reading paper is no longer the ground; the ground is
//     paper·αp  +  (1−αp)·( desk·αs + (1−αs)·image )
// and `image` is per-pixel and unknowable. Per invariant I-7 a guard that cannot be exact must be
// CONSERVATIVE, never optimistic: both image extremes are evaluated and the one that lands CLOSEST to
// `against` — i.e. the hardest to read — is returned. A guard built on an average would under-warn on
// exactly the images that need warning about.
//
// At αp >= 1 this returns `paper` UNCHANGED, by an early return rather than by arithmetic that happens
// to be identity. That is what keeps every guard byte-identical at 100% page opacity.
export function effectivePaper(
  paper: string,
  pageAlpha: number,
  desk: string,
  scrimAlpha: number,
  against: string,
): string {
  if (!(pageAlpha < 1)) return paper; // 100% opaque, or an unusable value → today's behaviour exactly
  const p = parseColor(paper);
  const d = parseColor(desk);
  if (!p || !d) return paper;
  const a = Math.max(0, Math.min(1, pageAlpha));
  const s = Math.max(0, Math.min(1, scrimAlpha));
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  let worst = paper;
  let worstRatio = Infinity;
  for (const img of [[0, 0, 0], [255, 255, 255]]) {
    const ground = p.map((v, i) => {
      const deskPx = d[i] * s + img[i] * (1 - s);
      return v * a + deskPx * (1 - a);
    });
    const c = `#${hex(ground[0])}${hex(ground[1])}${hex(ground[2])}`;
    const r = contrastRatio(against, c);
    if (r < worstRatio) {
      worstRatio = r;
      worst = c;
    }
  }
  return worst;
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio (1..21). Returns 1 (worst) if either colour can't be parsed. Accepts `#rrggbb`
 *  and `rgb(r,g,b)` (RAWY-200). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = relLuminance(ca);
  const lb = relLuminance(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Below this the ink reads as "too faint" on the paper (body text wants ≥ ~4.5 for AA, but we
// only WARN — the user may still choose it; ~3.0 is where large text starts to struggle).
export const MIN_READABLE_CONTRAST = 3;

export function contrastIsReadable(ink: string, paper: string): boolean {
  return contrastRatio(ink, paper) >= MIN_READABLE_CONTRAST;
}
