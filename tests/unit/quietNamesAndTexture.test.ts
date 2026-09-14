// QUIET NAMES + THE TEXTURE PLATE — the invariants neither type nor lint can see.
//
// Both features are mostly CSS and JSX, so these read the sources as FILES the way
// `readerNavGuard`/`paginatorTurnLock` do. The behaviour itself is proven against the running app by
// a private test-harness probe; what is defended here is the set of decisions a
// plausible-looking edit would silently undo.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";
import { LOWEST_SURFACE, surfaceAlpha } from "../../src/lib/texture";
import { THEMES } from "../../src/theme/themes";
import {
  deriveColors, reliefOf, reliefRoom, toRgb, withPanelRelief, RELIEF_MAX, RELIEF_STEP,
} from "../../src/features/profiles/model/palette";
import {
  libraryColors, parseProfileData, profileReadingTheme, profileTheme, readingThemeId,
} from "../../src/features/profiles/model/profile";
import {
  atDensity, DENSITY_MAX, DENSITY_MIN, DENSITY_STEP,
} from "../../src/features/library/design/model";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const TILE = read("src/features/library/design/BookTile.tsx");
const LIBD = read("src/features/library/design/LibraryDesign.tsx");
const LIB = read("src/features/library/Library.tsx");
const CHROME = read("src/features/library/design/Chrome.tsx");
const CSS_LIBD = read("src/styles/library-design.css");
const CSS_GLOBAL = read("src/styles/global.css");
const EDITOR = read("src/features/profiles/ProfileEditor.tsx");
const CSS_PF = read("src/styles/profiles.css");
const SECTION = EDITOR.slice(EDITOR.indexOf("function TextureSection"), EDITOR.indexOf("function TextureSection") + 6000);

describe("quiet names · the preference", () => {
  it("is stored as a normal libd_* Library preference", () => {
    // Not a parallel system: the same settings key shape, the same load, the same guarded save.
    expect(LIBD).toContain('settingsGet("libd_hide_titles")');
    expect(LIBD).toContain('settingsSet("libd_hide_titles"');
  });

  it("is saved only after the stored preferences have loaded", () => {
    // Every other libd_* save is gated this way. Without it the first render would overwrite the
    // reader's stored choice with the component's default.
    const at = LIBD.indexOf('settingsSet("libd_hide_titles"');
    expect(at).toBeGreaterThan(-1);
    expect(LIBD.slice(Math.max(0, at - 200), at)).toContain("prefsLoaded.current");
  });

  it("defaults to off, so a reader who never touches it sees no change", () => {
    expect(LIBD).toContain("const [hideTitles, setHideTitles] = useState(false)");
  });
});

describe("quiet names · which views honour it", () => {
  it("the control is offered in the three cover-led views only", () => {
    const at = CHROME.indexOf('props.view === "grid" || props.view === "covers"');
    expect(at, "the guarded control").toBeGreaterThan(-1);
    const near = CHROME.slice(at, at + 120);
    expect(near).toContain('"vista"');
  });

  it("Spines and Details are not among them", () => {
    // Spines writes the title onto the spine — the words are the artwork there. Details lists it in
    // a column under its own heading. Hiding either empties the view rather than quieting it.
    const at = CHROME.indexOf('props.view === "grid" || props.view === "covers"');
    const guard = CHROME.slice(at, at + 120);
    expect(guard).not.toContain('"spines"');
    expect(guard).not.toContain('"details"');
  });

  it("BookTile drives the existing caption mechanism rather than a second one", () => {
    // `capAlways` was a hardcoded `true`; it is the seam the design already had, restored.
    expect(TILE).toContain("const capAlways = !props.hideTitles");
    expect(TILE).toContain('capAlways ? "libd-cap libd-cap-always" : "libd-cap"');
  });
});

describe("quiet names · accessibility", () => {
  it("the tile names the book even when the caption is not painted", () => {
    // `.libd-cap` hides with `visibility`, which also removes it from the accessibility tree. The
    // name therefore lives on the tile itself, or a screen reader meets a shelf of unnamed books.
    const at = TILE.indexOf('className="libd-tile"');
    expect(at).toBeGreaterThan(-1);
    const near = TILE.slice(at, at + 900);
    expect(near).toContain("title={title}");
    expect(near).toContain("aria-label={title}");
  });

  it("the grid card keeps its own accessible name", () => {
    const at = LIB.indexOf("data-hidecap=");
    expect(at).toBeGreaterThan(-1);
    expect(LIB.slice(Math.max(0, at - 400), at)).toContain("title={title}");
  });

  it("keyboard focus reveals the caption in BOTH caption systems", () => {
    // `:focus-within` is the keyboard's half of `:hover`, and it was missing from the design
    // surface entirely — with names hidden, a reader tabbing the shelf would see nothing at all.
    expect(CSS_LIBD).toContain(".libd-tile:focus-within .libd-cap");
    expect(CSS_GLOBAL).toContain('.lib-card[data-hidecap="1"]:focus-within .lib-cap');
  });

  it("hover and selection reveal it too, in both", () => {
    expect(CSS_LIBD).toContain(".libd-tile:hover .libd-cap");
    expect(CSS_LIBD).toContain('.libd-tile[data-selected="1"] .libd-cap');
    expect(CSS_GLOBAL).toContain('.lib-card[data-hidecap="1"]:hover .lib-cap');
    expect(CSS_GLOBAL).toContain('.lib-card[data-hidecap="1"][data-selected="1"] .lib-cap');
  });

  it("hiding uses visibility, never display or unmounting, so nothing shifts", () => {
    // The caption keeps its reserved space; only its paint changes. Running a pointer along a shelf
    // must not move the shelf under the reader.
    const at = CSS_GLOBAL.indexOf('.lib-card[data-hidecap="1"] .lib-cap');
    const rule = CSS_GLOBAL.slice(at, at + 220);
    expect(rule).toContain("visibility: hidden");
    expect(rule).not.toContain("display: none");
  });
});

describe("quiet names · copy", () => {
  it("both locales carry the label and the hint", () => {
    for (const L of [ar, en]) {
      expect(L["lib.titles.quiet"]).toBeTruthy();
      expect(L["lib.titles.hint"]).toBeTruthy();
    }
  });

  it("the hint names the three formats it applies to", () => {
    // A reader standing in Spines or Details should not hunt for a control that is deliberately
    // absent there.
    expect(en["lib.titles.hint"]).toContain("Grid");
    expect(en["lib.titles.hint"]).toContain("Covers");
    expect(en["lib.titles.hint"]).toContain("Vista");
  });
});

describe("texture · the three-step enum stays the source of truth", () => {
  it("no percentage, opacity, density or scale control was introduced", () => {
    // The invariant `texture.ts` states: a profile stores a STEP, never a number, because the
    // rendered alpha depends on the live scrim and must never travel with the profile.
    expect(SECTION).not.toMatch(/type="range"/);
    expect(SECTION).not.toContain("d.textureAlpha");
    expect(SECTION).not.toContain("d.textureOpacity");
    expect(SECTION).not.toContain("d.textureScale");
    expect(SECTION).toContain("d.texture = s");
  });

  it("the steps still come from TEXTURE_STEPS", () => {
    expect(SECTION).toContain("TEXTURE_STEPS.map");
  });
});

describe("texture · the preview tells the truth", () => {
  it("swatches render at the CLAMPED alpha, from the same function the app uses", () => {
    // They were painted at a hardcoded 85% / 70%, which is not what the application paints.
    expect(SECTION).toContain("surfaceAlpha(");
    expect(SECTION).toContain("minChromeAlpha(worstDeskScrim()");
    expect(CSS_PF).toContain("var(--sw-a");
    expect(CSS_PF).not.toContain('.pf-texture-swatch[data-step="glass"]::after { background: color-mix(in srgb, var(--chrome-bg) 70%');
  });

  it("the swatch row is never frosted, so its stripe keeps meaning what it says", () => {
    // The stripe under a swatch is what shows THROUGH, so it must GROW as the panel thins. Adding
    // the app's frost here made it shrink instead: measured at 4x, the 71% glass swatch came out
    // perfectly flat (spread 0.00) while the 90% opaque one was the only striped tile in the row
    // (spread 1.96) — a 40px blur erases a 10px hatch on a 26px swatch. The row read backwards.
    // Frost is legible on the plate, which has a photograph to blur; it is not legible at 26px.
    const at = CSS_PF.indexOf(".pf-texture-swatch::after {", CSS_PF.indexOf("EACH SWATCH AT ITS OWN REAL ALPHA"));
    expect(at).toBeGreaterThan(-1);
    const rule = CSS_PF.slice(at, CSS_PF.indexOf("}", at));
    expect(rule).toContain("var(--sw-a");
    expect(rule).not.toContain("backdrop-filter");
    // and the editor must not go on handing down values nothing reads
    expect(SECTION).not.toContain('"--sw-frost"');
  });

  it("the plate carries the application's own surface formula", () => {
    // `.pf-lib-side` documents why: a preview that computes its own answer is not a preview.
    const at = CSS_PF.indexOf(".pf-texture-plate-panel {");
    expect(at).toBeGreaterThan(-1);
    const rule = CSS_PF.slice(at, at + 800);
    for (const v of ["--ui-floor", "--ui-base", "--ui-k", "--ui-frost", "--ui-sat", "--ui-bright"]) {
      expect(rule, v).toContain(v);
    }
  });

  it("the plate sits over the reader's own background when there is one", () => {
    expect(SECTION).toContain("pf-lib-bg");
    expect(SECTION).toContain("pf-lib-scrim");
  });
});

describe("texture · the clamp explains itself, but only when it bites", () => {
  it("the note is conditional on the two steps actually converging", () => {
    expect(SECTION).toContain("const converged =");
    expect(SECTION).toContain('alphaOf("light")');
    expect(SECTION).toContain('alphaOf("glass")');
    expect(SECTION).toContain("{converged && (");
  });

  it("both locales carry the plate's words and the convergence note", () => {
    for (const L of [ar, en]) {
      expect(L["profiles.texture.plateTitle"]).toBeTruthy();
      expect(L["profiles.texture.plateBody"]).toBeTruthy();
      expect(L["profiles.texture.plateFoot"]).toBeTruthy();
      expect(L["profiles.texture.converged"]).toBeTruthy();
    }
  });

  it("the note explains rather than blames the control", () => {
    // It must read as the design tool describing itself, not as an error message.
    const s = en["profiles.texture.converged"].toLowerCase();
    expect(s).not.toContain("error");
    expect(s).not.toContain("failed");
    expect(s).toContain("legibility");
  });
});

describe("texture · the convergence condition itself", () => {
  // The live probe watched all three steps and the note stayed hidden every time, which is the
  // RIGHT answer for that theme (90% / 77% / 71% — plainly three different surfaces) but proves
  // only half a conditional. The other half is proved here, against the same function the editor
  // calls, so "appears only when it applies" is not a claim that has never been tested one way.
  const converged = (floor: number) =>
    Math.abs(surfaceAlpha("light", LOWEST_SURFACE, floor) - surfaceAlpha("glass", LOWEST_SURFACE, floor)) < 0.005;

  it("stays quiet while the steps are genuinely distinct", () => {
    // A floor well below the surface's own alpha leaves the full range to travel.
    expect(surfaceAlpha("light", LOWEST_SURFACE, 0.3)).not.toBeCloseTo(
      surfaceAlpha("glass", LOWEST_SURFACE, 0.3), 3);
    expect(converged(0.3)).toBe(false);
  });

  it("speaks up once the legibility floor has closed the gap", () => {
    // A floor at or above the surface's own alpha collapses every step onto that one value: the
    // control still offers three choices and the theme can only paint one. That is exactly the
    // moment the reader needs telling, and it is not a fault in either.
    expect(converged(LOWEST_SURFACE)).toBe(true);
    expect(converged(0.99)).toBe(true);
    expect(surfaceAlpha("light", LOWEST_SURFACE, 0.99)).toBeCloseTo(LOWEST_SURFACE, 5);
  });
});

describe("keyboard · a book is reachable in the cover-led formats", () => {
  const PICKUP = read("src/features/library/design/bookPickup.ts");

  it("EVERY tile is a tab stop — Covers, Vista and Spines alike (F-12)", () => {
    // Spines was excluded at first because it draws no caption, so «إخفاء الأسماء» never reaches
    // it. But "no caption" was never a reason a book should be unreachable: a keyboard reader in
    // Spines could not get to one at all. One unconditional tab stop, one shared handler.
    expect(TILE).toContain("tabIndex={0}");
    expect(TILE).toContain("onKeyDown={pickup.onKeyDown}");
    expect(TILE).not.toContain("tabIndex={spines ?");
    expect(TILE).not.toContain("onKeyDown={spines ?");
  });

  it("keyboard activation lives in the gesture hook, beside the click it mirrors", () => {
    // One definition of what a press MEANS — nothing under arrange, toggle under select, otherwise
    // open. Written a second time in the component it would drift, silently.
    expect(PICKUP).toContain("const onKeyDown = useCallback");
    const at = PICKUP.indexOf("const onKeyDown = useCallback");
    const body = PICKUP.slice(at, PICKUP.indexOf("}, [h]);", at));
    expect(body).toContain("h.arrangeOn");
    expect(body).toContain("h.onToggleSelect");
    expect(body).toContain("h.onOpen()");
    expect(PICKUP).toContain("onKeyDown, cursor };");
  });

  it("a press that began on the ⋯ or its menu is not answered by the tile", () => {
    // Enter on a menu item bubbles out through the tile on its way. Answering it there would open
    // the book standing behind the menu — the Priority 6 defect, arriving from the other side.
    const at = PICKUP.indexOf("const onKeyDown = useCallback");
    expect(PICKUP.slice(at, at + 900)).toContain("e.target !== e.currentTarget");
  });

  it("no role=button on the tile, which would prune the ⋯ from assistive tech", () => {
    // ARIA makes a button's children PRESENTATIONAL. Copying Grid's role here would spend the
    // keyboard fix on one control and break another — the ⋯ must stay reachable.
    const at = TILE.indexOf('className="libd-tile"');
    expect(TILE.slice(at - 400, at + 1600)).not.toContain('role="button"');
  });

  it("focus reveals the actions control, using focus-within rather than a visible-only rule", () => {
    // `visibility: hidden` keeps the ⋯ out of the tab order, so nothing reveals it means nothing
    // can reach it. `:focus-within` and not `:has(:focus-visible)`: Escape restores focus to the ⋯
    // programmatically, and whether that counts as focus-visible is a browser heuristic — if it did
    // not, the control would vanish while still holding focus.
    expect(CSS_LIBD).toContain(".libd-tile:focus-within .libd-dots");
    expect(CSS_LIBD).not.toContain(".libd-tile:has(:focus-visible) .libd-dots");
  });

  it("the focus ring is the design's own, drawn on the jacket like Grid's", () => {
    const at = CSS_LIBD.indexOf(".libd-tile:focus-visible .libd-tile-cover");
    expect(at).toBeGreaterThan(-1);
    const rule = CSS_LIBD.slice(at, CSS_LIBD.indexOf("}", at));
    expect(rule).toContain("outline: 2px solid var(--acc)");
    expect(rule).toContain("outline-offset: 2px");
    // an outline takes no layout, so nothing shifts when it appears
    expect(rule).not.toContain("border");
    expect(rule).not.toContain("margin");
    // and the jacket must carry the class the rule hangs on
    expect(TILE).toContain('className="libd-tile-cover"');
  });
});

describe("quiet names · the hint tells the truth about where it applies", () => {
  it("the views the hint names are exactly the views the control is offered in", () => {
    // Not a restatement of the copy — a cross-check. The gate in `Chrome.tsx` is the authority on
    // where the preference exists; the hint is a promise about it. If someone adds or removes a
    // view from the gate and leaves the sentence alone, this fails.
    const at = CHROME.indexOf('props.view === "grid" || props.view === "covers"');
    const gate = CHROME.slice(at, at + 120);
    const gated = ["grid", "covers", "vista", "spines", "details"].filter((v) => gate.includes(`"${v}"`));
    expect(gated.sort()).toEqual(["covers", "grid", "vista"]);

    const named = { grid: "Grid", covers: "Covers", vista: "Vista", spines: "Spines", details: "Details" };
    const hint = en["lib.titles.hint"];
    const mentioned = Object.entries(named).filter(([, word]) => hint.includes(word)).map(([k]) => k);
    expect(mentioned.sort(), "the hint's list must match the gate's").toEqual(gated.sort());
  });

  it("the hint stays one short sentence", () => {
    // "Without making the setting unnecessarily verbose" — a preference's hint is read in passing,
    // beside the control, and a paragraph there is worse than no hint at all.
    for (const L of [ar, en]) {
      const h = L["lib.titles.hint"];
      expect(h.split(/[.!؟?]/).filter((s) => s.trim()).length, h).toBe(1);
      expect(h.length, h).toBeLessThan(110);
    }
  });

  it("the approved label is exactly as the owner settled it", () => {
    // Settled wording. It says what the control DOES, not what the shelf becomes.
    expect(ar["lib.titles.quiet"]).toBe("إخفاء الأسماء");
    expect(en["lib.titles.quiet"]).toBe("Hide names");
  });
});

describe("F-12 · Spines joins the keyboard, without a model of its own", () => {
  it("Spines uses the SAME handler as the other views, not one of its own", () => {
    // The whole point of the fix: one `pickup.onKeyDown`, unconditional. A Spines-only branch here
    // would be the parallel interaction model the brief forbade.
    const at = TILE.indexOf('className="libd-tile"');
    const root = TILE.slice(at, TILE.indexOf("{showDots &&", at));
    expect(root).toContain("onKeyDown={pickup.onKeyDown}");
    expect(root).not.toMatch(/onKeyDown=\{spines/);
    // and still no ARIA interaction model, for the same reason as before: role=button would prune
    // the ⋯ — which in Spines hangs OUTSIDE the tile — out of the accessibility tree.
    //
    // ASSERTED AGAINST CODE, NOT PROSE. The element's own comment explains why the role is absent
    // and therefore contains the very string being searched for; a naive `toContain` matched the
    // explanation and failed. Comments are stripped first, which is the same trap this file's
    // `preventDefault` check was caught by once already.
    const code = root.split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join(String.fromCharCode(10));
    expect(code).not.toContain('role="button"');
    expect(code).toContain("tabIndex={0}");
  });

  it("the focus ring and the ⋯ reveal are not scoped away from Spines", () => {
    // Both rules are written against `.libd-tile` with no `:not([data-spine])`, so Spines gets the
    // same ring and the same reveal as Covers and Vista rather than a second set of rules.
    for (const sel of [".libd-tile:focus-within .libd-dots", ".libd-tile:focus-visible .libd-tile-cover"]) {
      const at = CSS_LIBD.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
    }
    expect(CSS_LIBD).not.toContain('.libd-tile:not([data-spine="1"]):focus-visible');
  });

  it("Spines still renders its own way — the fix touched no spine geometry", () => {
    // "Do not change how spine titles are rendered, positioned, rotated, or styled." The branches
    // that decide a spine's shape must all still be there.
    expect(TILE).toContain("const spines = view ===");
    expect(TILE).toContain("const capRendered = !spines");          // still no caption
    expect(TILE).toContain("spines ? spineWidth(book, density)");   // still its own width
    // Still Spines' own height table — now read by `atDensity` so a size between two steps lands
    // between two heights. The table is unchanged; only the lookup is.
    expect(TILE).toContain("atDensity(SPINE_HEIGHTS, density)");               // still its own height
    expect(TILE).toContain('data-spine={spines ? "1" : undefined}');
    // the ⋯ still hangs clear of the narrow tile — RETUNED from -26 to -32 when the control grew
    // to its correct 30px size, so it keeps the same 2px band above the spine rather than cutting
    // 4px into it. The number changed; the intent it encodes did not.
    expect(TILE).toContain("buttonStyle={spines ? { insetBlockStart: -32");
  });

  it("the pointer's hover bridge to the ⋯ is untouched", () => {
    // Spines hangs its ⋯ 26px above the tile; this pseudo-element is what lets a POINTER travel
    // there without crossing dead space and dropping `:hover`. A keyboard does not travel, so the
    // fix needed nothing from it — and must not have taken anything either.
    expect(CSS_LIBD).toContain('.libd-tile[data-spine="1"]:hover::before');
    expect(CSS_LIBD).toContain('.libd-tile[data-spine="1"][data-menu="1"]::before');
  });

  it("selection in Spines is still its own inline outline, unchanged", () => {
    // Measured consequence, recorded so it is not mistaken for a bug later: this outline sits on
    // the SAME element the focus ring targets and, being inline, wins. Focus is therefore not
    // distinguishable on an already-selected spine. Left as-is — where the indicator should go is
    // a design decision about Spines, and selection's own appearance was out of scope.
    expect(TILE).toContain('outline: selected ? "2px solid var(--acc)" : undefined');
    expect(TILE).toContain("outlineOffset: selected ? 2 : undefined");
  });
});

describe("the book actions control sits ON the jacket, not above it", () => {
  const ACTIONS = read("src/features/library/design/BookActions.tsx");
  const CSS_LIBD_TOKENS = read("src/styles/library-design.css");

  it("uses the control step of the elevation scale, not the card step", () => {
    // It carried `--sh2`, which is the JACKET's own elevation — measured, the button's shadow and
    // the Covers cover's shadow resolved to the identical string. Covers hides that by coincidence
    // (chip and jacket on one plane); Vista, whose cover has real thickness, showed it as a 24px
    // chip hovering over the artwork behind its own dark halo.
    const at = ACTIONS.indexOf('background: "var(--dots-bg');
    expect(at).toBeGreaterThan(-1);
    const block = ACTIONS.slice(at, at + 1400);
    expect(block).toContain('boxShadow: "var(--sh1)"');
    expect(block).not.toContain('boxShadow: "var(--sh2)"');
  });

  it("--sh2 is still what a CARD wears, which is why it was wrong here", () => {
    // Guards the premise rather than the fix: if the scale is ever renamed or re-ordered, the
    // reasoning above stops holding and this should be revisited.
    expect(CSS_LIBD_TOKENS).toMatch(/--sh1:\s*0 1px 2px/);
    expect(CSS_LIBD_TOKENS).toMatch(/--sh2:\s*0 3px 10px/);
    // the Covers jacket is the thing that legitimately wears --sh2
    expect(TILE).toContain('borderRadius: 3, boxShadow: "var(--sh2)"');
  });

  it("nothing else about the control moved", () => {
    // Size, ground, border, radius, placement and behaviour are untouched — the fix is one token.
    // SUPERSEDED IN PART. This guarded `--icon-xl` as the box, which was the very defect a later
    // pass fixed: an icon token used as a control's size. Placement, radius and ground are still
    // the things that must not drift, so those stay; the size is now guarded above against
    // `--ctl-md` instead.
    // Bounded by the end of the style object rather than a character count — the comments in it
    // are long, and a fixed window has now fallen short twice, failing on its own slice.
    const at = ACTIONS.indexOf("position: \"absolute\"");
    const block = ACTIONS.slice(at, ACTIONS.indexOf("...props.buttonStyle", at));
    expect(block).toContain("insetBlockStart: 6");
    expect(block).toContain("insetInlineEnd: 6");
    expect(block).toContain('borderRadius: "var(--r-md)"');
    expect(block).toContain('background: "var(--dots-bg, var(--chr))"');
    // and Spines still hangs it clear of its narrow tile, retuned to -32 for the control's true
    // 30px size so the 2px band above the spine survives. (The F-12 block guards this too; the
    // duplicate is kept because this test is about the control and that one is about the keyboard.)
    expect(TILE).toContain("buttonStyle={spines ? { insetBlockStart: -32");
  });
});

describe("the book actions control is one control, not one per surface", () => {
  const ACTIONS = read("src/features/library/design/BookActions.tsx");

  it("is sized by a CONTROL token, not an icon token", () => {
    // It was `--icon-xl` (24px) — an icon size used as the button's box — around a 14px glyph, so
    // it filled 58% where Grid's `.lib-card-edit` leaves 47%. `--ctl-md` is the system's own
    // "DEFAULT" control size, 30px, which is exactly the literal Grid had been using.
    expect(ACTIONS).toContain('width: "var(--ctl-md)"');
    expect(ACTIONS).toContain('height: "var(--ctl-md)"');
    expect(ACTIONS).not.toContain('width: "var(--icon-xl)"');
  });

  it("states its own layout, so it cannot depend on where it is mounted", () => {
    // THE ACTUAL DEFECT. `display/align/justify/padding` came from `.libd-stage button`. Vista does
    // not render into `.libd-stage` — its tiles live in `.v-room > .v-scroll > .v-books` — so the
    // reset never matched there and the ⋯ fell back to a raw platform button: `display: block`,
    // the UA's `padding: 1px 6px`, no centring, glyph measured 4px off-centre.
    for (const decl of ['display: "inline-flex"', 'alignItems: "center"', 'justifyContent: "center"', "padding: 0"]) {
      expect(ACTIONS, decl).toContain(decl);
    }
  });

  it("was NOT fixed by widening the shell's reset, which would break Vista's furniture", () => {
    // `.v-room button` would be (0,1,1) and `.v-piece` is (0,1,0), so the reset would override
    // Vista's own `display: flex; flex-direction: column; justify-content: flex-end`.
    expect(CSS_LIBD).not.toContain(".v-room button");
    expect(CSS_LIBD).toContain(".v-piece {");
  });

  it("keeps an opaque ground, deliberately unlike Grid's", () => {
    // Grid's is 88% translucent; matched here, the format badge an auto-drawn cover paints in this
    // same corner (`.ac-mark`) reads straight through the button. Measured: a stray "S" beside the
    // three dots. Grid has that today; copying it would trade a proportion problem for a
    // legibility one.
    expect(ACTIONS).toContain('background: "var(--dots-bg, var(--chr))"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RECOVERED VERBATIM. The six blocks below are the originals.
//
// Swapping the panel-depth block for the relief one, a string index anchored on
// `describe("the library` matched an earlier block than intended and overwrote everything from
// there to the end of the file. The file is untracked, so git held no copy, and the vitest cache
// keeps only durations. They were recovered from this session's transcript, which records every
// tool input verbatim — so these are the assertions that were actually written, character for
// character, not a rewrite from memory.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the library's empty states are one pattern", () => {
  const LIBD_SRC = read("src/features/library/design/LibraryDesign.tsx");

  it("no empty placeholder box survives", () => {
    // What stood above «لا نتائج» was a bare 52px div with a border and no content — an unfinished
    // mark slot that read as a missing asset.
    expect(LIBD_SRC).not.toContain("width: 52,");
    expect(LIBD_SRC).not.toContain('border: "1.5px solid var(--rule)"');
  });

  it("every state's mark contains something", () => {
    // The hoopoe for the welcome — the one mark here that is an identity — and an icon from the
    // set for the two quiet states, each naming itself.
    const at = LIBD_SRC.indexOf('className="libd-empty-mark"');
    expect(at).toBeGreaterThan(-1);
    const slot = LIBD_SRC.slice(at, at + 260);
    expect(slot).toContain("<Hoopoe");
    expect(slot).toContain("<Icon");
    expect(slot).toContain('"search"');
  });

  it("both states are the same structure at two declared scales", () => {
    for (const c of ["libd-empty-mark", "libd-empty-title", "libd-empty-body", "libd-empty-act"]) {
      expect(LIBD_SRC, c).toContain(c);
    }
    expect(LIBD_SRC).toContain('data-scale={welcome ? "welcome" : "quiet"}');
    for (const sel of ['.libd-empty[data-scale="quiet"]', '.libd-empty[data-scale="welcome"]']) {
      expect(CSS_LIBD, sel).toContain(sel);
    }
  });

  it("it reuses the mark treatment the Inbox's empty state already had", () => {
    // Not a new ornament: the same tinted-icon idea, at the same 64px, so the two empty states in
    // the application read as one family rather than two inventions.
    expect(CSS_LIBD).toContain("color: color-mix(in srgb, var(--acc) 40%, transparent)");
    expect(CSS_LIBD).toContain(".libd-empty-mark svg { width: 64px; height: 64px; }");
    expect(CSS_GLOBAL).toContain(".inbox-empty-mark svg { width: 64px; height: 64px; }");
  });

  it("the search state still says what happened and how to leave it", () => {
    expect(LIBD_SRC).toContain('t("lib.noResults")');
    expect(LIBD_SRC).toContain('t("lib.noResultsBody")');
    expect(LIBD_SRC).toContain('t("lib.clearSearch")');
  });
});

describe("cover size · the density steps became a continuum", () => {
  const MODEL = read("src/features/library/design/model.ts");
  const LIBD_SRC = read("src/features/library/design/LibraryDesign.tsx");
  const LIB_SRC = read("src/features/library/Library.tsx");

  it("the design's four authored widths are still the anchors", () => {
    // Nothing here invents a size the design did not choose. The steps stop being the only places
    // a reader can stand; they do not stop being the design's numbers.
    expect(MODEL).toContain("const DENSITY_WIDTHS = [92, 118, 148, 184]");
    expect(MODEL).toContain("export function atDensity(");
  });

  it("an integer position still returns its authored value exactly", async () => {
    const { atDensity, baseWidth } = await import("../../src/features/library/design/model");
    const T = [92, 118, 148, 184];
    T.forEach((want, i) => expect(atDensity(T, i), `step ${i}`).toBe(want));
    expect(baseWidth(0)).toBe(92);
    expect(baseWidth(3)).toBe(184);
  });

  it("a position between two steps lands between their values", async () => {
    const { atDensity, baseWidth } = await import("../../src/features/library/design/model");
    expect(atDensity([92, 118, 148, 184], 0.5)).toBe(105);
    expect(baseWidth(1.5)).toBe(133);
    // and the spine heights, which are what size MEANS in Spines
    expect(atDensity([104, 132, 168, 208], 1.5)).toBe(150);
  });

  it("it clamps rather than reading off the end of a table", async () => {
    const { atDensity, clampDensity } = await import("../../src/features/library/design/model");
    expect(atDensity([92, 118, 148, 184], -5)).toBe(92);
    expect(atDensity([92, 118, 148, 184], 99)).toBe(184);
    expect(clampDensity(Number.NaN)).toBe(1);
    expect(clampDensity(9)).toBe(3);
  });

  it("no per-step table is read by bare indexing any more", () => {
    // Each of these jumped while everything around it moved smoothly.
    // COMMENTS STRIPPED FIRST. The comment explaining why `SHELF_COL[d]` was wrong contains the
    // very text being searched for — the same trap this file's `preventDefault` and `role="button"`
    // checks were caught by. Assert on code.
    const codeOf = (src: string) =>
      src.split(String.fromCharCode(10))
        .filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
        .join(String.fromCharCode(10));
    for (const src of [read("src/features/library/design/BookTile.tsx"),
                       read("src/features/library/design/ViewGrouped.tsx"),
                       read("src/features/library/design/ViewVista.tsx")]) {
      const code = codeOf(src);
      expect(code).not.toMatch(/SPINE_HEIGHTS\[/);
      expect(code).not.toMatch(/SPINE_LABEL_MAX\[/);
      expect(code).not.toMatch(/SHELF_COL\[/);
    }
  });

  it("stored values need no migration, because 0..3 were always in range", () => {
    // `libd_density` has always held "0".."3". Those are valid positions on the continuum, so a
    // reader's stored choice survives untouched and nothing has to be rewritten on upgrade.
    expect(MODEL).toContain("export const DENSITY_MIN = 0");
    expect(MODEL).toContain("export const DENSITY_MAX = DENSITY_WIDTHS.length - 1");
    expect(LIBD_SRC).toContain('settingsGet("libd_density")');
  });
});

describe("cover size · the control, and the view that never had one", () => {
  const CHROME_SRC = read("src/features/library/design/Chrome.tsx");
  const LIB_SRC = read("src/features/library/Library.tsx");

  it("Grid now offers it; Details still does not", () => {
    // Grid's absence was a WIRING GAP: it never read density, its floor was hardcoded at 148px —
    // `DENSITY_WIDTHS[2]` — and measured, all four steps drew an identical card. Details' absence
    // is a decision: it is a row list, and cover size is not what organises it.
    expect(CHROME_SRC).toContain('{props.view !== "details" && (');
    expect(CHROME_SRC).not.toContain('props.view !== "details" && props.view !== "grid"');
  });

  it("Grid's floor is the reader's, with the old constant as the fallback", () => {
    // A Grid rendered outside the design surface has no size to be given, and must look exactly as
    // it always did.
    expect(CSS_GLOBAL).toContain("minmax(var(--lib-cover-min, 148px), 1fr)");
    expect(LIB_SRC).toContain('"--lib-cover-min"');
  });

  it("it is Sard's own slider, not a second idea of one", () => {
    // `.gs-slider` is `accent-color` over the platform control and nothing more; every range in
    // the profile editor is that. Following it also buys RTL, which a native range does itself.
    expect(CHROME_SRC).toContain('type="range"');
    expect(CHROME_SRC).toContain('className="libd-size"');
    expect(CSS_LIBD).toContain("accent-color: var(--acc)");
    expect(CSS_GLOBAL).toContain("accent-color: var(--accent)");   // the one it follows
  });

  it("it is named and speaks its value, which the four buttons never did", () => {
    // Those had `aria-label={`${i + 1}`}` — a bare ordinal that tells a screen-reader user nothing.
    expect(CHROME_SRC).toContain('aria-label={t("lib.size")}');
    expect(CHROME_SRC).toContain("aria-valuetext=");
    for (const L of [ar, en]) expect(L["lib.size"]).toBeTruthy();
  });

  it("its step is coarse enough for an arrow key to do something", () => {
    // Continuous under a pointer, usable from a keyboard: 0.1 of a step per press, so crossing the
    // range takes thirty presses rather than three hundred.
    expect(read("src/features/library/design/model.ts")).toContain("export const DENSITY_STEP = 0.1");
  });
});

describe("import sheet · the chooser opens once, and every hook always runs", () => {
  const SHEET = read("src/features/profiles/ImportSheet.tsx");
  const code = SHEET.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join(String.fromCharCode(10));

  it("the picker is opened from an effect, never from the render body", () => {
    // It was three statements in the render body — `void pick(); setBusy(true); return null;`. The
    // state update forced a second render which fell THROUGH the early return and reached a hook
    // the first render had skipped. Measured in the app: "React has detected a change in the order
    // of Hooks", the settings surface blank (text length 0), and TWO native "Open" dialogs from one
    // click.
    expect(code).not.toContain("void pick();\n    setBusy(true);");
    const at = code.indexOf("void pick()");
    expect(at, "the picker call").toBeGreaterThan(-1);
    // it must sit inside a useEffect
    const effectAt = code.lastIndexOf("useEffect(", at);
    expect(effectAt).toBeGreaterThan(-1);
    expect(code.slice(effectAt, at)).not.toContain("return (");
  });

  it("no hook is called after a conditional return", () => {
    // `useDialog` was below the early return; `usePackagePictures` above it, with a comment saying
    // exactly why. Both must now be above.
    // SCOPED TO THE COMPONENT. Searching the whole module finds the `return null;` inside the
    // `usePackagePictures` helper at the top of the file, which is not the early return this rule is
    // about — every hook in the component would then read as "after" it. The invariant is about one
    // function, so the window is that function.
    const body = code.slice(code.indexOf("export function ImportSheet"));
    const firstReturn = body.indexOf("return null;");
    expect(firstReturn).toBeGreaterThan(-1);
    const beforeReturn = body.slice(0, firstReturn);
    for (const hook of ["useDialog(", "usePackagePictures(", "useState<Stage>", "useRef("]) {
      expect(beforeReturn, hook).toContain(hook);
    }
  });

  it("a latch keeps StrictMode from opening the chooser twice", () => {
    // StrictMode is on, so React invokes every effect twice in development. Without the ref this
    // would open two choosers again for an entirely different reason.
    expect(code).toContain("asked.current");
    expect(read("src/main.tsx")).toContain("React.StrictMode");
  });

  it("the latch resets when the sheet leaves the picking stage", () => {
    // «اختر ملفًا آخر» sends it back to `picking`, and that must open the chooser once more.
    const at = code.indexOf("asked.current = false");
    expect(at, "the reset").toBeGreaterThan(-1);
    expect(code.indexOf("asked.current = true")).toBeGreaterThan(at);
  });
});

describe("a colour edit changes only what depends on it", () => {
  const EDITOR = read("src/features/profiles/ProfileEditor.tsx");

  it("the follow table matches what deriveColors actually derives", async () => {
    // Not a restatement of the map — a check against the function. Each role is edited in turn and
    // the fields that MOVE must be exactly the ones the table claims follow it.
    const { deriveColors } = await import("../../src/features/profiles/model/palette");
    const { THEMES } = await import("../../src/theme/themes");
    const FOLLOWS: Record<string, string[]> = {
      paperBg: ["paperBg", "surfaceBg", "chromeBg", "muted"],
      text: ["text", "muted", "chromeBorder"],
      accent: ["accent", "selection"],
    };
    // DERIVED vs DERIVED. Comparing the derived result against the AUTHORED palette conflates two
    // different things: `chromeBorder` and `selection` are written in a different FORMAT by the
    // designer (`rgba(43,37,33,.10)`) than by the function (`...,0.12)`), so they read as "moved"
    // for every role. Holding the baseline derived isolates the actual dependency.
    const a = THEMES.ivory.colors;
    const base = deriveColors(a.paperBg, a.text, a.accent, THEMES.ivory.dark);
    for (const [role, hex] of [["paperBg", "#2E5C8A"], ["text", "#E8D44D"], ["accent", "#D2185B"]] as const) {
      const three = { paperBg: a.paperBg, text: a.text, accent: a.accent, [role]: hex };
      const d = deriveColors(three.paperBg, three.text, three.accent, THEMES.ivory.dark);
      const moved = Object.keys(d).filter(
        (k) => JSON.stringify((d as never)[k]) !== JSON.stringify((base as never)[k]),
      );
      expect(moved.sort(), role).toEqual([...FOLLOWS[role]].sort());
    }
  });

  it("commit writes only the followers, never the whole palette", () => {
    // It assigned `deriveColors(...)` wholesale, whichever role had been touched — so the first edit
    // of a SHIPPED paper converted its authored palette into a derived one. Measured on ivory,
    // changing only the accent moved chromeBg #EAE0CA -> #efe8d6 and halved the paper→chrome
    // separation (0.107 -> 0.049); on sepia the panel flipped from lighter than its paper to darker.
    const at = EDITOR.indexOf("const commit = (role:");
    expect(at).toBeGreaterThan(-1);
    // Bounded by what follows `commit`, not by the first `};` — the body contains one.
    const body = EDITOR.slice(at, EDITOR.indexOf("const onType", at));
    expect(body).toContain("for (const k of FOLLOWS[role])");
    expect(body).not.toMatch(/d\.theme\[scope\]\.colors = deriveColors\(/);
    expect(body).toContain("const next = { ...cur }");
  });

  it("the shared highlight inks are in no follow list, so nothing regenerates them", () => {
    const at = EDITOR.indexOf("const FOLLOWS = {");
    const table = EDITOR.slice(at, EDITOR.indexOf("} as const satisfies", at));
    expect(table).not.toContain("highlight");
    for (const k of ["surfaceBg", "chromeBg", "muted", "chromeBorder", "selection"]) {
      expect(table, k).toContain(k);
    }
  });
});

describe("page opacity means one thing in both places", () => {
  const EDITOR = read("src/features/profiles/ProfileEditor.tsx");
  const BG = read("src/lib/background.ts");

  it("the editor previews the RAW value, as the reading surface paints it", () => {
    // It ran the number through `pageComposite` — 1-(1-a)^3 — compensating for a paper that used to
    // be painted three times. That triple paint is gone (invariant I-4: exactly ONE surface paints
    // the paper), so the compensation outlived what it compensated for. Measured at the stored 0.84
    // the reader wrote `--bg-page-opacity: 84.00%` while this preview rendered 0.995904.
    expect(EDITOR).toContain('"--pgo": previewPageOpacity');
    expect(EDITOR).not.toContain("pageComposite(previewPageOpacity)");
  });

  it("the reader still writes the raw value, unchanged by this", () => {
    expect(BG).toContain('r.style.setProperty("--bg-page-opacity", `${(pageOp * 100).toFixed(2)}%`)');
  });

  it("the AAA floor is untouched", () => {
    // 0.84 is a measured floor: below it body text stops clearing 7:1 against the worst image the
    // desk can show. Both surfaces read the same constant.
    expect(BG).toContain("export const PAGE_OPACITY_MIN = 0.84");
    expect(read("src/features/reader/ReadingSettings.tsx")).toContain("Math.round(PAGE_OPACITY_MIN * 100)");
    expect(EDITOR).toContain("min={PAGE_OPACITY_MIN}");
  });
});



// ADDED, NOT RECOVERED. The library/reading palette split never had a block of its own; this was
// written during the recovery and is kept, because the invariant is worth holding.

describe("a profile carries two palettes", () => {
  it("the shape is library and reading, and both parse", () => {
    const d = parseProfileData(JSON.stringify({
      theme: {
        library: { base: "ivory", dark: false, colors: THEMES.ivory.colors },
        reading: { base: "charcoal", dark: true, colors: THEMES.charcoal.colors },
      },
    }));
    expect(d.theme.library.base).toBe("ivory");
    expect(d.theme.reading.base).toBe("charcoal");
    expect(d.theme.library.dark).toBe(false);
    expect(d.theme.reading.dark).toBe(true);
  });

  it("a blob written before the split renders exactly as it did", () => {
    // v1 carried ONE palette. Absence-defaulting hands the same one to both scopes, so nothing
    // about such a profile changes until a reader parts them.
    const d = parseProfileData(JSON.stringify({
      theme: { base: "sepia", dark: false, colors: THEMES.sepia.colors },
    }));
    expect(d.theme.library.colors.paperBg).toBe(THEMES.sepia.colors.paperBg);
    expect(d.theme.reading.colors.paperBg).toBe(THEMES.sepia.colors.paperBg);
    expect(d.theme.library.base).toBe("sepia");
    expect(d.theme.reading.base).toBe("sepia");
  });

  it("the two palettes get two theme ids, and the library keeps its own", () => {
    // The library keeps `p.id` unchanged so every `theme_id` already on disk still resolves.
    expect(readingThemeId("u:abc" as never)).toBe("u:abc~r");
    expect(readingThemeId("u:abc" as never)).not.toBe("u:abc");
  });

  it("editing one surface leaves the other alone", () => {
    const d = parseProfileData(JSON.stringify({
      theme: {
        library: { base: "ivory", dark: false, colors: THEMES.ivory.colors },
        reading: { base: "ivory", dark: false, colors: THEMES.ivory.colors },
      },
    }));
    d.theme.library.colors = { ...d.theme.library.colors, paperBg: "#123456" };
    expect(d.theme.reading.colors.paperBg).toBe(THEMES.ivory.colors.paperBg);
  });
});

describe("the library's panel relief", () => {
  const PALETTE = read("src/features/profiles/model/palette.ts");
  const PROFILE = read("src/features/profiles/model/profile.ts");
  const L = (hex: string) => {
    const [r, g, b] = toRgb(hex).map((v) => v / 255);
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };
  const STEPS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

  it("is measured from the DESK, which is the surface a panel actually touches", () => {
    // The library's stage paints no ground of its own, so the desk is what a panel sits against and
    // no paper-coloured surface meets one anywhere. An earlier version measured from the paper and
    // moved a relationship that is never on screen.
    for (const t of Object.values(THEMES)) {
      const out = withPanelRelief(t.colors, 0);
      expect(Math.abs(L(out.chromeBg) - L(t.colors.surfaceBg)), t.id).toBeLessThan(1 / 255 + 1e-9);
    }
  });

  it("never reverses - the whole track runs one way", () => {
    // THE DEFECT THIS REPLACES. The first version folded when it ran out of room, so -x and +x gave
    // the SAME colour: the slider mirrored itself and four of the sixteen papers did nothing at all
    // from end to end. Walked densely here, because a fold can hide between two coarse samples.
    for (const t of Object.values(THEMES)) {
      const room = reliefRoom(t.colors.surfaceBg);
      let prev = -Infinity;
      for (let i = 0; i <= 60; i++) {
        const r = room.min + ((room.max - room.min) * i) / 60;
        const l = L(withPanelRelief(t.colors, r).chromeBg);
        expect(l, `${t.id} reversed at ${r}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = l;
      }
    }
  });

  it("has no dead travel: both ends of its own track do something", () => {
    // The track is the palette's ROOM, so a slider never carries a stretch that changes nothing.
    // True-Black has very little room downward and that is honest - but it is not zero, and the
    // upward half is full size.
    for (const t of Object.values(THEMES)) {
      const room = reliefRoom(t.colors.surfaceBg);
      const lo = withPanelRelief(t.colors, room.min).chromeBg;
      const hi = withPanelRelief(t.colors, room.max).chromeBg;
      expect(lo, t.id).not.toBe(hi);
      expect(room.max, t.id).toBeGreaterThan(0);
      expect(room.min, t.id).toBeLessThan(0);
    }
  });

  it("lands where it is asked to, within a byte", () => {
    for (const t of Object.values(THEMES)) {
      const room = reliefRoom(t.colors.surfaceBg);
      const deskL = L(t.colors.surfaceBg);
      for (const k of STEPS) {
        const r = k < 0 ? room.min * -k : room.max * k;
        const out = withPanelRelief(t.colors, r);
        expect(Math.abs(L(out.chromeBg) - (deskL + r)), `${t.id} ${r}`).toBeLessThan(1 / 255 + 1e-9);
      }
    }
  });

  it("moves the panel and NOTHING else - the background picture above all", () => {
    // THE STANDING CONSTRAINT. This control may change a panel's colour. It may not veil, dim, tint
    // or scrim the library's background photograph, which is the reader's own choice and has its own
    // settings. Structurally it cannot: it returns a palette, and a palette has no say over the
    // picture. Asserted anyway, because a later edit could reach for one.
    for (const t of Object.values(THEMES)) {
      for (const r of [-RELIEF_MAX, 0, RELIEF_MAX]) {
        const out = withPanelRelief(t.colors, r);
        for (const k of ["paperBg", "surfaceBg", "chromeBorder", "text", "muted", "accent", "selection"] as const) {
          expect(out[k], `${t.id} ${r} ${k}`).toBe(t.colors[k]);
        }
        expect(out.highlight).toBe(t.colors.highlight);
        expect(Object.keys(out).sort()).toEqual(Object.keys(t.colors).sort());
      }
    }
  });

  it("carries no opacity, scrim or blur anywhere in its implementation", () => {
    // CODE ONLY. The prose above the function says out loud that it must not scrim the picture, and
    // an assertion that reads its own explanation proves nothing — the same trap three earlier
    // guards in this file fell into. Comments are stripped before the check.
    const section = PALETTE.slice(PALETTE.indexOf("// ---- panel relief"))
      .split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("//"))
      .join(String.fromCharCode(10)).toLowerCase();
    for (const forbidden of ["opacity", "scrim", "blur", "presence", "backdrop", "rgba("]) {
      expect(section, forbidden).not.toContain(forbidden);
    }
  });

  it("absent means the palette is left alone, so nothing on disk moves", () => {
    for (const [id, t] of Object.entries(THEMES)) {
      const p = parseProfileData(JSON.stringify({ theme: { base: id, dark: t.dark, colors: t.colors } }));
      expect(p.theme.library.relief, id).toBeNull();
      expect(libraryColors(p.theme.library), id).toBe(p.theme.library.colors);
    }
  });

  it("the reading palette cannot be reached by it", () => {
    const data = parseProfileData(JSON.stringify({
      theme: {
        library: { base: "charcoal", dark: true, colors: THEMES.charcoal.colors, relief: -0.06 },
        reading: { base: "charcoal", dark: true, colors: THEMES.charcoal.colors, relief: -0.06 },
      },
    }));
    // A WHOLE profile, not a cast through a partial one. `Profile` carries seven fields beyond the
    // three this case cares about, and asserting past them compiles under the app's config and fails
    // under the tests' own stricter one — which is where the build actually checks.
    const p: Parameters<typeof profileTheme>[0] = {
      id: "u:t", name: "T", description: null, author: null,
      iconKind: "seal", iconRef: null, derivedFrom: null,
      createdAt: 0, updatedAt: 0, data,
    };
    expect(profileTheme(p).colors.chromeBg).not.toBe(THEMES.charcoal.colors.chromeBg);
    expect(profileReadingTheme(p).colors.chromeBg).toBe(THEMES.charcoal.colors.chromeBg);
    expect(profileReadingTheme(p).colors.paperBg).toBe(THEMES.charcoal.colors.paperBg);
  });

  it("a stored value is clamped to the palette's own room, never rejected", () => {
    const at = (relief: unknown) =>
      parseProfileData(JSON.stringify({ theme: { library: { base: "ivory", colors: THEMES.ivory.colors, relief } } }))
        .theme.library.relief;
    const room = reliefRoom(THEMES.ivory.colors.surfaceBg);
    expect(at(9)).toBe(room.max);
    expect(at(-9)).toBe(room.min);
    expect(at("x")).toBeNull();
    expect(at(null)).toBeNull();
    expect(at(0)).toBe(0);
  });

  it("opens at the palette's own relief when it has none of its own", () => {
    // The control tells the truth about the theme in force before it is touched.
    for (const t of Object.values(THEMES)) {
      const own = reliefOf(t.colors.surfaceBg, t.colors.chromeBg);
      const back = withPanelRelief(t.colors, own).chromeBg;
      expect(Math.abs(L(back) - L(t.colors.chromeBg)), t.id).toBeLessThan(1 / 255 + 1e-9);
    }
  });

  it("the editor draws it on the library chapter only, tracked to the room", () => {
    expect(EDITOR).toContain('{scope === "library" && (');
    expect(EDITOR).toContain('className="pf-relief"');
    expect(EDITOR).toContain("min={room.min}");
    expect(EDITOR).toContain("max={room.max}");
    expect(EDITOR).toContain("libraryColors(draft.data.theme.library)");
    expect(CSS_PF).toContain(".pf-relief {");
  });

  it("choosing a shipped paper clears it, so the paper is what it says", () => {
    const from = EDITOR.indexOf("d.theme[scope].base = id;");
    expect(EDITOR.slice(from, EDITOR.indexOf("})", from))).toContain("d.theme[scope].relief = null;");
  });

  it("is named for the surface it is measured against, in both languages", () => {
    for (const k of ["profiles.relief.name", "profiles.relief.hint", "profiles.relief.darker",
      "profiles.relief.level", "profiles.relief.lighter"] as const) {
      expect(ar[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(ar["profiles.relief.darker"]).toContain("{p}");
    expect(en["profiles.relief.lighter"]).toContain("{p}");
    expect(en["profiles.relief.level"]).toContain("desk");
    expect(ar["profiles.relief.level"]).toContain("المكتب");
  });

  it("the palette derivation itself is untouched", () => {
    expect(PALETTE).toContain("const deskStep = dark ? 0.023 : 0.071;");
    expect(PALETTE).toContain("const chromeStep = dark ? 0.005 : 0.025;");
    expect(PROFILE).toContain("export function libraryColors");
    expect(RELIEF_STEP).toBeGreaterThan(0);
  });
});
