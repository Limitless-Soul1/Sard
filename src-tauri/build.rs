fn main() {
    // RAWY-144: embed the Windows exe icon reliably on rebuild. tauri-build embeds the app icon
    // (icons/icon.ico) into the executable's resource table, but it does NOT declare that file as a
    // build input — so after the icon is replaced, an INCREMENTAL rebuild kept the PREVIOUSLY embedded
    // icon (the taskbar/title-bar icon stayed stale until a `cargo clean`). Declaring it here makes
    // Cargo re-run this script — and re-embed the icon — whenever icons/icon.ico changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");

    // THE BUILD ID, carried into the binary so a report can say which build produced it.
    //
    // Generated once per build by scripts/build-identity.mjs and handed to BOTH halves of the app
    // (here for Rust, and through Vite's `define` for the frontend). The diagnostic report prints
    // both and compares them, which turns "is the frontend of this executable the one we shipped?"
    // into a measurement — the question that cost the 2026-08-07 installer investigation its time,
    // because nothing in the running app could answer it.
    //
    // `rerun-if-env-changed` is what keeps it honest: change the id and Cargo rebuilds rather than
    // baking a stale one into a fresh binary.
    println!("cargo:rerun-if-env-changed=SARD_BUILD_ID");
    // Never invented. A build made without the packaging scripts says so, in the report, in words —
    // a plausible-looking wrong id is worse than an admitted absence.
    let build_id = std::env::var("SARD_BUILD_ID")
        .unwrap_or_else(|_| "UNSET — built directly, not through the Sard build scripts".to_string());
    println!("cargo:rustc-env=SARD_BUILD_ID={build_id}");

    tauri_build::build()
}
