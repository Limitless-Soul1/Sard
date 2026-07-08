// TTS voice picker (RAWY-111; rescoped RAWY-113 for design 6) — the Voices chip opens this: the
// voices available for the CURRENT engine + book language (Edge Arabic → Salma/Zariyah/Hamed/…;
// Piper → the bundled voice). The Engine chip picks the engine; this refines the voice. Selecting
// persists it per language and switches live. Opens above the trailing chips.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { loadPickerVoices, type PickerVoice, useTts } from "../../lib/tts";

export function TtsVoicePicker({ onClose }: { onClose: () => void }) {
  const { t, lang: uiLang, dir } = useI18n();
  const engine = useTts((s) => s.engine);
  const voice = useTts((s) => s.voice);
  const curLang = useTts((s) => s.lang);
  const setVoice = useTts((s) => s.setVoice);
  const [voices, setVoices] = useState<PickerVoice[] | null>(null);

  useEffect(() => {
    let ok = true;
    void loadPickerVoices().then((v) => {
      if (ok) setVoices(v);
    });
    return () => {
      ok = false;
    };
  }, []);

  // Localized region name (ar-EG → "Egypt" / "مصر"); falls back to the raw code.
  const regionName = useMemo(() => {
    try {
      const dn = new (Intl as unknown as { DisplayNames: new (l: string[], o: { type: string }) => { of: (c: string) => string | undefined } }).DisplayNames([uiLang], { type: "region" });
      return (code: string) => dn.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [uiLang]);

  // Scope to the CURRENT engine + language (the engine is chosen on the Engine chip).
  const items = useMemo(
    () => (voices ?? []).filter((v) => v.engine === engine && v.lang === curLang),
    [voices, engine, curLang],
  );

  const meta = (v: PickerVoice): string => {
    if (v.engine !== "edge") return t("tts.offline");
    const region = v.locale.includes("-") ? regionName(v.locale.split("-")[1]) : "";
    const g = v.gender ? t(v.gender === "Male" ? "tts.male" : "tts.female") : "";
    return [region, g].filter(Boolean).join(" · ");
  };

  return (
    <div className="tts-menu tts-voices-menu" dir={dir} role="dialog" aria-label={t("tts.voices")}>
      <div className="tts-menu-head">{t("tts.voices")}</div>
      <div className="tts-menu-scroll">
        {voices === null ? (
          <div className="tts-menu-empty">{t("tts.loadingVoices")}</div>
        ) : items.length === 0 ? (
          <div className="tts-menu-empty">{t("tts.loadingVoices")}</div>
        ) : (
          items.map((v) => {
            const on = v.id === voice && v.engine === engine;
            return (
              <button
                key={v.engine + v.id}
                className={`tts-menu-row${on ? " on" : ""}`}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  setVoice(v.engine, v.id, curLang);
                  onClose();
                }}
              >
                <span className="tts-menu-name">{v.label}</span>
                <span className="tts-voice-meta">{meta(v)}</span>
                {on && (
                  <svg className="tts-menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
