//! The translation implementation's fingerprint: that the build carries the one of its own sources, what it
//! covers, and which edits change it — on synthetic source and on the real files.

use std::path::{Path, PathBuf};

use super::editions::implementation;
use super::fingerprint::{fingerprint, of_files, tokens, FILES};

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read(f: &str) -> std::io::Result<String> {
    std::fs::read_to_string(src().join(f))
}

#[test]
fn the_build_carries_the_fingerprint_of_the_sources_it_was_built_from() {
    let now = of_files(&src()).unwrap();
    assert_eq!(now, implementation(), "build.rs computed it from these very files");
    assert_eq!(of_files(&src()).unwrap(), now, "the same files, the same fingerprint");
    assert_eq!(now.len(), 64);
}

/// Every product file of the pipeline is covered, and the engine module with it; a file added to the pipeline
/// without being added here fails this test.
#[test]
fn it_covers_every_product_file_of_the_pipeline_and_the_engine() {
    let mut pipeline: Vec<String> = std::fs::read_dir(src().join("translation").join("pipeline"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".rs") && !n.ends_with("_tests.rs") && n != "tests.rs")
        .map(|n| format!("translation/pipeline/{n}"))
        .collect();
    pipeline.sort();
    let covered: Vec<&str> = FILES.iter().copied().filter(|f| f.starts_with("translation/pipeline/")).collect();
    assert_eq!(covered, pipeline.iter().map(String::as_str).collect::<Vec<_>>());
    assert!(FILES.contains(&"translation/engine.rs"), "the engine's request helper reads every answer");
    for f in FILES {
        assert!(src().join(f).is_file(), "{f} exists");
    }
    let mut unique = FILES.to_vec();
    unique.dedup();
    assert_eq!(unique.len(), FILES.len());
}

const BASE: &str = "fn f(x: u32) -> u32 {\n    let v = [1, 2, 3];\n    let s = \"a // not a comment\";\n    match x { 0 => 1, _ => 2 }\n}\n";

#[test]
fn comments_whitespace_line_endings_and_trailing_commas_leave_the_tokens_alone() {
    let base = tokens(BASE);
    for (what, variant) in [
        ("comments of every kind", "// lead\nfn f(x: u32) -> u32 { /* block /* nested */ still */\n    let v = [1, 2, 3]; // trailing\n    /// doc\n    //! inner doc\n    let s = \"a // not a comment\";\n    match x { 0 => 1, _ => 2 }\n}\n".to_string()),
        ("whitespace and line breaks", "fn f(x:u32)->u32{let v=[1,2,3];let s=\"a // not a comment\";match x{0=>1,_=>2}}".to_string()),
        ("indentation by tabs", BASE.replace("    ", "\t")),
        ("CRLF line endings", BASE.replace('\n', "\r\n")),
        ("a byte-order mark", format!("\u{feff}{BASE}")),
        ("trailing commas before ] and }", BASE.replace("[1, 2, 3]", "[1, 2, 3,]").replace("_ => 2 }", "_ => 2, }")),
    ] {
        assert_eq!(tokens(&variant), base, "{what} must not change the fingerprint");
    }
}

#[test]
fn every_change_of_code_or_literal_changes_the_tokens() {
    let base = tokens(BASE);
    for (what, variant) in [
        ("a number", BASE.replace("[1, 2, 3]", "[1, 2, 4]")),
        ("a string's text", BASE.replace("not a comment", "not a comment!")),
        ("whitespace inside a string", BASE.replace("a // not", "a //  not")),
        ("an identifier", BASE.replace("fn f", "fn g")),
        ("a type", BASE.replace("-> u32", "-> u64")),
        ("an operator", BASE.replace("0 => 1", "0 => 1 + 1")),
        ("a comma before ) (it can make a one-element tuple)", BASE.replace("(x: u32)", "(x: u32,)")),
        ("a removed line of code", BASE.replace("    let v = [1, 2, 3];\n", "")),
    ] {
        assert_ne!(tokens(&variant), base, "{what} must change the fingerprint");
    }
}

#[test]
fn literals_and_lifetimes_are_read_exactly() {
    assert_eq!(tokens("let s = \"a // b /* c */\";"), ["let", "s", "=", "\"a // b /* c */\"", ";"]);
    assert_eq!(tokens("let s = \"say \\\"hi\\\"\";"), ["let", "s", "=", "\"say \\\"hi\\\"\"", ";"]);
    assert_eq!(tokens("let r = r#\"he said \"hi\" // x\"#;"), ["let", "r", "=", "r#\"he said \"hi\" // x\"#", ";"]);
    assert_eq!(tokens("let b = br\"x\"; let c = b'y';"), ["let", "b", "=", "br\"x\"", ";", "let", "c", "=", "b", "'y'", ";"]);
    assert_eq!(tokens("let q = '\"'; let e = '\\''; let u = '\\u{1F}';"), ["let", "q", "=", "'\"'", ";", "let", "e", "=", "'\\''", ";", "let", "u", "=", "'\\u{1F}'", ";"]);
    assert_eq!(tokens("fn f<'a>(x: &'a str) {}"), ["fn", "f", "<", "'a", ">", "(", "x", ":", "&", "'a", "str", ")", "{", "}"]);
    assert_eq!(tokens("a /* x /* y */ z */ b"), ["a", "b"], "block comments nest");
}

/// On the real files: a comment or a re-indentation keeps the fingerprint; a prompt, an answer reading or a rule
/// changed by one character does not.
#[test]
fn on_the_real_files_a_comment_keeps_the_fingerprint_and_a_behaviour_change_does_not() {
    let base = fingerprint(read).unwrap();
    let edited = |file: &'static str, edit: fn(String) -> String| {
        fingerprint(move |f| if f == file { read(f).map(edit) } else { read(f) }).unwrap()
    };
    let same = [
        ("a comment in the adapters", edited("translation/pipeline/adapter.rs", |s| format!("// a note for a reader\n{s}"))),
        ("re-indented decisions", edited("translation/pipeline/decide.rs", |s| s.replace("    ", "\t"))),
        ("CRLF in the engine", edited("translation/engine.rs", |s| s.replace("\r\n", "\n").replace('\n', "\r\n"))),
    ];
    for (what, fp) in same {
        assert_eq!(fp, base, "{what} must keep the fingerprint");
    }
    // A Windows checkout (CRLF) and a Linux checkout (LF) of all ten files: one fingerprint.
    let lf = fingerprint(|f| read(f).map(|s| s.replace("\r\n", "\n"))).unwrap();
    let crlf = fingerprint(|f| read(f).map(|s| s.replace("\r\n", "\n").replace('\n', "\r\n"))).unwrap();
    assert_eq!((lf.as_str(), crlf.as_str()), (base.as_str(), base.as_str()), "line endings never change it");
    let differ = [
        ("model B's instruction", edited("translation/pipeline/adapter.rs", |s| { assert!(s.contains("Output only the translation")); s.replacen("Output only the translation", "Output just the translation", 1) })),
        ("the engine's request helper", edited("translation/engine.rs", |s| { assert!(s.contains(".user_agent(\"Sard\")")); s.replacen(".user_agent(\"Sard\")", ".user_agent(\"Sard2\")", 1) })),
        ("a detector reason", edited("translation/pipeline/detect.rs", |s| { assert!(s.contains("hit the n_predict limit")); s.replacen("hit the n_predict limit", "hit the limit", 1) })),
    ];
    for (what, fp) in differ {
        assert_ne!(fp, base, "{what} must change the fingerprint");
    }
}
