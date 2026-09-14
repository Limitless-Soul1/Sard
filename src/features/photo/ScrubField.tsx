// A NUMBER YOU CAN DRAG OR TYPE.
//
// NewQu has almost no sliders. Its numeric controls are compact labelled fields you drag sideways to
// change and click to type into — which is how every editor of this kind works, and why its panels
// stay short: a slider costs a whole row, a scrub field costs none.
//
// Two details make it feel right rather than merely work:
//
//   · The drag is captured on the FIELD, and a pointer that started scrubbing keeps scrubbing even
//     when it leaves the control. Without capture the value stops changing the moment the cursor
//     slips off, which reads as the control breaking.
//   · A drag must not steal the click. The field only enters scrub mode after the pointer has moved
//     a few pixels; below that it is a click, and the input takes focus so typing works.

import { useRef, useState } from "react";

export function ScrubField({
  value, onChange, min, max, step = 1, unit, label, width = 52, precision = 1, title, disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** A short word before the number — "line", "X", "W". Omitted in the toolbar, present in panels. */
  label?: string;
  width?: number;
  precision?: number;
  title?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const focused = useRef(false);
  const drag = useRef<{ x: number; from: number; live: boolean } | null>(null);
  const rootRef = useRef<HTMLLabelElement>(null);

  const shown = draft ?? String(Number(value.toFixed(precision)));
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    drag.current = { x: e.clientX, from: value, live: false };
    rootRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    // Below the threshold this is still a click, so the input can take focus and be typed into.
    if (!d.live && Math.abs(dx) < 4) return;
    d.live = true;
    e.preventDefault();
    // A finer step while dragging than the stepper uses: a pixel of travel should not jump a card's
    // type size by a whole point.
    onChange(clamp(d.from + dx * step * 0.5));
  };
  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const wasLive = drag.current.live;
    drag.current = null;
    const root = rootRef.current;
    if (root && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (!wasLive) root?.querySelector("input")?.focus();
  };

  return (
    <label
      ref={rootRef}
      className={`pcx-scrub${disabled ? " off" : ""}`}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={() => { drag.current = null; }}
    >
      {label && <span className="pcx-scrub-label">{label}</span>}
      <input
        className="pcx-scrub-input"
        type="text"
        inputMode="decimal"
        style={{ width }}
        value={shown}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setDraft(null); }}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(clamp(v));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") { e.preventDefault(); onChange(clamp(value + step)); }
          if (e.key === "ArrowDown") { e.preventDefault(); onChange(clamp(value - step)); }
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="pcx-scrub-unit">{unit}</span>}
    </label>
  );
}
