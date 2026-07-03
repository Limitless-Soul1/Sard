import { useState } from "react";

import { useI18n, type Lang } from "../../i18n";

// First-run welcome / language picker (RAWY-84, design Band W). The very first thing a new reader
// sees, before any language is chosen — so it is deliberately BILINGUAL (both scripts shown at
// once, neither selected). Warm Ivory, a book-cover keyline, the hoopoe haloed above a balanced
// "Sard · سَرْد" lockup (Arabic in the app's UI Arabic font, sized up to match the Latin), then two
// equal language cards. Choosing one persists the UI language (D22 — still changeable later in
// Global Settings) and proceeds straight into the app; there is no Continue step.
export function LanguagePicker() {
  const { setLang } = useI18n();
  const [bird, setBird] = useState(true);
  const choose = (lang: Lang) => setLang(lang);

  return (
    <main className="welcome" dir="ltr">
      {/* warm-Ivory brand backdrop */}
      <div className="page-grain welcome-grain" aria-hidden />
      <div className="welcome-vignette" aria-hidden />
      <div className="welcome-watermark" aria-hidden>س</div>
      <div className="welcome-keyline welcome-keyline-outer" aria-hidden />
      <div className="welcome-keyline welcome-keyline-inner" aria-hidden />

      <div className="welcome-col">
        {/* hoopoe hero with warm halo */}
        <div className="welcome-hero">
          <div className="welcome-halo" aria-hidden />
          {bird && (
            <img
              className="welcome-bird"
              src="/assets/sard-bird.png"
              alt="Sard hoopoe"
              onError={() => setBird(false)}
            />
          )}
        </div>

        {/* balanced bilingual wordmark */}
        <div className="welcome-wordmark">
          <span className="welcome-latin">Sard</span>
          <span className="welcome-bar" aria-hidden />
          <span className="welcome-ar">سَرْد</span>
        </div>

        {/* ornament rule */}
        <div className="welcome-rule" aria-hidden>
          <span className="welcome-rule-line" />
          <span className="welcome-rule-dot">◆</span>
          <span className="welcome-rule-line" />
        </div>

        {/* choose-language — bilingual by design */}
        <div className="welcome-prompt">
          <span className="welcome-prompt-en">Choose your language</span>
          <span className="welcome-sep" aria-hidden>·</span>
          <span className="welcome-prompt-ar" dir="rtl">اختر لغة الواجهة</span>
        </div>

        {/* two equal language cards */}
        <div className="welcome-choices">
          <button className="welcome-lang" onClick={() => choose("en")}>
            English
          </button>
          <button className="welcome-lang welcome-lang-ar" onClick={() => choose("ar")} dir="rtl">
            العربية
          </button>
        </div>

        {/* changeable-later footnote — bilingual */}
        <div className="welcome-foot">
          <span className="welcome-foot-en">You can change this anytime</span>
          <span className="welcome-sep" aria-hidden>·</span>
          <span className="welcome-foot-ar" dir="rtl">يمكنك تغييرها في أي وقت</span>
        </div>
      </div>
    </main>
  );
}
