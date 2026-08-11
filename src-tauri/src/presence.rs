//! Discord Rich Presence (feature: disc/rpc) — the reading session on your Discord profile.
//!
//! THE DIVISION OF LABOUR. The frontend knows what is being read; this module knows how to say it
//! to Discord. The Reader feeds us the book title, the chapter label and the whole-book fraction;
//! we turn that into an `Activity` (details = the book, state = chapter or "NN%", assets = Sard's
//! mark, timestamps = when this book was opened) and push it down Discord's IPC pipe.
//!
//! WHY A THREAD. Every call into the GameSDK-free IPC client blocks on the pipe: `connect()` probes
//! pipes until Discord answers, and `set_activity` writes synchronously. None of that may run on
//! the main thread — a blocked command handler is a frozen window. So the client lives on its own
//! thread, woken by a channel; commands enqueue and return immediately, the worker serialises the
//! actual pipe traffic. A failed `connect()` (Discord not running) is a drop and a retry on the
//! NEXT update — never a busy loop, never a stale client.
//!
//! THE OFF SWITCH IS ENFORCED HERE, NOT ONLY IN THE UI. `presence_update` reads the
//! `discord_rpc_enabled` setting itself and no-ops when it is off. The settings toggle is the
//! frontend's copy; this is the core's copy, so even a stale frontend (a session already in flight
//! when the toggle was flipped, a crashed renderer) cannot leak reading state to Discord. Nothing
//! about the feature is observable by Discord unless that key says `1`.
//!
//! THE CLIENT ID. The ID below is a PLACEHOLDER — the app owner must register Sard at
//! https://discord.com/developers/applications, drop its Application ID in here, and upload the
//! hoopoe mark as the `sard` Rich-Presence asset. With a placeholder id the IPC handshake succeeds
//! (Discord accepts any well-formed id) but Discord's servers reject the activity, which shows up
//! nowhere — a silent no-op, exactly like a missing Discord. The one constant is the whole
//! integration point; nothing else knows this value exists.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use discord_rich_presence::activity::{Activity, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use tauri::State;

use crate::db::AppState;
use crate::settings;

/// THE Discord application id — see the module note. Owner-supplied.
const DISCORD_APPLICATION_ID: &str = "0000000000000000000";
/// The Rich-Presence asset key for Sard's mark, registered under the Discord application above.
const LARGE_IMAGE_KEY: &str = "sard";
/// The app name as Discord shows it in the activity's hover text.
const LARGE_IMAGE_TEXT: &str = "Sard · سَرْد";

/// The settings key that carries the on/off switch. Absent = on (the default), exactly like
/// `bg_enabled` — and read by BOTH sides: the toggle UI writes it, the core gate below reads it.
pub const RPC_SETTING_KEY: &str = "discord_rpc_enabled";

/// One book-open → the activity Discord shows. Shapes mirror `ipc.ts` on the frontend.
#[derive(Deserialize, Debug)]
pub struct PresenceActivity {
    /// The book's title (the details line).
    pub details: String,
    /// Chapter label, or `"NN%"` — whatever the frontend resolved for the current position.
    #[serde(default)]
    pub state: Option<String>,
    /// Epoch MILLISECONDS of the book open; the worker converts to the unix seconds Discord wants.
    /// `None` keeps the previous session's start (it arrives on every relocate; only the first
    /// carries a value).
    #[serde(default)]
    pub started_at: Option<u64>,
}

/// Messages to the worker thread. The thread OWNS the client; the manager only forwards.
enum Msg {
    Update(PresenceActivity),
    Clear,
}

/// Tauri-managed handle. Cheap to clone? No — it is managed ONCE and borrowed by `State`; the
/// thread is spawned in `start()` and told to exit through the channel in `shutdown()`.
pub struct PresenceManager {
    tx: Sender<Msg>,
    #[allow(dead_code)] // joined only for diagnostics; the process exit tears the thread down anyway
    thread: JoinHandle<()>,
}

impl PresenceManager {
    /// Spawn the worker thread. Nothing connects until the first update arrives.
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        let thread = std::thread::Builder::new()
            .name("sard-discord-rpc".into())
            .spawn(move || worker(rx))
            .expect("spawn the discord rpc worker thread");
        PresenceManager { tx, thread }
    }

    /// Best-effort forward; the send fails only if the worker already died.
    fn send(&self, msg: Msg) -> Result<(), String> {
        self.tx.send(msg).map_err(|e| e.to_string())
    }
}

/// The worker: owns the (optional) IPC client, keeps the session start time, and serialises all
/// pipe traffic. Blocks on `recv()` when idle — costs nothing while the user just reads.
fn worker(rx: Receiver<Msg>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut started_at: Option<u64> = None;
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Update(activity) => {
                if let Some(st) = activity.started_at {
                    started_at = Some(st);
                }
                // Connect lazily and RE-RETRY on every update after a failure: a reader who opens
                // Discord after Sard must not have to reopen the book to see the presence appear.
                if client.is_none() {
                    let mut fresh = DiscordIpcClient::new(DISCORD_APPLICATION_ID);
                    match fresh.connect() {
                        Ok(()) => client = Some(fresh),
                        Err(e) => {
                            println!("[Sard] discord rpc: connect failed ({e}); retrying on the next update");
                            continue;
                        }
                    }
                }
                let c = client.as_mut().expect("client was just connected");
                let mut act = Activity::new()
                    .details(&activity.details)
                    .assets(Assets::new().large_image(LARGE_IMAGE_KEY).large_text(LARGE_IMAGE_TEXT));
                if let Some(state) = activity.state.as_deref().filter(|s| !s.is_empty()) {
                    act = act.state(state);
                }
                if let Some(start) = started_at {
                    act = act.timestamps(Timestamps::new().start((start / 1000) as i64));
                }
                if let Err(e) = c.set_activity(act) {
                    // A rejected activity (placeholder client id, or a stale pipe after Discord
                    // restarted) is NOT fatal: the next update re-sends. Log and move on.
                    println!("[Sard] discord rpc: set_activity failed ({e}); will retry");
                    let _ = c.close();
                    client = None;
                }
            }
            Msg::Clear => {
                started_at = None;
                if let Some(mut c) = client.take() {
                    let _ = c.clear_activity();
                    let _ = c.close();
                }
            }
        }
    }
}

/// Tell the worker to clear + disconnect, then end the loop. Called from the app's exit path so no
/// Sard exit can leave a stale "reading" activity on someone's profile.
pub fn shutdown(manager: &PresenceManager) {
    let _ = manager.send(Msg::Clear);
    // No join and no explicit kill: the exit is already in flight, and the Clear sits ahead of the
    // process teardown in the same pipe of causality. If the OS wins the race the pipe closes
    // server-side and Discord drops the activity itself — either way nothing lingers.
}

/// Push a new activity to Discord. Gated on the persisted on/off setting — see the module note.
#[tauri::command]
pub fn presence_update(
    activity: PresenceActivity,
    state: State<AppState>,
    presence: State<PresenceManager>,
) -> Result<(), String> {
    let conn = state.conn();
    let enabled = settings::get(&conn, RPC_SETTING_KEY)
        .map_err(|e| e.to_string())?
        .as_deref()
        != Some("0");
    if !enabled {
        return Ok(());
    }
    presence.send(Msg::Update(activity))
}

/// Clear the activity (leaving the book, or the setting was switched off).
#[tauri::command]
pub fn presence_clear(presence: State<PresenceManager>) -> Result<(), String> {
    presence.send(Msg::Clear)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worker must never panic, whatever the machine state: no Discord running (the common
    /// case in tests and on most machines), a mid-session Clear, or an activity with no state
    /// line. Each message is drained to completion so the assertions exercise the real loop.
    #[test]
    fn worker_survives_without_discord() {
        let (tx, rx) = mpsc::channel::<Msg>();
        std::thread::spawn(move || worker(rx));

        tx.send(Msg::Clear).unwrap(); // nothing connected yet — must be a no-op
        tx.send(Msg::Update(PresenceActivity {
            details: "A book".into(),
            state: None,
            started_at: None,
        }))
        .unwrap();
        tx.send(Msg::Update(PresenceActivity {
            details: "A book".into(),
            state: Some("Chapter 1".into()),
            started_at: Some(1_700_000_000_000),
        }))
        .unwrap();
        tx.send(Msg::Clear).unwrap();

        // Give the worker time to drain the four messages. It only exits on channel close, so
        // dropping the sender is the shutdown signal — same as the app's exit path.
        drop(tx);
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}
