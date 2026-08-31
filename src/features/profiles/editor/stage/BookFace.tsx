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

import type { CSSProperties, ReactNode } from "react";

import { BookmarkShape } from "../../../reader/BookmarkShape";
import {
  PAGE_WIDTH_DEFAULT,
  READER_DESK_RATIO,
  textColumnPx,
  pageWidthPx,
  renderTypography,
  sheetWidthPx,
  type ReadingStyle,
} from "../../../../reader-engine/injectedCss";
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
/** The stage's own height at the reference window — the page fills it, as the reading sheet does. */
const COMPOSITION_H = 660;
const PAGE_AT_DEFAULT = 428;

/**
 * THE MINIATURE'S ONE SCALE FACTOR.
 *
 * `pageWidthPx` gives the reading page its width in REAL pixels — 480 at the narrow end, 1400 at the
 * wide. The composition draws the default measure at 428, so the whole miniature is that ratio:
 * 428 / 940 = 0.4553. Everything on the page is drawn at the reader's own size and then reduced by
 * this ONE number, which is what makes it a miniature rather than a small page with big words in it.
 */
export const MINI_K = PAGE_AT_DEFAULT / pageWidthPx(PAGE_WIDTH_DEFAULT);

/**
 * The reading document's own base size.
 *
 * MEASURED, NOT CHOSEN. Read out of foliate's frame in the running reader: the book's `html` and
 * `body` both compute to 16px, the paragraph to 16px, and the reader's size control is applied on top
 * as `body { zoom: N }` — so the text a reader actually sees is 16 × zoom. The specimen used a flat
 * 18 × zoom, which at the reader's own 2.5 drew 45px inside a 560px page: about a quarter of the
 * characters per line the real page fits, with words running off the edge. That is the parity break
 * this constant closes.
 */
export const READER_BASE_PX = 16;

/**
 * THE RUNNING HEAD'S SIZE, AS A RELATIONSHIP RATHER THAN A NUMBER.
 *
 * The chapter line above the specimen was drawn at 10.5px against the reader's base 16px body — so
 * the design's choice was never "10.5 pixels", it was "two-thirds of the body". Held as a flat px
 * value it could not follow the text-size control: measured across the 0.8-2.5 range the body went
 * 12.8 -> 40px and the head stayed at 10.5, so the proportion drifted from 0.82 to 0.26.
 *
 * Kept as the ratio, the head is `READER_BASE_PX * zoom * LABEL_RATIO` — the same expression the body
 * uses, times the proportion — and it is right at every size for the same reason it was right at one.
 */
export const LABEL_RATIO = 10.5 / READER_BASE_PX;

/** The page's width on screen: the reader's real measure, reduced by the miniature's scale. */
export function previewPageWidth(fraction: number): number {
  return Math.min(pageWidthPx(fraction) * MINI_K, COMPOSITION_W);
}

/**
 * Wrap Arabic marks so the diacritics control has the same thing to act on that the reader does.
 *
 * `FoliateController` walks a book's text nodes and wraps every mark in `.sard-tashkil`; `injectedCss`
 * then dims or collapses that class. The specimen has no walker, so it wraps its own passage here —
 * same character ranges, same class, so the same two CSS declarations reach it.
 */
// The reader wraps two kinds of run — Arabic marks and digits — in `.sard-tashkil` and `.sard-num`,
// and styles those classes. The specimen wraps the SAME two, with the same class names and the same
// character ranges, so the same rules reach it. One pass, so a digit inside a marked word is still
// found. The ranges are copied from `FoliateController`, which is where the reader's own are.
const RUNS = new RegExp(
  "([ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]+)" +
  "|([0-9٠-٩۰-۹]+)",
  "g",
);

function withRuns(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  RUNS.lastIndex = 0;
  while ((m = RUNS.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span className={m[1] ? "sard-tashkil" : "sard-num"} key={`${m.index}`}>{m[0]}</span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function BookFace({
  profile,
  readerStyle,
  /**
   * THE MEASURE THIS PREVIEW IS DRAWN AT — the stage's own control, not a profile value.
   *
   * It has to be a prop, and that is the whole of a regression this closes. The measure slider lives
   * on the stage (`ProfileEditor`'s `pageW`, opened on the reader's live width and never saved), and
   * it used to reach the page as `--pf-page-w`, which `.pf-page` read in the stylesheet. When the
   * page geometry moved here to match the reader's own arithmetic, `.pf-page` gained an INLINE
   * width — and an inline width beats a stylesheet variable. Measured: the slider moved, the state
   * moved, `--pf-page-w` moved 218.6 -> 428 -> 637.4 across the range, and the page stayed at a
   * fixed inline 900px through all of it. The value was arriving; nothing was reading it.
   *
   * So the slider is routed in explicitly. A profile's own `type.reading.pageWidth` is deliberately
   * NOT consulted for the sheet: before the geometry moved here, the profile never had any say in
   * the preview's width either, and the control's own hint promises the reader that page width is
   * theirs — "See the page at another width."
   */
  pageWidth,
}: {
  profile: Profile;
  readerStyle: ReadingStyle;
  pageWidth: number;
}) {
  const c = profile.data.theme.reading.colors;
  const dark = profile.data.theme.reading.dark;

  /**
   * THE MEASURE THIS PAGE IS SET IN, decided by the reading engine's own function.
   *
   * Every field the profile has no opinion about falls back to the reader's live value, which is
   * exactly what the reading surface would use — so the specimen is not "something like" the page,
   * it is the page's own arithmetic run on the same inputs. `renderTypography` also owns the one
   * real decision (tracking is withheld from RTL text), so the preview cannot accidentally show
   * Arabic something the reader would never draw.
   */
  const r = profile.data.type.reading;
  const eff = {
    ...readerStyle,
    zoom: r.zoom ?? readerStyle.zoom,
    lineHeight: r.lineHeight ?? readerStyle.lineHeight,
    letterSpacing: r.letterSpacing ?? readerStyle.letterSpacing,
    paragraphSpacing: r.paragraphSpacing ?? readerStyle.paragraphSpacing,
    fontWeight: r.fontWeight ?? readerStyle.fontWeight,
    firstLineIndent: r.firstLineIndent ?? readerStyle.firstLineIndent,
    align: r.align ?? readerStyle.align,
    diacritics: r.diacritics ?? readerStyle.diacritics,
    // The page's own geometry the measure chapter still owns. The MEASURE is not among them —
    // it arrives as a prop from the stage's own slider (see `pageWidth` above).
    marginPx: r.marginPx ?? readerStyle.marginPx,
  };
  // Two renders, because the page holds two scripts and the tracking rule is per-script. The Arabic
  // run asks as RTL and is refused; the Latin run asks as LTR and is served.
  const AR = renderTypography(eff, { rtl: true });
  const LA = renderTypography(eff, { rtl: false });

  /**
   * THE PAGE IS DRAWN AT THE READER'S OWN SIZE AND REDUCED ONCE.
   *
   * `zoom` on the page wrapper (below) is the whole miniaturisation, so everything inside is stated
   * in the reader's real pixels: 16px of book type multiplied by the reader's `zoom`, in a column of
   * `pageWidthPx(pageWidth)`. That is what makes the wrapping right — a narrow measure really is a
   * narrow column of real text, so it really does break earlier, rather than being a wide column
   * squeezed by CSS.
   */
  const arStyle: CSSProperties = {
    fontFamily: bookFaceCss(profile.data.type.arabic),
    fontSize: `${READER_BASE_PX * AR.zoom}px`,
    lineHeight: AR.lineHeight,
    fontWeight: AR.fontWeight,
    textAlign: AR.textAlign,
    textIndent: AR.textIndent,
    letterSpacing: AR.letterSpacingPx ? `${AR.letterSpacingPx}px` : undefined,
    marginBlock: `${AR.paragraphSpacingPx}px`,
  };
  const laStyle: CSSProperties = {
    fontFamily: bookFaceCss(profile.data.type.latin),
    fontSize: `${READER_BASE_PX * LA.zoom}px`,
    lineHeight: LA.lineHeight,
    fontWeight: LA.fontWeight,
    textAlign: LA.textAlign,
    textIndent: LA.textIndent,
    letterSpacing: LA.letterSpacingPx ? `${LA.letterSpacingPx}px` : undefined,
    marginBlock: `${LA.paragraphSpacingPx}px`,
  };
  /** Diacritics: the reader dims or hides the marks; the specimen shows the same three states. */
  const diaClass = ` pf-dia-${eff.diacritics}`;
  /** The number ink, from the same field the reading surface reads — `null` leaves digits inheriting. */
  const numberInk = profile.data.theme.reading.numbers;

  /**
   * THE PAGE'S GEOMETRY, DERIVED THE WAY THE READER DERIVES IT.
   *
   * The desk this window would give the reader, the sheet's own `min(100%, …)` rule against it, and
   * the gutter that leaves the text at its real proportion. The miniature's scale then falls out of
   * the widest sheet this window allows, so the composition is filled at every window size instead
   * of being pinned to one reference measurement.
   */
  const pageGeo = (() => {
    const available = Math.max(320, Math.round(window.innerWidth * READER_DESK_RATIO));
    // The STAGE's measure, through the reading surface's own `sheetWidthPx`. Same function, same
    // arithmetic, same relationship to the real reader — only the fraction comes from the control
    // the reader is holding rather than from a value they cannot see.
    const sheet = Math.round(sheetWidthPx(pageWidth, available));
    const inset = Math.max(0, eff.marginPx);
    // The TEXT HOST, as its own box rather than as padding on the sheet.
    //
    // Padding was the wrong instrument: measured, `.pf-page` ended up with 243px a side instead of
    // the 123 computed here, and rendered 982px wide despite being given 900 — a flex parent was
    // stretching it past its own width, and the stylesheet's own inline padding compounded with the
    // inset. The reader does not do it that way either: it sizes the SHEET, then insets a host
    // inside it. Two boxes, each with one job, and no arithmetic to get wrong.
    const text = textColumnPx(sheet, eff.marginPx);
    return { sheet, inset, text, k: COMPOSITION_W / available };
  })();

  return (
    <>
      <div className="pf-bookface" aria-hidden>
        {/* `zoom`, not `transform`: it is layout-affecting, so the box the composition sees is
            already the reduced one and nothing has to be sized twice. The reader applies `zoom` to
            its own body for exactly the same reason. */}
        <div
          className="pf-page"
          style={{
            zoom: pageGeo.k,
            // `border-box`, so the reader's own margins live INSIDE the measure rather than widening
            // the sheet past it — the reading surface pads within its column too.
            boxSizing: "border-box",
            width: `${pageGeo.sheet}px`,
            // Pinned: the sheet is exactly its measure, never stretched by the composition around it.
            minWidth: `${pageGeo.sheet}px`,
            maxWidth: `${pageGeo.sheet}px`,
            flex: "none",
            paddingInline: 0,
            // A PAGE IS TALL. Without a height the box shrank to the four paragraphs it holds and
            // drew a wide, short banner — correct in its proportions and nothing like a book. The
            // reading sheet fills its desk vertically, so this fills the stage: the composition's
            // own height, expressed in the reader's pixels so the one scale factor still applies.
            minHeight: `${Math.round(COMPOSITION_H / pageGeo.k)}px`,
          }}
        >
          {/* The paper is a layer under the type, which is what lets the sheet thin over the reading
              environment behind it while the words stay fully opaque. The environment itself is NOT
              here: it belongs to the composition, so that resizing this page reveals more of it
              rather than resizing it too. */}
          <div className="pf-page-paper" />

          {/* THE RUNNING HEAD, AND IT BELONGS TO THE TEXT COLUMN — not to the sheet.
              It was a bare child of `.pf-page`, which is the SHEET, so it took the sheet's full width
              while the body below it is inset to `pageGeo.text`. Being RTL, its text then sat flush
              against the paper's right edge with the column's right edge some 130px inside it —
              measured at (0,101) 861px wide against a body ending near 730. A chapter line that does
              not line up with the text it heads does not read as a heading at all; it reads as a
              stray line floating above the page, which is exactly how it was reported.
              The sheet insets a host, and this is part of that host's measure — the same width and
              the same centring the body uses, from the same one number, so the two can never drift. */}
          <div
            className="pf-page-label"
            style={{
              fontFamily: bookFaceCss(profile.data.type.arabic),
              // The body's own expression, times the proportion the design drew it at. Stated in the
              // reader's pixels like everything else on this page, so the miniature reduces it once.
              fontSize: `${READER_BASE_PX * AR.zoom * LABEL_RATIO}px`,
              width: `${pageGeo.text}px`,
              marginInline: "auto",
            }}
            dir="rtl"
          >
            الفصل الثالث · في المجالس
          </div>

          {/* BOTH SCRIPTS, ALWAYS. A profile authored by a Latin reader still ships an Arabic face,
              and the only way to see that is to show it — so this passage is a type specimen and does
              NOT follow the interface language, unlike the chrome around it. */}
          {/* THE SET BODY. Wrapped, because the measure is a relationship BETWEEN lines and
              paragraphs: a single paragraph cannot show paragraph spacing, and one line cannot show
              leading. Three paragraphs and both scripts is the smallest specimen where every control
              in the chapter has something to move. */}
          <div
            className={`pf-page-body${diaClass}`}
            style={{
              width: `${pageGeo.text}px`,
              marginInline: "auto",
              ...(numberInk ? { "--num-ink": numberInk } : {}),
            } as CSSProperties}
          >
          <p className="pf-page-ar" style={arStyle} dir="rtl">
            {withRuns("وكان في المدينة رجلٌ يجمع الحكايات كما يجمع الناسُ المال، فإذا أقبل الليل ")}
            {/* THE MARK IS BEHIND THE WORDS, NEVER ON THEM. `opacity` and `mixBlendMode` on this
                span applied to its GLYPHS as well as its background — see the note kept from the
                marks work; the alpha rides in the colour so the words keep their full strength. */}
            <span
              className="pf-page-hl"
              style={{
                background: `color-mix(in srgb, ${c.highlight.amber} ${dark ? 66 : 72}%, transparent)`,
              }}
            >
              نشرها على مجلسه
            </span>{" "}
            {withRuns(" فجلس السامعون كأنّهم في سَفَرٍ لا يبلغ آخره، ثمّ ينصرفون وفي أيديهم ")}
            <span className="pf-page-ul">{withRuns("طَرَفٌ من الخبر")}</span>.
          </p>

          <p className="pf-page-ar" style={arStyle} dir="rtl">
            {withRuns("حدّث في سنة ٤٠٧ عن ثلاثةٍ وعشرين رجلًا، ثمّ عاد إلى الفصل ۱۲ فقرأ الصفحة 348 — ولم يبدأ حتى سكن المجلس. يقول: إنّ الحكاية لا تُروى مرّتين على وجهٍ واحد، لأنّ الذي يسمعها في المرّة الثانية ليس هو الذي سمعها أوّل مرّة.")}
          </p>

          <p className="pf-page-ar" style={arStyle} dir="rtl">
            {withRuns("فإذا انتهى، قام النّاس وفي نفوسهم أنّ الليلة كانت أطول ممّا كانت، وأنّ الطريق إلى بيوتهم صار أقصر.")}
          </p>

          <p className="pf-page-la" style={laStyle} dir="ltr">
            {withRuns("Chapter 12 contains 348 pages; the night narrows to a single lamp, and the story keeps its own hours (see p. 407). He never began until the room had settled.")}
          </p>
          </div>

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
              color={profile.data.theme.reading.bookmark ?? c.accent}
              h={profile.data.marks.bookmarkSize * MARK_K}
            />
          </span>
        </div>
      </div>

      {/* THE READING BAR IS GONE FROM HERE, DELIBERATELY.
          It is reader CHROME, not the book, and it drew a floating pill across the specimen — a
          control the page does not contain. The reading surface keeps its own bar untouched; the
          preview shows the page, and only the page. */}
    </>
  );
}
