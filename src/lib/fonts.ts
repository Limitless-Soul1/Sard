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
const CUSTOM_STYLE_ID = "sard-custom-fonts";

// The chrome's UI-font default (mirrors global.css). The chosen family is prepended; the Arabic
// + Inter fallbacks always remain so Arabic UI keeps shaping whatever the user picks.
const UI_FALLBACK = `"SardUIArabic", "Inter", system-ui, sans-serif`;

export interface FontChoice {
  family: string; // the CSS font-family value
  label: string; // human label
  builtin: boolean;
}

// Built-in families that are actually registered as chrome @font-faces (so they render in the UI).
export const BUILTIN_UI_FONTS: FontChoice[] = [
  { family: "Inter", label: "Inter", builtin: true },
  { family: "SardUIArabic", label: "IBM Plex Arabic", builtin: true },
];

// Catalogue of built-in BOOK faces — shown in the shared font library (display + book defaults),
// not selectable as the chrome font (they're injected into the book under SardLatin/SardArabic).
export const BUILTIN_BOOK_FONTS = [
  { family: "Literata", label: "Literata" },
  { family: "Source Serif", label: "Source Serif" },
  { family: "Amiri", label: "Amiri" },
  { family: "Noto Naskh", label: "Noto Naskh" },
];

function applyUiFontVar(family: string | null): void {
  const root = document.documentElement;
  if (family && family.trim()) {
    root.style.setProperty("--ui-font", `"${family}", ${UI_FALLBACK}`);
  } else {
    root.style.removeProperty("--ui-font"); // fall back to the global.css default
  }
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
  custom: CustomFont[];
  ready: boolean;
  setUiFont: (family: string | null) => void;
  importFont: () => Promise<CustomFont | null>;
  removeFont: (id: string) => Promise<void>;
  /** Built-in chrome fonts + every imported font, as selectable UI-font choices. */
  uiChoices: () => FontChoice[];
}

export const useFonts = create<FontsState>((set, get) => ({
  uiFont: null,
  custom: [],
  ready: false,
  setUiFont: (family) => {
    applyUiFontVar(family);
    set({ uiFont: family });
    settingsSet(UI_FONT_KEY, family ?? "").catch(console.error);
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
  const [font, list] = await Promise.all([
    settingsGet(UI_FONT_KEY).catch(() => null),
    fontsList().catch(() => [] as CustomFont[]),
  ]);
  const custom = list ?? [];
  injectCustomFaces(custom);
  const uiFont = font && font.trim() ? font : null;
  applyUiFontVar(uiFont);
  useFonts.setState({ uiFont, custom, ready: true });
}
