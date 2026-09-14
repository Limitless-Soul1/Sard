// THE FOUR LAYER TINTS.
//
// The reference gives each layer a colour — gold, copper, teal, violet — so the strata of a bar read
// apart at a glance and a layer's row, its spine and its band agree. Those four are already in Sard as
// SEMANTIC HIGHLIGHT SLOTS, which every theme supplies its own values for, built-in or reader-made. So
// the mapping is to slots, never to hexes, and the sheet follows the reader's palette for free.
import type { HighlightSlot } from "../../../theme/tokens";
import type { LayerKey } from "./manifest";

export const TINT_SLOT: Record<LayerKey, HighlightSlot> = {
  highlights: "amber",
  notes: "coral",
  references: "teal",
  replacements: "purple",
};
