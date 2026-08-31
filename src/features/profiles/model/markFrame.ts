/**
 * ONE FRAMING, EVERY SURFACE THAT DRAWS A MARK.
 *
 * A profile's picture is painted in six places — the editor's header seal, the identity page's own
 * preview, the card foot, the editor stage's library chip, the switcher in the library foot, and the
 * import preview — and before this they did not agree: three used `50% 34%`, the rest `50% 50%`, and
 * the switcher's box is 16:10 while every other is square. So the framing a reader chose in the
 * editor was not the framing the cards showed them. Measured, one image, one profile:
 *
 *     editor mark   50% 34% / cover      76×76
 *     stage chip    50% 34% / cover      22×22
 *     card seal     50% 50% / cover      30×30
 *     switcher      50% 50% / cover      34×21
 *
 * This is the single answer. Every one of those surfaces asks it, so they cannot drift again.
 *
 * HOW IT WORKS. `cover` fits the picture to the box and crops the rest; `background-position` picks
 * which part survives that crop, and a transform about the SAME point magnifies around it. The
 * consequence is the one a reader expects: the pixel under the focal point does not move when the
 * scale changes — everything else grows away from it.
 *
 * AT THE DEFAULT IT EMITS NO TRANSFORM AT ALL. `{ 50, 50, 1 }` is `background-position: 50% 50%`
 * over `cover`, which is exactly what these surfaces painted before framing existed, so a profile
 * that has never been framed is byte-identical on screen.
 *
 * THE BOX MUST CLIP. At any scale above 1 the layer is deliberately larger than its box, so the
 * element that owns the mark carries `overflow: hidden`. Every one of the six already did except
 * `.pf-seal`, which had never needed to.
 */
import type { CSSProperties } from "react";
import { ICON_FRAME_DEFAULT, type ProfileIcon } from "./profile";

/** The style for the LAYER inside a mark's clipping box. `url()` stays with the caller. */
export function markFrame(icon: ProfileIcon | undefined | null): CSSProperties {
  const i = icon ?? ICON_FRAME_DEFAULT;
  const at = `${i.focalX}% ${i.focalY}%`;
  return {
    backgroundSize: "cover",
    backgroundPosition: at,
    ...(i.scale === 1 ? {} : { transform: `scale(${i.scale})`, transformOrigin: at }),
  };
}

/**
 * How far the picture can travel inside a box, in device pixels, per axis.
 *
 * `cover` already overflows on one axis whenever the aspect ratios differ; scale adds to both. The
 * pan needs this to convert a pointer movement into a change in focal percent — without it a drag
 * would move the picture by an amount that depended on the picture, which is how a crop control
 * comes to feel slippery on one image and stuck on another.
 *
 * Returns zeroes when there is nothing to move: a square picture in a square box at scale 1 CANNOT
 * pan, and saying so honestly is what lets the interface disable the gesture rather than swallow it.
 */
export function panRange(
  box: { w: number; h: number },
  pic: { w: number; h: number },
  scale: number,
): { x: number; y: number } {
  if (!(box.w > 0 && box.h > 0 && pic.w > 0 && pic.h > 0)) return { x: 0, y: 0 };
  const cover = Math.max(box.w / pic.w, box.h / pic.h) * scale;
  return {
    x: Math.max(0, pic.w * cover - box.w),
    y: Math.max(0, pic.h * cover - box.h),
  };
}
