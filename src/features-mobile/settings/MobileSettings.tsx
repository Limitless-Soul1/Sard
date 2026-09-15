// SETTINGS — design G1, "app-wide, grouped, no tabs".
//
// THE DESK ALREADY HAS THIS SURFACE and this is its phone form, not a second one: `GlobalSettings`
// (RAWY-39, band H) is "the app-wide settings surface opened from the Library. DISTINCT from the
// in-book reading panel — this sets the WHOLE app, while a book's own font/theme are set while
// reading." The mobile reader's hub (D3–D6) is that in-book panel; this is the app-wide half, and the
// two do not overlap. Every group name, label and hint below is the desk's own `gs.*` string.
//
// G1's rule is the shape: the desk stacks a left nav against a content pane, and the phone cannot, so
// the desk's SECTIONS become GROUPS in one scrolling column. No tabs, and nothing is nested behind a
// disclosure the reader has to discover.
//
// WHAT IS NOT HERE, and why it is absent rather than greyed out. The G1 mock also draws Page turn,
// Storage size, Back up notes and Export everything. MEASURED against the product: Sard has no
// page-turn animation setting at all (foliate's paginator honours an `animated` attribute and the
// controller never sets it), no storage-size backend, no backup command and no export command. A
// control that looks live and does nothing is the RAWY-193/205 defect the annotations panel names
// explicitly, so those rows are omitted outright. The mock is ahead of the product there; this file
// does not pretend otherwise.
//
// IT OWNS NO STATE. The mode is `useTheme.setMode`, the typefaces are the `reading_style` row the desk
// reads and writes through the same key, the bookmark shape is `useBookmarkStyle`, and the language is
// `useI18n.setLang`. Each persists exactly where it already persisted.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { getVersion } from "@tauri-apps/api/app";
import { settingsGet, settingsSet } from "../../lib/ipc";
import { BOOKMARK_SHAPES, useBookmarkStyle } from "../../lib/bookmarkStyle";
import { ARABIC_FONTS, LATIN_DEFAULTS, LATIN_FONTS, type ReadingStyle } from "../../reader-engine/injectedCss";
import { currentMode, useTheme, type ThemeMode } from "../../theme";

/** The same row the desk reads and writes. Naming it again here would be a second source of truth. */
const STYLE_KEY = "reading_style";

const LANGS = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

/** A labelled group of choices. One shape for every setting on the screen, so nothing needs explaining. */
function Group({
  label,
  value,
  options,
  onPick,
  hint,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onPick: (id: string) => void;
  hint?: string;
}) {
  return (
    <div className="mg-group">
      <div className="mh-group">{label}</div>
      <div className="mg-opts" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`ml-chip${o.id === value ? " on" : ""}`}
            aria-pressed={o.id === value}
            onClick={() => onPick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint ? <div className="mg-hint">{hint}</div> : null}
    </div>
  );
}

export function MobileSettings() {
  const { t, lang, setLang } = useI18n();
  const { themeId, autoMode, setMode } = useTheme();
  const mode: ThemeMode = currentMode({ themeId, autoMode });
  const { shape, setShape } = useBookmarkStyle();
  const [style, setStyle] = useState<ReadingStyle | null>(null);
  const [version, setVersion] = useState("");

  // The desk's own load: the stored row over the defaults, so a key the reader has never touched still
  // reads as what they are actually getting.
  useEffect(() => {
    let alive = true;
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
      if (alive) setStyle({ ...LATIN_DEFAULTS, ...parsed });
    })();
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const patchStyle = (p: Partial<ReadingStyle>) =>
    setStyle((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...p };
      settingsSet(STYLE_KEY, JSON.stringify(next)).catch(console.error);
      return next;
    });

  return (
    <div className="mg-root">
      <div className="ml-allhead">
        <div className="ml-allhead-title">{t("gs.title")}</div>
      </div>

      <div className="mg-scroll">
        {/* The desk states the scope in one line and it is the first thing to read here too: a setting
            on this screen is not the setting the hub changes. */}
        <div className="mg-note">{t("gs.appwideNote")}</div>

        <Group
          label={t("gs.nav.appearance")}
          value={mode}
          options={[
            { id: "day", label: t("gs.mode.day") },
            { id: "night", label: t("gs.mode.night") },
            { id: "auto", label: t("gs.mode.auto") },
          ]}
          onPick={(m) => setMode(m as ThemeMode)}
        />

        {style ? (
          <Group
            label={t("fonts.ar")}
            value={style.arabicFont}
            options={Object.entries(ARABIC_FONTS).map(([id, f]) => ({ id, label: f.label }))}
            onPick={(id) => patchStyle({ arabicFont: id as ReadingStyle["arabicFont"] })}
          />
        ) : null}

        {style ? (
          <Group
            label={t("fonts.la")}
            value={style.latinFont}
            options={Object.entries(LATIN_FONTS).map(([id, f]) => ({ id, label: f.label }))}
            onPick={(id) => patchStyle({ latinFont: id as ReadingStyle["latinFont"] })}
          />
        ) : null}

        <Group
          label={t("gs.nav.bookmark")}
          value={shape}
          options={BOOKMARK_SHAPES.map((s) => ({ id: s.key, label: s.label }))}
          onPick={(id) => setShape(id as typeof shape)}
        />

        {/* The hint is the desk's, and it is also G1's "interface direction · follows language" row:
            direction is DERIVED from the language and has never been a separate switch, so stating it
            is honest where a second control would be a lie. */}
        <Group
          label={t("gs.language")}
          value={lang}
          options={LANGS.map((l) => ({ id: l.code, label: l.label }))}
          onPick={(c) => setLang(c as (typeof LANGS)[number]["code"])}
          hint={t("gs.languageHint")}
        />

        <div className="mg-about">
          {version ? `${t("gs.about.version")} ${version}` : ""}
        </div>
      </div>
    </div>
  );
}
