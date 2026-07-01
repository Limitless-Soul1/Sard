-- RAWY-60: multi-passage photo cards. A card can now collect several separate passages
-- (possibly from different chapters). When it holds more than one passage we store them as a
-- JSON array of { text, chapterLabel } so the "Edit" flow can reopen the composer with the full
-- collection (separators + per-passage chapter labels restored). Single-passage cards leave this
-- NULL and keep using the plain `quote` column exactly as before.
ALTER TABLE photo_cards ADD COLUMN passages TEXT;
