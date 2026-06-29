//! Library repositories — CRUD for books, shelves, highlights, notes, bookmarks, and
//! reading progress. RAWY-09 implements reading-progress persistence (CFI + fraction);
//! RAWY-15 adds the Library home reads (`list_books`, `collections_list`) + a dev seed.

use std::path::Path;
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
    pub read_at: Option<i64>,         // reading_progress.updated_at — "date read"
    pub cover_fit: Option<String>,    // per-book crop/fit override (RAWY-19), or null
}

// Effective fields = a metadata_overrides value when present, else the extracted column.
// Field names are STATIC literals (never user input), so interpolation is injection-safe.
const OV_TITLE: &str = "COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='title'), b.title)";
const OV_AUTHOR: &str = "COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='author'), b.author)";

/// The SELECT column list yielding EFFECTIVE book fields, in BookRow order.
fn book_select() -> String {
    format!(
        "b.id, b.file_path, b.format, {OV_TITLE}, {OV_AUTHOR}, \
         COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='language'), b.language), \
         COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
         COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='cover'), b.cover_path), \
         b.added_at, b.last_opened_at, p.fraction, p.updated_at, \
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='cover_fit')"
    )
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<BookRow> {
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
        cover_fit: r.get(12)?,
    })
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
    // Whitelist the ORDER BY column (effective title/author so edits re-sort correctly).
    let sort_col = match sort {
        "author" => format!("LOWER(COALESCE({OV_AUTHOR},''))"),
        "format" => "LOWER(COALESCE(b.format,''))".to_string(),
        "date_read" => "COALESCE(p.updated_at,0)".to_string(),
        "date_added" => "COALESCE(b.added_at,0)".to_string(),
        _ => format!("LOWER(COALESCE({OV_TITLE},''))"),
    };
    let dir_sql = if order.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };

    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(f) = format.filter(|s| !s.is_empty()) {
        clauses.push("b.format = ?".into());
        args.push(Box::new(f.to_string()));
    }
    if let Some(c) = collection.filter(|s| !s.is_empty()) {
        clauses.push("b.id IN (SELECT book_id FROM book_collections WHERE collection_id = ?)".into());
        args.push(Box::new(c.to_string()));
    }
    if let Some(s) = search.filter(|s| !s.is_empty()) {
        clauses.push(format!("({OV_TITLE} LIKE ? OR {OV_AUTHOR} LIKE ?)"));
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
        "SELECT {} FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id \
         {where_sql} ORDER BY {sort_col} {dir_sql}, LOWER(COALESCE({OV_TITLE},'')) ASC",
        book_select()
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), row_from)?;
    rows.collect()
}

/// One book with overrides applied (for returning the fresh state after an edit).
pub fn get_book(conn: &Connection, id: &str) -> rusqlite::Result<Option<BookRow>> {
    let sql = format!(
        "SELECT {} FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id WHERE b.id = ?1",
        book_select()
    );
    conn.query_row(&sql, [id], row_from).optional()
}

// ---------------------------------------------------------------------------
// RAWY-19 — per-book edits as overrides (the source EPUB is never rewritten).
// ---------------------------------------------------------------------------

fn set_override(conn: &Connection, id: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO metadata_overrides(book_id, field, value) VALUES(?1,?2,?3) \
         ON CONFLICT(book_id, field) DO UPDATE SET value = excluded.value",
        rusqlite::params![id, field, value],
    )?;
    Ok(())
}

fn clear_override(conn: &Connection, id: &str, field: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM metadata_overrides WHERE book_id = ?1 AND field = ?2",
        rusqlite::params![id, field],
    )?;
    Ok(())
}

fn get_override(conn: &Connection, id: &str, field: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM metadata_overrides WHERE book_id = ?1 AND field = ?2",
        rusqlite::params![id, field],
        |r| r.get(0),
    )
    .optional()
}

/// Base (extracted) value of a whitelisted books column.
fn base_field(conn: &Connection, id: &str, col: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(&format!("SELECT {col} FROM books WHERE id = ?1"), [id], |r| r.get(0))
        .optional()
        .map(|o| o.flatten())
}

/// Set an override only if it differs from the extracted base; clear it otherwise (so the
/// overrides table stays minimal and editing a value back to the original reverts it).
fn apply_field(conn: &Connection, id: &str, field: &str, base_col: &str, new: Option<&str>) -> rusqlite::Result<()> {
    let Some(v) = new else { return Ok(()) }; // None = caller didn't touch this field
    let base = base_field(conn, id, base_col)?;
    if v.is_empty() || base.as_deref() == Some(v) {
        clear_override(conn, id, field)
    } else {
        set_override(conn, id, field, v)
    }
}

/// Update editable metadata as overrides; returns the fresh book.
pub fn update_book(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    author: Option<&str>,
    language: Option<&str>,
    dir: Option<&str>,
    cover_fit: Option<&str>,
) -> rusqlite::Result<Option<BookRow>> {
    apply_field(conn, id, "title", "title", title)?;
    apply_field(conn, id, "author", "author", author)?;
    apply_field(conn, id, "language", "language", language)?;
    apply_field(conn, id, "dir", "dir", dir)?;
    // cover_fit has no extracted base — set when given (crop/fit), clear when empty.
    match cover_fit {
        Some(v) if !v.is_empty() => set_override(conn, id, "cover_fit", v)?,
        Some(_) => clear_override(conn, id, "cover_fit")?,
        None => {}
    }
    get_book(conn, id)
}

/// Replace the cover: copy the image INTO managed storage and store a 'cover' override
/// (the extracted cover file is left intact, so revert restores it).
pub fn set_cover(conn: &Connection, app_data_dir: &Path, id: &str, image_path: &str) -> Result<Option<BookRow>, String> {
    let covers = app_data_dir.join("library").join("covers");
    std::fs::create_dir_all(&covers).map_err(|e| e.to_string())?;
    let ext = Path::new(image_path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "img".into());
    let dest = covers.join(format!("{id}-custom.{ext}"));
    std::fs::copy(image_path, &dest).map_err(|e| format!("Couldn't copy cover: {e}"))?;
    set_override(conn, id, "cover", &dest.to_string_lossy()).map_err(|e| e.to_string())?;
    get_book(conn, id).map_err(|e| e.to_string())
}

/// Revert to the extracted/auto cover: delete the custom file + the 'cover' override.
pub fn revert_cover(conn: &Connection, id: &str) -> Result<Option<BookRow>, String> {
    if let Some(path) = get_override(conn, id, "cover").map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(&path); // best-effort; ignore if already gone
    }
    clear_override(conn, id, "cover").map_err(|e| e.to_string())?;
    get_book(conn, id).map_err(|e| e.to_string())
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
