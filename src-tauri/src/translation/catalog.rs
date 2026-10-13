//! The translation catalog: every file Sard may download for translation, pinned to one exact version.
//!
//! ## Why the catalog is compiled in, not fetched
//!
//! Each entry names a URL at an IMMUTABLE revision (a repository commit or a release tag, never a
//! branch), the exact byte size and the SHA-256 of the file. A download is accepted only when both
//! match, so what ends up on disk is decided by this file — and this file reaches users only inside a
//! signed Sard update. A host that later replaces, re-quantises or truncates a file cannot change what
//! Sard installs; it can only make the download fail.
//!
//! The consequence is deliberate: changing a model, a quantisation or the runtime is a code change,
//! reviewed and released like any other, never something that happens on a server. Nothing in Sard
//! ever switches a file or a version silently.
//!
//! ## Why there is a list of sources
//!
//! One source per file today. The list exists so that a second, Sard-controlled copy of the same bytes
//! can be added before public release without changing how a download is verified: the hash, not the
//! host, is what makes a file acceptable.

/// Where a file may be fetched from. Always a URL at an immutable revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    pub url: &'static str,
}

/// What a file is, which decides where it is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Model,
    Runtime,
}

/// The licence a file is distributed under. It decides what the user must be shown — and, for
/// `GemmaTerms`, accept — before the file may be downloaded. Presenting it is not this module's job;
/// recording it next to the file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Licence {
    /// The Gemma Terms of Use, which include the Gemma Prohibited Use Policy. They carry use
    /// restrictions that must be passed on to the user.
    GemmaTerms,
    /// Apache License 2.0.
    Apache2,
    /// llama.cpp (MIT) and the third-party licences its build embeds.
    LlamaCppRuntime,
}

/// One downloadable file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Artifact {
    /// Stable identifier. Also the name of the directory the file lives in, so it is a plain name.
    pub id: &'static str,
    pub kind: Kind,
    /// The file name on disk — the same name the source serves it under.
    pub file_name: &'static str,
    /// Exact size in bytes.
    pub size: u64,
    /// SHA-256 of the whole file, lowercase hex.
    pub sha256: &'static str,
    pub sources: &'static [Source],
    pub licence: Licence,
}

/// Candidate A: MiLMMT-46 4B, Q6_K. Quality-focused.
pub const MODEL_A: Artifact = Artifact {
    id: "milmmt-46-4b-q6k",
    kind: Kind::Model,
    file_name: "MiLMMT-46-4B-v1.0.Q6_K.gguf",
    size: 3_190_739_232,
    sha256: "056d0c29d132a8f77a791720e8032b252c1d4af3c5696a132aaf85416c4fc00b",
    sources: &[Source {
        url: "https://huggingface.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF/resolve/765aa350dc9aa28c41e2a9e34e1b25d56c0d3911/MiLMMT-46-4B-v1.0.Q6_K.gguf",
    }],
    licence: Licence::GemmaTerms,
};

/// Candidate B: Gemma 4 E2B instruction-tuned, Q4_0. Speed- and resource-focused.
pub const MODEL_B: Artifact = Artifact {
    id: "gemma-4-e2b-it-q4-0",
    kind: Kind::Model,
    file_name: "gemma-4-E2B-it-Q4_0.gguf",
    size: 2_841_481_184,
    sha256: "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52",
    sources: &[Source {
        url: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf",
    }],
    licence: Licence::Apache2,
};

/// The inference runtime for Windows x64: llama.cpp release b11501, Vulkan build — the exact build the
/// translation pipeline was evaluated with. Outputs differ between runtime builds, so this is pinned
/// exactly as the models are. One build serves both paths: GPU when a model fits, CPU otherwise.
pub const RUNTIME_WINDOWS_X64: Artifact = Artifact {
    id: "llama-b11501-win-vulkan-x64",
    kind: Kind::Runtime,
    file_name: "llama-b11501-bin-win-vulkan-x64.zip",
    size: 33_425_118,
    sha256: "6bf677025ae9ccdf5ca5e1ee1961ecaf25759f8cf63e875925a83bfaf00b7475",
    sources: &[Source {
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11501/llama-b11501-bin-win-vulkan-x64.zip",
    }],
    licence: Licence::LlamaCppRuntime,
};

/// Every file in the catalog.
pub const ALL: &[Artifact] = &[MODEL_A, MODEL_B, RUNTIME_WINDOWS_X64];

/// Look an artifact up by its identifier.
pub fn by_id(id: &str) -> Option<&'static Artifact> {
    ALL.iter().find(|a| a.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translation::download::{check_url, Policy};

    /// A name that is used as a path component must not be able to name anything but itself.
    fn is_plain_name(s: &str) -> bool {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }

    #[test]
    fn identifiers_and_file_names_are_plain_and_unique() {
        for a in ALL {
            assert!(is_plain_name(a.id), "id {:?} must be a plain name", a.id);
            assert!(is_plain_name(a.file_name), "file name {:?} must be a plain name", a.file_name);
            assert_ne!(a.file_name, crate::translation::store::RECORD_NAME, "{} would collide with the record", a.id);
        }
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                assert_ne!(a.id, b.id, "duplicate id");
            }
        }
    }

    #[test]
    fn every_entry_is_pinned_to_an_exact_file() {
        for a in ALL {
            assert!(a.size > 0, "{}: size", a.id);
            assert_eq!(a.sha256.len(), 64, "{}: sha256 length", a.id);
            assert!(a.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')), "{}: sha256 must be lowercase hex", a.id);
            assert!(!a.sources.is_empty(), "{}: needs a source", a.id);
        }
    }

    #[test]
    fn every_source_is_allowed_and_names_an_immutable_revision() {
        let policy = Policy::production();
        for a in ALL {
            for s in a.sources {
                check_url(&policy, s.url).unwrap_or_else(|e| panic!("{}: {} is refused: {e}", a.id, s.url));
                assert!(s.url.ends_with(&format!("/{}", a.file_name)), "{}: the URL must serve {}", a.id, a.file_name);
                // A Hugging Face URL must resolve a 40-hex commit, never a branch such as `main`; a GitHub
                // release URL names a tag, which the release process never moves.
                if let Some(rest) = s.url.split("/resolve/").nth(1) {
                    let rev = rest.split('/').next().unwrap_or("");
                    assert!(rev.len() == 40 && rev.chars().all(|c| c.is_ascii_hexdigit()), "{}: {rev:?} is not a commit", a.id);
                } else {
                    assert!(s.url.contains("/releases/download/"), "{}: unrecognised source form {}", a.id, s.url);
                }
            }
        }
    }

    #[test]
    fn the_licences_are_the_ones_the_evaluation_recorded() {
        assert_eq!(MODEL_A.licence, Licence::GemmaTerms);
        assert_eq!(MODEL_B.licence, Licence::Apache2);
        assert_eq!(RUNTIME_WINDOWS_X64.licence, Licence::LlamaCppRuntime);
        assert_eq!(by_id(MODEL_B.id), Some(&MODEL_B));
        assert_eq!(by_id("no-such-model"), None);
    }
}
