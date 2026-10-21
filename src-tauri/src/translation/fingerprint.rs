//! The translation implementation's fingerprint: one SHA-256 over the code that decides what a translation is.
//!
//! WHAT IT COVERS — the files in `FILES`, in that order:
//! * every product file of the pipeline: its rules, planners and checks, the prompts it sends, the request
//!   bodies the adapters build and how they read an answer;
//! * `engine.rs`, whose request helper carries every exchange and reads every answer, and whose launch builds
//!   the engine's command line.
//!
//! The model and the runtime (their hashes), the engine flags of a model, its constant and the execution path
//! are checked separately, field by field, so they are not repeated here.
//!
//! HOW — over the files' TOKENS, not their bytes. Left out: comments (line, block and doc), whitespace
//! (indentation, line breaks, line endings, a byte-order mark) and a trailing comma before `]` or `}`. Edits of
//! only those kinds keep the fingerprint. Every other change gives another one — test-only code inside these
//! files included, which is the safe direction. String and character literals are taken exactly as written, so a
//! prompt cannot change unnoticed. The same files give the same fingerprint on every machine and checkout.
//!
//! WHERE — computed when Sard is built (`build.rs`); an edition records it, and a build with another
//! implementation cannot resume it. A test holds `FILES` to every product file of the pipeline, and another
//! checks that the build carries the fingerprint of the sources it was built from.
//!
//! This file is compiled twice — into `build.rs` and into Sard — so it uses nothing but `std` and `sha2`.

use std::path::Path;

use sha2::{Digest, Sha256};

/// The files, relative to `src-tauri/src`, in the order they are taken.
pub const FILES: [&str; 10] = [
    "translation/engine.rs",
    "translation/pipeline/adapter.rs",
    "translation/pipeline/chunk.rs",
    "translation/pipeline/complete.rs",
    "translation/pipeline/decide.rs",
    "translation/pipeline/detect.rs",
    "translation/pipeline/mod.rs",
    "translation/pipeline/script.rs",
    "translation/pipeline/text.rs",
    "translation/pipeline/unicode_tables.rs",
];

/// The tokens of Rust source, without comments, whitespace or a trailing comma before `]` or `}`. Literals are
/// kept whole and exactly as written; every other character outside a word is a token of its own.
pub fn tokens(source: &str) -> Vec<String> {
    let src = source.strip_prefix('\u{feff}').unwrap_or(source).replace("\r\n", "\n");
    let c: Vec<char> = src.chars().collect();
    let word = |ch: char| ch == '_' || ch.is_alphanumeric();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            let mut depth = 0usize;
            while i < c.len() {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if word(ch) {
            let start = i;
            while i < c.len() && word(c[i]) {
                i += 1;
            }
            // A raw string: `r`, `br` or `cr`, then hashes, then a quote.
            let w: String = c[start..i].iter().collect();
            let mut j = i;
            while j < c.len() && c[j] == '#' {
                j += 1;
            }
            if matches!(w.as_str(), "r" | "br" | "cr") && c.get(j) == Some(&'"') {
                let hashes = j - i;
                let mut k = j + 1;
                while k < c.len() && !(c[k] == '"' && (0..hashes).all(|h| c.get(k + 1 + h) == Some(&'#'))) {
                    k += 1;
                }
                let end = (k + 1 + hashes).min(c.len());
                out.push(c[start..end].iter().collect());
                i = end;
            } else {
                out.push(w);
            }
        } else if ch == '"' {
            let start = i;
            i += 1;
            while i < c.len() && c[i] != '"' {
                if c[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(c.len());
            out.push(c[start..i].iter().collect());
        } else if ch == '\'' {
            let start = i;
            if c.get(i + 1) == Some(&'\\') {
                // An escaped character literal: skip the escaped character, then up to the closing quote.
                i += 3;
                while i < c.len() && c[i] != '\'' {
                    i += 1;
                }
                i = (i + 1).min(c.len());
            } else if c.get(i + 2) == Some(&'\'') {
                i += 3; // a one-character literal
            } else {
                i += 1; // a lifetime or a label: the quote and its name
                while i < c.len() && word(c[i]) {
                    i += 1;
                }
            }
            out.push(c[start..i.min(c.len())].iter().collect());
        } else {
            if (ch == ']' || ch == '}') && out.last().is_some_and(|t| t == ",") {
                out.pop();
            }
            out.push(ch.to_string());
            i += 1;
        }
    }
    out
}

/// The fingerprint of the files in `FILES`, each read by `read` from its path in that list: lowercase hex.
pub fn fingerprint(read: impl Fn(&str) -> std::io::Result<String>) -> std::io::Result<String> {
    let mut h = Sha256::new();
    for f in FILES {
        let toks = tokens(&read(f)?);
        h.update(format!("file {f} {}\n", toks.len()).as_bytes());
        for t in &toks {
            h.update(format!("{}:", t.len()).as_bytes());
            h.update(t.as_bytes());
            h.update(b"\n");
        }
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The fingerprint of the files as they are under `src` (the `src-tauri/src` directory).
pub fn of_files(src: &Path) -> std::io::Result<String> {
    fingerprint(|f| std::fs::read_to_string(src.join(f)))
}
