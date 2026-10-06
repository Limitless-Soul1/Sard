import { useI18n } from "../../i18n";

// THE WAY BACK TO THE FURTHEST POINT READ — one control, offered from the two panels a reader is
// actually in when they discover they are behind it.
//
// It lives in its own file because it now appears in BOTH the Contents panel (where a reader who
// navigated away from chapter 610 navigated away FROM) and the Search panel (where they arrive to look
// for something and are told, by the spoiler-safe line right above, that the boundary is somewhere
// they are not). Written twice it would eventually read or behave differently in the two places; the
// only thing either caller decides is what the destination is CALLED, because naming a chapter is the
// Contents panel's own rule and the Reader resolves it the same way for the search line.
//
// It is NOT the return pill. That one is transient, sits over the reading area, and offers the way back
// to wherever the reader was standing a moment ago; this one is durable, sits inside a panel, and
// offers the furthest point they have ever read to. Nothing is shared between them but the idea of
// going somewhere, and they must be able to appear at the same time without either explaining the
// other away.
// RESET SITS BESIDE IT, IN A ROW, because it cannot sit inside it: a button within a button is not
// something HTML allows, and the way back was a single button. So the two actions are siblings sharing
// one ground — the way back takes the width it needs, Reset takes its own label's worth. Passing no
// `onReset` renders the row exactly as the control looked before, at the same margins.
//
// It is the MARK it resets, never the reader: pressing it in chapter 500 leaves the reader in chapter
// 500 and moves the frontier to them. The row then retires itself, because a reader standing at their
// furthest point is offered nothing — the same rule that hides it at the frontier normally.
export function FurthestReturn({
  label, onGo, onReset,
}: { label: string; onGo: () => void; onReset?: () => void }) {
  const { t, dir } = useI18n();
  return (
    <div className="rp-furthest-row">
    <button className="rp-furthest" onClick={onGo} title={t("toc.furthestAria")} aria-label={t("toc.furthestAria")}>
      <span className="rp-furthest-arrow" aria-hidden="true">
        {/* Forward along the READING direction, and the sibling of the return pill's single chevron:
            that one points back to where you were, this one runs on to how far you got. The path is
            CHOSEN per direction, never transformed, so it can never end up a double-mirror. */}
        <svg viewBox="0 0 24 24">
          <path d={dir === "rtl" ? "M13 5l-7 7 7 7M19 5l-7 7 7 7" : "M11 5l7 7-7 7M5 5l7 7-7 7"} />
        </svg>
      </span>
      <span className="rp-furthest-text">
        <span className="rp-furthest-lead">{t("toc.furthest")}</span>
        <span className="rp-furthest-where" dir="auto">{label}</span>
      </span>
    </button>
      {onReset && (
        <button
          className="rp-furthest-reset"
          type="button"
          onClick={onReset}
          title={t("toc.furthestResetAria")}
          aria-label={t("toc.furthestResetAria")}
        >
          {t("toc.furthestReset")}
        </button>
      )}
    </div>
  );
}
