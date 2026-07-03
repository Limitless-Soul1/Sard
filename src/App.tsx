import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/global.css";
import { I18nProvider, useI18n } from "./i18n";
import { initBookmarkStyle } from "./lib/bookmarkStyle";
import { initFonts } from "./lib/fonts";
import { initStyleScope } from "./lib/styleScope";
import { initTheme, useTheme } from "./theme";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Library, type OpenTarget } from "./features/library/Library";
import { Reader } from "./features/reader/Reader";
import { libraryListBooks, settingsGet, settingsSet } from "./lib/ipc";

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

  if (!i18nReady || !themeReady) return null; // brief: settings loading (avoids theme flash)
  if (!hasLang) return <LanguagePicker />;
  return open ? <Reader book={open} onExit={() => setOpen(null)} /> : <Library onOpen={setOpen} />;
}

function App() {
  useEffect(() => {
    initTheme(); // load + apply persisted theme/override/hide-titles/mode (RAWY-39)
    initFonts(); // load + apply persisted UI font + register imported @font-faces (RAWY-39)
    initBookmarkStyle(); // load persisted bookmark shape/colour/position (RAWY-41)
    initStyleScope(); // load unified-vs-per-book book-style scope (RAWY-43)
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
