# Sard — development workflow

How work moves from an idea to a release. Read this before opening a pull request.

```
feature/*  or  fix/*  ──PR──▶  develop  ──release process──▶  main  ──tag──▶  release
```

## Branches

| Branch | Purpose |
|---|---|
| `main` | **Production.** The code users run. Protected. Only a release reaches it |
| `develop` | **Integration.** The latest finished development state. Protected; changes arrive by pull request |
| `feature/*` | A new feature, branched from `develop` — e.g. `feature/book-backgrounds` |
| `fix/*` | A bug fix, branched from `develop` — e.g. `fix/tts-playback-gap` |

Other short-lived branches are fine when they suit the work. Everything branches from `develop` and
returns to `develop` through a pull request.

**Never commit directly to `main` or `develop`.**

## Day to day

```
git switch develop
git pull
git switch -c feature/your-change

# …implement, test, commit locally…

git push origin feature/your-change     # only when finished — see below
# open a pull request into develop
```

CI must pass before a pull request merges. Delete the branch once it has.

## Publish a branch only when the work is finished

**A branch is pushed when the work is done — not to store it remotely.** Push it when:

- the implementation is complete and actually works;
- it is tested;
- known issues are fixed, or written down deliberately;
- it is ready for someone else to read.

Local commits are the place for work in progress. An unfinished branch on the remote invites review of
something that is not ready and turns the remote into a backup drive.

**Test it the way CI will run it, not only the way it runs on your machine.** A clean checkout has no
generated fixtures, a fixed Node version, and none of the local state you may have accumulated. A green
local run is not evidence about a clean runner.

## Releases

`main` is **not** a merge target. It is a *published snapshot*: the release takes `develop`'s tree,
removes everything that is not part of the shipped application, and commits that result. Git cannot
express this as a merge — a merge would carry the whole development tree across — so a release is never
a `develop` → `main` pull request.

The order is fixed, and nothing is published before it completes:

1. **Generate** the production snapshot from `develop`.
2. **Audit** it — no development-only paths, no internal content.
3. **Build** that same snapshot.
4. **Verify the artifact** — identity, version, build id, no diagnostic traces.
5. **Publish**, then tag.

The tree that is audited, the tree that is built and the tree that ships are the same tree. A release is
never published before its artifact has been verified.

## What `main` must never contain

Development-only material of any kind: diagnostic instrumentation, investigation tooling, internal
reports and plans, development scripts, or anything else not required to build and run Sard. Two
automated gates enforce this — one over file paths, one over file contents — and either failing blocks
the release.

## `private/` — local only

`private/` is a personal workspace for internal material: notes, investigations, evidence, local tools.

**It never leaves your machine.** It is not committed, not pushed, not included in a pull request, and
never appears in a branch, a snapshot or a release. It is covered by `.gitignore`, and the production
gates reject it independently — so a file force-added from it still cannot be published.

Do not reference anything under `private/` from public code or documentation.

## Getting started

See [`BUILD.md`](../BUILD.md) for prerequisites and how to build. `npm test` runs the unit suite;
`npm run build` type-checks and bundles the frontend.
