// A profile, as a card — a small Sard rather than a swatch.
//
// The design's own words for what this has to achieve: "Each card renders the Profile's own paper,
// desk, chrome, covers, page, face and bookmark at 1:5, so the answer to 'what will Sard look like'
// is the card itself."
//
// THE SEAL is a type specimen, not clip art: the profile's initial, set in the profile's OWN display
// face, on its OWN paper. That is what makes two profiles distinguishable at a glance even when
// their palettes are close.
//
// SELECTION is the swatch grid's own language, reused rather than reinvented: a 2px accent ring with
// 4px of the surrounding paper between it and the card, so it reads on a pale card and a black one
// alike.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { SardMini } from "./SardMini";
import { miniOf, sealOf } from "./mini";
import { SEAL_DIAMOND, type Profile } from "./model/profile";

export interface CardActions {
  onUse: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onDelete: () => void;
}

export function ProfileCard({
  profile,
  active,
  themeName,
  iconUrl,
  libUrl,
  actions,
}: {
  profile: Profile;
  active: boolean;
  /** The name of the theme this profile started from, when it started from one. */
  themeName: string;
  /** The profile's icon image, resolved by the section that already holds the managed rows. */
  iconUrl?: string | null;
  /** The profile's library background, so the card's miniature shows the picture it really makes. */
  libUrl?: string | null;
  actions: CardActions;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const mini = miniOf(profile, libUrl);

  /**
   * WHERE THE MENU GOES, measured when it opens.
   *
   * It used to hang off the card absolutely, and `.gs-body` — the settings pane, which scrolls —
   * clipped it: measured on the fourth card, the menu ran to 817px inside a container ending at
   * 687px and simply ceased to exist, `elementFromPoint` returning nothing at all. Raising
   * `z-index` cannot fix that, because clipping by an ancestor's `overflow` is not a paint order.
   * So the menu leaves the scroll container entirely and is placed against the viewport.
   */
  const place = () => {
    const b = more.current?.getBoundingClientRect();
    if (!b) return;
    const W = 256;
    const gap = 6;
    // Aligned to the button's outer edge in whichever direction the interface runs, then kept
    // inside the viewport — a card at the edge of the grid must not push the menu off-screen.
    const raw = getComputedStyle(document.documentElement).direction === "rtl" ? b.left : b.right - W;
    const left = Math.max(8, Math.min(raw, window.innerWidth - W - 8));
    setAt({ top: b.bottom + gap, left });
  };

  /**
   * Then keep it on screen. The height is not known until it has rendered, and a card low in the
   * grid would otherwise hang off the bottom — so the menu flips above its button when there is
   * more room there, and is clamped either way.
   */
  useEffect(() => {
    if (!menu || !at) return;
    const el = pop.current;
    const b = more.current?.getBoundingClientRect();
    if (!el || !b) return;
    const h = el.getBoundingClientRect().height;
    const gap = 6;
    const below = window.innerHeight - b.bottom - gap - 8;
    const top = h <= below ? b.bottom + gap : Math.max(8, Math.min(b.top - gap - h, window.innerHeight - h - 8));
    if (Math.abs(top - at.top) > 0.5) setAt((cur) => (cur ? { ...cur, top } : cur));
  }, [menu, at]);

  // Close on an outside click or Escape — the idiom every other Sard menu uses.
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      const n = e.target as Node;
      // The menu is portalled, so it is NOT inside the card any more — both have to be asked.
      if (!wrap.current?.contains(n) && !pop.current?.contains(n)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const seal = sealOf(profile);

  return (
    <div className={`pf-card${active ? " on" : ""}`} ref={wrap}>
      {/* The miniature IS the primary control: tapping the card is switching, exactly as tapping a
          paper in the theme grid is choosing one. */}
      <button
        className="pf-card-face"
        onClick={actions.onUse}
        aria-pressed={active}
        title={profile.name ?? ""}
      >
        <SardMini p={mini} />
      </button>

      <div className="pf-card-foot">
        <span
          className="pf-seal"
          style={{
            background: profile.data.theme.colors.paperBg,
            color: seal.text === SEAL_DIAMOND
              ? profile.data.theme.colors.accent
              : profile.data.theme.colors.text,
            fontFamily: seal.fontFamily,
          }}
          aria-hidden
        >
          {profile.iconKind === "color" && profile.iconRef ? (
            <span className="pf-seal-dot" style={{ background: profile.iconRef }} />
          ) : profile.iconKind === "image" && iconUrl ? (
            <span className="pf-seal-img" style={{ backgroundImage: `url("${iconUrl}")` }} />
          ) : (
            // An image icon whose row has not loaded yet — or has gone — falls back to the initial
            // rather than to a hole. The seal is a real choice, so it is never a broken state.
            seal.text
          )}
        </span>

        <span className="pf-card-text">
          <span className="pf-card-name" dir="auto">
            {profile.name ?? "—"}
          </span>
          <span className="pf-card-sub" dir="auto">
            {themeName}
          </span>
        </span>

        {active && <span className="pf-badge">{t("profiles.active")}</span>}

        <button
          ref={more}
          className="pf-card-more"
          onClick={() => { if (!menu) place(); setMenu((v) => !v); }}
          aria-label={t("profiles.card.menu")}
          aria-expanded={menu}
        >
          ⋯
        </button>
      </div>

      {menu && at && createPortal(
        <div
          ref={pop}
          className="pf-menu"
          role="menu"
          style={{ top: at.top, left: at.left }}
        >
          <button role="menuitem" onClick={() => { setMenu(false); actions.onEdit(); }}>
            {t("profiles.card.edit")}
          </button>
          {!active && (
            <button role="menuitem" onClick={() => { setMenu(false); actions.onUse(); }}>
              {t("profiles.card.use")}
            </button>
          )}
          <button role="menuitem" onClick={() => { setMenu(false); actions.onDuplicate(); }}>
            {t("profiles.card.duplicate")}
          </button>
          {/* Sharing arrives with the package format. Shown disabled rather than hidden, for the
              same reason the Import button is: the design's own menu carries five entries, and a
              control that appears later moves the furniture under the reader. */}
          <button role="menuitem" onClick={() => { setMenu(false); actions.onShare(); }}>
            {t("profiles.card.share")}
          </button>
          <div className="pf-menu-rule" />
          <button
            role="menuitem"
            className="danger"
            onClick={() => { setMenu(false); actions.onDelete(); }}
          >
            {t("profiles.card.delete")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
