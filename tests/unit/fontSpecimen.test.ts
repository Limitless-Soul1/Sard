// WHAT A FONT'S OWN PAGE PROMISES.
//
// The screen itself is DOM and this suite has no DOM, so what is pinned here is the part that can be
// wrong without anyone noticing: the specimen text, the coverage contract, the single door both
// imports go through, and the geometry that keeps the page inside a short window. The rendered result
// is verified in the running application.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

const specimen = read("src/features/fonts/FontSpecimen.tsx");
const arrive = read("src/features/fonts/arrive.ts");
const dropRoute = read("src/features/profiles/dropRoute.ts");
const settings = read("src/features/settings/GlobalSettings.tsx");
const css = read("src/styles/profiles.css");
const rust = read("src-tauri/src/fonts/mod.rs");
const ar = read("src/i18n/locales/ar.ts");
const en = read("src/i18n/locales/en.ts");

/** One CSS rule's body, by selector. */
function rule(selector: string): string {
  const i = css.indexOf(selector + " {");
  if (i < 0) return "";
  const open = css.indexOf("{", i);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("both doors end on the same screen", () => {
  it("the drop route announces through the shared entry point", () => {
    expect(dropRoute).toContain("announceImportedFont");
  });

  it("…and so does the picker in Global Settings", () => {
    expect(settings).toContain("announceImportedFont");
  });

  it("neither door imports anything of its own — the pipeline is untouched", () => {
    // The drop path still calls the existing command, and the picker still calls the existing store
    // method. The new module adds an ANSWER, not a second importer.
    expect(dropRoute).toContain("fontImportDropped");
    expect(settings).toContain("importFont()");
    expect(arrive).not.toContain("fontImport(");
    expect(arrive).not.toContain("font_import");
  });

  it("the announcement is the only thing that opens the specimen", () => {
    expect(arrive).toContain("useFontPreview.getState().show");
    // Nothing else may open it, or the two doors could drift apart again.
    expect(dropRoute).not.toContain("useFontPreview");
    expect(settings).not.toContain("useFontPreview");
  });

  it("a stumble AFTER the import cannot report the import as failed", () => {
    // THE REGRESSION THIS PINS. The announcement was first written inside the same `try` as the
    // import, so an unavailable `fonts_list` made a font that had imported perfectly report
    // `font.err.failed` — the two existing drop tests caught it. The import now has a `try` of its
    // own that RETURNS, and everything after it is wrapped separately: showing the new screen is a
    // courtesy after the import, never part of it.
    const i = dropRoute.indexOf("fontImportDropped(paths[0])");
    const after = dropRoute.slice(i); // to the end: the reasoning between the two blocks is long
    // The import's own catch answers and leaves; the announcement cannot reach that branch.
    expect(after).toMatch(/catch[\s\S]{0,220}font\.err\.failed[\s\S]{0,120}return;/);
    // …and the announcement's own failure falls back to the toast rather than to a refusal.
    expect(after).toContain("shown = true");
    expect(after).toContain("if (!shown)");
    expect(after).toMatch(/bad:\s*false/);
  });

  it("a refusal never reaches the specimen", () => {
    // The drop path's catch still answers with the toast, and `announceImportedFont` is only reached
    // from the success branch — it takes a STORED row, which a refused file never produces.
    expect(dropRoute).toContain("bad: true");
    expect(arrive).toMatch(/row:\s*CustomFont/);
  });
});

describe("the face is registered before it is shown", () => {
  it("the announcement reloads and then re-checks", () => {
    expect(arrive).toContain("reload()");
    expect(arrive).toContain("ensureRegistered");
  });

  it("registration is decided by the document, not by the row", () => {
    // `document.fonts.check` after `load` — the only thing that knows whether the face can draw.
    expect(arrive).toContain("document.fonts.load");
    expect(arrive).toContain("document.fonts.check");
  });

  it("the screen re-checks for itself and says when the face is not ready", () => {
    expect(specimen).toContain("ensureRegistered");
    expect(specimen).toContain("font.specimen.loading");
  });
});

describe("coverage is read from the font, never from its name", () => {
  it("the core probes real code points through the cmap", () => {
    expect(rust).toContain("ARABIC_PROBE");
    expect(rust).toContain("LATIN_PROBE");
    expect(rust).toContain("fn sfnt_scripts");
    expect(rust).toContain("fn subtable_has");
    // The two subtable formats that between them cover every modern font.
    expect(rust).toMatch(/Some\(4\)/);
    expect(rust).toMatch(/Some\(12\)/);
  });

  it("a script counts only when EVERY probe glyph is present", () => {
    // One stray glyph must not read as coverage.
    expect(rust).toContain("ARABIC_PROBE.iter().all(");
    expect(rust).toContain("LATIN_PROBE.iter().all(");
  });

  it("a compressed container answers `unknown`, not a guess", () => {
    // woff/woff2 keep their tables deflated; the parser says so instead of inventing an answer.
    expect(rust).toContain("arabic: None");
    expect(rust).toContain("latin: None");
  });

  it("the screen shows English ONLY on a proven Latin font", () => {
    // `latin === true` — an unknown (`null`) must not be treated as a yes.
    expect(specimen).toContain("latin === true");
  });

  it("…and shows Arabic unless the font is KNOWN not to have it", () => {
    // `!== false` keeps the specimen visible when coverage could not be read, which is the case the
    // reader most needs to look at.
    expect(specimen).toContain("arabic !== false");
  });
});

describe("the specimen text is worth showing", () => {
  /** The string a `const NAME = "\u2026"` declares, so a nearby comment cannot be read as specimen text. */
  const literal = (name: string): string => {
    const i = specimen.indexOf(`const ${name}`);
    const open = specimen.indexOf('"', i);
    return specimen.slice(open + 1, specimen.indexOf('"', open + 1));
  };

  it("the stage line carries diacritics, joining and Arabic punctuation", () => {
    const text = literal("HERO");
    expect(text).toMatch(/[\u064B-\u0652]/); // harakat / shadda / sukun
    expect(text).toContain("،");
    expect(text.split(/\s+/).length).toBeLessThan(16);
  });

  it("the stage breaks where the sentence breaks, not where the box ends", () => {
    // Two spans, not one wrapped paragraph: the caesura is chosen, and it survives every width.
    expect(specimen).toMatch(/const HERO = \[/);
    expect(specimen).toContain("fs-hero-line");
    expect(rule(".fs-hero-line")).toContain("display: block");
  });

  it("the reading passage is prose, and long enough to have rhythm", () => {
    const text = literal("READING");
    expect(text).toContain("؛");   // the Arabic semicolon
    expect(text).toContain("ء");   // a bare hamza
    expect(text).toMatch(/[\u064B-\u0650]/); // tanween
    // A passage, not a line — this zone answers "would I read three hundred pages of it".
    expect(text.split(/\s+/).length).toBeGreaterThan(18);
    // …and it is NOT the stage line said twice.
    expect(text).not.toContain(literal("HERO"));
  });

  it("both digit sets are shown, because a book meets both", () => {
    expect(specimen).toContain("٠١٢٣٤٥٦٧٨٩");
    expect(specimen).toContain("0123456789");
  });

  it("diacritics are shown as words, not as marks on a dotless carrier", () => {
    // A vowelled word list is a specimen; a column of bare harakat is diagnostic output.
    const text = literal("VOWELLED");
    expect(text).toMatch(/[\u064B-\u0652]/);
    expect(text.split("·").length).toBeGreaterThan(2);
  });

  it("the English specimen is a sentence first and an alphabet second", () => {
    expect(specimen).toMatch(/The quiet page turns/);
    expect(specimen).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(specimen.indexOf("LATIN_LINE")).toBeLessThan(specimen.indexOf("LATIN_ALPHABET"));
  });

  it("the specimen text is content, so it is NOT in the locale files", () => {
    // Translating it would stop an English reader ever seeing the font's Arabic.
    expect(ar).not.toContain("وَقَفَ الضَّوءُ");
    expect(en).not.toContain("The quiet page turns");
  });
});

describe("direction and labels", () => {
  it("the Arabic zones are rtl and the Latin zone is ltr", () => {
    expect(specimen).toContain('dir="rtl"');
    expect(specimen).toContain('dir="ltr"');
    expect(specimen).toContain('lang="ar"');
    expect(specimen).toContain('lang="en"');
  });

  it("every label the popup uses exists in both locales", () => {
    for (const k of [
      "font.specimen.title", "font.specimen.already", "font.specimen.arabic", "font.specimen.english",
      "font.specimen.reading", "font.specimen.details", "font.specimen.installed",
      "font.specimen.loading",
      "font.specimen.done", "font.specimen.where",
      "font.specimen.coverage.both", "font.specimen.coverage.arabic", "font.specimen.coverage.latin",
      "font.specimen.coverage.neither", "font.specimen.coverage.unknown",
      "font.specimen.neitherNote", "font.specimen.unknownNote",
    ]) {
      expect(ar, k).toContain(`"${k}"`);
      expect(en, k).toContain(`"${k}"`);
    }
  });

  it("the way out is a named control, not a bare glyph", () => {
    expect(specimen).toContain('aria-label={t("panel.close")}');
    expect(specimen).toContain('role="dialog"');
    expect(specimen).toContain('aria-modal="true"');
  });

  it("every zone a reader might name carries a label", () => {
    // The three labelled zones share one device; surface and alignment are what keep them apart.
    for (const k of ["font.specimen.reading", "font.specimen.details", "font.specimen.english"]) {
      expect(specimen, k).toContain(k);
    }
  });
});

describe("it is a popup over Sard, not a page instead of it", () => {
  it("it uses the scrim every other Sard dialog uses", () => {
    expect(specimen).toContain("pf-dialog-scrim");
    expect(rule(".pf-dialog-scrim")).toContain("position: fixed");
  });

  it("the panel is a panel: bounded in both axes, never the whole window", () => {
    const m = rule(".fs-modal");
    expect(m).toMatch(/width:\s*min\(/);
    expect(m).toMatch(/max-height:\s*min\(/);
    expect(css).not.toContain(".fs-sheet");
    expect(specimen).not.toContain("fs-sheet");
  });

  it("a press outside dismisses, and one inside does not", () => {
    expect(specimen).toContain("onClick={clear}");
    expect(specimen).toContain("e.stopPropagation()");
  });
});

/**
 * A rule's type size in px — from `font-size`, from the top of a `clamp()`, or from the `font:`
 * shorthand the quiet tier uses. `rem` is resolved at the 16px root Sard sets.
 */
const sizeOf = (sel: string): number => {
  const body = rule(sel);
  const clamped = /font-size:\s*clamp\(([^,]+),([^,]+),([^)]+)\)/.exec(body);
  if (clamped) return parseFloat(clamped[3]);
  const px = /font-size:\s*([0-9.]+)px/.exec(body);
  if (px) return parseFloat(px[1]);
  const short = /font:\s*[0-9]+\s+([0-9.]+)(rem|px)/.exec(body);
  if (short) return parseFloat(short[1]) * (short[2] === "rem" ? 16 : 1);
  return NaN;
};

describe("six compositions, not one document", () => {
  // THE REGRESSION THIS SUITE EXISTS FOR. The popup before this one was correct in every mechanical
  // respect and still read as a single scrolling page: one surface, horizontal rules between the
  // parts, and sizes close enough that no zone announced itself. Each test below pins one of the
  // things that now makes a zone legible as a zone.

  it("every zone is present, in the order the eye should travel", () => {
    const order = ["fs-mast", "fs-stage", "fs-read", "fs-detail", "fs-latin", "fs-foot"];
    let at = -1;
    for (const z of order) {
      const i = specimen.indexOf(`"${z}`);
      expect(i, z).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the zones are told apart by SURFACE, not by one more horizontal rule", () => {
    // Two inset bands frame open canvas: the masthead at the top, the Latin band and the completion
    // strip at the bottom. The stage, the reading zone and the detail zone carry no background.
    for (const sel of [".fs-mast", ".fs-read", ".fs-latin", ".fs-foot"]) {
      expect(rule(sel), sel).toMatch(/background:\s*color-mix/);
    }
    // …and the two open zones alternate with them, which is the rhythm the eye follows.
    for (const sel of [".fs-stage", ".fs-detail"]) {
      expect(rule(sel), sel).not.toContain("background:");
    }
  });

  it("…and by ALIGNMENT: exactly one zone is centred", () => {
    expect(rule(".fs-detail-set")).toContain("text-align: center");
    for (const sel of [".fs-stage", ".fs-read", ".fs-latin"]) {
      expect(rule(sel), sel).not.toContain("text-align: center");
    }
  });

  it("…and by DEVICE: the reading zone uses a vertical rule, not a horizontal one", () => {
    // Another full-width rule would have been the fourth identical divider in a row.
    expect(rule(".fs-passage")).toContain("border-inline-start");
    expect(rule(".fs-read")).not.toContain("border-top");
    expect(rule(".fs-read")).not.toContain("border-bottom");
  });

  it("…and by COLUMN: the reading and Latin zones set a label in the margin", () => {
    for (const sel of [".fs-read", ".fs-detail", ".fs-latin"]) {
      expect(rule(sel), sel).toContain("display: grid");
      expect(rule(sel), sel).toMatch(/grid-template-columns:\s*96px/);
    }
    expect(specimen).toContain("fs-mark");
  });

  it("nothing in the flow is a card", () => {
    // Cards are what a reader reads as "a dashboard". The two surfaced bands are full-bleed frames:
    // no radius, no border on all four sides, no shadow, and no horizontal padding of their own on
    // the scroll container that would inset them from the popup's edges.
    for (const sel of [".fs-mast", ".fs-read", ".fs-latin", ".fs-foot"]) {
      expect(rule(sel), sel).not.toContain("border-radius");
      expect(rule(sel), sel).not.toContain("box-shadow");
    }
    expect(rule(".fs-body")).toContain("padding: 0");
  });
});

describe("the typeface is the hero", () => {
  it("the stage is the largest thing in the popup", () => {
    const hero = sizeOf(".fs-hero");
    expect(hero).toBeGreaterThanOrEqual(48);
    expect(hero).toBeGreaterThan(sizeOf(".fs-name"));
    expect(hero).toBeGreaterThan(sizeOf(".fs-passage"));
    expect(hero).toBeGreaterThan(sizeOf(".fs-latin-line"));
  });

  // FOUR TIERS, NOT ONE SLOPE.
  //
  // The scale was once a single descending run — 56, 44, 26, 19, 17, 15, 13, 11 — and its bottom
  // was the problem: the diacritic line, the figures and the alphabet had slid into the same range
  // as the metadata, so the things a reader opens this popup to INSPECT were the things they could
  // not read. What the sizes encode now is ROLE:
  //
  //   display    the identity and the stage — large, and allowed to be
  //   specimen   anything a reader is meant to look AT, hard-floored at a size that can be inspected
  //   support    an inventory rather than a sentence: the quietest specimen, still a specimen
  //   quiet      labels, metadata, the closing note — small on purpose, legible all the same
  //
  // Within a tier, size is not the ranking. The detail zone is set LARGER than the reading passage
  // on purpose — a glyph you inspect needs more size than prose you read — and stays subordinate
  // through ink, brevity and centring instead.
  const DISPLAY = [".fs-hero", ".fs-name"];
  const SPECIMEN = [".fs-vowelled", ".fs-figure", ".fs-latin-line", ".fs-passage"];
  const SUPPORT = [".fs-alphabet"];
  const QUIET = [".fs-meta", ".fs-mark", ".fs-kicker", ".fs-where"];

  it("no specimen has fallen into the metadata range", () => {
    // THE REGRESSION THIS PINS: 15px diacritics, 17px figures, a 13px alphabet.
    for (const sel of SPECIMEN) expect(sizeOf(sel), sel).toBeGreaterThanOrEqual(22);
    for (const sel of SUPPORT) expect(sizeOf(sel), sel).toBeGreaterThanOrEqual(16);
    // …and every specimen is clear of the loudest quiet element by a visible margin.
    const loudestQuiet = Math.max(...QUIET.map(sizeOf));
    for (const sel of [...SPECIMEN, ...SUPPORT]) {
      expect(sizeOf(sel), sel).toBeGreaterThan(loudestQuiet + 1);
    }
  });

  it("the quiet tier stays quiet — and stays legible", () => {
    // NOMINAL px: `rem` here resolves against Sard's chrome root, which is
    // `clamp(16px, …, 22.4px) * var(--ui-user)` — viewport- AND user-scaled. Measured in the running
    // app on a profile with the UI scale below 1, the previous values rendered at 11.3-11.8px, which
    // is why the floor is expressed generously rather than at the nominal minimum.
    for (const sel of QUIET) {
      expect(sizeOf(sel), sel).toBeLessThanOrEqual(14);   // never competes with a specimen
      expect(sizeOf(sel), sel).toBeGreaterThanOrEqual(13); // never disappears, even scaled down
    }
    // The coverage note is a SENTENCE, not a label: it is read, so it sits above the quiet tier.
    expect(sizeOf(".fs-note")).toBeGreaterThan(Math.max(...QUIET.map(sizeOf)));
  });

  it("the tiers are separated, and the display tier is far above the rest", () => {
    const display = Math.min(...DISPLAY.map(sizeOf));
    const specimen = Math.max(...SPECIMEN.map(sizeOf));
    expect(display).toBeGreaterThan(specimen);
    // The stage against the quietest label: contrast the eye reads as a hierarchy, not a gradient.
    expect(sizeOf(".fs-hero") / Math.min(...QUIET.map(sizeOf))).toBeGreaterThan(3.5);
  });

  it("the stage has room for a tall face's marks", () => {
    // MEASURED DEFECT. Amiri's own content box is 1.77em; at line-height 1.5 the second line of the
    // couplet had its shadda in the first line's descenders. The leading is set by the tallest face
    // the specimen may be handed, not by how the shortest one looks.
    const lh = (sel: string) => parseFloat(/line-height:\s*([0-9.]+)/.exec(rule(sel))?.[1] ?? "0");
    expect(lh(".fs-hero")).toBeGreaterThanOrEqual(1.77);
    const i = css.indexOf("@media (max-height: 700px)");
    const q = css.slice(i, css.indexOf("@media", i + 10));
    expect(/\.fs-hero \{[^}]*line-height:\s*([0-9.]+)/.exec(q)).not.toBeNull();
    expect(parseFloat(/\.fs-hero \{[^}]*line-height:\s*([0-9.]+)/.exec(q)![1])).toBeGreaterThanOrEqual(1.77);
  });

  it("the diacritic specimen has room for its marks", () => {
    // Arabic marks sit above AND below the baseline; too little leading and they touch the line
    // above. Verified in the rendered popup as well — this pins the intent.
    // The threshold is the MEASURED requirement, not a round number: this line renders 45px of ink
    // at 26px type — 1.73em — so anything at or above that clears the marks. Verified in the app.
    const body = rule(".fs-vowelled");
    const lh = parseFloat(/line-height:\s*([0-9.]+)/.exec(body)?.[1] ?? "0");
    expect(lh).toBeGreaterThanOrEqual(1.8);
    expect(sizeOf(".fs-vowelled")).toBeGreaterThanOrEqual(24);
  });

  it("tracking is never applied to joined Arabic", () => {
    // letter-spacing on connected script breaks the shaping the specimen exists to show. The
    // figures and marks are non-joining, so they may be tracked; the vowelled words may not.
    expect(rule(".fs-figure")).toContain("letter-spacing");
    expect(rule(".fs-vowelled")).not.toContain("letter-spacing");
    expect(rule(".fs-hero")).not.toContain("letter-spacing");
    expect(rule(".fs-passage")).not.toContain("letter-spacing");
  });

  it("the name introduces the face without becoming the specimen", () => {
    expect(sizeOf(".fs-name")).toBeGreaterThan(sizeOf(".fs-passage"));
    expect(sizeOf(".fs-name")).toBeLessThan(sizeOf(".fs-hero"));
  });

  it("a font with no Arabic still gets a hero, rather than a caption", () => {
    // Nothing to be subordinate TO, so the Latin line takes the stage's size and the band's surface
    // goes with it — the zone stops being a band and becomes the stage.
    expect(specimen).toContain('arabic === false ? "fs-latin solo"');
    expect(sizeOf(".fs-latin.solo .fs-latin-line")).toBeGreaterThan(sizeOf(".fs-latin-line"));
    expect(rule(".fs-latin.solo")).toContain("background: transparent");
    expect(rule(".fs-latin.solo")).toContain("border-top: none");
  });

  it("the measures are in `em`, so they do not vary with the arriving font", () => {
    // `ch` is the width of the FONT'S OWN "0", so one rule gives every font a different measure.
    // Measured at 24ch: Arial wrapped into the intended paragraph, Andalus stayed one 565px row.
    for (const sel of [".fs-hero", ".fs-passage", ".fs-latin-line"]) {
      expect(rule(sel), sel).toMatch(/max-width:\s*[\d.]+em/);
      expect(rule(sel), sel).not.toMatch(/max-width:\s*[\d.]+ch/);
    }
  });

  it("the metadata is quiet, and the confirmation is not part of it", () => {
    const meta = rule(".fs-meta");
    // Quiet, but not a smudge — the range, not one frozen value.
    expect(sizeOf(".fs-meta")).toBeLessThan(sizeOf(".fs-passage"));
    expect(sizeOf(".fs-meta")).toBeGreaterThanOrEqual(13);
    expect(meta).toContain("flex-wrap: wrap");
    expect(specimen).toContain("fs-dot");
    // «متاح الآن في سَرْد» belongs to the ending, not to the introduction.
    const mast = specimen.indexOf("fs-mast");
    const foot = specimen.indexOf("fs-foot");
    const installed = specimen.indexOf("font.specimen.installed");
    expect(installed).toBeGreaterThan(foot);
    expect(installed).toBeGreaterThan(mast);
  });
});

describe("the popup begins and ends", () => {
  it("the identity is pinned, so the name never scrolls away from its specimen", () => {
    expect(rule(".fs-mast")).toContain("flex: none");
  });

  it("«تمّ» is anchored in a completion strip, with the confirmation beside it", () => {
    const foot = rule(".fs-foot");
    expect(foot).toContain("flex: none");
    expect(foot).toContain("justify-content: space-between");
    // The note that used to be a stranded full-width paragraph now belongs to the ending.
    const i = specimen.indexOf('className="fs-foot"');
    const after = specimen.slice(i);
    expect(after).toContain("font.specimen.where");
    expect(after).toContain("font.specimen.done");
  });

  it("only the body scrolls — never the application", () => {
    const body = rule(".fs-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overscroll-behavior: contain");
  });

  it("the panel is a column, so the body is what gives way", () => {
    const m = rule(".fs-modal");
    expect(m).toContain("flex-direction: column");
    expect(m).toMatch(/max-height/);
  });

  it("a long family name wraps rather than overflowing", () => {
    expect(rule(".fs-name")).toContain("overflow-wrap: anywhere");
    expect(rule(".fs-hero")).toContain("overflow-wrap: anywhere");
  });

  it("a short window keeps the details inspectable", () => {
    // Stepping the type down is fine; sending the diacritics and figures back to 14-15px is not.
    const i = css.indexOf("@media (max-height: 700px)");
    const q = css.slice(i, css.indexOf("@media", i + 10));
    for (const sel of [".fs-vowelled", ".fs-figure", ".fs-alphabet", ".fs-passage"]) {
      const m = new RegExp(`\\${sel} \\{[^}]*font-size:\\s*([0-9.]+)px`).exec(q);
      expect(m, sel).not.toBeNull();
      expect(parseFloat(m![1]), sel).toBeGreaterThanOrEqual(15);
    }
  });

  it("a short window loses air, not structure", () => {
    // The height query moves padding and steps the type down. It must NOT remove a zone's surface or
    // flatten the ladder — that would be losing the design in order to fit.
    const i = css.indexOf("@media (max-height: 700px)");
    expect(i).toBeGreaterThan(0);
    const q = css.slice(i, css.indexOf("@media", i + 10));
    expect(q).toContain("padding");
    // No zone changes what it IS: the surfaces stay where they are…
    expect(q).not.toContain("background");
    // …and no ZONE is dropped to make the popup fit. Exactly one supporting LINE may go — the Latin
    // alphabet, whose sentence above it already shows the letterforms — and only where a Latin-only
    // font is not relying on it as its own inventory.
    const hidden = [...q.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)]
      .map((x) => x[1].trim().split(/\r?\n/).pop()!.trim()); // the selector, not the comment above
    expect(hidden).toEqual([".fs-latin:not(.solo) .fs-alphabet"]);
    for (const zone of [".fs-mast", ".fs-stage", ".fs-read", ".fs-detail", ".fs-latin", ".fs-foot"]) {
      expect(hidden, zone).not.toContain(zone);
    }
  });

  it("a narrow window moves the marginal labels rather than deleting them", () => {
    const i = css.indexOf("@media (max-width: 760px)");
    expect(i).toBeGreaterThan(0);
    const q = css.slice(i);
    expect(q).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(q).not.toContain("display: none");
  });
});
