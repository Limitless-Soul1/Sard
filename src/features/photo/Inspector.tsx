// THE INSPECTOR — precision, and the card itself. Not a settings page.
//
// ## What lives here, and what does not
//
// NewQu splits the controls in two, and the split is the whole point of having both surfaces:
//
//   TOOLBAR (on the canvas)   the two or three things you reach for constantly — the face, the size,
//                             the alignment, the colour. A few pixels from what they change.
//   INSPECTOR (here)          everything else, and everything precise: the words, the finer
//                             typography, exact position and size, and — when nothing is selected —
//                             the card itself.
//
// So this panel deliberately does NOT offer font size, alignment or text colour. They are one click
// away on the toolbar, and having them in both places was the old panel's habit: every control
// everywhere, forever, whether or not it applied.
//
// ## Numbers
//
// Every value is a real quantity in the card's own export pixels, in a field you can drag or type.
// No XS/S/M/L/XL, no sliders as the only way in, and no normalised fraction ever shown — the
// document stores fractions because that is what survives a change of format, and the conversion
// happens here, at the edge.

import { useState } from "react";

import { useI18n } from "../../i18n";
import { ColourPicker, normaliseHex } from "./ColourPicker";
import { Picker } from "./Picker";
import { ScrubField } from "./ScrubField";
import { SliderField } from "./SliderField";
import { COMPOSITIONS, type CompositionId } from "./compositions";
import { isImage, isText } from "./elements";
import {
  DEFAULT_HALO_WIDTH, DEFAULT_LEGIBILITY_SOFTNESS, DEFAULT_LEGIBILITY_STRENGTH,
  HALO_WIDTH_MAX_EM, STROKE_MAX_EM,
} from "./legibility";
import { FORMATS, type CardFormat, type CardMeta } from "./photo";
import type { CardElement, Composition, ImageElement, Rect, TextStyle } from "./composition";

/**
 * THE FLIP, AS TWO SWITCHES.
 *
 * Exported because the background needs the identical control: the ground and a picture element are
 * the same decision about the same kind of object, and drawing it twice is how two controls that
 * mean one thing drift apart.
 *
 * The glyphs are the mirror itself — a shape and its reflection across a dashed axis — rather than
 * arrows, which read as "move" on a surface where things can also be moved.
 */
export function FlipRow({ label, flipX, flipY, onX, onY, labelX, labelY }: {
  label: string;
  flipX: boolean;
  flipY: boolean;
  onX: () => void;
  onY: () => void;
  labelX: string;
  labelY: string;
}) {
  return (
    <div className="pcx-seg-field">
      <span className="pcx-seg-label">{label}</span>
      <div className="pcx-segs">
        <button type="button" className={flipX ? "on" : ""} onClick={onX} title={labelX} aria-label={labelX} aria-pressed={flipX}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v18" strokeDasharray="2.5 2.5" />
            <path d="M9.5 6.5 4 12l5.5 5.5z" />
            <path d="M14.5 6.5 20 12l-5.5 5.5z" fill="currentColor" fillOpacity=".22" />
          </svg>
        </button>
        <button type="button" className={flipY ? "on" : ""} onClick={onY} title={labelY} aria-label={labelY} aria-pressed={flipY}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
            <path d="M3 12h18" strokeDasharray="2.5 2.5" />
            <path d="M6.5 9.5 12 4l5.5 5.5z" />
            <path d="M6.5 14.5 12 20l5.5-5.5z" fill="currentColor" fillOpacity=".22" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title?: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="pcx-sec">
      {title && (
        <h3 className="pcx-sec-title">
          <span>{title}</span>
          {note && <i>{note}</i>}
        </h3>
      )}
      {children}
    </section>
  );
}

function Segments<T extends string | number>({
  value, options, onPick,
}: { value: T; options: { v: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="pcx-segs">
      {options.map((o) => (
        <button key={String(o.v)} type="button" className={value === o.v ? "on" : ""} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** What the document-level panel needs. Grouped so the prop list stays readable. */
export interface DocControls {
  format: CardFormat;
  setFormat: (f: CardFormat) => void;
  /** Export pixels. Overrides the format's own size when the user sets them. */
  width: number;
  height: number;
  setSize: (w: number, h: number) => void;
  papers: { id: string; label: string; paper: string; ink: string }[];
  paperId: string;
  setPaper: (id: string) => void;
  /** A colour the user chose outright, beyond the shipped papers. */
  paperHex: string | null;
  setPaperHex: (hex: string | null) => void;
  dir: "rtl" | "ltr";
  setDir: (d: "rtl" | "ltr") => void;
  /** The card's own footer: whether it is stamped with a date and a time. */
  meta: CardMeta;
  setMeta: (patch: Partial<CardMeta>) => void;
  /** What those stamps would actually read, formatted the way the card will print them. */
  stamps: { date: string; time: string };
  composition: CompositionId;
  applyComposition: (id: CompositionId) => void;
}

export function Inspector({
  comp, selected, canvas, autoFrac, doc, onStyle, onText, onImage, onRect, onRotate, onRemove,
  onOrder, onReplaceImage, onClearImage,
}: {
  comp: Composition;
  selected: CardElement | null;
  canvas: { w: number; h: number };
  /** What an auto-fitted quote is drawn at, as a fraction — where taking it by hand starts. */
  autoFrac: number;
  doc: DocControls;
  onStyle: (patch: Partial<TextStyle>) => void;
  onText: (text: string) => void;
  onImage: (patch: Partial<ImageElement>) => void;
  onRect: (rect: Rect) => void;
  onRotate: (deg: number) => void;
  onRemove: () => void;
  onOrder: (dir: "front" | "forward" | "backward" | "back") => void;
  onReplaceImage: () => void;
  onClearImage: () => void;
}) {
  const { t } = useI18n();
  const [paperPicker, setPaperPicker] = useState(false);
  const [legColour, setLegColour] = useState(false);
  const [strokeColour, setStrokeColour] = useState(false);

  // ── the card itself ───────────────────────────────────────────────────────────────────────
  if (!selected || selected.kind === "unknown") {
    return (
      <>
        <p className="pcx-rest">{t("photo.add.hint")}</p>

        <Section title={t("photo.sec.format")}>
          <div className="pcx-formats">
            {FORMATS.map((f) => (
              <button
                key={f.key}
                className={`pcx-format${doc.format === f.key ? " on" : ""}`}
                onClick={() => doc.setFormat(f.key)}
              >
                <span className="pcx-format-proxy" style={{ aspectRatio: `${f.w} / ${f.h}` }} />
                <span className="pcx-format-txt">
                  <b>{t(`photo.format.${f.key}`)}</b>
                  <i>{f.w}×{f.h}</i>
                </span>
              </button>
            ))}
          </div>
          <div className="pcx-pair">
            <ScrubField label={t("photo.doc.width")} value={doc.width} onChange={(v) => doc.setSize(Math.round(v), doc.height)} min={240} max={4096} step={1} unit="px" precision={0} width={54} />
            <ScrubField label={t("photo.doc.height")} value={doc.height} onChange={(v) => doc.setSize(doc.width, Math.round(v))} min={240} max={4096} step={1} unit="px" precision={0} width={54} />
          </div>
        </Section>

        <Section title={t("photo.sec.paper")}>
          <div className="pcx-papers">
            {doc.papers.map((p) => (
              <button
                key={p.id}
                className={`pcx-paper${!doc.paperHex && doc.paperId === p.id ? " on" : ""}`}
                style={{ background: p.paper }}
                onClick={() => { doc.setPaperHex(null); doc.setPaper(p.id); }}
                title={p.label}
              >
                {/* The paper's own ink, as a mark ON it. A letterform in the middle of each swatch
                    read as content that had got onto the card by accident — and it told you less
                    about the pairing than a stroke of the actual ink does. */}
                <span className="pcx-paper-ink" style={{ background: p.ink }} aria-hidden />
              </button>
            ))}
          </div>
          {/* The papers are shortcuts. This is the ceiling being removed. */}
          <button className={`pcx-customcol${doc.paperHex ? " on" : ""}`} onClick={() => setPaperPicker((v) => !v)}>
            <span className="pcx-customcol-chip" style={doc.paperHex ? { background: doc.paperHex } : undefined} />
            <span>{t("photo.doc.customPaper")}</span>
            <i>{doc.paperHex ?? ""}</i>
          </button>
          {paperPicker && (
            <ColourPicker
              value={doc.paperHex}
              onChange={(hex) => doc.setPaperHex(hex)}
              title={t("photo.doc.customPaper")}
              onClose={() => setPaperPicker(false)}
              showClear={!!doc.paperHex}
              onClear={() => { doc.setPaperHex(null); setPaperPicker(false); }}
              clearLabel={t("photo.doc.paperFromTheme")}
            />
          )}
        </Section>

        <Section title={t("photo.sec.composition")} note={t("photo.comp.note")}>
          <div className="pcx-comps">
            {COMPOSITIONS.map((c) => (
              <button
                key={c.id}
                className={`pcx-comp${doc.composition === c.id ? " on" : ""}`}
                onClick={() => doc.applyComposition(c.id)}
              >
                <span className={`pcx-comp-thumb ${c.id}`}><i /><i /><i /></span>
                <span>{t(c.label)}</span>
              </button>
            ))}
          </div>
        </Section>

        {/* The wordmark is NOT here. It is an element of the card and lives with the others in the
            rail, where its form and its place are chosen. These two are STAMPS the card carries. */}
        <Section title={t("photo.sec.footer")} note={t("photo.stamp.note")}>
          {([
            { k: "date" as const, label: t("photo.meta.date"), value: doc.stamps.date,
              path: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 9.5h16M8 3v4M16 3v4" },
            { k: "time" as const, label: t("photo.meta.time"), value: doc.stamps.time,
              path: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2" },
          ]).map((m) => (
            <div key={m.k} className={`pcx-stamp${doc.meta[m.k] ? " on" : ""}`}>
              <span className="pcx-stamp-ico" aria-hidden>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={m.path} />
                </svg>
              </span>
              <span className="pcx-stamp-txt">
                <b>{m.label}</b>
                {/* Not a description of the setting — the very characters the card will print. */}
                <i dir="auto">{m.value}</i>
              </span>
              <button
                className="pcx-switch"
                role="switch"
                aria-checked={doc.meta[m.k]}
                aria-label={m.label}
                onClick={() => doc.setMeta({ [m.k]: !doc.meta[m.k] })}
              >
                <span className="pcx-switch-knob" aria-hidden />
              </button>
            </div>
          ))}
        </Section>

        <Section title={t("photo.sec.direction")}>
          <Segments
            value={doc.dir}
            options={[{ v: "rtl" as const, label: t("photo.doc.fromRight") }, { v: "ltr" as const, label: t("photo.doc.fromLeft") }]}
            onPick={doc.setDir}
          />
          <p className="pcx-note">{t("photo.doc.brandNote")}</p>
        </Section>
      </>
    );
  }

  // ── an element ────────────────────────────────────────────────────────────────────────────
  const r = selected.placement.rect;
  const idx = comp.elements.findIndex((e) => e.id === selected.id);
  const atFront = idx === comp.elements.length - 1;
  const atBack = idx === 0;
  const px = (f: number, axis: "w" | "h" = "w") => f * canvas[axis];
  const frac = (v: number, axis: "w" | "h" = "w") => v / canvas[axis];

  return (
    <>
      {isText(selected) && (
        <>
          <Section title={t("photo.sec.words")}>
            <textarea
              className="pcx-text"
              value={selected.text}
              rows={3}
              onChange={(e) => onText(e.target.value)}
              placeholder={t("photo.el.textPlaceholder")}
              dir="auto"
            />
          </Section>

          {/* Size, alignment and colour are NOT here — they are on the toolbar, one click from the
              thing they change. This section is the rest of the typography. */}
          <Section title={t("photo.sec.type")}>
            {/* TEXT HAS A SIZE. That is the whole model — a number, on a track, from the moment the
                element exists. There is no choice to make between "fill the card" and "a fixed
                size", because that was never two ways of sizing text; it was one way plus a
                convenience wearing the costume of a mode.

                The track covers 12–120px because that is where card type lives; the field beside it
                reaches the whole range, so an outsized display line is one keystroke away. */}
            {selected.style.size != null ? (
              <SliderField
                label={t("photo.el.size")}
                value={px(selected.style.size)}
                onChange={(v) => onStyle({ size: frac(v) })}
                min={6} max={Math.round(canvas.w * 0.4)} softMin={12} softMax={120}
                step={0.5} unit="px" precision={1} width={48}
              />
            ) : (
              <div className="pcx-sf">
                <span className="pcx-sf-label">{t("photo.el.size")}</span>
                <span className="pcx-autonote">{t("photo.fit.autoNow")}</span>
              </div>
            )}
            {/* The convenience, offered as one: a long passage can be left to find its own size
                rather than being trimmed. Off by default, and off is the ordinary state. */}
            {selected.origin === "quote" && (
              <div className="pcx-stamp compact">
                <span className="pcx-stamp-txt">
                  <b>{t("photo.fit.auto")}</b>
                  <i>{t("photo.fit.autoHint")}</i>
                </span>
                <button
                  className="pcx-switch"
                  role="switch"
                  aria-checked={selected.style.size == null}
                  aria-label={t("photo.fit.auto")}
                  onClick={() => onStyle({ size: selected.style.size == null ? autoFrac : null })}
                >
                  <span className="pcx-switch-knob" aria-hidden />
                </button>
              </div>
            )}
            <Picker
              value={String(selected.style.weight ?? 400)}
              options={[
                { value: "300", label: t("photo.weight.light") },
                { value: "400", label: t("photo.weight.regular") },
                { value: "700", label: t("photo.weight.bold") },
              ]}
              onPick={(v) => onStyle({ weight: Number(v) })}
            />
            <SliderField
              label={t("photo.doc.line")}
              value={selected.style.lineHeight ?? 1.6}
              onChange={(v) => onStyle({ lineHeight: v })}
              min={0.8} max={3.2} softMin={1} softMax={2.6}
              step={0.05} precision={2} width={42}
            />
            <SliderField
              label={t("photo.doc.track")}
              value={(selected.style.letterSpacing ?? 0) * px(selected.style.size ?? 0.04)}
              onChange={(v) => onStyle({ letterSpacing: v / Math.max(1, px(selected.style.size ?? 0.04)) })}
              min={-8} max={60} softMin={-4} softMax={20}
              step={0.5} unit="px" precision={1} width={42}
            />
            <SliderField
              label={t("photo.el.opacity")}
              value={Math.round((selected.style.opacity ?? 1) * 100)}
              onChange={(v) => onStyle({ opacity: v / 100 })}
              min={0} max={100} step={1} unit="%" precision={0} width={42}
            />
            <SliderField
              label={t("photo.doc.rotate")}
              value={selected.placement.rotate ?? 0}
              onChange={onRotate}
              min={-180} max={180} softMin={-45} softMax={45}
              step={1} unit="°" precision={0} width={44}
            />
            {/* WHICH WAY THIS ONE LINE RUNS.
                It said "Card / Arabic / English", and all three were wrong about what they do.
                "Card" does not follow the card: it renders dir="auto", so the line takes its
                direction from its own words. The other two choose no language and no face - nothing
                about the text changes script - they force a direction, which is a different thing
                and the only thing this control has ever done.
                The stored values are untouched, so a card already saved keeps the setting it was
                given; only what the reader is told about it has changed. */}
            <div className="pcx-seg-field">
              <span className="pcx-seg-label">{t("photo.el.dir")}</span>
              <Segments
                value={selected.style.dir ?? "auto"}
                options={[
                  { v: "auto" as const, label: t("photo.el.dirAuto") },
                  { v: "rtl" as const, label: t("photo.doc.fromRight") },
                  { v: "ltr" as const, label: t("photo.doc.fromLeft") },
                ]}
                onPick={(v) => onStyle({ dir: v })}
              />
            </div>
            <p className="pcx-note">{t("photo.el.dirNote")}</p>
          </Section>

          {/* READABILITY OVER A PICTURE. Its own section, below the type, because it is a decision
              about the GROUND under these words rather than about the words themselves — and because
              it belongs beside the type controls it depends on, not in the paper section where it
              would apply to a card that has no picture at all.

              «بلا» is first and is what every existing card carries, so nothing already made changes.
              The strength row appears only once a treatment is chosen: a slider that governs nothing
              is furniture. See `legibility.ts` for what each one draws and why. */}
          <Section title={t("photo.sec.legibility")} note={t("photo.legibility.note")}>
            <Segments
              value={selected.style.legibility ?? "none"}
              options={[
                { v: "none" as const, label: t("photo.legibility.none") },
                { v: "halo" as const, label: t("photo.legibility.halo") },
                { v: "veil" as const, label: t("photo.legibility.veil") },
                { v: "plate" as const, label: t("photo.legibility.plate") },
              ]}
              onPick={(v) =>
                onStyle(
                  v === "none"
                    ? { legibility: "none" }
                    // Chosen for the first time: give it values to act on, and keep whatever the
                    // reader had already dialled if they are only changing which treatment it is.
                    : {
                      legibility: v,
                      legibilityStrength: selected.style.legibilityStrength ?? DEFAULT_LEGIBILITY_STRENGTH,
                      legibilitySoftness: selected.style.legibilitySoftness ?? DEFAULT_LEGIBILITY_SOFTNESS,
                      // A halo arrives with a body, for the same reason it arrives with a strength: a
                      // control at zero is one the reader has to discover before the treatment does
                      // anything it could not already do.
                      ...(v === "halo" ? { haloWidth: selected.style.haloWidth ?? DEFAULT_HALO_WIDTH } : {}),
                    },
                )
              }
            />
            {(selected.style.legibility ?? "none") !== "none" && (
              <>
                <SliderField
                  label={t("photo.legibility.strength")}
                  value={Math.round((selected.style.legibilityStrength ?? DEFAULT_LEGIBILITY_STRENGTH) * 100)}
                  onChange={(v) => onStyle({ legibilityStrength: v / 100 })}
                  min={0} max={100} step={1} unit="%" precision={0} width={42}
                />
                {/* HOW THICK THE HALO IS — halo only, because only a halo has a body.
                    NOT a stroke, and the difference is the whole reason both exist: a stroke is an
                    outline ON the letterform and this is the mass of light standing OFF it. See
                    `haloBody`, which builds that mass out of offset copies because a text shadow has
                    no spread to give it. */}
                {selected.style.legibility === "halo" && (
                  <SliderField
                    label={t("photo.legibility.width")}
                    value={Math.round((selected.style.haloWidth ?? 0) * 1000) / 10}
                    onChange={(v) => onStyle({ haloWidth: v / 100 })}
                    min={0} max={Math.round(HALO_WIDTH_MAX_EM * 100)}
                    step={0.5} unit="%" precision={1} width={42}
                  />
                )}
                {/* ONE KNOB, THREE MEANINGS — and each is the one that matters for its treatment: how
                    far a halo's light carries, how soon a veil dissolves, how round and how generous
                    a plate's edge is. It earns its place because at either end the same treatment
                    looks like a different decision. */}
                <SliderField
                  label={t("photo.legibility.softness")}
                  value={Math.round((selected.style.legibilitySoftness ?? DEFAULT_LEGIBILITY_SOFTNESS) * 100)}
                  onChange={(v) => onStyle({ legibilitySoftness: v / 100 })}
                  min={0} max={100} step={1} unit="%" precision={0} width={42}
                />
                {/* PLATE ONLY. A veil has no edge to shape and a halo has no surface, so offering
                    this for them would be a control that does nothing. */}
                {selected.style.legibility === "plate" && (
                  <div className="pcx-seg-field">
                    <span className="pcx-seg-label">{t("photo.legibility.shape")}</span>
                    <Segments
                      value={selected.style.legibilityShape ?? "block"}
                      options={[
                        { v: "block" as const, label: t("photo.legibility.shapeBlock") },
                        { v: "lines" as const, label: t("photo.legibility.shapeLines") },
                      ]}
                      onPick={(v) => onStyle({ legibilityShape: v })}
                    />
                  </div>
                )}
                {/* THE COLOUR, AND WHY IT IS NOT MERELY A SWATCH.
                    Derived, the treatment resolves to the card's own paper wherever that reads — which
                    on a pale card is white, every time, for every card. That is a sensible default and
                    a poor ceiling: a warm scrim, a coloured wash, an ink-dark plate under pale type are
                    all ordinary editorial decisions and none of them was reachable. The chip shows what
                    is in force, and clearing it returns the treatment to the derived answer. */}
                <button
                  className={`pcx-customcol${selected.style.legibilityColor ? " on" : ""}`}
                  onClick={() => setLegColour((v) => !v)}
                >
                  <span
                    className="pcx-customcol-chip"
                    style={selected.style.legibilityColor ? { background: selected.style.legibilityColor } : undefined}
                  />
                  <span>{t("photo.legibility.colour")}</span>
                  <i>{selected.style.legibilityColor ?? t("photo.legibility.colourAuto")}</i>
                </button>
                {legColour && (
                  <ColourPicker
                    value={selected.style.legibilityColor ?? null}
                    onChange={(hex) => onStyle({ legibilityColor: normaliseHex(hex) })}
                    title={t("photo.legibility.colour")}
                    onClose={() => setLegColour(false)}
                    showClear={!!selected.style.legibilityColor}
                    onClear={() => { onStyle({ legibilityColor: null }); setLegColour(false); }}
                    clearLabel={t("photo.legibility.colourAuto")}
                  />
                )}
              </>
            )}

            {/* THE STROKE, AND WHY IT IS HERE RATHER THAN IN A MODE LIST.
                It is the fourth readability device and the only one that is not a mode: it composes
                with the other three instead of replacing one — a halo carries the words off a busy
                ground, and a hairline stroke stops the glyph edges dissolving into that halo. So it
                sits below them, always available, and is off at zero.

                It is under «الوضوح» and not under the type controls because it is a decision about
                being READ. Nothing here can move a line: see the note at the top of legibility.ts. */}
            <div className="pcx-substep">
              <span className="pcx-seg-label">{t("photo.stroke.title")}</span>
            </div>
            {/* ONE UNIT, BOTH WAYS. This read the value as a percentage of the type size and wrote it
                back as a per-mille, so every drag stored a TENTH of what the handle showed: the track
                ran to 24 and the number could not pass 2.4, and at the soft end of the track it
                appeared to stop at 0.8. A slider whose two halves disagree about the unit is not a
                range that needs widening — it is arithmetic that has to be made to agree. */}
            <SliderField
              label={t("photo.stroke.width")}
              value={Math.round((selected.style.strokeWidth ?? 0) * 1000) / 10}
              onChange={(v) => onStyle({ strokeWidth: v / 100 })}
              min={0} max={Math.round(STROKE_MAX_EM * 100)}
              step={0.5} unit="%" precision={1} width={42}
            />
            {(selected.style.strokeWidth ?? 0) > 0 && (
              <>
                <button
                  className={`pcx-customcol${selected.style.strokeColor ? " on" : ""}`}
                  onClick={() => setStrokeColour((v) => !v)}
                >
                  <span
                    className="pcx-customcol-chip"
                    style={selected.style.strokeColor ? { background: selected.style.strokeColor } : undefined}
                  />
                  <span>{t("photo.stroke.colour")}</span>
                  <i>{selected.style.strokeColor ?? t("photo.stroke.colourAuto")}</i>
                </button>
                {strokeColour && (
                  <ColourPicker
                    value={selected.style.strokeColor ?? null}
                    onChange={(hex) => onStyle({ strokeColor: normaliseHex(hex) })}
                    title={t("photo.stroke.colour")}
                    onClose={() => setStrokeColour(false)}
                    showClear={!!selected.style.strokeColor}
                    onClear={() => { onStyle({ strokeColor: null }); setStrokeColour(false); }}
                    clearLabel={t("photo.stroke.colourAuto")}
                  />
                )}
              </>
            )}
            <p className="pcx-note">{t("photo.stroke.note")}</p>
          </Section>
        </>
      )}

      {isImage(selected) && (
        <Section title={t("photo.sec.picture")}>
          <div className="pcx-imgprev" data-empty={selected.assetId ? undefined : ""} />
          <div className="pcx-pair">
            <button className="pcx-solid" onClick={onReplaceImage}>{t("photo.el.replace")}</button>
            <button className="pcx-ghost" onClick={onClearImage}>{t("photo.el.remove")}</button>
          </div>
          {/* MIRRORED, NOT REWRITTEN. Two switches rather than a menu: a flip is a state the
              picture is in, and a reader wants to see at a glance which way round it is. */}
          <FlipRow
            label={t("photo.el.flip")}
            flipX={!!selected.flipX}
            flipY={!!selected.flipY}
            onX={() => onImage({ flipX: !selected.flipX })}
            onY={() => onImage({ flipY: !selected.flipY })}
            labelX={t("photo.el.flipH")}
            labelY={t("photo.el.flipV")}
          />
          <SliderField
            label={t("photo.el.radius")} value={(selected.radius ?? 0) * 100}
            onChange={(v) => onImage({ radius: v / 100 })}
            min={0} max={50} step={1} unit="%" precision={0} width={42}
          />
          <SliderField
            label={t("photo.el.opacity")} value={Math.round((selected.opacity ?? 1) * 100)}
            onChange={(v) => onImage({ opacity: v / 100 })}
            min={0} max={100} step={1} unit="%" precision={0} width={42}
          />
          <SliderField
            label={t("photo.doc.rotate")} value={selected.placement.rotate ?? 0} onChange={onRotate}
            min={-180} max={180} softMin={-45} softMax={45} step={1} unit="°" precision={0} width={44}
          />
          <SliderField
            label={t("photo.ground.blur")} value={selected.blur ?? 0}
            onChange={(v) => onImage({ blur: v })}
            min={0} max={60} softMin={0} softMax={24} step={0.5} unit="px" precision={1} width={42}
          />
        </Section>
      )}

      {/* Precision, for anything: exact place, exact size, and where it sits in the stack. */}
      <Section title={t("photo.sec.place")}>
        <div className="pcx-quad">
          <ScrubField label="X" value={px(r.x)} onChange={(v) => onRect({ ...r, x: frac(v) })} min={-canvas.w} max={canvas.w * 2} step={1} unit="px" precision={0} width={44} />
          <ScrubField label="Y" value={px(r.y, "h")} onChange={(v) => onRect({ ...r, y: frac(v, "h") })} min={-canvas.h} max={canvas.h * 2} step={1} unit="px" precision={0} width={44} />
          <ScrubField label="W" value={px(r.w)} onChange={(v) => onRect({ ...r, w: frac(v) })} min={16} max={canvas.w * 2} step={1} unit="px" precision={0} width={44} />
          <ScrubField label="H" value={px(r.h, "h")} onChange={(v) => onRect({ ...r, h: frac(v, "h") })} min={16} max={canvas.h * 2} step={1} unit="px" precision={0} width={44} />
        </div>
        <div className="pcx-pair">
          <button className="pcx-ghost" onClick={() => onRect({ ...r, x: (1 - r.w) / 2 })}>{t("photo.doc.centreH")}</button>
          <button className="pcx-ghost" onClick={() => onRect({ ...r, y: (1 - r.h) / 2 })}>{t("photo.doc.centreV")}</button>
        </div>
        <div className="pcx-segs">
          <button disabled={atBack} onClick={() => onOrder("back")}>{t("photo.el.toBack")}</button>
          <button disabled={atBack} onClick={() => onOrder("backward")}>{t("photo.el.backward")}</button>
          <button disabled={atFront} onClick={() => onOrder("forward")}>{t("photo.el.forward")}</button>
          <button disabled={atFront} onClick={() => onOrder("front")}>{t("photo.el.toFront")}</button>
        </div>
      </Section>

      <button className="pcx-remove" onClick={onRemove}>{t("photo.el.remove")}</button>
    </>
  );
}

export { normaliseHex };
