// Global App Settings (RAWY-39, design Band H) — the app-wide settings surface opened from the
// Library. DISTINCT from the in-book reading panel (RAWY-24/34): this sets the WHOLE app —
// interface font, default theme & light/dark mode, reading defaults for NEW books, language —
// while a book's own font/theme are set while reading. Sectioned window: left nav + content.
// UI chrome → inherits the UI direction (RAWY-30) and uses theme tokens.

import { useEffect, useState, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { Hoopoe } from "../library/Hoopoe";
import { settingsGet, settingsSet } from "../../lib/ipc";
import { BUILTIN_BOOK_FONTS, useFonts } from "../../lib/fonts";
import {
  ARABIC_FONTS,
  LATIN_DEFAULTS,
  LATIN_FONTS,
  type ArabicFont,
  type LatinFont,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { THEMES, THEME_ORDER, currentMode, useTheme, type ThemeMode } from "../../theme";

const STYLE_KEY = "reading_style";

type Section = "appearance" | "fonts" | "reading" | "bookmark" | "language" | "about";
const NAV: { key: Section; label: TKey; icon: string }[] = [
  { key: "appearance", label: "gs.nav.appearance", icon: "◑" },
  { key: "fonts", label: "gs.nav.fonts", icon: "A" },
  { key: "reading", label: "gs.nav.reading", icon: "▤" },
  { key: "bookmark", label: "gs.nav.bookmark", icon: "▸" },
  { key: "language", label: "gs.nav.language", icon: "⌘" },
  { key: "about", label: "gs.nav.about", icon: "ⓘ" },
];

const LANGS = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

export function GlobalSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, dir } = useI18n();
  const [section, setSection] = useState<Section>("appearance");
  if (!open) return null;
  return (
    <>
      <div className="panel-scrim show" onClick={onClose} />
      <div className="gs" role="dialog" aria-modal="true" dir={dir}>
        {/* left nav */}
        <nav className="gs-nav">
          <div className="gs-brand">
            <Hoopoe size={22} />
            <span className="gs-brand-name">{t("gs.title")}</span>
          </div>
          <div className="gs-nav-list">
            {NAV.map((n) => (
              <button
                key={n.key}
                className={`gs-nav-item${section === n.key ? " on" : ""}`}
                onClick={() => setSection(n.key)}
              >
                <span className="gs-nav-ico" aria-hidden>{n.icon}</span>
                {t(n.label)}
              </button>
            ))}
          </div>
          <div className="gs-appwide">
            <b>{t("gs.appwide")}</b> {t("gs.appwideNote")}
          </div>
        </nav>
        {/* content */}
        <div className="gs-content">
          <div className="gs-topbar">
            <button className="gs-x" onClick={onClose} aria-label="✕">✕</button>
          </div>
          <div className="gs-body">
            {section === "appearance" && <AppearanceSection />}
            {section === "fonts" && <FontsSection />}
            {section === "reading" && <ReadingDefaultsSection />}
            {section === "bookmark" && <BookmarkSection />}
            {section === "language" && <LanguageSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </>
  );
}

// ---- shared bits ----
function SecHead({ children }: { children: ReactNode }) {
  return <div className="gs-h1">{children}</div>;
}
function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="gs-lbl-row">
      <span className="gs-lbl">{children}</span>
      {hint != null && <span className="gs-lbl-hint">{hint}</span>}
    </div>
  );
}
function Seg<T extends string>({ value, options, onPick }: { value: T; options: { key: T; label: ReactNode }[]; onPick: (k: T) => void }) {
  return (
    <div className="gs-seg" role="group">
      {options.map((o) => (
        <button key={o.key} className={`gs-seg-item${value === o.key ? " on" : ""}`} onClick={() => onPick(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Appearance: mode + default theme + interface font ----
function AppearanceSection() {
  const { t } = useI18n();
  const { themeId, autoMode, setTheme, setMode } = useTheme();
  const fonts = useFonts();
  const mode = currentMode({ themeId, autoMode });
  return (
    <>
      <SecHead>{t("gs.appearance")}</SecHead>

      <div className="gs-sec">
        <Label>{t("gs.mode")}</Label>
        <Seg<ThemeMode>
          value={mode}
          onPick={(m) => setMode(m)}
          options={[
            { key: "day", label: `☀ ${t("gs.mode.day")}` },
            { key: "night", label: `☾ ${t("gs.mode.night")}` },
            { key: "auto", label: `⚙ ${t("gs.mode.auto")}` },
          ]}
        />
      </div>

      <div className="gs-sec">
        <Label hint={t("gs.appliesAppWide")}>{t("gs.defaultTheme")}</Label>
        <div className="gs-swatches">
          {THEME_ORDER.map((id) => (
            <button key={id} className="gs-swatch-cell" onClick={() => setTheme(id)} title={THEMES[id].name}>
              <span
                className={`gs-swatch${themeId === id && !autoMode ? " on" : ""}`}
                style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
              >
                Aa
              </span>
              <span className="gs-swatch-name">{THEMES[id].name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="gs-sec">
        <Label hint={t("gs.uiFontHint")}>{t("gs.uiFont")}</Label>
        <div className="gs-fontrow">
          <select
            className="gs-select"
            value={fonts.uiFont ?? ""}
            onChange={(e) => fonts.setUiFont(e.target.value || null)}
          >
            <option value="">{t("gs.uiFontDefault")}</option>
            {fonts.uiChoices().map((c) => (
              <option key={c.family} value={c.family}>
                {c.label}
                {c.builtin ? "" : ` · ${t("gs.imported")}`}
              </option>
            ))}
          </select>
          <AddFontButton />
        </div>
        {/* live preview in the chosen face */}
        <div className="gs-fontpreview" style={{ fontFamily: fonts.uiFont ? `"${fonts.uiFont}", var(--ui-font)` : "var(--ui-font)" }}>
          Sard · سَرْد · The quick brown fox — 0123
        </div>
      </div>
    </>
  );
}

function AddFontButton() {
  const { t } = useI18n();
  const importFont = useFonts((s) => s.importFont);
  const setUiFont = useFonts((s) => s.setUiFont);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  return (
    <button
      className="gs-addfont"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const f = await importFont();
          if (f) {
            setUiFont(f.family_name); // make the just-imported font the active UI font
            setAdded(f.family_name);
            window.setTimeout(() => setAdded(null), 2400);
          }
        } catch (e) {
          console.error(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {added ? t("gs.fontAdded", { name: added }) : t("gs.addFont")}
    </button>
  );
}

// ---- Fonts & library: the shared catalogue ----
function FontsSection() {
  const { t } = useI18n();
  const { custom, removeFont } = useFonts();
  return (
    <>
      <SecHead>{t("gs.nav.fonts")}</SecHead>
      <div className="gs-sec">
        <Label>{t("gs.sharedLibrary")}</Label>
        <div className="gs-chips">
          {BUILTIN_BOOK_FONTS.map((f) => (
            <span key={f.family} className="gs-chip" style={{ fontFamily: f.family }}>{f.label}</span>
          ))}
          <span className="gs-chip">Inter</span>
          <span className="gs-chip">IBM Plex Arabic</span>
          {custom.map((c) => (
            <span key={c.id} className="gs-chip gs-chip-imported" style={{ fontFamily: `"${c.family_name}"` }}>
              {c.family_name} · {t("gs.imported")}
              <button className="gs-chip-x" onClick={() => removeFont(c.id)} title={t("gs.remove")} aria-label={t("gs.remove")}>×</button>
            </span>
          ))}
          <AddFontButton />
        </div>
        <div className="gs-note">{t("gs.fontsUsedBy")}</div>
      </div>
    </>
  );
}

// ---- Reading defaults (for NEW books): the global reading_style baseline ----
function ReadingDefaultsSection() {
  const { t } = useI18n();
  const [style, setStyle] = useState<ReadingStyle | null>(null);

  useEffect(() => {
    (async () => {
      const raw = await settingsGet(STYLE_KEY).catch(() => null);
      let parsed: Partial<ReadingStyle> = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Partial<ReadingStyle>;
        } catch {
          parsed = {};
        }
      }
      setStyle({ ...LATIN_DEFAULTS, ...parsed });
    })();
  }, []);

  const patch = (p: Partial<ReadingStyle>) => {
    setStyle((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...p };
      settingsSet(STYLE_KEY, JSON.stringify(next)).catch(console.error);
      return next;
    });
  };

  if (!style) return <SecHead>{t("gs.reading")}</SecHead>;
  return (
    <>
      <SecHead>{t("gs.reading")}</SecHead>
      <div className="gs-banner">↻ {t("gs.readingBanner")}</div>

      <div className="gs-sec gs-two">
        <div>
          <Label>{t("gs.defaultLatin")}</Label>
          <select className="gs-select" value={style.latinFont} onChange={(e) => patch({ latinFont: e.target.value as LatinFont })}>
            {(Object.keys(LATIN_FONTS) as LatinFont[]).map((k) => (
              <option key={k} value={k}>{LATIN_FONTS[k].label}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>{t("gs.defaultArabic")}</Label>
          <select className="gs-select" value={style.arabicFont} onChange={(e) => patch({ arabicFont: e.target.value as ArabicFont })}>
            {(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => (
              <option key={k} value={k}>{ARABIC_FONTS[k].label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="gs-sec">
        <div className="gs-slider-head"><span>{t("gs.defaultSize")}</span><span className="gs-slider-val">{Math.round(style.zoom * 100)}%</span></div>
        <input className="gs-slider" type="range" min={0.8} max={2.5} step={0.05} value={style.zoom}
          onChange={(e) => patch({ zoom: Math.round(Number(e.target.value) * 100) / 100 })} />
      </div>
      <div className="gs-sec">
        <div className="gs-slider-head"><span>{t("gs.defaultLineSpacing")}</span><span className="gs-slider-val">{style.lineHeight.toFixed(2)}</span></div>
        <input className="gs-slider" type="range" min={1.2} max={2.6} step={0.05} value={style.lineHeight}
          onChange={(e) => patch({ lineHeight: Math.round(Number(e.target.value) * 100) / 100 })} />
      </div>
    </>
  );
}

function BookmarkSection() {
  const { t } = useI18n();
  return (
    <>
      <SecHead>{t("gs.bookmark")}</SecHead>
      <div className="gs-soon">
        <span className="gs-soon-ico" aria-hidden>▸</span>
        <span>{t("gs.bookmarkSoon")}</span>
      </div>
    </>
  );
}

function LanguageSection() {
  const { t, lang, setLang } = useI18n();
  return (
    <>
      <SecHead>{t("gs.language")}</SecHead>
      <div className="gs-sec">
        <Seg
          value={lang}
          onPick={(c) => setLang(c)}
          options={LANGS.map((l) => ({ key: l.code, label: l.label }))}
        />
        <div className="gs-note">{t("gs.languageHint")}</div>
      </div>
      <TwoLevelCard />
    </>
  );
}

function AboutSection() {
  const { t } = useI18n();
  return (
    <>
      <SecHead>{t("gs.about")}</SecHead>
      <div className="gs-about">
        <Hoopoe size={34} />
        <div>
          <div className="gs-about-name">Sard · سَرْد</div>
          <div className="gs-about-tag">{t("gs.about.tagline")}</div>
          <div className="gs-about-ver">{t("gs.about.version")} 0.1.0</div>
        </div>
      </div>
      <TwoLevelCard />
    </>
  );
}

// The explicit two-level distinction (design Band H) — global vs in-book.
function TwoLevelCard() {
  const { t } = useI18n();
  return (
    <div className="gs-twolevel">
      <div className="gs-tl-card gs-tl-global">
        <div className="gs-tl-head"><span className="gs-tl-ico">⌂</span>{t("gs.twoLevel.global")}</div>
        <div className="gs-tl-desc">{t("gs.twoLevel.globalDesc")}</div>
      </div>
      <div className="gs-tl-card gs-tl-inbook">
        <div className="gs-tl-head"><span className="gs-tl-ico gs-tl-ico-book">▤</span>{t("gs.twoLevel.inbook")}</div>
        <div className="gs-tl-desc">{t("gs.twoLevel.inbookDesc")}</div>
      </div>
    </div>
  );
}
