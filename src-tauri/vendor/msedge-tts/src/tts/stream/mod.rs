//! TTS Stream module

use crate::tts::{AudioMetadata, Payload};

/// Synthesized Stream Response
#[derive(Debug)]
pub enum SynthesizedResponse {
    /// Synthesized Audio bytes segment
    AudioBytes(Vec<u8>),
    /// Synthesized Audio Metadata segment
    AudioMetadata(Vec<AudioMetadata>),
}

impl From<Payload> for SynthesizedResponse {
    fn from(payload: Payload) -> Self {
        match payload {
            Payload::AudioBytes((bytes, index)) => {
                SynthesizedResponse::AudioBytes(bytes[index..].to_vec())
            }
            Payload::AudioMetadata(metadata) => SynthesizedResponse::AudioMetadata(metadata),
        }
    }
}

#[cfg(feature = "blocking")]
mod blocking;
#[cfg(feature = "blocking")]
#[cfg_attr(docsrs, doc(cfg(feature = "blocking")))]
pub use blocking::*;

#[cfg(feature = "smol-runtime")]
#[cfg_attr(docsrs, doc(cfg(feature = "smol-runtime")))]
pub mod smol_runtime;

#[cfg(feature = "tokio-runtime")]
#[cfg_attr(docsrs, doc(cfg(feature = "tokio-runtime")))]
pub mod tokio_runtime;
