import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
// Design tokens first, so every sheet after this can read them. Defining them changes nothing on
// its own — no rule consumes them yet; the surfaces move across in their own stages.
import { isMobile } from "./lib/platform";
import { MobileApp } from "./features-mobile/app/MobileApp";
import "./styles/tokens.css";
import "./styles/global.css";
// PROFILES: its own sheet. Nothing in it overrides an existing rule, so a reader who never opens
// Profiles renders exactly as before — and `global.css` is untouched by this feature.
import "./styles/profiles.css";
import "./styles/deposit.css";
// Choosing several things at once: one appearance for every list that offers it.
import "./styles/selection.css";
import { I18nProvider, useI18n } from "./i18n";
import { initBookmarkStyle } from "./lib/bookmarkStyle";
import { initReadMarkerStyle } from "./lib/readMarkerStyle"; // RAWY-256: persisted read-marker variant
import { initFonts } from "./lib/fonts";
import { applyBackgrounds, initBackground, useBackground } from "./lib/background"; // RAWY-265
import { createCloseHandler, runCloseFlush } from "./lib/closeFlush"; // the window close is owned by the page, not the Reader
import { diagStart } from "@diag"; // DIAGNOSTIC BUILD ONLY - observes, never intervenes
import { registerOutcomeRecorder } from "./lib/listeningOutcomes"; // RAWY-263: the local outcome baseline
import { initTheme, reapplyTitlebarTheme, resolveTheme, useTheme } from "./theme";
import { initProfiles } from "./features/profiles/store"; // PROFILES: register authored themes first
import { UnsavedChange } from "./features/profiles/UnsavedChange";
import { DroppedProfile } from "./features/profiles/DroppedProfile";
import { FontDropNotice } from "./features/fonts/FontDropNotice";
import { FontSpecimen } from "./features/fonts/FontSpecimen";
import { DroppedDeposit } from "./features/deposit/DroppedDeposit";
import { useIncomingDeposit } from "./features/deposit/store";
import { useBookDetailsRequest } from "./features/library/bookDetailsRequest";
import { useOpenFileRequest } from "./features/library/openFileRequest";
import { routeDroppedPaths } from "./features/profiles/dropRoute";
import { initPresence } from "./lib/presence"; // DISC/RPC: load the Discord on/off switch
import { LegalGate } from "./features/legal/LegalGate";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Library, type OpenTarget } from "./features/library/Library";
import { Reader } from "./features/reader/Reader";
import { RuntimeGate } from "./app/RuntimeGate"; // RESILIENCE-1 / WP-1
import { canRender } from "./lib/runtime";
import { libraryListBooks, openedFilesTake, settingsGet, settingsSet } from "./lib/ipc";

// RAWY-12 i18n + RAWY-13 themes + RAWY-15 Library home. First run shows the language
// picker; afterwards the saved language/theme drive the UI and the Library is the home
// screen. Selecting a book opens the Reading View; its back button returns here.
function Root() {
  const { ready: i18nReady, hasLang } = useI18n();
  const themeReady = useTheme((s) => s.ready);
  const [open, setOpen] = useState<OpenTarget | null>(null);

  // DEV: open a specific book id directly (for reader/highlight testing), then clear it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (async () => {
      const id = await settingsGet("dev_open");
      if (!id) return;
      await settingsSet("dev_open", "");
      const books = await libraryListBooks({ sort: "date_added", order: "desc" });
      const b = books.find((x) => x.id === id);
      if (b) setOpen({ id: b.id, filePath: b.file_path, dir: b.dir, format: b.format });
    })().catch(console.error);
  }, []);

  // A FILE THE OPERATING SYSTEM HANDED US — one opened with "Open with Sard", dragged onto the
  // executable, or named on the command line.
  //
  // Sard claims no extension it does not read: a deposit is an ordinary .zip, and seizing .zip would
  // take the reader's archives away from the tools he already uses to open them. BOOKS are different —
  // an .epub is a book and nothing else, and a reader who double-clicks one means to read it — so
  // those two extensions are registered at install time and arrive through this same door.
  //
  // It ends at the SAME door a dropped file takes. `routeDroppedPaths` classifies by content rather
  // than by extension, so a deposit reaches the deposit sheet and a profile reaches the profile
  // preview without this needing to know which it was handed.
  //
  // TWO ARRIVALS, ONE QUEUE. A cold start queues its argument before the window exists, so the drain
  // on mount collects it. A second launch pushes onto the same queue and emits `sard://opened`, which
  // carries nothing and only means "look again" — so a path can never arrive twice or be lost to a
  // listener that was not yet attached.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    const drain = async () => {
      const paths = await openedFilesTake().catch(() => [] as string[]);
      // ONCE TAKEN, ALWAYS DELIVERED. The drain is destructive, so a path that has left the queue can
      // never be asked for again — dropping it here because this effect has since been cleaned up
      // would lose the deposit outright. It cost a measured failure to learn: under StrictMode the
      // first mount took the path and the second found an empty queue, and nothing ever opened.
      // Routing is a write to a store that outlives the component, so it is safe after unmount.
      //
      // WHAT IS LEFT AFTER THE CONTENT GATES IS A BOOK, and a book is the library's business, not
      // this root's: importing one means refusing formats this runtime cannot render, reporting what
      // was refused, and refreshing the shelves, none of which live here. The paths are left where
      // the library will find them, so a double-clicked book is imported by exactly the code a
      // dropped book is.
      if (paths.length) await routeDroppedPaths(paths, (rest) => useOpenFileRequest.getState().hand(rest));
    };
    void drain();
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un = await listen("sard://opened", () => void drain());
        if (alive) unlisten = un;
        else un();
      } catch {
        /* not in a tauri webview — nothing hands us files */
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // «افتح الأرشيف» WHILE A BOOK IS OPEN. The archive is a library section, so the page has to come back
  // before the library can change section. Only the return trip belongs here; the library clears the
  // request once it has honoured it.
  const wantsArchive = useIncomingDeposit((s) => s.showArchive);
  const wantsBook = useBookDetailsRequest((s) => s.wanted);
  // A BOOK HANDED IN WHILE ANOTHER ONE IS OPEN. The library is unmounted whenever the reader is on
  // screen, so the only way the waiting file can be imported at all is to come back to it first —
  // and the library opens the new book itself once it has it, which is what makes a double-click
  // during reading land on the book that was double-clicked.
  const wantsFile = useOpenFileRequest((s) => s.pending.length > 0);
  useEffect(() => {
    if (wantsArchive || wantsBook || wantsFile) setOpen(null);
  }, [wantsArchive, wantsBook, wantsFile]);

  if (!i18nReady || !themeReady) return null; // brief: settings loading (avoids theme flash)
  // RESILIENCE-1 / WP-1: the runtime gate. foliate's OPF parser needs browser features an older
  // WebView2 does not have; without them NO book opens, so this is a genuine precondition rather
  // than a per-book failure. Placed AFTER i18n is ready (so the notice is in the user's language)
  // but BEFORE the language picker: choosing a language is pointless if nothing can be read.
  // A missing PDF capability is NOT checked here — EPUB reading is unaffected by it (see RuntimeGate).
  if (!canRender("epub")) return <RuntimeGate />;
  if (!hasLang) return <LanguagePicker />;
  // THE ONE PLACE THE TWO FRONT ENDS PART. Everything above is shared — settings, the runtime gate,
  // the language picker — because none of it is a layout question. Below this line the desktop chrome
  // and the mobile chrome are separate trees that share no markup and no CSS rule: a port has to be
  // difficult, not merely discouraged.
  //
  // On every desktop build `isMobile()` is false, so this costs the existing product one branch that
  // is never taken and changes nothing it renders.
  if (isMobile()) return <MobileApp />;
  // RAWY-206: `onOpenBook` is the SAME `setOpen` the Library hands a book to — the reader's Notes panel
  // uses it to open another book at a note's locator, so there is one open path, not two.
  return (
    <>
      {open ? (
        <Reader book={open} onExit={() => setOpen(null)} onOpenBook={setOpen} />
      ) : (
        <Library onOpen={setOpen} />
      )}
      {/* PROFILES (stage 5): a profile-owned value changed outside the editor has three honest
          destinations, and Sard asks rather than guessing. Mounted here because the change can come
          from either surface — Global Settings on the Library side, the theme picker and the faces
          on the reader's. It renders nothing until there is something to ask about. */}
      <UnsavedChange />
      {/* A profile dropped onto the window. The Library's drop listener already ran it through the
          import gate; this shows the ordinary preview so the drop and the picker end in one place. */}
      <DroppedProfile />
      {/* The answer a dropped font gets — app-level, because a font may be dropped anywhere. */}
      <FontDropNotice />
      {/* A font that has just arrived, shown as a page. Mounted here, beside the notice, because
          a font can be imported from the window drop or from Global Settings and the specimen has
          to appear either way. It renders nothing until one arrives. */}
      <FontSpecimen />
      <DroppedDeposit />
      {/* THE LEGAL GATE, LAST AND ON TOP. Mounted at the application root because it is about
          the installation rather than about any screen, and it renders nothing at all once the
          revision this build carries has been accepted. */}
      <LegalGate />
    </>
  );
}

function App() {
  useEffect(() => {
    // PROFILES: register reader-authored themes BEFORE the persisted theme id is resolved. A
    // `theme_id` naming a profile can only resolve once that profile's theme is registered, so
    // resolving it first would paint the fallback and correct itself a frame later — a visible
    // flash of the wrong paper. This is the one ordering constraint Profiles introduces.
    initProfiles().then(
      () => initTheme(), // load + apply persisted theme/override/hide-titles/mode (RAWY-39)
      () => initTheme(), // a failed profile load must never stop the theme from being applied
    );
    initFonts(); // load + apply persisted UI font + register imported @font-faces (RAWY-39)
    initBookmarkStyle(); // load persisted bookmark shape/colour/position (RAWY-41)
    initReadMarkerStyle(); // RAWY-256: persisted chapter read-marker variant (global, like bookmark shape)
    // DIAGNOSTIC BUILD ONLY. Armed at startup so the tester has to do nothing special before
    // reproducing — the evidence for a failure is worthless if collection began after it. Hooks
    // `fetch` and subscribes to the TTS store; it records and never intervenes.
    diagStart();
    // RAWY-265: loaded in the SAME startup batch as the theme, so the first paint is already correct.
    // Applying it later would paint the themed ground first and then swap — the RAWY-118 class of flash.
    initBackground();
    registerOutcomeRecorder(); // RAWY-263: observe listening outcomes locally. Read-only; never writes while audio plays.
    initPresence(); // DISC/RPC: load the persisted Discord on/off switch
  }, []);

  // RAWY-265 — the library background is re-derived whenever the LIBRARY theme or any of its own
  // inputs change, because both the scrim tint and the re-grounded `--lib-faint` are computed FROM
  // the theme's tokens: a theme change with a stale scrim would leave a warm image under a cold
  // palette, and a stale faint colour would silently drop below its 3:1 floor.
  //
  // `themeId` is the right dependency and not merely a convenient one: the Reader applies a book
  // theme by calling module-level `applyTheme` directly and restores the library theme on exit
  // (Reader.tsx's `libraryThemeRef`), so the STORE's `themeId` stays the library's own throughout —
  // exactly the value this surface is themed by (D29).
  // Only the LIBRARY half depends on the theme: its `--lib-faint` re-grounding needs real colour
  // numbers. The reading desk's scrim is resolved in CSS from `--app-bg`, so it follows the book
  // theme the Reader applies to `:root` with no JS involvement — which is why `bgThemeId` being the
  // LIBRARY theme (D29: the Reader restores it on exit via `libraryThemeRef`) is correct here and
  // does not leave the desk stale.
  const bgThemeId = useTheme((s) => s.themeId);
  const bgReady = useBackground((s) => s.ready);
  const bgEnabled = useBackground((s) => s.enabled);
  const bgLibrary = useBackground((s) => s.library);
  const bgLibParams = useBackground((s) => s.libraryParams);
  const bgReading = useBackground((s) => s.reading);
  const bgReadParams = useBackground((s) => s.readingParams);
  useEffect(() => {
    applyBackgrounds(resolveTheme(bgThemeId).colors);
  }, [bgThemeId, bgReady, bgEnabled, bgLibrary, bgLibParams, bgReading, bgReadParams]);

  // WebView2 re-themes the native title-bar caption during its own startup, AFTER our first paint,
  // so one call at boot does not stick. Paint it black at once (a window whose caption is briefly the
  // system's light one is the flicker this replaces), again once WebView2 has finished, and on every
  // focus — the caption is theme-independent, so these are the only three moments that matter.
  useEffect(() => {
    reapplyTitlebarTheme();
    const t = window.setTimeout(reapplyTitlebarTheme, 1200);
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) reapplyTitlebarTheme();
      })
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      window.clearTimeout(t);
      unlisten?.();
    };
  }, []);

  // THE WINDOW CLOSE, owned here because the page owns it — not the Reader.
  //
  // Tauri blocks the native close whenever `js_event_listeners` says a `tauri://close-requested`
  // listener exists (tauri/src/manager/window.rs), and that registry is emptied only by an explicit
  // `unlisten` IPC. Nothing clears it on navigation, so a page RELOAD orphans the entry: the close
  // stays prevented while the handler that was supposed to complete it is gone with the old
  // JavaScript context. Measured in that state — window visible and enabled, message loop pumping,
  // process alive indefinitely, recoverable only from outside.
  //
  // Registering here fixes it because this component is the page. The reload that orphans the old
  // entry is the same reload that mounts this and registers a fresh handler, so a live handler always
  // exists for exactly as long as a window does. Measured across the four distinguishing states, a
  // stale entry with a live handler beside it closes in one second — the entry was never the problem,
  // the absence of a handler was.
  //
  // What must be SAVED first still belongs to whoever is reading: `lib/closeFlush.ts` carries the
  // Reader's flush (position + read-aloud cursor), bounded so a slow or failed save can never leave
  // the window unclosable — the failure mode RAWY-174 already paid for once.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false; // a cleanup that beats the registration promise must still unregister
    // The decision-making lives in `lib/closeFlush.ts` so it can be tested without a window: the latch
    // that guards against a double ✕ used to be permanent, and one failed `destroy()` left the window
    // impossible to close by any means. `destroy()` bypasses this handler, so there is no re-fire loop;
    // it needs core:window:allow-destroy (granted, RAWY-174).
    const handleClose = createCloseHandler({
      flush: (ms) => runCloseFlush(ms),
      destroy: () => win.destroy(),
      // The close was released for a retry; say so, so a recurrence leaves evidence instead of only a
      // window that would not shut.
      onDestroyFailed: (err) => console.error("[sard] window destroy failed; close released for retry", err),
    });
    win
      .onCloseRequested(handleClose)
      .then((u) => { if (disposed) u(); else unlisten = u; })
      .catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // F11 toggles fullscreen (the Windows convention); Esc exits when fullscreen (RAWY-42). Works
  // app-wide via the Tauri window API. We track our OWN intent rather than reading
  // `isFullscreen()` (which can lag the actual state, so a naive `!isFullscreen()` re-entered
  // instead of exiting). Esc is a no-op when not fullscreen, so it never clobbers other Esc use.
  useEffect(() => {
    let full = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        full = !full;
        getCurrentWindow().setFullscreen(full).catch(console.error);
      } else if (e.key === "Escape" && full) {
        e.preventDefault();
        full = false;
        getCurrentWindow().setFullscreen(false).catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}

export default App;
