import { useEffect, useState } from "react";
import "./styles/global.css";
import { I18nProvider, useI18n } from "./i18n";
import { initTheme, useTheme } from "./theme";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Library, type OpenTarget } from "./features/library/Library";
import { Reader } from "./features/reader/Reader";
import { libraryDevSeed } from "./lib/ipc";

// RAWY-12 i18n + RAWY-13 themes + RAWY-15 Library home. First run shows the language
// picker; afterwards the saved language/theme drive the UI and the Library is the home
// screen. Selecting a book opens the Reading View; its back button returns here.
function Root() {
  const { ready: i18nReady, hasLang } = useI18n();
  const themeReady = useTheme((s) => s.ready);
  const [open, setOpen] = useState<OpenTarget | null>(null);

  if (!i18nReady || !themeReady) return null; // brief: settings loading (avoids theme flash)
  if (!hasLang) return <LanguagePicker />;
  return open ? <Reader book={open} onExit={() => setOpen(null)} /> : <Library onOpen={setOpen} />;
}

function App() {
  useEffect(() => {
    initTheme(); // load + apply persisted theme/override/hide-titles
    libraryDevSeed().catch(console.error); // DEV: seed a believable library (idempotent)
  }, []);
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}

export default App;
