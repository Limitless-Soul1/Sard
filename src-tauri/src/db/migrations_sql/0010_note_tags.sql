-- RAWY-203: custom note tags (many-to-many, shared across all books).
--
-- PURELY ADDITIVE: this migration only CREATEs new tables/indexes. It NEVER alters or drops the
-- existing `notes` table (or any other) — an existing note with no tags is completely unaffected.
-- Idempotent (IF NOT EXISTS + the runner's version gate), transactional (the runner wraps each
-- migration in a txn), recorded in schema_migrations.
--
-- Tags are SHARED and unique by name: `tags.name` is UNIQUE, so `شخصيات` is one tag reused by notes in
-- any book. A tag is created inline while writing a note (INSERT-or-reuse on the name).
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER
);

-- The many-to-many link. BOTH foreign keys are ON DELETE CASCADE, and BOTH act on the JOIN row only:
--   * note_id -> notes(id): deleting a NOTE removes that note's links (no orphan join rows).
--   * tag_id  -> tags(id):  deleting a TAG removes the links referencing it — and because the `notes`
--                           table has NO foreign key to `tags`, deleting a tag can NEVER touch a note.
-- So "deleting a tag keeps the notes" is guaranteed by the ABSENCE of a notes->tags relationship, not
-- merely by cascade config. The composite PK dedupes a (note, tag) pair (idempotent tagging).
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag_id  TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
);

-- The Inbox filter groups by tag; the note-editor loads a note's tags — index both directions.
CREATE INDEX IF NOT EXISTS idx_note_tags_tag  ON note_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);
