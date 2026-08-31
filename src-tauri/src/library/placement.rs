//! WHERE A BOOK IS, AND IN WHAT ORDER — the one answer.
//!
//! A book has exactly one placement: a container and an ordering key. The container is a shelf's id
//! or [`UNFILED`]; the key is text that sorts itself. The primary key of the table is the BOOK, so
//! "which of this book's shelves is its home" is not a question anyone has to answer — it cannot be
//! asked. That is the whole point: it used to be answered independently by the flat views, by the
//! grouped views and by the drag engine, and on a real library those three disagreed.
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

// ---------------------------------------------------------------------------
// The one write
// ---------------------------------------------------------------------------

/// Put a book in a container at a key. This is the ONLY way an arrangement changes.
///
/// One statement, so a reader can never observe a book in two places or in none — the failure the
/// old remove-then-insert-then-renumber sequence made possible. Refuses a rule shelf, because a
/// query cannot be written to and an "add" that silently left the book where it was is exactly the
/// behaviour a reader reads as the book having been copied.
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
         ON CONFLICT(book_id) DO UPDATE SET container = ?2, rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    if is_rule_shelf(conn, container).map_err(|e| e.to_string())? {
        return Err("a rule shelf holds a query, not books".into());
    }
    // A CATEGORY BELONGS TO ONE SHELF. Storing another shelf's category id would leave a row every
    // view reads as uncategorised, and deleting the real category would leave it pointing at
    // nothing. No caller does this today, which is exactly why it is refused here rather than
    // trusted — the check lived in the old placement path and has to keep living in the new one.
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
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let books = container_books(&tx, container).map_err(|e| e.to_string())?;
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT container, rank FROM placements WHERE book_id = ?1",
            [book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    // ── is this a move at all? ──────────────────────────────────────────────────────────
    if let Some((cur_container, cur_rank)) = &current {
        if cur_container == container {
            let at = books.iter().position(|(id, _)| id == book_id);
            if let Some(at) = at {
                let next = books.get(at + 1).map(|(id, _)| id.as_str());
                let same_category = tx
                    .query_row(
                        "SELECT category_id FROM placements WHERE book_id = ?1",
                        [book_id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                    .flatten();
                let category_unchanged = same_category.as_deref() == category_id;
                if category_unchanged && (before == Some(book_id) || before == next) {
                    tx.commit().map_err(|e| e.to_string())?;
                    return Ok(Placed {
                        changed: false,
                        container: cur_container.clone(),
                        rank: cur_rank.clone(),
                    });
                }
            }
        }
    }

    // ── where it goes ───────────────────────────────────────────────────────────────────
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
    let rank = between(lower, upper)?;

    tx.execute(
        "INSERT INTO placements(book_id, container, rank, category_id) VALUES(?1, ?2, ?3, ?4)          ON CONFLICT(book_id) DO UPDATE SET container = ?2, rank = ?3, category_id = ?4",
        rusqlite::params![book_id, container, rank, category_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Placed { changed: true, container: container.to_string(), rank })
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
}
