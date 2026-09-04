// THE DEPOSIT MANIFEST — the whole of what leaves, as one legible document.
//
// A deposit is a zip whose only required member is this file. It is built here, in a pure function
// with no React and no IPC, so every rule about what travels is unit-testable and so the text the
// sender READS in the preview is the text that is WRITTEN — `deposit_export` copies it verbatim.
//
// WHAT DOES NOT TRAVEL, and why it is a list rather than an omission:
//   · reading position and progress — where someone stopped is a spoiler and a behavioural signal;
//   · bookmarks — private navigation scaffolding, not a reading trace;
//   · note tags — `tags.name` is UNIQUE and shared across every book, so importing them would edit a
//     vocabulary the receiver owns. The strings ride along on the note for display and nothing else;
//   · shelf placement, collections, view orders, metadata overrides, profiles, settings;
//   · local row ids — every id in Sard is derived from `book_id` + anchor, so the receiver recomputes
//     them. Sending one would be handing a foreign key into someone else's database.
//
// A DEPOSIT IS NOT A DATABASE DUMP. Six tables the sender owns are deliberately absent.
import type { HighlightRow, NoteRow, RefRow, RepRow } from "../../../lib/ipc";
import type { DepositPlan } from "../../../lib/ipc";

/** The format version this build writes. Newer is refused on import, older is accepted. */
export const DEPOSIT_VERSION = 1;
export const MANIFEST_NAME = "deposit.json";
/** The ceiling `deposit::package` enforces. Checked here too, so the sheet can say so in words. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export type LayerKey = "highlights" | "notes" | "references" | "replacements";
export const LAYERS: LayerKey[] = ["highlights", "notes", "references", "replacements"];

export interface ManifestHighlight {
  cfi: string;
  section: string | null;
  /** Nullable BY MEASUREMENT: a spine-only cfi names a document and no position inside it. */
  section_index: number | null;
  color: string;
  text: string | null;
  chapter_label: string | null;
  created_at: number | null;
}
export interface ManifestNote {
  cfi: string | null;
  section: string | null;
  section_index: number | null;
  title: string | null;
  body: string;
  color: string | null;
  chapter_label: string | null;
  created_at: number | null;
  /** An INDEX into this manifest's own highlights array — never an id. */
  of_highlight: number | null;
}
export interface ManifestReference {
  phrase: string;
  phrase_fold: string;
  word_count: number;
  note: string;
}
export interface ManifestReplacement {
  phrase: string;
  phrase_fold: string;
  word_count: number;
  replacement: string;
}

export interface DepositManifest {
  deposit: number;
  created_at: number;
  app: { name: string; version: string };
  sender: { name: string };
  book: {
    hash: string;
    format: string | null;
    title: string | null;
    author: string | null;
    language: string | null;
    dir: string | null;
    size_bytes: number;
    spine_count: number | null;
    file?: string;
    cover?: string;
  };
  inscription: { text: string; signed: string };
  marks: {
    highlights: ManifestHighlight[];
    notes: ManifestNote[];
    references: ManifestReference[];
    replacements: ManifestReplacement[];
  };
}

/** Which marks the sender bound, by row id. A layer's absence from a set means none of it travels. */
export interface Selection {
  highlights: Set<string>;
  notes: Set<string>;
  references: Set<string>;
  replacements: Set<string>;
}

export const emptySelection = (): Selection => ({
  highlights: new Set(),
  notes: new Set(),
  references: new Set(),
  replacements: new Set(),
});

export interface BuildInput {
  plan: DepositPlan;
  highlights: HighlightRow[];
  notes: NoteRow[];
  references: RefRow[];
  replacements: RepRow[];
  selection: Selection;
  inscription: { text: string; signed: string };
  /** The book file travels unless the sender turns it off. */
  includeBook: boolean;
  appVersion: string;
  now: number;
}

/** Where a mark falls, as the plan resolved it. Keyed by row id, so the two halves cannot drift. */
const sectionOf = (plan: DepositPlan, id: string) => {
  const s = plan.sections.find((x) => x.id === id);
  return { section: s?.section ?? null, section_index: s?.section_index ?? null };
};

export function buildManifest(input: BuildInput): DepositManifest {
  const { plan, selection } = input;

  const highlights = input.highlights
    .filter((h) => selection.highlights.has(h.id))
    .map((h) => ({
      cfi: h.cfi,
      ...sectionOf(plan, h.id),
      // THE SEMANTIC SLOT, never a hex. It is what lets the receiver's theme paint the mark in their
      // own ink rather than in the sender's.
      color: h.color,
      text: h.text_excerpt,
      chapter_label: h.chapter_label,
      created_at: h.created_at,
    }));

  // The link between a note and its highlight survives as a POSITION in the array above, so the
  // relationship travels without either row carrying an identifier.
  const indexOfHighlight = new Map<string, number>();
  input.highlights
    .filter((h) => selection.highlights.has(h.id))
    .forEach((h, i) => indexOfHighlight.set(h.id, i));

  const notes = input.notes
    .filter((n) => selection.notes.has(n.id))
    .map((n) => ({
      cfi: n.cfi,
      ...sectionOf(plan, n.id),
      title: n.title,
      body: n.body ?? "",
      color: n.color,
      chapter_label: n.chapter_label,
      created_at: n.created_at,
      of_highlight: n.highlight_id ? indexOfHighlight.get(n.highlight_id) ?? null : null,
    }));

  const references = input.references
    .filter((r) => selection.references.has(r.id))
    .map((r) => ({ phrase: r.phrase, phrase_fold: r.phrase_fold, word_count: r.word_count, note: r.note }));

  const replacements = input.replacements
    .filter((r) => selection.replacements.has(r.id))
    .map((r) => ({
      phrase: r.phrase,
      phrase_fold: r.phrase_fold,
      word_count: r.word_count,
      replacement: r.replacement,
      // `enabled` deliberately does NOT travel: an imported substitution arrives switched off, and
      // whether the SENDER had it on says nothing about whether the receiver wants it on.
    }));

  return {
    deposit: DEPOSIT_VERSION,
    created_at: input.now,
    app: { name: "Sard", version: input.appVersion },
    sender: { name: input.inscription.signed },
    book: {
      hash: plan.book.hash,
      format: plan.book.format,
      title: plan.book.title,
      author: plan.book.author,
      language: plan.book.language,
      dir: plan.book.dir,
      size_bytes: plan.book.size_bytes,
      spine_count: plan.spine_count,
      ...(input.includeBook && plan.book_member ? { file: plan.book_member } : {}),
      // THE COVER ALWAYS TRAVELS. It was once carried only when the book was not, on the reasoning that
      // a deposit holding the book already holds its cover — true of the bytes, useless to the reader.
      // The receiver is the one person who has never seen this book, and the face is what he decides
      // by; extracting it from the packed book would mean parsing an EPUB before he has accepted one.
      // The sender's own size line has always counted `book_bytes + cover_bytes`, so this is also what
      // he was already told he was sending.
      ...(plan.cover_member ? { cover: plan.cover_member } : {}),
    },
    inscription: { text: input.inscription.text, signed: input.inscription.signed },
    marks: { highlights, notes, references, replacements },
  };
}

/** Two-space JSON: a sender who unzips their own deposit can read exactly what they are sending. */
export const manifestText = (m: DepositManifest): string => JSON.stringify(m, null, 2);

export const markCount = (m: DepositManifest): number =>
  m.marks.highlights.length + m.marks.notes.length + m.marks.references.length + m.marks.replacements.length;

/** Is there anything to send? An inscription alone is a valid deposit; an empty one is not. */
export const isSendable = (m: DepositManifest): boolean =>
  markCount(m) > 0 || m.inscription.text.trim().length > 0;
