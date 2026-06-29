// Highlight colour helpers (RAWY-22). A stored colour is EITHER a semantic slot
// (adapts to the active theme) OR a literal #hex (a custom colour the user picked).
// colorValue resolves both to a concrete CSS colour for swatches + side-list tints.

import { HIGHLIGHT_SLOTS, type ThemeColors } from "../../theme/tokens";

export { HIGHLIGHT_SLOTS };

export const isHex = (c: string | null | undefined): c is string =>
  !!c && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c);

/** Resolve a slot name or #hex to a CSS colour, given the active theme's slot map. */
export function colorValue(color: string | null | undefined, hl: ThemeColors["highlight"]): string {
  if (!color) return hl.amber;
  if (isHex(color)) return color;
  return (hl as Record<string, string>)[color] ?? hl.amber;
}
