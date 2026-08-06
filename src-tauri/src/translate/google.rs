//! Google Translate — the unofficial, keyless `translate_a/single` endpoint.
//!
//! This is the same endpoint the free Google Translate web UI hits. It needs no API key and no
//! signup, which preserves Sard's no-account ethos for the default path. The trade-off, on the
//! record: it is undocumented, so it could change or start rejecting anonymous traffic. That is an
//! acceptable risk for a personal reading tool, and the DeepL provider exists as the stable,
//! documented fallback for anyone who hits it.
//!
//! Response shape: a nested JSON array `[[[<translated>, <original>, ...], ...], ..., [<source-lang>]]`.
//! serde_json's `Value` is the honest representation — there is no documented contract to model.

use serde_json::Value;

use super::TranslateResult;

/// The endpoint. `client=gtx` is the param that makes it answer anonymous browser-style requests
/// instead of redirecting to the web UI; without it the call 404s.
const ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";

pub fn translate(
    agent: &ureq::Agent,
    text: &str,
    target: &str,
) -> Result<TranslateResult, String> {
    // POST, not GET: a full page of text is far too long for a URL query param. The endpoint
    // accepts the SAME urlencoded params in the request body (measured: GET 400s at ~15 KB; POST
    // returns valid translations at 100 KB+). The body is sent with `.send_empty()` — ureq 3's
    // typestate puts `post()` in RequestBuilder<WithBody>, where the bodyless `.call()` is absent;
    // `.send_empty()` is the explicit "no body" send and the params live in `.query()` either way.
    // (The form params are identical whether on the URL or in the body — the endpoint reads both.)
    let resp = agent
        .post(ENDPOINT)
        .query("client", "gtx")
        .query("sl", "auto")
        .query("tl", target)
        .query("dt", "t")
        .query("q", text)
        .send_empty()
        .map_err(|e| format!("Google request failed: {e}"))?;

    let body: Value = resp
        .into_body()
        .read_json()
        .map_err(|e| format!("Google response parse failed: {e}"))?;

    // [0] is the array of [translated, original, ...] segment pairs. Concatenate the translated
    // halves (index 0 of each pair) for the full text — multi-sentence selections arrive as several.
    let text_out = body
        .get(0)
        .and_then(|segs| segs.as_array())
        .map(|segs| {
            segs.iter()
                .filter_map(|s| s.get(0).and_then(|t| t.as_str()))
                .collect::<Vec<&str>>()
                .join("")
        })
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Google returned an empty translation".to_string())?;

    // [2] is the auto-detected source language code (e.g. "ar", "en"). Best-effort: absent on some
    // responses, and we prefer to return None than guess.
    let detected = body
        .get(2)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(TranslateResult {
        text: text_out,
        detected_source: detected,
        provider: "google",
    })
}
