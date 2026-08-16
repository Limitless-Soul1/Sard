-- Library structure: cases above shelves, categories inside them, and an explicit
-- hand order for shelf membership.
--
-- Everything here is ADDITIVE. `collections` remains the shelf table it has always been,
-- so every existing shelf, every membership row and every surface that reads them
-- (the mobile library, the book edit dialog, `collections_for_book`) keeps working
-- untouched. A library that never opens the new views is unchanged by this migration.

-- A case groups shelves. A shelf with no case reads as loose and is shown on its own.
CREATE TABLE IF NOT EXISTS cases (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  ink        TEXT,              -- the case's accent, as authored; NULL = derive from the theme
  sort_order INTEGER,
  created_at INTEGER
);

-- Shelves learn four things: which case holds them, how their contents are ordered,
-- whether membership is manual or derived from a rule, and whether they are collapsed.
--
-- SQLite permits a REFERENCES clause on ADD COLUMN only when the default is NULL, which
-- is exactly what an un-cased shelf means, so the two agree by construction.
ALTER TABLE collections ADD COLUMN case_id    TEXT REFERENCES cases(id) ON DELETE SET NULL;
ALTER TABLE collections ADD COLUMN order_rule TEXT;    -- NULL = 'hand'; else title|author|added|recent|progress
ALTER TABLE collections ADD COLUMN auto_rule  TEXT;    -- NULL = manual membership; else reading|finished|added
ALTER TABLE collections ADD COLUMN collapsed  INTEGER; -- 1 = collapsed to a spine strip

-- Optional named groups WITHIN one hand-ordered shelf.
CREATE TABLE IF NOT EXISTS collection_categories (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  sort_order    INTEGER,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

-- Membership gains its place in the hand order and its category.
-- `category_id` is nulled rather than cascaded when a category is deleted: removing a
-- grouping must never remove the books that were grouped by it.
ALTER TABLE book_collections ADD COLUMN position    INTEGER;
ALTER TABLE book_collections ADD COLUMN category_id TEXT REFERENCES collection_categories(id) ON DELETE SET NULL;

-- Give the books already on a shelf a deterministic starting order, so a shelf that is
-- switched to hand ordering opens in a stable arrangement instead of an arbitrary one.
-- Counting lesser book_ids yields a dense 0..n-1 per shelf in one statement.
UPDATE book_collections
   SET position = (
     SELECT COUNT(*) FROM book_collections x
      WHERE x.collection_id = book_collections.collection_id
        AND x.book_id < book_collections.book_id
   )
 WHERE position IS NULL;

CREATE INDEX IF NOT EXISTS idx_collections_case   ON collections(case_id);
CREATE INDEX IF NOT EXISTS idx_categories_shelf   ON collection_categories(collection_id);
CREATE INDEX IF NOT EXISTS idx_book_collections_c ON book_collections(collection_id, position);
