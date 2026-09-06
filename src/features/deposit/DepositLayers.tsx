// THE SHEAF — the marks, hanging as slips on a thread.
//
// The four layers rest CLOSED: a checkbox, an ink spine, the name, an included-over-available count,
// and «افتح». One opens at a time, so the sheet never grows past its own height.
//
// TWO TARGETS, NEVER CONFUSED. The checkbox decides the whole layer; the row's own press opens it.
// Inside, each slip carries a knot that releases that one mark. A released slip stays on screen,
// struck through rather than removed — you can always bind it again, and the count above it is the
// honest "of".
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { resolveTheme, useTheme } from "../../theme";
import { colorValue } from "../reader/highlightColors";
import type { LayerKey, Selection } from "./model/manifest";
import { LAYERS } from "./model/manifest";
import type { LayerRows } from "./model/bind";
import { layerState } from "./model/bind";
import { TINT_SLOT } from "./model/tints";

/** One slip, as either side prepares it: a sender reads its rows, a receiver reads the manifest. */
export interface SlipData {
  id: string;
  text: string;
  under?: string | null;
  place?: string | null;
  /** The receiver already glosses or replaces this phrase. Their own wording, for the comparison. */
  clash?: string | null;
  /** On a clashing slip: is the receiver taking the sender's meaning over their own? */
  taking?: boolean;
}

export type LayerSlips = Record<LayerKey, SlipData[]>;

/** One slip's three fixed tracks: knot, text, place. */
function Slip({
  id,
  text,
  under,
  place,
  clash,
  taking,
  bound,
  onToggle,
  onTakeTheirs,
}: {
  id: string;
  text: string;
  under?: string | null;
  place?: string | null;
  clash?: string | null;
  taking?: boolean;
  bound: boolean;
  onToggle: () => void;
  onTakeTheirs?: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="dep-slip" data-bound={bound ? "1" : undefined} key={id}>
      <button
        type="button"
        className="dep-knot"
        onClick={onToggle}
        title={bound ? t("dep.unbind") : t("dep.bind")}
        aria-label={bound ? t("dep.unbind") : t("dep.bind")}
        aria-pressed={bound}
      />
      <div className="dep-slip-body">
        <span className="dep-slip-text">{text}</span>
        {under ? <span className="dep-slip-under">{under}</span> : null}
        {/* A PHRASE THE RECEIVER ALREADY OWNS. Said on the slip itself, with their own wording beside
            it, so the choice is made where the thing being chosen is — not in a dialog afterwards. */}
        {clash ? (
          <span className="dep-slip-clash">
            {t("dep.clash")} <b>{clash}</b>
            {/* THE CHOICE IS MADE ON THE SLIP. Keeping your own meaning is the default; taking theirs
                is an explicit press, and it is the only thing in the whole import that replaces
                anything the receiver already had. */}
            <button type="button" className="dep-clash-btn" data-on={taking ? "1" : undefined} onClick={onTakeTheirs}>
              {taking ? t("dep.takeTheirs") : t("dep.keepMine")}
            </button>
          </span>
        ) : null}
      </div>
      <span className="dep-slip-place">{place ?? t("dep.noPlace")}</span>
    </li>
  );
}

export function DepositLayers({
  slips,
  selection,
  openLayer,
  onOpen,
  onSetLayer,
  onToggleMark,
  onTakeTheirs,
  /** «ما ظلّلتُه» when it is your reading, «ما ظلّله» when it is someone else's. */
  possessive = "mine",
  labelKey = "dep.sheafLabel",
  unplaced = 0,
}: {
  slips: LayerSlips;
  selection: Selection;
  openLayer: LayerKey | null;
  onOpen: (k: LayerKey | null) => void;
  onSetLayer: (k: LayerKey, on: boolean) => void;
  onToggleMark: (k: LayerKey, id: string) => void;
  onTakeTheirs?: (k: LayerKey, id: string) => void;
  possessive?: "mine" | "theirs";
  labelKey?: string;
  /**
   * How many marks carry no place in the book.
   *
   * THE MAP IS SPATIAL AND THESE HAVE NO SPACE, so the sheaf is where the fact belongs — a footnote
   * under the layers, never a shape on the map. It says the marks are here and that the map has
   * nowhere to draw them; it says nothing about which KIND they are, because the kind is not the
   * reason. A reference made from a page has a place and is drawn like any other mark.
   */
  unplaced?: number;
}) {
  const { t, lang } = useI18n();
  const asRows: LayerRows = slips;
  // The same two lines every other surface uses to read a slot colour, so the layers follow whatever
  // palette is live — built-in or reader-made.
  const hl = resolveTheme(useTheme((s) => s.themeId)).colors.highlight;
  const tintOf = (k: LayerKey) => colorValue(TINT_SLOT[k], hl);

  return (
    <section className="dep-sheaf">
      <span className="dep-label">{t(labelKey as never)}</span>
      <ul className="dep-layers">
        {LAYERS.map((k) => {
          const available = asRows[k].length;
          const included = selection[k].size;
          const state = layerState(selection, k, asRows);
          const open = openLayer === k;
          return (
            <li
              className="dep-layer"
              key={k}
              data-open={open ? "1" : undefined}
              data-layer={k}
              style={{ ["--dep-tint" as string]: tintOf(k) }}
            >
              <div className="dep-layer-head">
                <button
                  type="button"
                  className="dep-check"
                  data-state={state}
                  disabled={available === 0}
                  onClick={() => onSetLayer(k, state !== "all")}
                  title={state === "all" ? t("dep.releaseAll") : t("dep.takeAll")}
                  aria-label={state === "all" ? t("dep.releaseAll") : t("dep.takeAll")}
                  aria-pressed={state === "all"}
                >
                  {state !== "none" && <Icon name="check" size="sm" />}
                </button>
                <span className="dep-spine" aria-hidden />
                <span className="dep-layer-name">{t(`dep.layer.${possessive}.${k}` as never)}</span>
                <span className="dep-layer-count">
                  {t("dep.layerCount", {
                    included: localeNum(included, lang),
                    available: localeNum(available, lang),
                  })}
                </span>
                <button
                  type="button"
                  className="dep-open"
                  disabled={available === 0}
                  onClick={() => onOpen(open ? null : k)}
                >
                  {open ? t("dep.close") : t("dep.open")}
                </button>
              </div>
              {open && (
                <ul className="dep-slips">
                  {slips[k].map((s) => (
                    <Slip
                      key={s.id}
                      id={s.id}
                      text={s.text}
                      under={s.under}
                      place={s.place ?? t("dep.noPlace")}
                      clash={s.clash}
                      taking={s.taking}
                      bound={selection[k].has(s.id)}
                      onToggle={() => onToggleMark(k, s.id)}
                      onTakeTheirs={onTakeTheirs ? () => onTakeTheirs(k, s.id) : undefined}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {/* Only when there is something to explain — silence when every mark has a place. */}
      {unplaced && unplaced > 0 ? (
        <p className="dep-unplaced">
          {unplaced === 1
            ? t("dep.unplacedOne")
            : t("dep.unplacedMany", { n: localeNum(unplaced, lang) })}
        </p>
      ) : null}
    </section>
  );
}
