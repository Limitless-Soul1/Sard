// WHAT THE DOCUMENT LOOKS LIKE — the ground and the free elements, drawn inside the card itself.
//
// This renders INSIDE the exported node, which is the point: there is one composition and one
// renderer, so what the user drags is what rasterises. Nothing in here knows it is being edited —
// selection outlines and handles live in a sibling overlay outside the card, so they cannot reach
// the PNG.
//
// ## Direction is not handled here, because it is handled by the coordinate system
//
// A rect's `x` is the INLINE-START edge, so it maps to `inset-inline-start` and CSS resolves it
// against the card's own `dir`. An Arabic composition therefore reads correctly when the same
// document meets an English one, with no mirroring code. The one exception is an element that asked
// not to mirror — a signature, a logo — which pins to a physical edge instead.
//
// ## Scale is not handled here either
//
// Every length in the document is a fraction of the canvas, so it is emitted as a percentage or as
// `fraction × cardWidth`. The card renders at half its export size and rasterises at pixelRatio 2;
// because nothing here is an absolute pixel, the preview and the export agree by construction.

import { useLayoutEffect, useRef } from "react";

import { isImage, isText } from "./elements";
import { backingStyle, strokeStyle, type BackingStyle, type StrokeStyle } from "./legibility";
import type { CardElement, Composition, Ground, ImageElement, TextElement } from "./composition";

/** Turn a managed image id into something the webview can load, or null if it is not resolvable. */
export type AssetUrl = (assetId: string) => string | null;

const pct = (n: number): string => `${n * 100}%`;

function placementStyle(el: CardElement): React.CSSProperties {
  if (el.kind === "unknown") return { display: "none" };
  const { rect, rotate, mirror } = el.placement;
  const base: React.CSSProperties = {
    position: "absolute",
    insetBlockStart: pct(rect.y),
    inlineSize: pct(rect.w),
    blockSize: pct(rect.h),
  };
  // `mirror: false` opts an element out of the logical axis and pins it physically — the rare case
  // where a mark should stay in the same corner whichever way the text runs.
  if (mirror === false) base.left = pct(rect.x);
  else base.insetInlineStart = pct(rect.x);
  if (rotate) {
    base.transform = `rotate(${rotate}deg)`;
    base.transformOrigin = "center";
  }
  return base;
}

/**
 * TEXT THAT FILLS ITS BOX WHEN IT IS ASKED TO.
 *
 * `size: null` means "measure it" — the guarantee the original card made and the one thing in the old
 * implementation most worth keeping: a longer passage shrinks rather than being trimmed. The search is
 * the same shape as the card's own: bisect the font size until the content just fits the box.
 *
 * It is imperative rather than a style prop for the reason the original records — so it survives a
 * theme re-render, which would otherwise reinstate the JSX value and undo the fit.
 */
function FitText({
  text, style, cardW, className, backing, stroke, onNeedsRoom,
}: {
  text: string;
  style: TextElement["style"];
  cardW: number;
  className?: string;
  /** The readability treatment, already resolved to CSS — see `legibility.ts`. */
  backing?: BackingStyle;
  /**
   * The line around the letters, already resolved. Paint only, like the treatment: it cannot move a
   * line break, so the bisect above never re-runs for it.
   */
  stroke?: StrokeStyle;
  /**
   * How much room this text needs at the size it has been given, as a MULTIPLE of the box it was
   * given, whenever that is more than one. A ratio rather than a pixel count so the caller never
   * has to know the scale the card happens to be drawn at. Only meaningful when the size is the
   * USER'S: an auto-fitted text answers the question by shrinking instead.
   */
  onNeedsRoom?: (ratio: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const auto = style.size === null || style.size === undefined;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.parentElement;
    if (!box) return;
    if (!auto) {
      el.style.fontSize = `${(style.size as number) * cardW}px`;
      // AND THEN SAY WHETHER IT FITS. The size is the user's and is not up for negotiation here, so
      // the only honest answer to a box that is too small is how much room the words actually need.
      // Someone above decides what to do about it; what must not happen is the box quietly cropping
      // the sentence, which is what an `overflow: hidden` parent does on its own.
      if (onNeedsRoom && box.clientHeight > 0 && el.scrollHeight > box.clientHeight + 1) {
        onNeedsRoom(el.scrollHeight / box.clientHeight);
      }
      return;
    }
    // Bisect between a floor small enough for a very long passage and a ceiling that would fill a
    // nearly empty card. Twelve steps resolve this to well under a pixel at card scale.
    let lo = 0.012 * cardW;
    let hi = 0.16 * cardW;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      const fits = el.scrollHeight <= box.clientHeight + 0.5 && el.scrollWidth <= box.clientWidth + 0.5;
      if (fits) lo = mid;
      else hi = mid;
    }
    el.style.fontSize = `${lo}px`;
  }, [text, auto, style.size, style.lineHeight, style.letterSpacing, style.weight, style.family, cardW,
      // Only the two that can change the BOX are dependencies. A treatment's colours, radii and
      // shadows cannot move a line, so re-running the fit for them would be work with no answer.
      backing?.inlineSize, backing?.inner, onNeedsRoom]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        margin: 0,
        inlineSize: "100%",
        fontFamily: style.family ?? undefined,
        fontWeight: style.weight ?? 400,
        lineHeight: style.lineHeight ?? 1.6,
        letterSpacing: style.letterSpacing ? `${style.letterSpacing}em` : undefined,
        textAlign: style.align ?? "start",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        // LAST, and deliberately layout-NEUTRAL: a treatment paints (background, radius, shadows) and
        // never reserves space, so the bisect above measures the same box whatever is applied. See the
        // rule at the top of `legibility.ts`.
        ...(backing ? { ...backing, inner: undefined } : null),
        // The stroke is paint too — `paint-order` keeps the letterform the typeface drew and shows
        // only the half of the line that falls outside it.
        ...(stroke ?? null),
      }}
      // The words keep their own direction while the BLOCK keeps the card's, so an Arabic line inside
      // an English card reads right-to-left without dragging its box to the other side.
      dir={style.dir && style.dir !== "auto" ? style.dir : "auto"}
    >
      {/* A PER-LINE treatment needs an INLINE box: `box-decoration-break: clone` repeats the padding
          and the corners on every line, which is what makes the plate follow the ragged edge of the
          setting instead of boxing the whole block. Without a treatment there is no span at all, so
          nothing about an ordinary text changes. */}
      {backing?.inner ? <span style={backing.inner}>{text}</span> : text}
    </div>
  );
}

function TextLayer({ el, cardW, ink, paper, onNeedsRoom }: {
  el: TextElement; cardW: number; ink: string; paper: string;
  onNeedsRoom?: (id: string, needed: number) => void;
}) {
  const justify =
    el.style.align === "center" ? "center" : el.style.align === "end" ? "flex-end" : "flex-start";
  // Resolved against THIS element's own ink and the card's paper, so the treatment is made of the
  // card's material and answers the colour the words are actually drawn in.
  const backing = backingStyle({
    mode: el.style.legibility ?? "none",
    strength: el.style.legibilityStrength,
    softness: el.style.legibilitySoftness,
    haloWidth: el.style.haloWidth,
    color: el.style.legibilityColor,
    shape: el.style.legibilityShape,
    textColor: el.style.color ?? ink,
    paper,
    align: el.style.align,
  });
  const stroke = strokeStyle({
    width: el.style.strokeWidth,
    color: el.style.strokeColor,
    textColor: el.style.color ?? ink,
    paper,
  });
  return (
    <div
      data-el={el.id}
      style={{
        ...placementStyle(el),
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: justify,
        color: el.style.color ?? ink,
        opacity: el.style.opacity ?? 1,
        overflow: "hidden",
      }}
    >
      <FitText
        text={el.text}
        style={el.style}
        cardW={cardW}
        backing={backing}
        stroke={stroke}
        onNeedsRoom={onNeedsRoom ? (ratio) => onNeedsRoom(el.id, el.placement.rect.h * ratio) : undefined}
      />
    </div>
  );
}

function ImageLayer({ el, url }: { el: ImageElement; url: string | null }) {
  return (
    <div
      data-el={el.id}
      style={{
        ...placementStyle(el),
        opacity: el.opacity ?? 1,
        borderRadius: el.radius ? `${(el.radius ?? 0) * 100}%` : undefined,
        overflow: el.radius ? "hidden" : undefined,
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            inlineSize: "100%",
            blockSize: "100%",
            objectFit: el.fit ?? "contain",
            objectPosition: `${(el.focalX ?? 0.5) * 100}% ${(el.focalY ?? 0.5) * 100}%`,
            // MIRRORED ON THE WAY TO THE SCREEN. A negative scale draws the same decoded picture the
            // other way round: the file is untouched, the flip costs nothing, and it survives the
            // export because the export rasterises this very element.
            ...(el.flipX || el.flipY
              ? { transform: `scale(${el.flipX ? -1 : 1}, ${el.flipY ? -1 : 1})` }
              : null),
            display: "block",
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * THE GROUND, when it is a photograph.
 *
 * Drawn as an `<img>` rather than a CSS background so the export path can find it: the hybrid
 * exporter composites decoded images with `drawImage` instead of base64-inlining them, and it can
 * only do that for images it can enumerate. A CSS `background-image` is invisible to that pass.
 *
 * The scrim is a flat veil in the theme's own paper colour, so a photograph reads as lit by the card
 * rather than pasted behind it — the same treatment the reading desk already gives its picture.
 */
export function GroundLayer({ ground, url, paper }: { ground: Ground; url: string | null; paper: string }) {
  if (ground.kind !== "image" || !url) return null;
  const scrim = ground.scrim ?? 0;
  const scale = ground.scale ?? 1;
  const ox = (ground.offsetX ?? 0) * 100;
  const oy = (ground.offsetY ?? 0) * 100;
  // THE FLIP RIDES ON THE ZOOM, as a sign. A transform list applies to the element from the right, so
  // the scale happens first and the translate afterwards in the parent's own axes — which is why
  // mirroring cannot make a drag run backwards. The percentages resolve against the unscaled box.
  const sx = ground.flipX ? -scale : scale;
  const sy = ground.flipY ? -scale : scale;
  const mirrored = !!(ground.flipX || ground.flipY);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }} aria-hidden>
      {/* THE GROUND IS PLACED, NOT JUST FITTED.
          `object-fit` decides the base size and the focal point decides what the crop keeps; the
          transform on top of that is the composition — where the picture sits and how close it is.
          Translate before scale, in percentages of the IMAGE, so dragging by a fraction of the card
          moves it by that fraction whatever the zoom. The card clips it, which is the crop. */}
      <img
        src={url}
        alt=""
        draggable={false}
        data-card-ground="1"
        style={{
          inlineSize: "100%",
          blockSize: "100%",
          objectFit: ground.fit ?? "cover",
          objectPosition: `${(ground.focalX ?? 0.5) * 100}% ${(ground.focalY ?? 0.5) * 100}%`,
          transform:
            scale !== 1 || ox || oy || mirrored
              ? `translate(${ox}%, ${oy}%) scale(${sx}, ${sy})`
              : undefined,
          transformOrigin: "center",
          opacity: ground.opacity ?? 1,
          filter: ground.blur ? `blur(${ground.blur}px)` : undefined,
          display: "block",
        }}
      />
      {scrim > 0 && (
        <div style={{ position: "absolute", inset: 0, background: paper, opacity: scrim }} />
      )}
    </div>
  );
}

/** The free elements, back to front. Order in the array IS the stacking order. */
export function ElementsLayer({
  comp, cardW, ink, paper, assetUrl, hideId, onNeedsRoom,
}: {
  comp: Composition;
  cardW: number;
  ink: string;
  /** The card's own paper — one of the candidates a readability treatment is made from. */
  paper: string;
  assetUrl: AssetUrl;
  /**
   * Told when a manually sized text needs more room than its box gives it, with the height it
   * needs as a fraction of the card. The editor passes this; the export path does not, because by
   * then the document has already been made to fit.
   */
  onNeedsRoom?: (id: string, needed: number) => void;
  /**
   * The element currently being typed into on the canvas. The editor draws that one itself, in a
   * real text box over the top; drawing it here as well would show every keystroke twice, half a
   * pixel apart.
   */
  hideId?: string | null;
}) {
  if (!comp.elements.length) return null;
  return (
    <div style={{ position: "absolute", inset: 0 }} data-card-elements="1">
      {comp.elements.map((el) => {
        if (el.hidden || el.id === hideId) return null;
        if (isText(el)) return <TextLayer key={el.id} el={el} cardW={cardW} ink={ink} paper={paper} onNeedsRoom={onNeedsRoom} />;
        if (isImage(el)) return <ImageLayer key={el.id} el={el} url={assetUrl(el.assetId)} />;
        return null; // an element from a newer version: kept in the document, drawn as nothing
      })}
    </div>
  );
}
