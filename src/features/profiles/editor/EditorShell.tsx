// Profile editor · the three columns — rail, chapter, preview.
//
// WHY A RAIL AND NOT AN ACCORDION. The accordion hid five answers to show one, so the editor could
// never say where you were. The rail keeps all six on screen with their current values, which makes
// the Profile readable at a glance and turns "what have I changed" into something you see rather
// than remember.
//
// THE FRAME FOLLOWS THE READER'S LANGUAGE. It used to be pinned `rtl` whatever the interface was,
// because its chapter names were Arabic literals with no translation to follow. They are keys now
// (see `chapters.ts`), so the whole editor can face the way the rest of the application faces: the
// rail sits at the inline start — the right in Arabic, the left in English — and the direction is
// set once at the top rather than twice, which is what the split into a separate `bodyDir` existed
// to work around.
import type { ReactNode } from "react";

import { useI18n } from "../../../i18n";
import { CHAPTERS, FOCUS, type ChapterId, type Focus } from "./chapters";

export function EditorShell({
  active,
  onSelect,
  value,
  dirty,
  children,
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
  /** The live faces. Receives the focus so it can draw the hairline frame. */
  preview: (focus: Focus) => ReactNode;
  /**
   * The block that closes the rail below the six chapters — Sard's firewall, which states once what
   * a profile does NOT carry. It is not a chapter and must never become one, so it arrives as a slot
   * rather than a seventh entry in CHAPTERS.
   */
  railFooter?: ReactNode;
}) {
  const { t, dir } = useI18n();
  const open = CHAPTERS.find((c) => c.id === active) ?? CHAPTERS[0];

  return (
    <div className="pfe" dir={dir}>
      {/* The whole Profile at a glance: six names, six values, a dot on anything moved. */}
      <nav className="pfe-rail" aria-label={t("profiles.editor.chapters")}>
        {CHAPTERS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`pfe-rail-item${c.id === active ? " is-open" : ""}`}
            aria-current={c.id === active ? "true" : undefined}
            onClick={() => onSelect(c.id)}
          >
            <span className="pfe-rail-name">
              {t(c.name)}
              {dirty(c.id) && <span className="pfe-dot" aria-label={t("profiles.editor.edited")} />}
            </span>
            <span className="pfe-rail-value">{value(c.id)}</span>
          </button>
        ))}
        {/* The wrapper is the rail's flex child, so it is what carries the push to the bottom. */}
        {railFooter && <div className="pfe-rail-foot">{railFooter}</div>}
      </nav>

      {/* One chapter at a time, with room for real specimens. */}
      <section className="pfe-chapter" aria-labelledby="pfe-ch-title">
        <h2 className="pfe-ch-title" id="pfe-ch-title">{t(open.name)}</h2>
        <p className="pfe-ch-q">{t(open.q)}</p>
        <div className="pfe-ch-body">{children}</div>
      </section>

      <aside className="pfe-preview">{preview(FOCUS[open.id])}</aside>
    </div>
  );
}
