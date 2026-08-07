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
]);

/** Properties that escape the column or fight the engine. Dropped outright, in every mode but raw. */
const NEVER = new Set([
  "position", "float", "clear",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "padding-block", "padding-block-start", "padding-block-end",
  "padding-inline", "padding-inline-start", "padding-inline-end",
  "columns", "column-count", "column-width", "column-gap", "column-rule", "column-span", "column-fill",
  "page-break-before", "page-break-after", "page-break-inside",
  "break-before", "break-after", "break-inside",
  "background", "background-color", "background-image",
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

/** Does this declaration survive? The single place the table is applied. */
export function keepDeclaration(prop: string, value: string, selector: string): boolean {
  const p = prop.trim().toLowerCase();
  // FINDING-1: a substring test for "!important" was a real bypass. CSS permits whitespace AND
  // comments between the bang and the keyword — `! important` and `!/**/important` are valid and
  // mean exactly the same thing, so both slipped through while the plain form was blocked. Comments
  // are stripped here as well as at sheet level, because `keepDeclaration` is called directly (by
  // the block filter and by tests) with values the sheet-level pass never saw.
  const v = value.replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
  if (!p || !v) return false;
  // `!important` from a book must never outrank the reader's own controls.
  if (/!\s*important/.test(v)) return false;
  if (NEVER.has(p)) return false;
  if (!KEEP.has(p)) return false;

  // A book may colour a WORD, never the page: a body/html-level colour would fight the theme.
  if (p === "color" && /(^|[\s,])(body|html)\b/i.test(selector)) return false;

  // Sizes and spacing must be relative, so the reader's zoom stays authoritative.
  if (p === "font-size" || p === "text-indent" || p === "letter-spacing") {
    return isRelativeSize(v) && !hasNegative(v);
  }
  // Margins: relative only, and never negative — this is the clipping rule, and it is absolute.
  if (p.startsWith("margin")) {
    return isRelativeSize(v) && !hasNegative(v);
  }
  return true;
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
    const value = decl.slice(idx + 1);
    if (keepDeclaration(prop, value, selector)) out.push(`${prop.trim()}: ${value.trim()}`);
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
  const out: string[] = [];
  for (const rule of parseRules(stripComments(css))) {
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
