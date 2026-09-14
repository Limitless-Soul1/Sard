// WHAT MUST BE SAVED BEFORE THE WINDOW GOES, published by whoever currently owns it.
//
// WHY THIS EXISTS. Closing the window has to flush two things the Reader owns — the reading position
// (debounced 500 ms) and the read-aloud cursor (throttled ~2 s) — because React cleanup does not run
// when the OS closes a window, so closing mid-read would lose the last tick of each. The natural
// place to do that is the Reader, and that is where the `onCloseRequested` handler used to live.
//
// It cannot live there, and the reason is a measured Tauri lifecycle detail rather than a style
// preference. `tauri/src/manager/window.rs` decides whether to block the native close like this:
//
//     WindowEvent::CloseRequested { api } => {
//       if window.has_js_listener(WINDOW_CLOSE_REQUESTED_EVENT) { api.prevent_close(); }
//       window.emit_to_window(WINDOW_CLOSE_REQUESTED_EVENT, &())?;
//     }
//
// `has_js_listener` reads `js_event_listeners`, a registry that is filled by the `listen` IPC and
// emptied ONLY by the matching `unlisten` IPC. Nothing clears it on navigation. A page reload
// destroys the JavaScript context without sending any `unlisten`, so the entry survives the handler
// it describes: the next close is PREVENTED, and the handler that was supposed to finish it no
// longer exists. Measured — window visible and enabled, message loop pumping, process alive forever.
//
// The four states that separate cause from symptom, each ending in one WM_CLOSE:
//     library-only          Reader never mounted, no listener ever registered   -> exits in 1 s
//     in-reader             a live listener exists                              -> exits in 1 s
//     reload-after-reader   stale registry entry, NO live handler               -> HANGS
//     reload-then-reopen    stale entry PLUS a fresh live handler               -> exits in 1 s
//
// The last row is the one that decides the fix: a stale entry is harmless on its own. The failure is
// exactly "prevented, with nothing alive to complete it". So the handler moves to the application
// root, where it is registered for as long as the page exists and is re-established by the very
// reload that orphans the old registry entry — and the Reader publishes its flush here instead.
//
// Deliberately NOT a store: this is a single function pointer read once, at teardown, by code that
// must not depend on React still being able to render.

/** Saves whatever the current view must persist before the window closes. */
export type CloseFlush = () => Promise<void>;

let current: CloseFlush | null = null;

/**
 * Publish the flush for the view that owns one. Returns a disposer that clears it only if it is
 * still the registered one, so a fast unmount/mount pair cannot leave the new owner's flush erased.
 */
export function setCloseFlush(fn: CloseFlush): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}

/** Is anything currently claiming state to flush? Used by tests and diagnostics. */
export function hasCloseFlush(): boolean {
  return current !== null;
}

/**
 * Run the registered flush, bounded, never throwing.
 *
 * The close must not depend on the flush succeeding — a slow disk, a rejected IPC or a view that
 * registered nothing all have to end with the window closing anyway. `ms` is the ceiling the close
 * is willing to wait.
 */
export async function runCloseFlush(ms = 1500): Promise<"flushed" | "timeout" | "none" | "failed"> {
  const fn = current;
  if (!fn) return "none";
  let outcome: "flushed" | "failed" = "flushed";
  const work = (async () => {
    try {
      await fn();
    } catch {
      outcome = "failed";
    }
  })();
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms)),
  ]);
  return timedOut ? "timeout" : outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSE HANDLER ITSELF, as a pure function of its two effects.
//
// WHY THIS IS NOT INLINE IN `App`. The defect below cannot be reached from a unit test while the logic
// lives inside a `useEffect` that needs a real Tauri window, and it is a defect that costs the user
// their whole session — so the logic is separated from the wiring and tested directly. `App` keeps the
// registration; this owns the decision-making.
//
// THE DEFECT, MEASURED. `closing` exists so a second ✕ during a flush is ignored rather than starting a
// second flush. It was set before the flush and never released. `destroy()` was wrapped in a bare
// `catch {}`, so when it failed the handler returned with the close still PREVENTED, the window still
// there, and the latch still set — and every later ✕ hit `if (closing) return` and did nothing.
// Reproduced by injecting one destroy failure into the real handler and then repairing it:
//
//     handler FIRED / body entered / flush ran / reached destroy / destroy threw
//     ...destroy healthy again...
//     handler FIRED / IGNORED: closing latch already set        <- and nothing, ever again
//
// The window stayed visible, enabled, responsive and modal-free, and could only be force-terminated.
// A transient failure had been turned into a permanent one.
//
// THE RULE THIS NOW KEEPS: the latch describes a close that is IN PROGRESS, so it is released the
// moment the close is known not to have happened. There is deliberately NO timeout around `destroy` —
// a hung destroy is not a failure this can recover from (a second destroy would hang too), and a
// timeout would only hide it. What is fixed is the case that was measured: destroy FAILING.
export interface CloseHandlerDeps {
  /** Persist whatever the current view owns. Bounded and non-throwing by contract. */
  flush: (ms?: number) => Promise<unknown>;
  /** Actually close the window. Rejecting means the window is still there. */
  destroy: () => Promise<void>;
  /** The ceiling the close is willing to wait for the flush. */
  flushMs?: number;
  /**
   * Told when a destroy attempt failed and the latch was released for a retry.
   *
   * A failed close used to leave NO trace at all: the error went into a bare `catch {}`, so the one
   * event worth knowing about — the window refusing to go — was the one event nothing recorded. If this
   * ever fires in the field it is the first line of the next investigation, which is why it is reported
   * rather than swallowed.
   */
  onDestroyFailed?: (error: unknown) => void;
}

/**
 * Build the `onCloseRequested` handler. The returned function may be called any number of times; it
 * runs one flush-and-destroy at a time, and stays usable if a destroy fails.
 */
export function createCloseHandler(deps: CloseHandlerDeps) {
  let closing = false;
  return async function handleCloseRequested(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault(); // hold the close so the flush can finish; WE own the destroy below
    if (closing) return; // a second ✕ mid-flush is left to the first
    closing = true;
    try {
      await deps.flush(deps.flushMs ?? 1500);
    } finally {
      try {
        await deps.destroy();
        // Reached only if the window did not go away synchronously; leaving the latch set is right —
        // the close succeeded and there is nothing left to retry.
      } catch (err) {
        // THE WINDOW IS STILL HERE and the close is still prevented. Release the latch so the next
        // gesture can try again, instead of leaving a window nothing can ever close.
        closing = false;
        try {
          deps.onDestroyFailed?.(err);
        } catch {
          /* a reporter that throws must not take the retry down with it */
        }
      }
    }
  };
}
