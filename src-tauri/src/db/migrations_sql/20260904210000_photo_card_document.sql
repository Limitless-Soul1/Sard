-- THE CARD DOCUMENT, and the image bindings the collector has to be able to read.
--
-- `doc` is NULLABLE ON PURPOSE. A card saved before this migration has NULL and is opened by
-- reconstructing its composition from the columns it already carries, which reproduces exactly what
-- the old code did when it reopened a card — so no existing card changes appearance, and no data
-- has to be rewritten. New cards write a document. No backfill, by construction.
ALTER TABLE photo_cards ADD COLUMN doc TEXT;

-- WHY THE IMAGE BINDING IS A TABLE AND NOT A FIELD INSIDE `doc`.
--
-- `backgrounds::gc()` deletes every managed image not named by a known reference source, and it runs
-- inside `set_surface()` — so it fires whenever anyone changes their wallpaper. It cannot parse the
-- frontend-owned document JSON to discover that a card is using an image, and the schema's stated
-- principle is that keeping the binding out of the JSON "is what makes 'zero orphans' a property of
-- the schema rather than a promise the UI has to keep".
--
-- So a card's images are rows. One per (card, image), written in the SAME transaction as the card
-- itself, which is what makes the reference and the row indivisible with respect to the collector.
-- A join table rather than a column because a card holds a ground AND any number of stickers, and
-- because two cards may legitimately share one imported image.
CREATE TABLE IF NOT EXISTS photo_card_images (
    card_id       TEXT NOT NULL,
    background_id TEXT NOT NULL,
    PRIMARY KEY (card_id, background_id)
    -- NOTE: a foreign key to `photo_cards` was here and was REMOVED by 20260904230000. A composer
    -- binds an image before the card row exists, so the constraint made the safety it protects
    -- impossible. See that migration for the full reasoning.
);

-- The collector reads this by image; the card writer deletes by card. Both directions are indexed.
CREATE INDEX IF NOT EXISTS idx_photo_card_images_bg ON photo_card_images (background_id);
