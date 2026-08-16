// Profile editor · the three columns — rail, chapter, preview.
//
// WHY A RAIL AND NOT AN ACCORDION. The accordion hid five answers to show one, so the editor could
// never say where you were. The rail keeps all six on screen with their current values, which makes
// the Profile readable at a glance and turns "what have I changed" into something you see rather
// than remember.
//
// ADDITIVE ON PURPOSE. This is the shell only. Chapter bodies still live in the existing editor and
// move in one at a time, so every commit in between builds and the old editor keeps working.
import type { ReactNode } from "react";

import { CHAPTERS, FOCUS, type ChapterId, type Focus } from "./chapters";

export function EditorShell({
  active,
  onSelect,
  value,
  dirty,
  children,
  preview,
}: {
  active: ChapterId;
  onSelect: (id: ChapterId) => void;
  /** The design's `value()` — each chapter's current answer, shown under its name. */
  value: (id: ChapterId) => string;
  /** The design's `dirty()` — whether this chapter has moved off its default. */
  dirty: (id: ChapterId) => boolean;
  /** The open chapter's controls. */
  children: ReactNode;
  /** The live faces. Receives the focus so it can draw the hairline frame. */
  preview: (focus: Focus) => ReactNode;
}) {
  const open = CHAPTERS.find((c) => c.id === active) ?? CHAPTERS[0];

  return (
    <div className="pfe" dir="rtl">
      {/* The whole Profile at a glance: six names, six values, a dot on anything moved. */}
      <nav className="pfe-rail" aria-label="فصول الهيئة">
        {CHAPTERS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`pfe-rail-item${c.id === active ? " is-open" : ""}`}
            aria-current={c.id === active ? "true" : undefined}
            onClick={() => onSelect(c.id)}
          >
            <span className="pfe-rail-name">
              {c.ar}
              {dirty(c.id) && <span className="pfe-dot" aria-label="مُعدَّل" />}
            </span>
            <span className="pfe-rail-value">{value(c.id)}</span>
          </button>
        ))}
      </nav>

      {/* One chapter at a time, with room for real specimens. */}
      <section className="pfe-chapter" aria-labelledby="pfe-ch-title">
        <h2 className="pfe-ch-title" id="pfe-ch-title">{open.ar}</h2>
        <p className="pfe-ch-q">{open.q}</p>
        <div className="pfe-ch-body">{children}</div>
      </section>

      <aside className="pfe-preview">{preview(FOCUS[open.id])}</aside>
    </div>
  );
}
