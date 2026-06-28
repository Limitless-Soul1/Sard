# Sard · سَرْد

A beautiful, smooth, lightweight **ebook reader** — Windows-first, with first-class
Arabic/RTL typography. The name **سَرْد** means *"narration / storytelling."* Priority
order: **beauty › smooth › lightweight.** *(Formerly "eRawy".)*

> **Status:** early. The app launches, opens an EPUB (paginated, RTL, scrollbar-free),
> persists reading progress, and offers full typography controls (size, per-script fonts,
> spacing, margins, alignment, diacritics). See [`PROJECT.md`](./PROJECT.md) for the full
> project state, decisions, and roadmap.

## Stack

- **Tauri 2** (Rust core) + **React + TypeScript** frontend (Vite)
- **foliate-js** (MIT) for EPUB rendering — vendored in `public/foliate-js/`
- **PDF.js** (Apache-2.0) for PDF — *later*
- **SQLite** for the library/annotations — *later*
- Bundled OFL fonts: Amiri, Noto Naskh Arabic (Arabic), Literata (Latin)

## Prerequisites

- [Node.js](https://nodejs.org) + npm
- [Rust](https://rustup.rs) (stable, MSVC toolchain on Windows)
- WebView2 runtime (preinstalled on Windows 10/11)

## Develop

```sh
npm install
npm run tauri dev      # launches the desktop app with hot-reload
```

## Build

```sh
npm run tauri build    # produces a release binary + installers (MSI/NSIS on Windows)
```

## Project layout (see PROJECT.md §5 for detail)

```
src/                 React frontend (features/, reader-engine/, theme/, motion/, …)
src-tauri/           Rust core (commands/ IPC seam, db/, library/, books/, …)
public/foliate-js/   vendored MIT EPUB engine (pinned)
public/fonts/        bundled OFL fonts (+ license files)
docs/                architecture notes + preserved spike evidence
PROJECT.md           living source of truth (read this first)
```

## License

**AGPL-3.0** (by choice) — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for
third-party attributions (foliate-js MIT, PDF.js Apache-2.0, fonts OFL).
