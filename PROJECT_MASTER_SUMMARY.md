# Sard · سَرْد — Project Master Summary

**The official long-term engineering reference for the Sard project.**

| | |
|---|---|
| **Document status** | Authoritative. Supersedes ad-hoc handoffs for onboarding purposes. |
| **Written** | 2026-08-04 |
| **Describes** | `main` @ `dd23765`, released version **1.1.0** (tagged `v1.1.0`, published 2026-08-03) |
| **Repository** | `M:\eRawy` → <https://github.com/Limitless-Soul1/Sard> |
| **Licence** | AGPL-3.0-only |
| **Maintenance rule** | Update this document whenever a **major milestone** completes — a release, a new subsystem, a reversed decision, or a change to the release pipeline. Do not update it for individual tickets; those live in the project history. |

### How this document was produced, and what it is not

Every factual claim below was taken from one of four sources, in this order of authority:

1. **The source tree itself** (`M:\eRawy` at `dd23765`) — code, configuration, migrations, workflows.
2. **The git history** (251 commits, 2026-06-28 → 2026-08-03) — including full commit bodies, which in this
   project are unusually detailed and carry the reasoning for most decisions.
3. **The repository's own published docs** — `README.md`, `BUILD.md`, `NOTICE`, `LICENSE`.
4. **The private engineering vault** (`M:\ProjectDocs\sard\`, off-repo, not published) — `STATE.md`,
   `DECISIONS.md`, `LESSONS.md`, `OPEN.md`, `SHARE-RELEASE.md`, `ENGINEERING-CONTRACT.md`, `HISTORY.md`.

Where a measurement is quoted it is labelled **measured** with its date. Where something is inferred it is
labelled as inference. Nothing here is invented: where the record is silent — notably on mobile platforms —
this document says the record is silent rather than filling the gap.

**One caveat a new reader must carry from the first page:** the private vault's hot file `STATE.md` was last
refreshed on 2026-08-03 *during* the pre-release audit and describes version `0.5.1` with two open P0
blockers. **That snapshot is stale.** Both P0s were closed and two releases shipped after it was written.
This document reflects the tree, not that snapshot. See §9.5 and Appendix B.

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Technology stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Major features](#4-major-features)
5. [Design philosophy](#5-design-philosophy)
6. [Development history](#6-development-history)
7. [Major technical decisions](#7-major-technical-decisions)
8. [Release process](#8-release-process)
9. [Current project status](#9-current-project-status)
10. [Future roadmap](#10-future-roadmap)
11. [Repository structure](#11-repository-structure)
12. [Lessons learned](#12-lessons-learned)
- [Appendix A — the engineering vault and the ticket workflow](#appendix-a--the-engineering-vault-and-the-ticket-workflow)
- [Appendix B — known documentation debt](#appendix-b--known-documentation-debt)
- [Appendix C — quick facts table](#appendix-c--quick-facts-table)

---

# 1. Project overview

## 1.1 What Sard is

**Sard** (Arabic *سَرْد*, "narration") is a **native desktop ebook reader** for Windows. It reads **EPUB**
with reflowable text and **PDF** as a fixed-layout document. It is built as a Rust core hosting the system
WebView, with a local SQLite database.

There is **no account, no sync service and no telemetry**. A user's library, reading positions, notes,
highlights, references, bookmarks, photo cards, background images, settings and downloaded voices all live in
one directory on their own machine (`%APPDATA%\com.sard.app`). Nothing leaves the device except two
deliberate, user-initiated network calls: downloading a Piper voice model, and using Microsoft Edge's online
neural voices for read-aloud (plus the update check from v1.1.0 onward).

The application is a single window. Its two top-level surfaces are the **Library** (a shelf of books, plus
cross-book views of every annotation, bookmark and photo card) and the **Reader** (one book, open).

## 1.2 The philosophy behind it

Three ideas do most of the work.

**A page resting on a desk.** The reading surface is a single centred column of text on an opaque page, with
the desk showing in the margins. That is not decoration — it is the model the whole reading UI is derived
from. The page is a physical object with a paper colour; the desk is the environment around it; chrome is
something that arrives when asked for and recedes when not. Every reading feature is judged by whether it
respects that model.

**Arabic is first-class, but it is not the identity.** This is recorded as decision **D44**, and it
supersedes the project's original "Arabic-first" framing. Sard aims to be the best *general* ebook reader,
for every language, judged on four pillars — **performance · beauty · quality · accessibility**. Arabic gets
genuine depth (real RTL layout, tashkīl control, Naskh and Ruqʿa faces, diacritic-folding search,
Arabic-Indic numerals, bidi-correct paragraph handling) because most readers treat it as a localisation
task and produce software that is broken in it. But English typography, panel motion, and whether hiding a
toolbar shifts the text underneath get the same attention. The stated priority order is
**beauty › smooth › lightweight**, and each is measured rather than asserted.

**Measure, never assert.** Since 2026-08-01 this is a written, permanent policy — the
**Engineering Contract** (§7.9). Investigation precedes code; the root cause is found before a fix is
designed; the smallest correct fix wins; performance has a budget that may not grow without measured
benefit; and every change reports before → after. The commit history is a record of numbers, including
numbers that *refuted* a proposed change and killed it.

## 1.3 Design goals

| Goal | What it means concretely |
|---|---|
| **Performance** | A frame budget that holds. Backgrounds are resampled at import so source size cannot reach render cost. No idle timers, no background polling, no animation loop that spins while nothing is happening. Heavy work is off the main thread. |
| **Beauty** | 16 themes, each a complete token set. Typography controls that reach the book's own document. No literal colours outside genuine paints. Motion that is short and purposeful. |
| **Quality** | Reading position survives font changes, resizes and re-imports (stored as an EPUB CFI). Deletes cascade to zero orphans. Migrations are additive and never edited after they ship. Behaviour is preserved unless changing it *is* the ticket. |
| **Accessibility** | Contrast floors are computed per theme, not chosen by eye. Every interactive control has an accessible name. Closed panels leave the tab order. `forced-colors`, `prefers-contrast` and `prefers-reduced-transparency` suppress the background feature rather than softening it. |

## 1.4 Target audience

- **Readers of Arabic** who have never had a desktop reader that renders their books correctly — correct
  RTL, tashkīl they can show, dim or hide, search that finds a word regardless of its diacritics, and page
  turns that go the right way.
- **Serious readers of anything** who want control of typography and a reading surface that does not fight
  them: long-form fiction and non-fiction readers, students, re-readers who annotate heavily.
- **People who want their library to be theirs** — local files, local database, no account, no cloud, no
  reading telemetry.
- **Listeners** — readers who alternate between reading and being read to, and who care that the voice does
  not change under them.

It is *not* aimed at: catalogue/collection managers (Calibre's job), publishers, or people who need a mobile
reader today.

## 1.5 What makes it different from other ebook readers

1. **Arabic built in from the layout up, not localised in.** RTL is one of two directions the layout is
   built in, not a mode. Search folds diacritics («الليل» finds «اللَّيْلُ»). Numerals render Eastern-Arabic
   in an Arabic interface. Bad paragraph markup in converted Arabic EPUBs is corrected at render time
   (§4.2). The interface mirrors completely, including which physical side each panel docks on — and the
   media transport deliberately does *not* mirror, because ⏮/⏭ mean time, not reading direction.
2. **References.** A note bound to a *word or phrase* rather than to a position, marked wherever that phrase
   occurs anywhere in the book — including in text written after the reference was made. No other consumer
   reader in this class ships this.
3. **Spoiler-safe search.** Matches up to your current position are shown in full; everything ahead is
   sealed behind a count until you ask. Searching a book you are halfway through should not tell you how it
   ends.
4. **Read-aloud with two engines and one rule.** Offline neural voices (Piper) or Edge's online voices, with
   sentence spotlight and word-level karaoke — and a structural guarantee that **the engine never changes
   without an explicit user press**. A silent fallback that swapped the narrating voice mid-paragraph was
   removed and cannot return (§7.5).
5. **Photo cards.** Turn a passage into a shareable image: five card styles × sixteen papers × four formats,
   with the quotation auto-fitted to the card.
6. **Personal backgrounds done properly.** Your own image behind the library and around the reading desk,
   with every legibility floor *measured* across all sixteen themes rather than eyeballed, and a render cost
   that is bounded by construction.
7. **A theme is a token set, not a stylesheet.** One set of semantic tokens drives the chrome *and* the
   book's own document through an injected-CSS funnel. Adding a seventeenth theme is adding a preset.

---

# 2. Technology stack

Every choice below is recorded with the reason it was made. Decision ids (`D1`, `D2`, …) refer to the
project's decision log (Appendix A).

## 2.1 Shell — Tauri 2 (`D1`)

The application is a Tauri 2 desktop app: a Rust process that owns the window, the filesystem, the database
and all privileged work, hosting the **system WebView** for the interface.

**Why:** the highest design ceiling available (the whole of modern CSS is on the table, which is what makes
the visual goals reachable) with a Chromium compositor for smoothness — but *without* bundling a browser.
Using the OS WebView2 keeps the installer small and idle RAM low compared with Electron. Windows is Tauri's
strongest target, which matches the Windows-first plan.

**Cost accepted:** the app inherits Chromium's own UI for free, including a find bar, print navigation,
reload and a browser context menu. All of it is suppressed natively (§4.16, `D47`). It also means the audio
session belongs to `msedgewebview2.exe` at the OS level (§7.8).

## 2.2 Core language — Rust

The core owns: SQLite access and migrations, book import (file read, SHA-256, zip/OPF parse, cover
extraction), metadata overrides, custom fonts, photo-card files, background image decode/resample/encode,
the Piper sidecar and Edge TTS orchestration, WebView2 chrome suppression, native title-bar theming and the
Windows audio-session identity worker.

**Why:** it is what Tauri is; and every one of those jobs is either privileged, CPU-heavy, or both. The
current core is **6,071 lines** across 20 modules (measured 2026-08-04).

## 2.3 Front end — React 19 + TypeScript + Vite

**Why React (`D1`):** ecosystem and hiring surface; the decision explicitly records that it is *reversible*
and that Svelte was the lighter alternative considered. TypeScript is used everywhere, with
`noUnusedLocals` on — which has caught real defects (§12).

**Why Vite:** fast dev server, and a production build that emits a `dist/` the Rust binary embeds. `npm run
build` is `tsc && vite build`, so a type error fails the build rather than shipping.

Current front end: **23,354 lines** of TS/TSX plus a single **4,627-line** global stylesheet
(measured 2026-08-04).

## 2.4 State — zustand

Small, unopinionated stores rather than a single global reducer. Used for the reader engine store, theme
store, annotations, bookmarks, references, photo basket and the updater. Chosen for weight and for the
absence of ceremony; there is no Redux-style action layer anywhere in the codebase.

## 2.5 Storage — SQLite via `rusqlite` (bundled) (`D10`)

One SQLite file, one `rusqlite::Connection`, behind a `Mutex` in the Tauri app state. Migrations are ordered
embedded SQL files with a `schema_migrations` table mirrored to `PRAGMA user_version`; only versions above
the current one are applied, each inside a transaction, so the runner is idempotent.

**Why bundled SQLite:** no external dependency on the user's machine, and a known version.
**Why `rusqlite` and not `sqlx`:** a low-concurrency desktop file database does not need an async SQL stack;
the synchronous API is lighter and simpler to reason about.
**Why one connection:** it makes "who holds the lock" a question with one answer. It is also why a panic
under that lock was once able to disable persistence for a whole session — a defect found and fixed in
RAWY-273 (§7.6).

## 2.6 EPUB rendering — foliate-js, vendored (`D2`)

EPUB parsing, pagination, CFI handling and rendering are **foliate-js** (MIT), **vendored at a pinned
commit** under `public/foliate-js/` — `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01).

**Why not build one:** a correct reflow + pagination + CFI + bidi engine is engineer-*years*. Rendering
inside the WebView gets Arabic shaping and bidi from HarfBuzz and the CSS engine for free.

**Why vendored rather than depended on:** so that an upstream change can never silently alter how a book
lays out. Sard also carries **local modifications** to that copy — including the iframe sandbox hardening
and a PDF page-canvas workaround — recorded in `public/foliate-js/VENDOR.txt` with the standing instruction
**"re-apply on any re-vendor."**

## 2.7 PDF rendering — PDF.js

PDF.js (Apache-2.0) ships *inside* the vendored foliate-js tree (`public/foliate-js/vendor/pdfjs/`), which
uses it directly. Sard's PDF support is deliberately narrow (§4.3).

One local patch: the page canvas is copied to an `<img>` via `toDataURL`, because `adoptNode` renders blank
in WebView2.

## 2.8 Read-aloud — Piper + eSpeak NG + ONNX Runtime, and Microsoft Edge voices (`D36`, `D37`)

**Piper** (MIT) is bundled as a prebuilt sidecar at `src-tauri/resources/piper/` — `piper.exe`,
`piper_phonemize.dll`, `espeak-ng.dll` (**GPL-3.0-or-later**), `onnxruntime.dll`,
`onnxruntime_providers_shared.dll`, `espeak-ng-data/` and `libtashkeel_model.ort`. It runs as **one
persistent process per voice** (`--json-input`), so the model is loaded once and stays warm. Arabic is
auto-routed through `--tashkeel_model` for diacritization, which is the quality gate for Arabic speech.

**Voice models are not bundled.** They are ~60 MB each and are downloaded on request, Rust-side, via `ureq`.
That is what keeps the installer small while still making offline speech available to everyone.

**Microsoft Edge** neural voices are reached through `msedge-tts` (MIT) — the free, keyless edge-tts
endpoint, no Azure account, over rustls. Edge is the **default** engine; it provides word-boundary metadata,
which is what makes word-level karaoke possible. Piper is the offline anchor.

**Why not Web Speech:** WebView2 exposes only locally installed voices, which means **zero Arabic**. It was
dropped early.

**A subtle build note that is load-bearing:** `msedge-tts` (aws-lc-rs) and `ureq 3` (ring) compile *two*
rustls crypto providers into one rustls, which makes provider auto-detection ambiguous and **panics** on the
first TLS handshake. `lib.rs` installs `aws_lc_rs` as the explicit process default before anything opens a
connection.

## 2.9 Image processing — the `image` crate

Used only by the backgrounds subsystem: decode, EXIF-orientation resolution, Lanczos3 downscale and
**lossless PNG** encode. Compiled with `default-features = false` and exactly three formats — `jpeg`, `png`,
`webp`. Notably **no `gif`**, so an animated GIF cannot even be decoded (it is refused by a magic-byte sniff
long before that).

## 2.10 Typography — eight bundled OFL families

Amiri, Noto Naskh Arabic, Aref Ruqaa, IBM Plex Sans, IBM Plex Sans Arabic, Literata, Source Serif 4, Inter —
all SIL Open Font License 1.1, each with its licence beside it in `public/fonts/`. Users can also import
their own fonts (`font_import`), stored under app data and registered per script.

## 2.11 Windows-specific crates

- **`webview2-com` 0.38** — reaches `ICoreWebView2Settings` to strip browser chrome and accelerators. Tauri
  surfaces none of these; they are set through `with_webview`. Pinned to the version already in the tree via
  `tauri`/`wry` so cargo dedupes and the COM interfaces stay ABI-identical.
- **`windows` 0.61 / `windows-core` 0.61** — Core Audio (`IMMDeviceEnumerator`, `IAudioSessionControl2` and
  its notifications), the ToolHelp process snapshot, threading and security primitives. Used by the audio
  identity worker (§7.8) and the native title-bar theming.
- **`tauri-plugin-single-instance`** — a second launch focuses the running window instead of starting a
  rival process that would attach the same WAL database.

## 2.12 Build system

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server alone. |
| `npm run tauri dev` | The desktop app with hot reload. |
| `npm run build` | `tsc && vite build` — typecheck + production front-end bundle into `dist/`. |
| `npm run tauri build` | Full release: binary + NSIS installer + MSI. |
| `npm run build:test` | **The everyday loop.** `scripts/build-test.mjs`. |
| `cargo test` / `cargo clippy --all-targets` | The Rust core, run inside `src-tauri/`. |

`build:test` exists because the naïve path fails in ways that waste hours. It (1) verifies `cargo` is
resolvable and falls back to rustup's default `%USERPROFILE%\.cargo\bin`, aborting with a readable message
rather than an opaque `cargo metadata` dump; (2) **closes any running Sard** — `sard.exe`, `Sard.exe` *and*
`Sard-standalone.exe` — because a held-open executable makes the build fail with `Access is denied (os error
5)` and leaves the *old* binary on disk, so you keep testing a stale build; (3) runs
`tauri build --no-bundle`, skipping the slow WiX/NSIS bundling a local test does not need; (4) copies the
result to a stable `test-build\` path.

> ⚠ `--no-bundle` is for test builds only. A release needs the full `tauri build`.

## 2.13 Release pipeline

GitHub Actions (`.github/workflows/release.yml`) + `tauri-apps/tauri-action` + minisign signing +
`tauri-plugin-updater`. Fully described in §8.

## 2.14 What was considered and rejected

| Rejected | Instead | Why |
|---|---|---|
| Electron / bundled browser | Tauri 2 + system WebView2 | Installer size, idle RAM. |
| Writing an EPUB engine | foliate-js, vendored | Engineer-years; and the WebView gives correct Arabic shaping for free. |
| Web Speech API | Piper + Edge | WebView2 exposes zero Arabic voices. |
| `sqlx` | `rusqlite` | Async SQL stack is unnecessary weight for a single-user file DB. |
| `react-i18next` | ~80-line custom i18n context (`D14`) | Two locales, flat keys, `{var}` interpolation. It is the upgrade path if plurals/namespaces/lazy loading ever arrive. |
| A per-file DB lock during import | One batch-wide guard | **Refuted by measurement** — Windows `std::sync::Mutex` is an unfair SRWLOCK; a waiter never wins the handover (§7.7). |
| A parallel Edge synthesis pool | One serialized socket | Reverted after it caused correctness regressions; ordering, not parallelism, was the real fix (§4.13). |
| A hand-rolled updater | `tauri-plugin-updater` | The custom one could not download, verify or install (§7.4). |

---

# 3. Architecture

## 3.1 The big picture

```
┌─ WebView2 (Chromium) ──────────────────────────────────────────────┐
│  React 19 + TypeScript + Vite + zustand                            │
│                                                                    │
│  features/    library · reader · settings · photo · updater        │
│  reader-engine/   the ONLY seam onto foliate-js                    │
│  theme/       one token set → chrome AND book                      │
│  i18n/        en + ar, mirrored end to end                         │
│  lib/         ipc.ts, tts scheduler, contrast, fonts, references   │
│                                                                    │
│   ┌─ book iframe (sandbox="allow-same-origin", NO allow-scripts) ─┐│
│   │  foliate-js renders the EPUB section. Three injected sheets:  ││
│   │  geometry · paint · @font-face. Overlays draw in foliate's    ││
│   │  own closed-shadow overlayer as SVG.                          ││
│   └───────────────────────────────────────────────────────────────┘│
└──────────────────────────┬─────────────────────────────────────────┘
                           │ 61 registered IPC handlers — the ONLY boundary
                           │ commands/mod.rs  ↔  src/lib/ipc.ts
┌──────────────────────────┴─────────────────────────────────────────┐
│  Rust core (src-tauri/src)                                         │
│  commands/     the single frontend↔core surface (55 commands)      │
│  db/           SQLite: one Connection behind a Mutex + migrations  │
│  library/ books/ metadata/ fonts/ settings/ photocards/            │
│  tts.rs        Piper sidecar + Edge orchestration (5 commands)     │
│  backgrounds/  decode · EXIF · Lanczos3 · lossless PNG · GC        │
│  webview_chrome.rs · window_chrome.rs · audio_identity.rs          │
│  sync/         a FUTURE seam. Trait only, no implementation.       │
└────────────────────────────────────────────────────────────────────┘
                           │
                  %APPDATA%\com.sard.app\
                  sard.db · library\ · covers\ · fonts\ ·
                  photocards\ · backgrounds\ · voices\
```

Three ideas hold the codebase together, and they are worth internalising before reading any file:

- **One IPC seam.** `src-tauri/src/commands/mod.rs` and `src/lib/ipc.ts` are the only place the front end
  and the core meet. Everything crossing that line is typed on both sides.
- **One token set.** A theme is a set of semantic tokens. They fan out to `:root` CSS variables for the
  interface *and*, through an injected-CSS funnel, into the book's own document — which is a separate frame
  that cannot read the parent's variables.
- **One database connection.** A single `rusqlite::Connection` behind a mutex, **recovered rather than
  poisoned** on panic, so one failure cannot silently disable persistence for the rest of the session.

## 3.2 Front end

```
src/
  App.tsx              top-level: Library ⇄ Reader, theme capture/restore
  main.tsx             mount
  app/  components/    shared exports
  features/
    library/           Library.tsx, Inbox.tsx (cross-book annotations),
                       BookmarksShelf.tsx, AutoCover.tsx, Hoopoe.tsx
    reader/            Reader.tsx (1,764 lines — the orchestrator),
                       ReaderChrome, ChaptersPanel, SearchPanel,
                       AnnotationsPanel, AnnotationLayer, ReadingSettings,
                       SettingsPanel, ReferenceDialog, TagPicker,
                       ReturnPill, PageBookmark, BookmarkShape,
                       TtsPlayer / TtsMini / TtsVoicePicker /
                       TtsTrackingControls, PhotoBasketTray,
                       + stores: annotationsStore, bookmarksStore,
                         referencesStore, photoBasket, perBookSettings
    settings/          GlobalSettings.tsx (app-wide modal)
    photo/             PhotoComposer, PhotoGallery, photo.ts
    updater/           UpdateRosette (trigger + states), UpdateDialog
    onboarding/        LanguagePicker (first run)
  reader-engine/       FoliateController.ts (3,289 lines), store.ts,
                       injectedCss.ts, ttsTrack.ts, refRule.ts
  theme/               themes.ts (16 presets), tokens.ts, applyTheme.ts, store.ts
  i18n/                index.tsx + locales/en.ts, locales/ar.ts
  lib/                 ipc.ts, tts.ts, ttsScheduler.ts, updater.ts,
                       background.ts, contrast.ts, highlightInk.ts,
                       references.ts, readMarkerStyle.ts, bookmarkStyle.ts,
                       fonts.ts, format.ts, styleScope.ts, listeningOutcomes.ts
  styles/global.css    4,627 lines, the single stylesheet
  motion/              shared motion constants
```

**A structural fact every newcomer trips over: the `<Reader>` instance is reused across books.** `App.tsx`
renders one `<Reader>` with **no `key`**, so following a note or bookmark into a *different* book re-runs
`openBook` **without remounting**. This is deliberate — the Notes panel must survive the follow — and it is
why `openBook` is the **single owner of every per-book value**. Six real defects came from state that
outlived the book it described; the fix was ownership and ordering, not `key={open.id}`, which would remount
the whole tree and destroy the behaviour the reuse exists for (§6.7).

## 3.3 Back end

| Module | Responsibility |
|---|---|
| `commands/mod.rs` | 55 `#[tauri::command]` handlers. The only frontend↔core boundary. |
| `db/mod.rs` | Connection open, pragmas (`foreign_keys` on, WAL), `AppState`, `AppState::conn()` — the poison-recovering accessor. |
| `db/migrations.rs` + `migrations_sql/` | The ordered migration runner and its embedded SQL. |
| `library/`, `books/`, `metadata/` | Catalogue, import pipeline, embedded-metadata read + user overrides. |
| `fonts/` | Custom font registration and validation. |
| `settings/` | Key/value persistence. |
| `photocards.rs` | Saved photo-card PNGs + rows. |
| `backgrounds/mod.rs` (921 lines) | Copy-in, content-SHA dedup, EXIF orientation, render-ceiling derivative, mean-luma sampling, garbage collection. |
| `tts.rs` (751 lines) | Piper sidecar lifecycle, voice download, Edge synthesis, engine mutexes. |
| `webview_chrome.rs` | Strips WebView2's browser chrome and accelerators; disables DevTools in release. |
| `window_chrome.rs` | Themes the native title bar (DWM). |
| `audio_identity.rs` | Names and icons Sard's audio session in the Windows Volume Mixer. |
| `sync/mod.rs` | **A placeholder.** A future `SyncBackend` trait seam. No implementation, no behaviour. |

## 3.4 The IPC seam

**61 registered handlers** (measured at `dd23765`): 55 in `commands`, 5 in `tts`, 1 in `window_chrome`.
Grouped:

- **App / DB** — `app_info`, `db_health`
- **Settings** — `settings_get`, `settings_set`
- **Books** — `book_register`, `library_list_books`, `book_update`, `book_delete`, `book_set_cover`,
  `book_set_cover_png`, `book_revert_cover`, `import_books`, `import_folder`
- **Progress** — `progress_save`, `progress_get`
- **Shelves** — `collections_list`, `collection_create`, `collection_rename`, `collection_delete`,
  `collection_add_book`, `collection_remove_book`, `collections_for_book`
- **Annotations** — `highlights_for_book`, `highlight_create`, `highlight_delete`, `highlight_set_color`,
  `highlight_set_alpha`, `notes_for_book`, `note_create`, `note_update`, `note_delete`, `annotations_all`
- **Tags** — `tags_list`, `tag_create`, `tag_delete`, `note_tags_for`, `note_tags_set`
- **References** — `refs_for_book`, `ref_save`, `ref_delete`
- **Bookmarks** — `bookmark_create`, `bookmark_delete`, `bookmarks_for_book`, `bookmarks_all`
- **Fonts** — `font_import`, `fonts_list`, `font_remove`
- **Backgrounds** — `background_choose`, `backgrounds_list`, `background_set_surface`
- **Photo cards** — `stage_png`, `save_photo_card`, `photocard_save`, `photocards_list`, `photocard_delete`
- **TTS** — `tts_voice_present`, `tts_download_voice`, `tts_synthesize`, `tts_edge_voices`, `tts_stop`
- **Window** — `set_titlebar_theme`

Two rules govern this surface:

1. **Every heavy command must be `async`.** A synchronous command runs on the main thread and freezes the
   entire native window — input, paint, taskbar icon — until it returns. This has bitten the project twice
   and is now a hard rule.
2. **No user-supplied path may escape its intended root.** The staged-PNG commands took a caller-supplied
   path and read/copied/deleted it; they are now constrained to exactly the shape `stage_png` emits, and the
   staged temp file is cleaned up on **every** exit path including failure.

## 3.5 Data flow — three representative paths

**Opening a book.**
`Library` → `App.setOpen({id})` → `Reader.openBook(id)` → *(one `Promise.all`)* load reading style, theme
override, `chapters_read`, `seen_start`, spoiler-safe flag, TTS cursor → `FoliateController.open(source,
container, opts)` → foliate builds the view, Sard injects the three CSS sheets and runs the render-time
paragraph pass → **only then** is `onRelocate` registered → highlights and reference ranges load → the first
`relocate` fires and the reader is live.

The ordering is the design: registering `onRelocate` before the durable sets are loaded once caused every
book open to persist an *empty* set over the stored one.

**Saving reading progress.** foliate emits `relocate` → Reader debounces 500 ms → `progress_save(bookId,
cfi, fraction)`. A second writer exists: the **window-close flush**. Any rule about progress must hold at
*both* writers — a rule applied to only the first one destroyed real reading positions once (§7.10).

**Creating a highlight.** Selection in the book iframe → `SelectionInfo` (carrying a **cloned Range**
snapshotted at selection time, because the toolbar clears the live selection before handlers run) →
`highlight_create(bookId, startCfi, endCfi, color, excerpt, chapterLabel)` → row written → the controller
draws it into foliate's overlayer as SVG. Optionally a note row is attached; a note may also exist alone.

## 3.6 Database

**Location:** `%APPDATA%\com.sard.app\sard.db` (+ `-wal`, `-shm`). Always resolve it from the bundle
identifier in `src-tauri/tauri.conf.json` — **never** by globbing for `*.db`; a legacy `com.erawy.app\erawy.db`
from the pre-rename era may still exist and is orphaned. A one-time, copy-then-verify migration from the old
identity exists in `lib.rs` and never deletes the old data.

**Schema:** migrations `0001`–`0014`, **with no `0008`** (a skipped number, not a missing file).

| # | Migration | Adds |
|---|---|---|
| 0001 | `initial_schema` | `books`, `metadata_overrides`, `collections`, `book_collections`, `reading_progress`, `highlights`, `notes`, `bookmarks`, `book_index`, `settings`, `custom_fonts` + inbox indexes |
| 0002 | `bookmark_fields` | bookmark columns |
| 0003–0006 | photo cards | `photo_cards`, author, passages, quote font |
| 0007 | `book_search_fold` | the Arabic search-fold support |
| 0009 | `paragraph_spacing_default` | a default correction |
| 0010 | `note_tags` | `tags` + `note_tags` (many-to-many, shared across books) |
| 0011 | `highlight_alpha` | per-highlight ink density |
| 0012 | `references` | `refs` (phrase-bound notes) |
| 0013 | `backgrounds` | the managed-image registry |
| 0014 | `note_title` | one nullable `notes.title` |

**Invariants worth knowing:**

- **Every migration since 0001 is purely additive** — `CREATE TABLE IF NOT EXISTS`, or one nullable column.
  A migration is never edited after it ships.
- **`notes.title` is deliberately nullable, not `NOT NULL DEFAULT ''`** — the list must be able to tell
  "absent" from "empty".
- **The `refs` table has no CFI, by design.** A reference belongs to the *term*, not to a place. It keys on
  `(book_id, phrase_fold)` with a UNIQUE index, so re-referencing a phrase *edits* rather than duplicating.
  `phrase` keeps the reader's exact text (tashkīl intact); `phrase_fold` is the matching key (NFKC +
  tashkīl/tatweel stripped + alef/ya/teh-marbuta folded + lowercased — the same fold the in-book search
  uses). `word_count` exists so single-word references skip the multi-token scan.
- **`note_tags` cascades on the JOIN row in both directions**, and the `notes` table has **no** foreign key
  to `tags`. That is *why* deleting a tag can never delete a note — a property of the schema, not of cascade
  configuration.
- **Deletes cascade to zero orphans** (`D31`): FK `ON DELETE CASCADE` across every book-owned table, plus
  two non-FK tie-ins (`photo_cards.book_id`, the `book_style:<id>` settings key) plus managed files, all in
  one transaction.
- **Settings are a key/value table**, and several structured values live there as JSON blobs
  (`reading_style`, `book_style:<id>`, `bg_reading_params`, `chapters_read:<id>`, `seen_start:<id>`). That
  is what makes a new per-book style field cost **no migration** (§7.11).

## 3.7 Storage layout on disk

```
%APPDATA%\com.sard.app\
  sard.db  sard.db-wal  sard.db-shm
  library\        imported book files (COPIES — the user's source is never rewritten)
  covers\         extracted / custom covers
  fonts\          user-imported fonts
  photocards\     saved card PNGs
  backgrounds\    imported images + optional lossless derivatives
  voices\         downloaded Piper voice models
```

**A database snapshot is no longer a full snapshot of user-visible state.** Since backgrounds landed, the
app owns managed *files* outside the DB, referenced by rows. Copying `sard.db` + sidecars captures the
reference but not the bytes.

## 3.8 Bundled resources

`src-tauri/tauri.conf.json` bundles exactly one resource tree: `resources/piper → piper` (the read-aloud
engine, ~21 MB, ~249 files, including its `LICENSES/` directory). Fonts and the vendored engines ship inside
the embedded front-end `dist/`.

## 3.9 Theme system

A theme (`src/theme/themes.ts`) is a `Theme` object: an id, a display name, a `dark` flag, a `ThemeColors`
token set (`paperBg`, `surfaceBg`, `chromeBg`, `chromeBorder`, `text`, `muted`, `accent`, `selection` and
**eight highlight inks**), and an optional `highlightAlpha`.

`applyTheme.ts` fans those tokens out to `:root` CSS variables for the chrome, and the reader engine funnels
the same values into the book's document as injected CSS — necessary because the book renders in a separate
frame that cannot read the parent's variables (which is also why the token values are literal colours).

Two derived-token rules matter:

- **`--read-marker` / `--read-marker-quiet`** are computed once per theme change and are **guaranteed
  legible against the chrome ground**. `--accent` is not: measured across all 16 themes, accent versus
  `--chrome-bg` is 2.79:1 in Parchment and `--muted` is 2.83:1 in Linen, both under the 3:1 non-text floor.
  A per-theme override table was rejected as *arithmetically insufficient*, not merely unmaintainable — a
  colour composited at partial alpha lands between the two, so full strength already is the maximum
  contrast. The rule is: keep the source colour if it clears 3:1, else blend toward `--text` in 5% steps and
  stop at the first step that clears. Result: 30 of 32 cells need no blend.
- **Reader-scoped variables**, never global ones. A per-book page or background colour sets
  `--reader-page` / `--reader-bg` **inline on `.reader-root`**, each falling back to the theme token when
  unset. Overriding the global `--paper-bg` would repaint 90+ chrome consumers.

## 3.10 The reader engine

`FoliateController.ts` (3,289 lines) is the **only** code that touches foliate. It owns:

- opening a book and the per-section `load` pass;
- the **three injected stylesheets**, split by rewrite cost (`D54`):
  1. **geometry** (`buildReadingCss`) — replaced wholesale by foliate's `setStyles` on any size / font /
     leading / align / weight / spacing / flow change. An inherent reflow.
  2. **paint** (`buildDynamicCss`, `data-sard-dyn`) — ink, tashkīl, page colour. Rewritten in place, **no
     reflow**.
  3. **`@font-face`** (`buildFontFaceCss`, `data-sard-fonts`) — rewritten *only* when the font actually
     changes. While the faces lived in the geometry sheet, every alignment click re-declared them, the
     engine dropped and re-fetched the font file, and the text painted in a fallback face for ~35–45 ms and
     re-wrapped. That was the "flash / line-jump".
- the **render-time paragraph pass** — `alignNeutralLines`, `markParagraphDirection`, `markEmptyParagraphs`.
  All three work by **adding a class**, never by touching the DOM, because inserting or wrapping nodes would
  shift CFI child-step indices and break every stored bookmark, highlight, resume position and TTS range;
- highlights, reference marks, the read-aloud spotlight and the karaoke word pill — **all drawn as SVG in
  foliate's own overlayer**, not as injected CSS, so there is no cascade to fight;
- TTS unit extraction (`getChapterUnits`) — one walk of the chapter producing `{text, range}` pairs so that
  queue index *N* corresponds to range *N* **by construction**;
- navigation, selection, chapter/section identity, and the PDF adapter.

**The book iframe never gets `allow-scripts`** (`D30`) — only `allow-same-origin`. A malicious EPUB's inline
script could otherwise reach `window.parent.__TAURI_INTERNALS__.invoke(...)` and call any command; this was
verified as a live code-execution path early in the project. Sard listens to book events from the parent
context, so scripts are unnecessary. **Book content must never execute script, full stop.**

A consequence that trips up debugging: an observer or timer injected *into* the book frame never fires, so
its "nothing happened" is a false negative. Measure the book frame from outside.

## 3.11 Annotations, notes and references — the data model

- A **highlight** is a CFI range + colour + optional per-highlight alpha + a denormalised chapter label.
- A **note** may be attached to a highlight, or stand alone pinned to a locator. It has an optional
  **title**, a body, a colour and tags.
- **A tag alone keeps a note alive**, and so does **a title alone**. Deletion requires the note to be empty
  in *both* fields — otherwise reducing a note to a heading would silently destroy it. Tagging a
  body-less highlight auto-creates an **empty-body anchor note** to carry the tags; anchors are filtered out
  of the Notes list and its count, so they never render as a blank note.
- **Classification lives in exactly one place** — `annoIsNote` / `annoIsHighlight` in `lib/ipc.ts`, shared
  by the reader panel and the library Inbox. A highlight carrying a note arrives as `kind: "highlight"` with
  the body folded in, so filtering on `kind` used to file it under Highlights and hide it from Notes. The
  two surfaces can no longer disagree.
- Ordering: `highlights_for_book` and `notes_for_book` both return **newest first**, matching the
  cross-book `annotations_all`. The **overlay** is fed a chronologically ascending copy — draw order
  matters, list order does not.

## 3.12 Read-aloud architecture

```
 TtsPlayer / TtsMini (UI)
        │
   src/lib/tts.ts  ── playback, AudioContext, decode cache, karaoke clock
        │
   src/lib/ttsScheduler.ts (448 lines) ── PURE module: no Tauri, no WebAudio, no DOM
        │                                  → the invariants are unit-testable
        │  IPC: tts_synthesize(engine, voiceId, text)
        ▼
   src-tauri/src/tts.rs
        ├── Piper: one persistent `piper --json-input` process per voice (warm model)
        └── Edge:  msedge-tts over one warm WebSocket behind a mutex
```

The engine is **serialized and single-socket** by decision. Ordering work on that one queue is what makes
read-aloud smooth; parallelism was tried and reverted. The scheduler enforces five structural invariants
(`D60`): keep one sentence ahead; strict priority current > next > look-ahead; never wait behind abandoned
work; fail loudly rather than silently skipping; and keep local recurrence counters the user can read.

Word-level karaoke comes from Edge `wordBoundary` metadata; Piper has none and degrades honestly to the
sentence spotlight. The IPC body is framed `[u32 BE json_len][json words][audio]` with the audio raw — no
base64.

Read-aloud has its own governing document (`LISTENING-OUTCOMES.md`, `D73`): the product goal is that *a
listener presses Play, finishes a chapter, and forgets audio is being generated*. It names eight measurable
outcomes and deliberately names **no mechanism**, because naming one would grant it protection. Constants
are outputs of calibration, never inputs; evidence outranks prior decisions; and a proposal defended by
pointing at architecture rather than at a listener outcome is returned unread.

## 3.13 Backgrounds subsystem

Two independent surfaces (library, reading desk), one paper painter, every floor measured.

- Images are copied byte-for-byte into `<app_data>/backgrounds/`, **content-SHA deduped**, registered in the
  `backgrounds` table and served through Tauri's asset protocol (the asset scope is `$APPDATA/**`).
- **No lossy re-encode ever occurs.** A derivative is written only above the 3840 px render ceiling or to
  bake a non-identity EXIF orientation, and it is always a lossless PNG. Below the ceiling the untouched
  original renders.
- **Import and bind are one atomic Rust call** (`background_choose`) because a bare import would leave the
  row unreferenced, and the GC that runs on any surface bind would delete the image the user just chose.
- **Surface bindings are plain settings keys** (`bg_library_id` / `bg_reading_id`) so the Rust GC can find
  them without parsing frontend JSON. Zero orphans becomes a property of the schema.
- **Two ceilings, decoupled, only one about rendering.** `MAX_EDGE` = 3840 bounds *render* cost;
  `MAX_SOURCE_PIXELS` = 140 MP bounds only the one-time import transient. Because every accepted source is
  resampled to `MAX_EDGE`, the bitmap is bounded at 56.25 MiB per surface **regardless of source size** —
  measured, a 115.68 MP source and a 2.21 MP source give identical frame times.
- **The pixel guard can never become a warning**: a Rust allocation failure is `abort()`, not a catchable
  error.

## 3.14 Security posture

- **CSP** (`tauri.conf.json`): `default-src 'self'`, `script-src 'self'` — no `unsafe-inline`, no
  `unsafe-eval`. Images/fonts allow the asset protocol, `blob:` and `data:`; `media-src blob:`;
  `frame-src 'self' blob:`.
- **Book iframes never get `allow-scripts`** (§3.10).
- **Capabilities** are minimal: `core:default`, `opener:default`, `dialog:default`, `updater:default`,
  `process:allow-restart`, and three window permissions (fullscreen ×2, destroy).
- **Paths from IPC arguments are constrained** to their intended root (§3.4).
- **DevTools are disabled in release builds**, and WebView2's browser accelerators and context menu are
  stripped globally.
- **The WebView2 CDP debug port is a dev-only env-var opt-in** (`D55`). It opens only when the *launching
  process* sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>`. That string appears in
  zero shipped artifacts — verified by grepping source, `tauri.conf.json`, build and copy scripts, the
  installer template, `.env` and `.cargo` — and by launching the shipped executable clean and probing the
  port (closed) then with the variable set (open). It is kept deliberately: it is the only way to measure
  the real release build, and removing it would cost measurability for zero user-facing gain.
- **`__TAURI_INTERNALS__.invoke` is non-writable and non-configurable**, and Tauri's init script wins the
  race against CDP's `addScriptToEvaluateOnNewDocument` — so IPC cannot be hooked from outside. Live
  verification goes through the app's own `settings_get` / `progress_get` instead, which reads the real
  persistence layer.

## 3.15 Startup and lifecycle

`lib.rs::run()` in order: install the rustls provider → register `single-instance` **first** (so a second
launch is intercepted before it opens a window or attaches the WAL database) → resolve app data → the
one-time legacy `com.erawy.app` copy-then-verify migration → open SQLite, set pragmas, run migrations →
register plugins (updater, process, dialog, opener) → apply WebView2 chrome suppression → start the audio
identity worker (Windows) → register the 61 IPC handlers.

The audio identity worker is one thread, COM MTA, **blocked on an event — measured 0 ms CPU across the whole
process over 30 s idle**. It is woken only by session-created and device-change notifications.

---

# 4. Major features

Each entry gives **purpose**, **design**, **current implementation** and **technical notes**.

## 4.1 Library

**Purpose.** Hold the reader's books as objects they recognise, and make everything they have ever written
findable from one place.

**Design.** Covers first. Three views — grid, list, shelf rows. User-defined shelves in a sidebar, plus
cross-book sections: Highlights & Notes (the Inbox), Bookmarks, Photo cards.

**Implementation.** `import_books` / `import_folder` copy the file into managed app-data and register it;
the id is the **SHA-256 of the bytes**, which gives deduplication for free and a stable id across a restore.
The user's source file is never rewritten — metadata edits are `metadata_overrides` rows read as
`COALESCE(override, extracted)`. Covers are extracted at import, or generated from the title
(`AutoCover`) when the book has none. The Inbox filters by colour, book, tag and kind; the Bookmarks shelf
lists every bookmark across books with book, chapter, %-read and time, and opens each at its own locator
through the same navigation path the reader uses.

**Technical notes.**
- Import is **async** — whole-file read, SHA-256, zip and OPF parse and a whole-file write would otherwise
  freeze the window. Measured on a real 10-book / 43.79 MB library: ~150 ms warm, 309 ms cold (~290 MB/s).
- The list view renders the **real cover** (`cover_path ? <img> : <AutoCover>`), matching the grid.
- The library **reserves its scrollbar gutter**, because a list crossing the overflow threshold otherwise
  re-lays out every card.
- Deleting a book cascades every row and file, in one transaction, with a two-step confirm.

## 4.2 Reader — EPUB

**Purpose.** Get out of the way.

**Design.** One centred column of text on an opaque page; the desk in the margins; chrome that auto-hides
and returns on intent. Paginated or scrolled flow. The default flow is **scrolled with a chapter-boundary
stop**: one scroll gesture reaching the boundary stops, and a new gesture advances.

**Implementation.** foliate-js under one controller (§3.10). Reading position is an **EPUB CFI**, so it
survives font changes, resizes and re-imports. Sard forces a single column and lets it fill the sheet, so
widening the page widens the measure.

**Technical notes.**
- **Panels are pinned to fixed physical sides, language-independent** (`D21`): Contents on the physical
  left, annotations and settings on the physical right, with the top-bar button row pinned `direction: ltr`
  so a panel is always on the same side as its button in all four {EN,AR}×{LTR,RTL} combinations. This uses
  physical `left`/`right` rather than a `:root[dir]` rule, which makes the specificity trap that plagued
  earlier attempts structurally impossible.
- **Bad paragraph markup is corrected at render time by adding a class** (`D65`), RTL books only.
  (a) A `<p dir="ltr">` whose strong *Arabic letters* strictly exceed its strong Latin letters gets
  `sard-force-rtl`. "Strong" means letters — Arabic punctuation, Arabic-Indic digits and tashkīl marks are
  not strong and must not tip the count. **Ties, including empty paragraphs, are left as LTR.**
  (a2) **Direction and alignment are decided separately** and must not be merged: direction must stay LTR or
  the sentence period moves to the wrong side, but alignment must follow the *book* or the line floats to
  the opposite margin. (b) Whitespace-only paragraphs (scrape padding — measured at 55% of one book, 21% of
  another) get `sard-empty-p`, collapsing their spacing. **The node is never removed.** Known limit: a lone
  blank paragraph used deliberately as a scene break collapses too.
- **Immersive scrolling** (`D56`): when enabled, a deliberate scroll-down hides the toolbar, the read-aloud
  pill and the reading scrollbar together. It binds to a dedicated **intent** signal (`.scrolled-away`), not
  to the shared `.chrome-hidden` class, because the latter is also set by the ordinary idle auto-hide —
  which once froze the transport ~2.6 s after enabling the feature. Per-element sub-toggles are per-book.
  Several pill states are **exempt** from hiding (chapter-end prompt, Edge-unavailable prompt, the Return
  pill) because a user must be able to see and act on them.
- The reading scrollbar is hidden with `scrollbar-color: transparent` — an **inherited** property, which is
  how it crosses foliate's closed shadow boundary. `scrollbar-width` is not inherited and cannot be used
  this way.

## 4.3 Reader — PDF

**Purpose.** Open the PDFs in the user's library without pretending they are EPUBs.

**Design and scope (`D32`, "Phase 0").** View as-is: import → open → read → resume by page fraction, with
page navigation, a scrubbable position bar, copy-selection, an approximate inverted mode, and a **manual
reading-direction override** (Arabic PDFs need RTL page turns). **No** themes, typography, annotations,
Photo Mode or in-book search.

**Technical notes.** A PDF has a page index, not a CFI, so the EPUB annotation and theme machinery cannot
apply. Sard says so rather than showing controls that do nothing. Both the Notes and Bookmark affordances
are `!isPdf`-gated, which is *why* a PDF can never be a cross-book navigation target. **Accepted cost:** the
PDF view has no search at all, since Sard suppressed WebView2's find bar and has not yet built its own.

## 4.4 Typography and reading settings

**Purpose.** Let the reader set the page, per script, and have it actually take effect.

**Design.** Separate Arabic and Latin faces; size, weight, leading, tracking, paragraph spacing, first-line
indent, alignment (four options), margins, page width; diacritics show / dim / hide; flow mode. Settings
live at **two levels** (`D26`): global (app-wide, from the Library) and in-book (this book, while reading).
The in-book drawer is **five tabs grouped by concept** — Typography · Layout · Colour · Read-aloud · All
books — where **a tab is a scope signal** (`D57`).

**Implementation.** `ReadingStyle` is a JSON blob in `settings`. Scope is a user toggle (`D28`/`D43`):
*unified* (one shared style, the default) or *per-book*. Per-book writes a **partial override** under
`book_style:<id>`; the effective style is `{...global, ...override}`. A field absent from an override defers
to unified for free. "Reset to app default" deletes the row.

**Technical notes.**
- **A control whose minimum emits no rule is a broken control.** `if (spacing > 0)` hands the value back to
  the cascade at the minimum, so the slider reaches zero and nothing moves. Every reading control emits at
  every value including 0.
- **Every typography control is specificity-hardened**, not just the ones that visibly broke.
- **A forced `!important` override flattens the book's intent**, so blocks the book deliberately centres
  (or aligns to the edge opposite the reading direction) are tagged and spared. In an RTL book,
  `text-align: right` is the *start* edge, not a flourish.
- Text scaling is CSS `zoom` on the section content, not `:root` — `:root` scaling clips text at column line
  ends, and zoom preserves the book's own typographic hierarchy.
- The **UI font is fully separate from the book font** (`D33`), sharing no variable; and UI scale is
  chrome-only, ramping 1.0 (≤1100 px) → 1.4× (≥2560 px) so fullscreen is not tiny.

## 4.5 Themes

**Purpose.** Sixteen genuinely different papers, each internally consistent.

**Design.** Ivory, Sepia, Slate, True-Black, Sage, Rose Quartz, Parchment, Dusk, Ink, Espresso, Forest
Night, Mulberry, Charcoal, Nocturne, Linen, and **Moonlit Sky** — a gold-on-night theme with its own
crescent, stars and cloud decoration layer. Each carries **eight highlight inks tuned to that paper**, so a
highlight lightens dark paper instead of blotting it.

**Implementation.** §3.9. Themes apply app-wide, or per-book. **The Library has its own theme**, independent
of the book theme (`D29`) — choosing a theme while reading must not change the Library, so the library theme
is captured on entry and restored on exit.

**Technical notes.** Moonlit Sky is a **skin applied on top of existing components, never a redesign**
(`D39`): every component keeps its exact markup and layout; Moonlit only sets token values and adds
decorations behind and around them. A per-book custom background colour, or a user wallpaper, replaces those
decorations so the result reads as intentional. A contrast guard warns (never blocks) when a custom text
colour is too faint for the chosen paper.

## 4.6 Highlights

**Purpose.** Mark a passage in one gesture.

**Design.** Eight inks per theme, plus a per-highlight **ink density**. Rendered as **word-shaped strokes**
rather than a rectangle.

**Implementation.** SVG in foliate's overlayer, driven by one shared resolver, `resolveHighlightInk()`.

**Technical notes.** That resolver **takes no opacity input and must not gain one.** A spec once prescribed
scaling the mark's opacity to compensate for translucent paper; measured in the real engine the premise was
false — glyphs are painted opaque, so a multiply blend works fully exactly where readability lives. The
compensation was deleted and the resolver never touched, which is what keeps the 128-cell byte-identity gate
and the Notes-preview parity true by construction.

## 4.7 Notes

**Purpose.** Somewhere quiet to write.

**Design.** A note carries a title, a body, an ink colour, an ink density and tags. It opens in a **compact
centred dialog** — the passage above, the text below, nothing competing — with a margin panel for colour,
density and tags.

**Implementation.** §3.11. Reachable from the in-book Notes panel and from the Library's cross-book Inbox.
The in-book panel has a **source filter** (`D53`): this book (default) / a specific book / all books.

**Technical notes.** Cross-book rows are **read-only by design** — editing needs that book's store, and only
the open book has one — and they say so on a hint line rather than showing controls that do nothing.
Following a cross-book row opens that book at that locator through the same path the Library uses, and
resets the filter to "this book", because the label would otherwise lie.

## 4.8 Tags

**Purpose.** One vocabulary across a whole library.

**Design.** Tags are **global and unique by name**, many-to-many with notes, built by the user inline.

**Implementation.** Migration 0010 (§3.6). The picker is a chip cloud plus one add-field. The Inbox has a
tag-filter dropdown.

**Technical notes.** The filter's options come from the **tags table**, not from the tags found on currently
loaded notes — deriving them from loaded data hid a valid tag with zero current links, which is exactly the
state after delete-and-recreate. Selecting a tag with no linked notes lands on the ordinary empty state, not
an error.

## 4.9 References

**Purpose.** A note bound to a *term* — a character's name, a recurring image, a piece of terminology —
rather than to a place.

**Design.** Select a word or phrase → Add reference → write the note. That phrase is then marked **wherever
it occurs in that book**, including in text you have not read yet. The mark is a **twin rule**: two thin
strokes with rounded terminals beneath the word, at a colour, thickness and distance you control; the
default colour is the theme's accent, so changing paper moves the mark exactly as it moves a highlight.

**Implementation.** Migration 0012 + `src/reader-engine/refRule.ts`. The mark is drawn as **SVG in foliate's
overlayer**, and **one shared geometry resolver** serves both the on-page drawing and the settings panel's
live preview, so the two cannot drift. Repaints are pure overlayer redraws — no CSS re-inject, no reflow.

**Technical notes.** The design moved *off* the CSS Custom Highlight API because it is not expressible
there: that API's styleable set is text-only, so it offers no rounded caps, no second stroke and no
controllable gap. Section ranges are pruned to the rendered set and cleared on dispose — a `Range` keeps its
text nodes, ancestors and owning `Document` alive, and foliate destroys a section's document on
navigate-away, so an unpruned map pins a detached document per matched section.

## 4.10 Bookmarks

**Purpose.** Mark a place to come back to.

**Design.** One bookmark per chapter, toggled from the reader. A visible on-page marker (with a
user-selectable shape) plus a cross-book Bookmarks shelf in the Library.

**Implementation.** The marker is a **per-chapter** mark keyed on **CFI section identity** (`D59`) — it
shows anywhere in the bookmark's chapter and hides when the reader leaves it.

**Technical notes.** It was originally keyed on a whole-book `fraction` window, which lit the marker in
every chapter of a long book. An intermediate design keyed on the *visible range* was rejected by the owner
because the marker vanished mid-chapter on scroll and the button could add a second bookmark while the first
was off-screen. The stored `fraction` is retained untouched for the shelf's %-read readout.

## 4.11 Search

**Purpose.** Find a phrase without being told how the book ends.

**Design.** In-book search, diacritic-insensitive and case-insensitive, reporting progress while it scans
rather than blocking on a long book. **Spoiler-safe**: matches up to the current position are shown in full;
everything ahead is sealed behind a count — *"3 matches ahead are hidden"* — and revealed only on request.

**Implementation.** The Arabic fold is a SQLite scalar function (`afold`, enabled by `rusqlite`'s
`functions` feature) plus the same fold in TypeScript, shared with references. Landing on a hit is corrected
at scroll time (`D63`): after foliate top-aligns it, a measured `scrollByDelta` nudge centres it vertically.
The persistent layout inset is never touched, because toggling it is exactly the ~70 px jump an earlier fix
removed. **Paged flow is an accepted limit** — a hit lands on its page, and centring inside a fixed page is
meaningless.

**Technical notes.** Search once broke the reader's whole overlay: the callback passed to suppress the
engine's per-match outline was `() => {}`, which returns `undefined`, and foliate appends whatever `draw`
returns. Every hit poisoned a map entry, and any later redraw threw at the first one and **aborted the
loop** — silently leaving highlights, reference marks and the read-aloud spotlight with stale geometry. It
now returns a real but empty `<g>`.

## 4.12 Photo cards

**Purpose.** Turn a passage into something shareable.

**Design (`D40`).** Two orthogonal axes: **style** (minimal / moonlit / gilded / manuscript / editorial) ×
**paper** (any of the 16 themes), in four formats. The card always keeps its format's aspect ratio and the
quotation **auto-fits** — a binary search for the largest font that fills it — with XS–XL acting as a cap on
that fit rather than growing the canvas. Cards can be saved in the app and re-shared later.

**Implementation.** `html-to-image` in the front end; `stage_png` / `save_photo_card` / `photocard_save` in
the core, with the staged temp file constrained and always cleaned up.

**Known limit.** The chosen style and text size are **not persisted** on "Save in app" — editing a saved
card reopens it at `minimal` + `auto`. The exported PNG is always correct; only the re-editable state is
lost.

## 4.13 Read aloud

**Purpose.** Listen to a chapter and forget that audio is being produced.

**Design.** Two engines chosen per book. A transport that collapses in two steps — a full pill, a compact
row, then a **kashida**: a tapered calligraphic stroke in the bottom margin whose fill is your progress and
whose bead is play/pause. Sentence spotlight on the page, plus word tracking inside it with Edge. Chapter
ends **offer to continue** rather than simply stopping.

**Implementation.** §3.12.

**Technical notes — the rules that were paid for:**
- **The engine never changes without an explicit user action.** A sustained Edge failure pauses in an
  explicit *"Edge unavailable — Retry / Switch to Piper"* state, rendered in **every** pill state including
  the minimised kashida.
- **Retry is a ladder, and the waiting is visible** (`D68`): one dispatch plus up to three retries with
  backoff 500 / 1500 / 4500 ms (measured live at 509 / 1526 / 4482 ms). The previous single immediate retry
  was built on the premise that a cold reconnect *is* the delay — false whenever the connection is
  *refused*, which returns in milliseconds and burned ~4 attempts inside ~200 ms.
- **Empty or truncated Edge audio is transient, not a hard stop** (`D69`) — a throttled endpoint returns
  short audio with no error, so it feeds the retry ladder and reaches the explicit pause only on exhaustion.
  Detection is kept; text is never silently skipped.
- **A spoken unit is capped at 250 characters and subdivided at safe punctuation, never mid-clause**
  (`D61`). `Intl.Segmenter` breaks on «.»/«؟»/«!» but not on «…» or the Arabic comma «،», so an Arabic
  clause-chain became one huge unit; a measured 318-character unit failed Edge synthesis 100%. The value 250
  comes from **749,438 measured units across 5 books** (median ~58, p90 ~114, p99 147–207) — above every
  well-formed p99 and below the failing case. **Known limit:** ~180 residual units remain where a long run
  has no interior break punctuation.
- **Buffering is measured in seconds of audio, not sentences** (`D71`), target 15 s, one request at a time.
  The same fixed 3-unit window buys 16.5 s of cover on Arabic and 6.5 s on English — a 2.5× spread in one
  library.
- **Playback still blocks on the first sentence before starting**, deliberately. "Fast start" was
  investigated and **closed as not required**: it would reclaim p50 0.38–0.40 s of a ~1.7 s startup, and
  under it sentence 2's only cover is sentence 1's own duration, which on English at 1.25× does not fit a
  p95 synth. The gate is a deliberate trade, not overhead.
- **Speeds are an explicit ordered set**, not a uniform grid, so 1.10× exists instead of being rounded away
  to 1.00. Both `setSpeed` and the settings restore path snap through `nearestSpeed`.
- **Skipping while paused resumes playback** — this reads as an invalid transition and is deliberate
  (`D72`). The user asked for a different sentence.
- The karaoke animation loop **parks** rather than spinning at ~60 Hz while paused or at chapter end.

## 4.14 Voice selection

The picker lists **every Edge language**, grouped into sections headed by the language's own name
(endonym), ordered Multilingual → العربية → English → all others alphabetically by endonym, with dialects
grouped inside their language. An earlier backend `ar-`/`en-` filter was removed because it silently made
Sard an Arabic/English-only reader, contradicting the general-reader positioning.

**A known, recorded limit:** voice memory is per **direction**, not per language. The reader derives the key
as `isRtlBook ? "ar" : "en"`, so there are exactly two slots. A French voice chosen for a French book saves
under the LTR slot and then narrates every LTR book. Real per-language memory needs a trustworthy language
key, and `books.language` is not it — Arabic books routinely mis-declare themselves as `en`, which is why
script detection exists at all. It is a separate task, not a type widening.

## 4.15 Background images

**Purpose.** Make the app feel like the user's, without making it unreadable.

**Design (`D74`).** Two independent surfaces — behind the Library, and around the reading desk. Per-surface
controls: image · **Presence** · Blur · Flip (physical, never mirrored) · Focal point · Reset, plus **page
opacity** on the reading surface, plus one app-wide "Show backgrounds" master that hides everything while
keeping the configuration. Progressive disclosure: one row until an image exists.

**Presence is deliberately a single control** — separate darkness/brightness/opacity dimmers compose
multiplicatively and cannot be modelled by a user.

**Implementation.** §3.13.

**Technical notes — the floors are measured, not chosen:**
- Library scrim **0.77** = the least scrim at which `--text` clears **WCAG AA 4.5:1** over any image across
  all 16 themes (Slate binds at 0.767). AAA there would need 0.930 — 7% of the photo visible.
- Reading desk scrim **0.62** is a **design** floor, not a safety one: the desk carries no bare text, and
  its thinnest chrome (the kashida bead at 90%) clears 6.20:1 with the scrim at **zero**.
- Page opacity floor **0.84** = body text clears **AAA 7:1** over any image, on all 16 themes.
- Consequently the reading Presence slider travels to **260** while the **library stays capped at 100** —
  measured asymmetry, not taste. The clamp is per-surface but **the divisor stays 100**, because dividing by
  a per-surface maximum would rescale the curve and silently change what every stored value means. Proven:
  202/202 values across 0–100 on both surfaces are bit-identical to the old function, and before/after
  binaries at Presence 0/50/100 differ by **0 of 792,000 pixels**.
- **Exactly one surface paints the paper.** Measured, the paper was being painted three times — the page
  sheet, the book document, and foliate's own filter layer — composing to 1−0.16³, so page opacity appeared
  to work and did nothing over the text.
- **Accessibility:** `forced-colors`, `prefers-contrast: more` and `prefers-reduced-transparency` suppress
  the feature rather than softening it; the configuration is retained.
- **A wallpaper beats a per-book background colour** — a deliberate reversal of the original precedence
  (§7.3).

## 4.16 Window and input ownership

Sard owns its keyboard and pointer surface (`D47`). WebView2's find bar (Ctrl+F/F3), print navigation
(Ctrl+P — which made Sard *disappear* into `edge://print/`), reload (Ctrl+R/F5), caret browsing (F7) and the
raw right-click menu are all suppressed natively through `ICoreWebView2Settings`. Suppression does not stop
keys reaching the page — every Sard shortcut still fires; only Chromium's own handling is removed. A DEBUG
build keeps DevTools, the context menu and the accelerators; release ships none of it.

A JS keydown handler is explicitly **not** an acceptable substitute: it is bypassable, since a focused
browser widget swallows the event.

## 4.17 Internationalisation and RTL

Two locales, English and Arabic, kept key-for-key at parity (~640 entries each), through a ~80-line custom
React context with flat keys and `{var}` interpolation. The interface mirrors completely — sidebar, shelves,
panels, controls — with logical properties (`inset-inline-*`) everywhere the interface mirrors, and physical
sides only where a side is deliberately pinned (§4.2). Numerals render Arabic-Indic in an Arabic interface.

Two hard rules learned here: **match `e.code`, never `e.key`**, for any Latin letter or punctuation shortcut
— on an Arabic layout the F key yields «ب», so a `key === "f"` shortcut can never fire for an Arabic typist;
and a **localised numeral next to a Latin unit needs a separator**, because Arabic-Indic zero (U+0660) is a
dot-shaped glyph that fuses with an adjacent "px" at small sizes.

## 4.18 Accessibility

Delivered so far: every interactive control has an accessible name, **measured against the computed
accessibility tree** rather than inferred from attributes (unnamed interactive controls 5 → 0 across three
surfaces). Sliders inherit their section heading through context rather than a prop, so a slider added later
cannot ship unnamed by omission. Closed side panels carry `inert`, removing them from both the tab order and
the a11y tree at once (Tab stops landing inside `aria-hidden` subtrees: 67/160 → 0/160). Contrast floors are
computed per theme (§3.9, §4.15). Keyboard activation never releases focus, so Tab users keep their
`:focus-visible` ring.

`ReaderChrome` is **deliberately excluded** from `inert`: tabbing into the auto-hidden toolbar is a keyboard
user's only route to it, and marking it inert would delete that affordance outright.

## 4.19 Update system

See §8.4 for the full flow. From **v1.1.0** the app updates itself: the rosette in the Library's corner
checks GitHub Releases, shows the new version and its release notes, and asks before doing anything.
Accepting downloads the installer, verifies its minisign signature against the public key compiled into the
app, installs it and restarts.

---

# 5. Design philosophy

## 5.1 The page on a desk

The reading surface is an opaque **page** with the **desk** visible around it. Everything follows:

- The page has a paper colour (per theme, or per book); the desk has its own colour or the user's image.
- Widening the page widens the *measure*, because Sard forces a single column that fills the sheet.
- Chrome is not part of the page. It arrives on intent and recedes.
- Page opacity is a property of the paper, and **exactly one surface may paint it** — three overlapping
  painters is why an earlier attempt "worked" on the margin and did nothing over the text.

## 5.2 The interface should get out of the way

Auto-hiding chrome, immersive scrolling, a transport that collapses to a single stroke in the margin. The
constraint attached to all of it: **hiding a container hides every state it can render.** Before hiding
anything, enumerate what it can show and ask which of those states the user *must* see. Those get
exemptions, derived from the same state the container uses so they are transient by construction.

## 5.3 Typography

Per-script faces, because Arabic and Latin have different needs in the same book. Every control emits at
every value including its minimum. Every control is specificity-hardened. The book's deliberate typographic
intent — a centred poem, a title page, a scene break — is tagged and spared from the user's body alignment.
Font faces live in their own stylesheet so that changing the line height does not make the text flash in a
fallback face.

## 5.4 RTL support as a first-class direction

Not a mirroring pass at the end. Layout is built in two directions; panels pin to physical sides so a
button and its panel never separate; the media transport deliberately does **not** mirror, because ⏮/⏭
represent time and the YouTube/Spotify convention is what a user's hands already know. Beware the **double
mirror** that cancels visually but not behaviourally — a flex row inheriting `dir="rtl"` swaps the buttons'
physical sides *and* a `scaleX(-1)` flips the glyphs, so the arrows look standard while their actions are
inverted.

## 5.5 Theme philosophy

A theme is a **complete token set**, not a colour swap. It drives the chrome and the book. It carries its
own eight highlight inks, tuned so a highlight lightens dark paper rather than blotting it. The Library
keeps its own theme, because choosing a book's look should not repaint the shelf. Every colour in the
codebase resolves to a token; literal colours appear only where something is genuinely a *paint* — a
generated book jacket, a highlight ink, a danger red.

Adding a seventeenth theme is adding a preset. Nothing else changes — including the derived legibility
tokens, which are computed on theme change and are therefore correct on arrival for a theme that does not
exist yet.

## 5.6 Simplicity — and what it costs to keep

- **No duplicated controls.** A control rendered in two places is a correctness bug waiting to happen. (But
  prove the copies share state before deleting one.)
- **When a UI needs a header that contradicts another header, the structure is wrong.** Fix the structure,
  not the copy. Three global flags sitting inside a per-book drawer got their own tab, and the clarifying
  header was deleted.
- **One scope vocabulary**, composed from a single pair of keys, so a reader learns the phrase once.
- **One inert-reason line.** A control that is greyed, or that cannot affect the current book, states *why*
  on a muted line beneath it. No "N/A" chips — they say what, never why. And a control that still works but
  has nothing to affect keeps working and explains itself.
- **Progressive disclosure**, because five tabs was measured as this drawer's practical ceiling.

## 5.7 A premium experience means the failures are designed too

- Nothing is silently swapped, skipped or degraded. A failure that matters becomes a visible, actionable
  state — in every UI state the user can be in.
- **A notice that is not rendered in a common UI state is not a notice; it is a silent failure.**
- Errors are classified and each class gets its own sentence in both locales. The build that said "couldn't
  check" for six different causes — including "no feed is configured at all" — is exactly why nobody could
  tell a network problem from a dead feature.
- **A control that cannot be seen while it is being set is a defect even when it works.** The immersive-blur
  toggle functioned correctly and still read as dead, because opening the drawer that contains it cancels
  the state its effect renders in. The panel now previews the effect on hover/focus.

---

# 6. Development history

251 commits, 2026-06-28 → 2026-08-03. Work is organised as numbered `[RAWY-NN]` tickets (sequential, never
reused), roughly RAWY-01 through RAWY-290. What follows are the phases, not the commits.

## 6.1 Foundation — late June 2026

The first five commits set the whole shape in a day: an app skeleton, then the **Rust core foundation
(SQLite, migrations, and the IPC seam)**, then the **reading-engine layer** (open and paginate an EPUB with
RTL and persisted progress), then typography controls with per-script fonts and a diacritics toggle. The
fifth commit renamed the project **eRawy → Sard** across identifiers, app id, crate and fonts. The old
identity survives in exactly two places: the repository directory name (`M:\eRawy`) and the one-time
app-data migration.

## 6.2 Library, themes and annotations — early July 2026 (→ `v0.1-milestone`, `v0.2-pre-tts`)

The Library, shelves, import with SHA dedup, cover extraction, the 16-theme token system, the eight-ink
highlight palette, notes and bookmarks, the cross-book Inbox, and Photo Mode. This is where the "one token
set" architecture was established.

## 6.3 Read-aloud, first generation — 2026-07-04 → 07-08 (→ `v0.3-tts`)

Piper as a bundled sidecar with on-demand voice models; Edge neural voices; the sentence spotlight and the
word karaoke pill; the voice picker. Web Speech was evaluated and dropped for having zero Arabic voices.

## 6.4 Moonlit Sky and visual depth — 2026-07-08 → 07-11 (→ `v0.4-moonlit`, `v0.5-tts-polish`)

The 16th theme and its decorative layer, applied strictly as a skin on top of existing components. Alongside
it, the first serious read-aloud repairs.

## 6.5 The long middle — mid-July → early August 2026 (99 commits to `v1.0.0`)

The densest phase of the project. Roughly in order:

- **Read-aloud stabilisation.** A parallel Edge synthesis pool was built (RAWY-191) and **reverted within a
  day** (RAWY-192) as a correctness regression. The silent Edge→Piper fallback was removed (RAWY-193). Then
  the scheduler was rebuilt around ordering rather than buffering (RAWY-231), the timeout semantics were
  found to be measuring queue wait rather than synthesis (RAWY-257), and finally the whole area was put
  under an outcomes-based governing document (RAWY-263).
- **Input and window ownership.** WebView2's browser chrome and accelerators were suppressed (RAWY-196),
  which also revealed that Ctrl+F could never have fired on an Arabic keyboard layout.
- **The annotation system matured.** Custom note tags (RAWY-203/204/205), the in-book Notes source filter
  and cross-book open (RAWY-206), per-highlight ink density and the compact note editor (RAWY-259),
  word-shaped highlight strokes (RAWY-258).
- **Reading position semantics.** The reading anchor: a jump freezes the reading position and offers a
  Return pill, and only reading thaws it (RAWY-250); chapter read indicators derived from that same
  completion signal (RAWY-256).
- **Settings reorganisation.** Five tabs grouped by concept, where a tab is a scope signal (RAWY-216/217).
- **Immersive mode**, in five tickets (RAWY-210 → 214), most of them fixing the consequences of hiding a
  container that can render must-see states.
- **References** (RAWY-260) — the phrase-bound note and its twin-rule mark.
- **Backgrounds** (RAWY-265, then 278–280) — the largest single subsystem added in this phase.
- **The pre-release audit and hardening** (RAWY-272 → 289): a poisoned-mutex recovery that had been
  silently disabling all persistence after any panic; import moved off the main thread; a detached-DOM leak
  in reference ranges; constrained IPC paths; cross-book state ownership in the Reader; chapter numbering
  derived from EPUB semantics; accessibility naming and `inert`; and the search/overlayer invariant.
- **Windows audio identity** (RAWY-270/270A) — the Volume Mixer showed Sard's read-aloud as "Microsoft Edge
  WebView2".

## 6.6 Release preparation and v1.0.0 — 2026-08-03

Three things had to be true before a public release, and none of them were code:

1. **GPL compliance.** Sard bundles a prebuilt eSpeak NG, which is GPL-3.0-or-later, and the binaries were
   shipping with no licence text and no source offer. `src-tauri/resources/piper/LICENSES/` now carries the
   verbatim GPL-3.0 (a link does not satisfy §4) alongside the MIT texts, and a written source offer naming
   **eSpeak NG 1.52.0** — the version string read out of `espeak-ng.dll` itself, because §6 wants the source
   corresponding to *this* binary.
2. **`NOTICE` rewritten** with full attribution: engines, the read-aloud stack with pinned versions, all
   eight OFL fonts, and the framework tree.
3. **`README` rewritten from scratch** for a reader who has never heard of Sard.

Then `v1.0.0`: the version moved 0.5.1 → 1.0.0 across `package.json`, `tauri.conf.json` and `Cargo.toml`
(and `package-lock.json`, which had been left at 0.1.0 since scaffolding).

## 6.7 The updater and the release pipeline — v1.1.0, 2026-08-03

Four commits, in one deliberate order: replace the custom updater with the official plugin → rebuild the
updater UI → add the CI pipeline → tag the release. Then one follow-up when the first pipeline run exposed
that release notes were a fixed string. Finally, the screenshot gallery — with the images moved to
`docs/screenshots/` rather than `public/`, because Vite copies `public/` into `dist/` and Tauri embeds
`dist/` in the binary: measured, `dist` went 14 MB → 38 MB with them in `public/`, and back to 14 MB after
the move.

---

# 7. Major technical decisions

## 7.1 Why AGPL-3.0

Two reasons, and the project is explicit that both are real.

**The constraint.** Sard bundles eSpeak NG, which is GPL-3.0-or-later. Distributing that binary means the
work it is conveyed with must be under a GPL-compatible licence and must add no restrictions of its own.
AGPL-3.0 satisfies both — GPL-3.0 §13 and AGPL-3.0 §13 expressly permit the combination.

**The choice (`D3`/`D3a`).** foliate-js is MIT and PDF.js is Apache-2.0, both permissive, so Sard *could*
legally be relicensed or closed later. AGPL is a strategic pick: a fork cannot be closed and sold on, while
anyone stays free to use the program for any purpose, including commercially. A non-commercial licence was
ruled out both because GPL-3.0 §10 forbids adding it on top of eSpeak NG and because it would not be open
source.

The moat is taste, Arabic depth and the brand — not hidden source. The name **Sard / سَرْد** and the hoopoe
mark are excluded from the AGPL: use them to refer to this project, not to brand a fork.

**Recorded future-watch (`FW1`):** AGPL-3.0 is widely held incompatible with App Store distribution terms.
Not a desktop problem, but it **must** be revisited before any iOS or mobile release. Relicensing is legally
possible because the engines are permissive.

## 7.2 Why the custom updater was replaced

The original updater (`D42`) was a hand-rolled check-and-notify: it fetched a JSON blob over `ureq`, compared
versions itself, and could only open a browser. It **could not download, could not verify a signature and
could not install** — and it was **inert in every shipped build**, because its manifest URL was a
compile-time empty string, a placeholder left while the repository was private. It shipped a "once-daily
update check" that was a permanent no-op, and reported "couldn't check" for six distinct causes including
"no feed is configured".

It was **deleted outright** — `updater.rs`, the `check_for_update` command and its registration — and
replaced with `tauri-plugin-updater` plus `tauri-plugin-process`, configured declaratively. There is now
exactly one update system in Sard, and it is not one this project maintains.

The front end was rebuilt to match: the rosette keeps its shape and four visual states but says only the one
thing that needs no decision ("You're using the latest version"); everything else opens a dialog wearing the
note editor's surface rather than a system box. Settings → About became a second **trigger** rather than a
second implementation, because the old row kept its own copy of the outcome and the two entry points could
disagree. `download()` and `install()` are kept separate rather than using `downloadAndInstall()`, so there
is a real moment between "verified bytes on disk" and "the installer runs" — the only point a cancel can be
honoured.

## 7.3 Why the wallpaper now beats a per-book background colour

The original precedence (`D50`) gave the colour priority as "the more specific, deliberate choice". In use
that read as a **broken feature**: a reader who had ever set a colour picked a wallpaper, saw nothing
change, and concluded wallpapers do not work — with no affordance anywhere saying which had won. Choosing a
wallpaper is the later and equally deliberate act, so it takes the surface.

**The fix is a deletion, with zero new state.** The suppression rule was removed outright, and a second rule
a CSS grep would have missed had to be re-scoped: the Moonlit decoration rule's specificity (0,4,1)
outranked the image rule's (0,3,1) and hid the wallpaper by a second path on that theme alone. The colour is
not discarded — it stays in `reading_style.backgroundColor` and becomes the **scrim's tint** while a
wallpaper is active. Remove the wallpaper and the gate attribute disappears, no rule matches, and the desk
falls back to its own background: **the colour returns by itself**, with no restore step and no second
source of truth.

## 7.4 Why screenshots were moved out of `public/`

Vite copies `public/` verbatim into `dist/`, and Tauri embeds `dist/` into the binary. Screenshots left
there ship **inside the installer**, for images the app never opens. Measured: `dist` 14 MB → 38 MB with
them in `public/`, back to 14 MB after moving them to `docs/screenshots/`.

Two of them had already been swept into the v1.1.0 release commit by a `git add -A` and are therefore inside
the **published v1.1.0 installer** — 5.03 MB of the 5.51 MB that release grew over v1.0.0. Nothing is broken
by it and no user data is affected; it simply makes that download bigger than it needs to be, and the next
release will not carry it. *(Recorded here because it is a real property of a shipped artifact.)*

## 7.5 Why the silent read-aloud fallback was removed

The per-sentence Edge→Piper fallback was designed to be non-destructive and auto-recovering, and it still
**swapped the narrating voice mid-paragraph**. The owner experienced it as "the voice suddenly became
Piper". It did flash a pill subtitle, but that notice auto-cleared in 5 seconds, was not actionable, and was
**not rendered at all in the minimised kashida** — a normal listening state — so the swap read as silent.

It was removed. The rule that replaced it is structural: no auto-fallback path remains, so the engine cannot
change without an explicit user press.

## 7.6 Why the database connection recovers from a poisoned mutex

`std::sync::Mutex` poisons **permanently** on the first panic under the guard, and the release profile
unwinds. All 50 lock sites did `state.db.lock().map_err(err)?`, so after one panic
`progress_save` / `settings_set` / `highlight_create` / everything returned `Err` forever — swallowed by
`.catch(console.error)` into a release build with DevTools off. **An app that looks normal and has stopped
saving anything.**

Measured on the unfixed code first: after one panic the command pattern fails 6/6 and never recovers, while
the same connection still answers `SELECT 1` and `PRAGMA integrity_check` = ok — which is what makes
recovering *correct*, because the failure is the mutex, not SQLite. `AppState::conn()` now recovers it.

## 7.7 Why import keeps a batch-wide lock (a change that was rejected by measurement)

An audit proposed a per-file lock so import would not hold the database mutex across a whole batch. It was
**measured and refuted**: with a contender doing a small write every 2 ms, the worst wait over three runs was
285/142/129 ms batch versus 73/139/116 ms per-file — improved in one run of three, nothing in the other two.
The cause is that **Windows `std::sync::Mutex` is an unfair SRWLOCK**: the loop releases and re-acquires
within microseconds, so a waiter never wins the handover. A change with no measured benefit was rejected.

The commands were still made `async`, because a sync command runs on the main thread and freezes the window
— that part *was* supported by measurement.

This is the clearest example of the project's standing rule that an architecture can be right in the
abstract and wrong on the machine.

## 7.8 Why the Windows audio identity work was accepted, and where it stops

The Volume Mixer showed Sard's read-aloud as "Microsoft Edge WebView2". Sard's own identity was already
correct at every layer it controls. The root cause: **Sard produces no audio at all** — read-aloud is Web
Audio, so the WASAPI session is opened by Chromium's audio service, a grandchild process. Its display name
and icon path are both empty, so Windows falls back to the *owning process's* executable, which is
Microsoft's.

Ownership **cannot be moved** — proven three ways, including that `sard.exe` loads the WebView2 COM client
proxy and neither `AUDIOSES.DLL` nor `MMDevApi.dll`, so it structurally cannot be the process that calls
`IAudioClient::Initialize`. What shipped is metadata only: a worker that names and icons the session,
selecting sessions **only by descent from our own process id**, never by executable name.

**A carried limit, stated plainly:** setting the name and icon does not change the session *identifier*, so
per-app volume and mute are still shared with every other WebView2 app of the same runtime version.

## 7.9 Why the project stopped adding features

On **2026-08-01** the owner established a permanent **Engineering Contract**. Sard left feature development
and entered **stabilisation and production hardening**. Its core clauses:

- Reliability over features; predictability over cleverness; consistency over optimisation.
- **100% of current user-visible behaviour is preserved** unless changing it is the explicit request.
- No feature removals, no UX or visual redesign, no architectural rewrites, no speculative optimisations, no
  "cleanup" commits, no code motion for style.
- **A measurable problem must exist**, its root cause must be identified, and the fix must be measured
  before → after — including CPU, memory, GPU, startup, navigation latency where relevant.
- **A performance budget**: CPU, memory, GPU, startup, navigation latency, bundle size, binary size, IPC
  traffic, listeners, timers, observers and background activity may not grow without measured benefit.
- **Honesty rules**: measured fact, confirmed behaviour, inference, hypothesis and unknown must be
  distinguished; when runtime validation is not possible the status is exactly *"Implemented — Verification
  Pending"*, never a verification claim.
- A **29-item Final Acceptance Checklist** gates completion of every ticket.

It is not retroactive: previous tickets remain complete unless explicitly reopened.

## 7.10 Architectures accepted and rejected — a summary table

| Question | Decision | Reason |
|---|---|---|
| Reader remount per book (`key={open.id}`)? | **Rejected** | Structurally fixes state leakage but remounts the whole tree, closing the Notes panel and discarding the deliberate cross-book snap-back. The reuse is the design; the missing *ownership* was the defect. |
| Parallel Edge synthesis pool | **Reverted** | Correctness regressions on a single-socket engine. Ordering, not parallelism, was the fix. |
| Per-file import lock | **Rejected** | Refuted by measurement (§7.7). |
| `highlight_tags` table for tagging a body-less highlight | **Rejected** | An empty-body anchor note needs no schema change and touches no existing rows. |
| Per-theme override table for the read-marker colour | **Rejected** | Arithmetically insufficient, not merely unmaintainable — these are token ceilings. |
| A second "overlay strength" slider | **Rejected** | The control already existed as Presence; it merely stopped at the measured floor. A second slider would be duplicated state. |
| Fast read-aloud start | **Closed as not required** | Measured gain 0.38–0.40 s of a 1.7 s startup; structurally cannot protect sentence 2 on a single-flight engine. |
| True cancellation of an in-flight Edge synth | **Declined** | Would require touching the socket lifecycle; single-flight bounds the residual to one synth instead. |
| CI / GitHub Actions | **Reversed** | Originally forbidden (`D8`, no Actions budget). Reversed with explicit approval for RAWY-290, which is now the only supported release path. |

## 7.11 The rule that keeps schema churn near zero

**To make a new setting per-book, add a field to `ReadingStyle` — do not invent a settings key.** The scope
stack is field-agnostic: `update()` routes to the global row or the per-book override; `effectiveStyle` is a
spread, so a field absent from an override defers to unified for free; and because both stores are JSON
blobs, a new field costs **no migration**. Choosing a default that reproduces prior behaviour byte-for-byte
is then the whole migration story. Conversely, an app-wide flag belongs in the theme store as its own key,
not in `ReadingStyle`.

---

# 8. Release process

## 8.1 Versioning

`MAJOR.MINOR.PATCH`, bumped in **three kept-identical sites** plus the lockfile:

- `package.json` (and `package-lock.json`)
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml` (→ `Cargo.lock`)

Because the updater compares the running version against the published manifest, **a moving version is a
hard prerequisite**, not bookkeeping. The v1.0.0 → v1.1.0 bump was a **minor**, deliberately: it added a
user-facing feature and drew a clean line — 1.0.0 has no updater and cannot update itself.

Tags are `v*`. The current tags are `v0.1-milestone`, `v0.2-pre-tts`, `v0.3-tts`, `v0.4-moonlit`,
`v0.5-tts-polish`, `v1.0.0`, `v1.1.0`. The first five are checkpoints; the last two are releases.

## 8.2 Cutting a release

```sh
# 1. bump the version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
# 2. commit
# 3. tag — ANNOTATED, because the annotation body becomes the release notes
git tag -a v1.2.0
git push origin v1.2.0
```

That is the whole procedure. **Releases are built by GitHub Actions, not by hand.**

A **manual dispatch** (Actions → Release → Run workflow) builds a **draft** release instead, so the pipeline
can be exercised without publishing anything.

## 8.3 The workflow — `.github/workflows/release.yml`

Triggered on `push: tags: v*` and on `workflow_dispatch`. Runs on `windows-latest` (Windows-only for now:
Sard ships a Windows-first build, and the MSI bundle can only be produced on Windows; when macOS and Linux
land this becomes a matrix and `tauri-action` merges the per-platform entries into one `latest.json`).

Steps: checkout → Node 20 with npm cache → stable Rust → **cargo cache** (`swatinem/rust-cache`, because the
Rust build dominates the run) → `npm ci` → **read release notes from the annotated tag** → `tauri-action`.

**Release notes come from the tag's annotation.** They land in two places that matter: the GitHub release
page and the `notes` field of `latest.json` — which is the text the in-app update dialog shows the reader.
Writing them at `git tag -a` time is what keeps those two in step without anyone editing a manifest. A tag
with no annotation falls back to one honest sentence rather than an empty box. *(This was fixed after the
first pipeline run, where `releaseBody` was a literal string and every release would have described itself
identically.)*

`tauri-action` inputs worth knowing:

| Input | Value | Why |
|---|---|---|
| `tagName` | the pushed tag, else `v__VERSION__` | |
| `releaseName` | `Sard v__VERSION__` | |
| `releaseBody` | the tag annotation | see above |
| `releaseDraft` | true when **not** a tag push | manual runs publish nothing |
| `prerelease` | false | |
| **`updaterJsonPreferNsis`** | **true** | **The load-bearing input.** It defaults to `false` "for legacy reasons", and Sard bundles both NSIS and MSI — so the default would quietly make the **MSI** the update payload. |

## 8.4 Signing, `latest.json`, and the updater

**Signing.** The updater refuses to install anything whose **minisign** signature does not match the public
key compiled into the app (`plugins.updater.pubkey` in `tauri.conf.json`). `createUpdaterArtifacts: true`
makes the bundler emit the `.sig` files. The private half lives in exactly two places and **must not** enter
the repository: the owner's offline backup, and two GitHub Actions secrets —
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

> ⚠ **If that key is lost, no existing install can ever be updated again.** It cannot be regenerated — only
> replaced, and replacing it strands everyone already running Sard on the version they have.

Without those variables a local `tauri build` still produces installers but **no `.sig` files**, and a
release without signatures is one the updater will refuse.

**`latest.json`.** Generated by the workflow and uploaded as a release asset. The app's configured endpoint
is:

```
https://github.com/Limitless-Soul1/Sard/releases/latest/download/latest.json
```

GitHub resolves `/latest/` to whatever the newest non-prerelease release is, so **publishing a release *is*
the deployment**. No manifest is edited by hand after the fact — which matters, because a manifest that has
to be updated manually on every release is one that eventually is not, leaving users told they are current
when they are not.

**NSIS is the update payload, deliberately.** The bundler emits both an NSIS `-setup.exe` and a WiX `.msi`.
The NSIS path is the tested one: the updater runs it with `/UPDATE`, which installs per-user **without an
elevation prompt** and restarts the app itself. `msiexec` on a per-user install is a rougher road. The MSI
remains a release asset for anyone who wants it; it is simply not what the updater downloads. `installMode`
is `passive` — a progress bar and no clicks, which is right when the app has already asked for consent.

**The in-app flow.** Rosette (or Settings → About) → `check()` → typed state. If newer: a dialog showing the
current version beside the new one, the release notes, and the question. On accept: `download()` with a
progress bar and a byte readout → then `install()` as a separate beat → the NSIS installer runs and restarts
Sard. Errors are classified — offline, server, signature, download, install — and each has its own sentence
in both locales.

## 8.5 What an update does not touch

The NSIS uninstaller **can** delete `%APPDATA%\com.sard.app`, but only when **both** a checkbox on the
uninstall confirmation page is ticked **and** `/UPDATE` was not passed. An update always passes `/UPDATE`, so
that branch is unreachable during one. The library, database, notes, highlights, references, bookmarks,
photo cards, backgrounds, settings and downloaded voices survive **by construction, not by convention** —
the installer replaces only the program files under `%LOCALAPPDATA%`.

## 8.6 Artifacts of a release

| Artifact | Role |
|---|---|
| `Sard_<ver>_x64-setup.exe` | NSIS installer — the usual download **and** the update payload |
| `Sard_<ver>_x64_en-US.msi` | MSI, for deployment tooling. Not the update payload |
| `*.sig` | minisign signatures for the updater artifacts |
| `latest.json` | the update manifest; its `notes` field is the tag annotation |

## 8.7 The legacy tester-bundle path (historical)

Before the CI pipeline, builds for external testers were assembled by hand into a share folder — a full
(not `--no-bundle`) `tauri build`, rotate the previous set into a dated archive, copy and rename the
installer and standalone executable plus the `piper\` engine, write a README and a BUILD-INFO with artifact
hashes, and pack a `.rar` from a staging directory. **There is no script for this**, and the procedure is
retained in the private vault only as history. **The supported path is now the tag-driven workflow.**

---

# 9. Current project status

*As of 2026-08-04, describing `main` @ `dd23765`.*

## 9.1 Repository state

- `main` is **clean and fully pushed** — local `HEAD` == `origin/main`, working tree clean.
- `v1.0.0` and `v1.1.0` are annotated tags present on the remote.
- **v1.1.0 is published**, built and signed by the pipeline.

## 9.2 What is finished and shipping

EPUB reading (paginated and scrolled, RTL and LTR, CFI resume) · PDF view-as-is with manual RTL · library
import with SHA dedup, shelves, three views, search and filter, cover extraction and generation ·
per-script typography at two scopes · 16 themes including Moonlit Sky with its decorations · highlights in
eight per-theme inks with per-highlight density · notes with titles and tags · **references** and the SVG
twin-rule mark · bookmarks with a per-chapter marker and a cross-book shelf · the cross-book annotation
Inbox · diacritic-insensitive, spoiler-safe in-book search · chapter read indicators and the reading anchor
with its Return pill · immersive scrolling with per-element sub-toggles · read-aloud on Piper and Edge with
sentence spotlight, Edge word karaoke, per-book resume, the kashida transport, chapter-end continue and an
explicit speed set · user background images on two surfaces with measured legibility floors · photo cards ·
full EN/AR interface, mirrored end to end · the in-app updater · Windows audio-session identity.

## 9.3 Build health

Last full measurement (2026-08-03, immediately pre-release):

| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `cargo clippy --all-targets` | **13 warnings** — all pre-existing doc-formatting / `contains()` style; none in changed code |
| `cargo test` | **36/36** (27 lib + 9 integration); re-confirmed 36/36 after the updater swap |
| `tauri build` (release) | exit 0 |
| Bundle | JS **596.00 kB** (gz 181.44) · CSS **170.28 kB** |
| Binary | `Sard.exe` **24,264,192 bytes** |

*(The bundle and binary figures predate the updater swap and the screenshot move; they are the last
recorded full measurement, not a claim about `dd23765`.)*

## 9.4 What is stable, and what has been verified how

- **Stable and verified live on the real release build:** the reader lifecycle and cross-book state
  ownership (44/44 checks, against the real database, snapshotted and restored byte-identically); the
  backgrounds immersive behaviour (driven over CDP against the real binary, with pixel diffs); the
  accessibility pass (measured against the computed a11y tree); the search/overlayer fix (ten scenario
  classes, zero uncaught exceptions where alignment alone previously threw 11 of 12).
- **Stable, verified by test and build only:** the Rust hardening tickets (poison recovery, async import,
  constrained staged paths) — each proven to build and pass its own tests in an isolated worktree at
  pristine HEAD, with command signatures byte-identical before and after.
- **Shipped but not yet exercised in the field:** the update pipeline has run and published; the *in-app
  update path from an installed v1.1.0 to a future v1.2.0* has not yet been exercised end-to-end by a real
  user, because there is no v1.2.0. This is the single most valuable thing to verify on the next release.

## 9.5 Known limitations

**Product**

- **Windows only.** No macOS or Linux build exists.
- **The installers are not code-signed**, so Windows SmartScreen warns on first run.
- **v1.0.0 cannot update itself** — its users must install v1.1.0 by hand once.
- **PDF has no in-book search at all** (the browser find bar was suppressed and Sard's own search is
  EPUB-only). This is recorded as urgent debt.
- **PDF is read-only**: no themes, typography, annotations or Photo Mode.
- **Read-aloud voice memory is per direction, not per language** (§4.14).
- **Photo card style and text size are not persisted** on "Save in app" (§4.12).
- **~180 read-aloud units across the measured library exceed the 250-character cap** because they contain no
  interior break punctuation; such a unit may still fail Edge synthesis.
- **A deliberate blank paragraph used as a scene break collapses** along with scrape padding.
- **Per-app volume is shared with other WebView2 apps** of the same runtime version (§7.8).
- **Two screenshots are inside the published v1.1.0 installer** (~5 MB of avoidable download) (§7.4).

**Engineering / observability**

- The read-aloud failure classifier has **never fired in the field**; the first real failure is its first
  real test.
- The 8 s / 9 s synthesis timeouts remain **provisional** pending a measured slow-synth distribution on a
  real network.
- **Orphaned `settings` rows survive book deletion** — `pdf_invert:<bookid>` keys were observed for books no
  longer in `books`. The cascade does not cover the key/value table. *(Carried, not yet fixed.)*

## 9.6 The pre-release audit — what it covered and what it did not

A comprehensive investigation-first audit ran through the end of July and early August. It produced
RAWY-272 through RAWY-289.

**Covered:** build and toolchain; the Reader lifecycle and cross-book state; PDF cross-book reachability
(found safe by construction); the database locking and poisoning surface; the import path; the reference
range lifecycle; the staged-PNG IPC paths; Contents chapter numbering; the accessibility tree; the
search/overlayer invariant.

**Not fully covered — the honest remainder:** Library internals · FoliateController in depth · TTS internals
· the full Rust command surface · long-session memory, listener, timer and observer behaviour · rendering
and animation · startup/shutdown paths · systematic error handling, edge cases and race conditions · IPC
efficiency.

**Deliberately left unchanged — do not "fix" these:**

- The `<Reader>` has no `key`. The reuse is the design.
- The update rosette's two infinite idle animations (~229 rAF/s at rest in the Library) — reported, and left
  by owner instruction as intentional design.
- Read-aloud's blocking start gate.
- The serialized, single-socket TTS engine.
- Import's batch-wide database guard.
- `MAX_EDGE` = 3840 — 2.67× below the measured render cliff, and it must not creep toward it.
- The Library Presence cap of 100 — an AA contrast floor, not a taste choice.
- `resolveHighlightInk()` and its lack of an opacity input.

---

# 10. Future roadmap

Everything in this section is a **plan or an open question**, not work in progress. Nothing here is
implemented.

## 10.1 The published roadmap (README)

1. **Code-signed installers**, so Windows stops warning on first run. *(This replaced "in-app update" on the
   roadmap when the updater shipped, and is the thing that would most improve first-run today.)*
2. **macOS and Linux builds.**
3. **A wider EPUB conformance pass** — footnotes, media overlays, complex fixed-layout.
4. **Deeper PDF support** — annotation on the page, text reflow where the document allows it.
5. **Import and export of annotations** in an open format.
6. **Dictionary and translation lookup** on selection.
7. **Accessibility** — completing full screen-reader labelling and a keyboard path to every action.

## 10.2 Arabic differentiators still on the target list

Recorded under the four-pillar positioning: kashida-aware justification (ship a good v1), tashkīl
show/hide/dim refinement, a **built-in Arabic dictionary** (long-press → definition, root, morphology), and
a curated Arabic typeface library with per-script fallback. The owner's **own Arabic TTS pipeline** (`D4`)
is a planned future differentiator, distinct from the shipped Piper/Edge engines — and the instruction is
explicit: **do not shape current architecture around it yet.**

## 10.3 Mobile — the state of the record

**No mobile research programme exists, and no mobile work has been done.** This is stated plainly rather
than filled in. What the record actually contains is exactly two items:

- **`FW1`, a future-watch entry:** AGPL-3.0 is widely held incompatible with App Store distribution terms.
  Not a desktop problem today, but it **must** be revisited before any iOS or mobile release. Relicensing is
  legally possible because every engine dependency is permissive (MIT / Apache-2.0) — with the significant
  exception that the bundled eSpeak NG is GPL-3.0, which is precisely what forced AGPL in the first place,
  so a mobile relicensing route would have to address the read-aloud stack.
- **The README roadmap's "macOS and Linux builds"** — desktop platforms, not mobile.

The Rust core has a `mobile_entry_point` attribute (Tauri's standard scaffolding) and the release workflow
carries a note about becoming a matrix when other platforms land. Neither is evidence of a mobile plan.
**Anyone picking this up should treat mobile as unresearched.**

## 10.4 User feedback collection — the state of the record

There is **no telemetry and no in-app feedback channel**, by design. Feedback has so far been collected in
one way: **the owner's own extended usage**, written up as Arabic notes and then logged as a **tracked
backlog** in the private vault (`FEEDBACK-BACKLOG.md`, logged 2026-07-23, covering three days of real use).
That backlog was mapped onto a dedicated ticket block (RAWY-227–238), prioritised — three items marked
catastrophic — and worked through; the three catastrophic items (read-aloud resume restarting the chapter,
wrong next-chapter after manual navigation, and a bookmark marker that followed the reader into every
chapter) are all closed.

The public channels that now exist are **GitHub issues and pull requests**, invited by the README with two
requests: *say what you measured*, and *preserve behaviour unless the change is the behaviour*. Bug reports
are asked to include the book that triggered them where possible.

**A structured programme for collecting feedback from users other than the owner does not exist yet.** If
one is wanted, it is a genuinely new piece of work, and it will have to be designed against the no-telemetry
constraint.

## 10.5 Deferred by explicit decision (not forgotten, not scheduled)

| Item | Status |
|---|---|
| Note-tag UI reach — the Notes side panel and standalone margin notes do not expose the tag picker | Backend already supports both; a UI-wiring job |
| Tag renaming and a tag-management screen (list / merge / count) | Deferred; the real answer if the global tag count grows |
| Bookmark excerpts in the Library shelf | The `label` column is never populated on creation; the shelf would show it for free |
| Multiple named custom themes; a library-scope custom theme | Natural extensions of the per-book colour work; no groundwork owed |
| PDF → EPUB conversion, OCR, PDF annotations | Deferred; a PDF has a page index, not a CFI |
| Photo card re-editable state | See §4.12 |
| Moonlit Sky's frosted/glass overlay pass on panels | Deferred after the decorations phase |
| Per-book backgrounds, light/dark image pairs, cover-derived backgrounds, image-replacement crossfade, settings export | Deferred within the backgrounds design |
| The disabled "Reading now" sidebar item | A stub since the Library was built |

---

# 11. Repository structure

```
M:\eRawy\                      (repo root; the directory name predates the rename to Sard)
│
├── README.md                  the public front door — overview, features, screenshots,
│                              architecture, build, roadmap, licence
├── BUILD.md                   how to build; the release procedure; the signing key
├── NOTICE                     full third-party attribution + why AGPL
├── LICENSE                    AGPL-3.0 full text
├── PROJECT_MASTER_SUMMARY.md  ← this document
│
├── package.json               front-end deps + the five npm scripts
├── tsconfig.json              TypeScript config (noUnusedLocals is on)
├── vite.config.ts             Vite config (dev server on :1420)
├── index.html                 the single HTML entry
├── build-test.bat             double-clickable wrapper over `npm run build:test`
│
├── .github/workflows/
│   └── release.yml            THE release pipeline (§8.3)
│
├── docs/
│   └── screenshots/           the 13 official screenshots. NOT in public/ — see §7.4
│
├── scripts/
│   ├── build-test.mjs         the everyday build (cargo check, kill Sard, --no-bundle, copy)
│   ├── kill-sard.mjs          closes sard.exe / Sard.exe / Sard-standalone.exe
│   └── copy-release.mjs       copies the built exe + piper\ into test-build\
│
├── public/                    copied VERBATIM into dist/ and embedded in the binary.
│   ├── foliate-js/            the VENDORED EPUB engine (pinned commit; VENDOR.txt records
│   │                          every local modification — re-apply on any re-vendor)
│   │   └── vendor/pdfjs/      PDF.js, inside foliate's tree
│   ├── fonts/                 the eight bundled OFL families + their licences
│   ├── moonlit/               the Moonlit Sky decoration assets
│   ├── assets/                app assets
│   └── cfi-bridge.js          the CFI helper loaded into the page
│
├── src/                       the React front end (see §3.2 for the full map)
│   ├── App.tsx  main.tsx
│   ├── features/              library · reader · settings · photo · updater · onboarding
│   ├── reader-engine/         the ONLY code that touches foliate-js
│   ├── theme/                 16 presets, tokens, applyTheme
│   ├── i18n/                  en + ar
│   ├── lib/                   ipc.ts (the typed seam) + shared logic
│   ├── styles/global.css      the single stylesheet
│   └── motion/                shared motion constants
│
├── src-tauri/                 the Rust core
│   ├── Cargo.toml             deps, each with a comment saying WHY it is there
│   ├── tauri.conf.json        product name, version, identifier, CSP, updater, bundle
│   ├── capabilities/          the minimal permission set
│   ├── icons/                 app icons + the hoopoe mark
│   ├── resources/piper/       the bundled read-aloud engine + LICENSES/
│   └── src/                   see §3.3 for the module map
│       └── db/migrations_sql/ 0001–0014, additive, never edited after shipping
│
├── dist/                      build output (gitignored)
└── test-build/                `build:test` output (gitignored)
```

**Conventions worth knowing before a first patch** (from the README, and enforced in review):

- Every colour resolves to a theme token. Literal colours appear only where something is genuinely a
  *paint*.
- Logical properties (`inset-inline-*`) wherever the interface mirrors; physical sides only where a side is
  deliberately pinned.
- Database changes are **additive migrations**, numbered, never edited after they ship.
- **Comments explain *why*, not *what*.** If a line looks strange, the reason it is not the obvious
  alternative belongs beside it. This codebase's comments are unusually dense for exactly this reason and
  they are load-bearing documentation — do not strip them.

---

# 12. Lessons learned

These are the project's hard-won rules. Each one cost a real defect or a wasted cycle. They are recorded in
full in the private vault's `LESSONS.md`; what follows is the distilled set, organised for a newcomer.

## 12.1 Architectural lessons

1. **Ownership must be explicit when a component is reused rather than remounted.** Reusing the reader
   across books is correct — and it made every per-book value a leak waiting to happen. One function owns
   all of it, resets all of it, and loads all of it before anything can emit a position.
2. **Ordering is part of the contract.** A handler registered before its state is loaded will happily
   persist an empty set over a full one. Load first, subscribe second.
3. **Count the painters before you add an alpha.** A layer that looks single may not be. Three surfaces
   painting the same paper compose to opacity, so a translucency feature "worked" everywhere except where it
   mattered.
4. **A dimension that lives in both CSS and JS is one change away from silent desync.** Grep the number
   before touching it, and verify the *painted* result rather than the source.
5. **A global CSS variable with many consumers cannot be overridden for one surface.** Scope a dedicated
   variable that falls back to the global one — the untouched default then stays byte-identical for free.
6. **Bind behaviour to intent, not to a convenient existing state class.** Enumerate every way a class gets
   set before reusing it. This is doubly true when the behaviour includes `pointer-events: none`, because an
   unintended trigger does not merely look wrong — it makes a control dead.
7. **Hiding a container hides every state it can render.** Enumerate them; exempt the ones the user must see
   and act on; derive the exemption from the same state the container uses so it is transient by
   construction.
8. **On a serialized engine, the fix for a stall is ordering, not more buffering.** Deepening a prefetch
   window piles more abandoned work on the one queue.
9. **Keep the invariant-bearing logic pure.** The TTS scheduler has no Tauri, no WebAudio and no DOM, which
   is what makes its guarantees testable with injected latency instead of being a timing accident.
10. **A preloaded subtree must keep its React key and its slot**, or committing it destroys the very thing
    you preloaded. Preloading is half the pattern; identity across the commit is the other half.
11. **`visibility: hidden`, never `display: none`,** when an off-screen subtree must load and be measured.
12. **Prefer an inherited property to reach into a closed shadow root.** A selector cannot cross the
    boundary; inheritance does. (`scrollbar-color` is inherited; `scrollbar-width` is not.)

## 12.2 UX lessons

1. **A notice not rendered in a common UI state is not a notice — it is a silent failure.**
2. **A control that cannot be seen while it is being set is a defect even when it works.** If a setting's
   effect lives in a transient state that opening the panel cancels, the panel must preview it.
3. **Empty initial state on a screen that re-mounts is a visible claim, and usually a false one.** "I have
   not looked yet" is a different claim from "there is nothing here" — gate the message on a query having
   actually answered.
4. **On a surface with a user background, an empty container is not a pause — it is a hole.** When a
   background feature lands, every "temporarily empty" state in that surface becomes a visual defect. Go and
   find them.
5. **A fix for a flash must not become a freeze.** Bound every wait, tolerate failure, and report the
   latency you introduced alongside the artifact you removed.
6. **When a UI needs a header that contradicts another header, the structure is wrong.** Fix the structure.
7. **Build the owner's stated scope, not a "more precise" one you inferred.** The looser, literal reading of
   a request is often the correct one; confirm before adding precision nobody asked for.
8. **A reported defect may be correct behaviour.** A confident bug report is a hypothesis, not a verdict —
   one report of "broken spacing" was correct Arabic morphology, and "fixing" it would have corrupted valid
   Arabic across every book.
9. **Media transport controls are not mirrored in RTL.** They represent time, not reading direction. Watch
   for the double mirror that cancels visually but not behaviourally.
10. **A duplicated control is a correctness bug waiting to happen** — but prove the copies share state
    before deleting one.

## 12.3 Engineering-process lessons

1. **Investigate before you edit, and report the root cause before touching code.** Two of this project's
   longest detours were plausible guesses that measurement later destroyed.
2. **Measure, never guess, on any freeze / slow / heavy / stall symptom** — and revert the probe before
   committing.
3. **Reproduce the reported bug on the pre-fix build before believing the diagnosis**, even a diagnosis
   handed to you as "already measured". Cost: one build.
4. **A harness must be proven to FAIL on the unfixed build before its pass means anything.** Several "verified
   live" claims in this project's history were green over a broken feature.
5. **A harness that sets up state to reach the interesting part often sets the bug out of existence.** When
   a feature has an optional field, the branch where it is *omitted* is the primary test.
6. **Drive the user's actual gesture, through the real trigger path.** If you catch yourself scripting
   `element.style =` or `setState` just to make something visible, you are testing your harness.
7. **`element.click()` proves nothing.** It bypasses layout, hit-testing and z-order, and it does not move
   focus — so it structurally cannot reveal focus or keyboard bugs.
8. **A CSS replica cannot verify a perceptual claim.** Three rounds of "16/16 verified" against a faithful
   transcription of the stylesheet were all correct about the CSS and all missed the bug, because the bug was
   that the gated half was the invisible half.
9. **Always assert that a control actually took effect before trusting a measurement of it.** Three
   instrument defects were caught in a single session: `getComputedStyle` on a pseudo-element returning a
   stale value without a forced reflow; a positive control that silently failed to install and therefore
   proved nothing; and an A/B that drove only one of two gated variables, producing a false "on" arm.
10. **An A/B whose arms run in a different order measures the order.** Alternate it, n≥5, before you believe
    it — and before you write any code on it.
11. **A measurement that cannot fail is not evidence.** Assertions must refuse to report on a contaminated
    region rather than summarising it.
12. **An observed result is not a measured figure.** Record which, and name the exact engine and path
    exercised. Absence of a symptom is evidence, not a measurement.
13. **Never draft results before the test has run.**
14. **A concurrency or performance fix validated only on a fast network or machine is not validated.** Inject
    adversity.
15. **A live test on the owner's own profile is structurally blind to the unset-default and first-run paths.**
16. **Exported-but-never-called code is not a safeguard.** Grep for the call site before trusting a fallback.
17. **Before assuming a feature needs backend work, grep for what is already built and unused.** One
    "build a bookmarks feature" ticket turned out to be a frontend view over a finished, unwired command.
18. **A fix scoped to one selector is not a fix for the symptom class.** Enumerate the class, prove coverage,
    apply one mechanism at a level that covers it.
19. **When an investigation enumerates call sites or writers, the specification must carry that enumeration
    by name.** Three live test rounds in one ticket were spent on specification gaps, not code defects.
20. **A diagnostic must be proven reachable in the release build when it is built, not when it is first
    needed.** An instrument is part of the feature, not a note about it.
21. **Never let a probe write the owner's real database, and never defer the restore.** Snapshot db + `-wal`
    + `-shm`, record the hash, restore in the same session, verify field by field.
22. **Never query a live SQLite database from a lone `.db` copy** — in WAL mode the recent writes are in the
    `-wal`. A missing WAL once produced a confident "zero rows" against data the owner had watched being
    written.
23. **A migration that touches real data is tested on a copy first**, with the invariant proven by hashing
    the untouched tables — not by eyeballing.
24. **Close the running executable before building, and prove the build rewrote it.** Report both timestamps.
    A tester once reported a defect against a binary nine minutes older than its fix.
25. **A session handover must state whether the tree compiles.** "Mid-edit" and "broken" are different states.
26. **Never round-trip a UTF-8 file through PowerShell 5.1 `Get-Content`/`Set-Content`** — it silently
    mangles Arabic and adds a BOM.
27. **Never leave a junction inside a git worktree when running `git worktree remove`** — it deletes
    *through* the reparse point and destroyed a real `node_modules` once.
28. **A commit can be isolated from surrounding WIP with a clean-HEAD worktree** — and the isolated
    configuration must be *built*, not assumed.
29. **`e.key` is layout-dependent; match `e.code`.** A shortcut can look correct in review and be dead in the
    hands of anyone using a non-Latin layout.
30. **A raw `HRESULT` is not a `Result`, and `S_FALSE` is a success code.** `is_ok()` on a three-state API is
    a silent no-op waiting to ship.
31. **A code path fed curated data can break the moment it is fed raw data.** Removing a filter also removes
    the implicit validation it was providing.
32. **When the owner's real data contradicts your prediction, the data is right.** Read it before concluding.
33. **A measurement or scoping question must not offer a count** — the number steers the answer. Ask how many
    distinct roots the evidence yields.
34. **Splitting a problem by topic can be as costly as joining unrelated things by topic.** A symptom filed
    as "a UX/error-message issue" turned out to be a direct measurement of the audio pipeline it had been
    filed away from.

---

# Appendix A — the engineering vault and the ticket workflow

## A.1 The vault

Sard's deep engineering record lives **outside the repository**, in a private Obsidian vault at
`M:\ProjectDocs\sard\`. It is deliberately off-repo (`D7`) because it holds strategy and decision reasoning,
not shippable material. Its layered structure exists to keep context loading cheap:

| File | Layer | Purpose |
|---|---|---|
| `STATE.md` | **hot** | Read first for any task. Current state, recent tickets, one line each. Target ~4 KB. |
| `ENGINEERING-CONTRACT.md` | warm | The standing development policy (§7.9). Read before starting any task. |
| `DECISIONS.md` | warm | Active decisions `D1`…`D74` + `FW1`, decision and why. Superseded ones are retired to the archive. |
| `LESSONS.md` | warm | The hard-won rules of §12, each with the scar that taught it. |
| `OPEN.md` | warm | Pending items, known defects, deferred work, roadmap pillars. |
| `SHARE-RELEASE.md` | warm | The handoff + the legacy tester-bundle procedure. |
| `LISTENING-OUTCOMES.md` | warm | The Layer-1 governing document for read-aloud (`D73`). |
| `LISTENING-BASELINE.md` | warm | The read-aloud evidence log — the numbers the outcomes document refuses to hold. |
| `TTS-ROADMAP.md` | warm | The read-aloud repair record; closed, superseded as governing authority. |
| `SETTINGS-INVENTORY.md` | warm | Every in-book setting: label EN+AR, control, default, scope, dependencies, location. |
| `FEEDBACK-BACKLOG.md` | warm | The owner's usage feedback as a tracked backlog. |
| `HISTORY.md` | cold | Full task narratives, RAWY-192 onward. Grep a named slice; never read whole. |
| `archive/PROJECT.md` | cold | 1.6 MB deep record, RAWY-01…191. **Do not read whole** — grep by name only. |

⚠ Vault files are UTF-8, LF, no BOM, and contain Arabic. **Never round-trip them through PowerShell 5.1.**

## A.2 The ticket workflow

Numbered `[RAWY-NN]`, sequential, **never reused**.

**STEP 1 — INVESTIGATE** (read-only; report the measured root cause *before* any edit) →
**STEP 2 — FIX / BUILD** (on step 1's measured root, never on an assumption) →
**INVARIANTS** (zero silent removal) →
**STEP 3 — VERIFY** (live, measured, on the real build; the owner is the final judge) →
**HONEST LIMIT** (state exactly what was not verified and why) →
**COMMIT** (one logical package, independently buildable and testable, tagged `[RAWY-NN]`) →
**PUSH** → **update `STATE.md` + `HISTORY.md`.**

Two standing rules on commits: **zero AI or tool attribution anywhere** (`D9`) — no `Co-authored-by`, no
"generated with", in code, docs or commit messages — and **stage explicitly by path**, never sweeping the
owner's untracked work into a commit.

---

# Appendix B — known documentation debt

Recorded so the next reader is not misled. None of these are code defects.

1. **`STATE.md` (vault) is stale.** Last refreshed 2026-08-03 during the audit. It states version `0.5.1`,
   describes RAWY-285 as uncommitted, and lists two open P0 blockers (missing GPL licence text; an empty
   updater manifest URL). **Both P0s are closed** — by `a5691ce` and `c9db3b2` respectively — and everything
   it describes as uncommitted is committed and pushed. Its "four different currents" table is entirely
   historical.
2. **`SHARE-RELEASE.md` (vault) §1.6–1.8 is stale** for the same reason, including "Status: NOT READY to cut
   a bundle".
3. **`DECISIONS.md` `D8` — "No CI / no GitHub Actions"** — has been **reversed** with explicit approval. The
   repository has `.github/workflows/release.yml`, and it is now the only supported release path. `D8` should
   be rewritten or retired.
4. **`DECISIONS.md` `D42` — the once-daily check + quiet badge updater** — describes the **deleted**
   implementation. The shipped updater is `tauri-plugin-updater` (§7.2, §8.4).
5. **The IPC command count is quoted as "52" in the README and the vault.** Measured at `dd23765` the
   registered handler count is **61** (55 `commands` + 5 TTS + 1 window chrome). The figure drifts with every
   ticket; prefer counting the `generate_handler!` list over quoting a number.
6. **`README.md`'s Installation section names `Sard_1.0.0_*` filenames** while the current release is 1.1.0.
7. **`src-tauri/Cargo.toml`'s `description`** still reads *"a beautiful, Arabic-first ebook reader"*, which
   predates the `D44` positioning change (Arabic is first-class, not the identity).
8. **`sync/mod.rs` is an empty seam** — a placeholder trait module with no implementation. It is not a
   feature and should not be read as one.
9. **The repository directory is `M:\eRawy`** and the GitHub repository is `Sard`. The directory name
   predates the rename and is intentionally left alone.

---

# Appendix C — quick facts table

| | |
|---|---|
| **Name** | Sard · سَرْد ("narration") |
| **Version** | 1.1.0 (tag `v1.1.0`, published 2026-08-03) |
| **Bundle identifier** | `com.sard.app` |
| **Crate** | `sard` / `sard_lib` |
| **Repository** | `M:\eRawy` → github.com/Limitless-Soul1/Sard |
| **Licence** | AGPL-3.0-only (name and hoopoe mark excluded) |
| **Platform** | Windows 10/11 x64; WebView2 runtime required |
| **First commit** | 2026-06-28 (as "eRawy"; renamed to Sard the same day) |
| **Commits** | 251 |
| **Formats** | EPUB (reflowable), PDF (view-as-is) |
| **Database** | `%APPDATA%\com.sard.app\sard.db`, SQLite/WAL, migrations 0001–0014 (no 0008) |
| **IPC handlers** | 61 registered (55 commands + 5 TTS + 1 window) |
| **Themes** | 16, each with 8 highlight inks |
| **Locales** | English, Arabic (~640 keys each, at parity) |
| **Front end** | 23,354 lines TS/TSX + 4,627 lines CSS |
| **Rust core** | 6,071 lines across 20 modules |
| **Bundle** | JS ~596 kB (gz ~181 kB), CSS ~170 kB *(measured 2026-08-03)* |
| **Read-aloud** | Piper (bundled sidecar, offline) + Microsoft Edge (network); serialized, single-socket |
| **Support** | creators.sa/lll9we |

---

*End of document. Update this file at the next major milestone — not per ticket.*
