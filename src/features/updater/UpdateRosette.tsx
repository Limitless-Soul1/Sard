// The Library "check for updates" affordance (RAWY-170) — an illuminated-manuscript ROSETTE (الوردة)
// jewel in the bottom-leading corner of the Library (bottom-left in RTL, mirrored for LTR). Approved
// design: docs/design/Sard Library Update Button v2 (standalone).html → the rosette direction.
//
// THEME-NEUTRAL: every colour is the active theme's `--accent` (currentColor) plus a pale jewel glint —
// no Moonlit-only motifs; it draws Ivory terracotta / Sage green / Moonlit gold alike.
//
// FOUR STATES (driven by `useUpdater`, RAWY-170, reusing the RAWY-168 check):
//   • idle       — the rosette turns slowly and shimmers at rest.
//   • checking   — it spins alive while a check runs.
//   • uptodate   — petals settle and a check ✓ appears (only after an explicit tap).
//   • available  — a quiet accent badge (dot + soft halo) sits at the corner + a faint orbit ring; a
//                  tap opens a small card (version + open the release page externally).
//
// A once-daily auto-check runs on mount (gated in the store via `updater_last_check`); a tap always
// checks now. Network is Rust-side (RAWY-64 posture); this only opens the release URL in the OS browser.

import { useEffect, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { useI18n } from "../../i18n";
import { useUpdater } from "../../lib/updater";

const PETALS = [0, 1, 2, 3, 4, 5, 6, 7];

export function UpdateRosette() {
  const { t } = useI18n();
  const state = useUpdater((s) => s.state);
  const ver = useUpdater((s) => s.ver);
  const url = useUpdater((s) => s.url);
  const notes = useUpdater((s) => s.notes);
  const auto = useUpdater((s) => s.auto);
  const manual = useUpdater((s) => s.manual);
  const dismiss = useUpdater((s) => s.dismiss);
  const [cardOpen, setCardOpen] = useState(false);

  // Once-daily auto-check on app start (the store gates it; async, so it never blocks the render).
  useEffect(() => {
    auto();
  }, [auto]);

  // After a manual check, a settled "up to date" / quiet "couldn't check" eases back to idle.
  useEffect(() => {
    if (state === "uptodate" || state === "unavailable") {
      const id = setTimeout(() => dismiss(), 4200);
      return () => clearTimeout(id);
    }
  }, [state, dismiss]);

  // The card only makes sense while an update is available.
  useEffect(() => {
    if (state !== "available") setCardOpen(false);
  }, [state]);

  const onTap = () => {
    if (state === "available") {
      setCardOpen((o) => !o);
      return;
    }
    if (state === "checking") return;
    manual();
  };

  const label =
    state === "checking" ? t("updater.checking") :
    state === "available" ? t("updater.available") :
    state === "uptodate" ? t("gs.update.uptodate", { v: ver }) :
    t("updater.check");

  return (
    <div className={`upd-rosette is-${state}`}>
      {cardOpen && state === "available" && (
        <div className="upd-card" role="dialog" aria-label={t("updater.available")}>
          <div className="upd-card-title">{t("gs.update.available", { v: ver })}</div>
          {notes && <div className="upd-card-notes">{notes}</div>}
          <div className="upd-card-actions">
            <button className="upd-card-go" onClick={() => url && openUrl(url).catch(() => {})}>
              {t("gs.update.get")}
            </button>
            <button className="upd-card-later" onClick={() => setCardOpen(false)}>
              {t("gs.update.later")}
            </button>
          </div>
        </div>
      )}
      <button className="upd-rosette-btn" onClick={onTap} aria-label={label} title={label}>
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
        {state === "available" && <span className="upd-badge" aria-hidden />}
      </button>
    </div>
  );
}
