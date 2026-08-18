//! Fonts (RAWY-39) — import user font files into the app and list them. An imported font is
//! copied into `<app_data>/fonts/<id>.<ext>` (served to the WebView via the asset protocol, which
//! is scoped to `$APPDATA/**`) and recorded in the `custom_fonts` table so it is available
//! app-wide (interface font, and later book fonts). Built-in fonts ship in `public/fonts/`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize, Clone)]
pub struct CustomFont {
    pub id: String,
    pub family_name: String,
    pub file_path: String,
    pub script: Option<String>,
}

const ALLOWED: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn gen_id(seed: &str) -> String {
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// A human family name from the file stem: drop a trailing weight/style word so
/// `IBMPlexSansArabic-Regular` → `IBMPlexSansArabic` and `My Font Bold` → `My Font`.
fn family_from_stem(stem: &str) -> String {
    let cleaned = stem.replace('_', " ");
    let parts: Vec<&str> = cleaned.split([' ', '-']).filter(|s| !s.is_empty()).collect();
    const WEIGHTS: [&str; 12] = [
        "regular", "bold", "italic", "light", "medium", "semibold", "thin", "black",
        "book", "roman", "oblique", "variablefont",
    ];
    let kept: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|p| !WEIGHTS.contains(&p.to_lowercase().as_str()))
        .collect();
    let name = if kept.is_empty() { parts } else { kept };
    let joined = name.join(" ").trim().to_string();
    if joined.is_empty() { "Imported font".into() } else { joined }
}

/// Register a font under a family the CALLER already knows, if this installation lacks it.
///
/// A PROFILE NAMES A FONT BY ITS FAMILY. `bookFaceCss` passes an unrecognised key straight through
/// as a CSS family, so a packaged font is only useful if it lands under the exact family the profile
/// names — which `family_from_stem` cannot guarantee, since it reads a filename and the manifest is
/// what carries the truth.
///
/// THAT IS ALSO THE DEDUPLICATION, and why fonts need no content hash to avoid duplicate records.
/// "Does this installation already have this family?" is the same question the renderer asks when it
/// resolves the profile, so a family already present needs nothing: a second copy would add a row, a
/// file and a byte count while changing nothing anyone can see. `Ok(None)` = already had it.
pub fn import_named(
    conn: &Connection,
    app_data_dir: &Path,
    src_path: &str,
    family: &str,
) -> Result<Option<CustomFont>, String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("font family is empty".into());
    }
    let existing: Option<String> = conn
        .query_row("SELECT id FROM custom_fonts WHERE family_name = ?1 LIMIT 1", [family], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        return Ok(None);
    }
    import_as(conn, app_data_dir, src_path, Some(family)).map(Some)
}

/// Copy `src_path` into the managed fonts dir and record it. Returns the new row.
pub fn import(conn: &Connection, app_data_dir: &Path, src_path: &str) -> Result<CustomFont, String> {
    import_as(conn, app_data_dir, src_path, None)
}

/// The shared body. `family_override` names the family instead of deriving it from the file stem.
fn import_as(
    conn: &Connection,
    app_data_dir: &Path,
    src_path: &str,
    family_override: Option<&str>,
) -> Result<CustomFont, String> {
    let src = Path::new(src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("Unsupported font type: .{ext} (use ttf, otf, woff, woff2)"));
    }
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("font").to_string();
    let family = match family_override {
        Some(f) => f.to_string(),
        None => family_from_stem(&stem),
    };

    let fonts_dir: PathBuf = app_data_dir.join("fonts");
    std::fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;
    let id = gen_id(&format!("{family}|{stem}|{}", now_unix()));
    let managed = fonts_dir.join(format!("{id}.{ext}"));
    std::fs::copy(src, &managed).map_err(|e| format!("copy font: {e}"))?;
    let file_path = managed.display().to_string();

    conn.execute(
        "INSERT INTO custom_fonts(id, family_name, file_path, script, added_at) \
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, family, file_path, Option::<String>::None, now_unix()],
    )
    .map_err(|e| e.to_string())?;

    Ok(CustomFont { id, family_name: family, file_path, script: None })
}

/// All imported fonts, newest first.
pub fn list(conn: &Connection) -> Result<Vec<CustomFont>, String> {
    let mut stmt = conn
        .prepare("SELECT id, family_name, file_path, script FROM custom_fonts ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CustomFont {
                id: r.get(0)?,
                family_name: r.get(1)?,
                file_path: r.get(2)?,
                script: r.get::<_, Option<String>>(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Remove an imported font (row + file). Tolerant of a missing file; never deletes outside
/// the managed fonts dir.
pub fn remove(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row("SELECT file_path FROM custom_fonts WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM custom_fonts WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    if let Some(p) = existing {
        let path = Path::new(&p);
        if path.starts_with(app_data_dir.join("fonts")) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}
