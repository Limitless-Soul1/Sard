//! Books — real EPUB import (RAWY-17): detect → hash → dedup → copy-in → extract
//! metadata + cover → insert. Plus the original `ensure` FK-bridge from RAWY-09.
//!
//! Storage model (D16): imported files are COPIED into a managed location under the
//! app-data dir (`library/<id>.epub`, covers in `library/covers/<id>.<ext>`) and the
//! library references the managed copy — so it never depends on the user's original
//! path (which may move or be deleted). The id is the SHA-256 of the file bytes, which
//! also gives free de-duplication. EPUB and PDF are imported (PDF via the simpler `import_pdf`
//! branch — RAWY-85); other formats are rejected gracefully. Nothing in here panics on a bad file
//! — every failure becomes a per-file `ImportResult` so one broken book never sinks a multi-file drop.


pub mod compat;

// The corpus tests read a book corpus that is not distributed, so `corpus_tests.rs` exists only in
// the private workspace — it was dropped when the public tree was split out, while this declaration
// was left behind. `mod` cannot be made conditional on a file existing, so an unqualified
// declaration made `cargo test` fail to COMPILE in every tree that lacks the file: not one Rust test
// could run anywhere, including the 102 that have nothing to do with the corpus.
//
// A feature gate is used rather than deleting the line, because the two trees share this file
// byte-for-byte; deleting it here would diverge them and the breakage would return on the next sync.
// The workspace that has the corpus runs them with `--features corpus-tests`.
#[cfg(all(test, feature = "corpus-tests"))]
mod corpus_tests;
#[cfg(test)]
mod wp2_tests;
use std::io::{Cursor, Read, Seek};
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

/// RAWY-80 (audit #7): collect every `.epub`/`.pdf` under `dir` (recursively, depth-capped, symlinks
/// skipped to stay loop-safe), sorted into a stable, human-legible import order.
/// RAWY-176 (AUD-5): PDFs are collected too, so a folder import matches drag-drop instead of silently
/// skipping them. An empty folder simply yields an empty list.
fn collect_from_dir(dir: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    collect_books(Path::new(dir), 0, &mut paths);
    paths.sort();
    paths
}

/// "Import a folder" — collect, then run every book through the exact same pipeline as a multi-file
/// pick (dedup, magic-byte format check, managed copy).
pub fn import_folder(conn: &Connection, app_data_dir: &Path, dir: &str) -> Vec<ImportResult> {
    import_books(conn, app_data_dir, &collect_from_dir(dir))
}

/// Recurse `dir` collecting `.epub`/`.pdf` file paths (RAWY-176/AUD-5: PDFs are collected too, so a
/// folder import behaves like drag-drop rather than silently skipping them). `read_dir`'s
/// `file_type()` does NOT follow symlinks, so skipping symlinked entries keeps the walk free of
/// cycles; depth is capped as a backstop against pathological trees. The magic-byte check in
/// `import_one` still has final say — the extension only decides what to hand to the pipeline.
fn collect_books(dir: &Path, depth: u32, out: &mut Vec<String>) {
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
            collect_books(&path, depth + 1, out);
        } else if ft.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("epub") || e.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
        {
            if let Some(s) = path.to_str() {
                out.push(s.to_string());
            }
        }
    }
}

/// RAWY-85 (PDF Phase 0, "view as-is"): a PDF has no EPUB OPF, so this is a simpler branch —
/// content-hash dedup, copy to managed storage as `<id>.pdf`, and store `format='pdf'` with the
/// filename as a placeholder title. The real title/author (PDF.js `getMetadata`) and a page-1 cover
/// (`getCover`) are enriched from the reader the first time the PDF is opened. `dir` is NULL (a PDF
/// has no spine page-progression); the reader offers a manual RTL override for Arabic PDFs.
fn import_pdf(conn: &Connection, app_data_dir: &Path, name: &str, bytes: &[u8]) -> ImportResult {
    let id = hex_sha256(bytes);
    if let Ok(Some(existing)) = book_title(conn, &id) {
        return ImportResult::of("duplicate", &id, &existing, Some("Already in your library".into()));
    }
    let title = name.to_string();
    let library_dir = app_data_dir.join("library");
    if let Err(e) = std::fs::create_dir_all(library_dir.join("covers")) {
        return ImportResult::of("error", &id, &title, Some(format!("Storage error: {e}")));
    }
    let managed = library_dir.join(format!("{id}.pdf"));
    if let Err(e) = std::fs::write(&managed, bytes) {
        return ImportResult::of("error", &id, &title, Some(format!("Couldn't store the file: {e}")));
    }
    let size = bytes.len() as i64;
    let res = conn.execute(
        // RAWY-178 (AUD-12): title_fold via afold() so the library search folds Arabic consistently.
        "INSERT INTO books(id, file_path, file_hash, format, title, author, language, dir, \
                           cover_path, size_bytes, added_at, last_opened_at, title_fold, author_fold) \
         VALUES(?1,?2,?3,'pdf',?4,NULL,NULL,NULL,NULL,?5,?6,NULL, afold(?4), NULL)",
        rusqlite::params![id, managed.to_string_lossy(), id, title, size, now_unix()],
    );
    match res {
        Ok(_) => ImportResult::of("imported", &id, &title, None),
        Err(e) => ImportResult::of("error", &id, &title, Some(format!("Database error: {e}"))),
    }
}

fn import_one(conn: &Connection, app_data_dir: &Path, src: &str) -> ImportResult {
    let name = file_stem(src);
    let bytes = match std::fs::read(src) {
        Ok(b) => b,
        Err(e) => return ImportResult::of("error", "", &name, Some(format!("Couldn't read file: {e}"))),
    };

    // Format detection by CONTENT (magic bytes), not the extension.
    // RAWY-85: PDFs are accepted (Phase 0 "view as-is") via a simpler branch — no EPUB OPF.
    if bytes.starts_with(b"%PDF") {
        return import_pdf(conn, app_data_dir, &name, &bytes);
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        // RAWY-176/AUD-5: EPUB + PDF are the honestly-supported formats, so a MOBI (or anything
        // that's neither a %PDF nor a ZIP) reports both — not "Not an EPUB file".
        return ImportResult::of("unsupported", "", &name, Some("Not an EPUB or PDF file".into()));
    }
    let mut zip = match zip::ZipArchive::new(Cursor::new(bytes.as_slice())) {
        Ok(z) => z,
        Err(_) => return ImportResult::of("unsupported", "", &name, Some("Not a valid EPUB (bad ZIP)".into())),
    };
    // A real EPUB declares its media type in a `mimetype` entry.
    //
    // WP-2A: `mimetype_ok` is BOM- and case-tolerant. The old `trim() != "…"` refused any file whose
    // mimetype carried a UTF-8 BOM, because Rust's `trim` does not strip U+FEFF (White_Space=No —
    // verified by compiling the check). That rejected otherwise-valid books at the door.
    //
    // A MISSING mimetype is no longer fatal either: if `container.xml` and a parsable OPF are both
    // present, the file is an EPUB whatever its packaging says. The entry is required by the
    // specification, but refusing a readable book over it serves nobody.
    let mimetype = read_entry_string(&mut zip, "mimetype").unwrap_or_default();
    let meta_probe = if compat::mimetype_ok(&mimetype) { None } else { parse_epub(&mut zip) };
    if !compat::mimetype_ok(&mimetype) && meta_probe.is_none() {
        return ImportResult::of("unsupported", "", &name, Some("Not an EPUB (missing epub mimetype)".into()));
    }

    // Stable content-hash id → free de-duplication.
    let id = hex_sha256(&bytes);
    if let Ok(Some(existing)) = book_title(conn, &id) {
        return ImportResult::of("duplicate", &id, &existing, Some("Already in your library".into()));
    }

    // Parse the OPF for title/author/language/direction/cover (all best-effort).
    let meta = meta_probe.or_else(|| parse_epub(&mut zip)).unwrap_or_default();

    // RESILIENCE-1 / WP-2C — the placeholder-aware metadata ladder.
    //
    // The old code accepted ANY non-empty `dc:title`, which is how a tester's library ended up
    // showing a book called "Unknown": Calibre writes that literal string when the source document
    // carried no title, and "not empty" cannot tell a placeholder from a name. The ladder is
    // dc:title → the book's own first heading → the filename → nothing, with EVERY rung rejecting
    // placeholders as well as blanks. The final rung is `None`, and the caller (here) supplies the
    // filename rather than a UI string, so the database never holds a localised default.
    let mut provenance: std::collections::BTreeMap<&'static str, compat::Provenance> = Default::default();
    let heading = if meta.title.as_deref().is_some_and(|t| compat::is_placeholder_title(t, meta.identifier.as_deref()))
        || meta.title.is_none()
    {
        // Only read content documents when the declared title is actually unusable — a good book
        // must not pay for a recovery it does not need.
        first_content_heading(&mut zip, &meta)
    } else {
        None
    };
    let (resolved_title, title_prov) = compat::resolve_title(
        meta.title.as_deref(),
        heading.as_deref(),
        &name,
        meta.identifier.as_deref(),
    );
    // `name` (the filename stem) is the last honest fallback; `file_stem` already yields "Untitled"
    // for a pathological path, so this can never store an empty title.
    let title = resolved_title.unwrap_or_else(|| name.clone());
    provenance.insert("title", title_prov);

    // WP-2C: the author fallback is now NULL, not the literal string "Unknown". Writing "Unknown"
    // made "the FILE said Unknown" indistinguishable from "Sard gave up" — and both states exist in
    // the real corpus. A NULL is honest; the UI renders "Unknown author" as chrome.
    let (author, author_prov) = compat::resolve_author(meta.author.as_deref());
    provenance.insert("author", author_prov);

    // RAWY-189: metadata can lie — an Arabic-script book may declare `en` (or no language) with no spine
    // page-progression, which would store `ltr` and open the book left-to-right. When the metadata gives
    // no reliable RTL signal, sniff the content; a predominantly Arabic-script body is stored `dir='rtl'`
    // so it reads/pages/speaks like any Arabic book (`dir` is the operational pivot — AUDIT-LANG). The
    // language field is left as the file declared it, except a *missing* one is filled with `ar` since we
    // just proved the script; the user can still edit both.
    let mut language = meta.language.clone().filter(|s| !s.trim().is_empty());
    let declared_language = language.is_some();
    let flip = should_flip_to_rtl(&mut zip, &meta);
    let dir = if flip { "rtl".to_string() } else { book_direction(&meta.ppd, language.as_deref()) };
    if flip && language.is_none() {
        language = Some("ar".to_string());
    }
    provenance.insert("language", if declared_language { compat::Provenance::Declared } else if language.is_some() { compat::Provenance::Inferred } else { compat::Provenance::Default });
    provenance.insert("dir", if flip { compat::Provenance::Inferred } else { compat::Provenance::Declared });

    // WP-2D: record what the CONTENT is, alongside what the file CLAIMS. `books.language` keeps the
    // declaration (a user may have reasons for it, and RAWY-189 deliberately preserves it); this is
    // the second, independent fact, and it is what a future per-language feature should key off —
    // `language` is untrustworthy, which is why RAWY-189 exists at all.
    // The `||` short-circuits, so the content sample is only taken when the cheap signals say
    // nothing — the same work the previous nested form did, without the duplicated arm.
    let script_detected = if flip || dir == "rtl" || detect_arabic_script(&mut zip, &meta.spine_docs) {
        Some("arabic")
    } else {
        Some("latin")
    };

    // WP-2E: the two structural facts, computed once here and stored, so the reader never re-derives
    // them per open. `None` (unknown) is preserved when the book declares no TOC document at all —
    // that is a different state from "declares one and it is nearly empty".
    let toc_degenerate = count_toc_entries(&mut zip, &meta)
        .map(|entries| compat::toc_degenerate(entries, meta.spine_docs.len()));
    let spine_fragmented = compat::spine_fragmented(&spine_section_sizes(&mut zip, &meta));
    let producer = meta.producer.clone();

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
        // RAWY-178 (AUD-12): title_fold/author_fold via afold() so the library search folds Arabic
        // consistently with the in-book search (كتاب ⇒ كِتاب, أحمد ⇔ احمد).
        // RESILIENCE-1 / WP-2: five additive columns (migration 15). Every pre-existing column is
        // written exactly as before, so a well-formed book's row is byte-identical to v1.1.0.
        "INSERT INTO books(id, file_path, file_hash, format, title, author, language, dir, \
                           cover_path, size_bytes, added_at, last_opened_at, title_fold, author_fold, \
                           producer, script_detected, toc_degenerate, spine_fragmented, meta_provenance) \
         VALUES(?1,?2,?3,'epub',?4,?5,?6,?7,?8,?9,?10,NULL, afold(?4), afold(?5), ?11,?12,?13,?14,?15)",
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
            producer,
            script_detected,
            toc_degenerate.map(|b| b as i64),
            spine_fragmented as i64,
            compat::provenance_json(&provenance),
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
    spine_docs: Vec<String>,        // RAWY-189: content-document zip paths, in reading order
    // ---- RESILIENCE-1 / WP-2 ----
    /// `dc:identifier` — so a title that is merely the book's own id is recognised as a placeholder.
    identifier: Option<String>,
    /// `dc:contributor[role=bkp]` / a Calibre meta stamp. Conditions every recovery rule.
    producer: Option<String>,
    /// The nav document's zip path (manifest `properties="nav"`), when the book is EPUB 3.
    nav_path: Option<String>,
    /// The NCX's zip path (spine `toc=` → manifest item, else any `.ncx`), when EPUB 2.
    ncx_path: Option<String>,
}

fn parse_epub<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Option<EpubMeta> {
    let container = read_entry_string(zip, "META-INF/container.xml")?;
    let opf_path = find_opf_path(&container)?;
    let opf = read_entry_string(zip, &opf_path)?;
    let opf_dir = parent_dir(&opf_path);
    let mut m = parse_opf(&opf, &opf_dir);
    // WP-2B: the producer is read from the RAW OPF text (a namespaced attribute quick-xml would
    // otherwise make us hunt for), because it conditions every other recovery rule.
    m.producer = compat::detect_producer(&opf);
    Some(m)
}

/// WP-2E: how many entries the table of contents actually offers.
///
/// Follows the SAME order foliate does at render time (nav document first, then NCX —
/// `epub.js:1001-1016`), so "degenerate" here means what it will mean on screen. Returns `None`
/// when the book declares no TOC document at all, which is a different fact from "declares one and
/// it is nearly empty" — only the latter is worth recovering from.
fn count_toc_entries<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, meta: &EpubMeta) -> Option<usize> {
    if let Some(p) = meta.nav_path.as_deref() {
        if let Some(s) = read_entry_string(zip, p) {
            return Some(compat::count_toc_entries(&s, false));
        }
    }
    if let Some(p) = meta.ncx_path.as_deref() {
        if let Some(s) = read_entry_string(zip, p) {
            return Some(compat::count_toc_entries(&s, true));
        }
    }
    None
}

/// WP-2E: the UNCOMPRESSED size of each linear content document, read from the zip's central
/// directory. No decompression — this costs nothing even on a 1,433-section book.
fn spine_section_sizes<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, meta: &EpubMeta) -> Vec<u64> {
    meta.spine_docs
        .iter()
        .filter_map(|p| zip.by_name(p).ok().map(|f| f.size()))
        .collect()
}

/// WP-2C rung 2: the book's own first heading, from the earliest linear content document that has
/// one. Bounded to the first few documents — a title lives at the front or nowhere.
fn first_content_heading<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, meta: &EpubMeta) -> Option<String> {
    for path in meta.spine_docs.iter().take(3) {
        if let Some(html) = read_entry_string(zip, path) {
            if let Some(h) = compat::first_heading(&html) {
                return Some(h);
            }
        }
    }
    None
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
    // spine itemrefs in reading order: (idref, linear) — RAWY-189 (content-script detection).
    let mut spine_refs: Vec<(String, String)> = Vec::new();
    let mut cur: Option<&'static str> = None;

    // WP-2E: the spine's `toc="…"` idref, resolved against the manifest after the walk.
    let mut spine_toc_idref: Option<String> = None;

    let mut r = quick_xml::Reader::from_str(opf_xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => {
                match e.local_name().as_ref() {
                    b"title" => cur = Some("title"),
                    b"creator" => cur = Some("creator"),
                    b"language" => cur = Some("language"),
                    b"identifier" => cur = Some("identifier"), // WP-2C: a title equal to this is a placeholder
                    b"spine" => {
                        m.ppd = attr(&e, b"page-progression-direction");
                        spine_toc_idref = attr(&e, b"toc");
                    }
                    b"itemref" => spine_refs.push((
                        attr(&e, b"idref").unwrap_or_default(),
                        attr(&e, b"linear").unwrap_or_default(),
                    )),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"spine" => {
                    m.ppd = attr(&e, b"page-progression-direction");
                    spine_toc_idref = attr(&e, b"toc");
                }
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
                b"itemref" => spine_refs.push((
                    attr(&e, b"idref").unwrap_or_default(),
                    attr(&e, b"linear").unwrap_or_default(),
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
                                "identifier" if m.identifier.is_none() => m.identifier = Some(s),
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

    // WP-2E: resolve the TOC documents the way the FORMAT defines them, never by filename.
    // Guessing at `nav.xhtml` / `*.ncx` mis-read three real corpus books — two as "no TOC at all"
    // and one with double-counted entries — which would have flagged good books as degenerate.
    m.nav_path = items
        .iter()
        .find(|(_, _, _, props)| props.split_whitespace().any(|p| p == "nav"))
        .filter(|(_, href, _, _)| !href.is_empty())
        .map(|(_, href, _, _)| zip_join(opf_dir, &percent_decode(href)));
    m.ncx_path = spine_toc_idref
        .as_ref()
        .and_then(|idref| items.iter().find(|(id, _, _, _)| id == idref))
        .or_else(|| items.iter().find(|(_, _, media, _)| media == "application/x-dtbncx+xml"))
        .filter(|(_, href, _, _)| !href.is_empty())
        .map(|(_, href, _, _)| zip_join(opf_dir, &percent_decode(href)));

    // RAWY-189: resolve the spine into ordered content-document zip paths for content sniffing.
    // Skip `linear="no"` refs — that's how covers / nav / other non-linear matter are marked — and
    // keep only (X)HTML content docs, so a Latin cover or nav page can't skew the script sample.
    for (idref, linear) in &spine_refs {
        if linear.eq_ignore_ascii_case("no") {
            continue;
        }
        if let Some((_, href, media, _)) = items.iter().find(|(id, _, _, _)| id == idref) {
            if href.is_empty() {
                continue;
            }
            let ml = media.to_ascii_lowercase();
            let hl = href.to_ascii_lowercase();
            let is_doc = ml.contains("html")
                || hl.ends_with(".xhtml")
                || hl.ends_with(".html")
                || hl.ends_with(".htm");
            if is_doc {
                m.spine_docs.push(zip_join(opf_dir, &percent_decode(href)));
            }
        }
    }
    m
}

fn extract_cover<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
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

/// Read one zip entry as text, TOLERANTLY.
///
/// RESILIENCE-1 / WP-2A: this used `read_to_string`, which returns `Err` on any non-UTF-8 byte —
/// and that error path was silently catastrophic. `parse_epub` returned `None`, so a book with a
/// `windows-1256` OPF (still common in older Arabic EPUBs) lost its title, author, language AND
/// cover, and — because the spine could not be read — its RTL detection too, importing an Arabic
/// book as `dir='ltr'`. `compat::decode_xml` never fails; at worst it falls back to latin-1, which
/// still recovers the ASCII structure everything else depends on.
fn read_entry_string<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(compat::decode_xml(&buf).text)
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

// ---------------------------------------------------------------------------
// RAWY-189: content-script direction detection
//
// The metadata (`dc:language`, spine `page-progression-direction`) is trusted first; when it gives
// no RTL signal, we sample the actual body text and flip an Arabic-script book to `dir='rtl'`. `dir`
// is the operational pivot (layout, paging, TTS voice + segmenter, typography) — AUDIT-LANG. The same
// `detect_arabic_script`/`should_flip_to_rtl` runs both at import and in the one-time backfill.
// ---------------------------------------------------------------------------

const AR_SAMPLES: usize = 6; // documents sampled across the spine
const AR_SCAN_CAP: usize = 50_000; // stop after this many arabic+latin letters total
const AR_PERDOC_CAP: usize = 40_000; // cap stripped chars scanned per document
const AR_MIN: usize = 200; // absolute floor of arabic letters before a flip is allowed
const AR_PCT: usize = 60; // arabic must be >= this % of (arabic+latin) letters

/// An Arabic-script *letter* (Arabic, Supplement, Extended-A, Presentation Forms A/B). `is_alphabetic`
/// excludes Arabic-Indic digits and Arabic punctuation, so only real letters count.
fn is_arabic_letter(c: char) -> bool {
    c.is_alphabetic()
        && matches!(c as u32,
            0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

/// Sample indices spread across the spine (~15/29/43/57/72/86 %), never doc 0 for a real book — front
/// matter (cover/title/copyright/TOC) clusters at the start and the colophon at the end, so a middle
/// spread + summing keeps a Latin cover or a stray English chapter from skewing the script sample.
fn spread_indices(n: usize) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    if n <= AR_SAMPLES {
        return (0..n).collect();
    }
    let mut idx = Vec::new();
    for i in 1..=AR_SAMPLES {
        let j = (n * i / (AR_SAMPLES + 1)).min(n - 1);
        if !idx.contains(&j) {
            idx.push(j);
        }
    }
    idx
}

/// Strip HTML markup (tags plus the bodies of `<style>`/`<script>`) so only visible text is counted.
/// Bounded: stops after `cap` kept chars. Only the leading tag name is inspected (enough for style/script).
fn strip_markup(s: &str, cap: usize) -> String {
    let mut out = String::new();
    let mut kept = 0usize;
    let mut in_tag = false;
    let mut in_skip = false;
    let mut tag = String::new();
    for c in s.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
                let closing = tag.starts_with('/');
                let name: String = tag
                    .trim_start_matches('/')
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .map(|c| c.to_ascii_lowercase())
                    .collect();
                if name == "style" || name == "script" {
                    in_skip = !closing;
                }
                tag.clear();
            } else if tag.len() < 32 {
                tag.push(c);
            }
        } else if c == '<' {
            in_tag = true;
            tag.clear();
        } else if !in_skip {
            out.push(c);
            kept += 1;
            if kept >= cap {
                break;
            }
        }
    }
    out
}

/// Sum Arabic-letter vs Latin-letter (ASCII alpha) counts across the sampled spine documents.
fn sample_script_counts<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, spine_docs: &[String]) -> (usize, usize) {
    let mut arabic = 0usize;
    let mut latin = 0usize;
    for &i in &spread_indices(spine_docs.len()) {
        let Some(raw) = read_entry_string(zip, &spine_docs[i]) else {
            continue;
        };
        for c in strip_markup(&raw, AR_PERDOC_CAP).chars() {
            if is_arabic_letter(c) {
                arabic += 1;
            } else if c.is_ascii_alphabetic() {
                latin += 1;
            }
        }
        if arabic + latin >= AR_SCAN_CAP {
            break;
        }
    }
    (arabic, latin)
}

/// True iff the sampled content is *predominantly* Arabic script: a minimum absolute amount AND a clear
/// majority of letters — so an English book that merely quotes Arabic is never flipped.
fn detect_arabic_script<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, spine_docs: &[String]) -> bool {
    let (arabic, latin) = sample_script_counts(zip, spine_docs);
    arabic >= AR_MIN && arabic * 100 >= (arabic + latin) * AR_PCT
}

/// Shared trigger for both import and backfill: flip to RTL only when the metadata gives no RTL signal
/// (no explicit spine direction of any value, and no RTL `dc:language`) AND the content is Arabic. An
/// explicit `page-progression-direction` (either value) or an RTL language always wins over content.
fn should_flip_to_rtl<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, meta: &EpubMeta) -> bool {
    meta.ppd.is_none()
        && book_direction(&meta.ppd, meta.language.as_deref()) == "ltr"
        && detect_arabic_script(zip, &meta.spine_docs)
}

/// Backfill helper: re-derive whether one already-imported EPUB should read RTL. Best-effort — a
/// missing/unreadable file or unparseable OPF returns `false` (skip the row), so startup never fails.
/// Opens the file *seekably* (BufReader, not a whole-file read) so only the zip central directory and
/// the handful of sampled chapters are read — keeping the one-time backfill cheap on large books.
fn content_says_rtl(app_data_dir: &Path, id: &str) -> bool {
    let path = app_data_dir.join("library").join(format!("{id}.epub"));
    let Ok(file) = std::fs::File::open(&path) else {
        return false;
    };
    let Ok(mut zip) = zip::ZipArchive::new(std::io::BufReader::new(file)) else {
        return false;
    };
    let Some(meta) = parse_epub(&mut zip) else {
        return false;
    };
    should_flip_to_rtl(&mut zip, &meta)
}

/// RAWY-189 backfill (schema migration 8). Correct the BASE `books.dir` for already-imported EPUBs whose
/// metadata mis-declared direction (Arabic content tagged `en`/untagged, no spine ppd). Guards:
///   * only `format='epub' AND dir='ltr'` rows — never PDFs, never already-`rtl` rows;
///   * `metadata_overrides` is NEVER touched, so an explicit user direction keeps winning via COALESCE;
///   * a missing/unreadable EPUB is skipped silently (best-effort) — the app launches even if the whole
///     `library/` folder is gone (then it simply flips nothing);
///   * the UPDATE is scoped `dir='ltr'`, so re-running is a no-op — idempotent independent of the marker.
/// Returns how many rows were flipped. `reading_progress`/`settings`/other tables are untouched.
pub fn backfill_arabic_dir(conn: &Connection, app_data_dir: &Path) -> rusqlite::Result<usize> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM books WHERE format = 'epub' AND dir = 'ltr'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let tx = conn.unchecked_transaction()?;
    let mut flipped = 0usize;
    for id in &ids {
        if content_says_rtl(app_data_dir, id) {
            tx.execute(
                "UPDATE books SET dir = 'rtl' WHERE id = ?1 AND format = 'epub' AND dir = 'ltr'",
                [id],
            )?;
            flipped += 1;
        }
    }
    tx.commit()?;
    Ok(flipped)
}

// ---------------------------------------------------------------------------
// RESILIENCE-1 / WP-2H — the compatibility backfill (migration 16)
// ---------------------------------------------------------------------------

/// What a re-examination of one already-imported EPUB learned.
struct Recovered {
    producer: Option<String>,
    script: Option<&'static str>,
    toc_degenerate: Option<bool>,
    spine_fragmented: bool,
    /// `Some` only when the STORED title is a placeholder and a better one was found.
    better_title: Option<(String, compat::Provenance)>,
    /// `true` when the stored title is a placeholder that could NOT be improved.
    ///
    /// This is a real and unavoidable state for a book imported before WP-2: Sard stores every book
    /// as `library/<id>.epub`, so the ORIGINAL filename — rung 3 of the ladder, and the rung that
    /// rescues the reported book on a fresh import — no longer exists. The backfill refuses to
    /// invent one, and records the fact instead so the UI can present the title as the placeholder
    /// it is rather than as the book's name.
    title_still_placeholder: bool,
    /// `true` when the stored author is a placeholder that should become NULL.
    author_is_placeholder: bool,
}

/// Re-open one managed EPUB and re-derive the WP-2 facts. Best-effort: any failure yields `None`
/// and the row is skipped, so a missing or corrupt file can never fail the backfill.
fn recover_one(app_data_dir: &Path, id: &str, stored_title: &str, stored_author: Option<&str>, filename_stem: &str) -> Option<Recovered> {
    let path = app_data_dir.join("library").join(format!("{id}.epub"));
    let file = std::fs::File::open(&path).ok()?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).ok()?;
    let meta = parse_epub(&mut zip)?;

    let stored_is_placeholder = compat::is_placeholder_title(stored_title, meta.identifier.as_deref());
    let better_title = if stored_is_placeholder {
        let heading = first_content_heading(&mut zip, &meta);
        // The DECLARED title is deliberately not offered again: it is what produced the stored
        // placeholder in the first place.
        let (t, p) = compat::resolve_title(None, heading.as_deref(), filename_stem, meta.identifier.as_deref());
        t.map(|t| (t, p))
    } else {
        None
    };

    let flip = should_flip_to_rtl(&mut zip, &meta);
    let script = if flip || detect_arabic_script(&mut zip, &meta.spine_docs) { "arabic" } else { "latin" };

    Some(Recovered {
        producer: meta.producer.clone(),
        script: Some(script),
        toc_degenerate: count_toc_entries(&mut zip, &meta)
            .map(|entries| compat::toc_degenerate(entries, meta.spine_docs.len())),
        spine_fragmented: compat::spine_fragmented(&spine_section_sizes(&mut zip, &meta)),
        title_still_placeholder: stored_is_placeholder && better_title.is_none(),
        better_title,
        author_is_placeholder: stored_author.is_some_and(compat::is_placeholder_author),
    })
}

/// Migration 16 — fill the WP-2 columns for books imported before this shipped, and correct the
/// metadata that made a tester's library show a book called "Unknown".
///
/// Guards, following the RAWY-189 precedent (`backfill_arabic_dir`) exactly:
///   * only `format='epub'` rows, and only those not yet examined (`script_detected IS NULL`), so a
///     re-run is a true no-op — idempotent independently of the migration marker;
///   * **`metadata_overrides` is NEVER touched**, so a title the user set keeps winning via COALESCE;
///   * a title is replaced ONLY when the stored one is a recognised placeholder AND something better
///     was found — a real title is never overwritten, whatever else changes;
///   * a missing / unreadable / corrupt book is skipped silently, so the app launches even if the
///     whole `library/` folder is gone.
///
/// Returns `(examined, titles_corrected)`.
pub fn backfill_compat(conn: &Connection, app_data_dir: &Path) -> rusqlite::Result<(usize, usize)> {
    let rows: Vec<(String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(title,''), author, COALESCE(file_path,'') FROM books \
             WHERE format = 'epub' AND script_detected IS NULL",
        )?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        it.filter_map(|r| r.ok()).collect()
    };

    let tx = conn.unchecked_transaction()?;
    let mut examined = 0usize;
    let mut retitled = 0usize;
    for (id, title, author, file_path) in &rows {
        // The managed copy is named `<id>.epub`, so the ORIGINAL filename is long gone. The stored
        // title is the best stand-in for it — and when that title is itself a placeholder, the
        // ladder simply falls through to `None` and nothing is changed. Honest either way.
        let stem = file_stem(file_path);
        let stem = if stem == *id { title.clone() } else { stem };
        let Some(rec) = recover_one(app_data_dir, id, title, author.as_deref(), &stem) else {
            continue; // unreadable → leave every column NULL so a later run retries it
        };
        examined += 1;

        tx.execute(
            "UPDATE books SET producer = ?2, script_detected = ?3, toc_degenerate = ?4, spine_fragmented = ?5 \
             WHERE id = ?1 AND format = 'epub'",
            rusqlite::params![
                id,
                rec.producer,
                rec.script,
                rec.toc_degenerate.map(|b| b as i64),
                rec.spine_fragmented as i64
            ],
        )?;

        // Provenance is recorded for EVERY examined book, not only the corrected ones. A book whose
        // placeholder title could not be improved is precisely the case the UI most needs to know
        // about — leaving it NULL would make "we checked and this really is a placeholder"
        // indistinguishable from "never examined".
        let mut prov_map: std::collections::BTreeMap<&'static str, compat::Provenance> = Default::default();
        prov_map.insert(
            "title",
            match (&rec.better_title, rec.title_still_placeholder) {
                (Some((_, p)), _) => *p,
                (None, true) => compat::Provenance::Default,
                (None, false) => compat::Provenance::Declared,
            },
        );
        prov_map.insert(
            "author",
            if rec.author_is_placeholder || author.is_none() {
                compat::Provenance::Default
            } else {
                compat::Provenance::Declared
            },
        );
        tx.execute(
            "UPDATE books SET meta_provenance = ?2 WHERE id = ?1",
            rusqlite::params![id, compat::provenance_json(&prov_map)],
        )?;

        if let Some((better, _)) = rec.better_title {
            tx.execute(
                "UPDATE books SET title = ?2, title_fold = afold(?2) WHERE id = ?1",
                rusqlite::params![id, better],
            )?;
            retitled += 1;
        }
        if rec.author_is_placeholder {
            // Sard's own old fallback wrote 'Unknown' here. Clearing it restores the distinction
            // between "the file said so" and "nothing was known".
            tx.execute(
                "UPDATE books SET author = NULL, author_fold = NULL WHERE id = ?1",
                rusqlite::params![id],
            )?;
        }
    }
    tx.commit()?;
    Ok((examined, retitled))
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

    // RAWY-80 (#7) / RAWY-176 (AUD-5): the folder walk recurses, matches `.epub` AND `.pdf`
    // case-insensitively, and skips everything else. (The rest of `import_folder` is just handing
    // these paths to the already-proven `import_books`.)
    #[test]
    fn collect_books_recurses_and_filters() {
        let base = std::env::temp_dir().join("sard_rawy176_collect_books");
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(base.join("a.epub"), b"x").unwrap();
        std::fs::write(base.join("B.EPUB"), b"x").unwrap(); // case-insensitive extension
        std::fs::write(base.join("d.pdf"), b"x").unwrap(); // RAWY-176: PDFs collected too
        std::fs::write(base.join("E.PDF"), b"x").unwrap(); // case-insensitive extension
        std::fs::write(base.join("notes.txt"), b"x").unwrap(); // not a book → skipped
        std::fs::write(base.join("cover.jpg"), b"x").unwrap(); // not a book → skipped
        std::fs::write(nested.join("c.epub"), b"x").unwrap(); // in a subfolder → recursion
        std::fs::write(nested.join("f.pdf"), b"x").unwrap(); // PDF in a subfolder → recursion

        let mut out = Vec::new();
        collect_books(&base, 0, &mut out);
        out.sort();

        assert_eq!(out.len(), 6, "expected exactly 6 .epub/.pdf files, got {out:?}");
        assert!(out.iter().any(|p| p.ends_with("a.epub")));
        assert!(out.iter().any(|p| p.to_lowercase().ends_with("b.epub")));
        assert!(out.iter().any(|p| p.ends_with("d.pdf")));
        assert!(out.iter().any(|p| p.to_lowercase().ends_with("e.pdf")));
        assert!(
            out.iter().any(|p| p.ends_with("c.epub")) && out.iter().any(|p| p.ends_with("f.pdf")),
            "must recurse into subfolders for both formats"
        );
        assert!(
            !out.iter().any(|p| p.ends_with(".txt") || p.ends_with(".jpg")),
            "must skip non-book files"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- RAWY-189: content-script direction detection -----------------------

    use std::io::Write as _;

    /// Build a minimal in-memory EPUB. `docs` = (id, href, body, linear-attr). An empty linear string
    /// omits the attribute. Returns the zip bytes (a real `application/epub+zip`).
    fn build_epub(docs: &[(&str, &str, &str, &str)], lang: Option<&str>, ppd: Option<&str>) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let w = Cursor::new(&mut buf);
            let mut zw = zip::ZipWriter::new(w);
            let stored = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("mimetype", stored).unwrap();
            zw.write_all(b"application/epub+zip").unwrap();
            zw.start_file("META-INF/container.xml", opts).unwrap();
            zw.write_all(br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
            for (_, href, body, _) in docs {
                zw.start_file(*href, opts).unwrap();
                zw.write_all(format!("<html><body><p>{body}</p></body></html>").as_bytes()).unwrap();
            }
            let manifest: String = docs.iter().map(|(id, href, _, _)| {
                format!(r#"<item id="{id}" href="{href}" media-type="application/xhtml+xml"/>"#)
            }).collect();
            let spine: String = docs.iter().map(|(id, _, _, lin)| {
                if lin.is_empty() { format!(r#"<itemref idref="{id}"/>"#) }
                else { format!(r#"<itemref idref="{id}" linear="{lin}"/>"#) }
            }).collect();
            let langtag = lang.map(|l| format!("<dc:language>{l}</dc:language>")).unwrap_or_default();
            let spineattr = ppd.map(|p| format!(r#" page-progression-direction="{p}""#)).unwrap_or_default();
            let opf = format!(
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>{langtag}</metadata><manifest>{manifest}</manifest><spine{spineattr}>{spine}</spine></package>"#
            );
            zw.start_file("content.opf", opts).unwrap();
            zw.write_all(opf.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    const AR: &str = "السلام عليكم ورحمة الله وبركاته هذا نص عربي طويل يكفي لتجاوز الحد الأدنى للكشف ";
    const EN: &str = "The quick brown fox jumps over the lazy dog and keeps on running all day long ";

    fn ar_body(reps: usize) -> String { AR.repeat(reps) }
    fn en_body(reps: usize) -> String { EN.repeat(reps) }

    fn flips(bytes: &[u8]) -> bool {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let meta = parse_epub(&mut zip).unwrap();
        should_flip_to_rtl(&mut zip, &meta)
    }

    // The spread never samples doc 0, so a heavy-Latin cover at the front can't suppress an Arabic body.
    #[test]
    fn spread_skips_front_matter() {
        assert_eq!(spread_indices(3), vec![0, 1, 2], "few docs → sample all");
        let big = spread_indices(1433);
        assert_eq!(big.len(), 6);
        assert!(!big.contains(&0), "must never sample doc 0 for a real book");
        assert!(big.iter().all(|&i| i < 1433));
    }

    #[test]
    fn arabic_letters_and_markup() {
        assert!(is_arabic_letter('ع'));
        assert!(!is_arabic_letter('٧'), "Arabic-Indic digit is not a letter");
        assert!(!is_arabic_letter('،'), "Arabic comma is punctuation, not a letter");
        assert!(!is_arabic_letter('a'));
        let t = strip_markup("<style>.a{color:red}</style><p class=\"x\">مرحبا</p><script>var a=1</script>", 1000);
        assert!(t.contains("مرحبا"));
        assert!(!t.contains("color") && !t.contains("var"), "style/script bodies stripped");
    }

    // A predominantly-Arabic body flips even behind a big Latin cover; genuine English never flips;
    // an explicit spine direction (either value) and an RTL language both win over content.
    #[test]
    fn detection_flips_only_real_arabic() {
        // 20 docs: doc0 a heavy Latin cover (linear defaulted), docs 1..19 Arabic. lang="en", no ppd.
        let mut docs: Vec<(String, String, String, String)> = Vec::new();
        docs.push(("c0".into(), "cover.xhtml".into(), en_body(40), String::new()));
        for i in 1..20 {
            docs.push((format!("c{i}"), format!("ch{i}.xhtml"), ar_body(8), String::new()));
        }
        let refs: Vec<(&str, &str, &str, &str)> =
            docs.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();
        assert!(flips(&build_epub(&refs, Some("en"), None)), "Arabic body behind a Latin cover must flip");

        // All-English → never flip.
        let eng: Vec<(String, String, String, String)> = (0..8)
            .map(|i| (format!("e{i}"), format!("e{i}.xhtml"), en_body(2), String::new()))
            .collect();
        let eng_refs: Vec<(&str, &str, &str, &str)> =
            eng.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();
        assert!(!flips(&build_epub(&eng_refs, Some("en"), None)), "genuine English must not flip");

        // Explicit ppd (even ltr) wins over content.
        assert!(!flips(&build_epub(&refs, Some("en"), Some("ltr"))), "explicit ppd=ltr is respected");
        // An RTL language already yields rtl → should_flip is false (nothing to add).
        assert!(!flips(&build_epub(&refs, Some("ar"), None)), "declared ar needs no content flip");
    }

    // The backfill flips ONLY ltr epub rows that sniff Arabic, leaves a user dir override untouched
    // (COALESCE still wins), never touches PDFs or genuine-English rows, and is idempotent.
    #[test]
    fn backfill_guards_and_idempotence() {
        let base = std::env::temp_dir().join("sard_rawy189_backfill");
        let _ = std::fs::remove_dir_all(&base);
        let lib = base.join("library");
        std::fs::create_dir_all(&lib).unwrap();

        // Arabic body, tagged en, no ppd → a real mis-tag. Two copies: one plain, one with an override.
        let ar_docs: Vec<(String, String, String, String)> = (0..10)
            .map(|i| (format!("a{i}"), format!("a{i}.xhtml"), ar_body(8), String::new()))
            .collect();
        let ar_refs: Vec<(&str, &str, &str, &str)> =
            ar_docs.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();
        let ar_bytes = build_epub(&ar_refs, Some("en"), None);
        let en_docs: Vec<(String, String, String, String)> = (0..10)
            .map(|i| (format!("e{i}"), format!("e{i}.xhtml"), en_body(2), String::new()))
            .collect();
        let en_refs: Vec<(&str, &str, &str, &str)> =
            en_docs.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();
        let en_bytes = build_epub(&en_refs, Some("en"), None);
        std::fs::write(lib.join("mis.epub"), &ar_bytes).unwrap(); // mis-tagged, no override → flips
        std::fs::write(lib.join("ovr.epub"), &ar_bytes).unwrap(); // mis-tagged, has override → base flips
        std::fs::write(lib.join("eng.epub"), &en_bytes).unwrap(); // genuine English → stays
        // "rtl" and "pdf" rows have no file needed (filtered out before any read).

        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap(); // SQL schema only
        let ins = |id: &str, fmt: &str, lang: &str, dir: Option<&str>| {
            conn.execute(
                "INSERT INTO books(id, file_path, format, title, language, dir, added_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, 0)",
                rusqlite::params![id, format!("{id}.{fmt}"), fmt, id, lang, dir],
            )
            .unwrap();
        };
        ins("mis", "epub", "en", Some("ltr"));
        ins("ovr", "epub", "en", Some("ltr"));
        ins("eng", "epub", "en", Some("ltr"));
        ins("art", "epub", "ar", Some("rtl")); // already rtl → never reconsidered
        ins("pdf", "pdf", "", None); // pdf → out of scope
        conn.execute(
            "INSERT INTO metadata_overrides(book_id, field, value) VALUES('ovr','dir','rtl')",
            [],
        )
        .unwrap();

        let flipped = backfill_arabic_dir(&conn, &base).unwrap();
        assert_eq!(flipped, 2, "only the two mis-tagged Arabic epub rows flip");

        let dir = |id: &str| -> Option<String> {
            conn.query_row("SELECT dir FROM books WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(dir("mis").as_deref(), Some("rtl"), "mis-tagged base corrected");
        assert_eq!(dir("ovr").as_deref(), Some("rtl"), "override row base corrected too");
        assert_eq!(dir("eng").as_deref(), Some("ltr"), "genuine English untouched");
        assert_eq!(dir("art").as_deref(), Some("rtl"), "already-rtl untouched");
        assert_eq!(dir("pdf"), None, "pdf dir stays NULL");

        // The user override survives byte-for-byte (never touched).
        let ov: String = conn
            .query_row("SELECT value FROM metadata_overrides WHERE book_id='ovr' AND field='dir'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ov, "rtl", "metadata_overrides row preserved");

        // Idempotent: a second run flips nothing.
        assert_eq!(backfill_arabic_dir(&conn, &base).unwrap(), 0, "re-run is a no-op");

        // Missing library folder → safe no-op (app must launch even if every file is gone).
        std::fs::remove_dir_all(&lib).unwrap();
        conn.execute("UPDATE books SET dir='ltr' WHERE id='mis'", []).unwrap(); // pretend un-flipped
        assert_eq!(backfill_arabic_dir(&conn, &base).unwrap(), 0, "missing files → flips nothing, no error");

        let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok");
        let _ = std::fs::remove_dir_all(&base);
    }

    // PART A end-to-end through the real `import_books` entrypoint: a mis-tagged Arabic EPUB is stored
    // `dir='rtl'` at import; a declared `en` is preserved but a *missing* language is filled with `ar`;
    // a genuine English book stays `ltr`.
    #[test]
    fn import_tags_mistagged_arabic_rtl() {
        let base = std::env::temp_dir().join("sard_rawy189_import");
        let _ = std::fs::remove_dir_all(&base);
        let app = base.join("appdata");
        let src = base.join("src");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&src).unwrap();

        let ar_docs: Vec<(String, String, String, String)> = (0..10)
            .map(|i| (format!("a{i}"), format!("a{i}.xhtml"), ar_body(8), String::new()))
            .collect();
        let ar_refs: Vec<(&str, &str, &str, &str)> =
            ar_docs.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();
        let en_docs: Vec<(String, String, String, String)> = (0..10)
            .map(|i| (format!("e{i}"), format!("e{i}.xhtml"), en_body(2), String::new()))
            .collect();
        let en_refs: Vec<(&str, &str, &str, &str)> =
            en_docs.iter().map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str())).collect();

        let write = |name: &str, bytes: &[u8]| -> String {
            let p = src.join(name);
            std::fs::write(&p, bytes).unwrap();
            p.to_string_lossy().into_owned()
        };
        let p_en_ar = write("mistagged_en.epub", &build_epub(&ar_refs, Some("en"), None)); // arabic body, lang en
        let p_none = write("mistagged_none.epub", &build_epub(&ar_refs, None, None)); // arabic body, no lang
        let p_eng = write("english.epub", &build_epub(&en_refs, Some("en"), None)); // genuine english

        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let res = import_books(&conn, &app, &[p_en_ar, p_none, p_eng]);
        assert!(res.iter().all(|r| r.status == "imported"), "all three import: {:?}",
            res.iter().map(|r| (&r.title, &r.status)).collect::<Vec<_>>());

        let row = |id: &str| -> (Option<String>, Option<String>) {
            conn.query_row("SELECT dir, language FROM books WHERE id=?1", [id],
                |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        let (d0, l0) = row(&res[0].id);
        assert_eq!(d0.as_deref(), Some("rtl"), "mis-tagged Arabic (lang=en) stored rtl at import");
        assert_eq!(l0.as_deref(), Some("en"), "declared en is preserved, not overwritten");
        let (d1, l1) = row(&res[1].id);
        assert_eq!(d1.as_deref(), Some("rtl"), "mis-tagged Arabic (no lang) stored rtl at import");
        assert_eq!(l1.as_deref(), Some("ar"), "a missing language is filled with ar");
        let (d2, _l2) = row(&res[2].id);
        assert_eq!(d2.as_deref(), Some("ltr"), "genuine English stays ltr");

        let _ = std::fs::remove_dir_all(&base);
    }
}
