-- THE DYE A BOOKMARK WAS PLACED IN.
--
-- The shelf draws one ribbon per bookmark in that bookmark's own colour, so the head of a cover
-- shows the palette of a book's reading and not one repeated swatch. Sard had a single GLOBAL
-- bookmark colour, which made every ribbon on every book identical and the palette meaningless.
--
-- NULL is the honest value for a bookmark placed before this column existed: the reader never chose
-- a dye for it, so the view resolves NULL to the global colour rather than inventing a choice.
ALTER TABLE bookmarks ADD COLUMN color TEXT;
