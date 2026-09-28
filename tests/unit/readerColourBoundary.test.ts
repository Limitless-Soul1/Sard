// WHERE THE READING PALETTE STOPS.
//
// Sard has two palettes at once — the app's and the book's — and for a long time they shared one set
// of variables on `:root`, taking turns writing it. Two faults came out of that, and this file exists
// so neither can come back by accident:
//
//   · THE FLASH. `.page-sheet` read the reader-scoped page colour with the global paper as its
//     fallback, and that colour was set only for a book with its own. An ordinary book therefore fell
//     through to whatever the root held — the LIBRARY's paper — and was corrected a beat later.
//     Measured on the running build at 182ms of the wrong colour, on every cold open.
//   · THE BLEED. Correcting it meant writing the READING palette to the root, where twenty rules use
//     the global paper as the INK that contrasts with the accent. The book's paper became the colour
//     of the label on the highlight button.
//
// The boundary that ends both: `applyTheme` owns the document root and speaks only for the app; the
// book's palette reaches the page through variables scoped to the reader; the Reader writes nothing
// global at all. These are structural facts about the source, so they are read as files — the same
// way this repo's other architectural guards are written.
//
// Comments are stripped before every assertion. A guard that can be satisfied by the prose next to
// the code is not a guard, and this suite has been fooled that way before.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

/** source with every comment removed, so an assertion can only match real code */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^(.*?)\/\/.*$/gm, (line, code: string) => (line.trim().startsWith("//") ? "" : code));

const READER = strip(read("src/features/reader/Reader.tsx"));
const CSS = strip(read("src/styles/global.css"));
const APPLY = strip(read("src/theme/applyTheme.ts"));

/** the css rules, as selector/body pairs, comments already gone */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] }))
  .filter((r) => r.sel && !r.sel.startsWith("@"));

const rulesUsing = (token: string) => RULES.filter((r) => r.body.includes("var(" + token));

describe("the Reader writes nothing to the global palette", () => {
  it("it does not even import the function that would", () => {
    // One writer of the document root, called by the app/profile layer. A Reader that cannot name
    // that function cannot re-open this hole in a later edit.
    expect(READER).not.toMatch(/import\s*\{[^}]*\bapplyTheme\b[^}]*\}\s*from\s*"\.\.\/\.\.\/theme"/);
  });

  it("every theme call it makes goes into the book document, not the page", () => {
    // The engine's is a different function reached through the controller: it styles the iframe the
    // book is rendered in. Those are the calls that must survive.
    expect([...READER.matchAll(/(^|[^\w.])applyTheme\s*\(/gm)]).toHaveLength(0);
    expect(READER).toMatch(/ctrlRef\.current\?\.applyTheme\(/);
  });

  it("and nothing survives to put a stale palette back on the way out", () => {
    // The exit restore existed only because the Reader used to overwrite the root. It captured the
    // library theme when the book OPENED, so switching profiles mid-book and going back handed the
    // Library its previous profile's colours.
    expect(READER).not.toContain("libraryThemeRef");
  });
});

describe("the book's palette reaches the page through reader-scoped variables", () => {
  it("the page colour is always named, never inherited", () => {
    // The whole of the flash fix: with the variable always set there is nothing to fall through to,
    // so the first frame is already right.
    expect(READER).toMatch(/"--reader-page":\s*readingTheme\.colors\.paperBg/);
  });

  it("it comes from the هيئة's palette, and from nothing above it", () => {
    // MEASURED DEFECT: `style.pageColor` was a SHARED session override read ahead of the palette, so
    // a colour chosen while reading one book painted every other, survived the Discard that claimed
    // to undo it, and belonged to no هيئة. One owner now — the palette the هيئة already carried.
    const line = /"--reader-page":\s*([^,\n]+)/.exec(READER)?.[1] ?? "";
    expect(line).toContain("readingTheme.colors.paperBg");
    expect(line).not.toContain("style?.pageColor");
    expect(line).not.toContain("??");
  });

  it("the desk is named too, with an overlay colour overriding it", () => {
    // The desk paints the reader-scoped colour with the global app surface as its fallback. That
    // fallback used to land on the reading palette only because the reading palette was on the root.
    expect(READER).toMatch(/"--reader-bg":\s*overlayPaint\.tint \?\? readingTheme\.colors\.surfaceBg/);
  });

  it("both variables are set on the reader root and nowhere higher", () => {
    expect(READER).toMatch(/className=\{`reader-root/);
    expect(READER).toMatch(/style=\{rootVars\}/);
  });

  it("the book's darkness and the book's theme are carried as reader attributes", () => {
    expect(READER).toMatch(/data-book-dark=\{String\(readingTheme\.dark\)\}/);
    expect(READER).toMatch(/data-book-theme=\{readingTheme\.id\}/);
  });
});

describe("the page-side stylesheet asks the book, not the app", () => {
  it("the page surface reads the reader-scoped colour", () => {
    const sheet = RULES.filter((r) => /(^|[\s,>])\.page-sheet\b/.test(r.sel) && /background/.test(r.body));
    expect(sheet.length).toBeGreaterThan(0);
    // A rule that paints NO colour reads neither palette, so it cannot cross the boundary — the PDF
    // "Around the page: None" state is the one such rule. Anything that paints a colour must still ask
    // the book.
    const paintsNothing = (body: string) => /background:\s*transparent\s*;/.test(body) && !/var\(--/.test(body);
    for (const r of sheet) if (!paintsNothing(r.body)) expect(r.body).toContain("var(--reader-page");
  });

  it("no rule painting the page keys on the app's own light-or-dark", () => {
    // The root's darkness is the INTERFACE's polarity and is read by the chrome. The page's inset
    // hairline has to match the paper it is drawn on, which is the book's.
    for (const r of RULES.filter((x) => /\.page-sheet\b/.test(x.sel))) {
      expect(r.sel).not.toMatch(/:root\[[^\]]*data-dark/);
    }
    expect(CSS).toContain('.reader-root[data-book-dark="true"] .page-sheet');
  });

  it("Moonlit's scenery follows the book being read", () => {
    // It is drawn into the desk margins around the page: it belongs to the reading environment, and
    // keyed on the root it would have inverted — appearing when the LIBRARY is Moonlit instead.
    const moonlit = RULES.filter((r) => r.sel.includes("moonlit"));
    const desk = moonlit.filter((r) => r.sel.includes(".reader-desk"));
    expect(desk.length).toBeGreaterThan(0);
    for (const r of desk) {
      expect(r.sel).toContain('[data-book-theme="moonlit"]');
      expect(r.sel).not.toContain(':root[data-theme="moonlit"]');
    }
    // and the same theme's LIBRARY decoration is untouched — it dresses the app, so it keeps asking
    // the app. The pair is the boundary stated twice, from both sides.
    const lib = moonlit.filter((r) => r.sel.includes(".lib-main"));
    expect(lib.length).toBeGreaterThan(0);
    for (const r of lib) expect(r.sel).toContain(':root[data-theme="moonlit"]');
  });
});

// THIS BLOCK CHANGED WHEN THE PRODUCT DID, and the change is recorded rather than quietly made.
//
// It read "the chrome keeps the app's palette, deliberately", and that was right while a هيئة could
// only reach the page. The owner tested a book wearing its own هيئة and reported the result as
// incomplete: the paper was the book's and the interface around it was still the Library's. A هيئة is
// the whole reading experience, so the Reader's own chrome follows it now.
//
// WHAT THE OLD GUARD WAS PROTECTING SURVIVES, AND IS THE POINT OF THE NEW ONE. The defect it named was
// never "the reader chrome changes colour"; it was THE BLEED — RAWY-48/D29 wrote the reading palette
// to `:root`, where the LIBRARY's 409 rules read it too, and the book's paper became the colour of the
// highlight button. Scoping the same tokens to `.reader-root` cannot do that: the two palettes never
// meet, because `:root` is never written by the Reader. That is what is asserted below, and it is a
// stricter statement than the old one — which only checked that the Reader named no tokens at all.
describe("the Reader wears the book's هيئة; the Library keeps its own", () => {
  it("the Reader scopes the palette onto ITSELF, never onto the document root", () => {
    // AND IT IS THE هيئة'S INTERFACE PALETTE, NOT ITS PAGE. A هيئة carries two, and naming the
    // READING one here made the whole interface a function of the paper: `deriveColors` steps
    // `surfaceBg` and `chromeBg` away FROM `paperBg` and floors `muted` between paper and ink, so a
    // هيئة with a pale page washed out the toolbar, the drawers and the contents list with it. The
    // owner reported that as a regression against the previous release.
    //
    // The request this block was originally written for is untouched: the Reader still wears the
    // هيئة the book is read in, so a book wearing هيئة B is not drawn inside هيئة A's interface.
    // B's INTERFACE palette dresses the interface and B's READING palette dresses the page, which is
    // what having two palettes is for.
    expect(READER).toContain("const chromeTheme = uiProfile ? profileTheme(uiProfile) : null;");
    expect(READER).toContain("...(chromeTheme ? themeVars(chromeTheme) : {})");
    expect(READER).not.toContain("...themeVars(readingTheme)");
    // The page and its desk still come from the READING palette, named right here — so the fix moved
    // the interface off the paper without moving the paper.
    expect(READER).toContain('"--reader-page": readingTheme.colors.paperBg');
    expect(READER).toContain("readingTheme.colors.surfaceBg");
    // `rootVars` is applied to `.reader-root` (see the `style={rootVars}` on it), and the Reader still
    // writes nothing to `:root` — the one fact that keeps the Library out of it.
    expect(READER).toMatch(/className=\{`reader-root/);
    expect(READER).toMatch(/style=\{rootVars\}/);
    expect(READER).not.toContain("document.documentElement.style");
    // The engine's `ctrl.applyTheme` styles the book's own iframe and must survive; a BARE one would
    // be the root writer coming back. Same test the block at the top of this file makes.
    expect([...READER.matchAll(/(^|[^\w.])applyTheme\s*\(/gm)]).toHaveLength(0);
  });

  it("derives those tokens from the SAME function the document root uses", () => {
    // One derivation: the muted floor and both marker registers are computed once, so the two surfaces
    // cannot drift into disagreeing about what a theme means.
    expect(APPLY).toContain("export function themeVars(theme: Theme)");
    expect(APPLY).toMatch(/for \(const \[k, v\] of Object\.entries\(themeVars\(theme\)\)\) set\(k, v\);/);
  });

  it("the paper is still what the chrome inks against the accent — now the READING paper", () => {
    // Unchanged CSS, re-pointed source. If this ever falls to zero the token has been renamed and the
    // pairing the هيئة's author chose — their reading paper against their reading accent — has been lost.
    const ink = RULES.filter(
      (r) => /\.rc-|\.rs-|\.hl-|\.tts|\.ref-/.test(r.sel) && /(^|[;\s])color\s*:[^;]*var\(--paper-bg/.test(r.body),
    );
    expect(ink.length).toBeGreaterThan(5);
  });

  it("and the theme writer still puts every token on the document root for the Library", () => {
    expect(APPLY).toMatch(/document\.documentElement/);
    for (const token of ["--app-bg", "--paper-bg", "--chrome-bg", "--text", "--accent"]) {
      expect(APPLY).toContain('"' + token + '":');
    }
    // Vista is drawn only by the Library, so its furniture stays on the root and is NOT scoped.
    expect(APPLY).toContain("applyVistaTokens(set, theme)");
    expect(READER).not.toContain("applyVistaTokens");
  });
});

describe("nothing outside the Reader depends on the reader-scoped variables", () => {
  it("only reader-side rules read them", () => {
    for (const token of ["--reader-page", "--reader-bg"]) {
      const users = rulesUsing(token);
      expect(users.length).toBeGreaterThan(0);
      for (const r of users) expect(r.sel).toMatch(/\.reader|\.page-sheet|\.rs-/);
    }
  });
});

describe("no page ever wears a colour that belongs to something else", () => {
  // THE INVARIANT, in the order it resolves:
  //   a per-book override  ->  the active profile's reading paper  ->  nothing else, ever.
  // What broke it was not the resolution but the STATE it read: a store that kept the previous
  // book's answer, and a global row no profile could reach.

  it("the reading session ends in the store, not only on screen", () => {
    // `useReader` is a module-level singleton. Leaving `status` and `style` standing after a book
    // closed is what let the previous book's page colour paint the next one, and what let a stale
    // "ready" carry the profile-switch effect past its own guard on a fresh mount.
    expect(READER).toMatch(/useReader\.getState\(\)\.set\(\{\s*status:\s*"idle",\s*style:\s*null\s*\}\)/);
  });

  it("this book's colour is published before the engine is asked to open it", () => {
    // Both halves of `--reader-page` were written only after `await ctrl.open(...)`, and the sheet is
    // mounted and painted throughout that wait. Neither value becomes knowable at the open: both are
    // resolved from this book's override and this book's theme well before it.
    const publish = READER.indexOf("set({ style: initialStyle });");
    const theme = READER.indexOf("setBookThemeId(effTheme);");
    const open = READER.indexOf("await ctrl.open(");
    expect(publish).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    expect(publish).toBeLessThan(open);
    expect(theme).toBeLessThan(open);
  });

  it("and the value it publishes is the reading style itself", () => {
    // It used to be `effectiveStyle(global, override)` — the global row with THIS book's partial
    // override on top — and the point of the assertion was that the resolution happened BEFORE the
    // page was published, not after. That point is unchanged and is what this pins.
    //
    // WHAT THE LINE SAYS NOW, and why it is not the old shape returning. A book may name a هيئة, and a
    // هيئة is ONE OBJECT: `resolveAppearanceStyle(own, …)` reads that object, so the alternative to
    // the global row is a COMPLETE appearance, never the global row with per-book fields laid over it.
    // The two are distinguishable in the source and the difference is the whole of the boundary: one
    // has a second owner for every field, the other has no second owner for any field.
    expect(READER).toMatch(/let initialStyle = own \? resolveAppearanceStyle\(own, [^)]*\) : global;/);
    // ...and nothing merges the two. A `{ ...global, ...something }` here would be the deleted model.
    expect(READER).not.toMatch(/initialStyle = \{ \.\.\.global/);
  });

  it("the page colour resolves from the هيئة alone — one source, no fallback behind it", () => {
    const line = /"--reader-page":\s*([^,\n]+)/.exec(READER)?.[1] ?? "";
    expect(line.trim()).toBe("readingTheme.colors.paperBg");
  });
});

describe("one reading style, and the book-style scope is gone", () => {
  // WHAT THIS REPLACES. Sard carried two levels — a global `reading_style` row and a partial
  // `book_style:<id>` override — with a `style_scope` setting choosing whether the second applied.
  // Two levels meant two owners of the same fields, and the reader could see it: a book that had once
  // been tuned kept its own face, paper and read-aloud colours whatever هيئة was worn. Measured on
  // a real library, two books held their own tracking colours and neither followed a هيئة.
  //
  // A هيئة is the complete reading appearance now, so there is exactly one row. These are structural
  // facts about the source, read as files like every other guard in this suite.
  const PERBOOK = strip(read("src/features/reader/perBookSettings.ts"));
  const PANEL = strip(read("src/features/reader/SettingsPanel.tsx"));
  const SETTINGS_UI = strip(read("src/features/reader/ReadingSettings.tsx"));
  const GLOBAL_UI = strip(read("src/features/settings/GlobalSettings.tsx"));

  it("the scope store no longer exists", () => {
    expect(existsSync(join(R, "src/lib/styleScope.ts"))).toBe(false);
  });

  it("nothing in the app reads or writes a scope", () => {
    for (const [name, src] of [["Reader", READER], ["panel", PANEL],
      ["reading settings", SETTINGS_UI], ["global settings", GLOBAL_UI]] as const) {
      expect(src, name).not.toContain("useStyleScope");
      expect(src, name).not.toContain("style_scope");
    }
  });

  it("and the per-book override has no resolver, loader or writer left", () => {
    // The functions are gone, not merely unused: a dead resolver is a second level waiting to be
    // called again.
    for (const fn of ["effectiveStyle", "loadBookOverride", "saveBookOverride",
      "clearBookOverride", "hasOverride", "book_style:"]) {
      expect(PERBOOK, fn).not.toContain(fn);
    }
    expect(PERBOOK).toContain("export async function loadGlobalStyle");
    expect(PERBOOK).toContain("export function saveGlobalStyle");
  });

  // THIS ASSERTION CHANGED WHEN THE PRODUCT DID, and the change is recorded rather than quietly made.
  //
  // It read "from the global row ALONE", and that was the right guard while a هيئة was the only thing
  // that could answer for a book. The owner has since decided that a book may wear a هيئة of its OWN —
  // complete, not a colour out of it — so "alone" is no longer the rule and asserting it would block a
  // decision rather than protect one.
  //
  // WHAT THE GUARD IS FOR SURVIVES INTACT, AND IS NOW STRICTER. The defect it was written against was
  // never "a book can look different"; it was TWO OWNERS FOR ONE FIELD — a partial `ReadingStyle`
  // accumulated per book and merged over the global row, so a book that had once been tuned kept its
  // own faces whatever هيئة was worn. The replacement stores ONE IDENTIFIER and owns no field, so the
  // test below asserts exactly that: the row holds an appearance id, and no per-book FIELD exists
  // anywhere. A future `book_zoom:` or `book_font:` fails here, which the old wording never checked.
  it("the reader resolves its style from one owner — a هيئة, or the global row", () => {
    expect(READER).toContain("const global = await loadGlobalStyle(target.dir ?? undefined);");
    expect(READER).not.toContain("overrideRef");
    // The per-book row is an IDENTIFIER, and the only one.
    expect(READER).toContain("settingsSet(bookAppearanceKey(book), id ?? BOOK_APPEARANCE_NONE)");
    expect(READER).toContain("bookAppearanceKey(");
    // And no per-book FIELD storage, in any spelling, anywhere in the reader or the settings module.
    for (const dead of ["book_style:", "book_font", "book_zoom", "book_lineHeight", "book_pageWidth",
      "book_margin", "book_align", "book_letterSpacing", "book_weight"]) {
      expect(READER, dead).not.toContain(dead);
      expect(PERBOOK, dead).not.toContain(dead);
    }
  });

  it("every reading change is saved to that one row — and as the AUTHORED row, not the resolved one", () => {
    // The rule this protects is that there is ONE reading row and no per-book scope. That still
    // holds; what changed is WHAT is written to it.
    expect(READER).toContain("saveGlobalRow(globalRowRef.current);");
    // MEASURED DEFECT: it used to write `useReader.getState().style` — the RESOLVED style, every
    // field filled in from the per-script baseline. One page-colour pick in an Arabic book therefore
    // persisted `align: "start"`, and every Latin book that followed the global was set `start`
    // instead of `justify`, permanently. The resolved style must never reach the row.
    expect(READER).not.toContain("saveGlobalStyle(useReader.getState().style!);");
    expect(READER).not.toContain("saveGlobalStyle(globalStyleRef.current)");
  });

  it("EXISTING ROWS ARE PRESERVED — nothing deletes a stored override", () => {
    // "Ignore, never delete" is the rule the shared model always followed. A reader who once tuned a
    // book keeps that row on disk; it is simply never consulted.
    for (const src of [READER, PERBOOK]) {
      expect(src).not.toContain("clearBookOverride");
      expect(src).not.toContain('settingsSet(bookKey');
    }
  });

  it("no scope copy survives in either locale", () => {
    for (const dict of [en, ar] as Record<string, string>[]) {
      for (const k of ["gs.scope", "gs.scope.unified", "gs.scope.perbook", "scope.allBooks",
        "scope.thisBook", "perbook.appliesTo", "perbook.reset", "settings.allbooksSub"]) {
        expect(dict[k], k).toBeUndefined();
      }
    }
  });
});

describe("«أنماط الكتب» is gone, not emptied", () => {
  // It was the settings home of the book-style scope. With one reading style owned by a هيئة it had
  // nothing left to say — it had already been reduced to a banner pointing at the reader — and a
  // settings row that opens a signpost is worse than no row.
  const GS = strip(read("src/features/settings/GlobalSettings.tsx"));

  it("the navigation no longer registers it", () => {
    expect(GS).not.toContain('label: "gs.nav.reading"');
    expect(GS).not.toContain('"reading"');
  });

  it("its component is deleted, not left unmounted", () => {
    expect(GS).not.toContain("ReadingDefaultsSection");
  });

  it("and every one of its strings is gone from BOTH locales", () => {
    for (const dict of [en, ar] as unknown as Record<string, string>[]) {
      for (const k of ["gs.nav.reading", "gs.reading", "gs.readingBanner",
        "gs.reading.inReader", "gs.reading.fontsHint"]) {
        expect(dict[k], k).toBeUndefined();
      }
    }
  });

  it("the sections that remain are untouched", () => {
    // The removal must take one row and nothing else with it.
    const E = en as unknown as Record<string, string>;
    const A = ar as unknown as Record<string, string>;
    for (const k of ["gs.nav.appearance", "gs.nav.profiles", "gs.nav.fonts", "gs.nav.bookmark",
      "gs.nav.language", "gs.nav.presence", "gs.nav.about"]) {
      expect(E[k], k).toBeTruthy();
      expect(A[k], k).toBeTruthy();
    }
  });
});
