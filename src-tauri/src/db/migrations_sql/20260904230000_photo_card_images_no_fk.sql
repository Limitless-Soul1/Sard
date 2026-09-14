-- THE BINDING TABLE MUST BE ABLE TO NAME A CARD THAT DOES NOT EXIST YET.
--
-- `photo_card_images` was created with `FOREIGN KEY (card_id) REFERENCES photo_cards (id)`, which
-- looked like tidy schema design and is in fact the opposite of what this table is for.
--
-- An image picked in an OPEN composer has to be referenced from the moment it is copied, because
-- `backgrounds::gc()` deletes anything no source names and it runs whenever the reader changes their
-- wallpaper. So the binding is written against the id the card WILL be saved under, before any
-- `photo_cards` row exists. With `PRAGMA foreign_keys = ON` — which this database sets — that write
-- fails, and the feature it protects cannot work at all.
--
-- The integrity the constraint was providing is provided instead by two things that fit the actual
-- lifecycle: `photocards::delete` removes a card's bindings explicitly in the same call, and
-- `photocards::sweep_draft_bindings` reclaims bindings for cards that were never saved — at startup,
-- where it cannot race a composer that is still open.
--
-- SQLite cannot drop a constraint, so the table is rebuilt. Existing rows are carried across.
CREATE TABLE IF NOT EXISTS photo_card_images_rebuilt (
    card_id       TEXT NOT NULL,
    background_id TEXT NOT NULL,
    PRIMARY KEY (card_id, background_id)
);

INSERT OR IGNORE INTO photo_card_images_rebuilt (card_id, background_id)
SELECT card_id, background_id FROM photo_card_images;

DROP TABLE photo_card_images;

ALTER TABLE photo_card_images_rebuilt RENAME TO photo_card_images;

CREATE INDEX IF NOT EXISTS idx_photo_card_images_bg ON photo_card_images (background_id);
