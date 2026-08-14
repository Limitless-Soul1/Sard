//! Library repositories — CRUD for books, shelves, highlights, notes, bookmarks, and
//! reading progress. RAWY-09 implements reading-progress persistence (CFI + fraction);
//! RAWY-15 adds the Library home reads (`list_books`, `collections_list`) + a dev seed.

#[cfg(test)]
mod wp3_tests; // RESILIENCE-1 / WP-3 — the database is the single source of a book's name

pub mod structure; // cases, categories and the hand order that sit on top of these tables

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
    /// RESILIENCE-1 / WP-3: per-field provenance JSON from the WP-2 compatibility layer, e.g.
    /// {"author":"default","title":"filename"}. Lets the UI present a GUESSED title as a guess
    /// instead of as the book's name. NULL for a row the backfill has not examined.
    pub meta_provenance: Option<String>,
    /// RESILIENCE-1 / WP-5A: the script SNIFFED from the book's own text at import ("arabic" /
    /// "latin"), never its declared language — WP-2 exists because declared metadata lies. The TTS
    /// pre-flight gates on this, so it must not gate on the field that was already wrong.
    pub script_detected: Option<String>,
    /// RESILIENCE-1 / WP-6: WP-2's structural flags, measured once at import and never re-derived.
    /// `toc_degenerate` = far too few TOC entries for the spine, so 6A synthesises contents.
    pub toc_degenerate: Option<i64>,
    /// `spine_fragmented` = many sections with a tiny median, so 6B defaults the book to scrolled
    /// flow (where arbitrary section breaks are invisible).
    pub spine_fragmented: Option<i64>,
    /// The imported file's size. The Spines view draws each book at its own thickness, and this
    /// is the only measure of a book's extent the library holds — there is no page count until a
    /// book has been opened and paginated at the reader's current type size.
    pub size_bytes: Option<i64>,
    /// Book Details' jacket controls, all stored the way `cover_fit` already is: as overrides with
    /// no extracted base, so clearing one returns the book to what Sard derives for it.
    /// `cover_paint` is a hex from the dialog's palette; NULL = the colour derived from the title.
    pub cover_paint: Option<String>,
    /// `"file"` = show the embedded image, `"typeset"` = show Sard's drawn jacket. NULL = use the
    /// embedded image when there is one.
    pub cover_mode: Option<String>,
    /// `"typeset"` | `"none"` — how the Spines view draws this book. NULL = typeset.
    pub spine_mode: Option<String>,
    /// A chosen spine image, resolved to an absolute path on the way out exactly as `cover_path`
    /// is. NULL = this book has none.
    pub spine_image: Option<String>,
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
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='cover_fit'), \
         b.meta_provenance, b.script_detected, b.toc_degenerate, b.spine_fragmented, b.size_bytes, \
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='cover_paint'), \
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='cover_mode'), \
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='spine_mode'), \
         (SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='spine_image')"
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
        meta_provenance: r.get(13)?,
        script_detected: r.get(14)?,
        toc_degenerate: r.get(15)?,
        spine_fragmented: r.get(16)?,
        size_bytes: r.get(17)?,
        cover_paint: r.get(18)?,
        cover_mode: r.get(19)?,
        spine_mode: r.get(20)?,
        spine_image: r.get(21)?,
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
    // RESILIENCE-1 / WP-3 — NORMALISE AT THE BOUNDARY, so stored and displayed cannot disagree.
    //
    // Found by measurement, not by reasoning: a real library held a title override ending in a
    // trailing space — typed, invisible, harmless-looking. Once WP-3 gave every
    // surface one resolver, that resolver trimmed for display — and the shown title stopped matching
    // the stored one, which is the exact class of divergence this package exists to remove. Trimming
    // HERE means surrounding whitespace never enters the database, so display, sort and the folded
    // search shadow all agree. Rows written before this keep their space until next edited; the
    // resolver still trims them for display, which is why both halves are needed.
    let v = v.trim();
    let base = base_field(conn, id, base_col)?;
    if v.is_empty() || base.as_deref() == Some(v) {
        clear_override(conn, id, field)
    } else {
        set_override(conn, id, field, v)
    }
}

/// RESILIENCE-1 / WP-3 — record metadata EXTRACTED FROM THE FILE, never as a user edit.
///
/// WHY THIS IS SEPARATE FROM `update_book`. `update_book` writes `metadata_overrides` — the table
/// that means "the reader said so". The PDF path was using it to store what PDF.js read out of the
/// file on first open, so an extraction was indistinguishable from a human decision and could
/// overwrite one. This writes the BASE columns instead, so `COALESCE(override, extracted)` keeps
/// any value the reader set winning, exactly as it does for EPUBs.
///
/// Only fills a base column that is EMPTY: an extraction never overwrites an earlier extraction
/// either, so re-running it cannot churn the row. `metadata_overrides` is never read or written.
pub fn set_extracted_metadata(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    author: Option<&str>,
) -> rusqlite::Result<Option<BookRow>> {
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        conn.execute(
            "UPDATE books SET title = ?2 WHERE id = ?1 AND (title IS NULL OR title = '')",
            rusqlite::params![id, t],
        )?;
    }
    if let Some(a) = author.map(str::trim).filter(|a| !a.is_empty()) {
        conn.execute(
            "UPDATE books SET author = ?2 WHERE id = ?1 AND (author IS NULL OR author = '')",
            rusqlite::params![id, a],
        )?;
    }
    // Keep the folded search shadows in step with the EFFECTIVE value, exactly as update_book does.
    conn.execute(
        "UPDATE books SET \
            title_fold  = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id=books.id AND field='title'),  title)), \
            author_fold = afold(COALESCE((SELECT value FROM metadata_overrides WHERE book_id=books.id AND field='author'), author)) \
         WHERE id = ?1",
        [id],
    )?;
    get_book(conn, id)
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
    cover_paint: Option<&str>,
    cover_mode: Option<&str>,
    spine_mode: Option<&str>,
) -> rusqlite::Result<Option<BookRow>> {
    apply_field(conn, id, "title", "title", title)?;
    apply_field(conn, id, "author", "author", author)?;
    apply_field(conn, id, "language", "language", language)?;
    apply_field(conn, id, "dir", "dir", dir)?;
    // These four have no extracted base — set when given, clear when given empty, leave alone when
    // absent. An empty string is therefore how a caller says "return this to Sard's own choice".
    for (field, value) in [
        ("cover_fit", cover_fit),
        ("cover_paint", cover_paint),
        ("cover_mode", cover_mode),
        ("spine_mode", spine_mode),
    ] {
        match value {
            Some(v) if !v.is_empty() => set_override(conn, id, field, v)?,
            Some(_) => clear_override(conn, id, field)?,
            None => {}
        }
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

// =================================================================================================
// CUSTOM COVERS
//
// Three concerns are kept deliberately separate here, because merging them is what caused the defect
// this replaced: CUSTODY (where the bytes live), IDENTITY (how one version is named) and DELIVERY
// (how the renderer gets them). The old code used a single string for all three — `{id}-custom.{ext}`
// was simultaneously the location, the name and the cache key — so replacing a .jpg with another
// .jpg produced a byte-identical URL and the WebView served its cached copy. MEASURED at the time:
//     bytes ON DISK 1000x1400 · page RENDERS 1284x1600 · cache-busted RENDERS 1000x1400
// The copy had always worked; only the URL was stale.
//
// IDENTITY IS NOW THE CONTENT. The name carries a hash of the bytes, so the reference changes if and
// only if the image changes — cache correctness is a property of the design rather than something
// every call site has to remember. Re-picking the same image is therefore a no-op, and two devices
// that choose the same cover derive the same name, which is what makes this safe to sync later.
//
// THE BYTES ARE STORED UNMODIFIED. No recompression, ever — the same guarantee `backgrounds` makes.
// Re-encoding would destroy quality and animation to buy a size bound that a regenerable derivative
// provides without either loss. If a thumbnail layer is ever added it is a CACHE, never authoritative.
//
// ⚠ IF A DERIVATIVE IS EVER GENERATED, IT MUST APPLY EXIF ORIENTATION AND HONOUR THE ICC PROFILE.
// The original relies on the rendering engine to do both, which it does; a naively decoded thumbnail
// would be rotated and colour-shifted relative to the cover it stands for. `backgrounds` already
// bakes orientation into its derivative for exactly this reason.
// =================================================================================================

/// The largest image accepted as a cover. Not a quality judgement — a guard against a pathological
/// input (a 200 MP camera original) becoming a permanent per-render decode cost. Generous enough
/// that no real cover is refused.
const MAX_COVER_BYTES: u64 = 64 * 1024 * 1024;

/// Where covers live, relative to the app-data root. Stored in this form rather than absolute so a
/// profile survives being restored under a different user, on a different platform, or on a phone
/// whose container path changes between installs.
const COVERS_REL: &str = "library/covers";

/// A staged cover, written to its final content-addressed name but NOT yet adopted.
#[derive(Serialize)]
pub struct StagedCover {
    /// App-data-relative path of the staged file.
    pub rel: String,
    /// `true` when Rust decoded it, so it is known-good and the caller may commit immediately.
    /// `false` means only that WE could not decode it — the caller must ask the renderer, which is
    /// the one validator whose answer means "this will display".
    pub verified: bool,
    /// The format Rust detected, for diagnostics. `None` when it could not decode.
    pub format: Option<String>,
}

/// Resolve a stored cover reference to an absolute path.
///
/// Accepts BOTH forms on purpose: rows written before this change hold an absolute path, and
/// rewriting them would be a migration over real user data to buy nothing. A legacy row keeps
/// working and heals itself the next time its cover is replaced.
pub fn resolve_cover(app_data_dir: &Path, stored: &str) -> String {
    let p = Path::new(stored);
    if p.is_absolute() {
        stored.to_string()
    } else {
        app_data_dir.join(p).to_string_lossy().into_owned()
    }
}

/// Apply `resolve_cover` to a row on its way out to the frontend, so the IPC contract stays
/// "absolute path" while storage is relative. The boundary converts; nothing downstream changes.
pub fn resolve_row_cover(app_data_dir: &Path, row: &mut BookRow) {
    if let Some(c) = row.cover_path.as_deref() {
        row.cover_path = Some(resolve_cover(app_data_dir, c));
    }
    // The spine image is stored and resolved by exactly the same rule.
    if let Some(s) = row.spine_image.as_deref() {
        row.spine_image = Some(resolve_cover(app_data_dir, s));
    }
}

/// Remove every custom cover of this book except `keep` — the file just written, or `None` to remove
/// all of them. Best-effort by design: an undeletable leftover is untidy, never broken, and must not
/// fail the replacement the reader asked for. This also collects files left by earlier naming
/// schemes, so covers/ converges on exactly one custom file per book without a migration.
fn sweep_custom_covers(covers: &Path, id: &str, keep: Option<&Path>) {
    sweep_managed(covers, id, "custom", keep)
}

/// The same sweep, for one KIND of managed image. Covers are `{id}-custom-…` and spines are
/// `{id}-spine-…`, so the two live in one directory and neither sweep can ever reach the other's
/// file — which is why a spine survives replacing a cover, and vice versa.
fn sweep_managed(dir: &Path, id: &str, kind: &str, keep: Option<&Path>) {
    let prefix = format!("{id}-{kind}");
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if keep == Some(p.as_path()) {
            continue;
        }
        if e.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// STAGE a replacement cover: validate what we can, write it under its content-addressed name, and
/// return without adopting it. Adoption is `commit_cover`; abandonment is `discard_cover`.
///
/// Two-stage on purpose. Deciding acceptance in Rust alone would mean maintaining a format allow-list
/// forever, and it would lag the renderer by construction — AVIF is a mainstream format Chromium
/// renders today that `image` cannot decode, so a Rust-only rule would refuse a file Sard can display
/// perfectly. Deciding it in the renderer alone is weaker in the other direction: browsers render a
/// truncated JPEG partially without complaining, while a decoder rejects it. So: decode here to catch
/// damage, and fall through to the renderer for anything we simply do not know — which needs no
/// allow-list and gains new formats for free as the engine does.
pub fn stage_cover(app_data_dir: &Path, id: &str, image_path: &str) -> Result<StagedCover, String> {
    stage_image(app_data_dir, id, image_path, "custom")
}

/// STAGE a spine image. Identical custody, validation and content-addressing to a cover — the
/// only difference is the name prefix, which is what keeps the two sweeps from ever meeting.
pub fn stage_spine(app_data_dir: &Path, id: &str, image_path: &str) -> Result<StagedCover, String> {
    stage_image(app_data_dir, id, image_path, "spine")
}

fn stage_image(app_data_dir: &Path, id: &str, image_path: &str, kind: &str) -> Result<StagedCover, String> {
    let meta = std::fs::metadata(image_path).map_err(|e| format!("Couldn't read that image: {e}"))?;
    if !meta.is_file() {
        return Err("That is not a file.".into());
    }
    if meta.len() == 0 {
        return Err("That file is empty.".into());
    }
    if meta.len() > MAX_COVER_BYTES {
        return Err(format!(
            "That image is {} MB. Covers are limited to {} MB.",
            meta.len() / (1024 * 1024),
            MAX_COVER_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(image_path).map_err(|e| format!("Couldn't read that image: {e}"))?;

    // ⚠ "DAMAGED" AND "UNKNOWN" ARE DIFFERENT ANSWERS AND MUST NOT BE COLLAPSED.
    //
    // Recognising the container but failing to decode it means the file is DAMAGED, and it is
    // refused here — a browser will happily paint the top half of a truncated JPEG and call it a
    // cover, which is exactly the silent failure this feature is supposed to end. Not recognising
    // the container at all means only that WE have no decoder; that is not a verdict, so the file
    // is staged and the renderer decides. Measured during validation: collapsing the two let a
    // 400-byte truncated JPEG through to the renderer instead of being named as damage.
    let decoded = match image::guess_format(&bytes) {
        Ok(fmt) => match image::load_from_memory(&bytes) {
            Ok(_) => Some(fmt),
            Err(e) => return Err(format!("That image is damaged and could not be read ({e}).")),
        },
        Err(_) => None, // unknown to us — ask the renderer, which may well display it (AVIF, SVG…)
    };
    let ext = match decoded {
        // The extension is NOT what types the response — MEASURED: Tauri's asset protocol sniffs the
        // bytes and returns image/jpeg even for a file with no extension or a lying one. It matters
        // for exactly one thing: TEXT-BASED formats. An SVG with no extension is served as text/html
        // and does not render, because browsers deliberately do not sniff SVG. So the extension is
        // kept for truthfulness and for that one case, not for binary correctness.
        Some(f) => f.extensions_str().first().unwrap_or(&"img").to_string(),
        None => Path::new(image_path)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| "img".into()),
    };

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    // 16 bytes, the same width `backgrounds` chose for its content ids — one convention for managed
    // images rather than two. Scoped to a single book that holds one custom cover at a time.
    let hash = format!("{:x}", hasher.finalize())[..32].to_string();

    let covers = app_data_dir.join(COVERS_REL);
    std::fs::create_dir_all(&covers).map_err(|e| e.to_string())?;
    let name = format!("{id}-{kind}-{hash}.{ext}");
    std::fs::write(covers.join(&name), &bytes).map_err(|e| format!("Couldn't save that image: {e}"))?;

    Ok(StagedCover {
        rel: format!("{COVERS_REL}/{name}"),
        verified: decoded.is_some(),
        format: decoded.map(|f| format!("{f:?}")),
    })
}

/// Adopt a staged cover. The extracted cover file is untouched, so revert still restores it.
pub fn commit_cover(conn: &Connection, app_data_dir: &Path, id: &str, rel: &str) -> Result<Option<BookRow>, String> {
    let covers = app_data_dir.join(COVERS_REL);
    let dest = app_data_dir.join(rel);
    if !dest.is_file() {
        return Err("That cover is no longer there.".into());
    }
    set_override(conn, id, "cover", rel).map_err(|e| e.to_string())?;
    // Only AFTER the new cover is recorded, and never the file just written.
    sweep_custom_covers(&covers, id, Some(dest.as_path()));
    get_book(conn, id).map_err(|e| e.to_string())
}

/// Adopt a staged spine image, and drop the book's previous one.
pub fn commit_spine(conn: &Connection, app_data_dir: &Path, id: &str, rel: &str) -> Result<Option<BookRow>, String> {
    let dir = app_data_dir.join(COVERS_REL);
    let dest = app_data_dir.join(rel);
    if !dest.is_file() {
        return Err("That spine image is no longer there.".into());
    }
    set_override(conn, id, "spine_image", rel).map_err(|e| e.to_string())?;
    sweep_managed(&dir, id, "spine", Some(dest.as_path()));
    get_book(conn, id).map_err(|e| e.to_string())
}

/// Remove a book's spine image entirely, returning it to whatever the spine mode derives.
pub fn clear_spine(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<Option<BookRow>, String> {
    clear_override(conn, id, "spine_image").map_err(|e| e.to_string())?;
    sweep_managed(&app_data_dir.join(COVERS_REL), id, "spine", None);
    get_book(conn, id).map_err(|e| e.to_string())
}

/// Abandon a staged cover the renderer refused. Nothing was adopted, so nothing else needs undoing.
pub fn discard_cover(app_data_dir: &Path, rel: &str) -> Result<(), String> {
    let p = app_data_dir.join(rel);
    if p.starts_with(app_data_dir.join(COVERS_REL)) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
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
pub fn revert_cover(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<Option<BookRow>, String> {
    // The stored value may be relative (written by this version) or absolute (written by an earlier
    // one), so it is resolved rather than used raw — otherwise revert would silently leave the file.
    if let Some(stored) = get_override(conn, id, "cover").map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(resolve_cover(app_data_dir, &stored)); // best-effort
    }
    clear_override(conn, id, "cover").map_err(|e| e.to_string())?;
    // Anything else this book left behind goes too, so reverting is a clean slate rather than a
    // partial one.
    sweep_custom_covers(&app_data_dir.join(COVERS_REL), id, None);
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
    // Resolved, because the stored reference is relative on rows written by this version and
    // absolute on older ones — removing it raw would leave the file behind for every new row.
    if let Some(c) = custom_cover {
        let _ = std::fs::remove_file(resolve_cover(app_data_dir, &c));
    }
    // And anything the book left behind under an earlier name, so deleting really does reach zero
    // orphans (D31) rather than zero-orphans-for-the-currently-referenced-file.
    sweep_custom_covers(&app_data_dir.join(COVERS_REL), id, None);
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
    // RAWY-283: NEWEST FIRST, matching `notes_for_book` and the cross-book `annotations_all`. The two
    // in-book tabs previously sorted OPPOSITE ways, which has no defensible reason.
    // ⚠ This list ALSO feeds the in-book overlay (`loadHighlights` iterates it and calls `addAnnotation`
    // per item, so array order IS paint order). The store therefore re-sorts a COPY chronologically
    // before handing it to the renderer — see `annotationsStore.load` — so which of two OVERLAPPING
    // marks paints on top is unchanged. Sorting here without that would have been a silent visual change.
    let mut stmt = conn.prepare(&format!(
        "SELECT {HL_COLS} FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC"
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
    /// RAWY-282: optional, independent of `body`. `None` = this note has no title, which is what every
    /// note written before migration 14 is — the list then renders exactly as it always did.
    pub title: Option<String>,
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
        title: r.get(9)?,
    })
}

// RAWY-282: `title` APPENDED, never inserted mid-list — every existing index in `note_row` keeps its
// position, so nothing that already read a column can read the wrong one.
const NOTE_COLS: &str =
    "id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at, title";

pub fn notes_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<NoteRow>> {
    // RAWY-282: NEWEST FIRST. This was `ORDER BY created_at` (ascending), which put the note just
    // written at the very BOTTOM of the panel — the opposite of every note-taking app, and of this
    // app's own cross-book Inbox, whose `annotations_all` has always ordered `created_at DESC`. The
    // two views disagreed; this makes the in-book list agree with the one that was already right.
    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTE_COLS} FROM notes WHERE book_id = ?1 ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([book_id], note_row)?;
    rows.collect()
}

fn get_note(conn: &Connection, id: &str) -> rusqlite::Result<Option<NoteRow>> {
    conn.query_row(&format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"), [id], note_row)
        .optional()
}

/// One note per highlight (or per standalone location) — idempotent on the anchor.
// RAWY-282: `title` made this the 8th parameter. Allowed rather than bundled into a struct, matching
// the `#[allow]` its own `#[tauri::command]` wrapper has carried since before this ticket — inventing a
// params struct for one added field would be a wider change than the feature.
#[allow(clippy::too_many_arguments)]
pub fn note_create(
    conn: &Connection,
    book_id: &str,
    highlight_id: Option<&str>,
    cfi: Option<&str>,
    color: Option<&str>,
    body: &str,
    chapter: Option<&str>,
    title: Option<&str>,
) -> rusqlite::Result<Option<NoteRow>> {
    let anchor = highlight_id.or(cfi).unwrap_or("");
    let id = gen_id(&format!("note:{book_id}:{anchor}"));
    let now = now_unix();
    conn.execute(
        "INSERT INTO notes(id, book_id, highlight_id, locator_cfi, color, body, chapter_label, created_at, updated_at, title) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9) \
         ON CONFLICT(id) DO UPDATE SET body=excluded.body, color=excluded.color, title=excluded.title, updated_at=excluded.updated_at",
        rusqlite::params![id, book_id, highlight_id, cfi, color, body, chapter, now, title],
    )?;
    get_note(conn, &id)
}

/// RAWY-282: `title` is `Option` and, unlike `color`, is written UNCONDITIONALLY rather than through
/// `COALESCE`. That is deliberate and is the only way "clear the title" can be expressed: with
/// `COALESCE` a `None` would mean "keep whatever is there", leaving a title the reader has just erased
/// permanently stuck on the note. `color` keeps its COALESCE because its callers legitimately mean
/// "update the text, leave the colour alone"; the title editor always sends the field it owns.
pub fn note_update(
    conn: &Connection,
    id: &str,
    body: &str,
    color: Option<&str>,
    title: Option<&str>,
) -> rusqlite::Result<Option<NoteRow>> {
    conn.execute(
        "UPDATE notes SET body = ?2, color = COALESCE(?3, color), title = ?4, updated_at = ?5 WHERE id = ?1",
        rusqlite::params![id, body, color, title, now_unix()],
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
    /// RAWY-282: the attached note's title, or `None`. Lets the cross-book Inbox render the same
    /// title/preview shape as the in-book list without a second query.
    pub note_title: Option<String>,
}

fn anno_item(r: &rusqlite::Row) -> rusqlite::Result<AnnoItem> {
    // GROUP_CONCAT joins the tag names with a newline (a tag name is a single-line string, so it never
    // contains one) — split back into a list; NULL (no tags) -> empty.
    let tag_str: Option<String> = r.get(13)?;
    // RAWY-282: column 14, APPENDED after the tags for the same reason RAWY-203 appended 12 and 13 —
    // every earlier index keeps its position, so no existing field can shift under a reader.
    let note_title: Option<String> = r.get(14)?;
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
        note_title,
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
            h.chapter_label, h.color, h.text_excerpt, n.body, h.start_cfi, h.created_at, n.id, {tags_sub}, n.title \
         FROM highlights h JOIN books b ON b.id = h.book_id \
         LEFT JOIN notes n ON n.highlight_id = h.id \
         UNION ALL \
         SELECT n.id, 'note', n.book_id, {OV_TITLE}, b.file_path, \
            COALESCE((SELECT value FROM metadata_overrides WHERE book_id=b.id AND field='dir'), b.dir), \
            n.chapter_label, n.color, n.body, NULL, n.locator_cfi, n.created_at, n.id, {tags_sub}, n.title \
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

// ---------------------------------------------------------------------------
// RAWY-260 — REFERENCES: a note bound to a PHRASE, per book (see 0012_references.sql).
// ---------------------------------------------------------------------------

/// One reference. `phrase` is what the reader selected (shown verbatim); `phrase_fold` is the folded
/// MATCHING key the frontend computes; `word_count` lets section matching skip the multi-token scan when
/// every reference in a book is a single word.
#[derive(Serialize)]
pub struct RefRow {
    pub id: String,
    pub book_id: String,
    pub phrase: String,
    pub phrase_fold: String,
    pub word_count: i64,
    pub note: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn ref_row(r: &rusqlite::Row) -> rusqlite::Result<RefRow> {
    Ok(RefRow {
        id: r.get(0)?,
        book_id: r.get(1)?,
        phrase: r.get(2)?,
        phrase_fold: r.get(3)?,
        word_count: r.get(4)?,
        note: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

const REF_COLS: &str = "id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at";

/// Every reference for one book — the whole set, loaded once when the book opens and then held in memory
/// for per-section matching. A book's references are counted in tens, not thousands, so this is one small
/// query per open rather than a lookup per section (let alone per word).
pub fn refs_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<RefRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {REF_COLS} FROM refs WHERE book_id = ?1 ORDER BY word_count DESC, created_at"
    ))?;
    let rows = stmt.query_map([book_id], ref_row)?;
    rows.collect()
}


/// Create or UPDATE the reference for a phrase in a book — one call serves both the create and the edit
/// flow, which is exactly how the dialog behaves (same dialog, note pre-filled when it already exists).
/// Idempotent per (book, folded phrase): referencing the same term twice edits the note instead of leaving
/// a second row that would mark the same words twice.
pub fn ref_save(
    conn: &Connection,
    book_id: &str,
    phrase: &str,
    phrase_fold: &str,
    word_count: i64,
    note: &str,
) -> rusqlite::Result<Option<RefRow>> {
    let id = gen_id(&format!("ref:{book_id}:{phrase_fold}"));
    let now = now_unix();
    conn.execute(
        "INSERT INTO refs(id, book_id, phrase, phrase_fold, word_count, note, created_at, updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?7) \
         ON CONFLICT(book_id, phrase_fold) DO UPDATE SET \
            phrase=excluded.phrase, word_count=excluded.word_count, note=excluded.note, \
            updated_at=excluded.updated_at",
        rusqlite::params![id, book_id, phrase, phrase_fold, word_count, note, now],
    )?;
    // The conflict target is (book_id, phrase_fold), not the id, so on an edit the row keeps its ORIGINAL
    // id — re-derive it from the unique key rather than assuming the id we just generated.
    conn.query_row(
        &format!("SELECT {REF_COLS} FROM refs WHERE book_id = ?1 AND phrase_fold = ?2"),
        rusqlite::params![book_id, phrase_fold],
        ref_row,
    )
    .optional()
}

/// Delete one reference. Its marks disappear from every occurrence in the book the moment the frontend
/// drops it from the match set — there is nothing in the document to clean up, because nothing was ever
/// written into it.
pub fn ref_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM refs WHERE id = ?1", [id])?;
    Ok(())
}

