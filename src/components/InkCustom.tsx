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

/** Space kept between the panel and the edge of the box it must stay inside, in px. */
export const PANEL_EDGE = 8;
/** The offset the stylesheet puts between the swatch and the panel. */
export const GAP = 10;

/**
 * THE BOX THE PANEL MAY OCCUPY: the viewport, narrowed by every ancestor that CLIPS.
 *
 * WHY THE WINDOW IS THE WRONG BOX, and it is a defect this replaces rather than a refinement. An
 * absolutely-positioned element is clipped by the nearest ancestor whose `overflow` is not `visible`,
 * and no z-index reaches past that — a scroll container cuts its descendants whatever they stack
 * above. Keeping the panel inside the WINDOW therefore only looks like the right rule where the
 * clipping ancestor happens to reach the window's edge, which is true of the reading drawer and false
 * of a settings column in the middle of the screen.
 *
 * MEASURED, in the profile editor at 1440x940 (RTL): the preview occupies x 0..897 and the chapter
 * column x 897..1289, `.pfe-chapter` carries `overflow-y: auto` — which makes `overflow-x` compute
 * to `auto` as well — and the panel's box came out at x 805..1041. Ninety-two pixels of it fell
 * outside the column and were cut away, the preview showed through where they should have been, and
 * the column grew a horizontal scrollbar. `elementFromPoint` reported the picker at the panel's inner
 * columns and the preview's page at its outer one: not a stacking problem, a clipping one.
 *
 * The PADDING box is what clips, and `clientLeft`/`clientWidth` are what report it — the border
 * box would be too generous by the border, and a scrollbar gutter is not usable space either.
 *
 * Each axis is narrowed independently, because an ancestor may clip one and not the other.
 */
function clipBoxOf(el: Element): { left: number; top: number; right: number; bottom: number } {
  let left = 0;
  let top = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let e = el.parentElement; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    const clipsX = s.overflowX !== "visible";
    const clipsY = s.overflowY !== "visible";
    if (!clipsX && !clipsY) continue;
    const r = e.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, r.left + e.clientLeft);
      right = Math.min(right, r.left + e.clientLeft + e.clientWidth);
    }
    if (clipsY) {
      top = Math.max(top, r.top + e.clientTop);
      bottom = Math.min(bottom, r.top + e.clientTop + e.clientHeight);
    }
  }
  return { left, top, right, bottom };
}

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

  // KEEP THE PANEL INSIDE THE BOX THAT CAN ACTUALLY SHOW IT.
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
  //
  // THAT BOX IS `clipBoxOf`, NOT THE WINDOW, and the difference is the whole of a second defect —
  // see the note there for the measurement. A panel kept inside the window can still be sliced in
  // half by the scrolling column it lives in, which is what the profile editor's own colour picker
  // was, and it is not something a z-index can reach. One rule for every swatch: stay inside whatever
  // would otherwise cut you, and inside the window as well, because the window clips too.
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
      // The box is measured with the transform already cleared, so `r` and it are in one space.
      const box = clipBoxOf(el);
      const minLeft = box.left + PANEL_EDGE;
      const maxRight = box.right - PANEL_EDGE;
      let dx = 0;
      if (r.right > maxRight) dx = maxRight - r.right;
      if (r.left + dx < minLeft) dx = minLeft - r.left;
      // A panel wider than the box is pinned to its start edge rather than hung off both.
      if (r.width > maxRight - minLeft) dx = minLeft - r.left;
      // THE BLOCK AXIS IS NUDGED TOO, and it has to be, because the flip below cannot answer every
      // case. `above` chooses the better SIDE of the swatch; when neither side holds the panel it has
      // no move left to make and the old rule quietly kept the worse one. Measured in the reader's
      // read-aloud tab at 1440x940: the word pill's swatch sits mid-column with 126px below it and
      // 250px above, against a 272px panel — so it stayed below and 138px of it were cut off by
      // `.sp-body`. Sliding it is the same instrument the inline axis already uses, and it keeps the
      // panel whole rather than trading a clipped picker for a scrolling one.
      const minTop = box.top + PANEL_EDGE;
      const maxBottom = box.bottom - PANEL_EDGE;
      let dy = 0;
      if (r.bottom > maxBottom) dy = maxBottom - r.bottom;
      if (r.top + dy < minTop) dy = minTop - r.top;
      // Taller than the box: pinned to the top, for the same reason the inline axis pins to the start.
      if (r.height > maxBottom - minTop) dy = minTop - r.top;
      el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
      // THE FLIP IS MEASURED FROM THE SWATCH, NOT FROM THE PANEL.
      //
      // Asking "does the panel's current top leave room below it" is a question whose answer changes
      // the moment the flip happens: once the panel is above, its top is high, room below looks
      // enormous, and the next pass flips it back. Measured in the running reader, that oscillation
      // settled on "below" every time and the panel stayed off the bottom of the window by up to
      // 86px. The swatch does not move when the panel flips, so anchoring to it is stable.
      const anchor = wrap.current?.getBoundingClientRect();
      if (anchor) {
        const roomBelow = box.bottom - PANEL_EDGE - anchor.bottom - GAP;
        const roomAbove = anchor.top - GAP - (box.top + PANEL_EDGE);
        // Prefer below, as the design does; flip only when below will not hold it and above will.
        // When NEITHER holds it the panel stays where the design puts it and the slide above keeps it
        // on screen — one decision each, rather than a flip that has to mean two things.
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
    // `above` IS A DEPENDENCY, and that is what makes the two corrections agree. The flip is React
    // state, so it moves the panel on a later render than the one that measured it — leaving the
    // slide computed for the side the panel is no longer on. Re-running settles it in one more pass,
    // and it cannot oscillate: the flip is decided from the SWATCH, which does not move when the
    // panel flips, so the second pass computes the same answer and React bails out.
  }, [open, above]);

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
