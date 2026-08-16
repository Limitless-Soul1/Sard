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
}

/**
 * Which face the preview locks to, and what the hairline frame is called.
 *
 * The design's FOCUS map exactly. `background` deliberately has no lock: it governs both faces at
 * once, so pinning the preview to either one would misstate what the chapter does.
 */
export const FOCUS: Record<ChapterId, Focus> = {
  identity:   { face: "library", label: "الهيئة النشِطة" },
  paper:      { face: "book",    label: "الصفحة وألوانها" },
  background: { face: null,      label: null },
  fonts:      { face: "book",    label: "الحرف المقروء" },
  marks:      { face: "book",    label: "العلامة والتظليل" },
  texture:    { face: "library", label: "لوحات الواجهة" },
};
