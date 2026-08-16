// FRAME 21 — "Where does this change go?", and frame 22's confirmation.
//
// A profile-owned value changed outside the editor. The design does not guess which of the three
// honest answers the reader meant, and neither does this: the change is already visible, and this
// asks where it should LIVE.
//
// The change is never reverted by opening this. Asking is not undoing — the reader sees the new
// paper while deciding what to do with it, which is the whole reason the question is answerable.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { captureCurrent, createProfile, saveProfile, useProfiles } from "./store";
import { driftOf, useSession, type SessionKey } from "./session";
import type { Profile } from "./model/profile";

/** What the reader changed, in their own words — the design names the value, not the key. */
function describe(keys: SessionKey[], t: (k: never) => string): string {
  const label = (k: SessionKey) =>
    k === "theme_id"
      ? t("profiles.unsaved.what.theme" as never)
      : k === "book_theme_id"
        ? t("profiles.unsaved.what.bookTheme" as never)
        : k === "arabicFont"
          ? t("profiles.unsaved.what.arabicFont" as never)
          : t("profiles.unsaved.what.latinFont" as never);
  return keys.map(label).join("، ");
}

export function UnsavedChange() {
  const { t } = useI18n();
  const pending = useSession((s) => s.pending);
  const keepForSession = useSession((s) => s.keepForSession);
  const dismiss = useSession((s) => s.dismiss);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ name: string; before: Profile } | null>(null);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  // Frame 22 fades on its own — a confirmation that has to be dismissed is a second decision.
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(null), 6000);
    return () => clearTimeout(id);
  }, [saved]);

  if (saved) {
    return createPortal(
      <div className="pf-saved" role="status">
        <span>{t("profiles.saved.applied", { name: saved.name })}</span>
        <button
          className="pf-saved-undo"
          onClick={() => {
            const before = saved.before;
            setSaved(null);
            // Undo restores the row the reader had before this write. The live surface is left as it
            // is: they can see what they undid, and the profile is what changed.
            void saveProfile(before);
          }}
        >
          {t("profiles.saved.undo")}
        </button>
      </div>,
      document.body,
    );
  }

  if (!pending || !pending.length || !active) return null;

  // 1 · into the profile that is open.
  const intoActive = async () => {
    setBusy(true);
    const before = structuredClone(active);
    const data = await captureCurrent();
    // ONLY the four. Everything else the profile holds is left exactly as saved — this dialog is
    // about a change made outside the editor, not a re-capture of the whole look.
    const next: Profile = {
      ...active,
      data: {
        ...active.data,
        type: { ...active.data.type, arabic: data.type.arabic, latin: data.type.latin },
        theme: { ...data.theme, base: data.theme.base },
      },
    };
    await saveProfile(next);
    setBusy(false);
    dismiss();
    setSaved({ name: active.name ?? "", before });
  };

  // 2 · a new profile carrying this look; the original is untouched.
  const intoNew = async () => {
    setBusy(true);
    const data = await captureCurrent();
    await createProfile(t("profiles.unsaved.newName", { name: active.name ?? "" }), data, active.id);
    setBusy(false);
    dismiss();
  };

  return createPortal(
    <div className="pf-dialog-scrim" onClick={() => keepForSession(pending)}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">
          {t("profiles.unsaved.changed", { what: describe(pending, t as never) })}
        </div>
        <p className="pf-dialog-body">{t("profiles.unsaved.where")}</p>

        <div className="pf-dest-list" role="group">
          <button className="pf-dest" disabled={busy} onClick={() => void intoActive()}>
            <span className="pf-dest-name">
              {/* A profile may legitimately have no name — the model allows it, and empty quotes
                  ("Save it into «»") is not a sentence. */}
              {active.name
                ? t("profiles.unsaved.intoActive", { name: active.name })
                : t("profiles.unsaved.intoActiveUnnamed")}
            </span>
            <span className="pf-dest-tag">{t("profiles.unsaved.recommended")}</span>
          </button>
          <button className="pf-dest" disabled={busy} onClick={() => void intoNew()}>
            <span className="pf-dest-name">{t("profiles.unsaved.intoNew")}</span>
          </button>
          <button className="pf-dest" disabled={busy} onClick={() => keepForSession(pending)}>
            <span className="pf-dest-name">{t("profiles.unsaved.sessionOnly")}</span>
          </button>
        </div>

        <div className="pf-hint">{t("profiles.unsaved.sessionHint")}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Watch the four, and ask once per drift.
 *
 * A SUBSCRIPTION RATHER THAN AN INTERCEPT. The shared setters persist as they always have, because a
 * reader with no profiles must be unaffected by any of this; what changes is only that a profile
 * NOTICES. Mounted once, beside the app's other always-on effects.
 */
export function useUnsavedChangeWatch(): void {
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const accepted = useSession((s) => s.accepted);
  const pending = useSession((s) => s.pending);
  const ask = useSession((s) => s.ask);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  useEffect(() => {
    if (!active) return;
    const check = () => {
      const drift = driftOf(active).filter((k) => !accepted.includes(k));
      if (drift.length && !pending) ask(drift);
    };
    check();
    // Poll rather than subscribe to four stores across two layers: the reading style is not a
    // zustand slice, so there is nothing to subscribe to for two of the four. A second is far below
    // the threshold where a reader would notice, and the check is three string comparisons.
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [active, accepted, pending, ask]);
}
