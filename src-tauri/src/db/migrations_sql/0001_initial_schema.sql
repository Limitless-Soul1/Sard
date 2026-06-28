-- eRawy schema v1 (RAWY-08). Tables per PROJECT.md §5 (data model).
-- foreign_keys is enabled per-connection (see db::open_database). Book-owned child
-- rows cascade on book deletion; a note's optional highlight link is nulled if the
-- highlight is removed.

CREATE TABLE books (
  id             TEXT PRIMARY KEY,
  file_path      TEXT NOT NULL,
  file_hash      TEXT,
  format         TEXT,            -- 'epub' | 'pdf' | ...
  title          TEXT,
  author         TEXT,
  language       TEXT,
  dir            TEXT,            -- 'ltr' | 'rtl'
  cover_path     TEXT,
  size_bytes     INTEGER,
  added_at       INTEGER,
  last_opened_at INTEGER
);

-- User edits stored as overrides instead of rewriting the source file.
CREATE TABLE metadata_overrides (
  book_id TEXT NOT NULL,
  field   TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (book_id, field),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER,
  created_at INTEGER
);

CREATE TABLE book_collections (
  book_id       TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  PRIMARY KEY (book_id, collection_id),
  FOREIGN KEY (book_id)       REFERENCES books(id)       ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

-- One row per book (exact resume position via CFI locator).
CREATE TABLE reading_progress (
  book_id     TEXT PRIMARY KEY,
  locator_cfi TEXT,
  fraction    REAL,
  updated_at  INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- chapter_label denormalized for a cheap global cross-book inbox.
CREATE TABLE highlights (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  start_cfi     TEXT,
  end_cfi       TEXT,
  color         TEXT,
  text_excerpt  TEXT,
  chapter_label TEXT,
  created_at    INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  highlight_id  TEXT,            -- optional link to a highlight
  locator_cfi   TEXT,
  color         TEXT,
  body          TEXT,
  chapter_label TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  FOREIGN KEY (book_id)      REFERENCES books(id)      ON DELETE CASCADE,
  FOREIGN KEY (highlight_id) REFERENCES highlights(id) ON DELETE SET NULL
);

CREATE TABLE bookmarks (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL,
  locator_cfi TEXT,
  label       TEXT,
  created_at  INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- Cached, computed-once-on-import locator/TOC index (keeps large books cheap to reopen).
CREATE TABLE book_index (
  book_id                TEXT PRIMARY KEY,
  toc_json               TEXT,
  section_fractions_json TEXT,
  built_at               INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE custom_fonts (
  id          TEXT PRIMARY KEY,
  family_name TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  script      TEXT,             -- 'arabic' | 'latin' | ...
  added_at    INTEGER
);

-- Indexes for the global cross-book inbox queries (cheap, harmless).
CREATE INDEX idx_highlights_book ON highlights(book_id);
CREATE INDEX idx_notes_book      ON notes(book_id);
CREATE INDEX idx_bookmarks_book  ON bookmarks(book_id);
