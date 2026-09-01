// THE UNSAVED-CHANGES DECISION, asked once, at the boundary that needs it.
//
// It is no longer a reaction to a change. `session.ts` decides WHEN — this only renders the question
// and carries out the answer, then lets the action that was waiting proceed.
//
//   Save     the drifted values are written into the active profile, so the look the reader has been
//            building becomes what that profile is.
//   Discard  the profile is re-applied, which puts the live surface back to its saved state.
//   Cancel   nothing happens at all, and the waiting action does not run — the reader stays exactly
//            where they were, with their changes intact.
//
// Save and Discard need no flag to clear: the dirty state is derived from profile-vs-live, so once
// either has run the two agree and the badge goes on its own.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { applyProfile, captureCurrent, saveProfile, useProfiles } from "./store";
import { THEMES, isBuiltinThemeId } from "../../theme/themes";
import { liveValues, profileValues, useSession, type SessionKey } from "./session";
import type { Profile, ProfileData } from "./model/profile";
import { useReader } from "../../reader-engine/store";
import { TTS_TRACKING_KEYS } from "../../reader-engine/injectedCss";
import { TYPOGRAPHY_KEYS } from "./model/profile";
import { useDialog } from "../../components/useDialog";

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
  // A LOOKUP, NOT A CHAIN OF TERNARIES. The chain ended in `latinFont`, so it named the LATIN FACE for
  // every key it did not recognise — and the set has grown twice since it was written (the number
  // ink, then the seven read-aloud marks). A reader who changed a tracking colour would have been
  // told they had changed the Latin font. An unknown key now says nothing rather than something
  // false, and the dialog falls back to its own "you have unsaved changes" wording if that empties
  // the list.
  const LABELS: Partial<Record<SessionKey, TKey>> = {
    theme_id: "profiles.unsaved.what.theme",
    book_theme_id: "profiles.unsaved.what.bookTheme",
    arabicFont: "profiles.unsaved.what.arabicFont",
    latinFont: "profiles.unsaved.what.latinFont",
    numberColor: "profiles.unsaved.what.numbers",
    ...Object.fromEntries(
      TYPOGRAPHY_KEYS.map((k) => [k, "profiles.unsaved.what.measure" as TKey]),
    ),
    ttsSpotlightOn: "profiles.unsaved.what.voice",
    ttsSpotlightColor: "profiles.unsaved.what.voice",
    ttsSpotlightOpacity: "profiles.unsaved.what.voice",
    ttsSpotlightRule: "profiles.unsaved.what.voice",
    ttsKaraokeOn: "profiles.unsaved.what.voice",
    ttsKaraokeColor: "profiles.unsaved.what.voice",
    ttsKaraokeOpacity: "profiles.unsaved.what.voice",
  };
  // The seven marks are ONE thing to a reader, so they are named once however many of them moved.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const key = LABELS[k];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t(key));
  }
  return out.join(t("profiles.unsaved.listSep"));
}

export function UnsavedChange() {
  const { t } = useI18n();
  const pending = useSession((s) => s.pending);
  const close = useSession((s) => s.close);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ name: string; before: Profile } | null>(null);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  /* Cancel is what Escape means here — see `useDialog`. `pending` may be absent on this render, in
     which case the dialog is not shown and the dismissal is never reachable. */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const dlg = useDialog({
    onDismiss: () => {
      const p = pendingRef.current;
      if (!p) return;
      close();
    },
  });

  /**
   * What was captured, with the drifted APP paper folded in.
   *
   * `captureCurrent` reads BOTH themes now — the library's and the book's — so the premise this
   * function was written against ("a profile writes one id to both keys") no longer holds. What
   * remains is the drift itself: `liveValues` may hold an app paper the reader has changed since,
   * and a profile made from it must carry THAT paper.
   */
  const capturedWithDrift = async () => {
    const data = await captureCurrent();
    const live = liveValues();
    // WHAT `captureCurrent` DELIBERATELY DECLINES TO TAKE MUST NOT BE LOST HERE.
    //
    // It takes NO typography opinion and NO read-aloud opinion, and both refusals are right for what
    // it is for: a profile made from "how Sard looks now" must not silently claim the reader's
    // measure or their reading cursor. Saving into a هيئة THAT ALREADY EXISTS is the opposite case —
    // those are values it already holds, and replacing the whole blob with a capture deleted them as
    // a side effect of confirming an unrelated colour change. Restored from the هيئة itself, so
    // nothing outside the drift can move.
    if (active) {
      data.type.reading = { ...active.data.type.reading };
      data.voice = active.data.voice ? { ...active.data.voice } : null;
    }
    if (isBuiltinThemeId(live.theme_id)) {
      const th = THEMES[live.theme_id];
      // THE APP PAPER, so the LIBRARY palette. `captureCurrent` now reads the library theme for
      // that scope anyway; this still overrides it because `liveValues` may hold a paper the reader
      // changed since, which is the drift this whole function exists to keep.
      data.theme = {
        ...data.theme,
        library: { ...data.theme.library, base: live.theme_id, dark: th.dark, colors: th.colors },
      };
    }
    // The number ink, likewise. `captureCurrent` deliberately takes none — a profile made from "how
    // Sard looks now" should not silently claim the digits — but SAVING a change is the opposite
    // case: the colour on screen is precisely what the reader is asking to keep.
    // The digits are drawn in a BOOK, so the reading palette carries them.
    data.theme = { ...data.theme, reading: { ...data.theme.reading, numbers: live.numberColor || null } };
    // AND THE READ-ALOUD MARKS, for exactly the same reason the number ink is folded in: they are
    // هيئة-owned and settable from the reading drawer, so the marks on screen are precisely what the
    // reader is asking to keep. Only while a book is open — with none, the reading style is unknown
    // rather than empty (see `driftOf`), and the هيئة's own block restored above stands.
    const liveStyle = useReader.getState().style;
    if (liveStyle) {
      data.voice = Object.fromEntries(
        TTS_TRACKING_KEYS.map((k) => [k, liveStyle[k]]),
      ) as ProfileData["voice"];
      // AND THE MEASURE, but only where it actually DIFFERS from what the هيئة asserts.
      //
      // Not "capture everything on screen": a هيئة that names no margin asserts Sard's own, and
      // writing that number back would turn a هيئة with no opinion into one with ten, freezing this
      // book's direction defaults into it. Only a field the reader has genuinely moved becomes an
      // opinion; the rest stay exactly as authored, `null` included.
      const asserted = profileValues(active!);
      for (const k of TYPOGRAPHY_KEYS) {
        if (String(liveStyle[k] ?? "") === asserted[k]) continue;
        (data.type.reading as unknown as Record<string, unknown>)[k] = liveStyle[k];
      }
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

  if (!pending || !active) return null;
  const keys = pending.keys;

  /** Answer, then let the action that was waiting on the answer happen. */
  const done = (proceed: boolean) => {
    const go = pending.proceed;
    close();
    if (proceed) go();
  };

  // Declared before the early returns above it would be a hook called conditionally; it sits here,
  // after the guards, because every path below this point renders the dialog.
  const save = async () => {
    setBusy(true);
    try {
      if (pending.onSave) await pending.onSave();
      else {
        const data = await capturedWithDrift();
        await saveProfile({ ...active, data });
      }
    } finally {
      setBusy(false);
    }
    done(true);
  };

  /** Put back what the profile says. Re-applying IS the discard — there is no snapshot to restore. */
  const discard = async () => {
    setBusy(true);
    try {
      if (pending.onDiscard) await pending.onDiscard();
      // RE-APPLYING IS THE DISCARD, and it is not a choice of هيئة: the reader is putting back what
      // the one they are already wearing says. It therefore takes no use stamp — see `applyProfile`.
      else await applyProfile(active, { worn: false });
    } finally {
      setBusy(false);
    }
    done(true);
  };



  return createPortal(
    /* The scrim CANCELS. Dismissing by clicking away must be the option that changes nothing —
       anything else would let a stray click save or discard on the reader's behalf. Escape is wired
       to the SAME answer, so the keyboard and the pointer cannot mean different things. */
    <div className="pf-dialog-scrim" onClick={() => done(false)}>
      <div className="pf-dialog" onClick={(e) => e.stopPropagation()} ref={dlg.ref} {...dlg.props}>
        <div className="pf-dialog-title" id={dlg.titleId}>
          {t("profiles.unsaved.pendingTitle", { name: active.name ?? "" })}
        </div>
        <p className="pf-dialog-body">
          {keys.length
            ? t("profiles.unsaved.pendingBody", { what: describe(keys, t) })
            : t("profiles.unsaved.pendingBodyDraft")}
        </p>

        <div className="pf-dest-list" role="group">
          <button className="pf-dest" disabled={busy} onClick={() => void save()}>
            <span className="pf-dest-name">{t("profiles.unsaved.save")}</span>
            <span className="pf-dest-tag">{t("profiles.unsaved.recommended")}</span>
          </button>
          <button className="pf-dest" disabled={busy} onClick={() => void discard()}>
            <span className="pf-dest-name">{t("profiles.unsaved.discard")}</span>
          </button>
          <button className="pf-dest" disabled={busy} onClick={() => done(false)}>
            <span className="pf-dest-name">{t("profiles.unsaved.cancel")}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
