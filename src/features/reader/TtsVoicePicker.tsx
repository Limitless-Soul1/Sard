// TTS voice picker (RAWY-111; rescoped RAWY-113 for design 6) — the Voices chip opens this: the
// voices available for the CURRENT engine + book language (Edge Arabic → Salma/Zariyah/Hamed/…;
// Piper → the bundled voice). The Engine chip picks the engine; this refines the voice. Selecting
// persists it per language and switches live. Opens above the trailing chips.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { loadPickerVoices, type PickerVoice, useTts } from "../../lib/tts";

// RAWY-187 (Part A): the picker is grouped into language SECTIONS in this fixed order. Multilingual heads
// the list because those Edge voices can speak ANY language (incl. Arabic), so they're useful for every
// book; then Arabic (the app is Arabic-first), English, then the rest. Sections with no voice are omitted.
const SECTION_ORDER = ["multilingual", "arabic", "english", "other"] as const;
type SectionKey = (typeof SECTION_ORDER)[number];
// Detect a section for one voice. Edge multilingual voices carry "Multilingual" in their short_name/`id`
// (a stable Microsoft naming convention, e.g. `en-US-AvaMultilingualNeural`) — that wins over the locale
// so they head the list. A voice NOT matched here still falls through to its locale section, so grouping
// can never drop a voice. Otherwise classify by LOCALE prefix (`ar-`/`en-`), everything else is "other".
function sectionOf(v: PickerVoice): SectionKey {
  if (v.id.includes("Multilingual")) return "multilingual";
  const loc = v.locale.toLowerCase();
  if (loc.startsWith("ar")) return "arabic";
  if (loc.startsWith("en")) return "english";
  return "other";
}

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

  // RAWY-187 (Part A): scope to the CURRENT ENGINE only (the Engine chip picks Piper vs Edge). The former
  // book-language filter is GONE — every book's picker now lists all of the engine's voices, grouped by
  // language section below, so a Multilingual/English voice can be chosen even for an Arabic book. Selection
  // still persists per the current book language (`setVoice(…, curLang)` unchanged), so playback is identical.
  const items = useMemo(
    () => (voices ?? []).filter((v) => v.engine === engine),
    [voices, engine],
  );

  // Group into the 4 fixed sections, alphabetical by display name within each, empty sections omitted.
  const groups = useMemo(() => {
    const by: Record<SectionKey, PickerVoice[]> = { multilingual: [], arabic: [], english: [], other: [] };
    for (const v of items) by[sectionOf(v)].push(v);
    const header: Record<SectionKey, string> = {
      multilingual: t("tts.secMultilingual"),
      arabic: t("tts.lang.ar"),
      english: t("tts.lang.en"),
      other: t("tts.secOther"),
    };
    return SECTION_ORDER
      .map((k) => ({
        key: k,
        header: header[k],
        voices: by[k].sort((a, b) => a.label.localeCompare(b.label, uiLang, { sensitivity: "base" })),
      }))
      .filter((g) => g.voices.length > 0);
  }, [items, t, uiLang]);

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
          // still loading (the async fetch hasn't resolved yet)
          <div className="tts-menu-empty">{t("tts.loadingVoices")}</div>
        ) : items.length === 0 ? (
          // RAWY-177 (AUD-17): loaded but empty — Edge returns no voices when offline. Show a clear
          // "no voices / offline" message instead of an eternal "loading…" spinner.
          <div className="tts-menu-empty">{t("tts.noVoices")}</div>
        ) : (
          // RAWY-187 (Part A): render each non-empty section with a small sticky header, then its voices.
          groups.map((g) => (
            <div key={g.key} className="tts-menu-group" role="group" aria-label={g.header}>
              <div className="tts-menu-section">{g.header}</div>
              {g.voices.map((v) => {
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
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
