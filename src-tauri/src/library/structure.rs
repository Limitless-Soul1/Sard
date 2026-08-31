//! The library's structure — cases, the shelves inside them, the categories inside those,
//! and the hand order of a shelf's books.
//!
//! This sits ON TOP of the RAWY-08 tables rather than beside them. `collections` is still
//! the shelf table, `book_collections` is still membership; migration 17 only taught them
//! which case a shelf belongs to, how it is ordered, and where each book sits. Every
//! pre-existing reader of those tables (`collections_list`, `collections_for_book`, the
//! mobile library, the book edit dialog) is therefore unaffected.
//!
//! Two kinds of shelf exist:
//!
//! * a **hand** shelf owns its membership — books are added, removed and positioned by the
//!   reader, and `book_collections.position` is that order;
//! * a **rule** shelf owns nothing — `auto_rule` names a query over the whole library
//!   (`reading`, `finished`, `added`) and its contents are derived on read. Writing to one
//!   is refused rather than silently ignored, so a caller cannot believe it moved a book
//!   into a shelf that computes itself.
//!
//! Following RAWY-31, every write returns the REFRESHED tree, so the UI updates names,
//! counts and order in one round-trip instead of re-reading.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// How a shelf orders the books it shows.
pub const ORDER_HAND: &str = "hand";
const ORDER_RULES: &[&str] = &[ORDER_HAND, "title", "author", "added", "recent", "progress"];
/// The rules a self-populating shelf may use.
const AUTO_RULES: &[&str] = &["reading", "finished", "added"];

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Same derivation as `library::gen_id` — a 24-hex id from stable parts.
fn gen_id(seed: &str) -> String {
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CategoryNode {
    pub id: String,
    pub name: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct ShelfNode {
    pub id: String,
    pub name: String,
    /// The shelf's own colour. `None` = fall back to its case's, which is what every shelf did
    /// before shelves could carry one.
    pub ink: Option<String>,
    pub case_id: Option<String>,
    /// Always a concrete value: `"hand"` when the column is NULL.
    pub order_rule: String,
    /// `None` = the reader owns this shelf's membership.
    pub auto_rule: Option<String>,
    pub collapsed: bool,
    pub count: i64,
    pub categories: Vec<CategoryNode>,
}

#[derive(Serialize)]
pub struct CaseNode {
    pub id: String,
    pub name: String,
    pub ink: Option<String>,
    /// Distinct books across this case's shelves — not the sum of the shelf counts, because
    /// one book may sit on several shelves of the same case.
    pub count: i64,
    pub shelves: Vec<ShelfNode>,
}

#[derive(Serialize)]
pub struct LibraryTree {
    pub cases: Vec<CaseNode>,
    /// Shelves that belong to no case.
    pub loose: Vec<ShelfNode>,
}

/// One membership row, in the shelf's own order.
#[derive(Serialize)]
pub struct ShelfItem {
    pub book_id: String,
    pub position: i64,
    pub category_id: Option<String>,
}

/// The SQL that derives a rule shelf's membership. Static text keyed by a validated rule,
/// so nothing here is interpolated from caller input.
fn auto_sql(rule: &str) -> Option<&'static str> {
    match rule {
        // Started but not finished. `fraction` is 0..1.
        "reading" => Some(
            "SELECT b.id FROM books b JOIN reading_progress p ON p.book_id = b.id \
             WHERE p.fraction > 0.001 AND p.fraction < 0.995 ORDER BY p.updated_at DESC",
        ),
        "finished" => Some(
            "SELECT b.id FROM books b JOIN reading_progress p ON p.book_id = b.id \
             WHERE p.fraction >= 0.995 ORDER BY p.updated_at DESC",
        ),
        "added" => Some("SELECT b.id FROM books b ORDER BY COALESCE(b.added_at, 0) DESC LIMIT 60"),
        _ => None,
    }
}

fn auto_count(conn: &Connection, rule: &str) -> rusqlite::Result<i64> {
    let Some(sql) = auto_sql(rule) else { return Ok(0) };
    let mut stmt = conn.prepare(&format!("SELECT COUNT(*) FROM ({sql})"))?;
    stmt.query_row([], |r| r.get(0))
}

fn shelves_where(conn: &Connection, case_id: Option<&str>) -> rusqlite::Result<Vec<ShelfNode>> {
    let sql = "SELECT c.id, c.name, c.case_id, c.order_rule, c.auto_rule, c.collapsed, \
               (SELECT COUNT(*) FROM placements p WHERE p.container = c.id), c.ink \
               FROM collections c WHERE c.case_id IS ?1 \
               ORDER BY COALESCE(c.sort_order, 0), c.name";
    let mut stmt = conn.prepare(sql)?;
    let raw = stmt
        .query_map([case_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(raw.len());
    for (id, name, cid, order_rule, auto_rule, collapsed, manual_count, ink) in raw {
        // A rule shelf's count is what the rule yields; a hand shelf's is its membership.
        let count = match auto_rule.as_deref() {
            Some(rule) => auto_count(conn, rule)?,
            None => manual_count,
        };
        out.push(ShelfNode {
            categories: categories_of(conn, &id)?,
            id,
            name,
            ink,
            case_id: cid,
            order_rule: order_rule.unwrap_or_else(|| ORDER_HAND.to_string()),
            auto_rule,
            collapsed: collapsed.unwrap_or(0) != 0,
            count,
        });
    }
    Ok(out)
}

fn categories_of(conn: &Connection, collection_id: &str) -> rusqlite::Result<Vec<CategoryNode>> {
    let mut stmt = conn.prepare(
        "SELECT k.id, k.name, \
         (SELECT COUNT(*) FROM placements p WHERE p.category_id = k.id) \
         FROM collection_categories k WHERE k.collection_id = ?1 \
         ORDER BY COALESCE(k.sort_order, 0), k.name",
    )?;
    let out = stmt
        .query_map([collection_id], |r| {
            Ok(CategoryNode {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })?
        .collect();
    out
}

/// The whole structure in one read: cases, their shelves, each shelf's categories, counts.
pub fn tree(conn: &Connection) -> rusqlite::Result<LibraryTree> {
    let mut stmt = conn.prepare(
        "SELECT id, name, ink FROM cases ORDER BY COALESCE(sort_order, 0), name",
    )?;
    let heads = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut cases = Vec::with_capacity(heads.len());
    for (id, name, ink) in heads {
        let shelves = shelves_where(conn, Some(&id))?;
        // No DISTINCT any more: a book has one placement, so it can be on at most one shelf of
        // this case. The old query existed to stop it being counted twice.
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM placements p \
             JOIN collections c ON c.id = p.container WHERE c.case_id = ?1",
            [&id],
            |r| r.get(0),
        )?;
        cases.push(CaseNode { id, name, ink, count, shelves });
    }
    Ok(LibraryTree {
        cases,
        loose: shelves_where(conn, None)?,
    })
}

/// A shelf's book ids in its own order. For a rule shelf the rule decides; for a hand shelf
/// `position` does, with the category grouping carried alongside.
pub fn shelf_items(conn: &Connection, collection_id: &str) -> rusqlite::Result<Vec<ShelfItem>> {
    let auto: Option<String> = conn
        .query_row("SELECT auto_rule FROM collections WHERE id = ?1", [collection_id], |r| r.get(0))
        .optional()?
        .flatten();

    if let Some(rule) = auto {
        let Some(sql) = auto_sql(&rule) else { return Ok(Vec::new()) };
        let mut stmt = conn.prepare(sql)?;
        let out: rusqlite::Result<Vec<ShelfItem>> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .enumerate()
            .map(|(i, id)| {
                Ok(ShelfItem {
                    book_id: id?,
                    position: i as i64,
                    category_id: None,
                })
            })
            .collect();
        return out;
    }

    // A HAND SHELF'S ORDER IS ITS PLACEMENTS, IN RANK ORDER.
    //
    // It used to be `book_collections.position`, which was nullable, not unique, and not required
    // to begin at zero — this reader's library holds a shelf whose only book sits at position 1.
    // The `position` returned here is now simply the book's index within its container, which is
    // what every caller actually wanted; the authoritative order is the rank, and nothing outside
    // the placement module ever needs to see one.
    let mut stmt = conn.prepare(
        "SELECT book_id, category_id FROM placements \
         WHERE container = ?1 ORDER BY rank",
    )?;
    let out: rusqlite::Result<Vec<ShelfItem>> = stmt
        .query_map([collection_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .enumerate()
        .map(|(i, row)| {
            let (book_id, category_id) = row?;
            Ok(ShelfItem { book_id, position: i as i64, category_id })
        })
        .collect();
    out
}

// ---------------------------------------------------------------------------
// Case writes
// ---------------------------------------------------------------------------

pub fn case_create(conn: &Connection, name: &str, ink: Option<&str>) -> rusqlite::Result<LibraryTree> {
    let now = now_unix();
    let id = gen_id(&format!("case|{name}|{now}"));
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cases", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO cases(id, name, ink, sort_order, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, name, ink, next, now],
    )?;
    tree(conn)
}

pub fn case_rename(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<LibraryTree> {
    conn.execute("UPDATE cases SET name = ?2 WHERE id = ?1", rusqlite::params![id, name])?;
    tree(conn)
}

/// Delete a case. Its shelves are NOT deleted — `case_id` is nulled by the FK, so they
/// become loose. Removing a grouping must never remove what was grouped.
pub fn case_delete(conn: &Connection, id: &str) -> rusqlite::Result<LibraryTree> {
    conn.execute("DELETE FROM cases WHERE id = ?1", [id])?;
    tree(conn)
}

/// Move a case to `to_index` among its peers, renumbering densely so the order is stable.
pub fn case_reorder(conn: &Connection, id: &str, to_index: i64) -> rusqlite::Result<LibraryTree> {
    let mut stmt =
        conn.prepare("SELECT id FROM cases ORDER BY COALESCE(sort_order, 0), name")?;
    let mut ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let Some(from) = ids.iter().position(|x| x == id) else { return tree(conn) };
    let moved = ids.remove(from);
    let at = (to_index.max(0) as usize).min(ids.len());
    ids.insert(at, moved);
    for (i, cid) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE cases SET sort_order = ?2 WHERE id = ?1",
            rusqlite::params![cid, i as i64],
        )?;
    }
    tree(conn)
}

// ---------------------------------------------------------------------------
// Shelf writes
// ---------------------------------------------------------------------------

/// Create a shelf, optionally inside a case and optionally rule-driven.
pub fn shelf_create(
    conn: &Connection,
    name: &str,
    case_id: Option<&str>,
    auto_rule: Option<&str>,
) -> rusqlite::Result<LibraryTree> {
    if let Some(rule) = auto_rule {
        if !AUTO_RULES.contains(&rule) {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "unknown shelf rule: {rule}"
            )));
        }
    }
    let now = now_unix();
    let id = gen_id(&format!("shelf|{name}|{now}"));
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collections", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO collections(id, name, sort_order, created_at, case_id, auto_rule) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, name, next, now, case_id, auto_rule],
    )?;
    tree(conn)
}

/// Move a shelf into a case, or out of every case with `None`.
pub fn shelf_set_case(conn: &Connection, id: &str, case_id: Option<&str>) -> rusqlite::Result<LibraryTree> {
    conn.execute(
        "UPDATE collections SET case_id = ?2 WHERE id = ?1",
        rusqlite::params![id, case_id],
    )?;
    tree(conn)
}

pub fn shelf_set_order(conn: &Connection, id: &str, order_rule: &str) -> rusqlite::Result<LibraryTree> {
    if !ORDER_RULES.contains(&order_rule) {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unknown order rule: {order_rule}"
        )));
    }
    conn.execute(
        "UPDATE collections SET order_rule = ?2 WHERE id = ?1",
        rusqlite::params![id, order_rule],
    )?;
    tree(conn)
}

/// Give a shelf its own colour, or clear it with `None` so it falls back to its case's.
pub fn shelf_set_ink(conn: &Connection, id: &str, ink: Option<&str>) -> rusqlite::Result<LibraryTree> {
    conn.execute("UPDATE collections SET ink = ?2 WHERE id = ?1", rusqlite::params![id, ink])?;
    tree(conn)
}

/// Give a case a colour, or clear it with `None`.
pub fn case_set_ink(conn: &Connection, id: &str, ink: Option<&str>) -> rusqlite::Result<LibraryTree> {
    conn.execute("UPDATE cases SET ink = ?2 WHERE id = ?1", rusqlite::params![id, ink])?;
    tree(conn)
}

/// Move a shelf to `to_index` among its siblings — the shelves of the same case, or the loose
/// ones. Renumbers that group densely so the order is stable, exactly as `case_reorder` does.
pub fn shelf_reorder(conn: &Connection, id: &str, to_index: i64) -> rusqlite::Result<LibraryTree> {
    let case_id: Option<String> = conn
        .query_row("SELECT case_id FROM collections WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    let mut stmt = conn.prepare(
        "SELECT id FROM collections WHERE case_id IS ?1 ORDER BY COALESCE(sort_order, 0), name",
    )?;
    let mut ids = stmt
        .query_map([case_id.as_deref()], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let Some(from) = ids.iter().position(|x| x == id) else { return tree(conn) };
    let moved = ids.remove(from);
    let at = (to_index.max(0) as usize).min(ids.len());
    ids.insert(at, moved);
    for (i, sid) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE collections SET sort_order = ?2 WHERE id = ?1",
            rusqlite::params![sid, i as i64],
        )?;
    }
    tree(conn)
}

/// Move a category within its shelf.
pub fn category_reorder(conn: &Connection, id: &str, to_index: i64) -> rusqlite::Result<LibraryTree> {
    let collection_id: String = conn
        .query_row("SELECT collection_id FROM collection_categories WHERE id = ?1", [id], |r| r.get(0))?;
    let mut stmt = conn.prepare(
        "SELECT id FROM collection_categories WHERE collection_id = ?1 \
         ORDER BY COALESCE(sort_order, 0), name",
    )?;
    let mut ids = stmt
        .query_map([&collection_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let Some(from) = ids.iter().position(|x| x == id) else { return tree(conn) };
    let moved = ids.remove(from);
    let at = (to_index.max(0) as usize).min(ids.len());
    ids.insert(at, moved);
    for (i, kid) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE collection_categories SET sort_order = ?2 WHERE id = ?1",
            rusqlite::params![kid, i as i64],
        )?;
    }
    tree(conn)
}

pub fn shelf_set_collapsed(conn: &Connection, id: &str, collapsed: bool) -> rusqlite::Result<LibraryTree> {
    conn.execute(
        "UPDATE collections SET collapsed = ?2 WHERE id = ?1",
        rusqlite::params![id, i64::from(collapsed)],
    )?;
    tree(conn)
}

/// PLACE A BOOK — kept as the index-shaped door onto the one arrangement transaction.
///
/// `index` is the position the book should end at once it has been taken out of the reckoning,
/// which is what this function has always meant. It is translated straight into «in front of which
/// book», because that is the form the transaction speaks and the form that cannot be off by one.
/// New callers should prefer `placement::place_book` and name the neighbour directly.
pub fn shelf_place_book(
    conn: &Connection,
    collection_id: &str,
    book_id: &str,
    category_id: Option<&str>,
    index: i64,
) -> rusqlite::Result<LibraryTree> {
    let books = crate::library::placement::container_books(conn, collection_id)?;
    let without: Vec<&(String, String)> = books.iter().filter(|(id, _)| id != book_id).collect();
    let at = (index.max(0) as usize).min(without.len());
    let before = without.get(at).map(|(id, _)| id.clone());
    crate::library::placement::place_book(conn, book_id, collection_id, before.as_deref(), category_id)
        .map_err(rusqlite::Error::InvalidParameterName)?;
    tree(conn)
}

// ---------------------------------------------------------------------------
// Category writes
// ---------------------------------------------------------------------------

pub fn category_create(conn: &Connection, collection_id: &str, name: &str) -> rusqlite::Result<LibraryTree> {
    let now = now_unix();
    let id = gen_id(&format!("cat|{collection_id}|{name}|{now}"));
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collection_categories WHERE collection_id = ?1",
            [collection_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO collection_categories(id, collection_id, name, sort_order) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![id, collection_id, name, next],
    )?;
    tree(conn)
}

pub fn category_rename(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<LibraryTree> {
    conn.execute(
        "UPDATE collection_categories SET name = ?2 WHERE id = ?1",
        rusqlite::params![id, name],
    )?;
    tree(conn)
}

/// Delete a category. Its books stay on the shelf and fall back to the ungrouped run —
/// `book_collections.category_id` is nulled by the FK, never cascaded.
pub fn category_delete(conn: &Connection, id: &str) -> rusqlite::Result<LibraryTree> {
    conn.execute("DELETE FROM collection_categories WHERE id = ?1", [id])?;
    tree(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // Migration 0007's backfill calls `afold`, so it must exist on THIS connection.
        crate::db::register_functions(&conn).unwrap();
        for (_, _, sql) in crate::db::migrations::MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn add_book(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books(id, file_path, format, title, added_at) VALUES(?1, ?1, 'epub', ?1, 0)",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn deleting_a_case_keeps_its_shelves() {
        let conn = db();
        let t = case_create(&conn, "Fantasy", Some("#BFA8D6")).unwrap();
        let case_id = t.cases[0].id.clone();
        shelf_create(&conn, "Favourites", Some(&case_id), None).unwrap();

        let t = case_delete(&conn, &case_id).unwrap();
        assert!(t.cases.is_empty(), "the case is gone");
        assert_eq!(t.loose.len(), 1, "its shelf survives, now loose");
        assert_eq!(t.loose[0].name, "Favourites");
    }

    #[test]
    fn placing_a_book_renumbers_densely() {
        let conn = db();
        for b in ["b1", "b2", "b3"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        for (i, b) in ["b1", "b2", "b3"].iter().enumerate() {
            shelf_place_book(&conn, &sid, b, None, i as i64).unwrap();
        }
        // Move the last book to the front.
        shelf_place_book(&conn, &sid, "b3", None, 0).unwrap();

        let items = shelf_items(&conn, &sid).unwrap();
        let order: Vec<_> = items.iter().map(|i| i.book_id.as_str()).collect();
        assert_eq!(order, vec!["b3", "b1", "b2"]);
        let positions: Vec<_> = items.iter().map(|i| i.position).collect();
        assert_eq!(positions, vec![0, 1, 2], "positions stay dense");
    }

    #[test]
    fn a_rule_shelf_refuses_a_placement_and_computes_its_own_count() {
        let conn = db();
        add_book(&conn, "b1");
        add_book(&conn, "b2");
        conn.execute(
            "INSERT INTO reading_progress(book_id, fraction, updated_at) VALUES('b1', 0.4, 1)",
            [],
        )
        .unwrap();

        let t = shelf_create(&conn, "Currently reading", None, Some("reading")).unwrap();
        let sid = t.loose[0].id.clone();
        assert_eq!(t.loose[0].count, 1, "the rule found the one started book");

        let err = shelf_place_book(&conn, &sid, "b2", None, 0);
        assert!(err.is_err(), "a rule shelf refuses a manual placement");

        let items = shelf_items(&conn, &sid).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].book_id, "b1");
    }

    #[test]
    fn deleting_a_category_keeps_its_books_on_the_shelf() {
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        let t = category_create(&conn, &sid, "Signed").unwrap();
        let cid = t.loose[0].categories[0].id.clone();
        shelf_place_book(&conn, &sid, "b1", Some(&cid), 0).unwrap();

        let t = category_delete(&conn, &cid).unwrap();
        assert!(t.loose[0].categories.is_empty());
        assert_eq!(t.loose[0].count, 1, "the book is still on the shelf");
        let items = shelf_items(&conn, &sid).unwrap();
        assert_eq!(items[0].category_id, None, "it simply lost its grouping");
    }

    /// A spine image and a custom cover share one managed directory. They are told apart only by
    /// their name prefix, and each sweep is scoped to its own — so replacing one must never delete
    /// the other. This is the cheap test for an expensive mistake: silently losing a reader's file.
    #[test]
    fn a_cover_sweep_cannot_reach_a_spine_image() {
        let dir = std::env::temp_dir().join("sard_spine_sweep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let cover_old = dir.join("b1-custom-aaa.jpg");
        let cover_new = dir.join("b1-custom-bbb.jpg");
        let spine = dir.join("b1-spine-ccc.jpg");
        let other_book = dir.join("b2-custom-ddd.jpg");
        for p in [&cover_old, &cover_new, &spine, &other_book] {
            std::fs::write(p, b"x").unwrap();
        }

        // Adopting `cover_new` sweeps this book's OTHER covers and nothing else.
        crate::library::sweep_custom_covers_for_test(&dir, "b1", Some(&cover_new));

        assert!(!cover_old.exists(), "the superseded cover is swept");
        assert!(cover_new.exists(), "the adopted cover is kept");
        assert!(spine.exists(), "the spine image survives a cover replacement");
        assert!(other_book.exists(), "another book's cover is untouched");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------------------------
    // The workflows a reader actually performs. These exist because the structure is the part of
    // the library that a screenshot cannot check: an order that looks right after one move can
    // still be wrong after four, and a delete that appears harmless can take books with it.
    // -----------------------------------------------------------------------------------------

    #[test]
    fn manual_order_survives_every_kind_of_move() {
        let conn = db();
        for b in ["b1", "b2", "b3", "b4", "b5"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "Hand", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        for (i, b) in ["b1", "b2", "b3", "b4", "b5"].iter().enumerate() {
            shelf_place_book(&conn, &sid, b, None, i as i64).unwrap();
        }
        let order = |c: &Connection| -> Vec<String> {
            shelf_items(c, &sid).unwrap().into_iter().map(|i| i.book_id).collect()
        };
        assert_eq!(order(&conn), ["b1", "b2", "b3", "b4", "b5"]);

        // The LAST book to the very front.
        shelf_place_book(&conn, &sid, "b5", None, 0).unwrap();
        assert_eq!(order(&conn), ["b5", "b1", "b2", "b3", "b4"]);

        // The FIRST book to the very end. An index past the end clamps rather than failing.
        shelf_place_book(&conn, &sid, "b5", None, 99).unwrap();
        assert_eq!(order(&conn), ["b1", "b2", "b3", "b4", "b5"]);

        // Between two others.
        shelf_place_book(&conn, &sid, "b4", None, 1).unwrap();
        assert_eq!(order(&conn), ["b1", "b4", "b2", "b3", "b5"]);

        // Moving a book to where it already is changes nothing.
        shelf_place_book(&conn, &sid, "b4", None, 1).unwrap();
        assert_eq!(order(&conn), ["b1", "b4", "b2", "b3", "b5"]);

        // Positions stay dense and gapless after all of that, which is what makes the NEXT
        // insertion land where the reader aimed.
        let pos: Vec<i64> = shelf_items(&conn, &sid).unwrap().into_iter().map(|i| i.position).collect();
        assert_eq!(pos, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn a_book_moves_between_shelves_without_being_duplicated_or_lost() {
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "From", None, None).unwrap();
        let from = t.loose[0].id.clone();
        let t = shelf_create(&conn, "To", None, None).unwrap();
        let to = t.loose.iter().find(|s| s.name == "To").unwrap().id.clone();

        shelf_place_book(&conn, &from, "b1", None, 0).unwrap();
        // A BOOK IS IN ONE PLACE. Joining another shelf therefore LEAVES the first — the reader
        // asked for a move, and a model that answered by adding a second home is what let the same
        // book be drawn twice and let each view pick a different one of its homes as "the" home.
        shelf_place_book(&conn, &to, "b1", None, 0).unwrap();
        assert_eq!(shelf_items(&conn, &from).unwrap().len(), 0, "it left the shelf it came from");
        assert_eq!(shelf_items(&conn, &to).unwrap().len(), 1, "and arrived at the one it went to");
        assert_eq!(memberships(&conn, "b1"), 1, "one placement, never two");

        // Taking it off that shelf does not lose it: it goes back among the books on no shelf,
        // which is a container with an order of its own rather than an absence.
        crate::library::collection_remove_book(&conn, &to, "b1").unwrap();
        assert_eq!(shelf_items(&conn, &to).unwrap().len(), 0);
        let unfiled = crate::library::placement::container_books(&conn, crate::library::placement::UNFILED).unwrap();
        assert_eq!(unfiled.iter().filter(|(id, _)| id == "b1").count(), 1, "it is unfiled, not gone");
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1, "the book itself is untouched");
    }

    #[test]
    fn a_book_moves_between_categories_and_keeps_its_place() {
        let conn = db();
        for b in ["b1", "b2", "b3"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        let t = category_create(&conn, &sid, "One").unwrap();
        let c1 = t.loose[0].categories[0].id.clone();
        let t = category_create(&conn, &sid, "Two").unwrap();
        let c2 = t.loose[0].categories.iter().find(|k| k.name == "Two").unwrap().id.clone();

        shelf_place_book(&conn, &sid, "b1", Some(&c1), 0).unwrap();
        shelf_place_book(&conn, &sid, "b2", Some(&c1), 1).unwrap();
        shelf_place_book(&conn, &sid, "b3", Some(&c2), 2).unwrap();

        let cat_of = |c: &Connection, id: &str| -> Option<String> {
            shelf_items(c, &sid).unwrap().into_iter().find(|i| i.book_id == id).unwrap().category_id
        };
        assert_eq!(cat_of(&conn, "b1").as_deref(), Some(c1.as_str()));
        assert_eq!(cat_of(&conn, "b3").as_deref(), Some(c2.as_str()));

        // Move b1 into the other category, at the front.
        shelf_place_book(&conn, &sid, "b1", Some(&c2), 0).unwrap();
        assert_eq!(cat_of(&conn, "b1").as_deref(), Some(c2.as_str()));
        assert_eq!(shelf_items(&conn, &sid).unwrap().len(), 3, "still three books on the shelf");

        // Move it out of every category — a valid state, not an error.
        shelf_place_book(&conn, &sid, "b1", None, 0).unwrap();
        assert_eq!(cat_of(&conn, "b1"), None);
        assert_eq!(shelf_items(&conn, &sid).unwrap().len(), 3);
    }

    #[test]
    fn deleting_a_category_that_holds_books_keeps_every_one_of_them() {
        let conn = db();
        for b in ["b1", "b2", "b3"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        let t = category_create(&conn, &sid, "Doomed").unwrap();
        let cid = t.loose[0].categories[0].id.clone();
        for (i, b) in ["b1", "b2", "b3"].iter().enumerate() {
            shelf_place_book(&conn, &sid, b, Some(&cid), i as i64).unwrap();
        }
        assert_eq!(t.loose[0].count, 0); // counted before the placements above

        let t = category_delete(&conn, &cid).unwrap();
        assert!(t.loose[0].categories.is_empty());
        assert_eq!(t.loose[0].count, 3, "all three books stay on the shelf");
        let items = shelf_items(&conn, &sid).unwrap();
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| i.category_id.is_none()), "they simply lose the grouping");
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 3, "and none of them leaves the library");
    }

    #[test]
    fn deleting_a_shelf_keeps_its_books_in_the_library() {
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "Doomed", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        shelf_place_book(&conn, &sid, "b1", None, 0).unwrap();

        crate::library::collection_delete(&conn, &sid).unwrap();
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1);
        let memberships: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_collections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(memberships, 0, "its membership rows cascade away with it");
    }

    #[test]
    fn cases_reorder_predictably_and_the_order_persists() {
        let conn = db();
        for n in ["A", "B", "C"] {
            case_create(&conn, n, None).unwrap();
        }
        let names = |c: &Connection| -> Vec<String> {
            tree(c).unwrap().cases.into_iter().map(|x| x.name).collect()
        };
        assert_eq!(names(&conn), ["A", "B", "C"]);

        let c_id = tree(&conn).unwrap().cases[2].id.clone();
        case_reorder(&conn, &c_id, 0).unwrap();
        assert_eq!(names(&conn), ["C", "A", "B"]);

        // Past the end clamps to last rather than failing or vanishing.
        case_reorder(&conn, &c_id, 99).unwrap();
        assert_eq!(names(&conn), ["A", "B", "C"]);

        // Re-reading from scratch gives the same order — it is stored, not incidental.
        assert_eq!(names(&conn), tree(&conn).unwrap().cases.into_iter().map(|x| x.name).collect::<Vec<_>>());
    }

    #[test]
    fn a_case_keeps_its_ink_through_a_rename() {
        let conn = db();
        let t = case_create(&conn, "Fantasy", Some("#BFA8D6")).unwrap();
        let id = t.cases[0].id.clone();
        assert_eq!(t.cases[0].ink.as_deref(), Some("#BFA8D6"));

        let t = case_rename(&conn, &id, "Speculative").unwrap();
        assert_eq!(t.cases[0].name, "Speculative");
        assert_eq!(t.cases[0].ink.as_deref(), Some("#BFA8D6"), "renaming must not drop the colour");

        // And it survives a fresh read, so the stored colour and the shown colour cannot diverge.
        assert_eq!(tree(&conn).unwrap().cases[0].ink.as_deref(), Some("#BFA8D6"));
    }

    #[test]
    fn moving_a_shelf_into_a_case_carries_its_books_with_it() {
        let conn = db();
        add_book(&conn, "b1");
        let t = case_create(&conn, "Case", None).unwrap();
        let cid = t.cases[0].id.clone();
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        shelf_place_book(&conn, &sid, "b1", None, 0).unwrap();

        let t = shelf_set_case(&conn, &sid, Some(&cid)).unwrap();
        assert!(t.loose.is_empty(), "it is no longer loose");
        assert_eq!(t.cases[0].shelves.len(), 1);
        assert_eq!(t.cases[0].shelves[0].count, 1, "and it brought its book");
        assert_eq!(t.cases[0].count, 1);

        // Out again.
        let t = shelf_set_case(&conn, &sid, None).unwrap();
        assert_eq!(t.loose.len(), 1);
        assert_eq!(t.loose[0].count, 1);
    }

    #[test]
    fn a_shelf_with_many_books_keeps_an_exact_order() {
        let conn = db();
        let ids: Vec<String> = (0..60).map(|i| format!("b{i:02}")).collect();
        for b in &ids {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "Big", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        for (i, b) in ids.iter().enumerate() {
            shelf_place_book(&conn, &sid, b, None, i as i64).unwrap();
        }
        // Pull one from the far end to the middle and check the WHOLE sequence, not just its ends.
        shelf_place_book(&conn, &sid, "b59", None, 30).unwrap();
        let got: Vec<String> = shelf_items(&conn, &sid).unwrap().into_iter().map(|i| i.book_id).collect();

        let mut want: Vec<String> = ids.clone();
        want.remove(59);
        want.insert(30, "b59".to_string());
        assert_eq!(got, want);
        assert_eq!(got.len(), 60, "nothing was dropped on the way");
    }

    #[test]
    fn a_shelf_carries_its_own_colour_and_can_give_it_back() {
        let conn = db();
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        assert_eq!(t.loose[0].ink, None, "a new shelf borrows its case's colour");

        let t = shelf_set_ink(&conn, &sid, Some("#8DC3BA")).unwrap();
        assert_eq!(t.loose[0].ink.as_deref(), Some("#8DC3BA"));
        // Stored, not incidental — a fresh read agrees.
        assert_eq!(tree(&conn).unwrap().loose[0].ink.as_deref(), Some("#8DC3BA"));

        // Renaming must not drop it, which is how a shown colour and a stored one diverge.
        crate::library::collection_rename(&conn, &sid, "Renamed").unwrap();
        assert_eq!(tree(&conn).unwrap().loose[0].ink.as_deref(), Some("#8DC3BA"));

        let t = shelf_set_ink(&conn, &sid, None).unwrap();
        assert_eq!(t.loose[0].ink, None, "clearing returns it to the case's colour");
    }

    #[test]
    fn shelves_reorder_within_their_own_case_only() {
        let conn = db();
        let t = case_create(&conn, "Case", None).unwrap();
        let cid = t.cases[0].id.clone();
        for n in ["A", "B", "C"] {
            shelf_create(&conn, n, Some(&cid), None).unwrap();
        }
        // A loose shelf that must NOT be disturbed by reordering inside the case.
        shelf_create(&conn, "Loose", None, None).unwrap();

        let names = |c: &Connection| -> Vec<String> {
            tree(c).unwrap().cases[0].shelves.iter().map(|s| s.name.clone()).collect()
        };
        assert_eq!(names(&conn), ["A", "B", "C"]);

        let c_shelf = tree(&conn).unwrap().cases[0].shelves[2].id.clone();
        shelf_reorder(&conn, &c_shelf, 0).unwrap();
        assert_eq!(names(&conn), ["C", "A", "B"]);

        shelf_reorder(&conn, &c_shelf, 99).unwrap();
        assert_eq!(names(&conn), ["A", "B", "C"], "past the end clamps to last");

        let t = tree(&conn).unwrap();
        assert_eq!(t.loose.len(), 1, "the loose shelf is untouched");
        assert_eq!(t.loose[0].name, "Loose");
    }

    #[test]
    fn categories_reorder_within_their_shelf() {
        let conn = db();
        let t = shelf_create(&conn, "Shelf", None, None).unwrap();
        let sid = t.loose[0].id.clone();
        for n in ["A", "B", "C"] {
            category_create(&conn, &sid, n).unwrap();
        }
        let names = |c: &Connection| -> Vec<String> {
            tree(c).unwrap().loose[0].categories.iter().map(|k| k.name.clone()).collect()
        };
        assert_eq!(names(&conn), ["A", "B", "C"]);

        let last = tree(&conn).unwrap().loose[0].categories[2].id.clone();
        category_reorder(&conn, &last, 0).unwrap();
        assert_eq!(names(&conn), ["C", "A", "B"]);
    }

    #[test]
    fn a_case_colour_can_be_set_and_cleared_after_creation() {
        let conn = db();
        let t = case_create(&conn, "Case", None).unwrap();
        let id = t.cases[0].id.clone();
        assert_eq!(t.cases[0].ink, None);

        let t = case_set_ink(&conn, &id, Some("#E8C36A")).unwrap();
        assert_eq!(t.cases[0].ink.as_deref(), Some("#E8C36A"));
        let t = case_set_ink(&conn, &id, None).unwrap();
        assert_eq!(t.cases[0].ink, None);
    }

    #[test]
    fn an_unknown_rule_is_refused_rather_than_stored() {
        let conn = db();
        assert!(shelf_create(&conn, "S", None, Some("nonsense")).is_err());
        let t = shelf_create(&conn, "S", None, None).unwrap();
        assert!(shelf_set_order(&conn, &t.loose[0].id, "sideways").is_err());
    }

    // -----------------------------------------------------------------------
    // MOVE, not copy.
    //
    // `shelf_place_book` is a JOIN by design — `book_collections` is many-to-many and a book may
    // legitimately sit on several shelves. What Arrange means by a drag is narrower: leave where
    // you were, arrive where you were dropped. That is two calls, and the bug was that the
    // library surface only ever made the first one, so every drag between shelves copied.
    //
    // These pin the resulting DATABASE state for each direction the reader can drag, read back
    // through `shelf_items` and `tree` — which is what a view switch, a reopen and a restart all
    // read too.
    // -----------------------------------------------------------------------

    /// Exactly what the library surface does for a manual placement: arrive, then leave the source.
    fn move_book(conn: &Connection, from: &str, to: &str, cat: Option<&str>, index: i64, book: &str) {
        shelf_place_book(conn, to, book, cat, index).unwrap();
        if from != to {
            crate::library::collection_remove_book(conn, from, book).unwrap();
        }
    }

    fn on_shelf(conn: &Connection, shelf: &str) -> Vec<String> {
        shelf_items(conn, shelf).unwrap().into_iter().map(|i| i.book_id).collect()
    }

    /// How many places a book is in. Under the placement model this can only ever be 0 or 1 — the
    /// primary key of the table is the book — so a test asserting «one, not two» is now asserting
    /// something the schema guarantees rather than something the code has to remember.
    fn memberships(conn: &Connection, book: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM placements WHERE book_id = ?1 AND container <> ?2",
            rusqlite::params![book, crate::library::placement::UNFILED],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn shelf_to_shelf_moves_the_book_and_does_not_copy_it() {
        let conn = db();
        add_book(&conn, "x");
        add_book(&conn, "y");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        shelf_place_book(&conn, &a, "x", None, 0).unwrap();
        shelf_place_book(&conn, &b, "y", None, 0).unwrap();

        move_book(&conn, &a, &b, None, 0, "x");

        assert!(on_shelf(&conn, &a).is_empty(), "the source no longer holds it");
        assert_eq!(on_shelf(&conn, &b), vec!["x", "y"], "the destination holds it, at the index given");
        assert_eq!(memberships(&conn, "x"), 1, "one membership, not two");
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 2, "the book itself is untouched");
    }

    #[test]
    fn category_to_category_moves_within_one_shelf_without_dropping_membership() {
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        let t = category_create(&conn, &s, "One").unwrap();
        let c1 = t.loose[0].categories[0].id.clone();
        let t = category_create(&conn, &s, "Two").unwrap();
        let c2 = t.loose[0].categories.iter().find(|k| k.name == "Two").unwrap().id.clone();
        shelf_place_book(&conn, &s, "x", Some(&c1), 0).unwrap();

        // Same shelf: the plan is a reorder, so nothing is removed. Removing and re-adding would
        // briefly take the book off a shelf it never left.
        move_book(&conn, &s, &s, Some(&c2), 0, "x");

        let it = shelf_items(&conn, &s).unwrap();
        assert_eq!(it.len(), 1, "still exactly one membership");
        assert_eq!(it[0].category_id.as_deref(), Some(c2.as_str()), "now in the second category");
    }

    #[test]
    fn category_to_another_shelf_moves_and_does_not_carry_the_old_category() {
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        let t = category_create(&conn, &a, "One").unwrap();
        let c1 = t.loose.iter().find(|s| s.id == a).unwrap().categories[0].id.clone();
        shelf_place_book(&conn, &a, "x", Some(&c1), 0).unwrap();

        move_book(&conn, &a, &b, None, 0, "x");

        assert!(on_shelf(&conn, &a).is_empty());
        let it = shelf_items(&conn, &b).unwrap();
        assert_eq!(it.len(), 1);
        assert_eq!(it[0].category_id, None, "the old shelf's category does not follow it");
        // The category row survives: taking a book out of it is not deleting it.
        let cats: i64 = conn
            .query_row("SELECT COUNT(*) FROM collection_categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cats, 1);
    }

    #[test]
    fn moving_across_cases_moves_the_book_not_the_shelf() {
        let conn = db();
        add_book(&conn, "x");
        let t = case_create(&conn, "Left", None).unwrap();
        let left = t.cases[0].id.clone();
        let t = case_create(&conn, "Right", None).unwrap();
        let right = t.cases.iter().find(|c| c.name == "Right").unwrap().id.clone();
        let t = shelf_create(&conn, "A", Some(&left), None).unwrap();
        let a = t.cases.iter().find(|c| c.id == left).unwrap().shelves[0].id.clone();
        let t = shelf_create(&conn, "B", Some(&right), None).unwrap();
        let b = t.cases.iter().find(|c| c.id == right).unwrap().shelves[0].id.clone();
        shelf_place_book(&conn, &a, "x", None, 0).unwrap();

        move_book(&conn, &a, &b, None, 0, "x");

        assert!(on_shelf(&conn, &a).is_empty());
        assert_eq!(on_shelf(&conn, &b), vec!["x"]);
        assert_eq!(memberships(&conn, "x"), 1);
        let t = tree(&conn).unwrap();
        assert_eq!(t.cases.iter().find(|c| c.id == left).unwrap().shelves.len(), 1, "shelf A stays put");
        assert_eq!(t.cases.iter().find(|c| c.id == right).unwrap().shelves.len(), 1, "shelf B stays put");
    }

    #[test]
    fn an_unshelved_book_joins_a_shelf_and_stops_being_unshelved() {
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        // "Unshelved" is not a collection: it is the set of books with no membership at all,
        // so there is nothing to remove the book from on the way in.
        assert_eq!(memberships(&conn, "x"), 0);

        shelf_place_book(&conn, &a, "x", None, 0).unwrap();

        assert_eq!(on_shelf(&conn, &a), vec!["x"]);
        assert_eq!(memberships(&conn, "x"), 1, "exactly one membership, so no longer unshelved");
    }

    #[test]
    fn taking_a_book_off_its_shelf_leaves_it_in_the_library_and_unshelved() {
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        shelf_place_book(&conn, &a, "x", None, 0).unwrap();

        crate::library::collection_remove_book(&conn, &a, "x").unwrap();

        assert!(on_shelf(&conn, &a).is_empty());
        assert_eq!(memberships(&conn, "x"), 0, "unshelved again");
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1, "and still in the library");
    }

    #[test]
    fn a_move_survives_being_read_back_from_scratch() {
        // The library reads `tree` + `shelf_items` after every write, on every view switch, and
        // on a fresh launch. If the move is in the database, all three see it; this asserts the
        // re-read, through the same functions a restart uses.
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        shelf_place_book(&conn, &a, "x", None, 0).unwrap();
        move_book(&conn, &a, &b, None, 0, "x");

        let reread = tree(&conn).unwrap();
        assert_eq!(reread.loose.iter().find(|s| s.id == a).unwrap().count, 0, "the source counts none");
        assert_eq!(reread.loose.iter().find(|s| s.id == b).unwrap().count, 1, "the destination counts one");
        assert!(on_shelf(&conn, &a).is_empty());
        assert_eq!(on_shelf(&conn, &b), vec!["x"]);
    }

    #[test]
    fn a_move_onto_a_rule_shelf_is_refused_before_anything_is_removed() {
        // Order matters: the destination is written FIRST, so a refusal leaves the book exactly
        // where it was rather than losing it from both.
        let conn = db();
        add_book(&conn, "x");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "Reading", None, Some("reading")).unwrap();
        let rule = t.loose.iter().find(|s| s.name == "Reading").unwrap().id.clone();
        shelf_place_book(&conn, &a, "x", None, 0).unwrap();

        assert!(shelf_place_book(&conn, &rule, "x", None, 0).is_err());
        assert_eq!(on_shelf(&conn, &a), vec!["x"], "still on the shelf it started on");
        assert_eq!(memberships(&conn, "x"), 1);
    }

    // -----------------------------------------------------------------------
    // Select mode's "Move to…" — a move that must not eat memberships it was not asked about.
    //
    // The tray resolves ONE source shelf and the operation leaves only that one. A book that also
    // sits on a third shelf keeps it: `book_collections` is many-to-many on purpose, and the naive
    // repair for the copy bug — strip everything else — would destroy placements someone made
    // deliberately.
    // -----------------------------------------------------------------------

    /// What the tray does per book: join the destination, then leave the resolved source only.
    fn bulk_move(conn: &Connection, remove_from: Option<&str>, to: &str, cat: Option<&str>, books: &[&str]) {
        for b in books {
            shelf_place_book(conn, to, b, cat, 0).unwrap();
            if let Some(from) = remove_from {
                if from != to {
                    crate::library::collection_remove_book(conn, from, b).unwrap();
                }
            }
        }
    }

    #[test]
    fn a_bulk_move_empties_the_source_and_fills_the_destination() {
        let conn = db();
        for b in ["b1", "b2", "b3"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        for (i, x) in ["b1", "b2", "b3"].iter().enumerate() {
            shelf_place_book(&conn, &a, x, None, i as i64).unwrap();
        }

        bulk_move(&conn, Some(&a), &b, None, &["b1", "b2", "b3"]);

        assert!(on_shelf(&conn, &a).is_empty(), "every one of them left the source");
        let mut got = on_shelf(&conn, &b);
        got.sort();
        assert_eq!(got, vec!["b1", "b2", "b3"]);
        for x in ["b1", "b2", "b3"] {
            assert_eq!(memberships(&conn, x), 1, "{x} has one membership, not two");
        }
    }

    #[test]
    fn a_bulk_move_leaves_a_books_other_shelves_completely_alone() {
        // A bulk move takes every selected book to the destination and leaves it nowhere else —
        // including a book that happened to be sitting on some third shelf when the move began.
        let conn = db();
        for b in ["b1", "b2"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        let t = shelf_create(&conn, "Keep", None, None).unwrap();
        let keep = t.loose.iter().find(|s| s.name == "Keep").unwrap().id.clone();
        shelf_place_book(&conn, &a, "b1", None, 0).unwrap();
        shelf_place_book(&conn, &a, "b2", None, 1).unwrap();
        // Placing b2 on Keep MOVES it there; it is no longer on A.
        shelf_place_book(&conn, &keep, "b2", None, 0).unwrap();
        assert_eq!(on_shelf(&conn, &a), vec!["b1"]);
        assert_eq!(on_shelf(&conn, &keep), vec!["b2"]);

        bulk_move(&conn, Some(&a), &b, None, &["b1", "b2"]);

        assert!(on_shelf(&conn, &a).is_empty(), "the source is emptied");
        // The helper drops each book at index 0 in turn, so the destination reads back in the
        // reverse of the order it was given — an artefact of the helper, stated rather than glossed.
        assert_eq!(on_shelf(&conn, &b), vec!["b2", "b1"], "both arrive at the destination");
        assert!(on_shelf(&conn, &keep).is_empty(), "and b2 left Keep, because a book is in one place");
        assert_eq!(memberships(&conn, "b2"), 1);
        assert_eq!(memberships(&conn, "b1"), 1);
    }

    #[test]
    fn a_bulk_move_into_a_category_files_every_book_into_it() {
        // Category → Category, as the tray offers it: the destination is a shelf AND a category.
        let conn = db();
        for b in ["b1", "b2"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        let t = category_create(&conn, &s, "X").unwrap();
        let x = t.loose[0].categories[0].id.clone();
        let t = category_create(&conn, &s, "Y").unwrap();
        let y = t.loose[0].categories.iter().find(|k| k.name == "Y").unwrap().id.clone();
        shelf_place_book(&conn, &s, "b1", Some(&x), 0).unwrap();
        shelf_place_book(&conn, &s, "b2", Some(&x), 1).unwrap();

        // Same shelf, so nothing is removed — only the category changes.
        bulk_move(&conn, Some(&s), &s, Some(&y), &["b1", "b2"]);

        let it = shelf_items(&conn, &s).unwrap();
        assert_eq!(it.len(), 2, "still two memberships, not four");
        for i in &it {
            assert_eq!(i.category_id.as_deref(), Some(y.as_str()));
        }
    }

    #[test]
    fn a_bulk_move_with_no_source_is_an_add_and_removes_nothing() {
        // Unfiled → Shelf. The books were on nothing, so there is nothing to leave.
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose[0].id.clone();

        bulk_move(&conn, None, &b, None, &["b1"]);

        assert_eq!(on_shelf(&conn, &b), vec!["b1"]);
        assert_eq!(memberships(&conn, "b1"), 1);
    }

    #[test]
    fn leaving_a_shelf_a_book_was_never_on_is_a_no_op() {
        // The scoped case: the pane's shelf is the stated source even when the selected book is
        // not actually on it. The destination is what the reader asked for, so the book goes there
        // from wherever it really was — a stated source that is wrong must not strand it.
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "Scoped", None, None).unwrap();
        let scoped = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        let t = shelf_create(&conn, "Elsewhere", None, None).unwrap();
        let elsewhere = t.loose.iter().find(|s| s.name == "Elsewhere").unwrap().id.clone();
        shelf_place_book(&conn, &elsewhere, "b1", None, 0).unwrap();

        bulk_move(&conn, Some(&scoped), &b, None, &["b1"]);

        assert_eq!(on_shelf(&conn, &b), vec!["b1"], "it arrived at the destination");
        assert!(on_shelf(&conn, &elsewhere).is_empty(), "and left the shelf it was actually on");
        assert!(on_shelf(&conn, &scoped).is_empty(), "the stated source never held it and holds nothing now");
        assert_eq!(memberships(&conn, "b1"), 1, "one placement, wherever the move was said to start");
    }

    #[test]
    fn a_bulk_move_across_cases_survives_a_re_read() {
        let conn = db();
        for b in ["b1", "b2"] {
            add_book(&conn, b);
        }
        let t = case_create(&conn, "Left", None).unwrap();
        let left = t.cases[0].id.clone();
        let t = case_create(&conn, "Right", None).unwrap();
        let right = t.cases.iter().find(|c| c.name == "Right").unwrap().id.clone();
        let t = shelf_create(&conn, "A", Some(&left), None).unwrap();
        let a = t.cases.iter().find(|c| c.id == left).unwrap().shelves[0].id.clone();
        let t = shelf_create(&conn, "B", Some(&right), None).unwrap();
        let b = t.cases.iter().find(|c| c.id == right).unwrap().shelves[0].id.clone();
        shelf_place_book(&conn, &a, "b1", None, 0).unwrap();
        shelf_place_book(&conn, &a, "b2", None, 1).unwrap();

        bulk_move(&conn, Some(&a), &b, None, &["b1", "b2"]);

        let t = tree(&conn).unwrap();
        let sa = &t.cases.iter().find(|c| c.id == left).unwrap().shelves[0];
        let sb = &t.cases.iter().find(|c| c.id == right).unwrap().shelves[0];
        assert_eq!(sa.count, 0);
        assert_eq!(sb.count, 2);
    }

    #[test]
    fn a_book_details_case_change_moves_it_between_the_cases_shelves() {
        // Book Details assigns Case → Shelf: choosing a case narrows the shelf list, choosing the
        // SHELF is the write. Re-assigning to another case's shelf must leave the first.
        let conn = db();
        add_book(&conn, "b1");
        let t = case_create(&conn, "One", None).unwrap();
        let c1 = t.cases[0].id.clone();
        let t = case_create(&conn, "Two", None).unwrap();
        let c2 = t.cases.iter().find(|c| c.name == "Two").unwrap().id.clone();
        let t = shelf_create(&conn, "S1", Some(&c1), None).unwrap();
        let s1 = t.cases.iter().find(|c| c.id == c1).unwrap().shelves[0].id.clone();
        let t = shelf_create(&conn, "S2", Some(&c2), None).unwrap();
        let s2 = t.cases.iter().find(|c| c.id == c2).unwrap().shelves[0].id.clone();

        // assign
        shelf_place_book(&conn, &s1, "b1", None, 0).unwrap();
        assert_eq!(on_shelf(&conn, &s1), vec!["b1"]);

        // re-assign to the other case's shelf, the way the dialog does it
        shelf_place_book(&conn, &s2, "b1", None, 0).unwrap();
        crate::library::collection_remove_book(&conn, &s1, "b1").unwrap();

        assert!(on_shelf(&conn, &s1).is_empty(), "it left the first case's shelf");
        assert_eq!(on_shelf(&conn, &s2), vec!["b1"]);
        assert_eq!(memberships(&conn, "b1"), 1, "no duplicate membership was created");

        // and a re-read — what reopening Book Details and the sidebar both do — agrees.
        let t = tree(&conn).unwrap();
        assert_eq!(t.cases.iter().find(|c| c.id == c1).unwrap().count, 0);
        assert_eq!(t.cases.iter().find(|c| c.id == c2).unwrap().count, 1);
    }

    #[test]
    fn a_case_with_no_shelves_offers_nowhere_to_put_a_book() {
        // The Book Details bug in one assertion: a case can exist with no shelf under it, so
        // "choose a case" cannot mean "file the book on its first shelf" — there may not be one.
        let conn = db();
        let t = case_create(&conn, "Empty", None).unwrap();
        assert_eq!(t.cases[0].shelves.len(), 0);
        // And a case holding only a rule shelf is the same story: nothing manual to place into.
        let t = shelf_create(&conn, "Reading", Some(&t.cases[0].id), Some("reading")).unwrap();
        let c = t.cases.iter().find(|c| c.name == "Empty").unwrap();
        assert_eq!(c.shelves.iter().filter(|s| s.auto_rule.is_none()).count(), 0);
    }

    // =======================================================================
    // ADVERSARIAL. These do not ask whether the happy path works — the tests above already
    // answer that. They ask what happens under repetition, at the boundaries, and in the
    // orders a reader would only reach by being impatient.
    //
    // Every one of them runs against an in-memory database, which is the only place this kind
    // of hammering can safely happen: the real library cannot be isolated from the running app,
    // so it is never touched here.
    // =======================================================================

    /// Every membership row in the database, as (collection, book) pairs.
    /// Every book that is on a shelf, as (shelf, book). Books on no shelf are excluded — they are
    /// placed too, in the unfiled container, but they are not "on a shelf" in the sense these tests
    /// are asking about.
    fn all_memberships(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT container, book_id FROM placements WHERE container <> ?1                  ORDER BY container, book_id",
            )
            .unwrap();
        let rows = stmt
            .query_map([crate::library::placement::UNFILED], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    /// Positions on one shelf, in stored order. A healthy shelf is 0..n with no gaps or repeats.
    fn positions(conn: &Connection, shelf: &str) -> Vec<i64> {
        shelf_items(conn, shelf).unwrap().into_iter().map(|i| i.position).collect()
    }

    #[test]
    fn many_cases_keep_a_stable_total_order_through_repeated_reordering() {
        let conn = db();
        for i in 0..12 {
            case_create(&conn, &format!("C{i:02}"), None).unwrap();
        }
        // Walk the first case to the end, one step at a time, then walk it back.
        for target in 1..12 {
            let t = tree(&conn).unwrap();
            let first = t.cases[0].id.clone();
            case_reorder(&conn, &first, target).unwrap();
            let after = tree(&conn).unwrap();
            assert_eq!(after.cases.len(), 12, "a reorder must never lose or duplicate a case");
            let names: std::collections::HashSet<_> = after.cases.iter().map(|c| c.name.clone()).collect();
            assert_eq!(names.len(), 12, "every case is still distinct");
        }
        // And out-of-range indices must clamp rather than corrupt.
        let t = tree(&conn).unwrap();
        let id = t.cases[0].id.clone();
        case_reorder(&conn, &id, 999).unwrap();
        assert_eq!(tree(&conn).unwrap().cases.len(), 12);
        case_reorder(&conn, &id, 0).unwrap();
        assert_eq!(tree(&conn).unwrap().cases.first().unwrap().id, id);
    }

    #[test]
    fn deleting_every_case_in_turn_leaves_every_shelf_and_book_alive() {
        let conn = db();
        for b in ["b1", "b2", "b3"] {
            add_book(&conn, b);
        }
        let mut shelves = Vec::new();
        for i in 0..4 {
            let t = case_create(&conn, &format!("C{i}"), None).unwrap();
            let cid = t.cases.iter().find(|c| c.name == format!("C{i}")).unwrap().id.clone();
            let t = shelf_create(&conn, &format!("S{i}"), Some(&cid), None).unwrap();
            let sid = t.cases.iter().find(|c| c.id == cid).unwrap().shelves[0].id.clone();
            // Its own book: one book cannot be on four shelves at once any more, and reusing one
            // for all four would be testing the old model rather than this one.
            let book = format!("cased{i}");
            add_book(&conn, &book);
            shelf_place_book(&conn, &sid, &book, None, 0).unwrap();
            shelves.push(sid);
        }
        loop {
            let t = tree(&conn).unwrap();
            let Some(c) = t.cases.first() else { break };
            let id = c.id.clone();
            case_delete(&conn, &id).unwrap();
        }
        let t = tree(&conn).unwrap();
        assert!(t.cases.is_empty());
        assert_eq!(t.loose.len(), 4, "every shelf survived, now un-cased");
        for s in &shelves {
            assert_eq!(shelf_items(&conn, s).unwrap().len(), 1, "and kept its book");
        }
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 7, "the three originals and one per cased shelf");
    }

    #[test]
    fn repeated_renaming_never_multiplies_or_loses_a_case() {
        let conn = db();
        let t = case_create(&conn, "One", Some("#E8C36A")).unwrap();
        let id = t.cases[0].id.clone();
        for i in 0..50 {
            case_rename(&conn, &id, &format!("Name {i}")).unwrap();
        }
        let t = tree(&conn).unwrap();
        assert_eq!(t.cases.len(), 1);
        assert_eq!(t.cases[0].name, "Name 49");
        assert_eq!(t.cases[0].ink.as_deref(), Some("#E8C36A"), "renaming never disturbs the colour");
    }

    #[test]
    fn a_shelf_walked_up_and_down_its_case_keeps_every_sibling() {
        let conn = db();
        let t = case_create(&conn, "C", None).unwrap();
        let cid = t.cases[0].id.clone();
        for i in 0..8 {
            shelf_create(&conn, &format!("S{i}"), Some(&cid), None).unwrap();
        }
        let ids: Vec<String> = tree(&conn).unwrap().cases[0].shelves.iter().map(|s| s.id.clone()).collect();
        for step in 0..8 {
            shelf_reorder(&conn, &ids[0], step).unwrap();
            let now = tree(&conn).unwrap();
            assert_eq!(now.cases[0].shelves.len(), 8, "no shelf lost at step {step}");
            let distinct: std::collections::HashSet<_> = now.cases[0].shelves.iter().map(|s| &s.id).collect();
            assert_eq!(distinct.len(), 8, "no shelf duplicated at step {step}");
        }
    }

    #[test]
    fn a_shelf_moved_between_cases_repeatedly_never_lands_in_two_at_once() {
        let conn = db();
        add_book(&conn, "b1");
        let t = case_create(&conn, "A", None).unwrap();
        let a = t.cases[0].id.clone();
        let t = case_create(&conn, "B", None).unwrap();
        let b = t.cases.iter().find(|c| c.name == "B").unwrap().id.clone();
        let t = shelf_create(&conn, "S", Some(&a), None).unwrap();
        let sid = t.cases.iter().find(|c| c.id == a).unwrap().shelves[0].id.clone();
        shelf_place_book(&conn, &sid, "b1", None, 0).unwrap();

        for i in 0..20 {
            let to = if i % 3 == 0 { None } else if i % 3 == 1 { Some(a.as_str()) } else { Some(b.as_str()) };
            shelf_set_case(&conn, &sid, to).unwrap();
            let t = tree(&conn).unwrap();
            let appearances = t.cases.iter().filter(|c| c.shelves.iter().any(|s| s.id == sid)).count()
                + usize::from(t.loose.iter().any(|s| s.id == sid));
            assert_eq!(appearances, 1, "the shelf is in exactly one place after step {i}");
            assert_eq!(shelf_items(&conn, &sid).unwrap().len(), 1, "and keeps its book");
        }
    }

    #[test]
    fn a_book_shuttled_between_two_shelves_never_accumulates_memberships() {
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        shelf_place_book(&conn, &a, "b1", None, 0).unwrap();

        for i in 0..30 {
            let (from, to) = if i % 2 == 0 { (&a, &b) } else { (&b, &a) };
            shelf_place_book(&conn, to, "b1", None, 0).unwrap();
            // The removal is now a no-op by construction: the book already left when it arrived
            // elsewhere. Kept in the loop because this is exactly the sequence the UI performs, and
            // the point of the test is that repeating it thirty times accumulates nothing.
            crate::library::collection_remove_book(&conn, from, "b1").unwrap();
            assert_eq!(memberships(&conn, "b1"), 1, "exactly one placement after step {i}");
            assert_eq!(shelf_items(&conn, to).unwrap().len(), 1, "it is on the shelf it moved to, step {i}");
            assert_eq!(shelf_items(&conn, from).unwrap().len(), 0, "and on no other, step {i}");
        }
        assert_eq!(all_memberships(&conn).len(), 1);
    }

    #[test]
    fn positions_stay_dense_however_a_shelf_is_churned() {
        let conn = db();
        for i in 0..10 {
            add_book(&conn, &format!("b{i}"));
        }
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        for i in 0..10 {
            shelf_place_book(&conn, &s, &format!("b{i}"), None, i as i64).unwrap();
        }
        // Move things about at every index, including out of range.
        for (book, at) in [("b0", 9), ("b9", 0), ("b5", 5), ("b3", 99), ("b7", 0), ("b2", 4)] {
            shelf_place_book(&conn, &s, book, None, at).unwrap();
            let p = positions(&conn, &s);
            assert_eq!(p, (0..p.len() as i64).collect::<Vec<_>>(), "positions dense after moving {book} to {at}");
        }
        // Remove a few and the remainder must still renumber densely on the next write.
        for b in ["b1", "b4", "b6"] {
            crate::library::collection_remove_book(&conn, &s, b).unwrap();
        }
        shelf_place_book(&conn, &s, "b0", None, 0).unwrap();
        let p = positions(&conn, &s);
        assert_eq!(p, (0..p.len() as i64).collect::<Vec<_>>(), "and after removals");
    }

    #[test]
    fn deleting_a_category_that_holds_every_book_on_the_shelf_keeps_them_all() {
        let conn = db();
        for i in 0..6 {
            add_book(&conn, &format!("b{i}"));
        }
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        let t = category_create(&conn, &s, "K").unwrap();
        let k = t.loose[0].categories[0].id.clone();
        for i in 0..6 {
            shelf_place_book(&conn, &s, &format!("b{i}"), Some(&k), i as i64).unwrap();
        }
        category_delete(&conn, &k).unwrap();
        assert_eq!(shelf_items(&conn, &s).unwrap().len(), 6, "every book stayed on the shelf");
        for it in shelf_items(&conn, &s).unwrap() {
            assert_eq!(it.category_id, None, "and is simply uncategorised now");
        }
    }

    #[test]
    fn categories_survive_repeated_reordering_with_no_loss_or_duplication() {
        let conn = db();
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        for i in 0..6 {
            category_create(&conn, &s, &format!("K{i}")).unwrap();
        }
        let ids: Vec<String> = tree(&conn).unwrap().loose[0].categories.iter().map(|k| k.id.clone()).collect();
        for round in 0..6 {
            category_reorder(&conn, &ids[round % ids.len()], ((round * 2) % 6) as i64).unwrap();
            let now = tree(&conn).unwrap();
            let cats = &now.loose[0].categories;
            assert_eq!(cats.len(), 6, "no category lost in round {round}");
            let distinct: std::collections::HashSet<_> = cats.iter().map(|k| &k.id).collect();
            assert_eq!(distinct.len(), 6, "no category duplicated in round {round}");
        }
    }

    #[test]
    fn a_category_cannot_be_used_across_shelves() {
        // A book placed on shelf B carrying shelf A's category id is an inconsistent row: the
        // category belongs to another shelf, every view falls back to showing the book as
        // uncategorised, and deleting A's category leaves the row pointing at nothing at all.
        //
        // No caller does this today — the drop slots and the pickers all take the category from
        // the shelf they are drawing — which is exactly why the hole went unnoticed until it was
        // looked for deliberately.
        let conn = db();
        add_book(&conn, "b1");
        let t = shelf_create(&conn, "A", None, None).unwrap();
        let a = t.loose[0].id.clone();
        let t = shelf_create(&conn, "B", None, None).unwrap();
        let b = t.loose.iter().find(|s| s.name == "B").unwrap().id.clone();
        let t = category_create(&conn, &a, "K").unwrap();
        let k = t.loose.iter().find(|s| s.id == a).unwrap().categories[0].id.clone();

        assert!(
            shelf_place_book(&conn, &b, "b1", Some(&k), 0).is_err(),
            "a foreign category must be refused, not stored"
        );
        assert!(all_memberships(&conn).is_empty(), "and the refusal leaves no partial row behind");

        // A category that does not exist at all is refused for the same reason.
        assert!(shelf_place_book(&conn, &b, "b1", Some("nope"), 0).is_err());
        assert!(all_memberships(&conn).is_empty());

        // The shelf's OWN category is of course accepted.
        let t = category_create(&conn, &b, "L").unwrap();
        let l = t.loose.iter().find(|s| s.id == b).unwrap().categories[0].id.clone();
        shelf_place_book(&conn, &b, "b1", Some(&l), 0).unwrap();
        assert_eq!(shelf_items(&conn, &b).unwrap()[0].category_id.as_deref(), Some(l.as_str()));

        // And placing with no category remains fine.
        shelf_place_book(&conn, &b, "b1", None, 0).unwrap();
        assert_eq!(shelf_items(&conn, &b).unwrap()[0].category_id, None);
    }

    #[test]
    fn an_empty_library_answers_every_read_without_failing() {
        let conn = db();
        let t = tree(&conn).unwrap();
        assert!(t.cases.is_empty() && t.loose.is_empty());
        // Reads against ids that do not exist must be empty, not errors.
        assert!(shelf_items(&conn, "nope").unwrap().is_empty());
        assert!(case_delete(&conn, "nope").is_ok());
        assert!(collection_delete_ok(&conn, "nope"));
    }

    fn collection_delete_ok(conn: &Connection, id: &str) -> bool {
        crate::library::collection_delete(conn, id).is_ok()
    }

    #[test]
    fn a_rule_shelf_reports_its_query_and_owns_no_rows() {
        let conn = db();
        for b in ["b1", "b2"] {
            add_book(&conn, b);
        }
        conn.execute(
            "INSERT INTO reading_progress(book_id, fraction, updated_at) VALUES('b1', 0.5, 1)",
            [],
        )
        .unwrap();
        let t = shelf_create(&conn, "Reading", None, Some("reading")).unwrap();
        let r = t.loose[0].id.clone();
        assert_eq!(shelf_items(&conn, &r).unwrap().len(), 1, "the query finds the started book");
        assert!(
            all_memberships(&conn).is_empty(),
            "and stores nothing — a rule shelf owns no membership rows"
        );
        // It refuses a placement, and refusing must not leave a partial row behind.
        assert!(shelf_place_book(&conn, &r, "b2", None, 0).is_err());
        assert!(all_memberships(&conn).is_empty());
        // Removing from it is a no-op rather than an error, so a UI that tries cannot corrupt.
        assert!(crate::library::collection_remove_book(&conn, &r, "b1").is_ok());
        assert_eq!(shelf_items(&conn, &r).unwrap().len(), 1, "the rule still describes the book");
    }

    #[test]
    fn deleting_a_shelf_takes_its_categories_and_no_books() {
        let conn = db();
        for b in ["b1", "b2"] {
            add_book(&conn, b);
        }
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        let t = category_create(&conn, &s, "K").unwrap();
        let k = t.loose[0].categories[0].id.clone();
        shelf_place_book(&conn, &s, "b1", Some(&k), 0).unwrap();
        shelf_place_book(&conn, &s, "b2", None, 1).unwrap();

        crate::library::collection_delete(&conn, &s).unwrap();

        let books: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 2, "the books are untouched");
        assert!(all_memberships(&conn).is_empty(), "its memberships went with it");
        let cats: i64 = conn
            .query_row("SELECT COUNT(*) FROM collection_categories WHERE id = ?1", [&k], |r| r.get(0))
            .unwrap();
        assert_eq!(cats, 0, "and so did its categories, rather than being orphaned");
    }

    #[test]
    fn a_book_placed_on_shelf_after_shelf_ends_on_the_last_one_only() {
        // This test used to assert the opposite — that a book gathered a home on every shelf it was
        // placed on, and that leaving one left the others behind. That was the model, and it is the
        // model a real library broke: with several homes, each part of the app picked a different
        // one, so the same book reported a different place and a different set of destinations
        // depending only on which view was drawing it. A book is now in ONE place.
        let conn = db();
        add_book(&conn, "b1");
        let mut ids = Vec::new();
        for n in ["A", "B", "C", "D"] {
            let t = shelf_create(&conn, n, None, None).unwrap();
            ids.push(t.loose.iter().find(|s| s.name == n).unwrap().id.clone());
        }
        for id in &ids {
            shelf_place_book(&conn, id, "b1", None, 0).unwrap();
            assert_eq!(memberships(&conn, "b1"), 1, "never more than one, at any point");
        }

        // It is on the last shelf it was placed on, and on none of the others.
        assert!(shelf_items(&conn, &ids[3]).unwrap().iter().any(|i| i.book_id == "b1"));
        for id in &ids[..3] {
            assert!(
                shelf_items(&conn, id).unwrap().iter().all(|i| i.book_id != "b1"),
                "a shelf it was moved off holds nothing"
            );
        }

        // Taking it off that one leaves it unfiled rather than nowhere at all.
        crate::library::collection_remove_book(&conn, &ids[3], "b1").unwrap();
        assert_eq!(memberships(&conn, "b1"), 0, "on no shelf");
        let unfiled =
            crate::library::placement::container_books(&conn, crate::library::placement::UNFILED).unwrap();
        assert!(unfiled.iter().any(|(id, _)| id == "b1"), "but still placed, among the unfiled");
    }

    #[test]
    fn a_shelf_with_sixty_books_survives_being_shuffled_end_to_end() {
        let conn = db();
        for i in 0..60 {
            add_book(&conn, &format!("b{i:02}"));
        }
        let t = shelf_create(&conn, "S", None, None).unwrap();
        let s = t.loose[0].id.clone();
        for i in 0..60 {
            shelf_place_book(&conn, &s, &format!("b{i:02}"), None, i as i64).unwrap();
        }
        // Deterministic churn: take the last to the front, the front to the middle, repeatedly.
        for round in 0..20 {
            let items = shelf_items(&conn, &s).unwrap();
            let last = items.last().unwrap().book_id.clone();
            shelf_place_book(&conn, &s, &last, None, 0).unwrap();
            let first = shelf_items(&conn, &s).unwrap()[0].book_id.clone();
            shelf_place_book(&conn, &s, &first, None, 30).unwrap();
            let p = positions(&conn, &s);
            assert_eq!(p.len(), 60, "still sixty books in round {round}");
            assert_eq!(p, (0..60).collect::<Vec<_>>(), "and still densely numbered");
        }
        let distinct: std::collections::HashSet<_> =
            shelf_items(&conn, &s).unwrap().into_iter().map(|i| i.book_id).collect();
        assert_eq!(distinct.len(), 60, "no book was duplicated or lost");
    }

    #[test]
    fn names_that_would_break_a_query_are_stored_and_read_back_intact() {
        // Quotes, percent signs and Arabic all go through the same parameterised path; a name is
        // data, never SQL.
        let conn = db();
        let awkward = [
            "O'Brien's shelf",
            "100% done",
            "a; DROP TABLE collections;--",
            "الرفّ العربي",
            "  leading and trailing  ",
        ];
        for n in awkward {
            shelf_create(&conn, n, None, None).unwrap();
        }
        let t = tree(&conn).unwrap();
        assert_eq!(t.loose.len(), awkward.len(), "every one was stored");
        for n in awkward {
            assert!(t.loose.iter().any(|s| s.name == n), "{n:?} came back unchanged");
        }
        let still_there: i64 = conn
            .query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, awkward.len() as i64, "and the table survived");
    }
}
