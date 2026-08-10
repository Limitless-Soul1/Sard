// DIAGNOSTIC INSTRUMENTATION — throwaway branch. Never merged, never shipped.
//
// A log line says what the code did. A snapshot says what the SCREEN is. The reader is blank on one
// machine and correct in CI, so the difference is in geometry, style or stacking — none of which a
// lifecycle trace can see. This records all three at each stage, for the elements that matter.
//
// Why not pixel screenshots: a picture shows THAT it is blank, which is already known. What is
// missing is WHY, and "zero height", "opacity 0", "off-viewport" and "covered by a sibling" all look
// identical in a picture and are four different bugs.
import { trace } from "./trace";

/** The computed properties that can make a correct DOM invisible. */
const PROPS = [
  "display",
  "visibility",
  "opacity",
  "position",
  "zIndex",
  "overflow",
  "background-color",
  "color",
  "width",
  "height",
  "transform",
  "filter",
  "clip-path",
  "contain",
  "isolation",
] as const;

function describe(el: Element | null): unknown {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const style: Record<string, string> = {};
  for (const p of PROPS) style[p] = cs.getPropertyValue(p);
  return {
    tag: el.tagName.toLowerCase(),
    cls: (el.className || "").toString().slice(0, 60),
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    // Off-viewport is a different bug from zero-size, and both are different from hidden.
    inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.top < innerHeight && r.left < innerWidth,
    scroll: { w: (el as HTMLElement).scrollWidth, h: (el as HTMLElement).scrollHeight },
    children: el.childElementCount,
    style,
  };
}

/**
 * What is actually on top at the centre of an element.
 *
 * "Rendered but covered" is invisible to every geometry check — the box is right, the styles are
 * right, and something else is painted over it.
 */
function topmostAt(el: Element | null): string {
  if (!el) return "no element";
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return "zero-size";
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return "nothing";
  const owns = el.contains(hit) || hit === el;
  return `${hit.tagName.toLowerCase()}.${(hit.className || "").toString().slice(0, 40)}${owns ? " (self)" : " (COVERING)"}`;
}

export function snapshot(label: string): void {
  const stage = document.querySelector(".page-host");
  const frame = stage?.querySelector("iframe") ?? null;
  trace(`SNAPSHOT ${label}`, {
    window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    readerRoot: describe(document.querySelector(".reader-root")),
    pageSheet: describe(document.querySelector(".page-sheet")),
    pageHost: describe(stage),
    hostFrame: describe(frame),
    foliateView: describe(document.querySelector("foliate-view")),
    topmostOverPageHost: topmostAt(stage),
    topmostOverFrame: topmostAt(frame),
    // A reader that rendered has text somewhere; one that did not has none.
    readerTextLen: (document.querySelector(".reader-root")?.textContent ?? "").trim().length,
  });
}

/** Fonts: which faces the document believes it has, and whether they finished loading. */
export function snapshotFonts(label: string): void {
  const families = new Set<string>();
  document.fonts.forEach((f) => families.add(`${f.family}:${f.status}`));
  trace(`FONTS    ${label}`, {
    status: document.fonts.status,
    count: document.fonts.size,
    families: [...families].slice(0, 24),
    uiFont: getComputedStyle(document.documentElement).getPropertyValue("--ui-font").trim(),
    checkArabic: document.fonts.check('16px "SardUIArabic"', "رفّ"),
    checkLatin: document.fonts.check('16px "SardUILatin"', "A"),
  });
}

/**
 * The first frame the browser actually paints after a stage.
 *
 * Two nested rAFs: the first runs before the upcoming paint, the second after it, so the timestamp
 * is a real paint rather than a scheduling callback.
 */
export function afterPaint(label: string): void {
  const t = performance.now();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      trace(`PAINT    ${label} +${Math.round(performance.now() - t)}ms`);
      snapshot(`after-paint:${label}`);
    }),
  );
}
