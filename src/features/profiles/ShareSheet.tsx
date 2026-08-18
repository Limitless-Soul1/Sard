// FRAME 10 — "What is included?", and FRAME 12 — that it was packed.
//
// A package is one file the reader sends however they like. No account, no server, no gallery. The
// sheet's job is that the size at the bottom is never a surprise: every row states what it
// contributes, so nothing travels that the reader did not see listed.
//
// WHAT IT LISTS IS WHAT THIS PROFILE HAS. The rows are not a transcription of the design's example
// profile: they are the settings every package carries, plus one row per asset the plan actually
// found on disk — its picture, its icon, its imported face — each priced in real bytes and each with
// a switch. A profile with no image and no imported font shows the settings rows and no switches at
// all, which is the truth about it rather than a reduced copy of the drawing.
//
// The design's font-LICENSING row stays absent. Sard does not determine or enforce redistribution
// rights (owner decision): the reader is responsible for what they share, and a row claiming Sard
// checked would be untrue. The switch is what serves that — a font can be left behind.
//
// Frames 11 (progress) and 13 (a heavy package) are still not here. They measure a long write, and
// whether one is possible now depends on a ceiling nobody has set; adding either before that number
// exists would be theatre in the place a real measurement belongs.
//
// THE PAPER AND COLOURS HAVE NO SWITCH. The design is explicit, and it is right: a profile without
// them is not a profile.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { profileAssetPlan, profileExport, type PlannedAsset } from "../../lib/ipc";
import { manifestText, serialiseProfile, type PackageAsset } from "./model/package";
import { profileRefs } from "./model/profile";
import type { Profile } from "./model/profile";

/**
 * A filename a reader can recognise in a downloads folder, from a name that may be any script.
 *
 * `.zip`, NOT a private extension. The package always WAS a zip; the custom suffix only hid that
 * from the operating system, from the reader, and from every tool that already knows how to open
 * one. The safety was never in the extension — it is in the validation the import path performs, and
 * that is unchanged.
 */
function fileNameFor(p: Profile): string {
  const base = (p.name ?? "").trim().replace(/[\\/:*?"<>|]+/g, "").slice(0, 40);
  return `${base || "profile"}.zip`;
}

export function ShareSheet({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // What CAN travel, resolved by Rust from this profile's own refs. Assets default to ON: the reader
  // asked to share the profile, and its picture is part of it — excluding is the deliberate act.
  const [plan, setPlan] = useState<PlannedAsset[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const refs = profileRefs(profile);
    const families = [profile.data.type.arabic, profile.data.type.latin, profile.data.type.ui]
      .filter((f): f is string => typeof f === "string" && f.trim() !== "");
    profileAssetPlan(refs.bgLibrary, refs.bgReading, profile.iconKind === "image" ? profile.iconRef : null, families)
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan([]));
    return () => { alive = false; };
  }, [profile]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The exact bytes that will be written, computed now so the size shown is measured rather than
  // estimated — the design's promise is that the number at the bottom is not a surprise.
  const included = useMemo(() => (plan ?? []).filter((a) => !off.has(a.member)), [plan, off]);
  const claims: PackageAsset[] = included.map((a) => ({
    kind: a.kind, id: a.id, member: a.member, name: a.name,
    bytes: a.bytes, family: a.family, surfaces: a.surfaces,
  }));
  const text = manifestText(serialiseProfile(profile, "sard", claims));
  const bytes = new TextEncoder().encode(text).length;
  // The archive is the manifest PLUS the assets, and the plan already holds one entry per distinct
  // file — so a picture serving two surfaces is counted once here exactly as it is packed once.
  const total = bytes + included.reduce((n, a) => n + a.bytes, 0);
  const sizeLabel = total >= 1024 * 1024
    ? t("profiles.share.mb", { n: localeDigits((total / (1024 * 1024)).toFixed(1), lang) })
    : t("profiles.share.kb", { n: localeDigits(String(Math.max(1, Math.round(total / 1024))), lang) });
  const assetSize = (a: PlannedAsset) =>
    a.bytes >= 1024 * 1024
      ? t("profiles.share.mb", { n: localeDigits((a.bytes / (1024 * 1024)).toFixed(1), lang) })
      : t("profiles.share.kb", { n: localeDigits(String(Math.max(1, Math.round(a.bytes / 1024))), lang) });

  // THE ROWS ARE WHAT THIS PROFILE ACTUALLY HAS. Two kinds sit in one list:
  //
  //   · SETTINGS rows, which cannot be excluded and cost nothing — a profile without its paper is
  //     not a profile, and its marks are values rather than files.
  //   · ASSET rows, one per thing the plan found on disk, each priced in real bytes and each with a
  //     switch, because these are the only things whose absence still leaves a profile behind.
  //
  // A profile with no image and no imported font therefore shows exactly the settings rows and no
  // switches at all — which is the truth about it, not a reduced version of the design.
  const settingRows = [
    { key: t("profiles.share.row.paper"), note: t("profiles.share.row.paperNote") },
    { key: t("profiles.share.row.marks"), note: t("profiles.share.row.marksNote") },
  ];

  const labelFor = (a: PlannedAsset): { name: string; note: string } => {
    if (a.kind === "font") {
      return { name: t("profiles.share.row.fonts"), note: `${a.name} · ${t("profiles.share.fontsNoteCustom")}` };
    }
    if (a.kind === "icon") return { name: t("profiles.share.row.icon"), note: a.name };
    const both = a.surfaces.includes("library") && a.surfaces.includes("reading");
    const name = a.surfaces.includes("library")
      ? t("profiles.share.row.libraryBg")
      : t("profiles.share.row.bookBg");
    return { name, note: both ? `${a.name} · ${t("profiles.share.sameImage")}` : a.name };
  };

  const doExport = async () => {
    setError(null);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      defaultPath: fileNameFor(profile),
      filters: [{ name: "Sard profile", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await profileExport(picked, text, included.map((a) => ({ member: a.member, source: a.source })));
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
          {settingRows.map((r) => (
            <div className="pf-share-row" key={r.key}>
              <span className="pf-share-row-text">
                <span className="pf-share-row-name">{r.key}</span>
                <span className="pf-share-row-note">{r.note}</span>
              </span>
              <span className="pf-share-row-size">{t("profiles.share.noSize")}</span>
              {/* No switch, and the design is explicit about why: a profile without its paper is not
                  a profile, and its marks are values rather than files. */}
              <span className="pf-share-always">{t("profiles.share.always")}</span>
            </div>
          ))}

          {(plan ?? []).map((a) => {
            const { name, note } = labelFor(a);
            const on = !off.has(a.member);
            return (
              <div className="pf-share-row" key={a.member}>
                <span className="pf-share-row-text">
                  <span className="pf-share-row-name">{name}</span>
                  <span className="pf-share-row-note">{on ? note : t("profiles.share.excluded")}</span>
                </span>
                <span className="pf-share-row-size">{assetSize(a)}</span>
                <button
                  className={`pf-switch-ctl${on ? " on" : ""}`}
                  role="switch"
                  aria-checked={on}
                  aria-label={name}
                  onClick={() =>
                    setOff((cur) => {
                      const next = new Set(cur);
                      if (next.has(a.member)) next.delete(a.member);
                      else next.add(a.member);
                      return next;
                    })
                  }
                >
                  <i />
                </button>
              </div>
            );
          })}
        </div>

        <div className="pf-share-size">
          <span>{t("profiles.share.size")}</span>
          <span className="pf-share-size-v">{sizeLabel}</span>
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
