-- REPLACEMENTS — a reading-time substitution of one word or short phrase, scoped to ONE book.
--
-- A sibling of `refs`, and deliberately shaped like it: the row keys on the PHRASE, never on a
-- position, so it survives re-pagination, a font change and a re-import. What it is NOT is an
-- annotation: it has no cfi, no colour and no anchor, because it applies wherever the phrase occurs
-- rather than at one place.
--
--   phrase       exactly as the reader typed or selected it — shown verbatim in the editor.
--   phrase_fold  the MATCHING key: NFKC, tashkil/tatweel stripped, alef/ya/teh-marbuta folded,
--                lowercased, whitespace collapsed. Computed by the frontend, which owns that folding
--                (`src/lib/references.ts`), so both features compare words the same way.
--   replacement  what the reader wants to read instead. Stored verbatim; never folded.
--   word_count   whitespace-separated tokens in the phrase, so section matching can skip the
--                multi-token scan for the common single-word case — the same trick `refs` uses.
--   enabled      1 while the substitution is in force. Turning it off must restore the author's
--                wording exactly, so this is a switch and NOT a delete: the row survives untouched.
--
-- PER BOOK by construction: `book_id` is part of both the identity and the lookup index, so the same
-- word may read differently in two books and neither knows about the other.
--
-- THE BOOK FILE IS NEVER TOUCHED. This table is the whole of the feature's persistence; the EPUB on
-- disk, the stored annotations and their CFIs are all left exactly as they were.
CREATE TABLE IF NOT EXISTS reps (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  phrase       TEXT NOT NULL,
  phrase_fold  TEXT NOT NULL,
  replacement  TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER,
  updated_at   INTEGER
);

-- One rule per phrase per book — the same composite key serves the uniqueness rule and the per-book
-- lookup that runs on every section render.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reps_book_phrase ON reps(book_id, phrase_fold);
