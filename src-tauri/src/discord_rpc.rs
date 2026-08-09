// src-tauri/src/discord_rpc.rs
//
// Discord Rich Presence integration.
// Shows the currently-open book (title + optional author/progress)
// on the user's Discord profile, if they opt in via Settings.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// Replace with your own Discord Application ID from
// https://discord.com/developers/applications
const DISCORD_APP_ID: &str = "1421191366247186563";

pub struct DiscordState(pub Mutex<Option<DiscordIpcClient>>);

impl Default for DiscordState {
    fn default() -> Self {
        DiscordState(Mutex::new(None))
    }
}

/// Try to connect to a locally-running Discord client.
/// Safe to call even if Discord isn't running - just returns None.
fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID).ok()?;
    client.connect().ok()?;
    Some(client)
}

/// Call this once at app startup (from lib.rs setup) to establish
/// the initial connection, if Discord happens to already be open.
pub fn init() -> DiscordState {
    DiscordState(Mutex::new(try_connect()))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Wrap a segment in Unicode "First Strong Isolate" / "Pop Directional Isolate"
/// marks (U+2068 / U+2069). This tells the bidi algorithm to treat the segment
/// as its own isolated run, using ITS OWN first-strong-character direction,
/// rather than letting neighbouring RTL/LTR text (e.g. an Arabic chapter title
/// next to a "26%" figure) reorder pieces visually. Cheap, invisible, and the
/// standard fix for exactly this "mixed RTL text + number" garbling.
fn isolate(s: &str) -> String {
    format!("\u{2068}{}\u{2069}", s)
}

/// Update presence to show the book currently being read.
///
/// `title` - book title, shown as the top line ("Reading <title>")
/// `author` - optional author, shown as the second line
/// `progress_pct` - optional 0-100 reading progress, appended to the second line
pub fn set_reading(
    state: &DiscordState,
    title: &str,
    author: Option<&str>,
    chapter: Option<&str>,
    progress_pct: Option<u8>,
) {
    let mut guard = state.0.lock().unwrap();

    // Lazily (re)connect if we don't have a live client yet -
    // handles the case where Discord was closed when Sard started.
    if guard.is_none() {
        *guard = try_connect();
    }

    let Some(client) = guard.as_mut() else {
        return; // Discord not running - silently no-op
    };

    let details = format!("Reading {}", title);

    // Build the second line as: "by <author> · <chapter> · <pct>%",
    // dropping any part that isn't available.
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = author {
        parts.push(isolate(&format!("by {}", a)));
    }
    if let Some(c) = chapter {
        parts.push(isolate(c));
    }
    if let Some(p) = progress_pct {
        parts.push(isolate(&format!("{}%", p)));
    }
    let state_line = parts.join(" · ");

    let mut activity_builder = activity::Activity::new()
        .details(&details)
        .activity_type(activity::ActivityType::Playing)
        .assets(
            activity::Assets::new()
                .large_image("sard_logo")
                .large_text("Sard"),
        )
        .buttons(vec![activity::Button::new(
            "Get Sard",
            "https://github.com/Limitless-Soul1/Sard",
        )])
        .timestamps(activity::Timestamps::new().start(now_unix()));

    if !state_line.is_empty() {
        activity_builder = activity_builder.state(&state_line);
    }

    // If set_activity fails (e.g. Discord was closed mid-session),
    // drop the stale client so the next call retries a fresh connect.
    if client.set_activity(activity_builder).is_err() {
        *guard = None;
    }
}

/// Clear presence - call when a book is closed or the app goes idle.
pub fn clear(state: &DiscordState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
}

/// Show a generic "browsing the library" presence, for when a book is closed
/// but the app is still open - nicer than going fully blank on Discord.
pub fn set_browsing(state: &DiscordState) {
    let mut guard = state.0.lock().unwrap();

    if guard.is_none() {
        *guard = try_connect();
    }

    let Some(client) = guard.as_mut() else {
        return;
    };

    let activity_builder = activity::Activity::new()
        .details("Browsing the library")
        .activity_type(activity::ActivityType::Playing)
        .assets(
            activity::Assets::new()
                .large_image("sard_logo")
                .large_text("Sard"),
        )
        .buttons(vec![activity::Button::new(
            "Get Sard",
            "https://github.com/Limitless-Soul1/Sard",
        )])
        .timestamps(activity::Timestamps::new().start(now_unix()));

    if client.set_activity(activity_builder).is_err() {
        *guard = None;
    }
}

/// Disconnect cleanly - call on app shutdown.
pub fn shutdown(state: &DiscordState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut client) = guard.take() {
        let _ = client.close();
    }
}