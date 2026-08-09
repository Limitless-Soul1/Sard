# Tests

Two layers, with different jobs.

## `tests/unit/` — the unit suite

```
npm test        # typechecks tests/, then runs the suite
```

Pure modules, no DOM, no application launch. Fast enough to run on every change. This is what CI runs
on every pull request, and what must be green before anything merges.

Real DOM and layout questions are deliberately **not** answered here. jsdom and happy-dom approximate
Chromium, and a test that passes against the approximation tells you nothing about WebView2 — the
engine Sard actually renders in. Where a claim needs a real browser, it is verified against the real
application instead, outside this suite.

## `tests/fixtures/` — generated EPUBs

```
npm run fixtures:build
```

Each fixture reproduces one specific defect: a damaged archive, a chapter with no block container,
hostile CSS, a degenerate table of contents. The **generator is the source of truth and is committed**;
the `.epub` files it produces are not, so the repository carries no opaque binary test blobs. CI builds
them before running the suite, and you should too after a clean checkout.

A fixture is only useful while it still reproduces its defect, so several tests assert the *shape* of
the fixture itself — that the no-block-container book really has no block containers, and that a
control book still does. Without that, a fixture can drift into ordinary markup and silently stop
covering anything.

## Writing a test

- Assert behaviour, not implementation. A test that mirrors the code it covers fails to catch the bug
  it was written for.
- Prove the test can fail. A check that passes against a deliberately broken input is worth more than
  one that has only ever been green.
- Keep it independent of the machine it runs on: no absolute paths, no assumptions about local state.
  A clean checkout has none of what your working copy has accumulated.
