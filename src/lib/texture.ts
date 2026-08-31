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
import { worstDeskScrim } from "./background";
import type { TextureStep } from "../features/profiles/model/profile";

/** The most translucent of the eight chrome surfaces. The mapping is anchored to it. */
export const LOWEST_SURFACE = 0.9;

/** AA for body text. The same floor the rest of the palette work is measured against. */
const AA = 4.5;

/**
 * How far a surface travels from its OWN value down toward the legibility floor.
 *
 * WHY THIS REPLACED A SCALE. A single multiplier cannot keep three steps apart, because the amount of
 * room a surface has depends on where it starts. The library sidebar over a picture starts at 85% and
 * the floor is ~78–80%: multiplying 85% by the glass factor lands under the floor, a `max()` catches
 * it, and Light and Glass both come out AT the floor — measured in the release as 80% and 80%,
 * pixel-identical. The user could not tell the two apart because they were not different.
 *
 * Anchoring to the floor instead makes the distance explicit: every step lands at
 * `floor + (base − floor) × k`, which is never below the floor and never collapses while `base` is
 * above it. `opaque` is k=1 — the surface's own value, so a reader who never touches texture renders
 * byte-identically to a build without the feature. `glass` keeps a small k rather than 0 so the eight
 * chrome surfaces stay distinguishable from each other, which is what the original mapping was for.
 */
export function stepK(step: TextureStep): number {
  return step === "opaque" ? 1 : step === "light" ? 0.3 : 0;
}

/**
 * The frost a thinned surface puts on whatever shows through it, in px.
 *
 * Alpha alone cannot carry this. Over a picture the sidebar has ~6 points of alpha between its own
 * value and the floor, and six points is not a difference anyone can name. Frost is the other half of
 * what "glass" means, it costs no contrast — blurring moves the ground toward its own mean, never
 * toward an extreme — and it is the one cue that reads instantly at every step.
 */
export function stepBlur(step: TextureStep): number {
  return step === "opaque" ? 0 : step === "light" ? 14 : 40;
}

/**
 * WHY ALPHA AND BLUR ARE NOT ENOUGH, AND WHAT ELSE THE BACKDROP CAN SAY.
 *
 * Measured on the configuration the reader actually has: chrome `#010101` — near black — over a dark
 * photograph. Near-black composited at 86% and at 71% over a dark ground both resolve to near black.
 * Fourteen points of alpha is a real difference that the eye cannot find, and blur only speaks where
 * the picture behind has structure to lose.
 *
 * Saturation and brightness act on the BACKDROP, so they change what the panel is made of rather than
 * how much of it there is: Glass reads as light coming through frosted material, Light as a thin
 * veil, Opaque as no material at all. Neither costs contrast against the measured floor, because
 * `minChromeAlpha` already searches the worst case against PURE WHITE — brightening a real image can
 * only move its ground toward that extreme, never past it.
 */
export function stepSat(step: TextureStep): number {
  return step === "opaque" ? 1 : step === "light" ? 1.3 : 1.9;
}

/**
 * THESE NUMBERS WERE TUNED AGAINST A MEASUREMENT, not chosen.
 *
 * The panel is sampled as rendered pixels and converted to CIE L*, which is perceptually uniform;
 * adjacent steps must differ by at least 4 L*, roughly where a difference stops needing to be
 * pointed out. The first attempt (1.08 / 1.35) measured dL* 1.68 and 3.17 — below that, and the
 * reader's report of "still too similar" was exactly right.
 *
 * Brightness is the lever that works here because the constraint is the BACKDROP: over a dark
 * photograph, 14 points of near-black alpha changes almost nothing, while lifting what shows through
 * changes it a great deal. It is safe against the contrast floor by construction — `minChromeAlpha`
 * already solves for a PURE WHITE backdrop, and brightening a real image cannot pass that.
 */
export function stepBright(step: TextureStep): number {
  return step === "opaque" ? 1 : step === "light" ? 2.0 : 3.6;
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
 *     effectiveAlpha = surfaceAlpha(step, LOWEST_SURFACE, minChromeAlpha(worstDeskScrim(), theme))
 *
 * Runtime-derived on every application. Never stored.
 */
export function effectiveTextureAlpha(
  step: TextureStep,
  theme: { chromeBg: string; text: string },
  scrim: number = worstDeskScrim(),
): number {
  return surfaceAlpha(step, LOWEST_SURFACE, minChromeAlpha(scrim, theme));
}

/**
 * THE ONE ANSWER both the application and the editor's preview render from.
 *
 * `base` is the surface's own alpha with no texture applied; `floor` is the measured minimum for the
 * live theme and scrim. Every surface on both sides of the editor goes through this, so a preview can
 * no longer promise a panel the application will not paint.
 */
export function surfaceAlpha(step: TextureStep, base: number, floor: number): number {
  const f = Math.min(base, floor);
  return f + (base - f) * stepK(step);
}

/**
 * Write what every textured surface reads: how far to travel, the floor to stop at, and the frost.
 *
 * `opaque` removes all three rather than writing neutral values — absent is how "unchanged" is
 * spelled, and the CSS defaults (`--ui-k: 1`, `--ui-floor: 0%`, no blur) reduce the formula back to
 * the surface's own value exactly.
 */
export function applyTexture(
  step: TextureStep,
  theme: { chromeBg: string; text: string },
  scrim: number = worstDeskScrim(),
): void {
  const root = document.documentElement;
  // `opaque` still writes, because "the surface's own value" is now the FULL panel rather than the
  // background feature's 85%, and that is the whole point of the step. It writes k=1 and no frost,
  // so every surface lands on its own base exactly.
  // THE PANEL'S BASE, so that OPAQUE MEANS OPAQUE.
  //
  // This is why the three steps looked alike. With a picture set, the sidebar's own base is 85% —
  // the background feature's choice, made before any texture control existed — so EVERY step showed
  // the picture through the panel and the three differed only in how much. Nothing in that range
  // reads as "opaque". Once a profile governs the surface, texture owns it: the base is the full
  // panel, `opaque` renders it solid and hides the desk entirely, and `glass` goes to the measured
  // floor. Solid → faintly showing → clearly showing and frosted is a difference anyone can name.
  //
  // The fallback in the stylesheet is still `--bg-lib-sidebar`, so a tree with no profile applied
  // renders exactly as it always did.
  root.style.setProperty("--ui-base", "100%");
  root.style.setProperty("--ui-k", stepK(step).toFixed(3));
  root.style.setProperty("--ui-floor", `${(minChromeAlpha(scrim, theme) * 100).toFixed(2)}%`);
  root.style.setProperty("--ui-frost", `${stepBlur(step)}px`);
  root.style.setProperty("--ui-sat", stepSat(step).toFixed(2));
  root.style.setProperty("--ui-bright", stepBright(step).toFixed(2));
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
