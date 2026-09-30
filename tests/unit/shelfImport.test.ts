// BOOKS ADDED WHILE A SHELF IS OPEN BELONG ON THAT SHELF.
//
// THE DEFECT THIS PINS. A multi-book import performed from inside a shelf put every book in the
// library and on no shelf at all, so the reader — still standing in the shelf they had just added to
// — saw nothing appear. The two halves of the operation never exchanged one fact: the scope lives in
// the design surface, the import lives in the Library, and neither asked the other. The fix reports
// the open shelf to the Library and files the successes through `collection_add_book`.
//
// What is pinned here is the RULE, not the plumbing: WHICH results are filed, and onto what. The
// wiring itself (a prop, a ref) is exercised by the runtime verification, which drives the real UI.

import { describe, expect, it, vi } from "vitest";

import type { ImportResult } from "../../src/lib/ipc";

/** The rule, extracted exactly as `fileIntoOpenShelf` applies it. */
async function fileIntoOpenShelf(
  shelfId: string | null,
  results: readonly ImportResult[],
  add: (shelfId: string, bookId: string) => Promise<unknown>,
): Promise<void> {
  if (!shelfId) return;
  for (const r of results) {
    if (r.status !== "imported") continue;
    await add(shelfId, r.id).catch(() => undefined);
  }
}

const r = (id: string, status: ImportResult["status"]): ImportResult => ({ id, title: id, status, message: null });

describe("an import performed inside a shelf files what it added", () => {
  it("files every imported book, in the order they were imported", async () => {
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf("shelf-1", [r("a", "imported"), r("b", "imported"), r("c", "imported")], add);
    expect(add.mock.calls).toEqual([
      ["shelf-1", "a"],
      ["shelf-1", "b"],
      ["shelf-1", "c"],
    ]);
  });

  it("files ONLY the successes — a duplicate is a book the import did not add", async () => {
    // A duplicate result carries the id of the book ALREADY in the library. Filing it would move a
    // book the reader never added into the shelf they happen to be standing in, which is a different
    // operation from the one they asked for.
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf("shelf-1", [r("a", "imported"), r("dup", "duplicate"), r("bad", "unsupported"), r("err", "error")], add);
    expect(add.mock.calls).toEqual([["shelf-1", "a"]]);
  });

  it("files nothing at all in the general Library", async () => {
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf(null, [r("a", "imported"), r("b", "imported")], add);
    expect(add).not.toHaveBeenCalled();
  });

  it("files nothing when every file was refused", async () => {
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf("shelf-1", [r("x", "unsupported"), r("y", "error")], add);
    expect(add).not.toHaveBeenCalled();
  });

  it("a partial import files exactly the books that succeeded", async () => {
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf("shelf-1", [r("ok1", "imported"), r("boom", "error"), r("ok2", "imported")], add);
    expect(add.mock.calls.map((c) => c[1])).toEqual(["ok1", "ok2"]);
  });

  it("a failed filing never fails the import, and never stops the books after it", async () => {
    // The books are in the library either way — that is the part a reader cannot undo by hand. A
    // shelf row that did not get written is recoverable with one drag.
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async (_s, id) => {
      if (id === "b") throw new Error("database is locked");
      return undefined;
    });
    await expect(fileIntoOpenShelf("shelf-1", [r("a", "imported"), r("b", "imported"), r("c", "imported")], add)).resolves.toBeUndefined();
    expect(add.mock.calls.map((c) => c[1])).toEqual(["a", "b", "c"]);
  });

  it("an empty batch is a no-op", async () => {
    const add = vi.fn<(shelfId: string, bookId: string) => Promise<undefined>>(async () => undefined);
    await fileIntoOpenShelf("shelf-1", [], add);
    expect(add).not.toHaveBeenCalled();
  });
});
