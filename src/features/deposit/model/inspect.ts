// READING A DEPOSIT BEFORE ANY OF IT ENTERS.
//
// Pure and total: text in, an answer out, no IPC and no React. Every refusal is a key the sheet can
// say in words, and every acceptance is a manifest whose optional fields have been defaulted rather
// than trusted — absence is how an older deposit spells "I did not carry this".
//
// THIS IS NOT THE TRUST BOUNDARY. `deposit::package::validate` re-checks the few rules that make a
// WRITE safe, because a boundary that holds only because the caller was well behaved is not a
// boundary. What lives here is the full, forgiving reading — the part worth unit-testing.
import { DEPOSIT_VERSION, MAX_MANIFEST_BYTES } from "./manifest";
import type {
  DepositManifest,
  ManifestHighlight,
  ManifestNote,
  ManifestReference,
  ManifestReplacement,
} from "./manifest";

export type Refusal =
  | { code: "dep.err.tooLarge"; bytes: number }
  | { code: "dep.err.unreadable" }
  | { code: "dep.err.notSard" }
  | { code: "dep.err.newer"; found: number }
  | { code: "dep.err.badBook" }
  | { code: "dep.err.badMember"; member: string };

export type Inspection = { ok: true; manifest: DepositManifest } | { ok: false; refusal: Refusal };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const isSha256 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
/** A member name is a stranger's string: it must live in one of the two folders and cannot climb out. */
const memberOk = (m: string) => (m.startsWith("book/") || m.startsWith("cover/")) && !m.includes("..");

export function inspectDeposit(text: string): Inspection {
  if (text.length > MAX_MANIFEST_BYTES) {
    return { ok: false, refusal: { code: "dep.err.tooLarge", bytes: text.length } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { code: "dep.err.unreadable" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refusal: { code: "dep.err.unreadable" } };
  }
  const o = raw as Record<string, unknown>;

  // A file that does not claim to be a deposit is not one. Checked BEFORE the version, so an ordinary
  // JSON document is refused as foreign rather than as "from a newer Sard".
  if (typeof o.deposit !== "number" || !Number.isFinite(o.deposit)) {
    return { ok: false, refusal: { code: "dep.err.notSard" } };
  }
  // NEWER IS REFUSED, OLDER IS NOT. A deposit from a later Sard may carry meaning this build cannot
  // see, and accepting it would silently discard it; an older one is safe, because every optional
  // field's absence already means its default.
  if (o.deposit > DEPOSIT_VERSION) {
    return { ok: false, refusal: { code: "dep.err.newer", found: o.deposit } };
  }

  const book = obj(o.book);
  if (!isSha256(book.hash)) return { ok: false, refusal: { code: "dep.err.badBook" } };
  for (const key of ["file", "cover"] as const) {
    const m = book[key];
    if (typeof m === "string" && !memberOk(m)) {
      return { ok: false, refusal: { code: "dep.err.badMember", member: m } };
    }
  }

  const marks = obj(o.marks);
  const highlights: ManifestHighlight[] = arr(marks.highlights).map((x) => {
    const h = obj(x);
    return {
      cfi: str(h.cfi),
      section: strOrNull(h.section),
      // NULLABLE BY MEASUREMENT: a spine-only cfi names a document and no position inside it.
      section_index: numOrNull(h.section_index),
      color: str(h.color, "amber"),
      text: strOrNull(h.text),
      chapter_label: strOrNull(h.chapter_label),
      created_at: numOrNull(h.created_at),
    };
  });
  const notes: ManifestNote[] = arr(marks.notes).map((x) => {
    const n = obj(x);
    const of = numOrNull(n.of_highlight);
    return {
      cfi: strOrNull(n.cfi),
      section: strOrNull(n.section),
      section_index: numOrNull(n.section_index),
      title: strOrNull(n.title),
      body: str(n.body),
      color: strOrNull(n.color),
      chapter_label: strOrNull(n.chapter_label),
      created_at: numOrNull(n.created_at),
      // An index into THIS manifest's highlights. One that points nowhere is dropped rather than kept
      // as a dangling number.
      of_highlight: of !== null && of >= 0 && of < highlights.length ? of : null,
    };
  });
  // THE PLACE ARRIVES WITH THE RULE, exactly as it does for a highlight or a note. Read back here or
  // it is lost: this reader rebuilds every row field by field rather than passing the parsed object
  // through, so a field it does not name is a field the receiver never sees. Measured — his map drew
  // his highlights and his notes at their chapters and his references and replacements nowhere at all,
  // while the sender's own map drew all four. A copy written before the place travelled carries
  // neither field, and those still arrive unplaced.
  const references: ManifestReference[] = arr(marks.references)
    .map((x) => {
      const r = obj(x);
      return {
        phrase: str(r.phrase),
        phrase_fold: str(r.phrase_fold),
        word_count: numOrNull(r.word_count) ?? 1,
        note: str(r.note),
        section: strOrNull(r.section),
        section_index: numOrNull(r.section_index),
      };
    })
    .filter((r) => r.phrase.length > 0);
  const replacements: ManifestReplacement[] = arr(marks.replacements)
    .map((x) => {
      const r = obj(x);
      return {
        phrase: str(r.phrase),
        phrase_fold: str(r.phrase_fold),
        word_count: numOrNull(r.word_count) ?? 1,
        replacement: str(r.replacement),
        section: strOrNull(r.section),
        section_index: numOrNull(r.section_index),
      };
    })
    .filter((r) => r.phrase.length > 0);

  const inscription = obj(o.inscription);
  const sender = obj(o.sender);
  const app = obj(o.app);

  return {
    ok: true,
    manifest: {
      deposit: o.deposit,
      created_at: numOrNull(o.created_at) ?? 0,
      app: { name: str(app.name, "Sard"), version: str(app.version) },
      sender: { name: str(sender.name) },
      book: {
        hash: book.hash,
        format: strOrNull(book.format),
        title: strOrNull(book.title),
        author: strOrNull(book.author),
        language: strOrNull(book.language),
        dir: strOrNull(book.dir),
        size_bytes: numOrNull(book.size_bytes) ?? 0,
        spine_count: numOrNull(book.spine_count),
        ...(typeof book.file === "string" ? { file: book.file } : {}),
        ...(typeof book.cover === "string" ? { cover: book.cover } : {}),
      },
      inscription: { text: str(inscription.text), signed: str(inscription.signed) },
      marks: { highlights, notes, references, replacements },
    },
  };
}

/** Everything the manifest carries, as the sheaf counts it. */
export const availableIn = (m: DepositManifest) => ({
  highlights: m.marks.highlights.length,
  notes: m.marks.notes.length,
  references: m.marks.references.length,
  replacements: m.marks.replacements.length,
});
