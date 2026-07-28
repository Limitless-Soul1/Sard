-- RAWY-260: REFERENCES — a persistent note attached to a WORD OR SHORT PHRASE, not to a location.
--
-- This is deliberately NOT a highlight, note, annotation or bookmark, and the schema says so: there is no
-- CFI here. A highlight belongs to one place in the text; a reference belongs to the *term itself*, so once
-- «كلاين» carries a reference, every occurrence of it in that book is marked — including ones written long
-- after the reference was created. That is why the row keys on the phrase, never on a position.
--
-- PER BOOK by construction: `book_id` is part of both the identity and the lookup index, so a reference made
-- in one book can never surface in another.
--
--   phrase       the text exactly as the reader selected it — shown in the dialog and the popup, never
--                normalised for display, so Arabic keeps its tashkīl and the reader sees what they typed.
--   phrase_fold  the MATCHING key: NFKC + tashkīl/tatweel stripped + alef/ya/teh-marbuta folded + lowercased
--                (the same folding the in-book search uses), so «الكلاين» and «كلاين» agree and Arabic
--                shaping is irrelevant to the comparison. Computed by the frontend, which owns that folding.
--   word_count   how many whitespace-separated tokens the phrase has. Kept so section matching can bucket
--                candidates by length and skip the multi-token scan entirely for single-word references —
--                the common case — instead of testing every phrase against every position.
--
-- UNIQUE(book_id, phrase_fold) makes the same term idempotent per book: re-referencing a phrase EDITS the
-- existing reference rather than creating a duplicate that would mark the same words twice.
CREATE TABLE IF NOT EXISTS refs (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  phrase      TEXT NOT NULL,
  phrase_fold TEXT NOT NULL,
  word_count  INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER,
  updated_at  INTEGER
);

-- The read path is always "every reference for the book I just opened", loaded once and held in memory for
-- per-section matching — so one composite index serves both the lookup and the uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_book_phrase ON refs(book_id, phrase_fold);
