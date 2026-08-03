//! RAWY-265 Phase 1 â€” verification of the background import path.
//!
//! Drives the REAL `backgrounds::import` / `set_surface` / `gc` against REAL byte streams (hand-built
//! PNG/APNG/WebP/HEIC payloads written by the harness, so each file genuinely IS the format it claims
//! rather than a renamed stand-in), on a REAL migrated SQLite database. Nothing here is stubbed.
//!
//! Run: `cargo test --test backgrounds -- --nocapture`

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sard_lib::{backgrounds, db, settings};

fn fixtures() -> PathBuf {
    // Written by scratchpad/make-test-images.mjs; the path is passed in so the harness can live
    // outside the repo and no test payload is ever committed.
    PathBuf::from(std::env::var("SARD_BG_FIXTURES").expect("set SARD_BG_FIXTURES to the fixture dir"))
}

/// RAWY-FINAL: SKIP, don't FAIL, when the fixtures aren't configured.
///
/// These nine tests read real APNG / WebP / HEIC / EXIF-rotated payloads written by
/// `scratchpad/make-test-images.mjs` â€” a generator that is deliberately NOT committed (no binary test
/// payload in the repo). The consequence was that a bare `cargo test` on any other machine, including
/// a future CI, failed 9/9 with `NotPresent` and ABORTED the run before the unit tests were reported:
/// nobody but the original author could get a green signal out of this project.
///
/// Skipping keeps the suite exactly as valuable where it can run (set `SARD_BG_FIXTURES` and every
/// assertion executes unchanged) while making the default invocation honest. The same ground is
/// covered without fixtures by the self-contained unit tests in `src/backgrounds/mod.rs`, which build
/// their images with the `image` crate already in the tree; only the real-format payloads are unique
/// to this file.
fn skip_no_fixtures(test: &str) -> bool {
    match std::env::var("SARD_BG_FIXTURES") {
        Ok(v) if PathBuf::from(&v).is_dir() => false,
        _ => {
            eprintln!(
                "SKIP {test}: set SARD_BG_FIXTURES to the fixture dir (see scratchpad/make-test-images.mjs) \
                 to run the real-format background tests"
            );
            true
        }
    }
}

/// Prefixes every fixture-backed test. Kept as a macro so the guard is one visually obvious line.
macro_rules! need_fixtures {
    () => {
        if skip_no_fixtures(concat!(module_path!(), "::", "fixture-backed test")) {
            return;
        }
    };
}

fn fresh(tag: &str) -> (Connection, PathBuf) {
    let dir = std::env::temp_dir().join(format!("sard-bgtest-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    db::migrations::run(&conn, None).unwrap();
    (conn, dir)
}

fn f(name: &str) -> String {
    fixtures().join(name).display().to_string()
}

fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM backgrounds", [], |r| r.get(0)).unwrap()
}

fn files_in(dir: &Path) -> Vec<String> {
    let bg = dir.join("backgrounds");
    if !bg.exists() {
        return vec![];
    }
    let mut v: Vec<String> = std::fs::read_dir(bg)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn rejects_are_specific_and_by_content_not_extension() {
    need_fixtures!();
    let (conn, dir) = fresh("reject");
    let cases = [
        ("animated.png", "bg.err.animated"),   // APNG: acTL before IDAT
        ("animated.webp", "bg.err.animated"),  // VP8X ANIMATION flag
        ("photo.heic", "bg.err.heic"),         // ISO-BMFF ftyp/heic
        ("liar.jpg", "bg.err.heic"),           // HEIC bytes behind a .jpg name
        ("vector.svg", "bg.err.vector"),
        ("notanimage.txt", "bg.err.format"),
        ("bomb.png", "bg.err.tooManyPixels"),  // 30000x30000 declared in 69 bytes
    ];
    for (name, expected) in cases {
        let got = backgrounds::import(&conn, &dir, &f(name)).unwrap_err();
        assert_eq!(got, expected, "{name} produced the wrong code");
        println!("  {name:22} -> {got}");
    }
    // A rejected import must leave NOTHING behind â€” no row, no partial file on disk.
    assert_eq!(count(&conn), 0, "a rejected import created a row");
    assert!(files_in(&dir).is_empty(), "a rejected import left files: {:?}", files_in(&dir));
    println!("7/7 rejects correct; 0 rows, 0 files left behind");
}

#[test]
fn under_ceiling_image_is_rendered_untouched() {
    need_fixtures!();
    let (conn, dir) = fresh("under");
    let src = f("small-mid.png");
    let row = backgrounds::import(&conn, &dir, &src).unwrap();

    // THE "never recompress" GUARANTEE: no derivative at all, and the managed copy is byte-identical
    // to what the user chose.
    assert!(row.derivative_path.is_none(), "an under-ceiling image should NOT get a derivative");
    let orig = std::fs::read(&src).unwrap();
    let copied = std::fs::read(&row.original_path).unwrap();
    assert_eq!(orig, copied, "the archival copy is not byte-identical to the source");
    assert_eq!((row.width, row.height), (800, 600));
    assert_eq!(files_in(&dir).len(), 1, "expected exactly one managed file");
    println!(
        "800x600 -> derivative: none | copy byte-identical: yes ({} bytes) | luma {:.4}",
        copied.len(),
        row.mean_luma.unwrap()
    );
}

#[test]
fn over_ceiling_image_gets_a_lossless_derivative_and_keeps_aspect() {
    need_fixtures!();
    let (conn, dir) = fresh("over");
    let src = f("oversize-5000.png");
    let t0 = std::time::Instant::now();
    let row = backgrounds::import(&conn, &dir, &src).unwrap();
    let ms = t0.elapsed().as_millis();

    let d = row.derivative_path.clone().expect("an over-ceiling image MUST get a derivative");
    assert!(d.ends_with(".display.png"), "the derivative must be PNG (lossless): {d}");

    // The ORIGINAL is still byte-identical â€” the derivative is an addition, never a replacement.
    assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&row.original_path).unwrap());
    // Recorded dimensions are the ORIGINAL's, not the derivative's.
    assert_eq!((row.width, row.height), (5000, 1200));

    let dim = image::image_dimensions(&d).unwrap();
    assert_eq!(dim.0, 3840, "longest edge must land exactly on the ceiling");
    // Aspect ratio preserved: 5000/1200 == 3840/922 to within a rounding step.
    let want = (1200.0_f64 * 3840.0 / 5000.0).round() as u32;
    assert_eq!(dim.1, want, "aspect ratio was not preserved");
    let ar_src = 5000.0 / 1200.0;
    let ar_out = dim.0 as f64 / dim.1 as f64;
    assert!((ar_src - ar_out).abs() < 0.01, "aspect drift {ar_src} vs {ar_out}");

    println!(
        "5000x1200 -> derivative {}x{} (aspect {:.4} vs {:.4}) in {} ms | original untouched",
        dim.0, dim.1, ar_out, ar_src, ms
    );
}

#[test]
fn dedup_is_by_content_not_by_filename() {
    need_fixtures!();
    let (conn, dir) = fresh("dedup");
    let a = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap();
    let b = backgrounds::import(&conn, &dir, &f("copy-of-small-mid.png")).unwrap();
    assert_eq!(a.id, b.id, "identical content under a different name must dedup");
    assert_eq!(count(&conn), 1, "dedup created a second row");
    assert_eq!(files_in(&dir).len(), 1, "dedup created a second file");

    // Different content must NOT collide.
    let c = backgrounds::import(&conn, &dir, &f("small-dark.png")).unwrap();
    assert_ne!(a.id, c.id);
    assert_eq!(count(&conn), 2);
    println!("same bytes/different name -> 1 row 1 file; different bytes -> 2 rows");
}

#[test]
fn mean_luma_tracks_image_brightness() {
    need_fixtures!();
    let (conn, dir) = fresh("luma");
    let dark = backgrounds::import(&conn, &dir, &f("small-dark.png")).unwrap().mean_luma.unwrap();
    let mid = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap().mean_luma.unwrap();
    let light = backgrounds::import(&conn, &dir, &f("small-light.png")).unwrap().mean_luma.unwrap();
    assert!(dark < mid && mid < light, "luma must be monotonic: {dark} {mid} {light}");
    // sRGB relative luminance of a flat grey: 16 -> ~0.006, 128 -> ~0.216, 240 -> ~0.871.
    assert!((dark - 0.006).abs() < 0.01, "dark {dark}");
    assert!((mid - 0.216).abs() < 0.01, "mid {mid}");
    assert!((light - 0.871).abs() < 0.02, "light {light}");
    println!("luma dark {dark:.4} < mid {mid:.4} < light {light:.4} (expected .006 / .216 / .871)");
}

#[test]
fn gc_leaves_zero_orphans_and_spares_the_bound_row() {
    need_fixtures!();
    let (conn, dir) = fresh("gc");
    let keep = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap();
    let drop1 = backgrounds::import(&conn, &dir, &f("small-dark.png")).unwrap();
    let drop2 = backgrounds::import(&conn, &dir, &f("oversize-5000.png")).unwrap();
    assert_eq!(count(&conn), 3);
    // 4 files: 3 originals + 1 derivative for the oversize one.
    assert_eq!(files_in(&dir).len(), 4, "{:?}", files_in(&dir));

    // Binding one surface must collect the other two â€” INSIDE set_surface, with no separate GC call.
    backgrounds::set_surface(&conn, &dir, backgrounds::KEY_LIBRARY_ID, Some(&keep.id)).unwrap();
    assert_eq!(count(&conn), 1, "unreferenced rows survived");
    assert_eq!(files_in(&dir).len(), 1, "unreferenced FILES survived: {:?}", files_in(&dir));
    assert!(Path::new(&keep.original_path).exists(), "the bound row's file was deleted");
    assert!(!Path::new(&drop1.original_path).exists());
    assert!(!Path::new(&drop2.original_path).exists());
    assert!(!Path::new(&drop2.derivative_path.unwrap()).exists(), "the derivative was orphaned");
    assert_eq!(settings::get(&conn, backgrounds::KEY_LIBRARY_ID).unwrap().as_deref(), Some(keep.id.as_str()));

    // Clearing collects the last one too.
    backgrounds::set_surface(&conn, &dir, backgrounds::KEY_LIBRARY_ID, None).unwrap();
    assert_eq!(count(&conn), 0);
    assert!(files_in(&dir).is_empty(), "clearing left files: {:?}", files_in(&dir));
    assert_eq!(settings::get(&conn, backgrounds::KEY_LIBRARY_ID).unwrap(), None);
    println!("3 rows/4 files -> bind: 1/1 (bound row intact) -> clear: 0/0, key removed");
}

#[test]
fn a_row_whose_files_vanished_is_repaired_by_re_import() {
    need_fixtures!();
    let (conn, dir) = fresh("repair");
    let row = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap();
    // Simulate an antivirus quarantine / a partial restore / a cleared app-data.
    std::fs::remove_file(&row.original_path).unwrap();
    let again = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap();
    assert_eq!(again.id, row.id, "the content id should be stable across a repair");
    assert!(Path::new(&again.original_path).exists(), "re-import did not restore the file");
    assert_eq!(count(&conn), 1, "repair duplicated the row");
    println!("row survived its file; re-import restored the bytes without duplicating the row");
}

#[test]
fn two_surfaces_are_independent() {
    need_fixtures!();
    let (conn, dir) = fresh("surfaces");
    let a = backgrounds::choose(&conn, &dir, backgrounds::KEY_LIBRARY_ID, &f("small-mid.png")).unwrap();
    let b = backgrounds::choose(&conn, &dir, backgrounds::KEY_READING_ID, &f("small-dark.png")).unwrap();
    // Both are referenced, so the GC that runs inside each call must spare BOTH.
    assert_eq!(count(&conn), 2, "a second surface's row was collected");
    backgrounds::set_surface(&conn, &dir, backgrounds::KEY_LIBRARY_ID, None).unwrap();
    assert_eq!(count(&conn), 1, "clearing one surface collected the other");
    assert!(Path::new(&b.original_path).exists(), "the reading surface lost its file");
    assert!(!Path::new(&a.original_path).exists(), "the cleared surface's file survived");
    println!("library + reading bind independently; clearing one spares the other");
}

/// THE REGRESSION THIS API SHAPE EXISTS FOR. A bare `import` leaves the row unreferenced; the GC that
/// runs on the next surface bind then deletes it. This asserts the defect is gone via `choose`, and
/// documents the unsafe ordering next to it so nobody reintroduces a two-step flow.
#[test]
fn choose_is_atomic_so_a_concurrent_bind_cannot_collect_the_new_image() {
    need_fixtures!();
    let (conn, dir) = fresh("atomic");
    // The UNSAFE ordering, kept as a live demonstration: import leaves `b` unbound, and binding `a`
    // collects it.
    let _a = backgrounds::import(&conn, &dir, &f("small-mid.png")).unwrap();
    let b = backgrounds::import(&conn, &dir, &f("small-dark.png")).unwrap();
    backgrounds::set_surface(&conn, &dir, backgrounds::KEY_LIBRARY_ID, Some(&_a.id)).unwrap();
    assert!(!Path::new(&b.original_path).exists(), "the two-step flow was expected to lose the image");

    // The SHIPPED ordering: choose() binds inside the same call, so nothing can collect it.
    let (conn, dir) = fresh("atomic2");
    let x = backgrounds::choose(&conn, &dir, backgrounds::KEY_LIBRARY_ID, &f("small-mid.png")).unwrap();
    let y = backgrounds::choose(&conn, &dir, backgrounds::KEY_READING_ID, &f("small-dark.png")).unwrap();
    assert!(Path::new(&x.original_path).exists() && Path::new(&y.original_path).exists());
    assert_eq!(count(&conn), 2);
    println!("two-step loses the image (reproduced); choose() keeps both");
}
