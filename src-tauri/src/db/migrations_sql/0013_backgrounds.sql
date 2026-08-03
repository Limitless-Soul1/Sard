-- RAWY-265: BACKGROUND PERSONALISATION — the managed-image registry (spec §7.3).
--
-- PURELY ADDITIVE: this migration only CREATEs a new table. It never alters or drops anything, so a
-- profile that never sets a background is byte-identical to before it ran (invariant I-1).
--
-- WHY A TABLE AND NOT A SETTINGS BLOB. A background is a managed FILE with a lifecycle — copied in,
-- deduped by content, possibly accompanied by a derivative, and eventually deleted with zero orphans
-- (D31). Settings are strings; files need a registry that the GC can enumerate. It also gives the
-- deferred per-book/recents work a seam that does not require a retrofit.
--
--   id              the content SHA-256 (truncated hex). CONTENT-addressed, so importing the same
--                   photo twice reuses one file and one row — the same dedup rule the library import
--                   uses for EPUBs. It also makes the id stable across a re-import after a restore.
--   original_path   the user's file, copied in BYTE-FOR-BYTE and never modified. This is the archival
--                   copy; the "never recompress" guarantee lives here (spec §7.2).
--   derivative_path NULL for the overwhelming majority of images — meaning "render the original, no
--                   downscale was needed and none was done". Non-NULL only when the source exceeded
--                   the render ceiling OR carried a non-identity EXIF orientation (see backgrounds.rs).
--                   Always a LOSSLESS PNG: no lossy re-encode occurs at any point, for any image.
--                   It is a CACHE — deletable and regenerable, never authoritative.
--   width/height    the ORIGINAL pixel dimensions (post EXIF-orientation), not the derivative's. The UI
--                   reports what the user gave us, and the focal-point maths is aspect-driven.
--   mean_luma       0..1 mean relative luminance, sampled at import. Feeds the "arrive correct" initial
--                   Presence (spec §10.2): the app computes a tasteful first paint instead of asking the
--                   user to tune one. Stored rather than recomputed because it never changes and the
--                   decode is the expensive part. NULL only if sampling failed — the UI then falls back
--                   to a fixed default rather than guessing.
--
-- REFERENCES ARE NOT HERE, DELIBERATELY. Which surface uses which background lives in two plain
-- settings keys (`bg_library_id` / `bg_reading_id`) precisely so the Rust GC can read them WITHOUT
-- parsing the frontend-owned parameter JSON. The GC rule is then a two-key lookup: any row not named
-- by one of those keys is unreferenced and its files are deleted. Keeping the binding out of the JSON
-- is what makes "zero orphans" a property of the schema rather than a promise the UI has to keep.
CREATE TABLE IF NOT EXISTS backgrounds (
  id              TEXT PRIMARY KEY,
  original_path   TEXT NOT NULL,
  derivative_path TEXT,
  source_name     TEXT,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  mean_luma       REAL,
  added_at        INTEGER NOT NULL
);

-- The only read that is not by primary key is the GC's "list everything" and the (deferred) recents
-- strip, both newest-first.
CREATE INDEX IF NOT EXISTS idx_backgrounds_added ON backgrounds(added_at DESC);
