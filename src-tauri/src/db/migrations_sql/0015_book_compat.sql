-- RESILIENCE-1 / WP-2 — what the compatibility layer learned about each book.
--
-- ADDITIVE ONLY, per the project invariant: every migration since 0001 adds tables or nullable
-- columns, and a shipped migration is never edited. Five nullable columns, no data rewritten here —
-- existing rows keep every value they had, and the code backfill (migration 16) fills these in
-- separately so a failure there can never leave the schema half-applied.
--
-- NULL means "not examined yet" for every column below, which is exactly the state of every row
-- that existed before this shipped. No default is given, deliberately: a `0` default on the two
-- flags would be a claim ("this book is fine") that nothing has actually checked.

-- Who produced the file: dc:contributor[role=bkp], or 'calibre' inferred from its own meta stamp.
-- This is what makes every other recovery rule safe to apply — see books/compat.rs.
ALTER TABLE books ADD COLUMN producer TEXT;

-- The script the CONTENT is actually in ('arabic' | 'latin'), from the RAWY-189 sample. Recorded
-- separately from `language` so a mis-declared book keeps BOTH facts: what it claimed, and what it
-- is. 3 of the 15 corpus books declare `en` over Arabic content.
ALTER TABLE books ADD COLUMN script_detected TEXT;

-- 1 when the table of contents reaches too few of the spine's sections to navigate by
-- (the reported book: 116 sections, 1 NCX entry). 0 when checked and sound.
ALTER TABLE books ADD COLUMN toc_degenerate INTEGER;

-- 1 when the spine is many sections whose median size is far too small to be chapters — a
-- conversion artifact (the reported book: 115 sections, 2450-byte median). 0 when checked and sound.
ALTER TABLE books ADD COLUMN spine_fragmented INTEGER;

-- Per-field provenance as a small JSON object, e.g. {"author":"default","title":"filename"}.
-- Lets the metadata editor present a guess AS a guess instead of as fact.
ALTER TABLE books ADD COLUMN meta_provenance TEXT;
