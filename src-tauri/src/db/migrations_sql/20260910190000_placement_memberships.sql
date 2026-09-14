-- A BOOK MAY BE ON SEVERAL SHELVES AT ONCE.
--
-- `placements` was introduced with the BOOK as its primary key, and said so deliberately: "a second
-- manual home is not something to be resolved — it is unrepresentable". That was the right answer to
-- the problem in front of it. Membership had lived in `book_collections`, whose key is the PAIR, and
-- every consumer decided for itself which of a book's shelves was "the" home — the flat views read
-- the membership rows, the grouped views used whichever band drew the tile, and the drag engine used
-- a third rule. Measured on a real library, one book reported «outside every shelf» in Grid and «قيد
-- القراءة» in Covers, and was offered forty-two destinations in one and six in the other. Collapsing
-- to one placement made the disagreement impossible.
--
-- WHAT CHANGED IS THE REQUIREMENT, NOT THE DIAGNOSIS. A reader wants one book to sit on «روايات
-- عربية» and on «المفضلة» and on «هذا الأسبوع» at the same time, and to see it in all three. So the
-- ambiguity has to be answered rather than outlawed — and it is answered by SCOPE, which the older
-- model did not have: a shelf shows its own memberships, and the root library shows canonical books
-- once, ordered by `view_orders`, which has no container column and so cannot re-file anything.
--
-- The columns were already right. `container`, `rank` and `category_id` have always been per-row, so
-- shelf-local ordering and shelf-local categories already work exactly as multi-membership needs.
-- Only the primary key forbade the second row. Widening it to the pair is therefore the whole schema
-- change, and it brings duplicate prevention with it: (book, shelf) twice is now unrepresentable, in
-- the database rather than in a frontend check.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not create a single new membership. Every library that
-- goes through it comes out with exactly the rows it went in with — one placement per book — so the
-- application behaves identically the moment it is applied. This changes what the schema PERMITS.
-- Nothing writes a second membership until the model and the interface are ready to read one, which
-- is the point of doing it in this order: the database can never be ahead of the code that reads it.

-- SQLite cannot alter a primary key, so the table is rebuilt. Nothing in the schema references
-- `placements` as a parent — its two foreign keys both point outward, at `books` and at
-- `collection_categories` — so this is safe with `foreign_keys = ON`, which is how the connection is
-- opened and which a migration running inside a transaction cannot change anyway.

CREATE TEMP TABLE _before AS SELECT COUNT(*) AS n FROM placements;

CREATE TABLE placements_new (
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  container   TEXT NOT NULL,
  rank        TEXT NOT NULL,
  category_id TEXT REFERENCES collection_categories(id) ON DELETE SET NULL,
  -- ONE ROW PER BOOK PER CONTAINER. The book may repeat; the pair may not.
  PRIMARY KEY (book_id, container)
);

INSERT INTO placements_new (book_id, container, rank, category_id)
SELECT book_id, container, rank, category_id FROM placements;

DROP TABLE placements;
ALTER TABLE placements_new RENAME TO placements;

-- The read every container does: its books, in order.
CREATE INDEX idx_placements_container ON placements(container, rank);
-- The read multi-membership adds: everywhere one book is. Without it, "which shelves is this on"
-- is a scan, and the interface asks it once per tile.
CREATE INDEX idx_placements_book ON placements(book_id);

-- NOT ONE ROW MAY BE LOST. A rebuild that silently dropped placements would scatter a library's
-- arrangement with no way back, so the count is checked against itself and a mismatch fails the
-- CHECK — which aborts the migration's transaction and leaves the old table exactly as it was.
CREATE TEMP TABLE _guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _guard(ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM placements) = (SELECT n FROM _before) THEN 1 ELSE 0 END;

DROP TABLE _guard;
DROP TABLE _before;
