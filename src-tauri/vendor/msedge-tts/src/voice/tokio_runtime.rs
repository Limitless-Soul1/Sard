//! Functions to get all available voices asynchronously.
//!
//! Use [get_voices_list_async] function to get all available voices asynchronously.  
//! Use [get_voices_list_proxy_async] function to get all available voices with proxy asynchronously.

use crate::{constants, error::Result, voice::Voice};

/// Get all available voices asynchronously
///
/// Support Windows and MacOS system-proxy
pub async fn get_voices_list_async() -> Result<Vec<Voice>> {
    Ok(reqwest::Client::new()
        .get(constants::VOICE_LIST_URL)
        .header("User-Agent", constants::USER_AGENT)
        .send()
        .await?
        .json()
        .await?)
}

/// Get all available voices with proxy asynchronously
///
/// # Arguments:
///
/// * `proxy` - a str of format `<protocol>://<user>:<password>@<host>:port`.
#[cfg(feature = "proxy")]
#[cfg_attr(docsrs, doc(cfg(all(feature = "tokio-runtime", feature = "proxy"))))]
pub async fn get_voices_list_proxy_async(proxy: &str) -> Result<Vec<Voice>> {
    let proxy = reqwest::Proxy::all(proxy)?;
    Ok(reqwest::Client::builder()
        .proxy(proxy)
        .build()?
        .get(constants::VOICE_LIST_URL)
        .header("User-Agent", constants::USER_AGENT)
        .send()
        .await?
        .json()
        .await?)
}
