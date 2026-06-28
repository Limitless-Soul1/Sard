import { useI18n, type Lang } from "../../i18n";

// First-run, full-screen language picker. Tasteful (paper + Sard wordmark), not final
// polish. Selecting a language persists it and sets the app direction; it won't show again.
export function LanguagePicker() {
  const { setLang } = useI18n();
  const choose = (lang: Lang) => setLang(lang);

  return (
    <main className="picker" dir="ltr">
      <div className="picker-inner">
        <h1 className="picker-wordmark">
          Sard <span className="picker-dot">·</span> <span className="sard-ar">سَرْد</span>
        </h1>
        <p className="picker-prompt">Choose your language · اختر لغة الواجهة</p>
        <div className="picker-choices">
          <button className="picker-btn" onClick={() => choose("en")}>
            English
          </button>
          <button className="picker-btn picker-btn-ar" onClick={() => choose("ar")} dir="rtl">
            العربية
          </button>
        </div>
      </div>
    </main>
  );
}
