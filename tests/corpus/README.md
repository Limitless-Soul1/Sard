# The Sard Regression Corpus

A **permanent, fixed set of real books** that every change to importing, rendering, pagination,
metadata, navigation, TTS or reader interaction must be verified against.

It complements the generated fixtures in [`../fixtures/`](../fixtures/); it does not replace them.

| | Generated fixtures | Regression corpus |
|---|---|---|
| **Made of** | Synthetic EPUBs, one defect each | Real books |
| **Answers** | "Is *this specific defect* handled?" | "Did anything else break?" |
| **Lives** | In the repo (as a generator) | **Outside the repo** — see below |
| **Membership** | Grows with each defect found | **Permanent.** Books are added, never removed |

---

## Why the books are not in this repository

The repository is **public** and **AGPL-3.0**. Most corpus books are **third-party copyrighted
works**, and the set is tens of megabytes. Committing them would be a licensing violation and a
repository-hygiene one — `.gitignore` already carries explicit rules against committing user data,
and this is the same class of material.

So the corpus is split:

- **In the repo** — `corpus.manifest.json`: for each book, its slot tags, SHA-256, and the
  structural traits measured at admission. Reviewable, diffable, and small.
- **Outside the repo** — the book files, at `%SARD_CORPUS%` (default `M:\ProjectDocs\sard\Corpus\`),
  the same convention the engineering vault already uses for `DB-Snapshots` and `Evidence`.

A machine without the corpus gets a clear **skip**, never a false pass.

---

## The manifest is an assertion, not an index

Each entry records the traits the book had when it was admitted — spine count, TOC entries and
source, declared language and direction, Arabic-script ratio, EPUB version, stylesheet count.

`npm run corpus:verify` checks:

1. **Integrity** — every file is present and its SHA-256 is unchanged. The corpus is immutable; a
   changed file is a corruption, not an update.
2. **Traits** — re-measured with `../lib/epub-read.mjs` and compared against the manifest.

### Be precise about what each layer proves

It would be easy to over-read check (2). Traits are a pure function of *(bytes, reader)*, and the
hash already pins the bytes — so a trait diff can only mean **the reader changed**. That is worth
having (the reader was corrected twice while it was being written, and both corrections silently
altered recorded traits), but it is **not** evidence about Sard.

The measuring reader is deliberately **independent** of Sard's Rust parser and of foliate's. If the
instrument reused the thing being measured, a regression could reproduce itself in the measurement
and vanish. The cost of that independence is that `corpus:verify` alone cannot see a Sard-side
change. Three layers cover it, and each has a different owner:

| Layer | Proves | Owned by |
|---|---|---|
| `npm run corpus:verify` | The corpus files are intact and the measuring instrument has not drifted | WP-0 |
| `npm run harness:fingerprint` | **Sard's rendering** of each book is unchanged | WP-0 |
| Rust corpus tests over the real importer | **Sard's import** of each book is unchanged | **WP-2** (part of its definition of done) |

Do not treat a green `corpus:verify` as "no regression". It is the first of three gates.

---

## Usage

```bash
npm run corpus:verify          # integrity + trait check; exits non-zero on drift
npm run corpus:build-manifest  # re-measure and rewrite the manifest (curated tags preserved)
```

Point at a different corpus location with `SARD_CORPUS=/path/to/corpus`.

### Adding a book

1. Copy it into the corpus directory with a descriptive `<primary-tag>--<slug>` filename.
2. `npm run corpus:build-manifest` — it will refuse until the new file has tags.
3. Add its `tags` to the manifest entry and re-run.
4. Commit the manifest change **with a note on what coverage the book adds.**

### Removing a book

Don't. The corpus is permanent: a book that was once worth testing against still is. If a book is
genuinely unusable (corrupt beyond the point of being a useful `corrupt` fixture), mark it
`"retired": true` with a reason rather than deleting the entry, so the history stays legible.

---

## Coverage slots

`corpus:verify` reports any slot with no book in it. Open gaps are listed in the manifest's
`gaps` field, with what is needed to close them.
