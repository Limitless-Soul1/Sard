-- TRANSLATION EDITIONS — a book's translation, stored so it can be made, resumed, explained and removed
-- without touching the book or anything the reader has built on it.
--
-- ADDITIVE ONLY: six new tables, and NOT ONE existing table or column is altered. The migration stands on
-- its own: it needs only `books`, which migration 1 created.
--
-- ONE EDGE TO THE REST OF THE LIBRARY. Only `translation_editions` carries `book_id`; every other table here
-- cascades from an edition. Deleting a book therefore removes exactly its editions and their rows, and
-- deleting an edition removes exactly its own — never another book's, and never a reading, note, highlight or
-- bookmark row. A book's id is the SHA-256 of its bytes, so an edition is bound to the exact source it was
-- made from, and replacing a damaged copy with the same bytes keeps it.
--
-- THE READER-SAFETY RULES ARE STRUCTURAL. A FAILED paragraph has no text and no final candidate; a REVIEW or
-- SECOND paragraph keeps its review reason, and no other status has one. The CHECKs below refuse any row that
-- would break that, whatever code writes it.

-- One row per edition: everything that decides its output besides its inputs, and the identity of both.
CREATE TABLE IF NOT EXISTS translation_editions (
  id               TEXT PRIMARY KEY,
  book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source_lang      TEXT NOT NULL,
  target_lang      TEXT NOT NULL,
  target_dir       TEXT NOT NULL CHECK (target_dir IN ('ltr', 'rtl')),
  model_id         TEXT NOT NULL,
  model_sha256     TEXT NOT NULL,
  runtime_id       TEXT NOT NULL,
  runtime_sha256   TEXT NOT NULL,
  execution        TEXT NOT NULL CHECK (execution IN ('gpu', 'cpu')),
  execution_detail TEXT NOT NULL,          -- JSON: {"device": "..."} or {"threads": n}
  launch_flags     TEXT NOT NULL,          -- JSON array: the engine flags the model runs with
  pipeline_id      TEXT NOT NULL,
  implementation_sha256 TEXT NOT NULL,     -- the fingerprint of the translation code of the build that made it
  profile_k        REAL NOT NULL,
  extraction_id    TEXT NOT NULL,          -- how paragraphs and sentences were taken from the book
  webview_version  TEXT NOT NULL,          -- the WebView2 runtime that took them
  app_build        TEXT NOT NULL,
  manifest_sha256  TEXT NOT NULL,          -- every section and paragraph input, in order
  identity_sha256  TEXT NOT NULL,          -- every translation-affecting input and setting
  mixing_approved  INTEGER NOT NULL DEFAULT 0 CHECK (mixing_approved IN (0, 1)),
  state            TEXT NOT NULL CHECK (state IN ('ready', 'running', 'stopped', 'complete')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translation_editions_book ON translation_editions(book_id);

-- The book's sections as the extraction saw them.
CREATE TABLE IF NOT EXISTS translation_sections (
  edition_id    TEXT NOT NULL REFERENCES translation_editions(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL CHECK (section_index >= 0),
  href          TEXT NOT NULL,
  linear        INTEGER NOT NULL CHECK (linear IN (0, 1)),
  content_type  TEXT NOT NULL,
  leaves        INTEGER NOT NULL CHECK (leaves >= 0),
  dropped_empty INTEGER NOT NULL CHECK (dropped_empty >= 0),
  body_fallback INTEGER NOT NULL CHECK (body_fallback IN (0, 1)),
  PRIMARY KEY (edition_id, section_index)
);

-- Every paragraph's exact input, frozen when the edition is made: translation and resume read only these.
CREATE TABLE IF NOT EXISTS translation_paragraphs (
  edition_id       TEXT NOT NULL,
  section_index    INTEGER NOT NULL,
  ordinal          INTEGER NOT NULL CHECK (ordinal >= 0),
  path             TEXT NOT NULL,          -- JSON array of child-element indices from <body>
  tag              TEXT NOT NULL,
  atoms            TEXT NOT NULL,          -- JSON object of counts of the inline elements inside it
  source_text      TEXT NOT NULL,
  source_sha256    TEXT NOT NULL,
  sentences        TEXT NOT NULL,          -- JSON array of strings: the pipeline's input
  sentences_sha256 TEXT NOT NULL,
  input_state      TEXT NOT NULL CHECK (input_state IN ('ok', 'contract')),
  input_detail     TEXT,
  CHECK ((input_state = 'ok') = (input_detail IS NULL)),
  PRIMARY KEY (edition_id, section_index, ordinal),
  UNIQUE (edition_id, section_index, ordinal, input_state),   -- what a result's key names: only an 'ok' paragraph
  FOREIGN KEY (edition_id, section_index)
    REFERENCES translation_sections(edition_id, section_index) ON DELETE CASCADE
);

-- One row per run of the engine over an edition, with what it ran with.
CREATE TABLE IF NOT EXISTS translation_sessions (
  id               TEXT PRIMARY KEY,
  edition_id       TEXT NOT NULL REFERENCES translation_editions(id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  end_reason       TEXT CHECK (end_reason IN ('complete', 'cancelled', 'engine', 'interrupted')),
  model_sha256     TEXT NOT NULL,
  runtime_sha256   TEXT NOT NULL,
  execution        TEXT NOT NULL,
  execution_detail TEXT NOT NULL,
  implementation_sha256 TEXT NOT NULL,
  app_build        TEXT NOT NULL,
  engine_info      TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  UNIQUE (edition_id, id)               -- lets a result name a session of ITS OWN edition, structurally
);
CREATE INDEX IF NOT EXISTS idx_translation_sessions_edition ON translation_sessions(edition_id);

-- One row per translated paragraph, written whole in one transaction: its status never exists without its data.
CREATE TABLE IF NOT EXISTS translation_results (
  edition_id     TEXT NOT NULL,
  section_index  INTEGER NOT NULL,
  ordinal        INTEGER NOT NULL,
  -- A RESULT EXISTS ONLY FOR A PARAGRAPH THAT PASSED THE INPUT RULES. The key below names the paragraph WITH
  -- its verdict, and this column can only say 'ok': a result for a rejected paragraph finds no row to point at,
  -- and the verdict of a paragraph that has a result cannot change under it.
  input_state    TEXT NOT NULL DEFAULT 'ok' CHECK (input_state = 'ok'),
  session_id     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('OK', 'RECOVERED', 'SECOND', 'REVIEW', 'FAILED')),
  text           TEXT,
  final_kind     TEXT,
  why_review     TEXT,
  outcome_json   TEXT NOT NULL,
  outcome_schema INTEGER NOT NULL,
  took_ms        INTEGER NOT NULL CHECK (took_ms >= 0),
  created_at     INTEGER NOT NULL,
  CHECK ((status = 'FAILED') = (text IS NULL)),
  CHECK ((status = 'FAILED') = (final_kind IS NULL)),
  CHECK ((status IN ('REVIEW', 'SECOND')) = (why_review IS NOT NULL)),
  CHECK (length(CAST(outcome_json AS BLOB)) <= 1048576),   -- the stored detail's bound, in bytes (1 MiB)
  PRIMARY KEY (edition_id, section_index, ordinal),
  FOREIGN KEY (edition_id, section_index, ordinal, input_state)
    REFERENCES translation_paragraphs(edition_id, section_index, ordinal, input_state) ON DELETE CASCADE,
  FOREIGN KEY (edition_id, session_id) REFERENCES translation_sessions(edition_id, id) ON DELETE CASCADE
);

-- Attempts that produced no result. Never a status, and never a request's or an answer's text.
CREATE TABLE IF NOT EXISTS translation_failures (
  edition_id    TEXT NOT NULL REFERENCES translation_editions(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('input', 'engine')),
  detail        TEXT NOT NULL,
  at            INTEGER NOT NULL,
  FOREIGN KEY (edition_id, section_index, ordinal)
    REFERENCES translation_paragraphs(edition_id, section_index, ordinal) ON DELETE CASCADE,
  FOREIGN KEY (edition_id, session_id) REFERENCES translation_sessions(edition_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_translation_failures_edition ON translation_failures(edition_id);
