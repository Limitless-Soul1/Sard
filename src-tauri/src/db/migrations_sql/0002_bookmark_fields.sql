-- RAWY-41: the bookmark system. The bookmarks table already exists (RAWY-08: id, book_id,
-- locator_cfi, label, created_at). Add the denormalised chapter_label (like highlights/notes,
-- RAWY-20 — makes the in-book + global list a cheap query) and the reading fraction (0..1) so the
-- on-page marker can show ONLY where the bookmark sits (within the visible viewport).
ALTER TABLE bookmarks ADD COLUMN chapter_label TEXT;
ALTER TABLE bookmarks ADD COLUMN fraction REAL;
