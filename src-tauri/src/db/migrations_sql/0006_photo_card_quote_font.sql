-- RAWY-81 (#1): the photo-card quote gets its OWN font, chosen independently of the book's font.
-- Stored as a font KEY (a built-in family key like 'literata'/'amiri' or an imported family name);
-- NULL = follow the book's script font (Amiri for Arabic, Literata for Latin) — the prior behavior,
-- so every existing card renders exactly as before.
ALTER TABLE photo_cards ADD COLUMN quote_font TEXT;
