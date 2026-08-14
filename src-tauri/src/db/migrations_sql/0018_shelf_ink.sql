-- A shelf gets a colour of its own.
--
-- Until now only a CASE carried an ink, and a shelf borrowed it. That is why a shelf's colour
-- read as inconsistent: there was nothing to be consistent with. A shelf with no ink still falls
-- back to its case's, so an untouched library looks exactly as it did.
ALTER TABLE collections ADD COLUMN ink TEXT;
