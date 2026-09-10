// A FONT THAT HAS JUST ARRIVED, PRESENTED THE WAY SARD WOULD PRESENT A PAGE.
//
// The brief is one sentence: «سرد استقبل خطًا جديدًا، وهذه هي الطريقة التي سيبدو بها». So the typeface
// is the only large thing here, and the name, the format and the coverage are small and out of its way.
//
// IT IS A POPUP OVER SARD, NOT A PAGE INSTEAD OF IT — the Library stays visible behind the scrim every
// other Sard dialog uses (`.pf-dialog-scrim`), because that is the relationship that says this arrived
// INTO Sard rather than replacing it.
//
// SIX ZONES, NOT ONE DOCUMENT. The version before this one was a popup and still read as a single
// scrolling page: identity, specimen, prose, figures, Latin and action all sat on one surface, told
// apart only by horizontal rules. What separates them now is COMPOSITION — each zone changes surface,
// alignment, measure, scale or device, so the eye can tell them apart without reading a label:
//
//   1  MASTHEAD    an inset band, pinned above the scroll: the name in its own face, and nothing else
//                  competing with it. The kicker names the moment; the metadata is a whisper.
//   2  STAGE       open canvas, the widest margins in the popup, the type at its largest, broken at a
//                  chosen point rather than wherever the box happens to end.
//   3  READING     a marginal label and a VERTICAL rule, indented — a different device from the rules
//                  above, and a different column position, so it reads as a separate composition.
//   4  DETAIL      centred and small, in a popup where nothing else is centred. Figures and marks that
//                  prose cannot show, without becoming a character inventory.
//   5  LATIN       a full-bleed inset band that echoes the masthead and closes the composition, with
//                  the same marginal-label device mirrored into LTR. Absent unless the font has Latin.
//   6  COMPLETION  the confirmation and «تمّ» together on one anchored strip — an ending, not a footer
//                  with a button parked in the corner.
//
// THE SPECIMEN TEXT IS CONTENT, NOT INTERFACE, which is why it is here and not in the locale files. An
// Arabic specimen demonstrates the font's Arabic whatever language the interface is in; translating it
// would mean an English reader could never see what the Arabic looks like.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { ensureRegistered } from "./arrive";
import { useFontPreview } from "./preview";

/**
 * THE STAGE — one written line, broken where a typographer would break it.
 *
 * Two lines, not one wrapped paragraph: the break falls after the Arabic comma, so the caesura is the
 * sentence's own rather than an accident of the panel's width. Every part is doing work — `ضَّ` carries
 * a shadda over a descender, `الشُّبّاكِ` runs a long connected word against the isolated `ثُمَّ`, and
 * the punctuation is Arabic's own «،».
 */
const HERO = ["وَقَفَ الضَّوءُ عِندَ الشُّبّاكِ،", "ثُمَّ مالَ على الوَرَقِ."];

/**
 * THE READING ZONE — the same voice at the size a book is actually set in.
 *
 * This is the question the stage cannot answer: not "is it beautiful at 52px" but "would I read three
 * hundred pages of it". Prose rhythm, ordinary sentence length, and the marks that appear in real
 * text — a bare hamza in `شيءٌ`, tanween on `حديقةٍ`, the Arabic semicolon, a shadda in `يُقلَّب`.
 */
const READING =
  "في المساءِ، حينَ يَهدَأُ البيتُ، تُفتَحُ الصَّفحةُ كما يُفتَحُ شُبّاكٌ على حديقةٍ؛ فتَمُرُّ الكلماتُ واحدةً واحدةً، حتّى لا يَبقى في الغُرفةِ شيءٌ سِوى صوتِ الوَرَقِ وهو يُقلَّب.";

/** THE DETAIL ZONE — what prose hides. Both digit sets, because a book meets both. */
const ARABIC_FIGURES = "٠١٢٣٤٥٦٧٨٩";
const LATIN_FIGURES = "0123456789";
const MARKS = "، ؛ ؟ « » ٪";
/** Diacritics shown as WORDS rather than as bare marks on a dotless carrier — a specimen, not a table. */
const VOWELLED = "مُشَدَّدَةٌ · تَنوينٌ · هَمزَةٌ · تاءٌ مَربوطَة";

/**
 * Latin: a natural sentence first, a small alphabet second, and both quieter than the Arabic.
 *
 * The alphabet carries NO figures: `LATIN_FIGURES` already shows them in the detail zone, beside the
 * Arabic-Indic set where the comparison is the point. Showing them twice cost a reader nothing and
 * cost the popup a line.
 */
const LATIN_LINE = "The quiet page turns, and the margin keeps its promise.";
const LATIN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ · abcdefghijklmnopqrstuvwxyz";

export function FontSpecimen() {
  const arrived = useFontPreview((s) => s.font);
  const clear = useFontPreview((s) => s.clear);
  const { t } = useI18n();
  const doneRef = useRef<HTMLButtonElement>(null);

  /**
   * IS THE FACE ACTUALLY DRAWING? — asked of the document, not assumed from the row.
   *
   * The whole point of this popup is that the reader sees THEIR font. A family that is stored but not
   * yet registered would render in a fallback and look, to them, exactly like the font they imported.
   * So it is re-checked here as well as before the popup opened, and while it is false the panel says
   * so rather than drawing something and staying quiet about it.
   */
  const [ready, setReady] = useState(false);
  const family = arrived?.row.family_name ?? null;
  useEffect(() => {
    if (!family) { setReady(false); return; }
    let alive = true;
    void ensureRegistered(family).then((ok) => alive && setReady(ok));
    return () => { alive = false; };
  }, [family]);

  // Escape closes, and «تمّ» takes focus when the popup opens — the idiom every other Sard surface
  // uses, so a keyboard reader is never left inside a panel with no announced way out.
  useEffect(() => {
    if (!arrived) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") clear(); };
    document.addEventListener("keydown", esc);
    doneRef.current?.focus();
    return () => document.removeEventListener("keydown", esc);
  }, [arrived, clear]);

  if (!arrived) return null;
  const { row, facts, outcome } = arrived;
  const fam = row.family_name;
  // The arriving face, with the interface stack behind it so a panel opened a moment before the file
  // lands still sets in something readable rather than collapsing to the browser's default.
  const inFont = { fontFamily: `"${fam}", var(--ui-font)` };

  const arabic = facts?.arabic ?? null;
  const latin = facts?.latin ?? null;
  const unknown = arabic === null && latin === null;
  const coverage = unknown ? "font.specimen.coverage.unknown"
    : arabic && latin ? "font.specimen.coverage.both"
    : arabic ? "font.specimen.coverage.arabic"
    : latin ? "font.specimen.coverage.latin"
    : "font.specimen.coverage.neither";

  return createPortal(
    // The scrim Sard already uses for a dialog: the Library stays visible and blurred behind it, and
    // a press outside the panel dismisses, exactly as everywhere else.
    <div className="pf-dialog-scrim" onClick={clear}>
      <div
        className="fs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("font.specimen.title")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- 1 · MASTHEAD. Pinned outside the scroll, so the identity is never scrolled away from
                the specimen it belongs to, and on its own surface so the stage below reads as open
                canvas by contrast. NO `dir="auto"` on the name: it resolves from the first strong
                character, which threw a Latin family name to the opposite edge from its own metadata
                — one block reading as two stranded halves. ---- */}
        <header className="fs-mast">
          <p className="fs-kicker">
            {t(outcome === "duplicate" ? "font.specimen.already" : "font.specimen.title")}
          </p>
          <div className="fs-name" style={inFont}>{fam}</div>
          <div className="fs-meta">
            {facts?.style && <><span>{facts.style}</span><span className="fs-dot" aria-hidden>·</span></>}
            {facts?.format && <><span>{facts.format.toUpperCase()}</span><span className="fs-dot" aria-hidden>·</span></>}
            <span>{t(coverage)}</span>
          </div>
          {!ready && <p className="fs-warn" role="status">{t("font.specimen.loading")}</p>}
          <button className="fs-x ui-close" onClick={clear} aria-label={t("panel.close")} title={t("panel.close")}>
            ✕
          </button>
        </header>

        {/* THE ONLY THING THAT SCROLLS. The masthead and «تمّ» sit outside it, so however tall a
            specimen runs the way out never leaves the popup — and the Library behind it never becomes
            the scroll container. No padding of its own: the zones are full-bleed and carry theirs. */}
        <div className="fs-body">
          {/* Drawn unless the font is KNOWN not to carry Arabic: `null` means the container could not
              be read, and refusing the specimen on a maybe would hide the one thing the reader opened
              this for. */}
          {arabic !== false && (
            <>
              {/* ---- 2 · THE STAGE ---- */}
              <section className="fs-stage" dir="rtl" lang="ar" aria-label={t("font.specimen.arabic")}>
                <p className="fs-hero" style={inFont}>
                  {HERO.map((line) => <span className="fs-hero-line" key={line}>{line}</span>)}
                </p>
              </section>

              {/* ---- 3 · READING. A marginal label and a vertical rule — a different device and a
                      different column position from the stage above it. ---- */}
              <section className="fs-read" dir="rtl" lang="ar" aria-labelledby="fs-read-mark">
                <h2 className="fs-mark" id="fs-read-mark">{t("font.specimen.reading")}</h2>
                <p className="fs-passage" style={inFont}>{READING}</p>
              </section>

              {/* ---- 4 · DETAIL. Named like its neighbours, so the reader can tell what they are
                      looking at, but centred on open ground between two bands — the one place in the
                      popup where the composition is symmetrical. ---- */}
              <section className="fs-detail" dir="rtl" lang="ar" aria-labelledby="fs-detail-mark">
                <h2 className="fs-mark" id="fs-detail-mark">{t("font.specimen.details")}</h2>
                <div className="fs-detail-set">
                  <p className="fs-figure" style={inFont}>{ARABIC_FIGURES}</p>
                  <p className="fs-figure" style={inFont} dir="ltr">{LATIN_FIGURES}</p>
                  <p className="fs-figure" style={inFont}>{MARKS}</p>
                  <p className="fs-vowelled" style={inFont}>{VOWELLED}</p>
                </div>
              </section>
            </>
          )}

          {/* ---- 5 · LATIN, only when the font really has it. A full-bleed inset band that echoes the
                  masthead and closes the composition; `solo` when there is no Arabic above it, because
                  with nothing to be subordinate to it must become the stage itself rather than leave
                  the popup with a caption where its specimen should be. ---- */}
          {latin === true && (
            <section
              className={arabic === false ? "fs-latin solo" : "fs-latin"}
              dir="ltr" lang="en" aria-labelledby="fs-en"
            >
              <h2 className="fs-mark" id="fs-en">{t("font.specimen.english")}</h2>
              <div className="fs-latin-body">
                <p className="fs-latin-line" style={inFont}>{LATIN_LINE}</p>
                <p className="fs-alphabet" style={inFont}>{LATIN_ALPHABET}</p>
              </div>
            </section>
          )}

          {/* A font with NEITHER script is not a failure — it imported, and it may hold a script Sard
              does not specimen. Saying that is better than an empty panel. */}
          {arabic === false && latin === false && (
            <p className="fs-note">{t("font.specimen.neitherNote")}</p>
          )}
          {unknown && <p className="fs-note">{t("font.specimen.unknownNote")}</p>}
        </div>

        {/* ---- 6 · COMPLETION. The confirmation and the way out on one strip: the reader learns the
                font is Sard's now IN the act of finishing, rather than from a paragraph of
                documentation stranded above a mostly empty footer. ---- */}
        <footer className="fs-foot">
          <div className="fs-final">
            <span className="fs-installed">{t("font.specimen.installed")}</span>
            <p className="fs-where">{t("font.specimen.where")}</p>
          </div>
          <button ref={doneRef} className="pf-btn primary" onClick={clear}>{t("font.specimen.done")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
