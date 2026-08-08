# Read-aloud spoke code-like text — tester report investigation

**Date:** 2026-08-08 · **Build:** `test-build\Sard.exe` (develop @ `242c616`) · **Product code changed:
NONE.**

**Book:** `لورد الغوامض 2: حلقة الحتمية` (EPUB, 4.03 MB, 759 content documents, 378 chapter files)
**Harnesses:** `tests/harness/tts-script-leak{,2,3}.mjs` — rounds 1–3 are recorded as **void** below;
round 4 (`tts-script-leak3.mjs`) is the decisive one.

---

## 1 · Reproduction status

**REPRODUCED — PROVEN.** The tester's "window dot pup futer tage" is
`window.pubfuturetag`, read aloud. Sard sends an ad-network script's source code to the speech engine
as an ordinary sentence unit.

---

## 2 · Where it occurs

The reported sentence is in `OEBPS/chapter-4821821045628395695.txt.html`, **spine position 404
(index 403)**. `[PROVEN]`

| | |
|---|---|
| Reported sentence | line **18** |
| Ad container | lines **19–21**, immediately after it |

That adjacency is exactly the tester's experience: the sentence is spoken, and the very next unit is
the script. It is **not** limited to this chapter — see §7.

---

## 3 · Exact text sent to TTS

`[PROVEN]` The unit is the script's source, 133 characters:

```
window.pubfuturetag = window.pubfuturetag || [];window.pubfuturetag.push({unit: "673524f31c366f114b8e6d97", id: "pf-12454-1"})
```

Spoken by a TTS engine this is approximately *"window dot pubfuturetag equals window dot pubfuturetag
or... window dot pubfuturetag dot push unit..."* — which matches the report.

The containing markup:

```html
<div id="pf-12454-1">
 <script>window.pubfuturetag = …</script>
</div>
```

This is a **PubFuture** advertising tag, embedded by whatever produced the EPUB from the source web
novel. It is not part of the novel.

---

## 4 · What the reader sees

**Nothing. `[PROVEN]`** Measured on the live page:

| Property | Value |
|---|---|
| `<script>` computed `display` | **`none`** (UA stylesheet — a script is never rendered) |
| `document.body.innerText` contains `pubfuturetag` | **false**, in every sampled section |

The reader sees an ordinary paragraph break. The application is speaking text that has no visual
representation at all.

**The script never executes** — the RAWY-64 vendored patch sandboxes content iframes to
`allow-same-origin` with no `allow-scripts`. This is purely its *text* being read, not it running.

---

## 5 · Does it exist in the EPUB source?

**Yes — PROVEN.** Static inspection of the extracted EPUB:

| Measure | Value |
|---|---|
| Chapter files | **378** |
| Chapter files containing `<script>` | **378 (100%)** |
| `<script>` occurrences | 378 (exactly one per chapter) |
| `pubfuturetag` occurrences | 1,134 (three per script) |
| All content documents (incl. nav) with `<script>` | **759 / 759** |

The book ships the same ad tag, with the same unit id, in every single document.

---

## 6 · Root cause

**The book supplies the payload; Sard's extraction rule lets it through. Both statements are needed.**

`FoliateController.getChapterUnits()` walks candidate containers:

```
CONTAINER = "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article"
```

and for each element keeps it when **all** of these hold — measured against the real DOM:

| Condition in the walk | The ad `<div>` | Result |
|---|---|---|
| matches `CONTAINER` | it is a `div` | ✅ passes |
| is a **leaf** (`!el.querySelector(CONTAINER)`) | contains only a `<script>` | ✅ **counts as a leaf** |
| not hidden (`visibility:hidden` / `display:none`) | `display: block`, `visibility: visible` | ✅ **not hidden** |
| `el.textContent.trim()` is non-empty | 133 characters of JavaScript | ✅ non-empty |

**The mismatch is between which element is tested and which text is read.** Visibility is tested on the
**container**, which is genuinely visible. The text is taken with **`textContent`**, which returns the
concatenated text of *all* descendants regardless of rendering — including `<script>`. So a visible,
empty-looking `<div>` yields the source code of the invisible `<script>` inside it.

`[PROVEN]` by differential on the live pipeline: pressing Play rebuilds the units for the section on
screen and publishes the count as the store's `total`. With the ad `<div>` in place, then detached,
then restored:

| Section | with ad | without ad | **delta** | restored |
|---|---|---|---|---|
| 403 | 71 | 70 | **1** | 71 |
| 700 | 70 | 69 | **1** | 70 |
| 120 | 137 | 136 | **1** | 137 |

Removing that single node removes **exactly one spoken unit**, every time, and putting it back restores
the count. No replica and no cached value is involved in this measurement.

---

## 7 · Scope

**The whole book.** `[PROVEN]` One ad unit per content document × 759 documents. A listener hears it
roughly once per chapter, always at the same structural position, which is why the tester saw it
"repeatedly in other chapters".

`[PROVEN]` The anomalous unit was found in **every** sampled section (3, 50, 120, 250, 403, 700).

---

## 8 · Other books

`[PROVEN]` All 34 EPUBs in the library were scanned by reading their zip entries:

| | |
|---|---|
| EPUBs scanned | 34 |
| Containing `<script>` in content documents | **2** |
| Containing `<style>` | 4 |

The second book (`داو الخالد العجيب`) has a script in **1 of 88** documents and its inline text sampled
empty, so it is likely harmless — **UNVERIFIED**, not checked through the pipeline.

**This is a class, not a one-off.** Any EPUB produced by scraping an ad-supported web-novel site can
carry the same shape, and `<style>` in a leaf container would leak CSS source by the identical
mechanism. **INFERRED** — the `<style>` variant was not reproduced.

---

## 9 · Mitigation options

| # | Option | Assessment |
|---|---|---|
| **A** | **Ignore text inside `script`, `style`, `noscript`, `template` during extraction** | **Recommended.** These four elements are *by definition* never rendered text. No legitimate book can lose prose, because prose is never inside them. Narrow, and the rule is a fact about HTML rather than a heuristic |
| B | Strip `<script>`/`<style>` at import | Rejected — mutates the reader's file, and `D16` says the source is never rewritten |
| C | Use `innerText` instead of `textContent` | Rejected — layout-dependent and slow on every unit, and it would silently change behaviour for the RAWY-22/69 hidden-title machinery that relies on the current visibility test |
| D | Filter units that "look like code" | Rejected — a heuristic that will eventually delete real prose. A book discussing JavaScript would lose sentences |
| E | Do nothing; treat as a book defect | Rejected — every affected reader hears it, and the class will recur |

**Option A defends against the class without a heuristic**, which is what makes it safe.

---

## 10 · Recommended fix (NOT implemented — awaiting approval)

Exclude the four never-rendered elements from the text the EPUB walk reads. Two candidate insertion
points; the second is likely correct but needs confirming before implementation:

1. The leaf-container filter in `getChapterUnits` — cheap, but only fixes containers whose *whole*
   content is a script.
2. **`segmentBlock`**, which walks the element's text nodes to build the sentence ranges — skipping any
   text node with a `script`/`style`/`noscript`/`template` ancestor fixes both the whole-script case
   *and* the mixed case (a paragraph with an inline script inside it).

`[UNVERIFIED]` I have not read `segmentBlock` line by line, so the exact edit is not yet specified.
That reading is the first step if you approve.

**EPUB-only.** The PDF path derives units from pdf.js text-layer spans and cannot contain scripts.

---

## 11 · Regression risks

| Risk | Assessment |
|---|---|
| Losing legitimate prose | **Very low.** Text inside `script`/`style`/`noscript`/`template` is never displayed, so it was never prose the reader could see |
| Unit **count** changes on affected books | **Expected and intended** — one fewer unit per chapter. Any stored TTS cursor for those chapters may be off by one after the fix |
| Sentence **ranges**/highlighting | Must be re-verified: `segmentBlock` builds the ranges the spotlight draws from |
| Stored anchors (`C-4`, `C-1`) | Highlights/bookmarks use CFI, not unit indices, so they are unaffected. **INFERRED** |
| Other formats | None — the change is confined to the EPUB walk |

Acceptance gates should be `tts-live.mjs` (playback + spotlight), `toc-regression.mjs`, and a new
harness asserting the ad unit is gone from this book while the count for a clean book is unchanged.

---

## 12 · Evidence classification

### PROVEN
- The spoken text is the `window.pubfuturetag` ad script, 133 characters.
- It is in **378/378** chapter files and **759/759** content documents of this book.
- The reported sentence and the ad container are adjacent (lines 18 and 19–21) in spine index 403.
- The ad `<div>` is a **leaf** container with `display:block`, `visibility:visible`; the `<script>`
  inside has `display:none`.
- `body.innerText` never contains the string — the reader cannot see it.
- Removing the node removes **exactly one** unit from the real queue in 3/3 sections; restoring it
  restores the count.
- The anomalous unit is present in every sampled section (6/6).
- 2 of 34 library EPUBs contain scripts in content documents.

### INFERRED
- A `<style>` element in a leaf container leaks CSS source by the identical mechanism.
- Scraped web-novel EPUBs are the general source of this class.
- CFI-based annotations are unaffected by a unit-count change.

### UNVERIFIED
- Whether the second book's single script actually produces a spoken unit.
- The exact edit site inside `segmentBlock`.
- Whether any stored TTS cursor is currently pointing at an ad unit in this book.

### DISPROVEN
- *"The script is executing."* It cannot — content iframes carry `allow-same-origin` only (RAWY-64).
- *"Sard mis-renders or corrupts the text."* The visible text is correct throughout; only an invisible
  element's source is added.
- *"It is confined to one chapter."* It is in every chapter.

### Void measurements — recorded so they are not re-used
- **Round 1** read `__sardTrackStats().units` as an array of texts. It is a **count**
  (`{section, units, ranged, unranged, rebuilt}`), so every section reported 0 units. An absence
  manufactured entirely by the instrument.
- **Round 2** compared `trackStats()` counts before/after removing the node. `trackStats` returns the
  **retained** set once a session owns the units, so it reported **169 units for six chapters of
  visibly different lengths**. Both the delta and the "replica mismatch" it implied were meaningless.
- **Round 3** used a replica of the extraction walk. It does **not** reproduce the real unit count
  (53 vs 71, 60 vs 70, 139 vs 137), because the real `segmentBlock` walks text nodes and builds ranges.
  A replica that cannot reproduce the count cannot be used to name a unit index or its text, so the
  index/text figures it produced are **not** cited as evidence anywhere above.

**No product code was changed by this investigation.**
