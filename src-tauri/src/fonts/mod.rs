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

// ---------------------------------------------------------------------------------------------
// WHAT A FONT FILE ACTUALLY IS — validation and identity, read from the file rather than its name.
//
// WHY THIS EXISTS. `import_as` accepted anything whose EXTENSION was in `ALLOWED` and named the
// family by stripping weight words off the file stem. That is enough for a reader who picks a file
// deliberately; it is not enough for a file that arrives by being dropped on the window, where "is
// this a font at all" has to be answered before anything is copied, and where a renamed `.txt` must
// be refused rather than stored. It is also the wrong source for identity: `Inter-Regular.ttf`
// renamed to `notes.ttf` would have been imported under the family "notes".
//
// SO THE FILE IS PARSED. Everything below reads the sfnt container the way the renderer will: the
// version tag, the table directory, and the `name` table's own strings. It indexes only through
// checked slices and returns `Err` for every malformed case rather than panicking — a corrupt font
// is an ordinary input here, not a bug.
//
// WHAT IT DOES NOT PARSE, stated rather than implied. A `.woff` stores each table deflated and a
// `.woff2` stores the whole file brotli-compressed; neither decompressor is in this tree, and adding
// one to read a family name would be a dependency bought for a label. Both are still real fonts the
// WebView renders, so they are accepted on the container check alone and keep the filename-derived
// family — the behaviour they already had. Only the sfnt formats gain metadata identity.

/// What a font file says about itself.
#[derive(Serialize, Clone, Debug)]
pub struct FontFacts {
    /// The family the file names, or the one derived from its stem when the format hides it.
    pub family: String,
    /// The style/subfamily ("Bold", "Italic"...), when the file names one.
    pub style: Option<String>,
    /// `ttf` / `otf` / `ttc` / `woff` / `woff2`
    pub format: String,
    /// True when `family` came from the font's own `name` table rather than from the filename.
    pub named_by_font: bool,
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}
fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(at)?, *b.get(at + 1)?, *b.get(at + 2)?, *b.get(at + 3)?]))
}

/// Decode one `name` record. Windows and Unicode records are UTF-16BE; Macintosh Roman is ASCII for
/// every character a family name realistically uses, so it is read as such and anything else is
/// declined rather than guessed at.
fn decode_name(platform: u16, raw: &[u8]) -> Option<String> {
    let s = match platform {
        0 | 3 => {
            if raw.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> =
                raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()?
        }
        1 => raw.iter().map(|&c| c as char).collect(),
        _ => return None,
    };
    let t = s.trim().trim_matches('\u{0}').trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Family and style out of an sfnt's `name` table, given the offset the font starts at.
///
/// Name IDs 16/17 are the TYPOGRAPHIC family and style and are preferred where present, because that
/// is the pair a renderer groups by; 1/2 are the legacy pair every font carries. A Windows English
/// record wins over any other, which keeps a localised name out of the family.
fn sfnt_names(b: &[u8], base: usize) -> Result<(Option<String>, Option<String>), String> {
    let num = be16(b, base + 4).ok_or("font.err.invalid")? as usize;
    if num == 0 || num > 512 {
        return Err("font.err.invalid".into());
    }
    let mut name_at: Option<usize> = None;
    for i in 0..num {
        let rec = base + 12 + i * 16;
        let tag = b.get(rec..rec + 4).ok_or("font.err.invalid")?;
        let off = be32(b, rec + 8).ok_or("font.err.invalid")? as usize;
        let len = be32(b, rec + 12).ok_or("font.err.invalid")? as usize;
        if tag == b"name" {
            if off.checked_add(len).map_or(true, |end| end > b.len()) {
                return Err("font.err.invalid".into());
            }
            name_at = Some(off);
        }
    }
    // A font with no `name` table is still a font to the renderer; it simply cannot say what it is.
    let off = match name_at {
        Some(v) => v,
        None => return Ok((None, None)),
    };
    let count = be16(b, off + 2).ok_or("font.err.invalid")? as usize;
    let strings = off + be16(b, off + 4).ok_or("font.err.invalid")? as usize;

    // Per slot: the best score seen, and its value. Preference is data rather than record order.
    let mut best: [(u32, Option<String>); 4] = [(0, None), (0, None), (0, None), (0, None)];
    for i in 0..count {
        let rec = off + 6 + i * 12;
        let platform = match be16(b, rec) {
            Some(v) => v,
            None => break,
        };
        let lang = match be16(b, rec + 4) {
            Some(v) => v,
            None => break,
        };
        let id = match be16(b, rec + 6) {
            Some(v) => v,
            None => break,
        };
        let len = match be16(b, rec + 8) {
            Some(v) => v,
            None => break,
        } as usize;
        let at = match be16(b, rec + 10) {
            Some(v) => v,
            None => break,
        } as usize;
        let slot = match id {
            1 => 0,
            2 => 1,
            16 => 2,
            17 => 3,
            _ => continue,
        };
        let start = match strings.checked_add(at) {
            Some(v) => v,
            None => continue,
        };
        let end = match start.checked_add(len) {
            Some(v) => v,
            None => continue,
        };
        let raw = match b.get(start..end) {
            Some(r) => r,
            None => continue,
        };
        let score = match (platform, lang) {
            (3, 0x0409) => 3, // Windows, US English — the record every font ships
            (3, _) => 2,
            (0, _) => 1, // Unicode
            _ => 1,
        };
        if score > best[slot].0 {
            if let Some(v) = decode_name(platform, raw) {
                best[slot] = (score, Some(v));
            }
        }
    }
    let family = best[2].1.clone().or_else(|| best[0].1.clone());
    let style = best[3].1.clone().or_else(|| best[1].1.clone());
    Ok((family, style))
}

/// Read a font file and say what it is, changing nothing. `Err` means "not a font Sard will take",
/// and its message is a translation key so the reader is told which refusal this was.
pub fn inspect(src_path: &str) -> Result<FontFacts, String> {
    let src = Path::new(src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err("font.err.type".into());
    }
    let meta = std::fs::metadata(src).map_err(|_| "font.err.unreadable".to_string())?;
    // A font under 128 bytes cannot carry a directory and a name table; one over 64 MB is not a font
    // anybody is importing, and refusing it keeps a stray archive out of memory.
    if meta.len() < 128 || meta.len() > 64 * 1024 * 1024 {
        return Err("font.err.invalid".into());
    }
    let bytes = std::fs::read(src).map_err(|_| "font.err.unreadable".to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("font");
    let tag = be32(&bytes, 0).ok_or("font.err.invalid")?;

    let (format, base) = match tag {
        0x0001_0000 | 0x7472_7565 => ("ttf", Some(0usize)), // TrueType outlines
        0x4F54_544F => ("otf", Some(0usize)),               // OTTO — CFF outlines
        0x7474_6366 => {
            // ttcf — a collection. The first font in it is the one a single @font-face can use.
            let first = be32(&bytes, 12).ok_or("font.err.invalid")? as usize;
            ("ttc", Some(first))
        }
        0x774F_4646 => ("woff", None),  // wOFF
        0x774F_4632 => ("woff2", None), // wOF2
        _ => return Err("font.err.invalid".into()),
    };

    // The extension must agree with what the bytes say, or the file has been renamed. `.otf` files
    // legitimately carry TrueType outlines and `.ttf` files CFF ones, so that pair is allowed both
    // ways; everything else is a mismatch worth refusing.
    let agrees = matches!(
        (ext.as_str(), format),
        ("ttf", "ttf")
            | ("ttf", "otf")
            | ("ttf", "ttc")
            | ("otf", "otf")
            | ("otf", "ttf")
            | ("otf", "ttc")
            | ("woff", "woff")
            | ("woff2", "woff2")
    );
    if !agrees {
        return Err("font.err.invalid".into());
    }

    match base {
        Some(at) => {
            let (family, style) = sfnt_names(&bytes, at)?;
            match family {
                Some(f) => Ok(FontFacts {
                    family: f,
                    style,
                    format: format.into(),
                    named_by_font: true,
                }),
                // Parsed cleanly, named nothing. The stem is the honest fallback, and the flag says so.
                None => Ok(FontFacts {
                    family: family_from_stem(stem),
                    style,
                    format: format.into(),
                    named_by_font: false,
                }),
            }
        }
        // A compressed container: validated as one, but it cannot be asked its name here.
        None => Ok(FontFacts {
            family: family_from_stem(stem),
            style: None,
            format: format.into(),
            named_by_font: false,
        }),
    }
}

/// What a dropped font did.
#[derive(Serialize, Clone, Debug)]
pub struct FontDrop {
    /// `imported` or `duplicate`
    pub outcome: String,
    pub family: String,
    pub style: Option<String>,
    pub format: String,
}

/// The drop path: validate, then register under the family the FILE names, and say which happened.
///
/// Deduplication is `import_named`'s, unchanged — "does this installation already have this family?"
/// is the same question the renderer asks when it resolves a هيئة, and `fonts.ts` registers one
/// `@font-face` per family, so a second file under a family already present would add a row, a file
/// and a byte count while changing nothing anyone can see.
pub fn import_dropped(
    conn: &Connection,
    app_data_dir: &Path,
    src_path: &str,
) -> Result<FontDrop, String> {
    let facts = inspect(src_path)?;
    let made = import_named(conn, app_data_dir, src_path, &facts.family)?;
    Ok(FontDrop {
        outcome: if made.is_some() { "imported".into() } else { "duplicate".into() },
        family: facts.family,
        style: facts.style,
        format: facts.format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A minimal but REAL sfnt: a version tag, a one-entry table directory, and a `name` table
    /// carrying one Windows/US-English record. Built by hand rather than shipped as a binary fixture
    /// so the bytes under test are visible in the test itself — and so a change to the parser is
    /// checked against the format, not against a file nobody can read.
    fn sfnt(tag: u32, name_id: u16, family: &str) -> Vec<u8> {
        let utf16: Vec<u8> = family.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        let mut out = Vec::new();
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes()); // numTables
        out.extend_from_slice(&[0u8; 6]); // searchRange / entrySelector / rangeShift
        let name_off: u32 = 28; // 12 header + 16 one record
        let name_len: u32 = (6 + 12 + utf16.len()) as u32;
        out.extend_from_slice(b"name");
        out.extend_from_slice(&0u32.to_be_bytes()); // checksum
        out.extend_from_slice(&name_off.to_be_bytes());
        out.extend_from_slice(&name_len.to_be_bytes());
        // ---- the name table ----
        out.extend_from_slice(&0u16.to_be_bytes()); // format
        out.extend_from_slice(&1u16.to_be_bytes()); // count
        out.extend_from_slice(&18u16.to_be_bytes()); // stringOffset = 6 + 12
        out.extend_from_slice(&3u16.to_be_bytes()); // platformID: Windows
        out.extend_from_slice(&1u16.to_be_bytes()); // encodingID: UCS-2
        out.extend_from_slice(&0x0409u16.to_be_bytes()); // language: US English
        out.extend_from_slice(&name_id.to_be_bytes());
        out.extend_from_slice(&(utf16.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes()); // offset into the string storage
        out.extend_from_slice(&utf16);
        // `inspect` refuses anything under 128 bytes as too small to be a font; pad past that.
        while out.len() < 200 {
            out.push(0);
        }
        out
    }

    /// The file keeps EXACTLY the name the test gives it — the uniqueness goes in a directory above
    /// it. Two of these tests are about the family derived from a filename, so a prefix on the file
    /// would be measuring the harness rather than the code.
    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sard-fonttest-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn reads_the_family_from_the_font_and_not_from_the_filename() {
        // THE DEFECT THIS PINS. The family used to be the file STEM with weight words stripped, so a
        // face renamed `notes.ttf` was imported under the family "notes" — a name no renderer, no
        // هيئة and no other installation would ever agree with.
        let p = write_temp("notes.ttf", &sfnt(0x0001_0000, 1, "Amiri Quran"));
        let facts = inspect(p.to_str().unwrap()).expect("a real sfnt is a font");
        assert_eq!(facts.family, "Amiri Quran");
        assert!(facts.named_by_font);
        assert_eq!(facts.format, "ttf");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn prefers_the_typographic_family_where_the_font_carries_one() {
        // Name ID 16 is the pair a renderer groups by; 1 is the legacy name every font carries.
        let p = write_temp("typo.ttf", &sfnt(0x0001_0000, 16, "IBM Plex Sans Arabic"));
        let facts = inspect(p.to_str().unwrap()).unwrap();
        assert_eq!(facts.family, "IBM Plex Sans Arabic");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn refuses_a_renamed_file_that_is_not_a_font() {
        // The whole reason the extension cannot be trusted: this is what a reader drops by accident.
        let mut text = b"This is a note, not a font. ".to_vec();
        while text.len() < 300 {
            text.push(b'x');
        }
        let p = write_temp("renamed.ttf", &text);
        assert_eq!(inspect(p.to_str().unwrap()).unwrap_err(), "font.err.invalid");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn refuses_a_truncated_font() {
        // A real header whose table directory runs off the end — a half-copied file.
        let mut bytes = sfnt(0x0001_0000, 1, "Cut Short");
        bytes.truncate(140);
        // Claim far more tables than the bytes can hold.
        bytes[4] = 0x00;
        bytes[5] = 0x40;
        let p = write_temp("cut.ttf", &bytes);
        assert!(inspect(p.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn refuses_a_file_too_small_to_be_a_font() {
        let p = write_temp("tiny.ttf", b"\x00\x01\x00\x00 short");
        assert_eq!(inspect(p.to_str().unwrap()).unwrap_err(), "font.err.invalid");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn refuses_an_extension_the_bytes_disagree_with() {
        // sfnt bytes wearing a `.woff` name. The container check is what catches it.
        let p = write_temp("liar.woff", &sfnt(0x0001_0000, 1, "Not A Woff"));
        assert_eq!(inspect(p.to_str().unwrap()).unwrap_err(), "font.err.invalid");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn refuses_a_format_sard_does_not_take() {
        let p = write_temp("art.png", &sfnt(0x0001_0000, 1, "Whatever"));
        assert_eq!(inspect(p.to_str().unwrap()).unwrap_err(), "font.err.type");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn accepts_otto_outlines_and_says_so() {
        let p = write_temp("cff.otf", &sfnt(0x4F54_544F, 1, "Some CFF Face"));
        let facts = inspect(p.to_str().unwrap()).unwrap();
        assert_eq!(facts.format, "otf");
        assert_eq!(facts.family, "Some CFF Face");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn a_compressed_container_is_accepted_but_names_itself_from_the_filename() {
        // The honest limitation, pinned so it cannot be misread as metadata identity: a `.woff2` is
        // brotli from byte 0 and this tree carries no decompressor, so the family is the stem and
        // `named_by_font` says as much.
        let mut bytes = b"wOF2".to_vec();
        while bytes.len() < 300 {
            bytes.push(0);
        }
        let p = write_temp("My Face-Regular.woff2", &bytes);
        let facts = inspect(p.to_str().unwrap()).unwrap();
        assert_eq!(facts.format, "woff2");
        assert_eq!(facts.family, "My Face");
        assert!(!facts.named_by_font);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn a_font_that_names_nothing_still_imports_under_its_filename() {
        // No `name` table at all: a legal, if unusual, font. It must not be refused — the renderer
        // can still draw with it — and the stem is the only label available.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        bytes.extend_from_slice(&1u16.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 6]);
        bytes.extend_from_slice(b"glyf");
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&28u32.to_be_bytes());
        bytes.extend_from_slice(&4u32.to_be_bytes());
        while bytes.len() < 200 {
            bytes.push(0);
        }
        let p = write_temp("Nameless-Bold.ttf", &bytes);
        let facts = inspect(p.to_str().unwrap()).unwrap();
        assert_eq!(facts.family, "Nameless");
        assert!(!facts.named_by_font);
        let _ = std::fs::remove_file(p);
    }
}
