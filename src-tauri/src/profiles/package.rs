//! The profile package — one file a reader sends however they like.
//!
//! No account, no server, no gallery. A package is a zip whose only required member is
//! `profile.json`; a reader who unzips it finds something legible rather than a blob.
//!
//! # Why Rust re-checks what TypeScript already validated
//!
//! The full validator is in TS and is deliberately pure, so every rule is unit-testable
//! (`model/package.ts`). This module duplicates the few rules that are the actual TRUST BOUNDARY,
//! and the duplication is deliberate: `commit` writes to the reader's database, and a boundary that
//! holds only because the caller was well-behaved is not a boundary. The frontend is Sard's own, but
//! the whole point of a rule enforced here is that it does not depend on that staying true.
//!
//! It re-checks only what matters for safety and cannot drift meaningfully:
//!   · it is a JSON object at all;
//!   · it does not claim a format newer than this build understands;
//!   · it carries a `data` object;
//!   · it carries none of the reader's own layout.
//!
//! The rest — defaulting, colour repair, enum membership — stays in TS, where absence-defaulting
//! already makes it total and where refusing would be worse than forgiving.
//!
//! # Settings only
//!
//! Assets travel in a later stage. A package that claims them is not refused here; its asset claims
//! are simply not honoured, so a profile shared from a later Sard still brings its colours and faces.

use std::io::{Read, Write};
use std::path::Path;

use rusqlite::Connection;

use super::Profile;

/// The format version this build writes and will accept.
pub const PACKAGE_VERSION: u64 = 1;

/// The only member a package must contain.
pub const MANIFEST_NAME: &str = "profile.json";

/// A manifest larger than this is not a profile. Matches the TS validator's own ceiling.
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// Everything the reader's own layout owns. A package carrying any of these is refused rather than
/// quietly stripped — silently dropping a field is how a sender comes to believe they sent something
/// they did not. Kept in step with `FORBIDDEN_DATA_KEYS` in `model/package.ts`.
const FORBIDDEN: [&str; 18] = [
    "lineHeight", "pageWidth", "measure", "margin", "margins", "marginPx", "paragraphSpacing",
    "tracking", "letterSpacing", "align", "textAlign", "diacritics", "zoom", "fontWeight",
    "firstLineIndent", "flowMode", "reading_style", "book_style",
];

/// Write a package to `path`. The manifest text is produced by the frontend and written verbatim, so
/// what the reader inspects before sending is byte-for-byte what leaves.
pub fn export(path: &str, manifest_json: &str) -> Result<(), String> {
    if manifest_json.len() > MAX_MANIFEST_BYTES {
        return Err("pkg.err.tooLarge".into());
    }
    // Written to a temp beside the destination and renamed, so an interrupted write never leaves a
    // half-file where the reader will later look for a package.
    let dest = Path::new(path);
    let tmp = dest.with_extension("zip.part");
    {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(MANIFEST_NAME, opts).map_err(|e| e.to_string())?;
        zip.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    let res = std::fs::rename(&tmp, dest).map_err(|e| e.to_string());
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Read a package's manifest WITHOUT changing anything. The reader sees the profile before it enters.
pub fn inspect(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "pkg.err.unreadable".to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "pkg.err.unreadable".to_string())?;
    let mut entry = zip
        .by_name(MANIFEST_NAME)
        .map_err(|_| "pkg.err.notSard".to_string())?;

    // BOUNDED BEFORE IT IS READ. A zip declares its uncompressed size, and a small archive can
    // declare a very large member; reading to the end first and checking afterwards is how a
    // decompression bomb exhausts memory. `take` makes the ceiling structural.
    if entry.size() as usize > MAX_MANIFEST_BYTES {
        return Err("pkg.err.tooLarge".into());
    }
    let mut text = String::new();
    entry
        .by_ref()
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "pkg.err.unreadable".to_string())?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err("pkg.err.tooLarge".into());
    }
    // Refuse here too, so `inspect` never hands the UI something `commit` would reject.
    check(&text)?;
    Ok(text)
}

/// The trust boundary. Returns the same refusal codes the TS validator uses, so one vocabulary
/// reaches the reader whichever side refused.
fn check(text: &str) -> Result<serde_json::Value, String> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err("pkg.err.tooLarge".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "pkg.err.unreadable".to_string())?;
    let obj = v.as_object().ok_or("pkg.err.unreadable")?;
    let version = obj
        .get("package")
        .and_then(|x| x.as_u64())
        .ok_or("pkg.err.notSard")?;
    if version > PACKAGE_VERSION {
        return Err("pkg.err.newer".into());
    }
    let data = obj.get("data").ok_or("pkg.err.noData")?;
    if !data.is_object() {
        return Err("pkg.err.noData".into());
    }
    if let Some(f) = forbidden_in(data, 0) {
        return Err(format!("pkg.err.carriesReadingSettings:{f}"));
    }
    Ok(v)
}

/// Any forbidden key, at any depth. Depth-bounded so a deeply nested document cannot spend the stack.
fn forbidden_in(v: &serde_json::Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match v {
        serde_json::Value::Object(m) => {
            for (k, child) in m {
                if FORBIDDEN.contains(&k.as_str()) {
                    return Some(k.clone());
                }
                if let Some(f) = forbidden_in(child, depth + 1) {
                    return Some(f);
                }
            }
            None
        }
        serde_json::Value::Array(a) => a.iter().find_map(|c| forbidden_in(c, depth + 1)),
        _ => None,
    }
}

/// Commit an inspected package as a NEW profile.
///
/// THE PACKAGE IS RE-CHECKED, not trusted. `inspect` and `commit` are separate IPC calls, so nothing
/// but this line guarantees that what is written passed the same rules as what was shown.
///
/// A FRESH ID, ALWAYS. The sender's id names a row in THEIR database; reusing it would collide with
/// an unrelated local profile or silently overwrite one. `derived_from` is left null for the same
/// reason — provenance is local, and a stranger's row id means nothing here. The imported profile is
/// an ordinary profile from this moment on: editable, renameable, deletable.
pub fn commit(conn: &Connection, manifest_json: &str, new_id: &str) -> Result<Profile, String> {
    let v = check(manifest_json)?;
    let obj = v.as_object().ok_or("pkg.err.unreadable")?;
    let str_of = |k: &str| obj.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let p = Profile {
        id: new_id.to_string(),
        name: str_of("name").filter(|s| !s.trim().is_empty()),
        description: str_of("description"),
        author: str_of("author"),
        icon_kind: Some("seal".into()),
        icon_ref: None,
        // Verbatim. Rust does not interpret a profile's look — the frontend's total parser does, and
        // re-serialising here would be a second opinion nobody asked for.
        data: obj
            .get("data")
            .map(|d| d.to_string())
            .ok_or("pkg.err.noData")?,
        derived_from: None,
        created_at: now,
        updated_at: now,
        // SETTINGS ONLY. Assets arrive in a later stage; a profile that names an image this database
        // does not have would be a reference the collector cannot honour.
        bg_library: None,
        bg_reading: None,
    };
    super::save(conn, &p).map_err(|e| e.to_string())?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(extra: &str) -> String {
        format!(r#"{{"package":1,"app":"t","name":"n","data":{{"theme":{{"base":"ivory"}}{extra}}}}}"#)
    }

    #[test]
    fn a_package_round_trips_through_a_real_file() {
        let dir = std::env::temp_dir().join(format!("sard-pkg-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("x.zip");
        let text = manifest("");
        export(path.to_str().unwrap(), &text).unwrap();
        assert!(path.exists(), "the archive is written under the chosen name");
        assert_eq!(inspect(path.to_str().unwrap()).unwrap(), text, "byte-for-byte what was written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_leaves_no_part_file_behind() {
        let dir = std::env::temp_dir().join(format!("sard-pkg-part-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("y.zip");
        export(path.to_str().unwrap(), &manifest("")).unwrap();
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(strays.is_empty(), "the temp is renamed, not left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // THE BOUNDARY, ASSERTED IN RUST. These must hold even if the frontend never called inspect.
    #[test]
    fn commit_refuses_what_inspect_would_have_refused() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let cases = [
            ("not json at all", "pkg.err.unreadable"),
            (r#"[]"#, "pkg.err.unreadable"),
            (r#"{"app":"t","data":{}}"#, "pkg.err.notSard"),
            (r#"{"package":99,"data":{}}"#, "pkg.err.newer"),
            (r#"{"package":1}"#, "pkg.err.noData"),
            (r#"{"package":1,"data":"x"}"#, "pkg.err.noData"),
        ];
        for (json, want) in cases {
            let e = commit(&conn, json, "u:x").unwrap_err();
            assert!(e.starts_with(want), "{json} -> {e}, wanted {want}");
        }
    }

    #[test]
    fn commit_refuses_a_package_carrying_the_readers_own_layout() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        for field in ["lineHeight", "zoom", "margins", "diacritics"] {
            let json = manifest(&format!(r#","{field}":1"#));
            let e = commit(&conn, &json, "u:x").unwrap_err();
            assert!(
                e.starts_with("pkg.err.carriesReadingSettings"),
                "{field} must be refused, got {e}"
            );
        }
        // and nested, not only at the top
        let nested = manifest(r#","type":{"deep":{"zoom":2}}"#);
        assert!(commit(&conn, &nested, "u:x").unwrap_err().starts_with("pkg.err.carriesReadingSettings"));
    }

    #[test]
    fn commit_writes_a_new_row_under_a_fresh_id_and_no_provenance() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let p = commit(&conn, &manifest(""), "u:fresh").unwrap();
        assert_eq!(p.id, "u:fresh", "the sender's id is never reused");
        assert_eq!(p.derived_from, None, "provenance is local; a stranger's row id means nothing");
        assert_eq!(p.bg_library, None, "settings only — no asset is claimed");
        assert_eq!(p.name.as_deref(), Some("n"));
        let rows = super::super::list(&conn).unwrap();
        assert_eq!(rows.len(), 1, "exactly one row, and it is the imported one");
        assert!(rows[0].data.contains("ivory"), "the look is stored verbatim");
    }

    #[test]
    fn inspect_refuses_an_archive_with_no_manifest() {
        let dir = std::env::temp_dir().join(format!("sard-pkg-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("z.zip");
        {
            let f = std::fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            zip.start_file("something-else.txt", opts).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(inspect(path.to_str().unwrap()).unwrap_err(), "pkg.err.notSard");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_refuses_a_file_that_is_not_an_archive() {
        let dir = std::env::temp_dir().join(format!("sard-pkg-raw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("plain.zip");
        std::fs::write(&path, b"just some bytes").unwrap();
        assert_eq!(inspect(path.to_str().unwrap()).unwrap_err(), "pkg.err.unreadable");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
