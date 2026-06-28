import { useEffect } from "react";
import "./styles/global.css";
import { I18nProvider, useI18n } from "./i18n";
import { initTheme, useTheme } from "./theme";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Reader } from "./features/reader/Reader";

// RAWY-12 i18n + RAWY-13 themes. First run shows the language picker; afterwards the
// saved language drives the UI direction and the saved theme drives all surfaces.
function Root() {
  const { ready: i18nReady, hasLang } = useI18n();
  const themeReady = useTheme((s) => s.ready);
  if (!i18nReady || !themeReady) return null; // brief: settings loading (avoids theme flash)
  return hasLang ? <Reader /> : <LanguagePicker />;
}

function App() {
  useEffect(() => {
    initTheme(); // load + apply persisted theme/override/hide-titles
  }, []);
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}

export default App;
