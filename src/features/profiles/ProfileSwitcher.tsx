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
import { isBuiltinThemeId } from "../../theme/themes";
import { SardMini } from "./SardMini";
import { miniOf } from "./mini";
import { applyProfile, useProfiles } from "./store";

export function ProfileSwitcher({ onManage }: { onManage: () => void }) {
  const { t } = useI18n();
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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

  // The SAME rule the card uses, deliberately: a profile built on one of the sixteen names it, and
  // one carrying its own paper says so rather than naming a preset it no longer resembles. Resolving
  // the profile's own id here instead would echo the profile's name back as its own paper.
  const themeNameOf = (p: typeof profiles[number]): string =>
    isBuiltinThemeId(p.data.theme.base) ? t(`theme.${p.data.theme.base}`) : t("profiles.theme.custom");

  return (
    <div className="pf-switch" ref={wrap}>
      <button
        className="pf-switch-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("profiles.title")}
      >
        {/* The live miniature of the profile it names — the design's own requirement, and the same
            component the cards and the editor's stage draw, so the three can never disagree. */}
        <span className="pf-switch-mini" aria-hidden>
          {active ? <SardMini p={miniOf(active)} /> : null}
        </span>
        <span className="pf-switch-text">
          <span className="pf-switch-name" dir="auto">
            {active ? (active.name ?? t("profiles.title")) : t("profiles.title")}
          </span>
          <span className="pf-switch-sub" dir="auto">
            {active ? themeNameOf(active) : t("profiles.count", { n: String(profiles.length) })}
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
                if (p.id !== activeId) void applyProfile(p);
              }}
            >
              <span className="pf-switch-row-mini" aria-hidden>
                <SardMini p={miniOf(p)} />
              </span>
              <span className="pf-switch-row-name" dir="auto">{p.name ?? "—"}</span>
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
