// RESILIENCE-1 / WP-5C — the voice-compatibility card.
//
// PRESENTATION ONLY. Every behaviour is the caller's: this component decides nothing, classifies
// nothing and stores nothing. It receives three handlers and renders them with hierarchy.
//
// WHY IT IS NOT IN THE PILL. It used to render as a row inside the ~330px transport pill, beside the
// Edge-unavailable state. At that width a title, a reason and two actions can only be squeezed onto
// one line each, which is exactly what made it read as a developer popup: no hierarchy, no
// whitespace, and both actions the same weight. The pill is a TRANSPORT — play, pause, speed — and a
// decision the reader must make before anything can happen does not belong inside a transport.
//
// WHY IT INTERRUPTS. The reader pressed Listen and nothing will play until they choose, so a quiet
// inline note would be dishonest about the state. It does NOT take the window (the book stays
// visible and readable behind a soft scrim) because only listening failed — the ErrorCard's
// full-window treatment is reserved for a book that cannot be opened at all.
//
// THE THREE QUESTIONS, in reading order:
//   1. WHAT happened  — the title names the voice and the script, not the subsystem.
//   2. WHY            — one sentence, in plain language, with the consequence stated ("silence").
//   3. WHAT NEXT      — one obvious primary action; the escape hatch present but quiet.

import { useI18n } from "../../i18n";
import type { BookScript } from "../../lib/voiceCompat";

/** A speaker with the waves struck through — "this voice will not sound", drawn rather than emoji. */
const MutedVoice = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </svg>
);

export function VoiceMismatchCard({
  voiceName,
  bookScript,
  onChoose,
  onUseAnyway,
  onDismiss,
}: {
  /** The voice's friendly label, already resolved by the caller (`voiceLabel`). */
  voiceName: string;
  /** Which script the book is in — used only to phrase the sentence, never to decide anything. */
  bookScript: BookScript;
  onChoose: () => void;
  onUseAnyway: () => void;
  onDismiss: () => void;
}) {
  const { t, dir } = useI18n();
  // The script's name in the reader's own language. `arabic` is the only script the measurements
  // cover, so it is the only one named; anything else falls back to the generic phrasing rather
  // than inventing a label for a script nobody measured.
  const script = bookScript === "arabic" ? t("tts.mismatch.scriptArabic") : t("tts.mismatch.scriptOther");

  return (
    // `role="dialog"` + the label makes this a real dialog to a screen reader, which the pill row it
    // replaces never was. The scrim is a sibling, not a wrapper, so a click on it dismisses without
    // the card having to stop propagation.
    <div className="vm-scrim" onClick={onDismiss} role="presentation">
      <div
        className="vm-card"
        dir={dir}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vm-title"
        aria-describedby="vm-body"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="vm-mark" aria-hidden>
          <MutedVoice />
        </span>

        <h2 className="vm-title" id="vm-title" dir="auto">
          {t("tts.mismatch.title", { voice: voiceName })}
        </h2>

        <p className="vm-body" id="vm-body" dir="auto">
          {t("tts.mismatch.body", { voice: voiceName, script })}
        </p>

        <div className="vm-actions">
          {/* PRIMARY: the only action that solves the problem. Solid accent, first in reading order,
              and wider than the escape hatch so the choice is obvious at a glance rather than after
              reading both labels. */}
          <button className="vm-btn vm-primary" onClick={onChoose} autoFocus>
            {t("tts.mismatch.choose")}
          </button>
          {/* SECONDARY: deliberately quiet — a bare label, no border, no fill. It must EXIST (RAWY-197
              removed the picker's language filter on purpose, and D37 says Sard warns and obeys), but
              it must not compete: it leads to silence, which is never what the reader wants. */}
          <button className="vm-btn vm-quiet" onClick={onUseAnyway}>
            {t("tts.mismatch.anyway")}
          </button>
        </div>

        <button className="vm-x" onClick={onDismiss} aria-label={t("tts.close")} title={t("tts.close")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
