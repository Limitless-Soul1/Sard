//! DeepL — the official REST API (free or paid tier).
//!
//! Documented and stable, best European-language quality, decent Arabic. Requires an API key
//! entered in Settings. The free-tier host (`api-free.deepl.com`) and the paid host
//! (`api.deepl.com`) are selected by the key prefix DeepL itself issues ("tfc-..." vs the rest),
//! so the reader never has to know which plan they are on.
//!
//! Response shape is documented JSON `{ translations: [{ text, detected_source_language }] }`, so
//! unlike Google this one gets a real struct.

use serde::Deserialize;

use super::TranslateResult;

pub fn translate(
    agent: &ureq::Agent,
    text: &str,
    target: &str,
    key: &str,
) -> Result<TranslateResult, String> {
    // DeepL keys are prefixed `tfc-` for the free plan; anything else is the paid plan host.
    let host = if key.starts_with("tfc-") {
        "api-free.deepl.com"
    } else {
        "api.deepl.com"
    };
    let url = format!("https://{host}/v2/translate");

    // DeepL's target param is uppercase (`EN`, not `en`); source auto-detection is the default when
    // no `source_lang` is supplied.
    let target_up = target.to_uppercase();
    // ureq 3 typestate: `post()` returns `RequestBuilder<WithBody>`, where `.call()` (the bodyless
    // GET trigger) is not available. `.send_empty()` is the explicit "POST with no body" send.
    let resp = agent
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .query("target_lang", target_up.as_str())
        .query("text", text)
        .send_empty()
        .map_err(|e| format!("DeepL request failed: {e}"))?;

    #[derive(Deserialize)]
    struct DeepLResp {
        translations: Vec<DeepLTr>,
    }
    #[derive(Deserialize)]
    struct DeepLTr {
        text: String,
        detected_source_language: Option<String>,
    }

    let parsed: DeepLResp = resp
        .into_body()
        .read_json()
        .map_err(|e| format!("DeepL response parse failed: {e}"))?;

    let tr = parsed
        .translations
        .into_iter()
        .next()
        .ok_or_else(|| "DeepL returned no translations".to_string())?;

    Ok(TranslateResult {
        text: tr.text,
        detected_source: tr.detected_source_language,
        provider: "deepl",
    })
}
