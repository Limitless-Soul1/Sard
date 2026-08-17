// The editor stage's BOOK face — the reading surface as this profile would draw it.
//
// THE PAGE IS A SHEET ON A DESK, not a card that fills the frame. The design gives the page a fixed
// 452px measure and centres it in the stage, so the desk — and therefore the background image, and
// therefore what page translucency is translucent AGAINST — stays visible on both sides. The old
// stage sized the page to 79% of a 16:10 card, which left no desk to speak of and made the whole
// background chapter impossible to judge.
//
// A FIXED MEASURE IS ALSO WHY THERE ARE NO CONTAINER QUERIES HERE. The previous specimen scaled its
// type and its bookmark off the frame's width through `cqw`, which needed a query container and a
// length-division custom property. At a constant 452px the design's own px and rem values are simply
// correct, so the scaling machinery — and the "if the renderer cannot divide two lengths" fallback it
// needed — is gone rather than reimplemented.

import { BookmarkShape } from "../../../reader/BookmarkShape";
import { useI18n } from "../../../../i18n";
import { localeNum } from "../../../../lib/format";
import { PAGE_WIDTH_DEFAULT, pageWidthPx } from "../../../../reader-engine/injectedCss";
import type { BgParams } from "../../../../lib/background";
import { bookFaceCss } from "../../mini";
import type { Profile } from "../../model/profile";

/**
 * The design draws its marker 57px tall on its 452px page. Production's default marker is 68px of
 * real page (`DEFAULT_SIZE` in `bookmarkStyle.ts`), so the preview draws it at 68 × 0.84 ≈ 57 — the
 * design's own proportion at the default setting, tracking the slider from there across 40..120.
 */
const MARK_K = 0.84;

/**
 * The composition's own width, and the page's share of it as the design draws it (452 of 656).
 *
 * PAGE WIDTH IS NOT A PROFILE PROPERTY. It is named in the package validator's forbidden list and
 * the rail's footer promises the reader it stays theirs in every profile, so the preview BORROWS
 * their measure to open on and never writes one. `previewPageWidth` maps the reader's own 0..1
 * fraction — the same one the reading surface uses, through the same `pageWidthPx` — onto the
 * composition, anchored so that their default measure draws exactly the 452px the design specifies.
 * That way an untouched preview is the design's specimen, and moving the control shows the paper and
 * the type at the measure the reader actually reads at.
 */
const COMPOSITION_W = 656;
const PAGE_AT_DEFAULT = 452;

export function previewPageWidth(fraction: number): number {
  const k = PAGE_AT_DEFAULT / pageWidthPx(PAGE_WIDTH_DEFAULT);
  return Math.min(pageWidthPx(fraction) * k, COMPOSITION_W);
}

/** The design's specimen progress. A picture of a book being read, not a reading of this one. */
const READ_PCT = 38;

export function BookFace({
  profile,
  bg,
}: {
  profile: Profile;
  /** The book's own picture, already resolved. The PAGE owns it — see the note below. */
  bg?: { url: string; params: BgParams; scrim: number } | null;
}) {
  const { t, lang } = useI18n();
  const c = profile.data.theme.colors;
  const dark = profile.data.theme.dark;

  return (
    <>
      <div className="pf-bookface" aria-hidden>
        <div className="pf-page">
          {/* THE PICTURE, INSIDE THE PAGE. It used to hang on the composition, so it was a layer the
              page merely sat on: measured at the default measure it ran 260px past the page to the
              left and right, 175px above and 73px below, and `elementFromPoint` either side of the
              page returned the transparent book area with the image showing through. The page is the
              environment the image belongs to, so it owns it.

              THE CLIP IS A WRAPPER, NOT `overflow` ON THE PAGE. The marker deliberately overhangs the
              page's top edge, and clipping the page itself would cut the tab off — that was fixed
              once already and must not come back. This box is inset to the page's own bounds and
              clips only what is inside it.

              ORDER IS THE WHOLE POINT: image, then scrim, then the translucent paper, then the type.
              The sheet thins over the picture and the words stay fully opaque above both. */}
          {bg && (
            <span className="pf-page-bgclip">
              <span
                className="pf-page-bg"
                style={{
                  backgroundImage: `url("${bg.url}")`,
                  backgroundPosition: `${bg.params.focalX}% ${bg.params.focalY}%`,
                  filter: `blur(${bg.params.blur}px)`,
                  transform: `scaleX(${bg.params.flip ? -1 : 1})`,
                }}
              />
              <span className="pf-page-scrim" style={{ opacity: bg.scrim }} />
            </span>
          )}
          {/* The paper itself is a layer under the type, which is what lets the sheet thin over the
              image while the words stay fully opaque. */}
          <div className="pf-page-paper" />

          <div
            className="pf-page-label"
            style={{ fontFamily: bookFaceCss(profile.data.type.arabic) }}
            dir="rtl"
          >
            الفصل الثالث · في المجالس
          </div>

          {/* BOTH SCRIPTS, ALWAYS. A profile authored by a Latin reader still ships an Arabic face,
              and the only way to see that is to show it — so this passage is a type specimen and does
              NOT follow the interface language, unlike the chrome around it. */}
          <p
            className="pf-page-ar"
            style={{ fontFamily: bookFaceCss(profile.data.type.arabic) }}
            dir="rtl"
          >
            وكان في المدينة رجلٌ يجمع الحكايات كما يجمع الناسُ المال، فإذا أقبل الليل{" "}
            <span
              className="pf-page-hl"
              style={{
                background: c.highlight.amber,
                mixBlendMode: dark ? "screen" : "multiply",
                opacity: dark ? 0.66 : 0.72,
              }}
            >
              نشرها على مجلسه
            </span>{" "}
            فجلس السامعون كأنّهم في سَفَرٍ لا يبلغ آخره، ثمّ ينصرفون وفي أيديهم{" "}
            <span className="pf-page-ul">طَرَفٌ من الخبر</span>.
          </p>

          <p
            className="pf-page-la"
            style={{ fontFamily: bookFaceCss(profile.data.type.latin) }}
            dir="ltr"
          >
            The night narrows to a single lamp, and the story keeps its own hours.
          </p>

          {/* AT ITS REAL EDGE POSITION, and hanging over the page's top edge exactly as the reader's
              own marker does. `bookmarkPos` is PHYSICAL — it does not flip with the interface
              language (see `PageBookmark`), so a preview that mirrored it would be showing something
              the reader will never see. */}
          <span
            className="pf-page-mark"
            style={{ left: `${profile.data.marks.bookmarkPos * 100}%` }}
          >
            <BookmarkShape
              shape={profile.data.marks.bookmarkShape}
              color={profile.data.theme.bookmark ?? c.accent}
              h={profile.data.marks.bookmarkSize * MARK_K}
            />
          </span>
        </div>
      </div>

      {/* Sard's reading bar, on the desk below the page. It carries the interface texture because it
          is chrome, which is what makes `texture` legible on the book face at all. */}
      <div className="pf-readbar" aria-hidden>
        <span className="pf-readbar-name">{t("profiles.preview.readingBar")}</span>
        <span className="pf-readbar-rule" />
        <span className="pf-readbar-pct">{localeNum(READ_PCT, lang)}%</span>
      </div>
    </>
  );
}
