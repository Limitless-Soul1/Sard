# UX endurance audit + PDF stress audit

Sard driven as a reader would drive it, then attacked. Harnesses: `tests/harness/ux-endurance.mjs`,
`ux-leak-scroll.mjs`, `pdf-stress.mjs`, `pdf-hostile.mjs`, `pdf-corrupt-open.mjs`. Raw evidence in the
matching `*-result.json` files.

Same triage as the library audit: **SARD** only when Sard differs from what the file supports, **PDF**
when the file itself carries the problem, **UNCERTAIN** when it cannot be settled here.

---

## Part 1 — Reading experience (EPUB)

### Measured

| What | Result |
|---|---|
| Page turning, 80 consecutive turns | p50 **87 ms** · p95 **126 ms** · max **149 ms** · turns over 250 ms: **0** · failures: **0** |
| Long tasks while turning | **0** |
| Sustained scrolling, 240 wheel events | position verified to move · **0** long tasks · worst frame **0 ms** |
| Chapter transitions, 12 boundaries | **12/12** landed on the next section with content · p95 **154 ms** |
| Open the same book 12 times | 12/12 · open p50 **261 ms** · max 266 ms |
| Twelve different books in sequence | 12/12 opened · 260–364 ms |
| Bookmarks / highlights | create → read back → delete → read back: **correct**, with a real CFI |
| Page errors, whole session | **0** (one benign `ResizeObserver loop` notice in a separate run) |
| UI after the full session | 39 cards, no stray reader, no panel left open, no orphan overlay |

Turning is comfortably inside the threshold where a page change reads as instant, and the *tail* is
tight — p95 126 ms against a p50 of 87 ms means turns do not occasionally lurch, which is what
actually breaks the feel of reading.

### Memory and degradation — no leak

The first pass looked alarming: node counts climbing 2,322 → 5,201 across open/close cycles. That
reading was wrong, and the correction matters more than the number. Those samples were taken at
varying moments of a load and without collecting garbage, so they measured *uncollected*, not
*retained*.

Re-measured at an identical lifecycle point (back in the library, no book open) with garbage
collection forced before each sample, over ten open/close cycles:

```
cycle  0   nodes 605   listeners 321   docs 5   heap 2.4 MB
cycle  1   nodes 612   listeners 323   docs 6   heap 4.4 MB
...        (flat)
cycle 10   nodes 612   listeners 323   docs 6   heap 5.5 MB
```

**+0.7 nodes and +0.2 listeners per cycle** — flat from the first cycle onward. Heap grows 3.1 MB
across ten cycles and decelerates, consistent with cache warming rather than retention. Across the
six PDFs, including a 40 MB one, nodes, listeners and documents all returned *below* baseline.

**No leak, and no measured degradation over a long session.**

---

## Part 2 — PDF stress

Six PDFs, all measured in the real binary. What each file *is* was read from its bytes first, so a
finding can be attributed rather than guessed.

| File | Size / pages | Character | Open | Turn p50 | Jump to last |
|---|---|---|---|---|---|
| مقدمة ابن خلدون | 19.9 MB / 567 | scan, CCITT, page size varies per page | 0.9 s | 114 ms | 265 ms → "567 / 567" |
| الأمير الصغير | 3.8 MB / 102 | mixed text+image, JBIG2 | 648 ms | 114 ms | 265 ms → "102 / 102" |
| الداء والدواء | 8.3 MB / 678 | pure scan, **no text layer** | 615 ms | 114 ms | 264 ms → "678 / 678" |
| رسالة الغفران | 4.7 MB / 202 | text PDF | 334 ms | 113 ms | 265 ms → "202 / 202" |
| فنّ الحرب | 0.9 MB / 100 | **encrypted** (`/Encrypt`) | 312 ms | 115 ms | 264 ms → "100 / 100" |
| 697 | 40.3 MB / 967 | very long scan, JBIG2 + JPX | 916 ms | 114 ms | 267 ms → "967 / 967" |

- **Stability: nothing broke.** 30 rapid page turns with no waiting, on every file, left the reader
  coherent and painting — including the 967-page scan. No stuck pages, no crash, no blank reader.
- **Page counts match the files.** Every jump to the end landed on the true last page.
- **Internal bookmarks are correct in all six.** Sard shows 5 rows where the file declares 5 outline
  entries, 1 where it declares 1, none where there is none. *(First measurement said otherwise; the
  scan had a 400-stream cap that hid the outline dictionaries. Uncapped, the files agree with Sard.)*
- **The encrypted PDF opens and reads normally.**
- **Blank pages are blank in the file.** Six pages of رسالة الغفران rendered with no ink; all six were
  still blank after a further 2.5 s, so this is the page, not a rendering race. → **PDF**
- Pages are **height-fitted** to the reading area (720 px of a 720 px area), not shrunk.

### Finding — PDFs cannot be zoomed at all · **SARD**

Not a bug; a capability that is absent, and for this corpus it is the one that matters.

- `Reader.tsx:1744` gates Ctrl+wheel zoom off for PDFs (`!isPdf`), and the next line makes the wheel
  turn the page instead. Confirmed by measurement: Ctrl+wheel changes the page, never the scale.
- The PDF settings panel offers exactly three controls: normal/inverted, and copy. No zoom, no fit.

Four of these six files are **scans with no text layer**. A reader who finds the type too small has no
recourse — cannot magnify, cannot reflow, and cannot select text. On a scanned Arabic book that is the
difference between readable and not. I would treat this as the highest-value PDF work available, above
anything else found here.

### Finding — the importer accepts PDFs it cannot parse · **SARD, low severity**

Six deliberately damaged files were imported. `empty.pdf` and a text file wearing a `.pdf` extension
were correctly refused ("Not an EPUB or PDF file"). But a **truncated** file, a file of **random bytes
behind a `%PDF-` header**, and a file containing **only `%PDF-1.7\n`** were all accepted as valid books
— import validates the header, not the document.

The reader experience is nonetheless correct: opening them produces a clear Arabic damage card within
0.3–1.5 s, telling the reader the file appears incomplete and that re-importing usually fixes it. And
the trailer-less file **legitimately recovered** — pdf.js rebuilt its broken cross-reference table,
which is what a good PDF reader should do.

So nothing hangs and nothing lies; the cost is that a corrupt file enters the library silently and only
reveals itself when opened. Worth tightening at import; not worth blocking a release.

---

## Verdicts

| Area | Verdict |
|---|---|
| Page turning, scrolling, transitions | No defect found |
| Memory / degradation over a long session | No leak; no degradation |
| Bookmarks, highlights | Correct |
| UI coherence after heavy use | Correct |
| PDF rendering, navigation, stability | No defect found |
| PDF page counts, outlines, encryption | Correct — matches each file |
| PDF blank pages | **PDF** (the files') |
| **PDF zoom** | **SARD — absent capability** |
| **Import accepts unparseable PDFs** | **SARD — low severity** |

## What I could not test, and will not claim

- **Visual glitches needing an eye.** I measured ink, geometry, DOM state and errors. Tearing,
  flicker, a mispositioned highlight, a font that renders wrong — an automated probe does not see
  these. This audit does **not** clear Sard of visual glitches.
- **How zooming and page turning *feel*.** Latency figures are not the same as feel.
- **Read-aloud during long sessions**, and notes/references beyond create-read-delete.
- **Larger monitors.** All figures come from a 1100×720 window.

## Instrument faults corrected during this audit

Reported because each first produced a confident, wrong answer.

1. **"The PDF never painted in 60 s"** — I had opened the **EPUB** of the same title. The library holds
   both for several works and `.find()` took the first. Now every PDF is matched on a token unique to
   its card *and* verified against the file's page count after opening.
2. **A PDF page is not always an `<img>`** — assuming so reported a healthy text PDF as never painting.
3. **"20 of 20 page turns stuck"** — a PDF has no section index on `getContents()`; its position is
   `lastLocation.fraction`.
4. **"Nodes climbing 2,322 → 5,201"** — uncollected garbage sampled at varying moments, not a leak.
5. **"0 long tasks while scrolling"** — had no *before* position, so it could equally have meant
   nothing scrolled. Movement is now proven before smoothness is claimed.
6. **"Outlines missing"** — my PDF scan capped at 400 inflated streams and reported an absence it could
   not see. Uncapped, the outlines were there and matched.
7. **A PDF "failed to open" in the endurance run** — that probe waits for text, and a PDF page has none.
