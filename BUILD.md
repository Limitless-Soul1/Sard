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

## Runtime requirement — the WebView2 floor (RESILIENCE-1 / WP-1)

Sard renders books in the system **WebView2** runtime, and the vendored engines under
`public/foliate-js/` need browser features that older runtimes do not have:

| Content | Requires | If missing |
|---|---|---|
| **EPUB** | `Object.groupBy`, `Map.groupBy` (foliate `epub.js`) | **No book of any kind opens.** Sard shows a full-window gate at startup. |
| **PDF** | `Uint8Array.prototype.toHex` / `.toBase64`, `Uint8Array.fromBase64` (PDF.js 5.5) | **Every PDF fails.** PDF import is refused and opening one shows the runtime message. EPUB is unaffected. |

This is enforced by **feature detection** in `src/lib/runtime.ts` — never by a version number, so it
cannot desync when the engines are re-pinned. `public/foliate-js/VENDOR.txt` carries the full list,
the call sites, and the standing instruction to re-derive it on any re-vendor.

> ⚠ **Tauri's installer does not upgrade an existing WebView2 runtime** — it installs one only when
> absent. A machine whose runtime is pinned by policy stays below the floor indefinitely, which is
> exactly how this reached a tester. Mention the requirement in release notes.

## Faster local build — skip the installers

A full `tauri build` also produces the NSIS and MSI installers. That adds minutes *after* the app has
already compiled, and it depends on the NSIS and WiX toolchains being present. When you only want to
run your change, skip the bundling:

```
npx tauri build --no-bundle
```

The result is `src-tauri\target\release\sard.exe`, and nothing else. Run it directly — no dev server
needed, because the executable embeds the built frontend.

> ⚠ `--no-bundle` is for local builds only. A release needs the full `tauri build`: the installer *is*
> the release artifact.

**If the build fails with `Access is denied (os error 5)` or `EBUSY`,** a running copy of Sard is
holding its own executable open. Close it and build again.

## Frontend-only check (no Rust)
`npm run build` (`tsc && vite build`) type-checks and bundles the UI into `dist\`. The application
embeds `dist\`, so this is a quick way to validate a UI-only change before a full build.

## Cutting a release (and the updater's signing key)

Releases are built by GitHub Actions, not by hand. Push a `v*` tag and
`.github/workflows/release.yml` builds the app, signs the updater artifacts, generates
`latest.json`, creates the GitHub Release and uploads everything the in-app updater needs.

```
# bump the version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml first
git tag v1.2.0
git push origin v1.2.0
```

A **manual** run (Actions → Release → Run workflow) builds a **draft** release instead, so the
pipeline can be exercised without publishing anything.

### The signing key

The updater will not install anything whose minisign signature does not match the public key
compiled into the app (`plugins.updater.pubkey` in `tauri.conf.json`). The private half lives in two
places and **must not** enter this repository:

- the owner's own offline backup, and
- two GitHub Actions secrets: `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

> ⚠ **If that key is lost, no existing install can ever be updated again.** It cannot be
> regenerated — only replaced, and replacing it strands everyone already running Sard on the version
> they have. Back it up before doing anything else.

To build a signed release locally (rarely needed — the workflow is the supported path):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "<path to the key file>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<its password>"
npm run tauri build
```

Without those variables the bundler still produces installers, but **no `.sig` files** — and a
release without signatures is one the updater will refuse.

### Why NSIS is the update payload

The bundler emits both an NSIS `-setup.exe` and a WiX `.msi`. The workflow sets
`updaterJsonPreferNsis: true` because the action's default is `false` "for legacy reasons", which
would put the MSI in `latest.json`. The NSIS path is the tested one: the updater runs it with
`/UPDATE`, which installs per-user without an elevation prompt and restarts the app itself. The MSI
remains a release asset for anyone who wants it; it is simply not what the updater downloads.

### What an update does NOT touch

The NSIS uninstaller can delete `%APPDATA%\com.sard.app`, but only when **both** a checkbox on the
uninstall confirmation page is ticked **and** `/UPDATE` was not passed. An update always passes
`/UPDATE`, so that branch is unreachable during one — the library, database, notes, highlights,
backgrounds and downloaded voices survive by construction, not by convention.
