//! Library repositories — CRUD for books, shelves, highlights, notes, bookmarks, and
//! reading progress. RAWY-09 implements reading-progress persistence (CFI + fraction);
//! RAWY-15 adds the Library home reads (`list_books`, `collections_list`) + a dev seed.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params_from_iter, types::ToSql, Connection, OptionalExtension};
use serde::Serialize;

/// Persisted reading position for a book.
#[derive(Serialize)]
pub struct Progress {
    pub cfi: Option<String>,
    pub fraction: f64,
}

/// Upsert the reading position for a book (one row per book).
pub fn progress_save(
    conn: &Connection,
    book_id: &str,
    cfi: &str,
    fraction: f64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_progress(book_id, locator_cfi, fraction, updated_at) \
         VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_id) DO UPDATE SET \
            locator_cfi = excluded.locator_cfi, \
            fraction    = excluded.fraction, \
            updated_at  = excluded.updated_at",
        rusqlite::params![book_id, cfi, fraction, now_unix()],
    )?;
    Ok(())
}

/// Read the saved position for a book, or `None` if never opened.
pub fn progress_get(conn: &Connection, book_id: &str) -> rusqlite::Result<Option<Progress>> {
    conn.query_row(
        "SELECT locator_cfi, fraction FROM reading_progress WHERE book_id = ?1",
        [book_id],
        |r| {
            Ok(Progress {
                cfi: r.get(0)?,
                fraction: r.get(1)?,
            })
        },
    )
    .optional()
}

// ---------------------------------------------------------------------------
// RAWY-15 — Library home: list books (with progress), list shelves, dev seed.
// ---------------------------------------------------------------------------

/// One book as the Library grid/list needs it: metadata + reading progress joined.
#[derive(Serialize)]
pub struct BookRow {
    pub id: String,
    pub file_path: String,
    pub format: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub dir: Option<String>,
    pub cover_path: Option<String>,
    pub added_at: Option<i64>,
    pub last_opened_at: Option<i64>,
    pub fraction: Option<f64>,
    pub read_at: Option<i64>, // reading_progress.updated_at — "date read"
}

/// List books for the Library, sorted + filtered in SQL (the seam stays typed).
/// `sort` ∈ {title,author,format,date_read,date_added}; `order` ∈ {asc,desc}.
/// `format`/`collection`/`search` are optional filters (empty = ignored).
pub fn list_books(
    conn: &Connection,
    sort: &str,
    order: &str,
    format: Option<&str>,
    collection: Option<&str>,
    search: Option<&str>,
) -> rusqlite::Result<Vec<BookRow>> {
    // Whitelist the ORDER BY column — never interpolate user text into SQL.
    let sort_col = match sort {
        "author" => "LOWER(COALESCE(b.author,''))",
        "format" => "LOWER(COALESCE(b.format,''))",
        "date_read" => "COALESCE(p.updated_at,0)",
        "date_added" => "COALESCE(b.added_at,0)",
        _ => "LOWER(COALESCE(b.title,''))",
    };
    let dir_sql = if order.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };

    let mut clauses: Vec<&str> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(f) = format.filter(|s| !s.is_empty()) {
        clauses.push("b.format = ?");
        args.push(Box::new(f.to_string()));
    }
    if let Some(c) = collection.filter(|s| !s.is_empty()) {
        clauses.push("b.id IN (SELECT book_id FROM book_collections WHERE collection_id = ?)");
        args.push(Box::new(c.to_string()));
    }
    if let Some(s) = search.filter(|s| !s.is_empty()) {
        clauses.push("(b.title LIKE ? OR b.author LIKE ?)");
        let like = format!("%{s}%");
        args.push(Box::new(like.clone()));
        args.push(Box::new(like));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    let sql = format!(
        "SELECT b.id, b.file_path, b.format, b.title, b.author, b.language, b.dir, \
                b.cover_path, b.added_at, b.last_opened_at, p.fraction, p.updated_at \
         FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id \
         {where_sql} \
         ORDER BY {sort_col} {dir_sql}, LOWER(COALESCE(b.title,'')) ASC"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), |r| {
        Ok(BookRow {
            id: r.get(0)?,
            file_path: r.get(1)?,
            format: r.get(2)?,
            title: r.get(3)?,
            author: r.get(4)?,
            language: r.get(5)?,
            dir: r.get(6)?,
            cover_path: r.get(7)?,
            added_at: r.get(8)?,
            last_opened_at: r.get(9)?,
            fraction: r.get(10)?,
            read_at: r.get(11)?,
        })
    })?;
    rows.collect()
}

/// A shelf (collection) with its live book count, for the sidebar.
#[derive(Serialize)]
pub struct CollectionRow {
    pub id: String,
    pub name: String,
    pub count: i64,
}

pub fn collections_list(conn: &Connection) -> rusqlite::Result<Vec<CollectionRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, COUNT(bc.book_id) \
         FROM collections c LEFT JOIN book_collections bc ON bc.collection_id = c.id \
         GROUP BY c.id, c.name ORDER BY COALESCE(c.sort_order, 0), c.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CollectionRow {
            id: r.get(0)?,
            name: r.get(1)?,
            count: r.get(2)?,
        })
    })?;
    rows.collect()
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
