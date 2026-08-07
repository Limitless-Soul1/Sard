# Sard tests

Introduced by **WP-0 of the RESILIENCE-1 milestone** — see [`../REMEDIATION_PLAN.md`](../REMEDIATION_PLAN.md).

Before WP-0 the repository had no JavaScript test runner at all: automated coverage was 27 Rust
`#[test]`s, while roughly 70 % of the milestone is front-end, including its two riskiest changes.
This directory is the safety net that makes "preserving existing behaviour for valid books" a check
rather than a claim.

---

## Layout

```
tests/
  lib/epub-read.mjs        an INDEPENDENT EPUB structure reader (see "independence" below)
  fixtures/
    generate.mjs           builds 16 synthetic EPUBs, each isolating ONE defect
    fixtures.test.ts       proves each fixture carries its defect — and nothing else
    epub/                  generated output (git-ignored)
  corpus/
    corpus.manifest.json   the permanent regression corpus DEFINITION (committed)
    corpus-lib.mjs         shared plumbing
    build-manifest.mjs     re-measure the real books and rewrite the manifest
    verify.mjs             integrity + trait check
    corpus.test.ts         corpus definition + file checks
    README.md              why the books are not in this repository
  harness/
    cdp.mjs                minimal CDP client — drives the REAL Sard binary
    byte-identity.mjs      render fingerprints: baseline / compare
    csp.mjs                the book-stylesheet / CSP experiment, as a runnable check
    harness.test.ts        tests for the harnesses themselves
    fingerprints/          captured baselines (committed — they are the evidence)
```

---

## Commands

| Command | Cost | What it proves |
|---|---|---|
| `npm test` | ~0.6 s | Unit + fixture + corpus-definition suite. Runs in `npm run build:test`. |
| `npm run fixtures:build` | instant | Rebuild the generated fixtures. |
| `npm run corpus:verify` | ~1 s | The corpus files are intact and the measuring reader has not drifted. |
| `npm run corpus:build-manifest` | ~1 s | Re-measure the corpus after adding a book. |
| `npm run harness:csp` | ~10 s | The book-stylesheet finding still holds in a real Chromium. |
| `node tests/harness/byte-identity.mjs baseline --tag=NAME` | ~3 min | Record how Sard renders every corpus book. |
| `node tests/harness/byte-identity.mjs compare --tag=NAME` | ~3 min | **Sard's rendering is unchanged.** The merge gate for WP-4 and WP-7. |

---

## Three layers, three different guarantees

Do not read any one of them as "no regression". They cover different things and each has an owner.

| Layer | Proves | Owner |
|---|---|---|
| `npm test` + `npm run corpus:verify` | Defects are handled; the corpus and its measuring instrument are stable | WP-0 |
| `byte-identity.mjs compare` | **Sard's rendering** of each real book is unchanged | WP-0 |
| Rust corpus tests over the real importer | **Sard's import** of each real book is unchanged | **WP-2** |

---

## Independence

`lib/epub-read.mjs` deliberately shares no code with Sard's Rust parser or with foliate. If the
measuring instrument reused the thing being measured, a regression could reproduce itself in the
measurement and vanish.

The cost is that a Sard-side parser change is invisible to `corpus:verify` alone — traits are a pure
function of *(bytes, reader)*, and the hash already pins the bytes, so a trait diff can only mean the
*reader* changed. That is worth catching (it happened twice while the reader was being written), but
it is not evidence about the product. The other two layers are.

---

## Two traps worth knowing before you use these

**1. `document.styleSheets` cannot tell you whether book CSS applied.** Measured on the v1.1.0
baseline: every corpus book's external `<link>` stylesheets *are* present in `document.styleSheets`
— Alice 3, the Word book 2, matching each book's file count — while none of their rules reach
computed style. The sheet objects load and are inert. So the sheet list looks identical before and
after WP-7's CSP change. **The computed-style sample is the gate**, and `harness.test.ts` pins this
so nobody "verifies" WP-7 by counting sheets.

**2. The byte-identity harness drives the real profile.** Tauri resolves app data from the bundle
identifier with no environment override, so there is no isolated profile to point it at. Opening a
book writes reading progress, `last_opened_at`, `seen_start` and `chapters_read`. The harness
therefore snapshots `sard.db` (+ `-wal`/`-shm`) before it starts and restores it on **every** exit
path — the project's existing `.db-snapshot-*` convention, already covered by `.gitignore`. That
restore is also what makes the fingerprint deterministic: each run starts from the same resume
positions, so the same sections are sampled.

---

## Adding a test

- **A defect that can be described in a file** → a fixture in `fixtures/generate.mjs`, with a
  `proves` line naming the defect and its work package, plus an entry in the `ISOLATION` table so
  the self-test knows exactly how it differs from the control.
- **A defect that only real books exhibit** → a corpus book (see `corpus/README.md`).
- **Pure logic** (error classification, the TTS language matrix, the metadata resolver) → a
  `*.test.ts` beside the code it covers.
- **Layout, cascade or pagination** → the harness. jsdom cannot answer those questions, and a test
  that pretends otherwise is worse than no test.
