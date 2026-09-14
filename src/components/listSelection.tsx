/**
 * CHOOSING SEVERAL THINGS AT ONCE — said once, for every list that holds them.
 *
 * WHY IT IS ONE FILE. Sard has a dozen lists a reader accumulates: notes, highlights, references,
 * replacements, bookmarks, photo cards, books. Deleting fifty highlights one row at a time is fifty
 * repetitions of the same decision, and the shape of the answer is identical everywhere — turn
 * selection on, tick some rows or take them all, do the one thing the collection supports, leave.
 * Written per list, that becomes a dozen slightly different selection UIs, and the differences are
 * never deliberate: one forgets the partial state, one leaves the mode on with nothing selected, one
 * opens a row when the reader meant to tick it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not delete anything, and it does not know how. Each list
 * passes the actions it actually supports, so a collection that cannot be deleted from simply has
 * none — the bar never offers an action the list would have to refuse.
 *
 * WHERE IT SITS. At the TOP of the list it governs, beside the controls that were already there. A
 * floating bar at the foot of the window is how the library does it, and that is right for a grid
 * that fills the screen; in a 300px panel it would cover the rows being chosen.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";

/** How much of what is on screen is chosen — the three states «تحديد الكل» has to tell apart. */
export type AllState = "none" | "some" | "all";

/**
 * `visible` is what the reader can actually see and act on, which is not the same as everything
 * selected: a filter can hide a chosen row, and "all" must then mean "all of these", never "all of
 * something you cannot see".
 */
export function allStateOf(visible: readonly string[], selected: ReadonlySet<string>): AllState {
  if (visible.length === 0 || selected.size === 0) return "none";
  let n = 0;
  for (const id of visible) if (selected.has(id)) n++;
  if (n === 0) return "none";
  return n === visible.length ? "all" : "some";
}

/** Add or remove one id, without mutating the set the caller is holding. */
export function toggleIn(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Take all of `visible`, or give all of it back. Anything selected but not visible is left alone —
 * a hidden choice is still the reader's, and dropping it silently is how a filter deletes a
 * selection nobody made.
 */
export function toggleAllIn(visible: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (allStateOf(visible, selected) === "all") for (const id of visible) next.delete(id);
  else for (const id of visible) next.add(id);
  return next;
}

/** Drop ids that are no longer anywhere in the collection — a row deleted elsewhere, say. */
export function pruneTo(present: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const alive = new Set(present);
  const next = new Set<string>();
  for (const id of selected) if (alive.has(id)) next.add(id);
  return next;
}

export interface ListSelection {
  /** Is the mode on? Rows answer to a tick rather than to their usual press only while it is. */
  on: boolean;
  selected: ReadonlySet<string>;
  count: number;
  has: (id: string) => boolean;
  state: AllState;
  enter: () => void;
  /** Leave the mode AND forget the choice — cancelling is not "keep it for later". */
  exit: () => void;
  toggle: (id: string) => void;
  toggleAll: () => void;
  /** After an action has run: keep the mode, forget what it acted on. */
  clear: () => void;
}

/**
 * `visible` is the ids currently on screen, in order. Passing it every render is what keeps
 * «تحديد الكل» honest when a filter or a tab changes what "all" means.
 */
export function useListSelection(visible: readonly string[]): ListSelection {
  const [on, setOn] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());

  /**
   * ESCAPE LEAVES THE MODE — once, here, rather than in each list.
   *
   * THE PRIORITY IS THE EVENT PHASE, not a flag anybody has to remember. The two things that must
   * answer Escape first already claim it in the CAPTURE phase and stop it there: a dialog (see
   * `useDialog`) and the library's dismissal stack (see `transient`). A listener in the BUBBLE phase
   * therefore cannot see a key either of them has spent, so "the open dialog wins, otherwise the
   * selection does" is true by construction and cannot drift out of step with a third surface added
   * later. `defaultPrevented` covers anything nearer the key that answered it without stopping it.
   *
   * It CANCELS: the mode ends and the choice is forgotten. Escape has never meant "do the thing".
   */
  const exitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      exitRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);

  // Recomputed from `visible` itself, which is a fresh array every render — a linear scan of a
  // list a reader can see costs nothing, and a memo key here is how "all" goes stale after a filter.
  const state = allStateOf(visible, selected);

  const exit = useCallback(() => { setOn(false); setSelected(new Set<string>()); }, []);
  exitRef.current = exit;

  return {
    on,
    selected,
    count: selected.size,
    state,
    has: useCallback((id: string) => selected.has(id), [selected]),
    enter: useCallback(() => setOn(true), []),
    exit,
    toggle: useCallback((id: string) => setSelected((s) => toggleIn(s, id)), []),
    toggleAll: useCallback(() => setSelected((s) => toggleAllIn(visible, s)), [visible]),
    clear: useCallback(() => setSelected(new Set<string>()), []),
  };
}

/** One action the list supports while a selection is standing. */
export interface SelectionAction {
  key: string;
  label: string;
  run: () => void;
  /** Drawn as the destructive one. */
  danger?: boolean;
  /**
   * The mark beside the label, from Sard's own set. A word alone is readable and a word with its
   * mark is recognisable — and «حذف» is the one action on this bar that has to be recognised before
   * it is read.
   */
  icon?: IconName;
  /**
   * ASKED ONCE, IN PLACE. A list whose single-row delete already asks — the photo cards do, in the
   * lightbox's own pill — must not become less careful when the reader is deleting twenty. This is
   * that same question, in the same shape: the button becomes the confirmation, and anything else
   * pressed takes it back. A list that deletes a row outright leaves it off and keeps doing so.
   */
  confirm?: string;
}

/**
 * ONE ACTION BAR, IN ONE PLACE, AT ONE HEIGHT.
 *
 * WHAT WAS WRONG WITH IT. Measured over a library background: with the mode off the plate was
 * 100×40 at the far edge; with it on, 288×38 — so entering selection changed the bar's HEIGHT and
 * moved the list under it by two pixels, and the plate's own ground changed colour at the same
 * moment. Three things moving at once for one press is what made it read as improvised rather than
 * as a toolbar.
 *
 * SO THE BAR IS A FIXED SLOT. Same height, same place, same ground, whichever state it is in; only
 * its CONTENTS change. The mode is announced by the tick and by the edge, not by repainting the
 * surface — a control that changes colour to say it is active is also a control the reader has to
 * re-find.
 *
 * The order follows the list's own reading direction and is stated once here rather than per list:
 * the tick and «تحديد الكل» lead, the count sits with them because it is what they produced, the
 * actions trail, and «إلغاء» ends it. See selection.css for why the surface is built the way it is.
 */
export function SelectionBar(props: {
  sel: ListSelection;
  /** How many rows are on screen. Nothing is drawn at all when there are none. */
  total: number;
  actions: SelectionAction[];
  /** Placed inside the bar before the actions, for a list with something else to say. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { sel } = props;
  // Which action, if any, is currently standing as a question. Held here rather than by each list,
  // because the answer is always the same and forgetting to clear it is always the same bug.
  const [asking, setAsking] = useState<string | null>(null);
  if (props.total === 0) return null;

  if (!sel.on) {
    return (
      <div className="sel-bar">
        <button className="sel-enter" onClick={sel.enter}>{t("select.start")}</button>
      </div>
    );
  }

  return (
    <div className="sel-bar on" role="toolbar" aria-label={t("select.start")}>
      <button
        className="sel-all"
        onClick={sel.toggleAll}
        aria-pressed={sel.state === "all"}
        title={t("select.all")}
      >
        <SelectionTick state={sel.state} />
        <span className="sel-all-label">{t("select.all")}</span>
      </button>
      <span className="sel-count">{t("select.count", { n: String(sel.count) })}</span>
      {props.children}
      <span className="sel-spacer" />
      {props.actions.length > 0 && <span className="sel-sep" aria-hidden />}
      {props.actions.map((a) => (
        <button
          key={a.key}
          className={`sel-act${a.danger ? " danger" : ""}${asking === a.key ? " asking" : ""}`}
          onClick={() => {
            if (!a.confirm || asking === a.key) { setAsking(null); a.run(); return; }
            setAsking(a.key);
          }}
          disabled={sel.count === 0}
        >
          {a.icon && <Icon name={a.icon} size="sm" />}
          <span>{asking === a.key ? a.confirm : a.label}</span>
        </button>
      ))}
      <button
        className="sel-cancel"
        onClick={() => { if (asking) setAsking(null); else sel.exit(); }}
      >
        {t("select.cancel")}
      </button>
    </div>
  );
}

/**
 * The tick. One glyph with three states rather than a native checkbox, because "some" has no native
 * form that survives a theme — and the partial state is the one that tells a reader «تحديد الكل»
 * would ADD to what they have rather than replace it.
 */
/**
 * Spread onto a row while the mode is on: the row's whole press chooses it, and nothing inside the
 * row acts. CAPTURE phase, because the handlers being suppressed are on the row's own children — a
 * bubbling handler would run after the excerpt had already jumped the reader somewhere else.
 */
export function rowSelectProps(sel: ListSelection, id: string): Record<string, unknown> {
  if (!sel.on) return {};
  return {
    onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault();
      e.stopPropagation();
      sel.toggle(id);
    },
  };
}

export function SelectionTick({ state }: { state: AllState | boolean }) {
  const s: AllState = state === true ? "all" : state === false ? "none" : state;
  return (
    <span className={`sel-tick ${s}`} aria-hidden>
      {s === "all" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : s === "some" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
          <path d="M6 12h12" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The per-row tick. A BUTTON, not a decoration: a reader who tabs to a row must be able to choose it
 * without a pointer, and the row's own press is doing something else entirely.
 */
export function SelectionBox(props: { on: boolean; onToggle: () => void; label?: string }) {
  const { t } = useI18n();
  return (
    <button
      className={`sel-box${props.on ? " on" : ""}`}
      role="checkbox"
      aria-checked={props.on}
      aria-label={props.label ?? t("select.one")}
      onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
    >
      <SelectionTick state={props.on} />
    </button>
  );
}
