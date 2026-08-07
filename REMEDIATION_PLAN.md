# Sard Desktop — Post-Test Remediation Milestone

**One coordinated quality milestone. Nothing implemented.**
**Written:** 2026-08-04 · baseline `main` @ `dd23765` (v1.1.0)
**Companion:** [`EPUB_COMPATIBILITY_STUDY.md`](EPUB_COMPATIBILITY_STUDY.md) — the root-cause evidence for items 1–6 and 8.
This document adds the investigation for items 7 and 8, then turns all eight into one plan.

**Milestone name:** `RESILIENCE-1`
**Objective:** every failure becomes explainable, every imperfect book becomes readable, and
**every one of the 13 well-formed books in the test corpus renders byte-identically to v1.1.0.**
That second half is the acceptance frame for every package below, not an afterthought.

---

## Part I — What is actually wrong

### I.1 New investigation: item 7 — TTS language incompatibility

**The user's report is exact and the mechanism is fully traced.**

The picker no longer filters by book language — deliberately. `TtsVoicePicker.tsx:100-102`:

> *"book-language filter is GONE — every book's picker now lists all of the engine's voices … so a
> Multilingual/English voice can be chosen even for an Arabic book."*

That was RAWY-197's intent (a French book deserves a French voice), and it is right. But **nothing was
added on the other side to handle the mismatch it now permits.** The voice list carries the locale —
`EdgeVoiceInfo.lang` is `"ar-EG"`, `"en-US"`, … (`src-tauri/src/tts.rs:79`) — and the book's corrected
direction is known. **Neither is ever compared.**

So an `en-US` voice on an Arabic book fails at synthesis, and the failure lands in the retry ladder:

| Step | Code | Behaviour |
|---|---|---|
| Synthesis returns nothing usable | `tts.ts:attemptSynth` → `throw new Error("empty-audio (0-length buffer)")` | The Edge endpoint's response for an unspeakable request |
| Classified | `tts.ts:725` → not `isPermanentFailure`, not `isSynthStall`, not `isTransientTimeout` → **`"other"`** | Falls to the default class |
| Retried | `RETRY_BACKOFF_MS = [500, 1500, 4500]` (`tts.ts:571`) | **4 dispatches**, each up to a 13 s timeout |
| Exhausted | `throw new Error("${TTS_EDGE_DOWN}: …")` (`tts.ts:748`) | → status `edge-error` → the pill's **Retry** |

That is *precisely* "repeatedly retries synthesis before eventually showing Retry". The user is then
offered **Retry** and **Switch to Piper** — and neither can work, because the cause is the voice, and
the ladder's own comment states the principle it is violating: *"a permanent failure must NOT enter
the ladder — retrying it only delays the dialog the user has to act on anyway."*

**Root cause: a missing classification, not a broken pipeline.** The ladder is well-built; a
language mismatch is simply not in its taxonomy. `isPermanentFailure` recognises only
`"unknown edge voice"` and 4xx.

**Piper fails differently and worse.** Piper voices are per-language models
(`tts.rs:25-40 VoiceDef`, `PIPER_VOICE = { ar, en }`). An English Piper model fed Arabic text is
phonemised by eSpeak-NG under English rules and **returns audio** — no error at all. The user hears
confident gibberish and there is no failure to classify. Only a **pre-flight** check catches this;
no post-hoc error classification ever can. This is the argument that decides the design.

> **⚠ Measurement M1 required before implementation.** I traced the path statically and the symptom
> matches exactly, but I have **not** confirmed on the wire which error Edge returns for a
> script/locale mismatch (empty audio vs. an explicit rejection vs. a 4xx). It needs one live test
> with a known-incompatible pair. The fix below is designed to be correct either way — the pre-flight
> gate makes the wire behaviour irrelevant — but the *post-hoc* safety net in WP-5B must match reality.

### I.2 New investigation: item 8 — which surfaces actually disagree

Audited every place a book's title or author is displayed. The good news is that this is **narrower
than feared**:

| Surface | Source | Consistent? |
|---|---|---|
| Library grid / list / shelves | `library_list_books` → `OV_TITLE`/`OV_AUTHOR` = `COALESCE(override, extracted)` (`library/mod.rs:77-78`) | ✅ |
| Inbox (cross-book notes/highlights) | `annotations_all` → `{OV_TITLE}` (`library/mod.rs:946, 952`) | ✅ |
| Bookmarks shelf | `bookmarks_all` → `{OV_TITLE}` (`library/mod.rs:684`) | ✅ |
| **Reader header** | `ctrl.title` → foliate → **the embedded `dc:title`** (`Reader.tsx:472`, `FoliateController.ts:981`) | ❌ |
| **Photo cards** | `ctrl?.title` / `ctrl?.author` (`Reader.tsx:1188-1189`, `:1209-1210`) | ❌ |

The database is already the single source of truth for three of five surfaces; the reader and the
photo composer are the two that bypass it. **Live proof in the current test library:** book
`cd27ab1d` has `metadata_overrides.title = "Lord Of The mysteries"`, and the library shows that — but
the reader header shows the embedded `لورد الغوامض`, and a photo card exported from it would carry the
embedded title and `author = "cuttlefish that loves diving"`.

**A second consistency axis, easy to miss:** `chapter_label` is **denormalised at creation time** into
`highlights`, `notes` and `bookmarks`. On the Word/Calibre book — whose TOC has one entry, "Start" —
every annotation is stamped `"Start"` permanently. TOC recovery (WP-6) will fix *new* annotations and
leave old ones wrong. That is acceptable and must be a stated, deliberate decision rather than a
surprise.

**One more:** `Reader.tsx:483` writes PDF.js metadata straight into the **base** `books.title` /
`books.author` row on first open. Writing an untrusted extracted value into the authoritative column
(rather than treating it as another extraction source) is the same category error the compat layer
is meant to remove.

### I.3 A hard constraint discovered while planning

**There is no JavaScript test infrastructure in this repo.** No vitest, no jest, no test runner in
`package.json:6-12`, and zero `*.test.ts` files. Automated coverage today is **27 Rust `#[test]`s**.

`ttsScheduler.ts` is described in the project's own docs as "a PURE module … so the invariants are
unit-testable" — but nothing can run them.

This is load-bearing for the plan. Roughly 70 % of this milestone is front-end, including its two
riskiest changes (the CSP/CSS work and the reader interaction model). Shipping those with no
automated front-end coverage is the largest single regression risk in the whole programme, and it is
the cheapest one to remove. Hence **WP-0**.

### I.4 Verdicts on item 1 (import reliability), as asked

| Candidate | Verdict |
|---|---|
| User error | **No.** |
| Invalid EPUB | **No.** The file imported successfully; it is in the library and it opens. |
| Unsupported book | **No.** |
| **Poor error reporting** | **Yes — and it is the dominant factor.** Two distinct instances: `Reader.tsx:505` prints `String(e)` verbatim; `Library.tsx:144-153` discards `ImportResult.message` and shows only a count. |
| **An actual bug** | **Yes.** Vendored PDF.js 5.5.207 needs Chromium ≥ 140 with no declared or checked floor. Below it, **every PDF fails.** |

Plus three latent import bugs that will produce the same "generic failure" for other testers: a BOM'd
`mimetype` is hard-rejected (verified by compiling the Rust check — `'\u{feff}'.is_whitespace()` is
`false`); a non-UTF-8 OPF silently loses **all** metadata *and* the RTL sniff; an OPF with a missing
or namespace-mismatched `<metadata>` crashes the open with a raw `TypeError` from `epub.js:178`.

---

## Part II — Work packages

Eight packages. Each is independently shippable and independently revertible. Grouping rule applied
throughout: **a file is opened by exactly one package**, and where two concerns share a file they are
merged into one package with sub-items rather than split across two.

File ownership — the contract that keeps the merges clean:

| File | Owned by |
|---|---|
| `package.json`, `vitest.config.ts`, `tests/` | WP-0 |
| `src/lib/bookErrors.ts` *(new)*, `src/lib/runtime.ts` *(new)*, `src/features/library/Library.tsx`, `src/App.tsx`, `BUILD.md`, `VENDOR.txt` | WP-1 |
| `src-tauri/src/books/mod.rs`, `src-tauri/src/books/compat.rs` *(new)*, `migrations_sql/0015_*.sql`, `src-tauri/src/library/mod.rs` | WP-2 |
| `src/lib/ipc.ts`, `src/lib/bookMeta.ts` *(new)*, `src/features/photo/*` | WP-3 |
| `src/styles/global.css`, `src/features/reader/Reader.tsx`, `ReaderChrome.tsx`, `src/reader-engine/FoliateController.ts`, `public/foliate-js/paginator.js` | **WP-4** (covers items 3, 4, and the reader half of 1/5/8) |
| `src/lib/tts.ts`, `src/features/reader/TtsVoicePicker.tsx`, `TtsPlayer.tsx` | WP-5 |
| `src/features/reader/ChaptersPanel.tsx`, `src/features/reader/perBookSettings.ts` | WP-6 |
| `src-tauri/tauri.conf.json`, `src/reader-engine/cssSanitiser.ts` *(new)*, `src/reader-engine/injectedCss.ts` | WP-7 |
| `src/i18n/locales/{en,ar}.ts` | **shared — append-only, one block per package, no reordering** |

---

### WP-0 · Test & measurement scaffolding — ✅ **COMPLETE** (2026-08-04)
*No product behaviour changes.*

| | |
|---|---|
| **Addresses** | The precondition for every other package |
| **Risk** | **None** — nothing ships to users |
| **Effort** | Small |
| **Status** | Delivered and verified. `npm test` 59 passing · `cargo test` 36 passing · corpus 16/16 · baseline captured across 15 books. **Zero changes under `src/`, `src-tauri/` or `public/`.** |

> **Two findings from building it — both change how later packages must be verified.**
>
> **(a) `document.styleSheets` cannot gate WP-7.** Measured on the v1.1.0 baseline: every corpus
> book's external `<link>` stylesheets **are** present in `document.styleSheets` (Alice 3, the Word
> book 2, matching each book's file count) while none of their rules reach computed style. The sheet
> objects load and are inert. So the sheet list looks **identical** before and after the CSP change,
> and anyone verifying stage 7.1 by counting sheets would conclude wrongly. **The computed-style
> fingerprint is the gate.** Pinned by a test so the trap cannot be walked into.
>
> **(b) The corpus books cannot live in the repository.** It is public and AGPL-3.0, and most corpus
> books are third-party copyrighted works (~55 MB). Only the manifest is committed; the files live at
> `%SARD_CORPUS%`. See §0.3.

**Contents**

1. **Vitest** + `npm test`, wired into `build:test` so the everyday loop runs it.
2. **A generated fixture set** — built by a script, not checked-in binaries. Each fixture isolates
   **one** defect: `bom-mimetype`, `no-metadata-block`, `cp1256-opf`, `utf16-opf`,
   `placeholder-title`, `ncx-single-entry`, `no-toc-at-all`, `fragmented-spine`, `hostile-css`,
   `arabic-tagged-en`, `nested-toc`, `compressed-mimetype`, `truncated-zip`, and one **golden
   well-formed** control. Fixtures prove a *specific* defect is handled.
3. **The permanent Regression Corpus** *(added at the owner's direction — see 0.3 below)*. Real
   books, fixed membership, verified by content hash. Fixtures prove a defect is handled; the corpus
   proves **nothing else broke**. Neither substitutes for the other.
4. **The byte-identity harness.** A script that, for each well-formed book in the corpus, records a
   render fingerprint — computed `font-size`, `line-height`, `text-align`, `direction`,
   `margin-block`, `color`, `background-color` for a fixed set of sampled elements, plus the
   section's page count — and diffs before/after. Driven through the existing dev CDP route (`D55`,
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`).
   **Every package's "no regression" claim is discharged against this harness, not by eye.**
5. **The headless-Chromium CSP harness** used to isolate the stylesheet defect, promoted from a
   throwaway into `tests/harness/`. WP-7 depends on it.

**Why first, and why not optional.** The milestone's stated goal is *"preserving existing behavior for
valid books."* Without (3) and (4) that is an assertion. With them, it is a check that fails a build.

#### 0.3 · The permanent Regression Corpus

A fixed library of **real** books representing what Sard meets in production. Permanent: books are
added, never removed, so coverage only grows.

| Slot | Requirement | Filled by |
|---|---|---|
| `control-wellformed` | A golden, correctly-authored EPUB 3 | Alice's Adventures in Wonderland |
| `arabic-normal` | Ordinary Arabic EPUB, correct metadata | الأمير الصغير · فن الحرب |
| `english-normal` | Ordinary English EPUB | The Count of Monte Cristo |
| `rtl-declared` | Explicit `page-progression-direction="rtl"` | البؤساء |
| `rtl-undeclared` | Arabic content, **no** RTL signal — exercises the RAWY-189 sniff | حلقة الحتمية |
| `word-generated` | Word → Calibre conversion | The reported book |
| `calibre-generated` | Calibre output with a sound NCX | لورد الغوامض |
| `css-heavy` | Many/large stylesheets — the WP-7 stress case | Alice · Monte Cristo |
| `broken-toc` | TOC present but degenerate | The reported book (1 navPoint / 116 spine) |
| `no-toc` | No usable TOC at all | **GAP — to source** |
| `very-large` | ≥ 10 MB and/or ≥ 1,000 sections | لورد الغوامض (10.3 MB / 1,433 sections) |
| `pdf-arabic` | Arabic PDF, scanned or embedded-font | مقدمة ابن خلدون |
| `pdf-normal` | Ordinary Latin PDF | **GAP — to source** |
| `poetry-rtl` | Verse layout — the alignment/centring stress case | الشوقيات (141 sections) |

**Where the files live, and why not in the repository.** The repo is **public and AGPL-3.0**, and
`.gitignore` already carries explicit rules against committing user data. Most of these books are
**third-party copyrighted works**, and the set is ~35 MB. Committing them would be a licensing
violation and a repository-hygiene one.

So the split is:

- **In the repo:** `tests/corpus/corpus.manifest.json` — slot, filename, SHA-256, format, and the
  structural traits each book is *expected* to have (spine count, TOC entries, declared language,
  declared direction, producer). Plus the tooling to build and verify it. This is the part that must
  be reviewable and diffable.
- **Outside the repo:** the book files, at `%SARD_CORPUS%` (default
  `M:\ProjectDocs\sard\Corpus\`) — the same convention the vault already uses for `DB-Snapshots`
  and `Evidence`.

`npm run corpus:verify` checks the local corpus against the manifest by hash and reports missing
slots. A machine without the corpus gets a clear skip, never a false pass.

**The manifest is also an assertion, not just an index.** Each entry records the structural traits
measured at admission. If a parser change silently alters how a book is read, `corpus:verify` fails
on the trait diff — before any rendering is involved.

#### 0.4 · The per-PR gate

Any change touching **import, rendering, pagination, metadata, navigation, TTS or reader
interaction** must, before it is considered complete:

1. `npm test` — unit + fixture tests green.
2. `cargo test` + `cargo clippy --all-targets` — green.
3. `npm run corpus:verify` — the corpus is intact and traits are unchanged.
4. **Open every book in the corpus** and confirm no behavioural regression (§III.5 sweep).
5. For rendering-adjacent changes: the byte-identity harness reports **zero** diffs on the
   well-formed slots.

A package is not complete until its own tests pass **and** the corpus sweep is clean.

---

### WP-1 · The failure surface — ✅ **COMPLETE** (2026-08-04)
*Items 1 (reporting), 5, 6.*

| | |
|---|---|
| **Addresses** | Error classification · runtime compatibility · import diagnostics |
| **Risk** | **Low** — additive; existing success paths untouched |
| **Effort** | Medium |
| **Status** | Delivered and verified. `npm test` 137 passing (63 new) · `cargo test` 36 · corpus 16/16 · CSP 4/4 · **byte-identical rendering, proven against a rebuilt pre-WP-1 binary across all 15 corpus books.** |

> #### Shared foundation established by WP-1 — later packages build on this
>
> **1. `src/lib/errors.ts` is generic and subsystem-agnostic.** `Fault`
> (`book | environment | configuration | sard`), `RecoveryAction`, `Classified`, `Rule`/`matchRule`,
> and the diagnostics ring live there; `bookErrors.ts` is only the first consumer.
> **WP-5 must add a `ttsErrors.ts` on the same core rather than a parallel system** — the
> `configuration` fault exists and is currently unused precisely because WP-5 needs it (a voice that
> cannot speak the book is a *configuration* fault, not a book or environment one).
>
> **2. Kind ≠ presentation.** Several internal kinds may share one presentation when they leave the
> user with the same decision (`book-malformed` and `unsupported-format` already do). Diagnostics stay
> distinct; the UI converges. This is the mechanism for the owner's principle 5.
>
> **3. `src/app/ErrorCard.tsx` is the one failure look.** Any new failure surface renders through it.
> Invariants, all test-enforced: every presentation offers ≥1 real action, every one offers `back`,
> every one ends with `details`, and `retry` appears **only** where retrying can work.
>
> **4. Raw text has exactly one home.** `Classified.raw` → the Details disclosure. Nothing else may
> render an exception. A test asserts no title/body string in either locale contains implementation
> vocabulary.
>
> **5. `canRender(cap)` is the capability gate.** Feature detection only. **WP-2 onward must not add a
> version check anywhere** — `public/foliate-js/VENDOR.txt` now carries the required-features list and
> the standing instruction to re-derive it on any re-vendor.
>
> **6. Diagnostics persist.** `recordDiagnostic()` writes a bounded 60-entry ring to the `diagnostics`
> settings key (no migration). Verified live: the Details panel showed failures recorded in an earlier
> app session. **Later packages should record through this, not invent per-subsystem logging.**
>
> #### Two findings that change how later packages are verified
>
> **(a) The byte-identity harness could mistake a settings change for a regression.** A capture taken
> after the reading background's page-opacity setting changed reported
> `body.backgroundColor: rgba(0,0,0,0) → rgb(0,0,0)` on **all fifteen** books — a perfect
> impersonation of a catastrophic rendering regression, produced by a slider. WP-1 was cleared only by
> rebuilding a pre-WP-1 binary and re-measuring, which is far too expensive to be the routine answer.
> **Fixed in WP-0's harness:** captures now record the rendering configuration (theme, book theme,
> page opacity, background presence, and the reading-style fields that reach the page) and `diff`
> reports a mismatch as `CONFIG …` drift rather than as a code regression. **WP-4 and WP-7 must
> re-baseline after any settings change, and must never accept a `CONFIG` line as a pass.**
>
> **(b) `describe.skipIf` does not prevent a suite body from running.** A top-level `readFileSync` in
> a skipped describe still threw and failed the whole file. Read fixtures lazily inside tests — the
> "skips must be skips, never failures" property depends on it.
>
> #### Deferred to WP-2 (owns `src-tauri/`)
>
> WP-1 surfaces the reasons Rust **already** emits (`ImportResult.message`, previously discarded).
> Enriching what Rust emits — structured codes rather than prose, and the per-book compatibility flags
> — belongs to WP-2, which owns `books/mod.rs`. `importReport.ts` maps status → reason today and will
> map code → reason once WP-2 provides codes.

These three are one package because they are one user-visible concept — *"tell me what happened and
what to do"* — and because they share the error taxonomy, one i18n block, and one pass over the
`Reader.tsx` catch and the `Library.tsx` toast.

**1A · The error taxonomy.** New `src/lib/bookErrors.ts`, modelled on the shape
`src/lib/updater.ts:34 classifyError()` already proves in this codebase:

```ts
type BookErrorKind =
  | "unsupported-format"    // not an EPUB or PDF
  | "corrupt"               // bad zip, truncated, unreadable
  | "compat"                // parsable but malformed beyond recovery (missing <metadata>, …)
  | "runtime"               // the WebView2 runtime is too old for this content
  | "missing-file"          // the managed copy is gone
  | "transient"             // I/O or lock contention — retry is meaningful
  | "internal";             // unmapped: a Sard bug
```

Rules, all of them deliberate:

- **Every kind gets its own localized sentence and its own action.** `runtime` offers *Update
  WebView2* (and a link), not *Try again*. `corrupt` offers *Remove from library*. `transient` is the
  only kind that offers *Try again* as the primary — today it is the primary for **all** of them,
  which is why the reported failure looked retryable and was not.
- **`internal` is the only kind that may carry raw text**, and only behind a collapsed *Details*
  disclosure with a copy button. The primary line stays human.
- **The raw string is never discarded** — it is logged and copyable, because the field diagnosability
  problem is exactly what created this milestone.
- Classification is **pattern-based on the error, never on the file**, so an unmapped throwable
  degrades to `internal` rather than to a wrong sentence.

**1B · Runtime capability gate.** New `src/lib/runtime.ts`. **Feature probes, not version parsing** —
a probe cannot drift from what the vendored engines actually need:

```ts
const PROBES = {
  pdf:  () => typeof Uint8Array.prototype.toHex === "function"      // PDF.js 5.5 → Chromium ≥ 140
             && typeof Uint8Array.prototype.toBase64 === "function",
  epub: () => typeof Object.groupBy === "function"                  // foliate epub.js → Chromium ≥ 117
             && typeof Map.groupBy === "function",
};
```

- At startup, `epub` failing is fatal and shown as a full-window blocking notice — nothing works below it.
- `pdf` failing is **not** fatal: EPUB reading is unaffected. It disables PDF import with an
  explanatory line and turns any attempt to open an existing PDF into the `runtime` error card.
- Record both floors in `VENDOR.txt` beside the pin, and in `BUILD.md`, with the standing instruction
  **"re-derive on any re-vendor"** — this is the gap the reported bug fell through.
- Investigate switching the NSIS `webviewInstallMode` so the runtime is **upgraded**, not merely
  installed-if-absent. *(Needs verification against Tauri 2's actual options — flagged as an open
  question, not a decision.)*

**1C · Import diagnostics.** `Library.tsx` currently counts statuses and drops
`ImportResult.message`. Replace the toast with a **per-file result list** for any batch containing a
non-`imported` row: filename → one sentence → the raw reason behind *Details*. The Rust messages are
already good (`books/mod.rs:145-166`); they simply need to reach the screen.

**Verification.** Automated: unit tests mapping every known throwable string to its kind, including
the exact reported string; a test that no kind other than `internal` renders raw text; probe tests
with the globals stubbed absent. Manual: §III scenarios E1–E6, R1–R3, I1–I4.

---

### WP-2 · Import compatibility (Rust) — ✅ **COMPLETE** (2026-08-04)
*Item 2 — the metadata half.*

| | |
|---|---|
| **Addresses** | Placeholder metadata · bad creator · malformed OPF · missing metadata block · BOM · non-UTF-8 · producer detection · RTL from text · degenerate-TOC and fragmented-spine detection |
| **Risk** | **Low-medium** — all Rust, all unit-testable, no render path |
| **Effort** | Medium-large |
| **Status** | Delivered and verified. `cargo test` **93 passing** (66 new) · clippy at baseline · `npm test` 137 · corpus 16/16 · **byte-identical rendering** · migrations 15+16 run and re-run on the real 16-book library with overrides intact. |

> #### Decisions taken inside the approved scope
>
> **No new dependency for legacy encodings.** The approved fallback chain is exactly four encodings
> (UTF-8 → UTF-16 → windows-1256 → latin-1), each tabulatable in a few lines, so `encoding_rs`
> (≈2 MB of tables) was not added to a project that justifies every dependency it carries. A CJK
> legacy OPF falls through to latin-1 — mojibake in the title, but the ASCII structure (spine, cover,
> hrefs) still recovers, which is strictly better than v1.1.0 losing the whole parse.
>
> **A missing `mimetype` is no longer fatal**, but only when `container.xml` and a parsable OPF are
> both present. A plain zip is still refused — asserted by a test, because loosening a rejection is
> exactly where backward compatibility slips.
>
> #### Findings — each one caught by a test or by running against real data
>
> **(a) The reported book's title cannot be recovered by the backfill, and that is correct.** The
> ladder's rung 3 is the original filename — but Sard stores every book as `library/<id>.epub`, so
> for a book imported *before* WP-2 the original filename no longer exists. Verified on the owner's
> live database: `45182e14` still reads "Unknown" after the backfill because there was genuinely
> nothing better (the Word conversion has no `<h1>` anywhere either). **A fresh import of the same
> file gets its filename** — the corpus test proves it. The backfill refuses to invent a title.
> **What was fixed:** it left `meta_provenance` NULL, making "examined, genuinely a placeholder"
> indistinguishable from "never examined". It now records `{"title":"default"}`, which is the signal
> **WP-3 needs** to render "Untitled Book" as chrome instead of showing a placeholder as a name.
>
> **(b) `author` is now NULL where v1.1.0 wrote the literal `"Unknown"`.** Two live books changed
> (`23705230`, `45182e14`). The frontend already types `author: string | null` and renders nothing
> for a null (PDFs have always been null), so this degrades cleanly — but **WP-3 should render
> "Unknown author" as chrome**, per the plan.
>
> **(c) TOC/nav resolution must go through the OPF manifest, never filenames.** Guessing at
> `nav.xhtml` / `*.ncx` mis-read three real corpus books — two as "no TOC at all", one with
> double-counted entries (a nav document also carries page-list and landmarks navs). Had the
> importer guessed, two well-formed books would have been flagged degenerate. The same bug was found
> and fixed in WP-0's measuring reader; **it is a recurring trap in this format** and worth
> remembering for WP-6, which consumes these flags.
>
> **(d) Two clippy warnings of my own** (a duplicated match arm, an unfactored tuple type) — caught
> by comparing against the recorded baseline of 15 rather than by eyeballing the output.
>
> #### Handed to later packages
>
> - **WP-3**: `meta_provenance` per field (`declared|inferred|filename|default`) is now stored; the
>   metadata resolver should present a non-`declared` title as a guess. `books.script_detected`
>   is the trustworthy language signal — **not `books.language`**, which is preserved verbatim and is
>   wrong on 3 of 15 corpus books.
> - **WP-6**: `toc_degenerate` and `spine_fragmented` are computed at import and stored. `NULL` means
>   *not examined* and, for `toc_degenerate`, *the book declares no TOC document at all* — a
>   different state from "declares one that cannot navigate", and only the latter is worth
>   recovering from.
> - **WP-5**: `script_detected` is the per-book script for the TTS language check.

New `src-tauri/src/books/compat.rs`; `books/mod.rs` calls it and stores what it returns.

**2A · Decoding.** Replace `read_to_string` (`books/mod.rs:401-406`) with a tolerant decoder:
honour the XML declaration's encoding, then fall back UTF-8 → UTF-16 (BOM-sniffed) →
windows-1256 → latin-1. Strip a leading U+FEFF before the `mimetype` comparison
(`books/mod.rs:164`). Accept a *missing* mimetype as a warning when `container.xml` plus a parsable
OPF are present, rather than rejecting.

**2B · Producer detection.** Read `dc:contributor[role=bkp]` and `meta[name^=calibre]` into a new
`books.producer` column. **This is what makes every other rule safe:** `"Unknown"` is a confident
placeholder *when Calibre produced the file*, and possibly a real title otherwise. Producer-conditioned
rules are the difference between a compatibility layer and a heuristic that damages good books.

**2C · The placeholder-aware metadata ladder** (`EPUB_COMPATIBILITY_STUDY.md` §4.3):
`dc:title` → first content doc's `<h1>`/`<title>` → filename stem → localized `"Untitled Book"`,
each rung rejecting empty **and** placeholder values (`unknown`, `untitled`, `document`, `default`,
the `dc:identifier`, `غير معروف`, `بدون عنوان`; for creator also `word`, `author`, `user`, `calibre`).
**Author's fallback becomes `NULL`, not the literal `"Unknown"`** — the UI renders "Unknown author" as
*chrome*, so the database stops lying and "the file said Unknown" stays distinguishable from "Sard
gave up".

**2D · Language.** Keep RAWY-189's direction sniff exactly as it is — it is correct and it works.
Additionally store the sniffed script in a new column and, on disagreement with `dc:language`,
prefer the sniff for the operational field while keeping the declaration for the record. (3 of 14
books in the test library declare `en` over Arabic content.)

**2E · Structural flags**, computed once at import and stored:
- `toc_degenerate` when `navPoints + navLis < max(3, spine × 0.1)` — the Word book scores 1 vs 116.
- `spine_fragmented` when `median section < 4 KB` **and** `spine > 60` — the Word book measures
  a 2,450-byte median across 115 sections.
- Thresholds go in **named constants with the measurement in the comment**, so a later corpus can
  move them with evidence.

**2F · Provenance.** Every recovered field records `declared | inferred | filename | default`, so the
metadata editor can say *why* and the user can overrule through the existing `metadata_overrides`
mechanism — which already wins via `COALESCE`.

**2G · Migration `0015`.** Additive only: `producer`, `script_detected`, `toc_degenerate`,
`spine_fragmented`, `meta_provenance` (JSON). All nullable. Per the project invariant, once shipped it
is never edited.

**2H · Backfill.** Follow the RAWY-189 precedent exactly: idempotent, scoped so a re-run is a no-op,
never touches `metadata_overrides`, skips unreadable files silently so startup never fails. **It must
not overwrite a title a user has already corrected** — overrides are untouched by construction, and
that must be asserted by a test.

**Verification.** Automated: one Rust test per fixture; a **no-change test asserting the 13 good books
produce byte-identical `books` rows** to today; a backfill idempotence + override-preservation test
(the RAWY-189 tests at `books/mod.rs:818-892` are the template and already cover this shape). Manual:
§III I1–I8.

---

### ⚠ NAV-4 · The page-turn arrows were reversed in RTL books — reported 2026-08-05, fixed out of band

*Reported from real reading, after WP-4: "the left/right navigation arrows are reversed". The owner
asked whether it was the navigation mapping or RTL layout handling. It is the mapping.*

**Measured first, on real books, before any change:**

| book | ArrowRight | ArrowLeft |
|---|---|---|
| LTR (Alice) | FORWARD ✓ | BACKWARD ✓ |
| **RTL (Red Rising)** | **BACKWARD** ✗ | **FORWARD** ✗ |

**Root cause.** The controller navigated through foliate's `goLeft()`/`goRight()`, which are
direction-aware — `goLeft() { return dir === 'rtl' ? next() : prev() }`. So the keys moved the page
by SCREEN GEOMETRY, and their meaning inverted with the script. Nothing was wrong with RTL layout;
the arrows did exactly what they were told, which was the wrong thing. **WP-4 did not introduce
this** — the diff shows `handleNavKey` preserved the pre-existing mapping exactly; WP-4 only made
the keys reachable from every focus state, which is what made the inversion easy to notice.

**Why the requested behaviour is also the internally consistent one.** Sard already agreed with the
owner everywhere except here: the PDF path has always mapped ArrowRight to `view.next()` in both
directions, and the read-aloud skip maps ArrowRight to +1 with the explicit note *"media convention,
NOT mirrored in RTL"*. EPUB paging was the lone outlier, so this removes a contradiction rather than
introducing a convention.

**The fix.** `next()`/`prev()` (which called `goLeft()`/`goRight()`) are replaced by
`forward()`/`backward()`, which call `view.next()`/`view.prev()` — reading order, always. The key
table moved to `src/reader-engine/navIntent.ts`, which **takes no direction argument at all**, so the
defect is not corrected but *unrepresentable*: there is nothing left to branch on. The on-screen
chevrons were changed with it — ‹ is always Previous and › always Next — because leaving the buttons
mirrored while the keys were not would have replaced one inconsistency with a worse one. Their
tooltips no longer consult the book's direction.

**Regression tests, as requested.** `tests/unit/navDirection.test.ts` pins the table (6 tests),
including an assertion that `navIntent.length === 1` — reintroduce a direction parameter and the
suite stops compiling. End-to-end, `harness:interaction` now measures arrow direction on a REAL LTR
and a REAL RTL book and fails the run if either inverts, does nothing, or cannot be measured.

**Verification.** `npm test` 205/205 · `cargo test` 109/109 · clippy 15 = baseline · corpus 17/17 ·
byte-identity identical to `track-1` · `harness:tts` clean · `harness:interaction` clean, both
directions FORWARD/BACKWARD. **Mutation-tested:** restoring `goLeft()`/`goRight()` makes the harness
fail with "ArrowRight moved BACKWARD in reading order".

**Cannot regress existing behaviour.** LTR books already behaved this way and their measurements are
unchanged; only the RTL branch's outcome moves, and it moves onto the same rule the PDF and
read-aloud paths already used. The physical wrappers have no remaining callers.

**Two harness defects found alongside, both about the owner's data:**
1. **The profile guard could fail halfway.** A run ended, `sard.db` and `-wal` were restored, then
   `-shm` threw because a still-exiting Sard held it; the throw escaped the `finally`, so the
   snapshot was never cleaned up and the process was left running. Snapshot/restore now lives in ONE
   file (`tests/harness/profile.mjs`, shared by all three harnesses), retries against a deadline,
   treats `-shm` as the derived index it is, and KEEPS the snapshot with a loud warning if it truly
   cannot finish. A guard that protects the owner's data must not have three implementations.
2. **My own recovery was wrong, and the harness caught it.** Recovering from (1) I restored the
   earliest surviving snapshot — which had been taken during a paged-mode run — so the profile kept
   `flowMode=paged` and the next byte-identity compare reported **111 "regressions"** that were
   nothing but the flow mode. The config line the fingerprint records (added in WP-1 for exactly this
   confusion) is what identified it in one line. Profile restored; byte-identity clean.

---

### ⚠ TRACK-1 · TTS speaks but never highlights — found 2026-08-05, fixed out of band

*Reported against one book: "Edge TTS plays audio normally, but the word/sentence tracking never
starts." Reproduced by the owner, then measured. Not a TTS defect at all.*

**Root cause — the FIRST divergence, measured, not inferred.** `getChapterUnits`
([FoliateController.ts](src/reader-engine/FoliateController.ts)) finds the blocks to segment with
`doc.body.querySelectorAll("p, h1…h6, li, blockquote, div, section, article")` — every entry a
**block** element. The reported book, "داو الخالد العجيب", is a `.txt`→EPUB conversion: its
paragraphs are inline `<span>`s separated by `<br>`, with some text bare in `<body>`. That selector
therefore matched **0 nodes in all 88 chapter documents**, `anyLeaf` stayed false, and the whole-body
fallback emitted units with `range: null`.

Nothing downstream was broken. `text` still fed the TTS queue, so speech was perfect;
`showReadingHighlight` skips a null range and `setReadingWords` returns early, so the spotlight and
the word pill could never appear. **Audible and invisible, from one branch.** The fallback's own
comment called this "honest no-highlight" — but honesty the reader cannot see is indistinguishable
from a broken feature, and nothing in the DOM prevented the mapping: those text nodes are ordinary
and addressable.

**Book or Sard?** Both, and the split matters. The EPUB is structurally poor — valid HTML, no
semantic paragraphs. Sard's walk then gave up on ranges when it did not have to. The book is the
trigger; the code is the defect.

**Broader class, not one book.** Any EPUB whose chapters carry no block-level container — the normal
output of plain-text converters. The book is now a permanent corpus slot, `txt-converted`, and the
generated fixture `no-block-containers` covers the shape without needing the real file.

**The fix — one line, through proven code.** The fallback now calls `segmentBlock(doc.body, …)`, the
same routine every other book already uses: it walks the text nodes, segments the joined string once,
and maps each sentence's char offsets back to a live Range. Degenerate chapters get real ranges *and*
RAWY-247's over-long splitting, which the old fallback also skipped. The original "a text-bearing
chapter is never empty" guarantee is kept as a last resort beneath it. This branch is unreachable for
any chapter with even one block container, so no well-formed book can take it.

**Verification — a controlled A/B in the real binary, at pinned sections.**

| | pre-fix | post-fix |
|---|---|---|
| داو الخالد العجيب (section 22) | 111 units, **0 ranged** | 112 units, **112 ranged** |
| the other 15 corpus books | same section, same unit and range counts | identical |

Every book's section index and every unit/range count is unchanged apart from the reported one. The
112th unit is RAWY-247 subdividing one over-long sentence the old fallback left whole. Cost of the
repaired path: **1 ms** (the slowest book in the sweep is 190 ms, on the ordinary leaf path,
unchanged). Also: `npm test` 186/186 · `cargo test` 109/109 · clippy 15 = baseline · corpus 17/17 ·
byte-identity re-baselined as `track-1` (the only difference from `nav-fix` was the newly added book).

**New permanent gate:** `npm run harness:tts` opens every corpus book in the real binary and fails if
any unit the engine will speak cannot be highlighted.

**Two harness defects found while building that gate — both were silent false passes.**
1. The first book probed after launch returned an empty document and **0 units** — and 0 units
   satisfies "no unit lacks a range" vacuously. The gate now fails a chapter that produces no units
   at all, and waits for a document that has settled rather than one that merely has text.
2. Sections were not pinned, so each book resumed wherever it was last left; "Lord of the Mysteries"
   reported 274 containers in one run and 0 in the next, from two different chapters, making any
   before/after comparison unsound. The probe now pins `goToFraction(0.25)` like the byte-identity
   harness and prints the section index.

A gate that cannot fail is worse than no gate, so both were fixed before the fix was believed.

---

### ⚠ NAV-1 · Paged mode never paginated — found 2026-08-05, fixed out of band

*Reported as "TOC entries before Contents are unreachable in Alice". The root cause is much larger
than the report, and it changes WP-4's scope.*

**What was reported.** In Alice, the first three TOC entries all point into ONE front-matter document
(`…11-h-0.htm.xhtml#pgepubid00000/1/2` — a title, an edition line and a contents heading). Clicking
the first two appeared to do nothing and the highlight stayed on "Contents".

**Root cause — not TOC resolution at all.** `injectedCss.ts` emitted, paged-mode only:

```css
html, body { height: 100%; overflow: hidden; }
```

`overflow: hidden` makes `<body>` a **scroll container**, and per CSS Fragmentation a scroll
container is **monolithic — it cannot be split across columns**. foliate paginates by columnising
`<html>` and treating each column as a page, so this collapsed every chapter into ONE unbreakable
box: it rendered in column 1 and everything past the first screen was **clipped and unreachable**.

**Measured on the real app** (Alice chapter I, 26 paragraphs): laid out to **20,331 px inside a
624 px box, ONE column**, ~97 % of the chapter unreachable, foliate reporting 3 pages where it needed
~23. After removing the `body` half: **23 columns**. Isolated four ways —
`body{overflow:hidden}` alone breaks it; `body{height:100%}` alone is harmless.

**Why it presented as a TOC bug.** `paginator.js #scrollToRect` maps an anchor to a page with
`floor(rect.left / size)`. With no fragmentation every anchor in a section shares one `left`, so
**every TOC entry pointing into the same section resolved to the same page**. Alice is the only
corpus book with fragment-bearing TOC entries — but that shape is what Project Gutenberg's
Ebookmaker produces for *every* book it makes, so the class is large.

**The fix** is one token: `html, body` → `html`. `<html>` keeps the deterministic box that RAWY-04
needed, and foliate's own `columnize()` sets it there regardless.

**Scope impact — the whole corpus was affected**, because the profile's global `flowMode` is
`paged`. After the fix every corpus book fragments into real pages (Monte Cristo 75, Red Rising 58,
a4 53, فن الحرب 50 …); before, every one of them was a single clipped column.

> **This very likely subsumes the original report's issue #4** ("incorrect page layout · unstable
> page navigation · inconsistent pagination · pages behaving differently depending on content").
> **WP-4 must re-measure issue #4 against the fixed build before designing anything** — the
> section-granularity analysis in `EPUB_COMPATIBILITY_STUDY.md` §5.2 was written against a build
> where pagination did not work at all, and may no longer describe reality.

**Findings for later packages**

- **The byte-identity fingerprint tracked typography, not layout** — so this defect produced a
  *byte-identical* fingerprint, and so did the fix. The harness could neither have caught the bug nor
  seen the repair. **Fixed:** the fingerprint now records `layout { flow, pages, columns, paragraphs }`
  and `diff` compares it. Without that, WP-4 and WP-6 would have been verifying pagination work with
  an instrument blind to pagination.
- **`tests/harness/pagination.mjs`** reproduces the CSS mechanism in real Chromium (4 cases,
  including both controls); **`tests/unit/pagedFlow.test.ts`** guards the emitted CSS. Both were
  written *before* the fix and both failed against the old code.
- **`flowMode` changed from `scrolled` to `paged` in the profile between the WP-1 and WP-2 baselines,
  and I could not determine what changed it.** The renderer's `flow` attribute is never read back
  into settings (only the settings drawer writes `flowMode`), so the probes did not cause it. The
  WP-1 configuration capture caught it correctly as `CONFIG flowMode: scrolled → paged` rather than
  reporting 145 phantom regressions — which is precisely why that capture exists. Worth watching.

### WP-3 · One authoritative metadata source — ✅ **COMPLETE** (2026-08-05)
*Item 8.*

**What shipped.** `src/lib/bookMeta.ts` is now the only place that decides what a book is called.
Every surface resolves through it, and `FoliateController.title`/`.author` survive **only** as
extraction inputs — no display site reads them (grep-enforced by a test).

| Change | Where |
|---|---|
| The resolver + display rules | `src/lib/bookMeta.ts` (new) |
| The reader reads the **row**, by id | `commands::book_get` (new), `bookGet` in `src/lib/ipc.ts`, `Reader.tsx` open path |
| An extraction can only fill a gap | `library::set_extracted_metadata` (new) + `book_set_extracted` |
| PDF enrichment stopped writing overrides | `Reader.tsx` — `bookUpdate` → `bookSetExtracted` |
| Photo cards credit the effective name | `Reader.tsx` `openPhotoCard`, `addToBasket` |
| Missing title/author render as chrome | `ReaderChrome`, `SearchPanel`, library card / list row |
| A guessed title says so | the edit dialog, via WP-2's `meta_provenance` |
| Overrides are trimmed on write | `library::apply_field` |

**Three findings worth recording.**

1. **The plan said `OpenTarget` should carry the resolved title/author. That is not sufficient**, and
   implementing it as written would have left the bug alive on three paths. The reader is launched
   from four surfaces — library card, inbox, bookmarks shelf, cross-book note jump — and only the
   library card holds a full `BookRow`. A caller-supplied name would have been right on one path and
   absent on three. The reader now **fetches the row by id** (`book_get`), and `OpenTarget.title` /
   `.author` were kept as a *hint* used only if that read fails, so a book still opens with a name
   when the database is unreachable. Same direction as the plan, strictly more authoritative.

2. **The shipped PDF path could destroy a reader's rename, permanently.** `Reader.tsx` called
   `bookUpdate`, which writes `metadata_overrides` — the table meaning "the reader typed this". So
   opening a renamed PDF replaced their title with whatever PDF.js found in the file, and because the
   override *was* the only copy, the rename was unrecoverable. Now the extraction goes to the base
   columns, gap-only; the override wins through `COALESCE`, and reverting the override reveals the
   book's own name instead of nothing. This is a **data-loss defect fixed**, not a cosmetic one.

3. **A book vanished from the corpus harness, and it was my fault.** `resolveBookMeta` trims for
   display; the owner's library holds an override typed as `"الأنمساخ "` — trailing space. The card
   began rendering the trimmed form while the stored value kept the space, so the fingerprint harness
   could no longer find the card, and `arabic-normal--metamorphosis.epub` silently dropped out of the
   run. Trimming only at display would have *created* a stored-vs-shown divergence, which is the
   exact class of bug this package exists to remove — so the value is now normalised where it
   **enters** the database (`apply_field`), with the display trim retained for rows written earlier.
   The harness also stopped comparing raw stored text against rendered chrome, an assertion it had no
   business making. Without the byte-identity harness this would have shipped unnoticed.

**Verification.** `npm test` 178/178 · `cargo test --lib` 109/109 (16 new in `library/wp3_tests.rs`)
· clippy 15 warnings = baseline · `corpus:verify` 16/16 · byte-identity **identical to `nav-fix`**,
and metamorphosis renders again, so the sweep covers 15 books rather than 14.

**Mutation-tested, because a green test proves nothing until it has been seen to fail.** Two mutants
were introduced into the product code and both were caught: removing the gap-only guard failed
1 test; restoring the pre-WP-3D override write failed 7, including *"the reader's title must win"*.
The TS suite's grep-based test was likewise checked for a vacuous pass.

**Not done, deliberately.** The grid card still omits the author line when there is none, rather than
printing "Unknown author" under every PDF — it has no reserved slot, so omission reads better. The
list row, which *does* have a fixed column, uses the chrome. Values are consistent everywhere; only
the empty-slot presentation differs by layout.

---

#### Original plan


| | |
|---|---|
| **Addresses** | Reader header and photo cards bypassing the database |
| **Risk** | **Low** — two read sites change; the DB is already authoritative for the other three |
| **Depends on** | WP-2 (the resolver needs the recovered fields) |
| **Effort** | Small |

**The rule:** *the database is the single source of truth; the embedded file metadata is an
**extraction input** to it, never a display source.*

- One resolver, `src/lib/bookMeta.ts`, returning `{ title, author, dir, language, provenance }` from
  the COALESCE'd row — the same values the library, inbox and bookmarks already show.
- `OpenTarget` carries the resolved title/author into the reader. `FoliateController.title` /
  `.author` are **demoted to inputs** for the PDF enrichment path and are no longer read for display.
- Photo cards take the resolved values (`Reader.tsx:1188-1189`, `:1209-1210`), so a shared card
  credits what the user actually set.
- PDF enrichment (`Reader.tsx:483`) writes to the **extraction** columns, never over a user override.

**Two decisions to state rather than discover:**
1. **Denormalised `chapter_label` on existing annotations is not rewritten.** WP-6's synthesised TOC
   improves new annotations only. Rewriting history is a bigger, separate question.
2. The dev-only hardcoded photo-card author (`Reader.tsx:875`, inside the `import.meta.env.DEV`
   screenshot block) stays — it is not a product path.

**Verification.** Automated: a test asserting the resolver and `library_list_books` return identical
values for the same book, including with an override present. Manual: §III M1–M4 — in particular,
rename a book in the library and confirm the reader header, the photo card, the inbox and the
bookmarks shelf now all agree.

---

### WP-4 · The reading interaction model — ✅ **COMPLETE** (2026-08-05)
*Items 3 and 4.*

**The re-measurement changed the premise, and it mattered.** The chevrons render in PAGED MODE ONLY
(`showChevrons = isPaged || isPdf`) — and paged mode never paginated until NAV-1 was fixed the day
before. Issue #3 was therefore reported against a build where the mode it occurs in did not work.
Measured now, in the mode where it exists, it is real and quantified.

**Baseline, measured in the shipping binary before any change** (`tests/harness/interaction.mjs`):

| | before | after |
|---|---|---|
| left chevron vs open Contents, all 4 {en,ar}×{ltr,rtl} | **1764px² overlap, unclickable** | 0px², clickable |
| chevron x-position with the panel open | 22 (unmoved) | 322 = pad + 22 |
| ArrowRight after fresh open / toolbar click / desk click | **dead**, focus `body` | works, focus `foliate-view` |
| two rapid turns | **identical CFI — second dropped** | distinct CFIs |
| position readout | **nothing shown** | `Location 33 of 129` |

**Root causes.**
1. **Layout, not paint.** An absolutely positioned child resolves offsets against its containing
   block's PADDING BOX, so the desk's `padding-left: 300px` moved the page sheet and could never move
   a `left: 22px` chevron. Raising z-index alone would have floated the button ON TOP of the chapter
   list and stolen its clicks — the fix is to move it (4B), with the new rank as a backstop (4A).
2. **Key ownership.** The only page-turn handlers lived on the book iframe's document, and a keydown
   in a child frame never reaches the parent — so whenever focus was anywhere else the key reached no
   handler at all (4C). Focus itself was never claimed on open or after a TOC jump (4D).
3. **The engine discards, silently.** `#turnPage` returned immediately while locked (4E).
4. **The data was already there.** foliate emits `location`/`section`/`pageItem` on every relocate;
   Sard dropped all of it (4F).

**Deliberate design decisions.**
- **No synthetic page count.** A whole-book page number requires laying the book out at the current
  settings, and Sard's typography controls would move it under the reader — "421 pages" becomes
  "509" on one slider drag. Tier 1 is the book's REAL printed page (`page-list`; 0 of 17 corpus books
  have one). Tier 2 is a byte-derived **location**, and is labelled "location", never "page".
- **Depth-1 coalescing, never a queue** — a held arrow key must not bank turns that then run away.
- **4A's scope is the READER stacking context.** The library, photo composer and updater keep their
  own numbers; renaming those would be churn no gate in this milestone can check. Values are
  unchanged except `--z-nav`, raised deliberately above `--z-panel`.
- **Space was left alone.** It turns no page today, in any state; making it one is a new behaviour,
  not a repair, and is outside the approved scope.

**Verification.** `npm test` 199/199 · `cargo test` 109/109 · clippy 15 = baseline · corpus 17/17 ·
`harness:tts` every unit still ranged · **byte-identity identical to `track-1`** (so the layer rename
and the chevron move disturbed no typography or pagination) · `harness:interaction` clean.

**Mutation-tested.** Reverting only the paginator patch made one turn and two turns land on the
**identical CFI** — the gate catches the exact defect it exists for.

**Four harness defects found and fixed while building the gate — every one a false pass.**
1. The panel element is always in the DOM (hidden by class), so `.reader-panel` reported "open" for a
   closed panel and two rows were measured against a 0px pad.
2. The language key is `ui_lang`, not `lang`: both passes ran in Arabic while the table said "en".
3. Positions were not pinned, so "did the key turn the page?" depended on where the book resumed —
   the failing states MOVED between runs. Same defect the TTS probe had.
4. `renderer.page` is not comparable across a re-pin (one forward turn read 23→21), and **relocate
   fires several times per turn** (a single turn emitted 4), so counting either measured nothing.
   The unit is now an exact CFI from an exact CFI anchor, and the probe refuses to draw a conclusion
   when it cannot pin the same start twice.

---

#### Original plan


| | |
|---|---|
| **Addresses** | Hidden nav buttons · unusable navigation · focus loss · stacking · page-mode inconsistency · position awareness |
| **Risk** | **Medium** — touches the most-used surface, but every change is mechanically checkable |
| **Effort** | Large |

Items 3 and 4 are **one package** because they touch the same four files (`global.css`,
`Reader.tsx`, `ReaderChrome.tsx`, `FoliateController.ts`). Splitting them would open the reader twice.
As the brief asks, this studies the interaction model rather than patching symptoms.

**4A · A named layer scale.** One block in `global.css` defining `--z-desk`, `--z-chrome`,
`--z-panel`, `--z-nav`, `--z-modal`, `--z-toast`; every hand-picked `z-index` in the reader replaced
by a token. There are ~50 ad-hoc values today and they cannot be reasoned about as a set — which is
how a z-3 button ended up under a z-30 panel. **Written invariant:** *no application control may be
occluded by a panel, and no book content may occlude application chrome.*

**4B · Chevrons follow the reading area.** The real defect is not only z-order: an absolutely
positioned child is laid out against its containing block's **padding box**, so the desk's
`padding-left: 300px` moves the page sheet and cannot move the chevron. Bind the chevrons to the same
inset the desk uses (`inset-inline-start: calc(var(--panel-lead, 0px) + 22px)`) so they **move** with
the reading area, then raise them above panels as a backstop. Moving beats layering: a button merely
floated on top of the chapter list would be ugly and would steal its clicks.

**4C · Parent-window ownership of navigation keys.** Today the only page-turn handlers live on the
book iframe's document (`FoliateController.ts:1387-1392`, `:1474-1478`), and the parent window binds
only Ctrl+F and `/` (`Reader.tsx:1162-1176`). Invert it: the **parent owns** page-turn keys and the
frame **forwards** to it — the pattern `FoliateController.ts:1489-1516` already uses successfully for
F11 and Ctrl+F. This single change fixes all five focus-loss states at once (fresh open, toolbar
click, panel open, TOC click, desk-margin click) and is strictly smaller than chasing focus.

**4D · Focus policy, stated once.** A written rule — *after any navigation action, focus belongs to
the reading frame unless a keyboard user is deliberately in the chrome* — with `focusReadingView()`
called at each transition, including after `openBook` (which never calls it today) and after a TOC
jump (`Reader.tsx:1502`, which navigates without closing the panel or restoring focus). The existing
partial rule (`Reader.tsx:756-765`) fires only on the *last* panel's close.

**4E · Turn coalescing.** `paginator.js:1081-1092` discards every `next()`/`prev()` while locked
(100 ms + section-load), with no feedback. Replace the drop with a **depth-1 pending turn** executed
on release — mirroring the "one-deep" discipline `Reader.tsx:1138` already uses for jump anchors —
and give the button a visible in-flight state. **This is a fourth local patch to the pinned engine:
it must be recorded in `VENDOR.txt` beside the other three.**

**4F · Position awareness (item 4).** Use foliate's own data; invent nothing.
`progress.js:80-97` already returns `location: {current, next, total}` and `section: {current,
total}` on every relocate, and `view.js:329-337` attaches `pageItem` from the EPUB `page-list` — and
`FoliateController.ts:1352-1377` **discards all of it**. Carry it through and display, in order of
preference:

1. `pageItem` — the **real printed page** of the source edition, when the book provides a `page-list`
   (0 of 14 books here do, so it is a bonus tier, not the plan).
2. `location.current / location.total` — always available, byte-derived, **stable under font size,
   margins, page width, window size and flow mode.**
3. Paged mode only, as a secondary: page *n* of *m* within the chapter (`paginator.js:798-802`).

**Do not build a synthetic whole-book page count.** It requires laying out the entire book at the
current settings, and Sard's typography controls are rich enough that "421 pages" would become "509"
on one slider drag. A counter that moves under the reader is worse than none — which is why Kindle
uses locations and why foliate already computes them. Label tier 2 **"location"**, and say **"page"**
only when tier 1 is real. Both run through `localeNum`, as the PDF readout already does.

**Verification.** Automated: a geometry test asserting the chevrons' bounding boxes never intersect an
open panel's, in all four {EN,AR}×{LTR,RTL} combinations; a key-routing test for every focus state;
a coalescing test (two rapid turns → exactly two pages, never one); a monotonicity test on
`location.current`. Manual: §III N1–N8, P1–P4.

---

### ⚠ WP-5 — MEASUREMENT M1 COMPLETE (2026-08-05) · **the approved design needs two corrections**

*Implementation is STOPPED pending approval, per the standing rule on significant plan changes. The
pre-flight mechanism (5A) is confirmed correct and unchanged; what follows corrects its predicate and
replaces 5B's matching mechanism.*

**How it was measured.** Ten live syntheses through Sard's own `tts_synthesize` IPC — the identical
call Play makes — against the real Edge endpoint, with 322 voices available in this region
(`tests/harness/tts-mismatch.mjs`). Controls included in the same run, so a null result cannot be
confused with a broken probe.

| voice | text | result |
|---|---|---|
| en-US-Aria | **Arabic** | **AUDIO — 6 bytes** |
| fr-FR-Denise | **Arabic** | **AUDIO — 6 bytes** |
| de-DE-Katja | **Arabic** | **AUDIO — 6 bytes** |
| ar-EG-Salma | English | AUDIO — 36,741 bytes ✅ |
| ar-EG-Salma | French | AUDIO — 41,356 bytes ✅ |
| en-US-Aria | French | AUDIO — 33,434 bytes ✅ |
| en-US-Aria | English *(control)* | AUDIO — 28,676 bytes ✅ |
| ar-EG-Salma | Arabic *(control)* | AUDIO — 38,692 bytes ✅ |
| Multilingual | Arabic *(control)* | AUDIO — 33,219 bytes ✅ |
| nonexistent voice *(control)* | English | ERROR — `unknown edge voice` |

**Answer to M1: none of the three options the plan considered.** Edge does not reject a mismatch, does
not 4xx, and does not error. It returns **HTTP success carrying a 6-byte MP3** — about one millisecond
of nothing. The reader hears silence; the pipeline sees a completed synthesis and moves on.

#### Correction 1 — 5B cannot match a wire error, because there is no error

The plan specified `voice-language-mismatch` as a class matched on the wire failure. **There is no
wire failure to match.** A safety net matched against a guess would be dead code that looks like
protection. The signal that DOES exist is a *successful* synthesis returning a degenerate buffer:
**6 bytes against 28,000–41,000 for every working pair** — three orders of magnitude, not a
borderline call. Recommended: 5B detects an implausibly small buffer for a non-empty request and
raises the same terminal, never-retried class. Same intent, same "never enters the ladder" rule; only
the trigger changes, and the plan already deferred that trigger to this measurement.

#### Correction 2 — the compatibility rule is ASYMMETRIC, and the approved table is not

The approved table says *incompatible = the voice's locale does not match the detected script*, which
is symmetric. **Measurement says the failure is one-directional:**

- A non-Arabic-script voice fed **Arabic** script produces silence — en, fr and de all identical.
- An **Arabic voice reading Latin text works perfectly** (36 KB / 41 KB), as does an English voice
  reading French. Every Latin-script combination is fine regardless of language.

So the approved rule would raise a **false warning on a combination that genuinely works** — an
Arabic voice reading an English book, which is a realistic thing for this owner to do. Recommended
predicate: *incompatible when the BOOK's script is non-Latin and the voice's locale does not use that
script (and the voice is not Multilingual)*. A Latin-script book accepts any voice.

**Scope of the evidence, stated honestly:** this was measured for Arabic and Latin script only, which
is Sard's actual world (17 corpus books, all Arabic or Latin). It is not a claim about CJK or Cyrillic,
and the predicate should be written so that an unmeasured script is treated as compatible rather than
warned about — a false warning is worse than a missing one, because it trains readers to dismiss it.

**Unchanged by this measurement:** 5A's pre-flight-before-synthesis mechanism (still the only thing
that can catch Piper's confident gibberish, where audio is genuinely produced), 5C's user-facing
state and "use it anyway", and 5D's prohibition on touching the ladder.

---

### WP-5 · TTS language compatibility — ✅ **COMPLETE** (2026-08-05)
*Item 7. Implemented against the MEASURED behaviour, with both corrections approved by the owner.*

| Part | What shipped |
|---|---|
| **5A** | `src/lib/voiceCompat.ts` — the pure rule; `script_detected` exposed on `BookRow` → `BookMeta` → the reader store; the pre-flight in `useTts.start()`, **before** the first synthesis |
| **5B** | `isImplausiblyShortAudio` in `synthInvoke`, throwing `voice-language-mismatch`, which `isPermanentFailure` recognises — so it can never enter the ladder |
| **5C** | A distinct terminal pill state (no "Retry" — it cannot succeed), *Choose another voice* / *Use it anyway*, and an inline note in the picker at selection time |
| **5D** | `tests/unit/ttsLadder.test.ts` asserts the ladder's shape is unchanged |

**The rule, and why it is asymmetric.** A voice that cannot RENDER a script produces nothing; a mere
language mismatch inside a script it *can* render is fine. So `arabic` book + non-Arabic-script voice
is the only incompatible case, Multilingual is always universal, and **every Latin combination and
every unmeasured script is compatible** — a false warning teaches readers to dismiss the dialog, so
the design ranks it as the worse error. The gate reads the SNIFFED script (WP-2's `script_detected`),
never the declared language, because declared metadata is exactly what WP-2 exists to distrust.

**"Use it anyway" is recorded per voice id** (`tts_voice_ok:<id>`), so consenting to one incompatible
voice never silently clears the warning for a different one. RAWY-197 removed the picker's language
filter deliberately and D37 says the engine never changes without an explicit press — Sard warns and
obeys.

**Verification.** `npm test` **228/228** (16 new compatibility tests, 7 ladder tests) · `cargo test`
109/109 · clippy 15 = baseline · corpus 17/17 · byte-identity identical to `track-1` · `harness:tts`
clean · **the live endpoint re-measured, and the SHIPPING rule evaluated inside the running app agrees
with every one of the ten measured outcomes** (`tests/harness/tts-mismatch.mjs`, which now fails if
the code and the endpoint ever disagree).

**One thing deliberately not done.** Piper cannot be verified end-to-end the way Edge was: its failure
mode is *plausible audio* (eSpeak-NG phonemising Arabic under English rules), so there is no
measurable signal to assert against — only the pre-flight protects it, and the pre-flight is tested
against the Piper model ids directly. Stated rather than implied, because "tested" would overclaim.

#### ⚠ Open defect found during WP-5 — the interaction harness leaks `flowMode`

`tests/harness/interaction.mjs` forces paged mode to measure the chevrons, and its DB snapshot/restore
does **not** revert that setting: after a run the profile stays `paged`, and the next byte-identity
compare reports **~111 false regressions** that are nothing but the flow mode. Observed twice.

Almost certainly a race — the app is killed and the files are restored ~500 ms later, so a dying
process can flush its own `reading_style` over the restore. **Not fixed inside WP-5**: it is a harness
defect, not a product one, and diagnosing a shutdown race properly needs its own measurement rather
than a guess bolted onto this package. Mitigations in place now: `tests/harness/set-flow.mjs` puts the
profile back deterministically, and the fingerprint's `config` line names the drift in one line
whenever it happens. **Recommend fixing before WP-6**, since every remaining package's verification
depends on byte-identity being trustworthy.

---

#### Original plan


| | |
|---|---|
| **Addresses** | Incompatible voice entering the retry pipeline |
| **Risk** | **Low-medium** — new gate ahead of an untouched pipeline |
| **Depends on** | Nothing (fully parallel) · **blocked on measurement M1 for 5B only** |
| **Effort** | Medium |

**5A · Pre-flight compatibility check — the primary mechanism.** Before the first synthesis of a
session, compare the **book's detected script** (WP-2's `script_detected`, else the corrected `dir`)
against the **voice's locale** (`EdgeVoiceInfo.lang`, already carried; `VoiceDef` for Piper). Three
outcomes:

| Outcome | Condition | Behaviour |
|---|---|---|
| **compatible** | locale's primary code matches the detected script family | Proceed unchanged |
| **universal** | the voice is Multilingual (already detected in `TtsVoicePicker.tsx:120`) | Proceed unchanged |
| **incompatible** | otherwise | **Never dispatch.** Show a distinct state before any audio is attempted |

The pre-flight is what makes this correct for **Piper**, where an English model reading Arabic
returns *audio* — confident gibberish, no error at all. No post-hoc classification can ever catch
that. This is the deciding argument for gating before synthesis rather than classifying after.

**5B · A new terminal class, outside the ladder.** Add `voice-language-mismatch` as a
**`isPermanentFailure` sibling — never a retry class** — as a safety net for the case the pre-flight
misses (a mid-chapter script change, an unexpected wire error). The ladder's own comment already
states the principle: a permanent failure must not enter it. *Exact wire-error matching depends on
measurement M1.*

**5C · The user-facing state.** Distinct from `edge-error`, with different actions:

> **This voice doesn't speak Arabic.**
> *William (Multilingual)* is an English voice, and this book is in Arabic.
> **[ Choose an Arabic voice ]** · [ Use it anyway ] · [ Cancel ]

- The primary action opens the picker **pre-scrolled to the compatible section** — the picker already
  groups by language with Arabic sorted near the top.
- **"Use it anyway" must exist.** RAWY-197 removed the language filter on purpose, and D37's standing
  rule is that *the engine never changes without an explicit user press*. Sard must not silently
  override an explicit choice; it must warn and obey. A "don't ask again for this voice" checkbox
  keeps a deliberate user out of a nag loop.
- **The picker warns at selection time too** — an inline note on incompatible voices — so the problem
  is visible before Play, not after.

**5D · What must not change.** The retry ladder, its backoff constants, `STALL_RETRY_LIMIT`, the
scheduler, and every existing classifier stay **untouched**. They were calibrated against measured
recovery curves (RAWY-257/266) and this package has no evidence to move them. The whole change is
*one gate in front* and *one class beside*.

**Verification.** Automated: a matrix of (book script × voice locale) → expected outcome, including
Multilingual and no-locale voices; a test asserting the mismatch class **never** enters
`RETRY_BACKOFF_MS`; a test asserting compatible pairs are byte-identical to today's path. Manual:
§III T1–T6.

---

### 🔬 WP-7 STRESS CAMPAIGN — **IN PROGRESS**, resume here (2026-08-05)

*The owner's standing brief: **try to break WP-7**. Optimise for discovering weaknesses, not for a
green run. Ten genuine defects beat a report claiming perfection because the investigation was
shallow. If something cannot be explained, STOP and measure it — do not work around it.*

**Per finding, record:** reproduction · measured root cause (never guessed) · Sard vs book vs
library/external · severity · does it block shipping · safest fix · implementation risk · regression
risk.

#### EVIDENCE CLASSIFICATION — required on every claim that influences design

Any claim strong enough to affect architecture, design or implementation carries one of these, and a
lower tier is **never** stated with the confidence of a higher one:

| tier | meaning |
|---|---|
| **Measured** | directly observed via instrumentation or reproduction in the running app |
| **Code-derived** | concluded from reading the implementation; NOT verified at runtime |
| **Hypothesis** | plausible, still requires measurement |
| **Unknown** | insufficient evidence |

A measurement contradicting a Code-derived conclusion is **information, not failure** — update the
finding and record why the original reasoning was insufficient. This milestone has three worked
examples: FINDING-8 (a computed value read without decomposing its inputs), FINDING-4 (a fixture name
taken from this document rather than verified), FINDING-6 (one artifact's flaw extrapolated to
another). All three were fast, confident and wrong.

**Before closing any package, answer in writing:** *what assumption am I making that I have not
measured?* Either measure it or record it below as an open question. The goal is not avoiding
mistakes; it is preventing unmeasured assumptions from hardening into accepted facts.

#### Findings so far

| # | Finding | Evidence | Severity | Location | Status |
|---|---|---|---|---|---|
| 1 | `! important` (space or comment between bang and keyword) bypassed the sanitiser | **Measured** | HIGH | Sard | ✅ FIXED — `/!\s*important/i` after comment strip |
| 2 | ONE byte-identity compare reported 3 diffs; 9 later runs clean. Content not captured | **Unknown** (the original event) | MEDIUM | unknown | ✅ CLOSED as a process gap — `dumpDiff()` now writes the complete diff on every failure (4 mutants killed, proven live). The 2026-08-05 event it could not explain was later reproduced and explained in full: settings drift, see FINDING-11 / UNKNOWN-1 |
| 3 | The corpus book's `-84.8pt` sits on `.block_`, which matches **0 elements** — the rationale's own evidence is a dead rule | **Measured** (`hostileMatchedElements: 0`) | HIGH (to rationale) | Book | ✅ understood |
| 4 | First falsification test targeted `a4`, which lacks the hostile margin — could never have detected clipping | **Measured** | MEDIUM | test harness | ✅ FIXED |
| 5 | الشوقيات reports `paras: 1` with 6032 chars, all modes | **Unknown** | LOW–MED | unknown | 🔴 OPEN |
| 6 | Dead-selector class of error; generated fixtures verified **sound** (`.para`/`.chap` match) | **Measured** | MEDIUM | corpus book only | ✅ guarded by tests |
| 7 | `raw` genuinely clips: `marginLeft −113px`, `marginRight 492px`, **`overflowX 1075px`**, `position:absolute`, `width:900px` | **Measured** | HIGH | Sard (by design) | ✅ rationale confirmed |
| 8 | `line-height` was reported as book-won; it is **Sard-won**. 25.2px = unitless `2.1` × book's `font-size:12px` | **Measured** — corrects a **Code-derived** claim | LOW (defect) / HIGH (table) | Sard | ✅ reclassified REDUNDANT |

**Re-derived table status.** `margin-left/right`, `position`, `float`, `width`, `font-size`,
`overflow` → **LOAD-BEARING (Measured)**. `margin-block`, `line-height` → **REDUNDANT (Measured)**.
`font-family`, `color`, `background-color` → **REDUNDANT (Code-derived only** — from the `!important`
inventory; they survived one run but were never decomposed the way `line-height` was, and that is
exactly the check FINDING-8 failed). `text-align`, `text-indent` → **Unknown**.

#### PROCESS RULE — the investigator does not set priorities

During stabilisation the investigation order is **fixed by the owner**. A discovery that looks more
important than the current task is NOT promoted; it is filed as a **Potential Priority Change**:

1. why it may matter more than the current task
2. estimated impact **if the hypothesis is true**
3. the cost of interrupting the work in progress
4. **stop and ask** — no reordering without approval

Rationale, in the owner's words: frequent context switching makes it much harder to know which
conclusions are complete and which are still pending. Discovering evidence and naming risk is the
investigator's job; deciding what gets worked on is the project's.

**Open Potential Priority Changes are listed below and remain UNSCHEDULED until approved.**

#### PPC-1 — inline `<style>` blocks may bypass the sanitiser *(awaiting decision)*

* **Claim tier: Code-derived.** `epub.js:857` routes `<style>` element text through `replaceCSS`, so
  the WP-7 hook *should* apply. **Never observed at runtime.** Every hostile test to date used an
  EXTERNAL stylesheet.
* **Impact if true:** a book carrying hostile CSS inline defeats WP-7 entirely, and no current test
  would notice — the feature's core guarantee would be conditional on stylesheet delivery method.
* **Impact if false:** none; one measurement converts a Code-derived assumption to Measured.
* **Cost to interrupt:** low-moderate. The fixture generator already emits inline styles, so this is
  one fixture plus one import-and-measure run. It would defer `text-align`/`text-indent` by roughly
  one work unit and adds a second in-flight thread to the CSS investigation.
* **Status: NOT SCHEDULED.** The next task remains `text-align` / `text-indent` unless the owner
  says otherwise.

### 👁 MANUAL VALIDATION PASS — findings and dispositions (2026-08-05)

Method note, stated because it bounds every conclusion here: this was a **static visual review** of
real captured application states, not a human reading session. It can see layout, overlap, RTL,
typography and truncation. It cannot see animation, flicker, transitions, latency or "feel" — those
remain unvalidated and need a person.

| id | finding | disposition |
|---|---|---|
| B1 | `search.hidden` used the Arabic plural (`{n} نتائج`) where every sibling string uses the singular | ✅ **FIXED** — Arabic 11–99 takes the singular; the panel showed "72 نتيجة" and "72 نتائج" three lines apart |
| U2 | Read-aloud transport covered the sentence being spoken | ✅ **FIXED** — see below |
| U3 | TOC mixes `قسم N` and `الفصل N` numbering | ⚪ **INTENTIONAL, documented** |
| U5 | Reader back control is left-anchored/left-pointing in an RTL UI | 📋 **DOCUMENTED, not changed** — owner's call |
| U6 | A library card reads title "Unknown", author "word" | ✅ **NOT A DEFECT** — stale row, proven |

#### U2 · The read-aloud transport hid the text it was reading — **FIXED** (Measured)

My first report understated this. I had only seen sentence 1 of 30, at the top of the page, and
described the pill as covering *static* text. Photographing playback at **sentence 6 of 30** showed
the real defect: the spoken sentence's highlight bands sat at the bottom of the window with the
transport directly on top of them — the reader could not see the words being read to them.

**Root cause, measured in `followReadingSentence`:** the scrolled-mode comfort band is 15–85% of the
reading box, but the transport is `position: fixed` and occupies roughly the bottom 30% of a 720px
window. A sentence at 80% therefore satisfied "comfortably in view" while being physically behind
the pill. The band measured the BOX; the occlusion is over the box.

**Fix:** the comfort band now ends where the occlusion starts —
`min(rv.top + rv.height*0.85, obstructionTop - 8)`, with `readingObstructionTop()` reading the live
`.tts-pill` rect and honouring its hidden/faded states (immersive fades it to `opacity: 0`, and a
faded pill occludes nothing). It reads the element rather than hard-coding a height because the
transport resizes (collapsed, expanded, chapter-end, Edge-error).

Deliberately **scroll-target only** — no layout change, so no repagination, and paged mode is
untouched (there, scrolling cannot resolve occlusion and a change would only churn). Verified: at the
same sentence 6/30, the sentence now starts at ~⅓ height with the active word visible above the
transport; byte-identity **byte-identical**; TTS harness green.

**Known limitation, not fixed:** the TAIL of a long (5-line) sentence can still pass under the
transport. The start of the sentence and the word cursor — what a listener actually follows — are
now always clear. Making the landing point adapt to sentence height is a behavioural change beyond a
pre-freeze fix.

#### U3 · Two numbering schemes in the TOC — intentional (RAWY-287)

Alice reads `قسم 1, 2, 3` → `الفصل 1…12` → `قسم 16`, and the 3 → 1 → 16 jump looks wrong. It is not.
`ChaptersPanel` labels a row by whether it carries a chapter designator: entries WITH one use the
**book's own** number (`الفصل N`); entries WITHOUT one — front matter, a Contents page, a preface —
are labelled as **sections** by **spine position** (`قسم N`). The rationale is recorded in the code:
numbering them all positionally is what "made a Contents page outrank the real Chapter I".

Left unchanged: the alternative re-introduces the bug RAWY-287 fixed. If it proves confusing to real
readers, the better lever is **visual** (de-emphasise section rows) rather than renumbering — noted
for after the beta, not now.

#### U5 · RTL back control — investigated, NOT changed (owner's decision)

Measured: `ReaderChrome.tsx:146` renders `<button className="rc-back">‹</button>` — a **literal
glyph**, with no direction-aware mirroring in CSS, and the header is not mirrored (back sits at the
LEFT while the library sidebar correctly sits at the RIGHT).

Against convention, this is wrong: mainstream RTL guidance (Material, Apple HIG) and native Arabic
readers mirror the navigation bar wholesale — back moves to the trailing edge, which in RTL is the
right, and the chevron points right. So the glyph and the placement are inconsistent with the rest of
the app's RTL treatment.

**Not changed, on purpose.** Flipping the glyph alone would make it point *away* from its own button;
fixing it properly means re-laying-out a chrome carrying a lot of prior work (RAWY-66 sizing, D21
fixed positions, RAWY-42 non-occlusion, RAWY-59/60 popovers). That is not a pre-freeze change, and
"which side should Back live on" is a question Arabic-native beta testers answer far better than I
can. **Recommend asking them explicitly.**

#### U6 · "Unknown" / "word" — a stale row, not a defect (Measured)

Three measurements settle it:
1. The EPUB's own metadata declares `<dc:title>Unknown</dc:title>` and `<dc:creator>word</dc:creator>`
   — the file really does say that.
2. Sard's mitigation exists and is tested: `is_placeholder_title("Unknown")` and
   `is_placeholder_author("word")` both return true.
3. A **fresh import today** produces title `word-generated--unknown-title` (filename-derived),
   author `null`, provenance `{"title":"filename"}` — WP-3's acceptance criterion I1 IS met.

The visible row is legacy data written before the WP-2/WP-3 compatibility layer existed; re-import
replaces it. New testers importing this file get the correct result. **No code change.** Existing
libraries keep stale rows — a backfill is a product decision, not a stabilization fix.

### ✨ PRE-BETA POLISH (2026-08-05)

| item | outcome |
|---|---|
| Theme names localized | ✅ **FIXED** — 16 names, all 5 render sites |
| Slider / progress direction | 📐 **PHILOSOPHY DECIDED + documented; one deviation recorded, not changed** |
| Settings panel bottom clipping | ✅ **FIXED** — soft fade affordance |
| Wrapped settings tabs | ⚪ **KEPT, rationale documented in the CSS** |

#### Theme names — localized

`THEMES[id].name` was a hard-coded English string rendered at **five** sites (the reading drawer
swatches, its two contrast/scope interpolations, the global settings picker, and the photo composer's
labels). Now `theme.<ThemeId>` keys in both locales; because `TKey = keyof typeof en`, the template
literal `` t(`theme.${id}`) `` is **type-checked against the key list** rather than cast, so a missing
or renamed theme is a compile error, not a silent English fallback.

Translated naturally rather than transliterated: **رَقّ** (parchment — the classical word for the
writing skin), **غَسَق** (dusk), **مَرْيَميّ** (sage), **بُنّي عتيق** (sepia), **سماء مقمرة** (moonlit
sky), **حِبر**, **كتّان**, **فحميّ**, **توتيّ**, **ليليّة**, **أردوازيّ**, **أسود خالص**, **عاجيّ**,
**كوارتز ورديّ**, **ليل الغابة**, **إسبريسو**.

#### Slider & progress direction — the philosophy, and where it is not yet applied

Studied across every `input[type="range"]` and progress bar in the app. Sard already HAS a coherent
model; it is stated in the CSS but not uniformly applied. Written down here so it can be:

1. **Physical chrome is PINNED, never mirrored.** `.reader-root { direction: ltr }` (RAWY-89) exists
   so drawers dock to fixed physical edges — settings right, chapters left (RAWY-32) — which is what
   stopped them overlapping. Chrome position must not move when the UI language flips.
2. **Media transports follow MEDIA convention, not reading direction.** `.tts-transport-mid` is
   explicitly `direction: ltr` — ⏮/⏸/⏭ mean the same on YouTube and Spotify in every locale, and the
   code says so. ⏮ is "earlier in time", not "earlier in the text".
3. **Value controls follow the READING direction.** A slider whose ends mean less→more should grow
   the way the reader reads. The volume slider already does this: `.tts-pill[dir="rtl"]` flips its
   fill gradient `to right` → `to left`.

**The one deviation, measured:** the typography sliders (text size, line spacing, paragraph spacing)
sit inside the LTR-pinned reader shell and therefore render **LTR** — small `A` on the left, large `A`
on the right — while the volume slider two panels away mirrors correctly. That is not a decision; it
is inherited from rule 1 and never revisited. Under rule 3 those sliders should mirror in Arabic.

**Not changed before the freeze, deliberately.** Overriding the direction on those rows means locally
undoing the very pin that fixed the RAWY-89 drawer overlap, and a partly-undone pin is exactly how
that bug returns. It is a contained fix (three rows plus the `A`/`A` endpoints) but it wants its own
before/after verification, which is post-beta work. **Recorded as the one known direction
inconsistency**; ask beta testers whether it actually reads wrong to them.

#### Settings panel clipping — fixed

`.sp-body` scrolls but ended in a hard cut, slicing a heading or swatch row mid-height so it read as
a rendering fault rather than "more below". Added a 34px bottom fade to the chrome colour on
`.settings-panel::after`, `pointer-events: none` so every control underneath stays clickable. Chosen
over a scroll-driven fade because `animation-timeline: scroll()` needs the pseudo-element on the
scroller itself; a permanent soft edge is correct-looking at rest and cannot misbehave.

#### Wrapped settings tabs — kept, with reasons

Five tabs at `flex: 1 1 30%` wrap to 3 + 2 with a wider bottom row. Reviewed and kept: one row of
five gives ~68px per tab where "القراءة الصوتية" needs ~85px (truncation, or shortened Arabic copy,
to fix a cosmetic complaint); a 3-column grid leaves a visible hole; two-per-row is taller and worse.
Filling the row is also conventional segmented-control behaviour. The count is fixed at five — the
PDF drawer returns its own panel — so this is not a responsive-count problem. Rationale is in
`global.css` above `.sp-tabs` so it is not re-litigated.

### 🏁 RESILIENCE-1 STABILIZATION — CAMPAIGN CLOSED (2026-08-05)

**WP-7 introduced zero rendering regressions**, proven byte-for-byte across all 16 corpus books
under matched settings. Every subsystem below was driven in the RUNNING application under all three
`book_css` modes, each with a vacuity guard that fails the run if the modes delivered identical CSS.

| subsystem | verdict | key evidence |
|---|---|---|
| CFI identity & round-trip | ✅ | byte-identical CFIs; `/6/8!/4/4` → "كان ألكسى فيدورو" in all modes |
| Resume | ✅ | saved/restored CFI and fraction identical to the character |
| Search | ✅ | same hit count and first-hit CFI (Alice 82, Karamazov 100) |
| Highlights / notes / bookmarks | ✅ | persist, draw, and survive every mode transition |
| Annotations across a mode CHANGE | ✅ | all 6 transitions incl. `raw↔sanitised`, `raw→off` |
| References | ✅ | create/load/render/update/delete, overlayer 3→4 and 0→1 |
| TTS — real playback | ✅ | start, speak-along, pause, resume, seek, chapter change, 20 s, stop |
| Themes | ✅ | 5 themes × 3 modes, text colour byte-identical per theme |
| Pagination (paged AND scrolled) | ✅ | 40 / 17 columns, identical across modes |
| Memory | ✅ | post-GC heap flat: −9.2 KB per identical cycle |
| Endurance | ✅ | 171 operations, open latency ×1.00, DOM nodes ×1.04 |

**Every finding is Fixed, Expected-with-evidence, or Documented.** Nothing is left as a bare
"Unknown". Still open and explicitly the owner's call: **PPC-1** (inline `<style>` bypass),
**PPC-2** (paginated byte-identity baseline), **FINDING-5** (الشوقيات `paras: 1`), the **English UI
audit** (blocked — no screenshot has ever arrived), and adopting the new `resilience-1-final`
baseline.

**Ten defects were found during this campaign. Nine were in the harness, not the product** — each
one capable of producing a false pass or a false alarm, and each caught by measurement rather than
by reasoning. That ratio is the campaign's main result: the product held; the instruments did not,
until they were fixed.

#### TASK 4 · Subsystem regression campaign — **IN PROGRESS** (2026-08-05)

`tests/harness/subsystem.mjs`. Each subsystem is driven in the running app under **all three
`book_css` modes** and compared ACROSS modes, because the question is not "does search work" but
"does book CSS change what search does". Invariants I1–I6 are declared at the top of the file.

**The guard that makes the result mean anything.** A cross-mode comparison that passes is worthless
if the modes delivered the same CSS — it would read as "book CSS is harmless" when it may only mean
the hook never fired. So every run first measures the CSS actually in the section document, and the
comparator FAILS as `VACUOUS` if the three modes are indistinguishable. Measured, so the runs below
are non-vacuous:

| book | off | sanitised | raw |
|---|---|---|---|
| `control-wellformed--alice` | 4 sheets / 31 rules / 79 decls | 7 / 70 / 200 | 7 / 78 / 271 |
| `arabic-normal--karamazov` | 4 / 32 / 80 | 5 / 38 / 111 | 5 / 39 / 116 |

**Result — no cross-mode violation, on an English and an Arabic RTL book, in PAGINATED flow:**

* **I1 CFI identity — holds.** Byte-identical CFI strings for the same paragraphs in all three
  modes, anchored on identical text. This is the data-safety invariant: a highlight made in one mode
  is not lost or displaced in another.
* **I2 CFI round-trip — holds, textually.** `epubcfi(/6/8!/4/4,/1:0,/1:16)` → "كان ألكسى فيدورو" and
  `/6/8!/4/6` → "لقد تزوج مرتين و", identical in off/sanitised/raw.
* **I3 search — holds.** Same hit count and same first-hit CFI per book across modes (Alice 82,
  Karamazov 100), 52–83 ms.
* **I4 annotations across a MODE CHANGE — holds.** The per-mode runs restore the database between
  them, so they never actually crossed a boundary; `--crossmode` anchors a highlight in one mode and
  reopens in another in a single session. off→raw on Alice (31→78 rules) and on Karamazov (32→39):
  same CFI still produced, highlight count +1, overlay drew.
* **I5 resume — holds, exactly.** Saved and restored CFI and fraction identical, to the character.
* **I6 pagination — measured for the first time.** Alice 40 columns, Karamazov 17, `column-width`
  688px / gap 56px, identical across modes. FINDING-10's blind spot does not apply here: this probe
  drives `flowMode: "paged"` explicitly and restores it.
* **Memory / performance — no growth.** 48 section navigations per run; heap ends level or lower
  (GC observed), open 3.4 s Alice / 5.4 s Karamazov, search 52–83 ms.

##### Part 2 — themes, TTS, scrolled flow, reverse transitions, endurance (`subsystem-extras.mjs`)

* **Scrolled flow — holds.** Full three-mode matrix on the Arabic book, no violation; same 11
  paragraphs, same 100 search hits, resume exact. Paged and scrolled are now equally covered.
* **All four reverse transitions — hold.** `raw→off`, `sanitised→off`, `raw→sanitised`,
  `sanitised→raw`: same CFI still produced, highlight +1, overlay drew, rule counts changed at every
  step so none was vacuous.
* **I7 themes — holds.** 5 themes × 3 modes = 15 measurements. Text colour is byte-identical across
  modes for every theme (ivory `rgb(43,37,33)`, sepia `rgb(69,56,42)`, slate `rgb(203,211,217)`,
  trueblack `rgb(207,200,186)`, moonlit `rgb(245,232,200)`), and the five themes are genuinely
  distinct, so the pass is not vacuous. Rule counts 41/47/48 by mode prove book CSS was live.
  Book CSS cannot defeat the reader's chosen theme.
* **I8 TTS — holds.** 11 speech units extracted per section, identical unit count and identical first
  units in all three modes (rules 46/52/53). Book CSS does not change what gets spoken.
* **I10 endurance — holds.** 9 rounds, 171 operations, alternating 3 modes × 2 books, each round a
  full reopen plus highlight, note, bookmark, progress save, book-wide search, 3 TOC jumps and 10
  page turns. Open latency 5352 → 5351 ms (×1.00), DOM nodes 360 → 373 (×1.04), reader healthy at
  every sample, all annotation counts consistent.

##### I9 live mode switch — **INCONCLUSIVE (Unknown), impact nil today**

Flipping `book_css` four times with the book open left the reader perfectly healthy — and the rule
count sat at **53 the entire time**, so nothing had changed and the survival proved nothing. Measured
cause: `Reader.tsx:402` loads the mode once, BEFORE `ctrl.open()`; the sanitiser hook runs while the
book's resources load, so the value only takes effect on the next open. **There is no UI control for
`book_css` anywhere in the app** — that one load is its only consumer — so no reader can reach this
path today. Recorded, not fixed: if a control is ever added, it must reopen the book.

##### Not a defect — `highlight_create` deduplicates by CFI (Measured)

The first endurance run showed highlight counts that did not rise every round, which looked like
lost writes. Re-run recording the returned ids: rounds 0 and 2 used one CFI and both returned row
`d04e5a5b`; rounds 1/3/5/7 shared `2edd51a3`; rounds 4 and 6 had different CFIs and returned new ids
with the count rising. So creating a highlight where one already exists returns the existing row —
correct, and the reason the counts moved as they did. The harness assertion was wrong and is now
narrowed to the real defect condition: a **new** id that does not raise the count.

##### FINDING-11 · A settings change masqueraded as 64 rendering regressions — **fixed** (Measured)

The post-campaign byte-identity gate failed with 173 problems. The FINDING-2 dump made the diagnosis
a single command, and both causes were settings, not code — **no product code was modified in this
session at all**:

1. **`flowMode: scrolled → paged` — the harness leaked into the owner's REAL profile.** Caught by the
   existing CONFIG guard. Root cause, measured: neither the per-mode run nor the cross-mode run leaks
   in isolation — only **back-to-back** runs do. `restoreDb` verifies the instant the copy lands, so
   it cannot see a still-exiting app flushing its in-memory settings afterwards; the NEXT run then
   snapshots that re-corrupted state and restores it faithfully, laundering the corruption into "a
   verified restore" that survives forever. **Fixed on both sides:** `snapshotDb` now refuses to
   snapshot while any Sard process is alive, and `restoreDb` re-verifies after a 2 s settle and keeps
   the snapshot if the profile moved. Owner's `flowMode` restored to `scrolled`.
2. **`hide_chapter_titles` was missing from the fingerprint's config list.** It changes rendering —
   headings compute to `font-size: 0px` — but the hand-maintained key list did not record it, so the
   CONFIG guard stayed silent and 64 differences read as code regressions. Measured directly:
   flipping the flag removed **50 of the 64**. Added to the list. This is the second time that
   hand-maintained list has missed a rendering-affecting setting (`paragraphSpacing` was the first).

The harness self-test also failed, and that too was a **test defect**: it asserted
`hide_chapter_titles !== "1"`, which cannot distinguish "restored correctly" from "leaked" for an
owner whose real value IS 1 — as this one's is. It now captures the original and compares against it.
9/9 guarantees hold.

**Baseline status:** `wp7-stage3` was captured with `hide_chapter_titles = 0`; the owner's profile
now has `1`. The baseline is therefore stale with respect to the owner's own settings. With the key
added, this correctly reports as CONFIG drift rather than as regressions. **Re-baselining is the
owner's call** and has not been done.

##### ✅ UNKNOWN-2 CLOSED — references verified end to end

First, a correction to the earlier reading: `refs_for_book` returning 0 for every book is **expected,
not a defect**. References are USER-CREATED (a phrase plus a note, `ref_save`), not auto-extracted
footnotes — measured by reading the IPC surface and confirmed against all 20 library books.

Driven for real on a Latin and an Arabic book, in all three modes (`tests/harness/references.mjs`):
create → load → render → update → delete. Overlayer shapes **3→4** (Alice) and **0→1** (Karamazov)
when the reference exists, identical in off/sanitised/raw; re-save edits in place (same id, count
stays 1, note changes); delete leaves 0. Rule counts 44/83/91 and 45/51/52 prove non-vacuity.

*Harness defect found and fixed en route:* the first probe looked for matches in the **CSS Custom
Highlight registry**, which is empty in the section realm — references draw on the foliate
**overlayer**. It reported "reference stored but NOTHING rendered" for a reference that had drawn
correctly, and would have been filed as a product bug.

##### ✅ UNKNOWN-3 CLOSED — REAL read-aloud verified, all three modes

`tests/harness/tts-live.mjs`, Arabic book, Edge voice `ar-DZ-AminaNeural` (322 voices reachable, 32
Arabic). Identical in off / sanitised / raw — 30 sentences, 137 words, rules 45/51/52 (non-vacuous):

| behaviour | measured |
|---|---|
| playback starts | status → `playing`, no error, no voice-mismatch |
| speak-along sync | word cursor advances; spotlight **0 (idle) → 2 (playing)** on the overlayer |
| pause | index and word index FROZEN across a 2.2 s wait |
| resume | returns to `playing` |
| seek | `skip(+1)` 0→1, `skip(-1)` 1→0 |
| chapter change while speaking | no error state |
| long session | 20 s continuous, 0 underruns, 0 abandoned, no failure |
| stop cleanup | player inactive, spotlight removed |

*Two harness defects found and fixed en route, both of which produced a convincing false negative:*
driving `useTts.start()` with DOM-scraped sentences (the app starts via
`ctrl.getCurrentChapterSentences()`, and it is the controller's extraction that builds the
sentence→range mapping the spotlight needs — so there was nothing to highlight), and looking for
`.sard-reading` as a CSS class when it is an **overlayer key**. The harness now clicks the chrome's
own read-aloud button, which is the only version of this test worth believing.

##### ✅ UNKNOWN-4 CLOSED — the heap swing is GC timing, not a leak

Forcing a real collection through CDP `HeapProfiler.collectGarbage` before every sample removes the
timing term. Eight identical open→read→navigate cycles in `raw`: post-GC heap **5.86–5.94 MB**,
growth **−9.2 KB per cycle**, ratio 0.99, spread 0.08 MB, DOM nodes constant at 389, iframes 0 —
against the 7→50 MB swing seen when GC was not forced. Retained memory is flat.
##### ✅ UNKNOWN-1 CLOSED — every one of the 173 differences accounted for, **0 rendering differences remain**

Final compare with all three settings matched to the baseline: **`RENDERING differences (non-CONFIG): 0`**
across all 16 corpus books. The only two remaining lines are the CONFIG guard correctly reporting
`hide_chapter_titles: undefined → 0` and `hide_first_line: undefined → 0`, i.e. the baseline predates
those keys being recorded. **WP-7 introduced zero rendering regressions**, proven byte-for-byte.

The three causes, each measured, none of them a code change:

| cause | differences | evidence |
|---|---|---|
| `flowMode` leaked by the harness | 109 | CONFIG guard; fixed, see FINDING-11 |
| `hide_chapter_titles` (h1–h6) | 50 | flipping the flag removed exactly these |
| `hide_first_line` (RAWY-69) | 14 | winning rule chain, below |

**Root cause of the last 14, measured not inferred.** The winning rule on every affected element is
`:root:root .sard-chapter-heading:not(.sard-revealed)… { font-size: 0px !important }` — Sard's own
rule, from `HIDE_BOX_RULE`, gated by **`hideFirstLine`**, which is a *separate, independent toggle*
from `hideChapterTitles` (they hide different element sets and were deliberately split in RAWY-69).
Its persisted key is `hide_first_line`.

Two hypotheses were tested and **disproved** before this one:
* *"WP-7 stage 4's CSP change made Sard's stylesheet apply where it previously didn't."* **False** —
  the baseline records `fontFamily: "SardArabic, SardLatin, serif"`, `lineHeight: 33.6px` and the
  themed colour on those very elements, so Sard's injected CSS was already fully effective.
* *"The elements weren't tagged at baseline."* **False** — the baseline literally records
  `class="chnum sard-chapter-heading"` at `fontSize=16px`: tagged, and not hidden. The tagging was
  identical; only the toggle differed.

`hide_first_line` is now recorded in the fingerprint config, so this can never again read as a code
regression. The owner's real values (`hide_chapter_titles=1`, `hide_first_line=1`, `flowMode=scrolled`)
were restored afterwards. **The `wp7-stage3` baseline is stale with respect to those preferences** —
re-baselining remains the owner's call.
* **Heap growth in the ENDURANCE run: Unknown by that method** — `usedJSHeapSize` there is GC-timing
  dependent (×0.28 vs ×2.36 on identical workloads), so it is reported and never asserted on. The
  question itself is now settled separately by `heap.mjs` with forced GC — see UNKNOWN-4 above.

##### Harness defects found and fixed while doing this (none were Sard defects)

Recorded because a campaign that reports its own false alarms as product bugs is worse than no
campaign. Each was caught by measurement, not by reasoning.

1. **`flowMode: "paginated"` is not a legal value** — it is `"paged"`; `scrolledMode = flow !==
   "paged"`, so the invalid value silently left the renderer scrolled and the harness called it a
   product defect. The renderer ATTRIBUTE that results is `paginated`; the two vocabularies differ.
2. **A FATAL run printed a green tick** — `violations` was empty because nothing had run. A run that
   died now reports "NOTHING was verified" and returns non-zero.
3. **The `hostile-css` fixture has ONE paragraph** in its opening section and no occurrence of the
   search term, so the first run "passed" on 1 CFI and 0 hits. Replaced with real books.
4. **The overlayer is not in the section document** — it hangs off `contents[0].overlayer`. The
   original probe returned 0 whether an annotation drew or not, which would have made a real loss
   indistinguishable from success.
5. **`instanceof Range` fails across realms.** `resolveCFI` returns a Range belonging to the SECTION
   document's realm, so the check failed and I2 was reported as an unverified `null` twice before
   being resolved properly.
6. **Sard rewrites `file_path` on import**, so a corpus filename can never match afterwards; the
   book must be identified by the id the import result returns (usually `status: "duplicate"`).

#### PPC-2 — the safety net has only ever watched scrolled rendering *(awaiting decision)*

* **Claim tier: Measured** (the blind spot) / **Hypothesis** (what a paginated baseline would catch).
  See FINDING-10. Filed rather than acted on, because re-baselining changes the reference every
  remaining comparison in this campaign is measured against, and that is the owner's call.
* **Why it may matter more than task 4:** task 4 is the subsystem regression campaign, and every
  byte-identity check inside it would inherit the same blind spot. Running it first means running it
  against a net that cannot see column or page-count damage.
* **Impact if true:** WP-7's byte-identity sign-off is narrower than it reads — it says "no drift in
  scrolled mode", not "no drift". Pagination regressions of the NAV-1 class would pass silently.
* **Impact if false:** a second baseline that never diverges from the first; cost is one capture.
* **Cost to interrupt:** low. One `flowMode` switch and one `baseline --tag=wp7-paginated` run
  (~2 minutes), plus deciding whether compares should run both. It defers task 4, nothing else.
* **Status: NOT SCHEDULED.** Proceeding to task 4 in the owner's fixed order unless told otherwise.

#### CLOSED BY DESIGN — do not re-investigate

* **`background-color` overridden to transparent.** Established architectural rule: when an element
  or page carries a background IMAGE, `background-color` is intentionally ignored so the image
  renders. The measured `rgba(0,0,0,0)` across all three `book_css` modes is this rule working, NOT
  a sanitiser finding. Only reopen with evidence that the behaviour VIOLATES that rule.

#### What am I assuming that I have NOT measured?

1. **That `sanitised ≡ off` universally.** Measured on ~16 properties, ONE fixture, ONE section, one
   window size. Not measured: other elements, other sections, other books, other viewport widths.
2. **That inline `<style>` blocks are sanitised too.** `epub.js:857` routes them through
   `replaceCSS`, so the hook should apply — **Code-derived, never observed**. A book whose hostile CSS
   is inline rather than external may bypass the sanitiser entirely. **This is the highest-value
   unmeasured assumption in WP-7** and should be tested first.
3. **That the CSP change affects only stylesheets.** `blob:` in `style-src` — no measurement of
   whether anything else in the app relied on that directive.
4. **That mode switching is stateless.** Each measurement used a fresh launch; switching `book_css`
   with a book already open was never tested.

#### TASK 3 · FINDING-2 tooling — ✅ **DONE** (2026-08-05)

`dumpDiff()` in `tests/harness/byte-identity.mjs`, exported for the same reason `diff` is: a
detector nobody has watched fail is not a detector. A failing compare now writes, before printing:
every problem **unsliced** (the console still caps at 60 — that cap is how FINDING-2 was lost), both
sides of each affected book verbatim, both configs, both engines, both capture timestamps. The file
is **timestamped, never overwritten** — two intermittent failures are two pieces of evidence.
Unaffected books are omitted, or 3 real differences drown in 12 identical ones. It never throws;
losing the exit code to a disk error is worse than losing the dump.

* **Proven, not assumed.** 4 mutants introduced and each killed by exactly one test: truncate to 60
  → *keeps every problem* fails; fixed filename → *never overwrites* fails; keep all books → *omits
  books that did not differ* fails; disable the engine guard → both engine tests fail.
* **Proven live.** `compare --tag=nav-fix` produced 15 real differences and wrote
  `fingerprints/diff-nav-fix-*.json`; `compare --tag=wp7-stage3` reports byte-identical, so the pass
  path is unchanged. Dumps are gitignored (they name corpus books; this repo is public).

#### FINDING-9 · The harness could blame our code for a WebView2 update — **fixed** (Measured)

The very first dump exposed it. `nav-fix` was captured on **Chrome/150.0.0.0**; the 2026-08-05 run
ran on **Chrome/151.0.0.0**. `diff` recorded the engine in every capture and *never compared it* —
so 15 differences were presented as ours with no hint the renderer underneath had changed. The
config guard existed for precisely this class of error and the engine had no equivalent. `diff` now
emits `ENGINE … (WebView2 changed, not our code — re-baseline)`.

* **Scope of the damage: none.** The campaign's live baseline `wp7-stage3` and `track-1` were both
  captured on Chrome/151, the version running now — only the retired `nav-fix` predates the update.
  **No WP-7 conclusion rests on a cross-engine comparison.** Verified by reading all three baselines.
* The other two `nav-fix` differences are also explained and benign: the stylesheet inventory is the
  WP-7 change the owner accepted as a new baseline, and `txt-converted--daw-alkhalid.epub` is
  "present in only one capture" because it entered the corpus during TRACK-1, after `nav-fix`.

#### FINDING-10 · The byte-identity net has never once measured paginated rendering (Measured)

Read from `wp7-stage3.json`: **all 16 books have `flow: "scrolled"`, `columns: 0`** — because the
harness uses the REAL profile and the owner's `flowMode` is `scrolled`. So four of the properties
the fingerprint tracks (`columnWidth`, `columnGap`, `layout.columns`, `layout.pages`) are inert in
every capture ever taken, and the safety net's blind spot is decided by a personal setting.

Paginated is where CSS damage is worst — NAV-1 was a pagination failure, and a monolithic scroll
container cannot split across columns at all. *Hypothesis (well-founded, unmeasured):* a paginated
baseline would detect fragmentation regressions the scrolled one structurally cannot.

**Not acted on — this is a PPC, see below.** One book, `txt-converted--daw-alkhalid.epub`, also
contributes **0 sampled elements** (0 paragraphs across a very broad `p, h1–h6, li, blockquote, div`
selector) — 15 of 16 books are covered, that one only by section and TOC counts. Cause *Unknown*;
`pre`-wrapped text from the txt converter is a hypothesis, not a measurement.

#### What the sanitiser already survived (20/23 hostile cases)

`calc()` smuggling (`calc(100% - 80pt)`, `calc(0px - 80px)`) · property-name obfuscation (escapes,
encodings, zero-width chars — all fail closed, since only KEEP names survive) · parser confusion
(semicolons in strings, colons in `url()`, braces in attribute selectors, unterminated comments) ·
nested at-rules · pathological input (20 k rules in 84 ms, 500-deep nesting, a 200 KB value).

#### NOT yet exercised — the whole app-level surface, in priority order

1. **`raw` on `word-generated--a4`.** It SHOULD lose text — that book's `margin: 0 369pt 0 -84.8pt`
   is the entire rationale for the sanitiser. **If it does not, the rationale is wrong** and the
   design needs re-examining. Most informative single test remaining.
2. **`sanitised` across all 17 corpus books** — the first real exercise of RAWY-195's
   `markBookAlignedBlocks()`, which by construction has never run against a book stylesheet.
3. **CFI stability across a mode switch** — does a resume position survive `off → sanitised`? Book
   CSS changes layout, and Sard's position model assumes layout is stable.
4. **The subsystems, under `sanitised` and `raw`:** pagination · scrolled mode · RTL · themes ·
   fonts (incl. embedded) · line spacing · margins · images · TOC · search · references · highlights
   · notes · selection · TTS · resume · performance · memory.
5. **Book categories not yet differentiated:** EPUB2 vs EPUB3 · mixed RTL/LTR · very large vs very
   small · multiple external sheets · inline + external together · malformed archives.

#### Method that worked, and is worth repeating

Build the hostile input FIRST and assume the component is wrong. A passing test is unproven until it
has been seen to fail — mutate the product and confirm the gate catches it. `it.fails()` banks a
known defect without blocking the build, and turns red the moment someone fixes it.

**Shipping position:** WP-7 ships `book_css=off`, and byte-identity proves that path unchanged. It is
NOT ready for stage 7.2 (`sanitised` as default) until items 1–5 above are done.

---

### ⚠ HARNESS-1 · The verification infrastructure itself — ✅ **FIXED** (2026-08-05)

*Four independent profile leaks accumulated during this milestone. Fixed before WP-7, because WP-7's
entire safety case rests on byte-identity being believable without manual intervention.*

**One root cause, in one line.** `cdp.mjs`'s `close()` was `child.kill()` followed by a fixed 500 ms
sleep, and never confirmed the process had exited. A dying Sard still holds sqlite open, so every
restore raced a live writer. The measured damage: `flowMode` left paged, `hide_chapter_titles` left
on, `paragraphSpacing` 14 → 28, and `zoom`/`lineHeight` overwritten by a stray second instance.
Byte-identity duly reported **1,517 / 978 / 54** "rendering differences" that were none of them real.

**The fix.**
* `close()` waits for the OS to confirm the exit, escalates to a forced kill, then sweeps.
* `launchSard()` kills any pre-existing instance FIRST, so a run can never share the profile.
* `restoreDb()` now **verifies** by hashing `sard.db` + `-wal` against the snapshot before deleting
  it. A restore that silently did not land keeps the snapshot and says so loudly. Hashing the whole
  database needs no per-setting list — it cannot miss a field the way the fingerprint's `config:`
  line missed `paragraphSpacing`.

**`npm run harness:lifecycle` — the self-test, which asserts the guarantees by DOING the damage:**
it leaves a stray instance and checks the next launch clears it, changes two persisted settings
mid-run, and then reads them back through a fresh app. **9/9 guarantees hold.**

**Acceptance, measured:** the interaction harness (which forces paged mode — the worst offender) run
immediately before byte-identity, with **no reset of any kind** → `flowMode=scrolled`, byte-identical.
All three app-driving harnesses run back to back leave zero snapshots and zero processes.
`set-flow.mjs` is retired; `set-style.mjs` / `set-flag.mjs` remain only as emergency recovery tools
and are no longer part of any normal flow.

---

### WP-6 · TOC and spine recovery — ✅ **COMPLETE** (2026-08-05)

**6A — FINAL RULE (owner's decision, simpler than either earlier design):** *a section's own heading
if it has one, otherwise a NUMBER.* Sard never derives a label from a section's text. A title taken
from an opening sentence is indistinguishable to a reader from one the author wrote, and none exists
in these files — that is fabricated metadata, not recovery.

| book | Contents before | Contents after |
|---|---|---|
| `word-generated--a4.epub` | 1 row | **196 rows** — 195 use the book's own headings, 1 numbered |
| `word-generated--unknown-title.epub` | 1 row | **116 rows**, all numbered |

An untitled row reads **"Chapter N" / "الفصل ١"**, not "Section N". These are spine sections
internally, but the Contents panel is a NAVIGATION surface and "Chapter" is what a reader of a novel
expects. The label asserts nothing about the file — it never claims the book contained that title, it
names a place to go. `panel.chapter` already existed for exactly this row, so no key was added.

`a4` now shows `Chapter-734 0` — its own heading, artefact or not, because that is what the book
says. The reader can see it is poor; Sard does not pretend otherwise, and does not invent better.

**This DELETED code rather than adding it.** Gone: the generated-heading detector, its 0.9 threshold
(justified by n=1), the text-derived labels, the heading-prefix strip, and the `SynthSource` concept.
`tocSynth.ts` went from ~130 lines to ~65, its tests from 19 to 11, and the spine walk no longer
reads `textContent` at all — only each section's heading, which is a smaller walk as well as a smaller
idea. No new i18n key: `panel.tocSection` already existed and already meant this.

<details><summary>Superseded: the measured detector design (kept for the record)</summary> The detector fires on ONE measured signature: a
set of ≥8 headings where ≥90 % collapse to the SAME string once digits are replaced. `a4`'s 195
headings collapse to exactly one form (`"Chapter-# #"`), a dominance of 1.0. Alice's 12 real titles
collapse to 12 forms — a dominance of 1/12 — so a genuine chapter list cannot be reached. No language,
wording or content is ever inspected; the test is structural, on the SET.

| book | Contents before | Contents after |
|---|---|---|
| `word-generated--a4.epub` | **1 row** | **196 rows**, labelled from text (headings rejected) |
| `word-generated--unknown-title.epub` | **1 row** | **107 rows** (the 9 empty sections skipped, not blank rows) |

**One thing the end-to-end run caught that the unit tests could not.** The rejected heading is also
the first thing in its own section's text, so every synthesised label OPENED with the exact string
the detector had just declared meaningless. Fixed by dropping that prefix — by exact match on the
heading read from the same section, never by pattern, and only when the headings were rejected. The
one section that genuinely has no heading keeps its text untouched, which is why row 1 of `a4` still
reads `Chapter-733 0 …`: there was nothing to reject there.

</details>

**Verification.** `npm test` **245/245** · `cargo test` 109/109 · clippy 15 = baseline · corpus 17/17
· byte-identity identical to `track-1` · `harness:tts` clean · both books re-measured in the running
app through the RENDERED Contents panel, not through the module.

#### ⚠ Two harness incidents during this package — both touched the owner's profile

1. **A stray Sard process survived a run**, so two instances held the same database and the second
   wrote its stale in-memory reading style over the first. Measured damage: `zoom` 2 → 2.5,
   `lineHeight` 2.1 → 2.6, `paragraphSpacing` 14 → 28 — the owner's real typography. Byte-identity
   reported 1,517 "rendering differences" that were none of them real. **Its `config:` line named the
   true cause in two lines**, which is precisely why that capture was added in WP-1. All three values
   restored and byte-identity is clean; `tests/harness/set-style.mjs` now restores any named field.
2. **The fingerprint's config capture is incomplete.** `paragraphSpacing` is not in it, so that third
   drift showed up only as 978 per-book differences with no explanation. Worth adding — a drift the
   config line cannot name is a drift that looks like a regression.

Together with the `flowMode` leak already logged, this is now **three** ways an app-driving harness
can corrupt the profile it borrows. **Recommend fixing the harness lifecycle before WP-7**, whose
entire safety case rests on byte-identity being trustworthy.

**One flaky Rust test observed.** A single run reported `108 passed; 1 failed`; four subsequent runs
all passed 109/109 and the failing test name was not captured. Most likely the WP-2 import tests,
which share `%TEMP%` paths keyed by fixture hash. Recorded rather than dismissed — not yet diagnosed.

---

#### Findings from the measurement (kept — this is why the design changed)
*Item 2 — the structural half.*

**Measured first** (`tests/harness/toc-shape.mjs`, flags read from the real database, heading counts
read through foliate's own `createDocument()` — the same call in-book search uses):

| book | spine | TOC | degenerate | fragmented | headings |
|---|---|---|---|---|---|
| `word-generated--a4.epub` | 196 | **1** | YES | no | **195 of 196** |
| `word-generated--unknown-title.epub` | 116 | **1** | YES | **YES** | **0** (107 text-only, 9 empty) |
| every other book (14) | — | — | no | no | — |

**✅ 6B shipped.** A fragmented spine now defaults that book to scrolled flow. It is a DEFAULT, not a
lock — it applies only when the book has no saved flow of its own, so choosing paged sticks for ever,
and the global preference is never touched. Exactly one corpus book qualifies. The 1433-section
Calibre book is deliberately not caught: the flag tests the MEDIAN SECTION SIZE, not the count, so a
long book with real chapters is untouched.

**⚠ 6A — the measurement contradicts the plan's premise, and raises a question the plan did not.**

The plan states: *"Prefer real headings — one pass over the spine taking the first h1–h6 per linear
section. **On the Word book this yields nothing**, which is itself the signal to fall back."*

That is true of ONE of the two flagged books and false of the other:

* `unknown-title` has **0** headings → tier 2, exactly as predicted.
* `a4` has **195 of 196** → tier 1 fires. But its headings are machine junk:
  `Chapter-734 0`, `Chapter-735 0` — an auto-numbered artefact of the converter, carrying no
  information about the content. Its section TEXT, by contrast, is real:
  `الناري التنين فارس : بيرسيرك…`

So "prefer headings" would give this book 195 rows of `Chapter-N 0` — navigable, but meaningless —
when the fallback tier would give 195 rows of actual opening text. **Following the approved rule
produces the worse result for the book that has headings.**

Options, for a decision rather than a silent choice:
1. **Follow the plan as written** — headings always win. Predictable; gives `a4` junk labels.
2. **Prefer headings unless they look auto-generated** — e.g. a run of near-identical labels
   differing only by a number. Better output, but a heuristic, and heuristics on book content are
   what WP-2 spent its effort removing.
3. **Prefer whichever yields more DISTINCT labels** — measurable, no content heuristic: `a4`'s
   headings are distinct but uninformative, so this would still pick them. Honest but ineffective here.

Recommendation: **option 2, narrowly scoped** — treat headings as auto-generated only when they are
identical after stripping digits, which is precisely the `Chapter-N 0` shape and cannot match a real
chapter title set. Implementation is NOT started pending this decision.

---

#### Original plan

| | |
|---|---|
| **Addresses** | Broken TOC · NCX fallback · spine fallback · pagination robustness |
| **Risk** | **Medium** — changes what the Contents panel shows |
| **Depends on** | **WP-2** (the flags) |
| **Effort** | Medium |

**6A · Synthesised contents when `toc_degenerate`.** foliate's chain is nav → NCX → *stop*
(`epub.js:1001-1016`); there is no spine fallback anywhere. Add one, reader-side:

1. **Prefer real headings** — one pass over the spine taking the first `h1`–`h6` per linear section.
   On the Word book this yields nothing, which is itself the signal to fall back.
2. **Fall back to section labels** — the first ~40 characters of each section's text. That turns one
   useless row into a usable 115-entry index.
3. **Say so.** Panel header: *"Contents generated by Sard — this book has none."* Never present a
   guess as the book's own.

This also repairs the downstream damage: the chapter label in both bars, `chapters_read` markers, TTS
chapter names and search's "you are here" are all currently pinned to `"Start"` for the entire book.

**6B · Fragmented-spine handling.** Ship the cheap, honest half now: when `spine_fragmented` is set,
**default that book to scrolled flow**, where 115 arbitrary page breaks are invisible. One line, and
it makes the reported book readable immediately. It is a per-book default, so the user can still
choose paged.

**"Continuous pages"** — suppressing the page break at a section boundary that is not a plausible
chapter start — is the real fix, but foliate paginates strictly per section and `expand()` pads every
section to a whole page (`paginator.js:381`). **Scope it as its own ticket after this milestone**, with
measurement. Do not attempt it here.

**Verification.** Automated: synthesis tests per fixture; a test that a **good** TOC is never
replaced or relabelled. Manual: §III C1–C5.

---

### WP-7 · CSS compatibility
*Item 2 — the rendering half. **Last, and deliberately so.***

| | |
|---|---|
| **Addresses** | Book stylesheets never entering the cascade · layout recovery · hostile converted CSS |
| **Risk** | **HIGH — the highest in the milestone** |
| **Depends on** | WP-0 (harness) · WP-2 (`producer`) · WP-6 (`spine_fragmented`) |
| **Effort** | Large |

**The finding.** Measured in headless Chromium against Sard's exact CSP and iframe model: **no EPUB's
external stylesheet has ever entered the cascade**, and the sole cause is that `style-src` in
`tauri.conf.json:23` omits `blob:`. The sandbox is irrelevant (variant **c** confirms). This is one
token — and it is the most dangerous token in the milestone, because it changes rendering for
**100 % of books at once**.

**The staged rollout — the core of this package's safety.**

The CSP is baked into the binary and **cannot be toggled at runtime**, so config rollback would
require a release. The design therefore puts the decision in a **runtime setting**, not in the CSP:

| Stage | CSP | `book_css` setting | Effect |
|---|---|---|---|
| **7.1** — ships in this milestone | `style-src … blob:` **added** | **`off`** (default) | Sanitiser strips *everything* from the book sheet. **Byte-identical to v1.1.0 for every book.** |
| **7.2** — a later release, on field evidence | unchanged | `sanitised` default for non-flagged producers | Books get their own typography back |
| **7.3** — opt-in only | unchanged | `raw` | Power users / debugging |

So the risky capability ships **inert**, behind a setting that can be flipped per book or globally,
and rolled back without a release. That is the difference between a staged rollout and a gamble.

**7A · The sanitiser** (`src/reader-engine/cssSanitiser.ts`), applied where `epub.js:864-874
replaceCSS()` already rewrites the sheet:

| Keep | Neutralise | Why |
|---|---|---|
| `font-style`, `font-variant`, `font-weight`, `text-transform`, `text-decoration`, non-body `color` | — | Emphasis and voice — what is being lost today |
| `text-align` (already guarded by `markBookAlignedBlocks`) | — | Poems, scene breaks |
| Relative `font-size` (`em`, `%`, `rem`) | Absolute `font-size` (`pt`, `px`) | Absolute sizes fight the reader's zoom |
| `%`/`em` margins and indents | **`pt`/`cm`/`in` margins and padding, and all negative margins** | The actual danger — see below |
| — | `position: absolute/fixed`, `float`, `width`/`height` on block containers | Escapes the column |
| — | `@page`, `column-*`, `page-break-*` overrides | foliate owns pagination |
| — | container `background-color` (already neutralised by `themeBlock`) | Theme integrity |

**Why the absolute-margin rule is not negotiable.** The Word/Calibre book carries
`margin: 0 369pt 0 -84.8pt` — Word's fixed A4 geometry translated literally. In a 600 px column that
leaves ~100 px of measure, and the negative left margin pushes content **outside** the column box,
where foliate's `overflow: hidden` (`paginator.js:333`) **silently clips it away**. Enabling the CSP
without this rule would convert a cosmetic complaint into **data loss**. Hence the ordering, and hence
`off` as the shipping default.

**7B · The unexercised groundwork.** RAWY-195 hardened every typography control and added
`markBookAlignedBlocks()` *specifically* so book CSS entering the cascade would not flatten the book's
own intent. **That machinery has never run against a real book stylesheet** — by construction, since
none has ever loaded. WP-7 is its first real test, and it must be verified against at least: Alice
(Latin, poetry), الشوقيات (Arabic verse, 141 sections), لورد الغوامض (1,433 sections,
`body{text-align:right!important}`), Monte Cristo, and the Word/Calibre book.

**Verification.** Automated: the WP-0 byte-identity harness must show **zero** diffs at stage 7.1 —
this is the gate; the sanitiser's property tests (a declaration in the keep list survives, one in the
neutralise list does not); a regression test that no negative or `pt` margin ever reaches the frame.
Manual: §III S1–S6, and the full 13-book visual sweep at both `off` and `sanitised`.

---

## Part III — Dependencies, order, verification

### III.1 Dependency graph

```
                        WP-0  Test & measurement scaffolding
                          │        (soft prerequisite for all; hard for WP-7)
        ┌─────────────────┼──────────────────┬───────────────────┐
        ▼                 ▼                  ▼                   ▼
   WP-1 Failure      WP-2 Import        WP-4 Reading UI     WP-5 TTS language
      surface        compatibility      (items 3 + 4)        (item 7)
   (items 1,5,6)      (item 2a)                                  │
        │                 │                                      │
        │        ┌────────┴────────┐                             │
        │        ▼                 ▼                             │
        │   WP-3 Metadata     WP-6 TOC & spine                   │
        │   single source      recovery (item 2b)                │
        │      (item 8)             │                            │
        └─────────┬─────────────────┘                            │
                  ▼                                              │
             WP-7 CSS compatibility  ◄──────────────────────────┘
                (item 2c) — LAST, ships inert
```

**Hard edges (must not be reordered)**

| Edge | Why |
|---|---|
| WP-2 → WP-3 | The resolver has nothing authoritative to return until recovery exists. |
| WP-2 → WP-6 | The flags are computed at import. |
| WP-0 → WP-7 | Without the byte-identity harness, "no regression" on a 100 %-of-books change is an assertion. |
| WP-6 → WP-7 | `spine_fragmented` conditions the sanitiser's per-producer default. |
| **everything → WP-7** | A rendering change this broad must land on a codebase whose other faults are already fixed and whose failures are already explainable — otherwise every field report becomes ambiguous. |

**Deliberately independent (parallelisable)**

- **WP-5 (TTS)** shares no file with any other package. Start it day one.
- **WP-4 (Reading UI)** and **WP-2 (Rust import)** touch disjoint trees — front-end vs `src-tauri` —
  and can run concurrently.
- **WP-1** touches `Reader.tsx` only in the `catch` block; **WP-4** owns the rest of the file. Land
  WP-1 first so WP-4 rebases onto it, not the reverse.

### III.2 Implementation order

| # | Package | Rationale for this slot |
|---|---|---|
| **1** | **WP-0** | Everything after it is measurable instead of asserted. |
| **2** | **WP-1** | **Highest harm ÷ cost in the milestone.** Fixes the reported P0 crash *and* makes every later package diagnosable in the field. Additive, low risk. |
| **3** | **WP-2** | Pure Rust, no render path, richly unit-testable. Unblocks two packages. |
| **4** | **WP-4** *(‖ with 3)* | Deterministic bugs affecting every book in page mode by default. Disjoint tree from WP-2. |
| **5** | **WP-5** *(‖ with 3–4)* | Independent subsystem; can land whenever it is ready. |
| **6** | **WP-3** | Small; needs WP-2. |
| **7** | **WP-6** | Needs WP-2. Changes what Contents shows — wants a settled reader beneath it. |
| **8** | **WP-7** | Last. Ships **inert** (`book_css: off`). Enabling it is a *separate decision on field evidence*, not part of this milestone. |

**Two suggested release boundaries**, so testers get value early and the risk is not one lump:

- **v1.2.0 — "You can always tell what happened."** WP-0, WP-1, WP-4, WP-5.
  Every reported UI and error defect is fixed; nothing about book parsing has changed.
- **v1.3.0 — "Sard reads imperfect books."** WP-2, WP-3, WP-6, WP-7 (inert).
  All parsing/recovery lands together, so a field regression has one obvious suspect release.

### III.3 Regression risks, ranked

| # | Risk | Package | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| 1 | **The CSP change alters rendering for all 13 good books** | WP-7 | High if enabled | **Severe** | Ships with `book_css: off` → byte-identical. Byte-identity harness is the merge gate. Enabling is a separate release decision. |
| 2 | **The sanitiser clips content** (negative/`pt` margins) | WP-7 | Medium | **Severe (data loss)** | Explicit neutralise rules; a regression test asserting no negative or `pt` margin reaches the frame; per-book toggle. |
| 3 | **Turn coalescing double-turns or drops a turn** | WP-4E | Medium | High | Depth-1 only, never a queue. Tests: two rapid turns → exactly two pages; a turn during a section load → exactly one. Vendored-engine patch → `VENDOR.txt`. |
| 4 | **Parent-window key ownership breaks TTS sentence-skip or Space** | WP-4C | Medium | High | `arrowCb`/`spaceCb` precedence is preserved verbatim; a key-routing matrix test covering TTS-active × TTS-idle × each focus state. |
| 5 | **The metadata ladder overrides a title a user already fixed** | WP-2C/2H | Low | High | `metadata_overrides` is untouched by construction (RAWY-189 precedent); an explicit preservation test. |
| 6 | **The backfill flips a correctly-tagged good book** | WP-2H | Low | High | Scoped `UPDATE`, idempotent, provenance recorded; the 13-book no-change row test. |
| 7 | **The pre-flight blocks a legitimate voice** (Multilingual, dialect, unlabelled locale) | WP-5A | Medium | Medium | "Use it anyway" always present; Multilingual detection reuses the picker's existing rule; the outcome matrix includes no-locale voices. |
| 8 | **Synthesised TOC replaces a real one** | WP-6A | Low | Medium | Gated strictly on `toc_degenerate`; an explicit "a good TOC is never touched" test. |
| 9 | **The z-layer refactor shuffles unrelated overlays** | WP-4A | Medium | Medium | Token values chosen to reproduce today's computed order exactly; a stacking-order snapshot before/after; visual sweep of all 16 themes. |
| 10 | **Scrolled-flow default surprises a paged-mode user** | WP-6B | Medium | Low | Per-book default only, user-overridable, applied at first open of a flagged book — never to a book the user has already configured. |
| 11 | **Error classification hides a real bug behind a friendly message** | WP-1A | Medium | Medium | Unmapped → `internal`, which shows *Details* and keeps the raw text. Never map by guessing. |
| 12 | **The runtime gate false-negatives and blocks a working install** | WP-1B | Low | High | Feature probes, not version strings. `pdf` failure is non-fatal — EPUB reading continues. |
| 13 | **Encoding fallback mis-decodes a valid UTF-8 OPF** | WP-2A | Low | Medium | Strict UTF-8 attempted first; fallbacks only on decode failure; the 13-book no-change test. |
| 14 | **i18n merge conflicts** across packages | all | High | Low | Append-only, one block per package, no reordering — stated in the file-ownership table. |

### III.4 Automated tests

**New infrastructure (WP-0):** vitest, a fixture generator, the byte-identity harness, the CSP harness.

| Layer | Coverage |
|---|---|
| **Rust unit** (extends the 27 existing) | Metadata ladder incl. every placeholder; BOM/compressed/missing mimetype; UTF-16 + cp1256 OPF; missing `<metadata>`; producer detection; `toc_degenerate` / `spine_fragmented` thresholds; backfill idempotence; **override preservation**; **13-book row-identity** |
| **TS unit** | `classifyOpenError` over every known throwable incl. the reported string; "only `internal` shows raw"; runtime probes with globals stubbed; the TTS compatibility matrix; "mismatch never enters the ladder"; `bookMeta` ≡ `library_list_books`; TOC synthesis + "good TOC untouched"; sanitiser keep/neutralise properties |
| **DOM / harness** | Chevron ∩ panel = ∅ in all four {EN,AR}×{LTR,RTL}; key routing per focus state; turn coalescing; `location.current` monotonicity; **byte-identity across all 13 books** |
| **Build gate** | `npm test` in `build:test`; `cargo test` + `cargo clippy --all-targets`; `npm run corpus:verify`; **the byte-identity harness is a required merge gate for WP-4 and WP-7** |

**Working discipline for the whole milestone** (owner's direction, binding):

- One work package at a time; comprehensive verification before starting the next.
- A package is not complete until **its own tests pass** and the corpus sweep (§0.4) is clean.
- Every fixed bug gets a regression test wherever practical, so it cannot silently return.
- Compiling is not evidence of correctness. Test normal cases, edge cases, malformed books, invalid
  input, **and previously working behaviour**.
- Backward compatibility is preserved at every step.
- If implementation shows the architecture or the plan must change significantly: **stop, document,
  and get approval** before expanding or altering scope.

### III.5 Manual test scenarios

*Run each against the full 14-book corpus unless noted. **Every scenario has an implicit control: the
13 well-formed books must behave exactly as they did in v1.1.0.***

**Import (I)**
- **I1** Import the Word/Calibre EPUB → title is not "Unknown"; author is not "word"; provenance is shown as a guess.
- **I2** Import a BOM'd `mimetype` fixture → succeeds (fails today).
- **I3** Import a cp1256 OPF fixture → title, author *and* RTL are all correct.
- **I4** Import a truncated zip → *"This file is damaged"*, filename named, reason behind **Details**.
- **I5** Import a `.txt` renamed `.epub` → unsupported, named, with the reason.
- **I6** Import a folder mixing good, duplicate and broken files → a per-file list, not one count.
- **I7** Re-import an existing book → still reports duplicate; no row churn.
- **I8** Correct a title, then restart → the correction survives the backfill.

**Errors & runtime (E, R)**
- **E1** Open a PDF on a WebView2 < 140 VM → the `runtime` card with *Update WebView2*, **not** *Try again*, and no raw text.
- **E2** Same VM, EPUB → **opens normally** (the PDF gate must not block EPUB).
- **E3** A VM below Chromium 117 → the blocking startup notice.
- **E4** Delete a managed file, then open → `missing-file`, offering removal.
- **E5** An OPF with no `<metadata>` → `compat`, not a raw `TypeError`.
- **E6** Force an unmapped throwable → `internal`, with *Details* carrying the raw text and a copy button.
- **R1–R3** Probe matrix: both pass / `pdf` fails / `epub` fails.

**Navigation & position (N, P)**
- **N1** Page mode, Contents open (default) → **both chevrons visible and clickable.**
- **N2** Open Notes → the right chevron stays visible and clickable.
- **N3** Open the settings drawer → same.
- **N4** Open a book, press → immediately, **without clicking the text** → the page turns.
- **N5** Click a toolbar button, then press → → the page turns.
- **N6** Open Contents → click a chapter → press → → the page turns.
- **N7** Click the desk margin, then press → → the page turns.
- **N8** Click a chevron 5× rapidly on the fragmented book → exactly 5 pages, in-flight state visible, none silently dropped.
- **P1** EPUB → a location readout is always visible and advances monotonically.
- **P2** Change font size / margins / page width / flow → **the location number does not change.**
- **P3** Resize the window → unchanged.
- **P4** A book with a real `page-list` → labelled "page", not "location".
- **N/P (RTL)** Repeat N1–N3 and P1 in an Arabic UI on an Arabic book — panel sides are physical and must not mirror.

**Read-aloud (T)**
- **T1** Arabic book + English Edge voice → **immediate** explanation, **zero** retry attempts, **no** audio dispatched.
- **T2** Same, choose *"Choose an Arabic voice"* → picker opens on the Arabic section; playback then works.
- **T3** Same, choose *"Use it anyway"* → it proceeds; the choice is remembered for that voice.
- **T4** Arabic book + Multilingual voice → **no warning**, plays normally (must not regress RAWY-197).
- **T5** Arabic book + Arabic voice → byte-identical to today.
- **T6** Pull the network mid-chapter → the **existing** `edge-error` path, ladder unchanged — the new class must not have absorbed it.
- **T7** Arabic book + English **Piper** voice → caught by the pre-flight (today it emits gibberish with no error).

**Contents & metadata (C, M)**
- **C1** The Word book → a usable generated contents list, labelled as generated.
- **C2** A well-formed book → its own TOC, **unchanged and unlabelled**.
- **C3** A nested TOC → nesting preserved.
- **C4** A book with no TOC at all → generated list or the honest empty state.
- **C5** The Word book → chapter labels in both bars are no longer "Start" everywhere.
- **M1** Rename a book in the library → the **reader header** shows the new title.
- **M2** Same book → a **photo card** carries the new title and author.
- **M3** Same book → **Inbox** and **Bookmarks shelf** agree.
- **M4** A book with no override → all five surfaces show the same extracted value.

**Book CSS (S) — WP-7 only**
- **S1** Every one of the 13 good books at `book_css: off` → **byte-identical** to v1.1.0.
- **S2** Alice at `sanitised` → poem centring survives; the reader's alignment control still works.
- **S3** الشوقيات at `sanitised` → verse layout intact.
- **S4** لورد الغوامض at `sanitised` → `body{text-align:right!important}` does not defeat the alignment control.
- **S5** The Word book at `sanitised` → **no clipped text**; the 369pt/−84.8pt margins are neutralised.
- **S6** Toggle `off → sanitised → raw → off` on one book → returns to the exact starting render.

### III.6 Rollback strategy

Per package, because the whole point of the split is that any one can be reverted alone.

| Package | Mechanism | Cost | Notes |
|---|---|---|---|
| **WP-0** | Revert | None | No product code. |
| **WP-1** | Revert | Low | Purely additive; reverting restores today's raw-string behaviour. |
| **WP-2** | **Cannot drop migration 0015** — the project invariant is that a shipped migration is never edited. Rollback = **stop reading the columns**; they stay, unused and nullable. | Low | Recovered values live in `books`, so a revert leaves recovered titles in place — which is *desirable*. `metadata_overrides` is untouched throughout. |
| **WP-3** | Revert two read sites | Low | Reverts to `ctrl.title`. No data written. |
| **WP-4** | Revert per sub-item: 4A/4B (CSS) and 4F (readout) are independent of 4C/4D (focus) and 4E (engine patch) | Low-medium | **Keep 4E in its own commit** so the vendored-engine patch can be reverted alone. |
| **WP-5** | Kill switch: a setting disabling the pre-flight, restoring today's ladder behaviour exactly | Low | The ladder is never modified, so there is nothing to restore. |
| **WP-6** | Setting: disable TOC synthesis and the scrolled default | Low | Synthesis is render-time; no stored TOC to unwind. |
| **WP-7** | **`book_css: off`** — already the shipping default | **None** | The whole design exists so that the CSP token can ship without the behaviour. A field problem is fixed by a setting, not a release. |

**Milestone-level rollback.** The two release boundaries (§III.2) are the coarse lever: v1.2.0 changes
no book parsing at all, so a v1.3.0 field regression has exactly one suspect release and one obvious
revert target.

### III.7 Open questions and required measurements

These are **not** blockers for planning, but each must be closed before the package that depends on it.

| ID | Question | Blocks | How to close |
|---|---|---|---|
| **M1** | What exactly does the Edge endpoint return for a locale/script mismatch — empty audio, an explicit rejection, or a 4xx? | **WP-5B only** (5A is unaffected) | One live synthesis with a known-incompatible pair, capturing the raw frames. |
| **M2** | Which WebView2 version was the tester on? | Nothing — it confirms the diagnosis | Ask the tester for `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}\pv`. |
| **M3** | What does one section boundary crossing actually cost (iframe teardown + Sard's five DOM passes)? | Sizes WP-4E's lock window; informs the "continuous pages" follow-up | CDP timing over the fragmented book vs a normal one. |
| **M4** | Does Tauri 2's NSIS `webviewInstallMode` offer an *upgrade* mode, or only install-if-absent? | WP-1B's installer half (the runtime gate itself is unaffected) | Read the Tauri 2 bundler config schema. |
| **M5** | What placeholder strings do Sigil, Pages, Vellum and Google Docs emit? | Widens WP-2C beyond Calibre | Sample a wider corpus than these 14 books. |

### III.8 Vault records to update on completion

- **`OPEN.md:444`** — the recorded diagnosis of the stylesheet defect attributes it to the iframe's
  opaque origin. **Measured false** (§WP-7): the sandbox is irrelevant; `style-src` missing `blob:`
  is the sole cause. Correct the entry rather than deleting it — the measurement it carries is still
  good, only the mechanism was wrong.
- **`LESSONS.md:295`** — same correction, plus a new lesson: *a vendored engine's browser-capability
  floor is part of the pin. Re-derive it on any re-vendor.*
- **`VENDOR.txt`** — record the two Chromium floors (117 EPUB / 140 PDF) and, after WP-4E, the fourth
  local engine patch.
- **`DECISIONS.md`** — three new decisions worth naming: *the database is the single source of truth
  for book metadata* (WP-3); *position is reported as locations, never as synthetic pages* (WP-4F);
  *book CSS is sanitised, never trusted, and ships disabled* (WP-7).
