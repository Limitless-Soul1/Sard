# PDF sentence highlighting — feasibility and architecture study

> ## ⚠ STATUS 2026-08-08 — DORMANT, because PDF read-aloud is temporarily disabled
>
> The implementation described in §14 shipped and passed its acceptance gate. It is now **inactive**,
> because the feature it follows was switched off at the product level — a highlight cannot run without
> a read-aloud session. **Nothing was reverted or deleted.**
>
> With `PDF_TTS_ENABLED = false` (`src/lib/pdfText.ts`): no observer is installed, no stylesheet is
> injected, and `showReadingHighlight`'s fixed-layout branch returns immediately. Setting the constant
> to `true` restores everything proven here, unchanged.
>
> `tests/harness/pdf-highlight-acceptance.mjs` fails by design in this state — it presses a control
> that no longer exists. It is the gate to re-run when the feature is switched back on.

**Date:** 2026-08-08 · **Branch:** `develop` · **Build:** `test-build\Sard.exe` (with vendored patches 10
and 11) · **Product code changed: NONE.**

**Harnesses (read-only):** `tests/harness/pdf-highlight-poc.mjs`, `pdf-highlight-poc2.mjs`. Both tear
down every artifact they create (verified leftover = 0) and snapshot/restore the profile.

---

## 1 · Can PDF sentence highlighting be implemented?

**Yes — PROVEN, and it needs no new highlighting system.** Every mechanism it depends on was exercised
in the real binary during real playback. The design is the simple one: add a CSS class to the
text-layer spans the active unit covers, inside the page iframe.

Word-level highlighting is **DISPROVEN** — §8 gives the measurement.

---

## 2 · How EPUB highlighting works today (the reference)

`[PROVEN by source reading]`

| Concern | Mechanism |
|---|---|
| Surface | foliate's **SVG overlayer**, above the text — `overlayer.add(key, range, drawFn, opts)` |
| Keys | `READING_KEY = "sard-reading"` (sentence band), `WORD_KEY = "sard-reading-word"` (word pill). **Reserved** — never the annotations map or the DB, so a user highlight cannot collide |
| Draw | `drawReadingSpotlight(rects)` / `drawReadingPill(rects)` build SVG from the range's rects |
| Progress | `Reader.tsx:971-982` — an effect on `[ttsActive, ttsIndex, ttsStatus, ttsWords]` calls `ctrl.showReadingHighlight(ttsIndex)`, then `setReadingWords`, then `followReadingSentence` when playing |
| Pause / resume / seek | **Free.** All three change `ttsIndex`/`ttsStatus` in the store, so the same effect re-runs. Nothing pause-specific exists |
| Stop | `!ttsActive` → `clearReadingHighlight()` |
| Staleness | `showReadingHighlight` returns early if `content.index !== this.ttsUnitsIndex` — the units carry the section they were built for |
| Redraw hook | `onReadingRedraw(cb)` → `readingRedrawCb`, re-drawn at the store's current index after a section is recreated |
| **PDF today** | `showReadingHighlight` line 3041: **`if (this.isFixedLayout) return;`** — and `setReadingWords` line 3094 does the same. PDF is excluded at the first statement |

**The integration point already exists and is already correct.** PDF highlighting is not new wiring; it
is replacing two early returns with a fixed-layout branch.

---

## 3 · The PDF path

`[PROVEN — measured]`

| Fact | Evidence |
|---|---|
| No overlayer on this path | `overlayerInDoc: false` |
| Page is a same-origin iframe document | `d.defaultView !== window` |
| Text layer is real positioned spans | 47 spans on the test page, non-zero rects |
| Spans accept classes | `classList.add` succeeds |
| A stylesheet can be injected into the page | `document.head` writable — `setPdfTheme` already does exactly this |
| Units are built by `pdfPageUnits()` | span → `normalizePdfText` → filter → join → `Intl.Segmenter` → map back → `setStartBefore`/`setEndAfter` |
| Ranges are span-granular | not character-granular |
| A page change is a **new document** | `sameDoc=false`; marks do not carry (0 of 37) |
| A zoom **clears and rebuilds** the layer | consequence of vendored patches 10/11 — see §5 |

---

## 4 · Direct span marking — proven end to end

The harness reproduced `pdfPageUnits` and **cross-validated the replica against the real pipeline
before using it**, because a probe that does not exercise the real path is only a hypothesis.

**GATE 0 — replica fidelity `[PROVEN]`:** real units **5** = replica units **5**; joined text
**identical**; every unit maps to ≥1 span; spans per unit `[18, 2, 2, 2, 1]`.

| Case | Result | Label |
|---|---|---|
| Mark units 0→1→2→3→4 in turn | Each marks its spans; the previous mark is always cleared first | **PROVEN** |
| Highlight actually paints | `backgroundColor = rgba(255,214,0,0.38)` on the marked spans | **PROVEN** |
| **Live playback tracking** | During real audio, store index **0 → 1 → 2**; re-deriving on each change marked 18 → 2 → 2 spans, text following the spoken sentence | **PROVEN** |
| **Pause** | `status=paused`, mark still present (2 spans) | **PROVEN** |
| **Resume** | mark retained | **PROVEN** |
| **Seek** (`skip(1)`) | index → 3, re-derive marked the correct 2 spans | **PROVEN** |
| **Page change** | new page: **0 stale marks**; re-derive gives that page's units; re-mark works (13 spans) | **PROVEN** |
| **Return to a visited page** | 0 stale marks, 5 units again | **PROVEN** |
| Teardown | 0 leftover artifacts | **PROVEN** |

---

## 5 · Zoom — and a correction to the previous report

**⚠ The earlier handoff statement that "a zoom does not require re-derivation" is now DISPROVEN, and it
was my own fix that changed it.** Before the accumulation fix, old spans were *kept* and new ones
appended, so marks appeared to survive. Now the container is correctly cleared on every re-render, so
**marked nodes are destroyed**.

`[PROVEN]` Marks before a zoom: **2** → immediately after: **0** → after re-deriving: **2**.

The design depends on re-deriving **by unit index**, so the real question is whether index *N* still
means the same sentence at another scale. Measured across `fit-page → 2 → 3 → 4 → fit-page`:

| Zoom | spans | units (replica / real) | spans per unit |
|---|---|---|---|
| fit-page | 47 | 5 / 5 | `[18,2,2,2,1]` |
| 2 | 47 | 5 / 5 | `[18,2,2,2,1]` |
| 3 | 47 | 5 / 5 | `[18,2,2,2,1]` |
| 4 | 47 | 5 / 5 | `[18,2,2,2,1]` |
| fit-page | 47 | 5 / 5 | `[18,2,2,2,1]` |

**Unit count, unit text and the span mapping are all identical at every scale `[PROVEN]`.** Re-deriving
by index after a zoom is therefore safe — it cannot land on a different sentence.

**The injected `<style>` survives the re-render `[PROVEN]`** (it lives in `<head>`, not in `.textLayer`),
so only the class needs re-applying, not the stylesheet.

---

## 6 · Themes

`[PROVEN]` Driven through the **real** chips (`.pdf-chip-<id>` after opening the PDF panel). The first
attempt used a wrong selector and reported an identical filter for all four themes — that run was void
and was re-done rather than reported.

| Theme | image filter | tint | marks | highlight on top? |
|---|---|---|---|---|
| normal | `none` | transparent | 2 | ✅ |
| sepia | `contrast(0.96) brightness…` | `rgb(217,185,130)` | 2 | ✅ |
| night | `invert(1) hue-rotate(180…` | transparent | 2 | ✅ |
| ink | `grayscale(1) contrast(1.…` | transparent | 2 | ✅ |
| cream | `contrast(0.96) brightness…` | `rgb(240,226,192)` | 2 | ✅ |
| grey | `invert(0.9) hue-rotate(1…` | transparent | 2 | ✅ |

**6 distinct filters and 3 distinct tints — the themes genuinely changed.** Under every one, the marked
span is the **top element at its own centre point** (`elementFromPoint`) and its background is
unchanged. The theme cannot paint over the highlight and cannot recolour it:

- the image filter targets `#canvas img`; the text layer is **outside** `#canvas`;
- the tint is `#canvas::after`, also inside `#canvas`, while `.textLayer` is a later sibling.

`[INFERRED — not measured]` A theme switch should not *remove* an existing mark, because `setPdfTheme`
only writes a `<style>` element and never calls `render()`. The harness re-applied the mark after each
switch, so this was not proven directly. **Cheapest experiment:** mark, switch theme, and read the mark
count without re-applying.

---

## 7 · Can it reuse the existing EPUB TTS state and index?

**Yes, completely `[PROVEN]`.** The harness drove the whole lifecycle from
`window.__sardTtsStore.getState().index` and nothing else. No parallel state, no second index, no new
scheduler interaction.

- `ttsUnits` / `ttsUnitsIndex` already exist on the controller and are already set for PDFs by
  `getChapterUnits` (the fixed-layout branch stores `content?.index ?? this.pdfPageIndex`).
- The `Reader.tsx` effect already fires on exactly the transitions that matter.
- `LISTENING-OUTCOMES.md` C-6 requires the listener's surface — including sentence highlighting — to be
  preserved; reusing the same state is what keeps EPUB and PDF one behaviour rather than two.

---

## 8 · Word-level highlighting — DISPROVEN

The repair is **lossy by construction**, so character offsets in the repaired string do not map back to
offsets in the source spans.

`[PROVEN]` On one page: **20 of 47 spans change length** under `normalizePdfText`. Raw 800 chars →
repaired 794. The changes go in **both directions**, so a global offset correction cannot exist:

| raw → repaired | source | result |
|---|---|---|
| 16 → **17** | `أﺑﻮ اﻟﻌﻼء املﻌﺮي` | `أبو العلاء املعري` — lam-alef expands **one** character into **two** |
| 1 → **0** | a lone separator | deleted |

Four transformations each break the mapping independently: NFKC folding, lam-alef expansion (1→2),
tatweel deletion, and bidi/zero-width control deletion. Even with a perfect offset map, the ranges are
**span-granular** (`setStartBefore`/`setEndAfter`) — a pdf.js span is a positioned text run, not a word.

**Sentence-level highlighting is the reliable ceiling on PDF, and this should be stated rather than
discovered.** It matches the existing engine asymmetry: word timings are an Edge/tier-1 feature, and
karaoke already degrades to the sentence spotlight on Piper.

---

## 9 · Recommended architecture

```
PDF iframe → pdf.js text layer → pdfPageUnits() → active index (TTS store)
           → re-derive covered spans → add/remove one class
```

**Rules that follow from the measurements:**

1. **Never store a live `Range` or a span list.** Re-derive from the unit index on every application.
   It is cheap (47 spans) and it is the only thing that survives a zoom re-render.
2. **Inject the highlight stylesheet per page document**, next to the theme injection, with its own id.
   It survives re-renders; only the class needs re-applying.
3. **Re-apply on three events:** unit index change (already wired), **zoom** (new), and page change
   (new document).
4. **Reserve the class name**, as `READING_KEY` is reserved, so it can never collide with page content.
5. **No overlayer, no coordinate maths, no second highlight system.**

---

## 10 · Exact files that would change

| File | Change | Risk |
|---|---|---|
| `src/reader-engine/FoliateController.ts` | Replace the `if (this.isFixedLayout) return;` early return in `showReadingHighlight` with a fixed-layout branch calling a new private `pdfMarkUnit(i)`; same for `clearReadingHighlight`. Add the per-page style injection beside `setPdfTheme`. Call the redraw callback from `setPdfZoom` and on the page-load handler that sets `pdfPageDoc`. | Low — additive; the EPUB path keeps its exact code |
| `src/features/reader/Reader.tsx` | **Probably none.** The effect at 971-982 already calls `showReadingHighlight(ttsIndex)`. Only needed if the zoom redraw is wired at this level instead | None |
| `src/lib/tts.ts`, `ttsScheduler.ts` | **None.** | — |
| `src/styles/global.css` | **None** — the rule lives inside the page iframe, so it must be a string in the controller | — |
| `public/foliate-js/*` | **None.** | — |

`setReadingWords` keeps its `isFixedLayout` early return — §8 is why.

---

## 11 · Acceptance gates

| Harness | Must show |
|---|---|
| `pdf-highlight-poc.mjs` (promote) | replica gate passes; marks follow the live index; survive pause; remap on seek; drop on page change |
| `pdf-highlight-poc2.mjs` (promote) | unit text stable across zoom; mark recoverable after zoom; highlight top-most under all 8 themes |
| `pdf-tts-diagnosis4.mjs` / `5` | still 47 spans / 5 units — highlighting must not reintroduce accumulation |
| `pdf-acceptance.mjs` | 8 themes geometry-identical, 0 premature page turns, TTS units 5 |
| `tts-live.mjs` | EPUB unaffected |
| `npm test`, `tsc` | 376/376, clean |

The two PoC harnesses should be **rewritten to drive the product's own code** once it exists — their
replica is a scaffold for studying the design, not a permanent test double.

---

## 12 · Known failure cases

| Case | Behaviour | Correct? |
|---|---|---|
| Unit with no spans | no highlight, speech continues | Yes — honest, matches EPUB's null-range rule |
| Scanned PDF | no units, no control | Yes |
| Watermark-only | units rejected by `hasSpeakableText` | Yes |
| **Very long first unit** | unit 0 covered **18 of 47 spans** — nearly half the page highlighted at once | ⚠ Cosmetic. Sentence segmentation on a title page produces one large "sentence". Worth watching, not blocking |
| Zoom mid-sentence | mark vanishes until re-applied | Must be wired (§9.3), or the highlight disappears on zoom |
| Rapid zoom burst | patch 11 discards superseded renders | Re-derive after the last render settles |
| Theme switch | mark expected to persist | `[INFERRED]` — prove before shipping |
| Page turn while playing | new document, no marks | Re-derive; audio continues since units are per page |

---

## 13 · Verdict

**Implementable, low-risk, and small.** One controller branch, one injected stylesheet, three redraw
triggers. It reuses the TTS state, the unit contract, the theme injection pattern and the existing
`Reader.tsx` effect. Nothing in TTS, EPUB, zoom, themes or the vendored renderer needs to change.

**One correction carried forward:** the "spans survive zoom" claim in the earlier report is dead — the
accumulation fix invalidated it, and the design must re-derive after a zoom. Everything else in the
proposed design survived contact with measurement.

**Not proven, and cheap to prove before implementation:** that a theme switch alone leaves an existing
mark in place (§6).

**No product code was changed by this investigation.**

---

## 14 · IMPLEMENTED — 2026-08-08 (RAWY-295)

Approved and built. **One product file changed: `src/reader-engine/FoliateController.ts`.** No vendored
code was touched, so **no `VENDOR.txt` entry was added**. No changes to the TTS engine, the scheduler,
the EPUB path, PDF themes, the zoom engine or `global.css`.

### What was added

| Piece | Purpose |
|---|---|
| `pdfDeriveUnits(doc)` | The **one** derivation, now returning the covered `spans` alongside `{text, range}`. `pdfPageUnits` became a projection of it, so speech and highlight can never disagree |
| `PDF_HL_CLASS = "sard-pdf-reading"` | Reserved and prefixed, the same rule as `READING_KEY`/`WORD_KEY` |
| `pdfEnsureHighlightStyle(doc)` | Injects one rule into the page's `<head>`, beside the theme sheet. `background` only — never a filter, because the theme owns filters on this page |
| `pdfMarkUnit(i)` / `pdfClearMarks(doc?)` | Clear, re-derive, add the class. Honours `ttsSpotlightOn` — one preference, both formats |
| `pdfWatchLayer(doc)` | A `MutationObserver` on `.textLayer` (`childList` only) that re-applies after pdf.js rebuilds the layer |
| `pdfHighlightIndex` | The active unit, so a rebuild can restore it without consulting the store |

**Wiring — three call sites, no new state machine:**
- `showReadingHighlight(i)`: the `isFixedLayout` early return became the PDF branch.
- `clearReadingHighlight()`: forgets the index **first**, then unmarks, so a rebuild racing the clear
  cannot repaint what is being removed. Unconditional, because one controller instance serves both
  formats (`Reader` renders it with no `key`).
- The fixed-layout `load` handler: watches the new layer and asks for a redraw.
- `dispose()`: disconnects the observer and nulls the index.

**Two deliberate choices worth recording.** The sampling side effect (`pdfSeenPages`) stayed in the
`pdfPageUnits` wrapper rather than moving into the shared derivation — the highlighter calls the
derivation on every unit change, and one page pushed dozens of times would corrupt the document
verdict's `coverage`. And the layer is watched with an observer rather than hooking `setPdfZoom`,
because that catches **any** cause of a rebuild — a resize or a fit-mode recompute — not just zoom.
`attributes` is deliberately not observed: adding the class is an attribute mutation and would re-enter.

### Acceptance evidence — `tests/harness/pdf-highlight-acceptance.mjs`

New gate. It drives the **product's** code and contains no replica.

| Case | Result | Label |
|---|---|---|
| Idle before playback | 0 marks, 47 spans present | **PROVEN** |
| Follows the index | 0 → 1 → 2, marking 18 → 2 → 2 spans, **3 distinct texts** | **PROVEN** |
| Top-most and contained | `topmost=true`, `insidePage=true` at every index | **PROVEN** |
| Pause / resume | mark retained through both | **PROVEN** |
| Seek | `skip(1)` → index 3, highlight moved to the new sentence | **PROVEN** |
| **Zoom 2×/4×/6×/fit-page** | index frozen at 3, **same 2 spans, same text at every level**, spans stay 47 | **PROVEN** |
| **All 8 themes, switch alone** | 8 distinct filters; mark count, text and top-most **unchanged with no re-application** | **PROVEN** |
| Desk unaffected | `rgb(14,14,14)` under every theme | **PROVEN** |
| Page change | no leak to the next page | **PROVEN** |
| Return to page | highlight restored | **PROVEN** |
| Stop | cleared | **PROVEN** |
| Scan PDF | no control, no marks | **PROVEN** |

**§6's `[INFERRED]` is now `[PROVEN]`:** a theme switch alone does not destroy the highlight. The gate
deliberately re-applies nothing during that stage.

### An instrument defect caught in the gate itself

The first run reported four zoom violations — "highlight moved to different text". It had not. Playback
was still running through four 5-second waits, so the sentence index legitimately advanced 3 → 4 and the
highlight correctly followed; the harness was comparing against a stale pre-zoom snapshot. Corroborating
detail: unit 4 has exactly **1** span (`[18,2,2,2,1]`) and the run reported `marks=1`.

The gate now **pauses before the zoom stage and records the index at every step**, so "the highlight
must not move" is a meaningful assertion instead of a race against playback.

### Regression results

`tsc` clean · **376/376** unit tests · `build:test` OK · `pdf-tts-diagnosis4` — 47 spans / 5 units,
no accumulation · `pdf-tts-diagnosis5` — 3 cycles + hostile burst, **0 violations** ·
`pdf-acceptance` — 8 themes geometry-identical, 0 premature turns at 400%/600% forward and reverse, and
**`highlightNodes` 0 → 18**, the pre-existing harness independently observing the feature ·
`tts-live` (EPUB) — playing, spotlight, pause/resume/seek unchanged.

### Known limitations, recorded rather than engineered away

1. **Unit 0 covers 18 of 47 spans** on the title page — nearly half the page highlighted at once,
   because sentence segmentation yields one long "sentence" there. Sentence-level highlighting is the
   supported behaviour; the segmentation algorithm was **not** changed to make this look smaller.
2. **No word-level highlighting.** §8 — the repair is lossy and the ranges are span-granular.
3. **`followReadingSentence` stays EPUB-only.** A fixed-layout page does not scroll to a sentence; the
   whole page is on screen.

### UNVERIFIED after implementation

- Behaviour on a **partially extractable** PDF during playback (pages that alternate between units and
  none). Extraction is characterised; highlighting across that boundary is not.
- Long-session behaviour: no endurance run was made with highlighting active.
- Whether the observer adds measurable cost on a very span-dense page (47 here; some PDFs carry far
  more).
