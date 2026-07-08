// TTS engine menu (RAWY-113, design 6) — the Engine chip opens this: pick Edge (online neural) or
// Piper (offline). Names stay Latin; the trait localizes (متصل / غير متصل); Edge carries the teal
// online dot. Selecting switches the engine (keeping the language) via the store; the Voices chip
// then refines the specific voice. Opens above the trailing chips.

import { useI18n } from "../../i18n";
import { type TtsEngineKind, useTts } from "../../lib/tts";

const ENGINES: { engine: TtsEngineKind; name: string }[] = [
  { engine: "edge", name: "Edge" },
  { engine: "piper", name: "Piper" },
];

export function TtsEngineMenu({ onClose }: { onClose: () => void }) {
  const { t, dir } = useI18n();
  const active = useTts((s) => s.engine);
  const setEngine = useTts((s) => s.setEngine);

  return (
    <div className="tts-menu tts-engine-menu" dir={dir} role="menu" aria-label={t("tts.engine")}>
      <div className="tts-menu-head">{t("tts.engine")}</div>
      {ENGINES.map(({ engine, name }) => {
        const on = engine === active;
        const online = engine === "edge";
        return (
          <button
            key={engine}
            className={`tts-menu-row${on ? " on" : ""}`}
            role="menuitemradio"
            aria-checked={on}
            onClick={() => {
              if (!on) setEngine(engine);
              onClose();
            }}
          >
            <span className="tts-menu-name">{name}</span>
            <span className={`tts-echip-trait${online ? " online" : ""}`}>
              {online && <span className="tts-teal-dot" aria-hidden />}
              {online ? t("tts.online") : t("tts.offline")}
            </span>
            {on && (
              <svg className="tts-menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
