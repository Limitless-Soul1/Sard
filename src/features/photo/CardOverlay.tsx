// THE EDITOR'S HANDS — selection, dragging and resizing, drawn OVER the card and never inside it.
//
// ## Why this is a sibling of the card rather than part of it
//
// The card node is the node that rasterises. Anything drawn inside it reaches the PNG, so a selection
// outline or a resize handle would be exported. This overlay is a sibling: it is positioned over the
// card and shares its geometry, but the exporter never sees it. That is also why it can be styled for
// clarity rather than for print.
//
// ## Pointer events, not HTML5 drag — and capture on the overlay, not the handle
//
// Tauri's webview has the OS drag/drop handler enabled because the Library needs it for file import,
// and on Windows that handler SWALLOWS native HTML5 drag events: `draggable` + `onDragStart` never
// fire from a real mouse. They fire for synthetic events, which is how a previous feature "passed"
// its tests while being broken. So every gesture here is pointer events with `setPointerCapture`.
//
// The capture is taken on the OVERLAY — a stable element — rather than on the handle being dragged.
// A handle moves out from under the cursor as the element resizes, and a capture held on the handle
// then misses its own `pointerup`, leaving the drag stuck on.
//
// ## Direction lives exactly here
//
// The document stores `x` as the INLINE-START edge. Physical pixels are what a pointer speaks, so
// this file is the one place that converts between them — once, in `toPhysical` and `toLogicalDelta`.
// Everything upstream stays direction-free.

import { useLayoutEffect, useRef, useState } from "react";

import { isText, MIN_SIZE, type ResizeGrip } from "./elements";
import type { CardElement, Composition, PresetPart, Rect, TextElement } from "./composition";

/**
 * THE INLINE EDITOR — a text box wearing the element's own type.
 *
 * Its own component because it needs a layout effect, and the elements are drawn in a `map`. Two
 * things it must get right or editing in place is a lie: the FACE (a textarea's default is the UA
 * monospace, which replaced a quote set in the book's face with a typewriter the moment it was
 * double-clicked) and the VERTICAL POSITION (the card centres text in its box; a textarea starts at
 * the top, so the words jumped). The face is passed in; the centring is measured, because the number
 * of lines is not known until the text has wrapped.
 */
function InlineText({
  el, width, family, autoFrac, onText, onDone,
}: {
  el: TextElement;
  /** The card's drawn width, so a fraction of the card becomes a size on screen. */
  width: number;
  /** What the card would set this in if the element names no face of its own. */
  family: string;
  /** And the size it is drawn at when it fits itself, which the document does not record. */
  autoFrac: number;
  onText: (text: string) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.paddingBlockStart = "0px";
    // `scrollHeight` with no padding is the height the wrapped text actually needs.
    const pad = Math.max(0, (ta.clientHeight - ta.scrollHeight) / 2);
    ta.style.paddingBlockStart = pad + "px";
  }, [el.text, el.style.size, el.style.lineHeight, el.style.family, autoFrac, width]);
  return (
    <textarea
      ref={ref}
      className="pc-ov-write"
      autoFocus
      value={el.text}
      onChange={(e) => onText(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
      dir={el.style.dir && el.style.dir !== "auto" ? el.style.dir : "auto"}
      style={{
        fontFamily: el.style.family ?? family,
        fontWeight: el.style.weight ?? 400,
        // The document speaks in fractions of the card; the overlay is drawn at the preview's
        // width, so one multiplication puts the type at the size it has on screen.
        fontSize: (el.style.size ?? autoFrac) * width,
        lineHeight: el.style.lineHeight ?? 1.6,
        letterSpacing: el.style.letterSpacing ? `${el.style.letterSpacing}em` : undefined,
        textAlign: el.style.align ?? "start",
        color: el.style.color ?? undefined,
        opacity: el.style.opacity ?? 1,
      }}
    />
  );
}

type Gesture =
  | { kind: "move"; id: string; startX: number; startY: number }
  | { kind: "resize"; id: string; grip: ResizeGrip; startX: number; startY: number }
  /** The GROUND being pushed about. It has no id — there is only ever one of it. */
  | { kind: "ground"; id: string; startX: number; startY: number }
  /** The MARK. It carries where it started, because its position is absolute rather than a delta. */
  | { kind: "brand"; id: string; startX: number; startY: number; from: { x: number; y: number } };

/** Grips, in logical terms. The overlay places them physically; the document never sees a side. */
const GRIPS: { grip: ResizeGrip; ix: number; iy: number; cursorRtl: string; cursorLtr: string }[] = [
  { grip: "is-bs", ix: 0, iy: 0, cursorRtl: "nesw-resize", cursorLtr: "nwse-resize" },
  { grip: "ie-bs", ix: 1, iy: 0, cursorRtl: "nwse-resize", cursorLtr: "nesw-resize" },
  { grip: "is-be", ix: 0, iy: 1, cursorRtl: "nwse-resize", cursorLtr: "nesw-resize" },
  { grip: "ie-be", ix: 1, iy: 1, cursorRtl: "nesw-resize", cursorLtr: "nwse-resize" },
  { grip: "bs", ix: 0.5, iy: 0, cursorRtl: "ns-resize", cursorLtr: "ns-resize" },
  { grip: "be", ix: 0.5, iy: 1, cursorRtl: "ns-resize", cursorLtr: "ns-resize" },
  { grip: "is", ix: 0, iy: 0.5, cursorRtl: "ew-resize", cursorLtr: "ew-resize" },
  { grip: "ie", ix: 1, iy: 0.5, cursorRtl: "ew-resize", cursorLtr: "ew-resize" },
];

export function CardOverlay({
  comp, width, height, rtl, selectedId, onSelect, onMove, onResize, onCommit, parts, onLiftPart,
  editingId, onBeginEdit, onEditText, onEndEdit, family, autoFrac, ground, brand,
}: {
  comp: Composition;
  /** The drawn size of the card on screen, in CSS pixels — the overlay matches it exactly. */
  width: number;
  height: number;
  rtl: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onResize: (id: string, grip: ResizeGrip, dx: number, dy: number) => void;
  /** Called once when a gesture ends, so the caller can push one undo entry per drag, not per pixel. */
  onCommit: () => void;
  /**
   * Parts the PRESET is drawing that have not been lifted yet — the quote, the title, the credit.
   * They are on the card already, so they must be clickable: pressing one hands back a real element
   * in the same place. Without this the only way to edit the quote was to ask a menu to create one,
   * which is the wrong way round.
   */
  parts?: { part: PresetPart; rect: Rect }[];
  onLiftPart?: (part: PresetPart) => void;
  /**
   * TYPING ON THE CARD ITSELF.
   *
   * One click selects; two open the words where they are. A text box is placed over the element and
   * given the element's own type at the preview's scale, so what is being typed sits at the size and
   * on the line it will actually occupy. The card stops drawing that element while this is open.
   */
  editingId?: string | null;
  onBeginEdit?: (id: string) => void;
  onEditText?: (text: string) => void;
  onEndEdit?: () => void;
  /** The face the card uses when an element names none — so the editor is not a typewriter. */
  family?: string;
  /** What an auto-fitted quote is drawn at. Without it the editor would type at a default size. */
  autoFrac?: number;
  /**
   * MOVING AND ZOOMING THE GROUND BY HAND.
   *
   * Present only while the background is the thing being worked on. A photograph is placed by eye —
   * you drag it until the face is where you want it — and a pair of number fields is the precision
   * afterwards, not the way in. Both deltas arrive as fractions of the card, like everything else.
   */
  ground?: { onMove: (dx: number, dy: number) => void; onZoom: (factor: number) => void };
  /**
   * THE SARD MARK, WHICH IS NOW SOMETHING THE USER PLACES.
   *
   * Given as a box to draw a handle over rather than as an element, because it is not one: it has no
   * words, no type and no stacking order, and letting it into the element list would make it a
   * sticker that happens to look like the wordmark. It is the card's signature, moved by hand.
   */
  brand?: { box: () => Rect | null; move: (dx: number, dy: number, from: { x: number; y: number }) => void };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /**
   * THE SECOND PRESS, COUNTED BY HAND.
   *
   * `onDoubleClick` is a MOUSE event, and `begin` calls `preventDefault()` on the pointerdown that
   * starts a drag — which suppresses the entire compatibility mouse sequence behind it, dblclick
   * included. Measured: double-clicking a text element opened nothing at all. So the interval is
   * timed here, on the pointer events that do arrive.
   */
  const lastPress = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const [active, setActive] = useState<string | null>(null);

  /** A logical rect → the physical box to draw, which is the only place RTL is considered. */
  const toPhysical = (el: CardElement) => {
    if (el.kind === "unknown") return null;
    const r = el.placement.rect;
    const physicalStart = el.placement.mirror === false || !rtl ? r.x : 1 - r.x - r.w;
    return { left: physicalStart * width, top: r.y * height, w: r.w * width, h: r.h * height };
  };

  /** A pointer delta → a document delta. Inline runs the other way when the card does. */
  const toLogicalDelta = (dxPx: number, dyPx: number, el: CardElement) => {
    const physical = el.kind !== "unknown" && el.placement.mirror === false;
    const sign = rtl && !physical ? -1 : 1;
    return { dx: (sign * dxPx) / width, dy: dyPx / height };
  };

  const release = (pointerId: number) => {
    const root = rootRef.current;
    if (root && root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
  };

  const begin = (e: React.PointerEvent, g: Gesture) => {
    e.preventDefault();
    e.stopPropagation();
    // A capture left over from a previous gesture would retarget this press to the overlay root,
    // where it reads as "clicked bare canvas" and clears the selection instead of starting a drag.
    // Observed once: two gestures back to back, and the second silently did nothing.
    release(e.pointerId);
    gesture.current = g;
    setActive(g.id);
    onSelect(g.id);
    rootRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "brand") {
      brand?.move((e.clientX - g.startX) / width, (e.clientY - g.startY) / height, g.from);
      return;
    }
    if (g.kind === "ground") {
      ground?.onMove((e.clientX - g.startX) / width, (e.clientY - g.startY) / height);
      g.startX = e.clientX;
      g.startY = e.clientY;
      return;
    }
    const el = comp.elements.find((x) => x.id === g.id);
    if (!el) return;
    const { dx, dy } = toLogicalDelta(e.clientX - g.startX, e.clientY - g.startY, el);
    if (g.kind === "move") onMove(g.id, dx, dy);
    else if (g.kind === "resize") onResize(g.id, g.grip, dx, dy);
    // The gesture is incremental: each move reports the delta since the LAST event, so the caller can
    // apply it without knowing where the drag began.
    g.startX = e.clientX;
    g.startY = e.clientY;
  };

  const end = (e: React.PointerEvent) => {
    if (!gesture.current) return;
    gesture.current = null;
    setActive(null);
    release(e.pointerId);
    onCommit();
  };

  return (
    <div
      ref={rootRef}
      className={`pc-ov${ground ? " ground" : ""}`}
      style={{ width, height }}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // If the capture is lost for any reason the gesture must end with it, or the next press starts
      // mid-drag and the element leaps.
      onLostPointerCapture={() => {
        gesture.current = null;
        setActive(null);
      }}
      // A press on bare canvas clears the selection, which is how the panel returns to card-level
      // properties without a "deselect" control — unless the GROUND is what is being worked on, in
      // which case the whole canvas is the thing you are dragging.
      onPointerDown={(e) => {
        if (ground) {
          e.preventDefault();
          // AND THE PRESS STOPS HERE. The workspace behind this treats a press on itself as "nothing
          // is selected any more", which includes leaving background mode — so the first press of a
          // ground drag was ending the very mode that made it a ground drag. Measured: the picture
          // never moved, and the panel had closed by the time anything asked why.
          e.stopPropagation();
          release(e.pointerId);
          gesture.current = { kind: "ground", id: "", startX: e.clientX, startY: e.clientY };
          rootRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        onSelect(null);
      }}
      onWheel={(e) => {
        if (!ground) return;
        e.preventDefault();
        // A notch up is about 10% closer. Sign follows the platform's scroll direction.
        ground.onZoom(Math.exp(-e.deltaY * 0.0016));
      }}
    >
      {/* THE MARK'S HANDLE. Drawn where the mark actually is, so it follows whatever the card did
          with it, and only while the mark is on the card at all. */}
      {(() => {
        const b = brand?.box();
        if (!b || ground) return null;
        return (
          <div
            className="pc-ov-brand"
            style={{ left: b.x * width, top: b.y * height, width: b.w * width, height: b.h * height }}
            title="Sard"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              release(e.pointerId);
              gesture.current = { kind: "brand", id: "", startX: e.clientX, startY: e.clientY, from: { x: b.x, y: b.y } };
              rootRef.current?.setPointerCapture(e.pointerId);
            }}
          />
        );
      })()}

      {/* The preset's own parts, still drawn by the preset, offered for selection. */}
      {(parts ?? []).map((p) => {
        const start = rtl ? 1 - p.rect.x - p.rect.w : p.rect.x;
        return (
          <div
            key={p.part}
            className="pc-ov-part"
            style={{ left: start * width, top: p.rect.y * height, width: p.rect.w * width, height: p.rect.h * height,
                     pointerEvents: ground ? "none" : undefined }}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onLiftPart?.(p.part); }}
            role="button"
            tabIndex={0}
            aria-label={p.part}
          />
        );
      })}

      {comp.elements.map((el) => {
        // Unknown elements are stored and round-tripped, but they have no geometry this version can
        // reason about, so they are not selectable either.
        if (el.kind === "unknown" || el.hidden) return null;
        const box = toPhysical(el);
        if (!box) return null;
        const selected = el.id === selectedId;
        const editing = el.id === editingId;
        return (
          <div
            key={el.id}
            className={`pc-ov-el${selected ? " on" : ""}${active === el.id ? " live" : ""}`}
            style={{ left: box.left, top: box.top, width: box.w, height: box.h,
                     pointerEvents: ground ? "none" : undefined }}
            onPointerDown={(e) => {
              // A press inside the open editor is the caret being placed, not the element being
              // dragged: taking the capture here would swallow it and move the box instead.
              if (editing) { e.stopPropagation(); return; }
              const now = e.timeStamp || performance.now();
              const again = lastPress.current.id === el.id && now - lastPress.current.at < 420;
              lastPress.current = { id: el.id, at: now };
              if (again && isText(el)) {
                e.preventDefault();
                e.stopPropagation();
                // Whatever the first press captured has to go, or the caret cannot be placed.
                release(e.pointerId);
                gesture.current = null;
                setActive(null);
                onSelect(el.id);
                onBeginEdit?.(el.id);
                return;
              }
              begin(e, { kind: "move", id: el.id, startX: e.clientX, startY: e.clientY });
            }}
            role="button"
            tabIndex={0}
            aria-label={el.kind}
          >
            {editing && isText(el) && (
              <InlineText
                el={el}
                width={width}
                family={family ?? "inherit"}
                autoFrac={autoFrac ?? 0.04}
                onText={(t) => onEditText?.(t)}
                onDone={() => onEndEdit?.()}
              />
            )}
            {selected && !editing &&
              GRIPS.map((g) => (
                <span
                  key={g.grip}
                  className="pc-ov-grip"
                  style={{
                    // A logical grip is drawn on the mirrored side when the card runs right to left.
                    left: (rtl && el.placement.mirror !== false ? 1 - g.ix : g.ix) * box.w,
                    top: g.iy * box.h,
                    cursor: rtl ? g.cursorRtl : g.cursorLtr,
                  }}
                  onPointerDown={(e) =>
                    begin(e, { kind: "resize", id: el.id, grip: g.grip, startX: e.clientX, startY: e.clientY })
                  }
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

export { MIN_SIZE };
