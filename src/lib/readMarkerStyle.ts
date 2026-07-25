import { create } from "zustand";
import { settingsGet, settingsSet } from "./ipc";
import type { TKey } from "../i18n/locales/en";

// RAWY-256 — the chapter READ-MARKER style: which of the six design variants marks a finished chapter in
// the Contents panel. GLOBAL, exactly like the bookmark SHAPE it sits beside (D67): this is an appearance
// preference, not a property of a book, and per-book scope would force the owner to re-pick it for every
// book in a library of hundreds. Persisted through the same settings key/value path as `bookmark_style`,
// so it costs no schema change and hydrates once at launch (`initReadMarkerStyle`, App.tsx).
//
// The six variants are the design file's own, implemented as CSS on the existing row — no new DOM nodes:
//   readingTrail  — a continuous settled-clay rule through finished chapters, live head on the current one
//                   (the QUIET register; every other variant is the noticeable one)
//   accentTrail   — the same rule promoted to full marker colour (THE DEFAULT, owner's choice)
//   trailingBar   — a bar on the row's TRAILING edge (pairs with Sard's leading bar on the reading row)
//   titleUnderline— a rule beneath the chapter title
//   silkRibbon    — a forked bookmark ribbon hanging from the row's top edge
//   waxSeal       — a small rimmed disc in the trailing margin
export type ReadMarkerKey = "readingTrail" | "accentTrail" | "trailingBar" | "titleUnderline" | "silkRibbon" | "waxSeal";

// Order = the order the chooser renders them, matching the design file's own "six, side by side".
export const READ_MARKERS: { key: ReadMarkerKey; label: TKey }[] = [
  { key: "readingTrail", label: "gs.readMarker.readingTrail" },
  { key: "accentTrail", label: "gs.readMarker.accentTrail" },
  { key: "trailingBar", label: "gs.readMarker.trailingBar" },
  { key: "titleUnderline", label: "gs.readMarker.titleUnderline" },
  { key: "silkRibbon", label: "gs.readMarker.silkRibbon" },
  { key: "waxSeal", label: "gs.readMarker.waxSeal" },
];

// The owner's explicit choice. A fresh install — and any existing profile that has never set this — gets it.
const DEFAULT_MARKER: ReadMarkerKey = "accentTrail";
const K_MARKER = "read_marker";

const isMarker = (v: unknown): v is ReadMarkerKey => READ_MARKERS.some((m) => m.key === v);

interface ReadMarkerState {
  marker: ReadMarkerKey;
  setMarker: (m: ReadMarkerKey) => void;
}

export const useReadMarkerStyle = create<ReadMarkerState>((set) => ({
  marker: DEFAULT_MARKER,
  setMarker: (m) => {
    set({ marker: m });
    settingsSet(K_MARKER, m).catch(console.error);
  },
}));

/** Hydrate the persisted choice at launch (App.tsx), beside `initBookmarkStyle`. An absent/unknown value
 *  falls back to the default, so an existing profile is unaffected until the owner picks something. */
export async function initReadMarkerStyle(): Promise<void> {
  const v = await settingsGet(K_MARKER).catch(() => null);
  useReadMarkerStyle.setState({ marker: isMarker(v) ? v : DEFAULT_MARKER });
}
