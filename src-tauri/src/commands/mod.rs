//! IPC seam — typed `#[tauri::command]` handlers. The single boundary the React
//! frontend uses to reach the Rust core (RAWY-08). Keep all frontend↔core traffic here.

use serde::Serialize;
use tauri::State;

use crate::db::{self, AppState};
use crate::settings;

#[derive(Serialize)]
pub struct AppInfo {
    pub app_data_dir: String,
    pub db_path: String,
    pub schema_version: i64,
}

#[derive(Serialize)]
pub struct DbHealth {
    pub ok: bool,
    pub schema_version: i64,
    pub tables: Vec<String>,
}

/// Stringify any error so it crosses the IPC boundary cleanly.
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> Result<AppInfo, String> {
    let conn = state.db.lock().map_err(err)?;
    let schema_version = db::schema_version(&conn).map_err(err)?;
    Ok(AppInfo {
        app_data_dir: state.app_data_dir.display().to_string(),
        db_path: state.db_path.display().to_string(),
        schema_version,
    })
}

#[tauri::command]
pub fn db_health(state: State<AppState>) -> Result<DbHealth, String> {
    let conn = state.db.lock().map_err(err)?;
    let schema_version = db::schema_version(&conn).map_err(err)?;
    let tables = db::list_tables(&conn).map_err(err)?;
    Ok(DbHealth {
        ok: true,
        schema_version,
        tables,
    })
}

#[tauri::command]
pub fn settings_get(key: String, state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(err)?;
    settings::get(&conn, &key).map_err(err)
}

#[tauri::command]
pub fn settings_set(key: String, value: String, state: State<AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(err)?;
    settings::set(&conn, &key, &value).map_err(err)?;
    Ok(true)
}
