// WHAT IS ON THE CARD, AND HOW CLOSE YOU ARE LOOKING.
//
// A row of chips across the top of the workspace, one per element, and the zoom control at its end.
//
// This is NewQu's answer to the layer panel it deliberately does not have. A chip names a thing and
// selects it; the order they appear in is the order they are stacked. It costs one line, it never
// grows into a tree, and it solves the one problem clicking cannot — reaching something that is
// completely hidden behind something else.
//
// It sits ABOVE the canvas rather than beside it, and its inline-end padding leaves the inspector's
// width clear so the two never overlap.

import { useI18n } from "../../i18n";
import { isImage, isText } from "./elements";
import type { Composition } from "./composition";

export function ObjectsStrip({
  comp, selectedId, onSelect, zoom, onZoom, inspectorOpen,
}: {
  comp: Composition;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 1 = fits the workspace. The label shows the effective percentage. */
  zoom: number;
  onZoom: (z: number | "fit") => void;
  inspectorOpen: boolean;
}) {
  const { t } = useI18n();

  const label = (el: Composition["elements"][number]): string => {
    if (el.kind === "unknown") return "—";
    if (isImage(el)) return t("photo.el.image");
    if (isText(el)) {
      const words = el.text.trim().replace(/\s+/g, " ");
      if (words) return words.length > 22 ? words.slice(0, 22) + "…" : words;
      return t(`photo.el.${el.kind}`);
    }
    return "—";
  };

  return (
    <div className={`pcx-strip${inspectorOpen ? " with-inspector" : ""}`}>
      <div className="pcx-chips" data-noscroll="1">
        {comp.elements.map((el) => (
          <button
            key={el.id}
            className={`pcx-chip${el.id === selectedId ? " on" : ""}`}
            onClick={() => onSelect(el.id)}
            onPointerDown={(e) => e.stopPropagation()}
            title={label(el)}
          >
            <span className={`pcx-chip-dot ${el.kind}`} aria-hidden />
            <span>{label(el)}</span>
          </button>
        ))}
      </div>

      <div className="pcx-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => onZoom(Math.max(0.25, zoom - 0.1))} title={t("photo.zoom.out")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14" /></svg>
        </button>
        <button className="pcx-zoom-fit" onClick={() => onZoom("fit")} title={t("photo.zoom.fit")}>
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => onZoom(Math.min(3, zoom + 0.1))} title={t("photo.zoom.in")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
    </div>
  );
}
