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
import { THEMES, isBuiltinThemeId } from "../../theme/themes";

import { SardMini } from "./SardMini";
import { miniOfTheme } from "./mini";
import { ProfileCard } from "./ProfileCard";
import { ShareSheet } from "./ShareSheet";
import { ImportSheet } from "./ImportSheet";
import { guardUnsaved, profileChangePending } from "./session";
import { ProfileEditor } from "./ProfileEditor";
import {
  applyProfile,
  defaultProfileData,
  createProfile,
  duplicateProfile,
  refreshProfiles,
  removeProfile,
  saveProfile,
  useProfiles,
} from "./store";
import type { Profile } from "./model/profile";
import { useDialog, useScrimDismiss } from "../../components/useDialog";
import { profileLabel } from "./model/profile";

type Dialog =
  | { kind: "none" }
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
  /**
   * Frame 22 — the last save, while it is still worth mentioning.
   *
   * It lives HERE rather than in the editor because the editor closes on save: an announcement owned
   * by a component that has just unmounted is one nobody can read or undo.
   */
  const [saved, setSaved] = useState<{ name: string; previous: Profile; applied: boolean } | null>(null);

  // ENTERING THE AREA IS WHEN THE ORDER IS RECOMPUTED.
  //
  // The list is ordered by most recent USE, and the stamp is written by `applyProfile` the moment a
  // profile is worn — but the re-sort is held until a list is next BUILT rather than done under the
  // reader's pointer, because a card's miniature IS the switch and promoting the card they have just
  // clicked would put a different profile where their finger already is. This section mounts on every
  // entry to Profiles, so leaving and coming back is exactly that "next build".
  //
  // It runs once, on mount. Re-reading on every list change would be a loop: the read sets the list.
  useEffect(() => {
    void refreshProfiles();
  }, []);

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
    const base = p.data.theme.library.base;
    return isBuiltinThemeId(base) ? t(`theme.${base}`) : t("profiles.theme.custom");
  };

  /**
   * A NEW هيئة OPENS IN THE EDITOR, with no questions first.
   *
   * There used to be a dialog between the button and the editor: a name, and a three-way "start
   * from" (how Sard looks now · one of the sixteen · a paper of your own). It is gone. Making a
   * هيئة is one gesture now — press, and you are editing it.
   *
   * WHERE IT STARTS: Sard's own default appearance (`defaultProfileData`) — NOT what is currently on
   * screen. A هيئة seeded from the live look is indistinguishable from the one being worn, drift and
   * all, which is exactly how creating one came to feel like editing the current one.
   *
   * IT CLAIMS NO PRESET (`null`). The claim was only ever honest for "one of the sixteen", where the
   * reader had been shown the swatches and picked one; with no such choice on offer there is nothing
   * to claim, and announcing one would put a paper's name on a هيئة nobody chose it for.
   *
   * THE NAME IS THE EDITOR'S. It carries the name field and says when one is required, so asking
   * for a name up front only meant asking twice.
   */
  const create = async () => {
    setBusy(true);
    try {
      // FROM SARD'S OWN DEFAULT, NOT FROM WHAT IS BEING WORN.
      //
      // This used to call `captureCurrent()`, and that is what made creation behave like editing: the
      // new هيئة opened holding the ACTIVE one's values — including whatever the reader had changed
      // and not yet saved — so the editor showed the current appearance and there was no way to tell
      // the two apart. Seeding from the default gives the new هيئة its own identity from the first
      // frame, and makes it impossible for the active one's drift to reach into it.
      const data = defaultProfileData();
      const preset = null;
      // MAKING A PROFILE IS NOT WEARING ONE. This used to apply the new profile immediately, which
      // repainted the whole application to the canvas the editor was about to open on — and for
      // the canvas was one the reader had not authored yet, so creating one silently replaced their
      // look and left it there when they backed out. Measured: paper #F5EEDD, ink #2B2521, accent
      // #9C5A3C written to `theme_id`, `book_theme_id` and `profile_active`, with the previous active
      // profile recoverable only from memory. It matters no less now that a هيئة begins from what is
      // already on screen: beginning FROM the live look must not also mean being dressed in the copy.
      //
      // `duplicate` below has always created-then-edited without applying, and `saveProfile` repaints
      // only `if (activeId === p.id)` — so "editing a profile does not dress the app in it" is the
      // rule everywhere else. This was the one exception. Wearing it stays one click away, on the
      // card's own face and in the switcher.
      // No name yet: the editor asks for one, and `profileLabel` shows "unnamed" until it has it.
      const p = await createProfile("", data, preset);
      setDialog({ kind: "edit", profile: p, fresh: true });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (p: Profile) => {
    const name = t("profiles.duplicateSuffix", { name: profileLabel(p.name, t("profiles.unnamed")) });
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
        <button className="pf-btn primary" disabled={busy} onClick={() => void create()}>
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
        <FirstRun onImport={() => { if (!profileChangePending()) setDialog({ kind: "import" }); }} onCreate={() => void create()} />
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
                // Switching replaces the live values, so unsaved changes to the CURRENT profile are
                // about to be lost. Silent when there are none, which is nearly always.
                onUse: () => guardUnsaved(() => void applyProfile(p)),
                onEdit: () => setDialog({ kind: "edit", profile: p }),
                onDuplicate: () => void duplicate(p),
                onShare: () => { if (!profileChangePending()) guardUnsaved(() => setDialog({ kind: "share", profile: p })); },
                onDelete: () => setDialog({ kind: "delete", profile: p }),
              }}
            />
          ))}
        </div>
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
          onSaved={(previous, saved) =>
            setSaved({
              // The same dash the cards, the switcher and the delete dialog use for a profile
              // nobody has named — "Saved “”" is a sentence with a hole in it.
              name: profileLabel(saved.name, t("profiles.unnamed")),
              previous,
              // "and applied" is only true when the profile being edited is the one being worn.
              // `saveProfile` repaints only `if (activeId === p.id)`, so saying it otherwise would
              // announce something that did not happen.
              applied: useProfiles.getState().activeId === saved.id,
            })
          }
        />
      )}

      {saved && <SavedToast state={saved} onDone={() => setSaved(null)} />}
    </>
  );
}

/**
 * FRAME 22 — the save, said out loud, and undoable while it is being said.
 *
 * WHY THE UNDO IS `saveProfile` AGAIN. Undoing a save is saving what was there before, so it goes
 * back through the one route every other write takes — which means it re-applies to the running app
 * on exactly the same condition the save did, and there is no second way for a profile to reach the
 * runtime. Nothing had to be snapshotted for this: the editor already held the stored profile it was
 * editing, and that IS the previous state.
 *
 * The window is the toast's own life. An undo offered after the sentence has gone is an undo the
 * reader cannot see the scope of, so the two share one timer.
 */
const SAVED_TOAST_MS = 6000;

function SavedToast({
  state,
  onDone,
}: {
  state: { name: string; previous: Profile; applied: boolean };
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(onDone, SAVED_TOAST_MS);
    return () => window.clearTimeout(id);
    // Re-armed per announcement: a second save replaces the first and starts its own window.
  }, [state, onDone]);

  return createPortal(
    <div className="pf-toast" role="status">
      <span className="pf-toast-msg">
        {t(state.applied ? "profiles.saved.applied" : "profiles.saved.only", { name: state.name })}
      </span>
      <button
        className="pf-toast-undo"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void saveProfile(state.previous).finally(onDone);
        }}
      >
        {t("profiles.saved.undo")}
      </button>
    </div>,
    document.body,
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
  // Escape cancels. Focus deliberately lands on the DIALOG and not on its first button — one of the
  // buttons here deletes a profile, and a dialog that opens with delete under the return key is a
  // trap dressed as a convenience.
  const dlg = useDialog({ onDismiss: onCancel });
  // The backdrop takes a press only when the gesture began there and ends clear of the sheet.
  const scrim = useScrimDismiss(onCancel);

  // Portalled for the same reason the editor is: `.gs` carries a transform, which makes it the
  // containing block for `position: fixed`, so a dialog rendered in place is centred on the
  // settings window and clipped by its `overflow: hidden` rather than centred on Sard.
  return createPortal(
    <div className="pf-dialog-scrim" {...scrim.scrimProps}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()}
        ref={(node) => { dlg.ref(node); scrim.panelRef(node); }} {...dlg.props}>
        <div className="pf-dialog-title" id={dlg.titleId}>
          {t("profiles.delete.title", { name: profileLabel(profile.name, t("profiles.unnamed")) })}
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
