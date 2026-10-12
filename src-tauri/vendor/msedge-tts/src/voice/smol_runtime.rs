//! Functions to get all available voices asynchronously.
//!
//! Actually there is no well maintained async http client for smol,
//! so we use [async-compat](https://docs.rs/async-compat) and [reqwest](https://docs.rs/reqwest).
//!
//! Use [get_voices_list_async] function to get all available voices asynchronously.  
//! Use [get_voices_list_proxy_async] function to get all available voices with proxy asynchronously.

use crate::{constants, error::Result, voice::Voice};

/// Get all available voices asynchronously
///
/// Support Windows and MacOS system-proxy
pub async fn get_voices_list_async() -> Result<Vec<Voice>> {
    Ok(async_compat::Compat::new(async {
        reqwest::Client::new()
            .get(constants::VOICE_LIST_URL)
            .header("User-Agent", constants::USER_AGENT)
            .send()
            .await?
            .json()
            .await
    })
    .await?)
}

/// Get all available voices with proxy asynchronously
///
/// # Arguments:
///
/// * `proxy` - a str of format `<protocol>://<user>:<password>@<host>:port`.
#[cfg(feature = "proxy")]
#[cfg_attr(docsrs, doc(cfg(all(feature = "smol-runtime", feature = "proxy"))))]
pub async fn get_voices_list_proxy_async(proxy: &str) -> Result<Vec<Voice>> {
    let proxy = reqwest::Proxy::all(proxy)?;
    Ok(async_compat::Compat::new(async {
        reqwest::Client::builder()
            .proxy(proxy)
            .build()?
            .get(constants::VOICE_LIST_URL)
            .header("User-Agent", constants::USER_AGENT)
            .send()
            .await?
            .json()
            .await
    })
    .await?)
}
