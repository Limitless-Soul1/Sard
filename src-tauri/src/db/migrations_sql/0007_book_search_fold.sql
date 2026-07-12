-- RAWY-178 (AUD-12): Arabic-aware LIBRARY search folding.
-- Add precomputed FOLDED shadows of the effective title/author, and backfill every existing book by
-- folding its effective (override-or-base) value with the app's `afold()` function (registered on the
-- connection before migrations run — see db::register_functions). Folding = strip tashkīl/tatweel,
-- fold آأإٱ→ا / ى→ي / ة→ه, lowercase, drop whitespace (the same normalization the in-book search uses).
-- Import + metadata edit keep these columns current; the library search compares folded-to-folded so an
-- unvocalized query finds a vocalized title. No data loss: only two new nullable columns are added.

ALTER TABLE books ADD COLUMN title_fold  TEXT;
ALTER TABLE books ADD COLUMN author_fold TEXT;

UPDATE books SET
  title_fold  = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id = books.id AND field = 'title'),  title)),
  author_fold = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id = books.id AND field = 'author'), author));
