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
import { BG_DEFAULT_PARAMS, type BgParams } from "../../../lib/background";
import { READ_MARKERS, type ReadMarkerKey } from "../../../lib/readMarkerStyle";
import { THEMES, isBuiltinThemeId } from "../../../theme/themes";
import type { BuiltinThemeId, CustomThemeId, Theme, ThemeColors } from "../../../theme/tokens";
import { HIGHLIGHT_SLOTS } from "../../../theme/tokens";
import { isHex } from "./palette";

/** The shape version of the `data` blob. Bumped only if absence-defaulting ever stops being enough. */
export const PROFILE_DATA_VERSION = 1;

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
}

export interface ProfileType {
  /** The interface face. `null` = Sard's own default stack. */
  ui: string | null;
  /** Book faces: a built-in registry key, or an imported family name. */
  arabic: string;
  latin: string;
}

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

export interface ProfileData {
  v: number;
  theme: ProfileTheme;
  type: ProfileType;
  marks: ProfileMarks;
  bg: { library: ProfileSurfaceBg; reading: ProfileReadingBg };
  texture: TextureStep;
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
  const t = (o.theme ?? {}) as Record<string, unknown>;
  const base: BuiltinThemeId = isBuiltinThemeId(t.base) ? t.base : "ivory";
  const baseTheme: Theme = THEMES[base];
  const ty = (o.type ?? {}) as Record<string, unknown>;
  const m = (o.marks ?? {}) as Record<string, unknown>;
  const bg = (o.bg ?? {}) as Record<string, unknown>;
  const bgLib = (bg.library ?? {}) as Record<string, unknown>;
  const bgRead = (bg.reading ?? {}) as Record<string, unknown>;

  return {
    v: typeof o.v === "number" ? o.v : PROFILE_DATA_VERSION,
    theme: {
      base: isBuiltinThemeId(t.base) ? t.base : null,
      dark: typeof t.dark === "boolean" ? t.dark : baseTheme.dark,
      colors: parseColors(t.colors, baseTheme.colors),
      highlightAlpha:
        typeof t.highlightAlpha === "number" ? t.highlightAlpha : baseTheme.highlightAlpha,
      bookmark: typeof t.bookmark === "string" && isHex(t.bookmark) ? t.bookmark : null,
      separator: typeof t.separator === "string" && t.separator.length <= 8 ? t.separator : null,
    },
    type: {
      ui: typeof ty.ui === "string" && ty.ui.trim() ? ty.ui : null,
      arabic: pick(ty.arabic, (x) => typeof x === "string" && !!x, "amiri"),
      latin: pick(ty.latin, (x) => typeof x === "string" && !!x, "literata"),
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
      library: { ref: refOr(bgLib.ref), params: parseBgParams(bgLib.params) },
      reading: {
        ref: refOr(bgRead.ref),
        params: parseBgParams(bgRead.params),
        sameAsLibrary: bgRead.sameAsLibrary === true,
      },
    },
    texture: pick<TextureStep>(o.texture, (x) => TEXTURE_STEPS.includes(x as TextureStep), "opaque"),
  };
}

/** A background id is a content hash written by Rust; anything else is treated as absent. */
const refOr = (v: unknown): string | null =>
  typeof v === "string" && /^[a-f0-9]{8,64}$/i.test(v) ? v : null;

/**
 * Reuse the shipped defaults rather than restating them: a profile's treatment of an image is the
 * same treatment the surfaces already use, and duplicating the numbers here is how the two would
 * drift.
 */
function parseBgParams(v: unknown): BgParams {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  return {
    presence: num(o.presence, 0, 100, BG_DEFAULT_PARAMS.presence),
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
export function profileTheme(p: Profile): Theme {
  return {
    id: p.id,
    // Shown wherever a theme names itself. A profile's name is text the reader typed — it is not
    // translatable and is displayed as written, which is also how an imported profile keeps the
    // name its author gave it.
    name: p.name?.trim() || "—",
    dark: p.data.theme.dark,
    colors: p.data.theme.colors,
    highlightAlpha: p.data.theme.highlightAlpha,
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
 * The ONLY two fields of `reading_style` a profile touches.
 *
 * The other twenty-seven are the reader's own. Naming these two here, rather than spreading a whole
 * object over the row, is what makes it impossible for a profile to carry line spacing home by
 * accident — the patch cannot express a field that is not in this list.
 */
export const PROFILE_READING_FIELDS = ["arabicFont", "latinFont"] as const;

/** The reading-style patch a profile contributes. Exactly two fields, always. */
export function readingPatch(p: Profile): { arabicFont: string; latinFont: string } {
  return { arabicFont: p.data.type.arabic, latinFont: p.data.type.latin };
}

/** The settings a profile writes, as key/value pairs, ready to persist. */
export function profileSettings(p: Profile): Array<[string, string]> {
  const bookmarkColor = p.data.theme.bookmark ?? p.data.theme.colors.accent;
  // "The same image, quieter" resolves to the LIBRARY's hash with the reading surface's own params.
  // One image on disk, two treatments — which is the whole point of addressing by content.
  const readingRef = p.data.bg.reading.sameAsLibrary
    ? p.data.bg.library.ref
    : p.data.bg.reading.ref;
  return [
    ["theme_id", p.id],
    ["book_theme_id", p.id],
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
