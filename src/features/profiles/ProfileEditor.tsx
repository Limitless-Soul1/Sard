// The profile editor — a composer, not a settings form.
//
// SIX QUESTIONS, ALWAYS VISIBLE. The editor is laid out by `EditorShell`: a permanent chapter rail,
// one chapter's controls, and the live preview. The accordion this replaced hid five answers to show
// one, so the editor could never say where you were; the rail keeps all six on screen with their
// current values and marks the ones that have moved.
//
// THE BODIES ARE THE OLD SECTIONS, UNCHANGED. Only their routing moved. Two of them had to be
// re-cut to match the six chapters, and only those two:
//   · `background` is one chapter over both surfaces — the old `libbg` and `bookbg` sections render
//     inside it, in that order, because the question is "where do you want the image" and a reader
//     answering it is thinking about one image, not two sections.
//   · `texture` becomes its own chapter, so the block that used to close Marks is lifted out into
//     `TextureSection`. Nothing about the control changed; it is the same three named steps.
//
// THE RAIL'S LAST BLOCK IS THE FIREWALL, stated once and never repeated: line spacing, measure,
// margins, diacritics, alignment and size are the reader's own, in every profile. It is not a
// control — it is the answer to the question the editor otherwise invites. It rides in the shell's
// `railFooter` slot rather than becoming a seventh chapter.

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import {
  BG_BLUR_MAX,
  BG_NO_OVERLAY,
  PAGE_OPACITY_MIN,
  bgOverlayOf,
  bgSrcUrl,
  effectivePageOpacity,
  imageLabel,
  overlayTint,
  presenceMaxFor,
  scrimAlpha,
  type BgSurface,
  worstDeskScrim,
} from "../../lib/background";
import { localeDigits, localeNum } from "../../lib/format";
import { backgroundImport, backgroundsList, type BackgroundRow } from "../../lib/ipc";
import {
  BOOKMARK_COLORS,
  BOOKMARK_SHAPES,
  BOOKMARK_SIZE_MAX,
  BOOKMARK_SIZE_MIN,
} from "../../lib/bookmarkStyle";
import { READ_MARKERS } from "../../lib/readMarkerStyle";
import { FONT_CATALOGUE, useFonts } from "../../lib/fonts";
import { applyTexture, LOWEST_SURFACE, minChromeAlpha, stepBlur, stepBright, stepK, stepSat, surfaceAlpha } from "../../lib/texture";
import {
  ARABIC_DEFAULTS,
  ARABIC_FONTS,
  LATIN_FONTS,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { loadGlobalStyle } from "../reader/perBookSettings";
import { DEFAULT_LIGHT, THEMES, THEME_ORDER } from "../../theme/themes";
import type { ThemeColors } from "../../theme/tokens";
import { BookmarkShape } from "../reader/BookmarkShape";
import { ACCENTS, CustomPaper, PAPERS_DARK, PAPERS_LIGHT } from "./CustomPaper";
import { MeasureSection } from "./editor/MeasureSection";
import { ColorPicker } from "../../components/ColorPicker";
import { EditorShell } from "./editor/EditorShell";
import { FOCUS, type ChapterId, type Focus } from "./editor/chapters";
import { ShareSheet } from "./ShareSheet";
import { guardUnsaved, profileChangePending } from "./session";
import { BookFace, previewPageWidth } from "./editor/stage/BookFace";
import { FocusFrame } from "./editor/stage/FocusFrame";
import { LibraryFace } from "./editor/stage/LibraryFace";
import {
  PAGE_WIDTH_DEFAULT,
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
} from "../../reader-engine/injectedCss";
import { bookFaceCss, sealOf } from "./mini";
import { readerPageWidth, saveProfile, useProfiles } from "./store";
import {
  ICON_FRAME_DEFAULT,
  ICON_SCALE_MAX,
  ICON_SCALE_MIN,
  SEAL_DIAMOND,
  TEXTURE_STEPS,
  type TextureStep,
  PROFILE_NAME_MAX,
  cleanProfileName,
  isDefaultIconFrame,
  profileLabel,
  type Profile,
  type ProfileData,
  type ProfileIcon,
  type ProfileSeal,
  profileTheme,
  libraryColors,
  TYPOGRAPHY_KEYS,
} from "./model/profile";
import { markFrame, panRange } from "./model/markFrame";
import { judgePalette } from "./model/guidance";
import { editHex } from "./model/hex";
import {
  deriveColors,
  reliefOf,
  reliefRoom,
  RELIEF_STEP,
} from "./model/palette";
import { Icon } from "../../components/Icon";
import { useDialog } from "../../components/useDialog";

/**
 * What each chapter owns, as a value that can be compared.
 *
 * The rail's dot answers "what have I changed", so a chapter is dirty when ITS OWN slice of the
 * draft differs from the SAVED profile — the head's single `unsaved` badge, decomposed into the six
 * places it could have come from.
 *
 * The slices PARTITION the profile: every editable field belongs to exactly one, so a change lights
 * exactly one dot. That is why `theme.bookmark` is counted under `marks` and subtracted from
 * `paper` — the bookmark colour is set in Marks, and a field counted twice would light two.
 */
function chapterSlice(p: Profile, id: ChapterId): unknown {
  const d = p.data;
  switch (id) {
    case "identity":
      // THE WHOLE PAGE, INCLUDING WHAT THE PAGE OWNS INSIDE THE BLOB. The slices are meant to
      // partition the profile, and two of Identity's own fields were in no slice at all: choosing a
      // different seal face, or framing a picture, changed the profile and lit no dot on the rail.
      return { name: p.name, iconKind: p.iconKind, iconRef: p.iconRef, seal: d.seal, icon: d.icon };
    // ONE SURFACE EACH, so a dot lights on the chapter the reader actually changed. The bookmark is
    // held out of both: the marks chapter owns it.
    case "paper": {
      const { bookmark: _libMark, ...libPaper } = d.theme.library;
      return libPaper;
    }
    case "paperBook": {
      const { bookmark: _readMark, ...readPaper } = d.theme.reading;
      return readPaper;
    }
    case "background":
      return d.bg;
    case "measure":
      return d.type.reading;
    case "fonts":
      return d.type;
    case "marks":
      return { ...d.marks, bookmark: d.theme.reading.bookmark };
    case "texture":
      return d.texture;
  }
}

export function ProfileEditor({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  /**
   * This profile has just been made, so nothing about it has been answered yet.
   *
   * WHICH CHAPTER OPENS IS NOT ONE RULE. The design's own state opens on `paper` — that is the
   * chapter a reader returns to when adjusting a profile that already exists, and it is what the
   * accordion did before the rail. But a profile created seconds ago has an untouched name, and
   * opening on its colours asks the second question first. So the flow decides: `create` and
   * `duplicate` pass this, plain editing does not.
   */
  /** Kept in the props for its callers; the landing section no longer depends on it. */
  fresh?: boolean;
  onClose: () => void;
  /** Frame 22: what was saved, and what it replaced — see `save` below. */
  onSaved?: (previous: Profile, saved: Profile) => void;
}) {
  const { t, lang } = useI18n();
  const live = useProfiles((s) => s.profiles.find((p) => p.id === profile.id)) ?? profile;

  const [draft, setDraft] = useState<Profile>(() => structuredClone(live));
  // IDENTITY IS WHERE THE EDITOR OPENS, always. A new profile landed here and an existing one landed
  // on the paper — so the page that says WHICH profile you are editing was the one you never saw
  // first, and the editor opened on a chapter without ever naming its subject.
  const [chapter, setChapter] = useState<ChapterId>("identity");
  const [face, setFace] = useState<"library" | "book">("library");
  /**
   * WHICH PALETTE THE COLOUR CHAPTERS EDIT — the one their own chapter is about.
   *
   * This was derived from the preview switch, which made the two palettes one chapter with a toggle
   * in it: technically two surfaces, presented as one. They are two CHAPTERS now, and each pins the
   * stage to its own face (`FOCUS`), so entering «ألوان المكتبة» shows the library and edits the
   * library, and «ألوان الكتب» shows a page and edits the page.
   *
   * Reading it from the chapter rather than the face also makes it deterministic: flipping the
   * stage's switch to look at the other surface can no longer change what a swatch writes to.
   * `paperBook` is the profile's `reading` scope — the word `bg` has always used for that surface.
   */
  const scope: "library" | "reading" = chapter === "paperBook" ? "reading" : "library";
  /**
   * WHAT THE STAGE PAINTS, which is a different question from what the chapter edits.
   *
   * The preview's custom properties dress whichever face is on screen, so they follow `face`. Tying
   * them to `scope` instead would have painted the BOOK page in the LIBRARY's colours in every
   * book-faced chapter that is not a palette one — Fonts, Measure, Marks — because those chapters
   * edit no palette and `scope` falls back to the library.
   */
  const previewScope: "library" | "reading" = face === "book" ? "reading" : "library";
  const [share, setShare] = useState(false);
  // The managed rows, so a ref can be shown as a thumbnail and a name. Loaded once; anything the
  // editor imports is appended, so a freshly chosen image renders without a round trip.
  const [bgRows, setBgRows] = useState<BackgroundRow[]>([]);
  useEffect(() => {
    let alive = true;
    backgroundsList()
      .then((r) => alive && setBgRows(r))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  /**
   * THE DRAFT'S TEXTURE, ON THE APPLICATION, WHILE THE EDITOR IS OPEN.
   *
   * ROOT CAUSE of "the three options do nothing". Choosing a step only ever called `patch`, which
   * writes the draft. Nothing called `applyTexture`, so the root kept whatever the ACTIVE profile
   * had applied at startup: measured in the release, clicking all three in turn left
   * `data-ui-texture` at `glass` and the real sidebar at one alpha throughout. The control moved,
   * its own miniature moved, and the application it describes did not.
   *
   * The editor is a live preview of a profile, so the surfaces it governs follow the draft. On the
   * way out the ACTIVE profile is reapplied — a draft that is closed without saving must not leave
   * its texture behind on an application that never adopted it.
   */
  useEffect(() => {
    applyTexture(draft.data.texture, libraryColors(draft.data.theme.library));
    return () => {
      const st = useProfiles.getState();
      const act = st.activeId ? st.profiles.find((x) => x.id === st.activeId) : undefined;
      if (act) applyTexture(act.data.texture, profileTheme(act).colors);
      else applyTexture("opaque", libraryColors(draft.data.theme.library));
    };
    // The RELIEF belongs in here with the palette: the texture floor is measured against the panel,
    // so moving the panel moves the floor. `profileTheme` on the way out already carries it.
  }, [draft.data.texture, draft.data.theme.library.colors, draft.data.theme.library.relief]);

  /**
   * The reader's own measure, for every control the profile has no opinion about.
   *
   * Shown greyed beside each control so a reader can see what they would be overriding BEFORE they
   * override it — a three-state control whose "unset" state shows nothing tells you only that you
   * have not chosen, not what you would be changing.
   */
  const [readerStyle, setReaderStyle] = useState<ReadingStyle>(ARABIC_DEFAULTS);
  useEffect(() => {
    let alive = true;
    loadGlobalStyle()
      .then((st) => alive && setReaderStyle(st))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // Both background surfaces append to the same list, so the append is written once.
  const addBgRow = (r: BackgroundRow) =>
    setBgRows((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r]));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(live), [draft, live]);

  /**
   * A NAME MAY NOT BE ERASED — and that is the whole rule, deliberately.
   *
   * "A profile must have a name" would be the obvious rule and it would trap a reader: twelve of the
   * twenty-three profiles in this library have no name at all, and someone opening one of them to
   * change a colour would be told to invent a name first. So the rule is about the EDIT rather than
   * the state — you cannot take away a name that is there. A profile that arrived nameless saves
   * exactly as it always did.
   *
   * Blank means blank in any script: `cleanProfileName` decides that, so the field agrees with what
   * the database would store rather than testing for spaces on its own.
   */
  const erasedName = cleanProfileName(live.name) !== null && cleanProfileName(draft.name) === null;
  const nameNoteId = useId();

  const patch = (f: (d: ProfileData) => void) =>
    setDraft((cur) => {
      const next = structuredClone(cur);
      f(next.data);
      return next;
    });

  // FRAME 22 — a save is announced, and is undoable for as long as the announcement is on screen.
  //
  // The editor does not own that announcement: it closes on save, and a toast belonging to a closed
  // component is a toast nobody can dismiss. So it reports the save and the surface that opened it
  // says so. `onSaved` is handed the profile AS IT WAS — the same object this editor was opened with,
  // which is exactly what an undo has to put back, so nothing new has to be captured for it.
  const save = async () => {
    await saveProfile(draft);
    onSaved?.(live, draft);
    onClose();
  };

  /**
   * LEAVING, BY WHATEVER ROUTE. The ✕ and Escape are the same act, so they run the same code — an
   * Escape that skipped the gate would be a way to lose a draft that the button cannot lose.
   */
  const askToLeave = () =>
    guardUnsaved(onClose, {
      alsoDirty: dirty,
      onSave: async () => { await saveProfile(draft); onSaved?.(live, draft); },
      onDiscard: () => { setDraft(live); },
    });
  // The editor covers Sard entirely and says `aria-modal`, so it keeps focus like any other dialog.
  // Focus lands on the editor rather than on its first field: it opens on a page, not on a question.
  const dlg = useDialog({ onDismiss: askToLeave, initialFocus: "none" });

  /** A palette's name, for the rail: the preset it started from, or "custom" once edited. */
  const paletteName = (scopeId: "library" | "reading"): string =>
    draft.data.theme[scopeId].base
      ? t(`theme.${draft.data.theme[scopeId].base}` as TKey)
      : t("profiles.theme.custom");
  const themeName = paletteName("library");

  const bgName = (ref: string | null) => bgRows.find((r) => r.id === ref)?.source_name ?? null;

  // THE DRAFT'S OWN IMAGES, resolved for the specimens. Taken from the DRAFT rather than the saved
  // profile, which is what makes the preview answer while a control is still moving.
  const urlOf = (ref: string | null): string | null => {
    const row = ref ? bgRows.find((r) => r.id === ref) : null;
    return row ? bgSrcUrl(row) : null;
  };
  const libUrl = urlOf(draft.data.bg.library.ref);
  const bookUrl = urlOf(
    draft.data.bg.reading.sameAsLibrary ? draft.data.bg.library.ref : draft.data.bg.reading.ref,
  );
  const iconUrl = draft.iconKind === "image" && draft.iconRef ? urlOf(draft.iconRef) : null;
  const headSeal = sealOf(draft);
  /** The focus frame measures its target against this, in the stage's own unscaled pixels. */
  const stageRef = useRef<HTMLDivElement | null>(null);

  /**
   * THE MEASURE THE PREVIEW IS DRAWN AT — the reader's own, and preview-only.
   *
   * It opens on whatever they actually read at, so the specimen answers "how does my paper look on
   * my page" rather than on one fixed column. It is deliberately NOT part of the draft: `pageWidth`
   * is on the package validator's forbidden list and the rail footer promises it stays the reader's
   * own in every profile, so this lives in the editor's own state, is never saved, and never reaches
   * `ProfileData`.
   */
  const [pageW, setPageW] = useState(PAGE_WIDTH_DEFAULT);
  useEffect(() => {
    let alive = true;
    readerPageWidth()
      .then((v) => alive && setPageW(v))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  /**
   * EACH FACE'S OWN PICTURE, resolved here and owned there.
   *
   * They used to be one layer on the composition, which meant neither face could confine its own
   * background — a face cannot clip a layer that is not its descendant. Now the library's picture is
   * handed to the library and the book's to the page, and each is bounded by the thing it belongs
   * to. `scrimAlpha` is production's own presence→scrim function for that surface, which is what
   * keeps the preview and the thing it depicts from drifting apart.
   */
  const libBg = libUrl
    ? {
        url: libUrl,
        params: draft.data.bg.library.params,
        scrim: scrimAlpha(draft.data.bg.library.params.presence, "library" as BgSurface),
      }
    : null;
  // THE OVERLAY THE READER WILL ACTUALLY SEE, read through the same two functions the Reader uses.
  //
  // The preview used to paint the scrim unconditionally, so a reader who had chosen "no colour" was
  // shown a veiled picture here and an unveiled one in the book — one setting, two readings of it.
  // The choice lives in the reading style rather than in the profile, so the preview reads it live;
  // what matters is that the RULE has one home, not that the value does.
  const readOverlay = overlayTint(bgOverlayOf(draft.data.bg.reading.overlay));
  const bookBg = bookUrl
    ? {
        url: bookUrl,
        params: draft.data.bg.reading.params,
        scrim: readOverlay.paint
          ? scrimAlpha(draft.data.bg.reading.params.presence, "reading" as BgSurface)
          : 0,
        /** null = the theme's own desk colour, which is what `--pd` already is. */
        tint: readOverlay.tint,
        paint: readOverlay.paint,
      }
    : null;

  /**
   * The palette, on the stage, as the design declares it on its frame.
   *
   * `--pf` (faint) is not a stored colour: the design derives it as the muted ink pulled most of the
   * way back to the paper, and it is the only place the sixteen do not already supply a value.
   *
   * `--pgo` is 1 with no background, which is production's rule rather than the mock's — page
   * translucency only means something when there is an image to be translucent against, and the real
   * reading surface composites it exactly this way: the PAPER thins, never the words on it.
   */
  /** The page the READER would be given for this draft — the paper, the frost and the desk all
      composite from this one number, as they do on the reading surface. */
  const previewPageOpacity = effectivePageOpacity({
    enabled: true,
    reading: bookUrl ? draft.data.bg.reading : null,
    readingParams: draft.data.bg.reading.params,
  } as Parameters<typeof effectivePageOpacity>[0]);

  // The colours THIS FACE will actually be rendered with. The library's panel depth is applied by
  // the same function the running app uses, so the preview cannot drift from the result; the book
  // face is deliberately outside its reach and reads its palette straight.
  const shown =
    previewScope === "library"
      ? libraryColors(draft.data.theme.library)
      : draft.data.theme.reading.colors;
  const stageVars = {
    "--pp": shown.paperBg,
    "--pd": shown.surfaceBg,
    "--pc": shown.chromeBg,
    "--pb": shown.chromeBorder,
    "--px": shown.text,
    "--pm": shown.muted,
    "--pa": shown.accent,
    "--pf": `color-mix(in srgb, ${shown.muted} 62%, ${shown.paperBg})`,
    // THE PREVIEW SHOWS WHAT THE APP WILL RENDER, not what the step asks for.
    // `TEXTURE_ALPHA` is the step's raw wish; `effectiveTextureAlpha` is that wish clamped against
    // the live desk scrim and the active theme, which is what `applyTexture` actually writes. Glass
    // asks for 0.78 and the measured floor is 0.800, so the raw value promised a panel thinner than
    // the reader will ever be given. Same function as the real path — one answer, not two.
    // THE SAME THREE VARIABLES THE APPLICATION READS, so `.pf-lib-side` can carry the application's
    // own formula verbatim instead of computing a second answer. Measured before this: the preview
    // painted 90/85.6/78% while the real sidebar painted 85/80/80% — two different renderings of one
    // setting, and neither the user nor the harness could see they disagreed.
    "--ui-k": stepK(draft.data.texture),
    "--ui-floor": `${(minChromeAlpha(worstDeskScrim(), libraryColors(draft.data.theme.library)) * 100).toFixed(2)}%`,
    "--ui-frost": `${stepBlur(draft.data.texture)}px`,
    "--ui-sat": stepSat(draft.data.texture),
    "--ui-bright": stepBright(draft.data.texture),
    // The panel's base, the same value `applyTexture` writes to the root: once a profile governs
    // the surface, texture owns it, and `opaque` means the full panel.
    "--ui-base": "100%",
    // THE PREVIEW SHOWS THE PAGE THE READER WILL BE GIVEN, not the number the profile stores.
    //
    // `effectivePageOpacity` is the reader's own rule: no reading image means a fully opaque page,
    // and a stored value below the measured AAA floor is lifted to it. This read the raw number, so
    // a profile carrying, say, 0.5 previewed a sheet half-transparent with the photograph blazing
    // through behind the words — a page the reader would never actually render, because the reader
    // clamps it to 0.84. Same function on both sides, so the preview cannot promise what the
    // reading surface will refuse to deliver. (The same fault the texture step had.)
    // THE RAW VALUE, exactly as the reading surface paints it. One setting, one meaning.
    //
    // This ran the number through `pageComposite` — `1-(1-a)^3` — because the paper USED to be
    // painted three times: the sheet, foliate's part, and the paginator's `#background part=filter`.
    // That triple paint is gone. `injectedCss.ts` records it as a defect ("Page opacity appeared to
    // work and did nothing where it mattered"), invariant I-4 now says exactly ONE surface paints
    // the paper, and `paperWithOpacity` returns `transparent` for the inner ones to enforce it.
    //
    // So the compensation outlived the thing it compensated for, and the preview was the only place
    // still applying it. Measured on one profile at the stored 0.84: the reader wrote
    // `--bg-page-opacity: 84.00%` and painted its sheet at `rgb(0 0 0 / 0.84)`, while this preview
    // rendered 0.995904 — sixteen points more opaque, which is why moving the control looked like it
    // did nothing here and plainly worked there.
    //
    // `effectivePageOpacity` above is still the reader's own gate (no reading image means a fully
    // opaque page, and the AAA floor is honoured), so the two sides share the value, the range, the
    // floor AND now the rendering.
    "--pgo": previewPageOpacity,
    // The reading desk's own blur, which this preview never applied, and the frost the page adds
    // when it is thin enough to see through. Same two numbers the reading surface composites.
    "--pblur": `${Math.max(0, draft.data.bg.reading.params.blur)}px`,
    "--pf-page-w": `${previewPageWidth(pageW)}px`,
  } as CSSProperties;

  /** Each chapter's current answer, under its name in the rail. */
  const chapterValue = (id: ChapterId): string => {
    switch (id) {
      case "identity":
        return draft.name?.trim() || "—";
      case "paper":
        return themeName;
      case "paperBook":
        return paletteName("reading");
      case "background": {
        // One line for both surfaces, because the chapter covers both. The library names the image;
        // the book adds itself only when it carries one the library does not.
        const lib = bgName(draft.data.bg.library.ref);
        const book = draft.data.bg.reading.sameAsLibrary
          ? t("profiles.bg.sameAsLibraryShort")
          : bgName(draft.data.bg.reading.ref);
        if (!lib && !book) return "—";
        return [lib, book].filter(Boolean).join(" · ");
      }
      case "fonts":
        return t("profiles.fonts.three");
      case "marks":
        return t(`profiles.shape.${draft.data.marks.bookmarkShape}`);
      case "measure": {
        // The rail says how many opinions this chapter holds, not a value — there are ten, and any
        // one of them would misrepresent the rest.
        const held = TYPOGRAPHY_KEYS.filter((k) => draft.data.type.reading[k] !== null).length;
        return held ? localeDigits(String(held), lang) : t("profiles.measure.follows");
      }
      case "texture":
        return t(`profiles.texture.${draft.data.texture}`);
    }
  };

  const chapterDirty = (id: ChapterId): boolean =>
    JSON.stringify(chapterSlice(draft, id)) !== JSON.stringify(chapterSlice(live, id));

  const chapterBody = (id: ChapterId): React.ReactNode => {
    switch (id) {
      case "identity":
        return (
          <IdentitySection
            draft={draft}
            setDraft={setDraft}
            rows={bgRows}
            onImported={addBgRow}
            erased={erasedName}
            nameNoteId={nameNoteId}
          />
        );
      // ONE SECTION, TWO SURFACES. The chapters differ in which palette they edit and which face
      // the stage locks to — not in what they contain — so there is one implementation and no
      // second copy of the colour editor to keep in step.
      case "paper":
      case "paperBook":
        // KEYED BY SCOPE, so switching surfaces gives the chapter a fresh start. `InlineColours`
        // keeps the raw text of a half-typed hex in local state, and without a remount that buffer
        // followed the reader across: measured, entering «ألوان الكتب», typing there, and returning
        // to «ألوان المكتبة» showed the BOOK's code in the library's field while the library's own
        // colour was still correctly applied. Two surfaces, two lots of local state.
        return <ThemeSection key={scope} draft={draft} patch={patch} scope={scope} />;
      case "measure":
        return (
          <MeasureSection
            value={draft.data.type.reading}
            fallback={readerStyle}
            onChange={(p) => patch((d) => { d.type.reading = { ...d.type.reading, ...p }; })}
          />
        );
      case "background":
        return (
          <>
            {/* EACH SECTION SHOWS ITS OWN FACE.
                Every other chapter locks the preview to the surface it governs; `background` alone
                has `face: null`, because it governs both. The consequence, measured in the running
                editor: the book background's layers exist ONLY on the book face, so moving the book
                presence while the library face was up changed nothing anybody could see — the
                value was correct at every step (scrim 1.000 → 0.886 → 0.772 → 0.620 → 0.316 →
                0.012 across 0..260) and none of it was on screen.

                Touching a section now brings its own face forward. The chapter keeps its freedom to
                show either — the segmented control above the preview still switches by hand — but a
                change can no longer happen somewhere the reader is not looking. */}
            <div className="pf-field-label">{t("profiles.section.libraryBg")}</div>
            <BackgroundSection
              surface="library"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={addBgRow}
              onTouch={() => setFace("library")}
            />
            <div className="pfe-ch-rule" role="separator" />
            <div className="pf-field-label">{t("profiles.section.bookBg")}</div>
            <BackgroundSection
              surface="reading"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={addBgRow}
              onTouch={() => setFace("book")}
            />
          </>
        );
      case "fonts":
        return <FontsSection draft={draft} patch={patch} />;
      case "marks":
        return <MarksSection draft={draft} patch={patch} />;
      case "texture":
        return <TextureSection draft={draft} patch={patch} libBg={libBg} />;
    }
  };

  /**
   * Opening a chapter turns the preview to the face that chapter governs. The segmented control
   * stays: the focus is where the chapter POINTS, not a cage, and `background` governs both faces
   * at once so it moves nothing.
   */
  const openChapter = (id: ChapterId) => {
    setChapter(id);
    const f = FOCUS[id].face;
    if (f) setFace(f);
  };

  // PORTALLED TO `document.body`, and it has to be. `.gs` (the settings window) carries
  // `transform: translate(-50%,-50%)`, and a transform makes an element the containing block for
  // every `position: fixed` descendant — so rendered in place this full-surface editor was confined
  // to the 960x660 settings window and clipped by its `overflow: hidden`. Measured in the running
  // app before this was added.
  return createPortal(
    <>
    {share && <ShareSheet profile={live} onClose={() => setShare(false)} />}
    <div className="pf-editor" ref={dlg.ref} {...dlg.props}>
      <div className="pf-editor-head">
        {/* THE PROFILE'S OWN FACE, beside its name. The toolbar named the profile but never showed
            it, so the one surface that is always on screen while you edit gave no sign of which
            profile you were editing beyond a word. Same three-way as the card: a chosen image, a
            chosen colour, or the initial — an image whose row has not loaded falls back to the
            initial rather than to a hole. */}
        <span
          className="pf-editor-seal"
          style={{
            background: draft.data.theme.library.colors.paperBg,
            color: headSeal.text === SEAL_DIAMOND
              ? draft.data.theme.library.colors.accent
              : draft.data.theme.library.colors.text,
            fontFamily: headSeal.fontFamily,
          }}
          aria-hidden
        >
          {draft.iconKind === "color" && draft.iconRef ? (
            <span className="pf-editor-seal-dot" style={{ background: draft.iconRef }} />
          ) : iconUrl ? (
            <span
              className="pf-editor-seal-img"
              style={{ backgroundImage: `url("${iconUrl}")`, ...markFrame(draft.data.icon) }}
            />
          ) : (
            headSeal.text
          )}
        </span>
        <span className="pf-editor-ident">
          <span className="pf-editor-title" id={dlg.titleId} dir="auto">
            {profileLabel(draft.name, t("profiles.unnamed"))}
          </span>
          <span className="pf-editor-sub">{t("profiles.editor.subtitle")}</span>
        </span>
        {dirty && <span className="pf-editor-dirty">{t("profiles.editor.unsaved")}</span>}
        <span className="pf-editor-spacer" />
        {/* The design's own head carries sharing beside Save. Disabled while the draft is dirty:
            a package is made from the SAVED profile, and exporting one that does not match what is
            on screen would send something the reader never saw. */}
        <button className="pf-btn" disabled={dirty} title={dirty ? t("profiles.editor.unsaved") : undefined}
          // Sharing packages the profile as SAVED, so unsaved changes would simply not travel.
          onClick={() => { if (!profileChangePending()) guardUnsaved(() => setShare(true)); }}>
          {t("profiles.card.share")}
        </button>
        <button
          className="pf-btn primary"
          disabled={!dirty || erasedName}
          title={erasedName ? t("profiles.identity.nameRequired") : undefined}
          onClick={() => void save()}
        >
          {t("profiles.editor.save")}
        </button>
        <button
          className="pf-editor-x"
          // THE DRAFT IS THE THING AT RISK HERE. It is never applied, so `driftOf` cannot see it and
          // re-applying the profile would not undo it — the gate is told about it and given the two
          // verbs that mean something for a draft: commit it, or drop it.
          onClick={askToLeave} aria-label={t("profiles.editor.close")}>
          <Icon name="close" size="sm" />
        </button>
      </div>

      {/* RAIL FIRST, then the chapter, then the preview — the design's own order. The rail carries
          `border-inline-end`, which puts it at the inline START: the right in Arabic, the left in
          English. */}
      <div className="pf-editor-body">
        <EditorShell
          active={chapter}
          onSelect={openChapter}
          value={chapterValue}
          dirty={chapterDirty}
          preview={(focus: Focus) => (
            /* THE PREVIEW — what you see here is what you will see in Sard.
               The stage is both the coordinate system and the palette scope: every layer below is an
               absolutely-positioned sibling in one paint order, and the faces read these `--p*`
               properties rather than taking colours as props. */
            <div className="pf-stage" style={stageVars} ref={stageRef}>
              {/* THE COMPOSITION, at the size the design drew it and scaled to fit. */}
              {/* THE PICTURE IS NOT HERE ANY MORE. Each face carries its own, bounded by the thing
                  it belongs to — the library by the library, the book's by the page — because a face
                  cannot confine a layer that is not its descendant. */}
              <div className="pf-stage-fit">
                {/* THE READING ENVIRONMENT, for the book face only. The picture belongs to the desk
                    the sheet lies on, not to the sheet — which is what keeps the page and its
                    environment two independent spaces, so moving the measure resizes the page and
                    reveals more environment rather than resizing both. The library's picture is not
                    here: it belongs to the library window, and lives inside the face itself. */}
                {face === "book" && bookBg && (
                  <>
                    <span
                      className="pf-stage-bg"
                      style={{
                        backgroundImage: `url("${bookBg.url}")`,
                        backgroundPosition: `${bookBg.params.focalX}% ${bookBg.params.focalY}%`,
                        // THE PAGE'S FROST IS A FLOOR ON THE DESK'S BLUR, exactly as the reading
                        // surface composites it. Written HERE and not in the stylesheet because this
                        // inline filter is what the element actually renders — a `.pf-stage-bg` rule
                        // is overridden by it, which is why the stylesheet's version was inert.
                        filter: `blur(${bookBg.params.blur}px)`,
                        transform: `scaleX(${bookBg.params.flip ? -1 : 1})`,
                      }}
                      aria-hidden
                    />
                    {bookBg.paint && (
                    <span
                      className="pf-stage-scrim"
                      style={{ opacity: bookBg.scrim, ...(bookBg.tint ? { background: bookBg.tint } : {}) }}
                      aria-hidden
                    />
                  )}
                  </>
                )}
                {face === "library"
                  ? <LibraryFace profile={draft} iconUrl={iconUrl} bg={libBg} />
                  : <BookFace profile={draft} readerStyle={readerStyle} pageWidth={pageW} />}
              </div>

              {/* The face switch is a CONTROL, not part of the picture, so it stays on the stage at
                  a constant size instead of scaling with the composition. */}
              <div className="pf-stage-segbar">
                <div className="pf-stage-seg" role="group">
                  <button className={face === "library" ? "on" : ""} onClick={() => setFace("library")}>
                    {t("profiles.editor.stageLibrary")}
                  </button>
                  <button className={face === "book" ? "on" : ""} onClick={() => setFace("book")}>
                    {t("profiles.editor.stageBook")}
                  </button>
                </div>
                {/* ON THE STAGE, NOT IN A CHAPTER, and only where a page exists to measure. The rail
                    tells the reader in as many words that page width is not part of a profile; a
                    slider sitting among the chapters would say the opposite. Here it is plainly what
                    it is — something that changes what you are looking at, not what you are saving. */}
                {face === "book" && (
                  <label className="pf-stage-measure" title={t("profiles.preview.measureHint")}>
                    <span>{t("profiles.preview.measure")}</span>
                    <input
                      type="range"
                      min={PAGE_WIDTH_MIN}
                      max={PAGE_WIDTH_MAX}
                      step={0.01}
                      value={pageW}
                      onChange={(e) => setPageW(Number(e.target.value))}
                    />
                  </label>
                )}
              </div>

              {/* WHAT THIS CHAPTER GOVERNS, drawn around the object itself. It sits OUTSIDE the
                  scaled composition and measures its target in the stage's own pixels, so the
                  hairline stays a hairline and the frame follows anything the reader moves. */}
              <FocusFrame
                targets={focus.targets}
                label={focus.label ? t(focus.label) : null}
                stage={stageRef}
              />
            </div>
          )}
          railFooter={
            /* The firewall. Not a control, and not a chapter — the one place the boundary is stated. */
            <div className="pf-firewall">
              <div className="pf-firewall-title">{t("profiles.notPart.title")}</div>
              <p className="pf-firewall-body">{t("profiles.notPart.body")}</p>
            </div>
          }
        >
          {chapterBody(chapter)}
        </EditorShell>
      </div>
    </div>
    </>,
    document.body,
  );
}

// ---- sections ------------------------------------------------------------------------------------

/**
 * The four seals the design offers, in its order.
 *
 * The first is not one of the design's — it is today's behaviour made explicit, so a reader who
 * never touches this keeps exactly the seal they already had and can always get back to it. The
 * other three are the design's: the same letter in two named faces, then its diamond.
 */
const SEAL_OPTIONS = [
  { face: "profile",   glyph: "initial", label: "profiles.identity.sealProfileFace" },
  { face: "arefRuqaa", glyph: "initial", label: "profiles.identity.sealAref" },
  { face: "amiri",     glyph: "initial", label: "profiles.identity.sealAmiri" },
  { face: "profile",   glyph: "diamond", label: "profiles.identity.sealDiamond" },
] as const satisfies readonly { face: ProfileSeal["face"]; glyph: ProfileSeal["glyph"]; label: TKey }[];

/**
 * THE IDENTITY PAGE — one thing being named, not a form about a profile.
 *
 * It opens on the pair that IS the identity: the mark and the name, at the top, the name given the
 * larger setting because it is the thing being named. Below it, one question — «الرمز» — answered
 * three ways, and under the answer, the controls that belong to THAT answer and nothing else.
 *
 * THE PAGE HAS TWO TIERS AND KEEPS THEM APART. The kind is a choice, so it is a segmented three-way
 * at one height; everything under it is an action or a variant, so it is quieter and shorter. Before
 * this the two were interleaved: one of the three kinds was labelled with a verb («＋ اختيار صورة»),
 * which both wrapped — measured 54px tall against 42px with the wrap removed, in ALL THREE buttons,
 * because a flex row is as tall as its tallest item — and opened a file dialog from what claimed to
 * be a radio. The same dialog was then offered a second time by «استبدال…» directly beneath it.
 * Nouns choose; verbs act; they no longer share a row.
 */
function IdentitySection({
  draft,
  setDraft,
  rows,
  onImported,
  erased,
  nameNoteId,
}: {
  draft: Profile;
  setDraft: React.Dispatch<React.SetStateAction<Profile>>;
  rows: BackgroundRow[];
  onImported: (row: BackgroundRow) => void;
  /** The saved profile HAS a name and the draft has blanked it — see `erasedName`. */
  erased: boolean;
  nameNoteId: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [framing, setFraming] = useState(false);
  /**
   * LEAVING THE IMAGE KIND IS NOT A ONE-WAY DOOR — the simplest form of that, and deliberately no
   * more.
   *
   * `iconRef` holds one thing at a time and means something different for each kind, so choosing a
   * colour overwrites the picture's hash with a hex and the picture is gone. It always was: going
   * image → seal → image reopened the file dialog and asked for a picture the profile still had.
   * Arrow keys made that a single keystroke away, which is how it was found.
   *
   * So one piece of component state remembers the last picture this editor showed, WITH ITS
   * FRAMING, and every route back to the image kind consults it first. It is not persisted and not
   * undo history: closing the editor ends it, exactly as every other unsaved thing here does.
   *
   * `offered` is separate and narrower — it is what puts «إعادة الصورة» on screen, and only an
   * explicit removal sets it. Merely glancing at another kind should not grow a button.
   */
  const [kept, setKept] = useState<{ ref: string; icon: ProfileIcon } | null>(null);
  const [offered, setOffered] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const sealArt = sealOf(draft);
  const colour = draft.iconKind === "color";
  const image = draft.iconKind === "image";
  const sealKind = !colour && !image;
  // `iconRef` is overloaded — a hex for a colour icon, a content hash for an image — so the row is
  // only looked up when the kind says there is one to find.
  const iconRow = image && draft.iconRef ? rows.find((r) => r.id === draft.iconRef) ?? null : null;
  const frame = draft.data.icon;
  // The colour the mark is actually wearing, and whether it is one the eight can express. `own` is
  // what makes the custom chip a SELECTED thing rather than a permanent invitation.
  const markColour = colour && draft.iconRef ? draft.iconRef : draft.data.theme.library.colors.accent;
  const own =
    colour && !!draft.iconRef &&
    !BOOKMARK_COLORS.some((c) => c.hex.toLowerCase() === (draft.iconRef ?? "").toLowerCase());

  /**
   * THE MANAGED PIPELINE, NOT A SECOND ONE. An icon is an image like any other: `background_import`
   * copies it into the managed directory, dedupes it by content and records the row, which is what
   * makes it collectable — and, once the draft is saved and `icon_ref` reaches the column, what makes
   * it survive collection. `backgrounds::gc()` counts that column as its fourth reference source.
   *
   * A NEW PICTURE ARRIVES UNFRAMED. Carrying the previous picture's framing onto a different one
   * would apply a crop chosen for a composition this image does not have; centre is the only framing
   * that means the same thing for every picture.
   */
  const pickIcon = async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const imported = await backgroundImport(picked);
      onImported(imported);
      setDraft((d) => ({
        ...d,
        iconKind: "image",
        iconRef: imported.id,
        data: { ...d.data, icon: { ...ICON_FRAME_DEFAULT } },
      }));
      setKept(null);
      setOffered(false);
      setFraming(true);
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("bg.err.") ? t(code as TKey) : code);
    } finally {
      setBusy(false);
    }
  };

  const chooseKind = (kind: Profile["iconKind"]) => {
    setFraming(false);
    setPickerOpen(false);
    // Whatever the reader goes on to choose, the picture they are leaving is remembered first.
    if (kind !== "image" && image && draft.iconRef) {
      setKept({ ref: draft.iconRef, icon: frame });
      setOffered(false);
    }
    if (kind === "seal") {
      setDraft((d) => ({ ...d, iconKind: "seal", iconRef: null }));
      return;
    }
    if (kind === "color") {
      setDraft((d) => ({
        ...d,
        iconKind: "color",
        // Switching AWAY from an image must not carry its hash into the colour slot — the column
        // means something different for each kind.
        iconRef: d.iconKind === "color" && d.iconRef ? d.iconRef : d.data.theme.library.colors.accent,
      }));
      return;
    }
    if (image) return;
    // A picture already chosen and still resolvable is SELECTED, not asked for again. Only a kind
    // with nothing behind it opens a dialog.
    if (draft.iconRef && rows.some((r) => r.id === draft.iconRef)) {
      setDraft((d) => ({ ...d, iconKind: "image" }));
    } else if (kept && rows.some((r) => r.id === kept.ref)) {
      setDraft((d) => ({
        ...d, iconKind: "image", iconRef: kept.ref, data: { ...d.data, icon: kept.icon },
      }));
      setOffered(false);
    } else {
      // THE KIND CHANGES FIRST, AND THEN THE DIALOG OPENS. If the dialog owned the change, cancelling
      // it would leave the reader on the kind they came from and the empty state below could never
      // be seen at all — the one screen that says what to do next would be unreachable by the only
      // route to it. Choosing "a picture" is an answer to «الرمز» whether or not a file follows.
      setDraft((d) => ({ ...d, iconKind: "image", iconRef: null }));
      void pickIcon();
    }
  };

  const removeImage = () => {
    if (draft.iconRef) { setKept({ ref: draft.iconRef, icon: frame }); setOffered(true); }
    setFraming(false);
    setDraft((d) => ({ ...d, iconKind: "seal", iconRef: null }));
  };

  const restoreImage = () => {
    if (!kept) return;
    setDraft((d) => ({
      ...d, iconKind: "image", iconRef: kept.ref, data: { ...d.data, icon: kept.icon },
    }));
    setOffered(false);
  };

  const setFrame = (next: Partial<ProfileIcon>) =>
    setDraft((d) => ({ ...d, data: { ...d.data, icon: { ...d.data.icon, ...next } } }));

  // A press anywhere else finishes choosing, exactly as the paper chapter's pickers behave.
  useEffect(() => {
    if (!pickerOpen) return;
    const away = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (el.closest(".pf-ink-picker") || el.closest(".pf-mark-custom")) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [pickerOpen]);

  const KINDS = [
    { id: "seal" as const, on: sealKind, label: t("profiles.identity.iconSeal") },
    { id: "color" as const, on: colour, label: t("profiles.identity.iconColour") },
    { id: "image" as const, on: image, label: t("profiles.identity.iconImage") },
  ];

  /**
   * ARROW KEYS, BECAUSE THE MARKUP CLAIMS A RADIOGROUP. It always did, and it never behaved as one:
   * measured, all three buttons sat in the tab order and ArrowRight moved nothing. A radiogroup is
   * ONE tab stop with the arrows moving inside it, so that is what this is.
   *
   * READING ORDER, NOT SCREEN ORDER. The arrows follow the direction the interface is written in, so
   * in Arabic ArrowLeft advances — that is what a reader of Arabic means by "next".
   */
  const onKindKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const rtl = document.documentElement.dir === "rtl";
    const step =
      e.key === "ArrowDown" ? 1
      : e.key === "ArrowUp" ? -1
      : e.key === "ArrowRight" ? (rtl ? -1 : 1)
      : e.key === "ArrowLeft" ? (rtl ? 1 : -1)
      : 0;
    let next = -1;
    if (step) next = (i + step + KINDS.length) % KINDS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = KINDS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const group = e.currentTarget.parentElement;
    const btn = group?.querySelectorAll<HTMLButtonElement>(".pf-icon-kind")[next];
    btn?.focus();
    chooseKind(KINDS[next].id);
  };

  // The mark, drawn exactly as every other surface draws it — so what the page shows IS what the
  // cards, the chip and the switcher will show. `markFrame` is the single source of that.
  const markInner =
    colour && draft.iconRef ? (
      <span className="pf-icon-now-dot" style={{ background: draft.iconRef }} />
    ) : iconRow ? (
      <span
        className="pf-icon-now-img"
        style={{ backgroundImage: `url("${bgSrcUrl(iconRow)}")`, ...markFrame(frame) }}
      />
    ) : (
      sealArt.text
    );
  const markStyle: CSSProperties = {
    background: draft.data.theme.library.colors.paperBg,
    color: sealArt.text === SEAL_DIAMOND
      ? draft.data.theme.library.colors.accent
      : draft.data.theme.library.colors.text,
    fontFamily: sealArt.fontFamily,
  };
  const markEmpty = image && !iconRow;

  return (
    <>
      {/* THE LEAD — the mark and the name, together, at the top of the first page.
          They were two stacked fields of equal weight, one of them a small input among many, so the
          page opened on no subject in particular. A profile IS its name and its mark; pairing them
          and giving the name the larger setting is what makes this read as the identity of something
          rather than as the first two rows of a form. The row is `flex` with logical spacing, so it
          mirrors in Arabic without a second rule.

          THE MARK IS A CONTROL WHEN THERE IS SOMETHING TO DO TO IT. With a picture it opens the
          framing; with none it asks for one. It was `aria-hidden` and unreachable by keyboard while
          being the subject of the page. For a seal or a colour it stays exactly what it was —
          presentational — because the controls below already own those two choices, and a button
          that does nothing is worse than no button. */}
      <div className="pf-identity-lead">
        {image ? (
          <button
            type="button"
            className={`pf-icon-now pf-icon-now--lead pf-icon-now--live${markEmpty ? " pf-icon-now--empty" : ""}${framing ? " on" : ""}`}
            style={markStyle}
            onClick={() => (markEmpty ? void pickIcon() : setFraming((v) => !v))}
            aria-expanded={markEmpty ? undefined : framing}
            aria-label={markEmpty ? t("gs.bg.choose") : t("profiles.identity.frame")}
            title={markEmpty ? t("gs.bg.choose") : t("profiles.identity.frame")}
          >
            {markEmpty ? <span className="pf-icon-now-plus" aria-hidden>＋</span> : markInner}
          </button>
        ) : (
          <span className="pf-icon-now pf-icon-now--lead" style={markStyle} aria-hidden>
            {markInner}
          </span>
        )}
        <label className="pf-field pf-identity-namefield">
          <span className="pf-field-label">{t("profiles.identity.name")}</span>
          <input
            className={`pf-input pf-input--lead${erased ? " pf-input--bad" : ""}`}
            value={draft.name ?? ""}
            dir="auto"
            maxLength={PROFILE_NAME_MAX}
            aria-invalid={erased || undefined}
            aria-describedby={erased ? nameNoteId : undefined}
            placeholder={t("profiles.identity.namePlaceholder")}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {erased && (
            <span className="pf-field-note" id={nameNoteId}>{t("profiles.identity.nameRequired")}</span>
          )}
        </label>
      </div>

      {/* THE KIND — three nouns, one tab stop, one height. The seal is not a placeholder for the
          image: the design calls the initial "a type specimen, not clip art", so it stays a real
          choice a reader may prefer to keep. Each preview shows what ITS OWN kind would look like;
          what the profile looks like NOW is the lead above, once, large. */}
      <div className="pf-field">
        <span className="pf-field-label" id="pf-kind-label">{t("profiles.identity.icon")}</span>
        <div className="pf-icon-kinds" role="radiogroup" aria-labelledby="pf-kind-label">
          {KINDS.map((k, i) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={k.on}
              tabIndex={k.on ? 0 : -1}
              className={`pf-icon-kind${k.on ? " on" : ""}`}
              onClick={() => chooseKind(k.id)}
              onKeyDown={(e) => onKindKey(e, i)}
            >
              <span
                className="pf-seal"
                style={
                  k.id === "seal"
                    ? {
                        background: draft.data.theme.library.colors.paperBg,
                        color: draft.data.theme.library.colors.text,
                        fontFamily: sealArt.fontFamily,
                      }
                    : k.id === "color"
                      ? { background: draft.data.theme.library.colors.paperBg }
                      : {
                          background: draft.data.theme.library.colors.paperBg,
                          color: draft.data.theme.library.colors.muted,
                        }
                }
              >
                {k.id === "seal" && sealArt.text}
                {k.id === "color" && (
                  <span
                    className="pf-seal-dot"
                    style={{
                      background: colour && draft.iconRef ? draft.iconRef : draft.data.theme.library.colors.accent,
                    }}
                  />
                )}
                {k.id === "image" &&
                  (iconRow ? (
                    <span
                      className="pf-seal-img"
                      style={{ backgroundImage: `url("${bgSrcUrl(iconRow)}")`, ...markFrame(frame) }}
                    />
                  ) : (
                    // NOT migrated to the icon set: this mark lives inside `.pf-seal`, which is one
                    // of the protected identity components (with `.pf-card` and `.pf-mini`).
                    "▣"
                  ))}
              </span>
              <span className="pf-icon-kind-label">{k.label}</span>
            </button>
          ))}
        </div>

        {/* ONE CONTEXTUAL ROW — what belongs to the kind that is actually chosen, and nothing else. */}
        {image && iconRow && (
          <div className="pf-icon-acts">
            <button
              type="button"
              className={`pf-btn${framing ? " on" : ""}`}
              onClick={() => setFraming((v) => !v)}
              aria-expanded={framing}
            >
              {t("profiles.identity.frame")}
            </button>
            <button type="button" className="pf-btn" disabled={busy} onClick={() => void pickIcon()}>
              {busy ? t("gs.bg.preparing") : t("gs.bg.replace")}
            </button>
            <button type="button" className="pf-btn" onClick={removeImage}>
              {t("gs.bg.remove")}
            </button>
          </div>
        )}

        {/* THE EMPTY STATE — one thing to do, said once. The mark above is the target; this is the
            same act in words, for a reader who is looking at the row rather than at the mark. */}
        {markEmpty && (
          <div className="pf-icon-acts">
            <button
              type="button"
              className="pf-btn primary"
              disabled={busy}
              onClick={() => void pickIcon()}
            >
              {busy ? t("gs.bg.preparing") : t("gs.bg.choose")}
            </button>
            <span className="pf-icon-acts-note">{t("gs.bg.formats")}</span>
          </div>
        )}

        {/* Removal offered its own way back, for as long as this editor is open. */}
        {kept && offered && !image && (
          <div className="pf-icon-acts">
            <button type="button" className="pf-btn" onClick={restoreImage}>
              {t("profiles.identity.restore")}
            </button>
          </div>
        )}

        {framing && iconRow && (
          <FramingPanel
            row={iconRow}
            icon={frame}
            paper={draft.data.theme.library.colors.paperBg}
            onChange={setFrame}
            onReset={() => setFrame({ ...ICON_FRAME_DEFAULT })}
            onDone={() => setFraming(false)}
          />
        )}

        {error && <div className="pf-contrast warn">{error}</div>}

        {/* HOW THE SEAL IS DRAWN — the design's four, on the profile's own paper so each is judged
            in the colours it will actually wear. The first follows the profile's book face, which is
            what every seal did before there was a choice; the other three are the design's. */}
        {sealKind && (
          <div className="pf-seal-faces" role="radiogroup" aria-label={t("profiles.identity.sealStyle")}>
            {SEAL_OPTIONS.map((o, i) => {
              const on = draft.data.seal.face === o.face && draft.data.seal.glyph === o.glyph;
              const text = o.glyph === "diamond"
                ? SEAL_DIAMOND
                : (draft.name ?? "").trim().slice(0, 1) || "س";
              const choose = (n: number) => {
                const p = SEAL_OPTIONS[n];
                setDraft((d) => ({
                  ...d, data: { ...d.data, seal: { face: p.face, glyph: p.glyph } },
                }));
              };
              return (
                <button
                  key={o.face + o.glyph}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  title={t(o.label)}
                  aria-label={t(o.label)}
                  className={`pf-seal-face${on ? " on" : ""}`}
                  style={{
                    background: draft.data.theme.library.colors.paperBg,
                    color: o.glyph === "diamond"
                      ? draft.data.theme.library.colors.accent
                      : draft.data.theme.library.colors.text,
                    fontFamily: bookFaceCss(o.face === "profile" ? draft.data.type.arabic : o.face),
                    fontWeight: o.face === "amiri" ? 700 : 400,
                  }}
                  onKeyDown={(e) => {
                    const rtl = document.documentElement.dir === "rtl";
                    const step =
                      e.key === "ArrowDown" ? 1
                      : e.key === "ArrowUp" ? -1
                      : e.key === "ArrowRight" ? (rtl ? -1 : 1)
                      : e.key === "ArrowLeft" ? (rtl ? 1 : -1)
                      : 0;
                    let next = -1;
                    if (step) next = (i + step + SEAL_OPTIONS.length) % SEAL_OPTIONS.length;
                    else if (e.key === "Home") next = 0;
                    else if (e.key === "End") next = SEAL_OPTIONS.length - 1;
                    if (next < 0) return;
                    e.preventDefault();
                    e.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>(".pf-seal-face")[next]?.focus();
                    choose(next);
                  }}
                  onClick={() => choose(i)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        )}

        {/* THE COLOUR — the eight named ones, and Sard's own picker for anything else. The row
            offered only the eight, while every colour control in the Reader now opens the same
            picker and accepts a typed code; a mark was the one place left where "some other colour"
            had no answer. The picker is the editor's own inline one — the pattern the paper chapter
            already uses — so this page borrows nothing from the Reader's chrome. */}
        {colour && (
          <div className="pf-mark-colours">
          <div className="pf-bm-colors" role="radiogroup" aria-label={t("profiles.identity.colourGroup")}>
            {BOOKMARK_COLORS.map((c, i) => {
              const on = (draft.iconRef ?? "").toLowerCase() === c.hex.toLowerCase();
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on || (i === 0 && !BOOKMARK_COLORS.some((x) =>
                    (draft.iconRef ?? "").toLowerCase() === x.hex.toLowerCase())) ? 0 : -1}
                  className={`pf-bm-color${on ? " on" : ""}`}
                  style={{ background: c.hex }}
                  onClick={() => setDraft((d) => ({ ...d, iconRef: c.hex }))}
                  onKeyDown={(e) => {
                    const rtl = document.documentElement.dir === "rtl";
                    const step =
                      e.key === "ArrowDown" ? 1
                      : e.key === "ArrowUp" ? -1
                      : e.key === "ArrowRight" ? (rtl ? -1 : 1)
                      : e.key === "ArrowLeft" ? (rtl ? 1 : -1)
                      : 0;
                    let next = -1;
                    if (step) next = (i + step + BOOKMARK_COLORS.length) % BOOKMARK_COLORS.length;
                    else if (e.key === "Home") next = 0;
                    else if (e.key === "End") next = BOOKMARK_COLORS.length - 1;
                    if (next < 0) return;
                    e.preventDefault();
                    e.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>(".pf-bm-color")[next]?.focus();
                    setDraft((d) => ({ ...d, iconRef: BOOKMARK_COLORS[next].hex }));
                  }}
                  title={c.name}
                  aria-label={c.name}
                />
              );
            })}
          </div>

          {/* ANYTHING ELSE — an ACT, not a ninth colour.
              It was a 22px circle wearing a colour wheel, squeezed down from the Reader's own 34px
              control and sitting in a row of eight round swatches: a thing that looked like a choice
              but behaved like a button, and read as something stuck to the end of the row. This is
              the same picker and the same behaviour, said in the identity page's own language — a
              chip at the action tier, held clear of the swatches by a hairline, carrying the colour
              it would open on. When the mark wears a colour that is NOT one of the eight, the chip
              is the selected one and says so with the ring the swatches use. */}
          <span className="pf-mark-sep" aria-hidden />
          <button
            type="button"
            className={`pf-mark-custom${own ? " on" : ""}${pickerOpen ? " open" : ""}`}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <span className="pf-mark-custom-dot" style={{ background: markColour }} aria-hidden />
            {t("profiles.identity.colourCustom")}
          </button>
          </div>
        )}

        {colour && pickerOpen && (
          <div className="pf-ink-picker">
            <ColorPicker
              value={markColour}
              onChange={(hex) => setDraft((d) => ({ ...d, iconRef: hex }))}
              onDone={() => setPickerOpen(false)}
              presets={BOOKMARK_COLORS.map((c) => c.hex)}
              contrastAgainst={draft.data.theme.library.colors.paperBg}
            />
          </div>
        )}
      </div>

      {sealKind && <div className="pf-hint">{t("profiles.identity.sealHint")}</div>}
    </>
  );
}

/**
 * FRAMING — a crop control, not an image editor.
 *
 * `cover` fits a picture to a square and throws the rest away; until now nothing said WHICH part it
 * threw away, so a portrait became a chin and a landscape became a middle. This is the one place
 * that decision is made, and it is made by looking at the picture: drag it to where it should sit,
 * bring it closer if it should be closer, and the mark at the top of the page — the same mark the
 * cards, the chip and the switcher draw — moves with it.
 *
 * IT COMMITS AS IT MOVES, like every other control in this editor. There is no OK: the draft is
 * already the preview, and «إعادة الضبط» is the way back.
 *
 * THE STAGE IS `direction: ltr` AND THAT IS DELIBERATE. Its numbers come from pointer coordinates,
 * which do not mirror; the same rule the background's focal control has carried since it was built.
 * The reader never sees it, because a picture has no reading direction.
 */
function FramingPanel({
  row,
  icon,
  paper,
  onChange,
  onReset,
  onDone,
}: {
  row: BackgroundRow;
  icon: ProfileIcon;
  paper: string;
  onChange: (next: Partial<ProfileIcon>) => void;
  onReset: () => void;
  /**
   * FINISH ADJUSTING — and nothing else.
   *
   * Adjusting a picture is a MODE: the stage takes the drag, the wheel and the arrow keys, and
   * while it is open the page is about one thing. A mode a reader can enter and cannot deliberately
   * leave is a trap, so it has an explicit way out.
   *
   * IT DOES NOT SAVE. The draft was already changing as the picture moved — every control in this
   * editor works that way — so the profile's own «حفظ» and its unsaved state stay exactly where
   * they were. This closes an interaction; it does not commit a profile.
   */
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const url = bgSrcUrl(row);
  const atDefault = isDefaultIconFrame(icon);

  /**
   * A POINTER MOVEMENT IN PIXELS, TURNED INTO A FRAMING IN PERCENT.
   *
   * `panRange` says how far the picture can actually travel inside the box at this scale, so a drag
   * moves the picture BY THE DISTANCE DRAGGED rather than by a fraction that depends on the picture.
   * Without it the same gesture crawls on a panorama and races on a square.
   *
   * The picture follows the hand: dragging right moves the picture right, which means showing more
   * of its left — so the focal percentage moves the other way.
   */
  const pan = (dx: number, dy: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const range = panRange(
      { w: box.width, h: box.height },
      { w: row.width, h: row.height },
      icon.scale,
    );
    const next: Partial<ProfileIcon> = {};
    if (range.x > 0) {
      next.focalX = Math.round(Math.min(100, Math.max(0, icon.focalX - (dx / range.x) * 100)));
    }
    if (range.y > 0) {
      next.focalY = Math.round(Math.min(100, Math.max(0, icon.focalY - (dy / range.y) * 100)));
    }
    if (next.focalX !== undefined || next.focalY !== undefined) onChange(next);
  };

  const zoom = (delta: number) =>
    onChange({
      scale: Math.round(
        Math.min(ICON_SCALE_MAX, Math.max(ICON_SCALE_MIN, icon.scale + delta)) * 100,
      ) / 100,
    });

  // A square picture in a square box at scale 1 cannot move, and the interface says so rather than
  // swallowing the gesture: the cursor stops offering a grab and the hint names the way out.
  const box = stage.current?.getBoundingClientRect();
  const range = box
    ? panRange({ w: box.width, h: box.height }, { w: row.width, h: row.height }, icon.scale)
    : { x: 1, y: 1 };
  const movable = range.x > 0.5 || range.y > 0.5;

  return (
    <div className="pf-frame">
      <div
        ref={stage}
        className={`pf-frame-stage${movable ? " movable" : ""}`}
        style={{ background: paper }}
        tabIndex={0}
        role="group"
        aria-label={t("profiles.identity.frameStage")}
        onPointerDown={(e) => {
          if (!movable) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          const dy = e.clientY - drag.current.y;
          drag.current = { x: e.clientX, y: e.clientY };
          pan(dx, dy);
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={(e) => {
          // Only where the gesture is unambiguous — over the stage, which is the thing being zoomed.
          e.preventDefault();
          zoom(e.deltaY < 0 ? 0.08 : -0.08);
        }}
        onKeyDown={(e) => {
          // EVERYTHING THE POINTER CAN DO, FROM THE KEYBOARD. A crop that only a mouse can set is a
          // crop some readers simply do not get. The nudge is in pixels, through the same `pan`, so
          // the two agree by construction.
          const NUDGE = 8;
          const map: Record<string, [number, number]> = {
            ArrowLeft: [NUDGE, 0], ArrowRight: [-NUDGE, 0],
            ArrowUp: [0, NUDGE], ArrowDown: [0, -NUDGE],
          };
          if (map[e.key]) { e.preventDefault(); pan(map[e.key][0], map[e.key][1]); return; }
          if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(0.1); return; }
          if (e.key === "-" || e.key === "_") { e.preventDefault(); zoom(-0.1); }
        }}
      >
        <span
          className="pf-frame-img"
          style={{ backgroundImage: `url("${url}")`, ...markFrame(icon) }}
        />
      </div>

      <div className="pf-ms-head">
        <span className="pf-ms-label">{t("profiles.identity.zoom")}</span>
        {/* `dir="ltr"` ON A NUMBER AND ITS SIGN. Written plainly it renders «×1.45» in Arabic — bidi
            reorders the multiplication sign to the head of the run. The isolate keeps the pair in the
            order it is read aloud, without turning the surrounding paragraph Latin. */}
        <span className="pf-ms-value" dir="ltr">
          {localeDigits(icon.scale.toFixed(2).replace(/0$/, ""), lang)}×
        </span>
        {!atDefault && (
          <button type="button" className="pf-ms-clear" onClick={onReset}>
            {t("profiles.identity.frameReset")}
          </button>
        )}
      </div>
      <input
        className="pf-ms-slider"
        type="range"
        min={ICON_SCALE_MIN}
        max={ICON_SCALE_MAX}
        step={0.01}
        value={icon.scale}
        aria-label={t("profiles.identity.zoom")}
        onChange={(e) => onChange({ scale: Number(e.target.value) })}
      />

      {/* WHERE IT ACTUALLY APPEARS. The mark is chosen at 220px and then lived with at 22. These are
          the real sizes, in the real proportions, drawn through the same `markFrame` — so a framing
          that only works large is visibly a framing that only works large. */}
      <div className="pf-frame-sizes">
        <span className="pf-frame-sizes-label">{t("profiles.identity.asItAppears")}</span>
        <span className="pf-frame-size s-card" style={{ background: paper }}>
          <span style={{ backgroundImage: `url("${url}")`, ...markFrame(icon) }} />
        </span>
        <span className="pf-frame-size s-chip" style={{ background: paper }}>
          <span style={{ backgroundImage: `url("${url}")`, ...markFrame(icon) }} />
        </span>
        <span className="pf-frame-size s-switch" style={{ background: paper }}>
          <span style={{ backgroundImage: `url("${url}")`, ...markFrame(icon) }} />
        </span>
      </div>

      <div className="pf-frame-foot">
        <span className="pf-frame-hint">
          {t(movable ? "profiles.identity.frameHint" : "profiles.identity.frameHintFits")}
        </span>
        <button type="button" className="pf-btn primary pf-frame-done" onClick={onDone}>
          {t("profiles.identity.frameDone")}
        </button>
      </div>
    </div>
  );
}

/**
 * The three colours a reader chooses, and the three that follow — the design's own two groups.
 *
 * WHY THE FOLLOWERS ARE SHOWN BUT NOT EDITABLE. `deriveColors` computes desk, margins and the quiet
 * letter from the paper, the letter and the touch; that derivation is measured across all sixteen
 * shipped themes and is the reason two colours can produce a whole Sard. Showing them read-only with
 * the relationship named is what makes the rule visible instead of surprising — and it is exactly
 * what the design does: the follower rows are copy targets, not fields.
 *
 * EDITING A CORE COLOUR RE-DERIVES THE REST, so "follows the paper" stays true the moment the paper
 * changes. The alternative — editing paper and leaving the desk behind — would make the label a lie.
 */
/** The diagonal that stands for "no colour", the same mark the reader's row uses. */
const NONE_STRIPE =
  "linear-gradient(to top left, transparent calc(50% - 1px), var(--muted) calc(50% - 1px),"
  + " var(--muted) calc(50% + 1px), transparent calc(50% + 1px))";

function InlineColours({
  draft,
  patch,
  scope,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
  /** Which of the profile's two palettes this chapter edits — the face the reader is looking at. */
  scope: "library" | "reading";
}) {
  const { t, lang } = useI18n();
  const c = draft.data.theme[scope].colors;
  // WHAT THE PALETTE STORES vs WHAT THE LIBRARY PAINTS. `c` is the stored palette and stays the
  // thing every edit reads and writes; `shownC` is what the reader will actually be given, which on
  // the library is the same palette with its panel depth applied. Only the "follows" swatches use
  // it — a swatch that showed the stored chrome while the library painted another would be the
  // preview lying about the result.
  const shownC = scope === "library" ? libraryColors(draft.data.theme.library) : c;
  // The raw text per row, so a half-typed code survives a re-render. Absent = show the committed value.
  const [typed, setTyped] = useState<Partial<Record<"paperBg" | "text" | "accent" | "numbers", string>>>({});
  const [bad, setBad] = useState<string | null>(null);
  // Which role has its picker open. One at a time: the chapter is a list of three colours,
  // and three planes at once would be a control panel rather than a page.
  const [open, setOpen] = useState<"paperBg" | "text" | "accent" | "numbers" | "overlay" | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Inside the panel, or on one of the chips that opens it — both are "still choosing".
      if (t.closest(".pf-ink-picker") || t.closest(".pf-ink-chip--open")) return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const CORE = [
    // «الوَرَق» is the page in a book and the ground in the library — one role, two surfaces, so the
    // note follows the chapter rather than describing the book in both.
    { key: "paperBg", name: "profiles.colour.paper",
      note: (scope === "library" ? "profiles.colour.paperNote.library" : "profiles.colour.paperNote") as TKey },
    // «الحرف» is a book's words on one surface and the interface's own on the other, so the note
    // follows the chapter here for the same reason «الوَرَق» does.
    { key: "text", name: "profiles.colour.text",
      note: (scope === "library" ? "profiles.colour.textNote.library" : "profiles.colour.textNote") as TKey },
    { key: "accent", name: "profiles.colour.accent", note: "profiles.colour.accentNote" },
  ] as const;
  const FOLLOW = [
    { key: "surfaceBg", name: "profiles.colour.desk", tag: "profiles.colour.followsPaper", note: "profiles.colour.deskNote" },
    { key: "chromeBg", name: "profiles.colour.chrome", tag: "profiles.colour.followsPaper", note: "profiles.colour.chromeNote" },
    { key: "muted", name: "profiles.colour.muted", tag: "profiles.colour.followsText", note: "profiles.colour.mutedNote" },
  ] as const;

  /**
   * WHAT EACH ROLE ACTUALLY DECIDES, straight out of `deriveColors`.
   *
   * `surfaceBg` and `chromeBg` step away from the PAPER; `chromeBorder` is ruled in the INK; `muted`
   * is the paper→ink line at 0.6, so it follows both; `selection` is the ACCENT washed. `highlight`
   * is shared and never generated, so it appears in no list and is never touched.
   *
   * This is the same table the chapter already states to the reader — «يتبع الوَرَق», «يتبع الحرف» —
   * written where the edit happens so the words and the behaviour cannot drift apart.
   */
  const FOLLOWS = {
    paperBg: ["paperBg", "surfaceBg", "chromeBg", "muted"],
    text: ["text", "muted", "chromeBorder"],
    accent: ["accent", "selection"],
  } as const satisfies Record<"paperBg" | "text" | "accent", readonly (keyof ThemeColors)[]>;

  /**
   * Change ONE role, and only what depends on it.
   *
   * This re-derived the WHOLE palette from the three roles the reader owns, whichever one had been
   * touched — and a palette that came from a shipped paper is AUTHORED, not derived, so the first
   * edit of any kind silently converted it. Measured on «عاجيّ», changing only the accent:
   *
   *     surfaceBg  #E7DCC4 -> #e7ddc7      chromeBg  #EAE0CA -> #efe8d6
   *     muted      #8A7E6E -> #7c756c      paper->chrome separation 0.107 -> 0.049
   *
   * — the panels lost more than half their edge against the ground for a change to a button colour.
   * On «سبييّ» it is not even a flattening: the authored chrome is LIGHTER than its paper and the
   * derived one is DARKER, so the sidebar flips from raised to recessed.
   *
   * The derivation itself is untouched, and so is every authored value the edited role does not
   * govern. Nothing stored is rewritten; this decides only what the NEXT edit writes.
   */
  const commit = (role: "paperBg" | "text" | "accent", hex: string) =>
    patch((d) => {
      const cur = d.theme[scope].colors;
      const three = { paperBg: cur.paperBg, text: cur.text, accent: cur.accent, [role]: hex };
      const derived = deriveColors(three.paperBg, three.text, three.accent, d.theme[scope].dark);
      const next = { ...cur };
      for (const k of FOLLOWS[role]) (next as Record<string, unknown>)[k] = derived[k];
      d.theme[scope].colors = next;
      // A colour of the reader's own is no longer one of the sixteen.
      d.theme[scope].base = null;
    });

  const onType = (role: "paperBg" | "text" | "accent", raw: string) => {
    const r = editHex(raw);
    setTyped((p) => ({ ...p, [role]: r.draft }));
    setBad(r.bad ? role : null);
    if (r.full) commit(role, r.full);
  };

  /**
   * THE FOURTH INK TYPES LIKE THE OTHER THREE.
   *
   * This row used to end in a «كلون النص» tag where the others end in a hex field — a control that
   * only said what the digits were doing and gave no way to say it back. The field now behaves like
   * its neighbours: it shows the colour in force (the authored one, or the text's when there is
   * none) and accepts a code. Emptying it is how "follow the text" is spelled, which is the same
   * thing `null` has always meant here.
   */
  const onTypeNumbers = (raw: string) => {
    const r = editHex(raw);
    setTyped((p) => ({ ...p, numbers: r.draft }));
    setBad(r.bad ? "numbers" : null);
    if (!raw.trim()) patch((d) => { d.theme[scope].numbers = null; });
    else if (r.full) patch((d) => { d.theme[scope].numbers = r.full; });
  };

  const edited = draft.data.theme[scope].base === null;

  /**
   * WHERE THE SLIDER SITS, HOW FAR IT GOES, and what it says.
   *
   * THE TRACK IS THE PALETTE'S OWN ROOM. A desk near black has little room below it; one near white
   * has little above. Ending the control where the room ends is what stops the slider carrying a
   * stretch that changes nothing — which is exactly what the first version did, and worse: it
   * FOLDED there, so the two ends of the track produced the same colour and four of the sixteen
   * papers were inert from end to end.
   *
   * With no relief of its own it opens at the palette's own, so the control tells the truth about
   * the theme in force before it is touched. Until it is touched nothing is stored and no profile
   * moves.
   */
  const room = reliefRoom(c.surfaceBg);
  const reliefAt = Math.min(
    room.max,
    Math.max(room.min, draft.data.theme.library.relief ?? reliefOf(c.surfaceBg, c.chromeBg)),
  );
  // Named against the surface it is actually measured from. Below a step's worth of lightness there
  // is nothing to see, and calling that "lighter by 0.1%" would dress up a panel nobody can pick out.
  const reliefRead =
    Math.abs(reliefAt) < RELIEF_STEP / 2
      ? t("profiles.relief.level")
      : t(reliefAt < 0 ? "profiles.relief.darker" : "profiles.relief.lighter", {
          p: localeNum(Math.round(Math.abs(reliefAt) * 1000) / 10, lang),
        });

  return (
    <div className="pf-ink">
      <div className="pf-ink-head">
        <span className="pf-ink-title">{t("profiles.colour.heading")}</span>
        <span className="pf-ink-rule" />
        {edited && (
          <button
            className="pf-ink-resetall"
            onClick={() =>
              patch((d) => {
                const base = THEMES[DEFAULT_LIGHT];
                d.theme[scope].colors = structuredClone(base.colors);
                d.theme[scope].base = DEFAULT_LIGHT;
                d.theme[scope].dark = base.dark;
                d.theme[scope].relief = null;
                setTyped({});
                setBad(null);
              })
            }
          >
            {t("profiles.colour.resetAll")}
          </button>
        )}
      </div>
      <div className="pf-ink-hint">{t("profiles.colour.hint")}</div>

      {CORE.map((row) => (
        <div className="pf-ink-row" key={row.key}>
          {/* THE CHIP IS THE DOOR. The chapter's own hint already says "press a colour to change
              it"; until now pressing it did nothing and the only way in was knowing the code. */}
          <button
            className={`pf-ink-chip pf-ink-chip--open${open === row.key ? " on" : ""}`}
            style={{ background: c[row.key] }}
            onClick={() => setOpen(open === row.key ? null : row.key)}
            aria-expanded={open === row.key}
            aria-label={t(row.name)}
          />
          <span className="pf-ink-id">
            <span className="pf-ink-name">{t(row.name)}</span>
            <span className="pf-ink-note">{t(row.note)}</span>
          </span>
          {/* `dir="ltr"` and an isolate: a hex code is a Latin token and must not reorder inside an
              Arabic sentence, in either interface language. */}
          <input
            className={`pf-ink-field${bad === row.key ? " bad" : ""}`}
            value={typed[row.key] ?? c[row.key]}
            onChange={(e) => onType(row.key, e.target.value)}
            spellCheck={false}
            dir="ltr"
            aria-label={t(row.name)}
          />
        </div>
      ))}
      {/* NUMBERS — a fourth ink, and the only one that may be absent.
          IN THE BOOK CHAPTER ONLY. It is the ink the DIGITS ON A PAGE take: `readingPatch` is the
          one thing that reads it, and it reads `theme.reading.numbers`. Nothing anywhere consumes
          `theme.library.numbers`, so drawing this row in the library chapter would offer a control
          that changes nothing — which is worse than not offering it.
          `null` means "the digits take the text's colour", which is what every profile written
          before this says. The picker is the same one the three above use. */}
      {scope === "reading" && (
      <div className="pf-ink-row">
        <button
          className={`pf-ink-chip pf-ink-chip--open${open === "numbers" ? " on" : ""}`}
          style={{ background: draft.data.theme[scope].numbers ?? c.text }}
          onClick={() => setOpen(open === "numbers" ? null : "numbers")}
          aria-expanded={open === "numbers"}
          aria-label={t("profiles.colour.numbers")}
        />
        <span className="pf-ink-id">
          <span className="pf-ink-name">{t("profiles.colour.numbers")}</span>
          <span className="pf-ink-note">{t("profiles.colour.numbersNote")}</span>
        </span>
        {/* The same field the three rows above end in — see `onTypeNumbers`. */}
        <input
          className={`pf-ink-field${bad === "numbers" ? " bad" : ""}`}
          value={typed.numbers ?? draft.data.theme[scope].numbers ?? c.text}
          onChange={(e) => onTypeNumbers(e.target.value)}
          spellCheck={false}
          dir="ltr"
          aria-label={t("profiles.colour.numbers")}
        />
      </div>
      )}

      {scope === "reading" && open === "numbers" && (
        <div className="pf-ink-picker">
          <ColorPicker
            value={draft.data.theme[scope].numbers ?? c.text}
            onChange={(hex) => patch((d) => { d.theme[scope].numbers = hex; })}
            onDone={() => setOpen(null)}
            presets={ACCENTS}
            contrastAgainst={c.paperBg}
          />
        </div>
      )}

      {/* THE COLOUR BEHIND THE PAGE — the reading surface's own layer, and the third thing in this
          chapter that is not the paper.
          THREE SURFACES, KEPT APART. «الوَرَق» is the page the words sit on. The picture is chosen in
          «الخلفيّة» and is not a colour at all. This is only the layer BETWEEN them, and it has its
          own value and reads none of the palette's, so choosing a paper cannot tint a photograph and
          removing the layer cannot change the paper.
          IT LIVES HERE rather than with the picture because it is a colour of the reading surface,
          which is what this chapter is. Under «الخلفيّة» it read as a property of the image. */}
      {scope === "reading" && (
        <div className="pf-ink-row">
          <button
            className={`pf-ink-chip pf-ink-chip--open${open === "overlay" ? " on" : ""}`}
            style={
              bgOverlayOf(draft.data.bg.reading.overlay).kind === "none"
                ? { background: "transparent", backgroundImage: NONE_STRIPE }
                : { background: overlayTint(bgOverlayOf(draft.data.bg.reading.overlay)).tint ?? c.surfaceBg }
            }
            onClick={() => setOpen(open === "overlay" ? null : "overlay")}
            aria-expanded={open === "overlay"}
            aria-label={t("color.behindPage")}
          />
          <span className="pf-ink-id">
            <span className="pf-ink-name">{t("color.behindPage")}</span>
            <span className="pf-ink-note">{t("color.behindPageNote")}</span>
          </span>
          <span className="pf-ink-state">
            {t(
              bgOverlayOf(draft.data.bg.reading.overlay).kind === "none"
                ? "color.none"
                : bgOverlayOf(draft.data.bg.reading.overlay).kind === "colour"
                  ? "color.custom"
                  : "color.default",
            )}
          </span>
        </div>
      )}

      {scope === "reading" && open === "overlay" && (
        /* INLINE, like every other picker in this editor. The reader's `InkCustom` floats, which is
           right in a settings drawer and wrong here: measured in the running editor, the floating
           panel was the only picker that could reach the preview, and all four inline ones covered
           none of it at any window size. */
        <div className="pf-ink-picker">
          <div className="pf-ink-modes">
            <button
              className={bgOverlayOf(draft.data.bg.reading.overlay).kind === "theme" ? "on" : ""}
              onClick={() => patch((d) => { d.bg.reading.overlay = null; })}
            >
              {t("color.default")}
            </button>
            <button
              className={bgOverlayOf(draft.data.bg.reading.overlay).kind === "none" ? "on" : ""}
              onClick={() => patch((d) => { d.bg.reading.overlay = BG_NO_OVERLAY; })}
            >
              {t("color.none")}
            </button>
          </div>
          <ColorPicker
            value={overlayTint(bgOverlayOf(draft.data.bg.reading.overlay)).tint ?? c.surfaceBg}
            onChange={(hex) => patch((d) => { d.bg.reading.overlay = hex; })}
            onDone={() => setOpen(null)}
            presets={draft.data.theme[scope].dark ? PAPERS_DARK : PAPERS_LIGHT}
            contrastAgainst={c.text}
          />
          <div className="pf-hint">{t("color.behindPageHint")}</div>
        </div>
      )}

      {open && open !== "numbers" && open !== "overlay" && (
        <div className="pf-ink-picker">
          <ColorPicker
            value={c[open as "paperBg" | "text" | "accent"]}
            onChange={(hex) => commit(open as "paperBg" | "text" | "accent", hex)}
            onDone={() => setOpen(null)}
            presets={open === "accent" ? ACCENTS : draft.data.theme[scope].dark ? PAPERS_DARK : PAPERS_LIGHT}
            contrastAgainst={open === "paperBg" ? c.text : c.paperBg}
          />
        </div>
      )}

      {bad && (
        <div className="pf-ink-bad">
          {t("profiles.colour.badHex")} <span dir="ltr">#3A7BFF</span>
        </div>
      )}

      <div className="pf-ink-follows">
        <span className="pf-ink-follows-label">{t("profiles.colour.follows")}</span>
        {FOLLOW.map((f) => (
          <span className="pf-ink-follow" key={f.key} title={`${t(f.name)} · ${t(f.note)}`}>
            <span className="pf-ink-chip sm" style={{ background: shownC[f.key] }} />
            <span className="pf-ink-follow-name">{t(f.name)}</span>
            <span className="pf-ink-follow-tag">{t(f.tag)}</span>
          </span>
        ))}
      </div>

      {/* PANEL RELIEF — the library's, and the library's only.
          The three inks say WHAT COLOUR the library is; this says how far its panels stand off the
          desk they sit on. Measured against the DESK, because that is the surface they actually
          touch: `.libd-stage` and `.pf-lib-main` paint no ground of their own, so the stage IS the
          desk and no paper-coloured surface meets a panel anywhere in the library.

          IT MOVES `chromeBg` AND NOTHING ELSE. Not the desk, not the paper, and nothing whatever to
          do with the library's background picture — no scrim, no veil, no opacity over it. The
          picture is the reader's own choice and has its own settings; a panel control has no
          business dimming it.

          NOT DRAWN ON THE BOOK CHAPTER. A book page has no panels; `profileTheme` applies this and
          `profileReadingTheme` does not, so offering it there would be a control that changes
          nothing — the same reason «الأرقام» is not drawn on this one. */}
      {scope === "library" && (
        <div className="pf-relief">
          <div className="gs-slider-head">
            <span>{t("profiles.relief.name")}</span>
            <span className="gs-slider-val">{reliefRead}</span>
          </div>
          <input
            className="gs-slider"
            type="range"
            min={room.min}
            max={room.max}
            step={RELIEF_STEP}
            value={reliefAt}
            onChange={(e) =>
              patch((d) => {
                d.theme.library.relief = Number(e.target.value);
                // A relief of the reader's own is no longer one of the sixteen — the same rule the
                // three inks follow, so "reset to it" keeps telling the truth.
                d.theme.library.base = null;
              })
            }
            aria-label={t("profiles.relief.name")}
          />
          <div className="pf-hint">{t("profiles.relief.hint")}</div>
        </div>
      )}
    </div>
  );
}

function ThemeSection({
  draft,
  patch,
  scope,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
  /** Which of the profile's two palettes this chapter edits — the face the reader is looking at. */
  scope: "library" | "reading";
}) {
  const { t, lang } = useI18n();
  const [custom, setCustom] = useState(false);
  const verdicts = judgePalette(draft.data.theme[scope].colors);
  return (
    <>
      <div className="pf-swatches">
        {THEME_ORDER.map((id) => {
          const on = draft.data.theme[scope].base === id;
          return (
            <button
              key={id}
              className={`pf-swatch-cell${on ? " on" : ""}`}
              onClick={() =>
                patch((d) => {
                  d.theme[scope].base = id;
                  d.theme[scope].dark = THEMES[id].dark;
                  d.theme[scope].colors = structuredClone(THEMES[id].colors);
                  // The shipped paper carries its designer's own panel depth inside `colors`, so a
                  // depth left over from the previous palette would sit on top of it and the reader
                  // would not get the paper they just pressed.
                  d.theme[scope].relief = null;
                  d.theme[scope].highlightAlpha = THEMES[id].highlightAlpha;
                })
              }
              title={t(`theme.${id}`)}
            >
              {/* THE PAPER'S OWN LETTER AND ITS ACCENT. A swatch has to answer two questions at
                  once — what does ink look like on this paper, and what colour marks things — so the
                  design sets a single Arabic letter in the book face beside a dot of the accent.
                  "Aa" answered neither: it named a Latin face this reader may never see and left the
                  accent, which is half of what separates one paper from the next, off the tile. */}
              <span
                className="pf-swatch"
                style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
              >
                <span className="pf-swatch-glyph">س</span>
                <span className="pf-swatch-dot" style={{ background: THEMES[id].colors.accent }} />
              </span>
              <span className="pf-swatch-name">{t(`theme.${id}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="pf-hint">
        {t("profiles.theme.papers", { n: localeDigits(String(THEME_ORDER.length), lang) })}
      </div>

      {/* The measured verdict, shown as a number rather than a badge — the reader can see what a
          choice actually buys. Repair is offered, never imposed. The RATIO is localised too: an
          Arabic interface shows Eastern-Arabic numerals throughout, and a half-converted "14.2:١"
          is worse than either alone. */}
      <div className={`pf-contrast${verdicts.textOnPaper.passes ? "" : " warn"}`}>
        {t(verdicts.textOnPaper.passes ? "profiles.contrast.ok" : "profiles.contrast.low", {
          ratio: localeDigits(verdicts.textOnPaper.ratio.toFixed(1), lang),
        })}
      </div>

      {/* THE COLOURS, IN THE CHAPTER — not behind a button.
          The design (frame 2a) puts three editable colour rows directly under the sixteen papers,
          each with an always-visible code field, and then names the three that follow from them. It
          was implemented as a link that opened a dialog, which is the SUPERSEDED accordion frame's
          shape: two clicks and a modal to reach the chapter's own primary controls. */}
      <InlineColours draft={draft} patch={patch} scope={scope} />

      {/* Step three of the design's own numbering: a paper of your own, from a paper and a touch,
          shown as four whole Sards. That IS a separate surface in the design, and stays one. */}
      <button className="pf-cp-open" onClick={() => setCustom(true)}>
        {t("profiles.theme.customise")}
        <Icon name={lang === "ar" ? "caretLeft" : "caretRight"} size="sm" />
      </button>

      {custom && (
        <CustomPaper
          // "Starts from X" only when there IS an X. A profile already carrying its own paper has
          // nothing to start from, and repeating the dialog's own title under it says nothing.
          startFrom={
            draft.data.theme[scope].base
              ? t("profiles.theme.startsFrom", { name: t(`theme.${draft.data.theme[scope].base}`) })
              : ""
          }
          initialPaper={draft.data.theme[scope].colors.paperBg}
          initialAccent={draft.data.theme[scope].colors.accent}
          arabicFace={draft.data.type.arabic}
          name={draft.name}
          onCancel={() => setCustom(false)}
          onApply={({ dark, colors }) => {
            patch((d) => {
              // A paper of the reader's own is no longer one of the sixteen: `base` becomes null,
              // which is what makes the card read "a paper of your own" rather than naming a preset
              // it no longer resembles.
              d.theme[scope].base = null;
              d.theme[scope].dark = dark;
              d.theme[scope].colors = colors;
            });
            setCustom(false);
          }}
        />
      )}
    </>
  );
}

/**
 * One surface's background, bound to the DRAFT.
 *
 * RE-HOSTED, NOT REBUILT. Every control here is the one Global Settings already uses — the same
 * picker, the same presence and blur sliders against the same measured maxima, the same focal pad,
 * the same page-translucency floor. What changes is only where the value lands: a draft's `data.bg`
 * instead of the live surface. Choosing an image therefore does NOT repaint the running application
 * and does not write a global binding; `applyProfile` is still the only thing that binds.
 */
function BackgroundSection({
  surface,
  onTouch,
  draft,
  patch,
  rows,
  onImported,
}: {
  surface: BgSurface;
  /** Bring this section's own face forward, so a change is made where it can be seen. */
  onTouch: () => void;
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
  rows: BackgroundRow[];
  onImported: (row: BackgroundRow) => void;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = surface === "reading";
  const slot = reading ? draft.data.bg.reading : draft.data.bg.library;
  /**
   * PRESENCE HAS NOTHING TO ACT ON WHEN THERE IS NO OVERLAY.
   *
   * Presence is the strength of the COLOUR LAYER over the picture — `scrimAlpha` becomes that
   * layer's opacity and nothing else. «بلا لون» removes the layer outright, which is what it is for,
   * and the slider was then left fully interactive with nothing underneath it: measured on the
   * owner's own profile, a real drag produced 669 `input` events, swept the whole 0..260 range, and
   * could not change one pixel, because `.pf-stage-scrim` was not in the document at all.
   *
   * Disabled rather than hidden: the setting still exists and its stored value is untouched, so
   * choosing a colour again brings it back exactly where it was. A control that vanishes teaches a
   * reader that their value was thrown away.
   *
   * THE LIBRARY HAS NO OVERLAY, so this can only ever apply to the reading surface.
   */
  const overlayOff = reading && bgOverlayOf(draft.data.bg.reading.overlay).kind === "none";
  /** Patch, and show the face this section governs — one wrapper so no control can forget. */
  const touchPatch = (f: (d: ProfileData) => void) => { onTouch(); patch(f); };
  // "The same image, quieter" renders the LIBRARY's image with the reading surface's own params.
  const shown = reading && draft.data.bg.reading.sameAsLibrary ? draft.data.bg.library.ref : slot.ref;
  const row = rows.find((r) => r.id === shown) ?? null;
  const linked = reading && draft.data.bg.reading.sameAsLibrary;

  const at = (d: ProfileData) => (reading ? d.bg.reading : d.bg.library);

  const pick = async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      // Import only. The reference reaches the collector when the draft is saved — see
      // `background_import` for why that direction is the safe one.
      const imported = await backgroundImport(picked);
      onImported(imported);
      patch((d) => {
        at(d).ref = imported.id;
        if (reading) d.bg.reading.sameAsLibrary = false;
      });
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("bg.err.") ? t(code as TKey) : code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {reading && (
        <label className="pf-samecheck">
          <input
            type="checkbox"
            checked={draft.data.bg.reading.sameAsLibrary}
            disabled={!draft.data.bg.library.ref}
            onChange={(e) => patch((d) => { d.bg.reading.sameAsLibrary = e.target.checked; })}
          />
          <span>{t("profiles.bg.sameAsLibrary")}</span>
        </label>
      )}

      {!row ? (
        <>
          <button className="pf-btn" disabled={busy || linked} onClick={() => void pick()}>
            {busy ? t("gs.bg.preparing") : t("gs.bg.choose")}
          </button>
          <div className="pf-hint">{t("gs.bg.formats")}</div>
        </>
      ) : (
        <>
          <div className="bg-ctl-row">
            <span
              className="bg-ctl-thumb"
              style={{
                backgroundImage: `url("${bgSrcUrl(row)}")`,
                transform: `scaleX(${slot.params.flip ? -1 : 1})`,
              }}
              aria-hidden
            />
            <span className="bg-ctl-name" dir="auto" title={imageLabel(row.source_name).full}>
              {imageLabel(row.source_name).label}
            </span>
            {!linked && (
              <>
                <button className="bg-ctl-act" disabled={busy} onClick={() => void pick()}>
                  {busy ? t("gs.bg.preparing") : t("gs.bg.replace")}
                </button>
                <button
                  className="bg-ctl-act danger"
                  onClick={() => patch((d) => { at(d).ref = null; })}
                >
                  {t("gs.bg.remove")}
                </button>
              </>
            )}
          </div>

          <div className="gs-slider-head">
            {/* NAMED FOR ITS OWN SURFACE. This chapter draws two groups, and both sliders read
                «الحضور» — the only thing telling them apart is a heading that scrolls out of
                view. Moving the wrong one changes a surface the reader is not looking at, which
                is indistinguishable from a control that does nothing. */}
            <span>{t(reading ? "gs.bg.presenceBook" : "gs.bg.presenceLibrary")}</span>
            <span className="gs-slider-val">{localeDigits(String(slot.params.presence), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={presenceMaxFor(surface)} step={1}
            value={slot.params.presence}
            disabled={overlayOff}
            onChange={(e) => touchPatch((d) => { at(d).params.presence = Number(e.target.value); })}
          />
          {overlayOff && <div className="pf-hint">{t("gs.bg.presenceNoOverlay")}</div>}

          <div className="gs-slider-head">
            <span>{t("gs.bg.blur")}</span>
            <span className="gs-slider-val">{localeDigits(String(slot.params.blur), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={BG_BLUR_MAX} step={1}
            value={slot.params.blur}
            onChange={(e) => touchPatch((d) => { at(d).params.blur = Number(e.target.value); })}
          />

          {/* `cover` always crops; this chooses what survives the crop. */}
          <div className="pf-field-label">{t("gs.bg.focal")}</div>
          <div
            className="bg-ctl-focal"
            style={{
              backgroundImage: `url("${bgSrcUrl(row)}")`,
              backgroundPosition: `${slot.params.focalX}% ${slot.params.focalY}%`,
            }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              patch((d) => {
                at(d).params.focalX = Math.round(((e.clientX - r.left) / r.width) * 100);
                at(d).params.focalY = Math.round(((e.clientY - r.top) / r.height) * 100);
              });
            }}
          >
            <span
              className="bg-ctl-focal-dot"
              style={{ left: `${slot.params.focalX}%`, top: `${slot.params.focalY}%` }}
            />
          </div>

          {/* READING ONLY. The page is deliberately outside the interface texture's reach — the
              design says so — so its translucency lives here, against its own measured AAA floor. */}
          {reading && (
            <>
              <div className="gs-slider-head">
                <span>{t("gs.bg.pageOpacity")}</span>
                <span className="gs-slider-val">
                  {localeDigits(String(Math.round(slot.params.pageOpacity * 100)), lang)}
                </span>
              </div>
              <input
                className="gs-slider" type="range" min={PAGE_OPACITY_MIN} max={1} step={0.01}
                value={slot.params.pageOpacity}
                onChange={(e) => touchPatch((d) => { d.bg.reading.params.pageOpacity = Number(e.target.value); })}
              />
              <div className="pf-hint">{t("gs.bg.pageOpacityHint")}</div>

            </>
          )}
        </>
      )}
      {error && <div className="pf-contrast warn">{error}</div>}
    </>
  );
}

function FontsSection({
  draft,
  patch,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
}) {
  const { t } = useI18n();
  const custom = useFonts((s) => s.custom);

  return (
    <>
      <label className="pf-field">
        <span className="pf-field-label">{t("profiles.fonts.interface")}</span>
        <select
          className="pf-select"
          value={draft.data.type.ui ?? ""}
          onChange={(e) => patch((d) => { d.type.ui = e.target.value || null; })}
        >
          {FONT_CATALOGUE.map((f) => (
            <option key={f.id} value={f.css}>
              {f.label}
            </option>
          ))}
          {custom.map((c) => (
            <option key={c.id} value={c.family_name}>
              {c.family_name}
            </option>
          ))}
        </select>
      </label>

      <label className="pf-field">
        <span className="pf-field-label">{t("profiles.fonts.arabic")}</span>
        <select
          className="pf-select"
          value={draft.data.type.arabic}
          onChange={(e) => patch((d) => { d.type.arabic = e.target.value; })}
        >
          {Object.entries(ARABIC_FONTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
          {custom.map((c) => (
            <option key={c.id} value={c.family_name}>
              {c.family_name}
            </option>
          ))}
        </select>
      </label>
      <div className="pf-specimen" style={{ fontFamily: bookFaceCss(draft.data.type.arabic) }} dir="rtl">
        بِسْمِ اللهِ
      </div>

      <label className="pf-field">
        <span className="pf-field-label">{t("profiles.fonts.latin")}</span>
        <select
          className="pf-select"
          value={draft.data.type.latin}
          onChange={(e) => patch((d) => { d.type.latin = e.target.value; })}
        >
          {Object.entries(LATIN_FONTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
          {custom.map((c) => (
            <option key={c.id} value={c.family_name}>
              {c.family_name}
            </option>
          ))}
        </select>
      </label>
      <div className="pf-specimen" style={{ fontFamily: bookFaceCss(draft.data.type.latin) }} dir="ltr">
        The quick brown fox
      </div>
    </>
  );
}

function MarksSection({
  draft,
  patch,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
}) {
  const { t, lang } = useI18n();
  const colour = draft.data.theme.reading.bookmark ?? draft.data.theme.reading.colors.accent;
  // SIZE AND EDGE POSITION SIT BEHIND A DISCLOSURE (plan §X.0 Q12). They are the two marks settings a
  // reader sets once and then forgets, and putting them under the shapes would bury the choice that
  // is actually made often. The link is the editor's existing "go deeper" affordance — the same one
  // the colours use — rather than a new kind of control.

  return (
    <>
      <div className="pf-field-label">{t("profiles.marks.bookmark")}</div>
      <div className="pf-bm-grid">
        {BOOKMARK_SHAPES.map((s) => (
          <button
            key={s.key}
            className={`pf-bm-cell${draft.data.marks.bookmarkShape === s.key ? " on" : ""}`}
            onClick={() => patch((d) => { d.marks.bookmarkShape = s.key; })}
            // `BOOKMARK_SHAPES[].label` is a hard-coded English string on a shared constant. Rather
            // than change that constant — and with it the existing Bookmark settings section — the
            // twelve names are localised here, in the feature that needs them.
            title={t(`profiles.shape.${s.key}`)}
            aria-label={t(`profiles.shape.${s.key}`)}
          >
            <BookmarkShape shape={s.key} color={colour} h={26} />
          </button>
        ))}
      </div>

      <div className="pf-bm-colors">
        {BOOKMARK_COLORS.map((c) => (
          <button
            key={c.key}
            className={`pf-bm-color${colour.toLowerCase() === c.hex.toLowerCase() ? " on" : ""}`}
            style={{ background: c.hex }}
            onClick={() => patch((d) => { d.theme.reading.bookmark = c.hex; })}
            title={c.name}
            aria-label={c.name}
          />
        ))}
      </div>

      {/* The two settings the design's editor does not draw but Sard has always had. Kept rather
          than silently lost, and bound to the DRAFT, so the specimen answers while the slider moves
          and nothing is written until Save. */}
      {/* NO LONGER BEHIND A PRESS. These are two ordinary sliders for the marker's size and where it
          sits on the page edge; there is nothing advanced about them and nothing gained by making a
          reader find them. Measured before this: opening the chapter showed ZERO sliders. */}
      <div className="pf-field-label">{t("profiles.marks.advanced")}</div>

      <>
          <div className="gs-slider-head">
            <span>{t("gs.bookmark.size")}</span>
            <span className="gs-slider-val">
              {localeDigits(String(draft.data.marks.bookmarkSize), lang)}
            </span>
          </div>
          <input
            className="gs-slider"
            type="range"
            min={BOOKMARK_SIZE_MIN}
            max={BOOKMARK_SIZE_MAX}
            step={2}
            value={draft.data.marks.bookmarkSize}
            onChange={(e) => patch((d) => { d.marks.bookmarkSize = Number(e.target.value); })}
          />

          <div className="gs-slider-head">
            <span>{t("gs.bookmark.position")}</span>
            <span className="gs-slider-val">
              {localeDigits(String(Math.round(draft.data.marks.bookmarkPos * 100)), lang)}
            </span>
          </div>
          <input
            className="gs-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={draft.data.marks.bookmarkPos}
            onChange={(e) => patch((d) => { d.marks.bookmarkPos = Number(e.target.value); })}
          />
          <div className="pf-hint">{t("gs.bookmark.posHint")}</div>
      </>

      <div className="pf-field-label">{t("profiles.marks.readMarker")}</div>
      <div className="pf-rm-list">
        {READ_MARKERS.map((m) => (
          <button
            key={m.key}
            className={`pf-rm-cell${draft.data.marks.readMarker === m.key ? " on" : ""}`}
            onClick={() => patch((d) => { d.marks.readMarker = m.key; })}
          >
            <span className={`gs-rm-prev rm-${m.key}`} aria-hidden="true">
              <span className="toc-row read" />
              <span className="toc-row read" />
              <span className="toc-row active" />
            </span>
            <span className="pf-rm-name">{t(m.label)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * INTERFACE TEXTURE — three named steps, never a percentage.
 *
 * The design is explicit about that, and an enum cannot drift below the measured floor the way a
 * stored number could. The page is deliberately unreachable from here: its translucency lives in the
 * background chapter, against its own AAA floor.
 *
 * LIFTED OUT OF MARKS, NOT REWRITTEN. It used to close the Marks section; the six chapters give it
 * its own, so it moved as it was.
 */
function TextureSection({
  draft,
  patch,
  libBg,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
  /**
   * The reader's own library background, so the plate is judged over the thing it will actually sit
   * on. Absent when no picture is set — the plate then shows the panel over the theme's own desk
   * colour, which is equally truthful and is what that reader will really see.
   */
  libBg: { url: string; params: { focalX: number; focalY: number; blur: number; flip: boolean }; scrim: number } | null;
}) {
  const { t } = useI18n();

  // WHAT EACH STEP ACTUALLY RENDERS AT, on this theme and this desk, right now.
  //
  // The swatches used to be painted at a hardcoded 85% and 70%. Those numbers were never what the
  // application paints: the real alpha is the step's wish CLAMPED against the live scrim, which is
  // why `.pf-lib-side` carries the application's formula character for character rather than its
  // own. Three swatches that promise a translucency the reader will not be given are a decoration,
  // not a preview — so they read from the same function the real surfaces do.
  const floor = minChromeAlpha(worstDeskScrim(), libraryColors(draft.data.theme.library));
  const alphaOf = (step: TextureStep) => surfaceAlpha(step, LOWEST_SURFACE, floor);

  // WHEN TWO STEPS BECOME ONE. Over a bright desk the floor rises until `light` and `glass` have
  // nowhere left to differ and land on the same alpha — measured in the release at 80% and 80%,
  // pixel-identical. That is the clamp doing its job, not the control failing, but nothing on
  // screen said so and the reader was left comparing two choices that were the same choice.
  const converged = Math.abs(alphaOf("light") - alphaOf("glass")) < 0.005;

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <>
      <div className="pf-field-label">{t("profiles.marks.texture")}</div>
      <div className="pf-texture" role="radiogroup">
        {TEXTURE_STEPS.map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={draft.data.texture === s}
            className={`pf-texture-step${draft.data.texture === s ? " on" : ""}`}
            onClick={() => patch((d) => { d.texture = s; })}
          >
            <span
              className="pf-texture-swatch"
              data-step={s}
              // Each swatch carries ITS OWN step's alpha, because three steps are on screen at
              // once and the root's `--ui-*` describe only the selected one. Alpha ALONE: the
              // frost that stood here too dissolved the stripe the swatch is read by and inverted
              // the row (see `.pf-texture-swatch::after` for the measurements). Frost belongs on
              // the plate, where it has a photograph to blur and the room to show it.
              style={{ "--sw-a": pct(alphaOf(s)) } as React.CSSProperties}
              aria-hidden
            />
            {t(`profiles.texture.${s}`)}
            <span className="pf-texture-pct">{pct(alphaOf(s))}</span>
          </button>
        ))}
      </div>

      {/* THE PLATE — the selected step, at reading size, over the desk the reader actually has.
          A swatch 26px tall can show that a panel is translucent; it cannot show what READING
          THROUGH one feels like, which is the whole question this setting asks. The plate carries
          the application's formula verbatim (the same one `.pf-lib-side` uses) and puts real chrome
          on it: a title, a line of body text, a rule and a muted caption — because legibility over
          a background is the thing being judged, and it cannot be judged without words. */}
      <div className="pf-texture-plate" aria-hidden>
        {/* THE SAME TWO LAYERS THE OTHER PREVIEWS USE — picture, then the surface's own scrim — so
            the ground under this panel is the ground under the real one. The bleed and the blur come
            from the shared `.pf-lib-bg` rule; only the picture and its framing are per-profile. */}
        {libBg && (
          <>
            <span
              className="pf-lib-bg"
              style={{
                backgroundImage: `url("${libBg.url}")`,
                backgroundPosition: `${libBg.params.focalX}% ${libBg.params.focalY}%`,
                filter: `blur(${libBg.params.blur}px)`,
                transform: `scaleX(${libBg.params.flip ? -1 : 1})`,
              }}
            />
            <span className="pf-lib-scrim" style={{ opacity: libBg.scrim }} />
          </>
        )}
        <div className="pf-texture-plate-panel">
          <div className="pf-texture-plate-title">{t("profiles.texture.plateTitle")}</div>
          <div className="pf-texture-plate-body">{t("profiles.texture.plateBody")}</div>
          <div className="pf-texture-plate-rule" />
          <div className="pf-texture-plate-foot">{t("profiles.texture.plateFoot")}</div>
        </div>
      </div>

      <div className="pf-hint">{t("profiles.marks.textureHint")}</div>
      {converged && (
        // Said only when it is true. A permanent note about a clamp that is currently inert would
        // be documentation; this appears exactly when two of the three choices have become one.
        <div className="pf-texture-note">{t("profiles.texture.converged")}</div>
      )}
    </>
  );
}
