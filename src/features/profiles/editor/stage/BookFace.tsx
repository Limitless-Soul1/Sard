// The editor stage's BOOK face — the reading surface as this profile would draw it.
//
// THE PAGE IS A SHEET ON A DESK, not a card that fills the frame. The page takes a fixed 428px
// measure and is centred in the stage, so the desk — and therefore the background image, and
// therefore what page translucency is translucent AGAINST — stays visible on both sides. The old
// stage sized the page to 79% of a 16:10 card, which left no desk to speak of and made the whole
// background chapter impossible to judge.
//
// A FIXED MEASURE IS ALSO WHY THERE ARE NO CONTAINER QUERIES HERE. The previous specimen scaled its
// type and its bookmark off the frame's width through `cqw`, which needed a query container and a
// length-division custom property. At a constant 428px the design's own px and rem values are simply
// correct, so the scaling machinery — and the "if the renderer cannot divide two lengths" fallback it
// needed — is gone rather than reimplemented.

import { BookmarkShape } from "../../../reader/BookmarkShape";
import { useI18n } from "../../../../i18n";
import { localeNum } from "../../../../lib/format";
import { PAGE_WIDTH_DEFAULT, pageWidthPx } from "../../../../reader-engine/injectedCss";
import { bookFaceCss } from "../../mini";
import type { Profile } from "../../model/profile";

/**
 * The design draws its marker 57px tall on the 452px page it drew — a proportion of 0.126 of the
 * measure. The measure is now 428 (see `PAGE_AT_DEFAULT`), so holding that same drawn proportion puts
 * the marker at 428 × 0.126 ≈ 54, which production's default of 68px (`DEFAULT_SIZE` in
 * `bookmarkStyle.ts`) reaches at 68 × 0.794.
 *
 * The marker is deliberately NOT re-derived from the reference window the way the measure is. At that
 * scale it would be 31px: the design's marker is a drawn emblem, not a scale copy of the reader's, and
 * halving it would be redrawing the design rather than placing it. It keeps its proportion to the page
 * and tracks the slider from there across 40..120.
 */
const MARK_K = 0.794;

/**
 * The composition's own width, and the page's share of it AT THE REFERENCE WINDOW (see the reference
 * note in `profiles.css`, at `.pf-stage-fit`).
 *
 * 428 is not a drawn number. The reading page is an absolute measure in the running application —
 * `pageWidthPx(0.5)` = 940px by default, capped only by `min(100%)` — so its share of the window is
 * whatever the window happens to be, measured from 100% at 1180 down to 43.8% at 3200. Pinning the
 * reference at 1440 x 900 makes that share answerable: 940 / 1440 × 656 = 428. The design's own 452
 * was the same drawing against a ~1364px window, which is why it never looked wrong on a laptop and
 * always looked oversized on a large monitor.
 *
 * PAGE WIDTH IS NOT A PROFILE PROPERTY. It is named in the package validator's forbidden list and
 * the rail's footer promises the reader it stays theirs in every profile, so the preview BORROWS
 * their measure to open on and never writes one. `previewPageWidth` maps the reader's own 0..1
 * fraction — the same one the reading surface uses, through the same `pageWidthPx` — onto the
 * composition, anchored so that their default measure draws exactly 428. That way an untouched
 * preview is the design's specimen at the reference, and moving the control shows the paper and the
 * type at the measure the reader actually reads at.
 */
const COMPOSITION_W = 656;
const PAGE_AT_DEFAULT = 428;

export function previewPageWidth(fraction: number): number {
  const k = PAGE_AT_DEFAULT / pageWidthPx(PAGE_WIDTH_DEFAULT);
  return Math.min(pageWidthPx(fraction) * k, COMPOSITION_W);
}

/** The design's specimen progress. A picture of a book being read, not a reading of this one. */
const READ_PCT = 38;

export function BookFace({ profile }: { profile: Profile }) {
  const { t, lang } = useI18n();
  const c = profile.data.theme.colors;
  const dark = profile.data.theme.dark;

  return (
    <>
      <div className="pf-bookface" aria-hidden>
        <div className="pf-page">
          {/* The paper is a layer under the type, which is what lets the sheet thin over the reading
              environment behind it while the words stay fully opaque. The environment itself is NOT
              here: it belongs to the composition, so that resizing this page reveals more of it
              rather than resizing it too. */}
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
