-- WHERE AN IMPORTED MARK STANDS IN *THIS* READER'S COPY.
--
-- A deposit made against another edition carries cfis that mean nothing here, so each imported mark has
-- a placement life of its own: not yet examined, found, placed, or honestly refused. Three nullable
-- columns on the table Phase 2 already added — and NOT ONE column on `highlights`, `notes`, `refs` or
-- `reps`, whose shape a deposit must never change.
--
--   state           NULL/'pending'  not examined yet, or a pass was interrupted — the next open resumes
--                   'located'       found exactly once; `target_section` says where, awaiting its render
--                   'placed'        a cfi was minted in the rendered section and written; it draws
--                   'already_yours' the target already carries the reader's own mark — terminal, and
--                                   the friendliest thing a deposit can report
--                   'ambiguous'     found more than once; Sard will not choose between them
--                   'absent'        not in this copy at all
--                   'unanchorable'  nothing to search by (no excerpt, or a note with only a cfi)
--
--   target_section  the spine index the count pass settled on; cleared once the mark is placed
--   decided_at      when the verdict was reached
--
-- WHY A CFI IS NOT MINTED BY THE COUNT PASS. Measured over two books, section by section: a cfi minted
-- in a section's RAW document and resolved the way the engine draws it — `resolveNavigation(cfi)` then
-- `anchor(renderedDoc)` — failed on 2 of 55 ranges. The rendered document is the one Sard's cfis are
-- made against, so the mint happens there and only there; the count pass merely says WHICH section.
ALTER TABLE mark_origin ADD COLUMN state TEXT;
ALTER TABLE mark_origin ADD COLUMN target_section INTEGER;
ALTER TABLE mark_origin ADD COLUMN decided_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_mark_origin_state ON mark_origin(state);
