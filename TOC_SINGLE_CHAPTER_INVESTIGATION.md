# Investigation — "only one chapter in the Contents", and the black reading area

| | |
|---|---|
| **Type** | Investigation report. **No code was changed.** |
| **Date** | 2026-08-06 |
| **Tree** | `M:\eRawy`, working tree on `main` @ `dd23765` **with the uncommitted RESILIENCE-1 / WP work applied** |
| **Binary measured** | `M:\eRawy\test-build\Sard.exe`, built 2026-08-06 00:27 |
| **Reported books** | `M:\روايات\Infinite Mana in The Apocalypse.epub`, `M:\روايات\The_Villain_Wants_to_Live.epub` |
| **Method** | Independent file measurement (`tests/lib/epub-read.mjs`), source trace, and five CDP runs against the real binary under the harness snapshot/restore contract. The live profile was snapshotted before every run and restored after; verified intact afterwards (28 books, 26 progress rows, unchanged). |

Everything below is labelled **MEASURED** (an observation), **PROVEN** (a conclusion that follows from
measurements plus code that was read), or **UNKNOWN** (honestly not established).

---

## 0. Summary

The "one chapter" symptom has a single, fully-proven root cause, and it is **not a race condition**. It is a
deterministic two-phase publication of the Contents list:

1. Both books ship an EPUB 3 navigation document containing **exactly one** entry (`"Start"`), *and* an NCX
   containing the real 2,963 / 362 chapters. foliate reads the nav document first and **never falls back to
   the NCX once the nav document parses**. So `book.toc.length === 1`, permanently, for the whole session.
2. Sard's WP-6A recovery notices this (the book is flagged `toc_degenerate` in the database), walks the whole
   spine asynchronously, and **replaces** the panel's list when it finishes. Until it finishes, the panel
   honestly shows the one entry the book gave.

**MEASURED** on this machine: the swap lands **907 ms** after open for the 364-section book and **5,037 ms**
after open for the 2,964-section book. Cost scales linearly with spine length (~1.7–2.5 ms per section), so
the "few seconds" is a direct function of chapter count and machine speed. That is the whole of the observed
delay.

Two further defects were found on the same path, both **MEASURED live**:

- **Every row of the synthesised Contents list is dead.** Clicking one does nothing at all. The navigation
  call passes an argument shape foliate cannot resolve.
- **No row is ever marked as the current chapter**, and the panel never scrolls to it. In a 2,963-row list
  that means it always opens at chapter 1.

On the **black page**: it did **not** reproduce here on either book, at any section sampled. It is **PROVEN
not to be downstream of the TOC problem** — the two are on code paths that never meet. Its actual cause is
**UNKNOWN** and cannot be settled from this machine; §6 lists what was eliminated and the exact measurements
needed on the affected machine.

---

## 1. What the two files actually are — MEASURED

Measured with `tests/lib/epub-read.mjs`, the project's deliberately independent reader.

| | Infinite Mana | The Villain Wants to Live |
|---|---|---|
| EPUB version | 3.0 | 3.0 |
| Generator | `Ebook-lib 0.18.1` + `Sigil 2.0.2` | `Ebook-lib 0.18.1` + `Sigil 2.0.2` |
| `dc:language` | `ar` | `ar` |
| `page-progression-direction` | **absent** | **absent** |
| Spine itemrefs | **2,964** | **364** |
| Spine refs resolving to a manifest id | 2,964 (all) | 364 (all) |
| **Entries in the EPUB 3 nav document** | **1** | **1** |
| **navPoints in the NCX** | **2,963** | **362** |
| Stylesheet (`.css`) files | **0** | **0** |
| Content docs with a `<style>` block | 0 of 200 sampled | 0 of 200 sampled |
| Section size, median | 10,644 B | 22,937 B |
| Section size, max | 26,864 B | 48,113 B |

Both books' `nav.xhtml` is identical in shape:

```xml
<nav epub:type="toc" id="toc" role="doc-toc">
  <h1>Table of Contents</h1>
  <ol>
    <li><a href="chapter_1269.1.xhtml">Start</a></li>   <!-- Villain: Section0001.xhtml -->
  </ol>
</nav>
```

That is Sigil's placeholder nav. The real contents live in `EPUB/toc.ncx`, which both books carry in full.

Two incidental **MEASURED** facts:

- The Villain's single nav entry points at `Section0001.xhtml`, **which does not exist in the archive**.
  Infinite Mana's target (`chapter_1269.1.xhtml`) does exist.
- Spine index 0 of both books is `cover.xhtml`, marked `linear` (default yes) — see §6.

**PROVEN:** this is not a Sard-specific quirk of two files. It is one publisher's export pipeline. A third
book already in the library, *Kingdom's Bloodline*, carries the same `toc_degenerate = 1` flag; any book from
that source will behave identically.

---

## 2. Why the Contents list has one entry — PROVEN

`public/foliate-js/epub.js:1009-1026`:

```js
const { navPath, ncxPath } = this.resources
if (navPath) try {
    const nav = parseNav(await this.#loadXML(navPath), resolve)
    this.toc = nav.toc            // <-- an array of ONE item: truthy
    ...
} catch(e) { console.warn(e) }
if (!this.toc && ncxPath) try {   // <-- never entered: this.toc is truthy
    const ncx = parseNCX(await this.#loadXML(ncxPath), resolve)
    this.toc = ncx.toc
    ...
}
```

The NCX is consulted **only when the nav document produced nothing at all**. A nav document that parses
successfully and yields one useless entry wins over an NCX with 2,963 correct ones. There is no fallback on
*quality*, only on *absence*.

**MEASURED live** (§3): `view.book.toc.length === 1`, label `"Start"`, from the moment the book loads until
the book is closed. It is **never** repaired — not before the synthesis, not after.

Sard's Rust import layer deliberately mirrors that same order, so that its flag means what will happen on
screen — `src-tauri/src/books/mod.rs:357-368`, nav first, NCX second, documented as
*"Follows the SAME order foliate does at render time"*. It then applies `compat::toc_degenerate`
(`src-tauri/src/books/compat.rs:394-400`): fewer than 10 % of the spine reachable, floor of 3 entries.
1 < max(3, 296) and 1 < max(3, 36) → both flagged.

**MEASURED** from the live database (`%APPDATA%\com.sard.app\sard.db`, read-only):

```
The Villain Wants to Live        toc_degenerate=1  spine_fragmented=0  script_detected=arabic
Infinite Mana in The Apocalypse  toc_degenerate=1  spine_fragmented=0  script_detected=arabic
```

Migrations `15:book_compat` and `16:book_compat_backfill` are both recorded; `user_version = 16`.

---

## 3. The complete loading pipeline, and every asynchronous step

`Reader.openBook()` — `src/features/reader/Reader.tsx:334-660`. Awaits, in order. `stale()` (line 321) is
checked after each one and abandons the open if a newer one has superseded it.

| # | Step | Async | Notes |
|---|---|---|---|
| 1 | runtime pre-flight `canRender("epub")` | no | WP-1; refuses before attempting |
| 2 | `bookRegister(id, path)` | **await** | |
| 3 | `bookGet(id)` → `resolveBookMeta(row)` | **await** | **this is where `tocDegenerate` comes from** |
| 4 | `progressGet(id)` | **await** | yields `resumeCfi` |
| 5 | `loadBookCssMode()` | **await** | WP-7 stage 3 |
| 6 | `loadGlobalStyle(dir)` | **await** | |
| 7 | `loadBookOverride(id)` | **await** | |
| 8 | `Promise.all` × 4 settings (`chapters_read`, `seen_start`, `spoiler_safe`, `pdf_invert`) | **await** | |
| 9 | `ctrl.onRelocate(...)` registered | no | deliberately after 8 (RAWY-285) |
| 10 | `applyTheme(...)` | no | |
| 11 | **`ctrl.open(url, stage, opts)`** | **await** | see below |
| 12 | `set({ status: "ready", ... })` | no | **the reader is declared readable HERE** |
| 13 | `setToc(ctrl.getToc())` | no | **publishes the book's own 1-entry TOC** |
| 14 | `setTocSecMap(ctrl.tocHrefSectionMap())` | no | built from the same 1-entry TOC |
| 15 | `if (meta?.tocDegenerate) void ctrl.getSynthesisedToc().then(setToc…)` | **fire-and-forget** | **not awaited** |

Inside `ctrl.open()` — `src/reader-engine/FoliateController.ts:1463-1861`:

| | Step | Async |
|---|---|---|
| a | `dispose()` + `ensureFoliateDefined()` | **await** |
| b | `view.open(source)` — fetch, format detect, dynamic import, **OPF + nav/NCX parse** | **await** |
| c | flow attribute, `ensureCfiCompare()` | **await** |
| d | `relocate` / `load` listeners registered | no |
| e | `reinject()` — the geometry stylesheet via `renderer.setStyles` | no |
| f | `view.goTo(resumeCfi)` / `goToFraction(0)` / `renderer.next()` — **first paint** | **await** |

**PROVEN:** by the time step 12 declares the book ready, step (b) has already finished, so `book.toc` is
final and known to be 1. Nothing renders before the spine and navigation are parsed — foliate does not begin
rendering until (f), and (b) has completed by then. **There is no "render before navigation loaded" defect.**

Step 15 is the whole delay — `getSynthesisedToc()`, `FoliateController.ts:2509-2536`:

```ts
for (let i = 0; i < sections.length; i++) {
  const sec = sections[i];
  if (sec?.linear === "no") continue;
  doc = await sec.createDocument();                        // unzip + XML parse, per section
  const h = doc?.body?.querySelector("h1,h2,h3,h4,h5,h6");
  material.push({ heading: ... });
  if (material.length % UNITS_CHUNK === 0) await breathe(); // yield every 24 sections
}
this.synthToc = synthesiseToc(material, spineIndex);
```

`UNITS_CHUNK = 24`, `breathe = () => new Promise(r => setTimeout(r, 0))`
(`FoliateController.ts:1270-1271`). `sec.createDocument()` is `epub.js:1046-1049` —
`loadText(href)` then `parseFromString`. So the cost is **one zip-inflate plus one XML parse per linear
section**, 2,963 of them for Infinite Mana, deliberately yielded to the event loop so the window stays
responsive.

### 3.1 The measured timeline

Real binary, CDP, 1100×720 window, reading style `zoom: 2`, `lineHeight: 2.1`, `fontWeight: 700`.
`t = 0` is the click on the library card.

**The Villain Wants to Live — 364 sections**

```
t =    87 ms   reader mounted, no view yet
t =   483 ms   view + book present · book.toc = 1 ("Start") · sections = 364 · panel rows = 1
t =  1390 ms   panel rows = 363 · "synthesised" note shown        <-- the swap
```

**Infinite Mana in The Apocalypse — 2,964 sections**

```
t =    10 ms   reader mounted
t =   162 ms   view element created, book not yet parsed
t =   331 ms   view + book present · book.toc = 1 ("Start") · sections = 2964 · panel rows = 1
t =  5368 ms   panel rows = 2963 · "synthesised" note shown       <-- the swap
```

| | sections | book readable at | contents complete at | window with 1 entry | per section |
|---|---|---|---|---|---|
| Villain | 364 | 483 ms | 1,390 ms | **907 ms** | 2.50 ms |
| Infinite Mana | 2,964 | 331 ms | 5,368 ms | **5,037 ms** | 1.70 ms |

`book.toc.length` stayed `1` in every sample of both runs. Only the panel's React state is replaced.

The project's own harness already encodes this knowledge: `tests/harness/toc-shape.mjs:224` sleeps 2,500 ms
before reading the panel, commented *"the spine walk runs off the critical path, after the book is
readable"*.

---

## 4. Answers to the specific questions asked

**Why do these EPUBs initially expose only a single chapter?**
Because that is genuinely all the book offers through the route foliate uses (§2). Sard reports it faithfully
at step 13 and repairs it later at step 15.

**How does Sard discover and build the TOC for this type of EPUB?**
Two independent mechanisms. (1) `getToc()` = `flattenToc(view.book.toc)` — a pure synchronous read of what
foliate parsed (`FoliateController.ts:2492-2494`). (2) When the database row says `toc_degenerate`, WP-6A
walks the linear spine and takes each section's first `h1`–`h6`, or a number when it has none
(`tocSynth.ts`). The decision to run (2) is made from a **stored** flag computed at import time, never
re-derived at open.

**Is TOC construction asynchronous?**
The book's own TOC: **no** — synchronous, complete before the reader is declared ready.
The synthesised TOC: **yes** — an unawaited promise over 2,963 `await`s plus 123 event-loop yields.

**Does the reader render before the spine/navigation has finished loading?**
**No.** Proven in §3: `view.open()` completes the OPF, nav and NCX resolution before any `goTo`, and `goTo`
is what triggers the first paint.

**Is there a race condition?**
Not in the sense of two orderings competing. The publication is deterministic: 1 entry, then N entries.
There is one genuine **supersession** guard — if a second `openBook` starts while the walk is running,
`stale()` (line 601) discards the result, correctly. The three ways the second phase can silently never
arrive are listed in §5; none of them is a timing race.

**Does the behaviour depend on device speed?**
**Yes, entirely, and measurably.** 1.7–2.5 ms per section on this machine, on the main thread, yielding every
24 sections. A machine 3× slower spends ~15 s on Infinite Mana; 5× slower, ~25 s. Nothing bounds it and
nothing reports progress, so a slower machine is indistinguishable from a broken one for as long as it takes.

**Could this explain why another machine permanently shows one chapter while mine recovers?**
Yes — see §5. There are four mechanisms, and the first is by far the most likely.

---

## 5. Why one machine can stay at one chapter forever

Four paths, in descending order of likelihood.

### 5.1 That machine is running a build without the recovery — MEASURED, decisive

**MEASURED:** `git cat-file -p HEAD:src/reader-engine/tocSynth.ts` → *"exists on disk, but not in `HEAD`"*.
The whole RESILIENCE-1 work — `tocSynth.ts`, `compat.rs`, migration `0015_book_compat.sql`, `runtime.ts`,
`cssSanitiser.ts`, the WP-6A block in `Reader.tsx` — is **uncommitted working-tree work**. `HEAD` is
`dd23765`, the v1.1.0 release.

**PROVEN:** the shipped `Sard_1.1.0_x64-setup.exe` contains **no synthesised-TOC recovery, no
`toc_degenerate` column and no compatibility layer at all**. On it, `setToc(ctrl.getToc())` runs once with
foliate's 1-entry answer and nothing ever replaces it. The Contents panel shows one row, for ever, on any
machine, at any speed.

⚠ **`package.json` and `tauri.conf.json` both still say `1.1.0`.** The dev build and the release are
indistinguishable by version string, in the UI and in a bug report. Asking the user "what version" cannot
separate these two cases.

### 5.2 The book's row has no flag — PROVEN reachable

`src/lib/bookMeta.ts:73` — `tocDegenerate: row.toc_degenerate === 1`. **`NULL` becomes `false`.** A row is
`NULL` when the book was imported before migration 15 and migration 16's backfill has not (yet) succeeded.
That backfill is deliberately failure-tolerant (`src-tauri/src/db/migrations.rs:176-209`): a panic or an error
is caught, logged, and *deferred to the next launch* — and it needs the original file under `library/`
(`books/mod.rs:846`, *"the whole `library/` folder is gone"* case). A row that never gets examined never gets
recovered, silently.

### 5.3 The metadata read failed — PROVEN reachable

`Reader.tsx:386-390`:

```ts
let meta = await bookGet(target.id).then(row => row ? resolveBookMeta(row) : null).catch(() => null);
if (!meta && (target.title || target.author)) meta = hintMeta(target.id, target.title, target.author);
```

`hintMeta` returns `tocDegenerate: false` (`bookMeta.ts:96`). So **any failure of that one IPC call
downgrades the book to "no recovery", permanently, with no user-visible sign** — the book still opens, which
is the deliberate design for the *title*, but it silently also disables the Contents repair.

### 5.4 It is still running

At 1.7–2.5 ms/section on a fast machine, a slow machine can spend 15–25 s on a 2,964-section book with **no
progress indication of any kind**. A user who opens the panel, sees one chapter and closes the book has
observed exactly the reported symptom without anything being broken.

---

## 6. Two further defects on the same path — MEASURED live

### 6.1 The synthesised Contents list cannot navigate. At all.

A synthesised row carries `href = "sard-section:" + index` (`Reader.tsx:82, 611`). The jump handler routes it
to `goToSection` (`Reader.tsx:1737-1738`), which is:

```ts
goToSection(index: number) { return this.view?.goTo?.({ index, anchor: 0 }); }   // :2539-2541
```

foliate's `resolveNavigation` (`public/foliate-js/view.js:446-459`) accepts **a number**, an object with a
numeric `fraction`, a CFI string, or an href string. An `{index, anchor}` object matches none of them and
falls through to `book.resolveHref(target)`, which calls `.split` on an object.

**MEASURED**, real binary, The Villain Wants to Live:

```
A. view.goTo({index:40, anchor:0})   -> returned null      section stayed 1
   console.error: "href.split is not a function or its return value is not iterable"
                  "Could not resolve target [object Object]"
                  "Cannot read properties of undefined (reading 'index')"
                  "Could not go to [object Object]"

B. view.goTo(40)                     -> returned {"index":40}   section became 40

C. clicked Contents row[100] ("الفصل 101")  -> section 40 -> 40   *** NO NAVIGATION ***
   console.error: the same four lines
```

**PROVEN:** every row of the recovered Contents list is inert. The panel appears to work — it fills with
2,963 correctly-numbered chapters — and clicking any of them does nothing, silently, because the failure is
swallowed by `goTo`'s own `try/catch` and DevTools are disabled in release builds. `view.goTo(index)`, the
bare number, is correct and works.

### 6.2 No row is ever the current chapter

`tocSecMap` is built **once**, from the book's own 1-entry TOC (`Reader.tsx:594`), and is never rebuilt when
the synthesised list replaces `toc`. `tocIndex` (`Reader.tsx:1491-1501`) therefore fails both of its routes:
`chapterHref` from foliate is a real document href and can never equal `sard-section:N`, and
`tocSecMap.get("sard-section:N")` is `undefined` for every row.

**MEASURED**, The Villain Wants to Live, Contents open, reading section 1:

```
bookTocLen: 1     sections: 364     panelRows: 363     synthesised: true
activeRowIndex: -1        panelScrollTop: 0
submeta: "363 فصلًا · قُرئ 0٪"
chrome chapter label: "القراءة"        (reader.chapterFallback — the generic word "Reading")
```

**PROVEN:** with a synthesised list there is no active-row highlight, the RAWY-103 scroll-to-active finds
nothing and leaves the panel at row 1, and the reading chrome shows the fallback word instead of a chapter
name for the entire book.

---

## 7. The black reading area

### 7.1 It did not reproduce here — MEASURED

Both books were opened in the real binary and driven to sections 0, 1, 2, 100, 200, 363 (Villain) and
0, 1, 2, 1000, 2000, 2900 (Infinite Mana). Every one rendered text. Screenshots captured. Representative
sample, Infinite Mana section 1:

```
bodyBg:  rgb(0, 0, 0)        <- the True Black theme's paper
bodyColor: rgb(207, 200, 186)
textLen: 6555   textHead: "الفصل 1: الإيقاظ مانا اللانهائية في نهاية العالم …"
injected paint sheet present: :root:root body:not(#__sard_never__) *:not(a) { color: #CFC8BA !important }
```

### 7.2 What is eliminated, with evidence

| Candidate | Status |
|---|---|
| **The book's own CSS** | **ELIMINATED.** Both EPUBs contain **zero** `.css` files and zero `<style>` blocks (200 documents sampled each). There is no stylesheet in either book that could paint anything. |
| **A malicious/odd script in the book** | **ELIMINATED.** The book iframe never receives `allow-scripts` (D30), and neither file contains a script. |
| **Sard's injected paint** | **ELIMINATED for these books.** The only way `injectedCss.ts` can leave ink equal to paper is if the book's own CSS overrides a non-`!important` colour — and the branch that emits a non-forced ink (`themeBlock`, `injectedCss.ts:497`) is only reached on a light theme, where the paper is light. On a dark theme `forceBg` is true and the ink is `!important` (`:483-484`, `:861-865`). Measured above: black paper, `#CFC8BA` ink, text visible. |
| **An open failure** | **ELIMINATED.** A failed open renders a visible themed error card (`reader-error-overlay`, present in both v1.1.0 and the current tree), not a silent black area. |
| **Downstream of the TOC problem** | **ELIMINATED — this is the question you asked me to prove.** See 7.3. |

### 7.3 PROVEN: the black page is not caused by the TOC loading problem

Three independent arguments:

1. **The synthesis cannot touch what is on screen.** `getSynthesisedToc()` (`FoliateController.ts:2509-2536`)
   does exactly three things: `sec.createDocument()` (which returns a *detached* `Document` built by
   `DOMParser` — `epub.js:1046-1049` — never attached to the view, never rendered), a `querySelector` on it,
   and a push into an array. The result reaches only `setToc` / `setSynthNote`, two pieces of React state
   consumed solely by `ChaptersPanel`. It never touches the rendered document, the injected stylesheets, the
   overlayer, the renderer, or `view`.
2. **It starts after the page is already painted.** `status: "ready"` is set at `Reader.tsx:584`; the
   synthesis is dispatched at `:599`. Measured: the book was rendered and readable at t = 331 ms; the walk
   finished at t = 5,368 ms. The screen is complete before the walk begins.
3. **The symptom survives without the code.** On the released v1.1.0 the synthesis does not exist (§5.1) —
   yet the black page is reported there. A symptom that persists where the suspected cause is absent is not
   caused by it.

They are **correlated, not causal**: both symptoms appear on the same books because both books come from one
publisher's export pipeline, so a reader who has one has the other.

### 7.4 What is NOT eliminated — UNKNOWN

Three candidates survive. All three are properties of the *affected machine*, not of the files, which is why
they cannot be settled from here.

**(a) Rasterisation of a very tall section.** MEASURED, at the current reading settings (zoom 2), one chapter
renders as an iframe this tall in scrolled flow:

```
Villain        sec 1: 29,917 px    sec 100: 31,126 px    sec 200: 20,622 px
Infinite Mana  sec 1: 11,814 px    sec 2000: 10,252 px   sec 2900: 11,915 px
```

Those are unusually large composited surfaces, and whether they rasterise is a function of the GPU, the
driver and whether WebView2 has fallen back to software rendering — none of which is in the file. A black
rectangle that ignores every CSS change is the classic signature of a compositing failure. **This is a
hypothesis with a motive, not a finding: there is no evidence for or against it on this machine.**

**(b) The WebView2 runtime.** WP-1 (`src/lib/runtime.ts`) documents that an older runtime lacking
`Object.groupBy` / `Map.groupBy` makes **no** EPUB open at all — that is a different symptom, so it is not
this. But the runtime version on the affected machine is still unrecorded, and v1.1.0 has no gate and no
report.

**(c) A per-book colour override on that machine.** `book_style:<id>` with both `pageColor` and `textColor`
set dark would produce exactly "black, no text, changing the *theme* does not help", because a per-book
override outranks the theme. A single settings read on that machine settles it.

### 7.5 One measured fact worth knowing before interpreting any report

**Spine index 0 of both books is a full-viewport cover page with essentially no text.** MEASURED at section 0:

```
media:   svg 919×1287  +  image 919×1287 (blob: URL — the cover art, resolved correctly)
textLen: 160 chars   ("تم صنعه بواسطة موقع ايجي بلس …" — the source site's advert)
docH: 1811   innerH: 1811   -> the advert text sits below the fold
```

A reader opening either book for the first time (no saved position) lands here — `goToFraction(0)`,
`FoliateController.ts:1859`. The first screen is the cover image and nothing else, and Sard's
chapter-boundary stop means **two** scroll gestures are needed to leave it. If the cover image fails to
decode on a given machine, that screen becomes an empty box painted with the theme's paper — which on the
True Black theme is `rgb(0,0,0)`, with no text on it, and changing the theme only changes the shade of an
empty box. **This is a candidate worth ruling in or out first because it is cheap to test**, not a
conclusion: here the cover renders correctly (screenshot captured).

---

## 8. An unrelated defect found while tracing — MEASURED

**WP-7 stage 3 is silently stripping every inline `style=` attribute from every book.**

`cssSanitiser.ts:219-221` returns `""` for mode `off` (the shipping default). The hook is installed at module
load (`FoliateController.ts:1273-1288`) and read by the vendored engine at the top of `replaceCSS`
(`epub.js:871-879`). But `replaceCSS` is called from **three** places, and one of them is not a stylesheet:

```js
for (const el of doc.querySelectorAll('[style]'))                       // epub.js:858-860
    el.setAttribute('style', await this.replaceCSS(el.getAttribute('style'), href, parents))
```

**MEASURED:** the cover's source markup is
`<div style="height: 100vh; text-align: center; padding: 0pt; margin: 0pt;">`; in the rendered document the
attribute is **empty**. Every chapter of both books is wrapped in
`<div dir="rtl" style="text-align: right;">`, and that declaration is being removed too.

The comment at `FoliateController.ts:1280-1282` states *"Until stage 4 opens the CSP no book stylesheet
reaches the frame at all, so this hook is currently reached only by sheets that are already inert"*. That is
**incorrect**: inline `style` attributes are attributes, never subject to the CSP, and applied in v1.1.0.
Stage 3 is therefore **not** byte-identical to v1.1.0, contrary to what the byte-identity gate is asked to
prove. Whether this is visible on any given book is a separate question — it is not the black page here,
since these books render — but the stated invariant does not hold.

---

## 9. How to reproduce every measurement

```
# structure of the two files (no app needed)
node <scratch>/probe.mjs          # spine/manifest/nav/NCX resolution, section sizes
node <scratch>/probe2.mjs         # cover markup, nav target existence, inline styles, images

# live, against the real binary — snapshots and restores the profile
node <scratch>/toc-timing.mjs     # §3.1 timeline + screenshots
node <scratch>/nav-probe.mjs      # §6.1 navigation proof + section 0
node <scratch>/size-probe.mjs     # §7.4(a) rendered chapter dimensions
node <scratch>/active-probe.mjs   # §6.2 active row / chrome label
```

Scripts are in
`<scratch directory>`.
They follow `tests/harness/`'s contract exactly: `snapshotDb` → `launchSard` → drive → `restoreDb`. The
profile was verified unchanged after the last run.

### To settle §7 on the affected machine, three readings are enough

1. **Which build is it?** The version string cannot tell you (§5.1). Check whether a Contents panel on a
   flagged book ever grows past one row, or whether the app has a "contents synthesised" note at all.
2. **`SELECT toc_degenerate FROM books WHERE title LIKE '%Villain%'`** on that machine's
   `%APPDATA%\com.sard.app\sard.db` — separates §5.1/§5.2 from §5.4.
3. **`SELECT value FROM settings WHERE key = 'book_style:<id>'`** — settles §7.4(c) outright.

---

## 10. Everything above, sorted

**MEASURED**
Both books: 1 nav entry vs 2,963/362 NCX navPoints; zero stylesheets; all spine refs resolve; cover at spine 0.
Both rows carry `toc_degenerate = 1`. `book.toc.length` stays 1 for the whole session.
Contents completes 907 ms (364 sections) / 5,037 ms (2,964 sections) after the book is readable; 1.7–2.5 ms per section.
A synthesised row click produces four console errors and no navigation. `activeRowIndex = -1`, panel scroll 0, chrome label "القراءة".
The WP work is not in `HEAD`. Chapters render 8,891–31,126 px tall. Inline `style` attributes arrive empty.

**PROVEN**
The single chapter is foliate's nav-before-NCX rule with no quality fallback, reported faithfully, then replaced by an unawaited spine walk.
Nothing renders before navigation is parsed; there is no render-before-ready defect and no competing-order race.
The delay is linear in spine length and unbounded on a slow machine, with no progress indication.
Four distinct paths leave a machine at one chapter permanently; the shipped v1.1.0 is one of them by construction.
The recovered Contents list is completely non-navigable and never marks the current chapter.
The black page is not downstream of the TOC problem — the paths never meet, and it starts after the page is painted.
The book files cannot themselves paint a black page: no CSS, no scripts.

**UNKNOWN**
The actual cause of the black page. Which build the affected machine runs. Its WebView2 version and GPU rasterisation behaviour. Whether a per-book colour override exists there. Whether the cover image decodes there.
