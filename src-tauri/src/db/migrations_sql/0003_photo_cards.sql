-- Photo Mode part 2a (RAWY-52): saved photo cards. Each row is one card the user chose to
-- "Save in app"; the rendered PNG lives at app_data/photocards/<id>.png. Cross-book, like the
-- highlights/notes inbox — the gallery lists these newest-first.
CREATE TABLE IF NOT EXISTS photo_cards (
    id            TEXT PRIMARY KEY,
    book_id       TEXT,
    book_title    TEXT,
    chapter_label TEXT,
    cfi           TEXT,
    format        TEXT,
    theme_id      TEXT,
    quote         TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_cards_created ON photo_cards (created_at DESC);
