//! WHERE A BOOK IS, AND IN WHAT ORDER.
//!
//! A book has zero or more PLACEMENTS. Each is a container and an ordering key: the container is a
//! shelf's id or [`UNFILED`], and the key is text that sorts itself. The primary key of the table is
//! the PAIR, so one book may sit on «روايات عربية» and on «المفضلة» at once, and the same book on
//! the same shelf twice is unrepresentable rather than merely discouraged.
//!
//! ## What the pair replaced, and why the old answer was right at the time
//!
//! The key used to be the BOOK alone, and said so deliberately: "which of this book's shelves is its
//! home" could not be asked. That solved a real fault. Membership had lived in `book_collections`,
//! keyed on the pair, and every consumer picked a home for itself — the flat views read the
//! membership rows, the grouped views used whichever band drew the tile, and the drag engine used a
//! third rule. Measured on a real library, one book reported «outside every shelf» in Grid and «قيد
//! القراءة» in Covers, and was offered forty-two destinations in one and six in the other.
//!
//! THE AMBIGUITY IS NOW ANSWERED RATHER THAN OUTLAWED, and what answers it is SCOPE — which the old
//! model did not have. A shelf shows its own memberships. The root library shows canonical books
//! once, ordered by `view_orders`, which has no container column and therefore cannot re-file
//! anything. There is no primary shelf, no first-array-element home, and nothing in this module will
//! choose one: a caller that needs a container must say which, or ask for all of them.
//!
//! ## The unfiled invariant
//!
//! A book has an [`UNFILED`] row IF AND ONLY IF it has no real shelf membership. [`settle_unfiled`]
//! is the single place that holds that true, and every write here ends by calling it — so "on no
//! shelf" stays a fact about the table rather than something each caller remembers.
//!
//! ## What a rule shelf is, and is not
//!
//! A rule shelf owns nothing. Its contents are a query over the library, so it has no rows to
//! delete, no order to change, and no placement to be. It observes books; it never holds them. Every
//! function here refuses to treat one as a container, which is what stops a book dragged out of
//! «قيد القراءة» from being added somewhere while remaining where it was.
//!
//! ## The keys
//!
//! Mirrors `src/features/library/design/rank.ts` exactly — the same alphabet, the same integer
//! marker, the same fraction. Both sides must agree, because the frontend computes the key for a
//! drop from the container it can see, while this side computes one when a book arrives from
//! elsewhere. `tests` at the bottom pin the two together with the same cases the TypeScript uses.

use rusqlite::{Connection, OptionalExtension};

/// The container holding every book that is on no shelf. Not a row in `collections`: a book with no
/// shelf still has a place and an order, and this is its name.
///
/// The literal matches `LOOSE_SHELF_ID` in the frontend, and it must. Naming it `__unfiled` here
/// while the interface called it `__unshelved` gave one container two ids: the arrangement filed
/// books under one, every view looked for them under the other, and each half quietly behaved as
/// though the other were empty. That is the same fault this whole model exists to remove, so the
/// two names are pinned to each other by the test at the bottom of this file.
pub const UNFILED: &str = "__unshelved";

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: u64 = 62;
/// Where a container's first book sits — the middle of a five-digit number, so there is room to
/// drop something in front of everything without the fraction ever being needed.
const START: u64 = BASE.pow(4); // 14,776,336

#[derive(Debug, Clone, serde::Serialize)]
pub struct Placement {
    pub book_id: String,
    pub container: String,
    pub rank: String,
    pub category_id: Option<String>,
}

fn digit(v: u64) -> char {
    DIGITS[v as usize] as char
}

fn digit_value(c: u8) -> Option<u64> {
    DIGITS.iter().position(|&d| d == c).map(|i| i as u64)
}

/// A whole number as a key: a marker saying how many digits follow, then the digits.
pub fn encode_int(n: u64) -> String {
    let mut digits = String::new();
    let mut left = n;
    loop {
        digits.insert(0, digit(left % BASE));
        left /= BASE;
        if left == 0 {
            break;
        }
    }
    format!("{}{}", digit(digits.len() as u64), digits)
}

struct Parts {
    head: String,
    int: u64,
    frac: String,
}

fn parse(rank: &str) -> Option<Parts> {
    let bytes = rank.as_bytes();
    let len = digit_value(*bytes.first()?)? as usize;
    if len == 0 || bytes.len() < 1 + len {
        return None;
    }
    let mut n: u64 = 0;
    for &b in &bytes[1..1 + len] {
        n = n.checked_mul(BASE)?.checked_add(digit_value(b)?)?;
    }
    Some(Parts {
        head: rank[..1 + len].to_string(),
        int: n,
        frac: rank[1 + len..].to_string(),
    })
}

fn frac_at(s: &str, i: usize) -> u64 {
    s.as_bytes().get(i).and_then(|&b| digit_value(b)).unwrap_or(0)
}

/// A fraction strictly between two fractions, where `""` is zero and `None` is one. Never ends in
/// the digit `0`, so a value has exactly one spelling.
fn frac_between(lower: &str, upper: Option<&str>) -> String {
    let mut out = String::new();
    let mut top = upper;
    let mut i = 0usize;
    loop {
        let da = frac_at(lower, i);
        let db = match top {
            None => BASE,
            Some(u) => frac_at(u, i),
        };
        if da == db {
            out.push(digit(da));
            i += 1;
            continue;
        }
        if db - da >= 2 {
            out.push(digit(da + (db - da) / 2));
            return out;
        }
        // Adjacent digits leave no room here; keep the lower one and look in the next place, where
        // the only bound left is the top of the range.
        out.push(digit(da));
        top = None;
        i += 1;
    }
}

/// A key strictly between two keys. `None` means "no bound" at that end.
pub fn between(lower: Option<&str>, upper: Option<&str>) -> Result<String, String> {
    match (lower, upper) {
        (None, None) => Ok(encode_int(START)),
        (Some(lo), None) => {
            let p = parse(lo).ok_or_else(|| format!("not a rank: {lo}"))?;
            Ok(encode_int(p.int + 1))
        }
        (None, Some(hi)) => {
            let h = parse(hi).ok_or_else(|| format!("not a rank: {hi}"))?;
            if h.int > 0 {
                return Ok(encode_int(h.int - 1));
            }
            if h.frac.is_empty() {
                return Err("no room below the first rank".into());
            }
            Ok(format!("{}{}", h.head, frac_between("", Some(&h.frac))))
        }
        (Some(lo), Some(hi)) => {
            if lo >= hi {
                return Err(format!("ranks out of order: {lo} is not before {hi}"));
            }
            let l = parse(lo).ok_or_else(|| format!("not a rank: {lo}"))?;
            let h = parse(hi).ok_or_else(|| format!("not a rank: {hi}"))?;
            if h.int - l.int >= 2 {
                return Ok(encode_int(l.int + (h.int - l.int) / 2));
            }
            let upper_frac = if h.int == l.int { Some(h.frac.as_str()) } else { None };
            Ok(format!("{}{}", l.head, frac_between(&l.frac, upper_frac)))
        }
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Every placement in the library, in container and rank order. One statement: the whole
/// arrangement arrives as a single consistent picture rather than one shelf at a time, which is
/// what removes the possibility of two shelves being read from either side of a write.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Placement>> {
    let mut stmt = conn.prepare(
        "SELECT book_id, container, rank, category_id FROM placements ORDER BY container, rank",
    )?;
    let out = stmt
        .query_map([], |r| {
            Ok(Placement {
                book_id: r.get(0)?,
                container: r.get(1)?,
                rank: r.get(2)?,
                category_id: r.get(3)?,
            })
        })?
        .collect();
    out
}

/// The books of one container, in order.
pub fn container_books(conn: &Connection, container: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn
        .prepare("SELECT book_id, rank FROM placements WHERE container = ?1 ORDER BY rank")?;
    let out = stmt
        .query_map([container], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect();
    out
}

fn is_rule_shelf(conn: &Connection, container: &str) -> rusqlite::Result<bool> {
    if container == UNFILED {
        return Ok(false);
    }
    let rule: Option<Option<String>> = conn
        .query_row(
            "SELECT auto_rule FROM collections WHERE id = ?1",
            [container],
            |r| r.get(0),
        )
        .optional()?;
    Ok(matches!(rule, Some(Some(_))))
}

/// The key that puts a book at the end of a container.
pub fn append_rank(conn: &Connection, container: &str) -> rusqlite::Result<String> {
    let last: Option<String> = conn
        .query_row(
            "SELECT rank FROM placements WHERE container = ?1 ORDER BY rank DESC LIMIT 1",
            [container],
            |r| r.get(0),
        )
        .optional()?;
    Ok(between(last.as_deref(), None).unwrap_or_else(|_| encode_int(START)))
}

/// One membership, if it exists: its key and its category.
fn membership(
    conn: &Connection,
    book_id: &str,
    container: &str,
) -> rusqlite::Result<Option<(String, Option<String>)>> {
    conn.query_row(
        "SELECT rank, category_id FROM placements WHERE book_id = ?1 AND container = ?2",
        rusqlite::params![book_id, container],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// THE KEY FOR A GAP, computed from the container as it actually is.
///
/// `before` names the book to land in front of, or `None` for the end. A position, not an index: an
/// index has to be corrected for the moving book's own removal and has to agree with a list the
/// caller drew some milliseconds ago, and both were sources of silent, off-by-one error.
fn rank_for(
    conn: &Connection,
    container: &str,
    book_id: &str,
    before: Option<&str>,
) -> Result<String, String> {
    let books = container_books(conn, container).map_err(|e| e.to_string())?;
    let without: Vec<&(String, String)> = books.iter().filter(|(id, _)| id != book_id).collect();
    let index = match before {
        None => without.len(),
        Some(b) => without
            .iter()
            .position(|(id, _)| id == b)
            // A target that has since moved away means the end, rather than a refusal the reader
            // would experience as a drop that did nothing.
            .unwrap_or(without.len()),
    };
    let lower = if index > 0 { Some(without[index - 1].1.as_str()) } else { None };
    let upper = if index < without.len() { Some(without[index].1.as_str()) } else { None };
    between(lower, upper)
}

/// What every write refuses before it starts: a rule shelf, and another shelf's category.
fn guard_container(
    conn: &Connection,
    container: &str,
    category_id: Option<&str>,
) -> Result<(), String> {
    if is_rule_shelf(conn, container).map_err(|e| e.to_string())? {
        return Err("a rule shelf holds a query, not books".into());
    }
    // A CATEGORY BELONGS TO ONE SHELF. Storing another shelf's category id would leave a row every
    // view reads as uncategorised, and deleting the real category would leave it pointing at
    // nothing. That locality is what lets one book carry a different category on each of its
    // shelves, so it matters more now than it did when a book had one placement.
    if let Some(cat) = category_id {
        let ok: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM collection_categories WHERE id = ?1 AND collection_id = ?2",
                rusqlite::params![cat, container],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if ok == 0 {
            return Err("that category belongs to another shelf".into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

/// Write ONE membership at a key: this book, in this container.
///
/// One statement, so a reader can never observe a half-written membership — the failure the old
/// remove-then-insert-then-renumber sequence made possible. Refuses a rule shelf, because a query
/// cannot be written to and an "add" that silently left the book where it was is exactly the
/// behaviour a reader reads as the book having been copied.
///
/// It writes the named membership and touches no other. Callers that mean "and nowhere else" must
/// say so; [`place_book`] is the one that does.
pub fn set(
    conn: &Connection,
    book_id: &str,
    container: &str,
    rank: &str,
    category_id: Option<&str>,
) -> Result<(), String> {
    if is_rule_shelf(conn, container).map_err(|e| e.to_string())? {
        return Err("a rule shelf holds a query, not books".into());
    }
    if parse(rank).is_none() {
        return Err(format!("not a rank: {rank}"));
    }
    conn.execute(
        "INSERT INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_id, container) DO UPDATE SET rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

/// Every container holding this book. May be empty, may be one, may be several. No order is implied
/// beyond the container's own id — there is no first and no primary.
pub fn containers_of(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT container FROM placements WHERE book_id = ?1 ORDER BY container")?;
    let out = stmt.query_map([book_id], |r| r.get::<_, String>(0))?.collect();
    out
}

/// How many REAL shelves hold this book. [`UNFILED`] is a container, and deliberately not a shelf.
pub fn shelf_memberships(conn: &Connection, book_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM placements WHERE book_id = ?1 AND container <> ?2",
        rusqlite::params![book_id, UNFILED],
        |r| r.get(0),
    )
}

/// HOLD THE UNFILED INVARIANT: an [`UNFILED`] row exists if and only if no real shelf holds the book.
///
/// Called at the end of every write in this module, so no caller has to remember it and no two
/// callers can disagree about it. Both directions matter. A book that joins its first shelf must
/// stop appearing among «خارج الأرفف» — otherwise it is visibly in two places for one membership,
/// which is exactly the "copied" reading this design exists to prevent. A book that loses its last
/// shelf must reappear there, at the end, rather than becoming a book with no place at all.
///
/// A book that no longer exists gets nothing: its rows have already cascaded away with it.
pub fn settle_unfiled(conn: &Connection, book_id: &str) -> rusqlite::Result<()> {
    let exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM books WHERE id = ?1", [book_id], |r| r.get(0))?;
    if exists == 0 {
        return Ok(());
    }
    let shelved = shelf_memberships(conn, book_id)?;
    let unfiled: i64 = conn.query_row(
        "SELECT COUNT(*) FROM placements WHERE book_id = ?1 AND container = ?2",
        rusqlite::params![book_id, UNFILED],
        |r| r.get(0),
    )?;
    if shelved > 0 && unfiled > 0 {
        conn.execute(
            "DELETE FROM placements WHERE book_id = ?1 AND container = ?2",
            rusqlite::params![book_id, UNFILED],
        )?;
    } else if shelved == 0 && unfiled == 0 {
        let rank = append_rank(conn, UNFILED)?;
        conn.execute(
            "INSERT OR IGNORE INTO placements(book_id, container, rank, category_id) \
             VALUES(?1, ?2, ?3, NULL)",
            rusqlite::params![book_id, UNFILED, rank],
        )?;
    }
    Ok(())
}

/// Take a book off ONE shelf, leaving every other membership alone.
///
/// Returns whether a membership was actually there to remove. What it never does is reach the book:
/// the `books` row, the file, the progress, the notes, the highlights and the references are all
/// keyed on the book and none of them is touched here. If this was the last shelf, the book joins
/// «خارج الأرفف» — it does not become placeless, and it certainly does not disappear.
pub fn remove_from(conn: &Connection, book_id: &str, container: &str) -> rusqlite::Result<bool> {
    let gone = conn.execute(
        "DELETE FROM placements WHERE book_id = ?1 AND container = ?2",
        rusqlite::params![book_id, container],
    )?;
    settle_unfiled(conn, book_id)?;
    Ok(gone > 0)
}

/// What a placement attempt did.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Placed {
    /// False when the book was already exactly there. Nothing was written and nothing should be
    /// announced — a release that changes nothing is not a move, and reporting one as a success is
    /// the reader's «it said it moved and it did not».
    pub changed: bool,
    pub container: String,
    pub rank: String,
}

/// MOVE A BOOK IN FRONT OF ANOTHER — the one arrangement transaction.
///
/// `before` names the book the release landed in front of, or `None` for the end of the container.
/// A position, not an index: an index has to be corrected for the book's own removal and has to
/// agree with a list the caller drew some milliseconds ago, and both of those were sources of
/// silent error. A neighbour is a fact that survives the list being redrawn.
///
/// THE KEY IS COMPUTED HERE, inside the transaction, from the container as it actually is. Letting
/// the caller compute it would let a list drawn before someone else's write produce a key that
/// collides or lands in the wrong gap.
pub fn place_book(
    conn: &Connection,
    book_id: &str,
    container: &str,
    before: Option<&str>,
    category_id: Option<&str>,
) -> Result<Placed, String> {
    guard_container(conn, container, category_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // ── is this a move at all? ──────────────────────────────────
    // Reads the membership IN THIS CONTAINER. It used to read "the book's placement", which had
    // exactly one answer because the key was the book. With several memberships that question has
    // no single answer, and asking it anyway is precisely the ambiguity this model exists to end.
    let here = membership(&tx, book_id, container).map_err(|e| e.to_string())?;
    if let Some((cur_rank, cur_category)) = &here {
        let books = container_books(&tx, container).map_err(|e| e.to_string())?;
        if let Some(at) = books.iter().position(|(id, _)| id == book_id) {
            let next = books.get(at + 1).map(|(id, _)| id.as_str());
            let settled = cur_category.as_deref() == category_id
                && (before == Some(book_id) || before == next);
            // …and nothing to strip elsewhere. A book already in the right gap here but ALSO on
            // another shelf still has work to do, since this entry point means "and nowhere else".
            let elsewhere: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM placements WHERE book_id = ?1 AND container <> ?2",
                    rusqlite::params![book_id, container],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if settled && elsewhere == 0 {
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(Placed {
                    changed: false,
                    container: container.to_string(),
                    rank: cur_rank.clone(),
                });
            }
        }
    }

    let rank = rank_for(&tx, container, book_id, before)?;

    // ── AND NOWHERE ELSE ──────────────────────────────────────
    //
    // This is what makes this function a MOVE, and it is deliberate rather than left over. The
    // single-placement era expressed it through the primary key: an upsert keyed on the book
    // rewrote the one row it had, so arriving somewhere WAS leaving everywhere. With the key
    // widened to the pair, that same upsert would quietly add a second membership instead — the
    // drag that reads to a reader as the book having been copied.
    //
    // So the sweep is stated out loud. Every caller of this function today is a drag or a menu
    // built when a book had one place, and each keeps the behaviour it was written for until it is
    // taught otherwise. [`add_to`] is the entry point that adds a membership and leaves the rest
    // standing; nothing calls it yet, which is exactly why the database cannot get ahead of the
    // interface that reads it.
    tx.execute(
        "DELETE FROM placements WHERE book_id = ?1 AND container <> ?2",
        rusqlite::params![book_id, container],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_id, container) DO UPDATE SET rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    settle_unfiled(&tx, book_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Placed { changed: true, container: container.to_string(), rank })
}

/// ADD A MEMBERSHIP, LEAVING EVERY OTHER ONE STANDING.
///
/// The difference from [`place_book`] is the whole point of multi-membership, so it is stated as two
/// functions rather than a flag: this one adds, that one moves. A book on «روايات عربية» that is
/// added to «المفضلة» is afterwards on both, and «المفضلة» is not more or less its home than the
/// other — there is no home.
///
/// `before` positions the arrival exactly as it does for a move, and `None` means THE END OF THE
/// SHELF — including for a book that is already on it, which is then moved to the end.
///
/// That last part is why [`ensure_on`] exists beside this. «No neighbour named» has two possible
/// meanings and they are not the same write: «put it at the end» is what an index-shaped caller
/// means, and «I am not saying anything about where» is what choosing a shelf from a list means.
/// One function cannot answer both, and while it tried, asking for a book to be moved to the end of
/// a shelf it was already on silently did nothing.
pub fn add_to(
    conn: &Connection,
    book_id: &str,
    container: &str,
    before: Option<&str>,
    category_id: Option<&str>,
) -> Result<Placed, String> {
    guard_container(conn, container, category_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rank = rank_for(&tx, container, book_id, before)?;
    tx.execute(
        "INSERT INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_id, container) DO UPDATE SET rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    settle_unfiled(&tx, book_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Placed { changed: true, container: container.to_string(), rank })
}

/// BE ON THIS SHELF, WITHOUT SAYING ANYTHING ABOUT WHERE ON IT.
///
/// What «add this book to that shelf» means when the reader chose a shelf from a list: it names the
/// shelf and nothing about the book's neighbours. So a book that is already there does not move.
///
/// IDEMPOTENT. Adding a book to a shelf it is already on writes nothing and reports
/// `changed: false`, so the interface can offer the action without first knowing the answer. The
/// database enforces the same from underneath: the primary key is the pair, so a duplicate
/// membership cannot be stored even if some future caller forgets to ask.
///
/// A CATEGORY IS STILL HONOURED. Re-grouping a book within a shelf it is already on is a real write
/// and the only correct route to one — the alternative was `place_book`, which would have swept
/// away every other shelf the book was on as a side effect of grouping it, and re-ranked it to the
/// caller's index into the bargain. The rank is left exactly as it is.
pub fn ensure_on(
    conn: &Connection,
    book_id: &str,
    container: &str,
    category_id: Option<&str>,
) -> Result<Placed, String> {
    guard_container(conn, container, category_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if let Some((rank, current_category)) =
        membership(&tx, book_id, container).map_err(|e| e.to_string())?
    {
        if current_category.as_deref() == category_id {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(Placed { changed: false, container: container.to_string(), rank });
        }
        tx.execute(
            "UPDATE placements SET category_id = ?3 WHERE book_id = ?1 AND container = ?2",
            rusqlite::params![book_id, container, category_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Placed { changed: true, container: container.to_string(), rank });
    }

    // Not here yet: it joins at the end, which is what choosing a shelf from a list means.
    let rank = rank_for(&tx, container, book_id, None)?;
    tx.execute(
        "INSERT INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_id, container) DO UPDATE SET rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    settle_unfiled(&tx, book_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Placed { changed: true, container: container.to_string(), rank })
}

/// MOVE ONE MEMBERSHIP: arrive at `to`, and leave `from` — only `from`.
///
/// The narrow move, as against [`place_book`]'s "and nowhere else". A book on A, B and C that is
/// moved from A to D is afterwards on B, C and D: the memberships nobody mentioned are nobody's
/// business. Moving a book to the shelf it is already on is a reorder within that shelf, so `from`
/// equal to `to` is honoured rather than refused.
pub fn move_between(
    conn: &Connection,
    book_id: &str,
    from: &str,
    to: &str,
    before: Option<&str>,
    category_id: Option<&str>,
) -> Result<Placed, String> {
    let placed = add_to(conn, book_id, to, before, category_id)?;
    if from != to {
        remove_from(conn, book_id, from).map_err(|e| e.to_string())?;
    }
    Ok(placed)
}

/// Give a placement to every book that has none.
///
/// A book imported after the migration, or one whose placement was cascaded away, would otherwise
/// have no place at all — and "no place" is the state this design exists to abolish. New books join
/// the unfiled container at the end, in title order so an import of many arrives in a sensible run
/// rather than an arbitrary one. Cheap enough to run at every launch: one query that finds nothing.
pub fn ensure(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT b.id FROM books b LEFT JOIN placements p ON p.book_id = b.id \
         WHERE p.book_id IS NULL \
         ORDER BY LOWER(COALESCE((SELECT value FROM metadata_overrides \
                                   WHERE book_id = b.id AND field = 'title'), b.title, '')), b.id",
    )?;
    let missing: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<_, _>>()?;
    if missing.is_empty() {
        return Ok(0);
    }
    let mut last: Option<String> = conn
        .query_row(
            "SELECT rank FROM placements WHERE container = ?1 ORDER BY rank DESC LIMIT 1",
            [UNFILED],
            |r| r.get(0),
        )
        .optional()?;
    for id in &missing {
        let rank = between(last.as_deref(), None).unwrap_or_else(|_| encode_int(START));
        conn.execute(
            "INSERT OR IGNORE INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, NULL)",
            rusqlite::params![id, UNFILED, rank],
        )?;
        last = Some(rank);
    }
    Ok(missing.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same cases the TypeScript side pins, so the two encoders cannot drift apart.
    /// The frontend and this module must agree on what the unfiled container is called. They are
    /// separate literals in separate languages; nothing but a check keeps them the same.
    #[test]
    fn the_unfiled_container_has_one_name() {
        // The interface declares it once, in `ipc.ts`, and the library model imports that rather
        // than writing the string a second time. This pins the Rust literal to the same value.
        let ts = std::fs::read_to_string("../src/lib/ipc.ts")
            .expect("ipc.ts must be readable from the crate root");
        assert!(
            ts.contains(&format!("export const UNFILED = \"{UNFILED}\"")),
            "the interface must call the unfiled container {UNFILED}"
        );
    }

    #[test]
    fn keys_match_the_frontend() {
        assert_eq!(encode_int(0), "10");
        assert_eq!(encode_int(61), "1z");
        assert_eq!(encode_int(62), "210");
        assert_eq!(encode_int(START), "510000");
        assert_eq!(between(None, None).unwrap(), "510000");
    }

    #[test]
    fn appending_stays_short() {
        let mut r = between(None, None).unwrap();
        for _ in 0..10_000 {
            let next = between(Some(&r), None).unwrap();
            assert!(next > r, "{next} must sort after {r}");
            r = next;
        }
        assert!(r.len() < 12, "appending must not lengthen the key: {r}");
    }

    #[test]
    fn squeezing_the_same_gap_never_fails() {
        let lo = between(None, None).unwrap();
        let mut hi = between(Some(&lo), None).unwrap();
        for _ in 0..2_000 {
            let mid = between(Some(&lo), Some(&hi)).unwrap();
            assert!(mid > lo && mid < hi);
            hi = mid;
        }
    }

    #[test]
    fn refuses_bounds_out_of_order() {
        let a = encode_int(5);
        let b = encode_int(9);
        assert!(between(Some(&b), Some(&a)).is_err());
        assert!(between(Some(&a), Some(&a)).is_err());
    }

    // =======================================================================
    // MULTI-MEMBERSHIP — one book, several shelves, one book row.
    //
    // These are the foundation's own proofs. They assert the SCHEMA's guarantees where the schema
    // makes them, and the model's where it does not: a primary key can forbid a duplicate
    // membership, but only code can hold "unfiled if and only if nothing else".
    // =======================================================================

    /// The version this migration was given. Anything below it is the schema as it shipped.
    const WIDENED: i64 = 20_260_910_190_000;

    fn migrated(upto: Option<i64>) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::register_functions(&conn).unwrap();
        for (version, _, sql) in crate::db::migrations::MIGRATIONS {
            if upto.is_some_and(|stop| *version >= stop) {
                continue;
            }
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn db() -> Connection {
        migrated(None)
    }

    fn add_book(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books(id, file_path, format, title, added_at) VALUES(?1, ?1, 'epub', ?1, 0)",
            [id],
        )
        .unwrap();
    }

    fn add_shelf(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO collections(id, name) VALUES(?1, ?1)", [id]).unwrap();
    }

    fn add_category(conn: &Connection, id: &str, shelf: &str) {
        conn.execute(
            "INSERT INTO collection_categories(id, collection_id, name) VALUES(?1, ?2, ?1)",
            rusqlite::params![id, shelf],
        )
        .unwrap();
    }

    fn rows(conn: &Connection, book: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM placements WHERE book_id = ?1", [book], |r| r.get(0))
            .unwrap()
    }

    fn rank_in(conn: &Connection, book: &str, container: &str) -> Option<String> {
        membership(conn, book, container).unwrap().map(|(rank, _)| rank)
    }

    fn category_in(conn: &Connection, book: &str, container: &str) -> Option<String> {
        membership(conn, book, container).unwrap().and_then(|(_, cat)| cat)
    }

    #[test]
    fn one_book_sits_on_several_shelves_and_is_still_one_book() {
        let conn = db();
        add_book(&conn, "x");
        for s in ["arabic", "favourites", "this-week"] {
            add_shelf(&conn, s);
            add_to(&conn, "x", s, None, None).unwrap();
        }
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["arabic", "favourites", "this-week"]);
        assert_eq!(shelf_memberships(&conn, "x").unwrap(), 3);
        // THE INVARIANT THE WHOLE FEATURE RESTS ON. Three memberships, one book.
        let books: i64 =
            conn.query_row("SELECT COUNT(*) FROM books WHERE id = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1, "three memberships must not be three books");
        let files: i64 = conn
            .query_row("SELECT COUNT(DISTINCT file_path) FROM books WHERE id = 'x'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(files, 1, "and not three files");
    }

    #[test]
    fn the_same_shelf_twice_is_one_membership() {
        let conn = db();
        add_book(&conn, "x");
        add_shelf(&conn, "a");

        let first = ensure_on(&conn, "x", "a", None).unwrap();
        assert!(first.changed);
        let again = ensure_on(&conn, "x", "a", None).unwrap();
        assert!(!again.changed, "adding it where it already is changes nothing");
        assert_eq!(again.rank, first.rank, "and does not re-rank it");
        assert_eq!(rows(&conn, "x"), 1);

        // …AND THE DATABASE REFUSES IT FROM UNDERNEATH, so a future caller that forgets to ask
        // cannot store one either. This is the guarantee the frontend used to have to provide.
        let direct = conn.execute(
            "INSERT INTO placements(book_id, container, rank, category_id) VALUES('x', 'a', '510001', NULL)",
            [],
        );
        assert!(direct.is_err(), "a duplicate membership must be unrepresentable");
    }

    #[test]
    fn rank_belongs_to_the_membership_not_to_the_book() {
        let conn = db();
        for b in ["x", "p", "q"] {
            add_book(&conn, b);
        }
        for s in ["a", "b"] {
            add_shelf(&conn, s);
        }
        // Shelf A: p, q, x — shelf B: x, p.
        for b in ["p", "q", "x"] {
            add_to(&conn, b, "a", None, None).unwrap();
        }
        for b in ["x", "p"] {
            add_to(&conn, b, "b", None, None).unwrap();
        }
        let before_b = rank_in(&conn, "x", "b").unwrap();

        // Reorder x to the front of A only.
        add_to(&conn, "x", "a", Some("p"), None).unwrap();

        let a_order: Vec<String> =
            container_books(&conn, "a").unwrap().into_iter().map(|(id, _)| id).collect();
        assert_eq!(a_order, vec!["x", "p", "q"], "A reordered");
        assert_eq!(
            rank_in(&conn, "x", "b").unwrap(),
            before_b,
            "and B did not move an inch"
        );
        let b_order: Vec<String> =
            container_books(&conn, "b").unwrap().into_iter().map(|(id, _)| id).collect();
        assert_eq!(b_order, vec!["x", "p"]);
    }

    #[test]
    fn category_belongs_to_the_membership_not_to_the_book() {
        let conn = db();
        add_book(&conn, "x");
        for s in ["a", "b"] {
            add_shelf(&conn, s);
        }
        add_category(&conn, "cat-a", "a");
        add_category(&conn, "cat-b", "b");
        add_to(&conn, "x", "a", None, Some("cat-a")).unwrap();
        add_to(&conn, "x", "b", None, Some("cat-b")).unwrap();

        assert_eq!(category_in(&conn, "x", "a").as_deref(), Some("cat-a"));
        assert_eq!(category_in(&conn, "x", "b").as_deref(), Some("cat-b"));

        // Changing it on one shelf leaves the other alone.
        add_to(&conn, "x", "a", Some("x"), None).unwrap();
        assert_eq!(category_in(&conn, "x", "a"), None);
        assert_eq!(category_in(&conn, "x", "b").as_deref(), Some("cat-b"));

        // And a category still cannot cross shelves.
        assert!(add_to(&conn, "x", "a", None, Some("cat-b")).is_err());
    }

    #[test]
    fn unfiled_holds_exactly_when_nothing_else_does() {
        let conn = db();
        add_book(&conn, "x");
        add_shelf(&conn, "a");
        add_shelf(&conn, "b");

        // A book nothing has filed is unfiled.
        ensure(&conn).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec![UNFILED]);

        // Its first real shelf takes it out of «خارج الأرفف» — it must not be visibly in both.
        add_to(&conn, "x", "a", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a"]);

        add_to(&conn, "x", "b", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a", "b"]);

        // Losing one shelf is not losing the book, and does not unfile it.
        remove_from(&conn, "x", "a").unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["b"]);

        // Losing the last one puts it back among the unfiled, rather than nowhere at all.
        remove_from(&conn, "x", "b").unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec![UNFILED]);
    }

    #[test]
    fn removing_one_membership_keeps_the_book_and_the_others() {
        let conn = db();
        add_book(&conn, "x");
        for s in ["a", "b", "c"] {
            add_shelf(&conn, s);
            add_to(&conn, "x", s, None, None).unwrap();
        }
        assert!(remove_from(&conn, "x", "a").unwrap());
        assert!(!remove_from(&conn, "x", "a").unwrap(), "and says so when there was nothing to remove");

        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["b", "c"]);
        let books: i64 =
            conn.query_row("SELECT COUNT(*) FROM books WHERE id = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1, "the canonical book survives losing a shelf");
    }

    #[test]
    fn a_narrow_move_leaves_only_the_shelf_it_was_told_to() {
        let conn = db();
        add_book(&conn, "x");
        for s in ["a", "b", "d"] {
            add_shelf(&conn, s);
        }
        add_to(&conn, "x", "a", None, None).unwrap();
        add_to(&conn, "x", "b", None, None).unwrap();

        move_between(&conn, "x", "a", "d", None, None).unwrap();
        assert_eq!(
            containers_of(&conn, "x").unwrap(),
            vec!["b", "d"],
            "the membership nobody mentioned is nobody's business"
        );
    }

    #[test]
    fn place_book_still_means_and_nowhere_else() {
        // STAGE-1 BEHAVIOUR PRESERVATION, pinned. Every caller of `place_book` today was written
        // when a book had one place. If widening the key had quietly turned it into an add, every
        // existing drag would have started copying — which is the exact fault the single-placement
        // model was introduced to cure.
        let conn = db();
        add_book(&conn, "x");
        for s in ["a", "b", "d"] {
            add_shelf(&conn, s);
        }
        add_to(&conn, "x", "a", None, None).unwrap();
        add_to(&conn, "x", "b", None, None).unwrap();

        place_book(&conn, "x", "d", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["d"]);
        assert_eq!(rows(&conn, "x"), 1);
    }

    #[test]
    fn the_migration_widens_the_key_without_moving_a_row() {
        // A library as it stands today: one placement per book, written under the old key.
        let conn = migrated(Some(WIDENED));
        for b in ["x", "y", "z"] {
            add_book(&conn, b);
        }
        add_shelf(&conn, "a");
        conn.execute(
            "INSERT INTO placements(book_id, container, rank, category_id) VALUES \
             ('x','a','510000',NULL), ('y','a','510001',NULL), ('z','__unshelved','510000',NULL)",
            [],
        )
        .unwrap();
        // The old key really did forbid the second membership — otherwise this test proves nothing.
        assert!(
            conn.execute(
                "INSERT INTO placements(book_id, container, rank, category_id) VALUES('x','__unshelved','510002',NULL)",
                [],
            )
            .is_err(),
            "before the migration, a book could hold only one placement"
        );

        let before: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT book_id, container, rank FROM placements ORDER BY book_id")
                .unwrap();
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            v
        };

        let (_, _, sql) = crate::db::migrations::MIGRATIONS
            .iter()
            .find(|(v, _, _)| *v == WIDENED)
            .expect("the widening migration must be registered");
        conn.execute_batch(sql).unwrap();

        let after: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT book_id, container, rank FROM placements ORDER BY book_id")
                .unwrap();
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            v
        };
        assert_eq!(before, after, "every arrangement survives the rebuild, byte for byte");

        // And the thing it exists to permit is now permitted.
        add_shelf(&conn, "b");
        add_to(&conn, "x", "b", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a", "b"]);
    }

    #[test]
    fn the_cascade_still_takes_every_membership_with_the_book() {
        // Deleting the BOOK is a different act from taking it off a shelf, and it must still reach
        // all of its memberships — the foreign key is per row, so several rows now cascade.
        let conn = db();
        add_book(&conn, "x");
        for s in ["a", "b"] {
            add_shelf(&conn, s);
            add_to(&conn, "x", s, None, None).unwrap();
        }
        conn.execute("DELETE FROM books WHERE id = 'x'", []).unwrap();
        assert_eq!(rows(&conn, "x"), 0);
    }

    #[test]
    fn setting_a_category_keeps_the_rank_and_every_other_shelf() {
        // RE-GROUPING IS NOT MOVING. Before this, the only way to set a book's category on a shelf
        // was `place_book`, which meant «here and nowhere else» — so tidying the groups inside one
        // shelf deleted the book's memberships everywhere else, and re-ranked it to the caller's
        // index into the bargain.
        let conn = db();
        add_book(&conn, "x");
        for sh in ["a", "b"] {
            add_shelf(&conn, sh);
        }
        add_category(&conn, "cat-a", "a");
        add_to(&conn, "x", "a", None, None).unwrap();
        add_to(&conn, "x", "b", None, None).unwrap();
        let rank_before = rank_in(&conn, "x", "a").unwrap();

        let out = ensure_on(&conn, "x", "a", Some("cat-a")).unwrap();
        assert!(out.changed, "a category that differs is a change");
        assert_eq!(category_in(&conn, "x", "a").as_deref(), Some("cat-a"));
        assert_eq!(rank_in(&conn, "x", "a").unwrap(), rank_before, "and it did not move the book");
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a", "b"], "nor take it off shelf b");

        // Asking for the category it already has is still nothing to do.
        let again = ensure_on(&conn, "x", "a", Some("cat-a")).unwrap();
        assert!(!again.changed);

        // …and clearing it is a change in the other direction.
        let cleared = ensure_on(&conn, "x", "a", None).unwrap();
        assert!(cleared.changed);
        assert_eq!(category_in(&conn, "x", "a"), None);
        assert_eq!(category_in(&conn, "x", "b"), None);
    }

    #[test]
    fn the_shelves_of_a_book_are_all_of_them() {
        // `collections_for_book` was a `query_row` wrapped in a one-element vector: against a book
        // on three shelves it returned whichever row came first and dropped the rest in silence.
        let conn = db();
        add_book(&conn, "x");
        for sh in ["a", "b", "c"] {
            add_shelf(&conn, sh);
            add_to(&conn, "x", sh, None, None).unwrap();
        }
        let mut shelves = crate::library::collections_for_book(&conn, "x").unwrap();
        shelves.sort();
        assert_eq!(shelves, vec!["a", "b", "c"]);

        // A book on no shelf still reports none, and the unfiled container is not a shelf.
        add_book(&conn, "lonely");
        ensure(&conn).unwrap();
        assert!(crate::library::collections_for_book(&conn, "lonely").unwrap().is_empty());
    }

    #[test]
    fn a_move_that_names_its_source_leaves_only_that_one() {
        // The whole of the drag fix, at the level the command calls into. A book kept on three
        // shelves that is dragged from one of them onto a fourth must lose exactly one.
        let conn = db();
        add_book(&conn, "x");
        for sh in ["a", "b", "c", "d"] {
            add_shelf(&conn, sh);
        }
        for sh in ["a", "b", "c"] {
            add_to(&conn, "x", sh, None, None).unwrap();
        }
        move_between(&conn, "x", "a", "d", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["b", "c", "d"]);

        // And the sweeping form is still available, and still sweeps, for anyone who means it.
        place_book(&conn, "x", "a", None, None).unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a"]);
    }


    #[test]
    fn the_legacy_add_command_adds() {
        // It swept, under a name that says «add» — measured through the registered command against
        // a book on three shelves: «a, b, c» in, «b» out. It survived six stages because nothing
        // called it and nothing tested it, which is exactly the pair of facts that lets a command
        // drift from its own name.
        let conn = db();
        add_book(&conn, "x");
        for sh in ["a", "b", "c"] {
            add_shelf(&conn, sh);
            add_to(&conn, "x", sh, None, None).unwrap();
        }
        add_shelf(&conn, "d");
        crate::library::collection_add_book(&conn, "d", "x").unwrap();
        assert_eq!(
            containers_of(&conn, "x").unwrap(),
            vec!["a", "b", "c", "d"],
            "adding a shelf keeps the shelves it was on"
        );

        // Idempotent, like the additive command beside it.
        crate::library::collection_add_book(&conn, "d", "x").unwrap();
        assert_eq!(containers_of(&conn, "x").unwrap(), vec!["a", "b", "c", "d"]);
        assert_eq!(rows(&conn, "x"), 4, "and never a duplicate membership");

        // A book on nothing joins its first shelf and stops being unfiled.
        add_book(&conn, "lonely");
        ensure(&conn).unwrap();
        assert_eq!(containers_of(&conn, "lonely").unwrap(), vec![UNFILED]);
        crate::library::collection_add_book(&conn, "a", "lonely").unwrap();
        assert_eq!(containers_of(&conn, "lonely").unwrap(), vec!["a"]);
    }

}
