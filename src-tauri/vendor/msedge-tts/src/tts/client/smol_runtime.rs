//! Smol Async Runtime

use crate::error::Result;
use crate::tts::{client::MSEdgeTTSClientAsync, websocket_connect_smol_async};

/// Create Async TTS [Client](MSEdgeTTSClientAsync)
pub async fn connect_async() -> Result<MSEdgeTTSClientAsync<async_tungstenite::smol::ConnectStream>>
{
    Ok(MSEdgeTTSClientAsync(websocket_connect_smol_async().await?))
}

#[cfg(feature = "proxy")]
#[cfg_attr(docsrs, doc(cfg(all(feature = "smol-runtime", feature = "proxy"))))]
pub use crate::tts::proxy::smol_runtime::connect_proxy_async;
