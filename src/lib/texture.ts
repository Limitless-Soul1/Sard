// INTERFACE TEXTURE — the three named steps, and the clamp that keeps them legible.
//
// WHY THIS IS NOT IN THE PROFILE MODEL. A profile stores a STEP: `opaque`, `light` or `glass`. What
// that step renders as depends on the live desk scrim and the active theme, neither of which is a
// property of the profile — a profile carried to another machine, or opened with a different
// background, must not carry a stale alpha with it. So the step is persisted and the alpha is
// derived here, every time it is applied.
//
// THE FLOOR IS MEASURED, NOT CHOSEN. `--text` on `--chrome-bg` over an image needs alpha 0.800 at the
// worst case (Slate, against a pure-black/pure-white ground — deliberately blur-independent, since
// blurring can only pull the ground toward the image's mean and away from those extremes). The
// design draws `glass` at 0.78, which is below that at the very top of one slider. Rather than
// overrule the designer or ship a value the evidence does not support, the alpha is CLAMPED against
// the live scrim: at any reading visibility up to ~240 the clamp is inert and glass renders at
// exactly the 0.78 that was drawn; above it the alpha lifts by the least amount that clears AA.
//
// THE MAPPING IS FLOOR-ANCHORED, not proportional and not absolute. The eight chrome surfaces sit at
// 90/92/96×5/98 %, and they are deliberately different from each other — a drawer is not a toolbar.
// So the step does not overwrite them: it scales all eight by one factor, chosen so the LOWEST
// surface lands on the target. At `glass` that is 90 → 78, 92 → 79.7, 96 → 83.2, 98 → 84.9: the
// binding surface reaches the drawn floor and the hierarchy above it survives intact.

import { contrast } from "../features/profiles/model/palette";
import { currentDeskScrim } from "./background";
import type { TextureStep } from "../features/profiles/model/profile";

/** The most translucent of the eight chrome surfaces. The mapping is anchored to it. */
export const LOWEST_SURFACE = 0.9;

/** AA for body text. The same floor the rest of the palette work is measured against. */
const AA = 4.5;

/**
 * What the lowest surface should reach at each step, before the clamp.
 *
 * `opaque` is the surface's own value, so the step writes nothing and rendering is byte-identical to
 * a build without this feature. `glass` is the design's 0.78. `light` is the interpolation between
 * them at the step's own position — the design fixes the two ends and says only "three steps", so
 * the middle is placed rather than invented: 0.92 sits (1−0.92)/(1−0.78) of the way down.
 */
export function stepTarget(step: TextureStep): number {
  const alpha = step === "opaque" ? 1 : step === "light" ? 0.92 : 0.78;
  const t = (1 - alpha) / (1 - 0.78); // 0 at opaque, 1 at glass
  return LOWEST_SURFACE + (0.78 - LOWEST_SURFACE) * t;
}

/**
 * The least chrome alpha whose text still clears AA over the desk at this scrim.
 *
 * `scrim` is how much of the theme's own ground is painted over the image: 1 means the image is
 * fully covered and the chrome sits on pure theme colour, 0 means the image shows through
 * completely. The worst case a real image can present is an EXTREME — pure black or pure white — so
 * the search is run against both and the harder one wins. That is what makes the answer independent
 * of which image the reader chose.
 */
export function minChromeAlpha(scrim: number, theme: { chromeBg: string; text: string }): number {
  const s = Math.min(1, Math.max(0, scrim));
  // A chrome surface at alpha `a` over (extreme ⊕ scrim·chromeBg). Composite in sRGB, which is what
  // `color-mix(in srgb, …)` does, so the arithmetic matches what the browser will actually paint.
  const ground = (extreme: number): [number, number, number] => {
    const c = hex(theme.chromeBg);
    return [0, 1, 2].map((i) => extreme * (1 - s) + c[i] * s) as [number, number, number];
  };
  const over = (a: number, g: [number, number, number]): string => {
    const c = hex(theme.chromeBg);
    return rgbHex([0, 1, 2].map((i) => c[i] * a + g[i] * (1 - a)) as [number, number, number]);
  };
  // Both extremes, harder one wins. 0.5 is below every theme's requirement (Ink measures 0.500) and
  // 1.0 is fully opaque and always clears, so the search is bounded on both sides.
  let worst = 0.5;
  for (const extreme of [0, 255]) {
    const g = ground(extreme);
    let need = 1;
    for (let a = 0.5; a <= 1.0001; a += 0.005) {
      if (contrast(theme.text, over(a, g)) >= AA) {
        need = a;
        break;
      }
    }
    worst = Math.max(worst, need);
  }
  return Math.min(1, Math.round(worst * 1000) / 1000);
}

/**
 * The alpha the lowest surface actually renders at:
 *
 *     effectiveAlpha = max(textureStep, minChromeAlpha(currentDeskScrim(), activeTheme))
 *
 * Runtime-derived on every application. Never stored.
 */
export function effectiveTextureAlpha(
  step: TextureStep,
  theme: { chromeBg: string; text: string },
  scrim: number = currentDeskScrim(),
): number {
  return Math.max(stepTarget(step), minChromeAlpha(scrim, theme));
}

/**
 * Write the one variable the eight surfaces read.
 *
 * A SCALE, not an alpha, so each surface keeps its own value and the eight stay distinguishable.
 * `opaque` removes the property entirely rather than writing `1` — absent is how "unchanged" is
 * spelled, and it means a reader who never touches texture has no such declaration in the tree.
 */
export function applyTexture(
  step: TextureStep,
  theme: { chromeBg: string; text: string },
  scrim: number = currentDeskScrim(),
): void {
  const root = document.documentElement;
  if (step === "opaque") {
    root.style.removeProperty("--ui-texture-scale");
    root.removeAttribute("data-ui-texture");
    return;
  }
  const scale = Math.min(1, effectiveTextureAlpha(step, theme, scrim) / LOWEST_SURFACE);
  root.style.setProperty("--ui-texture-scale", scale.toFixed(4));
  root.setAttribute("data-ui-texture", step);
}

// ---- colour helpers, local and small -------------------------------------------------------------

function hex(h: string): [number, number, number] {
  const v = h.replace("#", "");
  const n = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) || 0) as [number, number, number];
}

const rgbHex = (c: [number, number, number]): string =>
  "#" + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
