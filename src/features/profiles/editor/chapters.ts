// The six questions a Profile answers, in the order the design puts them.
//
// NAMES, NOT WORDS. These used to be Arabic literals, because the design is a monolingual Arabic
// mockup and the editor frame was drawn RTL whatever the interface language was. That made the rail,
// the chapter heading, its question and the focus labels the only strings in the application that
// ignored the reader's language — nineteen of them, byte-identical in both — while everything around
// them translated correctly. They are keys now, and the Arabic is unchanged: the design's own
// wording is what `ar.ts` carries.

import type { TKey } from "../../../i18n/locales/en";

export const CHAPTERS = [
  { id: "identity",   name: "profiles.chapter.identity",   q: "profiles.chapter.identity.q" },
  { id: "paper",      name: "profiles.chapter.paper",      q: "profiles.chapter.paper.q" },
  { id: "background", name: "profiles.chapter.background", q: "profiles.chapter.background.q" },
  { id: "fonts",      name: "profiles.chapter.fonts",      q: "profiles.chapter.fonts.q" },
  { id: "marks",      name: "profiles.chapter.marks",      q: "profiles.chapter.marks.q" },
  { id: "texture",    name: "profiles.chapter.texture",    q: "profiles.chapter.texture.q" },
] as const satisfies readonly { id: string; name: TKey; q: TKey }[];

export type ChapterId = (typeof CHAPTERS)[number]["id"];

export interface Focus {
  face: "library" | "book" | null;
  label: TKey | null;
  /**
   * The region of the stage this chapter governs, as a CSS `inset`.
   *
   * These are the design's own numbers and they are measured against a STAGE-FILLING face — the
   * library face at `56px 26px 26px`, the book page 452px wide in the middle of the stage. They mean
   * nothing against a centred 16:10 miniature, which is why they could not be carried until the
   * faces were rebuilt. They are resolved against the composition box, which is laid out at exactly
   * the size the design drew it, so they stay honest at every window size. Do not retune them: the
   * frame is only honest if it lands on the thing it names.
   */
  inset: string;
}

/**
 * Which face the preview locks to, the region the chapter governs, and what that region is called.
 *
 * The design's FOCUS map exactly. `background` deliberately has no face lock: it governs both faces
 * at once, so pinning the preview to either one would misstate what the chapter does. Its region is
 * therefore the whole stage below the segmented control, and it carries no name — the design labels
 * it with whichever surface is being edited, which is a different string for each and is the one
 * label this map cannot hold.
 */
export const FOCUS: Record<ChapterId, Focus> = {
  identity:   { face: "library", label: "profiles.focus.identity", inset: "calc(100% - 96px) 34px 34px calc(100% - 166px)" },
  paper:      { face: "book",    label: "profiles.focus.paper",    inset: "56px 25% 0 25%" },
  background: { face: null,      label: null,                      inset: "56px 0 0 0" },
  fonts:      { face: "book",    label: "profiles.focus.fonts",    inset: "104px 27% 30% 27%" },
  marks:      { face: "book",    label: "profiles.focus.marks",    inset: "56px 27% 46% 27%" },
  texture:    { face: "library", label: "profiles.focus.texture",  inset: "64px 34px 34px calc(100% - 166px)" },
};
