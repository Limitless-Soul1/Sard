// injectedCss — the single funnel that compiles a ReadingStyle into ONE CSS string
// injected into book sections via renderer.setStyles(). Everything visual goes through
// here (size, fonts, leading, margins, alignment, diacritics). Structured so the theme
// token system (next task) can plug colors into the same string.

import type { Theme } from "../theme/tokens";
// RAWY-281: `resolveMarkOnGround` (RAWY-260) and `effectivePaper` (RAWY-265 Phase 3) were imported here for
// ONE consumer — the reference underline's ground-resolved colour. That rule is gone (see the REFERENCES
// note below): the design specifies the theme accent at 100%, and the mark is no longer CSS at all. Both
// helpers keep their other callers (`highlightInk.ts` / the settings contrast guards) and are untouched.

export type DiacriticsMode = "show" | "dim" | "hide";
// LOGICAL, not physical (RAWY-207): `start`/`end` follow the book's direction, so one stored value
// reads correctly in both an RTL and an LTR book — in Arabic `start` IS the right edge. Physical
// left/right would freeze one direction into the setting. These flow straight into `text-align`
// (all four are valid CSS keywords), so no value needs special-casing in the funnel below.
export type Align = "justify" | "start" | "center" | "end";
export type FlowMode = "scrolled" | "paged";

// THE READING-SIZE LATTICE — ONE definition, because there are now TWO inputs.
//
// The Settings slider and Ctrl+Wheel both move `ReadingStyle.zoom` (D6). If each carried its own
// bounds and step they would eventually disagree, and the percentage readout would show a value the
// slider could not express. Both read these instead, so the two inputs move on the same lattice by
// construction rather than by anyone remembering to keep them level.
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.05;
export type ArabicFont = "amiri" | "notoNaskh" | "arefRuqaa" | "plexArabic";
export type LatinFont = "literata" | "sourceSerif" | "inter" | "plexLatin";

export interface ReadingStyle {
  zoom: number; // size via CSS zoom (D6): ZOOM_MIN .. ZOOM_MAX, see below
  // A built-in key (ArabicFont/LatinFont) OR an IMPORTED font's family name (RAWY-44). Imported
  // fonts resolve to an asset URL via the resolver below so their @font-face reaches the iframe.
  arabicFont: string;
  latinFont: string;
  lineHeight: number;
  marginPx: number; // inline page padding
  align: Align;
  diacritics: DiacriticsMode;
  // Page width / measure (RAWY-21; RAWY-23 made it RESPONSIVE): a 0..1 "Narrow → Wide" fraction.
  // It maps to a window-relative preferred width (vw) clamped to a readable range, so the page
  // SCALES with window size instead of staying a fixed narrow column in a void. Applied to the
  // chrome sheet (a CSS var), NOT injected into the book, so it composes cleanly with zoom (D6).
  pageWidth: number;
  pageFitWindow: boolean; // "match window" — the sheet fills the desk, ignoring pageWidth
  // Typography extras (RAWY-23), all via this funnel, both scripts unless noted:
  fontWeight: number; // 400 normal · 500 medium · 700 bold (real weight — variable Latin / Amiri-Bold)
  paragraphSpacing: number; // px of extra space between paragraphs
  firstLineIndent: boolean; // classic first-line indent instead of/with spacing
  letterSpacing: number; // px tracking — LATIN ONLY (it breaks Arabic cursive joining)
  // Per-book TEXT COLOUR (RAWY-40): an explicit ink within the active theme. `null` = follow the
  // theme's own text colour. A set colour is forced through the same `:root:root` mechanism the
  // override uses (RAWY-38), so it wins over the book's own CSS. Contrast is guarded in the UI.
  textColor: string | null;
  // Per-book PAGE + BACKGROUND colour (RAWY-201): the reading SURFACE (`pageColor`, the paper the text
  // sits on) and the AREA BEHIND the page (`backgroundColor`, the desk where Moonlit draws its clouds).
  // Both `null` = follow the active theme's `paperBg` / `surfaceBg` — the null sentinel means "resolve
  // the per-theme value", so an untouched book is byte-identical to today in EVERY theme (light + dark).
  // pageColor is forced into the book iframe the same hardened way as textColor AND drives a reader-scoped
  // `--reader-page` var so the .page-sheet margin matches the iframe surface (no seam). backgroundColor
  // drives a reader-scoped `--reader-bg` var and, when set, REPLACES the Moonlit decorations (D50). Neither
  // touches the global `--paper-bg`/`--app-bg` vars (90+ chrome consumers) → accent/chrome never shift.
  pageColor: string | null;
  backgroundColor: string | null;
  // Reading flow (RAWY-25): "scrolled" (default — continuous vertical scroll per chapter,
  // boundary-stop) or "paged" (foliate columns/pages). Drives the renderer's flow attribute,
  // not injected CSS — but the deterministic paged section box (overflow:hidden) is paged-only.
  flowMode: FlowMode;
  // TTS text-tracking (RAWY-200): user control over the two read-aloud indicators — the SENTENCE
  // spotlight (RAWY-126) and the WORD karaoke pill (RAWY-127). These are NOT injected CSS; they are
  // SVG drawn into foliate's own overlayer (FoliateController drawReadingSpotlight/drawReadingPill), so
  // there is no cascade and no book-CSS competition — the values flow straight into those draws.
  //
  // The colour/opacity fields default to `null`, and `null` is load-bearing: it means "use the built-in
  // PER-THEME constant" (light vs dark differ — see READING_SPOTLIGHT / READING_PILL). A stored number
  // could not express that; it would freeze light's value onto dark and silently regress the dark theme
  // for every fresh profile. So the untouched default reproduces today's look byte-identically in BOTH
  // themes precisely because it stores nothing. (Same design as `textColor` above.)
  ttsSpotlightOn: boolean; // default true — the sentence band (+ rule, unless disabled below)
  ttsSpotlightColor: string | null; // null = the per-theme terracotta
  ttsSpotlightOpacity: number | null; // null = the per-theme band opacity; the baseline rule scales by the theme ratio
  ttsSpotlightRule: boolean; // default true — draw the thin baseline UNDERLINE under the band (RAWY-200). false = band only
  ttsKaraokeOn: boolean; // default true — the word pill (driven by Edge word timings)
  ttsKaraokeColor: string | null; // null = the per-theme terracotta
  ttsKaraokeOpacity: number | null; // null = the per-theme pill opacity (0.9)
  // RAWY-212: immersive-mode PER-ELEMENT hide sub-toggles. The MASTER (`immersive`, global — theme store)
  // stays a single on/off; these TWO decide, per D43 (unified default + per-book override), WHICH elements
  // fade on a deliberate scroll-away while immersive is on. They only bite when the master is on AND the user
  // scrolled down (`.reader-root.immersive.scrolled-away`); each gates only its own element. Defaults preserve
  // RAWY-210/211 exactly: pill + scrollbar hide. The `.tts-resume` chapter-end hint is NEVER hidden by
  // immersive (owner revision — it must show ALONE over the clean page when a chapter ends while scrolled
  // away), and the D49 overlayer highlight is never bound either — both always show/track. Both OFF (with the
  // master on) is a valid no-op.
  immHidePill: boolean; // default true — hide the read-aloud control pill + kashida bead on scroll-away
  immHideScrollbar: boolean; // default true — hide the reading scrollbar on scroll-away
  // RAWY-281: the REFERENCE TWIN RULE (docs/design/Sard Reference Twin Rule (standalone).html). Like the
  // TTS tracking fields above, these are NOT injected CSS — the pair is SVG drawn into foliate's own
  // overlayer (FoliateController drawRefRule), so there is no cascade and no book-CSS competition.
  //
  // All three default to `null`, and the null sentinel is load-bearing for the SAME reason it is above:
  // the colour is the ACTIVE THEME's accent, which differs per theme (#9C5A3C ivory · #97582F sepia ·
  // #C98A5E slate/true-black), and a stored hex would freeze one theme's accent onto all sixteen. The two
  // sizes store nothing either, so an untouched book draws the design file's own geometry verbatim.
  // A stored `reading_style` row that predates these fields inherits them via loadGlobalStyle's
  // `{...base, ...s}` — the settings blob is JSON, so no migration.
  refRuleColor: string | null; // null = the active theme's accent at 100% (the design's own rule)
  refRuleWeight: number | null; // null = 1 — scales thickness AND gap together (REF_WEIGHT_MIN..MAX)
  refRuleOffset: number | null; // null = 1 — scales the .30em clearance below the text (REF_OFFSET_MIN..MAX)
}

// Page-width fraction (0 = Narrow, 1 = Wide). Default ~comfortable. The CSS clamp bounds the
// actual rendered width to a readable range; "Match window" overrides to fill.
export const PAGE_WIDTH_MIN = 0;
export const PAGE_WIDTH_MAX = 1;
export const PAGE_WIDTH_DEFAULT = 0.5;
// Slider fraction → preferred page width in PX, mapped LINEARLY across the whole 0..1 range so
// the ENTIRE slider changes the width (RAWY-48 fix). The old model returned a vw value that CSS
// then `clamp(…, 1360px)`-ed, so on a wide/maximized window the width hit 1360px around t≈0.3 and
// the top ~⅔ of the slider did nothing. Now the fraction maps directly to 480..1400px; CSS only
// caps it with `min(100%)` so it never exceeds the window. "Match window" still fills the sheet.
export const PAGE_WIDTH_PX_MIN = 480;
export const PAGE_WIDTH_PX_MAX = 1400;
export const pageWidthPx = (t: number): number =>
  PAGE_WIDTH_PX_MIN + Math.max(0, Math.min(1, t)) * (PAGE_WIDTH_PX_MAX - PAGE_WIDTH_PX_MIN);

// RAWY-195: paragraph spacing now ALWAYS emits a rule, so `0` means a real zero — tighter than the
// book. That makes the old default of 0 wrong: it would have jammed every book's paragraphs together
// out of the box. The default is the gap a typical EPUB sets for itself (`p{margin:1em 0}` at a 16px
// base = 16px), so a freshly-opened book still looks like it always did — the difference is that the
// user can now go BELOW it. DB migration 9 lifts an already-stored 0 (which meant "book default") to
// this value, so existing books keep their current look and don't silently collapse.
export const PARAGRAPH_SPACING_DEFAULT = 16;

interface FontDef {
  regular: string;
  bold?: string; // a separate static bold file (Amiri)
  variable?: boolean; // a variable font with a weight axis (Literata, Noto Naskh) → real weights
  label: string;
}

// RAWY-92: every bundled face eligible for its SCRIPT is book-selectable here (the book pickers —
// GlobalSettings defaults + the in-reader per-book picker — both iterate these registries, and the
// @font-face injected into the foliate iframe resolves its src from `regular`/`bold`). Arabic faces
// and Latin faces are kept separate because the book injects per-script via unicode-range, so a face
// only appears in the picker for the script it actually covers.
export const ARABIC_FONTS: Record<ArabicFont, FontDef> = {
  amiri: { regular: "/fonts/Amiri-Regular.ttf", bold: "/fonts/Amiri-Bold.ttf", label: "Amiri" },
  notoNaskh: { regular: "/fonts/NotoNaskhArabic.ttf", variable: true, label: "Noto Naskh" },
  arefRuqaa: { regular: "/fonts/ArefRuqaa-Regular.ttf", bold: "/fonts/ArefRuqaa-Bold.ttf", label: "Aref Ruqaa" },
  plexArabic: { regular: "/fonts/IBMPlexSansArabic-Regular.ttf", bold: "/fonts/IBMPlexSansArabic-SemiBold.ttf", label: "IBM Plex Sans Arabic" },
};
export const LATIN_FONTS: Record<LatinFont, FontDef> = {
  literata: { regular: "/fonts/Literata.ttf", variable: true, label: "Literata" },
  sourceSerif: { regular: "/fonts/SourceSerif4.ttf", variable: true, label: "Source Serif" },
  inter: { regular: "/fonts/Inter.ttf", variable: true, label: "Inter" },
  plexLatin: { regular: "/fonts/IBMPlexSans-Regular.ttf", bold: "/fonts/IBMPlexSans-Bold.ttf", label: "IBM Plex Sans" },
};

// RAWY-44: an IMPORTED book font's @font-face must be declared INSIDE the foliate content iframe
// (the app-document @font-face registered by lib/fonts.ts does NOT reach the iframe). injectedCss
// stays pure: lib/fonts.ts (which holds the custom_fonts list) wires this resolver, mapping an
// imported family name → its asset-protocol URL (accessible from the iframe too). null = unknown.
let importedFontUrl: (family: string) => string | null = () => null;
export function setImportedFontUrlResolver(fn: (family: string) => string | null): void {
  importedFontUrl = fn;
}
const isBuiltinLatin = (k: string): k is LatinFont => k in LATIN_FONTS;
const isBuiltinArabic = (k: string): k is ArabicFont => k in ARABIC_FONTS;

// RAWY-135: the book @font-face is injected into the foliate content iframe, which is a `blob:`
// document. A built-in font's absolute-PATH url ("/fonts/Amiri-Regular.ttf") CANNOT be resolved
// against a blob base — it fails to parse, the face loads with status "error", and every book falls
// back to the same system serif, so picking Amiri vs Noto Naskh vs Aref Ruqaa vs IBM Plex looked
// identical. Absolutise the bundled-font paths against the app origin (http://tauri.localhost) so the
// url() resolves from inside the iframe. Imported fonts already carry an absolute asset-protocol URL
// (RAWY-44), which doesn't start with "/", so they're left untouched.
const absFontUrl = (u: string): string =>
  u.startsWith("/") && typeof location !== "undefined" ? `${location.origin}${u}` : u;

// Bold works on Amiri (real Amiri-Bold) + the variable faces; Amiri has only 400/700 so 500
// snaps to the nearest. We never synth-bold Arabic by choice (faux-bold harms shaping).
export const FONT_WEIGHTS = [400, 500, 700] as const;

// Per-script Unicode ranges so the right face renders the right script (font fallback).
const ARABIC_RANGE =
  "U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F";
const LATIN_RANGE = "U+0000-024F, U+2000-206F, U+2070-209F, U+20A0-20BF";

// RAWY-200: the TTS-tracking defaults, shared by BOTH per-script default sets so they can never drift.
// Both effects ON; colour + opacity `null` so the built-in per-theme constants are used verbatim — the
// untouched default is byte-identical to the pre-RAWY-200 look, in light AND dark, because it stores no
// number. `Pick<>` keeps this in lockstep with the interface (a renamed field fails to compile here).
export const TTS_TRACKING_DEFAULTS: Pick<
  ReadingStyle,
  | "ttsSpotlightOn" | "ttsSpotlightColor" | "ttsSpotlightOpacity" | "ttsSpotlightRule"
  | "ttsKaraokeOn" | "ttsKaraokeColor" | "ttsKaraokeOpacity"
> = {
  ttsSpotlightOn: true,
  ttsSpotlightColor: null,
  ttsSpotlightOpacity: null,
  ttsSpotlightRule: true, // the baseline underline is drawn today → default true keeps the look identical
  ttsKaraokeOn: true,
  ttsKaraokeColor: null,
  ttsKaraokeOpacity: null,
};

// RAWY-212: immersive per-element hide defaults, shared by BOTH per-script default sets so they can never
// drift. These reproduce RAWY-210/211 exactly for an existing `immersive_scroll=1` profile — pill + scrollbar
// hide on scroll-away (the resume hint was never hidden, and still isn't) — so nobody sees a behaviour change.
// A stored `reading_style` row that predates these fields inherits them via loadGlobalStyle's `{...base, ...s}`,
// so no migration.
export const IMMERSIVE_DEFAULTS: Pick<ReadingStyle, "immHidePill" | "immHideScrollbar"> = {
  immHidePill: true,
  immHideScrollbar: true,
};

// RAWY-281: the reference twin-rule defaults, shared by BOTH per-script default sets so they can never
// drift. All `null` = "draw the design file exactly": the theme's own accent, the design's
// clamp(1.5px,.10em,2.5px) thickness, its clamp(2px,.13em,4px) gap and its .30em clearance. Storing no
// number is what makes the default follow the theme through all 16 accents instead of freezing one.
export const REF_RULE_DEFAULTS: Pick<ReadingStyle, "refRuleColor" | "refRuleWeight" | "refRuleOffset"> = {
  refRuleColor: null,
  refRuleWeight: null,
  refRuleOffset: null,
};

// Per-script sensible defaults — beautiful before the user touches a control.
export const ARABIC_DEFAULTS: ReadingStyle = {
  zoom: 1.15,
  arabicFont: "amiri",
  latinFont: "literata",
  lineHeight: 1.9,
  marginPx: 56,
  align: "start",
  diacritics: "show",
  pageWidth: PAGE_WIDTH_DEFAULT,
  pageFitWindow: false,
  fontWeight: 400,
  paragraphSpacing: PARAGRAPH_SPACING_DEFAULT,
  firstLineIndent: false,
  letterSpacing: 0,
  textColor: null,
  pageColor: null,
  backgroundColor: null,
  flowMode: "scrolled",
  ...TTS_TRACKING_DEFAULTS,
  ...IMMERSIVE_DEFAULTS,
  ...REF_RULE_DEFAULTS,
};
export const LATIN_DEFAULTS: ReadingStyle = {
  zoom: 1.0,
  arabicFont: "amiri",
  latinFont: "literata",
  lineHeight: 1.6,
  marginPx: 56,
  align: "justify",
  diacritics: "show",
  pageWidth: PAGE_WIDTH_DEFAULT,
  pageFitWindow: false,
  fontWeight: 400,
  paragraphSpacing: PARAGRAPH_SPACING_DEFAULT,
  firstLineIndent: false,
  letterSpacing: 0,
  textColor: null,
  pageColor: null,
  backgroundColor: null,
  flowMode: "scrolled",
  ...TTS_TRACKING_DEFAULTS,
  ...IMMERSIVE_DEFAULTS,
  ...REF_RULE_DEFAULTS,
};

export const defaultsForDir = (dir?: string): ReadingStyle =>
  dir === "rtl" ? ARABIC_DEFAULTS : LATIN_DEFAULTS;

export interface BookThemeFlags {
  overrideBookColor: boolean;
  // RAWY-265 (Phase 3): the effective PAGE OPACITY, 0.84..1. Threaded through `flags` rather than added
  // to `ReadingStyle` deliberately (spec §7.3): the background is app-wide, so putting it in the style
  // would drag it into the per-book/unified scope machinery (D43), `book_style:<id>` overrides and a
  // migration — for a value that is not per-book. `flags` already reaches BOTH builders on the same
  // channel `applyTheme(theme, flags)` uses, so nothing new has to be plumbed.
  //
  // OPTIONAL, and absent means 1. Every existing caller therefore keeps today's behaviour with no edit,
  // and every expression below is written so that 1 short-circuits to the exact pre-Phase-3 string.
  pageOpacity?: number;
  /** The DESK scrim alpha in force (0.62..1). Absent means 1 (a pure theme-coloured desk).
   *  RAWY-281: its ONE reader was the reference underline's ground-resolved colour, and that rule is
   *  gone — the twin rule takes the accent at 100% by design and is drawn in the overlayer, not in CSS.
   *  The field is KEPT rather than removed: `applyTheme(theme, flags)` carries it from five call sites in
   *  `Reader.tsx`, it is optional and free, and unpicking that plumbing is churn this ticket has no reason
   *  to spend. It is currently UNREAD by both builders — do not treat its presence as evidence of use. */
  deskScrim?: number;
  hideChapterTitles: boolean;
  // RAWY-69: independent from hideChapterTitles — hides the section's detected leading "first
  // line" (FoliateController's `.sard-chapter-heading`, RAWY-68) without touching the semantic
  // heading. A book can have EITHER a title, a repeated first line, both, or neither hidden.
  hideFirstLine: boolean;
}

// RAWY-70: the localized strings for the hide-first-line placeholder + two-step reveal. They ride
// into the content frame as CSS `content` custom properties (the placeholder DOM FoliateController
// injects is purely structural — text lives in CSS), so a UI-language change is a plain re-inject,
// no DOM text to keep in sync. Defaults are English so a missing config never renders blank.
export interface RevealLabels {
  hidden: string; // "Title hidden" — the idle placeholder
  confirm: string; // "Reveal the title?" — the confirm question (step 2)
  reveal: string; // "Reveal" — confirm-yes
  cancel: string; // "Cancel" — confirm-no
  // RAWY-71: the UI-LANGUAGE direction (not the book's). The placeholder is a localized widget whose
  // text is entirely CSS `content` (pseudo-elements) — `dir="auto"` on the element sees NO real text
  // nodes and so resolves LTR always, which laid the confirm row (question · Reveal · Cancel) out
  // element-reversed in an Arabic UI. Setting `direction` explicitly from the UI language fixes the
  // logical order in both directions (and rides the same re-inject as the labels on a language change).
  dir: "rtl" | "ltr";
}
const DEFAULT_REVEAL_LABELS: RevealLabels = {
  hidden: "Title hidden",
  confirm: "Reveal the title?",
  reveal: "Reveal",
  cancel: "Cancel",
  dir: "ltr",
};

// A CSS string literal from an arbitrary label — escape the two chars that could break out of a
// double-quoted `content` value. Arabic/English labels never contain these, but never trust input.
const cssString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Theme colours + flags compile into the SAME injected string as typography (RAWY-13).
// The page background always follows the theme; text colour is forced when override is on OR
// the theme is dark (a light-inked book on a dark page must be re-inked).
//
// SPECIFICITY (RAWY-37 — the real fix): self-published EPUBs routinely hard-code their OWN
// colours with `!important` on CLASS selectors — e.g. this repo's test book bakes in a dark
// mode: `.bixbox{background:#1a1a1a!important} .epcontent{color:#e8e8e8!important} article{…}`.
// A class selector (0,1,0) out-specifies an element selector (0,0,1) EVEN when ours has
// !important, and our injected <style> is only *appended* (source order can't break a
// specificity tie the book wins). RAWY-36's element-level rules therefore lost on these books
// → override looked weak and Day/Night never repainted the page (the book's container bg won).
// Fix: anchor the forced rules on `:root:root` (two structural pseudo-classes → specificity
// (0,2,0), NO IDs) so they beat class-level !important, plus ONE never-matching ID guard
// `:not(#<NEVER>)` (RAWY-38) that adds an ID-column of specificity (→ (1,2,x)) WITHOUT changing
// what matches — so the rules also beat a book's own ID-selector !important (specificity 1,0,0),
// e.g. `#wrap{background:#0a0a0a!important}`. Container backgrounds are neutralised so the themed
// paper shows. HONEST LIMITS (can't be beaten from a stylesheet): an inline `style="…!important"`
// on the element, or a multi-ID chain like `#a #b{…!important}` (specificity ≥ 2,0,0) — both are
// essentially unseen in real EPUBs. See §9.
// Shared by both hide-title/hide-first-line rules (RAWY-69 split them into two independent
// selectors): `visibility:hidden` + a collapsed box, never `display:none` — see the RAWY-22 note
// where a fully-removed heading (no layout box) broke CFI navigation to a chapter whose TOC anchor
// pointed at it.
// RAWY-195: a never-matching id guard raises a rule into the ID column WITHOUT changing what it
// matches (RAWY-38). `NEVER` is the one the forced typography rules use; `NEVER2` is a SECOND guard
// used only by HIDE_BOX_RULE below, so a hidden box always outranks them (see there).
const NEVER = ":not(#__sard_never__)";
const NEVER2 = ":not(#__sard_never2__)";

// RAWY-265 (Phase 3) — the PAPER as the book iframe must paint it.
//
// ⚠️ CONFIGURATION C — EXPERIMENTAL, pending the owner's approval of an I-4a amendment.
//
// At full opacity this returns the hex UNCHANGED, so the emitted stylesheet is byte-identical to the
// pre-Phase-3 output. Below 1 it returns `transparent` — the iframe paints NO paper at all.
//
// WHY NOT `rgba(paper, α)` HERE, which is what the specification first assumed: MEASURED, the paper is
// painted THREE times, not once. `.page-sheet` paints it, the book document paints it, and foliate's
// paginator paints it a third time into `<div id="background" part="filter">` (paginator.js:556, set
// from `getBackground()` at 635/696/1135). Three α=0.84 layers compose to 1−0.16³: on True-Black the
// text area measured [0,0,0] — fully opaque — while the sheet margin measured [3,3,3]. Page opacity
// appeared to work and did nothing where it mattered.
//
// Invariant I-4 says exactly ONE surface paints the paper. Making that true means the sheet paints it
// and everything inside foliate paints nothing; measured, that is the only configuration with a seam of
// ZERO (triple 3 → part-only 3 → single-paint 0).
const paperWithOpacity = (hex: string, opacity?: number): string => {
  if (opacity == null || !(opacity < 1)) return hex; // the byte-identical path
  return "transparent";
};

// RAWY-195: the class FoliateController tags onto a block the BOOK deliberately centres (or aligns to
// the edge opposite the reading direction) — a poem, a scene break, a centred figure, a title page.
// Every user rule that would flatten that intent (alignment, paragraph spacing, first-line indent)
// excludes it, so the book's own typography survives the override. Leading (line-height) is NOT
// excluded: it is unambiguously the reader's control and a poem should follow the user's leading.
export const BOOK_ALIGN_CLASS = "sard-book-align";
// The gate class FoliateController adds to <html> AFTER that measurement. The forced alignment rule
// is scoped to it, so during the measurement pass the book's OWN text-align is what computes — see
// markBookAlignedBlocks(). Everything else is ungated (it doesn't disturb the measurement).
export const ALIGN_GATE_CLASS = "sard-al";
const KEEP = `:not(.${BOOK_ALIGN_CLASS})`;

// RAWY-253 (root A): FoliateController.markParagraphDirection tags a <p dir="ltr"> whose strong ARABIC
// letters exceed its Latin letters, in an RTL book — the conversion-tool artifact where an overwhelmingly
// Arabic paragraph is mislabeled LTR from its first strong (Latin) char. CSS below forces the base
// direction back to RTL; the paragraph keeps the UA `unicode-bidi: isolate` from its dir attribute, so its
// embedded Latin still reads LTR and the Arabic punctuation lands on the RTL edge. Attribute-only → CFI-safe.
// RAWY-281: `REF_HIGHLIGHT_NAME` ("sard-ref") lived here — the CSS Custom Highlight registry name shared
// by the stylesheet and the controller. Both sides are gone: the twin rule is drawn in the overlayer, so
// nothing registers a Highlight and nothing styles one. The name survives only as the overlayer key prefix
// in `FoliateController` (`REF_KEY_PREFIX`), which is a different registry with a different owner — giving
// it a shared constant would imply a relationship that no longer exists.

export const FORCE_RTL_CLASS = "sard-force-rtl";
// RAWY-253 (root B): FoliateController.markEmptyParagraphs tags a whitespace-only <p> (scrape padding); the
// rule below zeroes its margin + line-height so it stops becoming a large vertical gap. Node is NEVER
// removed (CFI-safe) — only its box collapses.
export const EMPTY_P_CLASS = "sard-empty-p";
// RAWY-253 (addendum, owner live-test): a <p dir="ltr"> that rule (b) deliberately LEFT as LTR — a genuinely
// Latin standalone line like “MI9”. — still has to sit on the SAME margin as the Arabic around it, or it
// floats to the opposite edge and reads as broken. **DIRECTION AND ALIGNMENT ARE DECIDED SEPARATELY, and that
// separation is deliberate — do NOT "simplify" them into one rule.** DIRECTION must stay LTR here: flipping it
// would move the sentence period to the wrong side (."MI9" instead of "MI9".) — that is precisely why rule (a)
// was rejected. ALIGNMENT is independent: it must follow the BOOK. The catch is that `text-align: start`
// resolves against the PARAGRAPH's own direction (= left for an LTR paragraph), which IS the defect, so the
// user's LOGICAL align is resolved to a PHYSICAL edge against the BOOK's direction instead.
export const LTR_ALIGN_CLASS = "sard-ltr-align";
// Resolve a logical Align to the physical edge it means in an RTL BOOK: start/justify = the right margin
// (where the Arabic sits), end = left, center = center. Only ever used for RTL books.
const alignForRtlBook = (a: Align): string => (a === "center" ? "center" : a === "end" ? "left" : "right");

// Prefix each selector of a list with `:root:root` (+ the id guard) — the RAWY-38 hardening, applied
// per selector. Takes an ARRAY, never a comma string: a leaf-div selector carries commas INSIDE its
// own `:has(…)`, which a naive split on "," would shatter.
const hardList = (sels: string[], prefix = ":root:root", suffix = NEVER): string =>
  sels.map((s) => `${prefix} ${s}${suffix}`).join(",\n    ");

// The book's own paragraph-ish blocks. TEXT_BLOCKS = every leaf text element the reader's leading and
// alignment apply to — headings are deliberately ABSENT so the book's heading typography survives.
// PARA_BLOCKS (spacing + indent) is narrower: <p> plus a "leaf" text div — some EPUBs use <div>, not
// <p>, for paragraphs — but only one with no block child (`:not(:has(<block>))`), so layout/container
// divs are spared and the page isn't stretched apart. <li> is excluded: margins there blow lists apart.
const LEAF_DIV =
  "body div:not(:has(p, div, ul, ol, table, section, article, aside, figure, blockquote, h1, h2, h3, h4, h5, h6, hr))";
const TEXT_BLOCKS = ["p", "li", "blockquote", "div"];
const PARA_BLOCKS = ["p", LEAF_DIV];

// RAWY-195: the hide-box rule carries a SECOND id guard so it outranks the forced typography rules
// above (which sit at one ID column). Without it, the hardened `margin-block` would beat this rule's
// `margin: 0` on a hidden first line and re-open a phantom gap where the title used to be — and the
// hardened line-height would beat its `line-height: 0`. It also, as a bonus, now beats a book's own
// `h1.chapter{margin:2em!important}` (0,1,1), which the old element-level rule (0,0,1) lost to.
const HIDE_BOX_RULE = (selectors: string[]): string => `
  ${selectors.map((s) => `:root:root ${s}${NEVER}${NEVER2}`).join(",\n  ")} {
    visibility: hidden !important;
    font-size: 0 !important; line-height: 0 !important;
    height: 0 !important; min-height: 0 !important; max-height: 0 !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important;
    overflow: hidden !important;
  }`;

function themeBlock(
  theme: Theme | undefined,
  flags: BookThemeFlags | undefined,
  textColor?: string | null,
  pageColor?: string | null,
): string {
  if (!theme) return "";
  const c = theme.colors;
  // A never-matching id guard — raises specificity into the ID column so placeholder colours beat
  // the forceInk re-ink rule below (which paints every `body *` to the theme ink !important) and
  // the container-background neutraliser. Same technique/name as the RAWY-38 forced rules.
  const G = ":root:root .sard-title-ph:not(#__sard_never__)";
  // The ink: a per-book TEXT COLOUR (RAWY-40) wins over the theme's own text colour when set.
  const ink = textColor || c.text;
  // RAWY-201: the PAGE colour — a per-book paper colour wins over the theme's own paperBg. `null` →
  // the theme value verbatim (byte-identical default). Same forced/hardened treatment as textColor.
  const pageBase = pageColor || c.paperBg;
  const page = paperWithOpacity(pageBase, flags?.pageOpacity);
  // Background + container neutralisation are forced when override is on OR the theme is dark
  // (a light-inked book on a dark page must be re-inked). The INK is also forced whenever a
  // custom text colour is set — an explicit per-book choice that must win over the book's CSS.
  //
  const forceBg = (flags?.overrideBookColor ?? false) || theme.dark;
  // RAWY-265 (Phase 3) — THE `overrideBookColor` COUPLING (spec §4.3), and it is not optional.
  // The neutraliser `body * { background-color: transparent }` is what stops a book's own opaque
  // container <div> sitting on top of the translucent paper. With override OFF on a LIGHT theme
  // `forceBg` is false, the neutraliser is not emitted, and page opacity would SILENTLY DO NOTHING on
  // exactly those books — a control that appears to work and doesn't.
  //
  // SCOPED DELIBERATELY TO THE NEUTRALISER ALONE. Folding this into `forceBg` would have been one
  // character shorter and WRONG: `forceBg` also drives `inkRules`, which repaints every text element to
  // the theme ink. Coupling that to page opacity would flatten a book's own authored text colours the
  // moment the reader nudged an unrelated slider — a silent behaviour change the specification does not
  // ask for. The spec says "the container neutraliser is emitted regardless", and that is exactly and
  // only what this does.
  const translucent = (flags?.pageOpacity ?? 1) < 1;
  const neutraliseContainers = forceBg || translucent;
  const forceInk = forceBg || !!textColor;
  // A never-matching id (no element is `id="__sard_never__"`) used purely to raise specificity.
  const ID = NEVER;
  const inkRules = `:root:root body${ID}, :root:root body${ID} *:not(a) { color: ${ink} !important; }
           :root:root body${ID} a, :root:root body${ID} a * { color: ${c.accent} !important; }`;
  return `
    html, body { background: ${page} !important; }
    ::selection { background: ${c.selection}; }
    ${
      forceBg
        ? `:root:root, :root:root body${ID} { background-color: ${page} !important; }
           /* neutralise the book's own container backgrounds so the themed paper shows through */
           :root:root body${ID} * { background-color: transparent !important; }
           /* re-ink every text element (incl. <body> itself) to the theme; links take the accent */
           ${inkRules}`
        : forceInk
          ? /* a custom ink with no bg-override: force just the ink (RAWY-40) */ inkRules
          : `html, body { color: ${ink}; }`
    }
    ${
      /* RAWY-265 (Phase 3): the coupling. Emitted ONLY when the page is translucent AND `forceBg` did
         not already cover it — so at full opacity, and on every profile that already forces the
         background, this contributes NOTHING and the sheet is byte-identical. */
      neutraliseContainers && !forceBg
        ? `:root:root, :root:root body${ID} { background-color: ${page} !important; }
           :root:root body${ID} * { background-color: transparent !important; }`
        : ""
    }
    ${
      flags?.hideChapterTitles
        ? /* Hide the chapter-title TEXT, but keep the heading element in normal flow with a
             valid (zero-size) box. `display:none` removed it from layout entirely, and since
             TOC entries anchor to the heading id, navigating to a chapter whose heading was
             display:none landed on a geometry-less element → a blank page (RAWY-22 bug). Here
             the heading still has a position the paginator can resolve, so the page renders.
             h1-h6 (RAWY-67 — was only h1/h2; some books use a lower heading level for the
             chapter title) — the book's OWN semantic heading element. `.sard-chapter-heading`
             is deliberately NOT included here (RAWY-69 split it into its own independent toggle
             below) — a heading-tag element never gets that class in the first place (see
             `markInBodyHeading`), so the two rules can never fight over the same element. */
          HIDE_BOX_RULE(["h1", "h2", "h3", "h4", "h5", "h6"])
        : ""
    }
    ${
      flags?.hideFirstLine
        ? /* RAWY-69: independent from hideChapterTitles above — hides ONLY the section's
             detected leading "first line" (`.sard-chapter-heading`, a class FoliateController
             adds — RAWY-68 — to a section's leading non-heading block ONLY when it provably
             echoes that section's own TOC number; never a semantic heading, see above). A
             converted/scraped EPUB that repeats its title as a plain first line of body text
             (not a real heading) is exactly what this catches — the RAWY-67 problem this toggle
             was originally introduced for, now controllable separately from the heading itself.
             RAWY-70: instead of a blank removal, the line is replaced by a quiet placeholder
             (the `.sard-title-ph` element FoliateController injects right before each detected
             line) offering a TWO-STEP reveal — tap → "Reveal the title?" → confirm — so an
             accidental tap can never instantly spoil. A revealed instance carries
             `.sard-revealed`, so it is excluded from the hide here (per-instance; a fresh section
             loads a fresh idle placeholder). */
          `${HIDE_BOX_RULE([".sard-chapter-heading:not(.sard-revealed)"])}
           /* the placeholder takes the hidden line's place — quiet, in the book's theme */
           .sard-title-ph {
             display: inline-flex; align-items: baseline; gap: .4em; flex-wrap: wrap;
             margin: .15em 0 .75em; font-size: .82em; line-height: 1.6;
             font-family: 'SardArabic', 'SardLatin', serif;
             user-select: none; -webkit-user-select: none;
           }
           .sard-title-ph[data-sard-state="revealed"] { display: none; }
           .sard-title-ph .sard-ph-confirm { display: none; }
           .sard-title-ph[data-sard-state="confirm"] .sard-ph-main { display: none; }
           .sard-title-ph[data-sard-state="confirm"] .sard-ph-confirm { display: inline-flex; align-items: baseline; gap: .5em; flex-wrap: wrap; }
           /* the clickable bits — reset UA button chrome, keep them looking like quiet links */
           .sard-title-ph .sard-ph-main, .sard-title-ph .sard-ph-yes, .sard-title-ph .sard-ph-no {
             background: none; border: 0; padding: 0; margin: 0; font: inherit; cursor: pointer;
             text-decoration: underline; text-underline-offset: 3px;
           }
           /* text comes from the localized CSS vars (defined once in :root, RAWY-70) */
           .sard-title-ph .sard-ph-main::before { content: var(--sard-ph-hidden); }
           .sard-title-ph .sard-ph-q::before { content: var(--sard-ph-confirm); }
           .sard-title-ph .sard-ph-yes::before { content: var(--sard-ph-reveal); }
           .sard-title-ph .sard-ph-no::before { content: var(--sard-ph-cancel); }
           /* colours — the G-guarded selectors beat the forceInk re-ink + bg-neutralise rules above */
           ${G}, ${G} .sard-ph-main, ${G} .sard-ph-q, ${G} .sard-ph-no { color: ${c.muted} !important; }
           ${G} .sard-ph-yes { color: ${c.accent} !important; }`
        : ""
    }
  `;
}

export function buildReadingCss(
  style: ReadingStyle,
  theme?: Theme,
  flags?: BookThemeFlags,
  bookDir?: string,
  revealLabels?: RevealLabels,
): string {
  const rl = revealLabels ?? DEFAULT_REVEAL_LABELS;
  // RAWY-134 (B): the reading iframe's scrollbar thumb tracks the theme INK (a per-book text colour
  // wins, then the theme's own) so it stays visible on dark paper — `currentColor` on the iframe's
  // <html> is the default black under a forced-background theme, which would vanish on a dark page.
  const scrollInk = style.textColor || theme?.colors?.text || "currentColor";

  const diacriticsRule =
    style.diacritics === "dim"
      ? ".sard-tashkil { opacity: 0.28; }"
      : style.diacritics === "hide"
        ? ".sard-tashkil { font-size: 0 !important; }"
        : "";

  // Typography extras (RAWY-23). Weight applies to body text (not headings → keep hierarchy).
  // Letter-spacing is LATIN-ONLY — it inserts gaps that break Arabic cursive joining.
  const latinText = bookDir !== "rtl";
  const extras = `
    ${/* font-weight is deliberately NOT hardened (RAWY-195 audit): a book marks whole-block emphasis
          with a class (`.calibre5{font-weight:bold}`), which out-specifies this element rule and so
          still wins — that is the book's EMPHASIS surviving, exactly as the invariant requires.
          Forcing it would flatten a bold paragraph to the reader's body weight. */ ""}
    p, li, blockquote, div, td, th, dd, dt {
      font-weight: ${style.fontWeight};
    }
    ${/* Paragraph spacing — ALWAYS emitted (RAWY-195). THIS is the bug the user actually hit, and it was
          reproduced on the pre-fix build: the rule was gated on `> 0`, so at the MINIMUM it emitted
          nothing at all and the paragraph fell back to the UA default (`p{margin:1em 0}` = 16px). The
          user could drag the slider to zero and the gap never budged — they could never set spacing
          TIGHTER than the default. A control whose minimum emits NO rule hands the value straight back
          to whatever else is in the cascade. The minimum now emits a real `margin-block: 0`, and the
          default moved to PARAGRAPH_SPACING_DEFAULT so a freshly-opened book keeps the same paragraph
          rhythm it has today (migration 9 lifts an already-stored 0 to it — that 0 meant "leave it
          alone", not "collapse it"). `KEEP` spares deliberately-centred blocks: a poem's lines would
          otherwise be prised apart by the reader's paragraph spacing. */ ""}
    ${hardList(PARA_BLOCKS, ":root:root", `${KEEP}${NEVER}`)}
      { margin-block: ${style.paragraphSpacing}px !important; }
    ${/* First-line indent — ALSO always emitted, and hardened (RAWY-195). Same shape of defect: OFF
          emitted nothing, so the indent was whatever the rest of the cascade said rather than an
          explicit zero, and ON would lose to any book class that zeroes the indent the moment book CSS
          applies. OFF is now an explicit `text-indent: 0`. Centred blocks are spared (they must not be
          indented). KNOWN LIMIT: with indent ON, a book's left-aligned VERSE lines (Alice's `p.poem`)
          are <p> too, so they take the indent — acceptable for an off-by-default, opt-in control. */ ""}
    ${hardList(PARA_BLOCKS, ":root:root", `${KEEP}${NEVER}`)}
      { text-indent: ${style.firstLineIndent ? "1.5em" : "0"} !important; }
    ${/* Tracking stays LATIN-ONLY and stays gated on `> 0` (RAWY-195 audit — a deliberate exception to
          the always-emit rule): its "minimum" IS the CSS initial value (`normal`), and forcing that on
          every paragraph would strip the book's own decorative tracking (Alice's `p.asterism` scene
          break) for no user gain. It IS hardened now, so when the user does ask for tracking the
          control actually wins on a class-styled book. */ ""}
    ${
      latinText && style.letterSpacing > 0
        ? `${hardList(["p", "li", "blockquote", "div", "td", "th"], ":root:root", `${KEEP}${NEVER}`)}
      { letter-spacing: ${style.letterSpacing}px !important; }`
        : ""
    }`;

  return `
    /* RAWY-208: @font-face is NOT here — it lives in its own stable sheet (buildFontFaceCss), written
       only when the FONT itself changes. This sheet is replaced wholesale by foliate's setStyles on
       every geometry change (alignment, weight, leading, zoom …); re-declaring the faces here made the
       engine drop and re-fetch them each time, so the text repainted in a FALLBACK face for ~35-45ms
       and re-wrapped — the flash/line-jump the owner reported. Measured: an alignment or weight change
       triggered 2 font re-fetches although the font never changed. */

    /* size via zoom (D6 — scales even absolute-CSS books). Zoom the column CONTENT (body),
       NOT the column container (:root/html, where foliate sets column-width): that way the
       scaled text reflows WITHIN foliate's fixed-width columns instead of overflowing them
       and clipping line-ends (worse at higher zoom / narrower measures). */
    body { zoom: ${style.zoom}; }

    /* deterministic section box → no stray paginated scrollbar (RAWY-04). PAGED-ONLY
       (RAWY-25): in scrolled mode foliate makes the section full-height and the container
       scrolls, so forcing height:100%/overflow:hidden here would clip the scroll. */
    html, body { margin: 0; box-sizing: border-box; }
    /* RAWY-134 (B): thin, on-brand scrollbar for the reading iframe's OWN scroll (a wide table/pre can
       overflow horizontally), matched to the app-shell bars (global.css). The app's inherited
       scrollbar-color doesn't cross the frame boundary, so set it here from the reading ink (scrollInk)
       so it tracks the theme/paper. Still a real, draggable scrollbar — only restyled. */
    html, body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, ${scrollInk} 30%, transparent) transparent; }
    ${/* RESILIENCE-1: `html`, NEVER `html, body`.
          THE DEFECT THIS FIXES — paged mode never paginated. `overflow: hidden` makes an element a
          SCROLL CONTAINER, and per CSS Fragmentation a scroll container is MONOLITHIC: it cannot be
          split across columns. foliate paginates by columnising <html> and treating each column as a
          page, so putting `overflow: hidden` on <body> collapsed every chapter into ONE unbreakable
          box — it rendered in column 1 and everything past the first screen was CLIPPED AND
          UNREACHABLE.
          MEASURED on the real app (Alice, chapter I, 26 paragraphs): laid out to 20,331px inside a
          624px box, ONE column, ~97% of the chapter unreachable, and foliate reported 3 pages where
          it needed ~23. Removing the `body` half: 23 columns, all reachable. Isolated four ways —
          `body{overflow:hidden}` alone breaks it, `body{height:100%}` alone is harmless.
          It is also what made the reported TOC bug: `paginator.js #scrollToRect` maps an anchor to a
          page with `floor(rect.left / size)`, and with no fragmentation every anchor in a section
          shares one `left`, so every TOC entry pointing into the same section resolved to the SAME
          page. In Alice the first three entries all point into one front-matter document.
          `html` KEEPS the rule: that is what RAWY-04 needed (no stray paginated scrollbar), and
          foliate's own `columnize()` sets `height`/`overflow:hidden` on <html> regardless — so this
          is belt-and-braces there and load-bearing nowhere else.
          Covered by the paged-flow and pagination checks. */ ""}
    ${style.flowMode === "paged" ? "html { height: 100%; overflow: hidden; }" : ""}
    /* MARGINS are applied on the CHROME side (RAWY-36): foliate's paginator sets html padding
       inline with !important in BOTH scrolled + paged modes, which overrode an injected
       html padding-inline here (inline styles always beat a stylesheet rule). So the page
       margin now insets the foliate host within the sheet (--page-margin -> .page-host), which
       foliate cannot override and which works identically in both flow modes. */
    /* RAWY-260 / RAWY-281 — REFERENCES. The mark for a referenced word or phrase is NOT drawn here any
       more, and the reason is a hard capability limit rather than a preference. RAWY-260 drew it with the
       CSS Custom Highlight API (::highlight(sard-ref)), whose styleable property set is text-only —
       colour, background-colour, text-decoration, text-shadow. The accepted design
       (docs/design/Sard Reference Twin Rule (standalone).html) is TWO DRAWN STROKES with rounded terminals,
       an em-based gap and a clearance below the content box; the file's own closing note says exactly what
       that rules out — "a browser's 'underline double' gives you two hairlines of identical weight,
       square ends, a fixed sub-pixel gap you cannot control, and colour tied to the text". No
       text-decoration can produce a rounded cap, so no value of this rule could have rendered the design.
       The pair is therefore drawn as SVG in foliate's own overlayer (FoliateController drawRefRule) —
       the SAME route RAWY-258 took for the highlight ink swatch, and for the same reason: it mutates
       NOTHING in the book, so foliate's CFI child-step indices stay untouched and every stored bookmark,
       resume position, highlight and TTS range keeps resolving. */
    /* a corrected reading direction (RAWY-19 override) flows + aligns the text accordingly */
    ${bookDir ? `html, body { direction: ${bookDir}; }` : ""}
    /* RAWY-253 (root A): re-assert RTL on paragraphs a converted EPUB hardcoded dir=ltr although they are
       overwhelmingly Arabic (FoliateController tags them, RTL books only). The dir attribute's own
       unicode-bidi:isolate stays, so the paragraph becomes an ISOLATED RTL block — Arabic reads RTL,
       embedded Latin still reads LTR, punctuation on the RTL edge. The important flag + the id-guard beat
       the UA [dir=ltr] presentational rule and any inherited direction. Never touches وMI9/الـMI9. */
    :root:root .${FORCE_RTL_CLASS}${NEVER} { direction: rtl !important; }
    /* RAWY-253 (root B): collapse whitespace-only <p> (scrape padding) so it stops taking the reader's
       per-paragraph margin + line-height × zoom as a gap. DOUBLE id-guard (like HIDE_BOX_RULE) so it
       out-ranks the hardened paragraph-spacing + line-height rules below. The node is NEVER removed. */
    :root:root .${EMPTY_P_CLASS}${NEVER}${NEVER2} { margin-block: 0 !important; line-height: 0 !important; }
    /* RAWY-253 (addendum): the paragraphs rule (b) LEFT as direction:ltr keep their LTR reading order (so
       “MI9”. still reads “MI9”. and the period stays put) but must align to the BOOK's margin, not their own
       LTR start edge. Emitted for RTL books only; the user's logical align is resolved to the physical edge
       the Arabic around it uses. Spares .sard-book-align (RAWY-195: never flatten the book's own centring).
       Double id-guard so it out-ranks the hardened text-align rule further down. */
    ${
      bookDir === "rtl"
        ? `:root:root .${LTR_ALIGN_CLASS}${KEEP}${NEVER}${NEVER2} { text-align: ${alignForRtlBook(style.align)} !important; }`
        : ""
    }
    /* highlight ink (RAWY-22): a clearly-visible "wick" — multiply blend on light paper,
       screen on dark. Opacity = the theme's own highlightAlpha when set (RAWY-29 themes.json:
       light = 1, dark ≈ 0.32–0.36), else the original RAWY-22 intensities (0.62 / 0.5) so the
       first 4 themes are unchanged. */
    :root {
      --overlayer-highlight-opacity: ${theme?.highlightAlpha ?? (theme?.dark ? 0.5 : 0.62)};
      --overlayer-highlight-blend: ${theme?.dark ? "screen" : "multiply"};
      /* RAWY-70: localized text for the hide-first-line placeholder + reveal (CSS-var driven, so a
         UI-language change is a re-inject, not a DOM edit). Definitions live here; the placeholder
         is only ever VISIBLE when hideFirstLine is on (themeBlock), so these are inert otherwise. */
      --sard-ph-hidden: ${cssString(rl.hidden)};
      --sard-ph-confirm: ${cssString(rl.confirm)};
      --sard-ph-reveal: ${cssString(rl.reveal)};
      --sard-ph-cancel: ${cssString(rl.cancel)};
    }
    /* RAWY-70: the injected placeholder is display:none by default (FoliateController injects it
       into every section with a detected first line, regardless of the toggle — matching how the
       sard-chapter-heading class is always tagged and CSS gates the effect). themeBlock reveals
       it only when hideFirstLine is on. So with the toggle OFF there is no placeholder at all and
       the real first line renders normally.
       RAWY-71: force the placeholder's direction to the UI language (its labels' language) and
       bidi-isolate it — a self-contained localized widget. A dir=auto attribute failed here because
       the text is all CSS pseudo-content (no real text nodes to infer direction from), so the confirm
       row (question · Reveal · Cancel) came out element-reversed in Arabic. Explicit direction lays
       it out in correct logical order, mirrored, in both LTR and RTL. */
    .sard-title-ph { display: none; direction: ${rl.dir}; unicode-bidi: isolate; }
    img, svg, video, table { max-width: 100%; max-height: 100%; }

    /* per-script fonts: Arabic glyphs use the chosen Arabic face, Latin uses Literata */
    html, body, p, li, blockquote, div, span, h1, h2, h3, h4, h5, h6, td, th, a {
      font-family: 'SardArabic', 'SardLatin', serif !important;
    }
    ${/* RAWY-195. These two were the last PLAIN rules in the funnel: an element selector at specificity
          (0,0,1), no !important — while text COLOUR (themeBlock) and paragraph spacing had carried the
          RAWY-38 hardening for years. MEASURED TRUTH (don't repeat the earlier misdiagnosis): they were
          not actually losing to book CSS, because Sard does not currently apply an EPUB's external
          stylesheet AT ALL — proven live on both test books via properties Sard never sets
          (`p.poem{margin-left:10%}` computes 0px, `{font-size:90%}` computes 16px). With no book rules
          in the cascade, a plain `p{…}` rule had nothing to lose to, and alignment/leading DID apply.
          That book-stylesheet defect is a separate, larger bug (see OPEN.md) — and the day it is fixed,
          a book's `.calibre4{text-align:right}` (0,1,0) would instantly out-specify these element
          rules and the controls WOULD silently die. So harden them by construction, now: `:root:root`
          (0,2,0 — beats a class !important) + a never-matching id guard (→ the ID column — beats
          `#wrap{…!important}`), plus !important. Headings are NOT in TEXT_BLOCKS: the book's heading
          typography must survive untouched.
          ALIGNMENT additionally: (a) is scoped to the `.sard-al` gate class, which FoliateController
          adds to <html> only AFTER it has measured each block's own alignment (with this rule therefore
          inert), and (b) spares `.sard-book-align` — the blocks that measurement found are deliberately
          centred (or aligned to the edge opposite the reading direction): poems, scene breaks, centred
          figures, title pages. Today that measurement still catches an inline `style="text-align:center"`
          and an `[align=center]` attribute (both of which DO apply — they are not stylesheet rules), and
          it is what will keep the book's centred poetry intact once its stylesheet loads. */ ""}
    ${hardList(TEXT_BLOCKS)} {
      line-height: ${style.lineHeight} !important;
    }
    ${hardList(TEXT_BLOCKS, `:root:root.${ALIGN_GATE_CLASS}`, `${KEEP}${NEVER}`)} {
      text-align: ${style.align} !important;
    }
    /* keep the book's intentional alignment for headings etc. */
    [align="center"], center { text-align: center; }
    [align="right"] { text-align: right; }

    ${extras}
    ${diacriticsRule}
    ${themeBlock(theme, flags, style.textColor, style.pageColor)}
  `;
}

// RAWY-208: the @font-face slice, split OUT of buildReadingCss into its own sheet.
//
// WHY: buildReadingCss's output is what foliate's setStyles REPLACES on every geometry change
// (alignment, weight, leading, spacing, zoom, flow). While the faces were declared inside it, each of
// those changes re-declared them, the engine dropped and re-fetched the font files, and the text
// painted in a FALLBACK face until they came back — measured at ~35-45ms, long enough to read as a
// flash AND to re-wrap the lines (a fallback has different metrics). The faces were being re-declared
// even when the font had not changed at all: an alignment click cost 2 font re-fetches.
//
// This sheet therefore depends ONLY on the two font slots. FoliateController writes it into a
// dedicated <style data-sard-fonts> and rewrites it ONLY when arabicFont/latinFont actually change
// (FONT_STYLE_KEYS) — the same in-place discipline as the RAWY-140 paint sheet. A real font change
// still re-declares (and must: the src is new), which is the one case where a re-fetch is correct.
//
// Per-script @font-face injected INTO the foliate content. Variable built-ins (Literata, Noto Naskh)
// declare a weight RANGE so the weight control drives the real axis; Amiri ships two static files
// (regular + a real Bold). IMPORTED fonts (RAWY-44) omit the format() hint (so any ttf/otf/woff loads)
// and the weight descriptor (→ normal; bolder weights synth-bold), and carry the same unicode-range as
// their slot so script routing still works (an imported Arabic font in the Arabic slot renders Arabic).
export function buildFontFaceCss(style: ReadingStyle): string {
  // Resolve each slot to a source URL. Built-in → its bundled file; imported → its asset URL
  // (RAWY-44; falls back to the built-in default if the imported font is missing/unloaded).
  const latBuiltin = isBuiltinLatin(style.latinFont) ? LATIN_FONTS[style.latinFont] : undefined;
  const arBuiltin = isBuiltinArabic(style.arabicFont) ? ARABIC_FONTS[style.arabicFont] : undefined;
  const latSrc = absFontUrl(latBuiltin?.regular ?? importedFontUrl(style.latinFont) ?? LATIN_FONTS.literata.regular);
  const arSrc = absFontUrl(arBuiltin?.regular ?? importedFontUrl(style.arabicFont) ?? ARABIC_FONTS.amiri.regular);
  const latImported = !latBuiltin;
  const arImported = !arBuiltin;

  return `
    @font-face {
      font-family: 'SardArabic';
      src: url('${arSrc}')${arImported ? "" : " format('truetype')"};
      ${arImported ? "" : `font-weight: ${arBuiltin!.variable ? "100 900" : "normal"};`}
      unicode-range: ${ARABIC_RANGE};
    }
    ${
      arBuiltin?.bold && !arBuiltin.variable
        ? `@font-face {
      font-family: 'SardArabic';
      src: url('${absFontUrl(arBuiltin.bold)}') format('truetype');
      font-weight: bold;
      unicode-range: ${ARABIC_RANGE};
    }`
        : ""
    }
    @font-face {
      font-family: 'SardLatin';
      src: url('${latSrc}')${latImported ? "" : " format('truetype')"};
      ${latImported ? "" : `font-weight: ${latBuiltin!.variable ? "200 700" : "normal"};`}
      unicode-range: ${LATIN_RANGE};
    }`;
}

// RAWY-140: the PAINT-only slice of the reading CSS — the ink (per-book text colour / theme ink),
// the tashkīl (diacritics) rule, and the reading iframe's scrollbar tint. None of these touch
// geometry, so FoliateController pushes them through a dedicated in-book <style> updated IN PLACE
// (see `writeDynamic`/`applyDynamic`) instead of foliate's `setStyles`, which re-declares @font-face
// (a transient fallback-font flash) and re-runs `expand()` (a column re-layout → the visible jump).
// buildReadingCss still emits these SAME rules so a freshly-loaded section is inked on its first
// paint; the dynamic <style> is appended AFTER foliate's sheet, so a live colour/tashkīl change
// shadows the (now-stale) copy in the geometry sheet until the next geometry re-inject re-syncs them.
// Keep the ink/diacritics expressions here in step with `themeBlock` + `diacriticsRule` above.
export function buildDynamicCss(style: ReadingStyle, theme?: Theme, flags?: BookThemeFlags): string {
  const scrollInk = style.textColor || theme?.colors?.text || "currentColor";
  const diacriticsRule =
    style.diacritics === "dim"
      ? ".sard-tashkil { opacity: 0.28; }"
      : style.diacritics === "hide"
        ? ".sard-tashkil { font-size: 0 !important; }"
        : "";
  let inkCss = "";
  let pageCss = "";
  if (theme) {
    const c = theme.colors;
    const ink = style.textColor || c.text;
    const forceBg = (flags?.overrideBookColor ?? false) || theme.dark;
    const forceInk = forceBg || !!style.textColor;
    const ID = ":not(#__sard_never__)";
    const inkRules = `:root:root body${ID}, :root:root body${ID} *:not(a) { color: ${ink} !important; }
           :root:root body${ID} a, :root:root body${ID} a * { color: ${c.accent} !important; }`;
    // Matches themeBlock: forceInk → hard re-ink (the G-guarded placeholder colours in the geometry
    // sheet still beat this by specificity); otherwise a plain base colour the book's own CSS wins over.
    inkCss = forceInk ? inkRules : `html, body { color: ${ink}; }`;
    // RAWY-201: emit the PAGE background here too, so a per-book page-colour change repaints via this
    // dynamic sheet with NO reflow (RAWY-140) — this <style> is appended AFTER foliate's own sheet, so
    // its `html, body background` wins over themeBlock's at equal specificity (writeDynamic ordering).
    // ALWAYS emit it (custom colour OR the theme's own paperBg), exactly like the ink above: if we only
    // emitted it when custom, then CLEARING a custom colour on a book that OPENED with one would leave
    // the geometry sheet's stale value (that sheet isn't rewritten on a paint-only change). Emitting the
    // theme value when unset is byte-identical (same computed colour as themeBlock's rule). The forced
    // variant matches themeBlock's hardened rule so a custom page colour also wins under a dark/override
    // theme.
    // RAWY-265 (Phase 3): the page rides THIS sheet, so dragging the opacity slider repaints in place
    // with NO reflow — the same RAWY-140 route `pageColor` already uses. The container neutralisation
    // must be emitted here too, or a translucent page would be correct on a fresh section and wrong
    // the moment the reader moved the slider (this sheet shadows the geometry sheet until the next
    // re-inject). Same scoping as `themeBlock`: the neutraliser only, never the ink.
    const page = paperWithOpacity(style.pageColor || c.paperBg, flags?.pageOpacity);
    const translucent = (flags?.pageOpacity ?? 1) < 1;
    pageCss = forceBg
      ? `html, body { background: ${page} !important; }
         :root:root, :root:root body${ID} { background-color: ${page} !important; }`
      : translucent
        ? `html, body { background: ${page} !important; }
           :root:root, :root:root body${ID} { background-color: ${page} !important; }
           :root:root body${ID} * { background-color: transparent !important; }`
        : `html, body { background: ${page} !important; }`;
  }
  return `
    html, body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, ${scrollInk} 30%, transparent) transparent; }
    ${diacriticsRule}
    ${inkCss}
    ${pageCss}
  `;
}
