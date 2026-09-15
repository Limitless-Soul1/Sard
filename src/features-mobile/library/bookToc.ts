// HOW MANY CHAPTERS A BOOK HAS, asked of the book itself.
//
// C5 writes "Contents · 14 chapters" beside the row that opens them, and the library has no such
// column — the count is not stored anywhere, because until now only the READER ever needed it. It is
// not approximated here either: the number is `book.toc.length`, the same table of contents the reader
// draws its Contents tab from, read from the same vendored parser.
//
// MEASURED on a real book (انتفاضة الحمر, 1.2 MB, 54 spine sections): 53 TOC entries with labels. The
// spine is not the answer — it counts front matter, covers and split files that no reader would call
// chapters — so the TOC is what the design's number means.
//
// IT IS LAZY AND CACHED, because it costs an unzip. Nothing asks for it until a book sheet opens, and
// once asked the answer is kept for the session: a reader who opens the same sheet twice pays once.
// A failure is not an error the reader should see — the row simply carries no count, which is honest,
// rather than a zero, which would be a lie about a book that certainly has chapters.
//
// foliate-js lives in `public/` and is loaded as a RAW module (Vite's import analysis rejects importing
// from /public), which is why the import carries `@vite-ignore` — the same route `FoliateController`
// takes with its script tag, for the same reason.

import { convertFileSrc } from "@tauri-apps/api/core";

const cache = new Map<string, number | null>();
const inflight = new Map<string, Promise<number | null>>();

/** The book's chapter count, or null when it cannot be read. Cached per book for the session. */
export function chapterCount(bookId: string, filePath: string): Promise<number | null> {
  const hit = cache.get(bookId);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(bookId);
  if (running) return running;

  const job = (async () => {
    try {
      const res = await fetch(convertFileSrc(filePath));
      const blob = await res.blob();
      const file = new File([blob], filePath.split(/[\\/]/).pop() ?? "book.epub");
      // The path is built at runtime so TypeScript does not try to resolve a module that lives in
      // `public/` and has no types — the same reason the controller loads foliate through a script tag.
      const url = "/foliate-js/view.js";
      const mod = (await import(/* @vite-ignore */ url)) as {
        makeBook: (f: File) => Promise<{ toc?: { label?: string }[] }>;
      };
      const book = await mod.makeBook(file);
      const n = Array.isArray(book?.toc) ? book.toc.length : null;
      cache.set(bookId, n);
      return n;
    } catch {
      cache.set(bookId, null);
      return null;
    } finally {
      inflight.delete(bookId);
    }
  })();

  inflight.set(bookId, job);
  return job;
}
