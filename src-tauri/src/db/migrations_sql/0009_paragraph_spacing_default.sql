-- RAWY-195 — paragraph spacing: 0 used to mean "no rule at all → the book's own margin wins".
-- The reading CSS now ALWAYS emits the rule, so 0 means a real zero (the user can finally set the
-- spacing TIGHTER than the book). That re-reads every ALREADY-STORED 0 as "collapse this book's
-- paragraphs", which is not what those rows meant — they meant "leave it to the book" (~1em = 16px).
--
-- So lift a stored 0 to the new default (PARAGRAPH_SPACING_DEFAULT = 16, injectedCss.ts): an existing
-- book keeps the paragraph rhythm it has today, and a 0 the user chooses AFTER this migration is an
-- explicit, honoured zero. Rows with a spacing the user actually set (12, 18, …) are untouched — those
-- already emitted a rule and already worked.
--
-- Runs once (versioned). json_* are SQLite's built-in JSON1 functions; json_valid() guards a row that
-- somehow isn't JSON, and json_extract() returns NULL for a row that has no such field — so both are
-- skipped rather than rewritten.

-- The global reading defaults (RAWY-39): a FULL ReadingStyle object at the top level.
UPDATE settings
   SET value = json_set(value, '$.paragraphSpacing', 16)
 WHERE key = 'reading_style'
   AND json_valid(value)
   AND json_extract(value, '$.paragraphSpacing') = 0;

-- Per-book overrides (RAWY-40): a PARTIAL style under `.style` of `book_style:<bookId>`. Only a row
-- that explicitly stored a 0 is touched; a row that never mentions paragraphSpacing keeps inheriting
-- the global default (json_extract → NULL → no match).
UPDATE settings
   SET value = json_set(value, '$.style.paragraphSpacing', 16)
 WHERE key LIKE 'book_style:%'
   AND json_valid(value)
   AND json_extract(value, '$.style.paragraphSpacing') = 0;
