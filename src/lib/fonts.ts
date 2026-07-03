// Fonts (RAWY-39) — the app-wide font surface used by Global Settings.
// - The INTERFACE font (chrome only, NOT book text) is driven by the `--ui-font` CSS var; the
//   chosen family is stored under `ui_font` and re-applied at launch.
// - IMPORTED fonts are copied into app-data by the Rust `font_import` command and recorded in
//   `custom_fonts`; here we register an @font-face for each (served via the asset protocol) so
//   they are available app-wide, and expose them to the picker. Built-in chrome faces (Inter,
//   IBM Plex Arabic) live in global.css.

import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import { fontImport, fontRemove, fontsList, settingsGet, settingsSet, type CustomFont } from "./ipc";
import { setImportedFontUrlResolver } from "../reader-engine/injectedCss";

const UI_FONT_KEY = "ui_font";
const UI_WEIGHT_KEY = "ui_weight";
const CUSTOM_STYLE_ID = "sard-custom-fonts";

// RAWY-91: the App-font default (mirrors global.css --ui-font). A user choice is PREPENDED; the Plex
// per-script fallbacks always remain — Latin → IBM Plex Sans (SardUILatin), Arabic → IBM Plex Sans
// Arabic (SardUIArabic) — so whatever the user picks, each script keeps a good default for glyphs the
// chosen face lacks.
const UI_FALLBACK = `"SardUILatin", "SardUIArabic", system-ui, "Segoe UI", sans-serif`;

export interface FontChoice {
  family: string; // the CSS font-family value
  label: string; // human label
  builtin: boolean;
}

// RAWY-91: the shared font catalogue (design "FONT LIBRARY") — every built-in face, usable by the app
// AND the book. `css` is the CSS family; `cssArabic` (if set) is the paired Arabic face for a Latin
// UI pick so Arabic chrome still shapes. `book*` are the book-picker keys (injectedCss). `weights` are
// the real weights the face ships (for the honest weight readout — e.g. Amiri is 400/700 only).
export interface CatFont {
  id: string;
  css: string; // app-font CSS family (empty = the IBM Plex default pair)
  label: string; // shown in the library, rendered in its own face
  scripts: ("ar" | "la")[];
  bookArabic?: string; // book-picker key if usable as the Arabic book font
  bookLatin?: string; // book-picker key if usable as the Latin book font
  weights: number[];
  builtin: true;
}

export const FONT_CATALOGUE: CatFont[] = [
  { id: "plex", css: "", label: "IBM Plex Sans Arabic", scripts: ["ar", "la"], bookArabic: "plexArabic", bookLatin: "plexLatin", weights: [400, 500, 700], builtin: true },
  { id: "amiri", css: "Amiri", label: "أميري · Amiri", scripts: ["ar", "la"], bookArabic: "amiri", weights: [400, 700], builtin: true },
  { id: "literata", css: "Literata", label: "Literata", scripts: ["la"], bookLatin: "literata", weights: [400, 500, 600, 700], builtin: true },
  { id: "inter", css: "Inter", label: "Inter", scripts: ["la"], bookLatin: "inter", weights: [400, 500, 700], builtin: true },
  { id: "sourceSerif", css: "SourceSerif4", label: "Source Serif", scripts: ["la"], bookLatin: "sourceSerif", weights: [400, 500, 700], builtin: true },
  { id: "notoNaskh", css: "NotoNaskhArabic", label: "نسخ عربي · Noto Naskh", scripts: ["ar"], bookArabic: "notoNaskh", weights: [400, 500, 700], builtin: true },
  { id: "arefRuqaa", css: "ArefRuqaa", label: "رقعة · Aref Ruqaa", scripts: ["ar"], bookArabic: "arefRuqaa", weights: [400, 700], builtin: true },
];

// App-font choices for the picker (family "" = the IBM Plex default). Imported fonts appended by the store.
export const BUILTIN_UI_FONTS: FontChoice[] = FONT_CATALOGUE.map((f) => ({ family: f.css, label: f.label, builtin: true }));

function applyUiFontVar(family: string | null): void {
  const root = document.documentElement;
  if (family && family.trim()) {
    root.style.setProperty("--ui-font", `"${family}", ${UI_FALLBACK}`);
  } else {
    root.style.removeProperty("--ui-font"); // fall back to the global.css default
  }
}

// RAWY-91: the App-font WEIGHT (Regular 400 / Medium 500 / Bold 700) → the --ui-weight var.
function applyUiWeightVar(weight: number): void {
  const root = document.documentElement;
  if (weight && weight !== 400) root.style.setProperty("--ui-weight", String(weight));
  else root.style.removeProperty("--ui-weight");
}

function injectCustomFaces(fonts: CustomFont[]): void {
  const css = fonts
    .map(
      (f) =>
        `@font-face { font-family: "${f.family_name}"; src: url("${convertFileSrc(
          f.file_path,
        )}"); font-display: swap; }`,
    )
    .join("\n");
  let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

interface FontsState {
  uiFont: string | null; // chosen chrome family (null = default stack)
  uiWeight: number; // App-font weight (400/500/700)
  custom: CustomFont[];
  ready: boolean;
  setUiFont: (family: string | null) => void;
  setUiWeight: (weight: number) => void;
  importFont: () => Promise<CustomFont | null>;
  removeFont: (id: string) => Promise<void>;
  /** Built-in chrome fonts + every imported font, as selectable UI-font choices. */
  uiChoices: () => FontChoice[];
}

export const useFonts = create<FontsState>((set, get) => ({
  uiFont: null,
  uiWeight: 400,
  custom: [],
  ready: false,
  setUiFont: (family) => {
    applyUiFontVar(family);
    set({ uiFont: family });
    settingsSet(UI_FONT_KEY, family ?? "").catch(console.error);
  },
  setUiWeight: (weight) => {
    applyUiWeightVar(weight);
    set({ uiWeight: weight });
    settingsSet(UI_WEIGHT_KEY, String(weight)).catch(console.error);
  },
  importFont: async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (!picked || typeof picked !== "string") return null;
    const f = await fontImport(picked);
    const custom = [f, ...get().custom.filter((c) => c.id !== f.id)];
    injectCustomFaces(custom);
    set({ custom });
    return f;
  },
  removeFont: async (id) => {
    await fontRemove(id);
    const removed = get().custom.find((c) => c.id === id);
    const custom = get().custom.filter((c) => c.id !== id);
    injectCustomFaces(custom);
    // If the removed font was the active UI font, fall back to the default stack.
    if (removed && get().uiFont === removed.family_name) get().setUiFont(null);
    set({ custom });
  },
  uiChoices: () => [
    ...BUILTIN_UI_FONTS,
    ...get().custom.map((c) => ({ family: c.family_name, label: c.family_name, builtin: false })),
  ],
}));

/** An imported font's asset-protocol URL by family name (RAWY-44) — used to declare its
 *  @font-face INSIDE the foliate iframe via the injectedCss resolver. */
export function customFontUrl(family: string): string | null {
  const f = useFonts.getState().custom.find((c) => c.family_name === family);
  return f ? convertFileSrc(f.file_path) : null;
}
// Wire the book-font resolver so injectedCss can point a book @font-face at an imported file.
setImportedFontUrlResolver(customFontUrl);

/** Load + apply the persisted UI font and register imported @font-faces. Call once at startup. */
export async function initFonts(): Promise<void> {
  const [font, weightRaw, list] = await Promise.all([
    settingsGet(UI_FONT_KEY).catch(() => null),
    settingsGet(UI_WEIGHT_KEY).catch(() => null),
    fontsList().catch(() => [] as CustomFont[]),
  ]);
  const custom = list ?? [];
  injectCustomFaces(custom);
  const uiFont = font && font.trim() ? font : null;
  const uiWeight = Number(weightRaw) === 500 || Number(weightRaw) === 700 ? Number(weightRaw) : 400;
  applyUiFontVar(uiFont);
  applyUiWeightVar(uiWeight);
  useFonts.setState({ uiFont, uiWeight, custom, ready: true });
}
