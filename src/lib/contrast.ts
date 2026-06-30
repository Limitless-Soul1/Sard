// WCAG contrast ratio between two colours (RAWY-40) — used to guard the per-book text-colour
// control so an ink too faint to read on the current paper is flagged.

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio (1..21). Returns 1 (worst) if either colour can't be parsed. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
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
