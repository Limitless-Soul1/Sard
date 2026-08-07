# Sard — External Beta 1

Built from RESILIENCE-1 (WP-0 … WP-7) plus the pre-beta polish pass. **No new features.** Everything
below is a stabilization fix, a compatibility fix, or a correctness fix.

---

## 1. Changelog

### Reading & rendering

* **Book stylesheets are now handled deliberately (WP-7).** A book's own CSS is passed through a
  sanitiser with three modes — `off` (ship default), `sanitised`, `raw`. Only a fixed allow-list of
  properties survives, `!important` cannot be smuggled through (including the `! important` and
  `!/*c*/important` forms), and the reader's typography, colours and layout can no longer be
  overridden by a hostile or careless book.
* **Paged mode paginates again (NAV-1).** It had been rendering scrolled.
* **Arrow keys no longer reverse in RTL books (NAV-4).** → is always *next*, ← is always *previous*,
  in both directions; the direction argument that made the reversal representable was removed.
* **Chapter lists recovered for books with a broken or missing TOC (WP-6).** The book's own heading
  is used when present; otherwise `Chapter N` / `الفصل ١`. Titles are never invented from content.
* **Import compatibility (WP-2) and a single source of truth for a book's displayed name (WP-3).**
  Placeholder metadata (`<dc:title>Unknown</dc:title>`, `<dc:creator>word</dc:creator>`) is detected
  and replaced with a filename-derived title, marked as a guess, instead of being shown as fact.

### Read-aloud

* **Speak-along highlighting works again (TRACK-1).** Audio played with no highlight.
* **The transport no longer hides the sentence it is reading.** The follow-scroll comfort band ended
  at 85% of the reading box while the floating transport covers roughly the bottom 30% of the window,
  so a sentence could be "in view" and physically behind the player. The band now ends where the
  occlusion starts. Scroll-target only — pagination is untouched.
* **Voice/script compatibility (WP-5).** A voice that cannot pronounce the book's script is refused
  before any synthesis, with a card naming the voice and offering an alternative.

### Interface

* **All 16 reading themes are named in Arabic** — عاجيّ، بُنّي عتيق، أردوازيّ، أسود خالص، مَرْيَميّ،
  كوارتز ورديّ، رَقّ، غَسَق، حِبر، إسبريسو، ليل الغابة، توتيّ، فحميّ، ليليّة، كتّان، سماء مقمرة.
* **Arabic grammar fix in search.** The spoiler card used a plural where Arabic takes the singular
  ("72 نتائج" → "72 نتيجة"), three lines from a sibling string that had it right.
* **Settings drawer no longer looks cut off.** A soft fade marks the scrollable edge.
* **Failure surface (WP-1).** A book that cannot be opened explains why instead of failing blankly.

### Under the hood

* Additive-only SQLite migrations; `metadata_overrides` never overwritten by extraction.
* CSP `style-src` allows `blob:` — required for locally bundled EPUB stylesheets. **No network access
  was added.**

---

## 1a. Requirements — please read before installing

**Windows 10/11 with an up-to-date Microsoft Edge WebView2 Runtime.**

Sard renders through WebView2, and the bundled engines call browser built-ins that only exist in
recent versions:

| you need | why |
|---|---|
| WebView2 ≥ **Chromium 117** | `Object.groupBy` / `Map.groupBy`, used by the EPUB metadata parser. Below this, **no book of any kind opens.** |
| WebView2 ≥ **Chromium 140** | `Uint8Array.prototype.toHex` / `.toBase64` / `Uint8Array.fromBase64`, used on every PDF open. Below this, **every PDF fails** — historically with `UnknownErrorException: hashOriginal.toHex is not a function` and an "Unable to open this book" message. |

Sard detects these at runtime and tells you to update WebView2 rather than failing cryptically — but
it cannot supply the missing browser features, so **updating WebView2 is the actual fix.** If you see
a message about WebView2, please update it and try again before reporting a bug.

Validated on WebView2 **151.0.4129.59**. Both installers are **unsigned**, so Windows SmartScreen
will warn on first run: choose "More info" → "Run anyway".

## 2. Known limitations

Things that are true of this build and are **not** defects to report:

1. **`book_css` ships as `off` and has no UI.** Book stylesheets are ignored by default. The setting
   exists in the database only, and takes effect on the next book open.
2. **Long sentences can still run under the read-aloud transport.** The start of the sentence and the
   word cursor are always clear; the tail of a 5-line sentence may pass beneath it.
3. ~~**Typography sliders read left-to-right in Arabic.**~~ **FIXED 2026-08-07 (PPC-4).** The settings
   drawer was the only reader panel not carrying `dir`, so it inherited the LTR pin RAWY-89 puts on
   `.reader-root`. It now follows the UI language like the Contents and Notes panels do; its physical
   right-edge docking is unchanged (RAWY-32 pins that with `right`/`translateX`, not logical insets).
4. **The reader's Back control sits at the left and points left in Arabic.** Deliberately unchanged:
   we want Arabic readers to tell us what feels natural before we move reader navigation.
5. **The contents list mixes two numbering schemes** — `الفصل N` uses the book's own chapter number,
   `قسم N` uses spine position for front/back matter. Intentional: numbering everything positionally
   made a Contents page outrank the real Chapter I.
6. **Books imported before this build keep their old metadata.** Re-import to pick up the improved
   title/author handling.
7. **Poorly converted books render as they are.** Some EPUBs have words joined without spaces in the
   source file; Sard shows the book faithfully and does not repair text.
8. **Remote images are not downloaded.** Books referencing images by URL show no image. Postponed
   deliberately; no internet-dependent behaviour in this build.
9. **Edge voices need a network connection.** Piper runs locally.

---

## 3. Postponed items (PPCs)

Filed, evidenced, and deliberately **not** scheduled. Each is a decision, not an oversight.

| id | item | why it is postponed |
|---|---|---|
| ~~**PPC-1**~~ | ~~Inline `<style>` blocks may bypass the sanitiser~~ | **CLOSED 2026-08-07 — no defect.** Measured on the real binary with the `hostile-inline-style` fixture. RAW proves the fixture is potent (`position:absolute` applied; the `style=` attribute's `-70pt` became `-93.3px`). SANITISED drops every hostile declaration from BOTH the `<style>` block and the `style=` attribute while keeping the benign ones — and the attribute is **rewritten to empty**, which no cascade could do. `npm run harness:ppc1`. |
| **PPC-2** | Byte-identity has only ever measured **scrolled** rendering | All 16 baseline books were captured with `flowMode: scrolled`, so `column-width`, `column-gap`, page and column counts have been inert in every capture. Pagination regressions of the NAV-1 class would not be caught by that net. Task 4 drove paged mode directly, so it is covered by the subsystem matrix — but not by the byte-identity baseline. |
| **PPC-3** | FINDING-5 — الشوقيات reports `paras: 1` for 6032 characters | Unexplained in all three modes. Low impact, cause unknown. |
| **PPC-4** | Typography sliders do not mirror in RTL | Contained fix, but it means locally undoing the pin that fixed the RAWY-89 drawer overlap. Wants its own before/after verification. |
| **PPC-5** | Adopt `resilience-1-final` as the byte-identity baseline | Captured and green; `wp7-stage3` is stale against the owner's own settings. Adoption is a deliberate choice, not a default. |
| **PPC-6** | English UI layout audit | Blocked — never unblocked. Needs a screenshot of the English UI. |
| **PPC-7** | Backfill metadata for pre-existing library rows | A migration touching real user data; a product decision, not a stabilization fix. |

---

## 4. Beta tester checklist

Please use Sard as a reader, not as a tester. The most valuable reports are about **how it feels**,
because that is precisely what could not be validated internally — automated checks cannot see
animation, flicker, transitions, latency or scroll behaviour.

### Please pay particular attention to

**Read-aloud comfort** — the headline area.
- Can you always see the sentence being read? Does the player ever hide it?
- Does the highlight keep up with the voice, or drift over a long session?
- Pause, resume, skip forward and back. Change chapter *while it is speaking*.
- Leave it running for 20+ minutes. Does it degrade, stutter, or stop?

**Arabic and RTL correctness** — you can judge this better than we can.
- Do the theme names read naturally? Would you have chosen different words?
- **The Back button sits at the left and points left. Does that feel right, or backwards?**
  We deliberately left it alone to ask you.
- Do the typography sliders (text size, line spacing) grow in the direction you expect?
- Any wording that is grammatically off, stiff, or machine-sounding.

**Long sessions.**
- Read for an hour or more. Does it slow down, grow heavy, or start to feel sluggish?
- Leave it open overnight and come back to it.

**Navigation.**
- Contents, search, jumping between chapters, returning to the library and back into a book.
- Does it always resume where you actually left off?
- Try many books in quick succession.

**Anything that feels unpolished.** Layout jumps, flicker, delays, strange transitions, focus that
goes somewhere unexpected, scrolling that feels wrong, things that overlap. **Even if you cannot
explain it, report it.** "Something felt off when I switched themes" is a useful report.

### When reporting

Please include: what you were doing, the book (name and roughly where it came from), whether it
happens every time, and what you expected instead. A screenshot or short screen recording is worth a
great deal — especially for anything involving motion.

### What is already known

Please check §2 first — those are known and do not need reporting. Everything else does, including
things that feel too small to mention.

---

## Verification state of this build

346/346 unit and integration tests · both TypeScript projects clean · harness lifecycle 9/9 ·
byte-identity **byte-identical** to `resilience-1-final` across all 16 corpus books · read-aloud,
references, themes, endurance and cross-mode annotation durability all green under `off`, `sanitised`
and `raw`.

**WP-7 introduced zero rendering regressions**, proven byte-for-byte under matched settings.

One honest caveat, repeated because it matters: the *felt* half of this application — motion,
latency, transitions, comfort over hours — has never been validated by a human. That is what this
beta is for.
