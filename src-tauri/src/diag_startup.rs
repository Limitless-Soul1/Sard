//! SARD DIAGNOSTIC BUILD ONLY — the STARTUP RECORD.
//!
//! WHY THIS EXISTS. One tester installed the diagnostic package and received none of it: no export
//! button, no diagnostic behaviour, an application that looked like an older build. Three other
//! testers installed the same file and were fine. Every explanation reachable from source survived
//! scrutiny, so the question can only be settled with evidence from that machine — and the frontend
//! cannot supply it.
//!
//! THE CONSTRAINT THAT DECIDES THE WHOLE DESIGN. If that machine is running an OLDER executable,
//! nothing added to the new build ever runs. A report written by the frontend therefore cannot tell
//!
//!     "an old executable launched"        from        "the new executable launched and its
//!                                                      frontend never reached our code"
//!
//! because BOTH produce no file at all. So this record is written by RUST, at startup, before the
//! database is opened and before a single line of frontend code executes — and the ABSENCE of the
//! file becomes evidence in its own right rather than an unanswered question.
//!
//! It is written to the same folder the export button uses, so the tester has exactly one place to
//! look and needs no instructions beyond "send me the newest file in here".
//!
//! OBSERVATION ONLY. Nothing here alters what the application does. Every operation is fallible and
//! every failure is swallowed: a diagnostic that can break startup is worse than no diagnostic.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Where this launch's record was written, so the frontend handshake amends the SAME file rather
/// than writing a second one that has to be correlated by timestamp.
static RECORD: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
fn slot() -> &'static Mutex<Option<PathBuf>> {
    RECORD.get_or_init(|| Mutex::new(None))
}

fn epoch(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn now() -> i64 {
    epoch(SystemTime::now())
}

/// SHA-256 of a file, streamed. `None` on any failure — a missing hash is reported as UNKNOWN, never
/// guessed. Streamed rather than read-to-end because the executable is ~75 MB.
fn sha256_file(p: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(p).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// size + mtime for a file, as `(bytes, epoch_secs)`.
fn facts(p: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.len(), m.modified().map(epoch).unwrap_or(0)))
}

/// Count files under a directory tree and report the newest and oldest mtime found.
/// Bounded by `limit` entries so a pathological folder cannot stall startup.
fn tree_stats(root: &Path, limit: usize) -> (usize, i64, i64) {
    let (mut n, mut newest, mut oldest) = (0usize, 0i64, i64::MAX);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if n >= limit {
                return (n, newest, if oldest == i64::MAX { 0 } else { oldest });
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if let Ok(md) = e.metadata() {
                n += 1;
                let t = md.modified().map(epoch).unwrap_or(0);
                if t > newest {
                    newest = t;
                }
                if t < oldest {
                    oldest = t;
                }
            }
        }
    }
    (n, newest, if oldest == i64::MAX { 0 } else { oldest })
}

/// Every place a Sard executable can plausibly live, checked by NAME rather than by scanning the
/// disk — the four roots the NSIS template can install into, for both the current and the legacy
/// product name. A scan would be slow and would still miss a custom directory; this answers the one
/// question that matters ("is more than one copy installed?") for the paths the installer uses.
fn candidate_installs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let env = |k: &str| std::env::var(k).ok().map(PathBuf::from);
    let roots = [
        env("LOCALAPPDATA"),
        env("LOCALAPPDATA").map(|p| p.join("Programs")),
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        env("APPDATA"),
    ];
    // Windows paths are case-insensitive, so `sard.exe` and `Sard.exe` resolve to the SAME file and
    // would otherwise be reported as two installations — the precise misreading this record exists to
    // prevent. Deduplicated on the canonical path.
    let mut seen: Vec<String> = Vec::new();
    for root in roots.into_iter().flatten() {
        for product in ["Sard", "eRawy"] {
            for exe in ["sard.exe", "erawy.exe"] {
                let p = root.join(product).join(exe);
                if !p.is_file() {
                    continue;
                }
                let key = std::fs::canonicalize(&p)
                    .map(|c| c.to_string_lossy().to_lowercase())
                    .unwrap_or_else(|_| p.to_string_lossy().to_lowercase());
                if !seen.contains(&key) {
                    seen.push(key);
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Write the startup record. Call as early as possible; never returns an error to the caller.
pub fn write_startup_record(docs_dir: Option<PathBuf>, app_data_dir: &Path) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let dir = docs_dir
            .map(|d| d.join("Sard Diagnostics"))
            .unwrap_or_else(|| app_data_dir.join("diagnostics"));
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(format!("sard-startup-{}.txt", now()));
        let text = build_record(app_data_dir);
        if std::fs::write(&path, text).is_ok() {
            if let Ok(mut g) = slot().lock() {
                *g = Some(path);
            }
        }
    }));
}

fn build_record(app_data_dir: &Path) -> String {
    // `String` takes `fmt::Write`; the file append below takes `io::Write`. Both traits are called
    // `Write`, so the fmt one is scoped to this function rather than imported at module level.
    use std::fmt::Write as _;
    let mut s = String::new();
    let p = &mut s;
    let _ = writeln!(p, "==============================================================================");
    let _ = writeln!(p, "SARD STARTUP RECORD  (diagnostic build)");
    let _ = writeln!(p, "==============================================================================");
    let _ = writeln!(p);
    let _ = writeln!(p, "Written by the Rust core BEFORE the database opened and BEFORE any frontend");
    let _ = writeln!(p, "code ran. If this file exists, the executable that produced it IS a diagnostic");
    let _ = writeln!(p, "build. If no such file exists after launching, the running executable is NOT.");
    let _ = writeln!(p);
    let _ = writeln!(p, "  writtenAtEpoch     {}", now());
    let _ = writeln!(p, "  appVersion         {}", env!("CARGO_PKG_VERSION"));

    // ---- the executable itself -------------------------------------------------------------
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "EXECUTABLE");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    let exe = std::env::current_exe().ok();
    let mut exe_mtime = 0i64;
    match exe.as_deref() {
        Some(e) => {
            let _ = writeln!(p, "  path               {}", e.display());
            let _ = writeln!(p, "  installDir         {}", e.parent().map(|d| d.display().to_string()).unwrap_or_else(|| "UNKNOWN".into()));
            match facts(e) {
                Some((sz, mt)) => {
                    exe_mtime = mt;
                    let _ = writeln!(p, "  sizeBytes          {sz}");
                    let _ = writeln!(p, "  mtimeEpoch         {mt}");
                }
                None => {
                    let _ = writeln!(p, "  sizeBytes          UNKNOWN");
                }
            }
            let _ = writeln!(p, "  sha256             {}", sha256_file(e).unwrap_or_else(|| "UNKNOWN".into()));
        }
        None => {
            let _ = writeln!(p, "  path               UNKNOWN (current_exe() failed)");
        }
    }

    // ---- what shipped beside it ------------------------------------------------------------
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "INSTALL DIRECTORY CONTENTS  (detects a partial deployment)");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    if let Some(dir) = exe.as_deref().and_then(|e| e.parent()) {
        match std::fs::read_dir(dir) {
            Ok(rd) => {
                for e in rd.flatten().take(40) {
                    let name = e.file_name().to_string_lossy().to_string();
                    let (kind, extra) = match e.metadata() {
                        Ok(m) if m.is_dir() => {
                            let (n, _, _) = tree_stats(&e.path(), 20_000);
                            ("dir ", format!("{n} files"))
                        }
                        Ok(m) => ("file", format!("{} bytes, mtime {}", m.len(), m.modified().map(epoch).unwrap_or(0))),
                        Err(_) => ("?   ", "unreadable".to_string()),
                    };
                    let _ = writeln!(p, "  {kind} {name:<34} {extra}");
                }
            }
            Err(e) => {
                let _ = writeln!(p, "  UNREADABLE: {e}");
            }
        }
    }

    // ---- other copies ----------------------------------------------------------------------
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "OTHER SARD EXECUTABLES ON THIS MACHINE  (detects a second installation)");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    let others = candidate_installs();
    if others.is_empty() {
        let _ = writeln!(p, "  none found in the standard install roots");
    }
    for o in &others {
        let running = exe.as_deref().map(|e| e == o.as_path()).unwrap_or(false);
        let (sz, mt) = facts(o).unwrap_or((0, 0));
        let _ = writeln!(p, "  {} {}", if running { "[THIS ONE]" } else { "[  other ]" }, o.display());
        let _ = writeln!(p, "             {sz} bytes, mtime {mt}, sha256 {}", sha256_file(o).unwrap_or_else(|| "UNKNOWN".into()));
    }

    // ---- profile ---------------------------------------------------------------------------
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "PROFILE AND RUNTIME");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    let _ = writeln!(p, "  appDataDir         {}", app_data_dir.display());
    let _ = writeln!(p, "  dbPresent          {}", app_data_dir.join("sard.db").is_file());
    let _ = writeln!(p, "  webview2Version    {}", tauri::webview_version().unwrap_or_else(|_| "UNKNOWN".into()));

    // ---- the WebView2 cache ----------------------------------------------------------------
    //
    // A frontend served from a stale cache is one of the few explanations that survives: the cache
    // lives under the BUNDLE IDENTIFIER, not the install directory, so it outlives uninstall and
    // reinstall. Reported as raw numbers plus one derived comparison against the executable's own
    // mtime — a code cache written entirely BEFORE this executable was built is the signature.
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "WEBVIEW2 CACHE  (survives uninstall — keyed by bundle identifier)");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    let eb = std::env::var("LOCALAPPDATA")
        .ok()
        .map(|l| PathBuf::from(l).join("com.sard.app").join("EBWebView"));
    match eb {
        Some(root) if root.is_dir() => {
            let _ = writeln!(p, "  path               {}", root.display());
            for sub in ["Default\\Cache", "Default\\Code Cache", "Default\\Local Storage"] {
                let d = root.join(sub);
                if d.is_dir() {
                    let (n, newest, oldest) = tree_stats(&d, 50_000);
                    let verdict = if newest > 0 && exe_mtime > 0 && newest < exe_mtime {
                        format!("  <-- ENTIRELY OLDER THAN THE EXECUTABLE by {}s", exe_mtime - newest)
                    } else {
                        String::new()
                    };
                    let _ = writeln!(p, "  {sub:<22} {n} files, newest {newest}, oldest {oldest}{verdict}");
                } else {
                    let _ = writeln!(p, "  {sub:<22} (absent)");
                }
            }
        }
        Some(root) => {
            let _ = writeln!(p, "  path               {} (does not exist)", root.display());
        }
        None => {
            let _ = writeln!(p, "  LOCALAPPDATA not set");
        }
    }

    // ---- the handshake ---------------------------------------------------------------------
    //
    // Written NOW, as NOT REACHED. `diag_startup_mark` overwrites it from the frontend. If this
    // section still says NOT REACHED in the file the tester sends, the executable ran and the
    // frontend never got to our code — which no other measurement can establish.
    let _ = writeln!(p, "\n------------------------------------------------------------------------------");
    let _ = writeln!(p, "FRONTEND HANDSHAKE — PLACEHOLDER");
    let _ = writeln!(p, "------------------------------------------------------------------------------");
    let _ = writeln!(p, "  This line is written by Rust before the frontend exists. The frontend APPENDS");
    let _ = writeln!(p, "  its own 'FRONTEND PHASE' sections below.");
    let _ = writeln!(p);
    let _ = writeln!(p, "    -> If NO 'FRONTEND PHASE' section appears after this one, the frontend of");
    let _ = writeln!(p, "       THIS executable never reached diagStart(). Read that as the finding.");
    s
}

/// Append a frontend phase to THIS launch's record. Called by the `diag_startup_mark` command.
pub fn append_frontend(section: &str) -> Result<(), String> {
    let path = slot()
        .lock()
        .map_err(|_| "record lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "no startup record was written this launch".to_string())?;
    let mut f = OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(f, "\n{section}").map_err(|e| e.to_string())
}
