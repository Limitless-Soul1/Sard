// THE `+` THAT OPENS SARD'S OWN COLOUR PICKER, wherever a swatch row offers a custom colour.
//
// WHAT IT REPLACES. Every custom-colour affordance in the Reader was a `<label class="rs-ink
// rs-ink-custom">` wrapping `<input type="color">` — so pressing it left Sard entirely and opened
// the operating system's colour dialog. Five of them: the text ink, the page, the desk, the
// reference rule, and the read-aloud track. They worked, and none of them looked like Sard, and not
// one accepted a typed or pasted value.
//
// WHY A COMPONENT AND NOT A PROP. The swatch markup is shared already (`rs-ink`), so the only thing
// the five sites disagreed about was where the picker should appear. Making that one decision once —
// an inline panel directly beneath the row it belongs to — is what makes them consistent. It is
// inline rather than floating on purpose: these rows live in a scrolling settings drawer, and a
// floating layer there has to track the scroll, the drawer's own clipping and the window edge, which
// is three chances to be wrong for no gain the reader can see.
//
// The panel commits AS THE COLOUR IS CHOSEN — the whole value of a live preview — and `Done` closes
// it. `null` (follow the theme) stays entirely the caller's business: this only ever reports a hex.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Space kept between the panel and the window edge, in px. */
export const PANEL_EDGE = 8;
/** The offset the stylesheet puts between the swatch and the panel. */
export const GAP = 10;

import { useI18n } from "../i18n";
import { ColorPicker } from "./ColorPicker";

export function InkCustom({
  value,
  fallback,
  onPick,
  presets = [],
  contrastAgainst,
  title,
}: {
  /** The current override, or null when the row is following the theme. */
  value: string | null;
  /** What to open on when there is no override — the theme's own value for this role. */
  fallback: string;
  onPick: (hex: string) => void;
  presets?: readonly string[];
  /** Shown against the colour so a reader sees the pairing they are making. */
  contrastAgainst?: string;
  title: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // A press anywhere else closes it. Bound while open only, so the settings drawer behaves normally
  // the rest of the time.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  // KEEP THE PANEL IN THE WINDOW.
  //
  // The stylesheet placed it with `position: absolute; inset-inline-start: 0; top: calc(100% + 10px)`
  // against the SWATCH, which is 2.35rem wide and sits at the end of a colour row near the drawer's
  // edge. A panel `min-width: 15rem` therefore hung off the side of the application. Measured in the
  // running reader before this: all five swatches, at 1280x800, 1024x700 and 900x620 — fifteen of
  // fifteen escaped, by up to 142px to the side and 86px below.
  //
  // The fix measures rather than guesses, because the panel's size is not knowable from here: the
  // picker sizes itself, the drawer scrolls, and the window resizes. `dx` slides it back inside on
  // the inline axis and `above` flips it over the swatch when there is no room beneath.
  const panel = useRef<HTMLDivElement | null>(null);
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setAbove(false); return; }
    const place = () => {
      const el = panel.current;
      if (!el) return;
      // THE SHIFT IS APPLIED HERE, NOT THROUGH STATE, and that is the whole correctness argument.
      //
      // The first version computed `dx` and handed it to React as a style prop. `place()` has to
      // clear the transform before measuring — the previous shift is part of the rect, so leaving it
      // on compounds the correction — and when the newly computed `dx` equalled the one already in
      // state, React had nothing to re-render and never put the transform back. Measured in the
      // running reader: fifteen of fifteen panels still escaped, by exactly the amounts they had
      // before the fix. Writing the style directly makes clearing and reapplying the same act.
      el.style.transform = "none";
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let dx = 0;
      if (r.right > vw - PANEL_EDGE) dx = vw - PANEL_EDGE - r.right;
      if (r.left + dx < PANEL_EDGE) dx = PANEL_EDGE - r.left;
      // A panel wider than the window is pinned to the start edge rather than hung off both.
      if (r.width > vw - 2 * PANEL_EDGE) dx = PANEL_EDGE - r.left;
      el.style.transform = dx ? `translateX(${dx}px)` : "";
      // THE FLIP IS MEASURED FROM THE SWATCH, NOT FROM THE PANEL.
      //
      // Asking "does the panel's current top leave room below it" is a question whose answer changes
      // the moment the flip happens: once the panel is above, its top is high, room below looks
      // enormous, and the next pass flips it back. Measured in the running reader, that oscillation
      // settled on "below" every time and the panel stayed off the bottom of the window by up to
      // 86px. The swatch does not move when the panel flips, so anchoring to it is stable.
      const anchor = wrap.current?.getBoundingClientRect();
      if (anchor) {
        const roomBelow = vh - anchor.bottom - GAP - PANEL_EDGE;
        const roomAbove = anchor.top - GAP - PANEL_EDGE;
        // Prefer below, as the design does; flip only when below will not hold it and above will.
        setAbove(r.height > roomBelow && r.height <= roomAbove);
      }
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ro && panel.current) ro.observe(panel.current);
    // `capture` so a scroll inside the settings drawer is seen too, not only the window's own.
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const live = /^#[0-9a-fA-F]{6}$/.test(value ?? "") ? (value as string) : fallback;

  return (
    <div className="rs-ink-wrap" ref={wrap}>
      <button
        type="button"
        className={`rs-ink rs-ink-custom${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-expanded={open}
      >
        <span className="rs-ink-plus" aria-hidden>+</span>
      </button>
      {open && (
        <div className={`rs-ink-panel${above ? " above" : ""}`} ref={panel}>
          <ColorPicker
            value={live}
            onChange={onPick}
            onDone={() => setOpen(false)}
            presets={presets}
            contrastAgainst={contrastAgainst}
          />
          <div className="rs-ink-panel-foot">{t("color.custom")}</div>
        </div>
      )}
    </div>
  );
}
