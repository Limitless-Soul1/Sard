//! HOW BOOKS READ IN A VIEW — which is not where they belong.
//!
//! `placement` owns membership: which container holds a book. This module owns sequence: what order
//! a particular run of books is drawn in, for one format, at one place in the library.
//!
//! The two were the same thing until now, and a flat view cannot survive that. Grid draws several
//! containers as one sequence, so "the last visible slot" was the end of whichever container the
//! concatenation happened to put last. Dragging a book from the top of the library to the bottom
//! FILED it — measured on a real library, «وُضع على خارج الأرفف», persisted, the container genuinely
//! changed — when the reader had asked to reorder.
//!
//! ── THE PROPERTY THAT MATTERS ───────────────────────────────────────────────────────────────
//!
//! Nothing in this module can change membership. Not because it is careful: because a `view_orders`
//! row has no container column. A reorder has nowhere to write one. `placements` is never read for
//! writing here and never written at all.
//!
//! ── THE RUN ─────────────────────────────────────────────────────────────────────────────────
//!
//! A run is what a reader rearranges as one block, named by `(format, scope, section)`:
//!
//!   · `format` is one of the five, because they keep independent orders on purpose;
//!   · `scope` is the MOST SPECIFIC part of where the reader stands — category, else shelf, else
//!     cabinet, else "" for the root. Not the navigation triple: a shelf id is already unique, and
//!     keying on the triple would orphan a shelf's order the moment it moved to another cabinet;
//!   · `section` is the block as drawn — "*" in the flat formats, and in the grouped ones the id of
//!     the shelf section, WHICH MAY BE A RULE SHELF. Measured inside one cabinet: Covers drew a
//!     rule-shelf section whose eighteen tiles were every one of them owned by another container. A
//!     section is not a container and must never be treated as one.
//!
//! ── UNARRANGED IS NOT EMPTY ─────────────────────────────────────────────────────────────────
//!
//! A run with no rows has never been arranged, and is drawn in the default order — `placements.rank`,
//! the sequence books arrived in. The first arrangement of a run materialises every book in it at
//! once, so a run is never half-ordered: the ambiguity of "some ranked, some not" never arises.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::placement::between;

/// The flat formats draw one run, and this is its name. Not a shelf id; nothing looks it up.
pub const WHOLE_RUN: &str = "*";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewOrderRow {
    pub section: String,
    pub book_id: String,
    pub rank: String,
    /// When the hand last arranged this run. Reading promotes a book only if it was read AFTER
    /// this, which is what keeps a reader's own arrangement from being undone by their history.
    /// Identical for every row of a run; carried per row so a scope's baseline arrives with the
    /// scope's order, in the one statement that was already being made.
    pub arranged_at: i64,
}

/// Which run — the key, kept together so it cannot be assembled differently in two places.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunKey {
    pub format: String,
    pub scope: String,
    pub section: String,
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// EVERY SECTION OF ONE SCOPE, IN ONE STATEMENT.
///
/// A grouped format draws all of a scope's sections at once. Asking per section would be one query
/// per shelf on screen — the N+1 this signature exists to make impossible. The index
/// `(format, scope, section, rank)` serves it as a covering scan, so the rows arrive already in the
/// order they will be drawn and nothing re-sorts them.
pub fn for_scope(conn: &Connection, format: &str, scope: &str) -> rusqlite::Result<Vec<ViewOrderRow>> {
    let mut stmt = conn.prepare(
        "SELECT section, book_id, rank, arranged_at FROM view_orders \
         WHERE format = ?1 AND scope = ?2 ORDER BY section, rank",
    )?;
    let out = stmt
        .query_map([format, scope], |r| {
            Ok(ViewOrderRow {
                section: r.get(0)?,
                book_id: r.get(1)?,
                rank: r.get(2)?,
                arranged_at: r.get(3)?,
            })
        })?
        .collect();
    out
}

/// The floor for a run that has never been arranged and so has no stamp of its own.
///
/// Without one, a run with no rows would count the reader's entire reading history as "since it was
/// arranged" and float all of it to the front the first time it is drawn. Stamped once by the
/// migration; read here rather than defaulted to zero, so the two kinds of run behave alike.
pub fn epoch(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'view_order_epoch'",
        [],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
}

/// One run's books, in order. Used by the write path to find neighbours.
fn run_books(conn: &Connection, key: &RunKey) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT book_id, rank FROM view_orders \
         WHERE format = ?1 AND scope = ?2 AND section = ?3 ORDER BY rank",
    )?;
    let out = stmt
        .query_map([&key.format, &key.scope, &key.section], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect();
    out
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// What a reorder is asked to do, and what it reports back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reordered {
    /// Whether anything was written. A release that would leave the run exactly as it is writes
    /// nothing and says nothing — decided here, inside the transaction, against the run as it
    /// actually stands rather than against the list the reader was looking at a moment ago.
    pub changed: bool,
    /// The run afterwards, in order — so the screen draws what the write produced rather than
    /// guessing at it or re-fetching and racing itself.
    pub order: Vec<String>,
}

/// MOVE A BOOK WITHIN ONE RUN. Membership is not consulted and not touched.
///
/// `before` is the book to land in front of, or `None` for the end of the run. A neighbour, never an
/// index: the pre-removal/post-removal bridging that indices need is where off-by-ones live.
///
/// `present` is every book the run currently SHOWS, in the order it is drawn — promotions included.
/// It was once "the order the view would draw them WITHOUT any saved order", used only to
/// materialise an empty run. Reading-aware ordering makes the drawn order and the stored order
/// legitimately different, so it is now the baseline for every reorder, and the whole run is
/// rewritten from it.
///
/// THE JUDGEMENT MOVED WITH IT. "Did this release actually move anything?" used to be asked of the
/// stored rows, deliberately, so that a list drawn a moment before someone else wrote to it could
/// not mislead the answer. It is asked of `present` now, because that is the sequence the hand was
/// working in: a promoted book released in front of the book that visibly follows it has moved
/// nothing, whatever the stored ranks happen to say.
pub fn reorder(
    conn: &mut Connection,
    key: &RunKey,
    book_id: &str,
    before: Option<&str>,
    present: &[String],
) -> Result<Reordered, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let existing: Vec<(String, String)> = run_books(&tx, key).map_err(|e| e.to_string())?;
    // An empty `present` means the caller could not say what the run shows; the stored rows are then
    // the only answer there is. It is never the normal path.
    let baseline: Vec<String> = if present.is_empty() {
        existing.iter().map(|(id, _)| id.clone()).collect()
    } else {
        present.to_vec()
    };

    if !baseline.iter().any(|id| id == book_id) {
        return Err(format!("book {book_id} is not in this run"));
    }
    if let Some(b) = before {
        if b != book_id && !baseline.iter().any(|id| id == b) {
            return Err(format!("no book {b} in this run to land in front of"));
        }
    }

    // NOTHING TO DO, AND SO NOTHING TO CLAIM.
    //
    // Three cases, asked of NEIGHBOURS rather than of arithmetic:
    //
    //   · released in front of itself;
    //   · released in front of whatever already follows it;
    //   · released at the end when it is already last.
    //
    // Every position is offered to every book, including these. Hiding them made the number of
    // destinations depend on which book was in hand, and made the formats disagree about how many
    // there were. A release into one of them writes NOTHING — which matters more than it used to:
    // a write here would re-stamp `arranged_at` and quietly bake every outstanding promotion into
    // the reader's arrangement, on a gesture that was not an arrangement at all.
    let current = baseline.iter().position(|id| id == book_id).unwrap();
    let follows = baseline.get(current + 1).map(|s| s.as_str());
    let is_last = current + 1 == baseline.len();
    let no_move = match before {
        Some(b) if b == book_id => true,
        Some(b) => follows == Some(b),
        None => is_last,
    };
    if no_move {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Reordered { changed: false, order: baseline });
    }

    let mut seq: Vec<String> = baseline.iter().filter(|id| *id != book_id).cloned().collect();
    let at = match before {
        None => seq.len(),
        Some(b) => seq.iter().position(|id| id == b).unwrap_or(seq.len()),
    };
    seq.insert(at, book_id.to_string());

    // THE RUN IS WRITTEN WHOLE, and the rows it no longer contains go with it. A run's rows ARE its
    // books: a stray left behind is a rank belonging to a place the book has left, waiting to
    // resurface the next time that run is drawn.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    tx.execute(
        "DELETE FROM view_orders WHERE format = ?1 AND scope = ?2 AND section = ?3",
        (&key.format, &key.scope, &key.section),
    )
    .map_err(|e| e.to_string())?;
    let mut rank: Option<String> = None;
    for id in &seq {
        let next = between(rank.as_deref(), None)?;
        tx.execute(
            "INSERT INTO view_orders (format, scope, section, book_id, rank, arranged_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&key.format, &key.scope, &key.section, id, &next, now),
        )
        .map_err(|e| e.to_string())?;
        rank = Some(next);
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(Reordered { changed: true, order: seq })
}

/// Forget every order kept for a section — used when the shelf that drew it is deleted.
///
/// A book leaving a run is NOT this. Its row stays: rule membership comes and goes by design, and a
/// book that leaves a smart shelf and returns should come back where the reader put it rather than
/// at the end. A stale row costs one index entry and is invisible until the book returns.
pub fn forget_section(conn: &Connection, section: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM view_orders WHERE section = ?1", [section])
}

/// Whether a run has ever been arranged. The views ask this to decide whether to use the saved
/// order or the default one.
pub fn is_arranged(conn: &Connection, key: &RunKey) -> rusqlite::Result<bool> {
    let one: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM view_orders WHERE format = ?1 AND scope = ?2 AND section = ?3 LIMIT 1",
            [&key.format, &key.scope, &key.section],
            |r| r.get(0),
        )
        .optional()?;
    Ok(one.is_some())
}

#[cfg(test)]
mod baseline_tests {
    use super::*;

    /// The table as the migrations build it, without dragging the whole schema in: a run's rows are
    /// self-contained and the foreign key to `books` is not what these properties are about.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE view_orders (
               format TEXT NOT NULL, scope TEXT NOT NULL, section TEXT NOT NULL,
               book_id TEXT NOT NULL, rank TEXT NOT NULL,
               arranged_at INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (format, scope, section, book_id)) WITHOUT ROWID;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        conn
    }

    fn key() -> RunKey {
        RunKey { format: "grid".into(), scope: "".into(), section: WHOLE_RUN.into() }
    }

    fn ids(conn: &Connection) -> Vec<String> {
        run_books(conn, &key()).unwrap().into_iter().map(|(id, _)| id).collect()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_drag_adopts_the_run_the_reader_was_looking_at() {
        // The reader sees C A B D E — C promoted above an arrangement of A B C D E — and drags D in
        // front of A. What must persist is the sequence they were working in, with the move applied:
        // C D A B E. Resolving against the stored ranks instead would put D next to a neighbour that
        // was nowhere on screen.
        let mut conn = db();
        reorder(&mut conn, &key(), "A", None, &s(&["A", "B", "C", "D", "E"])).unwrap();
        let out = reorder(&mut conn, &key(), "D", Some("A"), &s(&["C", "A", "B", "D", "E"])).unwrap();
        assert!(out.changed);
        assert_eq!(out.order, s(&["C", "D", "A", "B", "E"]));
        assert_eq!(ids(&conn), s(&["C", "D", "A", "B", "E"]));
    }

    #[test]
    fn a_drag_stamps_the_run_so_old_promotions_stop_floating() {
        let mut conn = db();
        reorder(&mut conn, &key(), "B", Some("A"), &s(&["A", "B", "C"])).unwrap();
        let at: i64 = conn
            .query_row("SELECT DISTINCT arranged_at FROM view_orders", [], |r| r.get(0))
            .unwrap();
        assert!(at > 0, "a hand-arranged run carries the moment it was arranged");
    }

    #[test]
    fn a_release_that_moves_nothing_writes_nothing() {
        // This matters more than it looks: a write here would re-stamp the run and silently bake
        // every outstanding promotion into the reader's arrangement, on a gesture that arranged
        // nothing. All three no-move cases are judged against the run AS DRAWN.
        let mut conn = db();
        // Arrange it for real first: a no-move release writes nothing, so it cannot be used to
        // materialise a run any more — which is itself the correct behaviour and is pinned below.
        reorder(&mut conn, &key(), "C", Some("A"), &s(&["A", "B", "C"])).unwrap();
        let before: i64 = conn
            .query_row("SELECT DISTINCT arranged_at FROM view_orders", [], |r| r.get(0))
            .unwrap();
        let drawn = s(&["C", "A", "B"]);

        for (book, target) in [("C", Some("C")), ("C", Some("A")), ("B", None)] {
            let out = reorder(&mut conn, &key(), book, target, &drawn).unwrap();
            assert!(!out.changed, "{book} released at its own place must not write");
        }
        let after: i64 = conn
            .query_row("SELECT DISTINCT arranged_at FROM view_orders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after, "no-move releases must not re-stamp the run");
        assert_eq!(ids(&conn), s(&["C", "A", "B"]), "and must not rewrite the ranks");
    }

    #[test]
    fn a_run_never_keeps_rows_for_books_it_no_longer_holds() {
        let mut conn = db();
        reorder(&mut conn, &key(), "A", None, &s(&["A", "B", "C"])).unwrap();
        // B has since moved to another shelf, so it is no longer in this run.
        reorder(&mut conn, &key(), "C", Some("A"), &s(&["A", "C"])).unwrap();
        assert_eq!(ids(&conn), s(&["C", "A"]));
    }

    #[test]
    fn the_five_formats_keep_their_own_runs() {
        let mut conn = db();
        let grid = RunKey { format: "grid".into(), scope: "".into(), section: "*".into() };
        let covers = RunKey { format: "covers".into(), scope: "".into(), section: "*".into() };
        reorder(&mut conn, &grid, "C", Some("B"), &s(&["A", "B", "C"])).unwrap();
        reorder(&mut conn, &covers, "C", Some("A"), &s(&["A", "B", "C"])).unwrap();
        assert_eq!(
            run_books(&conn, &grid).unwrap().into_iter().map(|(i, _)| i).collect::<Vec<_>>(),
            s(&["A", "C", "B"])
        );
        assert_eq!(
            run_books(&conn, &covers).unwrap().into_iter().map(|(i, _)| i).collect::<Vec<_>>(),
            s(&["C", "A", "B"])
        );
    }

    #[test]
    fn a_book_outside_the_run_is_refused() {
        let mut conn = db();
        assert!(reorder(&mut conn, &key(), "Z", None, &s(&["A", "B"])).is_err());
        assert!(reorder(&mut conn, &key(), "A", Some("Z"), &s(&["A", "B"])).is_err());
    }

    #[test]
    fn the_epoch_is_read_when_one_was_stamped_and_zero_otherwise() {
        let conn = db();
        assert_eq!(epoch(&conn), 0);
        conn.execute("INSERT INTO settings (key, value) VALUES ('view_order_epoch', '1234')", [])
            .unwrap();
        assert_eq!(epoch(&conn), 1234);
    }

    #[test]
    fn a_deleted_section_takes_its_rows_with_it() {
        let mut conn = db();
        let shelf = RunKey { format: "covers".into(), scope: "s1".into(), section: "s1".into() };
        reorder(&mut conn, &shelf, "A", None, &s(&["A", "B"])).unwrap();
        assert_eq!(forget_section(&conn, "s1").unwrap(), 2);
        assert!(run_books(&conn, &shelf).unwrap().is_empty());
    }

    #[test]
    fn a_no_move_release_does_not_materialise_an_unarranged_run() {
        // It used to: the old write materialised first and only then asked whether anything had
        // moved, so picking a book up and putting it straight back froze the run. That was
        // harmless when the drawn and stored orders could not differ. It is not harmless now — the
        // freeze would capture every outstanding promotion as though the reader had arranged it.
        let mut conn = db();
        let out = reorder(&mut conn, &key(), "A", Some("B"), &s(&["A", "B", "C"])).unwrap();
        assert!(!out.changed);
        assert_eq!(out.order, s(&["A", "B", "C"]), "it still reports what the run shows");
        assert!(run_books(&conn, &key()).unwrap().is_empty(), "and wrote nothing at all");
    }
}
