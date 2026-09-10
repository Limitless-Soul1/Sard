// A FONT THAT HAS JUST ARRIVED, WAITING TO BE LOOKED AT.
//
// WHY A STORE AND NOT A PROP — the same reason `fonts/dropped.ts` and `profiles/dropped.ts` give: a
// font can arrive from the Library's window listener or from a picker inside Global Settings, and the
// specimen has to appear whatever the reader happens to be looking at. The route leaves the arrival
// here and an app-level surface picks it up.
//
// IT CARRIES THE ROW AND THE FACTS TOGETHER, and that pairing is the point. The row is what Sard
// stores and what the font selector will offer; the facts are what the FILE says about itself, read
// from its own tables. Holding one without the other would leave the specimen either unable to name
// the face it is drawing or unable to say which scripts it really has.
import { create } from "zustand";

import type { CustomFont, FontFacts } from "../../lib/ipc";

export interface ArrivedFont {
  /** The stored row: this is what the font selector offers and what `@font-face` was built from. */
  row: CustomFont;
  /** What the file says about itself — family, style, format, and the measured script coverage. */
  facts: FontFacts | null;
  /** `duplicate` = the family was already here, so nothing was added. */
  outcome: "imported" | "duplicate";
  /** Bumped per arrival, so a second import replaces the first rather than being ignored. */
  at: number;
}

interface FontPreviewState {
  font: ArrivedFont | null;
  show: (f: Omit<ArrivedFont, "at">) => void;
  clear: () => void;
}

export const useFontPreview = create<FontPreviewState>((set) => ({
  font: null,
  show: (f) => set({ font: { ...f, at: Date.now() } }),
  clear: () => set({ font: null }),
}));
