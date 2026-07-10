fn main() {
    // RAWY-144: embed the Windows exe icon reliably on rebuild. tauri-build embeds the app icon
    // (icons/icon.ico) into the executable's resource table, but it does NOT declare that file as a
    // build input — so after the icon is replaced, an INCREMENTAL rebuild kept the PREVIOUSLY embedded
    // icon (the taskbar/title-bar icon stayed stale until a `cargo clean`). Declaring it here makes
    // Cargo re-run this script — and re-embed the icon — whenever icons/icon.ico changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
