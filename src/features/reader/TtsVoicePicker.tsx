// TTS voice picker (RAWY-111; rescoped RAWY-113 for design 6) — the Voices chip opens this: the
// voices available for the CURRENT engine + book language (Edge Arabic → Salma/Zariyah/Hamed/…;
// Piper → the bundled voice). The Engine chip picks the engine; this refines the voice. Selecting
// persists it per language and switches live. Opens above the trailing chips.
//
// RAWY-197: the picker now lists EVERY language Edge returns (the backend ar-/en- filter was removed).
// Languages are grouped into SECTIONS — one per primary ISO code — each headed by the language's
// OWN NAME (endonym: "Français", "Deutsch", "العربية"), in a fixed order: Multilingual → العربية →
// English → every other language alphabetically by endonym. Dialects group INSIDE their language,
// with the region shown per voice. The long list is navigated by section + scroll: a search field was
// built and then REMOVED at the owner's request (RAWY-197) — do not re-add it without asking.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { loadPickerVoices, type PickerVoice, useTts } from "../../lib/tts";

// Section sort order: Multilingual FIRST (those voices speak any language), then العربية, then English,
// then every other language alphabetically by endonym. Multilingual detection wins over locale, so a
// voice whose id contains "Multilingual" heads the list regardless of its locale.
const MULTILINGUAL = "__multilingual"; // synthetic section key for the "Multilingual" group
// RAWY-199: a voice whose locale is empty (the backend sends "" when Microsoft omits it) still has to be
// SELECTABLE — dropping it would lose a voice. It used to land in a section literally headed "__nolocale",
// because that raw key was passed to `endonymOf`, which throws on it and falls back to echoing the code.
// Give it a real, localized header instead, and sort it LAST.
const UNKNOWN_LANG = "__unknown"; // synthetic section key for voices with no usable locale
const PINNED: Record<string, number> = { ar: 1, en: 2 }; // العربية, English — fixed positions after Multilingual

// An endonym whose FIRST letter is lowercase-cased in the script — title-case it so section headers are
// visually consistent ("français" → "Français"). RAWY-197: a narrow, targeted exception — the Bantu
// `isi-` prefix is correct with a lowercase `i` (isiZulu, isiXhosa), so it is SPARED from title-casing.
const titleCaseEndonym = (s: string): string => {
  if (s.length === 0) return s;
  if (s.startsWith("isi")) return s; // the `isi-` convention is intentionally lowercase — do not touch it
  const first = s.charAt(0);
  const isLower = first !== first.toUpperCase() && first === first.toLowerCase();
  return isLower ? first.toUpperCase() + s.slice(1) : s;
};

// Endonym for a primary ISO code, in the language's OWN script (not translated into the UI language):
// `new Intl.DisplayNames(["fr"], {type:"language"}).of("fr")` → "français" → title-cased → "Français".
// Falls back to the raw code if the API is missing OR `.of()` rejects/throws on the code. RAWY-197: ICU's
// `DisplayNames.of()` THROWS `invalid_argument` on a code that is not a valid Unicode language id (empty
// string, "__nolocale", "QLatin1", …) — it does NOT return undefined. So the `.of()` call itself must be
// inside the try, not just the constructor. With the backend ar-/en- filter removed, locales that never
// appeared before now reach this path, so the throw is reachable on real data.
const endonymOf = (primary: string): string => {
  if (!primary) return primary; // empty → nothing to display-name
  try {
    const Ctor = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of: (c: string) => string | undefined } }).DisplayNames;
    if (!Ctor) return primary; // older runtime without Intl.DisplayNames → use the code as-is
    const name = new Ctor([primary], { type: "language" }).of(primary);
    if (name && name !== primary) return titleCaseEndonym(name);
  } catch {
    /* constructor missing OR .of() rejected the code — fall back to the code */
  }
  return primary;
};

// The synthetic Multilingual section header follows the UI LANGUAGE (it is a category, not a language):
// Arabic UI → "متعدّد اللغات", English UI → "Multilingual".
const MULTILINGUAL_KEY = "tts.secMultilingual";
// RAWY-199: header for voices Microsoft returns with no locale — a real, localized label instead of the
// raw "__nolocale" placeholder that used to be rendered verbatim.
const UNKNOWN_LANG_KEY = "tts.secUnknownLang";

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

  // Localized region name (ar-EG → "Egypt" / "مصر"); falls back to the raw code. RAWY-197: ICU's
  // `DisplayNames.of()` THROWS `invalid_argument` on an invalid region code (empty, "__nolocale", a
  // non-CLDR 2-letter code, …) — it does NOT return undefined — so each `.of()` call is itself wrapped.
  const regionName = useMemo(() => {
    const Ctor = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of: (c: string) => string | undefined } }).DisplayNames;
    if (!Ctor) return (code: string) => code; // older runtime → raw code
    let dn: { of: (c: string) => string | undefined } | null = null;
    try { dn = new Ctor([uiLang], { type: "region" }); } catch { /* type "region" unsupported */ }
    return (code: string) => {
      if (!dn || !code) return code;
      try { return dn.of(code) ?? code; } catch { return code; } // invalid region → raw code
    };
  }, [uiLang]);

  // RAWY-187 (Part A): scope to the CURRENT ENGINE only (the Engine chip picks Piper vs Edge). The former
  // book-language filter is GONE — every book's picker now lists all of the engine's voices, grouped by
  // language section below, so a Multilingual/English voice can be chosen even for an Arabic book. Selection
  // still persists per the current book language (`setVoice(…, curLang)` unchanged), so playback is identical.
  // RAWY-197: the selected voice (`voice`) is resolved at play time — the unset default is WilliamMultilingual,
  // so on a profile with no saved choice, `voice` already equals it and the row is marked "on" naturally.
  const items = useMemo(
    () => (voices ?? []).filter((v) => v.engine === engine),
    [voices, engine],
  );

  // Build the FULL section list ONCE (deps: items + uiLang) — the expensive work (grouping, per-language
  // Intl.DisplayNames lookups, sorting). RAWY-197: with ~90 languages the endonym lookups are non-trivial,
  // so they are isolated here rather than recomputed on each render.
  const allSections = useMemo(() => {
    const by = new Map<string, PickerVoice[]>();
    const endonymByKey = new Map<string, string>();
    for (const v of items) {
      // RAWY-199: `v.lang` is "" when the voice carries no locale — bucket it under a real section key
      // rather than passing the raw placeholder to `endonymOf` (which throws on it). The voice is still
      // listed and selectable; only its heading changes.
      const key = v.id.includes("Multilingual") ? MULTILINGUAL : (v.lang || UNKNOWN_LANG);
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(v);
      const synthetic = key === MULTILINGUAL || key === UNKNOWN_LANG;
      if (!endonymByKey.has(key)) endonymByKey.set(key, synthetic ? "" : endonymOf(key));
    }
    const sections = Array.from(by.keys()).map((key) => {
      const header =
        key === MULTILINGUAL ? t(MULTILINGUAL_KEY)
        : key === UNKNOWN_LANG ? t(UNKNOWN_LANG_KEY)
        : endonymByKey.get(key) ?? key;
      const list = by.get(key)!.sort((a, b) => a.label.localeCompare(b.label, uiLang, { sensitivity: "base" }));
      return { key, header, endonym: endonymByKey.get(key) ?? key, voices: list };
    });
    sections.sort((a, b) => {
      if (a.key === MULTILINGUAL) return -1; // Multilingual always heads the list
      if (b.key === MULTILINGUAL) return 1;
      if (a.key === UNKNOWN_LANG) return 1; // …and the no-locale bucket always tails it
      if (b.key === UNKNOWN_LANG) return -1;
      const pa = PINNED[a.key] ?? Infinity;
      const pb = PINNED[b.key] ?? Infinity;
      if (pa !== pb) return pa - pb;
      return a.endonym.localeCompare(b.endonym, uiLang, { sensitivity: "base" });
    });
    return sections.filter((s) => s.voices.length > 0);
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
          allSections.map((g) => (
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
