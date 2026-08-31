// Global App Settings (RAWY-39, design Band H) — the app-wide settings surface opened from the
// Library. DISTINCT from the in-book reading panel (RAWY-24/34): this sets the WHOLE app —
// interface font, default theme & light/dark mode, reading defaults for NEW books, language —
// while a book's own font/theme are set while reading. Sectioned window: left nav + content.
// UI chrome → inherits the UI direction (RAWY-30) and uses theme tokens.

import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import type { TKey } from "../../i18n/locales/en";
import { Icon, type IconName } from "../../components/Icon";
import { getVersion } from "@tauri-apps/api/app";
import { appInfo } from "../../lib/ipc"; // BETA identification in About (build id)

import { Hoopoe } from "../library/Hoopoe";
import { ProfilesSection } from "../profiles/ProfilesSection";
import { settingsGet, settingsSet } from "../../lib/ipc";
import { useUpdater } from "../../lib/updater";
import { FONT_CATALOGUE, UI_SCALE_MAX, UI_SCALE_MIN, useFonts } from "../../lib/fonts";
// RAWY-265: the Library background surface (measured constants + the apply layer live in the module).
import { BG_BLUR_MAX, BG_PRESENCE_MAX, bgSrcUrl, imageLabel, useBackground } from "../../lib/background";
import { BOOKMARK_COLORS, BOOKMARK_SHAPES, BOOKMARK_SIZE_MAX, BOOKMARK_SIZE_MIN, useBookmarkStyle } from "../../lib/bookmarkStyle";
import { BookmarkShape } from "../reader/BookmarkShape";
import { READ_MARKERS, useReadMarkerStyle } from "../../lib/readMarkerStyle"; // RAWY-256
import { usePresence } from "../../lib/presence"; // DISC/RPC: the Discord on/off switch
import { TtsTrackingControls } from "../reader/TtsTrackingControls"; // RAWY-200
import { useStyleScope } from "../../lib/styleScope";
import {
  ARABIC_FONTS,
  LATIN_DEFAULTS,
  LATIN_FONTS,
  type ArabicFont,
  type LatinFont,
  type ReadingStyle,
} from "../../reader-engine/injectedCss";
import { THEMES, THEME_ORDER, currentMode, resolveTheme, useTheme, type ThemeMode } from "../../theme";
import { useDialog } from "../../components/useDialog";

const STYLE_KEY = "reading_style";

type Section = "appearance" | "profiles" | "fonts" | "reading" | "bookmark" | "language" | "presence" | "about";
// The row marks were text characters chosen for what existed, not for what the sections hold: the
// bookmark row was a triangle, the language row was the command symbol, and six of the eight were
// being drawn by Cambria Math with the "about" mark falling through to MS PGothic. Each is now an
// icon of its own section, read from the section body. `fonts` deliberately keeps a LETTER -- it is
// a type specimen shown in the app's own face, which is the one case where the character is the
// right mark and has no fallback problem.
const NAV: { key: Section; label: TKey; icon?: IconName; letter?: string }[] = [
  { key: "appearance", label: "gs.nav.appearance", icon: "appearance" },
  // PROFILES: one row added, beside the bookmark and read-marker that already live here. The design
  // package draws a RESTRUCTURED settings window — Fonts, Bookmark and Language gone, three new
  // entries in their place — and that restructure is a different piece of work, deliberately not
  // done here. Every existing section keeps working exactly as it did.
  { key: "profiles", label: "gs.nav.profiles", icon: "profiles" },
  { key: "fonts", label: "gs.nav.fonts", letter: "A" },
  { key: "reading", label: "gs.nav.reading", icon: "bookStyles" },
  { key: "bookmark", label: "gs.nav.bookmark", icon: "bookmark" },
  { key: "language", label: "gs.nav.language", icon: "language" },
  { key: "presence", label: "gs.nav.presence", icon: "activity" },
  { key: "about", label: "gs.nav.about", icon: "about" },
];

const LANGS = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

export function GlobalSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, dir } = useI18n();
  const [section, setSection] = useState<Section>("appearance");
  // IT ALREADY CLAIMED TO BE A MODAL DIALOG. Measured, it took no focus, trapped no Tab, carried no
  // name and ignored Escape — while its scrim blocked the pointer, so a keyboard could reach the
  // library it had covered. Nothing here changes what Settings looks like or does; it makes the
  // claim true. Escape closes, which is what the scrim and the ✕ already meant.
  const dlg = useDialog({ onDismiss: onClose, initialFocus: "none" });
  if (!open) return null;
  return (
    <>
      <div className="panel-scrim show" onClick={onClose} />
      <div className="gs" ref={dlg.ref} {...dlg.props} dir={dir}>
        {/* left nav */}
        <nav className="gs-nav">
          <div className="gs-brand">
            <Hoopoe size={22} />
            <span className="gs-brand-name" id={dlg.titleId}>{t("gs.title")}</span>
          </div>
          <div className="gs-nav-list">
            {NAV.map((n) => (
              <button
                key={n.key}
                className={`gs-nav-item${section === n.key ? " on" : ""}`}
                onClick={() => setSection(n.key)}
              >
                <span className="gs-nav-ico" aria-hidden>
                  {n.icon ? <Icon name={n.icon} size="md" /> : n.letter}
                </span>
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
            {/* The name was the symbol itself (`aria-label="✕"`), which is the exact thing
                RAWY-119 introduced `panel.close` to stop — its own note reads "a real label so it
                isn't a bare glyph". */}
            <button className="gs-x" onClick={onClose} aria-label={t("panel.close")} title={t("panel.close")}>
              <Icon name="close" size="sm" />
            </button>
          </div>
          <div className="gs-body">
            {section === "appearance" && <AppearanceSection />}
            {section === "profiles" && <ProfilesSection />}
            {section === "fonts" && <FontsSection />}
            {section === "reading" && <ReadingDefaultsSection />}
            {section === "bookmark" && <BookmarkSection />}
            {section === "language" && <LanguageSection />}
            {section === "presence" && <PresenceSection />}
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
            <button key={id} className="gs-swatch-cell" onClick={() => setTheme(id)} title={t(`theme.${id}`)}>
              <span
                className={`gs-swatch${themeId === id && !autoMode ? " on" : ""}`}
                style={{ background: THEMES[id].colors.paperBg, color: THEMES[id].colors.text }}
              >
                Aa
              </span>
              <span className="gs-swatch-name">{t(`theme.${id}`)}</span>
            </button>
          ))}
        </div>
      </div>

      <LibraryBackgroundSection />

      <div className="gs-note">{t("gs.appearance.fontsMoved")}</div>
    </>
  );
}

// ---- RAWY-265: the Library background ----
//
// PROGRESSIVE DISCLOSURE, and it is load-bearing rather than cosmetic. The settings inventory already
// records that this app is at its practical control ceiling (33 settings; the in-book tab strip
// wraps at five tabs and cannot be fixed by shortening labels — RAWY-217 measured that). A feature
// that added six permanent rows would make that worse for every user, including the ones who never
// want a background. So with no image chosen this contributes ONE row; the controls only exist once
// there is something for them to control.
function LibraryBackgroundSection() {
  const { t, lang } = useI18n();
  const themeId = useTheme((s) => s.themeId);
  const theme = resolveTheme(themeId);
  const { enabled, library, libraryParams, setEnabled, setParams, choose, clear, resetParams } = useBackground();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await choose("library", picked, theme.colors.paperBg);
    } catch (e) {
      // Rust returns a stable `bg.err.*` CODE, not a sentence, so the message is localised here and
      // stays inside the i18n system (both locales, parity enforced). An unmapped code falls back to
      // showing itself rather than an empty toast.
      const code = String(e);
      const known = code.startsWith("bg.err.");
      setError(known ? t(code as TKey) : code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gs-sec">
      <Label hint={t("gs.bgHint")}>{t("gs.bg")}</Label>

      {!library ? (
        <>
          {/* RAWY-278: the button states the REAL in-flight state rather than only greying out. */}
          <button className="gs-addfont" disabled={busy} aria-busy={busy} onClick={pick}>
            {busy && <span className="bg-ctl-spin" aria-hidden />}
            {busy ? t("gs.bg.preparing") : t("gs.bg.choose")}
          </button>
          <div className="gs-note">{busy ? t("gs.bg.preparingHint") : t("gs.bg.formats")}</div>
        </>
      ) : (
        <>
          <div className="bg-ctl-row">
            <span
              className="bg-ctl-thumb"
              style={{
                backgroundImage: `url("${bgSrcUrl(library)}")`,
                transform: `scaleX(${libraryParams.flip ? -1 : 1})`,
              }}
              aria-hidden
            />
            <span className="bg-ctl-name" dir="auto" title={imageLabel(library.source_name).full}>
              {imageLabel(library.source_name).label}
            </span>
            <button className="bg-ctl-act" disabled={busy} aria-busy={busy} onClick={pick}>
              {busy && <span className="bg-ctl-spin" aria-hidden />}
              {busy ? t("gs.bg.preparing") : t("gs.bg.replace")}
            </button>
            <button
              className="bg-ctl-act danger"
              disabled={busy}
              onClick={() => { setError(null); clear("library").catch((e) => setError(String(e))); }}
            >
              {t("gs.bg.remove")}
            </button>
          </div>

          {/* RAWY-278. While busy: what Sard is doing to the file. Otherwise, ONLY when a derivative
              genuinely exists: that a display copy is what renders. Gated on `derivative_path`
              because for an under-ceiling image no copy was made and the note would be false — the
              original itself is what renders (the "never recompress" guarantee, spec §7.2). */}
          {busy && <div className="gs-note">{t("gs.bg.preparingHint")}</div>}
          {!busy && library.derivative_path && (
            <div className="gs-note">{t("gs.bg.displayCopy")}</div>
          )}

          <div className="gs-slider-head">
            <span>{t("gs.bg.presence")}</span>
            <span className="gs-slider-val">{localeDigits(String(libraryParams.presence), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={BG_PRESENCE_MAX} step={1}
            value={libraryParams.presence}
            onChange={(e) => setParams("library", { presence: Number(e.target.value) })}
          />
          {/* RAWY-279: the library cap stays at 100 — measured, AA 4.5:1 for `--text` over any image
              holds only down to an overlay of 0.77 (Slate binding), so there is no headroom here.
              Only the READING surface's range was extended. */}
          <div className="gs-note">{t("gs.bg.presenceHint")}</div>

          <div className="gs-slider-head">
            <span>{t("gs.bg.blur")}</span>
            <span className="gs-slider-val">{localeDigits(String(libraryParams.blur), lang)}</span>
          </div>
          <input
            className="gs-slider" type="range" min={0} max={BG_BLUR_MAX} step={1}
            value={libraryParams.blur}
            onChange={(e) => setParams("library", { blur: Number(e.target.value) })}
          />

          {/* The focal point. `cover` always crops; this is what decides which part survives — the
              answer to "it cut off the face". A click on the preview sets the centre directly. */}
          <Label>{t("gs.bg.focal")}</Label>
          <button
            className="bg-ctl-focal"
            style={{
              backgroundImage: `url("${bgSrcUrl(library)}")`,
              backgroundPosition: `${libraryParams.focalX}% ${libraryParams.focalY}%`,
            }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setParams("library", {
                focalX: Math.round(((e.clientX - r.left) / r.width) * 100),
                focalY: Math.round(((e.clientY - r.top) / r.height) * 100),
              });
            }}
          >
            <span
              className="bg-ctl-focal-dot"
              style={{ left: `${libraryParams.focalX}%`, top: `${libraryParams.focalY}%` }}
            />
          </button>
          <div className="gs-note">{t("gs.bg.focalHint")}</div>

          <BgToggle
            label={t("gs.bg.flip")}
            on={libraryParams.flip}
            onToggle={() => setParams("library", { flip: !libraryParams.flip })}
          />

          {libraryParams.presence === 0 && <div className="gs-note">{t("gs.bg.hidden")}</div>}
          <button className="bg-ctl-act" onClick={() => resetParams("library", theme.colors.paperBg)}>
            {t("gs.bg.reset")}
          </button>
        </>
      )}

      {/* The app-wide master. Deliberately shown even with no image: it governs BOTH surfaces, and a
          reader who needs backgrounds gone (a migraine, a presentation, battery) should not have to
          dismantle their configuration to get there. Turning it off keeps every setting on disk. */}
      <BgToggle label={t("gs.bg.show")} hint={t("gs.bg.showHint")} on={enabled} onToggle={() => setEnabled(!enabled)} />
      {error && <div className="gs-note bg-ctl-err">{error}</div>}
    </div>
  );
}

// The house toggle idiom, reused verbatim from the reading drawer (`rs-toggle-row` / `rs-switch` /
// `rs-knob`) rather than a parallel `gs-*` set. Those classes already carry the RAWY-90 direction pin
// that makes the knob slide from the same edge in Arabic and English — a fresh toggle would have to
// re-earn that, and would drift from the one users already know.
function BgToggle({ label, hint, on, onToggle }: { label: string; hint?: string; on: boolean; onToggle: () => void }) {
  return (
    <button className="rs-toggle-row" onClick={onToggle} aria-pressed={on}>
      <span className="rs-toggle-text">
        <span className="rs-toggle-label">{label}</span>
        {hint && <span className="rs-toggle-hint">{hint}</span>}
      </span>
      <span className={`rs-switch${on ? " on" : ""}`} aria-hidden>
        <span className="rs-knob" />
      </span>
    </button>
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
// RAWY-94: the Book-card preview px that MIRRORS the size slider. Maps the book-default zoom range
// (0.8..2.5, the same value applied inside books via injectedCss) into a card-safe 13..26px so the
// preview visibly tracks the slider without overflowing the card. Presentation only — never written.
const bookPreviewPx = (zoom: number) => Math.round(13 + ((Math.max(0.8, Math.min(2.5, zoom)) - 0.8) / 1.7) * 13);

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
  const { uiFont, uiWeight, uiScale, custom, setUiFont, setUiWeight, setUiScale, removeFont } = useFonts();
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
          {/* RAWY-98: the manual UI size (--ui-user). Composes with the auto viewport baseline;
              scales chrome only — never book text. */}
          <div className="gs-sblock">
            <div className="gs-slider-head"><span className="gs-fc-cap">{t("fonts.size")}</span><span className="gs-slider-val">{localeDigits(`${Math.round(uiScale * 100)}%`, lang)}</span></div>
            <input className="gs-slider" type="range" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step={0.05} value={uiScale} onChange={(e) => setUiScale(Number(e.target.value))} />
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
              <div className="gs-fprev-text" style={{ fontWeight: style.fontWeight, fontSize: bookPreviewPx(style.zoom) }}>
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

// ---- Book styles: the style MODE (unified vs per-book) and — in per-book ONLY — the global
//      reading_style baseline a NEW book starts from ----
//
// RAWY-284: the reading-APPEARANCE controls (line spacing + the read-aloud tracking group) used to be
// rendered here unconditionally, and in UNIFIED scope that was a pure duplicate of controls the reader
// already has in the open book: line spacing is the Typography tab's `type.lineSpacing`, and the
// tracking group is the SAME `TtsTrackingControls` component the Read-aloud tab renders (RAWY-200 made
// it shared precisely so the two surfaces could not drift). Under unified, `Reader.update` writes the
// GLOBAL row (Reader.tsx — `if (unified) globalStyleRef.current = next` → `saveGlobalStyle`), i.e. the
// very row this section edits. So the duplicate was not merely redundant, it was the WORSE of the two
// copies: identical destination, no live preview.
//
// It survives in PER-BOOK scope because there it is NOT a duplicate. The reader then writes
// `book_style:<id>` instead, and this global row is the baseline a not-yet-opened book starts from —
// which is also why it is the one place in the app where "you cannot preview it" is inherent rather
// than a defect: the book it describes is not open. The heading says exactly that.
//
// The controls are a SEPARATE COMPONENT rather than a `scope === "perbook" &&` around the JSX so that
// under unified they are not mounted at all: no `settingsGet` IPC, no style state, and none of the four
// `useBackground` subscriptions the two EffectBlocks take. Gating inside the component would have kept
// all of them alive to render nothing.
function ReadingDefaultsSection() {
  const { t } = useI18n();
  const { scope, setScope } = useStyleScope();
  return (
    <>
      <SecHead>{t("gs.reading")}</SecHead>

      {/* RAWY-43: choose whether all books share one style (unified) or each keeps its own.
          RAWY-271: Unified is listed FIRST because it is the default (styleScope.ts) — the old order
          read as if Per-book were the primary option. Order only; the stored value is untouched.
          RAWY-284: this block is deliberately unchanged — it is app-level, needs no preview, and is
          the setting that decides what the rest of this section means. */}
      <div className="gs-sec">
        <Label>{t("gs.scope")}</Label>
        <Seg<"unified" | "perbook">
          value={scope}
          onPick={(s) => setScope(s)}
          options={[
            { key: "unified", label: t("gs.scope.unified") },
            { key: "perbook", label: t("gs.scope.perbook") },
          ]}
        />
        <div className="gs-note">{scope === "unified" ? t("gs.scope.unifiedHint") : t("gs.scope.perbookHint")}</div>
      </div>

      {/* RAWY-284: no disabled/greyed leftovers under unified — the controls are GONE, replaced by
          where they actually are. Says the panel name a reader can act on, not just "in the reader". */}
      {scope === "perbook" ? <NewBookDefaults /> : <div className="gs-banner">▤ {t("gs.reading.inReader")}</div>}
    </>
  );
}

// RAWY-284: mounted ONLY in per-book scope (see the note above). Everything inside is byte-for-byte the
// pre-RAWY-284 markup and the same `patch` funnel writing the same `reading_style` key — the ticket
// changes WHERE these are shown, never what they store.
function NewBookDefaults() {
  const { t, lang } = useI18n();
  const { bookThemeId } = useTheme();
  // The tracking preview + contrast guard use the shared BOOK theme (D29) — the one a new book opens in
  // — so the swatches show the real per-theme terracotta and warn against the real paper. Theme choice
  // does NOT affect what is persisted (the track values are theme-independent); it is preview only.
  const gTheme = resolveTheme(bookThemeId);
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

  // RAWY-284: null, not a bare heading — the parent already rendered the section head and the style
  // MODE switch, so the panel is never a blank frame while this one `settingsGet` is in flight (UI
  // Rules: no blank frames, no visible rebuilding). Before this split the whole panel was one heading.
  if (!style) return null;
  return (
    <>
      {/* RAWY-284: the banner moved BELOW the mode switch so it scopes the group it describes. Under
          unified it said "the baseline for new books" about a row that is every book's LIVE style —
          true only in per-book, which is now the only scope that renders it. */}
      <div className="gs-banner">↻ {t("gs.readingBanner")}</div>

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

      {/* RAWY-200: read-aloud tracking defaults — the same six controls as the in-book panel, writing
          the GLOBAL reading_style row (the per-book panel writes book_style:<id>). */}
      <div className="gs-sec">
        <TtsTrackingControls
          style={style}
          update={patch}
          dark={gTheme.dark}
          paperBg={gTheme.colors.paperBg}
          themeInk={gTheme.colors.text}
          deskBg={gTheme.colors.surfaceBg}
        />
      </div>
    </>
  );
}

function BookmarkSection() {
  const { t, lang } = useI18n();
  const { shape, color, pos, size, setShape, setColor, setPos, setSize } = useBookmarkStyle();
  const marker = useReadMarkerStyle((st) => st.marker); // RAWY-256
  const setMarker = useReadMarkerStyle((st) => st.setMarker);
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

      {/* RAWY-256: the chapter READ-MARKER chooser. Placed HERE — beside the bookmark SHAPE — because it is
          the same KIND of setting: a global appearance choice about how a place in a book is marked, which
          FEEDBACK §6.5 keeps in main settings rather than per book (re-picking it for every book in a
          library of hundreds would be absurd). It reuses this section's existing `gs-bm-grid` / `gs-bm-cell`
          pattern verbatim — no new settings chrome (D19). NOTE for RAWY-244: this control lives in Global
          Settings → Bookmark, NOT in the RAWY-216 reader drawer (the bookmark controls were never in it);
          keep the two together if that ticket moves either. Each cell previews the REAL variant CSS, so what
          the owner sees in the picker is exactly what the Contents panel renders. */}
      <div className="gs-sec">
        <Label>{t("gs.readMarker")}</Label>
        <div className="gs-note gs-note-tight">{t("gs.readMarker.subtitle")}</div>
        <div className="gs-bm-grid">
          {READ_MARKERS.map((m) => (
            <button
              key={m.key}
              className={`gs-bm-cell${marker === m.key ? " on" : ""}`}
              onClick={() => setMarker(m.key)}
              title={t(m.label)}
              aria-label={t(m.label)}
            >
              <span className={`gs-rm-prev rm-${m.key}`} aria-hidden="true">
                <span className="toc-row read" />
                <span className="toc-row read" />
                <span className="toc-row active" />
              </span>
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

// DISC/RPC: the one switch. One row while off, one row while on — the smallest possible surface
// for a feature whose whole point is "show me, unless I say stop". Reuses the house toggle idiom
// (`rs-toggle-row` / `BgToggle`) so the knob, the RTL pin and the a11y wiring are the ones the
// rest of the app already uses.
function PresenceSection() {
  const { t } = useI18n();
  const enabled = usePresence((s) => s.enabled);
  const setEnabled = usePresence((s) => s.setEnabled);
  const showBook = usePresence((s) => s.showBook);
  const setShowBook = usePresence((s) => s.setShowBook);
  const showPosition = usePresence((s) => s.showPosition);
  const setShowPosition = usePresence((s) => s.setShowPosition);
  const showBrowsing = usePresence((s) => s.showBrowsing);
  const setShowBrowsing = usePresence((s) => s.setShowBrowsing);
  return (
    <>
      <SecHead>{t("gs.presence")}</SecHead>
      <div className="gs-sec">
        <BgToggle
          label={t("gs.presence.enabled")}
          hint={t("gs.presence.enabledHint")}
          on={enabled}
          onToggle={() => setEnabled(!enabled)}
        />
        <BgToggle
          label={t("gs.presence.showBook")}
          hint={t("gs.presence.showBookHint")}
          on={showBook}
          onToggle={() => setShowBook(!showBook)}
        />
        <BgToggle
          label={t("gs.presence.showPosition")}
          hint={t("gs.presence.showPositionHint")}
          on={showPosition}
          onToggle={() => setShowPosition(!showPosition)}
        />
        <BgToggle
          label={t("gs.presence.showBrowsing")}
          hint={t("gs.presence.showBrowsingHint")}
          on={showBrowsing}
          onToggle={() => setShowBrowsing(!showBrowsing)}
        />
      </div>
      <div className="gs-note">{t("gs.presence.note")}</div>
    </>
  );
}

// RAWY-290: About's update row is now a SECOND TRIGGER for the one shared updater, not a second
// implementation of it. It calls the same `manual()` the Library rosette calls, and the outcome —
// "up to date", the update dialog, or an error — is rendered by the shared store and dialog. This
// row therefore holds no result state of its own; keeping one would let the two entry points
// disagree about what the latest version is, which is exactly what the old pair did.

function AboutSection() {
  const { t } = useI18n();
  const updState = useUpdater((s) => s.state);
  const check = useUpdater((s) => s.manual);
  const busy = updState.k === "checking" || updState.k === "downloading" || updState.k === "installing";
  // RAWY-177 (AUD-15): read the REAL version from the bundled config (D41 bumps it each checkpoint)
  // rather than a hardcoded literal, so About can never drift from the shipped binary.
  const [ver, setVer] = useState("");
  useEffect(() => { getVersion().then(setVer).catch(() => {}); }, []);
  // THE ONLY PLACE A BETA SAYS IT IS A BETA.
  //
  // Deliberately not the window title, not the product name, not the version (owner, 2026-08-07): a
  // tester should experience exactly the application they will eventually receive, so the everyday
  // surface is identical to production. Identification lives here, where someone goes when they want
  // to know — and nowhere else.
  //
  // Betas are PRIVATE builds handed to a few testers directly, never published, and they carry the
  // product's real version. So the version line cannot distinguish one from the public release; the
  // BUILD ID can, because it is stamped in at compile time and a Beta's begins `BETA-`. Shown only
  // when it does, which leaves a release build's About panel exactly as it was.
  const [betaId, setBetaId] = useState<string | null>(null);
  useEffect(() => {
    appInfo()
      .then((i) => setBetaId(i.build_id?.startsWith("BETA-") ? i.build_id : null))
      .catch(() => {});
  }, []);
  return (
    <>
      <SecHead>{t("gs.about")}</SecHead>
      <div className="gs-about">
        <Hoopoe size={34} />
        <div>
          {/* The bilingual wordmark. Two spans, because one element cannot carry two faces and
              the mark's halves are set in different ones — see src/lib/typography.ts. */}
          <div className="gs-about-name">
            Sard <span aria-hidden>·</span> <span className="brand-ar">سَرْد</span>
          </div>
          <div className="gs-about-tag">{t("gs.about.tagline")}</div>
          <div className="gs-about-ver">{t("gs.about.version")} {ver}</div>
          {betaId && (
            <>
              <div className="gs-about-beta">{t("gs.about.beta")}</div>
              <div className="gs-about-build">
                <span className="gs-about-build-lbl">{t("gs.about.buildId")}</span>
                <code>{betaId}</code>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="gs-update">
        <button className="gs-update-btn" onClick={check} disabled={busy}>
          <svg className={busy ? "gs-update-spin" : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 11a8 8 0 1 0-.6 3M20 4v6h-6" /></svg>
          <span>{busy ? t("gs.update.checking") : t("gs.update.check")}</span>
        </button>
        {/* Only the "nothing to do" outcome belongs inline. An available update, a download and any
            failure all open the shared dialog, so this row never renders a second copy of them. */}
        {updState.k === "uptodate" && <div className="gs-update-msg">{t("upd.uptodate")}</div>}
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
