# PDF read-aloud — investigation report

> ## ⚠ STATUS 2026-08-08 — PDF READ-ALOUD IS **TEMPORARILY DISABLED** AT THE PRODUCT LEVEL
>
> **This is a product decision, not a defect and not a rollback.** Everything this report proves is
> still true and the implementation is intentionally preserved and still compiles. A reader simply
> cannot reach it: no Listen control, no player, no highlighting, no observer.
>
> **The gate:** `PDF_TTS_ENABLED` in `src/lib/pdfText.ts` — one constant, four call sites, all
> greppable by that name. **To re-enable, set it to `true`.** Nothing else needs editing.
>
> **The harnesses below are NOT broken.** `pdf-highlight-acceptance.mjs` and the playback stage of
> `pdf-tts-diagnosis5.mjs` fail by design, because the control they press is hidden. The extraction
> harnesses still pass — `pdf-acceptance` still reports `units 5 (ranges 5)` with `button false`.

**Date:** 2026-08-08 · **Branch:** `develop` · **HEAD:** `da891b5` · **Build:** `test-build\Sard.exe`
2026-08-07 22:54:56, verified newer than every source file · **Product code changed: NONE.**

**Instruments:** `window.__sardTtsStats()`, `window.__sardTtsStore.getState()`, `window.__sardPdfTts(lang)`,
driven over CDP against the real binary. Harnesses: `tests/harness/pdf-tts-diagnosis{,2,3,4}.mjs`,
results in the sibling `*-result.json` files. Profile snapshotted and restored on every run (all four OK).

---

## 1 · Executive verdict

| Question | Answer |
|---|---|
| **Is PDF read-aloud feasible in Sard?** | **It is not merely feasible — it already works.** Measured playing audio on رسالة الغفران, advancing through units. |
| **Is synchronised sentence highlighting feasible?** | **Yes**, and more cheaply than the handoff assumed. The page document survives zoom, spans accept classes, and a stylesheet can be injected into the page iframe. |
| **What is already proven?** | Extraction, Arabic repair, sentence segmentation, `{text, range}` units, synthesis, blob creation, decode, and playback — the whole chain. |
| **What is currently broken?** | **One defect, in the vendored renderer:** every zoom re-render *appends* another copy of the text layer instead of replacing it. After four zooms the page yields 35 units instead of 5, and read-aloud would speak the page seven times over. |

**The reported blocker — "PDF TTS produces no audio" — is DISPROVEN.** It rested on a probe that cannot
see Sard's audio, and the product's own source warns about exactly that probe.

---

## 2 · Evidence

### PROVEN

| # | Finding | Measurement |
|---|---|---|
| P1 | **PDF read-aloud produces audio.** | `status=playing`, `media.paused=false`, `readyState=4`, `isBlob=true`, `blobs.created` incrementing. Two independent runs. |
| P2 | **It advances through units.** | Sentence index reached **2 of 5** on the text-rich page; `underruns=0`, `abandoned=0`, `lastFailure=null`. |
| P3 | **EPUB control works in the same session.** | `status=playing`, `readyState=4`, 96 units, `wordIndex` advancing. |
| P4 | **Edge is reachable in this environment.** | `tts_edge_voices` → **322 voices, 32 Arabic**. |
| P5 | **Extraction and Arabic repair work.** | Raw spans carry presentation forms (`رﺳﺎﻟﺔ اﻟﻐﻔﺮان`); units carry letters (`رسالة الغفران تأليف أبو العلاء…`). `legible = 1.000`. |
| P6 | **Units carry ranges, 5/5.** | `units=5, withRange=5` on page 3; `units=1, withRange=1` on page 2. |
| P7 | **Ranges are owned by the page's own iframe document.** | `docIsIframe=true`; `d.defaultView !== window`. |
| P8 | **Zoom performs a real re-render.** | Page box **540×720 → 1350×1800**, `naturalWidth` 540 → 1350 at `zoom=3`. |
| P9 | **🔴 The text layer ACCUMULATES on every zoom.** | spans 47 → 141 → 188 → 235 → 329; chars 800 → 5600; opening phrase repeats **1 → 3 → 4 → 5 → 7**; **units 5 → 35**. `layerCount` stays **1** throughout — one container, growing. |
| P10 | **A page change clears it.** | Returning to the page: 47 spans, 800 chars, 5 units — identical to baseline. |
| P11 | **Each page is a NEW document object.** | `sameDoc=false` across a page turn; marks applied to the old page do not appear on the new one (0 of 37). |
| P12 | **The page document SURVIVES zoom.** | `sameDocObject=true`; all 47 original spans still connected, with their attributes **and** their classes intact. |
| P13 | **Text-layer spans are markable and the page is styleable.** | `classList.add` succeeds; `document.head` present for style injection. |
| P14 | **No overlay surface exists on the fixed-layout path.** | `overlayerInDoc=false`. |
| P15 | **Root cause located at source.** | `public/foliate-js/pdf.js:35` replaces the image (`replaceChildren`); lines 37–42 render the text layer into `.textLayer` **without clearing it**; line 111 routes every zoom back through the same function. |
| P16 | **`CSS.highlights` is available** in WebView2. | `cssHighlightApi=true` (recorded as an option, not a recommendation). |

### DISPROVEN

| # | Claim | Why it is wrong |
|---|---|---|
| D1 | *"PDF TTS produces no audio."* | P1/P2. The evidence for it was `document.querySelectorAll('audio') → []`. The pool is built with `new Audio()` and never attached to the DOM — [tts.ts:930](src/lib/tts.ts#L930) states that a `querySelectorAll('audio')` probe "silently matches nothing". The probe was blind by construction. |
| D2 | *"The exact failing call has never been observed / it is unknown whether synthesis reaches Rust."* | Synthesis reaches Rust, returns audio, and the audio decodes and plays. |
| D3 | *"pdf.js rebuilds the text layer on every zoom re-render."* | It **appends**. The document object, the span nodes, their attributes and their classes all survive (P9, P12). This inverts the handoff's central highlighting constraint. |
| D4 | *"Anything holding a DOM Range across a zoom is stale."* | Not across zoom — the nodes persist. It is true across a **page change** (P11). |

### UNVERIFIED

- **Whether the previous session's failure was real.** It is consistent with a transient Edge outage or a
  cold-socket timeout, but that session's environment cannot be reconstructed. Not reproduced here.
- **Time to first audio.** Cold PDF **18.0 s** vs cold EPUB **7.0 s**; warm PDF 2.8 s. PDF units average
  **148 chars** (742 chars / 5 units). Synthesis time tracks sentence length (~0.37–0.45× audio duration,
  RAWY-265), so the gap is *plausibly* unit length rather than format — **not yet isolated**.
- **Behaviour on the damaged corpus during playback.** Extraction verdicts are known from `pdf-tts.mjs`;
  playback on those files was not driven.
- **Whether accumulation also occurs on window resize** (`fit-page`/`fit-width` recompute on resize).
- Whether `1 → 3` on the first zoom (two copies, not one) is a double render or a resize plus a zoom.

### HYPOTHESIS

- **H1** The 18 s cold start is dominated by the first unit's length plus a cold WebSocket connect, not by
  anything PDF-specific. Falsified if a short first unit still takes ~18 s cold.
- **H2** `container.replaceChildren()` before `textLayer.render()` fixes P9 completely, because the image
  path two lines above already does exactly that and does not accumulate.
- **H3** The accumulation is the *real* origin of the original report: after zooming, a listener hears the
  page repeated, which is easy to describe as "read-aloud is broken".

---

## 3 · PDF vs EPUB — where the pipelines meet and part

| Stage | EPUB | PDF | Same? |
|---|---|---|---|
| Source DOM | Section iframe document | **Per-page** iframe document | Different lifetime |
| Text acquisition | Semantic containers (`p, h1…, li, blockquote…`), leaf-only, hidden-aware | pdf.js `.textLayer` positioned `<span>`s | **Different** |
| Repair | none needed | `normalizePdfText` (NFKC, tatweel, bidi, hyphenation) + `stripPdfArtifacts` | **PDF-only** |
| Segmentation | `Intl.Segmenter`, granularity `sentence` | `Intl.Segmenter`, granularity `sentence` | **Identical** |
| Unit contract | `{ text, range }[]` | `{ text, range }[]` | **Identical** |
| Range construction | `segmentBlock` over text nodes — character-granular | `setStartBefore`/`setEndAfter` on spans — **span-granular** | **Different granularity** |
| Entry point | `getChapterUnits()` | `getChapterUnits()` → `pdfPageUnits()` | **Identical entry** |
| Scheduler / retry ladder | shared | shared | **Identical** |
| Synthesis | `tts_synthesize(engine,id,text)` | same | **Identical** |
| Playback | detached `new Audio()` pool → `createMediaElementSource` → gain | same | **Identical** |
| Highlight surface | foliate overlayer (SVG) | **none** (`overlayerInDoc=false`) | **Different** |
| Unit scope | a whole chapter (96 units) | **one page** (1–5 units) | **Different** |

**There is no second TTS implementation, and none is needed.** The divergence is confined to two places:
how text is *acquired* and how it is *highlighted*.

---

## 4 · Root cause analysis

**Earliest confirmed failure point: `public/foliate-js/pdf.js`, the text-layer render, lines 37–42.**

The renderer clears the image container and does not clear the text container:

```js
doc.querySelector('#canvas').replaceChildren(pageImg)   // image: REPLACED
const container = doc.querySelector('.textLayer')        // text: reused as-is
const textLayer = new pdfjsLib.TextLayer({ textContentSource: …, container, viewport })
await textLayer.render()                                 // APPENDS into container
```

`onZoom` (line 111) calls the same `render` for every zoom change, so each zoom deposits another full copy
of the page's spans into the one container. Every downstream symptom follows arithmetically:

```
zoom changes → duplicate spans → duplicated joined text → inflated sentence count
   47 spans →  329 spans       →  800 → 5600 chars       →  5 → 35 units
```

**This is not the failure that was reported, and the reported failure does not exist.** The reported
symptom ("no audio") was an artifact of a blind probe. The defect that *is* present was never reported,
because nobody had zoomed and then listened.

**Attribution:** the accumulation is a defect in the **vendored renderer**, not in Sard's own PDF code.
`pdfPageUnits` reads `doc.querySelector('.textLayer')` faithfully; it is handed duplicated input.

---

## 5 · TTS architecture recommendation — reuse, do not rebuild

**Change nothing in the TTS subsystem.** It is already shared end to end, and the measurements confirm the
shared path carries PDF correctly. Specifically:

- **Do not touch `ttsScheduler.ts`.** The desktop TTS strategy states that if Phase 8 finds itself editing
  the scheduler, the trait is wrong; the same test applies here. Nothing in PDF read-aloud requires it.
- **Keep the single `{text, range}` contract.** PDF already satisfies it, 5/5.
- **Keep `getChapterUnits()` as the one entry point.** The fixed-layout branch is three lines and is the
  correct seam.
- **The only correct fix is upstream of the units**: stop the text layer from accumulating, so
  `pdfPageUnits` receives one copy of the page. Nothing after that stage needs to know PDFs exist.

**Recommended fix (product change — requires approval, not applied):** one vendored patch, clearing the
container before render, registered in `public/foliate-js/VENDOR.txt` with a re-apply note. This mirrors
the image path two lines above, so it is a consistency repair rather than a new mechanism. Estimated one
line plus the register entry.

**Rejected alternative:** de-duplicating in `pdfPageUnits`. It would hide a renderer defect behind reader
logic, leave the DOM growing without bound between page turns, and still corrupt any span-indexed
highlighting. Treating the symptom where the cause is two lines away is the wrong trade.

---

## 6 · Highlighting architecture

The measurements change the recommended design, and simplify it.

**What is true (P9–P14):**
- The page **document object survives zoom** — only the span *set* grows.
- Span nodes survive zoom **with classes intact**.
- A page change creates a **new document**; nothing carries over.
- There is **no overlayer** on this path, and none is needed.
- The page is same-origin and `head` is writable, so a stylesheet can be injected.

**Recommended design — mark the spans, own the stylesheet:**

1. **Inject one stylesheet per page document**, alongside the existing `setPdfTheme` injection, defining a
   single rule for a sentence-highlight class. The theme path already proves per-page injection works.
2. **Derive the covered spans from the active unit index**, never from a stored live `Range`. The unit's
   range already resolves to spans (`spansRecoverableFromRange=3`, `getClientRects()=8`), so resolution is
   available; storing an *index* rather than a node list is what makes it cheap to recompute.
3. **Re-apply on two events only:** page change (new document) and zoom (span set changed). Both are
   already observable — the controller captures `pdfPageDoc` on load and owns `setPdfZoom`.
4. **Clear before applying** — one class add and remove, no geometry maths, no coordinate transforms.

**Once the accumulation defect is fixed, zoom stops mattering for highlighting**, because the span set
becomes stable. Re-deriving after zoom then becomes belt-and-braces rather than a requirement — a
meaningful simplification versus the handoff's proposed design, which assumed a rebuild on every zoom.

**Word-level highlighting: not realistically available.** Ranges are span-granular
(`setStartBefore`/`setEndAfter`), and a pdf.js span is a positioned text run, not a word. Word-level would
require character-level mapping from the repaired string back to source offsets — and the repair is
*lossy by design* (NFKC folds presentation forms, lam-alef expands one character into two, tatweel and
bidi controls are deleted). **The mapping does not survive the repair**, so word karaoke on PDF is a
research task, not a feature. Sentence highlighting is the honest ceiling. This matches Edge word timings
being a tier-1 EPUB feature only.

---

## 7 · Failure cases and the behaviour each deserves

| Case | Measured state | Correct behaviour |
|---|---|---|
| **Normal text PDF** | 5 units, 5/5 ranges, `legible=1.000`, plays | Read aloud with sentence highlighting. No caveat. |
| **Damaged Arabic text layer** | repair recovers presentation forms; residual lam-alef ordering (`املعري`) persists — a file defect | Read aloud, but the document is *partial*: say so once, do not block. |
| **Watermark-only** | `stripPdfArtifacts` removes URLs; `hasSpeakableText` rejects what is left | Offer no control; show the explanatory notice. |
| **Scanned, no text layer** | `units=0`, verdict `no-text-layer` | Offer no control. A dead control is worse than an absent one. |
| **Partially extractable** | some pages yield units, others none | Offer the control (availability is document-level and sticky) and stay silent on empty pages rather than announcing each one. |

⚠ **A defect found in passing, not part of the brief:** on رسالة الغفران the document verdict was
`unusable / sparse-text-layer` (coverage 0.333) **while the same page produced perfect units**
(`legible=1.000`). The verdict is computed from pages *visited so far*, so it is pessimistic early in a
document and disagrees with the pipeline feeding the engine. This is open issue #6, now reproduced and
better characterised: it is a **sampling-window** problem, not a scoring-threshold problem. Advisory only
— it does not gate playback.

---

## 8 · User-facing UX

The constraint is `LISTENING-OUTCOMES.md` **§3 C-6** (the listener's surface is preserved; changing it is a
separate product decision) and **P-8** (the listener must not perceive production). So: honesty once, not
running commentary.

**Recommended, for owner approval — no wording implemented:**

1. **Good documents say nothing.** No badge, no caveat, no quality score. Silence is the correct UI for a
   working feature.
2. **Partial documents get one quiet, dismissible line, once per book** — in substance: *"This PDF's text
   was extracted automatically; some words may be read incorrectly."* It names the cause (extraction, not
   Sard, not the book) and sets an expectation without alarming.
3. **Unusable documents get the existing notice and no control.** Already correct.
4. **Never show a numeric quality score.** It invites the listener to evaluate the machinery — precisely
   what P-8 forbids — and issue #6 shows the number is not yet trustworthy enough to publish.
5. **Never announce per-page extraction failures during playback.** Each one would be a perceptible
   production event (O8).

---

## 9 · Implementation plan

Each stage is independently revertible and has a criterion fixed **before** the work, per §7.3 of the
governing document.

| Stage | Work | Verification criterion |
|---|---|---|
| **1** | **Vendored patch:** clear `.textLayer` before render in `public/foliate-js/pdf.js`; register in `VENDOR.txt`. | Re-run `pdf-tts-diagnosis4.mjs`: after zooms 2/3/4 and back to fit-page, spans stay **47**, `headRepeats` stays **1**, units stay **5**. **Red-verify first**: the harness must fail on the current build — it does, and that is recorded above. |
| **2** | Confirm no regression in what is already proven. | `pdf-acceptance.mjs` and `pdf-zoom-theme.mjs` pass unchanged: geometry, containment, 8 themes, 0 premature page turns. |
| **3** | **Sentence highlighting**: per-page stylesheet + mark-by-unit-index; re-apply on page change. | A harness proves the marked span set changes as the unit index advances, and that marks are correct after a page turn and after a zoom. |
| **4** | **O5 attribution** (isolate the 18 s cold start). | Measure time-to-first-audio against first-unit length, PDF vs EPUB, cold and warm. Either attribute it to length or open a defect. |
| **5** | **UX copy**, only if the owner approves §8. | Both locales; shown once per book; absent on good documents. |
| **6** | Documentation. | Handoff and workflow updated; this report retained as the evidence record. |

**Stage 1 is the whole blocker.** Stages 3–5 are product changes requiring approval.

---

## 10 · Conclusion on readiness

**The evidence is strong enough to begin Stage 1 immediately**, and it is the smallest correct change: the
cause is located at a specific line, the mechanism is arithmetically consistent with five independent
measurements, the fix mirrors code two lines above it, and a red-verified harness already exists to prove
it.

**Stages 3–5 need an owner decision, not more evidence.** They change product behaviour.

**Evidence still missing, named precisely:**

1. **O5 attribution** — whether 18 s cold is unit length or something PDF-specific (Stage 4).
2. **Playback on the damaged corpus** — extraction is characterised, playback is not.
3. **Whether a window resize accumulates** like a zoom does.
4. **Whether the first zoom's double copy** (1 → 3) is a double render or a resize-plus-zoom.
5. **Nothing about the original report** can be recovered; it is not reproducible and should be closed as
   *not reproduced, superseded by the accumulation defect*, rather than left open as "no audio".

**No product code was changed by this investigation.**

---

## 11 · Outcome of Stage 1 (added 2026-08-08, after the fix)

Stage 1 was approved and applied: `container.replaceChildren()` in `public/foliate-js/pdf.js`, plus
VENDOR.txt patch 10. **The gate did not turn fully green, and the reason is a second defect the
investigation did not separate from the first.**

| Zoom step | Before patch | After patch | Clean? |
|---|---|---|---|
| baseline (fit-page) | 47 spans · 5 units | 47 · 5 | ✅ |
| → zoom 2 (from fit mode) | 141 · 15 | 86 / 58 (**varies**) | ❌ |
| → zoom 3 (numeric→numeric) | 188 · 20 | **47 · 5** | ✅ |
| → zoom 4 (numeric→numeric) | 235 · 25 | **47 · 5** | ✅ |
| → back to fit-page | 329 · 35 · phrase ×7 | 94 · 10 · ×2 | ❌ |

**What the patch did fix:** the append/replace asymmetry, and with it the *unbounded* growth. Worst case
fell from **7 copies to 2**, and it no longer compounds with the number of zooms.

**What remains — a separate defect, hypothesis H-race:** `render()` is `async` and not reentrancy-safe.
The clear runs, then two `await`s (`streamTextContent()`, `textLayer.render()`) pass before the spans
land, so two overlapping renders each clear and then each append. Transitions **to or from a fit mode**
appear to fire two renders (a fit mode needs a layout measurement) and land deterministically on
**94 = 47 × 2**; a pure numeric step fires one and is clean.

**Proven a race rather than residue:** the `zoom 2` step measured **86 spans on one run and 58 on the
next** — a deterministic leftover cannot vary — while `back to fit-page` was 94 on both.

**Scope was not expanded.** The remaining fix (a render generation/guard) is a different change with a
different risk profile and was left for a separate decision.

### Stage 1b — the race fix (approved separately, applied 2026-08-08)

Vendored **patch 11**: a `WeakMap` render generation keyed by the **page document**, three staleness
checks, and the `streamTextContent()` await hoisted out of the `TextLayer` options literal so
clear→construct→append become adjacent. Keyed per document rather than module-wide so two different
pages rendering at once (a spread, a prefetched neighbour) cannot cancel each other.

| Test | Result |
|---|---|
| `diagnosis4` single ladder | **47 spans / 5 units / headRepeats 1** at every step |
| 4 × cycle fit→2→3→4→fit, varied settle (16 samples) | **all 47 / 5** |
| Hostile burst — 4 zoom changes 120 ms apart | **47 / 5** |
| Read-aloud after cycling | total **5** units, `playing`, `readyState=4`, `underruns=0`, `abandoned=0`, `lastFailure=none` |
| Violations | **0** |

Varied timings and repetition were the point: the pre-fix race was intermittent (86 spans one run, 58
the next), so a single clean pass would have proved nothing.

**The two patches must travel together.** With only 10 the layer doubles on every fit-mode transition;
with only 11 it grows without bound.

**Verified unaffected by the patch:** 376/376 unit tests; `tsc` clean; EPUB read-aloud plays; PDF
read-aloud plays (`readyState=4`, index advancing); `pdf-acceptance` — 8 themes geometry-identical
`[1574,2432]` AR 0.647, 0 premature page turns at 400%/600%, TTS units **5 (ranges 5)**, player reads
«القراءة 1 من 5»; `pdf-zoom-theme` — byte-identical to the recorded baseline.
