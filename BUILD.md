# Building Sard

## Test build — fast, for trying a code change locally

**One command**, from the CURRENT working tree (**including uncommitted changes**):

```
npm run build:test
```

…or double-click **`build-test.bat`** (a thin wrapper over the same command).

It does three things:

1. **Closes any running Sard** — `sard.exe`, `Sard.exe`, *and* `Sard-standalone.exe` — via
   `scripts/kill-sard.mjs`, and **aborts loudly** if one can't be closed, instead of letting the build die
   later with a cryptic `Access is denied (os error 5)` / `EBUSY`.
2. Runs **`tauri build --no-bundle`** — a real standalone release `.exe`, but **no installer** (skips the
   slow, fragile WiX **MSI** + **NSIS** bundling that a local test doesn't need).
3. Copies the result to a stable path via `scripts/copy-release.mjs`:
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
