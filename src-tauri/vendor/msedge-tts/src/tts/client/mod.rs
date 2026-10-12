//! TTS Client module

use crate::tts::AudioMetadata;

/// Synthesized Audio and Metadata
#[derive(Debug)]
pub struct SynthesizedAudio {
    pub audio_format: String,
    pub audio_bytes: Vec<u8>,
    pub audio_metadata: Vec<AudioMetadata>,
}

/// Async Client
#[cfg(any(feature = "smol-runtime", feature = "tokio-runtime"))]
#[cfg_attr(
    docsrs,
    doc(cfg(any(feature = "smol-runtime", feature = "tokio-runtime")))
)]
pub struct MSEdgeTTSClientAsync<T>(pub(crate) async_tungstenite::WebSocketStream<T>);

#[cfg(any(feature = "smol-runtime", feature = "tokio-runtime"))]
impl<T: futures_util::io::AsyncRead + futures_util::io::AsyncWrite + Unpin>
    MSEdgeTTSClientAsync<T>
{
    /// Synthesize text to speech with a [crate::tts::SpeechConfig] asynchronously
    pub async fn synthesize(
        &mut self,
        text: &str,
        config: &crate::tts::SpeechConfig,
    ) -> crate::error::Result<SynthesizedAudio> {
        use futures_util::StreamExt;
        let config_message = crate::tts::build_config_message(config);
        let ssml_message = crate::tts::build_ssml_message(text, config);
        self.0.send(config_message).await?;
        self.0.send(ssml_message).await?;

        let mut audio_bytes = Vec::new();
        let mut audio_metadata = Vec::new();
        let mut turn_start = false;
        let mut response = false;
        let mut turn_end = false;
        loop {
            if turn_end {
                break;
            }

            if let Some(message) = self.0.next().await {
                let message = message?;
                let payload = crate::tts::Payload::process(
                    message,
                    &mut turn_start,
                    &mut response,
                    &mut turn_end,
                )?;
                if let Some(payload) = payload {
                    match payload {
                        crate::tts::Payload::AudioBytes(payload) => {
                            audio_bytes.push(payload);
                        }
                        crate::tts::Payload::AudioMetadata(metadata) => {
                            audio_metadata.extend(metadata);
                        }
                    }
                }
            }
        }

        let audio_bytes = audio_bytes
            .iter()
            .flat_map(|(bytes, index)| &bytes[*index..])
            .copied()
            .collect();

        Ok(SynthesizedAudio {
            audio_format: config.audio_format.clone(),
            audio_bytes,
            audio_metadata,
        })
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
