-- HOW BOOKS READ IN A VIEW, WHICH IS NOT WHERE THEY BELONG.
--
-- `placements` answers one question: which container owns this book. It answered a second one as
-- well — what order the books are in — and the two came apart badly, because a flat view has to
-- draw several containers as one sequence. Grid concatenated them, so the first visible slot was
-- «To read»'s and the last was the end of the unshelved run. Dragging a book from the top of the
-- library to the bottom therefore FILED it: measured on a real library, «وُضع على خارج الأرفف»,
-- persisted, with the book's container genuinely changed. The reader had asked to reorder.
--
-- So ordering moves here, and membership stays where it is. The important property of this table is
-- what it does NOT have: no container column, no shelf column, nothing that could file a book. A
-- reorder cannot change membership because there is nowhere to write it.
--
-- ── THE KEY ─────────────────────────────────────────────────────────────────────────────────
--
--   format   grid | details | covers | spines | vista
--            The five formats keep independent orders on purpose. The same books, arranged one way
--            in Covers and another in Grid, are two answers to two different questions.
--
--   scope    the MOST SPECIFIC part of where the reader is standing: the category if they are in
--            one, else the shelf, else the cabinet, else '' for the library root.
--
--            Not the full `case|shelf|category` triple the navigation serialises. A shelf id is
--            already unique, so keying on the triple would put a shelf's order under its cabinet —
--            and moving that shelf to another cabinet would silently orphan the order the reader
--            had made. The most specific component survives re-parenting.
--
--   section  what the reader rearranges as one block. In the flat formats there is one run and this
--            is '*'. In the grouped formats it is the id of the SHELF SECTION as drawn — which may
--            be a rule shelf: measured inside one cabinet, Covers drew a rule-shelf section whose
--            eighteen tiles were every one of them owned by another container. A section is
--            therefore not a container, and this column must not be confused with one.
--
-- ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
--
-- No backfill. A run with no rows is not an error: it means "never arranged", and it is drawn in
-- the order it is drawn today, from `placements.rank`. Rows appear the first time a reader arranges
-- a run, and then for that run only. Nothing changes on upgrade, and dropping this table restores
-- the previous behaviour exactly — which is the rollback.
--
-- `placements.rank` keeps its meaning as the DEFAULT order: the sequence books arrived in. What
-- changes is that Manual Ordering stops writing it. Reading it as a starting point carries none of
-- the risk that writing it did.

CREATE TABLE view_orders (
  format  TEXT NOT NULL,
  scope   TEXT NOT NULL,
  section TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  rank    TEXT NOT NULL,
  PRIMARY KEY (format, scope, section, book_id)
) WITHOUT ROWID;

-- One screen is one query. A grouped format draws every section of a scope at once, so the index
-- has to serve «all the sections of this scope, each already in order» without a query per section —
-- that N+1 is exactly the shape this is written to avoid.
CREATE INDEX idx_view_orders_run ON view_orders(format, scope, section, rank);

-- A book deleted takes its orders with it (the foreign key above). A run whose shelf is deleted is
-- swept when the shelf goes; see `view_order::forget_section`.
