#![cfg_attr(docsrs, feature(doc_cfg))]

//! This library is a wrapper of **MSEdge Read aloud** function API.
//! You can use it to synthesize text to speech with many voices MS provided.
//!
//! # Features
//!
//! | Feature | Description |
//! |---|---|
//! | `blocking` (default) | Synchronous TTS client, stream, and voice list using `ureq` and `tungstenite`. |
//! | `smol-runtime` | Async runtime based on [`smol`](https://docs.rs/smol). Enables async client, stream, and voice list. |
//! | `tokio-runtime` | Async runtime based on [`tokio`](https://docs.rs/tokio). Enables async client, stream, and voice list. |
//! | `proxy` | SOCKS4/5 and HTTP CONNECT proxy support. Pairs with any runtime feature. |
//!
//! # How to use
//! 1. You need get a [tts::SpeechConfig] to configure the voice of text to speech.  
//!    You can convert [voice::Voice] to [tts::SpeechConfig] simply. Use [voice::get_voices_list] function to get all available voices.  
//!    [voice::Voice] and [tts::SpeechConfig] implemented [serde::Serialize] and [serde::Deserialize].  
//!    For example:
//!     ```rust
//!     use msedge_tts::voice::get_voices_list;
//!     use msedge_tts::tts::SpeechConfig;
//!     
//!     let voices = get_voices_list().unwrap();
//!     let speechConfig = SpeechConfig::from(&voices[0]);
//!     ```
//!     You can also create [tts::SpeechConfig] by yourself. Make sure you know the right **voice name** and **audio format**.
//!
//! 2. Create a TTS [tts::client] or [tts::stream].
//!
//! 3. Synthesize text to speech.
//!     ### Sync Client
//!     Call client function [synthesize](tts::client::MSEdgeTTSClient::synthesize) to synthesize text to speech. This function return Type [SynthesizedAudio](tts::client::SynthesizedAudio),
//!    you can get [audio_bytes](tts::client::SynthesizedAudio::audio_bytes) and [audio_metadata](tts::client::SynthesizedAudio::audio_metadata).
//!     ```rust
//!     use msedge_tts::{tts::client::connect, tts::SpeechConfig, voice::get_voices_list};
//!     
//!     let voices = get_voices_list().unwrap();
//!     for voice in &voices {
//!         if voice.name.contains("YunyangNeural") {
//!             let config = SpeechConfig::from(voice);
//!             let mut tts = connect().unwrap();
//!             let audio = tts
//!                 .synthesize("Hello, World! 你好，世界！", &config)
//!                 .unwrap();
//!             break;
//!         }
//!     }
//!     ```
//!     ### Sync Stream
//!     Call Sender Stream function [send](tts::stream::Sender::send) to synthesize text to speech. Call Reader Stream function [read](tts::stream::Receiver::read) to get data.  
//!    [read](tts::stream::Receiver::read) return [Option\<SynthesizedResponse\>](tts::stream::SynthesizedResponse), the response may be [AudioBytes](tts::stream::SynthesizedResponse::AudioBytes)
//!    or [AudioMetadata](tts::stream::SynthesizedResponse::AudioMetadata) or None. This is because the **MSEdge Read aloud** API returns multiple data segment and metadata and other information sequentially.  
//!
//!     **Caution**: One [send](tts::stream::Sender::send) corresponds to multiple [read](tts::stream::Receiver::read). Next [send](tts::stream::Sender::send) call will block until there no data to read.
//!    [read](tts::stream::Receiver::read) will block before you call a [send](tts::stream::Sender::send).
//!     ```rust
//!     use msedge_tts::{
//!         tts::stream::{msedge_tts_split, SynthesizedResponse},
//!         tts::SpeechConfig,
//!         voice::get_voices_list,
//!     };
//!     use std::{
//!         sync::{
//!             atomic::{AtomicBool, Ordering},
//!             Arc,
//!         },
//!         thread::spawn,
//!     };
//!     
//!     let voices = get_voices_list().unwrap();
//!     for voice in &voices {
//!         if voice.name.contains("YunyangNeural") {
//!             let config = SpeechConfig::from(voice);
//!             let (mut sender, mut reader) = msedge_tts_split().unwrap();
//!
//!             let signal = Arc::new(AtomicBool::new(false));
//!             let end = signal.clone();
//!             spawn(move || {
//!                 sender.send("Hello, World! 你好，世界！", &config).unwrap();
//!                 println!("synthesizing...1");
//!                 sender.send("Hello, World! 你好，世界！", &config).unwrap();
//!                 println!("synthesizing...2");
//!                 sender.send("Hello, World! 你好，世界！", &config).unwrap();
//!                 println!("synthesizing...3");
//!                 sender.send("Hello, World! 你好，世界！", &config).unwrap();
//!                 println!("synthesizing...4");
//!                 end.store(true, Ordering::Relaxed);
//!             });
//!
//!             loop {
//!                 if signal.load(Ordering::Relaxed) && !reader.can_read() {
//!                     break;
//!                 }
//!                 let audio = reader.read().unwrap();
//!                 if let Some(audio) = audio {
//!                     match audio {
//!                         SynthesizedResponse::AudioBytes(_) => {
//!                             println!("read bytes")
//!                         }
//!                         SynthesizedResponse::AudioMetadata(_) => {
//!                             println!("read metadata")
//!                         }
//!                     }
//!                 } else {
//!                     println!("read None");
//!                 }
//!             }
//!         }
//!     }
//!     ```  

mod constants;

pub mod error;
pub mod tts;
pub mod voice;
