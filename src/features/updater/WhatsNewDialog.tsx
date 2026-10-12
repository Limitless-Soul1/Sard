// WHAT'S NEW, ONCE, AFTER AN UPDATE.
//
// The first launch of a new version shows that version's own notes — the same sections the release
// published — in the update dialog's surface, so the moment reads as the end of the update rather than
// as something new. One action. Closing it in any way records the version (`afterUpdate.ts`); it is not
// shown again for this version, and the next version that brings notes shows them again.
//
// It waits while the update dialog itself is open: one dialog at a time.

import { useEffect, useRef } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { useUpdater } from "../../lib/updater";
import { useAfterUpdate } from "./afterUpdate";
import { WHATS_NEW } from "./whatsNew";

export function WhatsNewDialog() {
  const { t, dir } = useI18n();
  const open = useAfterUpdate((s) => s.open);
  const version = useAfterUpdate((s) => s.version);
  const check = useAfterUpdate((s) => s.check);
  const confirm = useAfterUpdate((s) => s.confirm);
  const updating = useUpdater(
    (s) => s.state.k === "available" || s.state.k === "downloading" || s.state.k === "installing" || s.state.k === "error",
  );
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void check();
  }, [check]);

  const show = open && !updating && !!version;

  useEffect(() => {
    if (show) primaryRef.current?.focus();
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void confirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [show, confirm]);

  if (!show || !version) return null;

  return (
    <>
      <div className="upd-scrim" onClick={() => void confirm()} />
      <div className="upd-dialog" role="dialog" aria-modal="true" aria-labelledby="wn-dlg-title">
        <div className="upd-dlg-eyebrow">{t("upd.eyebrow")}</div>
        <h2 className="upd-dlg-title" id="wn-dlg-title">{t("upd.after.title", { v: localeDigits(version) })}</h2>
        <div className="upd-notes">
          <div className="upd-notes-body upd-notes-local" dir={dir}>
            {WHATS_NEW.map((s) => (
              <section className="upd-note" key={s.h}>
                <h3 className="upd-note-h">{t(s.h)}</h3>
                <p className="upd-note-b">{t(s.b)}</p>
              </section>
            ))}
          </div>
        </div>
        <div className="upd-dlg-actions">
          <button className="upd-btn upd-btn-primary" ref={primaryRef} onClick={() => void confirm()}>
            {t("upd.after.ok")}
          </button>
        </div>
      </div>
    </>
  );
}
