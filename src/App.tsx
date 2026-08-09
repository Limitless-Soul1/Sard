import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/global.css";
import { I18nProvider, useI18n } from "./i18n";
import { initBookmarkStyle } from "./lib/bookmarkStyle";
import { initReadMarkerStyle } from "./lib/readMarkerStyle"; // RAWY-256: persisted read-marker variant
import { initFonts } from "./lib/fonts";
import { applyBackgrounds, initBackground, useBackground } from "./lib/background"; // RAWY-265
import { initStyleScope } from "./lib/styleScope";
import { diagStart } from "@diag"; // DIAGNOSTIC BUILD ONLY - observes, never intervenes
import { registerOutcomeRecorder } from "./lib/listeningOutcomes"; // RAWY-263: the local outcome baseline
import { initTheme, reapplyTitlebarTheme, useTheme, THEMES } from "./theme";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Library, type OpenTarget } from "./features/library/Library";
import { Reader } from "./features/reader/Reader";
import { RuntimeGate } from "./app/RuntimeGate"; // RESILIENCE-1 / WP-1
import { canRender } from "./lib/runtime";
import { libraryListBooks, settingsGet, settingsSet, discordClear } from "./lib/ipc";
import { initDiscordSettings, useDiscordSettings } from "./lib/discordSettings";
import { initDiscordPresence, showBrowsingPresence } from "./reader-engine/discordPresence";

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

  // Discord: no book open (initial launch, or after backing out of one) -> "Browsing the library".
  useEffect(() => {
    if (!open) {
      showBrowsingPresence();
    }
  }, [open]);

  if (!i18nReady || !themeReady) return null; // brief: settings loading (avoids theme flash)
  // RESILIENCE-1 / WP-1: the runtime gate. foliate's OPF parser needs browser features an older
  // WebView2 does not have; without them NO book opens, so this is a genuine precondition rather
  // than a per-book failure. Placed AFTER i18n is ready (so the notice is in the user's language)
  // but BEFORE the language picker: choosing a language is pointless if nothing can be read.
  // A missing PDF capability is NOT checked here — EPUB reading is unaffected by it (see RuntimeGate).
  if (!canRender("epub")) return <RuntimeGate />;
  if (!hasLang) return <LanguagePicker />;
  return open ? (
    <Reader
      book={open}
      onExit={() => setOpen(null)}
      onOpenBook={setOpen}
    />
  ) : (
    <Library onOpen={setOpen} />
  );
}

function App() {
  useEffect(() => {
    initTheme(); // load + apply persisted theme/override/hide-titles/mode (RAWY-39)
    initFonts(); // load + apply persisted UI font + register imported @font-faces (RAWY-39)
    initBookmarkStyle(); // load persisted bookmark shape/colour/position (RAWY-41)
    initReadMarkerStyle(); // RAWY-256: persisted chapter read-marker variant (global, like bookmark shape)
    initStyleScope(); // load unified-vs-per-book book-style scope (RAWY-43)
    // DIAGNOSTIC BUILD ONLY. Armed at startup so the tester has to do nothing special before
    // reproducing — the evidence for a failure is worthless if collection began after it. Hooks
    // `fetch` and subscribes to the TTS store; it records and never intervenes.
    diagStart();
    // RAWY-265: loaded in the SAME startup batch as the theme, so the first paint is already correct.
    // Applying it later would paint the themed ground first and then swap — the RAWY-118 class of flash.
    initBackground();
    registerOutcomeRecorder(); // RAWY-263: observe listening outcomes locally. Read-only; never writes while audio plays.
    initDiscordSettings(); // load persisted Discord presence settings
  }, []);

  // Discord Rich Presence — opt-in, off by default. Starts/stops the presence subscriber LIVE as the
  // Sharing-tab master switch flips, so no restart is needed for the toggle to take effect.
  useEffect(() => {
    let stopDiscord: (() => void) | undefined;

    const apply = (enabled: boolean) => {
      if (enabled && !stopDiscord) {
        stopDiscord = initDiscordPresence();
      } else if (!enabled && stopDiscord) {
        stopDiscord();
        stopDiscord = undefined;
        void discordClear().catch(() => {});
      }
    };

    apply(useDiscordSettings.getState().enabled);
    const unsub = useDiscordSettings.subscribe((s) => apply(s.enabled));
    return () => {
      unsub();
      stopDiscord?.();
    };
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
    applyBackgrounds(THEMES[bgThemeId].colors);
  }, [bgThemeId, bgReady, bgEnabled, bgLibrary, bgLibParams, bgReading, bgReadParams]);

  // RAWY-118: WebView2 re-themes the native title-bar caption during its own startup, AFTER our first
  // applyTheme, so the initial caption reverts to the system (black) even though we set it. Re-apply it
  // a moment after boot and whenever the window regains focus, so the caption tracks the app theme.
  useEffect(() => {
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