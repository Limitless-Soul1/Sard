// Global App Settings (RAWY-39, design Band H) — the app-wide settings surface opened from the
// Library. DISTINCT from the in-book reading panel (RAWY-24/34): this sets the WHOLE app —
// interface font, default theme & light/dark mode, reading defaults for NEW books, language —
// while a book's own font/theme are set while reading. Sectioned window: left nav + content.
// UI chrome → inherits the UI direction (RAWY-30) and uses theme tokens.

import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import type { TKey } from "../../i18n/locales/en";
import { Hoopoe } from "../library/Hoopoe";
import { settingsGet, settingsSet } from "../../lib/ipc";
import { FONT_CATALOGUE, useFonts } from "../../lib/fonts";
import { BOOKMARK_COLORS, BOOKMARK_SHAPES, BOOKMARK_SIZE_MAX, BOOKMARK_SIZE_MIN, useBookmarkStyle } from "../../lib/bookmarkStyle";
import { BookmarkShape } from "../reader/BookmarkShape";
import { useStyleScope } from "../../lib/styleScope";
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
        <Label hint={t("gs.libraryThemeHint")}>{t("gs.libraryTheme")}</Label>
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

      <div className="gs-note">{t("gs.appearance.fontsMoved")}</div>
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

// ---- Fonts & Library (RAWY-93 — rebuilt to the on-disk design): App font · Book font · shared library ----
const UI_WEIGHTS: { w: number; key: TKey }[] = [
  { w: 400, key: "fonts.weight.regular" },
  { w: 500, key: "fonts.weight.medium" },
  { w: 700, key: "fonts.weight.bold" },
];
// book-picker key → the @font-face family used to render that face's own name/preview in the panel
// (the app-document faces from global.css; imported fonts use their own family). RAWY-92 keys included.
const BOOK_FAMILY: Record<string, string> = {
  amiri: "Amiri", notoNaskh: "NotoNaskhArabic", arefRuqaa: "ArefRuqaa", plexArabic: "SardUIArabic",
  literata: "Literata", sourceSerif: "SourceSerif4", inter: "Inter", plexLatin: "SardUILatin",
};
const bookFamily = (key: string) => `"${BOOK_FAMILY[key] ?? key}"`;

// A weight segmented control (design: each label rendered in the target face AT that weight, so the
// control previews the weight). Marks weights the chosen face does NOT ship (honest, RAWY-36 — e.g.
// Amiri is 400/700 only, so Medium is flagged; picking it still works, rendering the nearest).
function WeightSeg({ value, avail, onPick, face }: { value: number; avail: number[]; onPick: (w: number) => void; face: string }) {
  const { t } = useI18n();
  return (
    <div className="gs-wseg" role="group">
      {UI_WEIGHTS.map((o) => {
        const has = avail.includes(o.w);
        return (
          <button
            key={o.w}
            type="button"
            className={`gs-wseg-item${value === o.w ? " on" : ""}${has ? "" : " na"}`}
            style={{ fontFamily: face, fontWeight: o.w }}
            onClick={() => onPick(o.w)}
            title={has ? undefined : t("fonts.weight.na")}
          >
            {t(o.key)}{has ? "" : " ·"}
          </button>
        );
      })}
    </div>
  );
}

// The design's picker ROW: the current face's name rendered IN ITS OWN FACE + a sub-label + a
// "Change ›" affordance, with the REAL <select> (owner-verified logic) laid transparently on top so
// clicking anywhere opens the native menu and onChange runs the existing handler — no logic change.
function FontPickRow({ faceFamily, name, sub, value, onChange, children }: {
  faceFamily: string; name: string; sub: ReactNode; value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void; children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <label className="gs-fpick">
      <span className="gs-fpick-main">
        <span className="gs-fpick-name" style={{ fontFamily: faceFamily }}>{name}</span>
        <span className="gs-fpick-sub">{sub}</span>
      </span>
      <span className="gs-fpick-change">{t("fonts.change")} <span aria-hidden>›</span></span>
      <select className="gs-fpick-native" value={value} onChange={onChange} aria-label={name}>
        {children}
      </select>
    </label>
  );
}

function FontsSection() {
  const { t, lang } = useI18n();
  const { uiFont, uiWeight, custom, setUiFont, setUiWeight, removeFont } = useFonts();
  const [style, setStyle] = useState<ReadingStyle | null>(null);

  useEffect(() => {
    (async () => {
      const raw = await settingsGet(STYLE_KEY).catch(() => null);
      let parsed: Partial<ReadingStyle> = {};
      if (raw) { try { parsed = JSON.parse(raw) as Partial<ReadingStyle>; } catch { parsed = {}; } }
      setStyle({ ...LATIN_DEFAULTS, ...parsed });
    })();
  }, []);
  const patchBook = (p: Partial<ReadingStyle>) => setStyle((cur) => {
    if (!cur) return cur;
    const next = { ...cur, ...p };
    settingsSet(STYLE_KEY, JSON.stringify(next)).catch(console.error);
    return next;
  });

  const appCat = FONT_CATALOGUE.find((f) => f.css === (uiFont ?? ""));
  const appAvail = appCat?.weights ?? [400, 500, 700]; // imported fonts: assume the full set
  const appStack = uiFont ? `"${uiFont}", var(--ui-font)` : "var(--ui-font)";
  const appName = appCat ? appCat.label : (uiFont ?? "");
  const appSub = uiFont == null
    ? t("fonts.app.rowDefault")
    : appCat
      ? appCat.scripts.map((s) => t(s === "ar" ? "fonts.ar" : "fonts.la")).join(" + ")
      : t("gs.imported");
  const libCount = FONT_CATALOGUE.length + custom.length;
  const arName = (k: string) => (k in ARABIC_FONTS ? ARABIC_FONTS[k as ArabicFont].label : k);
  const laName = (k: string) => (k in LATIN_FONTS ? LATIN_FONTS[k as LatinFont].label : k);
  // remove an imported font AND drop it from any default that used it (clean fall-back to the built-ins).
  const onRemove = (id: string, family: string) => {
    removeFont(id);
    if (style?.arabicFont === family) patchBook({ arabicFont: LATIN_DEFAULTS.arabicFont });
    if (style?.latinFont === family) patchBook({ latinFont: LATIN_DEFAULTS.latinFont });
  };
  const badges = (isApp: boolean, isAr: boolean, isEn: boolean) =>
    !isApp && !isAr && !isEn ? null : (
      <span className="gs-flib-badges">
        {isApp && <span className="gs-badge gs-badge-app">{t("fonts.badge.app")}</span>}
        {isAr && <span className="gs-badge gs-badge-book">{t("fonts.badge.bookAr")}</span>}
        {isEn && <span className="gs-badge gs-badge-book">{t("fonts.badge.bookEn")}</span>}
      </span>
    );
  // imported fonts (script unknown) offered in BOTH book pickers, mirroring RAWY-44/92.
  const customOpts = custom.map((c) => (
    <option key={c.family_name} value={c.family_name}>{`${c.family_name} · ${t("gs.imported")}`}</option>
  ));

  return (
    <>
      <div className="gs-fh">
        <SecHead>{t("fonts.title")}</SecHead>
        <span className="gs-fh-note">{t("fonts.appwideShort")}</span>
      </div>

      <div className="gs-fcards">
        {/* ===== APP FONT — one family for the whole interface ===== */}
        <section className="gs-fcard">
          <div className="gs-fcard-head">
            <span className="gs-fcard-ico gs-fcard-ico-app" aria-hidden>⌂</span>
            <div><div className="gs-fcard-title">{t("fonts.app")}</div><div className="gs-fcard-sub">{t("fonts.app.sub")}</div></div>
          </div>
          <FontPickRow faceFamily={appStack} name={appName} sub={appSub} value={uiFont ?? ""} onChange={(e) => setUiFont(e.target.value || null)}>
            <option value="">{t("fonts.app.default")}</option>
            {FONT_CATALOGUE.filter((f) => f.css).map((f) => <option key={f.id} value={f.css}>{f.label}</option>)}
            {custom.map((c) => <option key={c.id} value={c.family_name}>{`${c.family_name} · ${t("gs.imported")}`}</option>)}
          </FontPickRow>
          <div className="gs-wblock">
            <div className="gs-fc-cap">{t("fonts.weight")}</div>
            <WeightSeg value={uiWeight} avail={appAvail} onPick={setUiWeight} face={appStack} />
          </div>
          <div className="gs-fprev">
            <div className="gs-fc-cap">{t("fonts.preview")}</div>
            <div className="gs-fprev-text" style={{ fontFamily: appStack, fontWeight: uiWeight }}>{t("fonts.app.previewText")}</div>
          </div>
        </section>

        {/* ===== BOOK FONT — the default for NEW books (per-book overrides while reading are separate) ===== */}
        {style && (
          <section className="gs-fcard">
            <div className="gs-fcard-head">
              <span className="gs-fcard-ico gs-fcard-ico-book" aria-hidden>▤</span>
              <div><div className="gs-fcard-title">{t("fonts.book")}</div><div className="gs-fcard-sub">{t("fonts.book.sub")}</div></div>
            </div>
            <div className="gs-fpick-stack">
              <FontPickRow faceFamily={bookFamily(style.arabicFont)} name={arName(style.arabicFont)} sub={`${t("fonts.ar")} · ${arName(style.arabicFont)}`} value={style.arabicFont} onChange={(e) => patchBook({ arabicFont: e.target.value })}>
                {(Object.keys(ARABIC_FONTS) as ArabicFont[]).map((k) => <option key={k} value={k}>{ARABIC_FONTS[k].label}</option>)}
                {customOpts}
              </FontPickRow>
              <FontPickRow faceFamily={bookFamily(style.latinFont)} name={laName(style.latinFont)} sub={`${t("fonts.la")} · ${laName(style.latinFont)}`} value={style.latinFont} onChange={(e) => patchBook({ latinFont: e.target.value })}>
                {(Object.keys(LATIN_FONTS) as LatinFont[]).map((k) => <option key={k} value={k}>{LATIN_FONTS[k].label}</option>)}
                {customOpts}
              </FontPickRow>
            </div>
            <div className="gs-wblock">
              <div className="gs-fc-cap">{t("fonts.weight")}</div>
              <WeightSeg value={style.fontWeight} avail={[400, 500, 700]} onPick={(w) => patchBook({ fontWeight: w })} face={bookFamily(style.latinFont)} />
            </div>
            <div className="gs-sblock">
              <div className="gs-slider-head"><span className="gs-fc-cap">{t("gs.defaultSize")}</span><span className="gs-slider-val">{localeDigits(`${Math.round(style.zoom * 100)}%`, lang)}</span></div>
              <input className="gs-slider" type="range" min={0.8} max={2.5} step={0.05} value={style.zoom} onChange={(e) => patchBook({ zoom: Math.round(Number(e.target.value) * 100) / 100 })} />
            </div>
            <div className="gs-fprev">
              <div className="gs-fc-cap">{t("fonts.preview")}</div>
              <div className="gs-fprev-text" style={{ fontWeight: style.fontWeight }}>
                <div dir="rtl" style={{ fontFamily: bookFamily(style.arabicFont) }}>{t("fonts.book.previewAr")}</div>
                <div dir="ltr" style={{ fontFamily: bookFamily(style.latinFont) }}>{t("fonts.book.previewEn")}</div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* ===== FONT LIBRARY — every face in its own face, usable by the app AND books ===== */}
      <section className="gs-flib">
        <div className="gs-flib-head">
          <div className="gs-flib-titles">
            <span className="gs-flib-title">{t("fonts.library")}</span>
            <span className="gs-flib-sub">{t("fonts.library.sub", { n: localeDigits(String(libCount), lang) })}</span>
          </div>
          <AddFontButton />
        </div>
        <div className="gs-flib-grid">
          {FONT_CATALOGUE.map((f) => (
            <div key={f.id} className="gs-flib-card">
              <div className="gs-flib-main">
                <div className="gs-flib-name" style={{ fontFamily: f.css ? `"${f.css}"` : "var(--ui-font)" }}>{f.label}</div>
                <div className="gs-flib-meta">{t("fonts.builtin")} · {f.scripts.map((s) => t(s === "ar" ? "fonts.ar" : "fonts.la")).join(" + ")}</div>
              </div>
              {badges((uiFont ?? "") === f.css, !!f.bookArabic && style?.arabicFont === f.bookArabic, !!f.bookLatin && style?.latinFont === f.bookLatin)}
            </div>
          ))}
          {custom.map((c) => (
            <div key={c.id} className="gs-flib-card gs-flib-card-imported">
              <div className="gs-flib-main">
                <div className="gs-flib-name" style={{ fontFamily: `"${c.family_name}"` }}>{c.family_name}</div>
                <div className="gs-flib-meta">{t("gs.imported")} · TTF</div>
              </div>
              {badges(uiFont === c.family_name, style?.arabicFont === c.family_name, style?.latinFont === c.family_name)}
              <button className="gs-flib-remove" onClick={() => onRemove(c.id, c.family_name)} title={t("fonts.remove")}>✕ {t("fonts.remove")}</button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---- Reading defaults (for NEW books): the global reading_style baseline ----
function ReadingDefaultsSection() {
  const { t, lang } = useI18n();
  const { scope, setScope } = useStyleScope();
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

      {/* RAWY-43: choose whether all books share one style (unified) or each keeps its own. */}
      <div className="gs-sec">
        <Label>{t("gs.scope")}</Label>
        <Seg<"unified" | "perbook">
          value={scope}
          onPick={(s) => setScope(s)}
          options={[
            { key: "perbook", label: t("gs.scope.perbook") },
            { key: "unified", label: t("gs.scope.unified") },
          ]}
        />
        <div className="gs-note">{scope === "unified" ? t("gs.scope.unifiedHint") : t("gs.scope.perbookHint")}</div>
      </div>

      {/* Book font, weight & size now live in the Fonts panel (RAWY-91); line spacing stays here. */}
      <div className="gs-sec">
        <div className="gs-slider-head"><span>{t("gs.defaultLineSpacing")}</span><span className="gs-slider-val">{localeDigits(style.lineHeight.toFixed(2), lang)}</span></div>
        {/* RAWY-65: an RTL-mirror fix was investigated (see the Slider component's comment in
            ReadingSettings.tsx) and found unnecessary — this runtime already auto-mirrors native
            <input type=range> correctly for RTL, both visually and for click/drag, with no code. */}
        <input className="gs-slider" type="range" min={1.2} max={2.6} step={0.05} value={style.lineHeight}
          onChange={(e) => patch({ lineHeight: Math.round(Number(e.target.value) * 100) / 100 })} />
      </div>
      <div className="gs-note">{t("gs.reading.fontsHint")}</div>
    </>
  );
}

function BookmarkSection() {
  const { t, lang } = useI18n();
  const { shape, color, pos, size, setShape, setColor, setPos, setSize } = useBookmarkStyle();
  return (
    <>
      <SecHead>{t("gs.bookmark")}</SecHead>
      <div className="gs-note">{t("gs.bookmark.subtitle")}</div>

      <div className="gs-sec">
        <Label>{t("gs.bookmark.shape")}</Label>
        <div className="gs-bm-grid">
          {BOOKMARK_SHAPES.map((s) => (
            <button
              key={s.key}
              className={`gs-bm-cell${shape === s.key ? " on" : ""}`}
              onClick={() => setShape(s.key)}
              title={s.label}
              aria-label={s.label}
            >
              <BookmarkShape shape={s.key} color={color} h={30} />
            </button>
          ))}
        </div>
      </div>

      <div className="gs-sec">
        <Label hint={BOOKMARK_COLORS.find((c) => c.hex.toLowerCase() === color.toLowerCase())?.name}>
          {t("gs.bookmark.color")}
        </Label>
        <div className="gs-bm-colors">
          {BOOKMARK_COLORS.map((c) => (
            <button
              key={c.key}
              className={`gs-bm-color${color.toLowerCase() === c.hex.toLowerCase() ? " on" : ""}`}
              style={{ background: c.hex }}
              onClick={() => setColor(c.hex)}
              title={c.name}
              aria-label={c.name}
            />
          ))}
        </div>
      </div>

      <div className="gs-sec">
        <Label hint={localeDigits(`${size}px`, lang)}>{t("gs.bookmark.size")}</Label>
        <input
          className="gs-slider"
          type="range"
          min={BOOKMARK_SIZE_MIN}
          max={BOOKMARK_SIZE_MAX}
          step={2}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        />
        {/* preview at the ACTUAL chosen size */}
        <div className="gs-bm-sizeprev">
          <BookmarkShape shape={shape} color={color} h={size} />
        </div>
      </div>

      <div className="gs-sec">
        <Label hint={t("gs.bookmark.posHint")}>{t("gs.bookmark.position")}</Label>
        <input
          className="gs-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
        />
        {/* a live preview of the marker on a mock page edge */}
        <div className="gs-bm-preview">
          <span className="gs-bm-preview-mark" style={{ left: `${pos * 100}%` }}>
            <BookmarkShape shape={shape} color={color} h={34} />
          </span>
        </div>
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
