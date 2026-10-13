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

/// One file of the inference engine, as installed from its runtime archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// The inference engine: which archive it comes from and exactly which of its files are installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineSpec {
    pub archive: &'static Artifact,
    pub files: &'static [EngineFile],
    /// The archive's other entries: known, and deliberately never installed. With `files` this accounts for
    /// every entry, so an archive holding anything else is refused.
    pub unused: &'static [&'static str],
    /// The server executable, one of `files`.
    pub executable: &'static str,
    /// The oldest Microsoft Visual C++ runtime this build may be run with, as (major, minor).
    pub min_vc_runtime: (u16, u16),
    /// Written next to the engine: the licence texts the build itself declares.
    pub notices_name: &'static str,
    pub notices: &'static str,
}

/// The Windows x64 engine: 24 of the 52 files in `RUNTIME_WINDOWS_X64`.
///
/// ## Which files, and why exactly these
///
/// Established by reading the binaries, not by trial:
///
/// * The import tables of `llama-server.exe` close over eight files: the executable, `llama-server-impl.dll`,
///   `llama-common.dll`, `llama.dll`, `mtmd.dll`, `ggml.dll`, `ggml-base.dll` and `libomp.dll`.
/// * ggml then loads its compute backends at run time. It loads every `ggml-<backend>-*.dll`, or an exact
///   `ggml-<backend>.dll`, found in the executable's directory or the current directory. That is why
///   `ggml-vulkan.dll` (the GPU) and all fourteen `ggml-cpu-*.dll` variants are here: the loader scores the
///   variants and keeps the best one for the machine's processor.
/// * It is also why `ggml-rpc.dll` is NOT here: present, it would be loaded, and nothing needs a remote
///   backend.
/// * `LICENSE-LLVM-OpenMP` is the archive's only licence file.
///
/// Everything else in the archive (benchmarks, converters, other command-line tools) is listed in `unused` and
/// never extracted: 24 installed and 28 not, the archive's 52 entries.
///
/// ## Where the values come from
///
/// * **The archive's SHA-256** in `RUNTIME_WINDOWS_X64` is confirmed three ways:
///   * the digest GitHub reports for the release asset (uploaded by the project's own CI on 2026-10-08);
///   * the value recorded when the file was first downloaded on 2026-10-09;
///   * a fresh download on 2026-10-13.
/// * **Each file's size and SHA-256** below was read from that verified archive, and matched byte for byte
///   against two independent copies: the extraction used for every evaluation run, and the second download.
/// * **The release tag** `b11501` resolves to commit `46baf1f1fec5a06d1e52122a9207ca978b720f95`. That matches the
///   build's own version string.
///
/// ## The Visual C++ runtime it needs
///
/// The system's Visual C++ runtime (`MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`) is NOT part of the
/// archive. The engine imports it, and Sard itself does not, so it is checked before every launch — that it is
/// there, and that it is recent enough.
///
/// `min_vc_runtime` is 14.51, and this is where that comes from:
///
/// * **Microsoft's rule.** The installed runtime must be at least as recent as the tools a program was built
///   with ("Latest supported Visual C++ Redistributable downloads", Microsoft Learn).
/// * **The tools this build was made with.** The release's own build script builds these binaries with the
///   Visual Studio 2026 tools, and the one binary that records its linker's version, `ggml-vulkan.dll`, records
///   14.51.
/// * **Why it is not a formality.** Five of the binaries lock mutexes through the runtime (`_Mtx_lock`) and none
///   initialises one through it (`_Mtx_init_in_situ`). That is how code built with the 14.40 tools or later
///   looks, and Microsoft's standard-library changelog says of it that a program run with an older runtime
///   "may encounter null dereferences in `mutex` machinery".
/// * **Why Windows would not catch it.** Every function the engine imports from the runtime is exported by
///   every version of it back to 2015 (26 versions of `MSVCP140.dll` were compared). An old runtime would load;
///   the engine would start, and then fail.
///
/// 14.40 is the oldest runtime the mutex evidence alone would allow. 14.51 is what Microsoft's rule asks for, and
/// nothing here was run to show that anything older is enough.
pub const ENGINE_WINDOWS_X64: EngineSpec = EngineSpec {
    archive: &RUNTIME_WINDOWS_X64,
    files: &[
        EngineFile { name: "llama-server.exe", size: 9_216, sha256: "52adee6baa13aad64018dafcc0bb8f07d2a70f6c90b1f777a74df989f44d8355" },
        EngineFile { name: "llama-server-impl.dll", size: 9_207_808, sha256: "92aa6001b0430045e14cf733d088f68aa58112905f9a70d6d2e088515c8eacc4" },
        EngineFile { name: "llama-common.dll", size: 8_005_632, sha256: "26657dcaf2b439e56cd503b52be6eaad6fb1402729636f9ea37eff50fa33b3e2" },
        EngineFile { name: "llama.dll", size: 3_377_664, sha256: "658d78991e4c814b758f2ec7665309ad4d659c7f609d89d1dc957dd9a749a55c" },
        EngineFile { name: "mtmd.dll", size: 1_817_600, sha256: "93b873ad02ffd90bd81b2c0d93f1a8aadf49383072166d75f2fa4c50f9c99fac" },
        EngineFile { name: "ggml.dll", size: 79_872, sha256: "a2ca1d7a0e3c939aab0803b0731020eb8ea3a3d2a3deae7229d976ac5f3f82e9" },
        EngineFile { name: "ggml-base.dll", size: 801_792, sha256: "c40814972fa492e109e3585ab7999241860e233f3db846e481f6f7b19a3e5ba4" },
        EngineFile { name: "libomp.dll", size: 768_000, sha256: "a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c" },
        EngineFile { name: "ggml-vulkan.dll", size: 45_305_856, sha256: "ac89a3795faf520d3ec34cea40355fc3fcac690808aec81fe525aad9e75cc683" },
        EngineFile { name: "ggml-cpu-alderlake.dll", size: 1_435_136, sha256: "2e7b306b728f62089208735a22accd7778e5fb7e7c02aa00c70bdb811a0cf42a" },
        EngineFile { name: "ggml-cpu-cannonlake.dll", size: 1_614_848, sha256: "d896b1bd80ed7667cda224d00632f81991e03f8b37f689bdecad92ae4de9804d" },
        EngineFile { name: "ggml-cpu-cascadelake.dll", size: 1_599_488, sha256: "d234545660c7e5a83f619fda4b7e8e8f6adaa2c6034044945ed53a745c38dd97" },
        EngineFile { name: "ggml-cpu-cooperlake.dll", size: 1_609_216, sha256: "07a67ff9ba4e14e324efa23a465fd7db79f5bfce2c338d4d5d5a619bc7c84394" },
        EngineFile { name: "ggml-cpu-haswell.dll", size: 1_439_744, sha256: "820d913f3bc945ab2d7df2c2ee02ebb7ecf95854279c0b7d437ee3da2f57efbb" },
        EngineFile { name: "ggml-cpu-icelake.dll", size: 1_606_656, sha256: "635a628e008cce3578820b59c374dd196d35c26528819deaf81b2109a83b0a99" },
        EngineFile { name: "ggml-cpu-ivybridge.dll", size: 1_315_328, sha256: "6627a22e173094f2b7257acc0df708ea5da541d93b6f35d3d8a1266729bb195d" },
        EngineFile { name: "ggml-cpu-piledriver.dll", size: 1_308_160, sha256: "312d03fb1b7c2830fb019d9f8376ca82164497604b29e7bb7d837acfb3d83086" },
        EngineFile { name: "ggml-cpu-sandybridge.dll", size: 1_290_240, sha256: "99a2f53f7a96698d4769f485ef56577f195507bd4c71504c14484867a7096f22" },
        EngineFile { name: "ggml-cpu-sapphirerapids.dll", size: 1_886_208, sha256: "356f43a4aa2ec66ee695a4f8837dbbd0da5a6cb399b84b85a72de76d0a296367" },
        EngineFile { name: "ggml-cpu-skylakex.dll", size: 1_608_704, sha256: "f676d392e7ae57f4f48daf201728a8ff49f52b9b38cafc587cbe026db21389f6" },
        EngineFile { name: "ggml-cpu-sse42.dll", size: 915_968, sha256: "87d487df961bea00cfe8f1f8ab04f6f2a7233d1b851735c61804712bf55582e9" },
        EngineFile { name: "ggml-cpu-x64.dll", size: 908_800, sha256: "ed0a99535f89d8ca6fd61338fa0a8adedddf27e10ff2f1e775f120ad88277765" },
        EngineFile { name: "ggml-cpu-zen4.dll", size: 1_615_872, sha256: "4c13fd851f61d1ddd559f187d534aedfaf8028b6816df228b5725667c13cdc0c" },
        EngineFile { name: "LICENSE-LLVM-OpenMP", size: 19_741, sha256: "fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4" },
    ],
    unused: &[
        "ggml-rpc-server.exe",
        "ggml-rpc.dll",
        "llama-batched-bench-impl.dll",
        "llama-batched-bench.exe",
        "llama-bench-impl.dll",
        "llama-bench.exe",
        "llama-cli-impl.dll",
        "llama-cli.exe",
        "llama-completion-impl.dll",
        "llama-completion.exe",
        "llama-fit-params-impl.dll",
        "llama-fit-params.exe",
        "llama-gemma3-cli.exe",
        "llama-gguf-split.exe",
        "llama-imatrix.exe",
        "llama-llava-cli.exe",
        "llama-minicpmv-cli.exe",
        "llama-mtmd-cli.exe",
        "llama-mtmd-debug.exe",
        "llama-perplexity-impl.dll",
        "llama-perplexity.exe",
        "llama-quantize-impl.dll",
        "llama-quantize.exe",
        "llama-qwen2vl-cli.exe",
        "llama-results.exe",
        "llama-tokenize.exe",
        "llama-tts.exe",
        "llama.exe",
    ],
    executable: "llama-server.exe",
    min_vc_runtime: (14, 51),
    notices_name: "THIRD-PARTY-NOTICES.txt",
    // The licence texts the build itself declares (`llama.exe licenses`): llama.cpp, LLVM OpenMP, cpp-httplib,
    // BoringSSL and JSON for Modern C++. Each was compared with its source and found identical:
    // * four with the release's own source tree;
    // * BoringSSL's with its upstream repository at the tag the release's build script fetches —
    //   `0.20260929.0`, commit `427ec40cc8edc545253289232e885708c409e5ea`. The build embeds that tag's `LICENSE`
    //   file as it stands. It is the Apache License 2.0, and the tag has no `NOTICE` file.
    //
    // BoringSSL is compiled into two of the installed files, `llama-server-impl.dll` and `llama-common.dll`.
    notices: include_str!("engine-notices.txt"),
};

/// How a model is launched: the exact server flags the translation pipeline was evaluated with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchProfile {
    /// Full GPU offload — the configuration the pipeline was frozen with.
    pub gpu: &'static [&'static str],
    /// CPU only. The thread count is added by the caller; the device is always `none`.
    pub cpu: &'static [&'static str],
}

/// The launch profile for a model in the catalog, or `None` for anything that is not a model.
pub fn launch_profile(a: &Artifact) -> Option<LaunchProfile> {
    // A — the frozen GPU flags, and the CPU configuration measured for it (default load mode).
    const A: LaunchProfile = LaunchProfile {
        gpu: &["-ngl", "99", "-lm", "none", "-b", "256", "-ub", "256", "-t", "6", "-tb", "6", "-np", "1", "-c", "6144", "--cache-ram", "0", "--jinja"],
        cpu: &["-ngl", "0", "-b", "256", "-ub", "256", "-np", "1", "-c", "6144", "--cache-ram", "0", "--jinja"],
    };
    // B — the frozen GPU flags, and the same flags without the GPU for CPU-only runs.
    const B: LaunchProfile = LaunchProfile {
        gpu: &["-ngl", "99", "-lm", "mmap", "-t", "2", "-tb", "2", "-np", "1", "-c", "6144", "--cache-ram", "0", "--jinja"],
        cpu: &["-ngl", "0", "-lm", "mmap", "-np", "1", "-c", "6144", "--cache-ram", "0", "--jinja"],
    };
    if a.id == MODEL_A.id {
        Some(A)
    } else if a.id == MODEL_B.id {
        Some(B)
    } else {
        None
    }
}

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
