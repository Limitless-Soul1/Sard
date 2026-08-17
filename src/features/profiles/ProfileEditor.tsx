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

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import {
  BG_BLUR_MAX,
  PAGE_OPACITY_MIN,
  bgSrcUrl,
  presenceMaxFor,
  scrimAlpha,
  type BgSurface,
} from "../../lib/background";
import { localeDigits } from "../../lib/format";
import { backgroundImport, backgroundsList, type BackgroundRow } from "../../lib/ipc";
import {
  BOOKMARK_COLORS,
  BOOKMARK_SHAPES,
  BOOKMARK_SIZE_MAX,
  BOOKMARK_SIZE_MIN,
} from "../../lib/bookmarkStyle";
import { READ_MARKERS } from "../../lib/readMarkerStyle";
import { FONT_CATALOGUE, useFonts } from "../../lib/fonts";
import { ARABIC_FONTS, LATIN_FONTS } from "../../reader-engine/injectedCss";
import { DEFAULT_LIGHT, THEMES, THEME_ORDER } from "../../theme/themes";
import { BookmarkShape } from "../reader/BookmarkShape";
import { CustomPaper } from "./CustomPaper";
import { EditorShell } from "./editor/EditorShell";
import { FOCUS, type ChapterId, type Focus } from "./editor/chapters";
import { ShareSheet } from "./ShareSheet";
import { profileChangePending } from "./session";
import { SardMini } from "./SardMini";
import { bookFaceCss, miniOf } from "./mini";
import { saveProfile, useProfiles } from "./store";
import { TEXTURE_STEPS, type Profile, type ProfileData } from "./model/profile";
import { judgePalette } from "./model/guidance";
import { editHex } from "./model/hex";
import { deriveColors } from "./model/palette";

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
      return { name: p.name, iconKind: p.iconKind, iconRef: p.iconRef };
    case "paper": {
      const { bookmark: _bookmark, ...paper } = d.theme;
      return paper;
    }
    case "background":
      return d.bg;
    case "fonts":
      return d.type;
    case "marks":
      return { ...d.marks, bookmark: d.theme.bookmark };
    case "texture":
      return d.texture;
  }
}

export function ProfileEditor({
  profile,
  fresh = false,
  onClose,
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
  fresh?: boolean;
  onClose: () => void;
}) {
  const { t, dir } = useI18n();
  const live = useProfiles((s) => s.profiles.find((p) => p.id === profile.id)) ?? profile;

  const [draft, setDraft] = useState<Profile>(() => structuredClone(live));
  const [chapter, setChapter] = useState<ChapterId>(fresh ? "identity" : "paper");
  const [face, setFace] = useState<"library" | "book">("library");
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
  // Both background surfaces append to the same list, so the append is written once.
  const addBgRow = (r: BackgroundRow) =>
    setBgRows((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r]));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(live), [draft, live]);

  const patch = (f: (d: ProfileData) => void) =>
    setDraft((cur) => {
      const next = structuredClone(cur);
      f(next.data);
      return next;
    });

  const save = async () => {
    await saveProfile(draft);
    onClose();
  };

  const themeName = draft.data.theme.base
    ? t(`theme.${draft.data.theme.base}`)
    : t("profiles.theme.custom");

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

  /** Each chapter's current answer, under its name in the rail. */
  const chapterValue = (id: ChapterId): string => {
    switch (id) {
      case "identity":
        return draft.name?.trim() || "—";
      case "paper":
        return themeName;
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
          <IdentitySection draft={draft} setDraft={setDraft} rows={bgRows} onImported={addBgRow} />
        );
      case "paper":
        return <ThemeSection draft={draft} patch={patch} />;
      case "background":
        return (
          <>
            <div className="pf-field-label">{t("profiles.section.libraryBg")}</div>
            <BackgroundSection
              surface="library"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={addBgRow}
            />
            <div className="pfe-ch-rule" role="separator" />
            <div className="pf-field-label">{t("profiles.section.bookBg")}</div>
            <BackgroundSection
              surface="reading"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={addBgRow}
            />
          </>
        );
      case "fonts":
        return <FontsSection draft={draft} patch={patch} />;
      case "marks":
        return <MarksSection draft={draft} patch={patch} />;
      case "texture":
        return <TextureSection draft={draft} patch={patch} />;
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
    <div className="pf-editor" role="dialog" aria-modal="true">
      <div className="pf-editor-head">
        <span className="pf-editor-title" dir="auto">
          {draft.name ?? t("profiles.editor.title")}
        </span>
        {dirty && <span className="pf-editor-dirty">{t("profiles.editor.unsaved")}</span>}
        <span className="pf-editor-spacer" />
        {/* The design's own head carries sharing beside Save. Disabled while the draft is dirty:
            a package is made from the SAVED profile, and exporting one that does not match what is
            on screen would send something the reader never saw. */}
        <button className="pf-btn" disabled={dirty} title={dirty ? t("profiles.editor.unsaved") : undefined}
          onClick={() => { if (!profileChangePending()) setShare(true); }}>
          {t("profiles.card.share")}
        </button>
        <button className="pf-btn primary" disabled={!dirty} onClick={() => void save()}>
          {t("profiles.editor.save")}
        </button>
        <button className="pf-editor-x" onClick={onClose} aria-label={t("profiles.editor.close")}>
          ✕
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
          // The frame is Arabic and stays RTL; these controls are translated, so they follow the app.
          bodyDir={dir}
          preview={(focus: Focus) => (
            /* THE PREVIEW — what you see here is what you will see in Sard. */
            <div className="pf-stage">
              <div className="pf-stage-seg" role="group">
                <button className={face === "library" ? "on" : ""} onClick={() => setFace("library")}>
                  {t("profiles.editor.stageLibrary")}
                </button>
                <button className={face === "book" ? "on" : ""} onClick={() => setFace("book")}>
                  {t("profiles.editor.stageBook")}
                </button>
              </div>
              {/* The frame is sized against THIS area, not against a constant: it is what the
                  column has left once the segmented control and the focus label have taken theirs,
                  which is what lets the specimen grow with the window. */}
              <div className="pf-stage-area">
                <div className="pf-stage-frame">
                  {face === "library" ? (
                    <SardMini p={miniOf(draft, libUrl)} />
                  ) : (
                    <BookStage profile={draft} bgUrl={bookUrl} />
                  )}
                </div>
              </div>
              {/* WHAT THIS CHAPTER GOVERNS, named. The design frames the exact region with a
                  hairline; `FOCUS` here carries the face and the name but deliberately not the
                  design's pixel insets, which were measured against the mock's own geometry and
                  would be a lie against SardMini. So the region is named rather than drawn. */}
              {focus.label && <div className="pfe-focus-label">{focus.label}</div>}
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

// ---- the book face of the stage ----------------------------------------------------------------

/**
 * The reading surface as this profile would draw it: a real passage in the profile's own faces, a
 * highlight under the paper's own blend, and the bookmark at its physical page edge.
 *
 * Both scripts, always — a profile authored by a Latin reader still ships an Arabic face, and the
 * only way to see that is to show it.
 */
function BookStage({ profile, bgUrl }: { profile: Profile; bgUrl?: string | null }) {
  const c = profile.data.theme.colors;
  const dark = profile.data.theme.dark;
  const rd = profile.data.bg.reading.params;
  // THE PAGE OVER THE IMAGE — the relationship the background chapter exists to let a reader
  // balance, and which this stage could not show at all: it drew a solid desk colour and no image,
  // so page translucency had nothing to be translucent against.
  //
  // Both expressions are production's: `scrimAlpha(..., "reading")` is the reading surface's own
  // presence→scrim function, and the page is composited exactly as `global.css` composites it —
  // `color-mix(paper <opacity>, transparent)` on the BACKGROUND only, so the text stays fully
  // opaque while the paper thins.
  const page = bgUrl
    ? `color-mix(in srgb, ${c.paperBg} ${(rd.pageOpacity * 100).toFixed(1)}%, transparent)`
    : c.paperBg;
  return (
    <div className="pf-book" style={{ background: c.surfaceBg }}>
      {bgUrl && (
        <>
          <span
            className="pf-book-bg"
            style={{
              backgroundImage: `url("${bgUrl}")`,
              backgroundPosition: `${rd.focalX}% ${rd.focalY}%`,
              filter: `blur(${rd.blur}px)`,
              transform: `scaleX(${rd.flip ? -1 : 1})`,
            }}
            aria-hidden
          />
          <span
            className="pf-book-scrim"
            style={{ background: c.surfaceBg, opacity: scrimAlpha(rd.presence, "reading") }}
            aria-hidden
          />
        </>
      )}
      <div className="pf-book-sheet" style={{ background: page, color: c.text }}>
        <div
          className="pf-book-title"
          style={{ fontFamily: bookFaceCss(profile.data.type.arabic) }}
          dir="rtl"
        >
          الفصل الثالث · في المجالس
        </div>
        <p
          className="pf-book-p"
          style={{ fontFamily: bookFaceCss(profile.data.type.arabic) }}
          dir="rtl"
        >
          وكان في المدينة رجلٌ يجمع الحكايات كما يجمع الناسُ المال، فإذا أقبل الليل{" "}
          <span
            style={{
              background: c.highlight.amber,
              mixBlendMode: dark ? "screen" : "multiply",
              opacity: dark ? 0.66 : 0.72,
              padding: "0.05em 0.2em 0.09em",
              borderRadius: "0.12em",
            }}
          >
            نشرها على مجلسه
          </span>{" "}
          فجلس السامعون كأنّهم في سَفَرٍ لا يبلغ آخره.
        </p>
        <p
          className="pf-book-p latin"
          style={{ fontFamily: bookFaceCss(profile.data.type.latin), color: c.muted }}
          dir="ltr"
        >
          The night narrows to a single lamp, and the story keeps its own hours.
        </p>
        {/* AT ITS REAL EDGE POSITION. `bookmarkPos` is a fraction of the page's width and is
            PHYSICAL — it does not flip with the interface language, exactly as the reader's own
            marker does not (see `PageBookmark`). It used to sit at a fixed inline-end inset, which
            both ignored the setting and mirrored itself in English. */}
        <span
          className="pf-book-mark"
          style={{ left: `${profile.data.marks.bookmarkPos * 100}%` }}
        >
          <BookmarkShape
            shape={profile.data.marks.bookmarkShape}
            color={profile.data.theme.bookmark ?? c.accent}
            h={profile.data.marks.bookmarkSize * 0.5}
          />
        </span>
      </div>
    </div>
  );
}

// ---- sections ------------------------------------------------------------------------------------

function IdentitySection({
  draft,
  setDraft,
  rows,
  onImported,
}: {
  draft: Profile;
  setDraft: React.Dispatch<React.SetStateAction<Profile>>;
  rows: BackgroundRow[];
  onImported: (row: BackgroundRow) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seal = (draft.name ?? "").trim().slice(0, 1) || "س";
  const colour = draft.iconKind === "color";
  const image = draft.iconKind === "image";
  const sealKind = !colour && !image;
  // `iconRef` is overloaded — a hex for a colour icon, a content hash for an image — so the row is
  // only looked up when the kind says there is one to find.
  const iconRow = image && draft.iconRef ? rows.find((r) => r.id === draft.iconRef) ?? null : null;

  /**
   * THE MANAGED PIPELINE, NOT A SECOND ONE. An icon is an image like any other: `background_import`
   * copies it into the managed directory, dedupes it by content and records the row, which is what
   * makes it collectable — and, once the draft is saved and `icon_ref` reaches the column, what makes
   * it survive collection. `backgrounds::gc()` counts that column as its fourth reference source.
   *
   * IMPORT ONLY, exactly as the background sections do. The reference reaches the collector when the
   * draft is SAVED; until then the row is unreferenced, which is the same window a chosen background
   * already lives in.
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
      setDraft((d) => ({ ...d, iconKind: "image", iconRef: imported.id }));
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("bg.err.") ? t(code as TKey) : code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="pf-field">
        <span className="pf-field-label">{t("profiles.identity.name")}</span>
        <input
          className="pf-input"
          value={draft.name ?? ""}
          dir="auto"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </label>

      {/* THE ICON — three kinds now that the managed-image pipeline is reachable from here. The seal
          is not a placeholder for the image: the design calls the initial "a type specimen, not clip
          art", so it stays a real choice a reader may prefer to keep. The preview is drawn exactly as
          the card draws it, because it IS the card's seal.
          EACH KIND TESTS FOR ITSELF. While there were two, the seal could be inferred as "not the
          colour"; with three that inference quietly claimed the image's selection too. */}
      <div className="pf-field">
        <span className="pf-field-label">{t("profiles.identity.icon")}</span>
        <div className="pf-icon-kinds" role="radiogroup">
          <button
            role="radio"
            aria-checked={sealKind}
            className={`pf-icon-kind${sealKind ? " on" : ""}`}
            onClick={() => setDraft((d) => ({ ...d, iconKind: "seal", iconRef: null }))}
          >
            <span
              className="pf-seal"
              style={{
                background: draft.data.theme.colors.paperBg,
                color: draft.data.theme.colors.text,
                fontFamily: bookFaceCss(draft.data.type.arabic),
              }}
            >
              {seal}
            </span>
            {t("profiles.identity.iconSeal")}
          </button>
          <button
            role="radio"
            aria-checked={colour}
            className={`pf-icon-kind${colour ? " on" : ""}`}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                iconKind: "color",
                // Switching AWAY from an image must not carry its hash into the colour slot — the
                // column means something different for each kind.
                iconRef: d.iconKind === "color" && d.iconRef ? d.iconRef : d.data.theme.colors.accent,
              }))
            }
          >
            <span className="pf-seal" style={{ background: draft.data.theme.colors.paperBg }}>
              <span
                className="pf-seal-dot"
                style={{
                  background: colour && draft.iconRef ? draft.iconRef : draft.data.theme.colors.accent,
                }}
              />
            </span>
            {t("profiles.identity.iconColour")}
          </button>

          {/* THE THIRD KIND. The seal is not a placeholder for it — the design calls the initial
              "a type specimen, not clip art" — so choosing an image is a choice, not an upgrade. */}
          <button
            role="radio"
            aria-checked={image}
            className={`pf-icon-kind${image ? " on" : ""}`}
            onClick={() => {
              if (image) return;
              if (draft.iconRef && rows.some((r) => r.id === draft.iconRef)) {
                setDraft((d) => ({ ...d, iconKind: "image" }));
              } else {
                void pickIcon();
              }
            }}
          >
            <span
              className="pf-seal"
              style={
                iconRow
                  ? {
                      backgroundImage: `url("${bgSrcUrl(iconRow)}")`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }
                  : { background: draft.data.theme.colors.paperBg, color: draft.data.theme.colors.muted }
              }
            >
              {!iconRow && "▣"}
            </span>
            {t("profiles.identity.iconImage")}
          </button>
        </div>

        {image && (
          <div className="pf-icon-image-row">
            <button className="pf-btn" disabled={busy} onClick={() => void pickIcon()}>
              {busy ? t("gs.bg.preparing") : iconRow ? t("gs.bg.replace") : t("gs.bg.choose")}
            </button>
            {iconRow && (
              <button
                className="pf-btn"
                onClick={() => setDraft((d) => ({ ...d, iconKind: "seal", iconRef: null }))}
              >
                {t("gs.bg.remove")}
              </button>
            )}
          </div>
        )}
        {image && !iconRow && <div className="pf-hint">{t("gs.bg.formats")}</div>}
        {error && <div className="pf-contrast warn">{error}</div>}

        {colour && (
          <div className="pf-bm-colors">
            {BOOKMARK_COLORS.map((c) => (
              <button
                key={c.key}
                className={`pf-bm-color${
                  (draft.iconRef ?? "").toLowerCase() === c.hex.toLowerCase() ? " on" : ""
                }`}
                style={{ background: c.hex }}
                onClick={() => setDraft((d) => ({ ...d, iconRef: c.hex }))}
                title={c.name}
                aria-label={c.name}
              />
            ))}
          </div>
        )}
      </div>

      {sealKind && <div className="pf-hint">{t("profiles.identity.sealHint")}</div>}
    </>
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
function InlineColours({
  draft,
  patch,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
}) {
  const { t } = useI18n();
  const c = draft.data.theme.colors;
  // The raw text per row, so a half-typed code survives a re-render. Absent = show the committed value.
  const [typed, setTyped] = useState<Partial<Record<"paperBg" | "text" | "accent", string>>>({});
  const [bad, setBad] = useState<string | null>(null);

  const CORE = [
    { key: "paperBg", name: "profiles.colour.paper", note: "profiles.colour.paperNote" },
    { key: "text", name: "profiles.colour.text", note: "profiles.colour.textNote" },
    { key: "accent", name: "profiles.colour.accent", note: "profiles.colour.accentNote" },
  ] as const;
  const FOLLOW = [
    { key: "surfaceBg", name: "profiles.colour.desk", tag: "profiles.colour.followsPaper", note: "profiles.colour.deskNote" },
    { key: "chromeBg", name: "profiles.colour.chrome", tag: "profiles.colour.followsPaper", note: "profiles.colour.chromeNote" },
    { key: "muted", name: "profiles.colour.muted", tag: "profiles.colour.followsText", note: "profiles.colour.mutedNote" },
  ] as const;

  /** Re-derive the whole palette from the three the reader owns, keeping the authored dark flag. */
  const commit = (role: "paperBg" | "text" | "accent", hex: string) =>
    patch((d) => {
      const next = { paperBg: c.paperBg, text: c.text, accent: c.accent, [role]: hex };
      d.theme.colors = deriveColors(next.paperBg, next.text, next.accent, d.theme.dark);
      // A colour of the reader's own is no longer one of the sixteen.
      d.theme.base = null;
    });

  const onType = (role: "paperBg" | "text" | "accent", raw: string) => {
    const r = editHex(raw);
    setTyped((p) => ({ ...p, [role]: r.draft }));
    setBad(r.bad ? role : null);
    if (r.full) commit(role, r.full);
  };

  const edited = draft.data.theme.base === null;

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
                d.theme.colors = structuredClone(base.colors);
                d.theme.base = DEFAULT_LIGHT;
                d.theme.dark = base.dark;
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
          <span className="pf-ink-chip" style={{ background: c[row.key] }} />
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

      {bad && (
        <div className="pf-ink-bad">
          {t("profiles.colour.badHex")} <span dir="ltr">#3A7BFF</span>
        </div>
      )}

      <div className="pf-ink-follows">
        <span className="pf-ink-follows-label">{t("profiles.colour.follows")}</span>
        {FOLLOW.map((f) => (
          <span className="pf-ink-follow" key={f.key} title={`${t(f.name)} · ${t(f.note)}`}>
            <span className="pf-ink-chip sm" style={{ background: c[f.key] }} />
            <span className="pf-ink-follow-name">{t(f.name)}</span>
            <span className="pf-ink-follow-tag">{t(f.tag)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ThemeSection({
  draft,
  patch,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
}) {
  const { t, lang } = useI18n();
  const [custom, setCustom] = useState(false);
  const verdicts = judgePalette(draft.data.theme.colors);
  return (
    <>
      <div className="pf-swatches">
        {THEME_ORDER.map((id) => {
          const on = draft.data.theme.base === id;
          return (
            <button
              key={id}
              className={`pf-swatch-cell${on ? " on" : ""}`}
              onClick={() =>
                patch((d) => {
                  d.theme.base = id;
                  d.theme.dark = THEMES[id].dark;
                  d.theme.colors = structuredClone(THEMES[id].colors);
                  d.theme.highlightAlpha = THEMES[id].highlightAlpha;
                })
              }
              title={t(`theme.${id}`)}
            >
              <span
                className="pf-swatch"
                style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
              >
                Aa
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
      <InlineColours draft={draft} patch={patch} />

      {/* Step three of the design's own numbering: a paper of your own, from a paper and a touch,
          shown as four whole Sards. That IS a separate surface in the design, and stays one. */}
      <button className="pf-cp-open" onClick={() => setCustom(true)}>
        {t("profiles.theme.customise")} ←
      </button>

      {custom && (
        <CustomPaper
          // "Starts from X" only when there IS an X. A profile already carrying its own paper has
          // nothing to start from, and repeating the dialog's own title under it says nothing.
          startFrom={
            draft.data.theme.base
              ? t("profiles.theme.startsFrom", { name: t(`theme.${draft.data.theme.base}`) })
              : ""
          }
          initialPaper={draft.data.theme.colors.paperBg}
          initialAccent={draft.data.theme.colors.accent}
          arabicFace={draft.data.type.arabic}
          name={draft.name}
          onCancel={() => setCustom(false)}
          onApply={({ dark, colors }) => {
            patch((d) => {
              // A paper of the reader's own is no longer one of the sixteen: `base` becomes null,
              // which is what makes the card read "a paper of your own" rather than naming a preset
              // it no longer resembles.
              d.theme.base = null;
              d.theme.dark = dark;
              d.theme.colors = colors;
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
  draft,
  patch,
  rows,
  onImported,
}: {
  surface: BgSurface;
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
            <span className="bg-ctl-name" dir="auto">{row.source_name ?? ""}</span>
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
            <span>{t("gs.bg.presence")}</span>
            <span className="gs-slider-val">{localeDigits(String(slot.params.presence), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={presenceMaxFor(surface)} step={1}
            value={slot.params.presence}
            onChange={(e) => patch((d) => { at(d).params.presence = Number(e.target.value); })}
          />

          <div className="gs-slider-head">
            <span>{t("gs.bg.blur")}</span>
            <span className="gs-slider-val">{localeDigits(String(slot.params.blur), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={BG_BLUR_MAX} step={1}
            value={slot.params.blur}
            onChange={(e) => patch((d) => { at(d).params.blur = Number(e.target.value); })}
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
                onChange={(e) => patch((d) => { d.bg.reading.params.pageOpacity = Number(e.target.value); })}
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
  const colour = draft.data.theme.bookmark ?? draft.data.theme.colors.accent;
  // SIZE AND EDGE POSITION SIT BEHIND A DISCLOSURE (plan §X.0 Q12). They are the two marks settings a
  // reader sets once and then forgets, and putting them under the shapes would bury the choice that
  // is actually made often. The link is the editor's existing "go deeper" affordance — the same one
  // the colours use — rather than a new kind of control.
  const [adv, setAdv] = useState(false);

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
            onClick={() => patch((d) => { d.theme.bookmark = c.hex; })}
            title={c.name}
            aria-label={c.name}
          />
        ))}
      </div>

      {/* The two settings the design's editor does not draw but Sard has always had. Kept rather
          than silently lost, and bound to the DRAFT, so the specimen answers while the slider moves
          and nothing is written until Save. */}
      <button className="pf-cp-open" onClick={() => setAdv((v) => !v)} aria-expanded={adv}>
        {adv ? t("profiles.marks.advancedHide") : t("profiles.marks.advanced")} {adv ? "↑" : "↓"}
      </button>

      {adv && (
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
      )}

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
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
}) {
  const { t } = useI18n();
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
            <span className="pf-texture-swatch" data-step={s} aria-hidden />
            {t(`profiles.texture.${s}`)}
          </button>
        ))}
      </div>
      <div className="pf-hint">{t("profiles.marks.textureHint")}</div>
    </>
  );
}
