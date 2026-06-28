//! eRawy (الراوي) — Rust core (backend).
//!
//! RAWY-05 skeleton: the modules below are placeholders that make the planned
//! architecture (PROJECT.md §5) visible and give later tasks a clear home.
//! No real logic yet. All frontend↔core traffic goes through the `commands` seam.

pub mod commands; // IPC seam: #[tauri::command] handlers (the only frontend↔core boundary)
pub mod db; // SQLite connection pool + migration runner
pub mod library; // repositories: books, shelves, highlights, notes, bookmarks, progress
pub mod books; // file import, format detection, EPUB/PDF orchestration, cover extraction
pub mod metadata; // read embedded metadata + persist user overrides (never rewrite source files)
pub mod fonts; // register/validate custom fonts; expose available families per script
pub mod settings; // persist global settings (k-v JSON: active theme, typography defaults)
pub mod sync; // FUTURE seam: define the backend trait only, no implementation yet

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running eRawy");
}
