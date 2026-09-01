// PROFILES — what a profile IS, and the only way one is applied.
//
// A profile carries how Sard LOOKS. It does NOT carry how the reader READS: line spacing, measure,
// margins, paragraph spacing, tracking, alignment, first-line indent, diacritics, zoom, weight and
// flow stay in `reading_style` and `book_style:<id>`. Nothing in this file can write them, and
// `applyProfile` is written so that the boundary is a property of the code rather than a rule
// somebody has to remember: it patches the reading blob at exactly two fields, by name.
//
// THE `data` COLUMN IS THIS SHAPE. Rust treats it as opaque text, which is what keeps adding a
// visual field a code change instead of a migration — the same rule the background params blob
// follows. Parsing is therefore total: every field has a default, an unknown field is ignored, and
// a malformed blob yields a usable profile rather than an exception.

import {
  BOOKMARK_SIZE_MAX,
  BOOKMARK_SIZE_MIN,
  BOOKMARK_SHAPES,
  type BookmarkShapeKey,
} from "../../../lib/bookmarkStyle";
import {
  BG_DEFAULT_PARAMS,
  BG_NO_OVERLAY,
  presenceMaxFor,
  type BgParams,
  type BgSurface,
} from "../../../lib/background";
import { READ_MARKERS, type ReadMarkerKey } from "../../../lib/readMarkerStyle";
import { THEMES, isBuiltinThemeId } from "../../../theme/themes";
import type { BuiltinThemeId, CustomThemeId, Theme, ThemeColors } from "../../../theme/tokens";
import { HIGHLIGHT_SLOTS } from "../../../theme/tokens";
import { isHex, reliefRoom, withPanelRelief } from "./palette";
import {
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
  TTS_TRACKING_DEFAULTS,
  TTS_TRACKING_KEYS,
  ZOOM_MAX,
  ZOOM_MIN,
  type Align,
  type DiacriticsMode,
} from "../../../reader-engine/injectedCss";

/**
 * The shape version of the `data` blob. Bumped only if absence-defaulting ever stops being enough.
 *
 * 2 — `theme` became two palettes, `{ library, reading }`. Absence-defaulting still carries it: a
 * v1 blob has neither key, so the parser reads the OLD single palette and hands the same one to
 * both scopes. A v1 profile therefore renders exactly as it always did, and the two only diverge
 * once a reader edits one of them. The bump is bookkeeping for the package format, which reports
 * the version to a reader before an import — not a gate the parser needs.
 */
export const PROFILE_DATA_VERSION = 2;

export interface ProfileTheme {
  /** The preset this started from, for lineage and for "reset to it". `null` = built from scratch. */
  base: BuiltinThemeId | null;
  /** Authored, never inferred: it drives the highlight blend, the ink alpha and the title bar. */
  dark: boolean;
  colors: ThemeColors;
  highlightAlpha?: number;
  /** `null` = the accent. The same sentinel the reading style uses for "resolve from the theme". */
  bookmark: string | null;
  /** `null` = the glyph the theme would otherwise derive. */
  separator: string | null;
  /**
   * The ink the book's DIGITS take. `null` = the surrounding text's colour, which is what every
   * profile written before this says and what keeps them unchanged.
   */
  numbers: string | null;
  /**
   * How far the panels stand off the desk they sit on — signed lightness, panel minus desk.
   *
   * `null` = whatever the palette already says, which is what every profile written before this
   * means and why none of them move. A number takes the decision over; see `withPanelRelief`.
   *
   * READ BY THE LIBRARY ONLY. `profileTheme` applies it and `profileReadingTheme` does not, so a
   * value that somehow reached the reading palette still cannot alter a book page. The editor only
   * offers the control on the library chapter.
   *
   * It moves `chromeBg` and NOTHING else — not the desk, not the paper, and nothing whatever to do
   * with the library's background picture, which has its own settings and is not this control's
   * business.
   */
  relief: number | null;
}

export interface ProfileType {
  /** The interface face. `null` = Sard's own default stack. */
  ui: string | null;
  /** Book faces: a built-in registry key, or an imported family name. */
  arabic: string;
  latin: string;
  /** The reading measure a profile carries. Every field optional — see `ProfileTypography`. */
  reading: ProfileTypography;
}

/**
 * THE READING MEASURE, AS A PROFILE'S OPTIONAL OPINION.
 *
 * `null` EVERYWHERE IS THE WHOLE SAFETY PROPERTY, and it is the store's own idiom rather than a new
 * one: `patchReadingFonts` writes named fields into the raw `reading_style` blob and leaves the rest
 * absent, noting that "absent is how 'follow the default' is spelled". A `null` here is simply never
 * written, so a reader's own size and leading survive a profile switch untouched — which is how every
 * profile written before this behaves, with no migration and no stored defaults.
 *
 * These are the NINE the reading engine can actually honour, named exactly as `ReadingStyle` names
 * them so the patch is a field-for-field copy and the two cannot drift apart. `marginPx` is included
 * because the reader's own drawer offers it beside the rest of the measure.
 */
/**
 * THE READ-ALOUD MARKS, AS A PROFILE'S OPINION.
 *
 * WHY THIS ONE IS A BLOCK AND THE MEASURE IS A FIELD-BY-FIELD OPINION. Every typography field can say
 * "no opinion" on its own because `null` there has no other meaning. Here `null` is already taken: a
 * colour of `null` means "the theme's own terracotta", and an opacity of `null` means "the theme's own
 * band" — that is what `resolveSpotlight` reads, and it is how the «افتراضي» swatch is spelled. So
 * a per-field null could not also mean "leave the reader alone" without the two collapsing into each
 * other, and a profile could never say "put the marks back to the theme's default".
 *
 * The whole block is therefore the three-state: `null` for a هيئة that carries no opinion about
 * read-aloud — which is what every profile written before this says — and a complete set of
 * seven when it does.
 *
 * `null` MEANS "SARD'S OWN MARKS", NOT "WHATEVER IS THERE". Activating a هيئة writes all seven either
 * way (see `readingPatch`): its own when it has them, and the engine's defaults when it has not. A
 * هيئة is a complete look, so it cannot inherit the marks of the one worn before it. Nothing about a
 * STORED profile changed for this — `null` is still exactly what every profile written before this
 * chapter existed says; only what activating one asserts did.
 *
 * IT IS THE READING STYLE'S OWN TYPE. `Pick`ed from `ReadingStyle` through the defaults the engine
 * already publishes, so the patch is a field-for-field copy and a renamed field fails to compile here.
 */
export type ProfileVoice = typeof TTS_TRACKING_DEFAULTS;

/**
 * THE ENGINE'S OWN LIST, re-exported rather than repeated.
 *
 * The same seven names decide three things: what a هيئة carries, what activation writes, and what
 * `parseVoice` accepts. Written out three times they would drift on the day an eighth is added; named
 * once, an addition reaches all three or fails to compile.
 */
export const VOICE_KEYS: readonly (keyof ProfileVoice)[] = TTS_TRACKING_KEYS;

export interface ProfileTypography {
  zoom: number | null;
  /** The reading MEASURE, as the reader's own 0..1 fraction — see the note above `TYPOGRAPHY_KEYS`. */
  pageWidth: number | null;
  marginPx: number | null;
  lineHeight: number | null;
  letterSpacing: number | null;
  paragraphSpacing: number | null;
  fontWeight: number | null;
  firstLineIndent: boolean | null;
  align: Align | null;
  diacritics: DiacriticsMode | null;
}

/** Every key a profile may contribute, so the patch and the editor cannot fall out of step. */
/**
 * PAGE WIDTH IS HERE NOW, and the reversal is deliberate.
 *
 * It was excluded, and the exclusion was stated three times over: this list left it out, `package.ts`
 * refused any package carrying it, and the editor's own footer promised the reader that the measure
 * stayed theirs in every هيئة. That was coherent while a هيئة was a palette.
 *
 * It is not what a هيئة is any more. A هيئة is the complete reading preset — paper, faces, the
 * measure, the marks, the read-aloud cursor — so the width of the page is exactly the kind of
 * thing it should carry, and leaving it out made a هيئة that could set the MARGINS but not the page
 * they were measured against. The firewall it was defended by is dropped with it: `pageWidth` is no
 * longer a forbidden package key, so a shared هيئة carries the width it was designed at.
 *
 * IT IS THE SAME 0..1 FRACTION the reader's own control uses, mapped by `pageWidthPx`, so nothing
 * downstream has to learn a second unit; and it is `null` when the هيئة has no opinion, exactly like
 * every other field here.
 */
export const TYPOGRAPHY_KEYS = [
  "zoom", "pageWidth", "marginPx", "lineHeight", "letterSpacing",
  "paragraphSpacing", "fontWeight", "firstLineIndent", "align", "diacritics",
] as const;

export const EMPTY_TYPOGRAPHY: ProfileTypography = {
  zoom: null, pageWidth: null, marginPx: null, lineHeight: null, letterSpacing: null,
  paragraphSpacing: null, fontWeight: null, firstLineIndent: null, align: null, diacritics: null,
};

export interface ProfileMarks {
  bookmarkShape: BookmarkShapeKey;
  bookmarkSize: number;
  bookmarkPos: number;
  readMarker: ReadMarkerKey;
}

/**
 * One surface's background, as a profile carries it.
 *
 * `ref` is the content hash of an imported image, and it is the ONLY part of this the collector can
 * see — it is mirrored to the row's `bg_library` / `bg_reading` columns on save, because
 * `backgrounds::gc()` must be able to ask "is this image still referenced" without parsing `data`.
 * If a `ref` ever stops being mirrored, the image it names is deleted on the next surface bind.
 */
export interface ProfileSurfaceBg {
  ref: string | null;
  params: BgParams;
}

/**
 * The reading surface adds one thing the library does not have: the design's «الصورة نفسها · أهدأ» —
 * the same image as the library, at a quieter treatment. It resolves to the SAME content hash with
 * its own params, which costs nothing in storage; that is what content-addressing is for.
 */
export interface ProfileReadingBg extends ProfileSurfaceBg {
  sameAsLibrary: boolean;
  /**
   * The colour layer over the reading picture — the SAME three states the Reader's own control has,
   * read by the same `bgOverlayOf`: `null` is the theme's desk colour, `"none"` is no layer at all,
   * a hex is that colour.
   *
   * It lives here so the appearance editor can offer the choice, and it is written into the reading
   * style on activation the way the number ink is: one stored meaning, two places to set it, never
   * two interpretations. The LIBRARY's background has no such field and is not touched by this.
   */
  overlay: string | null;
}

/** Interface texture: three named steps, never a percentage. The design is explicit about that. */
export type TextureStep = "opaque" | "light" | "glass";

export const TEXTURE_STEPS: readonly TextureStep[] = ["opaque", "light", "glass"] as const;

/**
 * The alpha each step asks for.
 *
 * `glass` is 0.78 — the design's own value — and the measured binding floor is 0.800, so 0.78 is
 * below it at the extreme end of one slider. It is NOT clamped here: the floor depends on the live
 * desk scrim, which is a runtime value, so the clamp belongs where that is known. See
 * `effectiveTextureAlpha`. `opaque` is 1 and writes nothing at all, which is what keeps an untouched
 * profile byte-identical to today.
 */
export const TEXTURE_ALPHA: Record<TextureStep, number> = {
  opaque: 1,
  light: 0.92,
  glass: 0.78,
};

/**
 * How the seal is drawn, when a profile wears one.
 *
 * IN THE BLOB, NOT IN A COLUMN. `icon_kind` says WHICH of the three kinds a profile wears; this says
 * what the seal LOOKS like, which is appearance and therefore belongs with the rest of the
 * appearance. It also means no migration: the blob is parsed defensively, so a profile written
 * before this existed reads the defaults below and is byte-identical on screen to what it was.
 *
 * `face: "profile"` is that default — the seal follows the profile's own Arabic book face, which is
 * exactly what every seal did before there was a choice. The two named faces are the design's own.
 */
export interface ProfileSeal {
  face: "profile" | "arefRuqaa" | "amiri";
  glyph: "initial" | "diamond";
}

export const SEAL_FACES: readonly ProfileSeal["face"][] = ["profile", "arefRuqaa", "amiri"];
export const SEAL_GLYPHS: readonly ProfileSeal["glyph"][] = ["initial", "diamond"];

/**
 * How a picture is framed inside the square a mark is drawn in.
 *
 * IN THE BLOB, FOR THE SAME REASON THE SEAL IS. `icon_kind` and `icon_ref` are columns because the
 * collector must be able to ask "is this image still referenced" without parsing anything; how the
 * picture is FRAMED answers no such question, so it belongs with the rest of the appearance and
 * needs no migration. It is also per PROFILE and not per image: images are content-addressed and
 * deduped, so two profiles may share one row and must be able to frame it differently.
 *
 * `focalX` / `focalY` are the same vocabulary the surfaces already use for a background under
 * `cover` — the point of the picture that survives the crop, in percent.
 *
 * `scale` IS NOT CALLED `zoom`, AND THAT IS LOAD-BEARING. `zoom` is on the package firewall's
 * forbidden list, which matches key names at ANY depth (see `FORBIDDEN_DATA_KEYS`): a profile
 * carrying `icon.zoom` would export a package Sard itself refuses to import, naming a reading
 * setting the sender never set. `tests/unit/profilePackage.test.ts` pins that.
 */
export interface ProfileIcon {
  focalX: number;
  focalY: number;
  scale: number;
}

export const ICON_SCALE_MIN = 1;
export const ICON_SCALE_MAX = 3;

/**
 * Dead centre at `cover`, which is what every mark drawn before this already was — so a profile
 * that has never been framed reads this and is byte-identical on screen.
 */
export const ICON_FRAME_DEFAULT: ProfileIcon = { focalX: 50, focalY: 50, scale: 1 };

/** Whether a framing is still the default, for the reset control and for "write nothing new". */
export const isDefaultIconFrame = (i: ProfileIcon): boolean =>
  i.focalX === ICON_FRAME_DEFAULT.focalX &&
  i.focalY === ICON_FRAME_DEFAULT.focalY &&
  i.scale === ICON_FRAME_DEFAULT.scale;

/** The mark a `diamond` seal draws. The design's own character. */
export const SEAL_DIAMOND = "◆";

export interface ProfileData {
  v: number;
  /**
   * TWO PALETTES, ONE PROFILE — the Library's and the book page's.
   *
   * This was a single `ProfileTheme` written to BOTH `theme_id` and `book_theme_id`, which quietly
   * undid a separation the rest of the application already keeps: `theme/store.ts` calls `themeId`
   * "the LIBRARY (app chrome) theme" and `bookThemeId` the book's, and `setBookTheme` states that
   * `:root` is not touched. Measured, that decoupling works — changing the book theme alone left
   * the library's `--paper-bg` untouched — and only a profile forced the two together.
   *
   * `bg` above has been `{ library, reading }` since it was written, for the same reason. This
   * simply gives the palette the shape the backgrounds already had.
   */
  theme: { library: ProfileTheme; reading: ProfileTheme };
  type: ProfileType;
  marks: ProfileMarks;
  bg: { library: ProfileSurfaceBg; reading: ProfileReadingBg };
  /**
   * The read-aloud marks, or `null` for a هيئة that has no opinion about them. See `ProfileVoice`.
   */
  voice: ProfileVoice | null;
  texture: TextureStep;
  seal: ProfileSeal;
  /** How an image mark is framed. Meaningless — and ignored — for the other two kinds. */
  icon: ProfileIcon;
}

/** A profile as the app holds it: the row's own columns, plus the parsed blob. */
export interface Profile {
  id: CustomThemeId;
  name: string | null;
  description: string | null;
  author: string | null;
  iconKind: "seal" | "color" | "image";
  iconRef: string | null;
  derivedFrom: string | null;
  createdAt: number;
  updatedAt: number;
  data: ProfileData;
}

// ---- parsing: total, never throwing -------------------------------------------------------------

const pick = <T>(v: unknown, ok: (x: unknown) => boolean, fallback: T): T =>
  ok(v) ? (v as T) : fallback;

const hexOr = (v: unknown, fallback: string): string =>
  typeof v === "string" && isHex(v) ? v : fallback;

/** A colour that may legitimately carry alpha (border, selection). Accepts hex or `rgba()`. */
const washOr = (v: unknown, fallback: string): string =>
  typeof v === "string" && (isHex(v) || /^rgba?\([\d\s.,%]+\)$/.test(v)) ? v : fallback;

/**
 * Read a profile's typography, keeping `null` for anything absent, malformed or out of range.
 *
 * Deliberately NOT clamping: clamping would turn a nonsense value into a real override the reader
 * never asked for. Refusing it leaves the field null, and null is "leave the reader alone".
 */
function parseTypography(v: unknown): ProfileTypography {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number): number | null =>
    typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : null;
  return {
    zoom: num(o.zoom, ZOOM_MIN, ZOOM_MAX),
    // The reader's own 0..1 fraction. Anything outside it is not a measure this engine can honour, so
    // it reads as no opinion rather than being clamped into one.
    pageWidth: num(o.pageWidth, PAGE_WIDTH_MIN, PAGE_WIDTH_MAX),
    marginPx: num(o.marginPx, 0, 160),
    lineHeight: num(o.lineHeight, 1.2, 2.6),
    letterSpacing: num(o.letterSpacing, 0, 3),
    paragraphSpacing: num(o.paragraphSpacing, 0, 28),
    fontWeight: num(o.fontWeight, 300, 800),
    firstLineIndent: typeof o.firstLineIndent === "boolean" ? o.firstLineIndent : null,
    align: ALIGNS.includes(o.align as Align) ? (o.align as Align) : null,
    diacritics: DIACRITICS.includes(o.diacritics as DiacriticsMode) ? (o.diacritics as DiacriticsMode) : null,
  };
}

/**
 * Read a profile's read-aloud marks, or `null` when it carries none.
 *
 * ABSENT IS THE ANSWER FOR EVERY PROFILE WRITTEN BEFORE THIS, and it has to be distinguishable from a
 * block whose fields are all at their defaults — the first says "leave the reader's own marks
 * alone", the second says "these marks, which happen to be the defaults". So the object's PRESENCE is
 * the opinion, and a malformed one is read as absent rather than repaired into a real override.
 *
 * Within a present block each field is defaulted rather than refused: a hex that is not one, or an
 * opacity out of range, is a value that has drifted, and `TTS_TRACKING_DEFAULTS` is what the engine
 * would have drawn anyway. `null` survives as itself, because here it is a real value.
 */
function parseVoice(v: unknown): ProfileVoice | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const bool = (x: unknown, fallback: boolean): boolean => (typeof x === "boolean" ? x : fallback);
  const ink = (x: unknown): string | null => (typeof x === "string" && isHex(x) ? x : null);
  const alpha = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 1 ? x : null;
  return {
    ttsSpotlightOn: bool(o.ttsSpotlightOn, TTS_TRACKING_DEFAULTS.ttsSpotlightOn),
    ttsSpotlightColor: ink(o.ttsSpotlightColor),
    ttsSpotlightOpacity: alpha(o.ttsSpotlightOpacity),
    ttsSpotlightRule: bool(o.ttsSpotlightRule, TTS_TRACKING_DEFAULTS.ttsSpotlightRule),
    ttsKaraokeOn: bool(o.ttsKaraokeOn, TTS_TRACKING_DEFAULTS.ttsKaraokeOn),
    ttsKaraokeColor: ink(o.ttsKaraokeColor),
    ttsKaraokeOpacity: alpha(o.ttsKaraokeOpacity),
  };
}

const ALIGNS: readonly Align[] = ["justify", "start", "center", "end"];
const DIACRITICS: readonly DiacriticsMode[] = ["show", "dim", "hide"];

function parseColors(v: unknown, base: ThemeColors): ThemeColors {
  const o = (v ?? {}) as Record<string, unknown>;
  const hl = (o.highlight ?? {}) as Record<string, unknown>;
  return {
    paperBg: hexOr(o.paperBg, base.paperBg),
    surfaceBg: hexOr(o.surfaceBg, base.surfaceBg),
    chromeBg: hexOr(o.chromeBg, base.chromeBg),
    chromeBorder: washOr(o.chromeBorder, base.chromeBorder),
    text: hexOr(o.text, base.text),
    muted: hexOr(o.muted, base.muted),
    accent: hexOr(o.accent, base.accent),
    selection: washOr(o.selection, base.selection),
    highlight: Object.fromEntries(
      HIGHLIGHT_SLOTS.map((k) => [k, hexOr(hl[k], base.highlight[k])]),
    ) as ThemeColors["highlight"],
  };
}

const isShape = (v: unknown): boolean => BOOKMARK_SHAPES.some((s) => s.key === v);
const isMarker = (v: unknown): boolean => READ_MARKERS.some((m) => m.key === v);
const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * One palette, from whatever a blob happens to hold there.
 *
 * Lifted out of `parseProfileData` when `theme` became two, so both scopes are read by exactly the
 * same rules rather than by two copies that could drift.
 */
function parseOneTheme(t: Record<string, unknown>): ProfileTheme {
  const base: BuiltinThemeId = isBuiltinThemeId(t.base) ? t.base : "ivory";
  const baseTheme: Theme = THEMES[base];
  return {
    base: isBuiltinThemeId(t.base) ? t.base : null,
    dark: typeof t.dark === "boolean" ? t.dark : baseTheme.dark,
    colors: parseColors(t.colors, baseTheme.colors),
    highlightAlpha:
      typeof t.highlightAlpha === "number" ? t.highlightAlpha : baseTheme.highlightAlpha,
    bookmark: typeof t.bookmark === "string" && isHex(t.bookmark) ? t.bookmark : null,
    separator: typeof t.separator === "string" && t.separator.length <= 8 ? t.separator : null,
    numbers: typeof t.numbers === "string" && isHex(t.numbers) ? t.numbers : null,
    // Absent is the ONLY thing every blob written before this says, and it has to keep meaning
    // "leave the palette alone" — so this is `null` unless a number is actually there. Clamped to
    // THIS palette's own room, because the room is what the number means: a step past the end would
    // ask for a lightness that does not exist.
    relief: (() => {
      if (typeof t.relief !== "number" || !Number.isFinite(t.relief)) return null;
      const colors = parseColors(t.colors, baseTheme.colors);
      const room = reliefRoom(colors.surfaceBg);
      return Math.min(room.max, Math.max(room.min, t.relief));
    })(),
  };
}

/**
 * Parse a stored blob. Never throws.
 *
 * Missing fields take defaults and unknown fields are ignored — the "no migration, by construction"
 * rule. A blob written by a future Sard therefore imports and loses only what this version cannot
 * express, and a blob damaged on disk yields a plain, usable profile instead of a dead one.
 */
export function parseProfileData(raw: string): ProfileData {
  let o: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>;
  } catch {
    /* a damaged blob is a default profile, not an error */
  }
  /**
   * THE MIGRATION, AND IT IS THE PARSER — no pass, no rewrite, no version gate.
   *
   * A v1 blob's `theme` IS a palette: `{ base, dark, colors, ... }`. A v2 blob's `theme` HOLDS two:
   * `{ library, reading }`. They are told apart by the only thing that can distinguish them — the
   * presence of a scope key — and a v1 palette is then handed to BOTH scopes.
   *
   * That is what makes the change lossless: every profile written before this renders exactly as it
   * did, on both surfaces, until a reader deliberately edits one of them. It also keeps the file's
   * own rule intact ("missing fields take defaults ... the no-migration-by-construction rule"), and
   * it means a v2 blob opened by an older Sard degrades to the default palette rather than breaking.
   */
  const rawTheme = (o.theme ?? {}) as Record<string, unknown>;
  const twoScopes = rawTheme.library !== undefined || rawTheme.reading !== undefined;
  const asRec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const tLib = twoScopes ? asRec(rawTheme.library) : rawTheme;
  // `reading` falling back to `library` covers a hand-written or truncated blob that names only one.
  const tRead = twoScopes ? asRec(rawTheme.reading ?? rawTheme.library) : rawTheme;
  const ty = (o.type ?? {}) as Record<string, unknown>;
  const m = (o.marks ?? {}) as Record<string, unknown>;
  const bg = (o.bg ?? {}) as Record<string, unknown>;
  const bgLib = (bg.library ?? {}) as Record<string, unknown>;
  const bgRead = (bg.reading ?? {}) as Record<string, unknown>;

  return {
    v: typeof o.v === "number" ? o.v : PROFILE_DATA_VERSION,
    theme: { library: parseOneTheme(tLib), reading: parseOneTheme(tRead) },
    type: {
      ui: typeof ty.ui === "string" && ty.ui.trim() ? ty.ui : null,
      arabic: pick(ty.arabic, (x) => typeof x === "string" && !!x, "amiri"),
      latin: pick(ty.latin, (x) => typeof x === "string" && !!x, "literata"),
      // Absent reads as "this profile has no opinion", which is what every profile written before
      // typography existed meant. Out-of-range reads the same way rather than clamping: a value the
      // engine would refuse is not an opinion worth keeping.
      reading: parseTypography(ty.reading),
    },
    marks: {
      bookmarkShape: pick<BookmarkShapeKey>(m.bookmarkShape, isShape, "ribbon"),
      bookmarkSize: clampNum(m.bookmarkSize, BOOKMARK_SIZE_MIN, BOOKMARK_SIZE_MAX, 68),
      bookmarkPos: clampNum(m.bookmarkPos, 0, 1, 0.84),
      readMarker: pick<ReadMarkerKey>(m.readMarker, isMarker, "accentTrail"),
    },
    // Absent reads as "no image, default treatment" — which is what every profile written before
    // backgrounds existed meant, and it emits nothing downstream.
    bg: {
      library: { ref: refOr(bgLib.ref), params: parseBgParams(bgLib.params, "library") },
      reading: {
        ref: refOr(bgRead.ref),
        params: parseBgParams(bgRead.params, "reading"),
        sameAsLibrary: bgRead.sameAsLibrary === true,
        // Absent means the theme's own colour, which is what every profile written before this says.
        overlay:
          bgRead.overlay === BG_NO_OVERLAY
            ? BG_NO_OVERLAY
            : typeof bgRead.overlay === "string" && isHex(bgRead.overlay)
              ? bgRead.overlay
              : null,
      },
    },
    // Absent reads as "this هيئة has no opinion about the read-aloud marks" — what every profile
    // written before this chapter existed means, and what keeps a switch from repainting somebody's
    // reading cursor.
    voice: parseVoice(o.voice),
    texture: pick<TextureStep>(o.texture, (x) => TEXTURE_STEPS.includes(x as TextureStep), "opaque"),
    // Absent reads as "the profile's own face, and its initial" — what every seal drawn before this
    // existed already looked like, so nothing that is already saved changes appearance.
    seal: {
      face: pick<ProfileSeal["face"]>(
        (o.seal as Record<string, unknown> | undefined)?.face,
        (x) => SEAL_FACES.includes(x as ProfileSeal["face"]),
        "profile",
      ),
      glyph: pick<ProfileSeal["glyph"]>(
        (o.seal as Record<string, unknown> | undefined)?.glyph,
        (x) => SEAL_GLYPHS.includes(x as ProfileSeal["glyph"]),
        "initial",
      ),
    },
    // Absent reads as dead centre at `cover` — what every mark drawn before framing existed already
    // was — so nothing already saved moves. CLAMPED rather than refused, unlike the reading measure:
    // a framing out of range is not an opinion the engine would reject, it is a number that has
    // drifted, and the nearest legal framing is still a picture of the reader's own choice.
    icon: parseIcon(o.icon),
  };
}

function parseIcon(v: unknown): ProfileIcon {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    focalX: clampNum(o.focalX, 0, 100, ICON_FRAME_DEFAULT.focalX),
    focalY: clampNum(o.focalY, 0, 100, ICON_FRAME_DEFAULT.focalY),
    scale: clampNum(o.scale, ICON_SCALE_MIN, ICON_SCALE_MAX, ICON_FRAME_DEFAULT.scale),
  };
}

/**
 * A PROFILE'S NAME, AS IT MAY BE STORED.
 *
 * Two things, once, so every path agrees.
 *
 * ONE NAMELESS STATE. `createProfile` already wrote `name.trim() || null`, but `saveProfile` wrote
 * whatever the field held — so the editor could store `""` or `"   "` and the library then had
 * three different kinds of nameless profile, presented three different ways. Blank of any sort is
 * `null` from here on: the state that twelve of the reader's own profiles are already in.
 *
 * NO INVISIBLE DIRECTION CHANGES. A name is drawn in lists, in the switcher and in a dialog's
 * title, and an unbalanced bidi OVERRIDE reverses everything drawn after it — measured: a name
 * containing U+202E rendered its own tail backwards on the card, the switcher and the editor head
 * at once, and a U+0000 went into the database. The overrides and isolates (U+202A–U+202E,
 * U+2066–U+2069) and the C0/C1 control characters are removed.
 *
 * THE MARKS ARE KEPT. U+200E/U+200F and the zero-width joiners are ordinary parts of Arabic text
 * and are left exactly where the reader put them. Nothing else about a name is touched: no case
 * change, no collapsing of inner spaces, no length limit — a name that renders is a name.
 */
/**
 * A generous ceiling on a typed name — hygiene for the column, not a layout rule.
 *
 * MEASURED FIRST: a 322-character name renders in the editor's head across three lines with no
 * clipping, no overflow and no horizontal scroll at 820px, so nothing here is about what fits. It
 * exists so an accidental paste of a document into the field cannot put a novel in a name column.
 * Existing names are untouched — this bounds the INPUT, and nothing rewrites what is stored.
 */
export const PROFILE_NAME_MAX = 120;

export function cleanProfileName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const stripped = raw.replace(/[ ---‪-‮⁦-⁩]/g, "");
  const trimmed = stripped.trim();
  /**
   * BLANK MEANS NOTHING THE READER CAN SEE. `trim()` does not consider U+200F a space, so a name of
   * spaces and one right-to-left mark survived it — stored as a name, drawn as nothing, and it would
   * have slipped past the fallback that exists for exactly that. The marks are still KEPT inside a
   * real name; they simply cannot be all there is of one.
   */
  const visible = trimmed.replace(/[\s​-‏⁠﻿]/g, "");
  return visible === "" ? null : trimmed;
}

/**
 * What to show where a profile's name would go.
 *
 * ONE FALLBACK, not three. The card said «—», the switcher said «الهيئات» — the feature's own name,
 * so a nameless profile appeared to be called "Profiles" — and the editor's head said «هيئة». The
 * caller passes its own translated string so this file stays free of the i18n layer.
 */
export const profileLabel = (name: string | null | undefined, unnamed: string): string =>
  (name ?? "").trim() === "" ? unnamed : (name as string);

/** A background id is a content hash written by Rust; anything else is treated as absent. */
const refOr = (v: unknown): string | null =>
  typeof v === "string" && /^[a-f0-9]{8,64}$/i.test(v) ? v : null;

/**
 * Reuse the shipped defaults rather than restating them: a profile's treatment of an image is the
 * same treatment the surfaces already use, and duplicating the numbers here is how the two would
 * drift.
 */
/**
 * @param surface which surface these params belong to — PRESENCE HAS A DIFFERENT CEILING ON EACH.
 *
 * The reading presence may travel to 260 (RAWY-279): past 100 the theme's tint keeps fading until
 * the page all but settles on the original picture. The library's stops at 100, because its scrim is
 * a measured WCAG floor. This clamped BOTH to 100, so a book presence a reader had set above 100 was
 * silently reduced every time the profile was read back — the editor offered a range the parser
 * would not keep. Measured on the owner's own library: three profiles storing 224 and 260, all
 * loading as 100.
 */
function parseBgParams(v: unknown, surface: BgSurface): BgParams {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  return {
    presence: num(o.presence, 0, presenceMaxFor(surface), BG_DEFAULT_PARAMS.presence),
    blur: num(o.blur, 0, 40, BG_DEFAULT_PARAMS.blur),
    flip: typeof o.flip === "boolean" ? o.flip : BG_DEFAULT_PARAMS.flip,
    focalX: num(o.focalX, 0, 100, BG_DEFAULT_PARAMS.focalX),
    focalY: num(o.focalY, 0, 100, BG_DEFAULT_PARAMS.focalY),
    pageOpacity: num(o.pageOpacity, 0, 1, BG_DEFAULT_PARAMS.pageOpacity),
    immersiveBlur: typeof o.immersiveBlur === "boolean" ? o.immersiveBlur : BG_DEFAULT_PARAMS.immersiveBlur,
  };
}

export const serialiseProfileData = (d: ProfileData): string => JSON.stringify(d);

// ---- the theme a profile renders ----------------------------------------------------------------

/**
 * The `Theme` object a profile registers, under the profile's own id.
 *
 * One id, no mapping: a profile IS its theme as far as the rest of Sard is concerned, so
 * `resolveTheme(profile.id)` is all any consumer needs and there is no second table to keep in step.
 */
/**
 * THE READING PALETTE'S OWN ID.
 *
 * The registry maps one id to one theme, so a profile carrying two palettes needs two ids. The
 * library keeps `p.id` unchanged — every `theme_id` already stored on disk still resolves — and the
 * reading palette takes a suffix. `CustomThemeId` is `u:${string}` and `isThemeId` accepts any
 * `u:`-prefixed string, so this is a well-formed id and not a special case anything has to know
 * about: `resolveTheme` finds it in the same map as everything else.
 */
export const readingThemeId = (id: CustomThemeId): CustomThemeId => `${id}~r`;

/**
 * The library's colours with its panel depth applied — the ONE definition of that answer.
 *
 * Both the running app and the editor's own preview call this. The preview used to read
 * `theme.library.colors` straight, which is the shape of bug `--ui-k` was introduced to end: two
 * renderings of one setting, disagreeing, with nothing to show that they did.
 */
export function libraryColors(pt: ProfileTheme): ThemeColors {
  return pt.relief === null ? pt.colors : withPanelRelief(pt.colors, pt.relief);
}

/** The palette the LIBRARY wears — and the profile's own identity, which its card draws. */
export function profileTheme(p: Profile): Theme {
  const t = themeFrom(p, p.data.theme.library, p.id);
  return { ...t, colors: libraryColors(p.data.theme.library) };
}

/** The palette the BOOK PAGE wears. Identical to the library's until a reader parts them. */
export function profileReadingTheme(p: Profile): Theme {
  return themeFrom(p, p.data.theme.reading, readingThemeId(p.id));
}

function themeFrom(p: Profile, pt: ProfileTheme, id: CustomThemeId): Theme {
  return {
    id,
    // Shown wherever a theme names itself. A profile's name is text the reader typed — it is not
    // translatable and is displayed as written, which is also how an imported profile keeps the
    // name its author gave it.
    name: p.name?.trim() || "—",
    dark: pt.dark,
    colors: pt.colors,
    highlightAlpha: pt.highlightAlpha,
  };
}

// ---- what applying a profile is allowed to touch -------------------------------------------------

/**
 * THE WHITELIST. Every settings key a profile may write, and there are no others.
 *
 * Stated once, as data, so the boundary can be TESTED rather than trusted: a test snapshots the
 * whole settings table around an apply and asserts nothing outside this list moved.
 */
export const PROFILE_WRITES = [
  "theme_id",
  "book_theme_id",
  "ui_font",
  "bookmark_style",
  "bookmark_color",
  "bookmark_pos",
  "bookmark_size",
  "read_marker",
  "profile_active",
  // Backgrounds and texture. The two `*_id` keys are the surfaces' own bindings — a profile owns
  // what they point at, so applying one rebinds them; the collector counts both these keys and the
  // profile's columns, so an image is referenced twice over while a profile is active.
  "bg_library_id",
  "bg_reading_id",
  "bg_library_params",
  "bg_reading_params",
  "ui_texture",
] as const;

/**
 * EVERY READING VALUE A هيئة OWNS. The authoritative list, and the one the rest of the app derives.
 *
 * It began as two fields, then three, and for a long time it was declared here and consulted
 * NOWHERE: `driftOf` kept its own hand-written copy and the package firewall kept another. Both fell
 * behind, and each gap was a real defect — the measure could be changed from the reader without
 * the هيئة ever counting as edited, and a shared هيئة arrived without the size and the leading it was
 * designed at.
 *
 * Three things read this now, so they cannot disagree:
 *   · `readingPatch`  — what activating a هيئة writes, and what it clears
 *   · `session.ts`    — what counts as an unsaved change to the active هيئة
 *   · `package.ts`    — what may cross the border, and what is refused by name
 *
 * A field added here reaches all three; a `ReadingStyle` field NOT added here is refused at the
 * border and ignored by the rest, which is the safe direction for a list to fail in.
 */
export const PROFILE_READING_FIELDS = [
  "arabicFont", "latinFont", "numberColor", ...TYPOGRAPHY_KEYS, ...VOICE_KEYS,
] as const;

/**
 * What activating a هيئة does to the reading style: values to WRITE, and keys to CLEAR.
 *
 * TWO LISTS, BECAUSE "SARD'S OWN DEFAULT" IS NOT A VALUE. The patcher merges into the reader's blob,
 * so a field the هيئة does not name has to be actively removed for the default to show through —
 * omitting it leaves the PREVIOUS هيئة's value standing, which is the leak this shape exists to end.
 * Measured on a real library: one book's stored row wrote `marginPx: 136`, the هيئة worn over it
 * carried a measure but no margin of its own, and the reader read every book at 136px of margin
 * under a هيئة that never asked for it — a fifth of the page, unresponsive to text size because
 * a margin is not typographic.
 *
 * AND CLEARING IS WHY IT IS NOT A WRITE. `loadGlobalStyle` fills every absent field from
 * `defaultsForDir(dir)`, and those two sets DIFFER: zoom 1.15/1.0, line-height 1.9/1.6, align
 * start/justify. Writing a number would freeze ONE script's default into a row both scripts read, and
 * an Arabic book would open at the Latin baseline — the exact defect AUD-6 fixed. Absent is how this
 * model already spells "follow the default", and it stays direction-aware because it is resolved at
 * read time rather than at write time.
 */
export interface ReadingPatch {
  /** Fields to write, verbatim. `null` here is a real value the profile holds. */
  set: Record<string, unknown>;
  /** Keys to remove, so the engine's own per-script default resolves for them. */
  clear: string[];
}

export function readingPatch(p: Profile): ReadingPatch {
  const out: Record<string, unknown> = {
    arabicFont: p.data.type.arabic,
    latinFont: p.data.type.latin,
  };
  // THE NUMBER INK IS ALWAYS WRITTEN, null included — and it is the one field here that must be.
  //
  // Every typography field is OMITTED when the profile has no opinion, because omission is how the
  // reader's own value is left alone: those settings have a reading-drawer control of their own. The
  // number ink has none — a profile is its only source — so omitting it on clear left the previous
  // colour standing in `reading_style` forever. Measured: pressing «كلون النص», saving and reopening
  // the book still drew the digits in the old ink, because nothing ever told the blob to drop it.
  // Writing `null` is what "no override" means for a value only this screen can set.
  // THE DIGITS IN A BOOK, so the reading palette owns them — this is `readingPatch`, the reader's
  // own style by definition.
  out.numberColor = p.data.theme.reading.numbers;
  // THE OVERLAY OVER THE READING PICTURE, always written for the same reason the number ink is: the
  // profile is a saved configuration of how Sard looks, and omitting it on clear would leave the
  // previous choice standing in `reading_style` with nothing able to drop it. `null` is a real value
  // here — it means the theme's own colour — so writing it is what "follow the theme" persists as.
  out.backgroundColor = p.data.bg.reading.overlay;
  // THE PAGE COLOUR, ALWAYS WRITTEN, AND ALWAYS NULL — the third field here that must be, for the
  // same reason as the two above and with a sharper consequence.
  //
  // A profile has no `pageColor` field, and it should not: its opinion about what colour the page is
  // IS its reading paper, which travels as a palette. So the profile's position on this row is "no
  // page-colour override", and `null` is how that is spelled.
  //
  // Omitting it was not neutral. `reading_style.pageColor` is written only by the Reader's own
  // page-colour control, `.page-sheet` resolves `style.pageColor ?? readingTheme.colors.paperBg`, and
  // the profile's paper sits on the LOSING side of that. So one page colour, set once, outranked
  // every profile's reading paper for ever and no profile switch could reach it. Measured on the
  // owner's own configuration: a stored `#2C37BC` survived A -> B -> A with the book open and the
  // page never moved off it — the reading palette was simply unreachable.
  //
  // Writing null restores the documented order, with the active هيئة's reading paper below it. (The
  // per-book override that used to sit above both is gone with the book-style scope; there is one
  // reading style now.) A page colour chosen in the reading drawer still holds, and lasts until the
  // next هيئة switch — the same contract as the number ink and the overlay.
  out.pageColor = null;
  // THE MEASURE: every field, every time — the هيئة's own where it has one, and CLEARED where it has
  // not, so Sard's own default resolves instead of the last هيئة's value. A هيئة is the complete
  // reading appearance; it cannot be worn in another's margins.
  const r = p.data.type.reading;
  const clear: string[] = [];
  for (const k of TYPOGRAPHY_KEYS) {
    const v = r[k];
    if (v !== null && v !== undefined) out[k] = v;
    else clear.push(k);
  }
  // THE READ-ALOUD MARKS: ALWAYS ALL SEVEN, whether the هيئة carries an opinion or not.
  //
  // OMITTING THEM LEAKED ONE هيئة'S MARKS INTO ANOTHER, and that is the defect this closes. A patch
  // merges into the reader's blob, so a هيئة with no opinion wrote nothing and simply left whatever
  // the PREVIOUS هيئة had asserted standing: wearing A (green spotlight) and then B (no opinion) left
  // the reader reading B with A's green marks, and no gesture of theirs could have caused it. A هيئة
  // is a complete look, so activating one has to establish the whole of it.
  //
  // WHAT "NO OPINION" IS WORTH WRITING is not invented here. `loadGlobalStyle` fills every field the
  // blob does not carry from `defaultsForDir`, into which `TTS_TRACKING_DEFAULTS` is spread — so
  // "absent" and "these seven values" are the same effective state to the reading engine, and this is
  // the model's own spelling of "follow the default" rather than a second one. The constant is spread
  // at call time, so a change to the engine's defaults reaches these هيئات too.
  //
  // IT IS THE SHAPE `pageColor` ALREADY HAS, for the reason recorded above it: a value only these
  // screens can set must be able to say "back to Sard's own", and a field that is merely omitted has
  // no way to say it. The consequence is the same one that field already documents — a mark chosen
  // in the reading drawer holds until the next هيئة switch, and a هيئة carrying its own marks then
  // restores them exactly.
  //
  // The READ-ALOUD MARKS stay a WRITE rather than a clear, and the difference is not an inconsistency:
  // `TTS_TRACKING_DEFAULTS` is identical in both per-script sets, so writing them and clearing them
  // are the same effective state — and writing keeps `null` available as the real value it is there
  // ("the theme's own colour"), which absence could not express.
  const voice = p.data.voice ?? TTS_TRACKING_DEFAULTS;
  for (const k of VOICE_KEYS) out[k] = voice[k];
  return { set: out, clear };
}

/** The settings a profile writes, as key/value pairs, ready to persist. */
export function profileSettings(p: Profile): Array<[string, string]> {
  // THE BOOKMARK IS THE READER'S. It is drawn on a book, so it takes the reading palette's own
  // bookmark colour and falls back to that palette's accent.
  const bookmarkColor = p.data.theme.reading.bookmark ?? p.data.theme.reading.colors.accent;
  // "The same image, quieter" resolves to the LIBRARY's hash with the reading surface's own params.
  // One image on disk, two treatments — which is the whole point of addressing by content.
  const readingRef = p.data.bg.reading.sameAsLibrary
    ? p.data.bg.library.ref
    : p.data.bg.reading.ref;
  return [
    ["theme_id", p.id],
    // TWO IDS NOW, and this line is the whole of the fix. It wrote `p.id` to both, which forced the
    // book page to wear the library's palette and undid the separation the theme store keeps.
    ["book_theme_id", readingThemeId(p.id)],
    ["ui_font", p.data.type.ui ?? ""],
    ["bookmark_style", p.data.marks.bookmarkShape],
    ["bookmark_color", bookmarkColor],
    ["bookmark_pos", String(p.data.marks.bookmarkPos)],
    ["bookmark_size", String(p.data.marks.bookmarkSize)],
    ["read_marker", p.data.marks.readMarker],
    ["bg_library_id", p.data.bg.library.ref ?? ""],
    ["bg_reading_id", readingRef ?? ""],
    ["bg_library_params", JSON.stringify(p.data.bg.library.params)],
    ["bg_reading_params", JSON.stringify(p.data.bg.reading.params)],
    ["ui_texture", p.data.texture],
    ["profile_active", p.id],
  ];
}

/**
 * The two ids the collector must see, as the row's own columns.
 *
 * SEPARATE FROM `profileSettings` ON PURPOSE. Those are settings a profile writes when it is
 * APPLIED; these are columns that must be true whenever the profile EXISTS, active or not. A
 * profile nobody is using still owns its image, and the collector still has to know.
 */
export function profileRefs(p: Profile): { bgLibrary: string | null; bgReading: string | null } {
  return {
    bgLibrary: p.data.bg.library.ref,
    bgReading: p.data.bg.reading.sameAsLibrary
      ? p.data.bg.library.ref
      : p.data.bg.reading.ref,
  };
}
