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

import { useI18n } from "../../i18n";
import { SardMini } from "./SardMini";
import { bookFaceCss, miniOf } from "./mini";
import type { Profile } from "./model/profile";

export interface CardActions {
  onUse: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function ProfileCard({
  profile,
  active,
  themeName,
  actions,
}: {
  profile: Profile;
  active: boolean;
  /** The name of the theme this profile started from, when it started from one. */
  themeName: string;
  actions: CardActions;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const mini = miniOf(profile);

  // Close on an outside click or Escape — the idiom every other Sard menu uses.
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const seal = (profile.name ?? "").trim().slice(0, 1) || "س";

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
            color: profile.data.theme.colors.text,
            fontFamily: bookFaceCss(profile.data.type.arabic),
          }}
          aria-hidden
        >
          {profile.iconKind === "color" && profile.iconRef ? (
            <span className="pf-seal-dot" style={{ background: profile.iconRef }} />
          ) : (
            seal
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
          className="pf-card-more"
          onClick={() => setMenu((v) => !v)}
          aria-label={t("profiles.card.menu")}
          aria-expanded={menu}
        >
          ⋯
        </button>
      </div>

      {menu && (
        <div className="pf-menu" role="menu">
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
          <div className="pf-menu-rule" />
          <button
            role="menuitem"
            className="danger"
            onClick={() => { setMenu(false); actions.onDelete(); }}
          >
            {t("profiles.card.delete")}
          </button>
        </div>
      )}
    </div>
  );
}
