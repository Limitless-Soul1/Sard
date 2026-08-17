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

/**
 * The breathing room between the object and the hairline around it.
 *
 * The frame has to read as being AROUND the thing it names rather than clipped to its edge — the
 * design's own frames all sit outside their subject. Matched to the frame's 6px corner radius so the
 * corner curves clear of the object instead of cutting across it.
 */
const PAD = 6;

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
    };

    measure();
    // The window can resize the stage without the editor re-rendering at all.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  });

  if (!box) return null;
  return (
    <div
      className="pf-focus"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden
    >
      {label && <span className="pf-focus-label">{label}</span>}
    </div>
  );
}
