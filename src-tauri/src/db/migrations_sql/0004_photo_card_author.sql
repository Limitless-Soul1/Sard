-- RAWY-57: store the author on a saved photo card so the "Edit" flow can reopen the composer
-- with the full card content (book title + author + chapter). Older rows keep NULL (author
-- simply absent on edit). One column; the toggle states are intentionally not persisted
-- (they default when editing).
ALTER TABLE photo_cards ADD COLUMN author TEXT;
