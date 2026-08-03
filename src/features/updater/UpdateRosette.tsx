// The Library "check for updates" affordance (RAWY-170) — an illuminated-manuscript ROSETTE (الوردة)
// jewel in the bottom-leading corner of the Library (bottom-left in RTL, mirrored for LTR). Approved
// design: docs/design/Sard Library Update Button v2 (standalone).html → the rosette direction.
//
// THEME-NEUTRAL: every colour is the active theme's `--accent` (currentColor) plus a pale jewel glint —
// no Moonlit-only motifs; it draws Ivory terracotta / Sage green / Moonlit gold alike.
//
// RAWY-290: the rosette keeps its shape and its state machine, but now sits on the OFFICIAL updater
// plugin. Its four visual states map onto the store's states; it owns no update logic itself:
//   • idle       — turns slowly and shimmers at rest
//   • checking   — spins alive while a check (or a download/install) runs
//   • uptodate   — petals settle, a ✓ appears, and a small message says so (explicit tap only)
//   • available  — a quiet accent badge sits at the corner; the DIALOG carries the decision now,
//                  so a tap no longer opens a card of its own
//
// A once-daily auto-check runs on mount (gated in the store via `updater_last_check`); a tap always
// checks now.

import { useEffect } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { useUpdater } from "../../lib/updater";

const PETALS = [0, 1, 2, 3, 4, 5, 6, 7];

export function UpdateRosette() {
  const { t } = useI18n();
  const state = useUpdater((s) => s.state);
  const auto = useUpdater((s) => s.auto);
  const manual = useUpdater((s) => s.manual);
  const dismiss = useUpdater((s) => s.dismiss);

  // Once-daily auto-check on app start (the store gates it; async, so it never blocks the render).
  useEffect(() => {
    auto();
  }, [auto]);

  // "You're using the latest version" is a reassurance, not a notice to dismiss — it eases away.
  useEffect(() => {
    if (state.k !== "uptodate") return;
    const id = setTimeout(() => dismiss(), 4200);
    return () => clearTimeout(id);
  }, [state.k, dismiss]);

  // `downloading`/`installing` keep the rosette spinning: the dialog is doing the talking, and a
  // settled rosette behind a live progress bar would contradict it.
  const visual =
    state.k === "checking" || state.k === "downloading" || state.k === "installing" ? "checking" :
    state.k === "available" ? "available" :
    state.k === "uptodate" ? "uptodate" :
    "idle";

  const label =
    visual === "checking" ? t("updater.checking") :
    visual === "available" ? t("updater.available") :
    visual === "uptodate" ? t("upd.uptodate") :
    t("updater.check");

  const onTap = () => {
    if (state.k === "checking" || state.k === "downloading" || state.k === "installing") return;
    manual();
  };

  return (
    <div className={`upd-rosette is-${visual}`}>
      {/* The one piece of good news the rosette still delivers itself; everything else is the
          dialog's job. `role="status"` so a screen reader hears it without the focus moving. */}
      {state.k === "uptodate" && (
        <div className="upd-latest" role="status" aria-live="polite">
          <span className="upd-latest-tick" aria-hidden>✓</span>
          <span className="upd-latest-text">{t("upd.uptodate")}</span>
          <span className="upd-latest-ver">{localeDigits(state.current)}</span>
        </div>
      )}

      <button type="button" className="upd-rosette-btn" onClick={onTap} aria-label={label} title={label}>
        <svg className="upd-svg" viewBox="0 0 48 48" aria-hidden>
          <circle className="upd-orbit" cx="24" cy="24" r="20.5" fill="none" stroke="currentColor" strokeWidth="1" />
          <g className="upd-petals" fill="currentColor">
            {PETALS.map((i) => (
              <ellipse key={i} cx="24" cy="12.6" rx="3.25" ry="8" transform={`rotate(${i * 45} 24 24)`} />
            ))}
          </g>
          <circle className="upd-core" cx="24" cy="24" r="4.7" fill="currentColor" />
          <circle className="upd-jewel" cx="24" cy="24" r="2.5" />
          <circle className="upd-glint" cx="22.7" cy="22.7" r="0.9" />
          <path
            className="upd-check"
            d="M17.6 24.4 l4.3 4.3 l8.4 -9.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {visual === "available" && <span className="upd-badge" aria-hidden />}
      </button>
    </div>
  );
}
