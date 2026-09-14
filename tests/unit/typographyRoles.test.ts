import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARABIC, scriptOf } from "../../src/lib/typography";

/**
 * THE REINTRODUCTION GUARD FOR TYPOGRAPHY.
 *
 * Sard's three faces are declared in one place and chosen by one rule, stated in
 * `src/lib/typography.ts` and taken from the design of record:
 *
 *   · ARABIC IS ALWAYS `--ar`;
 *   · LATIN is `--ui` at label scale and `--book` at display scale;
 *   · the app's OWN WORDS are `--ui` in both scripts, because chrome is not per-script.
 *
 * Every drift this catches was locally reasonable, which is why no type check and no other test
 * caught any of them:
 *
 *   · Grid drew a book's title in the chrome face for BOTH scripts, so an Arabic title was Plex
 *     there and Amiri in Covers, Spines, Vista and the Details rows — one title, two typefaces,
 *     depending on which format the reader happened to be in;
 *   · the lede heading named the LATIN book face with no Arabic branch, and Literata has no Arabic
 *     glyphs, so an Arabic case name fell out of Sard's faces into a system serif;
 *   · reading-side text — a search snippet, a highlight, a note — offered Latin the book serif and
 *     Arabic the chrome sans, so an Arabic quotation was the one place Amiri never reached;
 *   · `Inter`, a SELECTABLE READING face belonging to no role, was hard-coded for the author line on
 *     generated jackets and the credit on quote cards;
 *   · the roles were declared on `.libd-root`, invisible to portals, to the Grid caption stylesheet
 *     and to the card that gets rasterised;
 *   · the wordmark was drawn four ways, two of them setting its Arabic half in the chrome sans;
 *   · and eight files each kept their own answer to "is this Arabic", two of which asked the BOOK's
 *     direction before the text's own script.
 */

const FACES = [
  "Amiri", "Literata", "SourceSerif4", "Inter",
  "SardUILatin", "SardUIArabic", "ArefRuqaa", "NotoNaskhArabic",
];

/** Where the faces are allowed to be named, and why. */
const DECLARES = new Set([
  // The reader injects its own stylesheet into the book's document, which never inherits ours.
  "src/reader-engine/injectedCss.ts",
  // The font PICKERS: their whole job is to name faces the reader may choose.
  "src/lib/fonts.ts",
  "src/features/settings/GlobalSettings.tsx",
  "src/features/photo/PhotoComposer.tsx", // its quote-face picker; roles are used for everything else
  "src/features/profiles/mini.ts",
]);

/**
 * Prose is not typography. The scan reads what SHIPS, so comments come out first — otherwise this
 * file could not describe the faults it exists to prevent, and neither could `lib/typography.ts`.
 */
function code(text: string, css: boolean): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // The `[^:]` keeps a `//` that belongs to a URL from swallowing the rest of its line.
  return css ? withoutBlocks : withoutBlocks.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `@font-face` and `:root` blanked out — the two places that are SUPPOSED to name families. */
function beyondTheDeclarations(css: string): string {
  const blank = (t: string, pat: RegExp): string => {
    const out = [...t];
    for (const m of t.matchAll(pat)) {
      let d = 0, j = t.indexOf("{", m.index);
      for (; j < t.length; j++) {
        if (t[j] === "{") d++;
        else if (t[j] === "}" && --d === 0) break;
      }
      for (let k = m.index; k <= j && k < t.length; k++) if (out[k] !== "\n") out[k] = " ";
    }
    return out.join("");
  };
  return blank(blank(css, /@font-face/g), /^:root\b/gm);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full.split("\\").join("/"));
  }
  return out;
}

const namesAFace = (line: string): boolean => FACES.some((f) => new RegExp("\\b" + f + "\\b").test(line));

describe("typography roles", () => {
  // The locales name the faces as WORDS — the labels in the font picker, in two languages. They are
  // what the reader reads, not what the reader reads them in.
  const files = walk("src").filter((f) => !f.startsWith("src/i18n/"));
  const globalCss = readFileSync("src/styles/global.css", "utf8");

  it("names a face only where the faces are declared or offered", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (DECLARES.has(file) || file === "src/styles/global.css") continue;
      const text = code(readFileSync(file, "utf8"), file.endsWith(".css"));
      for (const face of FACES) {
        // The face named as a CSS family: inside a quoted string, which is the only way it reaches
        // the page from TypeScript, and the usual way it reaches it from CSS.
        const re = new RegExp("[\"'`][^\"'`\\n]*\\b" + face + "\\b", "g");
        for (const hit of text.match(re) ?? []) offenders.push(`${file}: ${hit.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lets the stylesheet name a face only where it declares one", () => {
    // `global.css` holds the @font-face rules and the role tokens, so it cannot be excluded whole:
    // doing that is what hid eighteen ordinary component rules naming families of their own.
    const lines = beyondTheDeclarations(code(globalCss, true)).split("\n");
    const raw = globalCss.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!namesAFace(line)) return;
      let j = i;
      while (j >= 0 && !raw[j].includes("{")) j--;
      offenders.push(`${i + 1}: ${(raw[j] ?? "").split("{")[0].trim() || raw[i].trim().slice(0, 50)}`);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps every role reachable from :root, not from one shell", () => {
    // A role declared on `.libd-root` is invisible to a portal on `document.body`, to the Grid
    // caption stylesheet, and to the card that gets rasterised. That is how three of the faults
    // above became possible.
    const rootBlock = globalCss.slice(globalCss.indexOf(":root {"), globalCss.indexOf("* { box-sizing"));
    for (const role of ["--ui:", "--book:", "--ar:", "--brand:", "--brand-ar:"]) {
      expect(rootBlock).toContain(role);
    }
    const design = readFileSync("src/styles/library-design.css", "utf8");
    for (const role of ["--ui:", "--book:", "--ar:"]) {
      expect(design.includes(role)).toBe(false);
    }
  });

  it("builds every role from the family the reader chose, not from a constant", () => {
    // THE PRODUCT RULE, not merely an architectural one: one setting, and the whole interface
    // answers. `--ui-font` used to be the only runtime value of the five; `--book`, `--ar` and
    // `--brand-ar` were constants nothing ever wrote, so changing the application font moved the
    // chrome and the Latin half of the wordmark and left every Arabic title, the Arabic half of the
    // mark, and the text on a generated card exactly where they were.
    //
    // So: a role may hold a fallback CHAIN, but never a family of its own. It must resolve to a
    // base that `applyUiFontVar` writes.
    const rootBlock = globalCss.slice(globalCss.indexOf(":root {"), globalCss.indexOf("* { box-sizing"));
    const bases = new Set<string>();
    for (const role of ["--ui", "--book", "--ar", "--brand", "--brand-ar"]) {
      const m = new RegExp("^\\s*" + role + ":\\s*([^;]+);", "m").exec(rootBlock);
      expect(m, `${role} is declared on :root`).toBeTruthy();
      const value = m![1].trim();
      // exactly `var(--something-font)` — no literal family, no second opinion
      const v = /^var\((--[a-z-]+)\)$/.exec(value);
      expect(v, `${role} must be var(--…-font), got ${value}`).toBeTruthy();
      bases.add(v![1]);
    }

    // and every base a role depends on has to be one the setter actually writes
    const fonts = readFileSync("src/lib/fonts.ts", "utf8");
    const written = new Set(
      [...fonts.matchAll(/\["(--[a-z-]+)",\s*(?:UI_FALLBACK|`)/g)].map((m) => m[1]),
    );
    for (const base of bases) {
      expect(written.has(base), `${base} is written by applyUiFontVar`).toBe(true);
    }
    // the setter must clear what it sets, or a cleared choice would leave the old family behind
    expect(fonts).toMatch(/removeProperty\(base\)/);
  });


  it("starts every role from the application font, including when nothing is chosen", () => {
    // THE FAULT THE OWNER ACTUALLY HIT. "IBM Plex Sans Arabic" is offered in the picker like any
    // other face, but the catalogue writes it as the EMPTY STRING — which is also how "nothing
    // chosen" is stored. `applyUiFontVar` read the empty string as the latter and removed every
    // override, handing the roles back to whatever the :root bases held. When those bases named
    // Literata and Amiri, selecting IBM produced five families on one screen: Plex chrome, Plex
    // Latin titles, AMIRI Arabic titles, an Amiri half of the wordmark, and a Literata quote on a
    // generated card.
    //
    // So the bases must START from the app font. Literata and Amiri stay in the chains, one step
    // further back, as faces a reader may CHOOSE rather than faces that arrive unbidden.
    const rootBlock = globalCss.slice(globalCss.indexOf(":root {"), globalCss.indexOf("* { box-sizing"));
    for (const [base, plex] of [["--book-font", "SardUILatin"], ["--ar-font", "SardUIArabic"]] as const) {
      const m = new RegExp("^\\s*" + base + ":\\s*([^;]+);", "m").exec(rootBlock);
      expect(m, `${base} is declared on :root`).toBeTruthy();
      const first = m![1].split(",")[0].trim().replace(/^["']|["']$/g, "");
      expect(first, `${base} must lead with the application font, not a design constant`).toBe(plex);
    }
    // and the setter's own fallbacks must agree with those defaults, or clearing a choice would
    // land somewhere different from never having made one
    const fonts = readFileSync("src/lib/fonts.ts", "utf8");
    expect(fonts).toContain('["--book-font", `"SardUILatin"');
    expect(fonts).toContain('["--ar-font", `"SardUIArabic"');
  });


  it("leaves the per-script choice to the one place that knows the rule", () => {
    // `--ar` and `--book` are the two halves of a single decision — which script is this text in —
    // and a component that names either has made that decision on its own. `--ui` is not in this
    // list: chrome is not per-script, so naming it is exactly right.
    //
    // A component that spells the ternary itself is how the lede came to name the Latin book face
    // with no Arabic branch at all. `labelFace`, `displayFace` and their `...For` forms cannot.
    const offenders: string[] = [];
    for (const file of files) {
      if (file === "src/lib/typography.ts" || file.endsWith(".css")) continue;
      code(readFileSync(file, "utf8"), false).split("\n").forEach((line, i) => {
        if (/var\(--ar\)|var\(--book\)/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("asks one question about script, in one place", () => {
    // A face is chosen BY script, so a second opinion about what counts as Arabic is a second
    // opinion about typography. There were eight, and they did not agree: one covered Arabic
    // Extended-A and the others did not, and two consulted the book's direction BEFORE the text.
    const offenders: string[] = [];
    for (const file of files) {
      if (file === "src/lib/typography.ts") continue;
      // `lib/pdfText.ts` is the one honest exception and must STAY one. It keeps base Arabic and the
      // presentation forms in SEPARATE ranges on purpose: a PDF whose extracted text is full of
      // presentation forms has been damaged by the extractor, and that ratio is how the legibility
      // score notices. Folding its ranges into the typography one would silently destroy the metric.
      // It chooses no face and belongs to no role.
      if (file === "src/lib/pdfText.ts") continue;
      // `reader-engine/FoliateController.ts` is the other, and also stays. It decides the DIRECTION
      // of a paragraph inside a book (RAWY-253), not a face, and it reached for the same Unicode
      // script escape that lib/typography.ts settled on. Two callers of one correct rule, asking
      // two different questions, is not duplication.
      if (file === "src/reader-engine/FoliateController.ts") continue;
      const text = code(readFileSync(file, "utf8"), file.endsWith(".css"));
      if (/(?:const|let)\s+\w*ARABIC\w*\s*=\s*\//.test(text)) offenders.push(file + ": declares its own Arabic range");
      // `dir === "rtl" || ARABIC.test(...)` — the precedence that made a Latin title Arabic.
      if (/dir\s*===\s*"rtl"\s*\|\|/.test(text)) offenders.push(file + ": direction overrules the text");
    }
    expect(offenders).toEqual([]);
  });

  it("knows Arabic from a byte-order mark, which no hand-written range did", () => {
    // Every one of the eight ranges ran to the end of Arabic Presentation Forms-B, and its last code
    // point is U+FEFF — the byte-order mark. A title carrying a stray BOM was therefore "Arabic",
    // and would have been set in Amiri. Unicode is asked directly now, and it knows better.
    expect(ARABIC.test("\uFEFF")).toBe(false);
    expect(scriptOf("\uFEFFAlice")).toBe("latin");
    // every Arabic block, including the Extended-A that only one of the eight private ranges covered
    for (const ch of ["\u0627", "\u0750", "\u08A0", "\uFB50", "\uFE70"]) {
      expect(ARABIC.test(ch)).toBe(true);
    }
    expect(ARABIC.test("A")).toBe(false);
    // and the precedence the eight disagreed about: the text speaks before the book does
    expect(scriptOf("Kingdom of Ash", "rtl")).toBe("latin");
    expect(scriptOf("\u0645\u0642\u062F\u0645\u0629", "ltr")).toBe("arabic");
    expect(scriptOf("", "rtl")).toBe("arabic"); // nothing to go on: only then does the book decide
  });
});
