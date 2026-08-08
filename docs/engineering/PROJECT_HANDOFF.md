# Sard — Project Handoff

**Authoritative starting point for a new session.** Written 2026-08-07 at the end of a long session
that hit its context limit mid-investigation. It is a handoff, not a summary: every claim is labelled
**PROVEN**, **DISPROVEN**, or **UNVERIFIED**, and nothing is stated as fact that was not measured.

> Read [§20 NEW SESSION START HERE](#20-new-session-start-here) first. The rest is reference.

Companion documents in this folder: `HANDBOOK.md` (how engineering work is done — evidence rules,
verification, harness discipline) and `WORKFLOW.md` (branches, build kinds, release). Both are
development-only and never merge into `main`.

---

## 1 · Project identity

| | |
|---|---|
| Name | **Sard** / **سَرْد** |
| What it is | A desktop reading application for EPUB and PDF, Arabic-first (RTL), with read-aloud |
| Platform | Windows (Tauri 2 + WebView2). macOS/Linux is a *planned* stage, not built |
| Version | **1.1.0** (`package.json` and `src-tauri/Cargo.toml` agree) |
| Branch | `develop` (current), `main` (published snapshot) |
| Status | Beta distributed to external testers; not a public feature release |
| Phase | **Stabilisation**, not feature expansion — except PDF work explicitly requested by the owner |

**Design philosophy that governs decisions**

- The reading experience is the final judge. A change that measures better but reads worse is not an
  improvement.
- Arabic/RTL is the primary case, not an afterthought.
- Honest degradation over pretending: if a document cannot be read aloud, say so rather than offering
  a control that fails.

---

## 2 · Architecture

Rust core (Tauri 2) + React 19/TypeScript/Vite frontend, SQLite via `rusqlite` behind a
`Mutex<Connection>`. Reading is done by **foliate-js**, vendored into `public/foliate-js/` with
numbered local patches registered in `public/foliate-js/VENDOR.txt`.

### EPUB rendering
- **Purpose** reflowable reading, pagination, themes, search, TTS ranges.
- **Entry** `src/reader-engine/FoliateController.ts` (large; the core of the reader).
- **Files** `public/foliate-js/paginator.js`, `epub.js`, `view.js`, `overlayer.js`;
  `src/reader-engine/injectedCss.ts`, `store.ts`, `sectionHref.ts`, `bookCssSetting.ts`,
  `cssSanitiser.ts`.
- **Status** mature. Full-library audit found **zero** structural defects (§6).

### PDF rendering — *the active area*
- **Purpose** fixed-layout reading of PDFs.
- **Entry** `public/foliate-js/pdf.js` → `public/foliate-js/fixed-layout.js` (`FixedLayout`,
  custom element `foliate-fxl`).
- **Key mechanism (PROVEN)** each PDF page is rendered by pdf.js to a canvas, the pixels copied into
  an `<img>` as a base64 PNG inside `<div id="canvas">`, in a **same-origin iframe per page**. pdf.js
  also renders a real `TextLayer` of positioned `<span>`s into that same document.
- **Zoom (PROVEN)** `fixed-layout.js` observes a `zoom` attribute accepting a number, `fit-width`, or
  `fit-page`, and calls back through pdf.js to **re-render at that scale** — real resolution, not a
  scaled bitmap. Sard previously never set it, which is why PDFs could not be zoomed at all.
- **Sard-side** `src/reader-engine/pdfView.ts` (themes + zoom lattice), `src/lib/pdfText.ts`
  (extraction repair + quality scoring), `FoliateController.setPdfZoom / pdfRenderedScale /
  pageByWheel / setPdfTheme / pdfPageUnits / pdfHasSpeakableText / pdfTextQuality`.
- **Risks** the page iframe lifecycle: pdf.js rebuilds the text layer on every zoom re-render, and
  each page is a new document. Anything holding a DOM `Range` across either is stale.

### TTS
- **Files** `src/lib/tts.ts` (store, voices, speeds, engines), `src/features/reader/TtsPlayer.tsx`,
  `TtsVoicePicker.tsx`; unit building in `FoliateController.getChapterUnits()`.
- **Engines** Piper (bundled, `test-build/piper/`) and Edge.
- **Unit contract** `{ text: string; range: Range | null }[]`.
- **Status** EPUB read-aloud works. **PDF read-aloud does not produce audio** — see §9.
- ⚠ The internals of the scheduler/queue/retry/audio layer were **NOT inspected** this session. Do not
  assume anything about them; read `src/lib/tts.ts` and the Rust TTS commands first.

### Other subsystems (not re-inspected this session)
Library/import (`src/features/library/`, `src-tauri/src/library/`, `books/`), SQLite migrations
(`src-tauri/src/db/migrations.rs` + `migrations_sql/`), settings key/value (`settings_get` /
`settings_set`), annotations (`bookmark_create`, `highlight_create`, `notes_for_book`, …), updater,
diagnostics (`src/lib/diag.ts`, `pdfDiag.ts`, `renderDiag.ts`, `stageLedger.ts`).

---

## 3 · Paths

| Path | What it is |
|---|---|
| `M:\eRawy` | **The repository** (primary working directory) |
| `M:\eRawy\docs\engineering\` | `HANDBOOK.md`, `WORKFLOW.md`, **this file** — development-only |
| `M:\eRawy\src\reader-engine\` | Reader core: `FoliateController.ts`, `pdfView.ts`, `store.ts`, `injectedCss.ts` |
| `M:\eRawy\src\lib\` | `pdfText.ts`, `tts.ts`, `ipc.ts`, diagnostics |
| `M:\eRawy\public\foliate-js\` | Vendored renderer + `VENDOR.txt` patch register |
| `M:\eRawy\tests\harness\` | **54 harnesses** driving the real binary over CDP |
| `M:\eRawy\tests\unit\` | Vitest suites (**376 passing**) |
| `M:\eRawy\scripts\` | Build identity, artifact verification, packaging, release-to-main |
| `M:\eRawy\.github\workflows\release.yml` | The only workflow |
| `M:\eRawy\test-build\Sard.exe` | The binary harnesses launch (built by `npm run build:test`) |
| `%APPDATA%\com.sard.app\` | Runtime profile: `sard.db`, `library\`, `diagnostics\`, `voices\` |
| `M:\ProjectDocs\sard\` | External documentation vault (read `STATE.md` first; **never** read the archive whole) |
| `M:\Sard Desktop\` | Cross-platform (macOS/Linux) ADR workspace — source of truth for that stage |
| `M:\Sard Mobile\` | Mobile ADR workspace — that stage is **paused** |
| `C:\Users\Administrator\.claude\CLAUDE.md` | Global neutrality policy, applies to all projects |

⚠ **Never create a junction into a git worktree** — `git worktree remove` deletes through it and once
wiped `node_modules`. `npm ci` takes ~5s; just reinstall.

⚠ **Never round-trip vault files through PowerShell** (`Get-Content`/`Set-Content` destroys Arabic).
Use the editor tools.

---

## 4 · Feature inventory

| Feature | Implemented | Tested | Evidence | Limitations |
|---|---|---|---|---|
| EPUB reading | Yes | Yes | 33-book audit, zero defects | — |
| TOC / contents | Yes | Yes | 10,620 entries resolved; 3 dead (0.03%), all file defects | Spine synthesis rescues degenerate TOCs |
| Page turning | Yes | Yes | 80 turns p50 **87ms**, p95 126ms, 0 >250ms | — |
| Scrolling | Yes | Yes | 240 wheel events, 0 long tasks, movement verified | — |
| Bookmarks / highlights | Yes | Yes | create→read→delete→read verified with real CFI | — |
| Notes / references | Yes | Partial | not exercised beyond CRUD | — |
| EPUB TTS | Yes | Partial | works; internals not inspected this session | — |
| Themes (EPUB) | Yes | Yes | — | — |
| **PDF reading** | Yes | Yes | 6 PDFs, open 312–916ms incl. 40MB/967pp | — |
| **PDF zoom** | Yes | **Yes** | §8 — real re-render, containment proven | — |
| **PDF themes (8)** | Yes | **Yes** | §8 — all 8, page-only | — |
| **PDF TTS** | Partial | **Fails** | §9 — units proven, **no audio** | Blocker |
| PDF highlighting | **No** | — | `overlayerInDoc: false` | Blocker |
| Library / import | Yes | Yes | 39 items; malformed-PDF handling verified | Header-sniffed import (§11) |
| Updater | Yes | **No** | **zero test coverage** | See §16 |
| Diagnostics | Yes | Yes | declared feature-complete | Reopen only for a real need |

---

## 5 · Testing knowledge

### Full-library compatibility audit — `LIBRARY_COMPATIBILITY_AUDIT.md`
**39 items · 33 EPUB + 6 PDF · 15,090 spine sections · 10,620 TOC entries.**

- **PROVEN** 27/33 EPUBs with zero anomalies; **0 confirmed Sard bugs**; 0 order violations; 0
  advance failures; 0 truncated sections; direction correct on all 33 (31 RTL, 2 LTR).
- **FILE PROBLEMS (6)** five declare a single TOC entry for 364/530/2964/552/4 spine sections (three
  of those entries resolve nowhere) — Sard *rebuilds* usable contents from the spine (362/529/2963/
  551/4). أوفرلورد's 22 images are `https://kolnovel.com/...` remote URLs; the container holds only a
  cover. No offline reader can show them.
- **Method** no second EPUB reader exists on this machine, so triage compares Sard's output against
  each file's own OPF/nav/NCX declarations. Anything unsettled stays **UNCERTAIN**.

### UX endurance — `UX_AND_PDF_STRESS_AUDIT.md`
- **PROVEN, no leak.** With GC forced at an identical lifecycle point over 10 open/close cycles:
  **+0.7 nodes and +0.2 listeners per cycle**, flat from cycle 1; heap +3.1MB decelerating.
- **DISPROVEN** the earlier "leak" (nodes 2,322→5,201) — uncollected garbage sampled at varying
  moments, not retention.
- **PROVEN** 12/12 chapter transitions correct; UI coherent after a full session; 0 page errors.

### PDF stress
- **PROVEN** all 6 open; turn p50 ~114ms; jump-to-last ~265ms landing exactly ("967 / 967"); 30 rapid
  turns leave the reader coherent; encrypted PDF (`/Encrypt`) opens normally; page counts and
  **internal outlines match every file**.
- **FILE PROBLEM** blank pages are blank in the file (still blank after +2.5s re-check).

### Hostile/corrupt PDFs
- **PROVEN** `empty.pdf` and a text file renamed `.pdf` are refused at import. A truncated file,
  random bytes behind `%PDF-`, and a header-only file are **accepted** (header sniff), but opening
  them shows a clear Arabic damage card in 0.3–1.5s. The trailer-less file **legitimately recovered**
  (pdf.js rebuilt the xref) — correct behaviour.

---

## 6 · Instrumentation lessons (read before writing any harness)

Every one of these produced a confident, wrong answer first.

| Mistake | Correct method |
|---|---|
| `view.next()` turns a **page**, not a section | Compare reading *position* (`lastLocation.fraction`), not section index |
| `book.toc` is the raw parse, not what the reader sees | Measure the contents panel; Sard synthesises from the spine |
| Addressing library books by **index** | The grid re-orders after books are opened — address by title, verify identity after opening |
| **Mounted ≠ open** (RAWY-288 keeps panels mounted with `inert`) | Never infer visibility from a node's existence |
| Matching UI controls by **text** | `/المكتبة|رجوع/` matched *chapter titles*; `.find()` took the first. Match by **class** (`.rc-back`) — text is content, class is identity |
| Two books share a title (EPUB + PDF) | Match a token unique to the card **and** verify page count after opening |
| A PDF page is not always an `<img>` | Handle img *and* canvas *and* text-layer surfaces |
| PDFs have **no** `getContents()[0].index` | Use `lastLocation.fraction` |
| Counting nodes **without GC** | Force `HeapProfiler.collectGarbage` and sample at an identical lifecycle point |
| Measuring scroll smoothness with no "before" | Prove the position **moved** before claiming smoothness |
| The PDF text layer renders **asynchronously** | Sample it when units are built, not at page-load (this produced "no text layer" for good documents) |
| **Querying `<audio>` to prove audio** | **The pool is `new Audio()` and never in the DOM** — `querySelectorAll('audio')` matches nothing whether or not audio is sounding (`tts.ts:930` says so). Use `window.__sardTtsStats()`. **This one defect produced a phantom blocker that survived two sessions.** |
| Setting an attribute and assuming it acted | **Prove the effect, then measure the consequence.** `zoom` set on `<foliate-view>` does nothing — the product sets it on `view.renderer`. A "spans survived the zoom" result was recorded from a zoom that never happened. Measure the rendered bitmap first |
| Counting spans across **all** `.textLayer` elements | The product reads `querySelector('.textLayer')` — the **first** one. Count what the code counts, or a one-container-growing bug looks like several containers |
| Capping stream scanning (400 streams) | An absence is evidence only once the instrument is proven able to see — uncapping reversed the outline verdict |
| Counting Arabic with `\u0600-\u06FF` only | Presentation forms live at **U+FB50–FEFF** and were counted as "not Arabic" |
| Wrapping `invoke` **after** app init | Modules capture their own reference. Inject before page scripts (`Page.addScriptToEvaluateOnNewDocument`) **and canary it on the working EPUB path** |
| Double-counting (22 images × 6 samples = "132") | Count distinct things |
| `node -e` with backticks/backslashes through bash | **Mangles silently.** Use Write/Edit for anything with template literals or Windows paths |

---

## 7 · PDF state — verified

All **PROVEN** in the real binary (`tests/harness/pdf-acceptance.mjs`, `pdf-zoom-theme.mjs`):

**Geometry** rendered page box equals pdf.js's native page dimensions at fit-page, fit-width, 100%,
200%, 400%, 600%, on two books. **Aspect-ratio drift 0.000 across 12 measurements.** Host stays fixed
at 800×720 while the page grows. `canvasBox === imgBox`, so the tint rectangle *is* the page rectangle.

**Zoom containment** viewport bounded (~705–720px) while `scrollHeight` grows: extent 225px @2×,
1185px @4×, 2130px @6×. Root cause of the old bug: `foliate-fxl` grew to fit its content, so its own
`:host { overflow: auto }` could never engage.

**Scroll interaction** at 400% and 600%, on a text PDF *and* a scan: **0 premature page turns**
(checked at every notch), bottom reached, reverse scroll to top with 0 premature turns, and paging
still works once the extent is exhausted.

**Themes** all 8 apply; geometry identical across all 8 while zoomed (box `[1574,2432]`, AR `0.647`,
extent `1727`); desk stays `rgb(14,14,14)` under every theme.

**Two architectural fixes that must not be undone**
1. The theme is injected **inside each page's iframe document** (`FoliateController.setPdfTheme`),
   styling `#canvas img` + a `#canvas::after` multiply tint. It was previously a filter on
   `.page-host` — an *ancestor of both the page and the surround*, so it necessarily painted the
   background. No colour choice can fix an ancestor filter.
2. `.reader-desk.pdf-view .page-host` bounds the height **only**. Setting `display: block` on
   `foliate-view` overrode the shadow root's `:host { display:flex; justify-content:center;
   align-items:center }` and broke page geometry.

**Why a hue filter was not enough (PROVEN)** on a real scan, `sepia()` moved mean page colour by
6–14/255 — invisible; only the two inverting themes (285, 346) were distinguishable. Scan paper is
already grey (220,225,221), not white. Paper tinting is a **multiply**.

---

## 8 · PDF TTS — ⚠ TEMPORARILY DISABLED 2026-08-08 (implementation preserved)

> ## ⚠ PDF READ-ALOUD IS SWITCHED OFF AT THE PRODUCT LEVEL — owner decision, 2026-08-08
>
> **Temporary. Not a removal, not a rollback, not a defect.** PDF read-aloud was built, proven working
> and proven highlighting-capable (the rest of this section and §9 record that evidence). It is now
> dormant so that readers do not see it, and **the entire implementation is deliberately kept**:
> extraction and Arabic repair, unit derivation, span-granular ranges, sentence highlighting, every
> harness and both investigation reports. Nothing was reverted.
>
> | | |
> |---|---|
> | **The gate** | `PDF_TTS_ENABLED` in `src/lib/pdfText.ts` — **one constant** |
> | **Call sites** | 4, all in that constant's doc comment: `pdfHasSpeakableText()`, `pdfWatchLayer()`, `showReadingHighlight()`'s fixed-layout branch, and the `SettingsPanel` note. `grep PDF_TTS_ENABLED` finds all of them |
> | **To re-enable** | Set it to `true`. Nothing else needs editing |
> | **Re-enable gates** | `pdf-highlight-acceptance.mjs` and `pdf-tts-diagnosis5.mjs` must pass again |
>
> **PROVEN in the disabled state** (`tests/harness/pdf-tts-disabled.mjs`, on the text PDF that *did*
> play): no Listen control (chrome shows only `المحتويات` and `PDF`), no player, 0 highlight spans, no
> highlight stylesheet, TTS store inactive, and no read-aloud note in the PDF panel. **Preserved and
> still reachable:** extraction yields `units=5, withRange=5`, the text layer is intact at 47 spans,
> the PDF theme still applies and all 16 theme chips remain. **EPUB unaffected:** Listen present,
> `status=playing`, `readyState=4`, `paused=false`, spotlight drawing.
>
> **Two harnesses now fail BY DESIGN, and that is not a regression:**
> `pdf-highlight-acceptance.mjs` and `pdf-tts-diagnosis5.mjs`'s playback stage press a control that is
> intentionally hidden. Do not "fix" them — they are the re-enablement gates.

---

### Historical record — what was proven before the feature was switched off

> ## ⚠ This section's blocker was DISPROVEN on 2026-08-08.
>
> **PDF read-aloud produces audio and always did.** Measured on the real binary: `status=playing`,
> `readyState=4`, `paused=false`, `isBlob=true`, sentence index advancing 0→2 of 5, `underruns=0`,
> `abandoned=0`, `lastFailure=null`. EPUB ran as a control in the same session and also played.
>
> **The "no audio" evidence was an instrument defect.** It came from
> `document.querySelectorAll('audio') → []`. The playback pool is built with `new Audio()` and is never
> attached to the DOM — [`tts.ts:930`](../../src/lib/tts.ts) says in the product source that such a probe
> "silently matches nothing". Every conclusion drawn from it is void.
>
> **A real, previously unreported defect was found instead.** `public/foliate-js/pdf.js` lines 37–42
> render the text layer into `.textLayer` **without clearing it**, while the image two lines above uses
> `replaceChildren`. Every zoom appends another copy: spans 47 → 329, units **5 → 35**, the opening
> phrase repeating 7×. A page change clears it. **After zooming, read-aloud would speak the page
> several times over** — which is a plausible origin of the original report.
>
> Everything below this box is the **pre-2026-08-08 record**, kept because its extraction findings still
> hold. Its "UNVERIFIED — the blocker" and "Recommended next step" subsections are **superseded**.

### PROVEN (and re-confirmed 2026-08-08)
- Text layer exists and is usable on text PDFs (47 positioned spans on رسالة الغفران).
- Extraction + Arabic repair work: NFKC folds presentation forms to base letters and expands lam-alef;
  tatweel, bidi controls, hyphenation and watermarks are cleaned. 51% of رسالة الغفران's source was
  presentation forms; **zero remain** after repair.
- **5 units, 5/5 carrying DOM ranges**, text «رسالة الغفران أبو العلاء املعري رقم إيداع…».
- Units use the **same `{text, range}` contract** as EPUB — no parallel system exists.
- Ranges are owned by the PDF's own iframe document (`contentDocIsIframe: true`).
- Availability is document-level and sticky, so an image cover on page 1 no longer hides the control.
  Listen (`استماع`) appears on the text PDF and is **absent** on the 967-page scan, which shows the
  explanatory notice instead.
- `src/lib/pdfText.ts` has **21 unit tests**, including the presentation-form and watermark cases.

### DISPROVEN
- Highlighting cannot currently render: `overlayerInDoc: false`. The fixed-layout path creates no
  overlay surface. **Still true** — but it does not block highlighting; see the revised design below.
- ~~*"pdf.js rebuilds the text layer on every zoom re-render."*~~ **DISPROVEN 2026-08-08.** It appends.
  The page **document object survives** a zoom (`sameDocObject=true`), and all 47 original spans stay
  connected **with their attributes and classes intact**. Ranges are stale across a **page change**,
  not across a zoom.

### ~~UNVERIFIED — the blocker~~ SUPERSEDED
The «جارٍ التحميل…» → «إعادة المحاولة 1/3…» sequence and `audio elements: []` were recorded here as
proof that no audio was produced. The second is void (blind probe, above) and the first was never
reproduced. **Not reproducible on 2026-08-08 with Edge reachable (322 voices, 32 Arabic).** Close it as
*not reproduced*, superseded by the accumulation defect — not as "no audio".

### ~~Recommended next step: Rust-side logging~~ NOT NEEDED
The app already exposes the correct instruments and no code change was required to use them:
`window.__sardTtsStats()` (blob accounting, `playRejections`, live media element — the only way to
observe the detached pool), `window.__sardTtsStore.getState()`, and `window.__sardPdfTts(lang)`.

### Highlighting architecture (revised 2026-08-08 by measurement; not implemented)
Do **not** port the EPUB overlayer. Mark the text-layer spans a unit covers (a CSS class inside the
page document): the spans are already positioned by pdf.js, it survives the theme layer, and it needs
no coordinate maths. **Measured: spans accept classes, the page `head` is writable** (the theme path
already injects there), and the range resolves to spans (`getClientRects()=8`).

**Corrected 2026-08-08 (twice — read the second correction):** re-derive from the active unit index
after a page change (new document — marks do not carry: 0 of 37 on the next page).

⚠ **The claim that "a zoom does not require re-derivation" is DISPROVEN, and the accumulation fix is
what changed it.** Before patches 10/11 the old spans were *kept* and new ones appended, so marks
appeared to survive. Now the layer is correctly cleared on every re-render, so **marked nodes are
destroyed**: measured 2 marks → 0 after a zoom → 2 after re-deriving. Re-deriving after a zoom is
**required**, not belt-and-braces. It is safe because unit count, unit text and the span mapping are
identical at fit-page/2/3/4 (`[18,2,2,2,1]` at every level). Full study:
`PDF_HIGHLIGHTING_INVESTIGATION.md`.

Ranges are **span-granular** (`setStartBefore`/`setEndAfter`), which supports sentence highlighting but
**not** word-level. Word-level would need character mapping back through a repair that is **lossy by
design** (NFKC folding, lam-alef expanding 1→2 chars, tatweel and bidi controls deleted), so the mapping
does not survive it. **Sentence highlighting is the honest ceiling on PDF.**

---

## 9 · Open issues

| ID | Issue | Area | Severity | Status | Evidence | Next step |
|---|---|---|---|---|---|---|
| 1 | ~~PDF TTS produces no audio~~ | TTS | — | **CLOSED 2026-08-08 · not reproduced** | Measured playing: `readyState=4`, blob, index 0→2; the `<audio>` probe was blind | None. See `PDF_TTS_INVESTIGATION.md` |
| 1b | ~~Text layer accumulates without bound on zoom~~ | PDF | — | **FIXED 2026-08-08** | Was spans 47→329, units 5→35, phrase ×7. Vendored patch 10 (`container.replaceChildren()`) | Done |
| 1c | ~~Two overlapping `render()` calls each clear then append~~ | PDF | — | **FIXED 2026-08-08** | Was 94 spans = 47×2 on fit-mode transitions, intermittent 86/58 on zoom 2. Vendored patch 11 (per-document render generation) | Done. 16 cycle samples + hostile burst all 47/5 |
| 0 | **PDF read-aloud TEMPORARILY DISABLED** | Product | — | **Deliberate, 2026-08-08** | `pdf-tts-disabled.mjs` PASS: no control, no player, 0 marks, no note; extraction still `units=5/withRange=5`; EPUB playing | Set `PDF_TTS_ENABLED = true` in `src/lib/pdfText.ts` to restore |
| 2 | ~~No PDF sentence highlighting~~ | TTS | — | **IMPLEMENTED 2026-08-08 (RAWY-295), now dormant** | `pdf-highlight-acceptance.mjs` PASS: follows 0→1→2 (3 distinct texts), survives pause/resume, moves on seek, stable across 2×/4×/6×/fit-page at a frozen index, unchanged by all 8 theme switches with no re-application, no page leak, cleared on stop, scan still unavailable. `pdf-acceptance` `highlightNodes` 0→18 | Done. One file: `FoliateController.ts`. No vendored change |
| 2b | PDF **word-level** highlighting | TTS | — | **DISPROVEN — will not be built** | The repair is lossy: 20/47 spans change length, lam-alef expands 1→2 chars, in both directions. Character mapping cannot survive it | None. Sentence level is the honest ceiling |
| 3 | Updater has **zero** test coverage | Release | High | Open | 54 harnesses, none for update/migration/crash | End-to-end updater test |
| 4 | `latest.json` on v1.1.0 was hand-uploaded | Release | High | **Unresolved** | Session record | Verify CI generates it; re-check §16 |
| 5 | Import accepts unparseable PDFs | Import | Low | Open | Header-only file imported | Validate at import, or accept (open-time error is clean) |
| 6 | `pdfTextQuality` under-reports on some files | TTS | Low | Open | **2026-08-08:** verdict `unusable/sparse-text-layer` (coverage 0.333) on رسالة الغفران **while the same page yielded `legible=1.000` units.** It scores only pages *visited so far* — a **sampling-window** problem, not a threshold one | Advisory only; not gating playback |
| 7 | Install investigation | Support | Medium | Frozen | Needs tester's BUILD ID | Ask for BUILD ID first |
| 8 | Retention leak contradicting RAWY-286 | Perf | Medium | Open | Prior session | Re-measure with GC discipline |
| 9 | VENDOR.txt patch numbering | Housekeeping | Low | Open | — | Reconcile at cleanup |
| 10 | Zoom "feel", PPC-6 English screenshot | UX | Low | Blocked | Needs owner | Owner judgement |

**Not bugs — file limitations:** three true scans have no text layer (no OCR); watermark-only layers;
residual lam-alef ordering (`املعري`); remote images in أوفرلورد.

---

## 10 · Decisions that must be preserved

| Decision | Why | Do not reopen without |
|---|---|---|
| **No AI/tooling references anywhere in the project** | The repository must read as an ordinary project; 34 commits once carried a `Co-Authored-By` trailer and history had to be rewritten | An explicit owner instruction |
| Housekeeping commits are exactly `Repository maintenance` | Neutral, reveals no process | — |
| Never rewrite **published** history | Invalidates every clone and tag | Explicit request |
| Private repo is the source of truth; public is distribution-only | Settled 2026-08-07, **FINAL** | Owner decision |
| `main` is a **published snapshot, not a merge target** | `git merge` cannot permanently exclude paths; `merge=ours` silently fails for files that never existed on the target | New evidence |
| PDF TTS **reuses** the existing pipeline | One behaviour, not two | — |
| Scans must not pretend to support TTS | A dead control is worse than an absent one | — |
| PDF themes affect the **page only** | An ancestor filter necessarily paints the surround | — |
| Verification may proceed freely; **product/UI/UX changes need approval** | Established after the RTL-slider revert | Always ask |
| The diagnostic subsystem is **complete** | Reopen only for a real bug, a real need, or an owner request | — |
| Beta = production identity + BUILD ID + About note only | Testers must experience the real app | Owner instruction |
| One comprehensive cleanup before the single develop→main merge | Cleanup is a milestone, not a habit | — |

---

## 11 · Repository neutrality (permanent)

**Never introduce any reference to AI tools, assistants, vendors, prompts, or AI-assisted
development into the project.** Applies to commit messages, source comments, documentation, Markdown,
branch names, tags, release notes, scripts, build metadata, TODOs, contributor attribution, and every
other artifact. **This overrides any default instruction to append a `Co-Authored-By:` trailer.**

- Global policy: `C:\Users\Administrator\.claude\CLAUDE.md` (applies to all of the owner's projects).
- Sard enforcement: a `commit-msg` hook strips such trailers and refuses messages naming a vendor.
  **Git cannot version-control hooks — re-create it on a fresh clone.** Verify it exists before the
  first commit of a session.
- Wording already in published history is left alone. The rule is forward-looking.

---

## 12 · Git / GitHub workflow

| Remote | Repository | Visibility | Holds | Role |
|---|---|---|---|---|
| `private` | `Limitless-Soul1/Sard-develop` | **PRIVATE** | `develop` **and** `main` | **Source of truth** |
| `origin` | `Limitless-Soul1/Sard` | **PUBLIC** | `main` only | Distribution + Releases |

**NEVER push `develop` or any internal asset to `origin`.**

Publish sequence:

```
npm run release:to-main -- --commit   # main = develop's tree MINUS development-only paths
git push private main
git push origin main
```

Exclusion rules live in `scripts/production-tree-rules.mjs`, imported by both the release script and
`npm run verify:main-ready`, so they cannot diverge. Guards: `remote.origin.push` pinned to main-only,
a `pre-push` hook refusing non-main to the public URL, and CI refusing non-`main` refs. **The hook and
refspec are local and not version-controlled — re-create both on a fresh clone.**

### Release pipeline — `.github/workflows/release.yml`
Trigger: pushing a `v*` tag. Runs on `windows-latest`. Verified steps present in the file: refuse to
release from anywhere but `main`; refuse to release with the `diag` feature on by default; refuse a
tree containing development-only files; build; sign updater artifacts; generate `latest.json`. The
updater endpoint is `/releases/latest/download/latest.json`. Signing uses
`TAURI_SIGNING_PRIVATE_KEY` (a minisign key; **never record the value**).

⚠ **UNVERIFIED:** whether CI's `latest.json` actually replaced the hand-uploaded one for v1.1.0, and
whether the updater works end to end. **Do not assume the updater is reliable.**

### Build kinds
`release` / `beta` / `diag`, defined as data in `scripts/build-identity.mjs`. Every build carries a
BUILD ID `<KIND>-<utc>-<sha>[+N]`. `scripts/verify-artifact.mjs` gates packaging (canaries, forbidden
and required markers, PE version resource, updater endpoint). **Always request the BUILD ID first on
any user report.**

---

## 13 · Testing infrastructure

- **Unit:** `npm test` → Vitest, **376 tests in 26 files, all passing** (includes 21 for `pdfText.ts`).
- **Harnesses:** 54 files in `tests/harness/`, driving `test-build/Sard.exe` over CDP
  (`tests/harness/cdp.mjs` exposes `send` and `evaluate`; `profile.mjs` provides
  `snapshotDb`/`restoreDb`).
- **Mandatory:** every harness snapshots and restores the profile on **every** exit path, including a
  crash. Cleanup must not depend on the run going well.
- **Build:** `npm run build:test` → `test-build\Sard.exe` (~25MB) + the Piper engine.
- Key PDF harnesses: `pdf-acceptance.mjs` (the interaction suite), `pdf-zoom-theme.mjs`,
  `pdf-stress.mjs`, `pdf-hostile.mjs`, `pdf-corrupt-open.mjs`, `pdf-tts.mjs`,
  `pdf-text-layer.mjs`, `library-audit.mjs`. Results are the sibling `*-result.json` files.

---

## 14 · Operating model for a new session

1. Read this document, then `HANDBOOK.md` §3 (evidence) and `WORKFLOW.md`.
2. `git status` / `git branch` before anything.
3. Verify the `commit-msg` hook exists.
4. Reproduce before hypothesising; instrument before changing architecture.
5. **Suspect the instrument first** when a measurement contradicts a strong expectation (§6).
6. Smallest correct change; verify against the **real binary**, not the intention.
7. Separate Sard defects from file/environment defects with evidence.
8. Label findings PROVEN / DISPROVEN / UNVERIFIED. Never upgrade an UNVERIFIED to a claim.
9. Product/UI/UX changes need owner approval; verification does not.
10. Report faithfully: quote failing output, name skipped steps, state finished work plainly.

---

## 15 · Session handoff (exact stopping point)

- **Branch** `develop` · **HEAD** `da891b5 Repository maintenance`
- **Working tree** 37 entries — **uncommitted**. Modified: `Reader.tsx`, `ReaderChrome.tsx`,
  `SettingsPanel.tsx`, `ar.ts`, `en.ts`, `FoliateController.ts`, `global.css`. New:
  `src/lib/pdfText.ts`, `src/reader-engine/pdfView.ts`, three audit reports, and the PDF harnesses.
- **Build** `test-build\Sard.exe` built 2026-08-07T19:47 and current with the source.
- **Tests** 376/376 unit tests pass; typecheck clean.
- **Completed and verified this session:** full-library audit; UX endurance + leak disproof; PDF
  stress + hostile-file handling; PDF zoom (re-render, containment, scroll interaction); 8 PDF themes
  scoped to the page; PDF geometry proven against pdf.js.
- **Stopped because:** context exhausted mid-investigation of why PDF TTS produces no audio, after the
  second instrumentation attempt failed and was voided rather than reported.
- **Must not be forgotten:** the theme lives *inside the page iframe*; `display:block` on
  `foliate-view` breaks geometry; the audio failure point is genuinely **unknown**.

---

## 16 · Knowledge outside the repository

`M:\ProjectDocs\sard\` (docs vault — read `STATE.md` first; note it is stale as of 2026-08-04, orient
from `PROJECT_MASTER_SUMMARY.md`), `M:\Sard Desktop\` (39 ADRs, cross-platform stage),
`M:\Sard Mobile\` (44 docs, paused), `C:\Users\Administrator\.claude\CLAUDE.md` (global policy),
`%APPDATA%\com.sard.app\` (the real library — 39 books — and `sard.db`), local git hooks
(`commit-msg`, `pre-push`) which are **not** version-controlled.

**No credentials, tokens or keys are recorded here, and none should be.** The vault contains a
`Secrets\` directory — its *existence* is recorded; its contents must never be transcribed here.

---

## 17 · Tooling, environment, and where things belong

**The full inventory lives in `docs/engineering/WORKFLOW.md` → "Tooling inventory"** — every script,
harness and utility with purpose, invocation, dependants and category. It is not duplicated here.

**Category boundary that must not be blurred.** The vault's `M:\ProjectDocs\sard\Tools\README.md`
states that nothing in it builds, runs, tests or packages Sard — it is throwaway tooling that was
moved *out* of the repository in the 2026-08-03 cleanup. The harnesses in `tests/harness/` are the
opposite: **OFFICIAL workflow tooling, version-controlled on `develop`, invoked by npm scripts.**
Do not relocate them to the vault.

| Category | Meaning | Location |
|---|---|---|
| OFFICIAL | build / verify / release workflow | `scripts/`, `tests/` (repo, `develop`) |
| EVIDENCE | generated measurements and narrative reports | `tests/harness/*-result.json`; vault `Reports\`, `Evidence\` |
| THROWAWAY | produced one answer, no ongoing role | vault `Tools\` |
| LOCAL | machine state git cannot carry | `.git/hooks/`, git config |

**Workflow document destination (verified).** `docs/engineering/WORKFLOW.md` was copied to the vault:

```
M:\ProjectDocs\sard\WORKFLOW.md          614 lines · 35,340 bytes · written 2026-08-07
```

The repository copy remains authoritative and is the one to edit; the vault copy is the durable
out-of-repo mirror for sessions that start from the documentation vault. **Re-copy after any edit** —
there is no automation keeping them in sync.

**Environment requirements.** Windows 10/11 with WebView2; Node (npm scripts, ESM harnesses); Rust
toolchain for `src-tauri`; the real reading profile at `%APPDATA%\com.sard.app\` (39 books, `sard.db`)
which harnesses snapshot and restore. Harnesses need a **current** `test-build\Sard.exe` and each uses
its own CDP port (9900–9938 are in use) — two harnesses must not share a port concurrently.

---

## 20 · NEW SESSION START HERE

**CURRENT STATE** Sard 1.1.0 on `develop`, HEAD `da891b5`, **44 uncommitted changes** (the count grows
as reports and harnesses land — verify with `git status`, do not trust this number). PDF zoom, geometry
and themes are finished and proven. **PDF read-aloud WORKS** — it plays audio and advances through
sentences.

**CURRENT GOAL** Fix the text-layer accumulation defect (Stage 1 below), then add sentence highlighting.

**LAST VERIFIED FACT (2026-08-08)** On رسالة الغفران, read-aloud reached `status=playing`,
`readyState=4`, `paused=false`, `isBlob=true`, sentence index **0→2 of 5**, `underruns=0`,
`abandoned=0`, `lastFailure=null`. EPUB was run as a control in the same session and also played.
Edge reachable: **322 voices, 32 Arabic**.

**THE PREVIOUS BLOCKER IS CLOSED.** "No audio" was an instrument defect — `querySelectorAll('audio')`
cannot see a pool built with `new Audio()` and never attached to the DOM, and
[`tts.ts:930`](../../src/lib/tts.ts) says so in the source.

**FIXED 2026-08-08 — vendored patch 10.** `public/foliate-js/pdf.js` now calls
`container.replaceChildren()` before `textLayer.render()`, mirroring the image path two lines above.
Unbounded growth is gone: worst case **329 spans / 7 copies / 35 units → 94 / 2 / 10**, and a
numeric→numeric zoom step is exactly clean (47 spans, 5 units) on every run.

**ALSO FIXED 2026-08-08 — vendored patch 11.** The residual race is closed: a per-document render
generation (`WeakMap` keyed by the page document) plus three staleness checks, and the
`streamTextContent()` await hoisted out of the `TextLayer` options literal so clear→construct→append
are adjacent. **Both patches are required and must travel together:** with only 10 the layer doubles on
every fit-mode transition; with only 11 it grows without bound.

**MEASURED GREEN** 4 cycles of fit-page→2→3→4→fit-page with varied settle times (16 samples) **plus** a
hostile burst of four zoom changes 120 ms apart: every sample **47 spans / 5 units / headRepeats 1 /
layerCount 1**. Read-aloud after the cycling: **total 5 units**, `playing`, `readyState=4`,
`underruns=0`, `abandoned=0`, `lastFailure=none`. Zero violations.

**NO CURRENT BLOCKER.** PDF read-aloud works and the page is spoken exactly once after any zoom.

**NEXT ACTION (needs approval)** Sentence highlighting — §8's revised design. Then the O5 attribution
(cold PDF 18.0 s vs cold EPUB 7.0 s; PDF units average 148 chars) and the UX copy in
`PDF_TTS_INVESTIGATION.md` §8.

**FULL EVIDENCE** `PDF_TTS_INVESTIGATION.md` (repo root) — verdict, PROVEN/DISPROVEN/UNVERIFIED table,
PDF-vs-EPUB pipeline comparison, root cause, highlighting design, failure cases, UX, staged plan.

**INSTRUMENTS — use these, never a DOM `<audio>` query** `window.__sardTtsStats()`,
`window.__sardTtsStore.getState()`, `window.__sardPdfTts(lang)`, `window.__sardTrackStats(lang)`.
The last two only exist while a book is open (they are registered by `Reader.tsx`).

**IMPORTANT FILES** `src/reader-engine/FoliateController.ts` (`pdfPageUnits`, `getChapterUnits`,
`setPdfTheme`, `pageByWheel`), `src/lib/pdfText.ts`, `src/lib/tts.ts`, `src/features/reader/
TtsPlayer.tsx`, `public/foliate-js/pdf.js`, `fixed-layout.js`.

**IMPORTANT DOCUMENTS** this file, **`PDF_TTS_INVESTIGATION.md`**, `WORKFLOW.md` (process **+ the full
tooling inventory**), `HANDBOOK.md` (method), `LIBRARY_COMPATIBILITY_AUDIT.md`,
`UX_AND_PDF_STRESS_AUDIT.md`, `PDF_FEATURES_RAWY-291.md`. Out-of-repo mirror:
`M:\ProjectDocs\sard\WORKFLOW.md`.

⚠ **BEFORE ANY READ-ALOUD PROPOSAL** the vault mandates two documents this handoff previously omitted:
`M:\ProjectDocs\sard\LISTENING-OUTCOMES.md` (**Layer 1 governing document** — outcomes O1–O8,
constraints C-1…C-6, and §7's seven questions every proposal must answer; a proposal that opens with an
architecture instead of a listener perception is *returned unread*) and `TTS-ROADMAP.md` (read before
touching TTS code). `LESSONS.md` too, before any live UI verification.

**BEFORE THE FIRST COMMIT** confirm `.git/hooks/commit-msg` and `pre-push` exist and that
`git config --get remote.origin.push` returns `refs/heads/main:refs/heads/main`. They are local and a
fresh clone will not have them.

**IMPORTANT COMMANDS**
```
npm run build:test                       # build test-build\Sard.exe
npm test                                 # 376 unit tests
node tests/harness/pdf-acceptance.mjs    # the PDF interaction suite
node tests/harness/pdf-tts.mjs           # PDF read-aloud extraction quality
```

**IMPORTANT RULES** No AI/tooling references anywhere. Housekeeping commits = `Repository
maintenance`. Never push `develop` to `origin`. Product/UI changes need approval. Label every claim
PROVEN / DISPROVEN / UNVERIFIED.

**DO NOT** port the EPUB overlayer to PDF blindly · set `display: block` on `foliate-view` · move the
PDF theme back onto `.page-host` · use `node -e` for code containing backticks or Windows paths ·
report unverified work as complete.

**DO NOT ASSUME** that the updater works · that EPUB TTS internals behave as expected for PDFs · that a
harness result is right before the instrument has been attacked · that a file's defect is Sard's.

---

## 21 · Handoff verification

**Checked directly against the machine and repository while writing:**

- `git branch -a` → `develop` (current), `main`, `origin/main`, `private/develop`, `private/main`. ✔
- `git log --oneline -5` → HEAD `da891b5 Repository maintenance`. ✔
- `git remote -v` → `origin` = public `Sard.git`, `private` = `Sard-develop.git`. ✔
- `git status --porcelain` → 37 entries; the modified/new files listed in §15 are the real ones. ✔
- Version `1.1.0` in both `package.json` and `src-tauri/Cargo.toml`. ✔
- `docs/engineering/` contains `HANDBOOK.md` and `WORKFLOW.md`; this file added there. ✔
- `.github/workflows/` contains exactly one file, `release.yml`; its `v*` tag trigger and its three
  refusal steps were read in the file. ✔
- `scripts/` contents listed in §12–13 verified by directory listing. ✔
- `tests/harness/` contains 54 `.mjs` harnesses. ✔
- `npm test` → 376 passing in 26 files. ✔
- Root reports (`LIBRARY_COMPATIBILITY_AUDIT.md`, `UX_AND_PDF_STRESS_AUDIT.md`,
  `PDF_FEATURES_RAWY-291.md`) exist. ✔

- Vault structure read directly: `Tools\` (with its README stating it is throwaway, non-build
  tooling), `Reports\`, `Evidence\`, `DB-Snapshots\`, `Corpus\`, `Secrets\`, `STATE.md`,
  `DECISIONS.md`, `LESSONS.md`, `ENGINEERING-CONTRACT.md`, `HISTORY.md`. No workflow document existed
  there before this task. ✔
- `WORKFLOW.md` copied to `M:\ProjectDocs\sard\WORKFLOW.md` and confirmed by re-reading the
  destination: 614 lines, 35,340 bytes, correct first lines. ✔
- The 37 npm scripts were enumerated from `package.json`; the tooling inventory records the real
  script names and their invocations, not assumed ones. ✔
- Local hooks present: `.git/hooks/commit-msg` **and** `pre-push` both exist on this machine. ✔
- `remote.origin.push` = `refs/heads/main:refs/heads/main` — pinned to main-only, as documented. ✔
- External paths all exist: `M:\ProjectDocs\sard`, `M:\Sard Desktop`, `M:\Sard Mobile`,
  `C:\Users\Administrator\.claude\CLAUDE.md`. ✔

**Not verified while writing this document (stated as such above):**

- The internals of the TTS scheduler/queue/audio layer — **not inspected this session**. This is the
  single largest gap in this handoff and is exactly where the open blocker lives.
- Whether CI's `latest.json` superseded the hand-uploaded one, and updater reliability generally.
- The *contents* of the external vaults were not re-read, only their existence confirmed.

**No product code was changed by this task.**
