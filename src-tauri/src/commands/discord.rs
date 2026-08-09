// src-tauri/src/commands/discord.rs
//
// Frontend-facing commands for Discord Rich Presence.
// Add `mod discord;` to commands/mod.rs and register these
// three functions in the invoke_handler! list in lib.rs.

use crate::discord_rpc::{self, DiscordState};
use tauri::State;

#[tauri::command]
pub fn discord_set_reading(
    state: State<DiscordState>,
    title: String,
    author: Option<String>,
    chapter: Option<String>,
    progress_pct: Option<u8>,
) {
    discord_rpc::set_reading(&state, &title, author.as_deref(), chapter.as_deref(), progress_pct);
}

#[tauri::command]
pub fn discord_clear(state: State<DiscordState>) {
    discord_rpc::clear(&state);
}
#[tauri::command]
pub fn discord_set_browsing(state: State<DiscordState>) {
    discord_rpc::set_browsing(&state);
}