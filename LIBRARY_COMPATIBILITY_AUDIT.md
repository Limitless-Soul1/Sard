# Full-library compatibility audit

Every book in the library opened in the real binary and measured. Raw evidence:
`tests/harness/library-audit-merged.json`. Harness: `tests/harness/library-audit.mjs`.

## How a verdict was reached

There is no second EPUB reader on this machine, so "is this Sard or the book?" is decided against the
strongest evidence available: **the file's own declarations**. An EPUB states its structure in the OPF
spine and in its nav document or NCX.

- **BOOK** — Sard shows what the file declares. The file is like that.
- **SARD** — Sard shows something *different* from what the file declares.
- **UNCERTAIN** — cannot be settled from the file alone.

UNCERTAIN is a real verdict and was not upgraded to either side to tidy the result.

## What was measured

39 library items · **33 EPUB**, 6 PDF. Per book: OPF spine length · TOC entry count and depth ·
whether every TOC target resolves into the spine · the contents panel the reader actually shows ·
book direction · six sampled sections walked for order, emptiness, element count, images, computed
colours · position advance.

**15,090 declared spine sections · 10,620 TOC entries resolved individually.**

## Results — 33 EPUBs

| | Books |
|---|---|
| Passed with no anomaly | **27** |
| Confirmed problems in the EPUB file | **6** |
| Confirmed Sard bugs | **0** |
| Requiring further investigation | **0** |

- TOC targets that failed to resolve: **3 of 10,620** (0.03%), all three the single degenerate entry
  in a file that declares no real TOC.
- Section-order violations: **0**. Position-advance failures: **0**. Truncated sections: **0**.
- Direction: 31 RTL, 2 LTR — all correct against the file's declaration.

### The six books, and why each is the file

| # | Book | Finding | Verdict |
|---|---|---|---|
| 0 | The Villain Wants to Live | declares 1 TOC entry for 364 spine sections; that entry resolves nowhere | BOOK |
| 4 | Kingdom's Bloodline | declares 1 for 530; dead target | BOOK |
| 19 | Infinite Mana in The Apocalypse | declares 1 for 2,964 | BOOK |
| 20 | Leveling with the Gods | declares 1 for 552; dead target | BOOK |
| 38 | يوم سقط القناع | declares 1 for 4; first spine section is empty (3 elements, no text) | BOOK |
| 24 | أوفرلورد | 22 images do not load | BOOK |

**The degenerate-TOC five (0, 4, 19, 20, 38).** These files ship no usable table of contents. Sard
does not reproduce the defect — it **rebuilds one from the spine**, so the reader sees 362, 529,
2,963, 551 and 4 chapters respectively where the file offered one. This is Sard repairing a broken
file, and it is the opposite of a compatibility failure.

**أوفرلورد (#24).** The container holds exactly one image — the cover. Its opening section carries 22
`<img>` elements pointing at `https://kolnovel.com/wp-content/uploads/...`. The book references the
website it was scraped from instead of embedding artwork. No offline reader can display them, and
refusing remote fetches is correct behaviour. `naturalWidth: 0, complete: true` on every one.

## The 6 PDFs

Excluded from the EPUB compatibility verdict, not silently passed. A PDF renders to canvas, so an
EPUB-shaped probe reads `dir: null`, zero text length and no section advance — that is the
instrument being inapplicable, not a defect. **PDF rendering was not audited here and remains
unmeasured.**

## Instrument faults found and fixed before the result was trusted

Recorded because each produced a confident, wrong answer first — the class matters more than the
instance (HANDBOOK §3.4, §12).

1. **`next()` turns a page, not a section.** Three healthy books reported "did not advance". Now the
   reading *position* is compared, not the section index.
2. **`book.toc` is the raw parse, not what the reader sees.** Would have accused Sard of showing one
   chapter for 364 — while the panel showed 362. Now the contents panel is measured.
3. **Addressing books by index.** The grid re-orders once books have been opened; 19 phantom
   "card not clickable" failures.
4. **A mounted panel is not an open panel.** RAWY-288 keeps the contents panel mounted when closed, so
   the "is it closed?" test could never pass; the blind toggle left it open and wedged the run.
5. **Matching the back button by text.** `/المكتبة|رجوع/` matched *chapter titles* in one book
   (ch.38 «تغييرات لا رجوع فيها», ch.75 «المكتبة») and `.find()` took the first — the audit clicked a
   chapter instead of going back, and every subsequent book failed. Text is content; class is identity.
6. **Double-counted images.** 22 images in one long section, sampled six times, reported as 132.

## Assessment

Across 33 EPUBs, 15,090 spine sections and 10,620 TOC entries, **Sard produced no incorrect structure,
no misordered section, no truncated content and no navigation failure**. Every anomaly traced to the
file, and in five of six cases Sard actively compensated for a defect the file shipped with.

The corpus is genuinely hostile — scraped web-novel EPUBs with 1–2,964 sections, Arabic RTL
throughout, files with no TOC at all — which makes the result meaningful rather than flattering.

**Known gap:** PDF rendering is unmeasured, and this audit checked structure, order, completeness and
navigation — not typographic fidelity, which no automated probe here can judge.
