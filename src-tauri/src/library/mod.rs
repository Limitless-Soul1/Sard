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

// RAWY-178 (AUD-12): Arabic-aware search folding for the LIBRARY search, mirroring the in-book
// search's `normalizeForSearch` (FoliateController.ts) so both fold consistently — an unvocalized
// query finds a vocalized title (كتاب ⇒ كِتاب) and hamza/alef variants match (أحمد ⇔ احمد). Applied
// to a precomputed `title_fold`/`author_fold` shadow (import + edit + a migration backfill), and to
// the query term, so the LIKE compares folded-to-folded. NOTE: this omits `normalizeForSearch`'s
// leading NFKC pass (Rust has no NFKC without a new crate) — for normal (NFC) titles that's a no-op;
// the tashkīl/tatweel strip + alef/ya/teh folding + lowercase + whitespace-drop below cover the
// Arabic-first cases the audit names. Both sides use THIS function, so the library is self-consistent.
pub fn fold_search(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let mapped = match ch {
            '\u{0622}' | '\u{0623}' | '\u{0625}' | '\u{0671}' => 'ا', // آ أ إ ٱ → ا
            '\u{0649}' => 'ي',                                        // ى → ي
            '\u{0629}' => 'ه',                                        // ة → ه
            // tashkīl + tatweel → drop (matches TASHKIL_TATWEEL in normalizeForSearch)
            '\u{0640}' | '\u{064B}'..='\u{0652}' | '\u{0670}' | '\u{06D6}'..='\u{06ED}' => continue,
            c if c.is_whitespace() => continue, // drop all whitespace (\s+ → "")
            c => c,
        };
        for lc in mapped.to_lowercase() {
            out.push(lc);
        }
    }
    out
}

/// Escape the LIKE metacharacters `\` `%` `_` so a user's query is matched LITERALLY (RAWY-178/AUD-12:
/// previously `%`/`_` in a library query acted as unescaped wildcards). Pair with `ESCAPE '\'`.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

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
        // RAWY-178 (AUD-12): match against the precomputed Arabic-FOLDED shadow columns with a folded,
        // LIKE-escaped query — so كتاب finds كِتاب, أحمد finds احمد, and %/_ are literal (not wildcards).
        clauses.push("(b.title_fold LIKE ? ESCAPE '\\' OR b.author_fold LIKE ? ESCAPE '\\')".to_string());
        let like = format!("%{}%", escape_like(&fold_search(s)));
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
    // RAWY-178 (AUD-12): a title/author edit changes the EFFECTIVE value, so refresh the folded search
    // shadow from the effective (override-or-base) value — whether the override was set OR cleared.
    conn.execute(
        "UPDATE books SET \
            title_fold  = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id=books.id AND field='title'),  title)), \
            author_fold = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id=books.id AND field='author'), author)) \
         WHERE id = ?1",
        [id],
    )?;
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

/// RAWY-85: persist a page-1 cover for a PDF from raw PNG bytes (the reader extracts it via the
/// adapter's `getCover()` on first open). Stored as the book's EXTRACTED cover (`books.cover_path`,
/// like an EPUB cover) — so "revert cover" still works and the RAWY-76 delete cascade removes it.
pub fn set_cover_bytes(conn: &Connection, app_data_dir: &Path, id: &str, data: &[u8]) -> Result<(), String> {
    let covers = app_data_dir.join("library").join("covers");
    std::fs::create_dir_all(&covers).map_err(|e| e.to_string())?;
    let dest = covers.join(format!("{id}-cover.png"));
    std::fs::write(&dest, data).map_err(|e| format!("Couldn't write cover: {e}"))?;
    conn.execute(
        "UPDATE books SET cover_path=?1 WHERE id=?2",
        rusqlite::params![dest.to_string_lossy(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Revert to the extracted/auto cover: delete the custom file + the 'cover' override.
pub fn revert_cover(conn: &Connection, id: &str) -> Result<Option<BookRow>, String> {
    if let Some(path) = get_override(conn, id, "cover").map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(&path); // best-effort; ignore if already gone
    }
    clear_override(conn, id, "cover").map_err(|e| e.to_string())?;
    get_book(conn, id).map_err(|e| e.to_string())
}

/// RAWY-76 (data-integrity wave 1) — delete a book AND everything tied to its `book_id`, leaving
/// ZERO orphans, then remove its files. Every other book is untouched.
///
/// The DB work runs in one transaction. Most child tables carry `FOREIGN KEY(book_id) REFERENCES
/// books(id) ON DELETE CASCADE` (metadata_overrides, book_collections, reading_progress, highlights,
/// notes, bookmarks, book_index) and `foreign_keys=ON` (db::open_database), so `DELETE FROM books`
/// removes them automatically. Three things have NO FK and are deleted explicitly: `photo_cards`
/// (book_id is a plain nullable column — a saved card would otherwise dangle) and the per-book
/// `settings` rows `book_style:<id>` (RAWY-19/40) + `tts_position:<id>` (RAWY-162, last-spoken
/// sentence). Files removed best-effort AFTER the commit: the
/// managed `.epub`, the extracted cover, a replaced-cover file (the 'cover' override), and each
/// saved photo-card PNG. `false` = no such book.
pub fn delete_book(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<bool, String> {
    // Gather every file path BEFORE the rows go away (cover override read via metadata_overrides).
    let (epub_path, cover_path) = match get_book_files(conn, id).map_err(|e| e.to_string())? {
        Some(paths) => paths,
        None => return Ok(false), // unknown book — nothing to do
    };
    let custom_cover = get_override(conn, id, "cover").map_err(|e| e.to_string())?;
    let card_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM photo_cards WHERE book_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // No FK on these two — delete explicitly.
    tx.execute("DELETE FROM photo_cards WHERE book_id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM settings WHERE key = ?1", [format!("book_style:{id}")])
        .map_err(|e| e.to_string())?;
    // RAWY-162: the per-book last-spoken TTS sentence is another FK-less `settings` row — delete it too.
    tx.execute("DELETE FROM settings WHERE key = ?1", [format!("tts_position:{id}")])
        .map_err(|e| e.to_string())?;
    // The book row + all FK-cascade children (overrides, shelf membership, progress, highlights,
    // notes, bookmarks, index) in one shot.
    let removed = tx
        .execute("DELETE FROM books WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // Files: best-effort (a missing file is fine — the DB is already consistent).
    let _ = std::fs::remove_file(&epub_path);
    if let Some(c) = cover_path {
        let _ = std::fs::remove_file(&c);
    }
    if let Some(c) = custom_cover {
        let _ = std::fs::remove_file(&c);
    }
    let cards_dir = app_data_dir.join("photocards");
    for cid in card_ids {
        let _ = std::fs::remove_file(cards_dir.join(format!("{cid}.png")));
    }
    Ok(removed > 0)
}

/// The book's managed .epub path + its EXTRACTED cover path (the raw `books` columns, not the
/// COALESCE'd view — a replaced cover lives in the 'cover' override and is handled separately).
fn get_book_files(conn: &Connection, id: &str) -> rusqlite::Result<Option<(String, Option<String>)>> {
    conn.query_row(
        "SELECT file_path, cover_path FROM books WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
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

// ---------------------------------------------------------------------------
// RAWY-31 — shelf (collection) writes. Every write returns the REFRESHED shelf
// list (collections_list) so the UI updates names + live counts in one round-trip.
// Reuses the RAWY-08 tables; deleting a shelf removes the collection and (via the
// book_collections FK `ON DELETE CASCADE`) its membership rows — the BOOKS are
// never touched.
// ---------------------------------------------------------------------------

/// Create a shelf (placed at the end). The new shelf starts with count 0.
pub fn collection_create(conn: &Connection, name: &str) -> rusqlite::Result<Vec<CollectionRow>> {
    let now = now_unix();
    let id = gen_id(&format!("shelf|{name}|{now}"));
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collections", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO collections(id, name, sort_order, created_at) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, next, now],
    )?;
    collections_list(conn)
}

/// Rename a shelf (the books and memberships are untouched).
pub fn collection_rename(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<Vec<CollectionRow>> {
    conn.execute("UPDATE collections SET name = ?2 WHERE id = ?1", rusqlite::params![id, name])?;
    collections_list(conn)
}

/// Delete a shelf. `book_collections` rows cascade away (FK ON DELETE CASCADE); the
/// BOOKS remain in the library.
pub fn collection_delete(conn: &Connection, id: &str) -> rusqlite::Result<Vec<CollectionRow>> {
    conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
    collections_list(conn)
}

/// Add a book to a shelf (idempotent — re-adding is a no-op).
pub fn collection_add_book(conn: &Connection, collection_id: &str, book_id: &str) -> rusqlite::Result<Vec<CollectionRow>> {
    conn.execute(
        "INSERT OR IGNORE INTO book_collections(book_id, collection_id) VALUES(?1, ?2)",
        rusqlite::params![book_id, collection_id],
    )?;
    collections_list(conn)
}

/// Remove a book from a shelf (the book itself is untouched).
pub fn collection_remove_book(conn: &Connection, collection_id: &str, book_id: &str) -> rusqlite::Result<Vec<CollectionRow>> {
    conn.execute(
        "DELETE FROM book_collections WHERE book_id = ?1 AND collection_id = ?2",
        rusqlite::params![book_id, collection_id],
    )?;
    collections_list(conn)
}

/// The shelf ids a book currently belongs to (drives the edit-dialog chips).
pub fn collections_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT collection_id FROM book_collections WHERE book_id = ?1")?;
    let rows = stmt.query_map([book_id], |r| r.get::<_, String>(0))?;
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
    /// RAWY-259: this highlight's OWN ink density. `None` = follow the theme's default, which is what
    /// every pre-existing highlight does — so the column needs no backfill and old rows are unchanged.
    pub alpha: Option<f64>,
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
        alpha: r.get(7)?,
    })
}

const HL_COLS: &str = "id, book_id, start_cfi, color, text_excerpt, chapter_label, created_at, alpha";

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

/// RAWY-259: set (or clear) a highlight's OWN ink density. `None` restores "follow the theme default",
/// so the control can always be returned to the state every highlight had before this feature existed.
/// Touches one row by id — editing one highlight can never move another.
pub fn highlight_set_alpha(
    conn: &Connection,
    id: &str,
    alpha: Option<f64>,
) -> rusqlite::Result<Option<HighlightRow>> {
    // Clamp defensively: the value comes from a UI control, and a stored out-of-range alpha would make a
    // highlight invisible (0) or opaque enough to bury the text (>1) with no way back except this control.
    let a = alpha.map(|v| v.clamp(0.05, 1.0));
    conn.execute("UPDATE highlights SET alpha = ?2 WHERE id = ?1", rusqlite::params![id, a])?;
    get_highlight(conn, id)
}

pub fn highlight_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    // notes.highlight_id is ON DELETE SET NULL — a note survives its highlight as a stray.
    conn.execute("DELETE FROM highlights WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// RAWY-41 — bookmarks: a saved CFI location the user returns to. Mirrors the highlights
// pattern (denormalised chapter_label; a fraction 0..1 so the on-page marker can show only
// where placed). id derived from book+cfi so toggling the same spot is idempotent.
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub struct BookmarkRow {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub chapter_label: Option<String>,
    pub fraction: Option<f64>,
    pub label: Option<String>,
    pub created_at: Option<i64>,
}

const BM_COLS: &str = "id, book_id, locator_cfi, chapter_label, fraction, label, created_at";

fn bookmark_row(r: &rusqlite::Row) -> rusqlite::Result<BookmarkRow> {
    Ok(BookmarkRow {
        id: r.get(0)?,
        book_id: r.get(1)?,
        cfi: r.get(2)?,
        chapter_label: r.get(3)?,
        fraction: r.get(4)?,
        label: r.get(5)?,
        created_at: r.get(6)?,
    })
}

pub fn bookmarks_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<BookmarkRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BM_COLS} FROM bookmarks WHERE book_id = ?1 ORDER BY fraction"
    ))?;
    let rows = stmt.query_map([book_id], bookmark_row)?;
    rows.collect()
}

pub fn bookmark_create(
    conn: &Connection,
    book_id: &str,
    cfi: &str,
    chapter: Option<&str>,
    fraction: Option<f64>,
    label: Option<&str>,
) -> rusqlite::Result<Option<BookmarkRow>> {
    let id = gen_id(&format!("bm:{book_id}:{cfi}"));
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, locator_cfi, chapter_label, fraction, label, created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7) \
         ON CONFLICT(id) DO UPDATE SET chapter_label=excluded.chapter_label, \
            fraction=excluded.fraction, label=excluded.label",
        rusqlite::params![id, book_id, cfi, chapter, fraction, label, now_unix()],
    )?;
    conn.query_row(&format!("SELECT {BM_COLS} FROM bookmarks WHERE id = ?1"), [&id], bookmark_row)
        .optional()
}

pub fn bookmark_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Serialize)]
pub struct BookmarkItem {
    pub id: String,
    pub book_id: String,
    pub book_title: Option<String>,
    pub file_path: String,
    pub book_dir: Option<String>,
    pub chapter_label: Option<String>,
    pub fraction: Option<f64>,
    pub label: Option<String>,
    pub cfi: String,
    pub created_at: Option<i64>,
}

/// All bookmarks across every book, newest first (the global list, like annotations_all).
pub fn bookmarks_all(conn: &Connection) -> rusqlite::Result<Vec<BookmarkItem>> {
    let sql = format!(
        "SELECT k.id, k.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            k.chapter_label, k.fraction, k.label, k.locator_cfi, k.created_at \
         FROM bookmarks k JOIN books b ON b.id = k.book_id \
         ORDER BY k.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(BookmarkItem {
            id: r.get(0)?,
            book_id: r.get(1)?,
            book_title: r.get(2)?,
            file_path: r.get(3)?,
            book_dir: r.get(4)?,
            chapter_label: r.get(5)?,
            fraction: r.get(6)?,
            label: r.get(7)?,
            cfi: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    rows.collect()
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
    // FK note_tags.note_id -> notes(id) ON DELETE CASCADE removes this note's tag links (no orphans).
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

// ---- Custom note TAGS (RAWY-203): many-to-many, shared across all books ----
#[derive(Serialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub created_at: Option<i64>,
}

fn tag_row(r: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })
}

/// Every tag, alphabetical (case-insensitive) — the user's shared tag list.
pub fn tags_list(conn: &Connection) -> rusqlite::Result<Vec<Tag>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at FROM tags ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], tag_row)?;
    rows.collect()
}

/// Create a tag by name, or REUSE the existing one — names are UNIQUE and shared, so adding a name that
/// already exists returns the existing tag (no duplicate). Trims; an empty/whitespace name is a no-op.
pub fn tag_create(conn: &Connection, name: &str) -> rusqlite::Result<Option<Tag>> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let id = gen_id(&format!("tag:{name}"));
    conn.execute(
        "INSERT INTO tags(id, name, created_at) VALUES(?1,?2,?3) ON CONFLICT(name) DO NOTHING",
        rusqlite::params![id, name, now_unix()],
    )?;
    conn.query_row("SELECT id, name, created_at FROM tags WHERE name = ?1", [name], tag_row)
        .optional()
}

/// Delete a tag. ON DELETE CASCADE clears its `note_tags` links; the `notes` table has NO FK to tags,
/// so the notes themselves are never touched — deleting a tag only unlinks it, never deletes a note.
pub fn tag_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    Ok(())
}

/// The tags currently on one note (to populate the note editor).
pub fn note_tags_for(conn: &Connection, note_id: &str) -> rusqlite::Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.created_at FROM note_tags nt JOIN tags t ON t.id = nt.tag_id \
         WHERE nt.note_id = ?1 ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([note_id], tag_row)?;
    rows.collect()
}

/// Replace a note's tag set with exactly `tag_ids` (the editor sends the full selection). Atomic.
pub fn note_tags_set(conn: &Connection, note_id: &str, tag_ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM note_tags WHERE note_id = ?1", [note_id])?;
    for tid in tag_ids {
        tx.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES(?1,?2)",
            rusqlite::params![note_id, tid],
        )?;
    }
    tx.commit()
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
    // RAWY-203: the item's underlying NOTE id (a standalone note, or the note attached to a highlight),
    // so the UI knows which note to tag; null for a highlight with no note (nothing to tag). And the
    // note's tag NAMES, so the Inbox can filter by tag. Empty for an untagged/note-less item.
    pub note_id: Option<String>,
    pub tags: Vec<String>,
}

fn anno_item(r: &rusqlite::Row) -> rusqlite::Result<AnnoItem> {
    // GROUP_CONCAT joins the tag names with a newline (a tag name is a single-line string, so it never
    // contains one) — split back into a list; NULL (no tags) -> empty.
    let tag_str: Option<String> = r.get(13)?;
    let tags = tag_str
        .map(|s| s.split('\n').filter(|t| !t.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
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
        note_id: r.get(12)?,
        tags,
    })
}

/// All highlights + standalone notes across every book, newest first. Notes attached to a
/// highlight ride INSIDE that highlight's row (`note`), not as separate items.
pub fn annotations_all(conn: &Connection) -> rusqlite::Result<Vec<AnnoItem>> {
    // RAWY-203: EXTENDED, not replaced — two columns appended to each branch (the underlying note id +
    // its GROUP_CONCAT'd tag names). `created_at` stays column 12, so `ORDER BY created_at` is unchanged
    // and every existing field an item carried before is still returned in the same position.
    let tags_sub = "(SELECT GROUP_CONCAT(tg.name, char(10)) FROM note_tags nt \
                     JOIN tags tg ON tg.id = nt.tag_id WHERE nt.note_id = n.id)";
    let sql = format!(
        "SELECT h.id, 'highlight', h.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            h.chapter_label, h.color, h.text_excerpt, n.body, h.start_cfi, h.created_at, n.id, {tags_sub} \
         FROM highlights h JOIN books b ON b.id = h.book_id \
         LEFT JOIN notes n ON n.highlight_id = h.id \
         UNION ALL \
         SELECT n.id, 'note', n.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            n.chapter_label, n.color, n.body, NULL, n.locator_cfi, n.created_at, n.id, {tags_sub} \
         FROM notes n JOIN books b ON b.id = n.book_id \
         WHERE n.highlight_id IS NULL \
         ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], anno_item)?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::{escape_like, fold_search};

    // RAWY-178 (AUD-12): the library fold matches the in-book search intent — an unvocalized query
    // folds to the same string as the vocalized/variant title, so LIKE compares folded-to-folded.
    #[test]
    fn fold_search_folds_tashkil_and_variants() {
        // tashkīl stripped: كِتاب ⇒ كتاب
        assert_eq!(fold_search("كِتاب"), fold_search("كتاب"));
        // hamza/alef variants: أحمد ⇔ احمد ⇔ إحمد ⇔ آحمد
        assert_eq!(fold_search("أحمد"), fold_search("احمد"));
        assert_eq!(fold_search("إحمد"), fold_search("احمد"));
        assert_eq!(fold_search("آحمد"), fold_search("احمد"));
        // alef maqsura ى ⇒ ya ي ; teh marbuta ة ⇒ ه
        assert_eq!(fold_search("مصطفى"), fold_search("مصطفي"));
        assert_eq!(fold_search("مكتبة"), fold_search("مكتبه"));
        // tatweel + whitespace dropped, Latin lowercased
        assert_eq!(fold_search("كـتـاب"), fold_search("كتاب"));
        assert_eq!(fold_search("The Book"), "thebook");
        // a plain query is unchanged apart from case/space
        assert_eq!(fold_search("Alice"), "alice");
    }

    // RAWY-178 (AUD-12): %/_/\ become literal so a query with them isn't a wildcard.
    #[test]
    fn escape_like_escapes_metachars() {
        assert_eq!(escape_like("50%"), "50\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("x\\y"), "x\\\\y");
        assert_eq!(escape_like("plain"), "plain");
    }
}
