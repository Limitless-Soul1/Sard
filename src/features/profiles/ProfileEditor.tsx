// The profile editor — a composer, not a settings form.
//
// The design: "It borrows the shape Sard already uses for its one creative surface — the photo
// composer's stage plus a 344px rail. One section is open at a time; the stage answers immediately,
// and it can be shown as the Library or as the open book, because a background belongs to one of
// them and a reading face belongs to the other."
//
// So the geometry here is not invented: `.pc-stage` / `.pc-panel` (344px) is the shape the photo
// composer already uses, and the classes below sit beside it rather than replacing it.
//
// THE RAIL'S LAST BLOCK IS THE FIREWALL, stated once and never repeated: line spacing, measure,
// margins, diacritics, alignment and size are the reader's own, in every profile. It is not a
// control — it is the answer to the question the editor otherwise invites.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import {
  BG_BLUR_MAX,
  PAGE_OPACITY_MIN,
  bgSrcUrl,
  presenceMaxFor,
  type BgSurface,
} from "../../lib/background";
import { localeDigits } from "../../lib/format";
import { backgroundImport, backgroundsList, type BackgroundRow } from "../../lib/ipc";
import { BOOKMARK_COLORS, BOOKMARK_SHAPES } from "../../lib/bookmarkStyle";
import { READ_MARKERS } from "../../lib/readMarkerStyle";
import { FONT_CATALOGUE, useFonts } from "../../lib/fonts";
import { ARABIC_FONTS, LATIN_FONTS } from "../../reader-engine/injectedCss";
import { THEMES, THEME_ORDER } from "../../theme/themes";
import { BookmarkShape } from "../reader/BookmarkShape";
import { CustomPaper } from "./CustomPaper";
import { ShareSheet } from "./ShareSheet";
import { SardMini } from "./SardMini";
import { bookFaceCss, miniOf } from "./mini";
import { saveProfile, useProfiles } from "./store";
import { TEXTURE_STEPS, type Profile, type ProfileData } from "./model/profile";
import { judgePalette } from "./model/guidance";

type SectionId = "identity" | "theme" | "libbg" | "bookbg" | "fonts" | "marks";

export function ProfileEditor({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useI18n();
  const live = useProfiles((s) => s.profiles.find((p) => p.id === profile.id)) ?? profile;

  const [draft, setDraft] = useState<Profile>(() => structuredClone(live));
  const [open, setOpen] = useState<SectionId>("theme");
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

  const section = (id: SectionId, label: string, value: string, body: React.ReactNode) => (
    <div className={`pf-sec${open === id ? " open" : ""}`}>
      <button className="pf-sec-head" onClick={() => setOpen(id)} aria-expanded={open === id}>
        <span className="pf-sec-label">{label}</span>
        <span className="pf-sec-value">{value}</span>
      </button>
      {open === id && <div className="pf-sec-body">{body}</div>}
    </div>
  );

  const themeName = draft.data.theme.base
    ? t(`theme.${draft.data.theme.base}`)
    : t("profiles.theme.custom");

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
          onClick={() => setShare(true)}>
          {t("profiles.card.share")}
        </button>
        <button className="pf-btn primary" disabled={!dirty} onClick={() => void save()}>
          {t("profiles.editor.save")}
        </button>
        <button className="pf-editor-x" onClick={onClose} aria-label={t("profiles.editor.close")}>
          ✕
        </button>
      </div>

      {/* RAIL FIRST, then the stage — the design's own order. Its rail carries `border-inline-end`,
          which puts it at the inline START: the right in Arabic, the left in English. That is what
          makes its own caption true — "what you see on the left is what you will see in Sard". */}
      <div className="pf-editor-body">
        {/* THE RAIL — 344px, six sections, one open at a time. */}
        <div className="pf-rail">
          <div className="pf-rail-head">
            <span className="pf-rail-head-title">{t("profiles.editor.railTitle")}</span>
            <span className="pf-rail-head-sub">{t("profiles.editor.sectionsHint")}</span>
          </div>
          {section(
            "identity",
            t("profiles.section.identity"),
            draft.name ?? "—",
            <IdentitySection draft={draft} setDraft={setDraft} />,
          )}

          {section(
            "theme",
            t("profiles.section.theme"),
            themeName,
            <ThemeSection draft={draft} patch={patch} />,
          )}

          {section(
            "libbg",
            t("profiles.section.libraryBg"),
            bgRows.find((r) => r.id === draft.data.bg.library.ref)?.source_name ?? "—",
            <BackgroundSection
              surface="library"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={(r) => setBgRows((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r]))}
            />,
          )}

          {section(
            "bookbg",
            t("profiles.section.bookBg"),
            draft.data.bg.reading.sameAsLibrary
              ? t("profiles.bg.sameAsLibraryShort")
              : bgRows.find((r) => r.id === draft.data.bg.reading.ref)?.source_name ?? "—",
            <BackgroundSection
              surface="reading"
              draft={draft}
              patch={patch}
              rows={bgRows}
              onImported={(r) => setBgRows((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r]))}
            />,
          )}

          {section(
            "fonts",
            t("profiles.section.fonts"),
            t("profiles.fonts.three"),
            <FontsSection draft={draft} patch={patch} />,
          )}

          {section(
            "marks",
            t("profiles.section.marks"),
            t(`profiles.shape.${draft.data.marks.bookmarkShape}`),
            <MarksSection draft={draft} patch={patch} />,
          )}

          {/* The firewall. Not a control — the one place the boundary is stated. */}
          <div className="pf-firewall">
            <div className="pf-firewall-title">{t("profiles.notPart.title")}</div>
            <p className="pf-firewall-body">{t("profiles.notPart.body")}</p>
          </div>
        </div>

        {/* THE STAGE — what you see here is what you will see in Sard. */}
        <div className="pf-stage">
          <div className="pf-stage-seg" role="group">
            <button className={face === "library" ? "on" : ""} onClick={() => setFace("library")}>
              {t("profiles.editor.stageLibrary")}
            </button>
            <button className={face === "book" ? "on" : ""} onClick={() => setFace("book")}>
              {t("profiles.editor.stageBook")}
            </button>
          </div>
          <div className="pf-stage-frame">
            {face === "library" ? <SardMini p={miniOf(draft)} /> : <BookStage profile={draft} />}
          </div>
        </div>
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
function BookStage({ profile }: { profile: Profile }) {
  const c = profile.data.theme.colors;
  const dark = profile.data.theme.dark;
  return (
    <div className="pf-book" style={{ background: c.surfaceBg }}>
      <div className="pf-book-sheet" style={{ background: c.paperBg, color: c.text }}>
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
        <span className="pf-book-mark">
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
}: {
  draft: Profile;
  setDraft: React.Dispatch<React.SetStateAction<Profile>>;
}) {
  const { t } = useI18n();
  const seal = (draft.name ?? "").trim().slice(0, 1) || "س";
  const colour = draft.iconKind === "color";

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

      {/* THE ICON. Two kinds, not three: 'image' needs the asset pipeline the backgrounds need, and
          that arrives with them. The seal is not a placeholder for it — the design calls the initial
          "a type specimen, not clip art", so it is a real choice a reader may prefer to keep.
          The preview is drawn exactly as the card draws it, because it IS the card's seal. */}
      <div className="pf-field">
        <span className="pf-field-label">{t("profiles.identity.icon")}</span>
        <div className="pf-icon-kinds" role="radiogroup">
          <button
            role="radio"
            aria-checked={!colour}
            className={`pf-icon-kind${!colour ? " on" : ""}`}
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
                iconRef: d.iconRef ?? d.data.theme.colors.accent,
              }))
            }
          >
            <span className="pf-seal" style={{ background: draft.data.theme.colors.paperBg }}>
              <span
                className="pf-seal-dot"
                style={{ background: draft.iconRef ?? draft.data.theme.colors.accent }}
              />
            </span>
            {t("profiles.identity.iconColour")}
          </button>
        </div>

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

      {!colour && <div className="pf-hint">{t("profiles.identity.sealHint")}</div>}
    </>
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

      {/* The way out of the sixteen. The design puts it exactly here, as a link under the grid. */}
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
  const { t } = useI18n();
  const colour = draft.data.theme.bookmark ?? draft.data.theme.colors.accent;

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

      {/* INTERFACE TEXTURE — three named steps, never a percentage. The design is explicit, and an
          enum cannot drift below the measured floor the way a stored number could. The page is
          deliberately unreachable from here: its translucency lives in the book-background section,
          against its own AAA floor. */}
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
