// THE WHOLE COLOUR SPACE, not a row of swatches — and ONE of them, everywhere.
//
// WHY THIS LIVES IN `components/`. It was built for the profile editor, and for a while the Reader
// went on opening the operating system's colour dialog instead: five sites on `<input type="color">`
// (ink, page, desk, the reference rule, the read-aloud track) plus a sixth, `AnnotationLayer`'s own
// hue bar, which was Sard-shaped but had no saturation, no lightness and no way to type a value. Six
// controls, three mechanisms, one of which was not Sard at all. A reader who has a hex code — and a
// reader choosing a colour to match something they already own usually does — could not use it.
//
// It reaches into `features/profiles/model` for the colour maths, which `lib/texture.ts` already
// does; that module is shared in practice and this follows the path already worn rather than moving
// three hundred lines to make a point.
//
// WHAT WAS WRONG. Two surfaces let a reader choose a colour and neither of them could reach an
// arbitrary one. The Colours chapter had a hex FIELD but no picker, so it only helped a reader who
// already knew the code they wanted. `CustomPaper` had swatches and a hue strip, but the strip fed
// `paperFromHue`/`accentFromHue`, which pin saturation and lightness to constants — moving it swept
// the hue circle at one fixed tint, and the hex beside it was a read-only `<div>`. Between them a
// reader could reach 8 papers, 8 accents and one ring of hues. `#5E7A52` was reachable only by
// coincidence.
//
// WHY HSL AND NOT HSV. The model already speaks HSL: `palette.ts` carries `rgbToHsl`/`hslToRgb`, and
// `deriveColors` reasons in lightness. A picker in HSV would have to convert at every edge and would
// disagree with the derivation about what "lighter" means. The plane here is therefore saturation ×
// lightness at a chosen hue, which is exactly the space the rest of the palette work already uses.
//
// WHY THE GEOMETRY IS PHYSICAL. The plane and the two sliders are `dir="ltr"` whatever the interface
// language is. A spectrum has no reading direction — the same reason the background image's flip is
// physical in `global.css`. Mirroring it would put red where a reader last left violet purely
// because the interface is Arabic, and it would mean the gradient and the pointer maths disagree,
// which is a whole class of bug this simply does not have.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../i18n";
import { editHex } from "../features/profiles/model/hex";
import { contrast, isHex, rgbToHsl, hslToRgb, toHex, toRgb } from "../features/profiles/model/palette";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Where a pointer landed inside an element, 0..1 on each axis, physical left-to-right. */
function at(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: clamp01((clientX - r.left) / Math.max(1, r.width)),
    y: clamp01((clientY - r.top) / Math.max(1, r.height)),
  };
}

/**
 * A drag that keeps working outside the element.
 *
 * Pointer capture, so dragging off the plane still tracks instead of stopping at the edge — which is
 * how every other colour tool behaves and what a reader sweeping toward pure white will do.
 */
function useDrag(onMove: (e: React.PointerEvent<HTMLDivElement>) => void) {
  const down = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      down.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      onMove(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (down.current) onMove(e); },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      down.current = false;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not fatal */ }
    },
    onPointerCancel: () => { down.current = false; },
  };
}

export function ColorPicker({
  value,
  onChange,
  onDone,
  presets = [],
  /** Shown against the colour so a reader can see the pairing they are actually making. */
  contrastAgainst,
  alpha = false,
  opacity = 1,
  onOpacity,
}: {
  value: string;
  onChange: (hex: string) => void;
  /**
   * Close the picker. The colour is committed AS IT IS CHOSEN — that is what makes the preview worth
   * looking at — so this finishes the interaction rather than applying anything. Without it the panel
   * stayed open under the row it belonged to with no way to say "done", which is exactly how a reader
   * ends up stuck staring at an expanded picker.
   */
  onDone?: () => void;
  presets?: readonly string[];
  contrastAgainst?: string;
  /**
   * Alpha is OFF for every profile theme colour, and that is the model's rule rather than an
   * omission: `isHex` in `palette.ts` accepts exactly `#rrggbb` and is documented as the only shape a
   * profile may carry, while `contrast()` and `deriveColors()` both assume an opaque colour. A
   * translucent paper would make the measured contrast a fiction. The control exists for properties
   * that genuinely store an alpha, and is simply not enabled for these.
   */
  alpha?: boolean;
  opacity?: number;
  onOpacity?: (a: number) => void;
}) {
  const { t } = useI18n();
  const safe = isHex(value) ? value : "#000000";
  const [h, s, l] = rgbToHsl(toRgb(safe));

  // The hue a reader is working at is not recoverable from a grey — every grey is hue 0, so sweeping
  // to the edge of the plane and back would snap the hue to red. Holding it locally keeps the strip
  // where the reader put it, which is what makes the plane feel like one surface rather than two.
  const [hue, setHue] = useState(h);
  useEffect(() => { if (s > 0.004) setHue(h); }, [h, s]);

  // The field shows what the reader typed while they are typing, and the committed value otherwise.
  const [typed, setTyped] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => { setTyped(null); setBad(false); }, [value]);

  const emit = (nh: number, ns: number, nl: number) =>
    onChange(toHex(hslToRgb([nh, clamp01(ns), clamp01(nl)])).toUpperCase());

  const plane = useDrag((e) => {
    const p = at(e.currentTarget, e.clientX, e.clientY);
    emit(hue, p.x, 1 - p.y);
  });
  const hueBar = useDrag((e) => {
    const p = at(e.currentTarget, e.clientX, e.clientY);
    const nh = p.x * 360;
    setHue(nh);
    emit(nh, s, l);
  });
  const alphaBar = useDrag((e) => {
    if (!onOpacity) return;
    const p = at(e.currentTarget, e.clientX, e.clientY);
    onOpacity(clamp01(p.x));
  });

  const onHex = (raw: string) => {
    const r = editHex(raw);
    setTyped(r.draft);
    setBad(r.bad);
    // Commit the moment the value becomes a colour — typed or pasted, the same path. `editHex`
    // already supplies a missing `#` and expands `#abc`, so a pasted `5E7A52` lands as `#5E7A52`.
    if (r.full) onChange(r.full);
  };

  // Escape dismisses, matching the rest of the editor's layers. Bound on the picker's own subtree so
  // it cannot swallow an Escape meant for the dialog around it when the picker is not focused.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && onDone) { e.stopPropagation(); onDone(); }
  };

  const pure = toHex(hslToRgb([hue, 1, 0.5]));
  const ratio = contrastAgainst && isHex(contrastAgainst) ? contrast(safe, contrastAgainst) : null;

  return (
    <div className="pf-pick" onKeyDown={onKey}>
      <div
        className="pf-pick-plane"
        dir="ltr"
        style={{
          // Lightness down, saturation across, at the working hue — the HSL plane exactly.
          backgroundImage:
            "linear-gradient(to bottom, #fff 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0) 50%, #000 100%)," +
            `linear-gradient(to right, #808080 0%, ${pure} 100%)`,
        }}
        role="application"
        aria-label={t("profiles.pick.plane")}
        {...plane}
      >
        <span
          className="pf-pick-dot"
          style={{ left: `${s * 100}%`, top: `${(1 - l) * 100}%`, background: safe }}
        />
      </div>

      <div className="pf-pick-hue" dir="ltr" role="slider" aria-label={t("profiles.pick.hue")}
        aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hue)} {...hueBar}>
        <span className="pf-pick-dot pf-pick-dot--bar" style={{ left: `${(hue / 360) * 100}%`, background: pure }} />
      </div>

      {alpha && onOpacity && (
        <div
          className="pf-pick-alpha"
          dir="ltr"
          role="slider"
          aria-label={t("profiles.pick.alpha")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(opacity * 100)}
          style={{ backgroundImage: `linear-gradient(to right, transparent 0%, ${safe} 100%)` }}
          {...alphaBar}
        >
          <span className="pf-pick-dot pf-pick-dot--bar" style={{ left: `${opacity * 100}%`, background: safe }} />
        </div>
      )}

      <div className="pf-pick-foot">
        {onDone && (
          <button className="pf-pick-done" onClick={onDone}>
            {t("profiles.pick.done")}
          </button>
        )}
        {/* `dir="ltr"` and isolated: a hex code is a Latin token and must not reorder inside an
            Arabic sentence, in either interface language. */}
        <input
          className={`pf-pick-hex${bad ? " bad" : ""}`}
          value={typed ?? safe.toUpperCase()}
          onChange={(e) => onHex(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          dir="ltr"
          aria-label={t("profiles.pick.hex")}
          // THE RED BORDER WAS THE ONLY THING SAYING SO. `bad` already tinted the edge, which a
          // reader who cannot see it never learns about; `aria-invalid` says the same thing to a
          // screen reader. `#RRGGBBAA` is the longest a colour gets here, so seven more characters
          // could only ever be a paste that was never going to be a colour.
          aria-invalid={bad || undefined}
          maxLength={9}
        />
        {ratio !== null && (
          <span className={`pf-pick-cr${ratio >= 4.5 ? "" : " warn"}`}>{ratio.toFixed(1)}:1</span>
        )}
      </div>

      {presets.length > 0 && (
        <div className="pf-pick-presets">
          {presets.map((p) => (
            <button
              key={p}
              className={`pf-pick-preset${safe.toLowerCase() === p.toLowerCase() ? " on" : ""}`}
              style={{ background: p }}
              onClick={() => onChange(p.toUpperCase())}
              title={p}
              aria-label={p}
            />
          ))}
        </div>
      )}
    </div>
  );
}
