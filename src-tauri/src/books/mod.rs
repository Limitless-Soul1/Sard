//! Books — real EPUB import (RAWY-17): detect → hash → dedup → copy-in → extract
//! metadata + cover → insert. Plus the original `ensure` FK-bridge from RAWY-09.
//!
//! Storage model (D16): imported files are COPIED into a managed location under the
//! app-data dir (`library/<id>.epub`, covers in `library/covers/<id>.<ext>`) and the
//! library references the managed copy — so it never depends on the user's original
//! path (which may move or be deleted). The id is the SHA-256 of the file bytes, which
//! also gives free de-duplication. EPUB only for now; other formats are rejected
//! gracefully (no PDF here). Nothing in here panics on a bad file — every failure becomes
//! a per-file `ImportResult` so one broken book never sinks a multi-file drop.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Insert a minimal `books` row if one doesn't already exist (FK bridge for progress).
pub fn ensure(conn: &Connection, id: &str, file_path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO books(id, file_path, added_at) VALUES(?1, ?2, ?3)",
        rusqlite::params![id, file_path, now_unix()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Import (RAWY-17)
// ---------------------------------------------------------------------------

/// One per dropped/selected file. `status` ∈ imported | duplicate | unsupported | error.
#[derive(Serialize)]
pub struct ImportResult {
    pub id: String,
    pub title: String,
    pub status: String,
    pub message: Option<String>,
}

impl ImportResult {
    fn of(status: &str, id: &str, title: &str, message: Option<String>) -> Self {
        ImportResult { id: id.into(), title: title.into(), status: status.into(), message }
    }
}

/// Import a batch; never fails as a whole — each file gets its own result.
pub fn import_books(conn: &Connection, app_data_dir: &Path, paths: &[String]) -> Vec<ImportResult> {
    paths.iter().map(|p| import_one(conn, app_data_dir, p)).collect()
}

/// RAWY-80 (audit #7): "Import a folder" for real — collect every `.epub` under `dir`
/// (recursively, depth-capped, symlinks skipped to stay loop-safe) and run them through the
/// exact same pipeline as a multi-file pick (dedup, magic-byte format check, managed copy).
/// An empty folder simply yields an empty result list.
pub fn import_folder(conn: &Connection, app_data_dir: &Path, dir: &str) -> Vec<ImportResult> {
    let mut paths: Vec<String> = Vec::new();
    collect_epubs(Path::new(dir), 0, &mut paths);
    paths.sort(); // stable, human-legible import order
    import_books(conn, app_data_dir, &paths)
}

/// Recurse `dir` collecting `.epub` file paths. `read_dir`'s `file_type()` does NOT follow
/// symlinks, so skipping symlinked entries keeps the walk free of cycles; depth is capped as a
/// backstop against pathological trees.
fn collect_epubs(dir: &Path, depth: u32, out: &mut Vec<String>) {
    if depth > 16 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir → just contribute nothing
    };
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            collect_epubs(&path, depth + 1, out);
        } else if ft.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("epub"))
                .unwrap_or(false)
        {
            if let Some(s) = path.to_str() {
                out.push(s.to_string());
            }
        }
    }
}

fn import_one(conn: &Connection, app_data_dir: &Path, src: &str) -> ImportResult {
    let name = file_stem(src);
    let bytes = match std::fs::read(src) {
        Ok(b) => b,
        Err(e) => return ImportResult::of("error", "", &name, Some(format!("Couldn't read file: {e}"))),
    };

    // Format detection by CONTENT (magic bytes), not the extension.
    if bytes.starts_with(b"%PDF") {
        return ImportResult::of("unsupported", "", &name, Some("PDF support is coming".into()));
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return ImportResult::of("unsupported", "", &name, Some("Not an EPUB file".into()));
    }
    let mut zip = match zip::ZipArchive::new(Cursor::new(bytes.as_slice())) {
        Ok(z) => z,
        Err(_) => return ImportResult::of("unsupported", "", &name, Some("Not a valid EPUB (bad ZIP)".into())),
    };
    // A real EPUB declares its media type in an uncompressed `mimetype` entry.
    let mimetype = read_entry_string(&mut zip, "mimetype").unwrap_or_default();
    if mimetype.trim() != "application/epub+zip" {
        return ImportResult::of("unsupported", "", &name, Some("Not an EPUB (missing epub mimetype)".into()));
    }

    // Stable content-hash id → free de-duplication.
    let id = hex_sha256(&bytes);
    if let Ok(Some(existing)) = book_title(conn, &id) {
        return ImportResult::of("duplicate", &id, &existing, Some("Already in your library".into()));
    }

    // Parse the OPF for title/author/language/direction/cover (all best-effort).
    let meta = parse_epub(&mut zip).unwrap_or_default();
    let title = meta.title.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| name.clone());
    let author = meta.author.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Unknown".into());
    let language = meta.language.clone().filter(|s| !s.trim().is_empty());
    let dir = book_direction(&meta.ppd, language.as_deref());

    // Copy into managed storage; the library references this copy, not the source.
    let library_dir = app_data_dir.join("library");
    let covers_dir = library_dir.join("covers");
    if let Err(e) = std::fs::create_dir_all(&covers_dir) {
        return ImportResult::of("error", &id, &title, Some(format!("Storage error: {e}")));
    }
    let managed = library_dir.join(format!("{id}.epub"));
    if let Err(e) = std::fs::write(&managed, &bytes) {
        return ImportResult::of("error", &id, &title, Some(format!("Couldn't store the file: {e}")));
    }

    // Extract the cover image if present; otherwise the UI draws its auto-cover.
    let cover_path = extract_cover(&mut zip, &meta, &covers_dir, &id);

    let size = bytes.len() as i64;
    let res = conn.execute(
        "INSERT INTO books(id, file_path, file_hash, format, title, author, language, dir, \
                           cover_path, size_bytes, added_at, last_opened_at) \
         VALUES(?1,?2,?3,'epub',?4,?5,?6,?7,?8,?9,?10,NULL)",
        rusqlite::params![
            id,
            managed.to_string_lossy(),
            id,
            title,
            author,
            language,
            dir,
            cover_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            size,
            now_unix(),
        ],
    );
    match res {
        Ok(_) => ImportResult::of("imported", &id, &title, None),
        Err(e) => ImportResult::of("error", &id, &title, Some(format!("Database error: {e}"))),
    }
}

fn book_title(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT COALESCE(title, id) FROM books WHERE id = ?1", [id], |r| r.get(0))
        .optional()
}

// ---- EPUB parsing (container.xml → OPF) -----------------------------------

#[derive(Default)]
struct EpubMeta {
    title: Option<String>,
    author: Option<String>,
    language: Option<String>,
    ppd: Option<String>,            // spine page-progression-direction
    cover_path_in_zip: Option<String>,
    cover_media: Option<String>,
}

fn parse_epub(zip: &mut zip::ZipArchive<Cursor<&[u8]>>) -> Option<EpubMeta> {
    let container = read_entry_string(zip, "META-INF/container.xml")?;
    let opf_path = find_opf_path(&container)?;
    let opf = read_entry_string(zip, &opf_path)?;
    let opf_dir = parent_dir(&opf_path);
    Some(parse_opf(&opf, &opf_dir))
}

fn find_opf_path(container_xml: &str) -> Option<String> {
    let mut r = quick_xml::Reader::from_str(container_xml);
    loop {
        match r.read_event() {
            Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e)) => {
                if e.local_name().as_ref() == b"rootfile" {
                    if let Some(p) = attr(&e, b"full-path") {
                        return Some(p);
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_opf(opf_xml: &str, opf_dir: &str) -> EpubMeta {
    use quick_xml::events::Event;
    let mut m = EpubMeta::default();
    let mut cover_meta_id: Option<String> = None;
    // manifest items: id -> (href, media-type, properties)
    let mut items: Vec<(String, String, String, String)> = Vec::new();
    let mut cur: Option<&'static str> = None;

    let mut r = quick_xml::Reader::from_str(opf_xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => {
                match e.local_name().as_ref() {
                    b"title" => cur = Some("title"),
                    b"creator" => cur = Some("creator"),
                    b"language" => cur = Some("language"),
                    b"spine" => m.ppd = attr(&e, b"page-progression-direction"),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"spine" => m.ppd = attr(&e, b"page-progression-direction"),
                b"meta" => {
                    if attr(&e, b"name").as_deref() == Some("cover") {
                        cover_meta_id = attr(&e, b"content");
                    }
                }
                b"item" => items.push((
                    attr(&e, b"id").unwrap_or_default(),
                    attr(&e, b"href").unwrap_or_default(),
                    attr(&e, b"media-type").unwrap_or_default(),
                    attr(&e, b"properties").unwrap_or_default(),
                )),
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if let Some(field) = cur {
                    if let Ok(s) = t.unescape() {
                        let s = s.trim().to_string();
                        if !s.is_empty() {
                            match field {
                                "title" if m.title.is_none() => m.title = Some(s),
                                "creator" if m.author.is_none() => m.author = Some(s),
                                "language" if m.language.is_none() => m.language = Some(s),
                                _ => {}
                            }
                        }
                    }
                }
            }
            Ok(Event::End(_)) => cur = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    // Resolve cover: EPUB3 properties="cover-image" wins, else the EPUB2 cover meta id.
    let chosen = items
        .iter()
        .find(|(_, _, _, props)| props.split_whitespace().any(|p| p == "cover-image"))
        .or_else(|| {
            cover_meta_id
                .as_ref()
                .and_then(|cid| items.iter().find(|(id, _, _, _)| id == cid))
        });
    if let Some((_, href, media, _)) = chosen {
        if !href.is_empty() {
            m.cover_path_in_zip = Some(zip_join(opf_dir, &percent_decode(href)));
            m.cover_media = Some(media.clone());
        }
    }
    m
}

fn extract_cover(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    meta: &EpubMeta,
    covers_dir: &Path,
    id: &str,
) -> Option<PathBuf> {
    let zip_path = meta.cover_path_in_zip.as_ref()?;
    let mut data = Vec::new();
    zip.by_name(zip_path).ok()?.read_to_end(&mut data).ok()?;
    if data.is_empty() {
        return None;
    }
    let ext = cover_ext(meta.cover_media.as_deref(), zip_path);
    let out = covers_dir.join(format!("{id}.{ext}"));
    std::fs::write(&out, &data).ok()?;
    Some(out)
}

// ---- small helpers --------------------------------------------------------

fn read_entry_string(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == key)
        .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into())
}

/// RTL if the spine says so, or the language is an RTL script; otherwise LTR.
fn book_direction(ppd: &Option<String>, language: Option<&str>) -> String {
    if ppd.as_deref() == Some("rtl") {
        return "rtl".into();
    }
    let rtl_lang = language
        .map(|l| l.to_ascii_lowercase())
        .map(|l| ["ar", "fa", "he", "ur", "ps", "sd"].iter().any(|p| l.starts_with(p)))
        .unwrap_or(false);
    if rtl_lang { "rtl".into() } else { "ltr".into() }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..=i].to_string(), // keep trailing slash
        None => String::new(),
    }
}

/// Join a zip-internal base dir + relative href, resolving `.`/`..` segments.
fn zip_join(base_dir: &str, href: &str) -> String {
    let combined = format!("{base_dir}{href}");
    let mut out: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cover_ext(media: Option<&str>, href: &str) -> String {
    match media {
        Some("image/jpeg") => "jpg".into(),
        Some("image/png") => "png".into(),
        Some("image/gif") => "gif".into(),
        Some("image/webp") => "webp".into(),
        Some("image/svg+xml") => "svg".into(),
        _ => Path::new(href)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| "jpg".into()),
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RAWY-80 (#7): the folder walk recurses, matches `.epub` case-insensitively, and skips
    // everything else. (The rest of `import_folder` is just handing these paths to the already-
    // proven `import_books`.)
    #[test]
    fn collect_epubs_recurses_and_filters() {
        let base = std::env::temp_dir().join("sard_rawy80_collect_epubs");
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(base.join("a.epub"), b"x").unwrap();
        std::fs::write(base.join("B.EPUB"), b"x").unwrap(); // case-insensitive extension
        std::fs::write(base.join("notes.txt"), b"x").unwrap(); // not an epub → skipped
        std::fs::write(base.join("cover.jpg"), b"x").unwrap(); // not an epub → skipped
        std::fs::write(nested.join("c.epub"), b"x").unwrap(); // in a subfolder → recursion

        let mut out = Vec::new();
        collect_epubs(&base, 0, &mut out);
        out.sort();

        assert_eq!(out.len(), 3, "expected exactly 3 .epub files, got {out:?}");
        assert!(out.iter().any(|p| p.ends_with("a.epub")));
        assert!(out.iter().any(|p| p.to_lowercase().ends_with("b.epub")));
        assert!(
            out.iter().any(|p| p.ends_with("c.epub")),
            "must recurse into subfolders"
        );
        assert!(
            !out.iter().any(|p| p.ends_with(".txt") || p.ends_with(".jpg")),
            "must skip non-epub files"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
