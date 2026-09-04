//! Reading deposits — one book, one reader's marks on it, and a letter, in a single file.
//!
//! A deposit is a zip whose only required member is `deposit.json`, the same promise the profile
//! package makes: a reader who unzips one finds something legible rather than a blob. This module
//! owns the SENDER's half — what can travel, priced, and the writing of the file.
//!
//! # Why the plan is made here rather than in the sheet
//!
//! The share sheet has to name each layer, price the deposit and draw a map of where the marks fall,
//! and every one of those needs a managed path or a parsed spine the frontend has no business
//! holding. Resolving them in one place means the sheet renders exactly what `export` will write,
//! rather than a second picture of the same thing that can disagree with it — the lesson
//! `profile_asset_plan` already learned.
//!
//! # What this module does NOT do
//!
//! It does not resolve, validate or repair a single CFI. Measured over five real books: resolving a
//! stored CFI against the RAW section document fails for range CFIs that are perfectly valid in the
//! document they were made against (2 of 12), because a highlight's CFI is recorded against the
//! RENDERED document. Sard stores CFIs and resolves them at render time, and a deposit does the same:
//! it carries them verbatim and lets the receiver's reader resolve them exactly as the sender's did.

pub mod apply;
pub mod package;
pub mod placement;

#[cfg(test)]
mod apply_tests;
#[cfg(test)]
mod placement_tests;

use std::path::Path;

use rusqlite::Connection;

use crate::{books, library};

/// Where a mark falls in the book, as far as its stored CFI can say.
///
/// `section_index` is deliberately optional. A minority of stored highlights carry a SPINE-ONLY cfi
/// (`epubcfi(/6/14)`, no indirection step), which names a document but no position inside it, and a
/// deposit must carry those rather than drop them — they still have their text.
#[derive(serde::Serialize)]
pub struct MarkSection {
    pub kind: String,
    pub id: String,
    pub section: Option<String>,
    pub section_index: Option<u32>,
}

#[derive(serde::Serialize, Default)]
pub struct Counts {
    pub highlights: u32,
    pub notes: u32,
    pub references: u32,
    pub replacements: u32,
}

/// The book, as a deposit needs to describe it. `hash` is `books.id`, which IS the sha-256 of the
/// file's bytes — so identity, integrity and de-duplication are one value, not three.
#[derive(serde::Serialize)]
pub struct PlanBook {
    pub hash: String,
    pub format: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub dir: Option<String>,
    pub size_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct Plan {
    pub book: PlanBook,
    /// Sections in the spine. `None` when the file could not be parsed — the sheet then offers the
    /// deposit without a map instead of refusing to open.
    pub spine_count: Option<u32>,
    pub book_bytes: u64,
    pub cover_bytes: u64,
    /// Managed paths, resolved here so the sheet never holds one. `export` is handed these back.
    pub book_source: Option<String>,
    pub cover_source: Option<String>,
    /// The member names those sources will occupy, computed once so the manifest the sheet writes and
    /// the archive `export` writes cannot disagree about where a file lives.
    pub book_member: Option<String>,
    pub cover_member: Option<String>,
    pub sections: Vec<MarkSection>,
    pub counts: Counts,
}

/// The spine step of a foliate CFI: the part before `!`, with any `[assertion]` stripped.
///
/// The same rule as `cfiSection.ts`, which is the frontend's one copy of it. Two CFIs in the same
/// chapter share this string exactly.
fn cfi_section(cfi: &str) -> Option<String> {
    let t = cfi.trim();
    let inner = t
        .strip_prefix("epubcfi(")
        .and_then(|r| r.strip_suffix(')'))
        .unwrap_or(t);
    let spine = inner.split('!').next().unwrap_or("");
    let mut out = String::with_capacity(spine.len());
    let mut depth = 0usize;
    for ch in spine.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The ordinal of a spine step among the book's sections.
///
/// SPINE ITEM `i` IS CHILD STEP `2i + 2`. Verified against the engine's own section CFIs over 1444
/// sections in five books, with no disagreement. It is a convention rather than a guarantee, so the
/// arithmetic is bounds-checked against the real spine length and anything outside it is reported as
/// sectionless — a mark with no place is drawn nowhere, never at a guessed one.
fn section_index(step: &str, spine_count: Option<u32>) -> Option<u32> {
    let last: String = step
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let n: u32 = last.parse().ok()?;
    if n < 2 || n % 2 != 0 {
        return None;
    }
    let idx = (n - 2) / 2;
    match spine_count {
        Some(total) if idx >= total => None,
        _ => Some(idx),
    }
}

fn file_len(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// What can travel with this book, priced, and where every mark falls.
pub fn plan(conn: &Connection, app_data_dir: &Path, book_id: &str) -> Result<Plan, String> {
    let mut book = library::get_book(conn, book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "dep.err.noBook".to_string())?;

    // THE COVER THE READER IS ACTUALLY LOOKING AT.
    //
    // `book_select` already coalesces the reader's `cover` override over the extracted one, so the row
    // names the right image — but it names it the way it is STORED, and a cover the reader chose is
    // stored app-data-relative while an extracted one is absolute. Without this the relative path was
    // tested for existence against the process's own directory, found missing, and the deposit went
    // out with NO cover at all — silently, and only for the books whose covers had been replaced.
    //
    // `resolve_row_cover` is the same conversion the IPC boundary applies on the way to the frontend,
    // which is what makes this the shared source of truth rather than a second cover rule.
    library::resolve_row_cover(app_data_dir, &mut book);

    // PDFs are out of scope for this feature: they carry no CFI and no whole-book text search, so
    // there is no honest way to make their highlights portable. Refused here rather than half-served.
    if book.format.as_deref() != Some("epub") {
        return Err("dep.err.notEpub".into());
    }

    let book_bytes = file_len(&book.file_path);
    let spine_count = books::spine_count(Path::new(&book.file_path)).map(|n| n as u32);

    let cover_source = book
        .cover_path
        .as_ref()
        .filter(|p| Path::new(p.as_str()).is_file())
        .cloned();
    let cover_bytes = cover_source.as_deref().map(file_len).unwrap_or(0);

    let ext = Path::new(&book.file_path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "epub".into());
    let cover_ext = cover_source
        .as_deref()
        .and_then(|p| Path::new(p).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_else(|| "jpg".into());

    let highlights = library::highlights_for_book(conn, book_id).map_err(|e| e.to_string())?;
    let notes = library::notes_for_book(conn, book_id).map_err(|e| e.to_string())?;
    let refs = library::refs_for_book(conn, book_id).map_err(|e| e.to_string())?;
    let reps = library::reps_for_book(conn, book_id).map_err(|e| e.to_string())?;

    let mut sections: Vec<MarkSection> = Vec::with_capacity(highlights.len() + notes.len());
    for h in &highlights {
        let sec = cfi_section(&h.cfi);
        sections.push(MarkSection {
            kind: "highlight".into(),
            id: h.id.clone(),
            section_index: sec.as_deref().and_then(|s| section_index(s, spine_count)),
            section: sec,
        });
    }
    for n in &notes {
        let sec = n.cfi.as_deref().and_then(cfi_section);
        sections.push(MarkSection {
            kind: "note".into(),
            id: n.id.clone(),
            section_index: sec.as_deref().and_then(|s| section_index(s, spine_count)),
            section: sec,
        });
    }

    Ok(Plan {
        book: PlanBook {
            hash: book.id.clone(),
            format: book.format.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            language: book.language.clone(),
            dir: book.dir.clone(),
            size_bytes: book_bytes,
        },
        spine_count,
        book_bytes,
        cover_bytes,
        book_member: Some(format!("{}{}.{}", package::BOOK_DIR, book.id, ext)),
        cover_member: cover_source
            .as_ref()
            .map(|_| format!("{}cover.{}", package::COVER_DIR, cover_ext)),
        book_source: Some(book.file_path.clone()),
        cover_source,
        counts: Counts {
            highlights: highlights.len() as u32,
            notes: notes.len() as u32,
            references: refs.len() as u32,
            replacements: reps.len() as u32,
        },
        sections,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spine_step_is_read_from_a_full_cfi() {
        assert_eq!(cfi_section("epubcfi(/6/14!/4/2/2,/1:0,/1:64)").as_deref(), Some("/6/14"));
        // a spine-only cfi names a document and no position inside it — it still has a section
        assert_eq!(cfi_section("epubcfi(/6/8)").as_deref(), Some("/6/8"));
        assert_eq!(cfi_section("epubcfi(/6/14[chap01]!/4/2)").as_deref(), Some("/6/14"));
        assert_eq!(cfi_section(""), None);
    }

    #[test]
    fn the_ordinal_follows_the_verified_rule() {
        assert_eq!(section_index("/6/2", Some(10)), Some(0));
        assert_eq!(section_index("/6/14", Some(10)), Some(6));
        assert_eq!(section_index("/6/1518", Some(1000)), Some(758));
    }

    #[test]
    fn an_ordinal_past_the_spine_is_sectionless_rather_than_guessed() {
        // the bounds assertion Phase 0 asked for: the rule is a convention, not a guarantee
        assert_eq!(section_index("/6/40", Some(10)), None);
        assert_eq!(section_index("/6/3", Some(10)), None); // odd steps are not spine items
        assert_eq!(section_index("/6/0", Some(10)), None);
        assert_eq!(section_index("/x/y", Some(10)), None);
    }

    #[test]
    fn an_unknown_spine_length_still_yields_an_ordinal() {
        // no map is drawn without a spine count, but the ordinal itself is still meaningful
        assert_eq!(section_index("/6/14", None), Some(6));
    }
}
