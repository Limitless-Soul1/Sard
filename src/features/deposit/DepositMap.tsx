// THE READING MAP — where this reader went, drawn before a word of it is read.
//
// «خريطة قراءتي» when it is yours, «خريطة قراءته» when it is his. A STACKED COLUMN CHART: twenty-four
// fixed columns across the book, one per stretch, each stacked by the KIND of mark made there in one
// fixed order so the strata read alike from one column to the next. All four kinds share a column —
// a stretch is one bar, never four — and a kind with nothing in that stretch takes no room at all.
// You can see the shape of someone's reading before reading any of it: where they went quiet, where
// they stopped four times in sixty chapters.
//
// A STRATUM'S HEIGHT IS ITS COUNT, NOT ITS SHARE. Thirteen pixels a mark, capped at forty-six, exactly
// as the reference draws it. Absolute rather than normalised on purpose: normalising to the busiest
// stretch makes one dense chapter flatten the whole book, and "four times in sixty chapters" stops
// being legible. The cap is what keeps one crowded stretch from towering over the rest.
//
// THE FRAME IS A BOUNDARY, AND THE MAP IS CONTAINED BY IT. Four kinds at the cap is 4x46 + 3x2 = 190px
// in a 112px box, so a genuinely crowded stretch is taller than the frame it stands in. What is drawn
// stops at the frame's top edge. The heights themselves are untouched — a segment is still its count —
// and every mark stays in the model, the sheaf, the manifest and the transfer; the map is a viewport
// on the stack, not a recount of it.
//
// WHY CONTAINMENT WINS. Without the clip the top of a dense stack paints over the map's own header and
// into the inscription above it, and past 158px it vanishes behind that card regardless, because a
// textarea paints above the backgrounds of later siblings. Covering unrelated UI is the worse of the
// two failures. Measured: real reading data reaches 46px and the reference's own fixture 87px, so the
// boundary is reached only by a stretch holding roughly nine or more marks of three or more kinds.
//
// PRESSING A STRATUM TAKES OR RELEASES ITS WHOLE LAYER — the map is a control, not a picture. It is
// the same act as the layer's own checkbox below, so there is one way for a layer to change and two
// places to reach it.
//
// Direction is left to the document: the app runs RTL for Arabic and the flex row follows it, so the
// first stretch of the book sits where the book itself begins. Every colour is a live theme token —
// the mark's own ink for a stratum, the chrome's rule for silence — so a reader's own palette paints
// this map with no lookup table of its own.
import { useI18n } from "../../i18n";
import { resolveTheme, useTheme } from "../../theme";
import { colorValue } from "../reader/highlightColors";
import { TINT_SLOT } from "./model/tints";
import { localeNum } from "../../lib/format";
import type { Band, ReadingMap, Strata } from "./model/map";
import type { LayerKey } from "./model/manifest";
import { totalIn } from "./model/map";

/** The four strata, bottom to top, in the order the sheaf lists them. */
const ORDER: (keyof Strata)[] = ["highlights", "notes", "references", "replacements"];

/** The reference's own measure: a mark is this tall, and no stratum grows past the cap. */
const UNIT = 13;
const CAP = 46;

/** A chapter number under every sixth bar — enough to locate a stretch, few enough to stay quiet. */
const LABEL_EVERY = 6;

function Bar({
  band,
  tint,
  possessive,
  onSetLayer,
}: {
  band: Band;
  tint: (k: keyof Strata) => string;
  possessive: "mine" | "theirs";
  onSetLayer?: (k: LayerKey, on: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const segs = ORDER.filter((k) => band.all[k] > 0).map((k) => ({
    k,
    n: band.all[k],
    // BINARY, as the reference draws it: a stretch is lit while any of its marks of that kind is bound,
    // and empties to a hollow strip when the last one is released.
    on: band.bound[k] > 0,
    h: Math.min(band.all[k] * UNIT, CAP),
  }));

  // A SILENT STRETCH IS STILL DRAWN. Where the reader went quiet is a fact about the reading, so it
  // keeps a hollow strip rather than being left out of the row.
  if (!segs.length) return <div className="dep-band" data-empty="1" />;

  return (
    <div className="dep-band">
      {segs.map((s) => {
        const title = t("dep.mapBand", {
          name: t(`dep.layer.${possessive}.${s.k}` as never),
          n: localeNum(s.n, lang),
          from: localeNum(band.from + 1, lang),
          to: localeNum(band.to + 1, lang),
        });
        return (
          <button
            type="button"
            key={s.k}
            className="dep-stratum"
            data-layer={s.k}
            data-on={s.on ? "1" : undefined}
            data-voice={possessive}
            style={{ height: `${s.h}px`, ["--dep-tint" as string]: tint(s.k) }}
            title={title}
            aria-label={title}
            aria-pressed={s.on}
            disabled={!onSetLayer}
            onClick={() => onSetLayer?.(s.k as LayerKey, !s.on)}
          />
        );
      })}
    </div>
  );
}

export function DepositMap({
  map,
  marks,
  // The same map, in either voice: «خريطة قراءتي» when it is yours, «خريطة قراءته» when it is his.
  labelKey = "dep.mapLabel",
  noteKey,
  possessive = "mine",
  onSetLayer,
}: {
  map: ReadingMap;
  marks: number;
  labelKey?: string;
  noteKey?: string;
  possessive?: "mine" | "theirs";
  onSetLayer?: (k: LayerKey, on: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const hl = resolveTheme(useTheme((s) => s.themeId)).colors.highlight;
  const tint = (k: keyof Strata) => colorValue(TINT_SLOT[k], hl);
  return (
    <section className="dep-map">
      <header className="dep-map-head">
        <span className="dep-label">{t(labelKey as never)}</span>
        {/* The hairline between the two, as the reference rules it. */}
        <span className="dep-map-rule" aria-hidden />
        <span className="dep-note">
          {!map.bands.length
            ? t("dep.mapNoneNote")
            : noteKey
              ? t(noteKey as never)
              : t("dep.mapNote", { bands: localeNum(map.bands.length, lang), marks: localeNum(marks, lang) })}
        </span>
      </header>
      {map.bands.length > 0 && (
        <>
          <div className="dep-bands">
            {map.bands.map((b) => (
              <Bar key={b.index} band={b} tint={tint} possessive={possessive} onSetLayer={onSetLayer} />
            ))}
          </div>
          {/* THE RULE ROW — NOT AN AXIS. There is no continuous line anywhere in the map: this is
              twenty-four separate 2px segments on the same tracks as the bands above, each saying
              what its own stretch holds. Warm where something in that stretch is taken; on a received
              map, faintly warm where he marked a stretch you have taken nothing from — so his reading
              never arrives looking empty; otherwise the chrome's own rule, for silence.
              The book's chapter numbers sit under every sixth segment, each under ITS OWN stretch, so
              a number never names a stretch it is not standing on. A band past the end of a short
              book gets no number, because there is no such chapter to name. */}
          <div className="dep-axis">
            {map.bands.map((b, i) => (
              <div className="dep-axis-cell" key={b.index}>
                <span
                  className="dep-axis-rule"
                  data-rule={
                    totalIn(b.bound) > 0 ? "on" : possessive === "theirs" && totalIn(b.all) > 0 ? "his" : undefined
                  }
                  aria-hidden
                />
                <span className="dep-axis-label" aria-hidden>
                  {i === 0
                    ? t("dep.mapChapter", { n: localeNum(1, lang) })
                    : i % LABEL_EVERY === 0 && b.to >= b.from
                      ? localeNum(b.from + 1, lang)
                      : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
