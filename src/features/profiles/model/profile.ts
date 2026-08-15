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

export interface ProfileData {
  v: number;
  theme: ProfileTheme;
  type: ProfileType;
  marks: ProfileMarks;
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
  return [
    ["theme_id", p.id],
    ["book_theme_id", p.id],
    ["ui_font", p.data.type.ui ?? ""],
    ["bookmark_style", p.data.marks.bookmarkShape],
    ["bookmark_color", bookmarkColor],
    ["bookmark_pos", String(p.data.marks.bookmarkPos)],
    ["bookmark_size", String(p.data.marks.bookmarkSize)],
    ["read_marker", p.data.marks.readMarker],
    ["profile_active", p.id],
  ];
}
