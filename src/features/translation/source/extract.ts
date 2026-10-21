// THE SOURCE OF A TRANSLATION — a book's paragraphs and sentences, taken exactly as an edition freezes them.
//
// This is the extraction the translation pipeline was evaluated on, and it must not be tuned: every rule
// below reproduces the evaluated inputs exactly (measured in WebView2 155.0.4283.62, over every recorded
// paragraph and sentence list). A change to any of them is a change to what gets translated, so it gives a
// new EXTRACTION_ID and needs the same measurement again.
//
// A PARAGRAPH is a leaf block of the section's document, as foliate's `section.createDocument()` parses it
// (XHTML, or HTML when the XHTML is invalid): an element matching LEAF_SELECTOR that holds text and no
// nested such element. A section with none has its body as the one leaf. Text outside every leaf — beside
// the block containers, or directly inside a container that holds others — is not taken, by read-aloud or
// by the evaluation either. This is the selector read-aloud speaks by (`FoliateController.unitsForRoot`);
// read-aloud keeps its own copy and is not changed here.
//
// ITS TEXT is the leaf's `textContent`, with every run of whitespace — PYTHON'S whitespace set, which is the
// set the pipeline's input contract is written in, not JavaScript's `\s` — made one U+0020, and one space
// stripped at either end. A leaf whose text is then empty is dropped and counted, never silently lost.
//
// ITS SENTENCES are that text through `Intl.Segmenter("en", { granularity: "sentence" })`, each segment
// trimmed with JavaScript's `trim()`, empty ones dropped. The locale is always "en" — the source language
// the pipeline was evaluated on, not the book's declared language.
//
// WHAT IT DOES NOT DO. It checks nothing against the pipeline's input contract: the edition store does
// that, once, when the edition is made, and keeps a paragraph that breaks it with the reason, never to be
// sent. It does not say which WebView2 ran it: the caller records that as the edition's `webview_version`,
// and must take it from `tauri::webview_version()`, the one authoritative source — never from the page,
// whose user agent is reduced and whose client hints are not that source. It changes no document, and
// nothing calls it yet.
//
// NOT VALIDATED on real books (no measured book contains them): a WebView2 other than the one above, whose
// segmenter data may differ — which is why an edition stores its inputs rather than taking them again;
// U+001C–001F, U+0085 and U+FEFF, where Python's and JavaScript's whitespace differ; the HTML fallback for
// invalid XHTML; a body that is its section's only leaf; and images or declared note references inside a
// paragraph.

/** How paragraphs and sentences are taken. An edition records it. It stays the same while the rules here do,
 *  and any change to them that could change an edition's inputs gives a new one: the leaf rule, the
 *  whitespace set (Python 3.12.0, Unicode 15.0.0), the segmenter, and the atoms. */
export const EXTRACTION_ID = "leafblocks-1/pyws-3.12.0-ucd15/segmenter-en-1/atoms-1";

/** The block-ish containers, in the exact form read-aloud has always used. */
export const LEAF_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article";

// Python 3.12.0's whitespace — `str.isspace`, which is also `re`'s `\s` — under Unicode 15.0.0: 29 code
// points, the same set as the edition store's `PYTHON_WHITESPACE` (a test holds the two equal). It differs
// from JavaScript's `\s` by U+001C–001F and U+0085 (Python only) and U+FEFF (JavaScript only).
const PYTHON_SPACES = /[\u{9}-\u{d}\u{1c}-\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}-\u{2029}\u{202f}\u{205f}\u{3000}]+/gu;

/** Text as the pipeline receives it: each run of Python's whitespace becomes one U+0020, and one space is
 *  stripped at either end. */
export function collapse(text: string): string {
  return text.replace(PYTHON_SPACES, " ").replace(/^ /, "").replace(/ $/, "");
}

// `Intl.Segmenter` is in WebView2 and Node, but not in the ES2021 library the product compiles against.
type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
type SegmenterClass = new (locale: string, options: { granularity: "sentence" }) => Segmenter;
let segmenter: Segmenter | null = null;

/** The sentences of a text: the same collapse, then the "en" sentence segmenter; each segment trimmed with
 *  JavaScript's `trim()`, and empty ones dropped. */
export function sentencesOf(text: string): string[] {
  segmenter ??= new (Intl as unknown as { Segmenter: SegmenterClass }).Segmenter("en", { granularity: "sentence" });
  return Array.from(segmenter.segment(collapse(text)), (s) => s.segment.trim()).filter(Boolean);
}

// ---- What an extraction produces: the edition store's input, field for field ----

/** Counts of what sits inside a paragraph besides its text. Recorded for showing the edition later; they
 *  change nothing that is translated. */
export interface Atoms {
  /** `a` elements: links. */
  a: number;
  /** `br` elements: line breaks. `textContent` joins the text on either side of one with no space. */
  br: number;
  /** `img` elements: images. */
  img: number;
  /** Elements the book declares as a reference to a note — exactly the declared tier of foliate's footnote
   *  handler: an `epub:type` of noteref, biblioref or glossref, or the matching `doc-` role. Each is also
   *  counted under its own element name. */
  noteref: number;
}

export interface ParagraphInput {
  /** Child-element indices from `<body>` down to the leaf; empty for the body itself. */
  path: number[];
  /** The leaf's local name. */
  tag: string;
  atoms: Atoms;
  /** Exactly what the pipeline receives. */
  text: string;
  sentences: string[];
}

export interface SectionInput {
  /** The section's position in foliate's `book.sections` — the reader's section index. */
  index: number;
  /** The section's path in the book's package (foliate's `section.id`). */
  href: string;
  /** False only when the spine says `linear="no"`, as foliate reads it. */
  linear: boolean;
  /** As parsed: `application/xhtml+xml`, or `text/html` when the XHTML was invalid. */
  content_type: string;
  /** Leaves found, before those whose text collapses to nothing were dropped. */
  leaves: number;
  dropped_empty: number;
  /** No leaf container was found, so the body itself was taken (when it has text). */
  body_fallback: boolean;
  /** In document order. A paragraph's ordinal is its position here. */
  paragraphs: ParagraphInput[];
}

/** What the edition store is given to make an edition: these sections, and this `extraction_id` to record.
 *  The edition's `webview_version` is the caller's to supply, from `tauri::webview_version()`. */
export interface Extraction {
  extraction_id: string;
  sections: SectionInput[];
}

/** A section as foliate's book gives it. */
export interface SourceSection {
  id: string;
  /** The spine itemref's `linear` attribute as written; absent means linear. */
  linear?: string | null;
  createDocument(): Promise<Document>;
}

/** A section that could not be read. The extraction stops: an edition is never made from part of a book. */
export class ExtractionError extends Error {
  readonly index: number;
  readonly href: string;
  constructor(index: number, href: string, cause: unknown) {
    super(`section ${index} (${href}) could not be read: ${String(cause)}`);
    this.name = "ExtractionError";
    this.index = index;
    this.href = href;
  }
}

// ---- The section, from its leaves (pure) ----

/** A leaf block found in a section, before its text is collapsed. */
export interface Leaf {
  path: number[];
  tag: string;
  atoms: Atoms;
  /** Its `textContent`, as the document has it. */
  raw: string;
}

/** A section's input from the leaves found in it, in document order. A leaf whose text collapses to nothing
 *  is dropped and counted. */
export function assembleSection(index: number, section: Pick<SourceSection, "id" | "linear">, contentType: string, leaves: Leaf[], bodyFallback: boolean): SectionInput {
  const paragraphs: ParagraphInput[] = [];
  let dropped = 0;
  for (const leaf of leaves) {
    const text = collapse(leaf.raw);
    if (!text) {
      dropped++;
      continue;
    }
    paragraphs.push({ path: leaf.path, tag: leaf.tag, atoms: leaf.atoms, text, sentences: sentencesOf(text) });
  }
  return {
    index,
    href: section.id,
    linear: section.linear !== "no",
    content_type: contentType,
    leaves: leaves.length,
    dropped_empty: dropped,
    body_fallback: bodyFallback,
    paragraphs,
  };
}

// ---- The section, from its document ----

const OPS = "http://www.idpf.org/2007/ops";
const REF_TYPES = ["biblioref", "glossref", "noteref"];
const REF_ROLES = ["doc-biblioref", "doc-glossref", "doc-noteref"];

function declaresReference(el: Element): boolean {
  const types = new Set(el.getAttributeNS(OPS, "type")?.split(" "));
  const roles = new Set(el.getAttribute("role")?.split(" "));
  return REF_ROLES.some((r) => roles.has(r)) || REF_TYPES.some((t) => types.has(t));
}

function atomsOf(el: Element): Atoms {
  const atoms: Atoms = { a: 0, br: 0, img: 0, noteref: 0 };
  for (const e of Array.from(el.querySelectorAll("*"))) {
    if (e.localName === "a") atoms.a++;
    else if (e.localName === "br") atoms.br++;
    else if (e.localName === "img") atoms.img++;
    if (declaresReference(e)) atoms.noteref++;
  }
  return atoms;
}

/** The element path from `root` down to `el`. One `index` serves a whole section: it records every child's
 *  position the first time its parent is met, so a section is walked once, however long. */
function pathOf(el: Element, root: Element, index: Map<Element, number>): number[] {
  const out: number[] = [];
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    const parent = n.parentElement;
    if (!parent) break;
    if (!index.has(n)) {
      let k = 0;
      for (const c of Array.from(parent.children)) index.set(c, k++);
    }
    out.unshift(index.get(n) ?? -1);
  }
  return out;
}

const isLeaf = (el: Element): boolean => !el.querySelector(LEAF_SELECTOR) && !!(el.textContent ?? "").trim();

/** One section's input from its parsed document. A document without a body has no leaves. */
export function extractSection(index: number, section: Pick<SourceSection, "id" | "linear">, doc: Document): SectionInput {
  const body = doc.body;
  if (!body) return assembleSection(index, section, doc.contentType, [], false);
  let found: Element[] = Array.from(body.querySelectorAll(LEAF_SELECTOR)).filter(isLeaf);
  const bodyFallback = found.length === 0;
  if (bodyFallback) found = (body.textContent ?? "").trim() ? [body] : [];
  const positions = new Map<Element, number>();
  const leaves = found.map((el) => ({ path: pathOf(el, body, positions), tag: el.localName, atoms: atomsOf(el), raw: el.textContent ?? "" }));
  return assembleSection(index, section, doc.contentType, leaves, bodyFallback);
}

/** Every section of a book, in the reader's order, each from a fresh `createDocument()` — the book's own
 *  text, never a rendered page. Stops at the first section that cannot be read. */
export async function extractBook(book: { sections: SourceSection[] }): Promise<Extraction> {
  const sections: SectionInput[] = [];
  for (let i = 0; i < book.sections.length; i++) {
    const s = book.sections[i];
    let doc: Document;
    try {
      doc = await s.createDocument();
    } catch (e) {
      throw new ExtractionError(i, s.id, e);
    }
    sections.push(extractSection(i, s, doc));
  }
  return { extraction_id: EXTRACTION_ID, sections };
}
