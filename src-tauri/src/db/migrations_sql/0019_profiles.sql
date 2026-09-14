-- PROFILES — the visual-identity registry (stage 1 of the Profiles feature).
--
-- PURELY ADDITIVE: this migration only CREATEs. It alters nothing, drops nothing and backfills
-- nothing, so an installation that never opens Profiles is byte-identical to before it ran. No row
-- is written here — not even for the sixteen shipped themes, which are RENDERED as starting
-- profiles rather than materialised, and not for the reader's current settings, which continue to
-- live in `settings` until they first create or edit a profile. An empty table IS the correct
-- post-migration state.
--
-- WHAT A PROFILE IS. Sard's visual identity: paper and colours, the interface and book faces, both
-- backgrounds and their treatment, the bookmark and read-marker, and the interface texture. It is
-- NOT the reader's own layout — line spacing, measure, margins, paragraph spacing, tracking,
-- alignment, diacritics and zoom stay in `reading_style` and `book_style:<id>`, are never written
-- from a profile, and never travel in a shared package.
--
--   id            'u:<uuid>'. The `u:` prefix is the same one `ThemeId` uses for a reader-authored
--                 theme, so a profile's theme id is decidable without consulting this table and no
--                 future built-in preset can ever collide with one.
--   name          OPTIONAL, and deliberately so — a profile with no name shows its lineage instead.
--                 One field, not one per language: a name is typed once, by a person, in whatever
--                 script they choose, and an imported profile carries the name its author gave it.
--   icon_kind     'seal' (the initial drawn in the profile's own face) | 'color' | 'image'.
--   icon_ref      NULL for 'seal'; a '#rrggbb' for 'color'; a content hash for 'image'.
--   data          The profile itself, as JSON. Everything not needed by Rust lives here, so adding
--                 a visual field later is a code change and never a migration — the same
--                 "no migration, by construction" rule the background params blob follows.
--   derived_from  The profile or built-in theme this one was duplicated from. Provenance only.
--
-- WHY bg_library / bg_reading / icon_ref ARE COLUMNS AND NOT JSON FIELDS. This is the same
-- reasoning 0013_backgrounds.sql gives for keeping surface bindings in plain settings keys: the
-- background collector must be able to see which images are still referenced WITHOUT parsing
-- frontend-owned JSON. Profiles are a third reference source alongside `bg_library_id` and
-- `bg_reading_id`, so they have to be reachable from Rust by query. Putting them in `data` would
-- make "zero orphans" a promise the UI has to keep instead of a property of the schema — and would
-- let a profile's background be collected out from under it.
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  description  TEXT,
  author       TEXT,
  icon_kind    TEXT,
  icon_ref     TEXT,
  data         TEXT NOT NULL,
  derived_from TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  bg_library   TEXT,
  bg_reading   TEXT
);

-- The list is read newest-edited-first, which is the order the Profiles area presents.
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at DESC);
