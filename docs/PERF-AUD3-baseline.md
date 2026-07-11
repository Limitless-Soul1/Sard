# AUD-3 performance baseline (PERF-01)

Before-baseline for the Reader re-render cost (AUDIT-01 finding **AUD-3**), so the fix can be measured
against real numbers. Captured 2026-07-11 on the release test build (`build:test`, current code) with a
**temporary, reverted** in-app harness (React render counting via a `useLayoutEffect` commit timer + a
`PerformanceObserver` for `longtask`), driven on the owner's real library. CDP was unavailable (WebView2
runtime 150 disabled the remote-debugging port), so this replaced it. The harness is **not shipped** —
only this results file is committed.

Machine: Windows 10 19045; WebView2 150.0.4078.65; production build (StrictMode does **not** double
renders in prod). Books: `cd27ab1d4b` (لورد الغوامض / Lord of Mysteries, ~1,300-chapter EPUB, 10.3 MB,
the worst case) vs `b976d473e7` (Alice, 0.2 MB, ~12-chapter TOC). Contents panel mounted throughout.

## Measurements

| Scenario | Book (TOC rows) | Reader re-renders/sec | ms/commit p50 | p95 | max | longtasks (n / total ms / max ms) | render time / window |
|---|---|---|---|---|---|---|---|
| **TTS word-cadence (Edge)** | Alice (~12) | **3.6** | 0.6 | 0.9 | 1.4 | 0 / 0 / 0 | 67 ms / 30 s |
| TTS (Piper) | Big novel (~1300) | (8 commits)¹ | **5.3** | 9.3 | 9.4 | 1 / 73 / 73 | 46 ms / 30 s |
| TTS (Edge, errored @ idx 2) | Big novel (~1300) | (8 commits)¹ | 4.4 | 7.2 | 7.4 | 0 / 0 / 0 | 38 ms / 30 s |
| Search "the" | Alice (~12) | (8 commits)² | 2.2 | 5.3 | 5.3 | 2 / 1829 / 1757 | 19 ms / 25 s |
| **Search "كان" (common)** | Big novel (~1300) | **7.6** | **31.6** | **51.6** | 72.5 | **113 / 6863 / 108** | **10,772 ms / 45 s** |

¹ TTS produced only ~8 commits in the window (Edge errored on that chapter's Arabic; Piper's sentence
cadence is slow to start) — enough to read the per-commit cost, not the sustained frequency. TTS's
re-render *frequency* is book-independent (word cadence ≈ 3.6/sec, from Alice).
² Alice's search finishes almost instantly (small book), so few commits.

Method note: the per-subtree "reader" vs "toc" buckets came out ~identical because the `useLayoutEffect`
timing spans the whole commit, not just one subtree — so the TOC's share is isolated by the **big-novel-
vs-Alice delta** in full-commit ms during **TTS** (no search-results confound), not by nested buckets.
All numbers are real captures; frequency/counts are exact, ms/commit is the true commit duration.

## AUD-3 before-baseline

- **TTS word cadence: ~3.6 full-Reader re-renders/sec**, each **~0.6 ms** (Alice's tiny TOC) up to **~5 ms**
  (the 1,300-row TOC). **No longtasks, no dropped frames** — the TTS churn is *wasteful* (the whole Reader,
  including the unvirtualized 1,300-row Contents list, re-renders on every spoken word even though the TOC
  didn't change) but **not perceptibly janky** (each commit is well under the 16.7 ms frame budget).
- **Streaming search on the big novel: ~7.6 re-renders/sec at ~31.6 ms p50 / ~51.6 ms p95 per commit,
  113 longtasks (6.9 s) over the 45 s scan** — the Reader spends **~24 % of the whole-book search re-rendering**,
  and **every batch render blows the 16.7 ms frame budget** → sustained dropped frames. **This is the worst
  AUD-3 offender by far.**
- **TOC contribution (isolated via the TTS delta): the ~1,300-row unvirtualized Contents list adds ~4–5 ms
  per Reader re-render** (big novel ~5 ms vs Alice ~0.6 ms → ~7–8× costlier). During search this compounds
  with the **unbounded, growing search-results list** (AUDIT-01 **AUD-8**): the big-novel search commit of
  ~31.6 ms ≈ ~5 ms TOC + ~26 ms results-list (Alice's search commit was ~2 ms with few hits).

## Worst offenders (ranked by user-visible impact)

1. **Whole-book streaming search** — 31.6 ms p50 × 7.6/sec, 113 longtasks. AUD-3 (TOC) **+ AUD-8**
   (unbounded results) compounding. Sustained, visible jank during a search of the 1,300-chapter novel.
2. **TTS re-render churn** — 3.6/sec full-Reader re-renders (incl. the 1,300-row TOC) per spoken word.
   Wasteful CPU, but under frame budget → not the jank users feel. Lower priority.

## NOT actually a problem (don't over-fix)

- TTS on a small book (Alice: 0.6 ms/commit, 0 longtasks) — a non-issue.
- Even on the big novel, TTS re-renders stay ~5 ms (< frame budget) — so AUD-3's *TTS* path isn't the
  felt-jank source. **Search is.** Fix search first.

## What the AUD-3 fix should move (targets)

- Memoize (`React.memo`) and/or **virtualize** the 1,300-row Contents list → the ~5 ms TOC cost drops
  toward Alice's ~0.6 ms per commit, removed from **both** TTS and search.
- Cap/virtualize the streaming search results (**AUD-8**) → the big-novel search commit drops from
  ~31.6 ms toward ~5 ms.
- Drive the TTS word pill imperatively (don't re-render the whole Reader per word) → 3.6/sec → ~0.
- **Success target:** big-novel search p50 ms/commit **31.6 → ~2–5 ms** (Alice-like), **longtasks 113 → ~0**;
  TTS re-renders/sec **3.6 → ~0** of the Reader tree.
