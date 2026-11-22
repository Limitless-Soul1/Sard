// RESILIENCE-1 / WP-7A — THE BOOK-STYLESHEET SANITISER.
//
// MEASURED, in the real binary, across four books spanning the risk surface: every EPUB's external
// stylesheet objects EXIST but contribute **zero rules**, and `cssRules` throws on each one — the
// signature of an opaque, blocked sheet. No book's own CSS has ever applied in Sard. WP-7 changes
// that, and this module is the thing that makes it safe to do so.
//
// THE DANGER, stated concretely, because it decides the whole design. The Word/Calibre book carries
//     margin: 0 369pt 0 -84.8pt
// — Word's fixed A4 geometry translated literally. In a ~600 px column that leaves roughly 100 px of
// measure, and the NEGATIVE left margin pushes content outside the column box, where foliate's
// `overflow: hidden` silently clips it away. Letting that reach the frame would turn a cosmetic
// complaint into DATA LOSS. So absolute and negative box metrics are not a style preference to be
// weighed; they are the reason this module exists.
//
// PURE BY CONSTRUCTION: text in, text out. No DOM, no engine, no settings lookup. Every rule below is
// therefore provable in a unit test before a single byte of it can reach a reader's screen — which is
// the ordering the staged rollout depends on.

/** What a book's own stylesheet is allowed to do. The shipping default is `off`. */
export type BookCssMode =
  /** Strip everything. The sheet loads and contributes nothing — byte-identical to v1.1.0. */
  | "off"
  /** Apply the keep/neutralise table below. */
  | "sanitised"
  /** Pass through untouched. Debugging and power users only; never a default. */
  | "raw";

// ── the table ────────────────────────────────────────────────────────────────────────────────────

/**
 * Properties a book may set. Emphasis and voice — the things actually being lost today — plus
 * alignment, which carries real authorial intent in poetry and scene breaks.
 *
 * `color` is here but is filtered per-selector below: a book may colour a word, not the page.
 */
const KEEP = new Set([
  "font-style",
  "font-variant",
  "font-weight",
  "text-transform",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-style",
  "font-size", // only when RELATIVE — see `sizeIsRelative`
  "text-align",
  "text-indent", // only when relative — same check
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
  "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end",
  "color",
  "font-variant-numeric",
  "letter-spacing", // relative only
  "vertical-align",
  // THE BOOK'S LOOK — rules, frames, faded labels, boxes. Each is held to a shape that cannot leave the
  // column or out-size the reader's text: see `cleanDeclaration`. None of them may style the page itself.
  "opacity", // not below MIN_OPACITY: a book cannot make text vanish
  "display", // the block/inline kinds only — see DISPLAY
  "box-sizing",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "padding-block", "padding-block-start", "padding-block-end",
  "padding-inline", "padding-inline-start", "padding-inline-end",
  "width", "min-width", "max-width", // a percentage of the column, never a length
  "background", "background-color", // a plain colour only, never an image
  "border-collapse",
  "list-style-type",
  ...borderProps(),
]);

/** Every border longhand and shorthand: the four sides, the logical sides, and width/style/colour of each. */
function borderProps(): string[] {
  const sides = ["", "-top", "-right", "-bottom", "-left", "-block", "-block-start", "-block-end", "-inline", "-inline-start", "-inline-end"];
  const out: string[] = ["border-radius"];
  for (const s of sides) for (const part of ["", "-width", "-style", "-color"]) out.push(`border${s}${part}`);
  return out;
}

/** The kinds of box a book may ask for. `none` is left out: hidden text would still be read aloud. */
const DISPLAY = new Set(["block", "inline", "inline-block", "list-item"]);

/** Below this a book's faded label is no longer readable, so the declaration is dropped. */
const MIN_OPACITY = 0.2;

/** Padding past this would squeeze the line (em-like units, and percent of the column). */
const PADDING_MAX_EM = 4;
const PADDING_MAX_PCT = 25;

/** Properties that escape the column or fight the engine. Dropped outright, in every mode but raw. */
const NEVER = new Set([
  "position", "float", "clear",
  "height", "min-height", "max-height",
  "columns", "column-count", "column-width", "column-gap", "column-rule", "column-span", "column-fill",
  "page-break-before", "page-break-after", "page-break-inside",
  "break-before", "break-after", "break-inside",
  "background-image",
  "zoom", "transform", "writing-mode", "direction",
  "overflow", "overflow-x", "overflow-y",
  "line-height", // the reader owns this — RAWY-195 hardened it deliberately
  "font-family", // the reader's font choice must win
]);

/** At-rules the book must not control. foliate owns pagination; the reader owns the viewport. */
const NEVER_AT = new Set(["page", "media", "supports", "container", "viewport", "font-face"]);

/** Absolute length units. These are the ones that fight a reflowable column. */
const ABSOLUTE_UNIT = /(-?\d*\.?\d+)\s*(pt|px|cm|mm|in|pc|q)\b/i;
/** Any negative length, in any unit — the clipping case. */
const NEGATIVE_LENGTH = /-\s*\d*\.?\d+\s*(pt|px|cm|mm|in|pc|q|em|rem|ex|ch|%|vw|vh)?/i;

const isRelativeSize = (v: string): boolean => !ABSOLUTE_UNIT.test(v);
const hasNegative = (v: string): boolean => NEGATIVE_LENGTH.test(v);

/**
 * Does the selector style the PAGE — `<html>`, `<body>`, `:root`, or everything (`*`)?
 *
 * The page's box, ground and geometry are the reader's: the margins, the paper colour and the column
 * come from Sard's own settings. A book's `body { margin: 1em 1.5em; padding: 1.5em 2em; max-width: 38em }`
 * is exactly what squeezed its text into a narrow strip in a narrow column (measured with the book's
 * sheet passed through untouched). True when ANY selector in the list has one of those as its subject.
 */
export function stylesPage(selector: string): boolean {
  return selector.split(",").some((s) => {
    const subject = s.trim().split(/[\s>+~]+/).pop() ?? "";
    return /^(?:(?:html|body|:root)(?![\w-])|\*$)/i.test(subject);
  });
}

/** Properties that shape a box. On the page itself they are the reader's (see `stylesPage`). */
const BOX_PROP = /^(margin|padding|width|min-width|max-width|background|border|opacity|display|box-sizing)/;

/** CSS px per unit, to judge a border's width (em-like units at a 16 px text size). */
const PX_PER: Record<string, number> = {
  px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8, ch: 8,
};
/**
 * A length token at the start of a word, so a colour such as `#c8a96e` can never be read as one.
 *
 * The character before the number is matched and given back (`lead`) rather than asserted with a
 * lookbehind: a lookbehind is a syntax error to an older WebKitGTK, and a regex literal that fails to
 * parse takes the whole bundle down with it on Linux.
 */
const LENGTH_TOKEN = /(^|[^#\w.])(\d*\.?\d+)\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch)\b/gi;

/**
 * A border with its widths named rather than measured: `1px solid #ccc` → `thin solid #ccc`.
 *
 * A rule under a heading or a frame round a summary is the book's look, but its width is written in
 * pixels, and no absolute length may reach the frame (the property the whole module exists to keep).
 * The keywords are the browser's own widths (thin ≈ 1 px, medium ≈ 3 px, thick ≈ 5 px), so the rule is
 * drawn as the book drew it and nothing measured survives.
 */
function borderValue(v: string): string | null {
  if (hasNegative(v)) return null;
  const named = v.replace(LENGTH_TOKEN, (_, lead: string, n: string, unit: string) => {
    const px = parseFloat(n) * (PX_PER[unit.toLowerCase()] ?? 16);
    return lead + (px <= 1.5 ? "thin" : px <= 3.5 ? "medium" : "thick");
  });
  return ABSOLUTE_UNIT.test(named) || /\d\s*(%|vw|vh)/i.test(named) ? null : named;
}

/** Padding inside the book's own boxes: relative, never negative, and never wide enough to squeeze the line. */
function paddingOk(v: string): boolean {
  if (!isRelativeSize(v) || hasNegative(v) || v.includes("(")) return false;
  const lengths = /(\d*\.?\d+)\s*([a-z%]*)/gi;
  for (let m = lengths.exec(v); m; m = lengths.exec(v)) {
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "em" || unit === "rem") { if (n > PADDING_MAX_EM) return false; }
    else if (unit === "ex" || unit === "ch") { if (n / 2 > PADDING_MAX_EM) return false; }
    else if (unit === "%") { if (n > PADDING_MAX_PCT) return false; }
    else if (unit !== "" || n !== 0) return false; // viewport units, or a bare number
  }
  return true;
}

/** A plain colour — the only background a book may give a box. Never an image, a gradient or a url. */
const PLAIN_COLOUR = /^(#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([^()]*\))$/i;

/**
 * The value this declaration keeps, or null when it is dropped. The single place the table is applied.
 *
 * Most declarations are kept as written. A border's widths are rewritten as keywords (`borderValue`).
 */
export function cleanDeclaration(prop: string, value: string, selector: string): string | null {
  const p = prop.trim().toLowerCase();
  // FINDING-1: a substring test for "!important" was a real bypass. CSS permits whitespace AND
  // comments between the bang and the keyword — `! important` and `!/**/important` are valid and
  // mean exactly the same thing, so both slipped through while the plain form was blocked. Comments
  // are stripped here as well as at sheet level, because this is called directly (by the block
  // filter and by tests) with values the sheet-level pass never saw.
  const written = value.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const v = written.toLowerCase();
  if (!p || !v) return null;
  // `!important` from a book must never outrank the reader's own controls.
  if (/!\s*important/.test(v)) return null;
  if (NEVER.has(p)) return null;
  if (!KEEP.has(p)) return null;

  // A book may colour a WORD, never the page: a body/html-level colour would fight the theme.
  if (p === "color" && /(^|[\s,])(body|html)\b/i.test(selector)) return null;
  // Nor shape the page's own box: its margins, ground and column are the reader's.
  if (BOX_PROP.test(p) && stylesPage(selector)) return null;

  // Sizes and spacing must be relative, so the reader's zoom stays authoritative.
  if (p === "font-size" || p === "text-indent" || p === "letter-spacing") {
    return isRelativeSize(v) && !hasNegative(v) ? written : null;
  }
  // Margins: relative only, and never negative — this is the clipping rule, and it is absolute.
  if (p.startsWith("margin")) {
    return isRelativeSize(v) && !hasNegative(v) ? written : null;
  }
  if (p.startsWith("padding")) return paddingOk(v) ? written : null;
  if (p === "border-radius") return isRelativeSize(v) && !hasNegative(v) ? written : null;
  if (p.startsWith("border") && p !== "border-collapse") return borderValue(written);
  if (p === "width" || p === "min-width" || p === "max-width") {
    const m = /^(\d*\.?\d+)%$/.exec(v);
    return v === "auto" || (p === "max-width" && v === "none") || (m && parseFloat(m[1]) <= 100) ? written : null;
  }
  if (p === "background" || p === "background-color") return PLAIN_COLOUR.test(v) ? written : null;
  if (p === "opacity") {
    const m = /^(\d*\.?\d+)(%?)$/.exec(v);
    const n = m ? parseFloat(m[1]) / (m[2] ? 100 : 1) : NaN;
    return n >= MIN_OPACITY && n <= 1 ? written : null;
  }
  if (p === "display") return DISPLAY.has(v) ? written : null;
  return written;
}

/** Does this declaration survive at all? */
export function keepDeclaration(prop: string, value: string, selector: string): boolean {
  return cleanDeclaration(prop, value, selector) !== null;
}

// ── the parser ───────────────────────────────────────────────────────────────────────────────────
//
// Deliberately a scanner rather than a regex. A stylesheet contains braces inside strings and url()
// tokens, and comments can appear anywhere; a regex that ignores that will mis-split a real sheet and
// silently emit malformed CSS. This walks the text once, tracking string and comment state, so the
// structure it reports is the structure that is actually there.

interface Rule { selector: string; body: string; at: string | null }

function stripComments(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    out += css[i];
  }
  return out;
}

/** Split a sheet into top-level rules, keeping at-rule blocks intact for the caller to judge. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let head = "";
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const q = c;
      head += c;
      i++;
      while (i < css.length && css[i] !== q) {
        if (css[i] === "\\") { head += css[i]; i++; }
        head += css[i];
        i++;
      }
      head += css[i] ?? "";
      i++;
      continue;
    }
    if (c === "{") {
      let depth = 1;
      let body = "";
      i++;
      while (i < css.length && depth > 0) {
        const b = css[i];
        if (b === '"' || b === "'") {
          const q = b;
          body += b;
          i++;
          while (i < css.length && css[i] !== q) {
            if (css[i] === "\\") { body += css[i]; i++; }
            body += css[i];
            i++;
          }
          body += css[i] ?? "";
          i++;
          continue;
        }
        if (b === "{") depth++;
        else if (b === "}") { depth--; if (depth === 0) { i++; break; } }
        body += b;
        i++;
      }
      const sel = head.trim();
      const at = sel.startsWith("@") ? (sel.slice(1).split(/[\s({]/)[0] ?? "").toLowerCase() : null;
      rules.push({ selector: sel, body, at });
      head = "";
      continue;
    }
    if (c === ";" && head.trim().startsWith("@")) {
      // A statement at-rule with no block (@import, @charset). Recorded so it can be dropped.
      const sel = head.trim();
      rules.push({ selector: sel, body: "", at: (sel.slice(1).split(/[\s({]/)[0] ?? "").toLowerCase() });
      head = "";
      i++;
      continue;
    }
    head += c;
    i++;
  }
  return rules;
}

/** Filter one declaration block, returning only the declarations that survive. */
function filterBlock(body: string, selector: string): string {
  const out: string[] = [];
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx);
    const kept = cleanDeclaration(prop, decl.slice(idx + 1), selector);
    if (kept !== null) out.push(`${prop.trim()}: ${kept}`);
  }
  return out.join("; ");
}

/**
 * Sanitise a book's stylesheet.
 *
 * `off` returns an empty string — the sheet still loads (so the CSP change is exercised and can be
 * measured) but contributes nothing, which is what makes stage 7.1 byte-identical to v1.1.0.
 */
export function sanitiseBookCss(css: string, mode: BookCssMode): string {
  if (mode === "raw") return css;
  if (mode === "off") return "";
  const clean = stripComments(css);
  // AN INLINE `style="…"` ATTRIBUTE. The engine passes those through this same hook, and they are a
  // list of declarations with no selector and no braces — so the rule parser found nothing in them, and
  // a book's `style="text-align:center"` on a poem was erased. Filtered as one block instead; whose box
  // it is cannot be known here, so the page rule (`stylesPage`) cannot apply to it.
  if (!/[{}]/.test(clean)) return filterBlock(clean, "");
  const out: string[] = [];
  for (const rule of parseRules(clean)) {
    // Statement at-rules (@import pulls in a whole unsanitised sheet — and a remote one at that).
    if (rule.at && !rule.body) continue;
    if (rule.at) {
      // @media and friends are dropped WHOLE. Their conditions describe a viewport the reader
      // controls, and honouring them would let a book re-apply what the table just removed.
      if (NEVER_AT.has(rule.at)) continue;
      continue; // any other at-rule block is unknown territory — drop rather than guess
    }
    const kept = filterBlock(rule.body, rule.selector);
    if (kept) out.push(`${rule.selector} { ${kept} }`);
  }
  return out.join("\n");
}
