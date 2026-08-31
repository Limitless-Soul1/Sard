-- WHEN THE READER LAST ARRANGED A RUN — the one fact reading-aware ordering cannot do without.
--
-- The displayed sequence is a projection of two independent things:
--
--     books read SINCE the run was arranged, newest first
--   ++ every other book, in its stored rank order
--
-- and that "since" is why this column exists. It is not a convenience. No function of (manual
-- order, read_at) alone can produce the behaviour, and the proof is two cases the owner specified:
--
--   · a run arranged A B C D E, then C, E and B read, must show B E C A D — every read book
--     promoted, by recency;
--   · a run whose books were read FIRST and then hand-arranged to D B A E C, then E read, must
--     show E D B A C — only E promoted, while B and C stay exactly where the hand put them.
--
-- Both have the same manual order shape and the same set of read books. The only thing that tells
-- them apart is whether a read happened before or after the hand last touched the run. One integer
-- per run answers it; nothing per-book and nothing per-reading-event is needed.
--
-- WHY IT LIVES ON THE ROW rather than in a table of its own. Every row of a run carries the same
-- value, which is denormalised — and it is still the better trade here: `for_scope` already selects
-- exactly the rows a scope draws, so the stamp arrives with them for free, with no join, no second
-- statement and no chance of a run existing with no baseline. A `view_runs` table would buy
-- normalisation and cost a join on the hottest read in the library.
ALTER TABLE view_orders ADD COLUMN arranged_at INTEGER NOT NULL DEFAULT 0;

-- EXISTING RUNS ARE STAMPED AS ARRANGED NOW, and the reason is not tidiness.
--
-- Left at 0, every book ever read would count as "read since this run was arranged" and float to
-- the front on the very first launch. On this library that is 38 of 44 books: the reader would open
-- Sard and find their arrangement apparently destroyed, with no gesture of theirs to blame. The
-- migration therefore declares the past already accounted for — reading from here on promotes,
-- everything before it is baked into the ranks that already exist.
UPDATE view_orders SET arranged_at = CAST(strftime('%s', 'now') AS INTEGER);

-- THE SAME LINE DRAWN FOR RUNS THAT HAVE NEVER BEEN ARRANGED AT ALL.
--
-- A run with no rows has no stamp to read, and it needs the identical protection: without a floor
-- it would promote the whole reading history the first time it is drawn. This is that floor, held
-- once for the whole library, and consulted only when a run has no rows of its own.
INSERT OR REPLACE INTO settings (key, value)
VALUES ('view_order_epoch', CAST(strftime('%s', 'now') AS INTEGER));
