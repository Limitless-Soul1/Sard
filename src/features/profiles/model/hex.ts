// Typing a colour code — the design's own rule, as a function.
//
// The Paper chapter lets a reader paste or type a hex code and repaint the page under the cursor.
// That needs three answers from every keystroke, not one: what the FIELD should now show, whether the
// value is COMMITTABLE, and whether to warn. Returning all three keeps the component free of the
// rule, and the rule testable without a field.
//
// THE RULE IS THE DESIGN'S, transcribed rather than invented (frame 2a's `onNHex`):
//   • trim, and supply a leading `#` when the reader did not type one — pasting `3A7BFF` works
//   • accept three OR six digits, case-insensitively
//   • expand `#abc` to `#AABBCC`, and commit upper-case
//   • a lone `#` clears the field rather than reading as an error, so backspacing is not a warning
//   • warn only once there is something to warn about: more than one character, and not yet valid
//
// `draft` is deliberately the RAW text, not the normalised value: a reader half-way through typing
// `#3A7B` must see what they typed. Only `full` is ever written to the profile.

/** The shape of a colour value that is still being typed. */
export interface HexEdit {
  /** What the input should display — the reader's own text, with `#` supplied. */
  draft: string;
  /** The committable `#RRGGBB`, upper-case, or `null` while the value is not yet a colour. */
  full: string | null;
  /** True when `full` is set. */
  ok: boolean;
  /** True when the reader has typed enough to be wrong, and is. Drives the incomplete-code message. */
  bad: boolean;
}

const SHAPE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

const expand = (v: string): string =>
  "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];

/**
 * Normalise one keystroke's worth of hex input.
 *
 * Total: every string yields a `HexEdit`, and nothing throws. An empty field is neither ok nor bad —
 * it is a field the reader has emptied, which is a legitimate state on the way to a new value.
 */
export function editHex(raw: string): HexEdit {
  let v = raw.trim();
  if (v && v[0] !== "#") v = "#" + v;
  const ok = SHAPE.test(v);
  const full = ok ? (v.length === 4 ? expand(v) : v).toUpperCase() : null;
  return {
    // A lone `#` is an empty field, not a one-character value: it is what backspacing to nothing
    // leaves behind once the `#` is supplied automatically.
    draft: v === "#" ? "" : v,
    full,
    ok,
    bad: v.length > 1 && !ok,
  };
}
