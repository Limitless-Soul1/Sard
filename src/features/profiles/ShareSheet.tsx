// FRAME 10 — "What is included?", and FRAME 12 — that it was packed.
//
// A package is one file the reader sends however they like. No account, no server, no gallery. The
// sheet's job is that the size at the bottom is never a surprise: every row states what it
// contributes, so nothing travels that the reader did not see listed.
//
// SETTINGS ONLY, AND THE SHEET SAYS SO RATHER THAN PRETENDING. Three of the design's four share
// screens depend on assets that do not travel yet:
//
//   · frame 10's image / icon / font ROWS — there are no asset rows to list, so the sheet lists what
//     a settings-only package actually carries and nothing else. Inventing switches for things that
//     cannot be excluded would be a lie in the reader's favour.
//   · frame 10's font-licensing row — deliberately absent. Sard does not determine or enforce
//     redistribution rights (owner decision): the reader is responsible for what they share, and a
//     row claiming Sard checked would be untrue.
//   · frame 11's PROGRESS — a settings-only package is a couple of kilobytes and is written in one
//     go. A progress bar for that is theatre, and theatre in a place that will later carry a real
//     measurement is worse than none. It arrives with the images it would be measuring.
//   · frame 13's HEAVY PACKAGE screen — nothing here can be heavy yet.
//
// THE PAPER AND COLOURS HAVE NO SWITCH. The design is explicit, and it is right: a profile without
// them is not a profile.

import { useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { profileExport } from "../../lib/ipc";
import { manifestText, serialiseProfile } from "./model/package";
import type { Profile } from "./model/profile";

/** A filename a reader can recognise in a downloads folder, from a name that may be any script. */
function fileNameFor(p: Profile): string {
  const base = (p.name ?? "").trim().replace(/[\\/:*?"<>|]+/g, "").slice(0, 40);
  return `${base || "profile"}.sardprofile`;
}

export function ShareSheet({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The exact bytes that will be written, computed now so the size shown is measured rather than
  // estimated — the design's promise is that the number at the bottom is not a surprise.
  const text = manifestText(serialiseProfile(profile, "sard"));
  const bytes = new TextEncoder().encode(text).length;
  const kb = Math.max(1, Math.round(bytes / 1024));

  const rows: { key: string; note: string }[] = [
    { key: t("profiles.share.row.paper"), note: t("profiles.share.row.paperNote") },
    { key: t("profiles.share.row.fonts"), note: t("profiles.share.row.fontsNote") },
    { key: t("profiles.share.row.marks"), note: t("profiles.share.row.marksNote") },
  ];

  const doExport = async () => {
    setError(null);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      defaultPath: fileNameFor(profile),
      filters: [{ name: "Sard profile", extensions: ["sardprofile"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await profileExport(picked, text);
      setDone(picked);
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("pkg.err.") ? t(code as never) : code);
    } finally {
      setBusy(false);
    }
  };

  // FRAME 12 — packed, and where it went.
  if (done) {
    return createPortal(
      <div className="pf-dialog-scrim" onClick={onClose}>
        <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <div className="pf-dialog-title">
            {t("profiles.share.packed", { name: profile.name ?? "" })}
          </div>
          <div className="pf-share-file" dir="ltr">{done}</div>
          <p className="pf-dialog-body">{t("profiles.share.sendIt")}</p>
          <div className="pf-dialog-actions">
            <button
              className="pf-btn"
              onClick={() => {
                void navigator.clipboard.writeText(done).then(() => setCopied(true));
              }}
            >
              {copied ? t("profiles.share.copied") : t("profiles.share.copyPath")}
            </button>
            <button className="pf-btn primary" onClick={onClose}>
              {t("profiles.share.close")}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // FRAME 10 — what is included.
  return createPortal(
    <div className="pf-dialog-scrim" onClick={onClose}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">
          {t("profiles.share.title", { name: profile.name ?? "" })}
        </div>
        <p className="pf-dialog-body">{t("profiles.share.sub")}</p>

        <div className="pf-share-rows">
          {rows.map((r) => (
            <div className="pf-share-row" key={r.key}>
              <span className="pf-share-row-text">
                <span className="pf-share-row-name">{r.key}</span>
                <span className="pf-share-row-note">{r.note}</span>
              </span>
              {/* No switch. A profile without its paper is not a profile, and nothing else here can
                  be excluded either while a package carries settings alone. */}
              <span className="pf-share-always">{t("profiles.share.always")}</span>
            </div>
          ))}
        </div>

        <div className="pf-share-size">
          <span>{t("profiles.share.size")}</span>
          <span className="pf-share-size-v">
            {t("profiles.share.kb", { n: localeDigits(String(kb), lang) })}
          </span>
        </div>

        {error && <div className="pf-contrast warn">{error}</div>}

        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={onClose}>{t("profiles.theme.cancel")}</button>
          <button className="pf-btn primary" disabled={busy} onClick={() => void doExport()}>
            {busy ? t("profiles.share.packing") : t("profiles.share.export")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
