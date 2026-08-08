# PDF themes, zoom, and read-aloud — investigation and implementation

Three requested features. Two are implemented and verified in the real binary; the third is
investigated, measured, and **deliberately not implemented** — the measurements say a naive version
would ship a feature that speaks gibberish.

---

## 1 · Reading themes — implemented

**What a PDF theme can be.** A PDF page is a raster: pdf.js paints it to a canvas and the pixels are
copied into an `<img>` (`public/foliate-js/pdf.js`). There is no text to recolour and no stylesheet to
inject, so an appearance can only be a colour transform over the finished page. The themes are filter
chains, tuned rather than invented — and tuned against scans, because four of the six library PDFs are
scans whose paper already carries a colour cast that stacks with any tint.

Eight appearances (`src/reader-engine/pdfView.ts`): Normal, Sepia, Warm paper, Cream, Soft green,
Dark grey, Night, High contrast. Each carries a filter **and** a desk colour, so a dark page is not
framed in white. Two notes on the tuning:

- **Dark grey** is a *softened* inversion (0.9, reduced contrast). A full invert on a scan turns paper
  grain into visible noise; stopping short of pure black keeps it quiet.
- **High contrast** exists for faint or badly exposed scans, the most common defect in this corpus.

The appearance is a global reading preference (a reader who wants sepia wants it for every PDF). A
reader who had previously chosen "inverted" is migrated once to Night, and only if they have not since
chosen a theme — nobody's setting is discarded, and nobody who never used invert gets a dark page.

## 2 · Zoom — implemented

**The key finding: the zoom engine already existed and was simply never exposed.** `fixed-layout.js`
observes a `zoom` attribute accepting a number, `fit-width` or `fit-page`, and for a PDF it calls back
into pdf.js to **re-render the page at that scale**. Sard never set the attribute, so the renderer sat
at its default — which is why a PDF could not be zoomed at all, and why the audit measured every page
at exactly fit-page.

This matters for quality: zooming gains **real resolution**, it does not magnify a bitmap. Measured on
الأمير الصغير — Ctrl+wheel took the page image from **466 px to 1212 px intrinsic width**. A CSS
magnification would have left the intrinsic width untouched and simply stretched it.

Delivered:

| Requirement | Status |
|---|---|
| Ctrl + mouse wheel | Yes — on the desk **and** over the page itself (the page's wheel fires inside the iframe and never reaches the desk, so both paths are wired) |
| Pinch gesture | Yes — a trackpad pinch arrives as `wheel` with `ctrlKey`, the same path. No separate gesture code |
| Zoom in / out buttons | Yes — a multiplicative ladder (0.5 → 6), so steps feel equal at every scale |
| Fit width / Fit page | Yes |
| Remember zoom per document | Yes — persisted per book id; verified 2.117 → 2.117 across close and reopen |
| Smooth, flicker-free | Wheel events are coalesced to one render per frame; settings writes are debounced so a gesture never writes a row per frame |

Zoom is remembered **per document** while the appearance is global — deliberately. The right
magnification depends on that file's page size and scan quality; the right colour does not.

Ctrl+wheel previously fell through to the paging branch, so the gesture every reader expects to
magnify a scan was turning the page instead. That is now fixed in both wheel paths.

### Verified at runtime

```
open (default): zoom=fit-page natural=466 shown=466
ctrl+wheel in:  zoom=3.081  natural 466 -> 1212   RE-RENDERED=true   page unchanged=true
zoomOut  zoom=3          fitWidth zoom=fit-width (800)   fitPage zoom=fit-page (420)
themes   sepia/night/green/ink all applied, correct filters and desk colours
reopen   zoom 2.117 -> 2.117  remembered=true  theme kept=true
page errors: 0
```

Harness: `tests/harness/pdf-zoom-theme.mjs`.

---

## 3 · Read-aloud for PDF — investigated, not implemented

I did not assume it was impossible. It is architecturally straightforward and **blocked by the
content**, which is a different and more useful answer.

### What is available

pdf.js already builds a real `TextLayer` per page, and `page.getTextContent()` exposes it. Sard's TTS
pipeline consumes DOM text and highlights sentences, so the wiring is not the hard part.

### What the corpus actually contains — measured

Five pages sampled per file (`tests/harness/pdf-text-layer.mjs`):

| File | Fonts | Pages with text | What the text layer holds |
|---|---|---|---|
| مقدمة ابن خلدون | 1 | **0 / 5** | nothing — scan |
| 697 | 0 | **0 / 5** | nothing — scan |
| الداء والدواء | 0 | **0 / 5** | nothing — scan |
| الأمير الصغير | 108 | 1 / 5 | only a repeated site watermark; the body is images |
| رسالة الغفران | 210 | 3 / 5 | Arabic, but **34 of 53 sampled characters are presentation forms** |
| فنّ الحرب | 125 | 4 / 5 | Arabic presentation forms mixed with mojibake (`Ûa ‘‹èÐ`) |

**Three of six have no text at all.** No engineering extracts text from a picture without OCR.

**The three that do are damaged**, in the specific way this project already suspected: the text is
encoded as **Arabic presentation forms** (U+FB50–FEFF) — the *glyph shapes* rather than the letters —
with ligature and word-order damage visible in the extraction (`املعري` for `المعري`). Presentation
forms render correctly on screen because they are what the page draws, but as *text* they are the
wrong codepoints: a speech engine handed them either refuses them or mispronounces the words.

Feeding this to TTS unfiltered would produce confident-sounding gibberish — worse than no feature,
because the reader cannot tell whether the book or the app is at fault.

### Recommended architecture — quality-gated, in three stages

**Stage 1 — a text-layer quality gate (small, worth doing first).** On open, sample N pages and score
the layer: coverage (pages with text), the ratio of base Arabic letters to presentation forms,
private-use codepoints, and word-length sanity. Store the verdict per book. This is exactly the probe
already written and it turns an unanswerable question into a stored fact. It also immediately gives an
honest UI state: *"this book has no readable text layer"*, instead of a read-aloud button that fails.

**Stage 2 — normalisation, for layers that can be repaired.** Map presentation forms back to base
letters (a deterministic Unicode table), rejoin lam-alef ligatures, strip watermark runs, and repair
line-break hyphenation. Then re-score. A file that passes only after normalisation is still a genuine
win — رسالة الغفران is likely in this class.

**Stage 3 — speak the repaired text, page-anchored.** Sentence units built per page, with the page as
the anchor (a PDF has no CFI); highlighting draws over the text layer's own positioned spans, which
already carry per-glyph geometry. Advancing past the last sentence turns the page.

**OCR is the only route for the three scans, and I would not take it now.** It means shipping an OCR
engine (Tesseract with Arabic data is ~15–30 MB), minutes of processing per book, and accuracy on
Arabic scans that is mediocre without per-file tuning. That is a product of its own, not a feature.

**My recommendation:** do Stage 1 now — it is small, it makes the limitation honest, and it is the
prerequisite for everything else. Do Stage 2 next and measure how many real books it rescues. Treat
Stage 3 as worthwhile only if Stage 2 shows a decent yield. Do not start with the wiring, which is the
easy part and the part that would tempt a release of a feature that speaks nonsense.

### Honest limitation of this investigation

Six files is a small corpus, and it is skewed — these are Arabic scans and scraped text PDFs. A
library of born-digital Latin PDFs would very likely pass the gate at stage 1 with no normalisation at
all. The gate is worth building precisely because it answers this per document rather than globally.

---

## Instrument note

My first legibility score reported `arabicRatio = 0.24` for رسالة الغفران and called it "barely
Arabic". That was the instrument: the test matched `U+0600–06FF` and **presentation forms fall outside
that range**, so real Arabic was counted as non-Arabic. The corrected count (11 base letters vs 34
presentation forms) is what produced the actual diagnosis — the text is Arabic *and* wrongly encoded,
which is a different problem from "not Arabic" and has a different fix.
