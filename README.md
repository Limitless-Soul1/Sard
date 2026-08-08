<p align="center">
  <img src="src-tauri/icons/Sard-.png" alt="Sard" width="320">
</p>

<h1 align="center">Sard · سَرْد</h1>

<p align="center">
  A desktop ebook reader built around one idea — <em>a page resting on a desk</em>, and nothing between you and it.
</p>

<p align="center">
  <a href="#license"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-9C5A3C"></a>
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-2C3A42">
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-core-CE422B">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB">
</p>

---

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#key-features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#text-to-speech">Read-aloud</a> ·
  <a href="#build">Build</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#support-the-project">Support</a>
</p>

---

## Overview

**Sard** (Arabic *سَرْد*, "narration") reads EPUB and PDF. It is a native desktop application:
a Rust core, a WebView front end, and a local SQLite database. No account, no sync service, no
telemetry. Your library, your reading positions, your notes and your highlights live in one file
on your own machine.

It is Windows-first today. The reading surface is a single centred column of text on an opaque
page, with the desk showing in the margins — you set the measure, the margins and the page width,
and the interface gets out of the way until you ask for it.

## Why Sard exists

Most readers treat Arabic as a localisation task: mirror the layout, swap the strings, ship it.
That produces software where the diacritics collide with the line above, the justification tears
holes in the text, search misses a word because it carries a fatḥa, and the "next page" arrow
points the wrong way.

Sard was written the other way round. Right-to-left is not a mode — it is one of two directions
the layout is built in from the start. Tashkīl can be shown, dimmed or hidden. Search folds
diacritics, so «الليل» finds «اللَّيْلُ». Numerals render Eastern-Arabic in an Arabic interface.
Naskh and Ruqʿa faces ship with the app.

And none of that comes at the expense of everything else. Arabic is first-class here; it is not
the whole point. The same care goes into English typography, into how a panel opens, into whether
hiding a toolbar shifts the text under it. The priority order is **beauty › smooth › lightweight**,
and each one is measured rather than asserted.

## Key features

**Reading**
- EPUB with reflowable text: paginated or scrolled, RTL and LTR
- PDF, viewed as-is, with a scrubbable page bar
- Per-script typography — separate Arabic and Latin faces, size, weight, leading, tracking,
  paragraph spacing, first-line indent, alignment, margins, page width
- Diacritics: show, dim or hide
- Immersive scrolling — the toolbar, the read-aloud transport and the scrollbar recede as you
  read into the page, and return when you scroll back

**Library**
- Import single files or a whole folder; SHA-based deduplication
- Grid, list and shelf-row views; user-defined shelves; sort and filter
- Covers extracted from the book, or generated from its title when there is none
- Your own image behind the library and around the reading desk, with presence, blur and focal point

**Annotation**
- Highlights in eight inks tuned per theme, notes with titles and tags, bookmarks
- **References** — a note bound to a word or phrase, marked wherever that phrase occurs
- A cross-book inbox for every highlight and note you have ever made
- Photo cards: turn a passage into a shareable image in five papers and four formats

**Read-aloud**
- Offline neural voices via Piper, or Microsoft Edge's online voices
- Sentence spotlight and word-level highlighting that follow the audio
- A transport that shrinks from a full pill to a single calligraphic stroke in the margin

**Everywhere**
- 16 themes, including Moonlit Sky with its own decorative layer
- Full English and Arabic interface, mirrored end to end
- Keyboard-reachable controls with visible focus

## Screenshots

### Library

Your books as objects: real covers, shelves you define, and grid, list or shelf-row views. The
interface mirrors completely between Arabic and English — this is the same screen in both.

<p align="center">
  <img src="docs/screenshots/Library.png" alt="Sard's library in Arabic, right-to-left, showing the cover grid and user-defined shelves" width="900">
</p>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/Library-en-lang.png" alt="The same library in English, mirrored left-to-right"></td>
<td width="50%"><img src="docs/screenshots/Library-with-background-image.png" alt="The library with a personal background image behind the covers"></td>
</tr>
<tr>
<td><b>English, mirrored</b> — the sidebar, shelves and controls all move; only the wordmark keeps its order.</td>
<td><b>Your own background</b> — an image behind the library, with the theme still setting every colour.</td>
</tr>
</table>

### Reader

A single column of text on an opaque page, with the desk showing in the margins. Measure, margins,
page width, leading and per-script fonts are all yours to set.

<p align="center">
  <img src="docs/screenshots/in-book-with-image-background.png" alt="The reading surface: a centred page of text resting on a desk with a background image in the margins" width="900">
</p>

### Search

Diacritic-insensitive, and **spoiler-safe**: matches up to your position are shown in full, while
everything ahead is sealed behind a count until you ask for it.

<p align="center">
  <img src="docs/screenshots/search-feature.png" alt="In-book search with the spoiler-safe toggle on, showing one match hidden behind a sealed card" width="820">
</p>

### Notes &amp; annotations

A note can carry a title, a body, an ink colour, an ink density and tags — written in a centred
editor built to be a quiet room, with the passage above and nothing competing for attention.

<p align="center">
  <img src="docs/screenshots/notes.png" alt="The note editor: the highlighted passage, an optional title, the note body, and a margin panel with colour, ink density and tags" width="880">
</p>

### Selecting text &amp; references

Select any passage and the toolbar offers eight highlight inks and every action that can follow —
including **Add reference**, which binds a note to a word or phrase and marks it wherever that
phrase recurs.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/options-en.png" alt="The selection toolbar in English: eight highlight inks above, then Listen, Note, Add reference, Copy, Add to card and Create photo card"></td>
<td width="50%"><img src="docs/screenshots/options-ar.png" alt="The same selection toolbar in Arabic, mirrored"></td>
</tr>
<tr>
<td><b>English</b></td>
<td><b>Arabic</b> — same toolbar, mirrored.</td>
</tr>
</table>

### Themes

Sixteen papers, from Ivory through True-Black to Moonlit Sky. Each carries its own eight highlight
inks, tuned so a highlight lightens dark paper instead of blotting it.

<p align="center">
  <img src="docs/screenshots/Themes.png" alt="The Appearance settings showing all sixteen themes as labelled swatches, plus day/night mode and the library background controls" width="900">
</p>

### Settings

Two levels: app-wide from the Library, and per-book while reading. This is the in-book drawer —
five tabs, with Contents open on one side and the reading surface live between them, so every
change previews on the real page.

<p align="center">
  <img src="docs/screenshots/In-book-settings.png" alt="Reading an Arabic book with the Contents panel open on the left and the in-book settings drawer on the right" width="900">
</p>

### Read aloud

Offline neural speech through Piper, or Microsoft Edge's online voices. The sentence being spoken is
spotlit and the current word tracked inside it; the transport carries engine, voice, speed and
volume, and collapses to a single calligraphic stroke when you want the page to yourself.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/in-book-en-with-background-and-TTS-working.png" alt="Reading in English with read-aloud playing: the spoken sentence spotlit, the current word highlighted, and the transport showing the Piper and Edge engines, voice and speed"></td>
<td width="50%"><img src="docs/screenshots/in-book-ar-with-background-and-TTS-working.png" alt="The same read-aloud transport while reading an Arabic book, right-to-left"></td>
</tr>
<tr>
<td><b>English</b> — engine, voice, speed and volume in one pill.</td>
<td><b>Arabic</b> — the same tracking, right-to-left.</td>
</tr>
</table>

### Photo cards

Turn a passage into a shareable image — five card styles, sixteen papers, four formats — and keep it
in the app to re-share later.

<p align="center">
  <img src="docs/screenshots/quote.png" alt="The photo card composer: a portrait card with a quotation, beside controls for card style, paper, format and text size" width="880">
</p>

<p align="center">
  <img src="src-tauri/icons/Sard-.png" alt="" width="140">
</p>

## Technologies used

| Layer | Choice |
| --- | --- |
| Shell | [Tauri 2](https://tauri.app) — Rust core, system WebView, no bundled browser |
| Core | Rust — library, database, imports, TTS orchestration, image processing |
| Front end | React 19 + TypeScript, built with Vite |
| State | zustand |
| Storage | SQLite via `rusqlite` (bundled), one file under `%APPDATA%` |
| EPUB | [foliate-js](https://github.com/johnfactotum/foliate-js), vendored and pinned |
| PDF | [PDF.js](https://github.com/mozilla/pdf.js) |
| Offline speech | [Piper](https://github.com/rhasspy/piper) + [eSpeak NG](https://github.com/espeak-ng/espeak-ng) + [ONNX Runtime](https://github.com/microsoft/onnxruntime) |
| Type | Amiri · Noto Naskh Arabic · Aref Ruqaa · IBM Plex Sans (+ Arabic) · Literata · Source Serif 4 · Inter |

## Architecture

```
┌── React + TypeScript ──────────────────────────────┐
│  features/   library · reader · settings · photo   │
│  reader-engine/  the seam onto foliate-js          │
│  theme/      one token set → chrome AND book       │
│  i18n/       en + ar                               │
└───────────────────────┬────────────────────────────┘
                        │  52 IPC commands
┌───────────────────────┴────────────────────────────┐
│  Rust core (src-tauri/src)                         │
│  commands/   the single frontend↔core boundary     │
│  library/ books/ metadata/   import + catalogue    │
│  db/        SQLite, one shared connection          │
│  tts.rs     Piper sidecar + Edge orchestration     │
│  backgrounds/  decode, resample, encode            │
└────────────────────────────────────────────────────┘
```

Three ideas hold the codebase together:

**One IPC seam.** `commands/mod.rs` and `lib/ipc.ts` are the only place the front end and the core
meet. Everything crossing that line is typed on both sides.

**One token set.** A theme is a set of semantic tokens. They fan out to `:root` CSS variables for
the interface *and*, through an injected-CSS funnel, into the book's own document — which is a
separate frame that cannot read the parent's variables. Adding a seventeenth theme is adding a
preset; nothing else changes.

**One database connection.** A single `rusqlite::Connection` behind a mutex in the app state,
recovered rather than poisoned on panic, so one failure cannot silently disable persistence for
the rest of the session.

## Performance

Performance here means measured before and after, not asserted:

- **Frame budget.** Backgrounds are resampled to a bounded edge at import, so a 115-megapixel
  photograph and a 2-megapixel one cost the same to render — measured identical frame times at
  240 Hz.
- **Blur where it earns its place.** Frosted surfaces run a 4 px blur over a 96 %-opaque ground
  rather than a wide blur over a transparent one; the look survives, the compositor work does not.
- **No idle work.** The read-aloud animation loop parks instead of spinning when nothing is
  sounding. No background timers run while you are simply reading.
- **Off the main thread.** Import — whole-file read, SHA-256, zip and OPF parse — is asynchronous,
  so a folder of books does not freeze the window.
- **Stable layout.** Scrollbar gutters are reserved rather than borrowed, because a list that
  crosses the overflow threshold otherwise re-lays out every card.

## Text-to-speech

Two engines, chosen per book:

- **Piper** runs locally as a bundled sidecar. No network, no account. Voices are downloaded on
  request — they are not shipped with the app, which keeps the installer small.
- **Microsoft Edge** neural voices are used over the network when you want them, including
  word-level timing.

While a chapter plays, the current sentence is spotlit on the page and — with Edge — the current
word is tracked inside it. Speed is an explicit ordered set rather than a slider, so 1.10× exists
instead of being rounded away. The transport collapses in two steps: a full pill, a compact row,
then a **kashida** — a tapered calligraphic stroke in the bottom margin whose fill is your
progress and whose bead is play/pause. Chapter ends offer to continue rather than simply stopping.

## EPUB support

EPUB rendering is [foliate-js](https://github.com/johnfactotum/foliate-js), vendored at a pinned
commit under `public/foliate-js/` so a future upstream change can never silently alter how a book
lays out. Sard drives it through one controller and styles the book through a single injected-CSS
funnel.

Sard forces a single column and lets that column fill the sheet, so widening the page widens the
measure. Reading position is stored as an EPUB CFI, which survives a font change, a resize or a
re-import. Local modifications to the vendored copy — including the iframe sandbox hardening — are
recorded in `public/foliate-js/VENDOR.txt` and must be re-applied on any re-vendor.

PDF is deliberately narrower in scope: view-as-is, with page navigation, a scrubbable position bar,
copy-selection and an approximate inverted mode. Themes, reflow and annotation do not apply to a
fixed-layout document, and Sard says so rather than pretending otherwise.

## Search

In-book search is diacritic-insensitive: «الليل» finds «اللَّيْلُ». It is case-insensitive for Latin
text, and reports progress while it scans rather than blocking on a long book.

It is also **spoiler-safe**. Matches up to your current position are shown in full. Everything
ahead of you is sealed behind a count — *"3 matches ahead are hidden"* — and revealed only if you
ask. Searching a book you are halfway through should not tell you how it ends.

## Notes

A note can carry a title, a body and tags. A highlight can carry a note. A note can exist on its
own, pinned to a spot in the page, with no highlight at all.

Notes open in a centred editor built to be a quiet room — the passage above, your text below,
nothing else competing. Every note and highlight is also reachable from a single cross-book inbox
in the library, filterable by colour, book, tag and kind, so a thought you had six books ago is
still findable.

## References

A reference is a note bound to a **word or phrase** rather than to a position — a character's
name, a recurring image, a term you want to track.

Once created, that phrase is marked wherever it occurs, by a twin rule drawn beneath it: two thin
strokes with rounded terminals, at a colour, thickness and distance you control. The mark is drawn
as SVG in the reader's overlay rather than as a text decoration, because the design — rounded caps,
a second stroke, a controllable gap — is not expressible with CSS text styling. One shared geometry
resolver draws both the mark on the page and the sample in the settings panel, so the two can
never disagree.

## Themes

Sixteen papers: Ivory, Sepia, Slate, True-Black, Sage, Rose Quartz, Parchment, Dusk, Ink, Espresso,
Forest Night, Mulberry, Charcoal, Nocturne, Linen, and **Moonlit Sky** — a gold-on-night theme with
its own crescent, stars and cloud layer.

Each carries eight highlight inks tuned to that paper, so a highlight lightens dark paper instead
of blotting it. Themes apply app-wide, or per-book if you prefer each book to keep its own look;
the library can hold a different theme from the reader. A contrast guard flags any custom text
colour too faint to read on the paper you have chosen.

## Installation

Download the latest installer from the [**Releases**](https://github.com/Limitless-Soul1/Sard/releases)
page:

- **`Sard_1.0.0_x64-setup.exe`** — NSIS installer, the usual choice
- **`Sard_1.0.0_x64_en-US.msi`** — MSI, for deployment tooling

Requirements: **Windows 10 or 11 (x64)**. The WebView2 runtime is preinstalled on current Windows;
on older builds the installer will prompt for it.

The installers are not code-signed yet, so Windows SmartScreen will warn on first run —
*More info → Run anyway*. If you would rather not, [build from source](#build); it takes a couple
of minutes.

### Updates

From **v1.1.0** onward Sard updates itself. Click the flower in the Library's corner and it checks
GitHub Releases; if there is something newer it shows you the version and the release notes and asks
before doing anything. Accepting downloads the installer, verifies it against Sard's signing key,
installs it and restarts the app.

**Your data is never touched by an update.** The installer replaces only the program files under
`%LOCALAPPDATA%`; your library, reading positions, notes, highlights, references, bookmarks, photo
cards, backgrounds, settings and downloaded voices all live under `%APPDATA%\com.sard.app` and are
left exactly as they are. Deleting that data is possible only through an explicit checkbox on the
*uninstaller*, which an update never reaches.

*v1.0.0 predates the updater and cannot update itself — install v1.1.0 by hand once, and it will
keep itself current from then on.*

## Build

Prerequisites:

- [Node.js](https://nodejs.org) with npm
- [Rust](https://rustup.rs) — stable, MSVC toolchain
- WebView2 runtime

```sh
git clone https://github.com/Limitless-Soul1/Sard.git
cd Sard
npm install
npm run tauri build      # release binary + MSI/NSIS installers
```

For a faster local build, `npx tauri build --no-bundle` skips the installers and produces just the
executable. Close any running copy of Sard first — it holds its own executable open, and the build
would otherwise fail with a misleading error. See [`BUILD.md`](./BUILD.md) for the details and the
common failure modes.

## Development

```sh
npm run dev              # Vite dev server alone
npm run tauri dev        # the desktop app with hot reload
npm run build            # typecheck + production front-end build
cargo test               # Rust core (run inside src-tauri/)
cargo clippy --all-targets
```

Layout:

```
src/                 React front end — features/, reader-engine/, theme/, i18n/, lib/
src-tauri/           Rust core — commands/, db/, library/, books/, tts.rs, backgrounds/
public/foliate-js/   vendored EPUB engine (pinned; see VENDOR.txt)
public/fonts/        bundled OFL fonts and their licences
scripts/             build tooling
```

Conventions worth knowing before a first patch:

- Every colour resolves to a theme token. Literal colours appear only where something is a *paint*
  — a generated book jacket, a highlight ink, a danger red.
- Logical properties (`inset-inline-*`) wherever the interface mirrors. Physical sides only where
  a side is deliberately pinned: the reader's control cluster, Contents on the left, Notes and the
  settings drawer on the right.
- Database changes are additive migrations under `src-tauri/src/db/migrations_sql/`, numbered and
  never edited after they ship.
- Comments explain *why*, not *what*. If a line looks strange, the reason it is not the obvious
  alternative belongs beside it.

## Roadmap

- Code-signed installers, so Windows stops warning on first run
- macOS and Linux builds
- A wider EPUB conformance pass — footnotes, media overlays, complex fixed-layout
- Deeper PDF support: annotation on the page, text reflow where the document allows it
- Import and export of annotations in an open format
- Dictionary and translation lookup on selection
- Accessibility: full screen-reader labelling and a keyboard path to every action

## Contributing

Issues and pull requests are welcome. Two things that will make review quick:

1. **Say what you measured.** Sard's history is a record of changes justified by numbers. A patch
   that claims to be faster, lighter or clearer is easiest to accept when it says what moved.
2. **Preserve behaviour unless the change *is* the behaviour.** If a fix alters something a reader
   would notice, call that out explicitly.

Bug reports are most useful with the book that triggered them, if you can share it, or a
description of its structure if you cannot.

## Support the project

Sard is developed independently and given away under a free licence. If it earns a place in your
reading, you can help fund the work that keeps it going:

**[creators.sa/lll9we](https://creators.sa/lll9we)**

Contributions go toward development time, code signing for the installers, and the hardware Sard is
tested on. There is no paid tier and no feature behind a paywall — the whole application is, and
will remain, free software.

## License

Sard is licensed under the **GNU Affero General Public License v3.0** — see [`LICENSE`](./LICENSE).

You may use, study, modify and redistribute it, including commercially. What you may not do is
close it: any derivative you distribute, or run as a network service, must remain under the same
licence with its source available.

Third-party components keep their own terms — foliate-js (MIT), PDF.js (Apache-2.0), Piper (MIT),
eSpeak NG (GPL-3.0-or-later), ONNX Runtime (MIT), and the bundled fonts (SIL OFL 1.1). Full
attribution is in [`NOTICE`](./NOTICE).

The name **Sard / سَرْد** and the hoopoe mark are not covered by the AGPL. Use them to refer to
this project, not to brand a fork.
