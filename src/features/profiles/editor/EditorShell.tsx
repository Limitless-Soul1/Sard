// Profile editor · the three columns — rail, chapter, preview.
//
// WHY A RAIL AND NOT AN ACCORDION. The accordion hid five answers to show one, so the editor could
// never say where you were. The rail keeps all six on screen with their current values, which makes
// the Profile readable at a glance and turns "what have I changed" into something you see rather
// than remember.
//
// ADDITIVE ON PURPOSE. This is the shell only. Chapter bodies still live in the existing editor and
// move in one at a time, so every commit in between builds and the old editor keeps working.
//
// WHY THE SHELL IS `rtl` BUT THE BODY IS NOT. The chapter names and questions are the design's
// Arabic verbatim (see `chapters.ts`), so the frame they sit in has to be RTL whatever the interface
// language is. The controls inside a chapter are not: they are the app's own translated strings, and
// laying English out RTL is simply wrong. So the direction is set twice — `rtl` on the frame, the
// app's own direction on the body — rather than once at the top where it would catch both.
import type { ReactNode } from "react";

import { CHAPTERS, FOCUS, type ChapterId, type Focus } from "./chapters";

export function EditorShell({
  active,
  onSelect,
  value,
  dirty,
  children,
  bodyDir,
  preview,
  railFooter,
}: {
  active: ChapterId;
  onSelect: (id: ChapterId) => void;
  /** The design's `value()` — each chapter's current answer, shown under its name. */
  value: (id: ChapterId) => string;
  /** The design's `dirty()` — whether this chapter has moved off its default. */
  dirty: (id: ChapterId) => boolean;
  /** The open chapter's controls. */
  children: ReactNode;
  /**
   * The interface direction, for the chapter body ONLY.
   *
   * The frame stays `rtl` because its words are Arabic; the controls inside it are translated, so
   * they follow the app. Passed in rather than read from i18n here, which keeps the shell a pure
   * layout component that renders the same way wherever it is mounted.
   */
  bodyDir: "ltr" | "rtl";
  /** The live faces. Receives the focus so it can draw the hairline frame. */
  preview: (focus: Focus) => ReactNode;
  /**
   * The block that closes the rail below the six chapters — Sard's firewall, which states once what
   * a profile does NOT carry. It is not a chapter and must never become one, so it arrives as a slot
   * rather than a seventh entry in CHAPTERS.
   */
  railFooter?: ReactNode;
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
        {/* THE FOOTER IS TRANSLATED PROSE, so it takes the app's direction like the chapter body —
            the rail's own Arabic names are what make the frame RTL, and this block is not one of
            them. Without it the English sentence was laid out right-to-left inside the RTL rail and
            its final full stop rendered at the wrong end. */}
        {railFooter && <div className="pfe-rail-foot" dir={bodyDir}>{railFooter}</div>}
      </nav>

      {/* One chapter at a time, with room for real specimens. */}
      <section className="pfe-chapter" aria-labelledby="pfe-ch-title">
        <h2 className="pfe-ch-title" id="pfe-ch-title">{open.ar}</h2>
        <p className="pfe-ch-q">{open.q}</p>
        <div className="pfe-ch-body" dir={bodyDir}>{children}</div>
      </section>

      <aside className="pfe-preview">{preview(FOCUS[open.id])}</aside>
    </div>
  );
}
