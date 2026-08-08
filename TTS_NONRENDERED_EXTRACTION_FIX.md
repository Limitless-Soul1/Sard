# Non-rendered content reaching TTS — extraction study and proposed minimal fix

**Date:** 2026-08-08 · **Build:** develop @ `242c616` · **Product code changed: NONE.**
**Companion:** `TTS_SCRIPT_LEAK_INVESTIGATION.md` (the tester report and root cause).
**Harness:** `tests/harness/tts-nonrendered-probe.mjs` (read-only; injects a probe block into a real
chapter document, measures, removes it — verified removed).

---

## 1 · `segmentBlock`, line by line

`FoliateController.segmentBlock(el, doc, seg, norm, out)` — the only place DOM text becomes
`{text, range}`:

| Lines | What happens |
|---|---|
| **2950** | `const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)` — **no third argument, so no NodeFilter** |
| 2953–2959 | Walk every text node under `el`; keep those with `data.length` into `nodes[]` and their strings into `strs[]` |
| 2960–2962 | Bail if nothing, or if the joined string is blank |
| 2961 | `full = strs.join("")` — the concatenated raw text of the block |
| 2982–2983 | `prefix[i]` = cumulative length of nodes before node *i* |
| 2984–2988 | `locate(off)` → `[nodeIndex, offsetInNode]` by scanning `prefix` |
| 2991–2995 | `rangeFor(a,b)` → a live `Range` spanning chars `[a,b)` of `full` |
| 2996–3011 | Segment `full` with `Intl.Segmenter`; per sentence push `{text: norm(segment), range: rangeFor(...)}`; over-long units subdivide via `splitLongSpan`, each sub-span getting its own tiling range |

**The single defect is line 2950.** `NodeFilter.SHOW_TEXT` selects text nodes *anywhere* beneath `el`,
including inside `<script>`. `PROVEN` — the probe's unfiltered walker over a `<div><script>…</script></div>`
returned the script's text.

**Why the caller cannot catch it:** `getChapterUnits` (2890–2895) tests `isHidden(el)` on the
**container**, and the ad `<div>` is genuinely `display:block; visibility:visible`. The container is
visible; only its *child* is not. The visibility test and the text read are applied to different nodes.

---

## 2 · The safest place to exclude — and why it is not a matter of taste

**The TreeWalker filter at line 2950. `PROVEN` by construction.**

Everything downstream — `strs`, `full`, `prefix`, `locate`, `rangeFor` — is derived from the same
`nodes[]` array. A node never admitted to `nodes[]` is absent from all of them *simultaneously*, so the
char offsets and the DOM ranges stay mutually consistent with no further arithmetic.

Every alternative breaks that invariant:

| Alternative | Why it is wrong |
|---|---|
| Filter the **text** after `full` is built | `prefix`/`locate` still describe the unfiltered nodes, so every range after the removed span points at the wrong offset. Silent highlight drift |
| Drop **units** whose text looks like code | A heuristic. A book *about* JavaScript loses real sentences. Explicitly out of scope |
| Skip the container in `getChapterUnits` | Only fixes containers whose *entire* content is a script; a script inline inside a real paragraph still leaks, and the paragraph would be dropped wholesale |
| Switch to `innerText` | Layout-dependent and forces reflow per block (RAWY-182 already had to chunk this walk to stop it freezing the thread), and it would change the RAWY-22/69 hidden-title behaviour |

---

## 3 · Which elements are safe to exclude — measured, not assumed

The proposed set was `script, style, noscript, template`. **One of those four is unsafe.** Measured in
a real chapter document inside the actual sandboxed iframe:

| Element | Reaches TTS | Visible to reader | `display` | Verdict |
|---|---|---|---|---|
| `<script>` | **yes** | no | `none` | ✅ **safe to exclude** |
| `<style>` | **yes** | no | `none` | ✅ **safe to exclude** |
| **`<noscript>`** | **yes** | **YES** | **`inline`** | 🔴 **MUST NOT EXCLUDE** |
| `<template>` | no | no | `none` | ⚪ no-op — walker never reaches it |
| `<span style="display:none">` inside a visible `<p>` | **yes** | no | `none` | ✅ leaks (same class, wider — §5) |

### Why `<noscript>` is different `[PROVEN]`

The parser treats `<noscript>` contents as raw text **only when the scripting flag is enabled**. Sard's
content iframes are sandboxed `allow-same-origin` with **no** `allow-scripts` (RAWY-64), so scripting is
disabled — measured directly: an injected `<script>` did **not** execute (`scriptingRuns: false`).

With scripting disabled the browser **parses and renders** `<noscript>` content as ordinary markup.
Measured: `display: inline`, `offsetHeight: 34`, and its text present in `innerText`. **A reader on this
build sees `<noscript>` content on the page.** Excluding it would delete visible prose — the exact
failure this fix must not introduce.

**`<template>`** children are parsed into a separate `DocumentFragment` (`.content`) and are not in the
document tree, so the walker never reaches them (`walkerCollected: []`, `textContent: ""`). Listing it
would be a harmless no-op; it earns a comment, not code.

**So the correct minimal set is exactly two elements: `script` and `style`.**

---

## 4 · Can excluding them remove legitimate visible prose?

**No. `PROVEN` for this build, and structurally for any build.** `<script>` and `<style>` are
`display: none` in the UA stylesheet unconditionally — there is no document, stylesheet or scripting
state in which their contents render as text. Both measured `display: none`, `offsetHeight: 0`, and
absent from `innerText`. Text a reader can see is never inside them.

This is what makes the fix a statement about HTML rather than a heuristic, which is the property the
brief asks for.

---

## 5 · The wider class — a separate decision

`[PROVEN]` `<p>VISIBLE<span style="display:none">HIDDEN</span></p>` leaks `HIDDEN` to TTS today. Same
defect class: non-rendered content entering the pipeline. The container is visible, so `isHidden` passes,
and the walker takes every descendant text node.

A general fix means consulting computed style for each text node's ancestors during the walk. That is
**not** proposed here:

- **Cost.** `getComputedStyle` per node on a chapter with hundreds of nodes, on the path RAWY-182 had to
  chunk to stop it freezing the UI. Unmeasured.
- **Risk.** `visibility:hidden` is already load-bearing for the RAWY-22/69 hidden-title machinery.
- **Evidence.** No reported defect of this shape; the tester's report is entirely the `script` case.

**Recommendation:** fix the proven, zero-risk case now; record the `display:none`-descendant case as a
known, unfixed, wider instance with a named cost. `[UNVERIFIED]` — whether any real book in the corpus
hides prose this way was not measured.

---

## 6 · The proposed minimal change (NOT implemented)

One argument added at line 2950 — a filter rejecting text nodes whose parent is a `<script>` or
`<style>`. In shape:

```
const SKIP = new Set(["SCRIPT", "STYLE"]);
const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
  acceptNode: (n) => SKIP.has(n.parentNode?.nodeName ?? "")
    ? NodeFilter.FILTER_REJECT
    : NodeFilter.FILTER_ACCEPT,
});
```

`parentNode` alone is sufficient and is the whole check: the character data of `script` and `style` is
always a **direct** text child — neither may contain elements. No ancestor walk, no computed style, no
per-node cost beyond a `Set` lookup.

**Scope:** one file, one call site, EPUB only. The PDF path builds units from pdf.js text-layer spans
and cannot contain scripts. `splitLongSpan`, `norm`, `hasSpeech`, `MAX_TTS_UNIT_CHARS`, the whole-body
fallback and `getChapterUnits`' container walk are untouched.

**Second-order effect, intended:** with the ad `<div>`'s only text node rejected, `segmentBlock` returns
at line 2960/2962 (`nodes.length === 0` / blank `full`) and the div contributes **no** unit — rather
than an empty one.

---

## 7 · Predicted impact on the affected book

`[PROVEN, by the live differential already run]` Detaching the ad node and re-pressing Play changed the
real queue by exactly one unit per chapter and restored on re-insertion:

| Section | with ad | without ad | delta |
|---|---|---|---|
| 403 | 71 | 70 | **1** |
| 700 | 70 | 69 | **1** |
| 120 | 137 | 136 | **1** |

Detaching the node is behaviourally equivalent to the filter for this book, because the div's *only*
content is the script. So the predicted post-fix state is **one fewer unit per chapter, the JavaScript
absent, all surrounding Arabic units unchanged**.

`[UNVERIFIED]` That the ranges of the surrounding units are byte-identical after the fix. The
differential measured *counts*, not ranges. This must be measured against the implementation.

---

## 8 · Existing test coverage

`[PROVEN]` **None.** No unit test or harness asserts anything about `script`/`style`/non-rendered text in
extraction — `tests/unit/ttsUnitStructure.test.ts` contains no reference to any of them, and no harness
covers it. This defect could recur silently.

### Proposed gate (to be written with the fix)

1. **Unit test** — the cheapest and most durable: a fixture document with (a) a `<div>` containing only
   a `<script>`, (b) a paragraph with an inline `<script>`, (c) a `<style>` block, (d) a `<noscript>`
   block that **must still be extracted**, and (e) plain prose. Assert no unit contains script or style
   text, the `<noscript>` text *is* present, and prose units and their offsets are unchanged.
   **Red-verify against the current build first** — it must fail before the fix.
2. **Harness on the affected book** — units for sections 120/403/700 contain no `pubfuturetag`, count is
   exactly one lower, and `ranged == units` (every unit still carries a range).
3. **Regression on a clean book** — `tts-live.mjs`: unit count, sentence segmentation, spotlight drawing,
   pause/resume/seek unchanged.

---

## 9 · Regression risk

| Area | Risk | Note |
|---|---|---|
| `{text, range}` consistency | **Very low** | Filtering at the walker keeps offsets consistent by construction (§2) |
| Unit count on affected books | **Expected**, −1 per chapter | A stored TTS cursor in those chapters may be off by one, once |
| Unit count on clean books | **None expected** | No `script`/`style` inside leaf containers → walker output identical |
| Spotlight / karaoke | Low, must be re-verified | Ranges come from the same arrays |
| Stored annotations (C-1/C-4) | **None** | Highlights and bookmarks use CFI, not unit indices |
| PDF | **None** | Different extraction path |
| Whole-body fallback | Low | It calls the same `segmentBlock`, so it inherits the filter — desirable |

---

## 10 · Classification

**PROVEN**
- The leak is `doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)` at line 2950 with no NodeFilter.
- `<script>` and `<style>` text reaches the walker; both are `display:none`, `offsetHeight:0`, absent
  from `innerText`.
- **`<noscript>` renders in this build** (`display:inline`, height 34, present in `innerText`) because
  scripting is disabled in the sandboxed iframe — measured, `scriptingRuns: false`.
- `<template>` content is unreachable by the walker.
- A `display:none` descendant of a visible container leaks today.
- Removing the ad node changes the real queue by exactly one unit (3/3 sections).
- No existing test covers any of this.

**DISPROVEN**
- *"Excluding `script, style, noscript, template` is safe."* Excluding `<noscript>` would remove prose
  the reader can see.
- *"The container-level `isHidden` check should have caught it."* The container is genuinely visible.
- *"Scripts execute in content documents."* They do not.

**UNVERIFIED**
- Whether surrounding unit **ranges** are unchanged after the fix (counts only, so far).
- Whether any corpus book hides prose in a `display:none` descendant.
- Whether the second script-bearing EPUB produces a spoken unit.
- Whether `<noscript>` occurs in any corpus book (if it does, today it is both visible *and* spoken —
  which is correct, and the fix must keep it that way).

**No product code was changed. Awaiting approval before implementing §6.**
