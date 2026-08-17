// The six questions a Profile answers, in the order the design puts them.
//
// Confirmed from the design's own CHAPTERS array — not re-derived. The Arabic is the design's
// wording verbatim: these are the words a reader sees, so they live as literals rather than i18n
// keys until the whole editor is translated as one piece.
export const CHAPTERS = [
  { id: "identity",   ar: "الهويّة",          q: "باسمِ مَن هذه الهيئة؟" },
  { id: "paper",      ar: "الوَرَق والألوان", q: "كيف تبدو الصفحة؟" },
  { id: "background", ar: "الخلفيّة",         q: "أين تريد الصورة، وكيف تظهر؟" },
  { id: "fonts",      ar: "الخطوط",           q: "كيف يبدو الحرف؟" },
  { id: "marks",      ar: "العلامات",         q: "ما الذي يدلّك على موضعك؟" },
  { id: "texture",    ar: "الملمس",           q: "كيف تبدو واجهة سَرْد؟" },
] as const;

export type ChapterId = (typeof CHAPTERS)[number]["id"];

export interface Focus {
  face: "library" | "book" | null;
  label: string | null;
  /**
   * The region of the stage this chapter governs, as a CSS `inset`.
   *
   * These are the design's own numbers and they are measured against a STAGE-FILLING face — the
   * library face at `56px 26px 26px`, the book page 452px wide in the middle of the stage. They mean
   * nothing against a centred 16:10 miniature, which is why they could not be carried until the
   * faces were rebuilt. Do not retune them to fit a differently-sized preview: the frame is only
   * honest if it lands on the thing it names.
   */
  inset: string;
}

/**
 * Which face the preview locks to, the region the chapter governs, and what that region is called.
 *
 * The design's FOCUS map exactly. `background` deliberately has no face lock: it governs both faces
 * at once, so pinning the preview to either one would misstate what the chapter does. Its region is
 * therefore the whole stage below the segmented control, and it carries no name — the design labels
 * it with whichever surface is being edited, which is the one focus label that would need a new
 * string, so it waits for the editor's localisation to be settled as a piece.
 */
export const FOCUS: Record<ChapterId, Focus> = {
  identity:   { face: "library", label: "الهيئة النشِطة",  inset: "calc(100% - 96px) 34px 34px calc(100% - 166px)" },
  paper:      { face: "book",    label: "الصفحة وألوانها", inset: "56px 25% 0 25%" },
  background: { face: null,      label: null,              inset: "56px 0 0 0" },
  fonts:      { face: "book",    label: "الحرف المقروء",   inset: "104px 27% 30% 27%" },
  marks:      { face: "book",    label: "العلامة والتظليل", inset: "56px 27% 46% 27%" },
  texture:    { face: "library", label: "لوحات الواجهة",   inset: "64px 34px 34px calc(100% - 166px)" },
};
