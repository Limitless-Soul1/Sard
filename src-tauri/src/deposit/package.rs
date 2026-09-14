//! The deposit archive — writing it.
//!
//! A zip whose only required member is `deposit.json`. The manifest text is produced and shown by the
//! frontend and written VERBATIM: what the sender read in the preview is byte-for-byte what leaves.
//! The two optional members are ordinary files — a book and a cover — so unzipping a deposit yields a
//! readable document beside a readable book, not a blob.
//!
//! # Reading one
//!
//! `inspect` returns the manifest text and CHANGES NOTHING — the reader sees what a file contains
//! before any of it enters. `read_member` hands back one member's bytes so a preview can DRAW what is
//! arriving rather than name it. Both treat the archive as a stranger's: every ceiling here is the one
//! the equivalent file already faces elsewhere in Sard, so a deposit is never a way around a limit.

use std::io::{Read, Write};

use sha2::{Digest, Sha256};
use std::path::Path;

/// The format version this build writes.
///
/// The rule the profile package already proved: NEWER IS REFUSED, OLDER IS ACCEPTED. A deposit from a
/// future Sard may carry meaning this version cannot see, and importing it would silently discard it;
/// an older one is safe by construction, because absence is how every optional field spells its
/// default.
pub const DEPOSIT_VERSION: u64 = 1;

pub const MANIFEST_NAME: &str = "deposit.json";
pub const BOOK_DIR: &str = "book/";
pub const COVER_DIR: &str = "cover/";

/// The manifest ceiling. The same number the profile package uses, for the same reason: it bounds the
/// document a stranger can hand the parser, and it bounds the mark count implicitly — which is a
/// better rule than inventing a maximum number of highlights.
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// NOT A NEW NUMBER. It is the ceiling a book already faces arriving through the file picker, so a
/// deposit is not a way around a limit the reader would otherwise have met.
pub const MAX_BOOK_BYTES: u64 = 256 * 1024 * 1024;

/// A COVER IS AN IMAGE, AND IS READ BEFORE ANYTHING IS ACCEPTED.
///
/// The sheet draws the arriving cover so the reader can see what he is being given, which means a
/// stranger's file gets to allocate this much before he has agreed to anything. The book's own ceiling
/// is far too generous for that: the largest cover measured across a real shelf was under 3 MB, so
/// sixteen leaves every honest cover untouched and refuses the rest.
pub const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

/// A file that travels inside the deposit, and where it lives.
pub struct MemberIn<'a> {
    pub member: &'a str,
    pub source: &'a str,
}

/// Write a deposit to the path the sender chose.
pub fn export(
    path: &str,
    manifest_json: &str,
    book: Option<MemberIn<'_>>,
    cover: Option<MemberIn<'_>>,
) -> Result<(), String> {
    if manifest_json.len() > MAX_MANIFEST_BYTES {
        return Err("dep.err.tooLarge".into());
    }
    // The member names are computed by `plan`, but they arrive back through the frontend, so they are
    // checked here anyway: a name that climbs out of its folder is refused rather than written.
    for m in [book.as_ref(), cover.as_ref()].into_iter().flatten() {
        let ok = (m.member.starts_with(BOOK_DIR) || m.member.starts_with(COVER_DIR))
            && !m.member.contains("..");
        if !ok {
            return Err("dep.err.badMember".into());
        }
    }

    let file = std::fs::File::create(path).map_err(|e| format!("dep.err.write:{e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file(MANIFEST_NAME, opts)
        .map_err(|e| format!("dep.err.write:{e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("dep.err.write:{e}"))?;

    for m in [book, cover].into_iter().flatten() {
        let src = Path::new(m.source);
        let len = std::fs::metadata(src).map(|x| x.len()).unwrap_or(0);
        if len > MAX_BOOK_BYTES {
            return Err("dep.err.bookTooLarge".into());
        }
        let mut f = std::fs::File::open(src).map_err(|e| format!("dep.err.read:{e}"))?;
        zip.start_file(m.member, opts)
            .map_err(|e| format!("dep.err.write:{e}"))?;
        // Copied file-to-file with a ceiling: a book's bytes never cross the IPC boundary, and a
        // source that grows under us cannot run away with the disk.
        let written = std::io::copy(&mut std::io::Read::by_ref(&mut f).take(MAX_BOOK_BYTES + 1), &mut zip)
            .map_err(|e| format!("dep.err.write:{e}"))?;
        if written > MAX_BOOK_BYTES {
            return Err("dep.err.bookTooLarge".into());
        }
    }

    zip.finish().map_err(|e| format!("dep.err.write:{e}"))?;
    Ok(())
}

/// The manifest text, read and bounded. Nothing is parsed, unpacked or written.
///
/// The size is checked TWICE — against what the zip entry declares, and against what was actually
/// read — because a declared size is a stranger's claim, not a fact.
pub fn inspect(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("dep.err.read:{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "dep.err.notSard".to_string())?;
    let mut entry = zip
        .by_name(MANIFEST_NAME)
        .map_err(|_| "dep.err.notSard".to_string())?;
    if entry.size() as usize > MAX_MANIFEST_BYTES {
        return Err("dep.err.tooLarge".into());
    }
    let mut text = String::new();
    std::io::Read::take(&mut entry, MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "dep.err.unreadable".to_string())?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err("dep.err.tooLarge".into());
    }
    Ok(text)
}

/// One member's bytes, so a preview can draw a cover instead of naming a file.
///
/// The member name comes from the MANIFEST, which is a stranger's string: anything that is not inside
/// the two folders, or that climbs out of them, is refused rather than read.
pub fn read_member(path: &str, member: &str) -> Result<Vec<u8>, String> {
    if !(member.starts_with(BOOK_DIR) || member.starts_with(COVER_DIR)) || member.contains("..") {
        return Err("dep.err.badMember".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("dep.err.read:{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "dep.err.notSard".to_string())?;
    let mut entry = zip.by_name(member).map_err(|_| "dep.err.noMember".to_string())?;
    // Each folder answers to its own ceiling: a book may be large because a book is large; a cover is
    // drawn before the reader has accepted anything, so it may not be.
    let cap = if member.starts_with(COVER_DIR) { MAX_COVER_BYTES } else { MAX_BOOK_BYTES };
    if entry.size() > cap {
        return Err("dep.err.bookTooLarge".into());
    }
    let mut buf = Vec::new();
    std::io::Read::take(&mut entry, cap + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "dep.err.unreadable".to_string())?;
    if buf.len() as u64 > cap {
        return Err("dep.err.bookTooLarge".into());
    }
    Ok(buf)
}

/// THE BOOK, VERIFIED AGAINST ITS OWN NAME.
///
/// `book.hash` IS the sha-256 of the file's bytes — that is what a book's id means in Sard — so the
/// integrity check is free and exact: extract, hash, compare. A member whose bytes do not hash to the
/// hash the manifest declares is refused, and the rest of the deposit is still perfectly usable.
pub fn extract_verified_book(path: &str, member: &str, hash: &str) -> Result<Vec<u8>, String> {
    let bytes = read_member(path, member)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    let got: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != hash.to_ascii_lowercase() {
        return Err("dep.err.bookMismatch".into());
    }
    Ok(bytes)
}

/// THE TRUST BOUNDARY, in Rust, deliberately duplicating what TypeScript already checks.
///
/// The full validator is in TS and is total and forgiving, so every rule is unit-testable there. This
/// re-checks only what makes a WRITE safe, because a boundary that holds solely because the caller was
/// well behaved is not a boundary. It checks:
///
///   · it is a JSON object at all;
///   · it does not claim a format newer than this build understands;
///   · it carries a `book.hash` that is a real sha-256 and nothing else;
///   · any member name it points at lives inside the two folders and cannot climb out.
pub fn validate(manifest_json: &str) -> Result<serde_json::Value, String> {
    if manifest_json.len() > MAX_MANIFEST_BYTES {
        return Err("dep.err.tooLarge".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(manifest_json).map_err(|_| "dep.err.unreadable".to_string())?;
    let o = v.as_object().ok_or("dep.err.unreadable")?;

    // A file that does not claim to be a deposit is not one. Checked BEFORE the version, so a random
    // document is refused as foreign rather than as "from a newer Sard".
    let version = o.get("deposit").and_then(|x| x.as_u64()).ok_or("dep.err.notSard")?;
    // NEWER IS REFUSED, OLDER IS NOT. A deposit from a future Sard may carry meaning this build cannot
    // see, and importing it would silently discard it.
    if version > DEPOSIT_VERSION {
        return Err("dep.err.newer".into());
    }

    let book = o.get("book").and_then(|x| x.as_object()).ok_or("dep.err.badBook")?;
    let hash = book.get("hash").and_then(|x| x.as_str()).unwrap_or("");
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("dep.err.badBook".into());
    }
    for key in ["file", "cover"] {
        if let Some(m) = book.get(key).and_then(|x| x.as_str()) {
            if !(m.starts_with(BOOK_DIR) || m.starts_with(COVER_DIR)) || m.contains("..") {
                return Err("dep.err.badMember".into());
            }
        }
    }
    Ok(v)
}

/// The identity of a deposit: the sha-256 of the manifest exactly as it was read.
pub fn deposit_id(manifest_json: &str) -> String {
    let mut h = Sha256::new();
    h.update(manifest_json.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("sard-dep-test-{}-{}", std::process::id(), name));
        p.to_string_lossy().to_string()
    }

    #[test]
    fn a_deposit_is_a_zip_whose_manifest_is_written_verbatim() {
        let out = tmp("verbatim.zip");
        let text = "{\"deposit\":1,\"book\":{\"hash\":\"abc\"}}";
        export(&out, text, None, None).unwrap();
        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        let mut s = String::new();
        zip.by_name(MANIFEST_NAME).unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, text);
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn a_member_that_climbs_out_of_its_folder_is_refused() {
        let out = tmp("climb.zip");
        let src = tmp("climb-src.epub");
        std::fs::write(&src, b"x").unwrap();
        let err = export(
            &out,
            "{}",
            Some(MemberIn { member: "book/../../escape.epub", source: &src }),
            None,
        )
        .unwrap_err();
        assert_eq!(err, "dep.err.badMember");
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn a_member_outside_the_two_folders_is_refused() {
        let out = tmp("outside.zip");
        let src = tmp("outside-src.epub");
        std::fs::write(&src, b"x").unwrap();
        let err = export(&out, "{}", Some(MemberIn { member: "anywhere.epub", source: &src }), None)
            .unwrap_err();
        assert_eq!(err, "dep.err.badMember");
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn an_oversized_manifest_is_refused_before_anything_is_written() {
        let out = tmp("big.zip");
        let big = "x".repeat(MAX_MANIFEST_BYTES + 1);
        assert_eq!(export(&out, &big, None, None).unwrap_err(), "dep.err.tooLarge");
        assert!(!Path::new(&out).exists());
    }

    #[test]
    fn the_book_travels_beside_the_manifest() {
        let out = tmp("book.zip");
        let src = tmp("book-src.epub");
        std::fs::write(&src, b"PK-not-really-but-bytes").unwrap();
        export(
            &out,
            "{\"deposit\":1}",
            Some(MemberIn { member: "book/abc.epub", source: &src }),
            None,
        )
        .unwrap();
        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        let mut b = Vec::new();
        zip.by_name("book/abc.epub").unwrap().read_to_end(&mut b).unwrap();
        assert_eq!(b, b"PK-not-really-but-bytes");
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&out).ok();
    }
}

#[cfg(test)]
mod cover_ceiling_tests {
    use super::*;

    #[test]
    fn a_cover_answers_to_a_tighter_ceiling_than_a_book() {
        // The sheet draws a cover before anything is accepted, so a stranger must not be able to make
        // it allocate what a whole book may.
        assert!(MAX_COVER_BYTES < MAX_BOOK_BYTES);
        // ...and still generous: the largest cover measured on a real shelf was under 3 MB.
        assert!(MAX_COVER_BYTES >= 8 * 1024 * 1024);
    }

    #[test]
    fn a_member_outside_the_two_folders_is_never_read() {
        for bad in ["deposit.json", "../secret", "cover/../../secret", "elsewhere/cover.jpg"] {
            assert_eq!(read_member("nonexistent.zip", bad).unwrap_err(), "dep.err.badMember");
        }
    }
}
