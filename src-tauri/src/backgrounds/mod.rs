//! Backgrounds (RAWY-265, Phase 1) — managed user images for the Library and Reading surfaces.
//!
//! An imported image is copied into `<app_data>/backgrounds/` (served to the WebView via the asset
//! protocol, which is scoped to `$APPDATA/**`) and recorded in the `backgrounds` table. Copying is
//! NOT a style choice: an image referenced where the user left it would be outside the asset scope
//! and simply would not load — and it would break the moment they moved or deleted the file.
//!
//! ## The "never recompress" guarantee, and how a derivative honours it (spec §7.2)
//!
//! The imported file is copied BYTE-FOR-BYTE and is never modified. For the overwhelming majority of
//! images that is the whole story: if the longest edge is at or below `MAX_EDGE` and there is no EXIF
//! rotation to bake in, `derivative_path` stays NULL and the ORIGINAL is what gets rendered. No
//! resample, no re-encode, nothing.
//!
//! A derivative is written only in two cases, and it is ALWAYS a lossless PNG — no lossy re-encode
//! happens at any point, for any image:
//!   1. The source exceeds `MAX_EDGE`. Decoded cost is `W × H × 4` REGARDLESS of file size, so a
//!      24 MP phone photo costs ~96 MB of RAM per surface while being unable to show more detail than
//!      the display has pixels. Lanczos3 down to the ceiling is the whole reason the feature does not
//!      regress memory on a machine that is also running a WebView, an EPUB engine and a TTS sidecar.
//!   2. The source carries a non-identity EXIF orientation. This is baked into the derivative rather
//!      than left to the renderer DELIBERATELY: whether WebView2 honours EXIF for a CSS
//!      `background-image` (as opposed to an `<img>`) is not something this feature should depend on,
//!      and "verify then hope" is not a guarantee. Baking it makes orientation correct BY
//!      CONSTRUCTION on every engine, and costs nothing because the derivative is lossless.
//!
//! The derivative is a CACHE: regenerable, deletable, never authoritative.
//!
//! ## Why the surface bindings are plain settings keys, not columns here
//!
//! `bg_library_id` / `bg_reading_id` hold which background each surface uses. They are plain strings
//! so `gc()` can read them WITHOUT parsing the frontend-owned parameter JSON. That makes "zero
//! orphans" (D31) a property of the schema — every row named by no reference source is unreferenced
//! and its files go — rather than a promise the UI has to remember to keep.
//!
//! There are now THREE reference sources, not two: those two settings keys, and the `bg_library` /
//! `bg_reading` columns on `profiles`. A profile keeps its pair as columns for the same reason the
//! surfaces keep theirs as plain keys — so the collector can see them without parsing JSON. Anything
//! that becomes a fourth source must be added to `gc()` in the same breath as the write path that
//! creates it: `gc()` runs inside `set_surface()`, so an unknown reference is not a latent problem,
//! it is a deleted image the next time any surface is bound.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageReader};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// The render ceiling (spec §7.2). **DO NOT RAISE THIS WITHOUT NEW MEASUREMENT (RAWY-278).**
///
/// The original justification here was memory — "a source cannot show more detail than the display
/// has pixels, but it costs `W × H × 4`". That is true and it is the WEAKER half of the argument.
/// RAWY-278 measured the real one: **there is a RENDERING CLIFF, and this constant is what keeps the
/// app on the safe side of it.**
///
/// MEASURED on the WebView2 runtime's own Chromium (Edge 150.0.4078.105 — the same build as the
/// installed WebView2 runtime, verified), RTX 3060 Ti, vsync-locked at 240 Hz so the frame budget was
/// 4.16 ms. One image, one aspect ratio, only the long edge varied; scrolling text over the blurred
/// desk layer:
///
/// | long edge |     MP | decoded  | scroll fps | worst frame |
/// |-----------|--------|----------|------------|-------------|
/// |  **3840** |   8.85 |  33.8 MiB|    **240** |  **4.4 ms** |
/// |      5120 |  15.73 |  60.0 MiB|        240 |      4.4 ms |
/// |      6656 |  26.58 | 101.4 MiB|        240 |      4.3 ms |
/// |      7680 |  33.18 | 126.6 MiB|        240 |      4.3 ms |
/// |     10240 |  62.92 | 240.0 MiB|        240 |      4.3 ms |
/// |     12288 |  90.61 | 345.7 MiB|    **1.9** | **891.9 ms**|
/// |     13884 | 115.68 | 441.3 MiB|    **1.1** | **916.8 ms**|
///
/// It is a CLIFF, not a slope: everything up to 10240 held 240 Hz with not one frame missed, and the
/// next step down renders at 1–2 fps — an unusable application, not a slower one. So there is no
/// "warn the user and let them choose" middle ground here, and no gentle degradation to lean on.
///
/// CAUSE, measured rather than assumed: at 7680 the GPU process holds ~245 MB (the image IS a
/// texture); at 13884 the GPU process holds only ~103 MB while the RENDERER process holds ~800 MB —
/// the bitmap never becomes a GPU texture and is composited on the CPU every frame. It is NOT a
/// `MAX_TEXTURE_SIZE` refusal (that was 16384, and 13884 fits). Chromium stops GPU-residency
/// somewhere between 240 MiB and 346 MiB of decoded bitmap.
///
/// 3840 therefore sits **2.67× below the measured cliff** and already exceeds every shipping display.
/// The safe region ends abruptly and without warning, so the margin is the point: raising this toward
/// 10240 would buy no visible quality (the source is being downscaled to fit a window an order of
/// magnitude smaller) while spending the entire safety margin. Re-measure the ladder before touching it.
const MAX_EDGE: u32 = 3840;

/// Hard guards applied BEFORE any decode, so a decode bomb is refused by its header rather than by
/// exhausting memory — a 50000² PNG declares 2.5 gigapixels in about 1 KB.
///
/// **WHY A HARD LIMIT AND NOT A WARNING:** in Rust an allocation failure is not a catchable error. It
/// calls `handle_alloc_error` → `abort()`. There is no `bg.err.*`, no dialog, no recovery — the
/// process simply disappears. RAWY-273 made the DB mutex survive PANICS; an OOM abort is not a panic
/// and nothing survives it. A warning cannot catch a process abort, so the guard has to be a refusal.
///
/// **RAWY-278 raised `MAX_SOURCE_PIXELS` 80 MP → 140 MP.** The old value was a round number, not a
/// measured threshold, and it refused legitimate wallpapers. What made raising it safe is that the
/// two ceilings are DECOUPLED: every accepted source is resampled to `MAX_EDGE`, so the bitmap the
/// WebView ever holds is bounded at `MAX_EDGE² × 4` = 56.25 MiB per surface REGARDLESS of source
/// size. Measured: a 115.68 MP source and a 2.21 MP source produce identical frame times (240 Hz,
/// worst frame 4.3 ms, zero dropped frames), indistinguishable from having no background at all. So
/// source pixels cost nothing at render time; they cost only the ONE-TIME IMPORT TRANSIENT, and that
/// transient is the only thing this constant has to bound.
///
/// MEASURED transient (release, three real images; peak is reached inside the Lanczos3 resample):
///   29.12 MP →  345.5 MB · 80.05 MP →  795.8 MB · 115.68 MP → 1004.4 MB
/// Validated within 8% by `file_bytes + W·H·bpp + 16 · MAX_EDGE · min(W,H)` — that last term is the
/// resampler's f32 scratch buffer, which is LARGER than the decoded image itself and is what actually
/// dominates. The worst case at any budget is therefore a SQUARE source; at 140 MP that is ~1.29 GB,
/// against the ~870 MB the old 80 MP limit already authorised.
///
/// 140 MP admits a full 16K UHD frame (15360 × 8640 = 132.7 MP) — a real ceiling with a name rather
/// than another round number — and still refuses the pathological case by a factor of ~18.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 140_000_000;

/// Settings keys holding each surface's chosen background id. Read by `gc()`; see the module note.
pub const KEY_LIBRARY_ID: &str = "bg_library_id";
pub const KEY_READING_ID: &str = "bg_reading_id";
const SURFACE_KEYS: [&str; 2] = [KEY_LIBRARY_ID, KEY_READING_ID];

#[derive(Serialize, Clone, Debug)]
pub struct Background {
    pub id: String,
    /// Absolute path to the byte-for-byte copy of what the user chose.
    pub original_path: String,
    /// Absolute path to the lossless derivative, or `None` = "render the original".
    pub derivative_path: Option<String>,
    pub source_name: Option<String>,
    /// ORIGINAL dimensions, after any EXIF orientation is resolved.
    pub width: i64,
    pub height: i64,
    /// 0..1 mean relative luminance; drives the "arrive correct" initial Presence (spec §10.2).
    pub mean_luma: Option<f64>,
    pub added_at: i64,
}

/// Error codes, not prose. The frontend maps these to localised strings (both locales, parity
/// enforced) and falls back to the raw code if one is ever unmapped. Returning English sentences from
/// Rust — as the older `font_import` does — would put user-facing copy outside the i18n system.
mod err {
    pub const IO: &str = "bg.err.io";
    pub const TOO_BIG_FILE: &str = "bg.err.fileTooLarge";
    pub const TOO_MANY_PIXELS: &str = "bg.err.tooManyPixels";
    pub const FORMAT: &str = "bg.err.format";
    pub const ANIMATED: &str = "bg.err.animated";
    pub const HEIC: &str = "bg.err.heic";
    pub const VECTOR: &str = "bg.err.vector";
    pub const DECODE: &str = "bg.err.decode";
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn dir_of(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("backgrounds")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fmt {
    Jpeg,
    Png,
    Webp,
}

impl Fmt {
    fn ext(self) -> &'static str {
        match self {
            Fmt::Jpeg => "jpg",
            Fmt::Png => "png",
            Fmt::Webp => "webp",
        }
    }
}

/// Identify the payload from its MAGIC BYTES, never from the filename extension — a `.jpg` that is
/// really a HEIC is exactly the case that would otherwise reach the decoder and fail obscurely.
///
/// Rejections are SPECIFIC because a generic "unsupported" is useless to the person holding the file.
/// HEIC gets its own code: it is what an iPhone photo actually is, neither WebView2 nor the `image`
/// crate decodes it, and silently failing on a phone photo would be the worst first-run this feature
/// could have. Animation gets its own code because a looping background in a reader is battery,
/// distraction and per-frame compositing — a refusal to be explained, not a format we merely lack.
fn sniff(b: &[u8]) -> Result<Fmt, String> {
    if b.len() < 16 {
        return Err(err::FORMAT.into());
    }
    // JPEG — SOI + marker. JPEG has no animated variant to screen for.
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok(Fmt::Jpeg);
    }
    // PNG — screen for APNG, whose `acTL` chunk precedes the first `IDAT`.
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return if png_is_animated(b) { Err(err::ANIMATED.into()) } else { Ok(Fmt::Png) };
    }
    // WebP — RIFF container. The extended header (`VP8X`) carries an ANIMATION flag, and an animated
    // file also carries an `ANIM` chunk; check both so a malformed flag cannot smuggle one through.
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return if webp_is_animated(b) { Err(err::ANIMATED.into()) } else { Ok(Fmt::Webp) };
    }
    // GIF — outside the accepted set entirely (spec §9), animated or not.
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Err(err::ANIMATED.into());
    }
    // HEIC/HEIF — an ISO-BMFF `ftyp` box at offset 4 with a HEIF brand.
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        const HEIF: [&[u8; 4]; 6] = [b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"];
        if HEIF.iter().any(|k| *k == brand) {
            return Err(err::HEIC.into());
        }
    }
    // SVG — refused for unbounded rasterisation cost, and because it is not a photograph.
    let head = &b[..b.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.starts_with("<?xml") || trimmed.starts_with("<svg") {
        return Err(err::VECTOR.into());
    }
    Err(err::FORMAT.into())
}

/// Walk PNG chunks looking for `acTL` before the first `IDAT` (the APNG animation control chunk).
fn png_is_animated(b: &[u8]) -> bool {
    let mut i = 8usize; // past the signature
    while i + 8 <= b.len() {
        let len = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let kind = &b[i + 4..i + 8];
        if kind == b"acTL" {
            return true;
        }
        if kind == b"IDAT" || kind == b"IEND" {
            return false;
        }
        // length + type + data + crc; saturating so a corrupt length cannot wrap the cursor.
        i = match i.checked_add(12).and_then(|n| n.checked_add(len)) {
            Some(n) => n,
            None => return false,
        };
    }
    false
}

/// A WebP is animated when the `VP8X` feature byte sets bit 1 (ANIMATION) or an `ANIM` chunk exists.
fn webp_is_animated(b: &[u8]) -> bool {
    if b.len() >= 21 && &b[12..16] == b"VP8X" && (b[20] & 0x02) != 0 {
        return true;
    }
    let mut i = 12usize;
    while i + 8 <= b.len() {
        let kind = &b[i + 4..i + 8];
        if kind == b"ANIM" || kind == b"ANMF" {
            return true;
        }
        let len = u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let padded = len + (len & 1); // RIFF chunks are even-aligned
        i = match i.checked_add(8).and_then(|n| n.checked_add(padded)) {
            Some(n) => n,
            None => return false,
        };
    }
    false
}

/// Content-addressed id: the same photo imported twice reuses one file and one row (spec §7.4), the
/// same rule the EPUB import uses. 16 bytes of SHA-256 is ample for a per-profile registry.
fn content_id(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Mean RELATIVE luminance over a thumbnail (spec §10.2). Thumbnailing first is what makes this cheap
/// — the answer is a whole-image average, so sampling 64² instead of 24 MP changes the third decimal
/// at most. The per-channel linearisation matches the sRGB curve used by `lib/highlightInk.ts`, so
/// "luminance" means the same thing on both sides of the IPC boundary.
fn mean_luma(img: &DynamicImage) -> f64 {
    let small = img.thumbnail(64, 64).to_rgb8();
    let n = (small.width() as f64) * (small.height() as f64);
    if n == 0.0 {
        return 0.5;
    }
    let lin = |c: u8| -> f64 {
        let s = c as f64 / 255.0;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    let sum: f64 = small
        .pixels()
        .map(|p| 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]))
        .sum();
    (sum / n).clamp(0.0, 1.0)
}

/// Decode, resolving EXIF orientation into the pixels. Returns the image and whether a non-identity
/// orientation was applied (which alone forces a derivative — see the module note).
fn decode_oriented(bytes: &[u8]) -> Result<(DynamicImage, bool), String> {
    let cursor = std::io::Cursor::new(bytes);
    let reader = ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|_| err::DECODE.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|_| err::DECODE.to_string())?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|_| err::DECODE.to_string())?;
    let rotated = orientation != image::metadata::Orientation::NoTransforms;
    if rotated {
        img.apply_orientation(orientation);
    }
    Ok((img, rotated))
}

/// Read just the header for dimensions, so an over-large source is refused before it is decoded.
fn probe_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let cursor = std::io::Cursor::new(bytes);
    ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|_| err::DECODE.to_string())?
        .into_dimensions()
        .map_err(|_| err::DECODE.to_string())
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Background> {
    Ok(Background {
        id: r.get(0)?,
        original_path: r.get(1)?,
        derivative_path: r.get(2)?,
        source_name: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        mean_luma: r.get(6)?,
        added_at: r.get(7)?,
    })
}

const SELECT: &str = "SELECT id, original_path, derivative_path, source_name, width, height, \
                      mean_luma, added_at FROM backgrounds";

pub fn get(conn: &Connection, id: &str) -> Result<Option<Background>, String> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], row_from)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<Background>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT} ORDER BY added_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_from)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Are this row's managed files actually on disk? A profile restored from a partial backup, an
/// antivirus quarantine or a cleared app-data can leave the row without its bytes. The import path
/// uses this so a re-import REPAIRS such a row instead of returning a dedup hit that cannot render.
fn files_present(row: &Background) -> bool {
    if !Path::new(&row.original_path).exists() {
        return false;
    }
    match &row.derivative_path {
        Some(p) => Path::new(p).exists(),
        None => true,
    }
}

// ---------------------------------------------------------------------------------------------
// RAWY-FINAL — the import is split into three stages so the HEAVY one can run WITHOUT the DB lock.
//
// THE DEFECT. `background_choose` is correctly `async` (its doc-comment explains why at length), but
// its body took `state.db.lock()` and then ran the whole of `import` — decode, `mean_luma`, a Lanczos3
// resample of up to 80 MP, and a lossless PNG encode — while HOLDING that guard. `AppState.db` is the
// app's ONE connection, and every other DB command is SYNCHRONOUS, i.e. runs on the main thread. So
// the moment any of them fired during the resample (`settings_set` on every preference write — the
// background's own params slider included — `progress_save` on the reader's 500 ms debounce,
// `library_list_books`) the main thread blocked on the mutex and the window froze anyway. `async`
// moved the CPU off the main thread; it did not move the CONTENTION, which is what the freeze is.
//
// WHY THE FILE WRITES STAY UNDER THE LOCK. `gc()` deletes any file in `backgrounds/` that no row
// names ("best-effort tidy"). Writing the managed copy before the row exists, with the lock released,
// would let a concurrent `set_surface` collect the image the user just chose — the exact class of race
// `choose()` was written to close. So stage 2 encodes into MEMORY and stage 3 writes + INSERTs under
// one lock. The window is closed by construction, not by being short.
// ---------------------------------------------------------------------------------------------

/// Stage 1 — read, identify, size-guard, content-address. No DB, no writes, no decode.
pub struct Prepared {
    bytes: Vec<u8>,
    fmt: Fmt,
    id: String,
    source_name: Option<String>,
}

impl Prepared {
    /// The content id, so the caller can run the dedup check under a BRIEF lock before paying for a
    /// decode it may not need.
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Stage 2 — everything expensive, resolved into memory. Still no DB and still no writes.
pub struct Materialized {
    prep: Prepared,
    width: u32,
    height: u32,
    luma: f64,
    /// The lossless PNG derivative's BYTES, or `None` = "render the original".
    derivative_png: Option<Vec<u8>>,
}

/// Stage 1. Cheap relative to the decode: a file read plus a SHA-256.
pub fn prepare(src_path: &str) -> Result<Prepared, String> {
    let src = Path::new(src_path);
    let meta = std::fs::metadata(src).map_err(|_| err::IO.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(err::TOO_BIG_FILE.into());
    }
    let bytes = std::fs::read(src).map_err(|_| err::IO.to_string())?;

    // Format and animation are decided from the bytes, before anything expensive happens.
    let fmt = sniff(&bytes)?;
    // Dimensions from the header — the decode-bomb guard must not require a decode.
    let (pw, ph) = probe_dimensions(&bytes)?;
    if (pw as u64) * (ph as u64) > MAX_SOURCE_PIXELS {
        return Err(err::TOO_MANY_PIXELS.into());
    }

    let id = content_id(&bytes);
    let source_name = src.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
    Ok(Prepared { bytes, fmt, id, source_name })
}

/// Stage 2 — THE HEAVY ONE. Decode, resolve EXIF orientation, measure luminance, and (only when
/// required) Lanczos3-resample and PNG-encode. Must be called with NO DB lock held.
pub fn materialize(prep: Prepared) -> Result<Materialized, String> {
    let (img, rotated) = decode_oriented(&prep.bytes)?;
    let (w, h) = (img.width(), img.height());
    let luma = mean_luma(&img);

    // A derivative exists only when the source is over the ceiling, or when an EXIF rotation has to be
    // baked in. Otherwise the ORIGINAL is what renders and nothing was resampled at all.
    let oversize = w.max(h) > MAX_EDGE;
    let derivative_png = if oversize || rotated {
        let scaled = if oversize {
            // Lanczos3: the highest-quality resampler the crate offers, and the one the spec names.
            let (tw, th) = if w >= h {
                (MAX_EDGE, ((h as f64) * (MAX_EDGE as f64) / (w as f64)).round().max(1.0) as u32)
            } else {
                (((w as f64) * (MAX_EDGE as f64) / (h as f64)).round().max(1.0) as u32, MAX_EDGE)
            };
            img.resize_exact(tw, th, FilterType::Lanczos3)
        } else {
            img
        };
        // PNG — LOSSLESS. No lossy re-encode happens at any point, for any image (spec §7.2).
        // Encoded to a buffer rather than straight to disk so nothing lands in `backgrounds/` before
        // its row exists (see the note above `Prepared`).
        let mut buf = std::io::Cursor::new(Vec::new());
        scaled
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|_| err::IO.to_string())?;
        Some(buf.into_inner())
    } else {
        None
    };

    Ok(Materialized { prep, width: w, height: h, luma, derivative_png })
}

/// Stage 3 — write the managed files and record the row. MUST hold the DB lock: the write and the
/// INSERT have to be indivisible with respect to `gc()`.
pub fn commit(conn: &Connection, app_data_dir: &Path, mat: Materialized) -> Result<Background, String> {
    let dir = dir_of(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|_| err::IO.to_string())?;

    let id = mat.prep.id;
    // The archival copy: byte-for-byte, never touched again.
    let original = dir.join(format!("{id}.{}", mat.prep.fmt.ext()));
    std::fs::write(&original, &mat.prep.bytes).map_err(|_| err::IO.to_string())?;

    let derivative_path = match mat.derivative_png {
        Some(png) => {
            let out = dir.join(format!("{id}.display.png"));
            std::fs::write(&out, &png).map_err(|_| err::IO.to_string())?;
            Some(out.display().to_string())
        }
        None => None,
    };

    let row = Background {
        id,
        original_path: original.display().to_string(),
        derivative_path,
        source_name: mat.prep.source_name,
        width: mat.width as i64,
        height: mat.height as i64,
        mean_luma: Some(mat.luma),
        added_at: now_unix(),
    };
    conn.execute(
        "INSERT INTO backgrounds(id, original_path, derivative_path, source_name, width, height, \
         mean_luma, added_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            row.id,
            row.original_path,
            row.derivative_path,
            row.source_name,
            row.width,
            row.height,
            row.mean_luma,
            row.added_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(row)
}

/// The dedup check, isolated so the caller can run it under a BRIEF lock. `Ok(Some(row))` = this exact
/// content is already managed and its files are intact, so nothing needs decoding. A row whose files
/// have vanished (a partial restore, an antivirus quarantine) is DELETED here so the caller re-imports
/// over the top — the RAWY-265 repair path, unchanged.
pub fn dedup_or_repair(conn: &Connection, id: &str) -> Result<Option<Background>, String> {
    let Some(existing) = get(conn, id)? else { return Ok(None) };
    if files_present(&existing) {
        return Ok(Some(existing));
    }
    let _ = conn.execute("DELETE FROM backgrounds WHERE id = ?1", [id]);
    Ok(None)
}

/// Copy `src_path` into the managed dir, deduping by content, and record it.
///
/// Retained with its ORIGINAL signature and behaviour — `tests/backgrounds.rs` drives this directly.
/// It is now simply the three stages run back to back under whatever lock the caller already holds.
/// The command path (`background_choose`) runs them SEPARATELY so the heavy stage is unlocked.
pub fn import(conn: &Connection, app_data_dir: &Path, src_path: &str) -> Result<Background, String> {
    let prep = prepare(src_path)?;
    if let Some(existing) = dedup_or_repair(conn, prep.id())? {
        return Ok(existing);
    }
    commit(conn, app_data_dir, materialize(prep)?)
}

/// Delete every background not named by a surface key OR BY A PROFILE, with its files (D31 — zero
/// orphans).
///
/// Enumerating the table and subtracting the two bindings is deliberate: a refcount would drift the
/// first time a write path forgot to decrement, whereas this recomputes the truth from scratch every
/// time it runs. It is cheap (the table holds a handful of rows) and self-healing — a row orphaned by
/// any past bug is collected on the next run.
pub fn gc(conn: &Connection, app_data_dir: &Path) -> Result<usize, String> {
    let mut keep: Vec<String> = Vec::new();
    for k in SURFACE_KEYS {
        let v = crate::settings::get(conn, k).map_err(|e| e.to_string())?;
        if let Some(v) = v {
            if !v.is_empty() {
                keep.push(v);
            }
        }
    }
    // THE THIRD REFERENCE SOURCE, wired here rather than re-queried: `profiles::referenced_backgrounds`
    // has existed since the profiles table did, deliberately unwired until backgrounds could actually
    // enter a profile. That moment is now. It reads the `bg_library` / `bg_reading` COLUMNS, never
    // `data`, so the collector still answers this question without parsing frontend-owned JSON.
    keep.extend(crate::profiles::referenced_backgrounds(conn).map_err(|e| e.to_string())?);
    let mut removed = 0usize;
    for row in list(conn)? {
        if keep.iter().any(|k| *k == row.id) {
            continue;
        }
        let _ = std::fs::remove_file(&row.original_path);
        if let Some(d) = &row.derivative_path {
            let _ = std::fs::remove_file(d);
        }
        conn.execute("DELETE FROM backgrounds WHERE id = ?1", [&row.id])
            .map_err(|e| e.to_string())?;
        removed += 1;
    }
    // Best-effort tidy: an unmanaged stray in the dir (a crash between write and INSERT) is not a DB
    // row and so cannot be found by the loop above.
    let managed: Vec<String> = list(conn)?
        .into_iter()
        .flat_map(|r| {
            let mut v = vec![r.original_path];
            if let Some(d) = r.derivative_path {
                v.push(d);
            }
            v
        })
        .collect();
    if let Ok(entries) = std::fs::read_dir(dir_of(app_data_dir)) {
        for e in entries.flatten() {
            let p = e.path().display().to_string();
            if !managed.iter().any(|m| *m == p) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(removed)
}

/// Import an image AND bind it to a surface as ONE operation.
///
/// This exists because `import` alone leaves the new row UNREFERENCED, and `gc()` — which by design
/// collects anything no surface names — will happily delete it. Verified: importing two images and
/// then binding them one after the other destroyed the second image, because the first `set_surface`
/// ran a GC while the second row was still unbound (`tests/backgrounds.rs`, which caught this).
///
/// Binding writes the key BEFORE the GC runs, so by the time anything can be collected the new row is
/// already referenced and every OTHER surface's key is already on disk. The window is closed by
/// construction rather than by being short — a timing-dependent version of this would be a race that
/// happens to be hard to hit, which is exactly the kind of defect that surfaces in the field.
pub fn choose(
    conn: &Connection,
    app_data_dir: &Path,
    key: &str,
    src_path: &str,
) -> Result<Background, String> {
    let row = import(conn, app_data_dir, src_path)?;
    set_surface(conn, app_data_dir, key, Some(&row.id))?;
    Ok(row)
}

/// Bind a surface to a background (or clear it with `None`), then collect whatever that orphaned.
/// Running the GC HERE — rather than exposing it as a separate call the UI has to remember — is what
/// makes zero-orphans structural.
pub fn set_surface(
    conn: &Connection,
    app_data_dir: &Path,
    key: &str,
    id: Option<&str>,
) -> Result<(), String> {
    if !SURFACE_KEYS.contains(&key) {
        return Err("bg.err.surface".into());
    }
    match id {
        Some(v) => crate::settings::set(conn, key, v).map_err(|e| e.to_string())?,
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])
                .map_err(|e| e.to_string())?;
        }
    }
    gc(conn, app_data_dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    // RAWY-FINAL. `tests/backgrounds.rs` — the suite that covers this module — cannot run without
    // `SARD_BG_FIXTURES`, whose generator is not in the repository, so `cargo test` fails 9/9 for
    // anyone but the original author. These tests are deliberately SELF-CONTAINED (every image is
    // built here with the `image` crate already in the tree) so the split of `import` into
    // prepare/materialize/commit has a regression guard that actually executes.

    fn fresh(tag: &str) -> (Connection, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sard-bgunit-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn, None).unwrap();
        (conn, dir)
    }

    /// A deterministic PNG on disk. The gradient keeps it real image data (not a flat fill), so the
    /// resample and the luminance sample both have something to work on.
    fn write_png(dir: &Path, name: &str, w: u32, h: u32, base: u8) -> String {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([base, ((x % 251) as u8), ((y % 241) as u8)])
        });
        let p = dir.join(name);
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&p, image::ImageFormat::Png)
            .unwrap();
        p.display().to_string()
    }

    fn managed_files(dir: &Path) -> Vec<String> {
        let bg = dir_of(dir);
        let mut v: Vec<String> = std::fs::read_dir(&bg)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    // The load-bearing guard for the RAWY-FINAL split: running the stages SEPARATELY (what the
    // command now does, with the lock released around `materialize`) must produce exactly what the
    // one-shot `import` produces — same id, same dimensions, same luminance, same derivative decision.
    #[test]
    fn staged_import_matches_one_shot_import() {
        let (c1, d1) = fresh("staged-a");
        let (c2, d2) = fresh("staged-b");
        let src = write_png(&d1, "src.png", 200, 120, 40);

        let one_shot = import(&c1, &d1, &src).unwrap();

        let prep = prepare(&src).unwrap();
        assert!(dedup_or_repair(&c2, prep.id()).unwrap().is_none(), "fresh db → no dedup hit");
        let staged = commit(&c2, &d2, materialize(prep).unwrap()).unwrap();

        assert_eq!(staged.id, one_shot.id, "content id must not depend on the path taken");
        assert_eq!(staged.width, one_shot.width);
        assert_eq!(staged.height, one_shot.height);
        assert_eq!(staged.mean_luma, one_shot.mean_luma);
        assert_eq!(
            staged.derivative_path.is_some(),
            one_shot.derivative_path.is_some(),
            "the derivative decision must be identical"
        );
        assert_eq!(managed_files(&d1), managed_files(&d2), "same files land on disk either way");

        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
    }

    // An under-ceiling image is rendered UNTOUCHED: no derivative, and the managed copy is
    // byte-for-byte the file the user chose (the "never recompress" guarantee, spec §7.2).
    #[test]
    fn under_ceiling_image_is_copied_byte_for_byte_with_no_derivative() {
        let (conn, dir) = fresh("under");
        let src = write_png(&dir, "small.png", 640, 480, 90);
        let row = import(&conn, &dir, &src).unwrap();

        assert!(row.derivative_path.is_none(), "under the ceiling → nothing is resampled");
        assert_eq!((row.width, row.height), (640, 480));
        assert_eq!(
            std::fs::read(&src).unwrap(),
            std::fs::read(&row.original_path).unwrap(),
            "the archival copy must be byte-identical to the source"
        );
        let luma = row.mean_luma.unwrap();
        assert!((0.0..=1.0).contains(&luma), "mean luma in range, got {luma}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Over the ceiling: a LOSSLESS derivative is written, the longest edge lands exactly on MAX_EDGE,
    // and the ORIGINAL dimensions (not the derivative's) are what the row reports.
    #[test]
    fn over_ceiling_image_gets_a_derivative_and_keeps_aspect() {
        let (conn, dir) = fresh("over");
        let (w, h) = (MAX_EDGE + 400, 1000u32);
        let src = write_png(&dir, "big.png", w, h, 120);
        let row = import(&conn, &dir, &src).unwrap();

        assert_eq!((row.width, row.height), (w as i64, h as i64), "row reports ORIGINAL dimensions");
        let d = row.derivative_path.as_ref().expect("over the ceiling → a derivative");
        assert!(d.ends_with(".display.png"), "the derivative is always a lossless PNG");
        let (dw, dh) = probe_dimensions(&std::fs::read(d).unwrap()).unwrap();
        assert_eq!(dw, MAX_EDGE, "longest edge lands on the ceiling");
        let expect_h = ((h as f64) * (MAX_EDGE as f64) / (w as f64)).round() as u32;
        assert_eq!(dh, expect_h, "aspect ratio preserved");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Dedup is by CONTENT, and a dedup hit must not decode anything or add a second row/file set.
    #[test]
    fn dedup_is_by_content_not_by_filename() {
        let (conn, dir) = fresh("dedup");
        let a = write_png(&dir, "one.png", 300, 200, 55);
        let b = dir.join("copy-under-another-name.png");
        std::fs::copy(&a, &b).unwrap();

        let first = import(&conn, &dir, &a).unwrap();
        let before = managed_files(&dir);
        let second = import(&conn, &dir, &b.display().to_string()).unwrap();

        assert_eq!(first.id, second.id, "same bytes → same row");
        assert_eq!(managed_files(&dir), before, "a dedup hit writes no new file");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM backgrounds", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "exactly one row");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // D31 (zero orphans): binding surface A and then surface B must collect A's files, and must NEVER
    // collect the row a surface still names. This is the invariant the staged commit had to preserve.
    #[test]
    fn gc_collects_the_unbound_row_and_spares_the_bound_one() {
        let (conn, dir) = fresh("gc");
        let a = write_png(&dir, "a.png", 220, 140, 30);
        let b = write_png(&dir, "b.png", 240, 160, 200);

        let ra = choose(&conn, &dir, KEY_LIBRARY_ID, &a).unwrap();
        let rb = choose(&conn, &dir, KEY_LIBRARY_ID, &b).unwrap();

        assert!(get(&conn, &rb.id).unwrap().is_some(), "the bound row survives");
        assert!(get(&conn, &ra.id).unwrap().is_none(), "the unbound row is collected");
        assert!(!Path::new(&ra.original_path).exists(), "its file goes with it");
        assert!(Path::new(&rb.original_path).exists(), "the bound file is spared");
        assert_eq!(managed_files(&dir).len(), 1, "zero orphans left in the managed dir");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Insert a profile row naming `lib` / `read` as its backgrounds. Only the columns the collector
    /// reads matter here, so `data` is the minimum the NOT NULL constraint accepts.
    fn profile_with(conn: &Connection, id: &str, lib: Option<&str>, read: Option<&str>) {
        conn.execute(
            "INSERT INTO profiles(id, name, description, author, icon_kind, icon_ref, data, \
             derived_from, created_at, updated_at, bg_library, bg_reading) \
             VALUES(?1, 'p', NULL, NULL, 'seal', NULL, '{}', NULL, 0, 0, ?2, ?3)",
            rusqlite::params![id, lib, read],
        )
        .unwrap();
    }

    // THE REGRESSION TEST FOR THE THIRD REFERENCE SOURCE. Before `gc()` learned to read the profiles
    // table this deleted the image out from under the profile — and it did so on the NEXT surface
    // bind, not at some later sweep, because `set_surface()` collects inline.
    #[test]
    fn a_background_a_profile_names_survives_collection() {
        let (conn, dir) = fresh("gcprofile");
        let held = write_png(&dir, "held.png", 220, 140, 30);
        let other = write_png(&dir, "other.png", 240, 160, 200);

        // Imported for a profile: present in the table, named by no SURFACE key.
        let row = import(&conn, &dir, &held).unwrap();
        profile_with(&conn, "u:holder", Some(&row.id), None);

        // Any surface bind runs the collector. This is the exact moment the image used to die.
        let bound = choose(&conn, &dir, KEY_LIBRARY_ID, &other).unwrap();

        assert!(
            get(&conn, &row.id).unwrap().is_some(),
            "a background named by a profile must survive the collector",
        );
        assert!(Path::new(&row.original_path).exists(), "and so must its file");
        assert!(get(&conn, &bound.id).unwrap().is_some(), "the surface-bound row still survives too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The reading column is a reference in its own right, and a profile that names nothing must not
    // accidentally pin anything.
    #[test]
    fn the_profile_reading_column_counts_and_an_empty_profile_pins_nothing() {
        let (conn, dir) = fresh("gcreading");
        let kept = write_png(&dir, "k.png", 200, 120, 44);
        let doomed = write_png(&dir, "d.png", 200, 120, 88);
        let trigger = write_png(&dir, "t.png", 200, 120, 120);

        let kept_row = import(&conn, &dir, &kept).unwrap();
        let doomed_row = import(&conn, &dir, &doomed).unwrap();
        profile_with(&conn, "u:reader", None, Some(&kept_row.id));
        profile_with(&conn, "u:empty", None, None); // names nothing

        choose(&conn, &dir, KEY_READING_ID, &trigger).unwrap();

        assert!(get(&conn, &kept_row.id).unwrap().is_some(), "bg_reading is a real reference");
        assert!(
            get(&conn, &doomed_row.id).unwrap().is_none(),
            "an unreferenced row is still collected — widening must not become 'keep everything'",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Deleting the profile releases its hold: the image is collected on the next sweep, so a profile
    // cannot leak an image by being removed.
    #[test]
    fn deleting_the_profile_releases_its_background() {
        let (conn, dir) = fresh("gcrelease");
        let img = write_png(&dir, "i.png", 200, 120, 55);
        let trigger = write_png(&dir, "t2.png", 200, 120, 150);
        let row = import(&conn, &dir, &img).unwrap();
        profile_with(&conn, "u:temp", Some(&row.id), None);

        choose(&conn, &dir, KEY_LIBRARY_ID, &trigger).unwrap();
        assert!(get(&conn, &row.id).unwrap().is_some(), "held while the profile exists");

        conn.execute("DELETE FROM profiles WHERE id = 'u:temp'", []).unwrap();
        gc(&conn, &dir).unwrap();
        assert!(get(&conn, &row.id).unwrap().is_none(), "released once the profile is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A row whose files vanished (partial restore / antivirus quarantine) must be REPAIRED by a
    // re-import rather than returned as a dedup hit that cannot render.
    #[test]
    fn a_row_whose_files_vanished_is_repaired_by_re_import() {
        let (conn, dir) = fresh("repair");
        let src = write_png(&dir, "r.png", 260, 180, 77);
        let row = choose(&conn, &dir, KEY_READING_ID, &src).unwrap();

        std::fs::remove_file(&row.original_path).unwrap(); // the bytes disappear under us
        let again = import(&conn, &dir, &src).unwrap();

        assert_eq!(again.id, row.id, "content-addressed, so the id is stable");
        assert!(Path::new(&again.original_path).exists(), "the file is restored");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The format gate is decided by MAGIC BYTES, never the extension.
    #[test]
    fn rejects_are_by_content_not_extension() {
        let (_conn, dir) = fresh("sniff");
        // `Prepared` holds the raw bytes and deliberately has no `Debug`, so drop the Ok side first.
        let refusal = |p: &Path| prepare(&p.display().to_string()).map(|_| ()).unwrap_err();

        let gif = dir.join("looks-fine.png");
        std::fs::write(&gif, b"GIF89a\0\0\0\0\0\0\0\0\0\0").unwrap();
        assert_eq!(refusal(&gif), err::ANIMATED);

        let heic = dir.join("photo.jpg");
        std::fs::write(&heic, b"\0\0\0\x18ftypheic\0\0\0\0").unwrap();
        assert_eq!(refusal(&heic), err::HEIC);

        let svg = dir.join("vector.png");
        std::fs::write(&svg, b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();
        assert_eq!(refusal(&svg), err::VECTOR);

        let junk = dir.join("nonsense.png");
        std::fs::write(&junk, b"not an image at all!!").unwrap();
        assert_eq!(refusal(&junk), err::FORMAT);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------------------------------------------
    // RAWY-278. `MAX_SOURCE_PIXELS` was raised 80 MP → 140 MP. This is the guard that the RAISE did
    // not become a REMOVAL: the pixel ceiling must still refuse a decode bomb from its HEADER, before
    // anything is decoded.
    //
    // The bomb is built the way a real one is — a valid PNG whose IHDR DECLARES enormous dimensions
    // while the file itself stays tiny — by patching a real PNG's IHDR and repairing its CRC. That is
    // what makes this test cheap enough to exist: asserting the 140 MP boundary with genuine pixel
    // data would mean allocating ~560 MB inside `cargo test`, and a guard that is too expensive to
    // test is a guard nobody re-checks.
    // ---------------------------------------------------------------------------------------------

    /// PNG chunk CRC (IEEE 802.3, as the PNG spec requires). Bitwise so it needs no table and no dep.
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    /// Rewrite a real PNG's IHDR to DECLARE `w × h` and repair the chunk CRC so the header still
    /// parses. The pixel data is deliberately left alone — nothing here ever decodes it, which is
    /// precisely the situation `probe_dimensions` exists to handle.
    ///
    /// Layout: 0..8 signature · 8..12 length · 12..16 "IHDR" · 16..20 width · 20..24 height ·
    /// 24..29 bit depth/colour/compression/filter/interlace · 29..33 CRC over bytes 12..29.
    fn png_declaring(dir: &Path, name: &str, w: u32, h: u32) -> String {
        let real = write_png(dir, "seed-for-header-patch.png", 8, 8, 10);
        let mut b = std::fs::read(&real).unwrap();
        b[16..20].copy_from_slice(&w.to_be_bytes());
        b[20..24].copy_from_slice(&h.to_be_bytes());
        let crc = crc32(&b[12..29]);
        b[29..33].copy_from_slice(&crc.to_be_bytes());
        let p = dir.join(name);
        std::fs::write(&p, &b).unwrap();
        p.display().to_string()
    }

    #[test]
    fn the_pixel_ceiling_still_refuses_a_decode_bomb_by_its_header() {
        let (_conn, dir) = fresh("bomb");
        // `Prepared` holds the raw bytes and has no `Debug`, so drop the Ok side before unwrapping.
        let refusal = |p: &str| prepare(p).map(|_| ()).unwrap_err();

        // The canonical bomb from this module's own doc comment: 50000², 2.5 gigapixels, ~1 KB on disk.
        let bomb = png_declaring(&dir, "bomb.png", 50_000, 50_000);
        assert!(
            std::fs::metadata(&bomb).unwrap().len() < 4096,
            "the bomb must stay tiny — that is the whole point of guarding on the HEADER"
        );
        assert_eq!(refusal(&bomb), err::TOO_MANY_PIXELS, "50000² must still be refused");

        // Just OVER the new ceiling: 12000² = 144 MP > 140 MP.
        let over = png_declaring(&dir, "over.png", 12_000, 12_000);
        assert_eq!(refusal(&over), err::TOO_MANY_PIXELS, "144 MP is over the 140 MP ceiling");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The other half of the raise, and the reason it was made: the image RAWY-278 was investigated
    // against — the owner's real 13884 × 8332 wallpaper, 115,681,488 px — was refused by the old
    // 80 MP ceiling and must now pass the header guard. Pinning the REAL dimensions (rather than a
    // round number near the limit) is what makes this a regression test for the actual user-visible
    // change rather than for the arithmetic.
    #[test]
    fn the_investigated_wallpaper_now_clears_the_pixel_ceiling() {
        let (_conn, dir) = fresh("wallpaper");
        let (w, h) = (13_884u32, 8_332u32);
        assert!(
            (w as u64) * (h as u64) > 80_000_000,
            "this image is the one the OLD 80 MP ceiling refused"
        );
        let src = png_declaring(&dir, "wallpaper.png", w, h);
        // `prepare` sniffs, probes and content-addresses. It never decodes, so a declared-but-absent
        // 115 MP of pixel data is irrelevant here — only the ceiling decision is under test.
        assert!(prepare(&src).is_ok(), "115.68 MP must clear the 140 MP ceiling");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
