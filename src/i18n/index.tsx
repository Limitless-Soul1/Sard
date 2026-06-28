// Tiny zero-dependency i18n: a React context exposing { lang, dir, t, setLang }.
// UI DIRECTION follows the app language and is applied to <html dir>. The book reading
// container is isolated from this (see Reader / global.css) — book direction comes from
// foliate (book.dir), independent of the UI.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { settingsGet, settingsSet } from "../lib/ipc";
import { en, type TKey } from "./locales/en";
import { ar } from "./locales/ar";

export type Lang = "en" | "ar";
const LANG_KEY = "ui_lang";

const RESOURCES: Record<Lang, Record<TKey, string>> = { en, ar };
const dirOf = (lang: Lang): "ltr" | "rtl" => (lang === "ar" ? "rtl" : "ltr");

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  ready: boolean; // settings loaded
  hasLang: boolean; // a language was chosen (else show first-run picker)
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function translate(lang: Lang, key: TKey, vars?: Record<string, string | number>): string {
  let s = RESOURCES[lang][key] ?? en[key] ?? (key as string);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

function applyDocumentDir(lang: Lang) {
  const el = document.documentElement;
  el.lang = lang;
  el.dir = dirOf(lang);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  const [ready, setReady] = useState(false);
  const [hasLang, setHasLang] = useState(false);

  // Load the saved UI language on startup; if none, the picker is shown.
  useEffect(() => {
    (async () => {
      const saved = await settingsGet(LANG_KEY).catch(() => null);
      if (saved === "en" || saved === "ar") {
        setLangState(saved);
        applyDocumentDir(saved);
        setHasLang(true);
      } else {
        applyDocumentDir("en"); // neutral default while the picker is shown
      }
      setReady(true);
    })();
  }, []);

  const setLang = (next: Lang) => {
    setLangState(next);
    applyDocumentDir(next);
    setHasLang(true);
    settingsSet(LANG_KEY, next).catch(console.error);
  };

  const value: I18nValue = {
    lang,
    dir: dirOf(lang),
    ready,
    hasLang,
    t: (key, vars) => translate(lang, key, vars),
    setLang,
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
