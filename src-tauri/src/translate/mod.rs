//! Selection-based translation (Google unofficial + DeepL official).
//!
//! The only module that talks to a third-party translation service. Everything else in Sard is
//! offline-first and local; this is an explicit, opt-in exception to that rule, called from exactly
//! one IPC command (`commands::translate`). The provider is chosen in Global Settings and the API
//! key (DeepL only) is held in the `settings` KV table, read here — never in the frontend.
//!
//! Design constraints, on the record:
//! * **Off by default.** `translate` is a no-op until the reader enables it in Settings. The
//!   frontend toolbar button is not even rendered while disabled, so there is no path to send text
//!   to a provider by accident.
//! * **No storage.** A translation crosses the IPC seam once, as a return value, and is never
//!   written to the DB. The "one file on your machine" guarantee stays literally true.
//! * **Network only from Rust.** The webview CSP locks `connect-src` to `'self' ipc: asset:`; the
//!   call therefore must go through `ureq` here. That also keeps any API key out of JS.
//!
//! The two providers share one HTTP agent (ureq 3, rustls via aws-lc-rs — the same crypto provider
//! pinned at startup in `lib::run`, so no ambiguity) and one timeout budget. Each lives in its own
//! file so the parsing of one never reads like the parsing of the other.

use serde::{Deserialize, Serialize};

pub mod deepl;
pub mod google;

/// Which provider a translation is routed to. Stored as `translator.provider` in the `settings`
/// table; the strings are part of the on-disk format and never change.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Deepl,
}

impl Provider {
    /// Parse the stored string back into a variant, defaulting to Google on anything unrecognized.
    /// Defaulting is safe because a bad value can only come from a hand-edited DB; the settings UI
    /// only ever writes the two canonical strings.
    pub fn from_stored(s: &str) -> Option<Self> {
        match s {
            "google" => Some(Provider::Google),
            "deepl" => Some(Provider::Deepl),
            _ => None,
        }
    }

    /// The canonical string written to disk. Kept explicit (not `serde` derive on the store path)
    /// so a rename of a variant can never silently change what is persisted.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Deepl => "deepl",
        }
    }
}

/// The structured result returned to the frontend. `detected_source` is best-effort — Google's
/// unofficial endpoint returns it, DeepL returns it on paid plans; `None` is honest when unknown.
#[derive(Serialize)]
pub struct TranslateResult {
    pub text: String,
    pub detected_source: Option<String>,
    pub provider: &'static str,
}

/// Resolve the target language from the optional stored override, falling back to the app's UI
/// language. Sard is bilingual (ar/en), so this is the only meaningful default: an Arabic reader
/// wants English and vice versa. A reader who wants a third language sets the override.
pub fn resolve_target(stored_override: Option<&str>, app_lang: &str) -> String {
    if let Some(o) = stored_override.filter(|s| !s.is_empty()) {
        return o.to_string();
    }
    // Auto: translate TO the reader's own interface language — a reader using Sard in Arabic is, almost
    // by definition, reading a foreign-language book and wants Arabic back, and vice versa.
    if app_lang == "ar" {
        "ar".to_string()
    } else {
        "en".to_string()
    }
}

/// Build the shared HTTP agent. Mirrors the timeouts in `tts::tts_download_voice`: a fast visible
/// failure on an unreachable host, but enough room for a real round-trip. A translation payload is
/// tiny, so the recv timeout is tighter than a voice-model download.
fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(std::time::Duration::from_secs(15)))
            .timeout_recv_response(Some(std::time::Duration::from_secs(20)))
            .build(),
    )
}

/// Run a translation through the configured provider. The caller (`commands::translate`) has
/// already checked that translation is enabled and resolved provider + key; this function's job is
/// purely "ask the right service and shape the answer."
pub fn run(
    text: &str,
    provider: Provider,
    target: &str,
    deepl_key: Option<&str>,
) -> Result<TranslateResult, String> {
    let agent = agent();
    match provider {
        Provider::Google => google::translate(&agent, text, target),
        Provider::Deepl => {
            let key = deepl_key.ok_or_else(|| {
                "DeepL is selected but no API key is set. Add one in Settings.".to_string()
            })?;
            deepl::translate(&agent, text, target, key)
        }
    }
}
