# Sard — development workflow

> **Starting a new session?** Read `docs/engineering/PROJECT_HANDOFF.md` first. It is the
> authoritative entry point: current state, what is proven and unproven, the open blocker, and the
> exact next action. This document assumes you already know *what* is being worked on and covers only
> *how the repository is operated*.

**This document owns: branches, merge policy, build kinds, packaging and release.**
`docs/engineering/HANDBOOK.md` owns how work is done — investigation, evidence, verification,
harness design, decision boundaries and post-mortems.
`docs/engineering/PROJECT_HANDOFF.md` owns project state, subsystem status and open issues.
Nothing is stated in more than one of the three.

This is the permanent process for this repository. It exists because of a real incident, described
at the end, and every rule here is a response to something that actually went wrong rather than a
convention borrowed from elsewhere.

Two branches, one direction of travel: work happens on `develop`, and only completed, reviewed,
cleaned and explicitly approved work moves to `main`. Two repositories, one direction of travel: the
private one is where the project lives, the public one is where releases go.

---

## Repository architecture

> **FINAL — settled 2026-08-07.** This architecture does not change unless the owner explicitly
> decides to change it. It is not a default to be improved on, and it is not revisited because a
> different arrangement would be marginally more convenient on some particular day.

**The private repository is the source of truth. The public repository is a distribution channel.**

| | Repository | Visibility | Holds | Role |
|---|---|---|---|---|
| `private` | `Limitless-Soul1/Sard-develop` | **PRIVATE** | `develop` **and** `main` | **Primary.** All engineering work |
| `origin` | `Limitless-Soul1/Sard` | **PUBLIC** | `main` only | **Distribution.** Released code + GitHub Releases |

Everything lives in the private repository: `develop`, the engineering documents, diagnostics,
harnesses, investigation notes, checkpoints, packaging scripts and internal tools. `main` is mirrored
there too, so the private repository is a complete record and the public one is never needed to
reconstruct anything.

The public repository receives **only** production snapshots of `main`, and only through the release
pipeline below. Nothing else is ever pushed to it.

### Working in this model

```
git push                     # from develop -> private/develop   (tracked; no flags needed)
npm run release:to-main      # dry run: build main from develop, minus development-only files
npm run release:to-main -- --commit
git push private main        # record the snapshot in the source of truth
git push origin main         # publish it
```

### Why it cannot go wrong by accident

- **`remote.origin.push` is pinned** to `refs/heads/main:refs/heads/main` — a bare push to the public
  remote can only ever move `main`.
- **A `pre-push` hook refuses any ref but `main` to the public URL**, catching the explicit
  `git push origin develop` that would override the pinned refspec. Verified: it refuses.
- **The release excludes development-only paths by construction**, not by anyone remembering to
  delete them.
- **CI refuses** to release from a ref that is not on `main`, or from a tree containing
  development-only files.

The hook is in `.git/hooks/` and is **not** version-controlled — git cannot share hooks. On a fresh
clone, re-create it and re-pin the refspec before doing any work. The CI guards travel with the
repository; the local ones do not.

---

## `main` — the production branch

**Rules**

- Production only. This is the branch the public sees and the only branch a release is ever cut from.
- Always buildable, always releasable. If `main` is broken, the project is broken.
- Contains no diagnostic code, no instrumentation, no experiments, no temporary utilities and no
  working notes.
- Nothing lands here except by an explicitly approved merge (see [Merging into `main`](#merging-into-main)).
- Never committed to directly. Not for a typo, not for a one-line fix, not "just this once" — the
  exceptions are how a branch stops being trustworthy.

**What being "clean" buys.** `main` is the answer to the question *"what is actually in the build our
users are running?"* That question has to have a cheap, reliable answer. It stops having one the
moment `main` contains anything that is not in the product.

---

## The branch workflow

```
feature/*  or  fix/*  ──PR──▶  develop  ──release process──▶  main  ──tag──▶  CI  ──▶  release
```

**Never work directly on `main`. Never work directly on `develop` either** — day-to-day work happens on
short-lived branches taken from `develop`.

| Branch | Purpose |
|---|---|
| `main` | **Production.** The version users run. Protected. Only an approved release reaches it |
| `develop` | **Integration.** The latest finished development state. Protected; changes arrive by pull request |
| `feature/*` | A new feature, branched from `develop` — e.g. `feature/book-backgrounds` |
| `fix/*` | A bug fix, branched from `develop` — e.g. `fix/tts-playback-gap` |

Other short-lived branches are fine when they suit the work, but everything branches from `develop` and
returns to `develop` through a pull request.

### The daily routine

```
git switch develop
git pull                            # start from the latest develop, always
git switch -c feature/book-backgrounds
# …implement, test, commit locally…
git push private feature/book-backgrounds     # ONLY when finished — see below
# open a pull request into develop, let the checks run, review, merge
git branch -d feature/book-backgrounds        # delete once merged
```

### ⚠ A branch is published only when the work is FINISHED

**Do not push a development branch to save unfinished work remotely.** A branch is published when, and
only when:

- the implementation is complete;
- the intended functionality actually works;
- it has been tested — and tested the way CI will run it, not only the way it runs here;
- known issues are fixed, or written down deliberately;
- it is genuinely ready for someone to review.

An unfinished branch on the remote invites review of work that is not ready, and turns the remote into
a backup drive rather than a record of finished work. Local commits are the place for work in progress;
they cost nothing and lose nothing.

**"Tested" means tested against the conditions CI uses.** Four consecutive CI failures on this project
were all the same shape — a clean checkout lacked something this machine happened to have: generated
fixtures, Node 22, LF line endings, a corpus directory. A green local run is not evidence about a clean
runner. Reproduce the runner's conditions before pushing.

### The one step that is not a merge

**A release is NOT a `develop` → `main` pull request.** `main` is a *published snapshot*, not a merge
target: it carries 693 files where `develop` carries ~900, and one of them (`package.json`) has its
contents rewritten. Git cannot express that — a merge would add every excluded file, and
`.gitattributes merge=ours` does not help, because a file that exists on `develop` and never existed on
`main` is not a conflict at all. Git simply adds it.

So the release runs the release process instead, which generates the snapshot, audits it, builds that
same tree, and only then moves `main`. Pushing an annotated `vX.Y.Z` tag is what triggers CI — merging
into `main` does nothing, because the workflow fires on `push: tags: v*`.

Two consequences worth stating, because both look like sensible settings and both break things:

- **Do not enable "Require a pull request before merging" on `main`.** It blocks the direct push the
  release performs. *"Block force pushes"* is the protection to enable — it enforces the no-rewrite rule
  and does not interfere.
- **Do not change the public repository's default branch.** `develop` does not exist there, and both the
  pinned refspec and the `pre-push` hook refuse to put it there.

---

## `private/` — the local internal workspace

**Local only. Never committed, never pushed, never published, never packaged.**

One clearly identifiable root for everything internal, organised by purpose, so *"is this internal?"* is
answered by where a file sits rather than judged one file at a time. Loose internal documents at the
repository root are how material gets published by accident: each one looks harmless on its own.

```
private/
├── reports/          investigation reports, studies, audits
├── plans/            roadmaps, stage plans, status summaries
├── checkpoints/      session checkpoints and handoff snapshots
├── diagnostics/      diagnostic packaging notes, tester instructions
├── investigations/   work in progress on an open question
├── notes/            personal development notes
├── tools/            local utilities with no role in the build
├── scripts/          local scripts, likewise
├── evidence/         captured measurements, logs, before/after records
├── scratch/          genuinely throwaway working material
├── AI_DEVELOPMENT_STATUS.md
└── README.md
```

Nothing here is part of the product, and none of it may reach a public repository or a release artifact.

### `AI_DEVELOPMENT_STATUS.md`

A **compact** handoff so a new session can pick the work up without reading hundreds of files: current
branch and state, what was just finished, what is next, known issues and blockers, and the constraints
that must be understood before changing anything.

Keep it short and keep it current. It is a pointer, not a report — the moment it starts duplicating
`PROJECT_HANDOFF.md` or the vault it has failed at its one job, which is to be cheap to read. Update it
as work progresses; do not let it grow.

**It is local-only, exactly like everything else here** — never committed, pushed, referenced from
public documentation, or copied out of `private/`.

**The boundary is enforced twice, and the second one is not redundant:**

1. `.gitignore` ignores `/private/`, so nothing in it is ever committed.
2. `production-tree-rules.mjs` excludes `^private/` from any published snapshot, and the
   production-content gate scans the generated tree.

An ignore rule protects only what has not been added yet. A force-add, a stale index, or an edit to that
one line would slip straight past it — and the release consults the gates, not `.gitignore`. **The ignore
rule is an additional local boundary, never a replacement for the production gates.**

⚠ **`private/` is not backed up.** No history, no remote copy. Anything that would hurt to lose belongs
in the documentation vault at `M:\ProjectDocs\sard\`.

**What deliberately stays in the tracked tree**, because the build, the test run or CI resolves it by
path: `tests/`, `scripts/`, `docs/engineering/`, `src/lib/diag*.ts`, `src-tauri/src/diag_startup.rs` and
the `*_tests.rs` modules. All of it is already excluded from `main` by the production-tree rules, so it
is private where it counts — it never reaches the public repository or a release artifact.

---

## `develop` — the daily development branch

**All implementation work lands here, through the feature branches above.** Specifically:

| | |
|---|---|
| New features | Diagnostics and instrumentation |
| Bug fixes | Investigation tools and test harnesses |
| Refactoring | Packaging scripts and temporary utilities |
| Experiments and spikes | Internal documentation and working notes |

Nothing is developed directly on `main` — not a feature, not a fix, not a typo.

**Rules**

- May contain unfinished work. That is what it is for.
- May contain temporary tools, scratch files and notes that will never reach `main`.
- **Holds `WORKFLOW.md` permanently.** This document lives here, on the branch we work on, so it is
  always to hand and always current — and it is never merged into `main`.
- Does not need to be releasable at any given moment.
- **Is never released from.** CI refuses to build a release from any ref that is not on `main`.
- **Is never pushed to the public `origin`.** It lives in the private repository — see
  [Repository architecture](#repository-architecture).

### `develop` is PROTECTED — no direct work, no direct pushes

**Working directly on `develop` is prohibited. Pushing directly to `develop` is prohibited.** Every
change arrives through a pull request from a short-lived `feature/*` or `fix/*` branch, and there is no
exception for a small fix, a typo, or a change that is "obviously safe" — those are how a branch stops
being trustworthy, and the rule exists precisely because they always look reasonable at the time.

Enforced on the **private** repository (`Limitless-Soul1/Sard-develop`), which is the only place
`develop` exists:

| Setting | State |
|---|---|
| Direct pushes | **blocked** — a pull request is required |
| Force pushes | **blocked** |
| Branch deletion | **blocked** |
| Required status check | **`verify`** (`.github/workflows/pr-checks.yml`) must pass before merging |
| Stale approvals dismissed on new commits | **on** |
| Administrators | **not exempt** — the protection cannot be bypassed by the normal workflow |

The required check runs the typecheck, the unit suite, and the production-tree, production-content and
production-build gates against the snapshot the pull request would produce. Running the release gates
per pull request is deliberate: a contaminating change otherwise sits on `develop` until a release is
cut and is found with a release in flight, rather than in the one small diff that caused it.

⚠ **`main` is protected separately**, and differently. It takes *"block force pushes"* only — **not**
"require a pull request", which would block the direct push the release process performs. See
[The branch workflow](#the-branch-workflow).

Working freely here is the point. The safety does not come from being careful on `develop`; it comes
from the gate in front of `main`.

---

## Merging into `main`

### Cadence: one cleanup, not many

**We do not merge continuously.** There is no per-feature merge, no "small safe one to keep the
branches close", no merging just because something happens to be finished. `develop` runs ahead of
`main` for as long as it takes.

The sequence is:

1. Keep fixing the remaining issues on `develop`.
2. Keep building new features on `develop`.
3. Keep using every diagnostic tool, harness and throwaway utility on `develop`, freely.
4. **Then, and only when the owner decides the application is complete enough:**
   - clean the repository,
   - move the reusable internal tools out into the separate toolbox,
   - remove the temporary artifacts,
   - review everything,
   - merge `develop` → `main`,
   - publish.

**One comprehensive cleanup instead of repeated cleanups after every feature.** That is a deliberate
choice with a real trade-off, and the trade-off is worth stating so nobody re-litigates it later:

- **The cost.** The gap between the branches grows, and the eventual cleanup is one large piece of
  work rather than many small ones.
- **What is bought.** Cleaning after every feature means either doing the cleanup badly, many times,
  or letting the cleanup pressure shape the development work itself — which is how diagnostic tooling
  starts getting written to be *presentable* rather than to be *useful*. The laboratory only works if
  nothing in it has to be tidy. Meanwhile `main` is not degraded by waiting: it sits at a known-good
  released commit the entire time.

There is no risk of drift in the meantime, because `main` is not being touched. It is exactly the
tree v1.1.0 was built from until the day we replace it wholesale.

### Cleanup is a milestone, not a habit

**Until the owner declares Feature Freeze, the answer to "should we clean this up?" is NO.**

While the laboratory is active, do not:

- make the repository look clean,
- move tools out to the toolbox,
- remove investigation artifacts,
- reorganise folders for aesthetics,
- optimise anything for a future merge.

`develop` is **allowed to be messy while it is being worked in, and that is expected, not tolerated.**
A stray probe script, a directory of captured logs, a Markdown file that was useful for one afternoon
— none of these are debts. They are what an active investigation looks like.

The priority is always improving the product. Repository hygiene performed early is work done twice:
once now, and again at the real cleanup, because the tree will have moved. Worse, it is work done
*instead of* the product, and it feels productive while it is happening, which is what makes it worth
a written rule rather than good intentions.

**This applies to me as much as to you.** If I ever find myself thinking "this should probably be
tidied first", the default is to leave it and say nothing. The one exception is a mess that is
actively costing us — a harness that corrupts a profile, a file that breaks a build, a name collision
that misleads a person. That is not hygiene, it is a defect, and defects are product work.

Declaring **Feature Freeze** is what switches the priorities. Only then: finish the last fixes, stop
adding features, clean the repository, move the reusable tools to the external toolbox, remove the
temporary artifacts, review everything, merge to `main`, build and publish.

### The five conditions

When that day comes, the merge happens only when **all five** are true:

1. **The work is complete.** Not "working", not "nearly there" — finished.
2. **Testing is finished.** Unit suite, typecheck, and the relevant harnesses have been run and pass.
3. **The repository has been cleaned.** The checklist below has been worked through.
4. **The owner has reviewed it.**
5. **The owner has explicitly approved publishing.** Approval to merge and approval to release are
   the same decision here and are given in words, not inferred from silence or from earlier approval
   of something related.

### The pre-merge cleanup checklist

Work through this in order. Anything that cannot be ticked blocks the merge.

- [ ] **Clean the repository.** No stray build output, no scratch directories, no half-finished files.
- [ ] **Move the reusable internal tools out into the separate toolbox.** Anything worth keeping —
      the CDP harnesses, the probes, the packaging helpers, the profile snapshot/restore — leaves the
      product repository and goes to the toolbox, a repository of its own. It is *moved*, not deleted:
      these tools took real work and will be needed again the next time something cannot be reproduced
      on a development machine. Anything not worth moving is deleted outright.
      The sorting test is: *would a stranger cloning this repo to read books be confused by this file?*
      If yes, it is not product — move it or delete it, but do not merge it.
- [ ] **Remove temporary investigation files.** Probe scripts, one-off measurement harnesses,
      captured logs, sample outputs.
- [ ] **Remove development-only documentation.** Investigation reports, checkpoints, remediation
      plans, study documents, diagnostic guides — and **this file**. Anything with lasting value moves
      to the docs vault or stays on `develop`; none of it goes to `main`. See
      [What never crosses into `main`](#what-never-crosses-into-main).
- [ ] **Run the production-tree check**, which decides the two items above for you:
      ```
      node scripts/check-production-tree.mjs
      ```
      It must print `This tree is fit for main.` It is the same check CI runs before a release.
- [ ] **Verify the release build contains no diagnostic functionality:**
      ```
      npm run build:release      # builds, then runs the gate
      # or, against an existing build:
      npm run verify:release
      ```
      This must print `VERIFIED: this artifact is PUBLIC RELEASE`. It reads the executable's PE
      version resource and searches the binary and the web bundle for instrumentation markers. It is
      not advisory — a failure means the artifact may not be packaged, uploaded or shared.
- [ ] **Verify the repository is production-ready.** `npx tsc --noEmit`, `npm test`, and the harnesses
      relevant to what changed. A green suite on `develop` is not evidence about the *cleaned* tree —
      re-run after cleaning, because cleaning is itself a change.

### What never crosses into `main`

`develop` is the laboratory. `main` is the product users receive. These stay behind, permanently:

| | |
|---|---|
| **`WORKFLOW.md` — this document** | Internal documentation of any kind |
| Investigation reports and studies | Checkpoints and status notes |
| Diagnostic instrumentation | Diagnostic guides and tester instructions |
| Investigation harnesses | Packaging utilities for non-release builds |
| Temporary utilities and scratch tooling | Any development-only asset that is not part of the released application |

**`WORKFLOW.md` lives on `develop` and is never merged into `main`.** It is a working document for
the two of us, kept on the branch we work on so it is always at hand and always current. Production
carries only what belongs in the released project, and internal process documentation is not that.

The rule is executable, in `scripts/check-production-tree.mjs`, so it cannot quietly rot into a
suggestion. It lists every excluded path **with the reason it is excluded**, because an exclusion
whose reason is lost is one that eventually gets overridden by someone acting in good faith.

**It draws one distinction carefully, and that distinction matters more than the list.** "Mentions
diagnostics" is not "is diagnostics":

| Stays on `main` — production | Never reaches `main` — development |
|---|---|
| `src/lib/diagOff.ts` — the no-op stub a release build compiles **against**; remove it and the release build fails to resolve its imports | `src/lib/diag.ts`, `pdfDiag.ts`, `renderDiag.ts`, `stageLedger.ts` — the instrumentation itself |
| `scripts/verify-artifact.mjs`, `scripts/build-identity.mjs` — CI runs these against every published artifact; they are what **proves** there is no instrumentation | `src-tauri/src/diag_startup.rs`, `src-tauri/tauri.diag.conf.json` — the diagnostic build's code and identity |

A rule that deletes the safety equipment along with the hazard is not a safety rule.

**One open question for the first real merge:** `tests/harness/` is excluded (investigation harnesses;
the reusable ones belong in the external toolkit), but `main` currently carries **no tests at all** —
not the unit suite either. That matches the exclusion as written and matches `main` today, so nothing
changes by default. Whether a public repository should ship its unit tests is a product decision, not
a cleanup decision, and it is yours to make when the first merge comes.

### What CI enforces on its own

The checklist above is human discipline. These are the parts a machine refuses to let past, in
`.github/workflows/release.yml`:

- **Releases come from `main` only.** For a tag, the workflow resolves the tag to its commit and
  requires `main` to actually contain it — a tag's *name* proves nothing about where it points.
- **A tree containing development-only files is refused** before anything is built — the same
  `scripts/check-production-tree.mjs` run listed in the checklist, so the pre-merge check and the
  pre-release check cannot drift apart.
- **The `diag` Cargo feature must not be on by default**, or every build would be a diagnostic build.
- **The finished artifact is verified** by `scripts/verify-artifact.mjs` before it can be published.

---

## The engineering handbook

`docs/engineering/HANDBOOK.md` is the single source of truth for **how work is done** — investigation
method, evidence tiers, verification, harness design, decision boundaries, post-mortems, and the
classes of mistake that have recurred here. This file covers branches, builds and release; the
handbook covers thinking.

**It must be kept current.** Whenever a workflow rule is agreed, a mistake reveals a *class* of
mistake, or a decision is made that would otherwise be re-litigated, update it in the same change that
established it — not later. A lesson recorded a week after it was learned is a lesson already half
lost, and one recorded nowhere is one the project pays for twice.

Where a rule can be enforced rather than described, add the check as well: a failing test outlives a
paragraph.

Like this file, the handbook is development-only and never merged into `main`.

## Approval boundaries

**Verification may proceed. Product behaviour needs approval.** The full rule, the three kinds of
question it distinguishes, and the two traps that caused it to be written live in
**`docs/engineering/HANDBOOK.md` §6 — Decision boundaries**.

It is not restated here. Two copies of a rule drift, and the reader cannot tell which is current.

## The diagnostic subsystem is COMPLETE

**Declared 2026-08-07. No further improvement, polish or refinement.**

It has cost a lot of time and it now does its job: it reports which build produced it, it refuses to
judge a screen that has no book on it, it describes one book rather than a whole session, and it says
UNKNOWN where it does not know. That is enough. A diagnostic subsystem is a means, and it had started
to become the work.

Further work on it is allowed **only** when one of these is true:

1. **A real bug is discovered in it** — it reports something false, or fails to report at all.
2. **A real investigation needs a capability it does not have** — driven by an actual failure being
   chased, not by an improvement imagined in advance.
3. **The owner explicitly asks for an enhancement.**

"While I was in here I noticed…" is not one of them. Neither is a gap I can see but nothing is
currently blocked by. Two such gaps are already known and deliberately NOT being built: the rendering
ledger keeps no per-attempt history (unlike `pdfDiag`), and a diagnostic build's separate profile
means a tester must re-import the book they are reproducing with. Both are written down where they
happened. If an investigation ever needs either, that is condition 2 and the work is justified then.

Everything else goes to the product.

## Build kinds

There are exactly two, and they are different applications as far as Windows is concerned. Defined
once in `scripts/build-identity.mjs`; do not reproduce these values anywhere else.

| | Release | **Beta** | Diagnostic |
|---|---|---|---|
| Product name | `Sard` | `Sard` | `Sard Diagnostic` |
| Executable | `Sard.exe` | `Sard.exe` | `sard-diag.exe` |
| Identifier | `com.sard.app` | `com.sard.app` | `com.sard.diag` |
| Version | `1.1.0` | `1.1.0` — the REAL version | `1.1.0-diag` |
| Window title |  |  — identical |  |
| About panel | version | **version · Beta Build · BUILD ID** | version |
| BUILD ID | `REL-…` | **`BETA-…`** | `DIAG-…` |
| Updater | public endpoint | public endpoint | **none** |
| Distribution | **GitHub Releases** | **private — handed to testers** | private |
| Package | `Sard-Setup.exe` | `Sard-BETA-<stamp>-<sha>.zip` | `Sard-DIAG-<stamp>.zip` |

**The Beta is the product, marked — not a separate application and NOT a release channel** (owner,
2026-08-07). Same name, executable and identifier, so it REPLACES a tester Sard and they keep reading
their own library, which is the only way to get feedback about what we actually ship.

⚠ **A Beta is byte-comparable to a release apart from its BUILD ID.** Same version, same window
title, same product name — a tester must experience EXACTLY the application they will eventually
receive, so nothing on the everyday surface may differ. Betas are private builds handed to a few
testers directly; they are never published to GitHub Releases, which carry official production
versions only.

**The About panel is the one place a Beta admits what it is**, showing `Beta Build` and the BUILD ID.
Two Betas are told apart by that id (UTC stamp + commit), so no version bump is ever needed. Two
earlier attempts were reverted for the same reason — a `-beta` version, then a `Sard — BETA` window
title — because each changed the thing under test.

A diagnostic build installs *beside* a release install, keeps its own profile, and cannot update
itself or be updated. Its name says what it is after any number of copies, downloads and renames.

**Switching kind requires `cargo clean -p sard`.** `generate_context!` reads the Tauri config through
an environment variable that Cargo does not include in its fingerprint, so a cached compile will
silently keep the previous identity. The verifier catches this, but clean first and save the round
trip.

### Rules for diagnostic builds

- Never built from `main`.
- Never released, never uploaded to GitHub Releases, never given a version that looks like a release.
- Never shared without passing `scripts/verify-artifact.mjs --kind=diag`.
- Shared **only** through a location used for nothing else — never a folder or link that has ever
  held, or will ever hold, a public build.

---

## Sharing a build with anyone

This is where the incident happened, so it gets its own rules.

1. **One link, one purpose.** A location that has ever hosted a public build never hosts a diagnostic
   one, and vice versa. Re-using a location silently changes what an old link points at.
2. **Send the filename, not just the link.** `Sard-DIAG-20260807-Setup.exe` and `Sard-Setup.exe` are
   different things and now look different. Say which one you mean.
3. **When you send a new link, say the old one is dead.** A link you stop updating is not a link
   anyone else knows to stop using.
4. **Every package ships `BUILD-INFO.txt`.** When someone reports a problem, ask for its `BUILD ID`
   first. It is the fastest way to find out what they are actually running, and it costs one message.

## Standard procedure: ask for the BUILD ID first

**Before any debugging begins, on every report, from anyone: get the BUILD ID.** Not after
reproducing, not once a theory needs checking — first, before the investigation has a shape.

Three ways to get it, in order of what the reporter has to hand:

| They have | Where to look |
|---|---|
| A diagnostic build | The report's first lines: `buildIdFrontend` / `buildIdCore` / `buildIdMatch` |
| Any build at all | Right-click the executable → **Properties → Details** → *Product name* and *Product version* |
| The package it came in | `BUILD-INFO.txt`, the `BUILD ID` line |

Why this is first and not fourth: the 2026-08-07 investigation ran for days on "which build is this?",
answered by inferring from file sizes, install directories and WebView2 cache timestamps — and the
answer that eventually mattered (a diagnostic build from a stale link) was reachable in one message.
Every measurement taken before the build is known is a measurement that may be about the wrong
program.

Read `buildIdMatch` too, not just the id. **MISMATCH** means the executable is not running the
frontend it was built with, and that changes what is worth investigating at all: nothing else in the
report can be trusted to describe a coherent program.

Anyone can check a build by hand: right-click the executable → **Properties → Details**. `Product
name` reads either `Sard` or `Sard Diagnostic`. This is the same field the automated verifier reads,
so the manual check and the machine check cannot disagree.

---

## How  is updated

**`main` is not a merge target. It is a published snapshot of `develop`, minus the
development-only files.**

```
npm run release:to-main            # dry run — shows exactly what would be kept and dropped
npm run release:to-main -- --commit
```

**Why not `git merge`.** Git cannot permanently exclude paths from a merge, and the usual
suggestion — `.gitattributes` with `merge=ours` — does NOT work: a merge driver is only invoked when
BOTH sides changed the same file. A file that exists on `develop` and never existed on `main` is not
a conflict, so git simply adds it and no driver is consulted. It would appear to work right up until
the moment it mattered. `.gitignore` cannot help either — these files are TRACKED.

So the release takes `develop`'s tree, drops the excluded paths, and commits that onto `main`. That
is what a production branch honestly is: the tree we chose to ship. The history of how we got there
stays on `develop`, in full.

The exclusion list lives in `scripts/production-tree-rules.mjs` and is imported by BOTH the release
and the gate, so the two can never describe different trees. Adding a new internal document under
`docs/engineering/` requires no change anywhere — the directory rule already covers it.

The script refuses to run on a dirty tree or from the wrong branch, builds through a temporary index
so the working tree is never touched, and verifies `main` afterwards rather than assuming.

## Why this exists

On **2026-08-07** a public user downloaded and ran a diagnostic build of Sard.

GitHub was not the source, and this was established rather than assumed: the published installer
verified byte-for-byte against its minisign signature, GitHub Actions had run exactly once (three
days before the diagnostic build existed), no release or asset had been created or modified since,
the fork had no releases, and no diagnostic source had ever been committed to any branch.

The build reached the user through a **stale cloud-storage link**. They had been given it before the
public release; diagnostic builds were later uploaded to the same location; they returned to the link
they already had and took the newest file.

The confusing part — *"the last commit predates the diagnostic build by three days"* — dissolved on
reading the share package's own `BUILD-INFO.txt`: `HEAD + 65 uncommitted path(s)`, built **from the
working tree**. The commit history had never described what was inside the distributed binaries.

The stale link was the delivery. The **defect** was that the two builds were indistinguishable once
separated from the folder they were built into: identical filename, product name, version, identifier
and updater endpoint. A diagnostic build therefore installed *over* a real Sard, shared its profile,
and reported itself up to date so nothing would ever repair it. The same collision, running the other
way, is why a tester had earlier installed the diagnostic package and got a build with no diagnostics
in it — one root cause, two incidents.

The lesson this document owns is the one about identity:

- **A folder is not a property of a file.** Separation that survives only while a file stays where it
  was made is not separation. Identity has to travel with the artifact — which is why build kinds,
  BUILD IDs and package names exist above.

The incident also taught an evidence lesson — *an absence is only evidence once you have proved you
can see* — which belongs to method rather than process and is recorded in
**`docs/engineering/HANDBOOK.md` §3.1**, where the rest of the measurement rules live.

---

# Tooling inventory

Every script, harness and utility used to develop and verify Sard. **Categories matter**, because two
different things look alike and belong in opposite places:

| Category | Meaning | Where it lives |
|---|---|---|
| **OFFICIAL** | Part of the build/verify/release workflow. Version-controlled on `develop`. | `scripts/`, `tests/` in the repo |
| **EVIDENCE** | Generated output — proof of a measurement, not a tool. | `tests/harness/*-result.json` in-repo; narrative reports in the vault |
| **THROWAWAY** | Produced one answer and has no ongoing role. | `M:\ProjectDocs\sard\Tools\` (outside the repo) |
| **LOCAL** | Machine state that git cannot carry. | `.git/hooks/`, git config |

⚠ The vault's `Tools/README.md` states plainly that nothing in it builds, runs, tests or packages
Sard. **Do not move repo harnesses there.** They are OFFICIAL tooling and belong on `develop`.

## Build and release scripts — `scripts/` (OFFICIAL, permanent)

| Script | Purpose | Invoked by | Depended on by |
|---|---|---|---|
| `build-test.mjs` | Builds the release binary and copies it to `test-build\Sard.exe` **plus the Piper engine**. Every harness needs this first. | `npm run build:test` | All 54 harnesses |
| `build-identity.mjs` | Build kinds as data (`release`/`beta`/`diag`), BUILD ID generation and extraction. | imported | verifier, packagers |
| `verify-artifact.mjs` | **The release gate.** Canaries, forbidden/required markers, PE version resource, BUILD ID prefix, updater endpoint, web-bundle check. | `npm run verify:release` / `:beta` / `:diag` | packaging, CI |
| `production-tree-rules.mjs` | The single definition of development-only paths. | imported | `check-production-tree.mjs`, `release-to-main.mjs` |
| `check-production-tree.mjs` | Refuses a tree containing development-only files. | `npm run verify:main-ready` | pre-release |
| `release-to-main.mjs` | Builds `main` as a **snapshot** of `develop` minus development-only paths. | `npm run release:to-main -- --commit` | the publish sequence |
| `pack-beta-zip.mjs` | Beta installer → ZIP. Derives the artifact name from config; refuses one older than the verified binary. | `npm run pack:beta` | Beta distribution |
| `pack-diag-zip.mjs` | Diagnostic package. | `npm run pack:diag-zip` | tester diagnostics |
| `copy-release.mjs`, `kill-sard.mjs`, `pack-diag.mjs`, `pack-share.mjs` | Support utilities. | ad hoc | — |
| `verify-main-buildable.mjs` | **The production-build gate.** Reconstructs the tree the release would publish and runs the production typecheck and bundle against it. | `npm run verify:main-buildable` | `release-to-main.mjs` |

### The fast test build — `npm run build:test`

**This lives here, not in `BUILD.md`.** `BUILD.md` ships to `main`, where none of these scripts exist,
so instructions naming them were both broken for a public reader and a description of internal
tooling. The knowledge is kept; only its location changed.

`scripts/build-test.mjs`, from the CURRENT working tree **including uncommitted changes**, in order:

1. **Checks cargo is resolvable** — falls back to the rustup default `%USERPROFILE%\.cargo\bin` if it
   is not on PATH, or aborts with a clear "install Rust / fix PATH" message.
2. **Closes any running Sard** — `sard.exe`, `Sard.exe` **and** `Sard-standalone.exe`, via
   `scripts/kill-sard.mjs` — and aborts loudly if one cannot be closed, rather than letting the build
   die later with a cryptic `Access is denied (os error 5)` / `EBUSY`.
3. Runs **`tauri build --no-bundle`** — a real release `.exe`, no installer, skipping the slow WiX MSI
   and NSIS bundling a local test does not need.
4. Copies the result to a stable path via `scripts/copy-release.mjs`: `test-build\Sard.exe` and
   `test-build\piper\` (from `target\release\piper`, falling back to `src-tauri\resources\piper`).

⚠ **`--no-bundle` is for TEST builds only.** A release needs the full `tauri build` — the installer is
the artifact. `build:test` once ran the full bundle in an `&&` chain, so any bundling failure aborted
everything and left no fresh `test-build\Sard.exe`, making the app look broken when only the installer
step had failed.

⚠ **The standalone's process name is `Sard-standalone`.** The Share single-file is `sard.exe` renamed,
so `taskkill /IM sard.exe` and `Get-Process -Name sard` both miss it. `kill-sard.mjs` covers all three
names, which is why a running copy cannot silently break a build.

## Test infrastructure (OFFICIAL, permanent)

- **`tests/unit/`** — Vitest. `npm test` runs `tsc -p tsconfig.test.json && vitest run`.
  **376 tests / 26 files, all passing.** Includes `pdfText.test.ts` (21 tests covering Arabic
  presentation forms, tatweel, watermark stripping and the document-quality verdict).
- **`tests/harness/`** — **54 `.mjs` harnesses** driving the *real binary* over CDP.
  - `cdp.mjs` — the client. Exposes `launchSard({exe, port, timeoutMs})` returning `{ send, evaluate,
    close }`. `send` gives raw CDP (`Performance.getMetrics`, `HeapProfiler.collectGarbage`).
  - `profile.mjs` — `snapshotDb()` / `restoreDb()`. **Mandatory on every exit path, including a
    crash.** A harness that can lose the user's library is a defect regardless of what it measures.
- **`tests/fixtures/`**, **`tests/corpus/`** — `npm run fixtures:build`, `corpus:verify`.

### Harnesses built during the PDF/audit work (OFFICIAL, permanent — keep on `develop`)

| Harness | Purpose | Evidence file |
|---|---|---|
| `library-audit.mjs` | Full-library structural audit: spine, TOC resolution, panel rows, order, blanks, images. | `library-audit-merged.json` (39 books) |
| `ux-endurance.mjs` | Page-turn latency, scrolling, chapter transitions, annotations, open/close cycles, UI coherence. | `ux-endurance-result.json` |
| `ux-leak-scroll.mjs` | **Leak test with forced GC at a fixed lifecycle point**, scroll validity, annotation CRUD. | `ux-leak-scroll-result.json` |
| `pdf-stress.mjs` | Open latency, turn latency, hammer, jump-to-last, outlines, memory, per PDF. | `pdf-stress-result.json` |
| `pdf-hostile.mjs` | Malformed-PDF import + blank-page discrimination. Creates/cleans its own fixtures. | `pdf-hostile-result.json` |
| `pdf-corrupt-open.mjs` | What opening an accepted-but-damaged PDF does. | `pdf-corrupt-open-result.json` |
| `pdf-text-layer.mjs` | Text-layer usability per document (the TTS feasibility measurement). | `pdf-text-layer-result.json` |
| `pdf-tts.mjs` | Extraction quality through the real pipeline via `window.__sardPdfTts`. | `pdf-tts-result.json` |
| `pdf-zoom-theme.mjs` | Zoom re-render proof + theme application + persistence. | `pdf-zoom-theme-result.json` |
| `pdf-fixes.mjs` | The three reported failures, tested as reported. | `pdf-fixes-result.json` |
| `pdf-acceptance.mjs` | **The PDF acceptance suite** — zoom scroll both directions, themes while zoomed, TTS state. | `pdf-acceptance-result.json` |
| `pdf-tts-diagnosis.mjs` | Staged PDF read-aloud diagnosis with **EPUB as the control**: Edge capability, playback via `__sardTtsStats()`, extraction, highlighting structure. | `pdf-tts-diagnosis-result.json` |
| `pdf-tts-diagnosis2.mjs` | Round 2 — sustained multi-unit playback, range→span resolution, page-change mark lifetime. | `pdf-tts-diagnosis2-result.json` |
| `pdf-tts-diagnosis3.mjs` | Round 3 — zoom on `view.renderer` (the real call site), **proving the re-render happened** before judging span identity. | `pdf-tts-diagnosis3-result.json` |
| `pdf-tts-diagnosis4.mjs` | Round 4 — **the text-layer accumulation harness.** Red-verified: fails on the current build. Gate for the pdf.js fix. | `pdf-tts-diagnosis4-result.json` |
| `pdf-tts-diagnosis5.mjs` | **The render-race gate.** Repeated zoom cycles with varied settle times + a hostile burst + playback. `--cycles=N`. Must report `violations: 0`. | `pdf-tts-diagnosis5-result.json` |
| `pdf-highlight-poc.mjs`, `poc2.mjs` | **Study harnesses** for the highlighting design — they use a *replica* of the unit derivation, cross-validated against the real pipeline. Superseded as gates by the one below; kept for the design record. | `pdf-highlight-poc{,2}-result.json` |
| `pdf-highlight-acceptance.mjs` | **THE PDF SENTENCE-HIGHLIGHTING GATE (RAWY-295).** Drives the product's own code, no replica: index tracking, pause/resume, seek, zoom at a frozen index, all 8 themes with **no re-application**, page-change leak, stop, scan. Exits 3 on any violation. ⚠ **Fails BY DESIGN while PDF read-aloud is disabled** — it presses a hidden control. Do not "fix" it; it is the re-enablement gate. | `pdf-highlight-acceptance-result.json` |
| `pdf-tts-disabled.mjs` | **The DISABLED-state gate.** Proves a reader can reach no PDF read-aloud surface (no control, no player, no marks, no note) **while** the implementation stays reachable (`units=5/withRange=5`, text layer intact) and EPUB read-aloud still plays. Checks a *text* PDF, never a scan — a scan cannot distinguish "disabled" from "no text". | `pdf-tts-disabled-result.json` |

⚠ **PDF read-aloud is TEMPORARILY DISABLED** (owner, 2026-08-08) behind `PDF_TTS_ENABLED` in
`src/lib/pdfText.ts`. The implementation is preserved, not removed. While it is off,
`pdf-highlight-acceptance.mjs` and the playback stage of `pdf-tts-diagnosis5.mjs` fail by design;
`pdf-tts-disabled.mjs` is the harness that must pass. See `PROJECT_HANDOFF.md` §8.

Run: `node tests/harness/<name>.mjs`. Some accept `--limit=`, `--from=`, `--only=`.
**Environment:** Windows; `test-build\Sard.exe` must be current; each harness uses its own CDP port
(9900–9938 in use) so two must not run concurrently on the same port.

### Debug surfaces in product code (permanent, no UI)
`window.__sardTrackStats(lang)` and `window.__sardPdfTts(lang)` in `Reader.tsx` — they let a harness
measure the **real** pipeline instead of a re-implementation that could drift.

## Evidence and reports

- **In-repo:** `tests/harness/*-result.json` — raw measurements, regenerated by re-running.
- **In-repo narrative:** `LIBRARY_COMPATIBILITY_AUDIT.md`, `UX_AND_PDF_STRESS_AUDIT.md`,
  `PDF_FEATURES_RAWY-291.md` (repo root; development-only, never published).
- **Vault:** `M:\ProjectDocs\sard\Reports\`, `Evidence\`, `DB-Snapshots\`, `Corpus\`.

**How to record verification evidence:** state the measurement, the instrument, and the label
(PROVEN / DISPROVEN / UNVERIFIED). A number without its instrument is not evidence. If an instrument
could lie, say how — the pitfalls are catalogued in `PROJECT_HANDOFF.md` §6.

---

# Git and GitHub — operating rules

**Branches.** `develop` is the daily development branch and the only place work happens. `main` is the
**published snapshot** — not a merge target, because `git merge` cannot permanently exclude paths and
`.gitattributes merge=ours` silently fails for files that never existed on the target.

**Remotes.** `private` = `Limitless-Soul1/Sard-develop` (PRIVATE, holds `develop` **and** `main`, the
source of truth). `origin` = `Limitless-Soul1/Sard` (PUBLIC, `main` only, releases).
**`develop` must never reach `origin`.**

**Push restrictions (LOCAL, verified present on this machine):**
- `remote.origin.push` = `refs/heads/main:refs/heads/main`
- `.git/hooks/pre-push` refuses non-main to the public URL
- `.git/hooks/commit-msg` strips assistant/vendor trailers and refuses messages naming one

⚠ **Hooks and refspec are not version-controlled — re-create both on a fresh clone and verify them
before the first commit of a session.**

**Commit conventions.** Messages describe the change, never how it was produced or internal process.
Housekeeping/cleanup commits are exactly `Repository maintenance`. **No `Co-Authored-By:` or
"Generated with" trailers, ever** — hosting platforms parse them into the contributor list.

**Never commit or push:** anything referencing development assistants or tooling; archives under
`public/` (a 47 MB leftover once tripled every build); development-only paths onto `main`;
credentials or signing keys.

**Build/test/verify sequence before anything is considered done:**
```
npx tsc --noEmit -p tsconfig.json     # typecheck
npm test                              # 376 unit tests
npm run build:test                    # real binary
node tests/harness/<relevant>.mjs     # runtime measurement of what changed
```

**Release sequence:**
```
npm run verify:main-ready
npm run release:to-main -- --commit        # audits AND builds the exact shipping tree first
git push private main
git push origin main
git tag -a vX.Y.Z && git push origin vX.Y.Z   # CI builds, signs, generates latest.json
```
The order is not a convenience — see [Production release cleanliness](#production-release-cleanliness).

---

# Production release cleanliness

> **PERMANENT. Applies to every future release, at every version number, without exception.**
> Declared 2026-08-08, after v1.2.2 shipped carrying internal development material.

**Before every production release, the exact tree and artifact that will reach users must be audited
for BOTH build correctness AND production cleanliness.**

## Why the path check is not enough

The production-tree rules match **paths**. That answers "is an excluded file present?" and nothing
else, and two things slip past it every time:

- **Internal material inside a file that legitimately ships.** `package.json` shipped the whole
  internal tooling inventory; a source comment shipped a private machine path.
- **Development files under a path no rule names.** Rust test modules under `src-tauri/src/` were
  never matched, because the rule named `src-tauri/tests/`.

Both were published in v1.2.2 while every gate reported success. A gate that passes on a contaminated
tree is not a gate.

## What must be detected

Content inspection, not only path matching. The tree must be free of:

- private machine paths and local development paths;
- internal developer or test modules;
- diagnostic tools, harnesses, investigation utilities and testing infrastructure;
- internal plans, reports, studies, checkpoints, evidence files, workflow and handoff documents;
- developer-only scripts and packaging tools;
- internal project or process terminology **where it reveals private development infrastructure** —
  not ordinary product comments;
- development databases, temporary files, internal configuration and other developer-specific material;
- anything else not genuinely required by the end-user application.

**Vendored third-party code is exempt by path**, with its provenance recorded. Upstream terminology in
a vendored library is not contamination, and vendored files are never edited to satisfy this rule.

## The mandatory order

1. **Generate** the exact production shipping tree.
2. **Audit** that tree for forbidden paths *and* forbidden content.
3. **Build** that same tree.
4. **Verify the artifact** — production identity, version, BUILD ID, no diagnostic or development traces.
5. **Only then publish.**

**A release is never published before artifact verification succeeds.** v1.2.1 was published and then
rejected by its own verification, leaving an unverified installer live on the updater endpoint. The
release therefore builds to a **draft** and a later step promotes it only after verification passes.

**Two trees must never diverge.** Whatever is audited must be exactly what is built and exactly what is
shipped. Verifying one tree and releasing another is the failure this rule exists to prevent — which is
why the production-build check applies the same content transforms the release does.

**Any cleanliness failure blocks the release.** Not a warning, not a note to fix later.

**Approval.** Verification may proceed freely. **Product behaviour, UI, UX and visual decisions
require the owner's approval before implementation** — a filed observation is not an authorisation.

**Continuing in a new conversation:** read `docs/engineering/PROJECT_HANDOFF.md` (state, blockers,
next action) → this file (process) → `HANDBOOK.md` (method). Then `git status`, verify the hooks, and
reproduce before changing anything.

---

# Where everything lives — READ BEFORE ANY ARCHITECTURAL WORK

Sard's forward planning is deliberately kept **outside the source tree**. A session that starts from
the repository alone will not see it and will re-decide settled questions.

| # | What | Exact path |
|---|---|---|
| 1 | **Project source** | `M:\eRawy` |
| 2 | **Documentation vault** | `M:\ProjectDocs\sard\` — start at `STATE.md` (~4 KB hot layer; ⚠ stale as of 2026-08-04, orient from `M:\eRawy\PROJECT_MASTER_SUMMARY.md`). **Never read `archive\PROJECT.md`** (1.6 MB) |
| 3 | **Cross-platform plans** | `M:\Sard Desktop\` — 40 documents, ADR-based, entry `INDEX.md` |
| 4 | **Mobile plans** | `M:\Sard Mobile\` — 44 documents, ADR-based, entry `INDEX.md` |

**Canonical plan file per area**

| Area | Canonical source |
|---|---|
| Cross-platform (Linux + macOS) | `M:\Sard Desktop\` — **supersedes** `M:\eRawy\DESKTOP_CROSSPLATFORM_PLAN.md` |
| Linux | `M:\Sard Desktop\20-platform\01-linux.md` |
| macOS | `M:\Sard Desktop\20-platform\02-macos.md` |
| Android **and** iOS | `M:\Sard Mobile\30-mobile\` + `M:\Sard Mobile\40-decisions\` |
| Mobile architecture | `M:\Sard Mobile\30-mobile\04-mobile-architecture.md`, `05-native-service-layer.md` |
| TTS (desktop/cross-platform) | `M:\Sard Desktop\30-architecture\04-tts-strategy.md` |
| TTS (mobile) | `M:\Sard Mobile\20-architecture\05-audio-and-tts-architecture.md` |
| Portability split | `M:\Sard Desktop\10-current-state\02-subsystem-portability-inventory.md` |

**Previous investigations and decisions** — `M:\Sard Desktop\40-decisions\` (8 ADRs),
`M:\Sard Mobile\40-decisions\` (7 ADRs), `M:\ProjectDocs\sard\DECISIONS.md`, `LESSONS.md`,
`HISTORY.md`, `ENGINEERING-CONTRACT.md`, and the in-repo audits
(`LIBRARY_COMPATIBILITY_AUDIT.md`, `UX_AND_PDF_STRESS_AUDIT.md`, `PDF_FEATURES_RAWY-291.md`).

> **A future session MUST read the relevant documents above before making any architectural decision
> or starting implementation work on another platform.** The ADRs record decisions with their
> reasoning; re-deciding them without new evidence is a defect, not initiative. Full index and the
> per-platform status: `docs/engineering/CROSSPLATFORM_MOBILE_HANDOFF.md`.

**Platform status (PROVEN from the repository):** Windows is the **only** implemented platform
(v1.1.0; WebView2; CI runs `windows-latest` only). Linux, macOS, Android and iOS are **planned and
documented, not built** — no Linux/macOS CI, no `src-tauri/gen/android`, no iOS project. The desktop
cross-platform stage is active; the **mobile stage is paused**.
