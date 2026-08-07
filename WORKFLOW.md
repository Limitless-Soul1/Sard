# Sard — development workflow

This is the permanent process for this repository. It exists because of a real incident, described
at the end, and every rule here is a response to something that actually went wrong rather than a
convention borrowed from elsewhere.

Two branches, one direction of travel: work happens on `develop`, and only completed, reviewed,
cleaned and explicitly approved work moves to `main`.

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

## `develop` — the daily development branch

**All implementation work happens here.** Specifically:

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
- Is not pushed to the public `origin` while it carries internal tooling — see
  [A note on pushing `develop`](#a-note-on-pushing-develop).

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

## Build kinds

There are exactly two, and they are different applications as far as Windows is concerned. Defined
once in `scripts/build-identity.mjs`; do not reproduce these values anywhere else.

| | Release | Diagnostic |
|---|---|---|
| Product name | `Sard` | `Sard Diagnostic` |
| Executable | `Sard.exe` | `sard-diag.exe` |
| Identifier | `com.sard.app` | `com.sard.diag` |
| Version | `1.1.0` | `1.1.0-diag` |
| Updater | public GitHub endpoint | **none** |
| Installer | `Sard-Setup.exe` | `Sard-DIAG-<stamp>-Setup.exe` |

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

Anyone can check a build by hand: right-click the executable → **Properties → Details**. `Product
name` reads either `Sard` or `Sard Diagnostic`. This is the same field the automated verifier reads,
so the manual check and the machine check cannot disagree.

---

## A note on pushing `develop`

`origin` is a **public** repository. Pushing `develop` there would publish every diagnostic tool,
harness and internal note in it — the opposite of the separation this workflow exists to create.

So `develop` currently lives locally only. If it needs a backup or a second machine, it needs a
**private** remote — a private repository added as a second remote, or a private fork. That is a
decision to make deliberately, not a `git push` to make absent-mindedly.

---

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

Two lessons are built into the tooling rather than written down and hoped for:

- **A folder is not a property of a file.** Separation that survives only while a file stays where it
  was made is not separation. Identity has to travel with the artifact.
- **An absence is only evidence if you have proved you can see.** An earlier comparison of two
  installers found no diagnostic strings in either and concluded they were the same build — Tauri had
  compressed the assets and the search was reading nothing. `verify-artifact.mjs` now proves it can
  read a file before it will believe anything is missing from it.
