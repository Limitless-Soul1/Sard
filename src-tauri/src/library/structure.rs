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
               (SELECT COUNT(*) FROM book_collections bc WHERE bc.collection_id = c.id), c.ink \
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
         (SELECT COUNT(*) FROM book_collections bc WHERE bc.category_id = k.id) \
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
        // DISTINCT, so a book on two shelves of this case is counted once.
        let count: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT bc.book_id) FROM book_collections bc \
             JOIN collections c ON c.id = bc.collection_id WHERE c.case_id = ?1",
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

    let mut stmt = conn.prepare(
        "SELECT book_id, COALESCE(position, 0), category_id FROM book_collections \
         WHERE collection_id = ?1 ORDER BY COALESCE(position, 0), book_id",
    )?;
    let out = stmt
        .query_map([collection_id], |r| {
            Ok(ShelfItem {
                book_id: r.get(0)?,
                position: r.get(1)?,
                category_id: r.get(2)?,
            })
        })?
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

/// Place a book at `index` within a shelf (and optionally within one of its categories).
///
/// This is the single write behind both drag-and-drop and the keyboard move: it removes the
/// book from its old position on THIS shelf if present, then renumbers the whole shelf so
/// positions stay dense and total. Refused on a rule shelf, whose contents are computed.
pub fn shelf_place_book(
    conn: &Connection,
    collection_id: &str,
    book_id: &str,
    category_id: Option<&str>,
    index: i64,
) -> rusqlite::Result<LibraryTree> {
    let auto: Option<String> = conn
        .query_row("SELECT auto_rule FROM collections WHERE id = ?1", [collection_id], |r| r.get(0))
        .optional()?
        .flatten();
    if auto.is_some() {
        return Err(rusqlite::Error::InvalidParameterName(
            "cannot place a book on a shelf that fills itself".into(),
        ));
    }

    let tx = conn.unchecked_transaction()?;
    let mut ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT book_id FROM book_collections WHERE collection_id = ?1 \
             ORDER BY COALESCE(position, 0), book_id",
        )?;
        let rows = stmt
            .query_map([collection_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    if let Some(cur) = ids.iter().position(|x| x == book_id) {
        ids.remove(cur);
    } else {
        tx.execute(
            "INSERT OR IGNORE INTO book_collections(book_id, collection_id) VALUES(?1, ?2)",
            rusqlite::params![book_id, collection_id],
        )?;
    }
    let at = (index.max(0) as usize).min(ids.len());
    ids.insert(at, book_id.to_string());

    for (i, bid) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE book_collections SET position = ?3 WHERE collection_id = ?1 AND book_id = ?2",
            rusqlite::params![collection_id, bid, i as i64],
        )?;
    }
    tx.execute(
        "UPDATE book_collections SET category_id = ?3 WHERE collection_id = ?1 AND book_id = ?2",
        rusqlite::params![collection_id, book_id, category_id],
    )?;
    tx.commit()?;
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
        // Joining another shelf does NOT leave the first — a book may sit on several shelves.
        shelf_place_book(&conn, &to, "b1", None, 0).unwrap();
        assert_eq!(shelf_items(&conn, &from).unwrap().len(), 1);
        assert_eq!(shelf_items(&conn, &to).unwrap().len(), 1);

        // Leaving one shelf leaves the book on the other, and in the library.
        crate::library::collection_remove_book(&conn, &from, "b1").unwrap();
        assert_eq!(shelf_items(&conn, &from).unwrap().len(), 0);
        assert_eq!(shelf_items(&conn, &to).unwrap().len(), 1);
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

    fn memberships(conn: &Connection, book: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM book_collections WHERE book_id = ?1",
            [book],
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
}
