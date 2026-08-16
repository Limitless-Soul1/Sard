// The Profiles area — a section of Global Settings, per the design.
//
// "Global Settings is already the sovereign surface for app-wide appearance — the bookmark and the
// read marker live there today. Profiles take a nav row beside them."
//
// NOTHING ELSE IN GLOBAL SETTINGS MOVES. The design package draws a restructured settings window
// (seven rows, Fonts and Bookmark gone, three new entries); that restructure is not this feature and
// is not implemented. One row is added, and the sections that already exist keep working exactly as
// they did — which is also what keeps this stage inert for anyone who never opens it.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { bgSrcUrl } from "../../lib/background";
import { backgroundsList, type BackgroundRow } from "../../lib/ipc";
import { THEMES, THEME_ORDER, isBuiltinThemeId } from "../../theme/themes";
import type { BuiltinThemeId } from "../../theme/tokens";

/** The design's three: how Sard looks now, one of the sixteen, or a paper of your own. */
type StartFrom = "current" | "theme" | "custom";
import { SardMini } from "./SardMini";
import { miniOfTheme } from "./mini";
import { ProfileCard } from "./ProfileCard";
import { ShareSheet } from "./ShareSheet";
import { ImportSheet } from "./ImportSheet";
import { profileChangePending } from "./session";
import { ProfileEditor } from "./ProfileEditor";
import {
  applyProfile,
  captureCurrent,
  createProfile,
  duplicateProfile,
  removeProfile,
  useProfiles,
} from "./store";
import type { Profile } from "./model/profile";

type Dialog =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "share"; profile: Profile }
  | { kind: "import" }
  | { kind: "delete"; profile: Profile }
  // `fresh` marks a profile that has just been made, so the editor opens on its identity
  // rather than on its colours — the name is the unanswered question.
  | { kind: "edit"; profile: Profile; fresh?: boolean };

export function ProfilesSection() {
  const { t, lang } = useI18n();
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [busy, setBusy] = useState(false);

  // The managed rows, so a card can draw an image icon. Re-read whenever the profile list changes,
  // because the only way a new icon reaches a card is a profile being saved with one.
  const [bgRows, setBgRows] = useState<BackgroundRow[]>([]);
  useEffect(() => {
    let alive = true;
    backgroundsList()
      .then((r) => alive && setBgRows(r))
      .catch(() => undefined);
    return () => { alive = false; };
  }, [profiles]);
  const iconUrlOf = (p: Profile): string | null => {
    if (p.iconKind !== "image" || !p.iconRef) return null;
    const row = bgRows.find((r) => r.id === p.iconRef);
    return row ? bgSrcUrl(row) : null;
  };
  /** A card's own library image, so the miniature on it is the picture the profile actually makes. */
  const libUrlOf = (p: Profile): string | null => {
    const row = p.data.bg.library.ref ? bgRows.find((r) => r.id === p.data.bg.library.ref) : null;
    return row ? bgSrcUrl(row) : null;
  };

  const num = (n: number) => localeDigits(String(n), lang);

  const themeNameOf = (p: Profile): string => {
    const base = p.data.theme.base;
    return isBuiltinThemeId(base) ? t(`theme.${base}`) : t("profiles.theme.custom");
  };

  const create = async (name: string, start: StartFrom, base: BuiltinThemeId) => {
    setBusy(true);
    try {
      const data = await captureCurrent();
      if (start !== "current") {
        // Start from one of the sixteen. "A paper of your own" also begins here — it opens the
        // editor on this base, where the custom-paper dialog and its four previews live, rather
        // than making the reader choose colours before the profile exists.
        data.theme.base = base;
        data.theme.dark = THEMES[base].dark;
        data.theme.colors = structuredClone(THEMES[base].colors);
        data.theme.highlightAlpha = THEMES[base].highlightAlpha;
        data.theme.bookmark = null;
      }
      const p = await createProfile(name, data, start === "current" ? null : base);
      await applyProfile(p);
      setDialog({ kind: "edit", profile: p, fresh: true });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (p: Profile) => {
    const name = t("profiles.duplicateSuffix", { name: p.name ?? "—" });
    const copy = await duplicateProfile(p, name);
    setDialog({ kind: "edit", profile: copy, fresh: true });
  };

  const remove = async (p: Profile) => {
    await removeProfile(p, "ivory");
    setDialog({ kind: "none" });
  };

  return (
    <>
      <div className="gs-h1">{t("profiles.title")}</div>
      <div className="gs-note">{t("profiles.subtitle")}</div>

      <div className="pf-actions">
        <button className="pf-btn primary" disabled={busy} onClick={() => setDialog({ kind: "create" })}>
          {t("profiles.new")}
        </button>
        {/* Import arrives with the package format (a later stage). Shown disabled rather than
            hidden, because the design's list has it and a control that appears later moves the
            furniture under the reader. */}
        <button className="pf-btn" onClick={() => { if (!profileChangePending()) setDialog({ kind: "import" }); }}>
          {t("profiles.import")}
        </button>
        {profiles.length > 0 && (
          <span className="pf-count">{t("profiles.count", { n: num(profiles.length) })}</span>
        )}
      </div>

      {profiles.length === 0 ? (
        <FirstRun onImport={() => { if (!profileChangePending()) setDialog({ kind: "import" }); }} onCreate={() => setDialog({ kind: "create" })} />
      ) : (
        <div className="pf-grid">
          {profiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              active={p.id === activeId}
              themeName={themeNameOf(p)}
              iconUrl={iconUrlOf(p)}
              libUrl={libUrlOf(p)}
              actions={{
                onUse: () => void applyProfile(p),
                onEdit: () => setDialog({ kind: "edit", profile: p }),
                onDuplicate: () => void duplicate(p),
                onShare: () => { if (!profileChangePending()) setDialog({ kind: "share", profile: p }); },
                onDelete: () => setDialog({ kind: "delete", profile: p }),
              }}
            />
          ))}
        </div>
      )}

      {dialog.kind === "create" && (
        <CreateDialog busy={busy} onCancel={() => setDialog({ kind: "none" })} onCreate={create} />
      )}
      {dialog.kind === "delete" && (
        <DeleteDialog
          profile={dialog.profile}
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => void remove(dialog.profile)}
        />
      )}
      {dialog.kind === "import" && (
        <ImportSheet
          onClose={() => setDialog({ kind: "none" })}
          onEdit={(p) => setDialog({ kind: "edit", profile: p })}
        />
      )}

      {dialog.kind === "share" && (
        <ShareSheet profile={dialog.profile} onClose={() => setDialog({ kind: "none" })} />
      )}

      {dialog.kind === "edit" && (
        <ProfileEditor
          profile={dialog.profile}
          fresh={dialog.fresh}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
    </>
  );
}

/**
 * First run — absence drawn, not described.
 *
 * The design: "The empty state shows the default Sard as a miniature … with a mark, a title, one
 * sentence and two real actions." So the reader sees what Sard looks like right now, and the
 * reassurance that making a profile costs them nothing.
 */
function FirstRun({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const { t } = useI18n();
  return (
    <div className="pf-empty">
      <div className="pf-empty-mini">
        <SardMini p={miniOfTheme(THEMES.ivory, "سَرْد")} />
      </div>
      <div className="pf-empty-title">{t("profiles.empty.title")}</div>
      <p className="pf-empty-body">{t("profiles.empty.body")}</p>
      <div className="pf-empty-actions">
        <button className="pf-btn primary" onClick={onCreate}>
          {t("profiles.new")}
        </button>
        <button className="pf-btn" onClick={onImport}>
          {t("profiles.import")}
        </button>
      </div>
      <div className="pf-empty-reassure">{t("profiles.empty.reassure")}</div>
    </div>
  );
}

/** New profile: a name, and where it starts from. */
function CreateDialog({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string, start: StartFrom, base: BuiltinThemeId) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [start, setStart] = useState<StartFrom>("current");
  const [base, setBase] = useState<BuiltinThemeId>("ivory");
  // Portalled for the same reason the editor is: `.gs` carries a transform, which makes it the
  // containing block for `position: fixed`, so a dialog rendered in place is centred on the
  // settings window and clipped by its `overflow: hidden` rather than centred on Sard.
  return createPortal(
    <div className="pf-dialog-scrim" onClick={onCancel}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">{t("profiles.create.title")}</div>

        <label className="pf-field">
          <span className="pf-field-label">{t("profiles.create.name")}</span>
          <input
            className="pf-input"
            value={name}
            autoFocus
            dir="auto"
            placeholder={t("profiles.create.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && onCreate(name, start, base)}
          />
        </label>

        {/* "Start from" — the design's three. The third opens the custom-paper dialog from inside
            the editor, which is where the four harmonies and their previews live. */}
        <div className="pf-field">
          <span className="pf-field-label">{t("profiles.create.startFrom")}</span>
          <div className="pf-startfrom-list" role="radiogroup">
            {(["current", "theme", "custom"] as const).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={start === k}
                className={`pf-startfrom-opt${start === k ? " on" : ""}`}
                onClick={() => setStart(k)}
              >
                {k === "current"
                  ? t("profiles.create.fromCurrent")
                  : k === "theme"
                    ? t("profiles.create.fromTheme")
                    : t("profiles.theme.custom")}
              </button>
            ))}
          </div>
          {start === "theme" && (
            <div className="pf-swatches pf-startfrom-swatches">
              {THEME_ORDER.map((id) => (
                <button
                  key={id}
                  className={`pf-swatch-cell${base === id ? " on" : ""}`}
                  onClick={() => setBase(id)}
                  title={t(`theme.${id}`)}
                >
                  <span
                    className="pf-swatch"
                    style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
                  >
                    Aa
                  </span>
                  <span className="pf-swatch-name">{t(`theme.${id}`)}</span>
                </button>
              ))}
            </div>
          )}
          {start === "custom" && (
            <div className="pf-hint">{t("profiles.create.customHint")}</div>
          )}
        </div>

        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={onCancel}>
            {t("profiles.theme.cancel")}
          </button>
          <button className="pf-btn primary" disabled={busy} onClick={() => onCreate(name, start, base)}>
            {t("profiles.create.submit")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Delete, two-step — and the copy promises exactly what is and is not lost. */
function DeleteDialog({
  profile,
  onCancel,
  onConfirm,
}: {
  profile: Profile;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  // Portalled for the same reason the editor is: `.gs` carries a transform, which makes it the
  // containing block for `position: fixed`, so a dialog rendered in place is centred on the
  // settings window and clipped by its `overflow: hidden` rather than centred on Sard.
  return createPortal(
    <div className="pf-dialog-scrim" onClick={onCancel}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">
          {t("profiles.delete.title", { name: profile.name ?? "—" })}
        </div>
        <p className="pf-dialog-body">{t("profiles.delete.body")}</p>
        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={onCancel}>
            {t("profiles.delete.cancel")}
          </button>
          <button className="pf-btn danger" onClick={onConfirm}>
            {t("profiles.delete.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
