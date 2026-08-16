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
import type { TKey } from "../../i18n/locales/en";
import { applyProfile, captureCurrent, createProfile, saveProfile, useProfiles } from "./store";
import { THEMES, isBuiltinThemeId } from "../../theme/themes";
import { useTheme } from "../../theme/store";
import { driftOf, liveValues, useSession, type SessionKey } from "./session";
import type { Profile } from "./model/profile";

/**
 * What the reader changed, in their own words — the design names the value, not the key.
 *
 * THE SEPARATOR IS TRANSLATED, not a literal. It used to be a hardcoded «، » (U+060C, the ARABIC
 * comma), which is correct Arabic and wrong English: an English reader was told "You changed the
 * paper، the book's paper". Punctuation belongs to the script it is set in, so it comes from the
 * locale like every other word here.
 *
 * Exported so the joining can be tested in both languages without rendering the dialog.
 */
export function describe(keys: SessionKey[], t: (k: TKey) => string): string {
  const label = (k: SessionKey) =>
    k === "theme_id"
      ? t("profiles.unsaved.what.theme")
      : k === "book_theme_id"
        ? t("profiles.unsaved.what.bookTheme")
        : k === "arabicFont"
          ? t("profiles.unsaved.what.arabicFont")
          : t("profiles.unsaved.what.latinFont");
  return keys.map(label).join(t("profiles.unsaved.listSep"));
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

  /**
   * What was captured, with the drifted APP paper folded in.
   *
   * `captureCurrent` reads the BOOK theme, which is right for "how Sard looks now" but wrong here
   * when the value that drifted was the app paper: a profile writes one id to both keys, so a
   * profile made from a changed app paper must carry THAT paper, not the book one it never touched.
   */
  const capturedWithDrift = async () => {
    const data = await captureCurrent();
    const live = liveValues();
    if (isBuiltinThemeId(live.theme_id)) {
      const th = THEMES[live.theme_id];
      data.theme = { ...data.theme, base: live.theme_id, dark: th.dark, colors: th.colors };
    }
    return data;
  };

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
    const data = await capturedWithDrift();
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
    const data = await capturedWithDrift();
    const made = await createProfile(t("profiles.unsaved.newName", { name: active.name ?? "" }), data, active.id);
    // AND IT BECOMES THE ONE IN USE. A profile made FROM this look is the look the reader is
    // wearing; leaving the old one active would leave the same drift in place and ask again a
    // second later, which reads as the question being ignored.
    await applyProfile(made);
    setBusy(false);
    dismiss();
  };

  return createPortal(
    <div className="pf-dialog-scrim" onClick={() => keepForSession(pending)}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="pf-dialog-title">
          {t("profiles.unsaved.changed", { what: describe(pending, t) })}
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
  /**
   * NOTHING HERE MEANS ANYTHING UNTIL THE THEME LAYER HAS LOADED.
   *
   * `useTheme` starts at `DEFAULT_LIGHT` for BOTH ids, and `initTheme()` runs only after
   * `initProfiles()` resolves — App.tsx sequences them that way so profile themes are registered
   * before one is applied. Between those two moments `activeId` already names the profile while the
   * theme store still holds Sard's defaults, so a check there compares the profile against values
   * nobody has read yet, concludes that `theme_id` and `book_theme_id` both "changed", and asks the
   * reader where a change they never made should go. `pending` latches, so the question outlives the
   * correction that lands a few milliseconds later.
   *
   * Measured before this guard: on a clean reload with no user action the dialog appeared 166 ms in,
   * naming exactly those two values, while `theme_id`, `book_theme_id` and `profile_active` on disk
   * all agreed with each other. Nothing had drifted.
   */
  const themeReady = useTheme((s) => s.ready);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  useEffect(() => {
    if (!active || !themeReady) return;
    const check = () => {
      // A key stays silent only while it still holds the value the reader accepted. Change it
      // again and it is a new decision, so the question comes back.
      const live = liveValues();
      const drift = driftOf(active).filter((k) => accepted[k] !== live[k]);
      if (drift.length && !pending) ask(drift);
    };
    check();
    // Poll rather than subscribe to four stores across two layers: the reading style is not a
    // zustand slice, so there is nothing to subscribe to for two of the four. A second is far below
    // the threshold where a reader would notice, and the check is three string comparisons.
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [active, themeReady, accepted, pending, ask]);
}
