# Sard · Real-World EPUB Compatibility — Investigation

**Status:** Investigation only. Nothing implemented, nothing changed.
**Written:** 2026-08-04 · against `main` @ `dd23765` (v1.1.0)
**Scope:** the eight user-reported items, plus weaknesses found while investigating them.

---

## 0. How this was investigated

Per the Engineering Contract, every claim below is either **measured** or a **read of the source with the
file:line cited**. Where something is inferred it says so.

Evidence base:

| Source | What it gave |
|---|---|
| `M:\eRawy` @ `dd23765` | All code references. |
| The **real library** — `%APPDATA%\com.sard.app\sard.db` + `library\` — 14 EPUBs + 1 PDF | The offending book was still there. Every structural claim about it is read off the actual file. |
| **The offending EPUB itself**, unpacked | `content.opf`, `toc.ncx`, `stylesheet.css`, all 115 chapter files. |
| **A headless Chromium experiment** reproducing Sard's exact CSP + iframe model | Isolated the book-stylesheet defect to a single cause (§2.1). |
| **A compiled Rust check** of `str::trim` vs U+FEFF | Confirmed the mimetype-BOM rejection (§8.4). |
| MDN / caniuse browser-compat data | The Chromium floor for `Uint8Array.prototype.toHex`. |
| `M:\ProjectDocs\sard\OPEN.md`, `LESSONS.md` | The project's own prior measurement of the stylesheet defect. |

**The book in question is identified.** `books.id =
45182e1433d261b28f5f0a245501b0f1b0cdb334b9cf791710f06381c8722946`, 10,744,409 bytes, stored
`title='Unknown'`, `author='word'`, `language='en'`, `dir='rtl'`. It is **not** a Word EPUB —
it is a **Calibre 9.9.0 conversion** of a Word/HTML document:

```xml
<dc:contributor opf:role="bkp">calibre (9.9.0) [https://calibre-ebook.com]</dc:contributor>
<dc:title>Unknown</dc:title>
<dc:creator opf:file-as="word" opf:role="aut">word</dc:creator>
<dc:language>en</dc:language>          <!-- the body is Arabic -->
```

That distinction matters: the defects are **Calibre-conversion defects**, which is the single most
common way real-world EPUBs are produced, so the blast radius is much wider than "one bad file".

---

## 1. Findings at a glance

| # | Issue | Verdict | Severity | Other books affected? | Layer to fix |
|---|---|---|---|---|---|
| 1 | `UnknownErrorException: hashOriginal.toHex is not a function` | **Sard bug** (vendored PDF.js needs Chromium ≥ 140; Sard declares/checks no floor) | **P0 — critical** | **Every PDF**, on any machine with WebView2 < 140 | Rendering pipeline + build/release |
| 1b | An internal exception is printed verbatim to the user | **Sard bug** | **P0** | All failures of any kind | Core reader |
| 2 | Converted-EPUB fragility (the audit) | **Mixed** — see §2 | **P1** | Most Calibre/Word output | Import + rendering |
| 2.1 | **The book's own external CSS never enters the cascade** | **Sard bug — one missing CSP token** | **P1 — systemic** | **100 % of EPUBs, always** | `tauri.conf.json` + rendering |
| 3 | Title shows "Unknown" | **EPUB compatibility** (literal `dc:title`) — Sard's fallback ladder is one rung too short | **P2** | Any Calibre conversion with no source title | Import pipeline |
| 3b | Reader header ignores the user's own title override | **Sard bug** | **P2** | Every book with a title override | Core reader |
| 4 | Pagination unstable / inconsistent | **EPUB compatibility**, amplified by Sard | **P1** | Any finely-split conversion | Rendering + import |
| 5 | Nav button hidden behind the chapters panel | **Sard bug** | **P1** | **Every book**, page mode, default panel state | Rendering (CSS/layout) |
| 6 | Nav buttons stop responding | **Sard bug — three independent causes** | **P1** | Every book; worst on split books | Core reader |
| 7 | No page counter | **Missing feature** — the data is already computed and thrown away | **P2** | All EPUBs | Core reader |
| 8 | No compatibility layer | **Architectural gap** | **P1** | All imperfect EPUBs | New: import pipeline |

---

## 2. Issue 1 — `UnknownErrorException: hashOriginal.toHex is not a function`

### 2.0 Can it be reproduced? Which code path throws?

**Yes, deterministically — but only on a machine whose WebView2 runtime is older than Chromium 140.**

The exact throw site is in the vendored PDF.js worker:

`public/foliate-js/vendor/pdfjs/pdf.worker.mjs:59575`
```js
return shadow(this, "fingerprints", [hashOriginal.toHex(), hashModified?.toHex() ?? null]);
```

`hashOriginal` is **always** a `Uint8Array` — both branches above it produce one (`stringToBytes()` at
`pdf.worker.mjs:483`, or `calculateMD5()`). So the failure is not about the *value*; it is that
**`Uint8Array.prototype.toHex` does not exist** in the JS engine running it.

`Uint8Array.prototype.toHex` / `.toBase64` / `Uint8Array.fromBase64` are the TC39
`arraybuffer-base64` proposal. **Chrome and Edge shipped them in version 140** (September 2025);
Baseline marks the feature "newly available since September 2025". Sard vendors **PDF.js 5.5.207**,
which uses them unguarded in three places:

| File:line | Call | Reached when |
|---|---|---|
| `pdf.worker.mjs:59575` | `hashOriginal.toHex()` | **Every `getDocument()`** — every PDF, always |
| `pdf.mjs:7434` | `this.data.toBase64()` | Every embedded font that needs a `@font-face` rule |
| `pdf.mjs:24263`, `:24267` | `bytes.toBase64()`, `Uint8Array.fromBase64()` | Digital-signature handling |

The first one is on the unconditional open path, so **no PDF opens at all** below Chromium 140. The
error is wrapped by PDF.js's worker-message handler into `UnknownErrorException`, which is exactly
the class name the user saw.

**Measured on this dev machine:** WebView2 runtime `150.0.4078.105`, engine `Chrome/151.0.0.0`;
`typeof Uint8Array.prototype.toHex === "function"`. That is why the same build opens the 20 MB PDF
already in this library (`115cbc14…pdf`, which even has a saved cover and a title override — proof it
opened successfully here). The user's machine must be below 140.

### 2.1 Is it Sard or a malformed file?

**Sard.** A malformed PDF cannot produce this message — the failing line runs before any content is
parsed, and both of its input branches yield a `Uint8Array` regardless of file contents. The file is
irrelevant; the **runtime version** is the whole story.

The underlying defect is structural: **Sard has no declared minimum WebView2 version, no runtime
check, and no build-time floor.**

- `vite.config.ts` sets no `build.target`; there is no `browserslist` key in `package.json`.
- The vendored engines live in `public/`, so Vite never transpiles or even inspects them.
- Tauri's default NSIS `webviewInstallMode` installs the Evergreen runtime **only when it is
  missing** — it never *upgrades* an existing older one. A machine with a 2024-era WebView2 and
  auto-update disabled by policy (very common on managed/LTSC/Server Windows) stays there forever.

There is a **second, lower floor** that affects EPUBs too: `public/foliate-js/epub.js:178`, `:200`,
`:206`, `:258` use `Object.groupBy` / `Map.groupBy` in the OPF metadata parser — **Chromium ≥ 117**
(September 2023). Below that, *no book of any kind* opens.

So Sard's real, undeclared floor today is: **Chromium 117 for EPUB, Chromium 140 for PDF.**

### 2.2 Why does an internal exception reach the UI?

`src/features/reader/Reader.tsx:501-505`
```ts
} catch (e) {
  if (stale()) return;
  set({ status: "error", error: String(e) });
}
```
and `Reader.tsx:1746-1751` renders `{error}` verbatim inside `.reader-error-detail`.

`String(e)` on a PDF.js exception object yields `"UnknownErrorException: hashOriginal.toHex is not a
function"`. There is **no classification step anywhere** — no mapping from throwable to a
user-facing cause. The surrounding shell is good (a proper `role="alert"` card, a localized title
`"This book couldn't be opened"`, Retry and Back buttons); only the *detail line* is raw.

This is the same shape of defect as `src/lib/updater.ts:34 classifyError()`, which the updater
already solved correctly — the reader simply never got the equivalent.

### 2.3 What Sard should do instead

Three separate things, in this order:

1. **Raise the floor honestly and check it.** Determine the minimum Chromium the vendored engines
   need (today: 140, driven by PDF.js), record it in `VENDOR.txt` and `BUILD.md`, and add one
   feature-detect at startup. When the runtime is too old, say so in the user's language —
   *"Sard needs a newer version of the Microsoft Edge WebView2 runtime to open PDFs. Update it here."*
   — with a link, rather than letting the failure surface as a stack-trace fragment 40 minutes later.
   A `capabilities` probe is more robust than a version-string parse: test
   `typeof Uint8Array.prototype.toHex === "function"` directly.
2. **Change the installer to upgrade, not merely install,** the WebView2 runtime, or state the
   requirement in the release notes and the README.
3. **Add an error-classification funnel for book opening** (§9.1) so *no* throwable ever reaches the
   UI unmapped — this defect, a corrupt zip, a missing file, a malformed OPF, and the engine failures
   in §8 all deserve distinct, actionable sentences. Keep the raw string behind a "Details" disclosure
   for bug reports; never as the primary message.

**Severity: P0.** Every PDF, on an unknown but non-trivial share of installed machines, with an error
message no user can act on. **Layer: rendering pipeline** (the engine floor) + **build/release**
(the installer and the declared requirement) + **core reader** (the message).

---

## 3. Issue 2 — how Sard behaves with low-quality / auto-generated EPUBs

This is the audit. The headline finding is §3.1 and it is bigger than the reported issue.

### 3.1 ⚠ The book's own external stylesheet never enters the cascade — for *every* EPUB

`src/reader-engine/injectedCss.ts:727-746` already records this, and `M:\ProjectDocs\sard\OPEN.md:444`
carries the measurement (Alice's `p.poem{margin-left:10%}` computes `0px`; LotM's
`body{text-align:right!important}` computes `start`). The recorded *diagnosis*, however, attributes it
to the iframe's opaque origin. **That diagnosis is wrong, and the correction is a one-token fix.**

I reproduced Sard's exact model in headless Chromium — a parent document served with Sard's real CSP
header, creating a `blob:` iframe with `sandbox="allow-same-origin"` containing a `<link
rel="stylesheet" href="blob:…">` — and varied one factor at a time:

| Variant | `style-src` | `sandbox` | Book CSS applies? |
|---|---|---|---|
| **a** — Sard as shipped | `'self' 'unsafe-inline'` | `allow-same-origin` | **NO** (`margin-left: 0px`, `font-size: 16px`) |
| **b** | `'self' 'unsafe-inline' blob:` | `allow-same-origin` | **YES** (`28.39px`, `14.4px`) |
| **c** | `'self' 'unsafe-inline'` | *(none)* | **NO** |
| **d** | *(no CSP at all)* | `allow-same-origin` | **YES** |

**The sandbox is irrelevant. The sole cause is that `style-src` in
`src-tauri/tauri.conf.json:23` omits `blob:`.** `'self'` does not match `blob:` URLs in Chromium, so
every `<link>` foliate rewrites to a blob URL is blocked before it can be applied. (The
`SecurityError` on `cssRules` that the vault noted is a red herring — it occurs in variant **b** too,
where the CSS *does* apply.)

Consequences today:

- Every EPUB renders with **UA defaults + Sard's injected CSS only**. Its centred poetry, drop caps,
  heading scale, figure captions, emphasis classes, table styling and page-break hints are all gone —
  on well-authored books just as much as bad ones.
- `<style>` blocks *inside* a chapter **do** apply (`'unsafe-inline'` permits them), as do
  `style="…"` attributes and `[align]`. So Sard's behaviour is **inconsistent between two books that
  differ only in whether their CSS is linked or embedded**.
- Paradoxically this is currently *masking* the Word/Calibre book's hostile CSS (§5). Fixing the CSP
  without the sanitiser in §10 would make that book substantially **worse**, and would put every
  book's stylesheet into competition with the reading controls. RAWY-195 pre-hardened the controls
  and added `markBookAlignedBlocks()` in anticipation of exactly this day; that groundwork exists,
  but it has never been exercised against real book CSS.

**This is the single highest-leverage compatibility finding in the study.** It should be treated as
its own project, not folded into a bug fix.

### 3.2 Does Sard assume EPUBs are well-formed? Where is it fragile?

Mostly **no** — the import pipeline is defensively written (`src-tauri/src/books/mod.rs:9-10`:
"Nothing in here panics on a bad file"), and the RAWY-189 Arabic-script sniff is a genuine
real-world-tolerance feature. But the tolerance stops at the Rust boundary. Findings, per the
requested checklist:

| Aspect | Behaviour today | Verdict |
|---|---|---|
| **Missing metadata** | Title → filename stem (`books/mod.rs:176`); author → literal `"Unknown"` (`:177`); language → `NULL`. Reader header → `"Untitled"` if `dc:title` is truly absent. | **Adequate for absent, blind to placeholder** (§4) |
| **Incorrect language** | `dc:language` is stored verbatim and **never corrected**, even when the content sniff proves otherwise (`books/mod.rs:184-189` fills it only when *missing*). **3 of 14 books in this library declare `en` over Arabic content.** | **Weak** |
| **Incorrect RTL/LTR** | **Strong.** RAWY-189 samples 6 spine documents and flips `books.dir` to `rtl` on Arabic-dominant content. It worked on this very book. Only 3 of 14 books declare `page-progression-direction` at all, so the sniff is load-bearing. | **Good** |
| **Broken TOC** | **No fallback of any kind.** `epub.js:1001-1016` tries nav doc → NCX → *stops*. There is no spine-derived TOC. This book: **116 spine items, 1 NCX `navPoint`** ("Start" → the cover). | **Absent** (§4.3) |
| **Malformed NCX** | Same path; a parse failure is `console.warn`-ed and the TOC is left `undefined`. `ChaptersPanel.tsx:189` has a `panel.noChapters` empty state, but a *degenerate* 1-entry TOC renders as a one-row list, which reads as "the book has one chapter". | **Weak** |
| **Malformed nav document** | Same. | **Weak** |
| **Malformed HTML** | **Good.** `epub.js:812-816` detects an XHTML parser error and re-parses as HTML. | **Good** |
| **Unusual CSS** | Currently moot (§3.1). After a CSP fix: **no sanitiser at all** → hostile. | **Absent** |
| **Unusual spine** | No handling. 116 sections is treated identically to 16. See §5. | **Absent** |
| **Non-UTF-8 OPF** | `read_entry_string` (`books/mod.rs:401-406`) uses `read_to_string`, which **fails on non-UTF-8**. A `windows-1256` Arabic OPF (still common in older Arabic EPUBs) makes `parse_epub` return `None` → no title, no author, no language, no cover, no spine → **no RTL sniff → the book imports as LTR**. Not present in this corpus, but a real class. | **Fragile** |
| **`mimetype` with a BOM** | **Rejected outright.** `books/mod.rs:164` compares `mimetype.trim() != "application/epub+zip"`. Compiled and ran the check: Rust's `str::trim` does **not** strip U+FEFF (`'\u{feff}'.is_whitespace() == false`), so a BOM'd mimetype fails and the file is refused as *"Not an EPUB (missing epub mimetype)"* — a book foliate would open happily. A trailing newline *is* tolerated. | **Fragile** |
| **Compressed `mimetype`** | Tolerated — `الشوقيات` in this library stores it DEFLATE'd (a spec violation) and imports fine. | **Good** |

---

## 4. Issue 3 — the title reads "Unknown"

### 4.1 Root cause

The EPUB literally says so:

```xml
<dc:title>Unknown</dc:title>
<dc:creator opf:file-as="word" opf:role="aut">word</dc:creator>
```

`Unknown` is **Calibre's placeholder** when the source document carries no title metadata (Word
documents almost never do), and `word` is the source filename leaking into the creator field. The NCX
repeats it (`<docTitle><text>Unknown</text></docTitle>`), and so does **every one of the 115 chapter
files** (`<title>Unknown</title>`).

### 4.2 Which field is trusted — and the fallback that is one rung too short

`src-tauri/src/books/mod.rs:176`
```rust
let title = meta.title.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| name.clone());
```

The ladder is `dc:title → filename stem`, and the only rejection test is **emptiness**. `"Unknown"` is
not empty, so it wins. Note the irony at `:177`: Sard's *own* author fallback is the string
`"Unknown"` — so the library cannot distinguish "the file said Unknown" from "Sard gave up". (Both
states exist in this library: `45182e14` has `author='word'`, `23705230` has Sard's `author='Unknown'`.)

**Verdict: EPUB compatibility issue, with a Sard shortfall.** Sard is not wrong to read `dc:title`;
it is wrong to have no notion of a *placeholder* value.

### 4.3 Recommended fallback strategy

A four-rung ladder, each rung rejecting both empty **and** placeholder values:

1. **`dc:title`**, unless it matches a placeholder list — case-insensitively and trimmed:
   `unknown`, `untitled`, `unknown book`, `no title`, `default`, `document`, `document1`,
   the OPF's own `dc:identifier`, and the Arabic equivalents (`غير معروف`, `بدون عنوان`).
   Same list applied to `dc:creator` (`word`, `unknown`, `author`, `user`, `admin`, `calibre`).
2. **The first content document's `<h1>`/`<title>`** — but only if it too passes the placeholder
   filter. Here it would be rejected (`<title>Unknown</title>`), which is the correct outcome.
3. **The filename stem** — for this file, whatever the user named it, which is the best signal
   available and is what a reader recognises.
4. **`"Untitled Book"`** — an honest, localized last resort. Never the string `"Unknown"`, which
   masquerades as data.

Show the user *which rung was used*: the metadata editor (already surfaced automatically after a
single-file import, `Library.tsx:406-412`) should mark a filename-derived title as a guess and invite
a correction, rather than presenting it as fact.

### 4.4 Second-order bug found while investigating this

**The reader's header ignores the user's own title override.**

- `Library` shows `COALESCE(override, extracted)` — so a corrected title appears in the library.
- `Reader.tsx:472` sets `bookTitle: ctrl.title ?? null`, and
  `FoliateController.ts:981-985 get title()` reads **foliate's own `dc:title`** straight from the
  file, bypassing the database entirely.

This is live in the current library: `cd27ab1d` has `metadata_overrides.title = "Lord Of The
mysteries"`, but the reader header shows the embedded `لورد الغوامض`. So a user who fixes "Unknown"
in the library will still see "Unknown" while reading. `OpenTarget` doesn't currently carry the
title, so this needs one field threaded through. **Severity P2, layer: core reader.**

---

## 5. Issue 4 — pagination

### 5.1 What is *not* the cause

**Injected CSS is not the cause today.** Per §3.1 the book's `stylesheet.css` never enters the
cascade — measured. Which is fortunate, because that stylesheet is genuinely hostile to a reflowable
column. It is Word's fixed A4 geometry translated literally into CSS:

```css
.block_   { margin: 0 369pt 0 -84.8pt; }   /* 492px right margin, −113px left */
.block_27 { margin: 0 215pt 0.6pt 0.5pt; }
.block_   { margin: 0 143pt 0 140pt; }
.calibre  { color: #000; font-family: "FreeSans", sans-serif; }   /* on <body> */
```
plus `line-height: 1.2` hard-set on ~200 `.block_N` classes.

In a 600 px reading column, `margin-right: 369pt` would leave ~100 px of measure — text as a vertical
noodle — and `margin-left: -84.8pt` would push content **outside** the column box, where foliate's
`overflow: hidden` (`paginator.js:333`) would silently **clip it away**. `color: #000` on `body` would
also make text invisible on any dark theme unless the ink override fired.

**This is the strongest argument for sequencing: the CSP fix in §3.1 must not ship without the CSS
sanitiser in §10.4.** On this book it would turn a cosmetic complaint into data loss.

### 5.2 What *is* the cause — spine granularity

Measured over the 115 content files:

```
sections: 115   min 596 B   p25 2,057 B   median 2,450 B   p75 3,868 B   max 16,030 B
sections < 2 KB: 24        sections < 1 KB: 12
sections with ≈no text (7 visible chars — image-only): 8
```

Calibre split a single `index.html` at its internal size threshold into `index_split_000…114.html`.
The split points correspond to **nothing the reader can see** — not chapters, not scenes.

Now the mechanism. `paginator.js:370-390 expand()`:
```js
const pageCount = Math.ceil(contentSize / this.#size)
```
**Every section is padded up to a whole number of pages, minimum one.** So:

- Each of the 8 image-only sections becomes **one full page containing one picture**.
- The median section (~1,200 visible characters, ≈ *less than* one page at the Arabic defaults —
  zoom 1.15, line-height 1.9) becomes **one page that is mostly blank**.
- 24 sections under 2 KB become **near-empty pages**.

That is, precisely and completely:

> *incorrect page layout · inconsistent pagination · pages behaving differently depending on content*

It is not a bug in Sard's pagination. It is a **conversion artifact that Sard has no defence
against**, and it is invisible in scrolled mode (the default) — which is why it presents as a
*page-mode* complaint.

### 5.3 "Unstable page navigation"

Two compounding mechanisms, both real:

**(a) Almost every page turn crosses a section boundary.** Median section ≈ 1 page, so a turn is
usually a full iframe teardown + rebuild (`paginator.js:995-1017`), which re-runs Sard's entire
per-section load pass: tashkīl wrapping, `markBookAlignedBlocks()` (a `getComputedStyle` read per
block), `markParagraphDirection`, `markEmptyParagraphs`, `applyReferences`, and four listener
registrations (`FoliateController.ts:1412-1440`). On a normal 20-chapter book this happens ~20 times
per read; here it happens on nearly every click.

**(b) The paginator drops input while that runs.** `paginator.js:1081-1092`:
```js
async #turnPage(dir, distance) {
    if (this.#locked) return       // ← silently dropped, no feedback
    this.#locked = true
    …
    if (shouldGo || !this.hasAttribute('animated')) await wait(100)
    this.#locked = false
}
```
A **100 ms trailing lock plus the section-load time**, during which every further `next()`/`prev()`
is discarded with no visual acknowledgement. This is also cause (c) of Issue 6 — see §7.

### 5.4 Images

`injectedCss.ts:721` emits `img, svg, video, table { max-width: 100%; max-height: 100%; }` — an
element-level rule with no `!important` and none of the RAWY-38 hardening the typography rules carry.
It survives today only because no book CSS competes with it (§3.1); after a CSP fix, any book class
rule would out-specify it.

Separately, `paginator.js:344-368 setImageSize()` reads `this.#layout`, which in **scrolled** mode
(`:729-740`) returns `{ flow, margin, gap, columnWidth }` — with **no `width`/`height`**. So
`max-height: ${height - margin*2}px` evaluates to `"NaNpx"` and the declaration is dropped. Images in
scrolled mode are therefore bounded only by `max-width`. Benign for normal aspect ratios; a genuine
hazard for a very tall image. Worth noting as a latent engine bug rather than a present cause.

**Verdict: EPUB compatibility issue, amplified by Sard's lack of defences.**
**Severity P1. Layer: import pipeline (detect and normalise) + rendering pipeline (make boundary
crossings cheap and turns non-droppable).** Recommendations in §10.

---

## 6. Issue 5 — the navigation button hidden behind the chapters panel

**Fully diagnosed. Deterministic. This one is a straightforward Sard bug.**

### 6.1 Stacking

| Element | Position | z-index | Ref |
|---|---|---|---|
| `.page-chevron` (both) | `absolute`, `left:22px` / `right:22px`, 42 px wide | **3** | `global.css:329-353` |
| `.reader-chrome` | `absolute; inset:0` | 4 | `global.css:364` |
| `.settings-panel` | `absolute`, right drawer | 6 | `global.css:536` |
| `.reader-panel` (Contents · Search · Notes) | `absolute`, `top:70 bottom:56` | **30** | `global.css:817` |
| `.rp-lead` (Contents/Search) | `left: 0`, `inline-size: 300px` | — | `global.css:899` |
| `.rp-trail` (Notes) | `right: 0`, `inline-size: 340px` | — | `global.css:904` |

Both chevrons are children of `.reader-desk` (`Reader.tsx:1580-1608`), which is
`position:absolute` with **no** `z-index`/`transform`/`filter`/`opacity` — so it does **not** create
a stacking context. The chevrons therefore compete directly with the panels inside `.reader-root`'s
context, and **30 beats 3**. The Contents panel covers x ∈ [0, 300]; the left chevron occupies
x ∈ [22, 64]. It is entirely underneath.

### 6.2 Why the page moves out of the way but the button does not

`Reader.tsx:1534-1549`:
```ts
const PANEL_LEAD = 300;  const PANEL_TRAIL = 340;
const leftPad  = chaptersOpen || searchOpen ? PANEL_LEAD : 0;
const rightPad = annoOpen ? PANEL_TRAIL : 0;
const deskStyle = { …, paddingLeft: leftPad, paddingRight: rightPad };
```

`.page-sheet` is an in-flow flex item, so the desk's padding pushes it clear. The chevrons are
**absolutely positioned**, and an absolutely positioned box is laid out against its containing
block's **padding box** — so `left: 22px` is completely unaffected by `padding-left: 300px`. The
layout assumption "padding shifts the desk contents" holds for one child and silently fails for the
other two.

### 6.3 Frequency

Not an edge case:

- Chevrons render when `showChevrons = isPaged || isPdf` (`Reader.tsx:1423`) — **page mode**, exactly
  as reported.
- **The Contents panel is open by default** (`Reader.tsx:788-794`, persisted as `chapters_open`).

So on a fresh profile in page mode, the left chevron is hidden **from the first frame of the first
book**, in every book. The right chevron is covered by the Notes panel (`.rp-trail`, 340 px) or by
the settings drawer (z 6 > 3).

### 6.4 Recommendation

The principle the user states — *"application UI should never be obscured by book content or
application panels"* — should become a written invariant with a single owner, not a per-element
z-index patch. Concretely:

1. **Introduce a named layer scale** (e.g. `--z-desk: 0; --z-chrome: 40; --z-panel: 30; --z-nav: 45;
   --z-modal: 60`) in one block of `global.css`, and replace every hand-picked z-index in the reader
   with a token. There are currently ~50 hand-picked values across the file; they cannot be reasoned
   about as a set.
2. **Make the chevrons obey the panel inset**, not just the z-order — a covered-but-on-top button
   overlapping the chapter list is not the goal. Bind them to the same `leftPad`/`rightPad` the desk
   uses (`inset-inline-start: calc(var(--panel-lead, 0px) + 22px)`), so they *move* with the reading
   area. Then raise them above the panels as a backstop.
3. Add a regression check that asserts the chevrons' bounding boxes do not intersect any open
   panel's, in all four `{EN,AR} × {LTR,RTL}` combinations.

**Severity P1 (affects every book in page mode by default). Layer: rendering pipeline / CSS.**

---

## 7. Issue 6 — navigation buttons sometimes stop responding

There are **three independent causes**. All are reproducible; the user is almost certainly hitting
more than one.

### 7.1 Cause A — the button is not there to click (§6)

Covered by the panel at z 30. This is the "sometimes" — it correlates with *whether a panel is open*,
which the user experiences as intermittency. Deterministic once you know the trigger.

### 7.2 Cause B — keyboard navigation dies whenever focus leaves the book iframe

**There is no page-turn key handler on the parent window at all.** The only ones are attached to the
book iframe's own document:

- `FoliateController.ts:1474-1478` — EPUB: `ArrowLeft → next()`, `ArrowRight → prev()`.
- `FoliateController.ts:1387-1392` — PDF: arrows + Space.

`Reader.tsx:1162-1176` is the *only* parent-window `keydown` listener, and it handles **Ctrl/Cmd+F
and `/` only**. So the moment focus is anywhere in the parent document, arrows do nothing.

Focus leaves the frame in all of these states:

| Trigger | Result |
|---|---|
| **Opening a book** | Nothing calls `focusReadingView()` in `openBook`. Focus is on the parent `<body>`. Arrows are dead until the reader clicks the text. |
| **Clicking any toolbar button** | `releaseButtonFocusAfterPointerClick` (`lib/tts.ts:981-988`) blurs it — to the **parent** body, not the frame. |
| **Any panel open** | Focus is inside the panel. The focus-return effect (`Reader.tsx:756-765`) fires **only on the last panel's close transition**. |
| **Clicking a TOC entry** | `jumpHref` (`Reader.tsx:1502`) navigates but **does not close the Contents panel**, so `anyPanelOpen` stays true, focus stays on the clicked row, and arrows stay dead. |
| **Clicking the desk margin** | Outside the iframe → parent focus. |

The last row is the sharpest reproduction: *open Contents (default) → click a chapter → press the
arrow keys → nothing happens, forever, until you click on the text.* Note that `Reader.tsx:748-755`
documents a previous round of exactly this class of bug ("SPACE dead — the owner's report"); the fix
addressed the close transition but not the several states above.

### 7.3 Cause C — the paginator silently discards turns while locked

`paginator.js:1081-1092`, quoted in §5.3. `if (this.#locked) return` — no queueing, no coalescing, no
feedback. The lock is held for `100 ms + the section load`. On the reported book, where nearly every
turn crosses a boundary, a reader clicking at a natural pace will lose a meaningful fraction of
clicks, and the button gives **no indication** it was ignored (no `:active` persistence, no disabled
state, no spinner).

### 7.4 Is state becoming inconsistent, or event handling lost?

Neither, on the evidence. The listeners are re-registered per section in the `load` handler and are
not being lost. The store is not desynchronising. The failure is **input reaching nothing** — either
because the target is occluded (A), because the handler is in a different frame from the focus (B),
or because the engine is deliberately dropping it (C).

### 7.5 Recommendation

1. **Own page-turn keys at the parent window**, and forward from the frame — the inverse of today.
   `FoliateController` already re-dispatches `F11` and `Ctrl+F` to `window` for this exact reason
   (`:1489-1516`); make page turns follow the same, already-proven pattern. This single change kills
   cause B in all five states at once, and is strictly smaller than chasing focus around.
2. **Coalesce, don't drop.** `#turnPage` should record one pending turn while locked and execute it
   on release (a depth-1 queue — matching the "one-deep" discipline already used for jump anchors at
   `Reader.tsx:1138`). Drop only *further* turns beyond the pending one.
3. **Make the lock visible.** A turn that is queued or in flight should show it.
4. Close the Contents panel on a TOC jump (or return focus to the frame), so the most common
   navigation gesture doesn't leave the reader in a dead-keys state.

**Severity P1. Layer: core reader** (keyboard ownership, focus) **+ rendering pipeline** (the engine
lock — this is a fourth local patch to the vendored engine, so record it in `VENDOR.txt`).

---

## 8. Issue 7 — a page counter

### 8.1 What exists today

| Format | Bottom bar shows | Ref |
|---|---|---|
| **PDF** | `18 / 421` — a real page counter | `ReaderChrome.tsx:244-246`, `en.ts:80 "pdf.pageOf"` |
| **EPUB** | chapter label + `%` | `ReaderChrome.tsx:246-248` |

So the affordance and the string already exist; EPUB simply doesn't feed them. And on the reported
book the EPUB side degrades further: with a 1-entry TOC the chapter label reads **"Start"** for all
10 MB, so the reader has *no* positional information beyond a percentage.

### 8.2 The data is already computed — and thrown away

`progress.js:80-97` returns, on **every** relocate:

```js
{
  fraction,
  section:  { current, total },
  location: { current, next, total },   // sizePerLoc = 1500 bytes  (view.js:242)
  time:     { section, total },
}
```

and `view.js:329-337` attaches `tocItem` **and `pageItem`** to the relocate detail. Sard's handler
(`FoliateController.ts:1352-1377`) reads `cfi`, `fraction`, and `tocItem` — and **discards
`location`, `section`, `time` and `pageItem`.**

That gives three tiers, all free:

| Tier | Source | Meaning | Availability |
|---|---|---|---|
| **1** | `pageItem` ← `book.pageList` (EPUB 3 `page-list` nav / NCX `pageList`) | The **real printed page number** of the source edition | Rare — **0 of 14 books** in this library have one |
| **2** | `location.current / location.total` | Stable byte-derived position, ~1,500 bytes per unit | **Always.** Immune to font size, window size, flow mode |
| **3** | `paginator.page + 1 / paginator.pages` (`paginator.js:798-802`) | Page within the current section | Paged mode only; resets per section |

### 8.3 Recommendation

**Adopt tier 2 as the primary indicator, tier 1 when the book provides it, and tier 3 as a
same-chapter secondary.** Do **not** attempt a true whole-book "Page 18 / 421".

The reason is a design one, and it is the deciding argument: a real page count requires laying out
the entire book at the current settings, and it would then **change every time the reader touched
font size, margins, page width, or the window** — Sard's typography controls are unusually rich, so
this book's "421 pages" would become "509" on one slider drag. A counter that moves under the reader
is worse than no counter. Kindle solved this with locations for exactly this reason, and foliate
already computes them.

Concretely, for an EPUB the bottom bar could read:

> `الفصل الثالث · ٣٤٧ / ٢٬٩٤٠ · ٪١٢`

with tier 3 (`page 2 of 4 in this chapter`) available in paged mode. Label it honestly — "location",
not "page" — unless tier 1 data exists, in which case say "page" and mean it. Both variants must run
through `localeNum` for Arabic-Indic numerals, as the PDF readout already does.

**Cost: low.** No new computation, no new IPC, no migration — three fields carried through an
existing callback plus one string. **Severity P2 (usability). Layer: core reader.**

---

## 9. Additional weaknesses found during the investigation

These were not reported but are in the same family, and the request asked for them.

### 9.1 No error classification for book opening — the general form of Issue 1b

`Reader.tsx:505` renders `String(e)` for **every** failure mode. Beyond the PDF.js case, the
following all currently reach the user as raw engine text:

- **A missing or namespace-mismatched `<metadata>` element in the OPF.** `epub.js:173-178`:
  ```js
  const $metadata = $(opf.documentElement, 'metadata')
  const els = Object.groupBy($metadata.children, …)
  ```
  `childGetter`'s `$` returns `undefined` when nothing matches (`epub.js:87`), so this throws
  `TypeError: Cannot read properties of undefined (reading 'children')` — straight to the error card.
  A real hazard for hand-built and scraper-produced EPUBs.
- `view.js:66-68` — `ResponseError`, `NotFoundError`, `UnsupportedTypeError` are all thrown as bare
  classes and rendered as `"UnsupportedTypeError: …"`.
- A corrupt zip, a missing managed file, a deleted `library\` folder.

**Recommendation:** one `classifyOpenError(e): OpenErrorKind` funnel, mirroring the shape
`src/lib/updater.ts:34` already established, with localized strings per kind and the raw text behind
a "Details" disclosure. **P0, bundled with §2.3.**

### 9.2 Import failures tell the user a count, not a reason

The Rust side produces good per-file messages — *"Not a valid EPUB (bad ZIP)"*, *"Not an EPUB
(missing epub mimetype)"*, *"Couldn't store the file: …"*, *"Database error: …"*
(`books/mod.rs:145-166`, `:195-227`). The UI throws them all away:

`Library.tsx:144-153 summarize()` counts statuses and emits `"1 unsupported"`. **`ImportResult.message`
is never rendered anywhere.** A user whose book is refused has no route to finding out why — which is
precisely the situation this whole investigation is about. **P1, layer: import pipeline UI.**

### 9.3 `dc:language` is stored wrong and never corrected

RAWY-189 corrects `books.dir` from content but deliberately leaves `books.language` as declared
(`books/mod.rs:182-189`). Measured in this library: **3 of 14 books declare `en` over Arabic
content.** `dir` is the operational pivot for layout and paging, so reading works — but `language`
feeds anything language-shaped later (voice selection refinements, hyphenation, locale-aware
segmentation, search folding decisions). It is a wrong value sitting in the database, and it will bite
whatever is built on it next. The sniff already has the answer; storing it costs nothing.

### 9.4 The mimetype BOM rejection (§3.2)

Compiled and confirmed. One-line fix (`trim_start_matches('\u{feff}')`), but it is a *hard reject* of
a valid book today.

### 9.5 The stylesheet fix has an unexercised blast radius

RAWY-195 hardened every typography control and added `markBookAlignedBlocks()` specifically so that
book CSS entering the cascade would not flatten the book's own intent. That machinery has **never run
against a real book stylesheet** — by construction, since no book stylesheet has ever loaded. Before
the CSP change ships it needs verification against at least Alice (Latin, poetry), الشوقيات (Arabic
verse, 141 sections), لورد الغوامض (1,433 sections, `body{text-align:right!important}`) and the
Calibre/Word book.

### 9.6 Vendored-engine drift is unmonitored

`VENDOR.txt` records the pin and the standing "re-apply on any re-vendor" instruction, and there are
now **three** local patches to the engine (the sandbox hardening at `paginator.js:252`, the
`--sard-*` measure patch, the RAWY-75 wheel patch) — with a fourth proposed in §7.5. But nothing
records **what browser capabilities the vendored code requires**. That is the gap Issue 1 fell
through. A re-vendor should be gated on re-deriving the floor.

---

## 10. Issue 8 — the EPUB compatibility layer

### 10.1 Should it exist?

**Yes.** The evidence is that imperfect EPUBs are the *normal case*, not the exception. In a 14-book
library that was not assembled to prove a point:

- **3 books** declare the wrong `dc:language`.
- **11 of 14** declare no `page-progression-direction` — RTL is inferred, never stated.
- **1 book** has a degenerate TOC (116 sections, 1 entry).
- **3 books** are EPUB 2.0 with no nav document.
- **1 book** violates the spec by compressing `mimetype`.
- **0 books** provide a `page-list`.
- **0 books** currently get their own CSS applied (§3.1).

### 10.2 Where it belongs

**Import, not render.** Four reasons:

1. **It is once-per-book, not once-per-section.** The render path already runs five DOM passes per
   section; adding recovery there multiplies a cost that §5.3 shows is already the bottleneck.
2. **The results are user-editable.** `metadata_overrides` already exists and already wins via
   `COALESCE`. A recovered title should be a normal, correctable value — not magic that reappears.
3. **It is inspectable.** A stored recovery decision can be shown, explained, and undone. A render-time
   heuristic cannot.
4. **It matches the existing grain.** RAWY-189's script sniff is exactly this pattern, and it works.

**One deliberate exception:** the CSS sanitiser (§10.4) must be at **render** time, because Sard's
storage model is byte-preserving — "the user's source is never rewritten", `books/mod.rs:5-7`. Rewriting
CSS at import would violate that, and would also break the content-hash identity that makes dedup and
restore work.

### 10.3 Proposed shape — `src-tauri/src/books/compat.rs`

A single module, one entry point, running inside the existing import transaction. Every recovery
writes a `books` column plus a **provenance record** (`declared` / `inferred` / `filename` /
`default`), so the metadata editor can say *why* and the user can overrule.

| Recovery | Rule | Confidence |
|---|---|---|
| **Title** | The four-rung ladder in §4.3 with the placeholder list | high |
| **Author** | Same ladder; never emit the literal `"Unknown"` — emit `NULL` and let the UI render "Unknown author" as *chrome*, so the data stays honest | high |
| **Language** | Store the declared value **and** the sniffed script. On disagreement, prefer the sniff for the operational field and keep the declaration for the record (§9.3) | high |
| **Direction** | Keep RAWY-189 exactly as it is — it works | — |
| **TOC** | If `navPoints + navLis < max(3, spine × 0.1)` → mark `toc_degenerate`, and let the reader synthesise a spine-derived list (§10.5) | medium |
| **Spine granularity** | If `median section < ~4 KB` **and** `spine > 60` → mark `spine_fragmented` (§10.6) | high |
| **Encoding** | Decode OPF/NCX/container by declared XML encoding, falling back UTF-8 → UTF-16 → windows-1256 → latin-1, instead of failing (§3.2) | high |
| **`mimetype`** | Strip a BOM; accept a compressed entry (already works); treat a *missing* mimetype as a warning, not a rejection, when `container.xml` + a parsable OPF are present | high |
| **Producer** | Record `dc:contributor[role=bkp]` (`calibre (9.9.0)`, `Sigil`, `Pages`, `Word`) in a `books.producer` column | high |

That last row is worth its own note: **knowing the producer is what makes every other rule safe.**
"Title is literally `Unknown`" is a confident placeholder only when Calibre produced the file; on a
hand-authored book it might be someone's actual title. Producer-conditioned rules are far less likely
to damage a good book than blanket heuristics — which is the main risk of a compatibility layer.

**Known producer quirks to encode:**

- **Calibre** — `Unknown` / `word` placeholders; `index_split_NNN.html` fragmentation; a
  cover-only NCX; `.calibreN` class soup; `@page` rules; `<span dir="ltr">` wrapping page-break
  `<br>`s; `<title>` repeated from `dc:title` in every section.
- **Word → HTML → Calibre** — absolute `pt` margins from a fixed page geometry (§5.1); `mso-*`
  properties; empty `<p>` padding (Sard's `markEmptyParagraphs` already handles this well);
  `class="MsoNormal"`.
- **Scrapers** — whitespace-only `<p>` at 21–55 % density (already measured and handled, RAWY-253);
  `dir="ltr"` on Arabic paragraphs (already handled).

### 10.4 The CSS sanitiser (render layer)

Required **before or with** the CSP change in §3.1, never after. Its job is to let the book's
*typographic intent* through while refusing its *page geometry*, applied to the book's own stylesheet
as it is rewritten by `epub.js:864-874 replaceCSS()`:

| Keep | Neutralise | Why |
|---|---|---|
| `font-style`, `font-variant`, `font-weight`, `text-transform`, `text-decoration`, `color` on non-body elements | — | This is emphasis and voice — the thing currently being lost |
| `text-align` (already protected by `markBookAlignedBlocks`) | — | Poems, scene breaks |
| `font-size` in **relative** units (`em`, `%`, `rem`) | `font-size` in `pt`/`px` | Absolute sizes fight the reader's zoom |
| Percentage / `em` margins and indents | **Margins/padding in `pt`/`cm`/`in`**, and **all negative margins** | §5.1 — the actual danger |
| — | `position: absolute/fixed`, `float`, `width`/`height` on block containers | Escapes the column |
| — | `@page`, `column-*`, `page-break-*` overrides | foliate owns pagination |
| — | `background-color` on containers (already neutralised by `themeBlock`) | Theme integrity |

Ship it behind a **per-book toggle** — *"Use this book's own styling"* — defaulting to on for
well-formed books and off for producer-flagged conversions. That converts an irreversible global
behaviour change into a reversible per-book one, which is the right shape for a change with this
blast radius.

### 10.5 TOC recovery

When `toc_degenerate` is set, synthesise a contents list rather than showing one useless row:

1. **Prefer real headings.** One pass over the spine collecting the first `h1`–`h6` per section
   (cheap: only the first heading, only linear sections). For this book that yields nothing, which is
   itself the signal to fall back.
2. **Fall back to grouped sections** — "Section 1–10", "Section 11–20" — or, better, to the first
   ~40 characters of each section's text as a label. For a Calibre split that produces a usable
   scrollable index of 115 entries where there is currently one.
3. **Label it honestly** in the panel header: *"Contents generated by Sard — this book has none."*

This also repairs the downstream damage: the chapter label in both bars, `chapters_read` markers, TTS
chapter names, and the search "you are here" label are all currently pinned to "Start" for the whole
book.

### 10.6 Spine-fragmentation handling

When `spine_fragmented` is set, offer **"Continuous pages"** for that book: in paged mode, do not force
a page break at a section boundary unless the section is a plausible chapter start (a leading heading,
or a size above threshold). This is the correct fix for §5.2 and it is genuinely non-trivial — foliate
paginates strictly per section — so it deserves to be scoped as its own ticket and measured, not
bundled.

A cheaper interim that costs almost nothing: when `spine_fragmented` is detected, **default that book
to scrolled flow**, where the artifact is invisible. One line, honest, and it makes the reported book
readable immediately.

---

## 11. Recommended sequencing

Ordered by (harm × certainty) ÷ cost. Each is independently shippable.

| Step | Work | Why here |
|---|---|---|
| **1** | **Error classification for book opening** (§9.1) + **the WebView2 floor check** (§2.3) | P0. Fixes the reported crash *and* every future one. Small, self-contained, no blast radius. |
| **2** | **Surface `ImportResult.message`** (§9.2) | One-line UI change; without it every later compatibility fix is undiagnosable in the field. |
| **3** | **Chevron stacking + panel inset** (§6.4) and **parent-window page-turn keys** (§7.5) | P1, deterministic, affects every book in page mode. Independent of everything else. |
| **4** | **The page/location counter** (§8.3) | Low cost, high perceived value, and it partially compensates for the broken TOC on bad books. |
| **5** | **The import compatibility layer** (§10.3) — title, author, language, encoding, mimetype, producer | The metadata half. Self-contained, reversible via `metadata_overrides`, no render risk. |
| **6** | **TOC recovery + spine-fragmentation flag** (§10.5, §10.6) | Depends on step 5's flags. Ship the scrolled-flow default first; "continuous pages" is its own ticket. |
| **7** | **The CSS sanitiser** (§10.4) — built and verified **first**, then the `style-src blob:` change (§3.1) | Last, and deliberately so. Biggest gain, biggest risk. Never ship the CSP token without the sanitiser (§5.1). |
| **8** | **Turn coalescing in the paginator** (§7.5) | A fourth patch to the vendored engine — record it in `VENDOR.txt` and measure before/after. |

---

## 12. Answers to the questions as asked

**1. Can the exception be reproduced?** Yes, on any WebView2 below Chromium 140 — deterministically,
for every PDF. Not on this dev machine (150.0.4078.105), which is why the PDF in this library opened
fine. **Sard's bug, not the file's.** Path: `pdf.worker.mjs:59575`. It reaches the UI because
`Reader.tsx:505` renders `String(e)` with no classification. Sard should declare and check a runtime
floor, and map every open failure to a sentence a reader can act on.

**2. Does Sard assume EPUBs are well-formed?** Partly. Import is defensively written and the RTL sniff
is genuinely strong. But there is **no TOC fallback**, **no encoding fallback**, **no spine-shape
awareness**, **no CSS sanitiser**, and a **hard reject on a BOM'd mimetype**. And one systemic
finding beneath all of it: **no EPUB's external stylesheet has ever been applied** (§3.1) — a single
missing `blob:` in `style-src`.

**3. Why "Unknown"?** Because the file literally says `<dc:title>Unknown</dc:title>` — Calibre's
placeholder. Sard trusts `dc:title` and only rejects *empty* values. It needs a placeholder-aware
ladder ending at "Untitled Book", never at "Unknown". Separately, the reader header bypasses the
database and so ignores the user's own correction (§4.4).

**4. Why does pagination break?** Not injected CSS (it never loads) and not oversized images.
**115 sections with a 2,450-byte median**, each padded to a whole page by `expand()` — half-empty
pages, image-only pages, and a section boundary on nearly every turn, each one a full iframe rebuild
behind a 100 ms input lock. The book's Word-derived CSS (`margin: 0 369pt 0 -84.8pt`) would make it
far worse the moment the CSP is fixed without a sanitiser.

**5. Nav button behind the chapter panel?** `.page-chevron` z-index **3** vs `.reader-panel` z-index
**30**, in the same stacking context, and the desk's `padding-left` cannot move an absolutely
positioned child. Contents opens by default, so this is the default state in page mode.

**6. Nav buttons stop responding?** Three causes: the button is occluded (above); arrow keys are bound
only inside the book iframe while focus is routinely in the parent; and the paginator silently drops
turns while locked. Reproducible: open Contents → click a chapter → arrows are dead until you click
the text.

**7. Page counter?** Worth doing, and cheap — foliate already emits `location: {current, next, total}`
on every relocate and Sard discards it. Use **locations**, not synthetic pages: a real page count
would change every time the reader touched a typography control.

**8. Compatibility layer?** Yes — at **import**, keyed on the detected **producer**, writing normal
correctable values with provenance, plus one **render-time** CSS sanitiser that must land before the
CSP fix.
