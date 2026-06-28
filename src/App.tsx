import "./styles/global.css";
import { I18nProvider, useI18n } from "./i18n";
import { LanguagePicker } from "./features/onboarding/LanguagePicker";
import { Reader } from "./features/reader/Reader";

// RAWY-12: i18n foundation. First run shows the language picker; afterwards the saved
// language drives the UI + app direction. The book reading container stays direction-
// independent (handled in Reader).
function Root() {
  const { ready, hasLang } = useI18n();
  if (!ready) return null; // brief: settings loading
  return hasLang ? <Reader /> : <LanguagePicker />;
}

function App() {
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}

export default App;
