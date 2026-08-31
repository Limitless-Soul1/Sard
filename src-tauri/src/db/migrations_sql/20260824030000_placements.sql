-- ONE PLACEMENT PER BOOK.
--
-- Until now a book's arrangement lived in `book_collections`, whose primary key is the PAIR
-- (book_id, collection_id). That says a book may be filed on any number of shelves, each with its
-- own position, and every consumer had to decide for itself which of them was "the" home. They
-- decided differently: the flat views read the membership rows and never named a rule shelf, the
-- grouped views used whichever band drew the tile, and the drag engine used a third rule. The same
-- book therefore reported a different home, a different position and a different set of
-- destinations depending only on which format was looking at it.
--
-- This table answers the question once. The primary key is the BOOK, so a second manual home is not
-- something to be resolved — it is unrepresentable.
--
-- `container` is a `collections.id`, or the sentinel '__unshelved' — the same name the
-- interface has always used for the books on no shelf. Books on no shelf were previously
-- synthesised per render with their order kept in a settings key, outside the library and outside
-- any integrity constraint; measured on a real library, that key named five books out of thirty-nine
-- and three of the ids it did name were no longer unshelved. Unfiled is an ordinary container here.
--
-- `rank` is an ordering key: a marker digit saying how many base-62 integer digits follow, those
-- digits, then an optional base-62 fraction. Lexicographic order is numeric order, and SQLite's
-- default TEXT comparison, JavaScript's `<` and a byte comparison all agree — so the database, the
-- model and the screen produce one sequence without anyone re-sorting. Inserting between two books
-- writes ONE row instead of renumbering a shelf, which is what removes the pre/post-removal index
-- bridging where the off-by-one errors lived. See `src/features/library/design/rank.ts`.

CREATE TABLE placements (
  book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  container   TEXT NOT NULL,
  rank        TEXT NOT NULL,
  category_id TEXT REFERENCES collection_categories(id) ON DELETE SET NULL
);

CREATE INDEX idx_placements_container ON placements(container, rank);

-- Nothing is destroyed. A book filed on more than one hand shelf keeps every row it had, and so
-- does any row that was somehow written against a rule shelf; both are recorded here with the
-- reason they could not become the book's one placement, so the choice stays reviewable.
CREATE TABLE legacy_memberships (
  book_id       TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  position      INTEGER,
  category_id   TEXT,
  reason        TEXT NOT NULL,
  PRIMARY KEY (book_id, collection_id)
);

-- The digit alphabet, in ASCII order so that comparing text compares value.
CREATE TEMP TABLE _alphabet(chars TEXT NOT NULL);
INSERT INTO _alphabet(chars) VALUES ('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

-- 1 · WHICH CONTAINER EACH BOOK BELONGS TO.
--
-- The one manual shelf it sits on, or '__unshelved'. Where a book somehow sits on several, the tie is
-- broken the same way every time — lowest stored position, then the shelf made first, then its id —
-- so the migration is deterministic and re-runnable against a copy for comparison. A rule shelf is
-- never eligible: its contents are a query, so it owns nothing and can be nobody's home.
CREATE TEMP TABLE _chosen AS
SELECT
  b.id AS book_id,
  COALESCE((
    SELECT bc.collection_id
      FROM book_collections bc
      JOIN collections c ON c.id = bc.collection_id
     WHERE bc.book_id = b.id AND c.auto_rule IS NULL
     ORDER BY COALESCE(bc.position, 0), COALESCE(c.created_at, 0), c.id
     LIMIT 1
  ), '__unshelved') AS container
FROM books b;

-- 2 · THE REMEMBERED ORDER OF THE BOOKS ON NO SHELF, as it was kept in settings.
CREATE TEMP TABLE _remembered AS
SELECT je.value AS book_id, je.key AS at
  FROM settings s, json_each(s.value) je
 WHERE s.key = 'libd_loose_order' AND json_valid(s.value);

-- 3 · THE SEQUENCE THE READER CURRENTLY SEES, container by container.
--
-- This is the whole acceptance criterion of the migration: whatever order the app draws today, it
-- must draw tomorrow. So each container is ordered by exactly the rule that produces it now.
--
--   a hand shelf   `ORDER BY COALESCE(position, 0), book_id` — `shelf_items`, verbatim
--   unfiled        the remembered ids first, in their remembered order, then the rest by title
--
-- The title fallback is not a guess: `list_books` whitelists its sort column and falls through to
-- the effective title for every value it does not recognise — including "hand" — so the books the
-- remembered list never mentioned are, and have always been, in title order.
CREATE TEMP TABLE _seq AS
SELECT
  ch.book_id,
  ch.container,
  ROW_NUMBER() OVER (
    PARTITION BY ch.container
    ORDER BY
      CASE WHEN ch.container = '__unshelved'
           THEN COALESCE((SELECT r.at FROM _remembered r WHERE r.book_id = ch.book_id), 1000000000)
           ELSE COALESCE((SELECT bc.position FROM book_collections bc
                           WHERE bc.book_id = ch.book_id AND bc.collection_id = ch.container), 0)
      END,
      CASE WHEN ch.container = '__unshelved'
           THEN LOWER(COALESCE(
                  (SELECT value FROM metadata_overrides WHERE book_id = ch.book_id AND field = 'title'),
                  (SELECT title FROM books WHERE id = ch.book_id), ''))
           ELSE ''
      END,
      ch.book_id
  ) - 1 AS seq
FROM _chosen ch;

-- 4 · THE RANKS.
--
-- Sequence n becomes the whole number 62^4 + n, written as five base-62 digits behind the marker
-- '5'. Starting in the middle of a five-digit number rather than at zero leaves about fourteen
-- million whole numbers below the first book, so dropping something in front of everything never
-- needs the fraction. Five digits hold 916 million books per container.
INSERT INTO placements (book_id, container, rank, category_id)
SELECT
  s.book_id,
  s.container,
  '5'
    || substr(a.chars, ((14776336 + s.seq) / 14776336) % 62 + 1, 1)
    || substr(a.chars, ((14776336 + s.seq) / 238328)  % 62 + 1, 1)
    || substr(a.chars, ((14776336 + s.seq) / 3844)    % 62 + 1, 1)
    || substr(a.chars, ((14776336 + s.seq) / 62)      % 62 + 1, 1)
    || substr(a.chars,  (14776336 + s.seq)            % 62 + 1, 1),
  (SELECT bc.category_id FROM book_collections bc
    WHERE bc.book_id = s.book_id AND bc.collection_id = s.container)
FROM _seq s, _alphabet a;

-- 5 · EVERYTHING THE ONE-PLACEMENT RULE COULD NOT KEEP, preserved rather than dropped.
INSERT INTO legacy_memberships (book_id, collection_id, position, category_id, reason)
SELECT bc.book_id, bc.collection_id, bc.position, bc.category_id,
       CASE WHEN c.auto_rule IS NOT NULL
            THEN 'a membership row against a rule shelf, which owns nothing'
            ELSE 'a second manual shelf; the book keeps the first as its placement'
       END
  FROM book_collections bc
  JOIN collections c ON c.id = bc.collection_id
  LEFT JOIN _chosen ch ON ch.book_id = bc.book_id
 WHERE c.auto_rule IS NOT NULL
    OR ch.container IS NULL
    OR ch.container <> bc.collection_id;

-- 6 · THE OLD LOOSE ORDER IS SUPERSEDED, and renamed rather than deleted so it can still be read.
UPDATE settings SET key = 'libd_loose_order__superseded_by_placements'
 WHERE key = 'libd_loose_order';

DROP TABLE _seq;
DROP TABLE _remembered;
DROP TABLE _chosen;
DROP TABLE _alphabet;

-- `book_collections` is deliberately left in place and untouched. It stops being the arrangement and
-- becomes a record of what the arrangement was, which is the rollback path for one release.
