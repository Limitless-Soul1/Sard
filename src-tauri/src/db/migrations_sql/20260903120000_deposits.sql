-- READING DEPOSITS — what arrived, and which marks came with it.
--
-- ADDITIVE ONLY, per the project invariant: two new tables, and NOT ONE COLUMN is added to
-- `highlights`, `notes`, `refs` or `reps`. A deposit changes nothing about how an annotation is
-- stored; it only records where one came from.

-- One row per deposit that has been ACCEPTED.
--
-- The id is the SHA-256 of the manifest bytes, which makes re-importing the same file detectable
-- rather than duplicative: the second import finds the row and applies nothing. It is also why the
-- manifest is hashed exactly as it was read, before any parsing — two readers of the same file must
-- agree on its identity.
--
-- `sender` and `inscription` are kept because the archive shows them beside the marks later. They are
-- the sender's own words, typed by them; no account, no machine, no path is recorded here.
CREATE TABLE IF NOT EXISTS deposits (
  id          TEXT PRIMARY KEY,
  book_id     TEXT REFERENCES books(id) ON DELETE CASCADE,
  sender      TEXT,
  inscription TEXT,
  signed      TEXT,
  created_at  INTEGER,   -- when the sender bound it, from the manifest
  received_at INTEGER    -- when it was accepted here
);

-- WHERE A MARK CAME FROM.
--
-- Polymorphic BY DESIGN: four annotation tables, one attribution table, and no foreign key to any of
-- them — the same shape `note_tags` uses to guarantee that deleting a tag can never touch a note.
-- Deleting a mark leaves a row here naming an id nothing holds, which is harmless; and because every
-- id in Sard is derived from its content, recreating the same mark correctly recovers its attribution.
-- Deleting the BOOK cascades `deposits`, which cascades this.
CREATE TABLE IF NOT EXISTS mark_origin (
  kind       TEXT NOT NULL,   -- 'highlight' | 'note' | 'ref' | 'rep'
  mark_id    TEXT NOT NULL,
  deposit_id TEXT NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, mark_id)
);

CREATE INDEX IF NOT EXISTS idx_mark_origin_deposit ON mark_origin(deposit_id);
CREATE INDEX IF NOT EXISTS idx_deposits_book ON deposits(book_id);
