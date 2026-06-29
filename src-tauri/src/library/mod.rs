//! Library repositories — CRUD for books, shelves, highlights, notes, bookmarks, and
//! reading progress. RAWY-09 implements reading-progress persistence (CFI + fraction);
//! RAWY-15 adds the Library home reads (`list_books`, `collections_list`) + a dev seed.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params_from_iter, types::ToSql, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

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

// ---------------------------------------------------------------------------
// RAWY-20 — highlights + notes (anchored by CFI; chapter_label denormalised so the
// future cross-book inbox is a cheap query). `color` stores the SEMANTIC slot
// (amber/rose/sky/green/purple), not a hex, so it adapts when the theme changes.
// ---------------------------------------------------------------------------

/// 24-hex id derived from stable parts → re-acting on the same range/target is idempotent.
fn gen_id(seed: &str) -> String {
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize)]
pub struct HighlightRow {
    pub id: String,
    pub book_id: String,
    pub cfi: String, // the range CFI (foliate getCFI) — stored in start_cfi
    pub color: String,
    pub text_excerpt: Option<String>,
    pub chapter_label: Option<String>,
    pub created_at: Option<i64>,
}

fn highlight_row(r: &rusqlite::Row) -> rusqlite::Result<HighlightRow> {
    Ok(HighlightRow {
        id: r.get(0)?,
        book_id: r.get(1)?,
        cfi: r.get(2)?,
        color: r.get(3)?,
        text_excerpt: r.get(4)?,
        chapter_label: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const HL_COLS: &str = "id, book_id, start_cfi, color, text_excerpt, chapter_label, created_at";

pub fn highlights_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<HighlightRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {HL_COLS} FROM highlights WHERE book_id = ?1 ORDER BY created_at"
    ))?;
    let rows = stmt.query_map([book_id], highlight_row)?;
    rows.collect()
}

fn get_highlight(conn: &Connection, id: &str) -> rusqlite::Result<Option<HighlightRow>> {
    conn.query_row(&format!("SELECT {HL_COLS} FROM highlights WHERE id = ?1"), [id], highlight_row)
        .optional()
}

/// Create/update a highlight for a CFI range (idempotent per book+range).
pub fn highlight_create(
    conn: &Connection,
    book_id: &str,
    cfi: &str,
    color: &str,
    excerpt: Option<&str>,
    chapter: Option<&str>,
) -> rusqlite::Result<Option<HighlightRow>> {
    let id = gen_id(&format!("hl:{book_id}:{cfi}"));
    conn.execute(
        "INSERT INTO highlights(id, book_id, start_cfi, color, text_excerpt, chapter_label, created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7) \
         ON CONFLICT(id) DO UPDATE SET color=excluded.color, \
            text_excerpt=excluded.text_excerpt, chapter_label=excluded.chapter_label",
        rusqlite::params![id, book_id, cfi, color, excerpt, chapter, now_unix()],
    )?;
    get_highlight(conn, &id)
}

pub fn highlight_set_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<Option<HighlightRow>> {
    conn.execute("UPDATE highlights SET color = ?2 WHERE id = ?1", rusqlite::params![id, color])?;
    get_highlight(conn, id)
}

pub fn highlight_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    // notes.highlight_id is ON DELETE SET NULL — a note survives its highlight as a stray.
    conn.execute("DELETE FROM highlights WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Serialize)]
pub struct NoteRow {
    pub id: String,
    pub book_id: String,
    pub highlight_id: Option<String>,
    pub cfi: Option<String>, // locator_cfi for a standalone note
    pub color: Option<String>,
    pub body: Option<String>,
    pub chapter_label: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn note_row(r: &rusqlite::Row) -> rusqlite::Result<NoteRow> {
    Ok(NoteRow {
        id: r.get(0)?,
        book_id: r.get(1)?,
        highlight_id: r.get(2)?,
        cfi: r.get(3)?,
        color: r.get(4)?,
        body: r.get(5)?,
        chapter_label: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const NOTE_COLS: &str =
    "id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at";

pub fn notes_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<NoteRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTE_COLS} FROM notes WHERE book_id = ?1 ORDER BY created_at"
    ))?;
    let rows = stmt.query_map([book_id], note_row)?;
    rows.collect()
}

fn get_note(conn: &Connection, id: &str) -> rusqlite::Result<Option<NoteRow>> {
    conn.query_row(&format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"), [id], note_row)
        .optional()
}

/// One note per highlight (or per standalone location) — idempotent on the anchor.
pub fn note_create(
    conn: &Connection,
    book_id: &str,
    highlight_id: Option<&str>,
    cfi: Option<&str>,
    color: Option<&str>,
    body: &str,
    chapter: Option<&str>,
) -> rusqlite::Result<Option<NoteRow>> {
    let anchor = highlight_id.or(cfi).unwrap_or("");
    let id = gen_id(&format!("note:{book_id}:{anchor}"));
    let now = now_unix();
    conn.execute(
        "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) \
         ON CONFLICT(id) DO UPDATE SET body=excluded.body, color=excluded.color, updated_at=excluded.updated_at",
        rusqlite::params![id, book_id, highlight_id, cfi, color, body, chapter, now],
    )?;
    get_note(conn, &id)
}

pub fn note_update(conn: &Connection, id: &str, body: &str, color: Option<&str>) -> rusqlite::Result<Option<NoteRow>> {
    conn.execute(
        "UPDATE notes SET body = ?2, color = COALESCE(?3, color), updated_at = ?4 WHERE id = ?1",
        rusqlite::params![id, body, color, now_unix()],
    )?;
    get_note(conn, id)
}

pub fn note_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

// ---- Cross-book Highlights & Notes inbox (RAWY-27) ----

/// One row of the global inbox: every HIGHLIGHT (with its attached note body, if any) plus
/// every STANDALONE note, joined to its book. `chapter_label` is denormalised (RAWY-20) so
/// this is a cheap query; `book_title`/`book_dir`/`file_path` are the effective book fields so
/// an item carries everything needed to render it AND to open the book at its CFI.
#[derive(Serialize)]
pub struct AnnoItem {
    pub id: String,
    pub kind: String, // "highlight" | "note"
    pub book_id: String,
    pub book_title: Option<String>,
    pub file_path: String,
    pub book_dir: Option<String>,
    pub chapter_label: Option<String>,
    pub color: Option<String>,
    pub text: Option<String>, // highlight excerpt OR note body
    pub note: Option<String>, // for a highlight that HAS a note: the note body (else null)
    pub cfi: Option<String>,  // jump target
    pub created_at: Option<i64>,
}

fn anno_item(r: &rusqlite::Row) -> rusqlite::Result<AnnoItem> {
    Ok(AnnoItem {
        id: r.get(0)?,
        kind: r.get(1)?,
        book_id: r.get(2)?,
        book_title: r.get(3)?,
        file_path: r.get(4)?,
        book_dir: r.get(5)?,
        chapter_label: r.get(6)?,
        color: r.get(7)?,
        text: r.get(8)?,
        note: r.get(9)?,
        cfi: r.get(10)?,
        created_at: r.get(11)?,
    })
}

/// All highlights + standalone notes across every book, newest first. Notes attached to a
/// highlight ride INSIDE that highlight's row (`note`), not as separate items.
pub fn annotations_all(conn: &Connection) -> rusqlite::Result<Vec<AnnoItem>> {
    let sql = format!(
        "SELECT h.id, 'highlight', h.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            h.chapter_label, h.color, h.text_excerpt, n.body, h.start_cfi, h.created_at \
         FROM highlights h JOIN books b ON b.id = h.book_id \
         LEFT JOIN notes n ON n.highlight_id = h.id \
         UNION ALL \
         SELECT n.id, 'note', n.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            n.chapter_label, n.color, n.body, NULL, n.locator_cfi, n.created_at \
         FROM notes n JOIN books b ON b.id = n.book_id \
         WHERE n.highlight_id IS NULL \
         ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], anno_item)?;
    rows.collect()
}
