use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Condvar, Mutex},
};

use crate::{
    error::Result,
    tts::{
        Payload, RustlsStream, SpeechConfig, build_config_message, build_ssml_message,
        stream::SynthesizedResponse, websocket_connect,
    },
};

/// Sync TTS Stream Sender
pub struct Sender<T: Read + Write> {
    websocket: Arc<Mutex<tungstenite::WebSocket<RustlsStream<T>>>>,
    can_read_cvar: Arc<(Mutex<bool>, Condvar)>,
}

impl<T: Read + Write> Sender<T> {
    /// Synthesize text to speech with a [SpeechConfig] synchronously.  
    /// **Caution**: One [send](Self::send) corresponds to multiple [read](Receiver::read). Next [send](Self::send) call will block until there no data to read.
    /// [read](Receiver::read) will block before you call a [send](Self::send).
    pub fn send(&mut self, text: &str, config: &SpeechConfig) -> Result<()> {
        let (can_read, cvar) = &*self.can_read_cvar;
        let mut can_read = can_read.lock().unwrap();
        while *can_read {
            can_read = cvar.wait(can_read).unwrap();
        }

        let config_message = build_config_message(config);
        let ssml_message = build_ssml_message(text, config);
        let mut websocket = self.websocket.lock().unwrap();
        websocket.send(config_message)?;
        websocket.send(ssml_message)?;

        *can_read = true;
        cvar.notify_one();
        Ok(())
    }

    /// Check if can send
    pub fn can_send(&self) -> bool {
        let (can_read, _) = &*self.can_read_cvar;
        !*can_read.lock().unwrap()
    }
}

/// Sync TTS Stream Reader
pub struct Receiver<T: Read + Write> {
    websocket: Arc<Mutex<tungstenite::WebSocket<RustlsStream<T>>>>,
    can_read_cvar: Arc<(Mutex<bool>, Condvar)>,
    turn_start: bool,
    response: bool,
    turn_end: bool,
}

impl<T: Read + Write> Receiver<T> {
    /// Read Synthesized Audio synchronously.  
    /// **Caution**: One [send](Sender::send) corresponds to multiple [read](Self::read). Next [send](Sender::send) call will block until there no data to read.
    /// [read](Self::read) will block before you call a [send](Sender::send).
    pub fn read(&mut self) -> Result<Option<SynthesizedResponse>> {
        let (can_read, cvar) = &*self.can_read_cvar;
        let mut can_read = can_read.lock().unwrap();
        while !*can_read {
            can_read = cvar.wait(can_read).unwrap();
        }

        let mut websocket = self.websocket.lock().unwrap();
        let message = Payload::process(
            websocket.read()?,
            &mut self.turn_start,
            &mut self.response,
            &mut self.turn_end,
        )?;

        if self.turn_start && self.response && self.turn_end {
            self.turn_start = false;
            self.response = false;
            self.turn_end = false;
            *can_read = false;
            cvar.notify_one();
        }

        Ok(message.map(|message| message.into()))
    }

    /// Check if can read
    pub fn can_read(&self) -> bool {
        let (can_read, _) = &*self.can_read_cvar;
        *can_read.lock().unwrap()
    }
}

pub(crate) fn split<T: Read + Write>(
    websocket: tungstenite::WebSocket<RustlsStream<T>>,
) -> Result<(Sender<T>, Receiver<T>)> {
    let websocket = Arc::new(Mutex::new(websocket));
    let can_read_cvar = Arc::new((Mutex::new(false), Condvar::new()));
    let sender = Sender {
        websocket: websocket.clone(),
        can_read_cvar: can_read_cvar.clone(),
    };
    let reader = Receiver {
        websocket,
        can_read_cvar,
        turn_start: false,
        response: false,
        turn_end: false,
    };
    Ok((sender, reader))
}

/// Create Sync TTS Stream [Sender] and [Receiver]
pub fn msedge_tts_split() -> Result<(Sender<TcpStream>, Receiver<TcpStream>)> {
    split(websocket_connect()?)
}

#[cfg(feature = "proxy")]
#[cfg_attr(docsrs, doc(cfg(all(feature = "blocking", feature = "proxy"))))]
pub use crate::tts::proxy::blocking::msedge_tts_split_proxy;
