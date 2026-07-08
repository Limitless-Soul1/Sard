// TTS voice picker (RAWY-111) — lists BOTH engines' voices grouped by language, each labelled by
// engine: Piper (offline, the bundled default) + every free Edge neural voice for Arabic/English.
// Picking a voice persists it for that language and, if it's the language being read now, switches
// live. Opens above the player pill; the current book's language group is shown first.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { loadPickerVoices, type PickerVoice, type TtsLang, useTts } from "../../lib/tts";

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

  // Group by language; the book's current language first so its voices are at the top.
  const groups = useMemo(() => {
    const all = voices ?? [];
    const order: TtsLang[] = curLang === "ar" ? ["ar", "en"] : ["en", "ar"];
    return order
      .map((lg) => ({ lang: lg, items: all.filter((v) => v.lang === lg) }))
      .filter((g) => g.items.length);
  }, [voices, curLang]);

  const meta = (v: PickerVoice): string => {
    if (v.engine !== "edge") return "";
    const region = v.locale.includes("-") ? regionName(v.locale.split("-")[1]) : "";
    const g = v.gender ? t(v.gender === "Male" ? "tts.male" : "tts.female") : "";
    return [region, g].filter(Boolean).join(" · ");
  };

  return (
    <div className="tts-picker" dir={dir} role="dialog" aria-label={t("tts.voices")}>
      <div className="tts-picker-head">
        <span>{t("tts.voices")}</span>
        <button className="tts-ghost" onClick={onClose} aria-label={t("tts.collapse")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m6 10 6 6 6-6" /></svg>
        </button>
      </div>
      <div className="tts-picker-scroll">
        {voices === null ? (
          <div className="tts-picker-empty">{t("tts.loadingVoices")}</div>
        ) : (
          groups.map((g) => (
            <div key={g.lang} className="tts-picker-group">
              <div className="tts-picker-glabel">{t(g.lang === "ar" ? "tts.lang.ar" : "tts.lang.en")}</div>
              {g.items.map((v) => {
                const on = v.engine === engine && v.id === voice && v.lang === curLang;
                return (
                  <button
                    key={v.engine + v.id}
                    className={`tts-voice-row${on ? " on" : ""}`}
                    onClick={() => {
                      setVoice(v.engine, v.id, v.lang);
                      onClose();
                    }}
                  >
                    <span className="tts-voice-name">{v.label}</span>
                    <span className="tts-voice-meta">{meta(v)}</span>
                    <span className={`tts-voice-badge ${v.engine}`}>
                      {t(v.engine === "piper" ? "tts.piperBadge" : "tts.edgeBadge")}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
