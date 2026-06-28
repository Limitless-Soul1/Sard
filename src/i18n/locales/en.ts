// English UI strings. This is the SOURCE locale — its keys define the typed key set.
// Keep keys grouped by area. Book/font proper names are NOT translated.
export const en = {
  "app.name": "Sard",

  "picker.prompt": "Choose your language",
  "picker.sub": "You can change this later in settings.",
  "lang.english": "English",
  "lang.arabic": "العربية",

  "reader.next": "Next page",
  "reader.prev": "Previous page",

  "type.size": "Text size",
  "type.font": "Font",
  "type.lineSpacing": "Line spacing",
  "type.margins": "Margins",
  "type.align": "Alignment",
  "type.alignJustify": "Justify",
  "type.alignStart": "Start",
  "type.diacritics": "Diacritics",
  "diacritics.show": "Show",
  "diacritics.dim": "Dim",
  "diacritics.hide": "Hide",

  "settings.language": "Language",
  "book.arabicSample": "Arabic book",
  "book.englishSample": "English book",

  "theme.label": "Theme",
  "theme.dayNight": "Day / Night",
  "theme.override": "Override book colour",
  "theme.hideTitles": "Hide chapter titles",

  "status.idle": "idle",
  "status.loading": "Loading…",
  "status.ready": "Ready",
  "status.error": "Error",
} as const;

export type TKey = keyof typeof en;
