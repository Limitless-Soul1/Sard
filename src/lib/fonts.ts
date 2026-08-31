// Fonts (RAWY-39) — the app-wide font surface used by Global Settings.
// - The APPLICATION font is ONE choice, stored under `ui_font` and re-applied at launch. It drives
//   every typography role in the interface — chrome, the names of books and shelves, and the
//   wordmark — by being prepended to each role's family base (`applyUiFontVar` below).
//   It deliberately does NOT reach the text INSIDE a book: that is the reading surface, and it has
//   its own per-script, per-book pickers in Reading Settings (`reader-engine/injectedCss.ts`).
//   Choosing how a book is set is a different act from choosing how the app is dressed.
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
const UI_SCALE_KEY = "ui_scale";
const CUSTOM_STYLE_ID = "sard-custom-fonts";

// RAWY-98: the manual UI-size factor (--ui-user) composes with global.css's auto viewport baseline.
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.4;
export const UI_SCALE_DEFAULT = 1.0;

// RAWY-91: the App-font default (mirrors global.css --ui-font). A user choice is PREPENDED; the Plex
// per-script fallbacks always remain — Latin → IBM Plex Sans (SardUILatin), Arabic → IBM Plex Sans
// Arabic (SardUIArabic) — so whatever the user picks, each script keeps a good default for glyphs the
// chosen face lacks.
const UI_FALLBACK = `"SardUILatin", "SardUIArabic", system-ui, "Segoe UI", sans-serif`;

/**
 * THE READER PICKS ONE FAMILY, AND EVERY ROLE IS BUILT FROM IT.
 *
 * These are the three family BASES `global.css` reads — `--ui`, `--book`, `--ar`, `--brand` and
 * `--brand-ar` are all defined in terms of them. The chosen family is PREPENDED to each; what
 * follows is that role's fallback chain, and the chains differ on purpose:
 *
 *   --ui-font    both scripts, via the unicode-ranged Plex pair
 *   --book-font  Latin; falls back to Literata, the Latin book face
 *   --ar-font    Arabic; falls back to Amiri, the Arabic book face
 *
 * So a reader who picks a Latin-only face still gets Amiri for Arabic rather than a system serif,
 * and a reader who picks an Arabic-only face still gets Literata for Latin. The browser decides,
 * per glyph, using coverage it already knows — no script detection is involved.
 *
 * Before this, `--ui-font` was the only one of the five anything ever wrote. The other four were
 * constants, so the setting moved the chrome and stopped: Arabic titles, the Arabic half of the
 * wordmark and the text on a generated card all stayed on families the reader could not change.
 */
const ROLE_BASES: ReadonlyArray<readonly [string, string]> = [
  ["--ui-font", UI_FALLBACK],
  // Each role keeps the APP FONT behind the reader's pick, and its own design face behind that. So a
  // pick that cannot draw a script hands it to Plex — the application's own voice — rather than to a
  // book face nobody asked for. These mirror the `:root` defaults in global.css, which is what a
  // cleared choice falls back to.
  ["--book-font", `"SardUILatin", "SardUIArabic", "Literata", Georgia, serif`],
  ["--ar-font", `"SardUIArabic", "SardUILatin", "Amiri", serif`],
];

/**
 * Which scripts a chosen family actually covers, from the catalogue Sard already keeps.
 *
 * An IMPORTED font is recorded with no script, and there is nothing honest to infer from a file
 * name, so it is offered to both and the browser's per-glyph fallback decides. That is measurably
 * fine: an imported face carrying both scripts draws both, and one carrying only Arabic simply
 * fails to supply Latin glyphs and the next entry in the chain supplies them.
 */
export function coverageOf(family: string): { latin: boolean; arabic: boolean } {
  const cat = FONT_CATALOGUE.find((f) => f.css === family);
  if (!cat) return { latin: true, arabic: true }; // imported: unknown, so let the glyphs decide
  return { latin: cat.scripts.includes("la"), arabic: cat.scripts.includes("ar") };
}

/**
 * The chrome stack for a chosen family.
 *
 * Chrome is ONE stack covering both scripts, so ordering is the only lever: whichever face comes
 * first supplies a glyph it has. A Latin-only pick therefore goes in front — Arabic falls past it to
 * Plex Arabic. An ARABIC-only pick goes BEHIND the Latin default instead, because Aref Ruqaa and
 * Noto Naskh do carry rudimentary Latin glyphs and would otherwise draw the whole interface's Latin
 * in a display Arabic face nobody chose it for. Measured: without this, picking Aref Ruqaa set every
 * Latin label in Aref Ruqaa's Latin.
 */
export function chromeStack(family: string): string {
  const cov = coverageOf(family);
  if (cov.latin) return `"${family}", ${UI_FALLBACK}`;
  return `"SardUILatin", "${family}", ${UI_FALLBACK.replace(`"SardUILatin", `, "")}`;
}

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

/**
 * Apply the reader's chosen family to EVERY role base. Exported so the profile store applies the
 * same thing rather than its own copy of one stack.
 *
 * Clearing removes the inline overrides, so the `:root` defaults in global.css apply again and the
 * app looks exactly as it does out of the box.
 */
export function applyUiFontVar(family: string | null): void {
  const root = document.documentElement;
  const chosen = family && family.trim();
  // EMPTY MEANS "IBM PLEX", which is a choice like any other — the catalogue stores that face as an
  // empty `css` because it is also the default. Clearing the overrides is therefore the right thing
  // to do, but ONLY because the `:root` bases themselves now start from the Plex pair. When they
  // named Literata and Amiri, this line is what handed Arabic titles and the wordmark to Amiri the
  // moment a reader selected IBM.
  if (!chosen) {
    for (const [base] of ROLE_BASES) root.style.removeProperty(base);
    return;
  }
  const cov = coverageOf(chosen);
  for (const [base, fallback] of ROLE_BASES) {
    // A face is only put in front of a script it actually covers. Sard knows the coverage of every
    // built-in face, so a Latin-only pick never displaces Amiri for Arabic, and an Arabic-only pick
    // never displaces Literata for Latin.
    const covers = base === "--ar-font" ? cov.arabic : base === "--book-font" ? cov.latin : true;
    if (base === "--ui-font") root.style.setProperty(base, chromeStack(chosen));
    else if (covers) root.style.setProperty(base, `"${chosen}", ${fallback}`);
    else root.style.removeProperty(base);
  }
}

// RAWY-91: the App-font WEIGHT (Regular 400 / Medium 500 / Bold 700) → the --ui-weight var.
function applyUiWeightVar(weight: number): void {
  const root = document.documentElement;
  if (weight && weight !== 400) root.style.setProperty("--ui-weight", String(weight));
  else root.style.removeProperty("--ui-weight");
}

// RAWY-98: the manual UI-size factor → the --ui-user var (composes with the auto viewport baseline
// in global.css). Chrome-only: the book iframe is a separate document and never sees this var.
function applyUiScaleVar(scale: number): void {
  const root = document.documentElement;
  if (scale && scale !== 1) root.style.setProperty("--ui-user", String(scale));
  else root.style.removeProperty("--ui-user");
}
const clampScale = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n)) : UI_SCALE_DEFAULT;

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
  uiScale: number; // manual UI size factor (0.8..1.4) — composes with the auto viewport baseline
  custom: CustomFont[];
  ready: boolean;
  setUiFont: (family: string | null) => void;
  setUiWeight: (weight: number) => void;
  setUiScale: (scale: number) => void;
  importFont: () => Promise<CustomFont | null>;
  removeFont: (id: string) => Promise<void>;
  /** Built-in chrome fonts + every imported font, as selectable UI-font choices. */
  uiChoices: () => FontChoice[];
}

export const useFonts = create<FontsState>((set, get) => ({
  uiFont: null,
  uiWeight: 400,
  uiScale: UI_SCALE_DEFAULT,
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
  setUiScale: (scale) => {
    const s = clampScale(scale);
    applyUiScaleVar(s);
    set({ uiScale: s });
    settingsSet(UI_SCALE_KEY, String(s)).catch(console.error);
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
  const [font, weightRaw, scaleRaw, list] = await Promise.all([
    settingsGet(UI_FONT_KEY).catch(() => null),
    settingsGet(UI_WEIGHT_KEY).catch(() => null),
    settingsGet(UI_SCALE_KEY).catch(() => null),
    fontsList().catch(() => [] as CustomFont[]),
  ]);
  const custom = list ?? [];
  injectCustomFaces(custom);
  const uiFont = font && font.trim() ? font : null;
  const uiWeight = Number(weightRaw) === 500 || Number(weightRaw) === 700 ? Number(weightRaw) : 400;
  const uiScale = clampScale(Number(scaleRaw));
  applyUiFontVar(uiFont);
  applyUiWeightVar(uiWeight);
  applyUiScaleVar(uiScale);
  useFonts.setState({ uiFont, uiWeight, uiScale, custom, ready: true });
}
