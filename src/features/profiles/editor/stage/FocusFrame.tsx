// The hairline that names what the open chapter governs.
//
// IT MEASURES ITS TARGET RATHER THAN TRUSTING A NUMBER. The design states each region as a static
// inset — `56px 27% 46% 27%` and so on — which is exact for the one drawing it was measured on and
// wrong everywhere else. Transcribed literally it produced three faults at once:
//
//   • IT COULD NOT FOLLOW ANYTHING THAT MOVES. The bookmark is placed by a slider; at a position of
//     0.05 the marks frame covered 0% of the mark it is named after. The page can change width, and
//     the whole composition scales with the window.
//   • IT DID NOT KNOW WHICH FACE WAS ON SCREEN, so a book chapter's frame stayed drawn over the
//     library and a library chapter's over the book — measured in five of the six chapters.
//   • `inset` IS PHYSICAL. The design is RTL-only, so its values anchor to the physical right, which
//     is the inline-end only in Arabic. In English the library's sidebar moves to the left and the
//     frame stayed on the right: the active-profile and texture frames both covered 0% of the thing
//     they name, against 100% and 91.6% in Arabic.
//
// So the region is now read off the live layout. That fixes all three at their source: measured
// bounds already include the direction, the scale and any control the reader has just moved.
//
// EXISTENCE FOLLOWS THE TARGET. No matching element in the stage means no frame at all, and the
// faces are already rendered one at a time — so "only a frame whose object is on screen may be
// visible" holds because of how the thing is built, not because someone remembered a rule.
//
// IT LIVES AT STAGE LEVEL, OUTSIDE THE SCALED COMPOSITION, and is positioned in the stage's own
// pixels. Inside the fit box every measurement would need dividing by the scale factor to get back
// to the box's coordinates, and the hairline itself would be scaled with everything else — a 1px
// border drawn at 1.83x is not a hairline.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import { contrastRatio } from "../../../../lib/contrast";

/**
 * Ink that is legible on the pill, whatever accent the active theme carries.
 *
 * THE DESIGN'S PAIR DOES NOT SURVIVE SIXTEEN THEMES. It sets the label as the app's cream on the
 * accent, which is the right reading on the mock's own paper — but Sard's `--paper-bg` follows the
 * active profile, so on a dark theme it is dark and lands on a dark accent. Measured: 10.57 against
 * one profile's accent and 2.31 against another's, from the same rule. Reporting the first as if it
 * were a property of the design was my error.
 *
 * Choosing the better of black and white is not a preference; it is the one choice that cannot fail.
 * The worst possible ground is a mid grey, where white reaches 4.48 and black 4.69 — so the better of
 * the two always clears 4.5, and every real accent is far from that worst case.
 */
const INK_LIGHT = "#FFF8EC";
const INK_DARK = "#17110C";
const legibleOn = (ground: string): string =>
  contrastRatio(INK_LIGHT, ground) >= contrastRatio(INK_DARK, ground) ? INK_LIGHT : INK_DARK;

/**
 * The breathing room between the object and the hairline around it.
 *
 * The frame has to read as being AROUND the thing it names rather than clipped to its edge — the
 * design's own frames all sit outside their subject. Matched to the frame's 6px corner radius so the
 * corner curves clear of the object instead of cutting across it.
 */
const PAD = 6;

/**
 * Where the label sits against the frame's top edge.
 *
 * The design hangs it 11px ABOVE that edge, so the pill straddles the hairline. A frame whose top is
 * at — or above — the stage's own top has nowhere to hang it, and the stage's clip cuts the pill off.
 * That is not hypothetical: the page is now the full height of the environment, as the reading
 * surface's page is, so `paper`'s frame starts at the top of the stage, `background` frames the
 * composition itself, and `marks` starts ABOVE it because the bookmark overhangs the page edge.
 * Measured before this, at all four window sizes, the label sat 16px above the stage, clipped.
 *
 * So the offset is computed rather than chosen: hang it at the design's 11px whenever there is room,
 * and otherwise slide it down until it clears the stage's CONTROL STRIP — the face switch and the
 * measure, which are drawn above the frame (z-index 4 against 3) and would otherwise cut into the
 * pill. Clearing the strip rather than merely the stage's edge is what makes the narrow window work:
 * at 1280 the stage is 754px wide, the centred controls reach much further across it, and the marks
 * label ran into them by 12px. It also lands every inside-label on the same line, which reads as a
 * decision rather than as each frame finding its own spot.
 *
 * The frame never moves. Its whole job is to sit around its object, and shrinking it to make room for
 * its own label would break the one thing it is for.
 */
const LABEL_OVERHANG = 11;
const LABEL_MARGIN = 8;

interface Box { left: number; top: number; width: number; height: number }

const same = (a: Box | null, b: Box | null): boolean =>
  a === b || (!!a && !!b &&
    Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

export function FocusFrame({
  targets,
  label,
  stage,
}: {
  /** Selectors, within the stage, for the object(s) this chapter governs. Their union is framed. */
  targets: readonly string[];
  label: string | null;
  stage: RefObject<HTMLDivElement | null>;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);
  const [ink, setInk] = useState(INK_LIGHT);
  const inkRef = useRef(INK_LIGHT);
  /** The lowest edge of the stage's control strip, in the stage's own pixels. */
  const [stripBottom, setStripBottom] = useState(0);
  const stripRef = useRef(0);

  // NO DEPENDENCY ARRAY, deliberately. The editor re-renders on every draft change, so this
  // re-measures whenever a control moves the thing being framed — a bookmark slider, a page width,
  // a font. The equality guard below is what keeps that from looping: an unchanged rect sets no
  // state, so the render settles after one pass.
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;

    const measure = (): void => {
      const s = root.getBoundingClientRect();
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, found = false;
      for (const sel of targets) {
        const el = root.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // A collapsed box is not a target: it means the element is present but not laid out.
        if (r.width === 0 && r.height === 0) continue;
        found = true;
        x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
        x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
      }
      const next: Box | null = found
        ? { left: x1 - s.left - PAD, top: y1 - s.top - PAD, width: x2 - x1 + PAD * 2, height: y2 - y1 + PAD * 2 }
        : null;
      if (!same(next, boxRef.current)) {
        boxRef.current = next;
        setBox(next);
      }
      // The strip is a sibling of the composition, at a constant size, so its depth in the stage
      // changes with the window rather than with the picture — it has to be read, not assumed.
      const strip = root.querySelector(".pf-stage-segbar");
      const depth = strip ? strip.getBoundingClientRect().bottom - s.top : 0;
      if (Math.abs(depth - stripRef.current) >= 0.5) {
        stripRef.current = depth;
        setStripBottom(depth);
      }
      // The pill is painted in the ACTIVE theme's accent, which changes with the profile the reader
      // is wearing, so the ink that reads on it has to be chosen against that live value.
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      if (accent) {
        const want = legibleOn(accent);
        if (want !== inkRef.current) {
          inkRef.current = want;
          setInk(want);
        }
      }
    };

    measure();
    // The window can resize the stage without the editor re-rendering at all.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  });

  if (!box) return null;
  // Negative = hanging above the frame's edge, as drawn; clamped so the pill always clears the
  // control strip. Both values are already in the stage's own pixels, so this is the calculation.
  const labelTop = Math.max(-LABEL_OVERHANG, stripBottom + LABEL_MARGIN - box.top);
  return (
    <div
      className="pf-focus"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden
    >
      {label && (
        <span className="pf-focus-label" style={{ color: ink, insetBlockStart: labelTop }}>
          {label}
        </span>
      )}
    </div>
  );
}
