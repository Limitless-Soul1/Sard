// «تنسيق الكتاب» — whether ONE book is shown in its own formatting or in Sard's reading style.
//
//   on (the default)  the book's own stylesheet applies, through the sanitiser's `sanitised` table: its
//                     centring, heading sizes, bold and italic, rules and frames, faded labels. The reader
//                     still owns the text size, the faces, the leading, the page's margins and its paper.
//   off               the book's stylesheet is emptied (`off`), and the page is Sard's reading style alone —
//                     what every book looked like before this switch existed.
//
// A PREFERENCE, not a correctness rule: the owner chose «on» for every book (2026-11-21), as other
// reading apps do, with this per-book way back for a book whose own formatting reads badly. A deliberate
// redesign changes the default here and in `tests/unit/bookCss.test.ts`.
//
// Stored as `book_css:<bookId>`: absent while on, `off` when turned off. (Not `book_style:<id>`, which is
// the removed per-book style layer — see `perBookSettings.ts` — and may still hold old rows. Nor the
// app-wide `book_css` row of `reader-engine/bookCssSetting.ts`, which nothing ever wrote and the reader no
// longer reads.)
//
// The mode reaches the engine through `ctrl.open()`'s options, so the reader host on Linux and WebKit,
// which runs its own copy of the engine, gets the same answer as the direct path.

import { settingsGet, settingsSet } from "../../lib/ipc";
import type { BookCssMode } from "../../reader-engine/cssSanitiser";

export const bookCssKey = (bookId: string): string => `book_css:${bookId}`;

/** Only an EPUB's stylesheets pass through the engine's filter, so only an EPUB is offered the switch. */
export function takesBookCss(book: { format?: string | null; filePath: string }): boolean {
  return (book.format ?? "").toLowerCase() === "epub" || /\.epub$/i.test(book.filePath);
}

/** True when the book wears its own formatting. Anything but an explicit `off` reads as on. */
export function parseBookCss(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "off";
}

/** What the engine's stylesheet hook applies for this switch. */
export function bookCssMode(on: boolean): BookCssMode {
  return on ? "sanitised" : "off";
}

/** Read one book's switch. A failed read is the default: the book's own formatting. */
export async function loadBookCss(bookId: string): Promise<boolean> {
  return parseBookCss(await settingsGet(bookCssKey(bookId)).catch(() => null));
}

/** Store one book's switch. On is stored as the empty value, so a book left on holds no row's worth of meaning. */
export async function saveBookCss(bookId: string, on: boolean): Promise<void> {
  await settingsSet(bookCssKey(bookId), on ? "" : "off").catch(() => {});
}
