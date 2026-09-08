// A REAL COLOUR PICKER — a field of colour, a hue, a HEX box, and a few shortcuts.
//
// The swatch grid Sard had was not a picker; it was a menu of sixteen opinions, and it was the only
// way to colour anything. NewQu keeps presets as SHORTCUTS and puts an arbitrary colour behind them:
// drag in the square for saturation and brightness, drag the strip for hue, or type the hex you
// already know. The value shown is always the hex, because that is the thing a person can carry
// somewhere else.
//
// HSV rather than HSL for the square, because saturation-and-value is the arrangement people have
// learned from every other picker: white in one corner, black along the bottom, the pure hue in the
// far corner.

import { useRef } from "react";

import { useI18n } from "../../i18n";

// ---- colour maths, kept here so nothing else has to know about it ------------------------------

export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let t = m[1];
  if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
  const r = parseInt(t.slice(0, 2), 16) / 255;
  const g = parseInt(t.slice(2, 4), 16) / 255;
  const b = parseInt(t.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(x * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}

/** Normalise anything typed into a hex, or null if it is not a colour yet. */
export function normaliseHex(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  let t = m[1];
  if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
  return `#${t.toUpperCase()}`;
}

/** A small, deliberately warm set — Sard's inks and papers, not a rainbow. */
export const COLOUR_PRESETS = ["#2B2521", "#F5EEDD", "#9C5A3C", "#C9A227", "#5E7A52", "#3E6B8A", "#7A4E8A", "#B24A4A"];

// ---- the control -------------------------------------------------------------------------------

export function ColourPicker({
  value, onChange, title, onClose, showClear, onClear, clearLabel,
}: {
  /** The current colour as a hex, or null when it is following the theme. */
  value: string | null;
  onChange: (hex: string) => void;
  title: string;
  onClose: () => void;
  showClear?: boolean;
  onClear?: () => void;
  clearLabel?: string;
}) {
  const { t } = useI18n();
  const hsv = hexToHsv(value ?? "#9C5A3C") ?? { h: 20, s: 0.6, v: 0.6 };
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const trackSV = (e: React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onChange(hsvToHex(hsv.h, s, v));
  };
  const trackHue = (e: React.PointerEvent) => {
    const el = hueRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const h = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 360;
    onChange(hsvToHex(h, hsv.s || 1, hsv.v || 1));
  };

  return (
    <div className="pcx-pick" onPointerDown={(e) => e.stopPropagation()}>
      <header className="pcx-pick-head">
        <span className="pcx-pick-chip" style={{ background: value ?? "transparent" }} />
        <span className="pcx-pick-title">{title}</span>
        <button className="pcx-pick-x ui-close" onClick={onClose} title={t("photo.close")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      {/* Saturation across, brightness down — the arrangement every other picker has taught. */}
      <div
        ref={svRef}
        className="pcx-pick-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})` }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); trackSV(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) trackSV(e); }}
      >
        <span className="pcx-pick-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>

      <div
        ref={hueRef}
        className="pcx-pick-hue"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); trackHue(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) trackHue(e); }}
      >
        <span className="pcx-pick-dot" style={{ left: `${(hsv.h / 360) * 100}%`, top: "50%" }} />
      </div>

      {/* The hex is the point: it is the one form of a colour a person can take elsewhere. */}
      <label className="pcx-pick-hex">
        <span>HEX</span>
        <input
          value={value ?? ""}
          placeholder="#9C5A3C"
          onChange={(e) => {
            const hex = normaliseHex(e.target.value);
            if (hex) onChange(hex);
          }}
        />
      </label>

      <div className="pcx-pick-presets">
        {COLOUR_PRESETS.map((c) => (
          <button key={c} style={{ background: c }} onClick={() => onChange(c)} title={c} />
        ))}
      </div>

      {/* THE WAY OUT.
          Choosing a colour has no natural end — every drag is a new value, and the last one is
          simply where the user stopped. Without this the only way to finish was to press somewhere
          that was not the picker, which is a thing you have to already know. */}
      <div className="pcx-pick-foot">
        {showClear && (
          <button className="pcx-pick-clear" onClick={onClear}>{clearLabel}</button>
        )}
        <button className="pcx-pick-done" onClick={onClose}>{t("photo.pick.done")}</button>
      </div>
    </div>
  );
}
