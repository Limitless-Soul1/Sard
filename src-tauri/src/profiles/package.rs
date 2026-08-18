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
///
/// **2 CARRIES ASSETS.** Version 1 was settings only. The bump is additive in both directions: a v1
/// package still imports here (its `assets` list is simply absent), and a v2 package opened by a v1
/// build degrades to its settings exactly as v1 always promised — "a package that claims assets is
/// not refused; its asset claims are simply not honoured". Nothing about `data` changed, so the
/// forbidden-key boundary and the total parser are untouched.
pub const PACKAGE_VERSION: u64 = 2;

/// Where asset members live inside the archive. A reader who unzips a package finds `profile.json`
/// beside a folder of ordinary image and font files, which is the same "legible, not a blob" promise
/// the manifest already makes.
pub const ASSET_DIR: &str = "assets/";

/// A packageable asset, resolved from the profile's own references.
///
/// THE PLAN IS MADE HERE, NOT IN THE UI. The share sheet has to name each asset, price it in real
/// bytes, and hand back what the reader chose — and every one of those needs a managed path the
/// frontend has no business holding. Resolving them in one place means the sheet renders exactly
/// what `export` will write, rather than a second, frontend-only picture of the same thing that can
/// disagree with it.
///
/// `surfaces` is a LIST because one picture is often two surfaces. A profile whose book background
/// is "the same image, quieter" names one file twice, so it is packed once and claimed twice — which
/// is why the design prices the second one at "no additional size".
#[derive(serde::Serialize)]
pub struct PlannedAsset {
    pub kind: String,
    pub id: String,
    pub member: String,
    pub source: String,
    pub name: String,
    pub bytes: u64,
    pub family: Option<String>,
    pub surfaces: Vec<String>,
}

/// Resolve what CAN travel with this profile, with real sizes.
///
/// Only what the profile actually references, and only what is actually on disk: a ref whose row is
/// gone, or whose file went missing, is simply absent from the plan rather than offered and then
/// failing at export. Nothing here decides what SHOULD travel — that is the reader's, through the
/// sheet's switches.
pub fn plan(
    conn: &Connection,
    library_ref: Option<&str>,
    reading_ref: Option<&str>,
    icon_ref: Option<&str>,
    families: &[String],
) -> Result<Vec<PlannedAsset>, String> {
    let mut out: Vec<PlannedAsset> = Vec::new();

    // One entry per distinct FILE, with every surface that names it.
    let mut add_image = |id: &str, surface: &str, kind: &str| -> Result<(), String> {
        if let Some(existing) = out.iter_mut().find(|a| a.id == id) {
            if !existing.surfaces.iter().any(|s| s == surface) {
                existing.surfaces.push(surface.to_string());
            }
            return Ok(());
        }
        let Some(row) = crate::backgrounds::get(conn, id)? else { return Ok(()) };
        let Ok(meta) = std::fs::metadata(&row.original_path) else { return Ok(()) };
        out.push(PlannedAsset {
            kind: kind.to_string(),
            id: id.to_string(),
            // The member is the content id: the same picture cannot be written twice, and the name
            // says nothing about the sender's filesystem.
            member: format!("{ASSET_DIR}{id}"),
            source: row.original_path.clone(),
            name: row.source_name.clone().unwrap_or_else(|| id.to_string()),
            bytes: meta.len(),
            family: None,
            surfaces: vec![surface.to_string()],
        });
        Ok(())
    };
    if let Some(id) = library_ref.filter(|s| !s.is_empty()) {
        add_image(id, "library", "background")?;
    }
    if let Some(id) = reading_ref.filter(|s| !s.is_empty()) {
        add_image(id, "reading", "background")?;
    }
    if let Some(id) = icon_ref.filter(|s| !s.is_empty()) {
        add_image(id, "icon", "icon")?;
    }

    // A family that is not a custom row is a built-in: every installation already has it, so sending
    // it would be sending Sard its own file.
    for (i, family) in families.iter().enumerate() {
        let family = family.trim();
        if family.is_empty() {
            continue;
        }
        if out.iter().any(|a| a.family.as_deref() == Some(family)) {
            continue;
        }
        let found: Option<String> = conn
            .query_row(
                "SELECT file_path FROM custom_fonts WHERE family_name = ?1 LIMIT 1",
                [family],
                |r| r.get(0),
            )
            .ok();
        let Some(path) = found else { continue };
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| "ttf".into());
        out.push(PlannedAsset {
            kind: "font".into(),
            id: family.to_string(),
            member: format!("{ASSET_DIR}font-{i}.{ext}"),
            source: path,
            // A font's name IS its family — that is what the profile names and what the reader
            // recognises; the file it happens to live in is an implementation detail.
            name: family.to_string(),
            bytes: meta.len(),
            family: Some(family.to_string()),
            surfaces: Vec::new(),
        });
    }
    Ok(out)
}

/// One asset the caller wants written into the package.
///
/// The frontend chooses WHAT travels — it owns the share sheet, the toggles and the sizes — and this
/// module only moves bytes. That split is the same one `export` already had for the manifest: what
/// the reader inspected is what leaves, and Rust does not form a second opinion about it.
#[derive(serde::Deserialize)]
pub struct AssetIn {
    /// The member path inside the archive, e.g. `assets/<sha256>`.
    pub member: String,
    /// Absolute path of the file to copy in. Read as-is: ORIGINAL bytes, never re-encoded, so a
    /// background's content id survives the journey and the receiver can dedupe against it.
    pub source: String,
}

/// The only member a package must contain.
pub const MANIFEST_NAME: &str = "profile.json";

/// A manifest larger than this is not a profile. Matches the TS validator's own ceiling.
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// The largest single asset a package may carry.
///
/// NOT A NEW NUMBER. It is `backgrounds::MAX_FILE_BYTES` — the ceiling a reader's own file already
/// has to clear to be imported at all. An asset arriving inside a package is held to exactly the
/// limit it would have faced arriving through the file picker, so the package is not a way around a
/// rule that already exists. The image importer's pixel ceiling still applies afterwards, on its own.
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

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
pub fn export(path: &str, manifest_json: &str, assets: &[AssetIn]) -> Result<(), String> {
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

        // THE ASSETS, COPIED WHOLE. Streamed rather than read into memory, because a background's
        // original may be tens of megabytes and the package has no reason to hold one twice.
        //
        // STORED, NOT DEFLATED. A JPEG, a PNG and a woff2 are already compressed; deflating them
        // again costs time and yields ~nothing. The manifest above stays deflated — it is text.
        let stored: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for a in assets {
            // A member path is ours to construct, never the sender's to choose: anything outside the
            // asset folder — or climbing out of it — is refused rather than written.
            if !a.member.starts_with(ASSET_DIR) || a.member.contains("..") {
                return Err("pkg.err.badAsset".into());
            }
            let mut src = std::fs::File::open(&a.source).map_err(|_| "pkg.err.assetMissing".to_string())?;
            zip.start_file(a.member.as_str(), stored).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
        }
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

/// Extract one asset member to a temp file and hand back its path.
///
/// THE SAME BOMB DISCIPLINE `inspect` USES. A zip declares each member's uncompressed size, and a
/// small archive can declare a huge one; the declared size is checked BEFORE reading and `take`
/// makes the ceiling structural rather than a hope. The ceiling is the one the background importer
/// already enforces on any file a reader picks — an asset arriving in a package is not permitted to
/// be larger than one they could have chosen themselves.
fn extract_to_temp(
    zip: &mut zip::ZipArchive<std::fs::File>,
    member: &str,
    dir: &Path,
    file_name: &str,
) -> Result<std::path::PathBuf, String> {
    // The member name is read from the manifest, so it is a stranger's string: refuse anything that
    // is not inside the asset folder, or that tries to climb out of it.
    if !member.starts_with(ASSET_DIR) || member.contains("..") {
        return Err("pkg.err.badAsset".into());
    }
    let mut entry = zip.by_name(member).map_err(|_| "pkg.err.assetMissing".to_string())?;
    if entry.size() > MAX_ASSET_BYTES {
        return Err("pkg.err.assetTooLarge".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // The name is OURS, built from the kind and an index — never the sender's filename, which would
    // be a path the archive controls landing in a directory we control.
    let out = dir.join(file_name);
    let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
    let written = std::io::copy(&mut entry.by_ref().take(MAX_ASSET_BYTES + 1), &mut f)
        .map_err(|_| "pkg.err.unreadable".to_string())?;
    if written > MAX_ASSET_BYTES {
        let _ = std::fs::remove_file(&out);
        return Err("pkg.err.assetTooLarge".into());
    }
    Ok(out)
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
pub fn commit(
    conn: &Connection,
    manifest_json: &str,
    new_id: &str,
    // `None` = a settings-only commit, which is what every v1 caller and every test wants. When a
    // package is on disk its path and the app's data dir arrive together, because registering an
    // asset needs both the archive to read from and the managed dir to write into.
    assets_from: Option<(&str, &Path)>,
) -> Result<Profile, String> {
    let v = check(manifest_json)?;
    let obj = v.as_object().ok_or("pkg.err.unreadable")?;
    let str_of = |k: &str| obj.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // ---- the assets, registered through the importers a picked file already goes through --------
    //
    // NOTHING HERE INVENTS A SECOND WAY IN. A background arriving in a package is handed to
    // `backgrounds::import`, which content-addresses it exactly as it would a file the reader chose;
    // because the id is the SHA-256 of the ORIGINAL bytes and the package carries those bytes
    // untouched, the id it lands under is the id the sender's profile already names. So the refs
    // inside `data` resolve with no rewriting, and a receiver who already has the picture pays
    // nothing for it — `dedup_or_repair` hands back the row they had.
    //
    // A FAILED ASSET IS NOT A FAILED IMPORT. The profile is still the reader's colours, faces and
    // marks; an image that could not be decoded costs them the image, not the profile. So each one
    // is attempted independently and a failure leaves that reference unset, which is precisely the
    // state a profile whose image was never sent is already in.
    let mut icon_ref: Option<String> = None;
    let mut bg_library: Option<String> = None;
    let mut bg_reading: Option<String> = None;
    if let Some((archive_path, app_data_dir)) = assets_from {
        let claimed = obj.get("assets").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        if !claimed.is_empty() {
            if let Ok(file) = std::fs::File::open(archive_path) {
                if let Ok(mut zip) = zip::ZipArchive::new(file) {
                    let tmp = app_data_dir.join("import-tmp");
                    for (i, a) in claimed.iter().enumerate() {
                        let Some(member) = a.get("member").and_then(|x| x.as_str()) else { continue };
                        let kind = a.get("kind").and_then(|x| x.as_str()).unwrap_or("");
                        // THE EXTENSION HAS TO SURVIVE. `fonts::import` gates on it and names the
                        // managed file by it, so an extensionless temp is refused however good its
                        // bytes are — measured: the font never arrived. It is taken from the member
                        // path but SANITISED to a short alphanumeric run, because that path came out
                        // of a stranger's manifest and only the bytes are theirs to choose.
                        let ext = member
                            .rsplit('.')
                            .next()
                            .filter(|e| {
                                !e.is_empty()
                                    && e.len() <= 5
                                    && e.chars().all(|c| c.is_ascii_alphanumeric())
                            })
                            .map(str::to_ascii_lowercase);
                        let name = match &ext {
                            Some(e) => format!("asset-{i}.{e}"),
                            None => format!("asset-{i}"),
                        };
                        let Ok(path) = extract_to_temp(&mut zip, member, &tmp, &name) else { continue };
                        match kind {
                            "background" | "icon" => {
                                if let Ok(row) = crate::backgrounds::import(
                                    conn,
                                    app_data_dir,
                                    &path.display().to_string(),
                                ) {
                                    // The claimed id is checked against the id the bytes actually
                                    // produce. A mismatch means the manifest described something the
                                    // archive does not contain, so the claim is dropped rather than
                                    // believed — the row still exists and the collector still owns it.
                                    let claimed_id = a.get("id").and_then(|x| x.as_str());
                                    if claimed_id.is_none_or(|c| c == row.id) {
                                        // A LIST, because one picture is often two surfaces: a book
                                        // background that is "the same image, quieter" is packed
                                        // once and claimed twice.
                                        let surfaces = a
                                            .get("surfaces")
                                            .and_then(|x| x.as_array())
                                            .map(|v| {
                                                v.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>()
                                            })
                                            .unwrap_or_default();
                                        for s in surfaces {
                                            match s {
                                                "library" => bg_library = Some(row.id.clone()),
                                                "reading" => bg_reading = Some(row.id.clone()),
                                                "icon" => icon_ref = Some(row.id.clone()),
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                            }
                            "font" => {
                                // A font is resolved BY FAMILY, so a family the receiver already has
                                // needs nothing: registering a second copy would add a row that
                                // changes nothing anyone can see. `import_named` records the family
                                // the profile actually names rather than one guessed from a filename.
                                if let Some(family) = a.get("family").and_then(|x| x.as_str()) {
                                    let _ = crate::fonts::import_named(
                                        conn,
                                        app_data_dir,
                                        &path.display().to_string(),
                                        family,
                                    );
                                }
                            }
                            _ => {}
                        }
                        let _ = std::fs::remove_file(&path);
                    }
                    let _ = std::fs::remove_dir(&tmp);
                }
            }
        }
    }

    let p = Profile {
        id: new_id.to_string(),
        name: str_of("name").filter(|s| !s.trim().is_empty()),
        description: str_of("description"),
        author: str_of("author"),
        icon_kind: Some(if icon_ref.is_some() { "image".into() } else { "seal".to_string() }),
        icon_ref,
        // Verbatim. Rust does not interpret a profile's look — the frontend's total parser does, and
        // re-serialising here would be a second opinion nobody asked for.
        data: obj
            .get("data")
            .map(|d| d.to_string())
            .ok_or("pkg.err.noData")?,
        derived_from: None,
        created_at: now,
        updated_at: now,
        // The collector's own reference sources, set only for assets that actually landed. A ref to
        // a row this database does not have is a ref the collector cannot honour, so an image that
        // failed to register leaves these null exactly as a settings-only package does.
        bg_library,
        bg_reading,
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
        export(path.to_str().unwrap(), &text, &[]).unwrap();
        assert!(path.exists(), "the archive is written under the chosen name");
        assert_eq!(inspect(path.to_str().unwrap()).unwrap(), text, "byte-for-byte what was written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_leaves_no_part_file_behind() {
        let dir = std::env::temp_dir().join(format!("sard-pkg-part-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("y.zip");
        export(path.to_str().unwrap(), &manifest(""), &[]).unwrap();
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
            let e = commit(&conn, json, "u:x", None).unwrap_err();
            assert!(e.starts_with(want), "{json} -> {e}, wanted {want}");
        }
    }

    #[test]
    fn commit_refuses_a_package_carrying_the_readers_own_layout() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        for field in ["lineHeight", "zoom", "margins", "diacritics"] {
            let json = manifest(&format!(r#","{field}":1"#));
            let e = commit(&conn, &json, "u:x", None).unwrap_err();
            assert!(
                e.starts_with("pkg.err.carriesReadingSettings"),
                "{field} must be refused, got {e}"
            );
        }
        // and nested, not only at the top
        let nested = manifest(r#","type":{"deep":{"zoom":2}}"#);
        assert!(commit(&conn, &nested, "u:x", None).unwrap_err().starts_with("pkg.err.carriesReadingSettings"));
    }

    #[test]
    fn commit_writes_a_new_row_under_a_fresh_id_and_no_provenance() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let p = commit(&conn, &manifest(""), "u:fresh", None).unwrap();
        assert_eq!(p.id, "u:fresh", "the sender's id is never reused");
        assert_eq!(p.derived_from, None, "provenance is local; a stranger's row id means nothing");
        assert_eq!(p.bg_library, None, "settings only — no asset is claimed");
        assert_eq!(p.name.as_deref(), Some("n"));
        let rows = super::super::list(&conn).unwrap();
        assert_eq!(rows.len(), 1, "exactly one row, and it is the imported one");
        assert!(rows[0].data.contains("ivory"), "the look is stored verbatim");
    }

    /// A package's font makes the journey, lands under the family the MANIFEST names, and a second
    /// import of the same package adds nothing. The family is the identity at the point of use, so
    /// "already have it" is the same question the renderer asks.
    #[test]
    fn a_font_travels_once_and_lands_under_the_family_the_profile_names() {
        let dir = std::env::temp_dir().join(format!("sard-asset-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("SomeFace-Regular.ttf");
        std::fs::write(&src, b"not a real font, but real bytes").unwrap();

        let pkg = dir.join("p.zip");
        let text = format!(
            r#"{{"package":2,"app":"t","name":"n","assets":[{{"member":"assets/f0.ttf","kind":"font","family":"Rakwa"}}],"data":{{"theme":{{"base":"ivory"}},"type":{{"arabic":"Rakwa"}}}}}}"#
        );
        export(
            pkg.to_str().unwrap(),
            &text,
            &[AssetIn { member: "assets/f0.ttf".into(), source: src.display().to_string() }],
        )
        .unwrap();

        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let app_dir = dir.join("appdata");
        let from = Some((pkg.to_str().unwrap(), app_dir.as_path()));

        commit(&conn, &text, "u:one", from).unwrap();
        let fonts = crate::fonts::list(&conn).unwrap();
        assert_eq!(fonts.len(), 1, "the font arrived");
        assert_eq!(
            fonts[0].family_name, "Rakwa",
            "under the family the profile names, NOT one derived from the filename"
        );
        assert!(
            std::path::Path::new(&fonts[0].file_path).exists(),
            "and its bytes are on disk where the asset protocol can serve them"
        );

        // The same package again: the family is already here, so nothing is added.
        commit(&conn, &text, "u:two", from).unwrap();
        assert_eq!(
            crate::fonts::list(&conn).unwrap().len(),
            1,
            "a family already present is not registered twice"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TWO INSTALLATIONS, AND A PROFILE THAT SURVIVES THE JOURNEY.
    ///
    /// This is the claim the whole format exists to make, so it is made against two genuinely
    /// separate app-data directories and two separate databases — not one database pretending. A
    /// picture and a face are imported into A, planned, packed, and committed into a B that has
    /// never seen either.
    ///
    /// The assertion that matters is the ID: because a background is content-addressed over its
    /// ORIGINAL bytes and those bytes travel untouched, the row B creates lands under the SAME id A
    /// had — which is what makes the refs inside `data` resolve on the far side with no rewriting.
    #[test]
    fn a_profile_and_its_assets_survive_a_journey_between_two_installations() {
        let root = std::env::temp_dir().join(format!("sard-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let a_dir = root.join("A");
        let b_dir = root.join("B");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();

        // ---- installation A: a real picture and a real font file
        let a_conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&a_conn, None).unwrap();
        let src_png = crate::backgrounds::tests_support::write_png(&a_dir, "wall.png", 220, 140, 90);
        let bg = crate::backgrounds::import(&a_conn, &a_dir, &src_png).unwrap();
        let font_src = a_dir.join("Rakwa-Regular.ttf");
        std::fs::write(&font_src, b"font bytes that are not really a font").unwrap();
        crate::fonts::import_named(&a_conn, &a_dir, &font_src.display().to_string(), "Rakwa").unwrap();

        // ---- what can travel, priced from the files themselves
        let planned = plan(&a_conn, Some(&bg.id), Some(&bg.id), None, &["Rakwa".to_string()]).unwrap();
        assert_eq!(planned.len(), 2, "one picture (serving two surfaces) and one font");
        let picture = planned.iter().find(|p| p.kind == "background").unwrap();
        assert_eq!(
            picture.surfaces.len(),
            2,
            "one file claimed by both surfaces — packed once, which is why the design prices the \
             second at no additional size"
        );
        assert!(picture.bytes > 0, "priced from the file, not estimated");

        // ---- pack it
        let pkg = root.join("p.zip");
        let assets_json: Vec<String> = planned
            .iter()
            .map(|p| {
                format!(
                    r#"{{"kind":"{}","id":"{}","member":"{}","name":"n","bytes":{},"family":{},"surfaces":[{}]}}"#,
                    p.kind,
                    p.id,
                    p.member,
                    p.bytes,
                    p.family.as_ref().map(|f| format!("\"{f}\"")).unwrap_or("null".into()),
                    p.surfaces.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(","),
                )
            })
            .collect();
        let text = format!(
            r#"{{"package":2,"app":"t","name":"Masaa","assets":[{}],"data":{{"theme":{{"base":"ivory"}},"type":{{"arabic":"Rakwa"}}}}}}"#,
            assets_json.join(",")
        );
        let ins: Vec<AssetIn> = planned
            .iter()
            .map(|p| AssetIn { member: p.member.clone(), source: p.source.clone() })
            .collect();
        export(pkg.to_str().unwrap(), &text, &ins).unwrap();

        // ---- installation B has never seen any of it
        let b_conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&b_conn, None).unwrap();
        assert!(crate::backgrounds::list(&b_conn).unwrap().is_empty(), "B starts empty");
        assert!(crate::fonts::list(&b_conn).unwrap().is_empty(), "B starts empty");

        let from = Some((pkg.to_str().unwrap(), b_dir.as_path()));
        let p = commit(&b_conn, &text, "u:landed", from).unwrap();

        let b_bgs = crate::backgrounds::list(&b_conn).unwrap();
        assert_eq!(b_bgs.len(), 1, "the picture arrived");
        assert_eq!(
            b_bgs[0].id, bg.id,
            "and under the SAME content id, so the profile's own refs resolve with no rewriting"
        );
        assert!(std::path::Path::new(&b_bgs[0].original_path).exists(), "its bytes are on B's disk");
        assert_eq!(p.bg_library.as_deref(), Some(bg.id.as_str()), "the library surface is claimed");
        assert_eq!(p.bg_reading.as_deref(), Some(bg.id.as_str()), "and so is the reading surface");
        let b_fonts = crate::fonts::list(&b_conn).unwrap();
        assert_eq!(b_fonts.len(), 1, "the face arrived");
        assert_eq!(b_fonts[0].family_name, "Rakwa", "under the family the profile names");

        // ---- the same package again: B already has all of it
        commit(&b_conn, &text, "u:again", from).unwrap();
        assert_eq!(
            crate::backgrounds::list(&b_conn).unwrap().len(),
            1,
            "the picture is reused, not duplicated — content addressing does this for free"
        );
        assert_eq!(crate::fonts::list(&b_conn).unwrap().len(), 1, "and so is the face");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A member path is ours to construct. A manifest that names one outside the asset folder, or
    /// that climbs out of it, is refused rather than written or read.
    #[test]
    fn an_asset_member_may_not_escape_the_asset_folder() {
        let dir = std::env::temp_dir().join(format!("sard-escape-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("x.ttf");
        std::fs::write(&src, b"bytes").unwrap();
        for bad in ["../evil.ttf", "assets/../../evil.ttf", "evil.ttf"] {
            let e = export(
                dir.join("q.zip").to_str().unwrap(),
                &manifest(""),
                &[AssetIn { member: bad.into(), source: src.display().to_string() }],
            )
            .unwrap_err();
            assert_eq!(e, "pkg.err.badAsset", "{bad} is refused");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A v1 package — no `assets` at all — still imports, with assets enabled on the caller's side.
    #[test]
    fn a_settings_only_package_still_imports_when_assets_are_available() {
        let dir = std::env::temp_dir().join(format!("sard-v1-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let pkg = dir.join("v1.zip");
        let text = r#"{"package":1,"app":"t","name":"old","data":{"theme":{"base":"ivory"}}}"#;
        export(pkg.to_str().unwrap(), text, &[]).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        let app_dir = dir.join("appdata");
        let p = commit(&conn, text, "u:v1", Some((pkg.to_str().unwrap(), app_dir.as_path()))).unwrap();
        assert_eq!(p.name.as_deref(), Some("old"), "version 1 is still readable");
        assert_eq!(p.bg_library, None, "and claims nothing it did not carry");
        let _ = std::fs::remove_dir_all(&dir);
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
