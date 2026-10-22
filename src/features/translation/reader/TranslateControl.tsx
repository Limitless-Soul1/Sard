// The reader's translation control, in the toolbar's right-hand cluster: Translate, and — once the book has a
// translation — the switch between the original and the translation. "Translating…" while a job runs; there is no
// progress bar, pause or cancel in this phase.

import { useState } from "react";

import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n";
import type { ReaderStatus } from "./api";
import type { Mode, Notice } from "./useBookTranslation";

export function TranslateControl({
  status,
  mode,
  starting,
  onMode,
  onTranslate,
}: {
  status: ReaderStatus | null;
  mode: Mode;
  starting: boolean;
  onMode: (m: Mode) => void;
  onTranslate: () => void;
}) {
  const { t } = useI18n();
  if (!status || (!status.supported && !status.edition)) return null;
  const edition = status.edition;
  const working = starting || status.translating;
  // Translate starts a book, or goes on with one a job left unfinished; never twice at once.
  const offerTranslate = status.supported && !working && (!edition || edition.pending > 0);
  return (
    <div className="rc-tr">
      {edition && (
        <div className="rc-tr-col">
          <div className="rc-tr-switch" role="group">
            {(["original", "translation"] as const).map((m) => (
              <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => onMode(m)}>
                {t(m === "original" ? "translation.reader.original" : "translation.reader.translation")}
              </button>
            ))}
          </div>
          <span className="rc-btn-label rc-tr-status">{working ? t("translation.reader.translating") : " "}</span>
        </div>
      )}
      {offerTranslate && (
        <button className="rc-btn" type="button" onClick={onTranslate} title={t("translation.reader.translate")} disabled={status.translatingOther}>
          <span className="rc-btn-ico">
            <Icon name="navReplacements" />
          </span>
          <span className="rc-btn-label">{t("translation.reader.translate")}</span>
        </button>
      )}
      {!edition && working && <span className="rc-btn-label rc-tr-status rc-tr-alone">{t("translation.reader.translating")}</span>}
    </div>
  );
}

/** A refusal or a failure, said once at the foot of the page, quietly, with the technical text behind Details. */
export function TranslationNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!notice) return null;
  return (
    <div className="tr-reader-notice" role="status">
      <span className="tr-reader-notice-text">{t(notice.key)}</span>
      {notice.detail && (
        <button type="button" className="tr-reader-notice-act" onClick={() => setOpen((o) => !o)}>
          {open ? t("err.act.hideDetails") : t("err.act.details")}
        </button>
      )}
      <button type="button" className="tr-reader-notice-x" onClick={onDismiss} aria-label={t("rep.dismiss")} title={t("rep.dismiss")}>
        ✕
      </button>
      {open && notice.detail && <pre className="tr-reader-notice-detail">{notice.detail}</pre>}
    </div>
  );
}
