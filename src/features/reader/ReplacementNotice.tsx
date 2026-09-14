import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { useReplacements } from "./replacementsStore";

// SAYING SO. A reader who does not know a rule is in force reads a changed book and believes the author
// wrote it that way — which is the one outcome this feature must never produce. So while anything is
// being substituted, the reader is told, in the book, in plain words.
//
// It is deliberately QUIET rather than loud: a single line at the foot of the page, dismissible, and it
// never covers the text. Loud would be worse than useless — a banner the reader learns to ignore stops
// informing them, and this has to keep working on the hundredth page as well as the first.
//
// It reappears whenever the RULE SET changes, because "I dismissed this" means "I know about these
// rules", not "never tell me again". Turning a new rule on is new information.
export function ReplacementNotice({ onManage }: { onManage?: () => void }) {
  const { t } = useI18n();
  const reps = useReplacements((s) => s.reps);
  const active = reps.filter((r) => r.enabled && r.replacement.length > 0);
  // The identity of the active set, so dismissing survives a re-render but not a change of mind.
  const key = active.map((r) => r.id).sort().join(",");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(null), [key]);

  if (!active.length || dismissed === key) return null;

  const n = active.length;
  const label =
    n === 1
      ? t("rep.activeOne")
      : n === 2
        ? t("rep.activeTwo")
        : n <= 10
          ? t("rep.activeMany", { n: String(n) })
          : t("rep.activeManyM", { n: String(n) });

  return (
    <div className="rep-notice" role="status">
      <span className="rep-notice-dot" aria-hidden />
      <span className="rep-notice-text">{label}</span>
      <span className="rep-notice-hint">{t("rep.activeHint")}</span>
      {onManage && (
        <button type="button" className="rep-notice-act" onClick={onManage}>{t("rep.manage")}</button>
      )}
      <button
        type="button"
        className="rep-notice-x"
        onClick={() => setDismissed(key)}
        aria-label={t("rep.dismiss")}
        title={t("rep.dismiss")}
      >
        ✕
      </button>
    </div>
  );
}
