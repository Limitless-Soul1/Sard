// The seven questions a Profile answers, in the order the design puts them.
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
  // TWO SURFACES, TWO CHAPTERS. A profile carries two palettes, and one chapter with a switch in it
  // presented them as one thing with a setting. These are the two editing surfaces themselves: each
  // opens its own face, so the preview beside the swatches IS the thing being coloured.
  { id: "paper",      name: "profiles.chapter.paperLibrary", q: "profiles.chapter.paperLibrary.q" },
  { id: "paperBook",  name: "profiles.chapter.paperBook",    q: "profiles.chapter.paperBook.q" },
  { id: "background", name: "profiles.chapter.background", q: "profiles.chapter.background.q" },
  { id: "fonts",      name: "profiles.chapter.fonts",      q: "profiles.chapter.fonts.q" },
  // Directly after the faces, because it is the same question continued: the faces choose the voice,
  // this chooses how it is set on the page.
  { id: "measure",    name: "profiles.chapter.measure",    q: "profiles.chapter.measure.q" },
  { id: "marks",      name: "profiles.chapter.marks",      q: "profiles.chapter.marks.q" },
  // Directly after the marks, because the reading cursor IS one: it is drawn on the page while Sard
  // reads aloud, and it is set the way the highlight and the bookmark are — a colour and a strength.
  { id: "voice",      name: "profiles.chapter.voice",      q: "profiles.chapter.voice.q" },
  { id: "texture",    name: "profiles.chapter.texture",    q: "profiles.chapter.texture.q" },
] as const satisfies readonly { id: string; name: TKey; q: TKey }[];

export type ChapterId = (typeof CHAPTERS)[number]["id"];

export interface Focus {
  face: "library" | "book" | null;
  label: TKey | null;
  /**
   * The object(s) this chapter governs, as selectors within the preview stage.
   *
   * SELECTORS, NOT AN INSET. The design states each region as a static rectangle, which is exact for
   * the one drawing it was measured on and wrong everywhere else: it cannot follow a bookmark the
   * reader has just moved, it does not know which face is on screen, and `inset` is physical so it
   * mirrors onto empty space in English. `FocusFrame` reads the union of these elements' live bounds
   * instead — see the note there for the measurements that forced it.
   *
   * The face gate falls out of this for free: no matching element means no frame, and the faces are
   * rendered one at a time.
   */
  targets: readonly string[];
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
  // The active profile, where the library actually shows it.
  identity:   { face: "library", label: "profiles.focus.identity", targets: [".pf-lib-chip"] },
  // The page itself — the whole sheet, not a region of it.
  // THE LIBRARY'S OWN COLOURS, on the library. The whole composition, because a palette is not a
  // region of a surface — it IS the surface.
  paper:      { face: "library", label: "profiles.focus.paperLibrary", targets: [".pf-lib"] },
  // THE BOOK'S COLOURS, on the page: the whole sheet, not a region of it. This is the focus the
  // single palette chapter used to have, kept exactly, because it is still right for this half.
  paperBook:  { face: "book",    label: "profiles.focus.paper",        targets: [".pf-page"] },
  // It governs the desk under BOTH faces, so it frames the whole composition and names neither.
  background: { face: null,      label: null,                      targets: [".pf-stage-fit"] },
  // The reading type, all of it: the chapter line and both scripts are one specimen.
  fonts:      { face: "book",    label: "profiles.focus.fonts",    targets: [".pf-page-label", ".pf-page-ar", ".pf-page-la"] },
  // The whole set body — the measure is the relationship BETWEEN the lines, so framing one paragraph
  // would misstate what the chapter changes.
  measure:    { face: "book",    label: "profiles.focus.measure",  targets: [".pf-page-body"] },
  // The three marks the chapter owns — the highlight and the selected run on the page, and the
  // marker at its edge.
  marks:      { face: "book",    label: "profiles.focus.marks",    targets: [".pf-page-hl", ".pf-page-sel", ".pf-page-mark"] },
  // The sentence being read and the word inside it: one specimen, because the two marks are set
  // against each other and framing either alone would misstate what the chapter does.
  voice:      { face: "book",    label: "profiles.focus.voice",    targets: [".pf-page-spot"] },
  // The panel the interface texture is actually visible on.
  texture:    { face: "library", label: "profiles.focus.texture",  targets: [".pf-lib-side"] },
};
