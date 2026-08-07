# Sard Desktop — Linux & macOS expansion

**Engineering study and execution plan.** No implementation. No repository changes beyond this document.

| | |
|---|---|
| **Objective** | Sard fully supports Linux and macOS; the Windows implementation is preserved |
| **Evidence base** | `M:\eRawy` @ `dd23765` — every Rust module, every dependency, every script, every doc, read directly |
| **Supersedes** | The earlier draft of this file. `NEXT_STAGE_STUDY.md` remains valid as the record of *why* this stage was chosen over resuming mobile |
| **Labels** | `[MEASURED]` read from or run against the tree · `[INFERRED]` reasoning from measured facts · `[HYPOTHESIS]` untested |
| **Standing constraints honoured** | Engineering Contract · D30 (book content never executes script) · D44 (a general reader) · D16 (managed copies) · the 29-item acceptance checklist |

---

## 0. Executive summary

### 0.1 The three findings that determine everything below

**1 · The architecture is already right, and the port is not a Rust project.**
`[MEASURED]` 511 of 6,071 Rust LOC (8.4%) is Windows-specific, in three files, **already `cfg`-gated
with working non-Windows fallbacks**. Exactly one ungated Windows dependency exists in the entire
core — `Command::new("piper.exe")` at `tts.rs:183` — and Piper's removal deletes it.
**The real work is rendering-engine compatibility in the frontend**, not Rust portability. That
changes how this should be staffed, scheduled and verified.

**2 · One unanswered question can invalidate the plan's shape, and it is in your own vendored source.**
`public/foliate-js/paginator.js:242`, verbatim: `[MEASURED]`

> *"Sard patch (RAWY-64, security): upstream sets `allow-scripts` here **only to work around a WebKit
> event-dispatch bug (bugs.webkit.org #218086)** — Sard ships on WebView2 (Chromium), a different
> engine…"*

macOS is WKWebView. Linux is WebKitGTK. Every event the reader depends on — `pointerdown`,
`pointerup`, `wheel`, `keydown`, selection — crosses that boundary. The bug may be long fixed; that
is precisely why this is **one week of work, not one quarter**. Until it is answered, every duration
below is provisional.

**3 · The two platforms have opposite cost curves, and that decides the order.**

> **Linux is cheap to start and expensive to finish. macOS is expensive to start and cheap to
> finish.**

Linux: free CI runner, no hardware, no account, no signing — and it is foliate-js's *reference*
engine. But then: WebKitGTK version spread, Wayland vs X11, four desktop environments, distro
packaging, and Arabic IME behaviour that nobody has tested.
macOS: a Mac, $99/yr, notarisation, and an application menu that does not exist yet — but then **one
operating system, two architectures, one WebView per OS release, and a user base that updates.**

### 0.2 The recommendation, which is not the order you proposed

> **Build on Linux first. Release on macOS first. Graduate Linux to production last.**

This is deliberately not "Linux then macOS" and not "macOS then Linux".

| | |
|---|---|
| **Engineering starts on Linux** | It is where WebKit evidence is free and immediate — no purchase, no account, no notarisation blocking the first answer. Roughly **70% of that work is inherited by macOS unchanged** `[INFERRED]` |
| **macOS procurement starts on day 1, in parallel** | The Apple Developer account has a **1–2 week lead time for an organisation**. Starting it when macOS work begins wastes two weeks of critical path |
| **macOS is the first production release** | It finishes cleanly, its audience overlaps most with Sard's positioning, and if the schedule is ever cut you will have shipped the higher-value platform |
| **Linux ships earlier but as an explicit preview tier** | An AppImage has zero signing friction and can ship **weeks before macOS** — real field evidence on WebKit at no cost. It graduates to production once the long tail is understood |

**Critical path: 17–24 weeks** to both platforms production-ready. `[INFERRED]` — on the project's own
estimating basis (one primary developer with AI assistance, at a bar that roughly doubles nominal
figures). First shippable Linux preview at **≈ week 10**; macOS production at **≈ week 18–22**.

### 0.3 The plan at a glance

| Phase | Objective | Duration |
|---|---|---|
| **0** | WebKit feasibility probe · start macOS procurement | 1–2 wk |
| **1** | Remove Piper · establish a test runner · clear engine-portability debt | 3–4 wk |
| **2** | Architecture cleanup — one directory move, two deletions | 2–3 wk |
| **3** | Three platform seams, and no more | 1 wk |
| **4** | Linux — the WebKit workstream, to a shippable AppImage preview | 3–4 wk |
| **5** | macOS — packaging, integration, notarisation, the menu bar | 5–7 wk |
| **6** | Verification — one harness, three engines *(runs in parallel from Phase 0)* | 2–3 wk |
| **7** | Release — one tag, three signed artifacts, one manifest | 2–3 wk |
| **8** | Offline speech restoration *(post-release)* | 4–6 wk |

---

## 1. Current platform audit

Every Windows-specific dependency, with the six questions asked of each.
**Disposition key:** ❌ remove · 🔷 make conditional · 🔁 replace with a cross-platform solution ·
🔒 keep, intentionally platform-specific · ✅ already cross-platform.

### 1.1 Rust crates

| Crate | Why it exists | Blocks Linux? | Blocks macOS? | Disposition |
|---|---|---|---|---|
| **`webview2-com 0.38`** | Reaches `ICoreWebView2Settings`/`Settings3` to strip Chromium's find bar, reload, print, context menu, caret browsing — none of which Tauri surfaces (`webview_chrome.rs`) | **No** — already `[target.'cfg(windows)'.dependencies]` | **No** — same | 🔒 Crate stays Windows-only. The **capability** becomes a seam (§4, Seam 1) |
| **`windows 0.61`** (`Win32_Foundation`, `System_Com`, `Media_Audio`, `Diagnostics_ToolHelp`, `System_Threading`, `Security`) | Core Audio session enumeration + notifications, the ToolHelp process snapshot for the ancestry filter, and the event the audio worker blocks on (`audio_identity.rs`) | **No** — gated | **No** — gated | 🔒 Windows-only forever. §1.3 explains why no equivalent should be built |
| **`windows-core 0.61`** | `#[implement]` expands to `windows_core::` paths resolved at the crate root, so the crate must be nameable | **No** | **No** | 🔒 Same |
| **`tauri-plugin-single-instance`** | A second launch focuses the running window instead of attaching a rival process to the same WAL database (RAWY-173) | No — needed and works | **Partially.** `.app` bundles are already single-instance, and the plugin interferes with the standard re-open / "Open With" flow | 🔷 `#[cfg(not(target_os = "macos"))]`; handle re-activation via the standard macOS reopen event |
| **`tauri-plugin-updater`** | The in-app updater (RAWY-290) | No — AppImage is supported | No — `.app.tar.gz` is supported | 🔷 Config-level only: install semantics differ per OS, and must **self-disable** where a package manager owns updates (§2.9) |
| `tauri 2` (`protocol-asset`) · `serde` · `serde_json` · `sha2` · `quick-xml` · `zip 2` · `image 0.25` · `rusqlite 0.32` (`bundled`, `functions`) | The core | No | No | ✅ `rusqlite` `bundled` compiles SQLite from source for any target with a C toolchain |
| **`msedge-tts 0.4`** | Edge neural voices — the free, keyless endpoint; the Arabic-quality path | No | No | ✅ **Pure network code** — ureq + tungstenite + rustls. Ports unmodified |
| **`ureq 3`** | Originally to download Piper voice models; bumped from 2 to dedupe with `msedge-tts`'s copy | No | No | ✅ **Keep after Piper.** `msedge-tts` needs it, and the RAWY-111 dedup reasoning depends on it |
| **`rustls 0.23` (`aws_lc_rs`)** | Two crypto providers (aws-lc-rs via `msedge-tts`, ring via `ureq`) compile into one rustls; auto-detection is ambiguous and **panics** on the first handshake. `lib.rs:75` pins the default | No | No | ✅ **Keep.** It disambiguates two providers, not two platforms. Removing it as a "Piper leftover" reintroduces the panic |
| `tauri-plugin-dialog` · `-opener` · `-process` | File pickers, external opens, restart-after-update | No | No | ✅ — but see §2.4 on `opener` |

> **The complete third-party Windows surface is three crates, all already correctly gated. No crate
> needs replacing, and none needs removing except by removing its consumer.**

### 1.2 Rust modules

| Module | LOC | Why it exists | Blocks Linux? | Blocks macOS? | Disposition |
|---|---|---|---|---|---|
| **`tts.rs` — Piper half** | ~250 | The bundled sidecar: spawn, warm process per voice, voice download, WAV read-back | **Yes** — `piper.exe` and Windows DLLs do not exist there | **Yes** — same | ❌ **Delete.** §5 |
| `tts.rs` — Edge half | ~500 | Warm WebSocket per voice, bounded deadlines, word timings | No | No | 🔷 Portable as written; gains a trait so future engines have somewhere to live |
| **`webview_chrome.rs`** | 61 | Chromium's UI arrives free with WebView2 — find bar, `Ctrl+P` → `edge://print/`, `Ctrl+R` reload, the browser context menu, caret browsing. All measured live on the 0.5.1 release build | No — already `#[cfg(not(windows))] pub fn harden(_) {}` | No — same | 🔷 **Becomes a seam.** The *contract* ("Sard owns its keyboard and pointer surface") is shared; the mechanism is per-engine |
| **`window_chrome.rs`** | 86 | Themes the native caption via `DwmSetWindowAttribute`, plus a 1px `SetWindowPos` nudge because DWM will not recomposite without a real geometry change | No — no-op command already exists | No — same | 🔒 **Keep unchanged.** §4.4 explains why the "clean" cross-platform answer is worse |
| **`audio_identity.rs`** | 364 | The Volume Mixer showed read-aloud as "Microsoft Edge WebView2". Sard produces no audio — Web Audio means the WASAPI session belongs to Chromium's audio service, and Windows falls back to the *owning process's* executable, which is Microsoft's | No | No | 🔒 **Keep, gated, and build no equivalents.** §1.3 |
| `lib.rs` legacy `com.erawy.app` migration | ~35 | One-time copy-then-verify from the pre-rename identity | No — but meaningless there | No — same | 🔷 **Gate `#[cfg(windows)]`.** No macOS or Linux install can ever have that directory; running the probe is dead code that reads as a supported path |
| `sync/mod.rs` | 2 | An empty future seam | No | No | ❌ **Delete.** Appendix B.8 already says it is not a feature; a placeholder that survives a platform expansion starts to look like a commitment |
| `db/` · `library/` · `books/` · `metadata/` · `fonts/` · `settings/` · `photocards.rs` · `backgrounds/` · `commands/` | ~4,700 | The domain | No | No | ✅ `[MEASURED]` — **no OS call anywhere in any of them.** `std::path`, `std::fs`, `std::env::temp_dir()`, `rusqlite`, `image` |

### 1.3 The module that should stay Windows-only forever

`audio_identity.rs` is the clearest case in the codebase, and worth stating explicitly because the
instinct on a cross-platform project is to abstract everything.

**The problem it solves does not exist on the other two platforms.** `[MEASURED, from its own header]`
Windows identifies an audio session by its *owning process's executable* when the session carries no
metadata, and Chromium sets none — so Sard, hosting a **shared** Microsoft binary, inherits
Microsoft's name and icon.

- **macOS:** WKWebView audio is attributed to the host app bundle. Sard's name and icon appear
  correctly, for free. `[INFERRED]`
- **Linux:** PipeWire/PulseAudio attribute streams via `application.name`, set from the GTK
  application. `[INFERRED]`

**Recommendation: keep it, keep it gated, and build no macOS or Linux siblings** until a measured
problem exists. Writing them would be ~700 lines solving a problem neither platform has.

> **This is the discipline for the whole plan: a platform seam is justified by a second
> implementation that must exist — never by symmetry.**

### 1.4 Native APIs, exhaustively

| API | Location | Disposition |
|---|---|---|
| `Command::new("piper.exe")` | `tts.rs:183` | ❌ Deleted with Piper |
| `std::os::windows::process::CommandExt::creation_flags(CREATE_NO_WINDOW)` | `tts.rs:198` | ❌ **The only `std::os::windows` import in the core.** Deleted with Piper |
| `ICoreWebView2Settings` / `ICoreWebView2Settings3` — context menus, devtools, status bar, zoom, browser accelerators | `webview_chrome.rs` | 🔷 Seam. **Linux:** `WebKitSettings` + the `context-menu` signal via wry's GTK webview. **macOS:** far less to suppress — WKWebView ships no find bar and no reload UI; the context menu and `Cmd+R`/`Cmd+P` still need handling |
| `DwmSetWindowAttribute` (attr 20, fallback 19), `GetWindowRect`, `SetWindowPos` | `window_chrome.rs` | 🔒 No equivalent. macOS and Linux draw their own captions |
| `window.hwnd()` | `window_chrome.rs:59` | 🔒 |
| `IMMDeviceEnumerator`, `IAudioSessionControl2`, `IAudioSessionNotification`, `IMMNotificationClient`, ToolHelp snapshot, `CreateEventW`, `SECURITY_ATTRIBUTES` | `audio_identity.rs` | 🔒 §1.3 |
| `std::env::temp_dir()`, `std::env::current_exe()`, `std::fs`, `std::path` | throughout | ✅ Portable |
| `app.path().app_data_dir()` | `lib.rs:99` | ✅ Resolves per-OS. §2.1 |

---

## 2. Cross-platform gap analysis

Everything currently preventing Sard from running *correctly* — obvious and hidden.

### 2.1 Filesystem

`app_data_dir()` resolves correctly per OS: `%APPDATA%\com.sard.app` ·
`~/Library/Application Support/com.sard.app` · `~/.local/share/com.sard.app`. **No code change.**

**Hidden issue — the XDG expectation.** A Linux user will expect settings in `~/.config`, the database
in `~/.local/share`, derivatives in `~/.cache`. **Do not split it.** *"A user's library, positions,
notes, highlights, references, bookmarks, photo cards, backgrounds, settings and voices all live in
one directory on their own machine"* is a stated product property — it is what makes backup a folder
copy. **Deviate deliberately and document it in `BUILD.md`.** An undocumented deviation is a bug
report; a documented one is a design decision.

**Hidden issue — case sensitivity.** Linux filesystems are case-sensitive; Windows and default macOS
are not. Book ids are SHA-256 hex and cover extensions come from the source file. `[MEASURED]`
`safe_id()` already rejects `/`, `\` and `..`, and ids are hex — so no collision path exists. **No
action, but verify in Phase 4** that no import path lower-cases an extension.

**Hidden issue — the asset protocol scope.** `assetProtocol.scope: ["$APPDATA/**"]` resolves per-OS
through Tauri's own path resolution. `[MEASURED]` Every asset load in the frontend goes through
`convertFileSrc` — **no manual `asset.localhost` URL is constructed anywhere.** Portable as written.

### 2.2 Permissions and sandboxing

**The category with the largest hidden risk, because Sard reads files the user chooses from
anywhere.** `[MEASURED]` — `import_folder` performs a **recursive, depth-capped, symlink-skipping
`read_dir` walk** from a user-chosen directory (`books/mod.rs:53–79`).

| Environment | Effect | Assessment |
|---|---|---|
| **Windows** | No sandbox | ✅ No change |
| **macOS, Developer ID** *(the recommended distribution)* | No App Sandbox. **TCC** prompts once per protected folder (Documents, Downloads, Desktop) — but files and folders chosen through `NSOpenPanel` or dropped are granted implicitly | 🔷 Add the `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` Info.plist strings so any direct read produces a readable prompt rather than a silent failure |
| **macOS, Mac App Store** | **App Sandbox is mandatory.** A recursive folder walk needs a **security-scoped bookmark** persisted across launches | ⚠️ **Recommend MAS as a non-goal.** §7.5 |
| **Linux, AppImage / `.deb`** | No sandbox | ✅ Works as on Windows |
| **Linux, Flatpak** | Sandboxed. File access flows through the **XDG Desktop Portal**; the picker returns a `/run/user/N/doc/...` path. A *directory* grant does permit recursion, but **drag-and-drop of files from outside a grant is the exposed edge** | ⚠️ **Verify before committing to Flatpak.** §7.6 |

> **Consequence for the plan: AppImage is the Linux v1, not Flatpak.** Flatpak solves the WebKitGTK
> version-floor problem elegantly and is how much of this audience installs — but it introduces a
> sandbox into an application whose core loop is *"read the user's own files from wherever they
> are."* **Ship AppImage first; treat Flatpak as a Phase 4b with its own portal verification.**

### 2.3 Dialogs

`[MEASURED]` — all file interaction is JS-side through `@tauri-apps/plugin-dialog`:
`open({ multiple, filters: [epub, pdf] })` (`Library.tsx:442`), `open({ directory: true })`
(`Library.tsx:458`), a cover picker (`Library.tsx:1261`), and `save()` for photo-card export
(`PhotoComposer.tsx:16`). **All cross-platform; no code change.**

**Hidden issue:** on Linux the plugin uses GTK dialogs natively and the portal under Flatpak — a
second reason §2.2's Flatpak verification matters. On macOS the extension filter list maps to
`allowedContentTypes`; verify that `epub` (which has a UTI, `org.idpf.epub-container`) filters
correctly rather than greying out valid files. `[HYPOTHESIS]`

### 2.4 Tauri plugins

| Plugin | Status |
|---|---|
| `dialog` | ✅ |
| `process` | ✅ Restart after update, documented as the correct path on macOS and Linux |
| `updater` | 🔷 §2.9 |
| `single-instance` | 🔷 Exclude on macOS (§1.1) |
| `opener` | ⚠️ **`[MEASURED]` — no call site found anywhere in `src/`.** The plugin is registered and `opener:default` is in the capability set. Verify before Phase 2; if genuinely unused, **removing it shrinks the permission surface**, which matters for macOS notarisation and any future store review |

### 2.5 Notifications — **none, and that is a finding**

`[MEASURED]` **Sard uses zero OS notifications.** No `tauri-plugin-notification`, no
`Notification` API, no D-Bus notification dependency.

**Consequence:** no macOS `UNUserNotificationCenter` entitlement, no notification permission prompt,
no Linux D-Bus dependency. **One entire platform surface does not exist.** No action.

### 2.6 Media controls — a uniform gap, not a porting blocker

`[MEASURED]` **Sard has no OS media integration on any platform** — no MPRIS, no
`MPNowPlayingInfoCenter`, no SMTC, no `navigator.mediaSession`. Read-aloud transport is in-app only.
Media keys on a keyboard do nothing.

This is **not** a regression introduced by the port — it is missing on Windows today. But it is worth
recording, because the platforms are **not equally able to fix it**:

| Platform | Feasible? | Why |
|---|---|---|
| **Linux (MPRIS over D-Bus)** | **Yes, cheaply** | MPRIS is metadata + remote commands. It does **not** require owning the audio stream |
| **macOS (`MPNowPlayingInfoCenter`)** | **Yes, cheaply** | Same — metadata and remote commands, stream ownership irrelevant |
| **Windows (SMTC)** | **No** | SMTC requires owning the audio stream. RAWY-270 proved ownership **cannot be moved** — `sard.exe` loads the WebView2 COM proxy and neither `AUDIOSES.DLL` nor `MMDevApi.dll`, so it structurally cannot be the process that calls `IAudioClient::Initialize` |

> **A genuinely interesting asymmetry: macOS and Linux can both get proper media integration cheaply,
> exactly where Windows structurally cannot.** Record it as a **post-1.0 opportunity**, not as
> porting scope — adding a feature to two of three platforms during a port is how a port becomes a
> release that never ships.

### 2.7 Audio

Read-aloud is Web Audio inside the WebView, driven by `tts.ts`. **Engine-agnostic and portable.**
No native audio code exists outside `audio_identity.rs`'s metadata worker.

**Hidden issue — Linux audio backend variance.** WebKitGTK routes Web Audio through GStreamer, which
means the distro's GStreamer plugin set is in the path. A missing `gst-plugins-good`/`-bad` can mean
**MP3 decode failure** — and Edge returns MP3 (`audio-24khz-48kbitrate-mono-mp3`, forced at
`tts.rs:551`). `[HYPOTHESIS]` **Verify in Phase 4 on a minimal container**, and document the required
GStreamer packages. This is the kind of dependency an AppImage must bundle and a `.deb` must declare.

### 2.8 Keyboard shortcuts

`[MEASURED]` — better than expected:

- `FoliateController.ts:1498` **already handles Ctrl and Cmd** for in-book search.
- **Neither locale contains a single keyboard-shortcut label** — no `Ctrl+F` strings to re-word as
  `⌘F`. `[MEASURED]`

**Gaps:**
- `App.tsx:114` binds **`F11`** for fullscreen — the Windows/Linux convention. macOS expects
  `Cmd+Ctrl+F` and the green traffic light.
- Lesson §12.3.29 — *"`e.key` is layout-dependent; match `e.code`"* — needs an audit pass across all
  handlers. A shortcut that looks correct in review can be dead under a non-Latin layout, which for
  an Arabic-first-class reader is not hypothetical.

### 2.9 Updater

| Platform | Payload | Install semantics |
|---|---|---|
| Windows | NSIS `-setup.exe` with `/UPDATE` | `installMode: passive`; the installer restarts the app. `updaterJsonPreferNsis: true` is **load-bearing** — the default would ship the MSI |
| macOS | `.app.tar.gz` | Replace-and-relaunch; `install()` returns, so `relaunch()` runs |
| Linux, AppImage | AppImage | Self-replace |
| **Linux, Flatpak / `.deb` / `.rpm`** | — | **The package manager owns updates.** The in-app updater must **detect its packaging and disable itself**, or it will offer an update it cannot perform |

**One manifest.** `tauri-action` merges per-platform matrix entries into a single `latest.json` against
one release. The endpoint stays `/releases/latest/download/latest.json` — *publishing a release **is**
the deployment.*

**Risk carried unchanged:** the minisign private key. *"If that key is lost, no existing install can
ever be updated again."* It now gates three platforms instead of one. **Confirm the offline backup
before Phase 7.**

### 2.10 Packaging

`[MEASURED]` `tauri.conf.json` already declares `"targets": "all"` and already lists `icon.icns` in
the bundle icon array. **The macOS icon has been in the tree since the beginning.** `.app`/`.dmg` and
`.deb`/`.rpm`/`.AppImage` come out with **no config change**.

What must be added: the CI matrix (§2.12), macOS notarisation secrets, Windows Authenticode, and the
Linux `.desktop` entry, MIME associations for `application/epub+zip` and `application/pdf`, and icon
theme installation.

### 2.11 Rust crates and build

Covered in §1.1. `cargo build` for `x86_64-unknown-linux-gnu` and `aarch64-apple-darwin` **should
succeed with no source changes once Piper is gone.** `[HYPOTHESIS]` — the cheapest thing Phase 0
confirms.

### 2.12 Build scripts and CI

| Item | Gap |
|---|---|
| `.github/workflows/release.yml` | 🔁 `runs-on: windows-latest`, single job → a **matrix**. Linux needs `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`. macOS needs both `x86_64-apple-darwin` and `aarch64-apple-darwin` |
| `scripts/build-test.mjs` | 🔷 **Already branches on `process.platform`** for cargo resolution — half done |
| `scripts/kill-sard.mjs` | 🔁 Windows `taskkill` → needs `pkill`/`killall` siblings |
| `scripts/copy-release.mjs` | 🔁 `[MEASURED]` **16 Piper references.** Loses the `piper\` copy entirely; needs per-OS artifact names |
| `build-test.bat` | 🔒 Keep; add a `build-test.sh` sibling |

### 2.13 The rendering engine — where the real work is

**This is the substance of the port.** `[MEASURED]`:

| # | Item | Location | Consequence on WebKit |
|---|---|---|---|
| **1** | `allow-scripts` dropped from the book iframe | `paginator.js:242`, `fixed-layout.js:84` | §0.1. **Potentially fatal.** Phase 0 question A |
| **2** | `scrollbar-color` used as the **mechanism** to cross foliate's closed shadow root | `global.css:83, 892`; `injectedCss.ts:653, 873` | Safari shipped it in **18.2**; WebKitGTK varies. Lesson §12.1.12 records that `::-webkit-scrollbar` **cannot cross a shadow boundary** — so where `scrollbar-color` is absent there is **no fallback mechanism at all** for `global.css:892`. Injected *book* CSS can take a `::-webkit-scrollbar` rule (it lives inside the frame); the immersive hide cannot |
| **3** | 5 unprefixed `backdrop-filter` of 20 | `global.css:338, 2957, 3609, 3850, **4282**` | **4282 is the library wallpaper blur** — a headline feature. Silently no-ops |
| **4** | PDF page canvas → `toDataURL()` | `pdf.js:29` — *"adopting a painted canvas across documents renders blank in Chromium/WebView2"* | A workaround **for Chromium**. WebKit enforces stricter canvas-area limits; a large page may fail where Chromium succeeds |
| **5** | `Intl.Segmenter` — *"present in WebView2/Chromium"* | `FoliateController.ts:2266` | Safari 14.1+ / WebKitGTK 2.32+ |
| **6** | `:has()` in injected book CSS | `injectedCss.ts:425` | Safari 15.4+ / WebKitGTK 2.38+ |
| **7** | `color-mix(in srgb, …)` | `global.css:83` and throughout | Safari 16.2+ / **WebKitGTK 2.40+** ← this sets the real Linux floor |
| **8** | CSS `zoom` for text scaling (D6) | `injectedCss.ts:643` | WebKit-origin property, supported — but its interaction with **columnisation** was measured on Chromium only |
| **9** | `html-to-image` `toBlob` for photo cards | `PhotoComposer.tsx:583` | `foreignObject` serialisation has known WebKit fidelity problems with embedded fonts |

> **Lesson corollary worth recording.** §12.1.12 — *"prefer an inherited property to reach into a
> closed shadow root"* — is correct in general and **Chromium-shaped in this instance**. Append:
> *"…and verify the inherited property exists on every engine you ship, because the selector-based
> fallback cannot cross the boundary."*

### 2.14 The frontend gap nobody has noticed

`[MEASURED]` **`@tauri-apps/plugin-os` is absent, and there is no platform check anywhere in `src/`.**
The frontend has **no way to know what platform it is on.**

Correct today. It becomes the single genuinely missing frontend abstraction the moment macOS exists —
fullscreen convention, modifier key, title-bar insets, trackpad conventions. §4, Seam 3.

### 2.15 Arabic input — the Linux risk a generic checklist misses

Sard treats Arabic as first-class. Users type Arabic into note titles and bodies, search, tags and
references.

**Arabic IME behaviour inside WebKitGTK, under both Wayland and X11, with ibus and fcitx5, is
completely untested.** `[HYPOTHESIS]` Composition events, cursor placement in bidi text, and
selection inside a mixed-direction paragraph are all places where a WebView can be subtly wrong.

**This deserves a named check in Phase 4** — not a line in a table. It is the risk most likely to be
missed by a port checklist and most likely to matter to Sard's core audience.

---

## 3. Recommended implementation order

### 3.1 The four candidate orders, assessed

| Order | Verdict |
|---|---|
| **macOS first, then Linux** | **Rejected.** The Apple account (1–2 wk for an organisation), a Mac purchase and notarisation all sit *before* the first line of evidence. You would spend ~$1,100 and 3–4 weeks before learning what a free CI run answers in days — including whether the reading engine works on WebKit at all |
| **Parallel from day 1** | **Rejected for a solo maintainer.** Two engines, two packaging systems and two verification harnesses at once, before the shared WebKit question is answered. It maximises context-switching at exactly the moment the highest-uncertainty work is happening |
| **Shared refactoring first** | **Rejected as a large project, adopted as a small one.** §4 — three seams and one directory move, one week plus two weeks of cleanup. A general platform-service layer would be abstraction with no second implementation to abstract from |
| **Linux engineering first, macOS release first** | **Recommended** |

### 3.2 Why this order minimises total engineering time

**The WebKit work is shared and it dominates.** Items 1–8 of §2.13 are one workstream, not two.
Doing it on Linux costs a free CI runner; doing it on macOS costs hardware, an account and a
notarisation loop before you can even run. **Roughly 70% of Phase 4 is inherited by macOS
unchanged.** `[INFERRED]`

**foliate-js's reference engine is WebKitGTK.** ADR-0006 records it: upstream Foliate is a GTK
application, and Chromium is its *stated secondary target*. Sard currently runs 7,669 lines of
vendored engine on the engine it was secondarily tested against. **Linux is where the reading engine
is at home** — which inverts the usual assumption that Linux is the risky extra platform.

**Procurement has lead time and no dependencies.** The Apple account and the Mac should be started in
Phase 0, in parallel, so they are ready when Phase 5 begins. Serialising them behind Linux work wastes
two weeks of critical path for zero benefit.

**Release order follows finishing cost, not starting cost.** Linux is cheap to start and expensive to
finish — WebKitGTK spread, Wayland/X11, four DEs, distro packaging, IME. macOS is expensive to start
and cheap to finish — one OS, two architectures, one WebView per release. **So macOS reaches a
production bar sooner once started, and it should be the first production release.**

**And it fails gracefully.** If the schedule is cut at any point after Phase 5, you have shipped
macOS — the higher-value platform — plus a Linux preview that already gave you field evidence.

### 3.3 Why it minimises future maintenance

- **One WebKit compatibility surface, fixed once.** A bug found on WebKitGTK in Phase 4 is fixed
  before macOS users ever meet it.
- **A published Linux support tier** (§6, Phase 4) bounds the long tail *before* it arrives, rather
  than after the first bug report from an unfamiliar distro.
- **No abstraction is built speculatively.** Every seam in §4 has a named second implementation
  scheduled. The project's own §7.7 records what abstraction-by-intuition costs.

---

## 4. Shared refactoring

**Recommended: one directory move, two deletions, three seams. Roughly three weeks total. Nothing
else.**

The project's own precedent is decisive. §7.7 records a per-file import lock that was *"right in the
abstract and wrong on the machine"* and was killed by measurement. §12.3.1: *"investigate before you
edit."* **A solo project with one implementation has nothing to abstract *from*.** Write the second
platform concretely, let the duplication appear, then abstract what actually duplicated.

### 4.1 `cfg` separation — a directory move, not a crate split

The three platform modules are top-level siblings of the domain modules. That was right at three
files. At three platforms it scatters.

```
src-tauri/src/
  platform/
    mod.rs          the contracts + `pub use` per cfg — the ONLY file that names an OS
    windows.rs      webview hardening (COM) · titlebar (DWM) · audio identity
    macos.rs        webview hardening (WKWebView)
    linux.rs        webview hardening (WebKitGTK)
  commands/  db/  library/  books/  metadata/  fonts/  settings/
  photocards.rs  backgrounds/  tts/
```

**Cost: ~2 days.** `[INFERRED]` **Benefit:** the answer to *"what is platform-specific?"* becomes a
directory listing instead of a grep, and new platform code has one obvious home so it cannot scatter
back.

### 4.2 The three seams that must exist first

**Seam 1 · `platform::webview::harden(window)` — Rust.**
The *contract* — "Sard owns its keyboard and pointer surface" — is shared and load-bearing; only the
mechanism differs. `webview_chrome.rs` **already has the right signature**, including a non-Windows
no-op. Formalising it costs hours and gives the two new implementations a defined place to land
instead of being invented at the call site.

**Seam 2 · `TtsEngine` — Rust.**
`synthesize(voice, text) -> (audio_bytes, word_timings)` and `voices() -> Vec<VoiceInfo>`. **That is
the shape `tts_synthesize` already has.** Build it while the subsystem is already open for Piper's
removal — re-opening the code with the project's longest defect history a second time is the expensive
path. §5.6.

**Seam 3 · `platform` capabilities — TypeScript.**
Add `@tauri-apps/plugin-os`; resolve once at startup. **Branch on capability, not on OS name** — Linux
is not one platform, and `if (os === "linux")` will be wrong on some of it:

```ts
if (caps.overlayWindowControls) insetTitlebar();   // right
if (platform === "macos") insetTitlebar();          // wrong
```

Four capabilities, and a fifth should require an argument: `overlayWindowControls` ·
`fullscreenGesture` (`"f11" | "native"`) · `primaryModifier` (`"ctrl" | "meta"`) · `inAppUpdate`
(false under Flatpak and `.deb`). **~60 lines. If it passes ~150, the logic belongs in Rust.**

### 4.3 What I am refusing, and why

| Refused | Why |
|---|---|
| A `PlatformService` trait over window, audio, filesystem and notifications | Three of the four have exactly one implementation and no second one planned. **Sard uses no notifications at all** (§2.5). An interface with one implementation is a guess |
| **A `sard-core` crate split** (Tauri-free core) | It buys testing without an `AppHandle`, native-shell hosting, and a Rust-Gravity destination. **All three are mobile-facing, and mobile is paused.** It is a multi-week no-behaviour-change refactor that would then need re-verification on three platforms instead of one. **Defer to when mobile resumes**, where it will be drawn on three platforms of evidence |
| A filesystem/paths abstraction | `app_data_dir()` already is one |
| An audio abstraction over `audio_identity` | §1.3 — the problem does not exist on the other platforms |
| An input adapter (`PointerInput`/`TouchInput`) | Desktop has one input model. **macOS trackpad gestures are a real second consumer** and should be where this seam eventually emerges — in Phase 5, from pressure, not prediction |
| Command cleanup | 61 handlers, one file, typed both sides. `[MEASURED]` No platform-specific command exists except `set_titlebar_theme`, which already has a no-op fallback. **Nothing to clean** |
| Plugin cleanup | One candidate only: `opener`, with no call site found (§2.4). Verify, then decide |

---

## 5. Piper removal plan

### 5.1 The complete reference inventory

`[MEASURED]` — every Piper/eSpeak/ONNX/tashkeel reference in the tree, excluding `node_modules`,
`target/`, `test-build/` and this document:

| File | Refs | Nature |
|---|---|---|
| `src-tauri/src/tts.rs` | 68 | The sidecar implementation |
| `src/lib/tts.ts` | 64 | Engine kind, format sniffing, failure model, picker, speed |
| `scripts/copy-release.mjs` | 16 | Copies `piper\` into `test-build\` |
| `src/features/reader/TtsPlayer.tsx` | 8 | The "Switch to Piper" action and engine labels |
| `README.md` | 8 | Feature list, architecture diagram, stack table, licence section |
| `src/features/reader/Reader.tsx` | 5 | Engine wiring |
| `src/lib/listeningOutcomes.ts` | 4 | Outcome definitions referencing the engine |
| `src/lib/ipc.ts` | 4 | Command signatures |
| `src-tauri/src/lib.rs` | 4 | Command registration + the exit-handler child kill |
| `src/i18n/locales/en.ts` | 3 | Strings |
| `src/features/reader/TtsTrackingControls.tsx` | 3 | |
| `src/i18n/locales/ar.ts` | 2 | Strings |
| `src/features/reader/TtsVoicePicker.tsx` | 2 | |
| `scripts/build-test.mjs` | 2 | Comments |
| `BUILD.md` | 2 | The `test-build\piper\` layout |
| `src/reader-engine/injectedCss.ts` · `FoliateController.ts` · `lib/ttsScheduler.ts` | 1 each | Comments |
| `src-tauri/tauri.conf.json` | 1 | `bundle.resources` |
| `src-tauri/Cargo.toml` | 1 | A comment on `ureq` |
| `build-test.bat` | 1 | Comment |
| **`NOTICE`** | **~15 lines** | §2, the licence list, **and the "WHY AGPL" rationale** |

### 5.2 Code — what disappears completely

**Rust (`tts.rs`, ~250 of 751 lines):** `VoiceDef` · `VOICES` · `HF_BASE` · `voice_def` · `Running` ·
`engine_dir` · `voices_dir` · `piper_command` · `spawn_piper` · `piper_synthesize`. `TtsEngine` loses
`inner: Mutex<Option<Running>>`; `shutdown` loses the child kill; the `RunEvent::ExitRequested`
handler at `lib.rs:206` may go entirely.

**TypeScript — where the real prize is:**

| Collapses | From → to |
|---|---|
| `TtsEngineKind` | `"piper" \| "edge"` → one engine |
| Format sniffing | `head[0..3] === "RIFF"` WAV-vs-MP3 (`tts.ts:1316`) → **one format** |
| Timing degradation | *"Piper emits none → sentence-level only"* → **timings always present**; karaoke unconditional; the empty-word-list `framed()` path disappears |
| Failure taxonomy | Two engines × two failure models → one. `curEngine` branching in `playFrom`, `synthDispatch` and the retry ladder |
| Speed handling | The `--length_scale` saturation special case → gone |
| Voice picker | Piper rows + Edge rows → one catalogue |
| "Edge unavailable" pause | *Retry / **Switch to Piper*** → **Retry / Read on** ← the product hole, §5.7 |

> **This is a genuine simplification of the subsystem with the project's longest defect history, and
> it is the strongest engineering argument for the decision — independent of platforms.**

### 5.3 Commands — removed from the IPC seam

`tts_voice_present` and `tts_download_voice` are deleted from `lib.rs`'s `generate_handler!` and from
`src/lib/ipc.ts`. **The registered handler count falls from 61 to 59.**

`tts_synthesize` keeps its signature. **Recommendation: retain the `engine` parameter as a one-value
enum** rather than deleting it — it holds the seam open for §5.6 without a future signature change,
and a signature change across a typed IPC boundary is the more expensive edit.

### 5.4 Crates — what stays

**No crate is removed.** Two must be explicitly protected from being deleted as "Piper leftovers":

- **`ureq 3`** — introduced for voice downloads, but `msedge-tts` depends on it and the RAWY-111
  dedup reasoning rests on one copy in the tree.
- **`rustls` + the `lib.rs:75` `aws_lc_rs` provider pin** — it disambiguates two crypto providers, not
  two engines. **Removing it reintroduces a panic on the first TLS handshake**, which is the Edge
  WebSocket connect. This is the single most likely self-inflicted wound in Phase 1.

### 5.5 Assets, configuration and documentation

| Item | Action |
|---|---|
| `src-tauri/resources/piper/` — `piper.exe`, `piper_phonemize.dll`, `espeak-ng.dll`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `espeak-ng-data/`, `libtashkeel_model.ort`, `LICENSES/` | **Delete — 22 MB** `[MEASURED]` |
| `tauri.conf.json` → `bundle.resources` | **Delete the key entirely.** Nothing platform-specific remains in the bundle |
| `<app_data>/voices/` on users' machines | **A one-time, idempotent, logged cleanup on first run after upgrade** — up to 60 MB per voice of dead weight. Never silent |
| `scripts/copy-release.mjs` | Drop the `piper\` copy (16 refs) |
| `BUILD.md` | Remove the `test-build\piper\` layout description |
| `README.md` | Feature list, the architecture diagram's `tts.rs` line, the stack table's "Offline speech" row, the licence paragraph, and **the screenshot alt-text that describes "the Piper and Edge engines"** |
| **`NOTICE`** | Delete §2 in full **and rewrite the "WHY AGPL-3.0" section** — §5.8 |
| `Cargo.toml`, `build-test.mjs`, `build-test.bat`, three engine comments | Comment-only edits |

### 5.6 What remains — the abstraction, and why

**Keep the engine seam. Delete the engine.**

The abstraction is not speculative — it is **already load-bearing and already proven**. `[MEASURED]`
`tts_synthesize(engine, id, text) -> framed([u32 BE len][words json][raw audio])` already carries two
engines with different audio formats, different latency profiles and different timing availability,
and the frontend already decodes both through one WebAudio path.

That boundary was earned across RAWY-105/110/111/113/159/172/193/257/266. **Collapsing it to a single
concrete engine and then rebuilding it later means re-opening the subsystem with the longest defect
history in the project, twice.**

Formalise it as a Rust trait during Phase 1, with `EdgeEngine` as its only implementation:

```
                      TtsEngine  (trait)
                            │
              ┌─────────────┴──────────────┐
        EdgeEngine                   SystemEngine        [Phase 8]
        network · all 3              offline · per-OS
        MP3 + word timings           WAV/PCM, no timings
        → exact karaoke              → sentence spotlight
```

### 5.7 The product hole this opens, stated plainly

**Removing Piper removes offline read-aloud.** The "Edge unavailable" pause loses its only recovery
action. There is **no telemetry**, so there is no evidence about how often Piper is actually used —
**the owner's own usage is the only data that exists.**

Two invariants must survive verbatim and be verified, not assumed:

1. **The engine never changes without an explicit user press** (D37/RAWY-113 — the removed silent
   swap). Until Phase 8, the pause offers **Retry** and **Read on**, and must not acquire a hidden
   fallback.
2. **Fail loudly rather than silently skipping.** A platform with no usable voice says so in the
   picker; it does not present an empty list.

**Phase 8 restores offline speech** via platform speech behind the Seam-2 trait. A correction worth
recording: ADR-0004 assumed platform speech is *"a player, not a byte source"* and therefore needs a
second verb. **On desktop that is true of one platform out of three** — Windows WinRT
`SpeechSynthesizer` returns a WAV stream and macOS `AVSpeechSynthesizer.write(_:toBufferCallback:)`
returns PCM buffers. **Both are byte sources**, so both flow through the existing, unmodified WebAudio
pipeline. Only Linux (`speech-dispatcher`) is a player.

### 5.8 The licensing consequence — the largest single benefit

`NOTICE:19`, verbatim: `[MEASURED]`

> *"Sard bundles eSpeak NG, which is GPL-3.0-or-later… Distributing that binary means the work it is
> conveyed with must be under a GPL-compatible licence and must not add restrictions of its own."*

**eSpeak NG arrives only inside `src-tauri/resources/piper/`.** Everything else — foliate-js (MIT),
PDF.js (Apache-2.0), the eight families (OFL), and every crate — is permissive.

> **Removing Piper removes the only copyleft dependency in the tree, and the project becomes
> relicensable at the owner's sole discretion.** `[MEASURED — the dependency facts. INFERRED — the
> conclusion; confirm with counsel before acting.]`

I am **not** recommending a licence change. `NOTICE:24` records AGPL-3.0 as *"a deliberate choice, not
only a constraint."* But **the constraint half of that sentence stops being true in Phase 1**, and
`NOTICE` must be rewritten to say so honestly rather than continuing to cite a dependency that no
longer ships. It also retires `FW1` (AGPL vs App Store terms) at the root, whenever mobile resumes.

---

## 6. Execution roadmap

Durations `[INFERRED]` on the project's own basis: one primary developer with AI assistance, at a
quality bar that roughly doubles nominal figures.

---

### Phase 0 · WebKit feasibility probe — **1–2 weeks**

**Objective.** Answer, for the price of a free CI run, whether the reading engine works on WebKit at
all — and start the two procurement items with lead time.

**Expected result.** Six questions answered with evidence; `VENDOR.txt` rewritten; the probe branch
deleted; an Apple Developer account application submitted and a Mac ordered.

A throwaway spike: a temporary `ubuntu-latest` job, WebKitGTK deps, `cargo build`, `tauri build`,
headless under Xvfb, one real multi-section EPUB.

| | Question | If it fails |
|---|---|---|
| **A** | **Do `pointerdown`/`pointerup`/`wheel`/`keydown` reach the book document with `sandbox="allow-same-origin"` alone?** | Everything below is unreachable → §6.0.1 |
| **B** | Does the paginator columnise? Is `scrolling="no"` honoured? Any content-height expansion? | The engine needs work on WebKit generally |
| **C** | Does selection reach `rectInParent` with correct parent-space coordinates? | The annotation loop needs redesign |
| **D** | **Do stored CFIs resolve to byte-identical text on both engines?** | §6.0.2 — the one unrecoverable failure |
| **E** | Does `scrollbar-color` apply? Does unprefixed `backdrop-filter` apply? | Sizes the Phase 1 CSS work |
| **F** | Does the PDF `toDataURL` path render, and at what page size? | Sizes the PDF risk |

Nearly free alongside: confirm `cargo build` succeeds for Linux with only the Piper line failing
(§2.11), and **rewrite `VENDOR.txt`** — it is currently three lines, while the master summary and
ADR-0006 both state it records all nine patch sites. The comments are real and excellent
(`paginator.js:242/477/815`, `fixed-layout.js:84`, `pdf.js:29/135/170/216`) but findable only by grep.
On a re-vendor, that gap is how the question-A patch gets silently dropped.

**Risks.** A fails (Medium) → §6.0.1. D fails (Low-med) → §6.0.2. The probe is kept instead of deleted
and becomes a foundation (Medium) → delete the branch; its purpose is to be measured. A WebKitGTK
failure that does not predict WKWebView (Medium) → record as engine-specific, re-test in Phase 5, do
not chase a ghost.

**Validation.** Each answer names the exact engine and version exercised (§12.3.12). *"An observed
result is not a measured figure."*

**Exit criteria.** A–F answered **with evidence, not expectation**. `VENDOR.txt` rewritten. Branch
deleted. Apple account submitted. A one-page findings record.

#### 6.0.1 If A fails — pre-decided

| Option | Verdict |
|---|---|
| Restore `allow-scripts` on WebKit only | **Rejected.** Reopens a verified code-execution path into `__TAURI_INTERNALS__.invoke` on exactly the platforms where notarisation scrutiny is highest. **D30 is not negotiable per platform** |
| **Serve book content from a separate origin**, so `allow-same-origin` is safe alongside `allow-scripts` | **Recommended.** Origin isolation replaces sandbox-flag isolation — it preserves D30's *guarantee* while satisfying WebKit's *mechanism*. Costs a custom protocol handler and a re-check of every `contentDocument` access |
| A native event shim | **Rejected** — platform code inside the reading engine, contra ADR-0006 |
| Fork the engine per platform | **Rejected** — ADR-0006 calls divergence a product failure |

**Cost if taken: +3–5 weeks, once, shared by both platforms.** `[INFERRED]`

#### 6.0.2 The CFI parity gate — repeated in Phases 0, 4 and 5

> **A CFI that resolves differently on two engines silently corrupts every reading position,
> highlight, note, reference and bookmark in the database.**

`reading_progress.locator_cfi`, `highlights.start_cfi`/`end_cfi`, `notes.locator_cfi`,
`bookmarks.locator_cfi`. CFIs derive from DOM structure, and normalisation, whitespace handling and
`Range` boundary behaviour are **engine implementation details**. The sensitivity is already known and
documented: the render-time paragraph pass adds classes rather than nodes *precisely because* node
changes shift CFI child-step indices (§3.10).

1. Copy a real database **including `-wal` and `-shm`** (§12.3.22 — a missing WAL once produced a
   confident "zero rows" against data the owner had watched being written).
2. On Windows, dump every stored CFI and the text each resolves to.
3. On the new engine, resolve the same CFIs against the same books.
4. **Assert text equality character for character.** Not "approximately the same place."
5. Assert the reverse: an annotation made on the new engine resolves identically on Windows.

**If they diverge, the platform does not ship until they do not. No partial pass.**

---

### Phase 1 · Remove Piper, and clear what a platform multiplies — **3–4 weeks**

**Objective.** Delete the only per-platform native binary in the tree before it has to be built three
times; put a regression net under the change; clear the debt that gets 2–3× more expensive per
platform.

**Expected result.** A tree with no bundled engine, a fully permissive dependency graph, a runnable
frontend test suite, and a ~26 MB smaller download.

**Work.**
- **1a · Remove Piper** — §5.2–5.5 in full.
- **1b · Build Seam 2** (`TtsEngine` + `EdgeEngine`) while the subsystem is open — §5.6.
- **1c · Establish a frontend test runner.** `[MEASURED]` `package.json` has **no test script and zero
  `*.test.*` files exist.** The scheduler is **pure by deliberate design** — no Tauri, no WebAudio, no
  DOM — which is exactly what makes it cheap to put under test. **This lands before 1a touches it.**
- **1d · Engine-portability hygiene** — the five missing `-webkit-` prefixes; a decided
  `scrollbar-color` fallback strategy (§2.13 item 2).
- **1e** — the orphaned-`settings` cascade (`pdf_invert:<id>` rows survive book deletion) and font
  subsetting to WOFF2 (5.4 MB of TTF `[MEASURED]`).

**Risks.**

| Risk | Prob. | Mitigation |
|---|---|---|
| The scheduler regresses | Medium | 1c lands first. Before→after on all eight `LISTENING-OUTCOMES.md` measures |
| **`ureq` or the `rustls` pin deleted as Piper leftovers** | Medium | §5.4 — named explicitly. Both are load-bearing for Edge |
| Offline loss felt as a product regression | High (certain by decision) | Phase 8; honest release note |
| Removal scope-creeps into a TTS redesign | Medium | *"A migration is not a rewrite. Move behaviour; do not redesign it in the same commit"* |

**Validation.** `cargo test` green. The new frontend suite green **and proven to fail on a
deliberately broken build** (§12.3.4). Read-aloud on Edge byte-identical before→after: same latency
distribution, same underrun rate, same karaoke behaviour.

**Exit criteria.** Zero Piper references outside git history. `NOTICE` and `LICENSE` accurate to the
new dependency graph. Installer size recorded before→after (expected **−22 MB resources, −4 MB
fonts** `[INFERRED]`). **The engine cannot change without an explicit user press — verified
structurally, not by absence.**

---

### Phase 2 · Architecture cleanup — **2–3 weeks**

**Objective.** Give platform code one home before three platforms compete to scatter it; remove two
pieces of dead weight a platform expansion would otherwise legitimise.

**Expected result.** A `platform/` module, a Windows build that is byte-identical, and cross-platform
build scripts.

**Work.** The §4.1 directory move · delete `sync/mod.rs` · gate the legacy `com.erawy.app` migration
`#[cfg(windows)]` · `#[cfg(not(target_os = "macos"))]` on `single-instance` · verify and possibly
remove the `opener` plugin (§2.4) · make `kill-sard.mjs` and `copy-release.mjs` cross-platform; add
`build-test.sh`.

**Risks.** A no-behaviour-change refactor changes behaviour (Low-med) → the exit criteria are
byte-identity, not judgment. Cleanup expands into the crate split §4.3 refuses (Medium) → recorded as
out of scope by decision.

**Validation.** A live run against a **snapshotted and restored** real database (§12.3.21), field by
field.

**Exit criteria — gated on identity, not opinion.**
- The `generate_handler!` list unchanged, **name for name** (at 59 after Phase 1).
- Every command signature **byte-identical** before and after.
- `cargo test` count unchanged and green.
- `Sard.exe` size recorded before→after; any difference explained.

---

### Phase 3 · Three platform seams — **1 week**

**Objective.** Build the three abstractions that are known now, cheap now, and would each be invented
badly at a call site under schedule pressure later.

**Expected result.** Three seams. No fourth.

**Work.** Seam 1 (`platform::webview::harden`), Seam 2 (if not already landed in 1b), Seam 3 (the TS
capability module + `@tauri-apps/plugin-os`). §4.2.

**Risks.**

| Risk | Prob. | Mitigation |
|---|---|---|
| **Abstraction sprawl — the defining risk of this phase** | **High** | A hard rule: **a seam requires a second implementation that must exist.** Not symmetry, not tidiness. §7.7 is the project's own precedent for what abstraction-by-intuition costs |
| Seam 3 becomes a platform-branching junk drawer | Medium | A stated ceiling: **past ~150 lines, the logic belongs in Rust** |

**Validation.** The Windows build still byte-identical against Phase 2's baseline.

**Exit criteria.** Three seams, each with exactly one implementation plus a named, scheduled second
one. §4.3's refusals recorded in the repository so they are not quietly reversed.

---

### Phase 4 · Linux — **3–4 weeks**

**Objective.** Do the WebKit compatibility work **once**, on the platform where it is free, and reach
a shippable AppImage preview.

**Expected result.** A real book read end-to-end on WebKitGTK; an AppImage that launches on a clean
machine; a published support tier. **Roughly 70% of this is inherited by macOS unchanged.**
`[INFERRED]`

**Work.** CI matrix entry and toolchain · `platform/linux.rs` webview hardening via `WebKitSettings`
and the `context-menu` signal · **AppImage primary, `.deb` secondary; Flatpak deferred to 4b pending
the §2.2 portal verification** · `.desktop` entry, MIME associations for `application/epub+zip` and
`application/pdf`, icon theme install · updater self-disables where a package manager owns updates
(capability `inAppUpdate`) · native decorations from the DE · **document a WebKitGTK floor** — §2.13
item 7 puts it at **2.40**; fail gracefully below it, never crash · **verify GStreamer MP3 decode on a
minimal container** (§2.7) · **the Arabic IME check** (§2.15) on Wayland and X11, ibus and fcitx5 ·
re-check the three background constants (`MAX_EDGE` 3840, the 140 MP import ceiling, the 18 px blur
default) on **integrated** graphics — all three were measured on a discrete GPU, and **a Rust
allocation failure is `abort()`, not a catchable error: no dialog, the process vanishes.**

**Bound the long tail before it arrives.** Solo-maintainer bandwidth is the risk most often
under-rated and most often fatal. **Linux ships as a first-class *build* with community-supported
*distro* coverage** — one tested combination (current Ubuntu LTS), everything else best-effort,
**published in the README.** A stated tier is a boundary; an unstated one becomes an obligation.

**Risks.**

| Risk | Prob. | Mitigation |
|---|---|---|
| **CFI divergence** | Low-med | §6.0.2. **Blocking** |
| **Arabic IME broken or subtly wrong** | Medium | A named check, not a checkbox. High impact for the core audience |
| WebKitGTK version spread | High | A documented floor; AppImage bundles what it can |
| Wayland vs X11 (fractional scaling, drag-drop, IME) | Medium | Test both explicitly |
| GStreamer MP3 decode missing | Medium | Minimal-container test; declare the dependency |
| Background constants abort on low-end hardware | Med-high | Re-derive before the preview ships |

**Validation.** The full reading loop on WebKitGTK: open, paginate, highlight, note, reference,
bookmark, search, resume, read aloud. CFI parity per §6.0.2, both directions. All 16 themes. `cargo
test` and the frontend suite green **on the Linux runner**.

**Exit criteria.** The §8.2 Linux checklist passes at **preview tier**. An AppImage launches on a
clean machine at the documented floor. The support tier is published.

---

### Phase 5 · macOS — **5–7 weeks**

**Objective.** Bring macOS to a production bar, inheriting the WebKit work, and integrate natively
where the window meets the operating system.

**Expected result.** A notarised universal `.dmg` that launches with no Gatekeeper warning and feels
like a Mac application.

**Prerequisites** — started in Phase 0: an Apple silicon Mac (~$700–1,500), the Apple Developer
Program ($99/yr; **individual 24–48 h, organisation 1–2 weeks**), a Developer ID certificate.

**Work.** Universal binary (`x86_64` + `aarch64`, `lipo`'d — better UX and a smaller support surface
than two artifacts) · **notarisation + stapling**, without which Gatekeeper blocks first run ·
`titleBarStyle: "Transparent"` + `hiddenTitle` + traffic-light inset padding (§4.4) · **the
application menu** — About, Preferences, Quit, and a standard Edit menu; **genuinely new UI surface
and the most under-estimated item in this phase** · `Cmd+Ctrl+F` fullscreen via `fullscreenGesture` ·
`platform/macos.rs` webview hardening (much smaller than Windows) · **trackpad gestures** —
two-finger swipe to turn, pinch to size · Info.plist usage descriptions (§2.2) · `.app.tar.gz` updater
payload · **the WebKit Inspector harness, built properly** (Phase 6) · measure `html-to-image`
photo-card fidelity and record honestly.

> **Trackpad gestures are where the input adapter should be allowed to emerge** — a real second input
> consumer with real requirements, which is the only honest reason to create that seam.

**Risks.**

| Risk | Prob. | Mitigation |
|---|---|---|
| CFI divergence on WKWebView | Low-med | §6.0.2 again — **WebKitGTK passing does not prove WKWebView passes** |
| WKWebView iframe behaviour diverges from WebKitGTK | Medium | Phase 4 narrows this from "does WebKit work" to "does WKWebView differ" |
| **The menu bar is under-scoped** | **Med-high** | Scope it as a deliverable, not as polish |
| Notarisation friction | Medium | **Budget two attempts.** Rehearse with a draft release |
| Photo-card rasterisation degrades | Med-high | Record as a known, contained limit. **Do not rewrite the rasteriser in this phase** |

**Validation.** The full reading loop on WKWebView. CFI parity per §6.0.2, independently of Phase 4.
The traffic lights correct over Sard's top bar in all 16 themes, LTR and RTL. The menu keyboard-
navigable.

**Exit criteria.** The §8.3 macOS checklist passes at **production tier**. A notarised `.dmg`
installs and launches clean on a machine that has never seen Sard.

---

### Phase 6 · Verification — **2–3 weeks, running in parallel from Phase 0**

**Objective.** Hold three platforms to one standard of proof.

**Why it is not a phase at the end.** Sard's bar is unusually high: *"a harness must be proven to FAIL
on the unfixed build before its pass means anything"*; *"a measurement that cannot fail is not
evidence."* `[MEASURED]` **The live instrument is WebView2 CDP (D55), and it does not speak WebKit.**
So on day one of Phase 4, that standard becomes unmeetable on the new platform unless the harness
already exists. The harness work therefore **starts in Phase 0** and runs through Phases 4 and 5;
what is discrete here is the **gate**.

**Work.** One harness abstraction over CDP (Chromium) and the WebKit Inspector Protocol, with the same
assertion vocabulary: computed styles **with a forced reflow** (§12.3.9), **real gesture dispatch —
never `element.click()`** (§12.3.7), positive controls proven to fail. Then, on all three: the CFI
parity suite, the 44-check reader-lifecycle suite, the accessibility pass against each platform's
computed a11y tree, the read-aloud outcomes, and the 29-item acceptance checklist.

**Risks.** Verification silently fails to scale — no visible failure until quality has drifted (**High
if unaddressed**) → build early. The WebKit harness is weaker than the CDP one, so two platforms are
held to a lower bar (Medium) → **parity of assertions is the acceptance criterion, not parity of
effort**. Three-platform verification becomes the schedule (Medium) → automate in CI; reserve manual
work for what needs eyes.

**Exit criteria.** One harness, three engines, the same assertions. Every suite green on all three.
Each harness **proven to fail** on a deliberately broken build. **The honest limit written down** —
exactly what was not verified, on which platform, and why.

---

### Phase 7 · Release — **2–3 weeks, partly parallel**

**Objective.** One tag produces three signed artifacts and one manifest.

**Work.** Convert `release.yml` to a matrix (`windows-latest`, `macos-latest`, `ubuntu-22.04`) ·
verify `tauri-action` merges per-platform entries into **one** `latest.json` against one release ·
keep `updaterJsonPreferNsis: true` Windows-scoped · macOS notarisation secrets · **Windows
Authenticode signing** (Azure Trusted Signing) — this fixes the SmartScreen warning that greets
*every existing user today*, and it is the highest-value item here for people already using Sard ·
README, `BUILD.md` and `NOTICE` rewritten for three platforms including the §2.1 XDG deviation and the
Linux tier · clear the doc debt (`Cargo.toml`'s description still says *"Arabic-first"*, contradicting
D44; README names `Sard_1.0.0_*`; the IPC count is quoted as 52 against a measured 61 → 59).

**One item overdue independently of platforms.** `[MEASURED, §9.4]` The in-app update path from an
installed v1.1.0 to a newer version **has never been exercised end-to-end by a real user**, because no
newer version exists. The master summary calls it *"the single most valuable thing to verify on the
next release."* **Verify it on Windows before the tri-platform release, not during it** — otherwise a
broken updater ships to three platforms at once.

**Risks.** `latest.json` merges wrongly and the updater offers the wrong artifact (Medium) → exercise
via `workflow_dispatch`, which builds a **draft**, before tagging. The minisign key now gates three
platforms (Low probability, catastrophic impact) → confirm the offline backup first. Three release
trains for one maintainer (Med-high) → **one tag, one workflow, three artifacts; never a manual
per-platform step.**

**Exit criteria.** One tag → three signed artifacts → one `latest.json`. An installed v1.1.0 on
Windows updates itself, verified live. A Mac and a Linux machine each install from the published
artifact with no security warning, or a documented one. Docs accurate on all three.

---

### Phase 8 · Offline speech restoration — **4–6 weeks, post-release**

**Objective.** Close the philosophy gap Phase 1 opens, with the seam already built and without gating
the tri-platform release.

**Work.** Implement `SystemEngine` behind the Seam-2 trait: **macOS first**
(`AVSpeechSynthesizer` — genuinely good Arabic voices), then Windows (WinRT `SpeechSynthesizer`, with
an honest prompt when the Arabic language pack is absent), then Linux (system `espeak-ng` as a byte
source, or `speech-dispatcher` as a player). Voice enumeration into the existing picker, grouped by
language and labelled by engine, exactly as Edge voices already are.

**Risks.** Quality varies enough between platforms that it must be **stated in the UI**, not
discovered. Windows Arabic needs a user-installed language pack. Linux quality may be poor enough that
offering it is worse than not. **The "engine never changes without an explicit user press" invariant
must survive the reintroduction of a second engine** — the exact defect class of the removed silent
swap.

**Exit criteria.** Offline read-aloud works on at least macOS and Windows. The picker names each
engine honestly and never auto-switches. **The scheduler is unmodified** — a new engine behind an
existing trait must not require touching it.

---

## 7. Risks, ranked

Ranked by expected cost (probability × impact), not severity alone.

| # | Risk | Prob. | Impact | Category | Mitigation |
|---|---|---|---|---|---|
| **1** | **WebKit event dispatch fails without `allow-scripts`** (§0.1) | Medium | **Architecture-changing** | Technical | Phase 0, week one. §6.0.1 pre-decided |
| **2** | **CFI divergence between engines** | Low-med | **Catastrophic — silent data corruption of every annotation and position** | Architectural | §6.0.2. A blocking gate in Phases 0, 4 and 5. **No partial pass** |
| **3** | **Verification cannot meet Sard's own standard on WebKit** | **High if unaddressed** | Slow, invisible quality erosion | Maintenance | One harness, three engines, built from Phase 0 |
| **4** | **Linux long tail** — WebKitGTK spread, Wayland/X11, four DEs, distro packaging | High | Medium, **compounding** | Maintenance / distribution | A published support tier; one tested combination; AppImage before Flatpak |
| **5** | **Offline read-aloud lost** | Certain by decision | Medium | Product | Phase 8. **No telemetry exists — the owner's usage is the only evidence** |
| **6** | **Solo-maintainer bandwidth across three platforms** | Med-high | **Compounding** | Maintenance | Ruthless restraint on platform-specific features; media controls (§2.6) explicitly post-1.0; Linux tiered |
| **7** | **Arabic IME on Linux** (§2.15) | Medium | **High for the core audience** | Technical | A named Phase 4 check on Wayland and X11, ibus and fcitx5 |
| **8** | **Background constants `abort()` on integrated GPU / low RAM** | Medium | Crash with **no dialog** — the process vanishes | Technical | Re-derive all three before the Linux preview ships |
| **9** | **macOS application menu under-scoped** | Med-high | Schedule | Technical | Scoped as a Phase 5 deliverable, not polish |
| **10** | **`latest.json` merges wrongly; the updater offers the wrong artifact** | Medium | High — a broken update path on three platforms | Packaging | Rehearse with `workflow_dispatch` drafts before tagging |
| **11** | **macOS notarisation friction** | Medium | Schedule only | Packaging | Budget two attempts; start the account in Phase 0 |
| **12** | **Flatpak sandbox breaks the import loop** | Medium *(only if pursued)* | Medium | Packaging | AppImage is v1. Flatpak is 4b with its own portal verification |
| **13** | **Photo-card rasteriser fidelity on WebKit** | Med-high | Low — one contained feature | Technical | Record as a known limit; do not rewrite in-phase |
| **14** | **GStreamer MP3 decode missing on a minimal Linux install** | Medium | High when it happens — read-aloud silently fails | Distribution | Minimal-container test; declare the dependency; bundle in the AppImage |
| **15** | **The minisign key is lost** | Low | **Catastrophic — no existing install can ever update again, on any platform** | Packaging | Confirm the offline backup before Phase 7. It cannot be regenerated, only replaced, and replacing it strands every existing user |
| **16** | **Abstraction sprawl during Phase 3** | Medium | Compounding complexity | Architectural | A seam requires a second implementation that must exist |

### 7.5 macOS App Store — a recommended non-goal

Two independent obstacles, and neither is worth solving now:

1. **AGPL-3.0 vs App Store distribution terms.** Widely held incompatible. As sole copyright holder
   the owner can grant an exception — and after Phase 1 the tree is fully permissive and the licence
   is a free choice (§5.8). **Resolvable, but a decision, not a task.**
2. **The App Sandbox is mandatory**, which turns `import_folder`'s recursive walk into
   security-scoped-bookmark work (§2.2), and constrains the asset protocol and the updater — the
   in-app updater is **forbidden** on MAS; Apple owns updates.

**Recommendation: ship macOS via Developer ID + notarisation.** It reaches every Mac, keeps the in-app
updater, keeps the offline philosophy intact, and avoids review latency on every release. **Revisit
MAS only as a distribution decision, never as a technical milestone.**

### 7.6 Linux distribution concerns

| Concern | Position |
|---|---|
| **Format** | **AppImage v1** (no sandbox, bundles dependencies, one file). `.deb` secondary. **Flatpak deferred** pending §2.2 |
| **WebKitGTK floor** | ≈ **2.40** (`color-mix`, §2.13 item 7). Document it; fail gracefully below, never crash |
| **Wayland vs X11** | Both must be tested. Fractional scaling, drag-drop and IME differ |
| **Distro packaging by others** | Likely and welcome. **Publish the support tier** so a community `.rpm` is not read as an obligation |
| **GStreamer** | Read-aloud depends on MP3 decode. Bundle in the AppImage; declare in the `.deb` |
| **Desktop integration** | `.desktop` entry, MIME associations, icon theme — small, and their absence is what makes an app feel foreign |

---

## 8. Success criteria — what "support" actually means

**Compiling is not support. Launching is not support.** These are the checklists.

### 8.1 Shared — must pass identically on all three

| # | Criterion |
|---|---|
| 1 | **CFI parity, both directions** (§6.0.2). Character-for-character. **Blocking** |
| 2 | The full reading loop: import → open → paginate → highlight → note → reference → bookmark → search → close → **resume at the exact position** |
| 3 | All **16 themes** render correctly, including Moonlit Sky's decoration layer |
| 4 | **RTL and LTR** complete: mirrored interface, panels on their pinned physical sides, the media transport **not** mirrored |
| 5 | Arabic renders with correct shaping, tashkīl show/dim/hide, and diacritic-folding search |
| 6 | Read-aloud: sentence spotlight, **word karaoke**, chapter-end continue, per-book resume, explicit speed |
| 7 | Photo cards render and export at the correct pixel ratio |
| 8 | User background images work on both surfaces, with the measured legibility floors holding |
| 9 | **Deletes cascade to zero orphans**, verified against a real database |
| 10 | Accessibility: every interactive control has an accessible name; closed panels leave the tab order; contrast floors hold |
| 11 | **The performance budget holds** — no idle timers, no background polling, no animation loop spinning at rest; startup, navigation latency and idle working set recorded |
| 12 | `cargo test` and the frontend suite green **on that platform's runner** |
| 13 | The in-app updater completes a real upgrade end-to-end |
| 14 | Uninstall leaves user data intact; the app data directory survives an update **by construction** |

### 8.2 Linux — production-ready

Beyond §8.1:

- Runs on the documented WebKitGTK floor and **fails readably below it**.
- Verified on **Wayland and X11**.
- **Arabic input works** via ibus and fcitx5 — composition, cursor placement in bidi text, selection in
  mixed-direction paragraphs (§2.15).
- Read-aloud MP3 decode verified on a **minimal** install, with the GStreamer dependency declared or
  bundled.
- The AppImage launches on a clean machine with **no manual dependency installation**.
- `.desktop` entry, icon and MIME associations present; double-clicking an EPUB opens Sard.
- The three background constants re-derived on **integrated** graphics; **no `abort()` reachable** by
  importing a large image.
- The in-app updater **self-disables** where a package manager owns updates.
- **The support tier is published**, and the tested combination is stated by name.

### 8.3 macOS — production-ready

Beyond §8.1:

- A **notarised, stapled** universal `.dmg` launches on a clean Mac with **no Gatekeeper warning**.
- Runs natively on **Apple silicon and Intel**.
- The **application menu** is complete and keyboard-navigable: About, Preferences, Quit, Edit.
- `Cmd` shortcuts throughout; **`Cmd+Ctrl+F`** and the green button both toggle fullscreen.
- Traffic lights sit correctly over Sard's top bar in **all 16 themes, LTR and RTL**.
- **Trackpad gestures**: two-finger swipe turns the page; pinch resizes text.
- TCC prompts are readable, with Info.plist usage descriptions present.
- **A second launch focuses the existing window** (re-open handled without `single-instance`).
- Photo-card fidelity measured against Windows output, with any difference **recorded as a known
  limit** rather than discovered by a user.
- Retina rendering correct at 1×, 2× and fractional scaling.

### 8.4 Windows — the preservation criterion

**Windows is not "still works". It is "provably unchanged."**

- The `generate_handler!` list unchanged, **name for name**.
- Every command signature **byte-identical**.
- `Sard.exe` size recorded before→after at every phase boundary; any difference explained.
- `cargo test` count unchanged and green.
- The 44-check reader-lifecycle suite passes against a **snapshotted and restored** real database.
- **The only intended Windows-visible changes in this entire plan are:** offline read-aloud is removed
  (Phase 1, restored in Phase 8), the installer is ~26 MB smaller, and it becomes Authenticode-signed
  (Phase 7). **Anything else is a regression.**

---

## 9. The shortest honest summary

**The architecture is already right, and that is the most important finding here.** Sard was built by
someone who kept one IPC seam, one database connection, one reading engine and one token set, and who
put every Windows call behind a `cfg` gate with a working fallback **before there was any reason to**.
That discipline is now worth several months.

So this is not a restructuring. It is:

1. **Spend one week finding out whether the reading engine works on WebKit at all** — the answer is in
   a comment in your own `paginator.js`, and it says the patch you applied removes a workaround that
   exists *for WebKit*. **Order the Mac and start the Apple account the same week.**
2. **Delete Piper**, because it is the only thing in the tree that would otherwise be built three
   times and thrown away — and deleting it hands you a fully permissive dependency graph, a ~26 MB
   smaller download, and a materially simpler read-aloud subsystem in one move. **Keep the seam;
   delete the engine.**
3. **Move three files into `platform/`, build three seams, and refuse the fourth.**
4. **Do the WebKit work once, on Linux, where it is free** — then let macOS inherit it and be the
   first production release.
5. **Change nothing inside the page; integrate natively where the window meets the operating system.**

**17–24 weeks to both platforms production-ready.** A shippable Linux preview at ≈ week 10, macOS
production at ≈ week 18–22, offline voice restored one release later.

The temptation this plan is designed to resist is the one that feels most like good engineering:
building a platform service layer, splitting the core into crates, and unifying the title bar before
writing a line of Linux. **All three would be work you cannot yet justify with a measurement** — and
this project, more than most, already knows what that costs.

---

*Engineering study and plan only. No code was written, no repository state changed beyond this
document, no commits made. Every `[MEASURED]` claim was read from or run against the tree at
`dd23765`; every `[INFERRED]` and `[HYPOTHESIS]` is labelled and is the author's reasoning, not a
project decision.*
