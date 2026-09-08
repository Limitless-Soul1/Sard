// THE CONTEXTUAL TOOLBAR — the controls for the selected thing, floating on the canvas.
//
// NewQu puts the PRIMARY controls here rather than in a panel, and that is the load-bearing idea:
// the two or three things you reach for constantly — the face, the size, the alignment, the colour —
// sit a few pixels from what they change, so the common edit never crosses the room to a sidebar.
// The inspector keeps everything else.
//
// It floats ABOVE the card, never beneath it. Under the card it reads as a caption belonging to the
// page; above it, it reads as belonging to the selection.
//
// The size control is the one worth naming: `− [42 px] +`, where the number is both typed and
// dragged. Dragging a value horizontally is how every real editor does it, and it is why NewQu has
// no slider here at all.

import { useState } from "react";

import { useI18n } from "../../i18n";
import { ColourPicker } from "./ColourPicker";
import { Picker } from "./Picker";
import { ScrubField } from "./ScrubField";
import { isImage, isText } from "./elements";
import type { CardElement, ImageElement, TextStyle } from "./composition";

/** The alignments, drawn rather than named — four icons read faster than four words. */
const ALIGNS: { v: NonNullable<TextStyle["align"]>; path: string }[] = [
  { v: "start", path: "M4 6h16M4 11h10M4 16h13" },
  { v: "center", path: "M4 6h16M7 11h10M6 16h12" },
  { v: "end", path: "M4 6h16M10 11h10M7 16h13" },
  { v: "justify", path: "M4 6h16M4 11h16M4 16h16" },
];

export function CardToolbar({
  selected, canvasW, autoFrac, fonts, swatch, onStyle, onImage, onEditText, onRemove, onReplaceImage,
}: {
  selected: CardElement;
  /** The card's export width — the size field speaks in these pixels. */
  canvasW: number;
  /** What an auto-fitted quote is currently drawn at, as a fraction of the card. To hand it over. */
  autoFrac: number;
  fonts: { key: string; label: string }[];
  swatch: string;
  onStyle: (patch: Partial<TextStyle>) => void;
  onImage: (patch: Partial<ImageElement>) => void;
  onEditText: () => void;
  onRemove: () => void;
  onReplaceImage: () => void;
}) {
  const { t } = useI18n();
  // The swatch opens its own picker, anchored to itself. Sending the click to a colour control in
  // the inspector was how the old toolbar did it, and it meant the toolbar could not be trusted on
  // its own: press the swatch, and the answer appeared somewhere else on the screen.
  const [colour, setColour] = useState(false);
  if (selected.kind === "unknown") return null;

  const px = (f: number) => f * canvasW;
  const frac = (v: number) => v / canvasW;

  return (
    <div className="pcx-tb" onPointerDown={(e) => e.stopPropagation()}>
      {isText(selected) && (
        <>
          {/* Each face is drawn IN that face, which a native option list could not do — and the
              native list came up unreadable here anyway. See Picker. */}
          <Picker
            className="tb"
            width={132}
            title={t("photo.el.font")}
            value={selected.style.family ?? ""}
            options={[
              { value: "", label: t("photo.el.fontInherit") },
              ...fonts.map((f) => ({ value: f.key, label: f.label, family: f.key })),
            ]}
            onPick={(v) => onStyle({ family: v || null })}
          />

          {/* A quote that fits itself has no size to show, and showing one anyway would be a made-up
              number that the field then pretended to edit. It says what it is doing instead, and
              pressing it takes the size by hand at whatever it had just fitted to. */}
          {selected.style.size == null ? (
            <button className="pcx-tb-auto" onClick={() => onStyle({ size: autoFrac })} title={t("photo.tb.autoHint")}>
              {t("photo.tb.auto")}
            </button>
          ) : (
            <div className="pcx-tb-group">
              <button
                className="pcx-tb-step"
                onClick={() => onStyle({ size: frac(Math.max(6, px(selected.style.size ?? 0) - 1)) })}
                title={t("photo.tb.smaller")}
              >−</button>
              <ScrubField
                value={px(selected.style.size)}
                onChange={(v) => onStyle({ size: frac(v) })}
                min={6}
                max={Math.round(canvasW * 0.4)}
                step={1}
                unit="px"
                width={44}
                title={t("photo.tb.sizeHint")}
              />
              <button
                className="pcx-tb-step"
                onClick={() => onStyle({ size: frac(px(selected.style.size ?? 0) + 1) })}
                title={t("photo.tb.bigger")}
              >+</button>
            </div>
          )}

          <div className="pcx-tb-segs">
            {ALIGNS.map((a) => (
              <button
                key={a.v}
                className={`pcx-tb-mini${(selected.style.align ?? "start") === a.v ? " on" : ""}`}
                onClick={() => onStyle({ align: a.v })}
                title={t(`photo.align.${a.v}`)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none">
                  <path d={a.path} />
                </svg>
              </button>
            ))}
          </div>

          <span className="pcx-tb-colour">
            <button
              className="pcx-tb-swatch"
              style={{ background: swatch }}
              onClick={() => setColour((v) => !v)}
              title={t("photo.el.colour")}
            />
            {colour && (
              <ColourPicker
                value={selected.style.color ?? null}
                onChange={(hex) => onStyle({ color: hex })}
                title={t("photo.el.colour")}
                onClose={() => setColour(false)}
                showClear={!!selected.style.color}
                onClear={() => { onStyle({ color: null }); setColour(false); }}
                clearLabel={t("photo.el.colourInherit")}
              />
            )}
          </span>
          <span className="pcx-tb-div" />
          <button className="pcx-tb-text" onClick={onEditText}>{t("photo.tb.write")}</button>
        </>
      )}

      {isImage(selected) && (
        <>
          <button className="pcx-tb-text" onClick={onReplaceImage}>{t("photo.el.replace")}</button>
          <div className="pcx-tb-segs">
            {(["contain", "cover"] as const).map((f) => (
              <button
                key={f}
                className={`pcx-tb-mini wide${(selected.fit ?? "contain") === f ? " on" : ""}`}
                onClick={() => onImage({ fit: f })}
              >{t(`photo.fit.${f}`)}</button>
            ))}
          </div>
          <label className="pcx-tb-slider" title={t("photo.el.opacity")}>
            <span>{t("photo.el.opacity")}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((selected.opacity ?? 1) * 100)}
              onChange={(e) => onImage({ opacity: Number(e.target.value) / 100 })}
            />
            <b>{Math.round((selected.opacity ?? 1) * 100)}%</b>
          </label>
        </>
      )}

      <button className="pcx-tb-del" onClick={onRemove} title={t("photo.el.remove")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
        </svg>
      </button>
    </div>
  );
}
