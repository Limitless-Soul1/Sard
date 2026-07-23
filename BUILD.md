# Building Sard

## Prerequisites
- **Node** (for `npm`) and **Rust/cargo** (Tauri shells out to `cargo`).
- **`cargo` must be resolvable.** rustup installs it at **`%USERPROFILE%\.cargo\bin\cargo.exe`** and normally
  adds that folder to your PATH. If it didn't, `tauri build` fails with an opaque
  `failed to run 'cargo metadata' … program not found`.
  - `npm run build:test` **auto-falls back** to `%USERPROFILE%\.cargo\bin` (and `$CARGO_HOME\bin`) for the
    build, so it still works — but to make `cargo` work in *every* shell, add that folder to your **User
    PATH** and open a **new** terminal (a reboot isn't needed). One-off for the current shell:
    `` $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path" ``
  - If cargo is nowhere, the build stops with a one-line "install Rust / add `%USERPROFILE%\.cargo\bin`"
    message instead of the raw cargo dump. Install Rust from <https://rustup.rs>.

## Test build — fast, for trying a code change locally

**One command**, from the CURRENT working tree (**including uncommitted changes**):

```
npm run build:test
```

…or double-click **`build-test.bat`** (a thin wrapper over the same command).

It runs `scripts/build-test.mjs`, which does these steps in order:

1. **Checks cargo is resolvable** — falls back to the rustup default `%USERPROFILE%\.cargo\bin` if it's not
   on PATH, or aborts with a clear "install Rust / fix PATH" message (see Prerequisites).
2. **Closes any running Sard** — `sard.exe`, `Sard.exe`, *and* `Sard-standalone.exe` — via
   `scripts/kill-sard.mjs`, and **aborts loudly** if one can't be closed, instead of letting the build die
   later with a cryptic `Access is denied (os error 5)` / `EBUSY`.
3. Runs **`tauri build --no-bundle`** — a real standalone release `.exe`, but **no installer** (skips the
   slow, fragile WiX **MSI** + **NSIS** bundling that a local test doesn't need).
4. Copies the result to a stable path via `scripts/copy-release.mjs`:
   - `test-build\Sard.exe` — the app (double-click to run; no dev server needed)
   - `test-build\piper\`  — the read-aloud engine (from `target\release\piper`, falling back to
     `src-tauri\resources\piper`)

Then run it: **`test-build\Sard.exe`**.

### Why `--no-bundle`
`build:test` used to run a **full** `tauri build`, which also builds the **installer**
(`Sard_x.y.z_x64-setup.exe` via NSIS, plus an MSI via WiX). That adds minutes *after* the app is already
compiled and depends on the WiX/NSIS toolchains — and because it ran in an `&&` chain, **any** bundling
failure aborted the whole test build and left **no fresh `test-build\Sard.exe`** (the app looked "broken"
when only the installer step failed). Test builds don't need an installer, so they skip it.

> ⚠ **`--no-bundle` is for TEST builds only.** The **Share / release** bundle needs the FULL `tauri build`
> (installer + standalone). Do NOT switch that path to `--no-bundle`.

### Gotcha: the standalone's process name is `Sard-standalone`
The Share single-file is `sard.exe` **renamed** to `Sard-standalone.exe`, so its process name is
`Sard-standalone`, not `sard`. `taskkill /IM sard.exe` and `Get-Process -Name sard` both miss it — the
preflight (`scripts/kill-sard.mjs`) covers all three names so a running copy can't silently break the build.

## Frontend-only check (no Rust)
`npm run build` (`tsc && vite build`) type-checks and bundles the UI into `dist\`. The test build embeds
`dist\`, so this is a quick way to validate a UI-only change before a full `build:test`.
