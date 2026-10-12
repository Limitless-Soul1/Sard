//! Tokio Async Runtime

use crate::error::Result;
use crate::tts::{client::MSEdgeTTSClientAsync, websocket_connect_tokio_async};

/// Create Async TTS [Client](MSEdgeTTSClientAsync)
pub async fn connect_async() -> Result<MSEdgeTTSClientAsync<async_tungstenite::tokio::ConnectStream>>
{
    Ok(MSEdgeTTSClientAsync(websocket_connect_tokio_async().await?))
}

#[cfg(feature = "proxy")]
#[cfg_attr(docsrs, doc(cfg(all(feature = "tokio-runtime", feature = "proxy"))))]
pub use crate::tts::proxy::tokio_runtime::connect_proxy_async;
