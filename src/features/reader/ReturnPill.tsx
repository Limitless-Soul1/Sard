import { useI18n } from "../../i18n";
import { releaseButtonFocusAfterPointerClick } from "../../lib/tts";

// RAWY-250 (PART 3) — the RETURN PILL: after a programmatic jump (search hit, highlight/note, TOC entry,
// bookmark) the reader's real position is FROZEN and this pill offers the way back. Two actions, both
// explicit: RETURN (go back to the frozen position) and × (dismiss = "I am reading here now", which THAWS
// the freeze). The freeze is never invisible — that is the whole point of showing it.
//
// VISUAL VOCABULARY: the SKIN comes from `docs/design/Sard Return Button.html` — the single source of truth
// for the appearance (see the `.return-pill` block in global.css for the anatomy and the per-theme tokens).
// It is still built entirely from parts Sard already owns: the accent fill and 7px corner of the dialog
// primary action, the 1px toolbar divider, the UI font at the panel-label weight. NOTHING about the
// behaviour changed with it — same two actions, same callbacks, same show/hide, no dwell timer.
//
// PLACEMENT: TOP of the reader, deliberately far from the read-aloud pill at the bottom, so both can show at
// once without crowding. Like `.tts-pill` it is `position: fixed` — a pure overlay with ZERO layout impact —
// so it cannot reintroduce the RAWY-142 content jump; the top offset simply tracks whether the 70px `.rc-top`
// bar is currently shown (`chromeShown`).
//
// RTL: the whole pill is MIRRORED, not translated — it inherits the UI direction, so the element order
// reverses and the return arrow points the correct way for the reading direction (Arabic: the arrow points
// right, "back" in an RTL flow). The glyph is chosen from the UI direction rather than transformed, so it is
// never a double-mirror (the RAWY-194 transport scar).
//
// IMMERSIVE (owner-approved, D66): this pill is EXEMPT from the immersive hide, exactly like the chapter-end
// and Edge-error prompts (RAWY-213/214) — hiding it would leave a freeze the owner can neither see nor
// dismiss, which is the invisible-state failure this whole design exists to avoid. The exemption is by
// CONSTRUCTION: the `im-hide-pill` rules name `.tts-pill`/`.tts-mini` only, and `.return-pill` is not in them.
export function ReturnPill({
  label,
  chromeShown,
  onReturn,
  onDismiss,
}: {
  /** The chapter label of the frozen position ("الفصل ٤ · اسم الفصل"), or null if the book has none. */
  label: string | null;
  /** Is the 70px top bar currently shown? Drives the pill's top offset so it never collides with it. */
  chromeShown: boolean;
  onReturn: () => void;
  onDismiss: () => void;
}) {
  const { t, dir } = useI18n();
  // The arrow points "back along the reading direction": left in LTR, right in RTL. The PATH is chosen, never
  // transformed — so it can never be a double-mirror (the RAWY-194 transport scar).
  const arrow = dir === "rtl" ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7";
  return (
    <div
      className={`return-pill${chromeShown ? " below-chrome" : ""}`}
      dir={dir}
      role="status"
      onClickCapture={releaseButtonFocusAfterPointerClick}
    >
      <button className="return-pill-main" onClick={onReturn} title={t("anchor.returnAria")} aria-label={t("anchor.returnAria")}>
        <span className="return-pill-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d={arrow} /></svg>
        </span>
        <span className="return-pill-text">
          <span className="return-pill-lead">{t("anchor.return")}</span>
          {label && <span className="return-pill-chapter" dir="auto">{label}</span>}
        </span>
      </button>
      <button className="return-pill-x" onClick={onDismiss} title={t("anchor.dismiss")} aria-label={t("anchor.dismiss")}>
        ✕
      </button>
    </div>
  );
}
