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

## Database migrations

**Number a new migration with a UTC timestamp. Never with the next integer.**

```bash
date -u +%Y%m%d%H%M%S          # e.g. 20260816112700
```

Name the file after it and register it in `MIGRATIONS`:

```
src-tauri/src/db/migrations_sql/20260816112700_add_shelf_colour.sql
```

Why: branches are developed in parallel, and two of them reaching for "the next number" both reach
for the same one. That already happened — two branches took `17`, and on every database that had seen
the other branch the second feature's table was never created. Nothing reported it, because a skipped
migration and an applied one leave identical evidence behind: none. A timestamp cannot collide with a
number chosen on another branch, in another worktree, by someone you never spoke to.

UTC, not local time — local time repeats an hour every autumn and disagrees between contributors.

**Versions 1–19 predate this and keep their numbers forever.** They have run on real databases;
renumbering one changes what an upgrade does, retroactively. A test pins them.

### Migrations may run out of order — so each one must stand alone

A migration is applied when its version is **absent** from `schema_migrations`, not when it is newer
than everything applied. That is what makes two branches safe in either merge order: each migration
applies on its own account, and nothing ever needs renumbering.

The price is one rule: **a migration must not assume that a lower-numbered migration has already
run.** A database that took your branch's migration will later apply a lower-numbered one from
someone else's. Migrations from independent branches touch independent tables, which is what makes
this work in practice — but it is a rule, not a coincidence.

Never edit a migration that has shipped. Append a new one.

### What CI will not let you get away with

`cargo test` runs on every pull request, on Windows and Linux, and fails on:

- **a duplicate version** — the collision above, caught the moment both branches are in one tree;
- **a version above 19 that is not a valid UTC timestamp**;
- **a shipped version that has been renumbered or removed**;
- **a `.sql` file nobody registered**, or an entry with no file;
- **any change to how migrations are selected** that would re-run, skip, or reorder them — including
  a database whose highest recorded version came from another branch.

The full reasoning, and the reason `PRAGMA user_version` carries a count rather than a version
number, is at the top of `src-tauri/src/db/migrations.rs`.

## `private/` — local only

`private/` is a personal workspace for internal material: notes, investigations, evidence, local tools.

**It never leaves your machine.** It is not committed, not pushed, not included in a pull request, and
never appears in a branch, a snapshot or a release. It is covered by `.gitignore`, and the production
gates reject it independently — so a file force-added from it still cannot be published.

Do not reference anything under `private/` from public code or documentation.

## Getting started

See [`BUILD.md`](../BUILD.md) for prerequisites and how to build. `npm test` runs the unit suite;
`npm run build` type-checks and bundles the frontend.
