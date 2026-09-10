// PROFILES — loading, switching, and the one place a profile is applied.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP. Applying a هيئة writes the settings keys in
// `PROFILE_WRITES` and patches `reading_style` at exactly the fields `PROFILE_READING_FIELDS` names —
// asserting the ones it holds and CLEARING the rest, so nothing of the previous هيئة survives. It
// touches nothing else, and in particular it never reads, writes or deletes a `book_style:<id>` row:
// a هيئة is the complete reading preset, and there is no second, per-book owner to negotiate with.
//
// STARTUP ORDER MATTERS, ONCE. `initProfiles` registers every profile's theme with the resolver, so
// it must finish before `initTheme` applies a persisted `theme_id` that may name one. App.tsx awaits
// it for that reason and no other.

import { create } from "zustand";

import { LANG_KEY, translate, type Lang } from "../../i18n";

import {
  PROFILE_ACTIVE_KEY,
  profileDelete,
  profileImportCommit,
  profileSave,
  profileTouch,
  profilesList,
  settingsGet,
  settingsSet,
  type ProfileRow,
} from "../../lib/ipc";
import {
  BOOKMARK_DEFAULT_COLOR, BOOKMARK_DEFAULT_POS, BOOKMARK_DEFAULT_SHAPE, BOOKMARK_DEFAULT_SIZE,
  initBookmarkStyle, useBookmarkStyle,
} from "../../lib/bookmarkStyle";
import { BG_DEFAULT_PARAMS, applyBackgrounds, initBackground, useBackground } from "../../lib/background";
import { applyTexture } from "../../lib/texture";
import { applyUiFontVar, initFonts, useFonts } from "../../lib/fonts";
import { READ_MARKER_DEFAULT, initReadMarkerStyle, useReadMarkerStyle } from "../../lib/readMarkerStyle";
import { PAGE_WIDTH_DEFAULT, type ReadingStyle } from "../../reader-engine/injectedCss";
import { useReader } from "../../reader-engine/store";
import { noteGlobalStyleRow, peekGlobalStyle, primeGlobalStyle } from "../reader/perBookSettings";
import { applyTheme } from "../../theme/applyTheme";
import { resolveTheme, setCustomThemes } from "../../theme/resolve";
import { DEFAULT_LIGHT, THEMES } from "../../theme/themes";
import { initTheme, useTheme } from "../../theme/store";
import type { CustomThemeId, Theme, ThemeId } from "../../theme/tokens";
import {
  ICON_FRAME_DEFAULT,
  PROFILE_DATA_VERSION,
  cleanProfileName,
  parseProfileData,
  profileRefs,
  profileSettings,
  profileTheme,
  profileReadingTheme,
  readingThemeId,
  type ProfileTheme,
  EMPTY_TYPOGRAPHY,
  PROFILE_WRITES,
  REF_KEYS,
  TYPOGRAPHY_KEYS,
  VOICE_KEYS,
  readingPatch,
  type ReadingPatch,
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
  /**
   * HOW MANY TIMES A هيئة HAS BEEN APPLIED. Not which one — how many times.
   *
   * `activeId` cannot answer "was the هيئة just re-asserted", because re-applying the one already
   * worn does not change it. Everything downstream that has to re-read after an application was
   * therefore keyed on a value that stands still exactly when it matters: measured, «تجاهل
   * التغييرات» re-applied the هيئة, wrote its faces back to the row, and the open book kept the
   * drifted face — so discarding did not discard, and the prompt asked again immediately.
   */
  applyTick: number;
  byId: (id: string) => Profile | undefined;
}

export const useProfiles = create<ProfilesState>((_set, get) => ({
  ready: false,
  profiles: [],
  activeId: null,
  applyTick: 0,
  byId: (id) => get().profiles.find((p) => p.id === id),
}));

/**
 * Register every profile's themes so `resolveTheme` can find them. Replaces wholesale.
 *
 * TWO ENTRIES PER PROFILE now: the library's palette under `p.id` — unchanged, so every `theme_id`
 * already on disk still resolves — and the reading palette under `readingThemeId(p.id)`. The
 * registry maps one id to one theme, so two palettes need two keys; nothing else has to know,
 * because both are ordinary custom ids to everything downstream.
 */
function registerThemes(profiles: Profile[]): void {
  const m = new Map<CustomThemeId, Theme>();
  for (const p of profiles) {
    m.set(p.id, profileTheme(p));
    m.set(readingThemeId(p.id), profileReadingTheme(p));
  }
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

  // A READER'S OWN CHANGES NOW OUTLIVE THE SITTING.
  //
  // WHAT THIS USED TO DO, AND WHY IT NO LONGER DOES. The active هيئة re-asserted its own values here,
  // over whatever the last sitting had drifted to — a deliberate guarantee that a change made outside
  // the editor was "for this session only". It made every ordinary reading customisation temporary:
  // a reader who set the text size in a book, closed Sard and came back found the هيئة's size again,
  // with nothing having said the change would not last.
  //
  // The product decision is reversed. Changing the type, the paper or the measure while reading is a
  // change to the هيئة you are wearing, and it survives a restart like any other change.
  //
  // WHAT IS NOT REVERSED: the change is still UNSAVED. `driftOf` derives it by comparing what the
  // هيئة says with what Sard is showing, and that comparison is unaffected by when the values were
  // written — so switching هيئة still stops and asks whether to keep the changes or leave them. The
  // difference is only that the question now survives a restart instead of being answered by
  // silently discarding.
  //
  // Nothing latches, so there is still no second source of truth: the row IS the live value, and the
  // هيئة is still the last saved one.
  if (activeProfile) await settleThemeMode();
  // The Library must be able to answer "has this هيئة been changed?" too, and reading values are only
  // resolvable with the direction they were resolved for — so make both available before anything asks.
  await primeGlobalStyle().catch(() => {});

  // AND ONLY THEN, THE READER WHO ARRIVED FROM BEFORE ANY OF THIS EXISTED. It runs last because the
  // capture reads the reading row through `peekGlobalStyle`, which the line above is what primes; it
  // runs at all only when there are no هيئات, and it writes a marker so it cannot run twice. See
  // `materialiseLegacyLook`. `refreshProfiles` inside it puts the new هيئة into the store, so nothing
  // here has to repeat that.
  if (profiles.length === 0) {
    await materialiseLegacyLook(profiles).catch((e) => {
      // Never fatal: a reader whose look could not be captured still gets a working Sard, and the
      // marker is unwritten so the next launch tries again.
      console.error("legacy look not captured", e);
      return null;
    });
  }
}

/**
 * WEARING A هيئة IS CHOOSING A PAPER, so Follow-OS stops being in force.
 *
 * THE DEFECT THIS CLOSES, measured on the owner's own library: `theme_mode` was `auto`, and
 * `initTheme` resolves the library paper as
 *
 *     themeId = auto ? (osPrefersDark() ? DEFAULT_DARK : DEFAULT_LIGHT) : storedThemeId
 *
 * so the `theme_id` a هيئة writes was DISCARDED at every launch. Their row held `trueblack` while the
 * active هيئة was `u:mteyv188ouu2ly`, and `driftOf` compares exactly those two — so «غيّرتَ الورق»
 * appeared on every switch, for ever, without anyone having edited anything. The OS-change listener
 * does the same thing live.
 *
 * THE RULE ALREADY EXISTS; this only routes through it. `setTheme` turns Follow-OS off whenever a
 * paper is picked by hand, because an explicit choice outranks the system's. Wearing a هيئة is that
 * same choice made from another surface, and `applyProfile` wrote the store directly and skipped it.
 * Two owners of one value, and the OS won every restart.
 */
async function settleThemeMode(): Promise<void> {
  // THE PERSISTED VALUE, NOT THE STORE'S, because of the one ordering that matters. `initProfiles`
  // runs BEFORE `initTheme` (App.tsx sequences them so a profile's theme is registered before a
  // stored `theme_id` is resolved), so at startup `useTheme.autoMode` is still its default `false`
  // and reading it would say "not following the OS" about an installation that is. Measured: the
  // guard bailed, `initTheme` then read `auto` from disk and forced `trueblack`, and the drift came
  // straight back on the next launch.
  const stored = await settingsGet("theme_mode").catch(() => null);
  if (!useTheme.getState().autoMode && stored !== "auto") return;
  useTheme.setState({ autoMode: false });
  await settingsSet("theme_mode", "manual").catch(console.error);
}

/**
 * Re-read from the database. Used after any write, so the store is never a second source of truth.
 *
 * ALSO THE MOMENT THE ORDER IS RECOMPUTED. `applyProfile` stamps the profile as worn but deliberately
 * does not re-sort what is on screen — see the note there — so the new order arrives the next
 * time a list is BUILT: at startup, after any write, and when the Profiles area is entered.
 */
export async function refreshProfiles(): Promise<void> {
  const rows = await profilesList().catch(() => [] as ProfileRow[]);
  const profiles = (rows ?? []).map(toProfile);
  registerThemes(profiles);
  useProfiles.setState({ profiles });
}

// ---- applying -----------------------------------------------------------------------------------

/**
 * Patch `reading_style` at the fields a profile names, preserving every other one.
 *
 * It used to take exactly the two faces; it now takes whatever `readingPatch` produced, which is the
 * faces plus each typography field the profile has an opinion about. Absent stays absent.
 *
 * Reads the raw blob rather than going through `loadGlobalStyle`, deliberately: that helper fills in
 * every absent field from the per-script defaults, so writing its result back would MATERIALISE
 * defaults the reader never chose into their row. Patching the raw text leaves absent fields absent,
 * and absent is how "follow the default" is spelled.
 */
async function patchReadingStyle(patch: ReadingPatch): Promise<void> {
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
  // CLEARED FIRST, THEN WRITTEN. A measure field the هيئة does not name is REMOVED, not left alone:
  // the row is shared, so leaving it would hand the next هيئة the previous one's margin. Removing it
  // is how this model spells "Sard's own default", and it stays per-script because `loadGlobalStyle`
  // resolves the absence against the book's direction rather than against whatever was written.
  for (const k of patch.clear) delete blob[k];
  Object.assign(blob, patch.set);
  await settingsSet(READING_KEY, JSON.stringify(blob)).catch(console.error);
  // AND SAY SO. This row is what "what is Sard reading in?" means outside the Reader, and the answer
  // is cached — so a write that does not announce itself leaves every later comparison arguing with a
  // copy of the previous هيئة. That is what made a freshly saved هيئة report changes nobody had made.
  noteGlobalStyleRow(blob as Partial<ReadingStyle>);
}

/**
 * Make a profile the active one: persist it, and repaint what is already on screen.
 *
 * The store updates below are `setState`, not the stores' own setters, because the setters persist
 * as a side effect and the persisting has already happened here — through the whitelist, once.
 */
export async function applyProfile(
  p: Profile,
  /**
   * WAS THIS A CHOICE, or is the same هيئة simply being re-asserted?
   *
   * APPLYING IS NOT ALWAYS WEARING, and conflating the two made editing count as using. Two paths
   * re-apply the هيئة the reader is ALREADY wearing: saving it (so the running app repaints to the
   * edit) and discarding session drift (re-applying IS the discard — there is no snapshot). Neither
   * is the reader choosing a هيئة, and measured before this, saving the active one moved its use
   * stamp 1788258282 -> 1788258289 and would have floated it above هيئات actually worn since.
   *
   * The default is `true` because every OTHER caller is a switch: the switcher, the card's own face,
   * the import sheet. A new call site that forgets gets the right answer for a switch, and only a
   * re-application has to say so.
   */
  opts: { worn?: boolean } = {},
): Promise<void> {
  // WORN, NOW — the one fact "most recently used first" cannot be derived from. This is the single
  // use-point: every surface that switches profile comes through here, so one call covers the
  // switcher, the cards, the import sheet and the unsaved-changes prompt.
  //
  // IT DOES NOT RE-SORT WHAT IS ON SCREEN, and that is deliberate. A profile card's miniature IS the
  // switch, so promoting the card the reader has just clicked would slide it out from under their
  // pointer and put a different profile where their finger already is — a second click would then
  // switch to something they never chose. The order is recomputed when a list is next built instead
  // (`refreshProfiles`), which is the same shape the library uses for books promoted by reading.
  //
  // NOT AWAITED, and its failure is not the reader's problem: they asked for a look, and they get it
  // whether or not the stamp lands. A missing stamp costs one position in a list, once.
  if (opts.worn !== false) void profileTouch(p.id).catch(console.error);

  for (const [k, v] of profileSettings(p)) await settingsSet(k, v).catch(console.error);
  await patchReadingStyle(readingPatch(p));

  // The paper is being chosen, so Follow-OS yields — see `settleThemeMode`. Before the ids are
  // written, so nothing can read a half-settled state.
  await settleThemeMode();

  const theme = profileTheme(p);
  registerThemes(useProfiles.getState().profiles);
  applyTheme(theme);
  // THE LIBRARY AND THE BOOK, SEPARATELY. This wrote `p.id` to both, which made a profile the one
  // thing in the application that forced the two scopes together — `theme/store.ts` keeps them
  // apart everywhere else, and `setBookTheme` says so in as many words.
  useTheme.setState({ themeId: p.id, bookThemeId: readingThemeId(p.id) });

  useFonts.setState({ uiFont: p.data.type.ui });
  applyUiFontVar(p.data.type.ui); // lib/fonts.ts owns the stack; applying it here skips re-persisting

  useBookmarkStyle.setState({
    shape: p.data.marks.bookmarkShape,
    color: p.data.theme.reading.bookmark ?? p.data.theme.reading.colors.accent,
    pos: p.data.marks.bookmarkPos,
    size: p.data.marks.bookmarkSize,
  });
  useReadMarkerStyle.setState({ marker: p.data.marks.readMarker });

  // THE SURFACES' OWN STATE, RE-READ FROM WHAT WE JUST WROTE.
  //
  // `profileSettings` above persists `bg_library_id`, `bg_reading_id` and both params blobs, but
  // persisting is not applying: the live background store is hydrated from those rows by
  // `initBackground`, and that ran once at startup. So every other value a profile owns reached the
  // running application here while the backgrounds and the page transparency reached only the
  // database, and the reader saw them on the NEXT LAUNCH.
  //
  // Measured before this: activating a profile whose page opacity is 0.84 and whose library carries
  // an image left `--bg-page-opacity` at the previous profile's 85%, `--bg-rd-scrim-base` computed
  // from the previous presence, and `--bg-lib-image` empty with no `data-bg-library` gate at all —
  // while `data-theme`, `--paper-bg`, `--text` and `--accent` all updated correctly.
  //
  // RE-READING RATHER THAN RE-MAPPING IS THE POINT. `initBackground` is the one place that turns
  // those settings into store state, and `applyBackgrounds` the one place that turns store state
  // into custom properties. Going through both keeps the settings rows the single source of truth
  // for the runtime; assigning the profile's values straight into the store would have created a
  // second mapping that could drift from the one the rest of the application uses.
  await initBackground();
  applyBackgrounds(theme.colors);

  // TEXTURE, derived rather than stored. The profile carries the STEP; what it renders as depends on
  // the live desk scrim and the active theme, so the alpha is computed here on every application and
  // never persisted. `opaque` removes the variable entirely. AFTER the backgrounds, because the
  // texture's floor is measured against the live desk scrim they have just set.
  applyTexture(p.data.texture, theme.colors);

  // LAST, and it is what tells the rest of the application that an application HAPPENED. The tick
  // moves even when the id does not, which is the whole point — see `applyTick`.
  useProfiles.setState({ activeId: p.id, applyTick: useProfiles.getState().applyTick + 1 });
}

// ---- creating, duplicating, deleting -------------------------------------------------------------

const newId = (): CustomThemeId =>
  `u:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` as CustomThemeId;

/**
 * One live theme, as a profile stores a palette.
 *
 * `base` records lineage and is only meaningful for a SHIPPED theme: a custom id names another
 * profile, which is not a preset anything can be reset to.
 */
function snapshotPalette(theme: Theme, id: string, bookmark: string): ProfileTheme {
  return {
    base: typeof id === "string" && !id.startsWith("u:") ? (id as never) : null,
    dark: theme.dark,
    colors: theme.colors,
    highlightAlpha: theme.highlightAlpha,
    bookmark,
    separator: null,
    // Captured with no number ink: the digits follow the text until a reader asks otherwise.
    numbers: null,
    // Captured with no relief of its own — and that is the faithful capture, not a lossy one. The
    // theme handed in here is the RESOLVED one, so any relief in force is already inside `colors`;
    // storing it a second time as a step would apply it twice.
    relief: null,
  };
}

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
    // BOTH SURFACES, AS THEY ACTUALLY ARE. "Everything Sard looks like right now" has always meant
    // two things since the theme store split them; it simply had nowhere to put the second one.
    // The library takes `themeId` and the book takes `bookThemeId`, so a profile captured while the
    // two differ keeps that difference instead of flattening it.
    theme: {
      library: snapshotPalette(resolveTheme(t.themeId), t.themeId, bm.color),
      reading: snapshotPalette(theme, t.bookThemeId, bm.color),
    },
    type: {
      ui: fonts.uiFont,
      arabic: reading.arabicFont,
      latin: reading.latinFont,
      // A profile captured from "how Sard looks now" takes NO typography opinion. Capturing the
      // reader's live measure would make every new profile silently override size and leading on
      // every switch, which is the behaviour `null` exists to prevent. The reader opts in from the
      // typography chapter instead.
      reading: { ...EMPTY_TYPOGRAPHY },
    },
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
        // Captured with no overlay of its own: the theme's colour, which is what a capture of
        // "how Sard looks now" means when nothing has overridden it.
        overlay: null,
      },
    },
    // NOR ANY OPINION ABOUT THE READ-ALOUD MARKS, for the same reason the measure takes none: a
    // profile captured from "how Sard looks now" would then impose the reader's current spotlight on
    // every switch, and `null` is what prevents that. The reader opts in from the voice chapter.
    voice: null,
    // NOR ANY OPINION ABOUT THE REFERENCE MARK, for the same reason: a هيئة made from "how Sard looks
    // now" would otherwise impose the reader's current reference colour and sizes on every switch.
    refs: null,
    // Texture has no global setting to capture: today every surface is opaque, and `opaque` writes
    // nothing, so a profile made from "how Sard looks now" is byte-identical to today.
    texture: "opaque",
    // Nor has the seal: it is a property of a profile, and "how Sard looks now" is not yet one. The
    // defaults draw the name's initial in the profile's own face, which is what a seal has always
    // looked like.
    seal: { face: "profile", glyph: "initial" },
    // Nor has the framing: a profile captured from "how Sard looks now" has no mark of its own yet,
    // and dead centre at `cover` is what a mark has always been drawn at.
    icon: { ...ICON_FRAME_DEFAULT },
  };
}

/**
 * A هيئة THAT HAS NOTHING TO DO WITH WHAT IS ON SCREEN — Sard's own default appearance, written out.
 *
 * WHY THIS EXISTS AND `captureCurrent` DOES NOT ANSWER IT. `captureCurrent` reads the live stores, so
 * a هيئة made from it is a photograph of the moment — including whatever the reader had changed and
 * not yet saved. Seeding a NEW هيئة from that made creation behave like editing the one being worn:
 * the editor opened on the active هيئة's values, drift and all, and it was impossible to tell the two
 * apart by looking. A new هيئة must begin from Sard's own default, so that what the reader is wearing
 * — saved or drifted — cannot reach into it.
 *
 * Every value here is the default its own module already declares, read from that module rather than
 * copied as a literal, so a changed default reaches this in one edit and cannot fall behind.
 */
export function defaultProfileData(): ProfileData {
  const base = THEMES[DEFAULT_LIGHT];
  return {
    v: PROFILE_DATA_VERSION,
    // BOTH SURFACES ON SARD'S OWN PAPER. They begin identical and are free to part the moment the
    // reader edits one, which is what makes them two scopes rather than one.
    theme: {
      library: snapshotPalette(base, DEFAULT_LIGHT, BOOKMARK_DEFAULT_COLOR),
      reading: snapshotPalette(base, DEFAULT_LIGHT, BOOKMARK_DEFAULT_COLOR),
    },
    // THE TWO BOOK FACES ARE SARD'S OWN — the same pair the reading engine falls back to — and the
    // chrome face is left to Sard (`null`). No MEASURE opinion, for the reason `captureCurrent` takes
    // none: a هيئة that named a size would override the reader's leading on every switch, and an
    // empty typography is what prevents that.
    type: { ui: null, arabic: "amiri", latin: "literata", reading: { ...EMPTY_TYPOGRAPHY } },
    marks: {
      bookmarkShape: BOOKMARK_DEFAULT_SHAPE,
      bookmarkSize: BOOKMARK_DEFAULT_SIZE,
      bookmarkPos: BOOKMARK_DEFAULT_POS,
      readMarker: READ_MARKER_DEFAULT,
    },
    // No picture on either surface: a new هيئة is a sheet of Sard's own paper, not a copy of the
    // reader's desk. They add one from the editor's own background chapter.
    bg: {
      library: { ref: null, params: { ...BG_DEFAULT_PARAMS } },
      reading: { ref: null, params: { ...BG_DEFAULT_PARAMS }, sameAsLibrary: false, overlay: null },
    },
    voice: null,
    // Sard's own reference mark: the design exactly, in whatever accent the theme carries.
    refs: null,
    texture: "opaque",
    seal: { face: "profile", glyph: "initial" },
    icon: { ...ICON_FRAME_DEFAULT },
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

/**
 * The reader's own page measure, READ ONLY, for the editor's preview to open on.
 *
 * PAGE WIDTH IS NOT A PROFILE PROPERTY and must never become one — `pageWidth` is named in the
 * package validator's forbidden list, and the rail's own footer promises the reader it stays theirs
 * in every profile. This borrows the value so the preview can open on the measure they actually
 * read at; nothing here writes it back, and nothing carries it into `ProfileData`.
 *
 * Same two sources as the faces above, for the same reason: the live reader when a book is open, the
 * persisted row when the reader is standing in the Library.
 */
export async function readerPageWidth(): Promise<number> {
  const live = useReader.getState().style;
  if (live && typeof live.pageWidth === "number") return live.pageWidth;
  const raw = await settingsGet(READING_KEY).catch(() => null);
  if (!raw) return PAGE_WIDTH_DEFAULT;
  try {
    const s = JSON.parse(raw) as Partial<{ pageWidth: number }>;
    return typeof s.pageWidth === "number" ? s.pageWidth : PAGE_WIDTH_DEFAULT;
  } catch {
    return PAGE_WIDTH_DEFAULT;
  }
}

export async function createProfile(name: string, data: ProfileData, derivedFrom: string | null): Promise<Profile> {
  const now = Math.floor(Date.now() / 1000);
  const p: Profile = {
    id: newId(),
    name: cleanProfileName(name),
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
  // ONE PLACE DECIDES WHAT A STORED NAME LOOKS LIKE. Every editor, sheet and dialog reaches the
  // database through here, so the rule cannot be skipped by a path that forgot it.
  await profileSave(toRow({ ...p, name: cleanProfileName(p.name) }));
  await refreshProfiles();
  // THE RUNNING APP FOLLOWS THE EDIT, but editing is not wearing: the reader was already in this
  // هيئة and has not chosen it again, so this re-application takes no use stamp. Without that, a
  // save floated the هيئة to the front of a list ordered by USE — which is the one thing that
  // ordering must not report.
  if (useProfiles.getState().activeId === p.id) await applyProfile(p, { worn: false });
}

/**
 * Commit an inspected package as a new local profile.
 *
 * THE ID IS MINTED HERE, beside every other id this app makes, and handed to Rust rather than
 * generated there — one place decides what a profile id looks like. Rust re-checks the manifest
 * regardless: `commit` is the boundary, and it does not trust that inspection happened.
 */
export async function importProfile(manifestJson: string, archivePath?: string | null): Promise<Profile> {
  // The archive rides along so `commit` can register the assets beside the row — one place, as the
  // boundary intended. Absent (a v1 package, or a manifest with no assets) is settings only.
  const row = await profileImportCommit(manifestJson, newId(), archivePath ?? null);
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
export async function removeProfile(p: Profile, fallback: ThemeId): Promise<void> {
  const wasActive = useProfiles.getState().activeId === p.id;
  await profileDelete(p.id);
  await refreshProfiles();
  if (wasActive) {
    await settingsSet(PROFILE_ACTIVE_KEY, "").catch(console.error);
    await settingsSet("theme_id", fallback).catch(console.error);
    await settingsSet("book_theme_id", fallback).catch(console.error);

    // AND THE SCREEN GOES WHERE THE ROW JUST WENT. Persisting the fallback is not wearing it.
    // `refreshProfiles` above has already unregistered the deleted palette, so without these two
    // lines the live theme id still named the هيئة that no longer exists while the settings row said
    // `ivory` — measured: `themeId` stayed `u:<deleted>` and the tokens on `:root` were never
    // repainted, so the reader kept looking at the هيئة they had just deleted until the next launch,
    // when the persisted `ivory` finally took. The two must not be allowed to disagree.
    applyTheme(resolveTheme(fallback));
    useTheme.setState({ themeId: fallback, bookThemeId: fallback });
    useProfiles.setState({ activeId: null });
  }
}

// ---- THE LOOK A READER ALREADY HAD, BEFORE هيئات EXISTED -------------------------------------------
//
// THE LOSS THIS PREVENTS, traced rather than guessed. A reader who customised Sard before this system
// existed has all of it persisted — `reading_style`, `theme_id`, `book_theme_id`, the two background
// bindings, `ui_font`, the bookmark and the read marker — and ZERO هيئات. `initProfiles` loaded that
// list, found it empty, and did nothing else.
//
// Then the first هيئة they wear calls `readingPatch`, whose whole contract is that a هيئة is a
// COMPLETE look: it asserts what it names and CLEARS what it does not, so that nothing of the previous
// هيئة survives. That contract is right, and against a reader who is wearing no هيئة at all it is
// destructive — the values it clears are not a previous هيئة's, they are years of the reader's own
// settings, and nothing holds a copy.
//
// AND THE ONE GUARD THAT WOULD HAVE ASKED DOES NOT APPLY. `guardUnsaved` compares the ACTIVE هيئة with
// what is on screen; with `activeId === null` there is nothing to compare, so the switch proceeds
// silently. The safety net is real and this reader is standing beside it.
//
// SO THE FIRST THING SARD DOES, ONCE, IS GIVE THEM THE هيئة THEY ALREADY HAD. Their look becomes a
// هيئة, they are wearing it, and from that moment the ordinary machinery protects them: switching away
// asks, switching back restores, and the look they arrived with is a row they can return to or delete.
// Nothing about what they see changes at the moment it happens — the هيئة IS the look.
const LEGACY_KEY = "profiles_legacy_captured";

/**
 * The current look as a COMPLETE هيئة, reading values included.
 *
 * WHY NOT `captureCurrent`. That function deliberately takes no typography, no read-aloud and no
 * reference opinion, and the refusal is right for what it is for: a هيئة made from "how Sard looks
 * now" must not silently claim the reader's measure. This is the opposite case. The measure IS what is
 * being rescued — it is the largest part of what a pre-هيئة reader customised — so every field is
 * taken, and `null` is preserved where the reader genuinely has no opinion.
 */
export async function captureLegacyLook(): Promise<ProfileData> {
  const data = await captureCurrent();
  const live = peekGlobalStyle();
  if (!live) return data;
  data.type.reading = Object.fromEntries(
    TYPOGRAPHY_KEYS.map((k) => [k, live[k] ?? null]),
  ) as unknown as ProfileData["type"]["reading"];
  data.voice = Object.fromEntries(VOICE_KEYS.map((k) => [k, live[k]])) as unknown as ProfileData["voice"];
  data.refs = Object.fromEntries(REF_KEYS.map((k) => [k, live[k]])) as unknown as ProfileData["refs"];
  // The digits are a هيئة-owned colour with no control of its own outside this system.
  data.theme = {
    ...data.theme,
    reading: { ...data.theme.reading, numbers: live.numberColor ?? null },
  };
  return data;
}

/**
 * Has this reader ever set anything a هيئة would overwrite?
 *
 * THE LIST IS NOT INVENTED. `PROFILE_WRITES` names exactly the settings rows activating a هيئة writes
 * over, plus `reading_style`, which `readingPatch` rewrites — so "what would be lost" and "what is
 * checked here" are one list, and a key added to a هيئة's reach is checked here without anyone
 * remembering to. `profile_active` is excluded: it is this system's own bookkeeping, not a look.
 */
async function hasLegacyLook(): Promise<boolean> {
  const keys = [...PROFILE_WRITES.filter((k) => k !== "profile_active"), READING_KEY];
  for (const k of keys) {
    const v = await settingsGet(k).catch(() => null);
    if (v !== null && v !== undefined && v !== "") return true;
  }
  return false;
}

/**
 * Once, and only for a reader who arrived with a look and no هيئات.
 *
 * IDEMPOTENT BY TWO INDEPENDENT FACTS, either of which alone would do: a marker row, and the
 * `profiles.length === 0` precondition — a second run cannot see an empty list, because the first run
 * put a هيئة in it. So no launch after the first can produce a duplicate even if the marker is lost.
 *
 * A READER WHO NEVER CUSTOMISED ANYTHING GETS NOTHING, which is why the marker is written in that case
 * too: they are not asked to carry a هيئة named after a look they never had, and the check does not
 * run again on every launch.
 */
/**
 * In-flight guard.
 *
 * THE MARKER IS NOT ENOUGH ON ITS OWN, and this was measured rather than foreseen: `initProfiles` is
 * invoked twice on a launch (React runs the effect twice in development, and nothing forbids a second
 * caller in general). Both invocations reached this function before either had written the marker, both
 * saw zero هيئات, and the reader got their look captured TWICE — two rows with one name. Sharing the
 * single run is what makes "once" true against concurrency as well as against restarts.
 */
let legacyRun: Promise<Profile | null> | null = null;

export function materialiseLegacyLook(profiles: Profile[]): Promise<Profile | null> {
  if (!legacyRun) legacyRun = runLegacyCapture(profiles);
  return legacyRun;
}

async function runLegacyCapture(profiles: Profile[]): Promise<Profile | null> {
  if (profiles.length > 0) return null;
  // Re-read rather than trust the caller's snapshot: by the time this runs the list may have been
  // filled by whoever else was starting up.
  const live = await profilesList().catch(() => [] as ProfileRow[]);
  if ((live ?? []).length > 0) return null;
  const done = await settingsGet(LEGACY_KEY).catch(() => null);
  if (done) return null;
  if (!(await hasLegacyLook())) {
    await settingsSet(LEGACY_KEY, "none").catch(() => {});
    return null;
  }
  // ── THE CAPTURE CAN ONLY SEE WHAT HAS BEEN LOADED ────────────────────────────────────────────
  //
  // `captureCurrent` reads the LIVE STORES — theme, fonts, bookmark, read marker, background — and
  // at this moment most of them are still holding the values they were CONSTRUCTED with, not the
  // reader's. `App.tsx` starts them all without awaiting, and it sequences `initTheme` AFTER
  // `initProfiles` on purpose, so the theme store is not merely likely to be unloaded here: it is
  // guaranteed to be. `useTheme` is constructed with `themeId: DEFAULT_LIGHT`, and `DEFAULT_LIGHT`
  // is «ivory».
  //
  // MEASURED, from a tester upgrading with a customised look: the هيئة was created and the reader's
  // chrome went to Ivory. It was captured as Ivory — from a store that had never been told what the
  // reader's `theme_id` was — and then `applyProfile` wrote that capture back over the real
  // `theme_id` and `book_theme_id`, destroying the setting it existed to rescue. The background
  // survived only because `initBackground` happened to win the race; nothing guaranteed it.
  //
  // The reading row already had this treatment — `primeGlobalStyle` is awaited before this function
  // for exactly this reason. It was simply never extended to the other four sources. So every source
  // the capture reads is loaded first, and this is deliberately NOT a list of fields: a value added
  // to any of these stores later is captured correctly without anyone remembering this comment.
  //
  // They are all idempotent settings loaders, and this branch runs only for a reader who has no
  // هيئات and a look worth keeping — so nothing else pays for it, and `App.tsx` re-running them a
  // moment later reads the same rows to the same values.
  await Promise.all([
    initTheme().catch(() => {}),
    initFonts().catch(() => {}),
    initBookmarkStyle().catch(() => {}),
    initReadMarkerStyle().catch(() => {}),
    initBackground().catch(() => {}),
  ]);

  const lang = ((await settingsGet(LANG_KEY).catch(() => null)) as Lang | null) ?? "ar";
  const data = await captureLegacyLook();
  const made = await createProfile(translate(lang, "profiles.legacy.name"), data, null);
  // Written BEFORE activation: if applying were to fail, the reader still has the هيئة and Sard will
  // not try to make a second one on the next launch.
  await settingsSet(LEGACY_KEY, made.id).catch(() => {});
  // Wearing it changes nothing on screen — the هيئة is the look it was captured from — and it is what
  // brings this reader inside the guard, so the NEXT هيئة they choose stops and asks.
  await applyProfile(made, { worn: false });
  return made;
}
