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
               (SELECT COUNT(*) FROM book_collections bc WHERE bc.collection_id = c.id) \
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
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(raw.len());
    for (id, name, cid, order_rule, auto_rule, collapsed, manual_count) in raw {
        // A rule shelf's count is what the rule yields; a hand shelf's is its membership.
        let count = match auto_rule.as_deref() {
            Some(rule) => auto_count(conn, rule)?,
            None => manual_count,
        };
        out.push(ShelfNode {
            categories: categories_of(conn, &id)?,
            id,
            name,
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

    #[test]
    fn an_unknown_rule_is_refused_rather_than_stored() {
        let conn = db();
        assert!(shelf_create(&conn, "S", None, Some("nonsense")).is_err());
        let t = shelf_create(&conn, "S", None, None).unwrap();
        assert!(shelf_set_order(&conn, &t.loose[0].id, "sideways").is_err());
    }
}
