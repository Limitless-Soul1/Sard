// THE TRANSLATION VIEW, IN THE PAGE — a section shown with its translation, without changing the book's text.
//
// NOTHING OF THE BOOK'S TEXT IS TOUCHED. A translated paragraph keeps every one of its text nodes, exactly as they
// were; they are hidden (`font-size: 0`, their inline elements `display: none`), and the translation is drawn in
// their place by CSS, from an attribute on the paragraph's element (`::before { content: attr(…) }`). No text node
// is written, added, split or removed, so every CFI stays in the book's own coordinates: the reading position,
// bookmarks, highlights, notes and replacements go on pointing at the original text, as they do in the original
// view, and switching back is removing attributes. What follows from that, by construction:
//   * a highlight on a translated paragraph is drawn on hidden text, so it is not seen until the original is shown;
//   * the translation is not selectable: nothing can be highlighted, noted or copied from it;
//   * read-aloud reads the page's text, which is still the original.
//
// FINDING A PARAGRAPH ON THE PAGE. The edition took each paragraph from a fresh parse of the section, by the leaf
// rule (`isLeaf`) and its element path from <body> (`pathOf`). The rendered page is that document after the
// reader's own passes, which may add elements. So a paragraph is the leaf at its path only when the tag and the
// exact collapsed text agree there; otherwise the next leaf, in order, with exactly its tag and text. A paragraph
// found nowhere is left alone — shown in its original, with no mark — never guessed.
//
// The decisions (`match`, `marksFor`) are pure and unit-tested. The page work is checked in a real WebView2.

import { collapse, isLeaf, LEAF_SELECTOR, pathOf } from "../source/extract";
import type { ParagraphView, ShowView } from "./api";

/** The approved words the page carries. */
export interface Labels {
  review: string;
  reviewHint: string;
  notTranslated: string;
  keptOriginal: string;
}

/** A leaf as the matcher sees it. */
export interface Rendered {
  path: number[];
  tag: string;
  /** Its text, collapsed exactly as the extraction collapses it. */
  text: string;
}

/** Which rendered leaf (by index) each paragraph (by ordinal) is. See the module notes. */
export function match(paragraphs: Pick<ParagraphView, "ordinal" | "path" | "tag" | "text">[], rendered: Rendered[]): Map<number, number> {
  const byPath = new Map(rendered.map((r, i) => [r.path.join("/"), i] as const));
  const taken = new Set<number>();
  const out = new Map<number, number>();
  const same = (i: number, p: { tag: string; text: string }) => !taken.has(i) && rendered[i].tag === p.tag && rendered[i].text === p.text;
  let cursor = 0;
  for (const p of paragraphs) {
    let at = byPath.get(p.path.join("/"));
    if (at === undefined || !same(at, p)) {
      at = undefined;
      for (let j = cursor; j < rendered.length; j++) {
        if (same(j, p)) {
          at = j;
          break;
        }
      }
    }
    if (at === undefined) continue;
    taken.add(at);
    out.set(p.ordinal, at);
    cursor = Math.max(cursor, at + 1);
  }
  return out;
}

/** What a paragraph's element carries in the translation view: the translation to draw, a note under it, and a
 *  description (the element's title). `null`: nothing — a paragraph not translated yet is simply the original. */
export interface Marks {
  translation: string | null;
  note: string | null;
  title: string | null;
}

export function marksFor(show: ShowView, labels: Labels): Marks | null {
  switch (show.kind) {
    case "pending":
      return null;
    case "translation":
      return { translation: show.text, note: show.review ? labels.review : null, title: show.review ? labels.reviewHint : null };
    case "not_translated":
      return { translation: null, note: labels.notTranslated, title: null };
    case "kept_original":
      return { translation: null, note: labels.keptOriginal, title: null };
  }
}

// ---- The page ----

const STYLE_ID = "sard-translation";
const MARKED = "sard-tr-p";
const TR = "data-sard-tr";
const NOTE = "data-sard-tr-note";
/** Set when the title shown is ours; the book's own title of the element, if it had one, is kept beside it. */
const OUR_TITLE = "data-sard-tr-title";
const OWN_TITLE = "data-sard-tr-own-title";

// The size and line height are the element's own, measured before it is hidden: `font-size: 0` on the element
// would otherwise make every relative size inside it nothing. The translation is Arabic, right to left, in the
// reader's Arabic face (the reading sheet maps Arabic characters to it).
const CSS = `
.${MARKED}[${TR}] { font-size: 0 !important; line-height: 0 !important; }
.${MARKED}[${TR}] > * { display: none !important; }
.${MARKED}[${TR}]::before {
  content: attr(${TR});
  display: block;
  font-size: var(--sard-tr-size) !important;
  line-height: var(--sard-tr-lh) !important;
  direction: rtl;
  unicode-bidi: isolate;
  text-align: start;
}
.${MARKED}[${NOTE}]::after {
  content: attr(${NOTE});
  display: block;
  margin-block-start: 0.3em;
  font-size: calc(var(--sard-tr-size, 1em) * 0.72) !important;
  line-height: 1.4 !important;
  font-style: normal;
  font-weight: normal;
  text-indent: 0;
  opacity: 0.68;
  unicode-bidi: plaintext;
  text-align: start;
}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The rendered leaves of a section, by the extraction's own rule, with the elements they are. */
export function renderedLeaves(doc: Document): { el: Element; leaf: Rendered }[] {
  const body = doc.body;
  if (!body) return [];
  let found = Array.from(body.querySelectorAll(LEAF_SELECTOR)).filter(isLeaf);
  if (found.length === 0) found = (body.textContent ?? "").trim() ? [body] : [];
  const positions = new Map<Element, number>();
  return found.map((el) => ({ el, leaf: { path: pathOf(el, body, positions), tag: el.localName, text: collapse(el.textContent ?? "") } }));
}

/** Take every mark this view put on the section away again. */
export function clearDocument(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`.${MARKED}`)) as HTMLElement[]) {
    el.removeAttribute(TR);
    el.removeAttribute(NOTE);
    el.style.removeProperty("--sard-tr-size");
    el.style.removeProperty("--sard-tr-lh");
    if (el.hasAttribute(OUR_TITLE)) {
      if (el.hasAttribute(OWN_TITLE)) el.setAttribute("title", el.getAttribute(OWN_TITLE) ?? "");
      else el.removeAttribute("title");
      el.removeAttribute(OUR_TITLE);
      el.removeAttribute(OWN_TITLE);
    }
    el.classList.remove(MARKED);
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (!el.getAttribute("class")) el.removeAttribute("class");
  }
}

/** Show `paragraphs` in the section `doc`. Returns how many paragraphs carry a mark. */
export function applyToDocument(doc: Document, paragraphs: ParagraphView[], labels: Labels): number {
  ensureStyle(doc);
  clearDocument(doc);
  const leaves = renderedLeaves(doc);
  const at = match(paragraphs, leaves.map((l) => l.leaf));
  const view = doc.defaultView;
  let n = 0;
  for (const p of paragraphs) {
    const i = at.get(p.ordinal);
    const marks = marksFor(p.show, labels);
    if (i === undefined || !marks) continue;
    const el = leaves[i].el as HTMLElement;
    if (marks.translation !== null && view) {
      const cs = view.getComputedStyle(el);
      el.style.setProperty("--sard-tr-size", cs.fontSize);
      el.style.setProperty("--sard-tr-lh", cs.lineHeight);
      el.setAttribute(TR, marks.translation);
    }
    if (marks.note) el.setAttribute(NOTE, marks.note);
    if (marks.title) {
      if (el.hasAttribute("title")) el.setAttribute(OWN_TITLE, el.getAttribute("title") ?? "");
      el.setAttribute("title", marks.title);
      el.setAttribute(OUR_TITLE, "");
    }
    el.classList.add(MARKED);
    n++;
  }
  return n;
}
