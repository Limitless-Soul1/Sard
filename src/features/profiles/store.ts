// PROFILES — loading, switching, and the one place a profile is applied.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP. Applying a profile writes the keys in `PROFILE_WRITES` and
// patches `reading_style` at exactly `arabicFont` and `latinFont`. It touches nothing else, and in
// particular it never reads, writes or deletes a `book_style:<id>` row. A profile carries how Sard
// looks; the reader's layout and their per-book work are theirs.
//
// STARTUP ORDER MATTERS, ONCE. `initProfiles` registers every profile's theme with the resolver, so
// it must finish before `initTheme` applies a persisted `theme_id` that may name one. App.tsx awaits
// it for that reason and no other.

import { create } from "zustand";

import {
  PROFILE_ACTIVE_KEY,
  profileDelete,
  profileImportCommit,
  profileSave,
  profilesList,
  settingsGet,
  settingsSet,
  type ProfileRow,
} from "../../lib/ipc";
import { useBookmarkStyle } from "../../lib/bookmarkStyle";
import { useBackground } from "../../lib/background";
import { applyTexture } from "../../lib/texture";
import { useFonts } from "../../lib/fonts";
import { useReadMarkerStyle } from "../../lib/readMarkerStyle";
import { useReader } from "../../reader-engine/store";
import { applyTheme } from "../../theme/applyTheme";
import { resolveTheme, setCustomThemes } from "../../theme/resolve";
import { useTheme } from "../../theme/store";
import type { CustomThemeId, Theme } from "../../theme/tokens";
import {
  PROFILE_DATA_VERSION,
  parseProfileData,
  profileRefs,
  profileSettings,
  profileTheme,
  readingPatch,
  serialiseProfileData,
  type Profile,
  type ProfileData,
} from "./model/profile";

const READING_KEY = "reading_style";

// ---- row <-> profile --------------------------------------------------------------------------

const iconKindOf = (v: string | null): Profile["iconKind"] =>
  v === "color" || v === "image" ? v : "seal";

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id as CustomThemeId,
    name: r.name,
    description: r.description,
    author: r.author,
    iconKind: iconKindOf(r.icon_kind),
    iconRef: r.icon_ref,
    derivedFrom: r.derived_from,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    data: parseProfileData(r.data),
  };
}

function toRow(p: Profile): ProfileRow {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    author: p.author,
    icon_kind: p.iconKind,
    icon_ref: p.iconRef,
    data: serialiseProfileData(p.data),
    derived_from: p.derivedFrom,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    // MIRRORED FROM `data`, and this is the line the collector depends on. `backgrounds::gc()` reads
    // these columns and nothing else of the profile; if a ref lives in `data` but not here, the image
    // it names is deleted the next time any surface is bound.
    ...(({ bgLibrary, bgReading }) => ({ bg_library: bgLibrary, bg_reading: bgReading }))(
      profileRefs(p),
    ),
  };
}

// ---- the store ----------------------------------------------------------------------------------

interface ProfilesState {
  ready: boolean;
  profiles: Profile[];
  /** The active profile's id, or `null` when Sard is running on its own settings. */
  activeId: CustomThemeId | null;
  byId: (id: string) => Profile | undefined;
}

export const useProfiles = create<ProfilesState>((_set, get) => ({
  ready: false,
  profiles: [],
  activeId: null,
  byId: (id) => get().profiles.find((p) => p.id === id),
}));

/** Register every profile's theme so `resolveTheme` can find it. Replaces wholesale. */
function registerThemes(profiles: Profile[]): void {
  const m = new Map<CustomThemeId, Theme>();
  for (const p of profiles) m.set(p.id, profileTheme(p));
  setCustomThemes(m);
}

/**
 * Load profiles and register their themes.
 *
 * MUST COMPLETE BEFORE `initTheme`. A persisted `theme_id` may name a profile, and the resolver can
 * only answer once the theme is registered; otherwise the first paint falls back and then corrects
 * itself, which is a visible flash of the wrong paper.
 */
export async function initProfiles(): Promise<void> {
  const [rows, active] = await Promise.all([
    profilesList().catch(() => [] as ProfileRow[]),
    settingsGet(PROFILE_ACTIVE_KEY).catch(() => null),
  ]);
  const profiles = (rows ?? []).map(toProfile);
  registerThemes(profiles);
  const activeId = profiles.some((p) => p.id === active) ? (active as CustomThemeId) : null;
  useProfiles.setState({ ready: true, profiles, activeId });

  // TEXTURE IS DERIVED, SO IT HAS TO BE RE-DERIVED HERE. Every other profile-owned value is a
  // persisted setting whose own store reads it back at startup; the texture ALPHA is deliberately
  // not persisted — it depends on the live scrim and the active theme — so nothing else would
  // restore it, and a `glass` profile would come back opaque after a restart. Caught by running it.
  const activeProfile = activeId ? profiles.find((p) => p.id === activeId) : undefined;
  if (activeProfile) applyTexture(activeProfile.data.texture, profileTheme(activeProfile).colors);

  // THE SESSION LAYER'S GUARANTEE, KEPT HERE. A value the reader changed outside the editor and
  // chose to keep "for this session only" was written to settings by the ordinary setter — the
  // shared setters are deliberately untouched, because a reader with no profiles must behave exactly
  // as before. So the drift is undone at the START of the next session instead: the active profile
  // re-asserts its own four values, and whatever the last sitting drifted to is simply not there.
  //
  // AT STARTUP RATHER THAN AT SHUTDOWN, deliberately. A quit hook cannot survive a crash or a kill,
  // and a guarantee that holds only on a clean exit is not one. This runs before `initTheme`, whose
  // reads then see the profile's values rather than the drift.
  if (activeProfile) await reassertProfileValues(activeProfile);
}

/**
 * Write the active profile's four externally-changeable values back over any session drift.
 *
 * Only those four. Everything else a profile owns is unreachable from outside its editor, so there
 * is nothing to re-assert — and rewriting more would turn a targeted guarantee into a broad one
 * nobody asked for.
 */
async function reassertProfileValues(p: Profile): Promise<void> {
  await settingsSet("theme_id", p.id).catch(console.error);
  await settingsSet("book_theme_id", p.id).catch(console.error);
  await patchReadingFonts(p.data.type.arabic, p.data.type.latin);
}

/** Re-read from the database. Used after any write, so the store is never a second source of truth. */
export async function refreshProfiles(): Promise<void> {
  const rows = await profilesList().catch(() => [] as ProfileRow[]);
  const profiles = (rows ?? []).map(toProfile);
  registerThemes(profiles);
  useProfiles.setState({ profiles });
}

// ---- applying -----------------------------------------------------------------------------------

/**
 * Patch `reading_style` at exactly two fields, preserving the other twenty-seven.
 *
 * Reads the raw blob rather than going through `loadGlobalStyle`, deliberately: that helper fills in
 * every absent field from the per-script defaults, so writing its result back would MATERIALISE
 * defaults the reader never chose into their row. Patching the raw text leaves absent fields absent,
 * and absent is how "follow the default" is spelled.
 */
async function patchReadingFonts(arabicFont: string, latinFont: string): Promise<void> {
  const raw = await settingsGet(READING_KEY).catch(() => null);
  let blob: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") blob = parsed as Record<string, unknown>;
    } catch {
      /* an unreadable row is replaced by the two fields alone, not by a whole default style */
    }
  }
  blob.arabicFont = arabicFont;
  blob.latinFont = latinFont;
  await settingsSet(READING_KEY, JSON.stringify(blob)).catch(console.error);
}

/**
 * Make a profile the active one: persist it, and repaint what is already on screen.
 *
 * The store updates below are `setState`, not the stores' own setters, because the setters persist
 * as a side effect and the persisting has already happened here — through the whitelist, once.
 */
export async function applyProfile(p: Profile): Promise<void> {
  for (const [k, v] of profileSettings(p)) await settingsSet(k, v).catch(console.error);
  const { arabicFont, latinFont } = readingPatch(p);
  await patchReadingFonts(arabicFont, latinFont);

  const theme = profileTheme(p);
  setCustomThemes(new Map(useProfiles.getState().profiles.map((x) => [x.id, profileTheme(x)])));
  applyTheme(theme);
  useTheme.setState({ themeId: p.id, bookThemeId: p.id });

  useFonts.setState({ uiFont: p.data.type.ui });
  applyUiFont(p.data.type.ui);

  useBookmarkStyle.setState({
    shape: p.data.marks.bookmarkShape,
    color: p.data.theme.bookmark ?? p.data.theme.colors.accent,
    pos: p.data.marks.bookmarkPos,
    size: p.data.marks.bookmarkSize,
  });
  useReadMarkerStyle.setState({ marker: p.data.marks.readMarker });

  // TEXTURE, derived rather than stored. The profile carries the STEP; what it renders as depends on
  // the live desk scrim and the active theme, so the alpha is computed here on every application and
  // never persisted. `opaque` removes the variable entirely.
  applyTexture(p.data.texture, theme.colors);

  useProfiles.setState({ activeId: p.id });
}

/** The `--ui-font` write, mirroring `lib/fonts.ts` without re-persisting. */
function applyUiFont(family: string | null): void {
  const root = document.documentElement;
  if (family && family.trim()) {
    root.style.setProperty(
      "--ui-font",
      `"${family}", "SardUILatin", "SardUIArabic", system-ui, "Segoe UI", sans-serif`,
    );
  } else {
    root.style.removeProperty("--ui-font");
  }
}

// ---- creating, duplicating, deleting -------------------------------------------------------------

const newId = (): CustomThemeId =>
  `u:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` as CustomThemeId;

/** Everything Sard looks like right now, as a profile's worth of data. */
export async function captureCurrent(): Promise<ProfileData> {
  const t = useTheme.getState();
  const theme = resolveActiveTheme();
  const fonts = useFonts.getState();
  const bm = useBookmarkStyle.getState();
  const rm = useReadMarkerStyle.getState();
  const bgs = useBackground.getState();
  const reading = await currentReadingFonts();
  return {
    v: PROFILE_DATA_VERSION,
    theme: {
      base: typeof t.bookThemeId === "string" && !t.bookThemeId.startsWith("u:") ? (t.bookThemeId as never) : null,
      dark: theme.dark,
      colors: theme.colors,
      highlightAlpha: theme.highlightAlpha,
      bookmark: bm.color,
      separator: null,
    },
    type: { ui: fonts.uiFont, arabic: reading.arabicFont, latin: reading.latinFont },
    marks: {
      bookmarkShape: bm.shape,
      bookmarkSize: bm.size,
      bookmarkPos: bm.pos,
      readMarker: rm.marker,
    },
    // "How Sard looks now" has to mean it: the surfaces' current images and their treatments come
    // along. `sameAsLibrary` is not inferred from the two ids matching — it is an authored choice,
    // and a reader who happened to pick one image for both surfaces did not ask for them to be
    // linked from then on.
    bg: {
      library: { ref: bgs.library?.id ?? null, params: { ...bgs.libraryParams } },
      reading: {
        ref: bgs.reading?.id ?? null,
        params: { ...bgs.readingParams },
        sameAsLibrary: false,
      },
    },
    // Texture has no global setting to capture: today every surface is opaque, and `opaque` writes
    // nothing, so a profile made from "how Sard looks now" is byte-identical to today.
    texture: "opaque",
  };
}

/** The live theme object, whichever kind it is. */
function resolveActiveTheme(): Theme {
  return resolveTheme(useTheme.getState().bookThemeId);
}

/**
 * The two book faces currently in force.
 *
 * Read from the READER's live style when a book is open, and from the persisted global row when one
 * is not — capture has to work from the Library, which is where the reader will usually be standing
 * when they decide to keep how Sard looks.
 */
async function currentReadingFonts(): Promise<{ arabicFont: string; latinFont: string }> {
  const live = useReader.getState().style;
  if (live) return { arabicFont: live.arabicFont, latinFont: live.latinFont };
  const raw = await settingsGet(READING_KEY).catch(() => null);
  const base = { arabicFont: "amiri", latinFont: "literata" };
  if (!raw) return base;
  try {
    const s = JSON.parse(raw) as Partial<{ arabicFont: string; latinFont: string }>;
    return {
      arabicFont: typeof s.arabicFont === "string" ? s.arabicFont : base.arabicFont,
      latinFont: typeof s.latinFont === "string" ? s.latinFont : base.latinFont,
    };
  } catch {
    return base;
  }
}

export async function createProfile(name: string, data: ProfileData, derivedFrom: string | null): Promise<Profile> {
  const now = Math.floor(Date.now() / 1000);
  const p: Profile = {
    id: newId(),
    name: name.trim() || null,
    description: null,
    author: null,
    iconKind: "seal",
    iconRef: null,
    derivedFrom,
    createdAt: now,
    updatedAt: now,
    data,
  };
  await profileSave(toRow(p));
  await refreshProfiles();
  return p;
}

export async function saveProfile(p: Profile): Promise<void> {
  await profileSave(toRow(p));
  await refreshProfiles();
  if (useProfiles.getState().activeId === p.id) await applyProfile(p);
}

/**
 * Commit an inspected package as a new local profile.
 *
 * THE ID IS MINTED HERE, beside every other id this app makes, and handed to Rust rather than
 * generated there — one place decides what a profile id looks like. Rust re-checks the manifest
 * regardless: `commit` is the boundary, and it does not trust that inspection happened.
 */
export async function importProfile(manifestJson: string): Promise<Profile> {
  const row = await profileImportCommit(manifestJson, newId());
  await refreshProfiles();
  return toProfile(row);
}

export async function duplicateProfile(p: Profile, name: string): Promise<Profile> {
  return createProfile(name, structuredClone(p.data), p.id);
}

/**
 * Delete a profile.
 *
 * If it was active, Sard falls back to its own settings — the profile's theme id is dropped from
 * `theme_id` so nothing keeps naming something that no longer exists. Books, quotes and the
 * reader's own layout are untouched, which is what the confirmation promises.
 */
export async function removeProfile(p: Profile, fallback: string): Promise<void> {
  const wasActive = useProfiles.getState().activeId === p.id;
  await profileDelete(p.id);
  await refreshProfiles();
  if (wasActive) {
    await settingsSet(PROFILE_ACTIVE_KEY, "").catch(console.error);
    await settingsSet("theme_id", fallback).catch(console.error);
    await settingsSet("book_theme_id", fallback).catch(console.error);
    useProfiles.setState({ activeId: null });
  }
}
