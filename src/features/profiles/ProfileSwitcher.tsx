// THE LIBRARY ACCESS POINT — one row in the sidebar foot, and a menu that opens upward.
//
// The design: "The Library sidebar foot already holds the theme and the language. The active Profile
// joins them. One row, no new chrome. It carries a live miniature of the Profile it names, and the
// menu opens upward the way the theme and language menus do."
//
// ONE ROW, AND NOTHING ELSE MOVES. The foot already holds the Settings button and, beneath it, the
// theme/language caption. This sits above the Settings button and leaves both exactly as they were —
// the caption in particular is deliberately untouched: it reads as a status line because that is what
// it is, and the design's stated position for this row ("above the paper and language controls") is
// unreachable, because those are not controls.
//
// SELF-CONTAINED ON PURPOSE. `Chrome.tsx` belongs to the Library and gains a single line by mounting
// this; every profile concern — the store, the miniature, the menu, the switch — stays on this side
// of the boundary. That is also why it takes no props: a row that needed five would make the Library
// know about profiles.
//
// SWITCHING IS IMMEDIATE AND UNCONFIRMED, exactly as choosing a paper is. `applyProfile` repaints the
// running surface; there is no dialog, because there is nothing to lose.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { bgSrcUrl } from "../../lib/background";
import { backgroundsList, type BackgroundRow } from "../../lib/ipc";
import { isBuiltinThemeId } from "../../theme/themes";
import { SardMini } from "./SardMini";
import { miniOf } from "./mini";
import { applyProfile, refreshProfiles, useProfiles } from "./store";
import { guardUnsaved, useProfileDirty } from "./session";
import { markFrame } from "./model/markFrame";
import { profileLabel } from "./model/profile";

export function ProfileSwitcher({ onManage }: { onManage: () => void }) {
  const { t } = useI18n();
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const dirty = useProfileDirty();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  /**
   * A PROFILE THAT WEARS A PICTURE SHOULD WEAR IT HERE TOO.
   *
   * The card already draws a chosen image (`ProfileCard`'s seal), because `ProfilesSection` reads
   * the managed background rows and hands it down as `iconUrl`. This row takes no props by design,
   * so it never resolved that reference and always fell through to the generated miniature — the
   * reader saw their own picture on the card and a palette swatch in the foot, for the same profile.
   *
   * The rows are re-read whenever the profile list changes, which is the only way a newly chosen
   * icon reaches a card — the same trigger `ProfilesSection` uses, for the same reason.
   */
  const [bgRows, setBgRows] = useState<BackgroundRow[]>([]);
  useEffect(() => {
    let alive = true;
    backgroundsList()
      .then((r) => alive && setBgRows(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [profiles]);

  // Close on an outside click or Escape — the idiom every other menu in the sidebar uses.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // NOTHING TO SWITCH BETWEEN IS NOT A ROW. With no profiles saved, the foot is what it was before
  // this feature existed — an empty control that opens an empty menu would be furniture, not an
  // entry point, and the Profiles area is already reachable through Settings.
  if (profiles.length === 0) return null;

  const active = profiles.find((p) => p.id === activeId) ?? null;

  // The card's rule, unchanged and deliberately not re-derived: an image icon is a reference into
  // the managed background rows, and a reference that no longer resolves falls back rather than
  // leaving a hole — which is what keeps a deleted picture from emptying the foot.
  const activeIconUrl =
    active && active.iconKind === "image" && active.iconRef
      ? (() => {
          const row = bgRows.find((r) => r.id === active.iconRef);
          return row ? bgSrcUrl(row) : null;
        })()
      : null;

  // The SAME rule the card uses, deliberately: a profile built on one of the sixteen names it, and
  // one carrying its own paper says so rather than naming a preset it no longer resembles. Resolving
  // the profile's own id here instead would echo the profile's name back as its own paper.
  const themeNameOf = (p: typeof profiles[number]): string =>
    isBuiltinThemeId(p.data.theme.library.base) ? t(`theme.${p.data.theme.library.base}`) : t("profiles.theme.custom");

  return (
    <div className="pf-switch" ref={wrap}>
      <button
        className="pf-switch-btn"
        /**
         * OPENING THE MENU REBUILDS THE LIST, and without this the menu was the one surface where
         * "most recently worn first" was never visible.
         *
         * The order is a projection of the use stamps, and the store holds it until something asks
         * for it again: `initProfiles` at startup, every write, and the Profiles area on entry.
         * Switching from HERE is none of those — measured, wearing a هيئة from this menu and
         * reopening it showed the same order as before, for the whole session. A reader who never
         * opens the Profiles area therefore never saw the feature at all, which is exactly how it
         * was reported.
         *
         * BEFORE the menu paints, not after, and that is why the read is awaited. The list is
         * reordered while there is nothing on screen to reorder; a refresh after opening would move
         * the rows under a pointer already travelling to one of them. It is also why the GRID is not
         * refreshed on the switch itself — same rule, stated for the surface that shows the list:
         * rebuild it as it is opened, never while it is being read.
         */
        onClick={() => {
          if (open) { setOpen(false); return; }
          void refreshProfiles().finally(() => setOpen(true));
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("profiles.title")}
      >
        {/* The live miniature of the profile it names — the design's own requirement, and the same
            component the cards and the editor's stage draw, so the three can never disagree. */}
        <span className="pf-switch-mini" aria-hidden>
          {activeIconUrl ? (
            // The reader's own picture, in the slot the miniature would otherwise fill. The box is
            // SardMini's own 16:10 so the row's height does not move, and `cover` matches how the
            // card paints the same image (`.pf-seal-img`).
            <span
              style={{
                display: "block",
                width: "100%",
                aspectRatio: "16 / 10",
                backgroundImage: `url("${activeIconUrl}")`,
                // The profile's own framing, through the one helper every mark surface uses. The
                // box is 16:10 rather than square, which is exactly why it has to ask rather than
                // assume: `cover` crops a different part of the same picture at a different aspect.
                ...markFrame(active ? active.data.icon : null),
              }}
            />
          ) : active ? (
            <SardMini p={miniOf(active)} />
          ) : null}
        </span>
        <span className="pf-switch-text">
          <span className="pf-switch-name" dir="auto">
            {active ? profileLabel(active.name, t("profiles.unnamed")) : t("profiles.title")}
          </span>
          <span className="pf-switch-sub" dir="auto">
            {/* A CHANGE IS STATED, NEVER ASKED ABOUT. The old layer interrupted the moment anything
                moved; this says the same thing in the one place the active profile is always named,
                and waits. The reader is asked only at a boundary — see `session.ts`. */}
            {dirty.length
              ? t("profiles.editor.unsaved")
              : active ? themeNameOf(active) : t("profiles.count", { n: String(profiles.length) })}
          </span>
        </span>
      </button>

      {open && (
        <div className="pf-switch-menu lib-menu" role="menu">
          {profiles.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === activeId}
              onClick={() => {
                setOpen(false);
                if (p.id !== activeId) guardUnsaved(() => void applyProfile(p));
              }}
            >
              <span className="pf-switch-row-mini" aria-hidden>
                <SardMini p={miniOf(p)} />
              </span>
              <span className="pf-switch-row-name" dir="auto">{profileLabel(p.name, t("profiles.unnamed"))}</span>
              {p.id === activeId && <span className="pf-switch-check" aria-hidden>✓</span>}
            </button>
          ))}
          <div className="pf-switch-rule" />
          <button role="menuitem" onClick={() => { setOpen(false); onManage(); }}>
            <span className="pf-switch-row-name">{t("profiles.manage")}</span>
            <span className="pf-switch-count">{t("profiles.count", { n: String(profiles.length) })}</span>
          </button>
        </div>
      )}
    </div>
  );
}
