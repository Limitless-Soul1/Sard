-- THE SHARED PAGE COLOUR AND INK GO, because a هيئة already owns both.
--
-- WHAT THEY WERE. `reading_style` is the reader's own row, shared by every book. Two of its fields —
-- `pageColor` and `textColor` — were written by the reading drawer's colour controls and read AHEAD
-- of the هيئة's palette at render time (`style.pageColor ?? theme.colors.paperBg`). So a هيئة carried
-- a paper and an ink of its own in `theme.reading.colors`, and these shadowed them.
--
-- TWO OWNERS FOR ONE VISIBLE PROPERTY, and the wrong one won. Measured on a real library: a page
-- colour chosen while reading a book wearing «RedRose» painted a book wearing «Ring» in that same
-- colour, survived the Discard that claimed to undo it, and could not be reached from either هيئة
-- because neither owned it.
--
-- The controls edit the هيئة's palette now. These two fields are therefore legacy, and leaving them
-- would be worse than useless: nothing writes them any more, so whatever value they hold would go on
-- overriding every هيئة for ever with no control able to clear it.
--
-- REMOVED ONCE, AND NOT COPIED ANYWHERE. They are not folded into the worn هيئة or into any other:
-- they were a global override, not that هيئة's opinion, and writing them into one would change an
-- appearance the reader never edited. The palette each هيئة already carries becomes authoritative,
-- which is what it always was underneath.
--
-- IDEMPOTENT, AND NARROW. `json_remove` on keys that are already absent returns the object unchanged,
-- so a second run is a no-op; `json_valid` guards a row that is not JSON; and the `WHERE key` clause
-- means exactly one row can be touched. No profile blob, no book override, no assignment and no other
-- setting is read or written here.
UPDATE settings
   SET value = json_remove(value, '$.pageColor', '$.textColor')
 WHERE key = 'reading_style'
   AND json_valid(value)
   AND (json_type(value, '$.pageColor') IS NOT NULL
        OR json_type(value, '$.textColor') IS NOT NULL);

-- `json_type`, NOT `json_extract`, and the difference is the whole of whether this runs at all.
-- `json_extract` returns SQL NULL for a JSON `null`, so `IS NOT NULL` is FALSE for exactly the rows
-- this has to clean: the previous activation path wrote `pageColor: null` on every هيئة switch, so
-- the commonest shape of the legacy row is the two keys PRESENT and null. `json_type` answers
-- 'null' for a JSON null and SQL NULL only when the path is genuinely absent, which is the question
-- being asked. Caught on a real library, where both keys were present and null and the guarded
-- UPDATE matched nothing.
