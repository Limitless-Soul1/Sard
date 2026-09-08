// TYPOGRAPHY MUST REACH THE TEXT, WHATEVER SHAPE THE BOOK IS.
//
// Every typography selector in the funnel names a container ELEMENT — p, li, blockquote, div — because
// that is what a paragraph is in almost every EPUB. It need not be. A .txt-to-EPUB conversion can put a
// whole chapter into <body> as bare text nodes split by <br>, with <span> only for styling; EPUB 3 lets
// prose sit directly inside <section>. Neither shape matches any of those selectors, so all four reader
// controls were completely inert on them — MEASURED in the running app, on the real engine:
//
//                          conventional <p>            no block container
//   line spacing 1.5→2.6   34.08px → 59.06px           34px → 34px   (computed `normal`)
//   align → justify        ragged edge 42px → 0px      59px → 59px   (computed `start`)
//   align → centre         lines move, spread 22px     no movement
//   first-line indent      first line +34px            +0px          (computed `0px`)
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Sard's unit runner is deliberately `environment: "node"` with no
// DOM shim (see vitest.config.ts: a fake DOM "would invite tests that pass in a fake DOM and lie about
// WebView2"). So the RENDERED result is proven in the harness against the real engine, and what is
// pinned here is the part that is pure and that the harness cannot state as an invariant: the CSS
// CONTRACT — which structures each of the four controls can reach, and, just as importantly, which
// structures must stay untouched. Both halves matter: a fix that reached headings, or that started
// matching a conventional book differently, would be a regression even though the reported book improved.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — .mjs helper, intentionally untyped (the same convention as tests/corpus)
import { zipEntries, zipRead, decodeXml } from "../lib/epub-read.mjs";
import {
  buildReadingCss,
  ARABIC_DEFAULTS,
  LATIN_DEFAULTS,
  TEXT_HOST_CLASS,
  PARA_BREAK_CLASS,
  type ReadingStyle,
} from "../../src/reader-engine/injectedCss";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "epub");

/** One parsed rule: its selector list, and the declarations inside it. */
interface Rule {
  selectors: string[];
  decls: string;
}

/**
 * Split a stylesheet into rules. Deliberately simple — the funnel emits flat rules plus a handful of
 * at-blocks, and an at-block's inner rules are matched too, which is what we want.
 */
/**
 * Split a selector list on its TOP-LEVEL commas only.
 *
 * `hardList` in the funnel carries the same warning, and for the same reason: the leaf-div selector is
 * `body div:not(:has(p, div, …, h1, h2, …))`, whose commas sit INSIDE the `:has()`. A naive split on ","
 * shatters it into fragments like `h1` and `hr))`, and a reader of those fragments concludes that the
 * paragraph-indent rule targets headings — the precise inverse of what that clause says, since it
 * EXCLUDES divs containing one.
 */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  // Strip CSS comments first. The funnel carries long explanatory comments INSIDE the emitted sheet,
  // and a block scan would otherwise read a sentence of prose as a selector list.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@")) continue;
    out.push({ selectors: splitSelectors(sel), decls: m[2].trim() });
  }
  return out;
}

/** Every declaration of `prop` that lands on a selector matching `pred`. */
function declsFor(css: string, prop: string, pred: (sel: string) => boolean): string[] {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  const out: string[] = [];
  for (const r of rules(css)) {
    if (!r.selectors.some(pred)) continue;
    const m = r.decls.match(re);
    if (m) out.push(m[1].trim());
  }
  return out;
}

const HOST = `.${TEXT_HOST_CLASS}`;
/** A selector that targets the tagged text host itself (not merely a descendant of one). */
const hitsHost = (sel: string): boolean => new RegExp(`\\${HOST}(?![\\w-])`).test(sel);
/** A selector that targets a bare `p` — the conventional paragraph. */
const hitsP = (sel: string): boolean => /(?:^|\s)p(?![\w-])(?::not\([^)]*\))*\s*$/.test(sel.trim());
/**
 * Strip the arguments of functional pseudo-classes, so a selector is judged by its SUBJECT.
 * `body div:not(:has(p, div, …, h1, h2, …))` targets a div and explicitly EXCLUDES ones containing a
 * heading; reading those names as "this rule targets headings" inverts the meaning entirely.
 */
const subject = (sel: string): string => {
  let out = sel, prev = "";
  while (out !== prev) { prev = out; out = out.replace(/:(?:not|has|is|where)\([^()]*\)/g, ""); }
  return out;
};
/** A selector that targets a heading. */
const hitsHeading = (sel: string): boolean => /(?:^|[\s,>+~])h[1-6](?![\w-])/.test(subject(sel));

const style = (over: Partial<ReadingStyle>, base = LATIN_DEFAULTS): ReadingStyle => ({ ...base, ...over });

// Both directions, everywhere: the funnel takes `bookDir` and resolves logical alignment against it,
// so every claim below is made twice rather than assumed to be direction-neutral.
const DIRECTIONS = [
  ["LTR", undefined as string | undefined, LATIN_DEFAULTS],
  ["RTL", "rtl" as string | undefined, ARABIC_DEFAULTS],
] as const;

describe("the four controls reach prose that lives in no block container", () => {
  for (const [dirName, dir, base] of DIRECTIONS) {
    describe(dirName, () => {
      it("LINE SPACING is declared on the text host", () => {
        const css = buildReadingCss(style({ lineHeight: 2.35 }, base), undefined, undefined, dir);
        expect(declsFor(css, "line-height", hitsHost)).toContain("2.35 !important");
      });

      it("ALIGNMENT is declared on the text host", () => {
        for (const align of ["justify", "center", "start", "end"] as const) {
          const css = buildReadingCss(style({ align }, base), undefined, undefined, dir);
          expect(declsFor(css, "text-align", hitsHost), `align=${align}`).toContain(`${align} !important`);
        }
      });

      it("FIRST-LINE INDENT is declared on the text host, ON and OFF", () => {
        const on = buildReadingCss(style({ firstLineIndent: true }, base), undefined, undefined, dir);
        const off = buildReadingCss(style({ firstLineIndent: false }, base), undefined, undefined, dir);
        expect(declsFor(on, "text-indent", hitsHost)).toContain("1.5em !important");
        // OFF must be an explicit zero, not an absent rule — an absent rule hands the value back to
        // whatever else is in the cascade, which is the defect the funnel already fixed for <p>.
        expect(declsFor(off, "text-indent", hitsHost)).toContain("0 !important");
      });

      it("PARAGRAPH SPACING is declared on a text host that is a real block — but never on <body>", () => {
        const css = buildReadingCss(style({ paragraphSpacing: 22 }, base), undefined, undefined, dir);
        const spaced = rules(css).filter((r) =>
          r.selectors.some(hitsHost) && /(?:^|;)\s*margin-block\s*:/.test(r.decls));
        expect(spaced.length, "paragraph spacing must reach a tagged host").toBeGreaterThan(0);
        // <body> is excluded deliberately: there is only one, so a margin on it spaces nothing from
        // anything and would fight the `html, body { margin: 0 }` reset that owns the page box.
        for (const r of spaced) {
          for (const sel of r.selectors.filter(hitsHost)) {
            expect(sel, `paragraph spacing must exclude <body>:\n${sel}`).toMatch(/:not\(body\)/);
          }
        }
      });
    });
  }
});

describe("a conventional book is protected — nothing about it changed", () => {
  for (const [dirName, dir, base] of DIRECTIONS) {
    it(`${dirName}: <p> still carries all four controls`, () => {
      const css = buildReadingCss(
        style({ lineHeight: 2.1, align: "justify", firstLineIndent: true, paragraphSpacing: 18 }, base),
        undefined, undefined, dir);
      expect(declsFor(css, "line-height", hitsP)).toContain("2.1 !important");
      expect(declsFor(css, "text-align", hitsP)).toContain("justify !important");
      expect(declsFor(css, "text-indent", hitsP)).toContain("1.5em !important");
      expect(declsFor(css, "margin-block", hitsP)).toContain("18px !important");
    });
  }

  it("the host class is the ONLY selector added — no bare element selector was widened", () => {
    // If the fix had been "add body/section to the lists", a conventional book would start inheriting
    // alignment and indent onto its headings. Assert the shape of the fix, not just its effect: every
    // selector carrying one of the four properties is either an element the funnel already named, or
    // the host class.
    const css = buildReadingCss(
      style({ lineHeight: 2, align: "justify", firstLineIndent: true, paragraphSpacing: 12 }),
      undefined, undefined, undefined);
    // The elements the funnel already named, before this fix.
    const ALLOWED = /^(p|li|blockquote|div|td|th|dd|dt|center|body div|html|body)\b/;
    for (const r of rules(css)) {
      if (!/(?:^|;)\s*(line-height|text-align|text-indent|margin-block)\s*:/.test(r.decls)) continue;
      for (const raw of r.selectors) {
        // A marker class the controller already tagged before this change (`.sard-empty-p` collapses a
        // whitespace-only <p>, `.sard-ltr-align` pulls a kept-LTR line onto the book's margin) is not a
        // widened element selector — those rules existed and are untouched.
        if (/\.sard-(?!text-host)/.test(raw)) continue;
        if (hitsHost(raw)) continue;              // the one selector this fix adds
        if (/^:where\(/.test(raw)) continue;      // the zero-specificity heading guards
        if (/^\[align/.test(raw)) continue;       // the presentational-hint passthrough
        const sel = raw.replace(/:root:root(\.[\w-]+)?\s*/g, "").replace(/:not\([^)]*\)/g, "").trim();
        if (!sel) continue;
        expect(
          ALLOWED.test(sel),
          `an unexpected selector gained typography: ${raw}`,
        ).toBe(true);
      }
    }
  });
});

describe("headings keep the book's own typography", () => {
  const css = () => buildReadingCss(style({ lineHeight: 2.6, firstLineIndent: true }));

  it("the two inheritance guards exist, and both are zero-specificity", () => {
    // `line-height` and `text-indent` both INHERIT, so a tagged <body>/<section> would otherwise pass
    // the reader's body typography down into every chapter title inside it. `:where()` carries zero
    // specificity: enough to stop INHERITANCE, while losing to any rule the book itself writes. That
    // asymmetry is the whole point — Sard stops imposing, without imposing something else instead.
    const guards = rules(css()).filter((r) =>
      r.selectors.some((x) => /^:where\(\s*h[1-6]/.test(x)));
    const decls = guards.map((g) => g.decls).join(";");
    expect(decls, "leading must be handed back to the font").toMatch(/line-height\s*:\s*normal/);
    expect(decls, "indent must be handed back to the book").toMatch(/text-indent\s*:\s*0/);
    for (const g of guards) {
      expect(g.decls, "a guard that used !important would beat the book instead of losing to it")
        .not.toMatch(/!important/);
    }
  });

  it("no rule ever hands a heading the reader's own leading or indent", () => {
    // The hide-first-line feature legitimately collapses a heading's box (`line-height: 0`), so the
    // claim is specific: no heading is given the reader's RATIO, or a real first-line indent.
    for (const r of rules(css())) {
      if (!r.selectors.some(hitsHeading)) continue;
      expect(r.decls, `a heading was given the reader's leading:\n${r.selectors.join(", ")}`)
        .not.toMatch(/line-height\s*:\s*2\.6/);
      expect(r.decls, `a heading was given a first-line indent:\n${r.selectors.join(", ")}`)
        .not.toMatch(/text-indent\s*:\s*1\.5em/);
    }
  });
});

describe("deliberate book alignment still wins over the control", () => {
  it("a block the book centres is spared, on the host class too", () => {
    const css = buildReadingCss(style({ align: "justify", firstLineIndent: true, paragraphSpacing: 20 }));
    for (const prop of ["text-align", "text-indent", "margin-block"]) {
      const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:`);
      for (const r of rules(css)) {
        if (!re.test(r.decls)) continue;
        for (const sel of r.selectors.filter(hitsHost)) {
          expect(sel, `${prop} must spare a deliberately-aligned block:\n${sel}`).toMatch(/:not\(\.sard-book-align\)/);
        }
      }
    }
  });

  it("alignment on the host stays behind the measurement gate", () => {
    // The forced alignment is scoped to `.sard-al`, which the controller adds only AFTER it has read
    // each block's own alignment. If the host class escaped that gate, the measurement would read
    // Sard's value back and every book would look deliberately aligned.
    const css = buildReadingCss(style({ align: "center" }));
    for (const r of rules(css)) {
      if (!/(?:^|;)\s*text-align\s*:/.test(r.decls)) continue;
      for (const sel of r.selectors.filter(hitsHost)) {
        expect(sel, `host alignment must stay gated:\n${sel}`).toMatch(/\.sard-al\b/);
      }
    }
  });
});

// ── the fixtures that carry the affected shapes ──────────────────────────────────────────────────
//
// Structure only: whether the CONTROLS work on them is a rendering question, answered in the harness.
// What is guarded here is that the fixtures keep covering the cases at all — a fixture that quietly
// grew a <p> would still pass every rendering check while testing nothing.
describe("the fixtures still carry the shapes this fix is about", () => {
  /** Every chapter document of a fixture, decoded — the chapters are DEFLATE'd, so a byte scan of the
   *  archive finds nothing and would let these guards pass while testing nothing at all. */
  const chapters = (name: string): string[] => {
    const buf = readFileSync(join(FIXTURES, name));
    const entries: { name: string }[] = zipEntries(buf) ?? [];
    const docs = entries
      .filter((e) => /\.x?html?$/i.test(e.name) && !/nav\.x?html?$/i.test(e.name))
      .map((e) => decodeXml(zipRead(buf, e)) as string | null)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    expect(docs.length, `${name} yielded no chapter documents`).toBeGreaterThan(0);
    return docs;
  };
  const read = (name: string): string => chapters(name).join("\n");

  it("no-block-containers has bare text and <br>, and no block container", () => {
    const s = read("no-block-containers.epub");
    expect(s).toMatch(/<br\s*\/?>/i);
    expect(/<\s*p[\s>]/i.test(s), "a <p> appeared — the fixture stopped covering the bare-text shape").toBe(false);
  });

  it("no-block-containers-rtl carries the same shape in Arabic", () => {
    const s = read("no-block-containers-rtl.epub");
    expect(s).toMatch(/<br\s*\/?>/i);
    expect(/<\s*p[\s>]/i.test(s)).toBe(false);
    const opf = (zipEntries(readFileSync(join(FIXTURES, "no-block-containers-rtl.epub"))) ?? [])
      .find((e: { name: string }) => /\.opf$/i.test(e.name));
    const opfText = decodeXml(zipRead(readFileSync(join(FIXTURES, "no-block-containers-rtl.epub")), opf)) as string;
    expect(opfText, "the RTL fixture must declare Arabic").toMatch(/<dc:language>ar<\/dc:language>/);
    expect(s, "and carry Arabic prose").toMatch(/[\u0600-\u06FF]/);
  });

  it("section-containers holds prose directly in <section>, with no <p>", () => {
    const s = read("section-containers.epub");
    expect(s).toMatch(/<section/i);
    expect(/<\s*p[\s>]/i.test(s), "a <p> appeared — the fixture stopped covering the <section> shape").toBe(false);
  });

  it("control-wellformed is the conventional shape, and DOES use <p>", () => {
    // The control must remain conventional, or the regression half of this suite proves nothing.
    expect(read("control-wellformed.epub")).toMatch(/<\s*p[\s>]/i);
  });
});

// ── paragraph spacing where there are no paragraph boxes ─────────────────────────────────────────
//
// A chapter written as <br>-separated runs is ONE block with nothing to put a margin on. Six CSS-only
// mechanisms were measured against the real engine and all six failed, because Blink discards `display`
// on <br>. `markParagraphBreaks` therefore swaps each such <br> for an empty span, ELEMENT FOR ELEMENT,
// and this rule gives that span the box. What is pinned here is the CSS half of the contract; the swap
// itself, and the CFI equality that makes it safe, are measured in the harness against the real engine.
describe("paragraph spacing reaches <br>-separated runs", () => {
  const BREAK = `.${PARA_BREAK_CLASS}`;
  const hitsBreak = (sel: string): boolean => new RegExp(`\\${BREAK}(?![\\w-])`).test(sel);

  for (const [dirName, dir, base] of DIRECTIONS) {
    it(`${dirName}: the break box carries the reader's paragraph spacing as a HEIGHT`, () => {
      const css = buildReadingCss(style({ paragraphSpacing: 22 }, base), undefined, undefined, dir);
      const rows = rules(css).filter((r) => r.selectors.some(hitsBreak));
      expect(rows.length, "the break rule must be emitted").toBeGreaterThan(0);
      const decls = rows.map((r) => r.decls).join(";");
      // `height`, never `margin`: an empty block's top and bottom margins collapse THROUGH each other,
      // which is exactly why the first attempt at this measured dead.
      expect(decls).toMatch(/height\s*:\s*22px/);
      expect(decls, "a margin would collapse to nothing on an empty block").not.toMatch(/margin/);
      // and it must be a block, or it is not a box at all
      expect(decls).toMatch(/display\s*:\s*block/);
    });
  }

  it("ZERO is emitted explicitly, so the control works in both directions", () => {
    // An absent rule would hand the value back to the cascade; an explicit 0 collapses the box, which
    // is measured to reproduce exactly the layout <br> gave.
    const css = buildReadingCss(style({ paragraphSpacing: 0 }));
    const decls = rules(css).filter((r) => r.selectors.some(hitsBreak)).map((r) => r.decls).join(";");
    expect(decls).toMatch(/height\s*:\s*0px/);
  });

  it("the rule is hardened, so a book cannot flatten the box", () => {
    // `span { display: inline !important }` in a book stylesheet would otherwise take the control away
    // again, silently — the same failure mode the rest of the funnel is hardened against.
    const css = buildReadingCss(style({ paragraphSpacing: 16 }));
    for (const r of rules(css)) {
      for (const sel of r.selectors.filter(hitsBreak)) {
        expect(sel, `the break rule must carry the hardening: ${sel}`).toMatch(/:root:root/);
      }
      if (r.selectors.some(hitsBreak)) expect(r.decls).toMatch(/!important/);
    }
  });

  it("the break class is Sard's own, and distinct from the host class", () => {
    // Two different jobs: the host is the book's element, tagged; the break IS Sard's element, created.
    expect(PARA_BREAK_CLASS).not.toBe(TEXT_HOST_CLASS);
    expect(PARA_BREAK_CLASS.startsWith("sard-")).toBe(true);
  });

  it("conventional paragraph spacing is untouched by it", () => {
    // The <p> rule and the break rule are separate; adding the second must not have altered the first.
    const css = buildReadingCss(style({ paragraphSpacing: 18 }));
    expect(declsFor(css, "margin-block", hitsP)).toContain("18px !important");
  });
});
