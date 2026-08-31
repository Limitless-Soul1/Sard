/**
 * ONE DIALOG BEHAVIOUR, FOR EVERY SURFACE THAT CLAIMS TO BE ONE.
 *
 * WHY THIS EXISTS. Eight surfaces in Sard render `role="dialog" aria-modal="true"`, and measured
 * through the interface only one of them behaved like a dialog. On the unsaved-changes dialog:
 * focus stayed on the button behind the scrim, Tab kept focus inside 0 times out of 10 — it walked
 * the editor's chapter rail underneath — the dialog carried no accessible name, and Escape did
 * nothing. The scrim blocked the POINTER the whole time, so a reader using a keyboard could operate
 * exactly what the modal claimed to have made inert, with no way to dismiss it.
 *
 * `aria-modal="true"` is a promise to assistive technology that the rest of the page is unavailable.
 * This is the code that makes the promise true, said once so the eight cannot drift again.
 *
 *   · focus moves in when the dialog opens
 *   · Tab and Shift+Tab cycle WITHIN it
 *   · Escape dismisses it, where the caller says dismissal is meaningful
 *   · focus returns to whatever opened it
 *   · it carries an accessible name
 *
 * NESTING IS REAL HERE, not hypothetical: the unsaved-changes question opens on top of the profile
 * editor, which is itself a dialog. So this keeps a stack, and only the TOP of the stack traps keys.
 * Escape closes the nearest thing, which is what `CreateDialog` already did by hand and what a
 * reader means by Escape.
 *
 * IT CHANGES NO VISUAL DESIGN AND NO DECISION. `onDismiss` is whatever the caller's own cancel path
 * already is — for the unsaved question that is Cancel, which leaves the draft exactly where it was.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Open dialogs, innermost last. Only the last one answers the keyboard. */
const stack: HTMLElement[] = [];

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Everything inside `root` a Tab could land on, in document order, that is actually on screen. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => {
    if (e.hasAttribute("disabled") || e.getAttribute("aria-hidden") === "true") return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none";
  });
}

export interface DialogChrome {
  /** Put on the dialog element itself. */
  ref: (el: HTMLElement | null) => void;
  /** Spread onto the dialog element. Carries the roles, the name and the trap. */
  props: {
    role: "dialog";
    "aria-modal": true;
    "aria-labelledby"?: string;
    "aria-label"?: string;
    tabIndex: -1;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  };
  /**
   * Put on the element that NAMES the dialog — its own title. A dialog with no name is announced
   * as an anonymous group, which tells a reader that something has taken over and not what.
   */
  titleId: string;
}

export function useDialog(opts: {
  /**
   * What Escape does. Omit for a dialog that must be answered — Escape then does nothing rather
   * than choosing on the reader's behalf.
   *
   * IT IS THE CALLER'S OWN CANCEL. Nothing here decides anything: the unsaved question passes its
   * Cancel, so Escape leaves the draft untouched exactly as pressing «ابقَ هنا» does.
   */
  onDismiss?: () => void;
  /** A name of its own, for a dialog whose title is not a visible element. */
  label?: string;
  /**
   * WHERE focus lands inside, not whether it enters — it always enters, or the trap cannot arm.
   * `auto` takes the first field if the dialog has one; `none` takes the dialog itself, which is
   * what a surface that opens on a page rather than on a question wants.
   */
  initialFocus?: "auto" | "none";
}): DialogChrome {
  const titleId = useId();
  /**
   * THE ELEMENT, AS STATE, AND THAT IS THE WHOLE TRICK.
   *
   * A ref plus a mount-time effect is the obvious shape and it is wrong here: several of these
   * dialogs live inside components that are mounted the whole time and merely render `null` until
   * they are opened — Settings, the unsaved question, the editor. Their effect would run once, at a
   * moment when there is no dialog to trap, and never again. Measured with the ref version: focus
   * was never moved in and Tab walked straight out (0/10). Holding the node in state makes the
   * effect re-run every time the dialog actually appears or goes away, which is the event that
   * matters.
   */
  const [el, setEl] = useState<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dismiss = useRef(opts.onDismiss);
  dismiss.current = opts.onDismiss;
  const initial = opts.initialFocus ?? "auto";

  useEffect(() => {
    const node = el;
    if (!node) return;
    // Whatever had focus is what opened this, and is where focus belongs when it closes.
    const previously = document.activeElement as HTMLElement | null;
    if (previously && previously !== document.body) opener.current = previously;
    stack.push(node);

    /**
     * FOCUS ALWAYS ENTERS. `initialFocus` chooses WHERE inside, never whether — measured with
     * "none" meaning "leave focus alone": the trap is a handler on the dialog, so focus left
     * outside meant the handler never ran and Tab walked the library behind Settings (0/10).
     *
     * A FIELD IF THERE IS ONE, otherwise the dialog itself — never the first button. Landing on a
     * button means the next Enter presses it, and one of these dialogs deletes a profile.
     */
    if (!node.contains(document.activeElement)) {
      const field = initial === "none"
        ? null
        : node.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea");
      (field ?? node).focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (stack[stack.length - 1] !== node) return;   // an inner dialog owns it
      if (!dismiss.current) return;                    // this one must be answered
      e.preventDefault();
      e.stopPropagation();
      dismiss.current();
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(node);
      if (i >= 0) stack.splice(i, 1);
      // Only take focus back if it is still ours to give — if something else has claimed it in the
      // meantime, moving it would be the second surprise.
      const back = opener.current;
      if (back && back.isConnected && (!document.activeElement || document.activeElement === document.body
        || node.contains(document.activeElement))) {
        back.focus({ preventScroll: true });
      }
    };
    // Runs when the dialog element appears, and unwinds when it goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, initial]);

  /**
   * THE TRAP. Handled on the dialog rather than at the window so a Tab pressed inside a nested
   * dialog is answered by that dialog and not by the one beneath it.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const node = el;
    if (!node || stack[stack.length - 1] !== node) return;
    const items = focusables(node);
    if (items.length === 0) { e.preventDefault(); node.focus({ preventScroll: true }); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !node.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  // A stable callback, so React does not detach and re-attach the node on every render — which
  // would unwind and rebuild the trap under the reader's fingers.
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);

  return {
    ref,
    props: {
      role: "dialog",
      "aria-modal": true,
      ...(opts.label ? { "aria-label": opts.label } : { "aria-labelledby": titleId }),
      tabIndex: -1,
      onKeyDown,
    },
    titleId,
  };
}
