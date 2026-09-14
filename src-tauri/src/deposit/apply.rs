//! Accepting a deposit — the one place in this feature that writes to the reader's database.
//!
//! # The rule the whole module exists to keep
//!
//! **Nothing of the receiver's is ever overwritten.** That is not a matter of care; it is a matter of
//! not calling the existing writers, every one of which is an upsert:
//!
//! | writer | on conflict |
//! |---|---|
//! | `library::highlight_create` | `DO UPDATE SET color=…` |
//! | `library::note_create` | `DO UPDATE SET body=…, color=…, title=…` — it would DESTROY a note |
//! | `library::ref_upsert` | `DO UPDATE SET note=…` — it would overwrite a gloss |
//! | `library::rep_upsert` | `DO UPDATE SET replacement=…`, and inserts `enabled = 1` |
//!
//! So this module owns its own statements, and each one is written to be additive by construction:
//! `INSERT … ON CONFLICT DO NOTHING` for marks that are keyed by content, and an explicit, chosen
//! UPDATE for the two layers where the schema permits only one row per phrase.
//!
//! # Identity
//!
//! * a highlight's id is the SAME seed a local action would use — `hl:{book}:{cfi}` — so an identical
//!   mark collides with itself and is skipped rather than duplicated or updated;
//! * a note's id carries the DEPOSIT and its position in it — `note:{book}:{anchor}:dep:{deposit}:{i}`
//!   — so an arriving note can never land on the receiver's own note, two anchorless notes in one
//!   deposit cannot collapse into each other, and re-importing the same file recomputes the same ids
//!   and changes nothing.
//!
//! # CFIs
//!
//! Copied verbatim. Never parsed, never resolved, never validated here. Measured over five real books:
//! resolving a stored cfi against a RAW section document fails for range cfis that are perfectly valid
//! in the document they were made against, because a highlight's cfi is recorded against the RENDERED
//! document. Sard stores cfis and resolves them at render time; a deposit does the same.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::{books, library};

use super::package;

#[derive(serde::Deserialize, Default)]
pub struct ConflictChoice {
    pub index: usize,
    pub take_theirs: bool,
}

/// What the receiver kept. Indices into the manifest's own arrays — never ids.
#[derive(serde::Deserialize, Default)]
pub struct Acceptance {
    #[serde(default)]
    pub highlights: Vec<usize>,
    #[serde(default)]
    pub notes: Vec<usize>,
    #[serde(default)]
    pub references: Vec<ConflictChoice>,
    #[serde(default)]
    pub replacements: Vec<ConflictChoice>,
}

#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct Counts {
    pub highlights: u32,
    pub notes: u32,
    pub references: u32,
    pub replacements: u32,
}

#[derive(serde::Serialize, Debug)]
pub struct Outcome {
    pub deposit_id: String,
    pub book_id: Option<String>,
    /// The book arrived with the deposit and entered the library through the ordinary import path.
    pub book_imported: bool,
    /// The receiver already had this exact file — identity by content hash, so cfis apply verbatim.
    pub same_book: bool,
    pub applied: Counts,
    /// Marks the receiver already had. Skipped, never rewritten.
    pub skipped_existing: Counts,
    /// Kept, but with no position: the cfi named no place, or it belongs to another copy.
    pub unplaced: Counts,
    /// A phrase the receiver already glosses or replaces, left alone because they said so.
    pub kept_mine: Counts,
    pub already_received: bool,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn s(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}
fn i(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Where the book went, and whether its cfis can be trusted.
struct Bound {
    book_id: Option<String>,
    imported: bool,
    /// The receiver holds the very bytes the sender did, so every cfi applies verbatim. False when the
    /// reader bound the deposit to a DIFFERENT copy — then each cfi is a stranger here and the marks
    /// begin life as `pending`, to be placed by text in the reader.
    same_book: bool,
}

/// RESOLVE THE BOOK BEFORE ANYTHING IS WRITTEN.
///
/// 1. the receiver already holds this exact file — identity is the content hash, so this is exact;
/// 2. the deposit carries the book — verify its bytes hash to the id the manifest claims, then import
///    it through `books::import_books`, the ONLY way a book enters this library. Because the id is the
///    hash of those bytes, the import lands on the very same id and case 2 becomes case 1;
/// 3. neither — the marks are still accepted and simply have nowhere to point yet.
fn bind_book(
    conn: &Connection,
    app_data_dir: &Path,
    manifest: &serde_json::Value,
    archive: &str,
    // THE READER'S OWN ANSWER to "which of my books is this?", when the hash cannot answer it. Never
    // inferred here: a wrong binding would attach a stranger's marks to an unrelated text, so the
    // choice is the reader's and this only honours it.
    chosen: Option<&str>,
) -> Result<Bound, String> {
    let book = manifest.get("book").ok_or("dep.err.badBook")?;
    let hash = s(book, "hash").ok_or("dep.err.badBook")?;

    let have: Option<String> = conn
        .query_row("SELECT id FROM books WHERE id = ?1", [&hash], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if have.is_some() {
        return Ok(Bound { book_id: Some(hash), imported: false, same_book: true });
    }

    if let Some(id) = chosen {
        // A DIFFERENT COPY, named by the reader. It must be a book that exists; nothing else is trusted
        // about it, and every cfi-bearing mark will have to earn its place by text.
        let exists: Option<String> = conn
            .query_row("SELECT id FROM books WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Err("dep.err.noBook".into());
        }
        return Ok(Bound { book_id: Some(id.to_string()), imported: false, same_book: false });
    }

    if let Some(member) = s(book, "file") {
        let bytes = package::extract_verified_book(archive, &member, &hash)?;
        let ext = if member.to_ascii_lowercase().ends_with(".pdf") { "pdf" } else { "epub" };
        let staged = app_data_dir.join(format!("deposit-incoming-{hash}.{ext}"));
        std::fs::write(&staged, &bytes).map_err(|e| format!("dep.err.write:{e}"))?;
        let results = books::import_books(conn, app_data_dir, &[staged.to_string_lossy().to_string()]);
        // The staged copy is scratch: `import_books` has already made the managed one it will keep.
        let _ = std::fs::remove_file(&staged);
        let ok = results
            .iter()
            .any(|r| (r.status == "imported" || r.status == "duplicate") && r.id == hash);
        if !ok {
            return Err("dep.err.bookUnreadable".into());
        }
        // WHAT THE FILE ITSELF COULD NOT SAY. `import_books` re-derives everything from the EPUB, which
        // is right — it is the one importer, and a deposit's book must end up indistinguishable from a
        // book brought in any other way. But the sender's library knew things the file does not: an
        // author he corrected, a cover Sard stored for a book that carries none. The deposit carried
        // both. They are adopted here through the SAME mechanisms a reader's own edit uses — an
        // override for the words, the managed cover store for the picture — and ONLY where the import
        // left a gap, so nothing the file did say is ever overwritten.
        adopt_what_the_file_lacked(conn, app_data_dir, &hash, book, archive);
        return Ok(Bound { book_id: Some(hash), imported: true, same_book: true });
    }

    Ok(Bound { book_id: None, imported: false, same_book: false })
}

/// Fill the gaps the packed file left, from what the deposit was carrying.
///
/// Deliberately best-effort and never fatal: a book that arrived is worth keeping even if its cover
/// will not decode, and a missing author is a smaller loss than a refused import. Each gap is filled
/// through the reader-facing path for that field, so the result is an ordinary book with an ordinary
/// override — not a deposit-shaped special case the rest of Sard has to know about.
fn adopt_what_the_file_lacked(
    conn: &Connection,
    app_data_dir: &Path,
    id: &str,
    book: &serde_json::Value,
    archive: &str,
) {
    let Ok(Some(row)) = library::get_book(conn, id) else { return };

    // THE WORDS. Only where the file said nothing at all — the EPUB's own metadata wins whenever it
    // has any, because that is what an ordinary import of the same file would show.
    let blank = |v: &Option<String>| v.as_deref().map(str::trim).unwrap_or("").is_empty();
    let title = if blank(&row.title) { s(book, "title") } else { None };
    let author = if blank(&row.author) { s(book, "author") } else { None };
    if title.is_some() || author.is_some() {
        let _ = library::update_book(
            conn,
            id,
            title.as_deref(),
            author.as_deref(),
            None,
            None,
            None,
            None,
            None,
            None,
        );
    }

    // THE PICTURE THE SENDER WAS ACTUALLY LOOKING AT.
    //
    // Two cases, one rule. A book whose EPUB carries no cover would sit on the shelf as a blank plate.
    // And a sender who REPLACED his cover shared that replacement — but the import re-extracts the
    // EPUB's own, so without this the reader would be shown the original the sender had deliberately
    // set aside. The deposit's cover is adopted whenever it differs from what the file yielded, through
    // the same staging the reader's own "choose an image" uses; when they are identical — the ordinary
    // case — nothing is written and no needless override is created.
    if let Some(member) = s(book, "cover") {
        let extracted = row
            .cover_path
            .as_deref()
            .map(|c| library::resolve_cover(app_data_dir, c))
            .and_then(|abs| std::fs::read(abs).ok());
        let differs = match (&extracted, package::read_member(archive, &member).ok()) {
            (Some(mine), Some(theirs)) => mine != &theirs,
            _ => true,
        };
        if differs {
            if let Ok(bytes) = package::read_member(archive, &member) {
                let ext = std::path::Path::new(&member)
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_else(|| "img".into());
                let tmp = app_data_dir.join(format!("deposit-cover-{id}.{ext}"));
                if std::fs::write(&tmp, &bytes).is_ok() {
                    if let Ok(staged) = library::stage_cover(app_data_dir, id, &tmp.to_string_lossy()) {
                        let _ = library::commit_cover(conn, app_data_dir, id, &staged.rel);
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }
    }
}

/// Accept the chosen part of a deposit, in ONE transaction.
pub fn commit(
    conn: &mut Connection,
    app_data_dir: &Path,
    manifest_json: &str,
    archive: &str,
    accept: &Acceptance,
    bind_to: Option<&str>,
) -> Result<Outcome, String> {
    // EVERYTHING IS VALIDATED BEFORE ANYTHING IS MUTATED.
    let manifest = package::validate(manifest_json)?;
    let deposit_id = package::deposit_id(manifest_json);

    let seen: Option<String> = conn
        .query_row("SELECT id FROM deposits WHERE id = ?1", [&deposit_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    // "ALREADY RECEIVED" MUST MEAN "AND WHAT IT BROUGHT IS STILL HERE".
    //
    // The row is keyed on the manifest alone, and it used to be the whole answer: seen once, refused
    // ever after. But a reader can delete the book, or the marks, and then the deposit has been undone
    // — and refusing it as a repeat leaves him told that something exists when it plainly does not,
    // with no way to get it back. Measured: a deposit received while the book was away left a row with
    // no book to cascade from, and every later attempt applied nothing for good.
    //
    // So the row is only an answer while something it created survives: the book it bound, or a mark
    // it wrote. When nothing does, the deposit is forgotten and may arrive again.
    let still_here = if seen.is_some() {
        let book_alive: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deposits d JOIN books b ON b.id = d.book_id WHERE d.id = ?1",
                [&deposit_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let marks_alive: i64 = conn
            .query_row("SELECT COUNT(*) FROM mark_origin WHERE deposit_id = ?1", [&deposit_id], |r| r.get(0))
            .unwrap_or(0);
        book_alive > 0 || marks_alive > 0
    } else {
        false
    };
    if seen.is_some() && !still_here {
        // Nothing it brought is left. Forget it, so what follows is an ordinary first receipt.
        conn.execute("DELETE FROM deposits WHERE id = ?1", [&deposit_id])
            .map_err(|e| e.to_string())?;
    }
    if still_here {
        // The same file, twice. Nothing is applied a second time — and nothing is undone either.
        return Ok(Outcome {
            deposit_id,
            book_id: None,
            book_imported: false,
            same_book: false,
            applied: Counts::default(),
            skipped_existing: Counts::default(),
            unplaced: Counts::default(),
            kept_mine: Counts::default(),
            already_received: true,
        });
    }

    // The book is resolved BEFORE the transaction: importing one is its own multi-step act with its
    // own writes, and nesting it inside this transaction would make a rollback here undo a book the
    // reader can legitimately keep.
    let bound = bind_book(conn, app_data_dir, &manifest, archive, bind_to)?;
    let book_id = bound.book_id.clone();

    let empty = Vec::new();
    let marks = manifest.get("marks");
    let arr = |k: &str| -> Vec<serde_json::Value> {
        marks
            .and_then(|m| m.get(k))
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_else(|| empty.clone())
    };
    let highlights = arr("highlights");
    let notes = arr("notes");
    let references = arr("references");
    let replacements = arr("replacements");

    let mut applied = Counts::default();
    let mut skipped = Counts::default();
    let mut unplaced = Counts::default();
    let mut kept_mine = Counts::default();

    let now = now_unix();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO deposits(id, book_id, sender, inscription, signed, created_at, received_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            deposit_id,
            book_id,
            manifest.get("sender").and_then(|x| s(x, "name")),
            manifest.get("inscription").and_then(|x| s(x, "text")),
            manifest.get("inscription").and_then(|x| s(x, "signed")),
            i(&manifest, "created_at"),
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    // WHERE A MARK STANDS, recorded with its attribution.
    //
    // A same-hash import is `placed` the moment it is written: the cfi came from the very bytes this
    // reader holds, so it resolves natively and the page already draws it. A mark bound to a DIFFERENT
    // copy starts `pending` — its cfi means nothing here, and only the reader's own rendered text can
    // say where it belongs. The phrase-keyed layers have no position at all, so they are `placed` by
    // construction in either case.
    let same = bound.same_book;
    let origin = |tx: &rusqlite::Transaction, kind: &str, id: &str| -> Result<(), String> {
        let state = match kind {
            "highlight" | "note" if !same => "pending",
            _ => "placed",
        };
        tx.execute(
            "INSERT INTO mark_origin(kind, mark_id, deposit_id, state, decided_at) VALUES(?1,?2,?3,?4,?5) \
             ON CONFLICT(kind, mark_id) DO NOTHING",
            rusqlite::params![kind, id, deposit_id, state, now],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    };

    if let Some(bid) = book_id.as_deref() {
        // ── HIGHLIGHTS ──────────────────────────────────────────────────────────────────────────
        // The id is what a LOCAL action would compute for the same range, so an identical mark is
        // already-present by definition. `DO NOTHING` states that in SQL: never an update, so the
        // receiver's own colour and ink survive untouched.
        let mut hl_ids: Vec<Option<String>> = vec![None; highlights.len()];
        for &idx in &accept.highlights {
            let Some(h) = highlights.get(idx) else { continue };
            let Some(cfi) = s(h, "cfi") else { continue };
            let id = library::gen_id(&format!("hl:{bid}:{cfi}"));
            hl_ids[idx] = Some(id.clone());
            let existed: bool = tx
                .query_row("SELECT 1 FROM highlights WHERE id = ?1", [&id], |_| Ok(()))
                .optional()
                .map_err(|e| e.to_string())?
                .is_some();
            if existed {
                skipped.highlights += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO highlights(id, book_id, start_cfi, color, text_excerpt, chapter_label, created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO NOTHING",
                rusqlite::params![
                    id,
                    bid,
                    cfi,
                    s(h, "color").unwrap_or_else(|| "amber".into()),
                    s(h, "text"),
                    s(h, "chapter_label"),
                    i(h, "created_at").unwrap_or(now),
                ],
            )
            .map_err(|e| e.to_string())?;
            applied.highlights += 1;
            if h.get("section_index").map(|x| x.is_null()).unwrap_or(true) {
                unplaced.highlights += 1;
            }
            origin(&tx, "highlight", &id)?;
        }

        // ── NOTES ───────────────────────────────────────────────────────────────────────────────
        // A DEPOSIT-SPECIFIC SEED. The local seed is `note:{book}:{anchor}`, and `note_create` UPDATES
        // on that id — which is exactly how an arriving note would erase the receiver's own note on the
        // same passage. Carrying the deposit in the seed makes a collision impossible, while keeping
        // re-import idempotent: the same file recomputes the same ids.
        for &idx in &accept.notes {
            let Some(n) = notes.get(idx) else { continue };
            let anchor = n
                .get("of_highlight")
                .and_then(|x| x.as_u64())
                .and_then(|hi| hl_ids.get(hi as usize).cloned().flatten())
                .or_else(|| s(n, "cfi"))
                .unwrap_or_default();
            // THE POSITION IN THE MANIFEST IS PART OF THE SEED, and it has to be. A note with neither a
            // cfi nor a highlight has an EMPTY anchor, so without the index every such note in one
            // deposit would seed the same id and all but the first would be dropped by the conflict
            // clause. Measured: four notes sent, two arrived. The index is still deterministic, so
            // re-importing the same file recomputes the same ids and remains a no-op.
            let id = library::gen_id(&format!("note:{bid}:{anchor}:dep:{deposit_id}:{idx}"));
            let of_highlight = n
                .get("of_highlight")
                .and_then(|x| x.as_u64())
                .and_then(|hi| hl_ids.get(hi as usize).cloned().flatten());
            tx.execute(
                "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at, title) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9) ON CONFLICT(id) DO NOTHING",
                rusqlite::params![
                    id,
                    bid,
                    of_highlight,
                    s(n, "cfi"),
                    s(n, "color"),
                    s(n, "body").unwrap_or_default(),
                    s(n, "chapter_label"),
                    i(n, "created_at").unwrap_or(now),
                    s(n, "title"),
                ],
            )
            .map_err(|e| e.to_string())?;
            applied.notes += 1;
            if n.get("section_index").map(|x| x.is_null()).unwrap_or(true) {
                unplaced.notes += 1;
            }
            origin(&tx, "note", &id)?;
        }

        // ── REFERENCES ──────────────────────────────────────────────────────────────────────────
        // One row per phrase per book is the schema's rule, so a phrase the receiver already glosses
        // is a real conflict. It is never resolved here: the receiver answered it in the sheet, and
        // «keep mine» is the default. Taking theirs is an explicit, chosen UPDATE of that one column.
        for c in &accept.references {
            let Some(r) = references.get(c.index) else { continue };
            let (Some(phrase), Some(fold)) = (s(r, "phrase"), s(r, "phrase_fold")) else { continue };
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM refs WHERE book_id = ?1 AND phrase_fold = ?2",
                    rusqlite::params![bid, fold],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match existing {
                Some(id) if c.take_theirs => {
                    tx.execute(
                        "UPDATE refs SET note = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![s(r, "note").unwrap_or_default(), now, id],
                    )
                    .map_err(|e| e.to_string())?;
                    applied.references += 1;
                    origin(&tx, "ref", &id)?;
                }
                Some(_) => kept_mine.references += 1,
                None => {
                    let id = library::gen_id(&format!("ref:{bid}:{fold}"));
                    tx.execute(
                        "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(book_id, phrase_fold) DO NOTHING",
                        rusqlite::params![
                            id,
                            bid,
                            phrase,
                            fold,
                            i(r, "word_count").unwrap_or(1),
                            s(r, "note").unwrap_or_default(),
                            now
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    applied.references += 1;
                    origin(&tx, "ref", &id)?;
                }
            }
        }

        // ── REPLACEMENTS ────────────────────────────────────────────────────────────────────────
        // ARRIVING SWITCHED OFF. A replacement changes what the reader READS; accepting a stranger's
        // silently would rewrite words on their page. `enabled` already exists as "a switch and NOT a
        // delete", so the row is written with it at 0 and the reader turns it on themselves.
        for c in &accept.replacements {
            let Some(r) = replacements.get(c.index) else { continue };
            let (Some(phrase), Some(fold)) = (s(r, "phrase"), s(r, "phrase_fold")) else { continue };
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM reps WHERE book_id = ?1 AND phrase_fold = ?2",
                    rusqlite::params![bid, fold],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match existing {
                Some(id) if c.take_theirs => {
                    tx.execute(
                        "UPDATE reps SET replacement = ?1, enabled = 0, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![s(r, "replacement").unwrap_or_default(), now, id],
                    )
                    .map_err(|e| e.to_string())?;
                    applied.replacements += 1;
                    origin(&tx, "rep", &id)?;
                }
                Some(_) => kept_mine.replacements += 1,
                None => {
                    let id = library::gen_id(&format!("rep:{bid}:{fold}"));
                    tx.execute(
                        "INSERT INTO reps(id, book_id, phrase, phrase_fold, replacement, word_count, enabled, created_at, updated_at) \
                         VALUES(?1,?2,?3,?4,?5,?6,0,?7,?7) ON CONFLICT(book_id, phrase_fold) DO NOTHING",
                        rusqlite::params![
                            id,
                            bid,
                            phrase,
                            fold,
                            s(r, "replacement").unwrap_or_default(),
                            i(r, "word_count").unwrap_or(1),
                            now
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    applied.replacements += 1;
                    origin(&tx, "rep", &id)?;
                }
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(Outcome {
        deposit_id,
        book_id,
        book_imported: bound.imported,
        same_book: bound.same_book,
        applied,
        skipped_existing: skipped,
        unplaced,
        kept_mine,
        already_received: false,
    })
}
