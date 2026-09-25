// A BOOK'S OWN هيئة — the whole هيئة, and nothing of it copied.
//
// Sard's look is one shared choice: the worn هيئة answers for every book. A book may now name a هيئة of
// its own, and the promises this suite holds are that naming one gives it the COMPLETE هيئة (palette,
// faces, measure, marks and reference rule — not a colour taken out of it), that the value stored is an
// IDENTIFIER rather than a copy, that changing an appearance-owned setting afterwards edits the هيئة
// itself so every book wearing it follows, and that none of this can rewrite a هيئة the reader is not
// looking at.
//
// The resolver under test is the real one, composed of the real `readingPatch` — the SAME function
// activation uses — over the real per-script defaults. Nothing here re-implements what a هيئة means.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BOOK_APPEARANCE_FOLLOW,
  BOOK_APPEARANCE_NONE,
  SESSION_OWNED_FIELDS,
  bookAppearanceInForce,
  bookAppearanceKey,
  noteBookAppearance,
  parseBookAppearance,
  resolveAppearanceStyle,
  readingBackgroundOf,
  splitReadingEdit,
  withBackgroundEdit,
  withPaletteEdit,
  withPaperEdit,
  withReadingEdit,
} from "../../src/features/reader/bookAppearance";
import {
  PROFILE_READING_FIELDS, TYPOGRAPHY_KEYS, readingPatch, readingThemeId,
  type Profile,
} from "../../src/features/profiles/model/profile";
import {
  appearanceDraftDirty, clearAppearanceDraft, draftDirty, draftFor, editAppearance,
  resolveAppearance, useAppearanceDraft,
} from "../../src/features/reader/appearanceDraft";
import { changesBetween } from "../../src/features/profiles/session";
import { useProfiles } from "../../src/features/profiles/store";
import type { Theme } from "../../src/theme/tokens";
import { ARABIC_DEFAULTS, LATIN_DEFAULTS, REF_RULE_KEYS, TTS_TRACKING_KEYS } from "../../src/reader-engine/injectedCss";
import type { CustomThemeId } from "../../src/theme/tokens";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** Comments legitimately NAME the removed model in order to record it, so the guards below read CODE. */
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^(.*?)\/\/.*$/gm, (line, code: string) => (line.trim().startsWith("//") ? "" : code));
const reader = read("src/features/reader/Reader.tsx");
const readerCode = strip(reader);
const settings = read("src/features/reader/ReadingSettings.tsx");
const session = read("src/features/profiles/session.ts");
const unsaved = read("src/features/profiles/UnsavedChange.tsx");
const background = read("src/lib/background.ts");
const cssRaw = read("src/styles/global.css");
const migrations = read("src-tauri/src/db/migrations.rs");
const dropSql = read("src-tauri/src/db/migrations_sql/20260924190000_drop_profile_prev_data.sql");
const rustSave = read("src-tauri/src/profiles/mod.rs");
const profStore = read("src/features/profiles/store.ts");
const appSrc = read("src/App.tsx");
const perBook = read("src/features/reader/perBookSettings.ts");
const draftSrc = read("src/features/reader/appearanceDraft.ts");
const legacySql = read("src-tauri/src/db/migrations_sql/20260924210000_reading_style_drop_legacy_colours.sql");
const en = (await import("../../src/i18n/locales/en")).en;
const ar = (await import("../../src/i18n/locales/ar")).ar;


/** A هيئة, shaped exactly as the editor stores one. */
function appearance(id: string, over: Record<string, unknown> = {}): Profile {
  const o = over as {
    arabic?: string; latin?: string; paperBg?: string; dark?: boolean;
    reading?: Record<string, unknown>; overlay?: string | null; numbers?: string | null;
  };
  return {
    id: id as CustomThemeId,
    name: id.replace("u:", ""),
    description: null, author: null, iconKind: "seal", iconRef: null,
    derivedFrom: null, createdAt: 1, updatedAt: 1,
    data: {
      v: 1,
      theme: {
        library: { base: null, dark: false, colors: { ...BASE_COLORS }, bookmark: null, separator: null, numbers: null } as never,
        reading: {
          base: null, dark: o.dark ?? false,
          colors: { ...BASE_COLORS, paperBg: o.paperBg ?? "#FFFFFF" },
          bookmark: null, separator: null, numbers: o.numbers ?? null,
        } as never,
      },
      type: {
        ui: null,
        arabic: o.arabic ?? "amiri",
        latin: o.latin ?? "literata",
        reading: {
          zoom: null, pageWidth: null, marginPx: null, lineHeight: null, letterSpacing: null,
          paragraphSpacing: null, fontWeight: null, firstLineIndent: null, align: null, diacritics: null,
          ...(o.reading ?? {}),
        } as never,
      },
      marks: { bookmarkShape: "ribbon", bookmarkSize: 100, bookmarkPos: 0.1, readMarker: "accentTrail" } as never,
      bg: {
        library: { ref: null, params: {}, sameAsLibrary: false } as never,
        reading: { ref: null, params: {}, sameAsLibrary: false, overlay: o.overlay ?? null } as never,
      },
      voice: null, refs: null, texture: "opaque" as never,
      seal: {} as never, icon: {} as never,
    } as never,
  } as Profile;
}

const BASE_COLORS = {
  paperBg: "#FFFFFF", surfaceBg: "#EEEEEE", chromeBg: "#DDDDDD", chromeBorder: "#CCCCCC",
  text: "#111111", muted: "#777777", accent: "#AA5533", selection: "rgba(0,0,0,.2)",
  highlight: { amber: "#1", marigold: "#2", coral: "#3", rose: "#4", purple: "#5", sky: "#6", teal: "#7", green: "#8" },
} as unknown as Record<string, unknown>;

/** A builtin paper, as `resolveTheme` would hand one to `withPaperEdit`. */
const SEPIA_THEME = {
  id: "sepia", name: "Sepia", dark: false, highlightAlpha: null,
  colors: { ...BASE_COLORS, paperBg: "#E8D9BC" },
} as unknown as Theme;

/** «Runes» and «Sekiro», differing in BOTH palette and measure — the owner's own two test cases. */
const RUNES = appearance("u:runes", {
  paperBg: "#171A17", dark: true, arabic: "TheYearofTheCamel",
  reading: { zoom: 2.5, pageWidth: 0.95, lineHeight: 2.35, letterSpacing: 2.5, align: "justify" },
});
const SEKIRO = appearance("u:sekiro", {
  paperBg: "#171B19", arabic: "thmanyahserifdisplay",
  reading: { zoom: 2.5, pageWidth: 0.85, lineHeight: 2.45, letterSpacing: 3, marginPx: 32, paragraphSpacing: 22 },
});

/** The reader's own row: Sard's Arabic baseline plus a couple of session-owned choices. */
const SESSION = { ...ARABIC_DEFAULTS, flowMode: "paged", textColor: "#123456", pageColor: "#ABCDEF" } as never;

beforeEach(() => noteBookAppearance(null));

describe("the row", () => {
  it("is keyed by the book's own id and holds an identifier", () => {
    expect(bookAppearanceKey("abc")).toBe("book_appearance:abc");
    expect(parseBookAppearance("u:runes")).toBe("u:runes");
    expect(parseBookAppearance("ivory")).toBe("ivory");
  });

  it("reads absence, emptiness and the selector's stand-in as «افتراضي»", () => {
    for (const v of [null, undefined, "", "   ", BOOK_APPEARANCE_NONE, BOOK_APPEARANCE_FOLLOW]) {
      expect(parseBookAppearance(v)).toBeNull();
    }
  });

  it("stores a PROFILE id, not the palette id a هيئة projects", () => {
    // The `~r` id is one field of the object and cannot reach the measure — storing it is exactly what
    // limited the first cut of this feature to colour.
    expect(readingThemeId(RUNES.id)).toBe("u:runes~r");
    expect(reader).toContain("settingsSet(bookAppearanceKey(book), id ?? BOOK_APPEARANCE_NONE)");
    expect(reader).not.toContain("settingsSet(bookAppearanceKey(book), readingThemeId");
  });
});

describe("a هيئة resolves COMPLETE, not as a palette", () => {
  const style = resolveAppearanceStyle(RUNES, "rtl", SESSION);

  it("carries the faces", () => {
    expect(style.arabicFont).toBe("TheYearofTheCamel");
    expect(style.latinFont).toBe("literata");
  });

  it("carries the measure it names", () => {
    expect(style.zoom).toBe(2.5);
    expect(style.pageWidth).toBe(0.95);
    expect(style.lineHeight).toBe(2.35);
    expect(style.letterSpacing).toBe(2.5);
    expect(style.align).toBe("justify");
  });

  it("leaves the measure it does NOT name at Sard's own per-script default — not the last هيئة's", () => {
    // Runes names no margin. The answer must be the Arabic baseline, which is what clearing the key
    // achieves on activation, and NOT Sekiro's 32.
    expect(style.marginPx).toBe(ARABIC_DEFAULTS.marginPx);
    expect(style.paragraphSpacing).toBe(ARABIC_DEFAULTS.paragraphSpacing);
    expect(resolveAppearanceStyle(SEKIRO, "rtl", SESSION).marginPx).toBe(32);
  });

  it("is direction-aware, exactly as the global row is", () => {
    const ltr = resolveAppearanceStyle(appearance("u:plain"), undefined, SESSION);
    const rtl = resolveAppearanceStyle(appearance("u:plain"), "rtl", SESSION);
    expect(ltr.lineHeight).toBe(LATIN_DEFAULTS.lineHeight);
    expect(rtl.lineHeight).toBe(ARABIC_DEFAULTS.lineHeight);
  });

  it("means exactly what activation means — the same `readingPatch`, field for field", () => {
    const { set } = readingPatch(RUNES);
    for (const [k, v] of Object.entries(set)) {
      if ((SESSION_OWNED_FIELDS as readonly string[]).includes(k)) continue;
      expect((style as unknown as Record<string, unknown>)[k], k).toEqual(v);
    }
  });

  it("covers every field the project declares appearance-owned", () => {
    const { set } = readingPatch(RUNES);
    for (const k of PROFILE_READING_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(set, k) || (TYPOGRAPHY_KEYS as readonly string[]).includes(k), k).toBe(true);
    }
  });
});

describe("the fields a هيئة does not own stay the reader's", () => {
  it("keeps the session's flow, page fit and immersive pair", () => {
    const style = resolveAppearanceStyle(RUNES, "rtl", SESSION);
    for (const k of SESSION_OWNED_FIELDS) {
      expect((style as unknown as Record<string, unknown>)[k], k)
        .toEqual((SESSION as unknown as Record<string, unknown>)[k]);
    }
  });

  it("and that set is the package firewall's own boundary, less the one field a هيئة speaks about elsewhere", () => {
    // The firewall refuses `backgroundColor` as a RAW reading field — a هيئة may not send one — but a
    // هيئة does hold that value, in `bg.reading.overlay`, and `readingPatch` asserts it on every
    // activation. So it is appearance-owned through a different door, and is resolved from the هيئة
    // here rather than from the session. Every other field the firewall names stays the reader's.
    const notOwned = (Object.keys(ARABIC_DEFAULTS) as string[])
      .filter((k) => !(PROFILE_READING_FIELDS as readonly string[]).includes(k));
    // THREE fields are appearance-owned through a door other than `PROFILE_READING_FIELDS`:
    //   backgroundColor -> bg.reading.overlay          (asserted by `readingPatch`)
    //   pageColor       -> theme.reading.colors.paperBg (the palette the هيئة carries)
    //   textColor       -> theme.reading.colors.text
    // Everything else the firewall names stays the reader's, and that is reading MODE.
    const elsewhere = ["backgroundColor", "pageColor", "textColor"];
    expect([...SESSION_OWNED_FIELDS].sort()).toEqual(notOwned.filter((k) => !elsewhere.includes(k)).sort());
    for (const k of elsewhere) expect(notOwned).toContain(k);
    expect(readingPatch(RUNES).set).toHaveProperty("backgroundColor");
  });

  it("splits a change by owner, never into a per-book copy", () => {
    const { appearance: a, session: s } = splitReadingEdit({ lineHeight: 2, flowMode: "paged", pageFitWindow: true });
    expect(a).toEqual({ lineHeight: 2 });
    expect(s).toEqual({ flowMode: "paged", pageFitWindow: true });
  });
});

describe("editing while a book wears a هيئة edits THAT هيئة", () => {
  it("folds the measure back into the هيئة, in the place the resolver reads it from", () => {
    const next = withReadingEdit(RUNES, { lineHeight: 2.5 });
    expect(next).not.toBe(RUNES);
    expect(next.data.type.reading.lineHeight).toBe(2.5);
    // ...and the resolver now yields it, which is what makes every book wearing Runes follow.
    expect(resolveAppearanceStyle(next, "rtl", SESSION).lineHeight).toBe(2.5);
  });

  it("does not touch the هيئة it was not given", () => {
    const next = withReadingEdit(RUNES, { lineHeight: 2.5 });
    expect(RUNES.data.type.reading.lineHeight).toBe(2.35); // the original object is untouched
    expect(resolveAppearanceStyle(SEKIRO, "rtl", SESSION).lineHeight).toBe(2.45);
  });

  it("maps every appearance-owned field to its own home", () => {
    const n = withReadingEdit(RUNES, {
      arabicFont: "amiri", latinFont: "literata", numberColor: "#987654",
      backgroundColor: "#111111", zoom: 1.4,
      ttsSpotlightColor: "#00FF00", refRuleWeight: 2,
    } as never);
    expect(n.data.type.arabic).toBe("amiri");
    expect(n.data.type.latin).toBe("literata");
    expect(n.data.theme.reading.numbers).toBe("#987654");
    expect(n.data.bg.reading.overlay).toBe("#111111");
    expect(n.data.type.reading.zoom).toBe(1.4);
    expect(n.data.voice?.ttsSpotlightColor).toBe("#00FF00");
    expect(n.data.refs?.refRuleWeight).toBe(2);
  });

  it("gives a هيئة with no opinion about the marks one built from Sard's own, not from nowhere", () => {
    expect(RUNES.data.voice).toBeNull();
    const n = withReadingEdit(RUNES, { ttsKaraokeOn: false } as never);
    expect(n.data.voice?.ttsKaraokeOn).toBe(false);
    for (const k of TTS_TRACKING_KEYS) expect(n.data.voice, k).toHaveProperty(k);
    const r = withReadingEdit(RUNES, { refRuleOffset: 0.5 } as never);
    for (const k of REF_RULE_KEYS) expect(r.data.refs, k).toHaveProperty(k);
  });

  it("returns the SAME object when nothing in the change belongs to a هيئة", () => {
    expect(withReadingEdit(RUNES, { flowMode: "paged" } as never)).toBe(RUNES);
    expect(withReadingEdit(RUNES, {})).toBe(RUNES);
  });

  it("creates no per-book field anywhere — the deleted model, by its real name", () => {
    for (const dead of ["book_font", "book_zoom", "book_lineHeight", "book_pageWidth",
      "book_margin", "book_style:", "book_align"]) {
      expect(readerCode, dead).not.toContain(dead);
    }
  });
});

describe("the drift detector cannot be misled by an open book", () => {
  it("announces only a هيئة, never a plain paper", () => {
    expect(reader).toContain("noteBookAppearance(own ? own.id : null)");
  });

  it("tracks what is in force", () => {
    expect(bookAppearanceInForce()).toBeNull();
    noteBookAppearance("u:runes");
    expect(bookAppearanceInForce()).toBe("u:runes");
    noteBookAppearance(null);
    expect(bookAppearanceInForce()).toBeNull();
  });

  it("makes BOTH readers of the live style consult it — the prompt and the save", () => {
    // The save is the dangerous one: folding a book's هيئة into the one being saved would rewrite a
    // هيئة the reader is not looking at.
    for (const [name, src] of [["driftOf", session], ["save", unsaved]] as const) {
      expect(src, name).toContain("bookAppearanceInForce()");
      expect(src, name).toMatch(/bookAppearanceInForce\(\)\s*\n?\s*\?\s*peekGlobalStyle\(\)/);
    }
  });

  it("and neither of them reads the reader's live style unconditionally any more", () => {
    for (const [name, src] of [["driftOf", session], ["save", unsaved]] as const) {
      expect(src, name).not.toMatch(/=\s*useReader\.getState\(\)\.style \?\? peekGlobalStyle\(\);/);
    }
  });
});

describe("what the Reader does with it", () => {
  it("reads the row before the first paint, beside the reading style", () => {
    expect(reader).toContain("const bookAppearanceRow = settingsGet(bookAppearanceKey(target.id)).catch(() => null);");
    expect(reader).toContain("const appearanceRaw = await bookAppearanceRow;");
    expect(reader.indexOf("const appearanceRaw = await bookAppearanceRow;"))
      .toBeLessThan(reader.indexOf("theme: resolveTheme(effTheme)"));
  });

  it("resolves the palette AND the measure from the one object", () => {
    expect(reader).toContain("const effTheme = own ? readingThemeId(own.id) : ((builtin as ThemeId | null) ?? ts.bookThemeId);");
    expect(reader).toContain("let initialStyle = own ? resolveAppearanceStyle(own, target.dir ?? undefined, global) : global;");
  });

  it("leaves a FOLLOWING book on the untouched path", () => {
    // Re-resolving a following book from the worn هيئة would discard the reader's own unsaved changes,
    // which is why "follow" means "the existing row" and not "resolve the worn one".
    expect(reader).toContain("const global = await loadGlobalStyle(target.dir ?? undefined);");
  });

  it("declines a global switch entirely when the book wears its own", () => {
    expect(reader).toMatch(/if \(bookAppearanceRef\.current\) return;\s*\n\s*setBookThemeId\(defaultBookTheme\);/);
  });

  it("writes the book's row against the book actually open", () => {
    // RAWY-285: this closure outlives the book that made it when the Reader is reused, so a CAPTURED
    // id writes one book's choice onto another's row. Stated as the rule rather than as a distance —
    // the draft guard now sits in front of it, and a character count is not what anyone meant.
    const fn = reader.slice(reader.indexOf("const setThisBookAppearance = (id: string | null)"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body).toContain("const book = bookRef.current;");
    expect(body).not.toContain("initial.id");
  });

  it("offers «افتراضي» and the reader's own هيئات, by PROFILE id", () => {
    const list = settings.slice(settings.indexOf('label={t("appearance.book")}'));
    const opts = list.slice(0, list.indexOf("onChange="));
    expect(opts).toContain("BOOK_APPEARANCE_FOLLOW");
    expect(opts).toContain("key: p.id as string");
    expect(opts.indexOf("BOOK_APPEARANCE_FOLLOW")).toBeLessThan(opts.indexOf("profiles.map"));
  });

  it("does NOT offer the sixteen papers — they are not هيئات and have their own grid", () => {
    const list = settings.slice(settings.indexOf('label={t("appearance.book")}'));
    const opts = list.slice(0, list.indexOf("onChange="));
    expect(opts).not.toContain("THEME_ORDER.map");
    // The grid above is untouched and still offers every one of them.
    expect(settings).toContain("{THEME_ORDER.map((id) => (");
    expect(settings).toContain('className="rs-swatches"');
  });

  it("...except the one a book is ALREADY on, so the control cannot misreport its state", () => {
    const list = settings.slice(settings.indexOf('label={t("appearance.book")}'));
    const opts = list.slice(0, list.indexOf("onChange="));
    expect(opts).toContain("bookAppearanceId && isBuiltinThemeId(bookAppearanceId)");
    expect(opts).toContain('note: t("appearance.book.paperOnly")');
  });

  it("every row carries a preview built from that هيئة's own reading palette", () => {
    const list = settings.slice(settings.indexOf('label={t("appearance.book")}'));
    const opts = list.slice(0, list.indexOf("onChange="));
    expect(opts).toContain("swatch: <AppearanceChip colors={wornColors} />");
    expect(opts).toContain("swatch: <AppearanceChip colors={p.data.theme.reading.colors} />");
    // The chip describes shape only; every colour is inline from the هيئة, so there is no second
    // description of what a هيئة looks like.
    expect(settings).toMatch(/function AppearanceChip\(\{ colors \}: \{ colors: ThemeColors \}\)/);
    for (const c of ["colors.surfaceBg", "colors.paperBg", "colors.text", "colors.accent", "colors.chromeBorder"]) {
      expect(settings, c).toContain(c);
    }
    const cssRules = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const cls of [".rs-app-chip", ".rs-app-page", ".rs-app-line", ".rs-app-accent"]) {
      expect(cssRules, cls).toContain(cls);
    }
    // Logical insets, so the accent sits on the leading edge in both directions.
    expect(cssRules).toMatch(/\.rs-app-accent \{[^}]*inset-inline-start/);
    expect(cssRules).toMatch(/\.rs-app-page \{[^}]*inset-inline-start/);
  });

  it("names the control an APPEARANCE, not a paper", () => {
    const en = read("src/i18n/locales/en.ts");
    const ar = read("src/i18n/locales/ar.ts");
    expect(en).toContain('"appearance.book": "This book’s appearance"');
    expect(ar).toContain('"appearance.book": "هيئة هذا الكتاب"');
    expect(ar).toContain('"appearance.book.follow": "افتراضي"');
    // The hint must warn that an edit afterwards reaches every book wearing that هيئة.
    expect(en).toMatch(/appearance\.bookHint[\s\S]{0,400}every book using it/);
    expect(ar).toMatch(/appearance\.bookHint[\s\S]{0,400}كل كتاب يلبسها/);
    expect(en).not.toContain('"theme.bookOwn"');
  });
});

const BASE_PARAMS = {
  presence: 50, blur: 0, flip: false, focalX: 50, focalY: 50, pageOpacity: 1, immersiveBlur: true,
};

describe("the READING picture travels with the هيئة; the LIBRARY picture does not", () => {
  const withBg = (over: Record<string, unknown> = {}): Profile => {
    const p = appearance("u:bg");
    p.data.bg = {
      library: { ref: "lib-image", params: { ...BASE_PARAMS, presence: 10 } },
      reading: { ref: "read-image", params: { ...BASE_PARAMS, presence: 70, blur: 12 }, sameAsLibrary: false, overlay: null, ...over },
    };
    return p;
  };

  it("resolves the هيئة's own reading picture and its adjustments", () => {
    const { ref, params } = readingBackgroundOf(withBg());
    expect(ref).toBe("read-image");
    expect(params.presence).toBe(70);
    expect(params.blur).toBe(12);
  });

  it("never resolves the LIBRARY picture as a book's", () => {
    expect(readingBackgroundOf(withBg()).ref).not.toBe("lib-image");
  });

  it("honours «the same image, quieter» through the model's OWN rule, not a second one", () => {
    // A هيئة may point its reading surface at the library's picture. `profileRefs` decides that, and
    // activation uses the same call — so reading it here cannot drift from what wearing it does.
    const p = withBg({ sameAsLibrary: true });
    const r = readingBackgroundOf(p);
    expect(r.ref).toBe("lib-image");
    expect(r.params.presence).toBe(70);   // ...with the READING surface's own adjustments
  });

  it("folds a picture change back into the هيئة, not into a per-book row", () => {
    const p = withBg();
    const n = withBackgroundEdit(p, { params: { ...BASE_PARAMS, presence: 33 } });
    expect(n).not.toBe(p);
    expect(n.data.bg.reading.params.presence).toBe(33);
    expect(p.data.bg.reading.params.presence).toBe(70);          // the original is untouched
    expect(n.data.bg.library.params.presence).toBe(10);          // ...and so is the library surface
  });

  it("choosing a picture ends «the same image, quieter»", () => {
    const n = withBackgroundEdit(withBg({ sameAsLibrary: true }), { ref: "new-image" });
    expect(n.data.bg.reading.ref).toBe("new-image");
    expect(n.data.bg.reading.sameAsLibrary).toBe(false);
  });

  it("clearing it removes the picture from the هيئة", () => {
    const n = withBackgroundEdit(withBg(), { ref: null });
    expect(n.data.bg.reading.ref).toBeNull();
  });
});

describe("the background store's side of it", () => {
  it("keeps the session's reading surface beside the effective one", () => {
    expect(background).toContain("readingSession: BackgroundRow | null;");
    expect(background).toContain("readingSessionParams: BgParams;");
    expect(background).toContain("wearReadingBackground: (ref: string | null, params: BgParams | null) => void;");
  });

  it("returns «افتراضي» to the CURRENT session value, not a remembered one", () => {
    expect(background).toMatch(/if \(params === null\)[\s\S]{0,200}readingSession/);
  });

  it("defers every reading-surface write to the هيئة that owns it", () => {
    for (const m of ["setParams", "resetParams"]) {
      expect(background, m).toContain("if (ownedReading(surface)) { readingOwner!.setParams");
    }
    expect(background).toContain("if (ownedReading(surface)) { readingOwner!.setImage(row.id, params); return row; }");
    expect(background).toMatch(/clear: async \(surface\) => \{[\s\S]{0,400}ownedReading\(surface\)/);
  });

  it("owns the READING surface only — the library surface has no owner at all", () => {
    expect(background).toContain('const ownedReading = (surface: BgSurface): boolean => surface === "reading"');
    expect(background).not.toContain('ownedLibrary');
  });

  it("knows nothing about هيئات — the owner is injected, so the dependency runs one way", () => {
    expect(background).not.toContain("features/profiles");
    expect(background).not.toContain("bookAppearance");
  });
});

describe("a هيئة switch under an open book", () => {
  it("re-asserts the book's own هيئة instead of pushing the new one onto it", () => {
    // `applyProfile` re-runs `initBackground`, which re-hydrates the reading surface. Without this the
    // palette and the measure would hold while the DESK quietly became the other هيئة's picture.
    //
    // Stated as the RULE rather than as a character distance: the branch is keyed on the book's own
    // هيئة, and the picture's owner is installed before it — a line that widened the old gap.
    const fn = readerCode.slice(readerCode.indexOf("}, [applyTick]);") - 2600, readerCode.indexOf("}, [applyTick]);"));
    expect(fn).toContain("const own = appearanceFor(bookAppearanceRef.current).own;");
    expect(fn).toContain("if (!own) {");
    expect(fn).toContain("const next = resolveAppearanceStyle(own, dir ?? undefined, global);");
  });

  it("the PICTURE's owner is the EFFECTIVE one, in every branch", () => {
    // MEASURED DEFECT: these three call sites passed `own` — the book's OWN هيئة, which is null for a
    // following book — so such a book had no picture owner at all and the drawer's picture controls
    // fell through to the shared `bg_reading_params` row. Measured as Presence 9 -> 7 written straight
    // to that row, with no draft, nothing asked on the way out, and nothing Discard could reach.
    expect(readerCode).not.toContain("wearAppearanceBackground(own)");
    // The argument, up to the call's own closing paren — `ownerFor()` contains one of its own.
    const calls = [...readerCode.matchAll(/wearAppearanceBackground\((.*?)\);/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // Every call resolves the owner: `ownerFor()`, the discard path's `saved` (itself `ownerFor()`),
    // or the explicit hand-back on unmount.
    for (const a of calls) expect(["ownerFor()", "saved", "null"]).toContain(a);
  });

  it("hands the desk back when the reader leaves the book", () => {
    expect(reader).toMatch(/useBackground\.getState\(\)\.wearReadingBackground\(null, null\);[\s\S]{0,40}setReadingBackgroundOwner\(null\);/);
  });
});

describe("the Reader's polarity is the BOOK's, the Library's is the app's", () => {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] }))
    .filter((r) => r.sel && !r.sel.startsWith("@"));

  /** Classes that render inside `.reader-root` — every one traced to a file under features/reader/. */
  const READER_CLASSES = [
    "page-chevron", "rc-top", "reader-panel", "rp-tab", "hl-pop", "nec", "nec-scrim", "nec-del",
    "note-scrim", "note-sheet", "pc-basket-tray", "tts-pill", "tts-menu", "tts-mini--kashida",
    "tts-resume", "vm-card", "ref-scrim", "ref-dialog", "ref-del", "ref-popup",
  ];

  /**
   * Does this selector name that class? Plain string work, because a hand-built RegExp is exactly how
   * the first version of this guard passed while testing nothing: `"\."` is just a dot and `"\b"` is a
   * BACKSPACE character, so the pattern could never match and every rule looked clean.
   */
  const names = (sel: string, c: string) =>
    sel.split(/[\s,]+/).some((part) => part === "." + c || part.startsWith("." + c + ":")
      || part.startsWith("." + c + ".") || part.startsWith("." + c + "["));

  it("no reader-visual rule is keyed on the APPLICATION's polarity any more", () => {
    const stragglers = rules
      .filter((r) => /:root\[data-dark/.test(r.sel))
      .filter((r) => READER_CLASSES.some((c) => names(r.sel, c)));
    expect(stragglers.map((r) => r.sel)).toEqual([]);
  });

  it("...they are keyed on the BOOK's instead", () => {
    for (const c of READER_CLASSES) {
      const hit = rules.some((r) => /\.reader-root\[data-book-dark/.test(r.sel) && names(r.sel, c));
      expect(hit, c).toBe(true);
    }
  });

  it("and what still asks the application is only the application's own furniture", () => {
    const left = rules.filter((r) => /:root\[data-dark/.test(r.sel) && /\./.test(r.sel.split("]")[1] ?? ""));
    for (const r of left) {
      // Library shelves, the importer, the updater and the composer modal dress the APP, not a book.
      expect(r.sel, r.sel).toMatch(/\.(import-report|lib-viewtoggle|lib-shelf-act|edit-del|upd-[a-z-]+|pcx-modal)/);
    }
    expect(left.length).toBeGreaterThan(4);
  });

  it("the dark-mode token block is DUPLICATED for the reader, never moved away from the root", () => {
    // Moving it would strip a token from anything outside the reader that already resolves it.
    expect(css).toMatch(/:root\[data-dark="true"\] \{[^}]*--nc-cap:/);
    expect(css).toMatch(/\.reader-root\[data-book-dark="true"\] \{[^}]*--nc-cap:/);
  });

  it("the reader still publishes the book's own polarity for these to key on", () => {
    expect(reader).toMatch(/data-book-dark=\{String\(readingTheme\.dark\)\}/);
  });
});

describe("the paper belongs to the هيئة that owns it", () => {
  const NOCTURNE = { id: "nocturne", name: "Nocturne", dark: true, highlightAlpha: 0.32,
    colors: { ...BASE_COLORS, paperBg: "#101820", text: "#DCE3EA", accent: "#7FA6C9" } } as never;

  it("folds a picked paper into the هيئة's READING palette", () => {
    const p = appearance("u:x", { paperBg: "#FFFFFF" });
    const n = withPaperEdit(p, "nocturne", NOCTURNE);
    expect(n).not.toBe(p);
    expect(n.data.theme.reading.colors.paperBg).toBe("#101820");
    expect(n.data.theme.reading.dark).toBe(true);
    expect(n.data.theme.reading.highlightAlpha).toBe(0.32);
    expect(p.data.theme.reading.colors.paperBg).toBe("#FFFFFF");   // the original is untouched
  });

  it("records which of the sixteen it started from, so the editor can still offer to reset to it", () => {
    expect(withPaperEdit(appearance("u:x"), "nocturne", NOCTURNE).data.theme.reading.base).toBe("nocturne");
    // A palette that is not one of the sixteen has no base — the editor's own rule.
    expect(withPaperEdit(appearance("u:x"), "u:other~r", NOCTURNE).data.theme.reading.base).toBeNull();
  });

  it("changes the PAPER and nothing else the هيئة holds in that palette", () => {
    const p = appearance("u:x");
    p.data.theme.reading.numbers = "#AA0000";
    (p.data.theme.reading as unknown as Record<string, unknown>).bookmark = "#00FF00";
    (p.data.theme.reading as unknown as Record<string, unknown>).separator = "#0000FF";
    const n = withPaperEdit(p, "nocturne", NOCTURNE);
    expect(n.data.theme.reading.numbers).toBe("#AA0000");
    expect((n.data.theme.reading as unknown as Record<string, unknown>).bookmark).toBe("#00FF00");
    expect((n.data.theme.reading as unknown as Record<string, unknown>).separator).toBe("#0000FF");
  });

  it("leaves the LIBRARY palette of that هيئة alone", () => {
    const p = appearance("u:x");
    const before = JSON.stringify(p.data.theme.library);
    expect(JSON.stringify(withPaperEdit(p, "nocturne", NOCTURNE).data.theme.library)).toBe(before);
  });

  it("the Reader routes a paper pick to the owner, and only then to the shared row", () => {
    // A book wearing its own هيئة edits THAT هيئة; a following book takes the untouched path, which is
    // what keeps the existing drift/consent model exactly as it was.
    // The owner is resolved the same way for every control now — the book's own هيئة, else the one
    // the Library wears. Before, only a book with its own row had an owner at all.
    // Through the appearance IN FORCE — the dirty draft if there is one, else the effective owner.
    expect(reader).toMatch(/const setBookTheme = \(id: ThemeId\) => \{[\s\S]{0,200}const own = appearanceInForce\(\);/);
    expect(reader).toContain("editAppearance(withPaperEdit(own, id, resolveTheme(id)))");
    // AND IT MUST NOT SAVE. A paper chosen inside a book is unsaved until the reader says so on the
    // way out; writing it here is the behaviour this whole model replaced.
    expect(reader).not.toContain("saveProfile(withPaperEdit");
    expect(reader).toContain("useTheme.getState().setBookTheme(id); // shared BOOK theme");
    // The shared write must sit AFTER the early return, or a book's own choice would move the global.
    const fn = reader.slice(reader.indexOf("const setBookTheme = (id: ThemeId)"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body.indexOf("withPaperEdit")).toBeLessThan(body.indexOf("useTheme.getState().setBookTheme"));
    expect(body).toMatch(/withPaperEdit[\s\S]{0,120}return;/);
  });

  it("repaints the book when the palette behind an unchanged id moves", () => {
    // Editing the paper of a هيئة a book wears changes no id at all, so nothing keyed on the id fires.
    expect(reader).toContain("const paletteKey = ");
    expect(reader).toMatch(/\}, \[paletteKey\]\);/);
    expect(reader).toMatch(/ctrlRef\.current\?\.applyTheme\(readingTheme,/);
  });

  it("the grid marks the EFFECTIVE paper and names its owner", () => {
    // Through the ONE resolver, so the swatch that is lit and the paper on the page cannot disagree:
    // while a draft is open it is the draft that both of them read.
    expect(settings).toContain("const ownPaperProfile = bookAppearanceId ? resolveAppearance(bookAppearanceId, profiles) : null;");
    expect(settings).toContain("useAppearanceDraft((st) => st.current);");
    // A FOLLOWING book marks what the SHARED ROW says, not the worn هيئة's base — the two part company
    // the moment the reader picks a paper, and marking the هيئة then showed one paper while the page
    // wore another (measured: page on Sepia, True-Black marked).
    expect(settings).toContain("isBuiltinThemeId(appearanceThemeId) ? appearanceThemeId : worn?.data.theme.reading.base ?? null");
    // ...and the owner goes quiet when no هيئة holds the colour in force.
    expect(settings).toContain("const paperProfile = ownPaperProfile ?? (isBuiltinThemeId(appearanceThemeId) ? null : worn);");
    expect(settings).toContain("paperBase === id ?");
    expect(settings).not.toContain("appearanceThemeId === id ?");
    // Day/Night follows the paper on screen, not the global one.
    expect(settings).toContain('value={dark ? "night" : "day"}');
    expect(settings).not.toContain('value={appearanceTheme.dark ? "night" : "day"}');
    expect(settings).toContain('t("appearance.paperOwner", { name: paperOwner })');
  });
});

// =================================================================================================
// THE SESSION DRAFT — an edit made inside a book, and the moment it is asked about.
//
// The rule under test is the one the owner set: a هيئة-owned property changed from inside a book
// shows on the page AT ONCE and does not reach the هيئة until they say so on the way out. So there
// are exactly three outcomes — Save writes it, Discard drops it, Stay keeps it unsaved — and there is
// never a per-book copy of anything at any point.
// =================================================================================================
describe("an unsaved هيئة, for as long as the book is open", () => {
  beforeEach(() => {
    clearAppearanceDraft();
    useProfiles.setState({ profiles: [RUNES, SEKIRO] });
  });
  const list = [RUNES, SEKIRO];
  const sepia = () => withPaperEdit(RUNES, "sepia", SEPIA_THEME);

  it("with no draft, a book resolves the هيئة that is saved", () => {
    expect(resolveAppearance("u:runes", list)).toBe(RUNES);
    expect(resolveAppearance(null, list)).toBeNull();
    expect(resolveAppearance("u:gone", list)).toBeNull();
  });

  it("an edit is HELD, not written — and the book reads the draft from that moment", () => {
    const next = sepia();
    editAppearance(next);
    // The book sees it...
    expect(resolveAppearance("u:runes", list)).toBe(next);
    expect((resolveAppearance("u:runes", list) as Profile).data.theme.reading.base).toBe("sepia");
    // ...and the هيئة itself has not moved. This is the whole difference from what it replaced.
    expect(RUNES.data.theme.reading.base).toBeNull();
    expect(list.find((p) => p.id === "u:runes")).toBe(RUNES);
  });

  it("a هيئة the draft is not about is untouched", () => {
    editAppearance(sepia());
    expect(resolveAppearance("u:sekiro", list)).toBe(SEKIRO);
  });

  it("SEVERAL edits are ONE draft — not one question per property", () => {
    editAppearance(sepia());
    editAppearance(withReadingEdit(resolveAppearance("u:runes", list) as Profile, { zoom: 1.4, arabicFont: "kitab" }));
    const held = draftFor("u:runes");
    expect(held).not.toBeNull();
    // One draft, carrying BOTH changes, measured against the ONE saved row it departed from.
    expect(held!.saved).toBe(RUNES);
    expect(held!.draft.data.theme.reading.base).toBe("sepia");
    expect(held!.draft.data.type.reading.zoom).toBe(1.4);
    expect(held!.draft.data.type.arabic).toBe("kitab");
    expect(useAppearanceDraft.getState().current!.id).toBe("u:runes");
  });

  it("dirtiness is DERIVED, so a change put back asks nothing on the way out", () => {
    expect(appearanceDraftDirty()).toBe(false);
    editAppearance(withReadingEdit(RUNES, { zoom: 1.4 }));
    expect(appearanceDraftDirty()).toBe(true);
    // Back to exactly what the هيئة holds: nothing is unsaved, so nothing is asked.
    editAppearance({ ...RUNES, data: JSON.parse(JSON.stringify(RUNES.data)) as Profile["data"] });
    expect(appearanceDraftDirty()).toBe(false);
  });

  it("an edit to a هيئة that is gone is dropped rather than drafted against nothing", () => {
    useProfiles.setState({ profiles: [SEKIRO] });
    editAppearance(withReadingEdit(RUNES, { zoom: 1.4 }));
    expect(useAppearanceDraft.getState().current).toBeNull();
  });

  it("discarding leaves the هيئة exactly as it was", () => {
    const before = JSON.stringify(RUNES.data);
    editAppearance(sepia());
    clearAppearanceDraft();
    expect(resolveAppearance("u:runes", list)).toBe(RUNES);
    expect(JSON.stringify(RUNES.data)).toBe(before);
    expect(appearanceDraftDirty()).toBe(false);
  });

  it("a HAND-PAINTED هيئة returns to its own colours, `base: null` included", () => {
    expect(RUNES.data.theme.reading.base).toBeNull();
    const paper = RUNES.data.theme.reading.colors.paperBg;
    editAppearance(sepia());
    expect((resolveAppearance("u:runes", list) as Profile).data.theme.reading.base).toBe("sepia");
    clearAppearanceDraft();
    const back = resolveAppearance("u:runes", list) as Profile;
    expect(back.data.theme.reading.base).toBeNull();
    expect(back.data.theme.reading.colors.paperBg).toBe(paper);
  });

  it("names what changed in the words the dialog already uses", () => {
    // The palette is not a settings key, so `profileValues` cannot see it — and the paper is the
    // commonest edit there is, so it would otherwise be reported as an unnamed "something".
    expect(changesBetween(RUNES, sepia())).toContain("book_theme_id");
    expect(changesBetween(RUNES, withReadingEdit(RUNES, { zoom: 1.4 }))).toContain("zoom");
    expect(changesBetween(RUNES, withReadingEdit(RUNES, { arabicFont: "kitab" }))).toContain("arabicFont");
    expect(changesBetween(RUNES, withBackgroundEdit(RUNES, { ref: "asset-9" }))).toContain("bg_reading");
    // Nothing moved, nothing named.
    expect(changesBetween(RUNES, RUNES)).toEqual([]);
  });
});

describe("the Reader asks the question the rest of Sard already asks", () => {
  it("every door out of the book goes through the guard", () => {
    // Two doors, and both are props — so wrapping them covers every caller inside the Reader.
    expect(readerCode).toContain("const exitBook = useCallback(() => leaveWithDraft(onExit)");
    expect(readerCode).toContain("leaveWithDraft(() => onOpenBook?.(t))");
    expect(readerCode).toContain("onBack={exitBook}");
    expect(readerCode).toContain("onOpenBook={openOtherBook}");
    expect(readerCode).toContain("back: exitBook,");
    expect(readerCode).toContain("reimport: exitBook,");
    expect(readerCode).toContain('"remove-book": exitBook,');
    // ...and nothing reaches the raw props behind their backs.
    expect(readerCode).not.toContain("onBack={onExit}");
    expect(readerCode).not.toContain("onOpenBook={onOpenBook}");
  });

  it("it is the EXISTING dialog with its own three answers, not a second one", () => {
    expect(readerCode).toContain("guardUnsaved(");
    expect(readerCode).toContain("subject: held.draft,");
    expect(readerCode).toContain("await commitAppearanceDraft();");
    // ONE half now — the هيئة's. The colours moved into it, and reading mode is deliberately outside
    // the boundary, so there is nothing else the sentence could truthfully name.
    expect(readerCode).toContain("changesBetween(held.saved, held.draft)");
    expect(readerCode).not.toContain("sessionDraftChanges()");
    // No new modal family, no toast, no undo of its own.
    expect(readerCode).not.toMatch(/pf-toast|SavedAnnounce|useProfileSaved/);
  });

  it("a clean draft never asks", () => {
    // EITHER half being clean is not enough — `draftDirty` is the one that answers for both.
    expect(readerCode).toMatch(/if \(!held \|\| !draftDirty\(\)\) \{[\s\S]{0,140}go\(\);/);
  });

  it("changing which هيئة the book wears asks too, rather than stranding the draft", () => {
    const fn = readerCode.slice(readerCode.indexOf("const setThisBookAppearance = (id: string | null)"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body).toContain("leaveWithDraft(() => setThisBookAppearance(id), { keepsBook: true });");
    // ...and it says the book SURVIVES, which is what keeps the discard repaint (and stops the
    // Reader standing down from painting on a route that is not leaving at all).
    expect(readerCode).toContain("const leaving = !opts?.keepsBook;");
  });

  it("the palette and the interface are resolved from the draft, never from the registry", () => {
    expect(readerCode).toContain("profileReadingTheme(liveDraft.draft)");
    // From the OWNER's id, so a following book's draft paints too — keying on the book's own row
    // meant a draft of the global default was made, and then never shown.
    expect(readerCode).toContain("const ownerId = bookAppearanceId ?? liveActiveId;");
    expect(readerCode).toContain("resolveAppearance(ownerId, allProfiles)");
  });

  it("a DEFAULT book still takes the shared path, and no draft is made for it", () => {
    // `appearanceFor` yields no owner for a following book, so every writer's `if (own)` is false and
    // the existing global mechanism is reached exactly as it was.
    const fn = readerCode.slice(readerCode.indexOf("const setBookTheme = (id: ThemeId)"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body).toMatch(/if \(own\) \{[\s\S]*?editAppearance\([\s\S]*?return;[\s\S]*?\}/);
    // `readerCode` is comment-stripped, so the code alone — the shared write must still be there,
    // and must still sit after the early return that an owned book takes.
    expect(body).toContain("useTheme.getState().setBookTheme(id);");
    expect(body.indexOf("editAppearance")).toBeLessThan(body.indexOf("useTheme.getState().setBookTheme"));
  });

  it("a book on its way out is not painted — the vendored paginator cannot survive it", () => {
    // MEASURED: `setStyles` queues `requestAnimationFrame(() => … getBackground(this.#view.document))`
    // with no guard on `#view` (paginator.js:1204). Answering the dialog and leaving in the same tick
    // tore the view down before that frame ran — one uncaught TypeError per exit, on Save and on
    // Discard, where a plain exit and a reload produced none.
    expect(readerCode).toContain("if (leavingRef.current) return;");
    const fn = readerCode.slice(readerCode.indexOf("const leaveWithDraft = useCallback"));
    const body = fn.slice(0, fn.indexOf("\n  }, []);"));
    expect(body).toContain("leavingRef.current = leaving;");
    expect(body).toContain("if (leaving) return;");
  });

  it("the draft never outlives the Reader that holds it", () => {
    expect(readerCode).toMatch(/setReadingBackgroundOwner\(null\);\s*clearAppearanceDraft\(\);\s*\}, \[\]\);/);
  });
});

describe("no persistent undo survives anywhere", () => {
  it("the snapshot column is dropped, and the migration that added it is left standing as history", () => {
    expect(migrations).toContain('"drop_profile_prev_data"');
    // The add stays: it has run on a real database, and this runner tracks migrations by presence.
    expect(migrations).toContain('"profile_prev_data"');
    expect(dropSql).toContain("ALTER TABLE profiles DROP COLUMN prev_data;");
    // ...and the drop must be listed AFTER the add, or a fresh database drops what was never added.
    expect(migrations.indexOf('"profile_prev_data"')).toBeLessThan(migrations.indexOf('"drop_profile_prev_data"'));
  });

  it("nothing reads or writes it any more, and no announcement is left behind", () => {
    expect(rustSave).not.toContain("prev_data");
    expect(profStore).not.toContain("useProfileSaved");
    expect(profStore).not.toMatch(/opts\.announce|announce\?:/);
    expect(readerCode).not.toContain("prev_data");
    expect(appSrc).not.toContain("SavedAnnounce");
  });
});

// =================================================================================================
// C · THE AUTHORED ROW — a field nobody set must not acquire a value because another field changed.
// =================================================================================================
describe("the session row is written as authored, never as resolved", () => {
  it("only the reader's own fields are persisted", () => {
    // `saveGlobalRow` drops `undefined` so a field returned to "no opinion" stops being stored,
    // rather than freezing at whatever it last resolved to.
    expect(perBook).toContain("export function saveGlobalRow(");
    expect(perBook).toMatch(/for \(const \[k, v\] of Object\.entries\(row\)\) if \(v !== undefined\) clean\[k\] = v;/);
    expect(perBook).toContain("export function peekGlobalRow(");
  });

  it("the Reader keeps the authored row apart from the resolved style", () => {
    expect(readerCode).toContain("const globalRowRef = useRef<Partial<ReadingStyle>>({});");
    expect(readerCode).toContain("globalRowRef.current = peekGlobalRow() ?? {};");
    // A following book writes what was authored plus this edit — not the resolved object.
    expect(readerCode).toContain("globalRowRef.current = { ...globalRowRef.current, ...patch };");
    expect(readerCode).toContain("saveGlobalRow(globalRowRef.current);");
  });

  it("the RESOLVED style can no longer reach the row by any route", () => {
    // THE MEASURED DEFECT: one page-colour pick inside an Arabic book persisted `align: "start"`,
    // and every Latin book that followed the global was then set `start` instead of `justify`.
    expect(readerCode).not.toContain("saveGlobalStyle(");
    expect(readerCode).not.toMatch(/saveGlobalRow\(useReader\.getState\(\)\.style/);
    expect(readerCode).not.toMatch(/saveGlobalRow\(globalStyleRef/);
  });

  it("`align` really is the field that made this matter", () => {
    // The other four resolved fields are identical across scripts; this is the one that differs, so
    // this is the one that silently re-set books in the other script.
    expect(ARABIC_DEFAULTS.align).toBe("start");
    expect(LATIN_DEFAULTS.align).toBe("justify");
  });
});

// =================================================================================================
// B · THE SESSION HALF — the same sitting, the same question, both owners.
// =================================================================================================
describe("the page colour and the ink belong to the هيئة", () => {
  it("they edit the palette the هيئة already carries — no second representation", () => {
    const next = withPaletteEdit(RUNES, { paperBg: "#123456" });
    expect(next.data.theme.reading.colors.paperBg).toBe("#123456");
    // ...and the saved object is untouched.
    expect(RUNES.data.theme.reading.colors.paperBg).toBe("#171A17");
    // No duplicate field was invented for it.
    expect(JSON.stringify(next.data)).not.toContain("pageColor");
    expect(JSON.stringify(next.data)).not.toContain("textColor");
  });

  it("the ink likewise, and the two are independent", () => {
    const next = withPaletteEdit(RUNES, { text: "#EEEEEE" });
    expect(next.data.theme.reading.colors.text).toBe("#EEEEEE");
    expect(next.data.theme.reading.colors.paperBg).toBe(RUNES.data.theme.reading.colors.paperBg);
  });

  it("a hand-picked colour breaks the preset lineage, and says so", () => {
    const onSepia = withPaperEdit(RUNES, "sepia", SEPIA_THEME);
    expect(onSepia.data.theme.reading.base).toBe("sepia");
    // The palette is no longer that preset once a slot is picked by hand.
    expect(withPaletteEdit(onSepia, { paperBg: "#123456" }).data.theme.reading.base).toBeNull();
  });

  it("«theme default» resolves from the preset the palette was built on", () => {
    const onSepia = withPaperEdit(RUNES, "sepia", SEPIA_THEME);
    const moved = withPaletteEdit(onSepia, { paperBg: "#123456" });
    expect(moved.data.theme.reading.colors.paperBg).toBe("#123456");
    // `null` is the control's "default" — it must not freeze today's value.
    const back = withPaletteEdit({ ...moved, data: { ...moved.data,
      theme: { ...moved.data.theme, reading: { ...moved.data.theme.reading, base: "sepia" } } } } as Profile,
      { paperBg: null });
    expect(back.data.theme.reading.colors.paperBg).toBe(SEPIA_THEME.colors.paperBg);
  });

  it("nothing moves when the patch names neither slot", () => {
    expect(withPaletteEdit(RUNES, {})).toBe(RUNES);
  });
});

describe("the Reader addresses ONE owner, whichever kind of book it is", () => {
  it("the owner is the book's own هيئة, else the one the Library wears", () => {
    const fn = readerCode.slice(readerCode.indexOf("const ownerFor = useCallback"));
    const body = fn.slice(0, fn.indexOf("\n  }, []);"));
    expect(body).toContain("resolveAppearance(bookAppearanceRef.current, list)");
    expect(body).toContain("resolveAppearance(useProfiles.getState().activeId ?? null, list)");
    // A book on a BUILTIN paper names no هيئة, so there is no owner to edit.
    expect(body).toContain("if (bookAppearanceRef.current) return null;");
  });

  it("every appearance-owned writer goes through it", () => {
    // EVERY WRITER resolves the appearance IN FORCE, never the re-derived owner: a dirty draft's
    // identity must survive a later edit, a Global Default change and a book-appearance switch.
    expect(readerCode).toContain("const ownAppearance = appearanceInForce();");
    expect(readerCode).toContain("const wearing = appearanceInForce();");
    expect(readerCode).toContain("const own = appearanceInForce();");
    expect(readerCode).toContain("const live = appearanceInForce();");
    // MEASURED DEFECT: with `ownerFor()` here, editing again after the Global Default moved rebuilt
    // the draft from the NEW هيئة — the pending change was dropped and Save wrote an appearance the
    // reader never set out to edit.
    const wr = readerCode.slice(readerCode.indexOf("const update = (patch: Partial<ReadingStyle>)"));
    expect(wr.slice(0, wr.indexOf("\n  };"))).not.toContain("ownerFor()");
    // ...and nothing resolves an owner from the book row alone any more.
    expect(readerCode).not.toContain("bookAppearanceRef.current ? appearanceFor(bookAppearanceRef.current).own : null");
  });

  it("the two colours edit the owner's palette, not a shared row", () => {
    const fn = readerCode.slice(readerCode.indexOf("const setReadingColour ="));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body).toContain("editAppearance(withPaletteEdit(own,");
    // With no owner the control does nothing — the shared row is no longer an answer, because the
    // page resolves from the palette alone and a value written there would never be shown.
    expect(body).toContain("if (!own) return;");
    expect(body).not.toContain("update(");
  });

  it("the page no longer reads the shared override ahead of the palette", () => {
    expect(readerCode).toContain('"--reader-page": readingTheme.colors.paperBg,');
    expect(readerCode).not.toContain("style?.pageColor ?? readingTheme.colors.paperBg");
  });

  it("the drawer shows the هيئة's own colours", () => {
    expect(settings).toContain("const paper = theme.colors.paperBg;");
    expect(settings).toContain("const ink = theme.colors.text;");
    expect(settings).not.toContain("style.pageColor ?? theme.colors.paperBg");
    expect(settings).not.toContain("style.textColor ?? theme.colors.text");
  });

  it("the guard takes the draft's identity FROM THE DRAFT, never by re-deriving the owner", () => {
    // MEASURED DEFECT: a following book drafted the global default «TNocturne»; the reader then
    // changed the Library's هيئة to «TRing» while the draft was dirty. Looking the draft up by the
    // owner re-derived TRing, found no draft for it, and the dialog said «Unsaved changes in TRing»
    // over the generic body — the changed-property list lost — while Save correctly wrote TNocturne.
    // The reader was asked about one هيئة and their answer applied to another.
    expect(readerCode).toContain("const held = heldDraft();");
    expect(readerCode).not.toContain("draftFor(ownerFor()?.id ?? null)");
    expect(readerCode).not.toContain("draftFor(bookAppearanceRef.current)");
    // ...and every use of that identity comes from the same object.
    expect(readerCode).toContain("subject: held.draft,");
    expect(readerCode).toContain("keys: changesBetween(held.saved, held.draft),");
    // `ownerFor` still decides the owner for a NEW edit — reached through `appearanceInForce`,
    // which prefers an existing dirty draft and falls back to it.
    expect(readerCode).toMatch(/const appearanceInForce = useCallback\(\(\): Profile \| null => \{[\s\S]{0,200}return ownerFor\(\);/);
    expect(readerCode).toContain("if (held && appearanceDraftDirty()) return held.draft;");
  });
});

describe("reading mode is NOT appearance", () => {
  it("the four stay on the session row and out of the هيئة", () => {
    for (const k of ["flowMode", "pageFitWindow", "immHidePill", "immHideScrollbar"]) {
      expect(SESSION_OWNED_FIELDS as readonly string[]).toContain(k);
      expect(PROFILE_READING_FIELDS as readonly string[]).not.toContain(k);
    }
    const split = splitReadingEdit({ flowMode: "scrolled", pageFitWindow: true, zoom: 2 });
    expect(split.session).toEqual({ flowMode: "scrolled", pageFitWindow: true });
    expect(split.appearance).toEqual({ zoom: 2 });
  });

  it("the page and the ink have LEFT the session list", () => {
    expect(SESSION_OWNED_FIELDS as readonly string[]).not.toContain("pageColor");
    expect(SESSION_OWNED_FIELDS as readonly string[]).not.toContain("textColor");
  });

  it("a mode change is written as it is made, and never asks to be saved into a هيئة", () => {
    expect(readerCode).toContain("globalRowRef.current = { ...globalRowRef.current, ...split.session };");
    expect(readerCode).toContain("saveGlobalRow(globalRowRef.current);");
    // One half now: the هيئة draft. Reading mode is not inside the boundary.
    expect(draftSrc).toContain("export function draftDirty(): boolean {");
    expect(draftSrc).not.toContain("SessionDraft");
    expect(draftSrc).not.toContain("editSession");
  });
});

describe("the legacy shared colours are removed once", () => {
  it("the migration clears exactly those two keys, idempotently and narrowly", () => {
    expect(legacySql).toContain("json_remove(value, '$.pageColor', '$.textColor')");
    expect(legacySql).toContain("WHERE key = 'reading_style'");
    expect(legacySql).toContain("json_valid(value)");
    // It must not reach a profile blob, a book override or an assignment.
    expect(legacySql).not.toMatch(/profiles|book_appearance|theme_id/);
    expect(migrations).toContain('"reading_style_drop_legacy_colours"');
  });

  it("and it is ordered after the two that precede it", () => {
    const at = (n: string) => migrations.indexOf(`"${n}"`);
    expect(at("profile_prev_data")).toBeLessThan(at("drop_profile_prev_data"));
    expect(at("drop_profile_prev_data")).toBeLessThan(at("reading_style_drop_legacy_colours"));
  });
});
