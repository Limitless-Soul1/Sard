// A SLIDER AND A NUMBER, WHICH ARE NOT THE SAME QUESTION.
//
//     [ ────────●──── ]  42 px
//
// Dragging answers "how does this look" — it is continuous, it is fast, and you judge the result on
// the card rather than in the field. Typing answers "what exactly is it" — 41.7, or the size that
// matches the other card, or a value past the end of the track. Either alone is a worse editor: a
// numeric field makes you guess-and-check your way to a look, and a slider alone cannot say 41.7 and
// cannot reach a value its track does not cover.
//
// So the two share one value and neither owns it. The `ScrubField` beside the track is the same
// component used everywhere else here, which is why it is also draggable and why it clamps to its
// OWN range rather than the track's — the track is the comfortable middle of the range, not the
// whole of it. A slider whose travel is mostly sizes nobody uses is a slider you cannot aim.

import { ScrubField } from "./ScrubField";

export function SliderField({
  label, value, onChange, min, max, step = 1, unit, precision = 0, width = 46, title,
  softMin, softMax,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** The full range. The NUMBER may go anywhere in it. */
  min: number;
  max: number;
  step?: number;
  unit?: string;
  precision?: number;
  width?: number;
  title?: string;
  /** The track's range — the part of it people actually use. Defaults to the full range. */
  softMin?: number;
  softMax?: number;
}) {
  const lo = softMin ?? min;
  const hi = softMax ?? max;
  // A value typed beyond the track still has to put the handle somewhere sensible: at the end.
  const onTrack = Math.min(hi, Math.max(lo, value));
  return (
    <div className="pcx-sf" title={title}>
      <span className="pcx-sf-label">{label}</span>
      <input
        className="pcx-sf-range"
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={onTrack}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <ScrubField
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        unit={unit}
        precision={precision}
        width={width}
      />
    </div>
  );
}
