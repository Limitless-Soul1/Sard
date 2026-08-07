# Sard — Engineering Handbook

How engineering work is done on Sard. ~1,900 words — readable in full in well under ten minutes.

Every rule is here because something went wrong without it. Rules are deliberately short; the
reasoning is compressed to the clause that makes them stick.

| Document | Owns |
|---|---|
| **This document** | How work is done: investigation, evidence, verification, harnesses, decisions |
| `WORKFLOW.md` | Branches, merge policy, build kinds, packaging, release |
| `BETA-1.md`, item records | The status of specific findings |

Nothing is stated in two documents. Where a rule belongs elsewhere, this one points at it.
Both are development-only and never merged into `main`.

**If you read one section, read [§3](#3--evidence).** More wrong conclusions here came from believing
an absence than from any other cause.

---

## 1 · Philosophy

- **The product is the point.** Tooling, diagnostics and documents exist to improve it. When they
  start consuming the effort, they have stopped working.
- **Priority when goals conflict:** correctness → architecture → maintainability → performance →
  speed. A fast answer that might be wrong loses to a slower one known to be right.
- **UX is the final judge.** A change that measures better but reads worse is not an improvement.
- **Complexity is a cost, not a sin.** A design handling fewer real cases has moved the complexity
  into the failures. State the trade-off; don't pretend one side away.
- **Never claim faster, smoother or lighter without a before and an after.**

---

## 2 · Investigation

- **Investigate before implementing.** A fix built on a guess looks correct and leaves the defect.
- **Never stop at the first explanation.** Ask what else produces the same symptom.
- **Try to disprove yourself.** A hypothesis that survived no attack is a belief.
- **Name the cheapest decisive experiment**, and say what each outcome means *before* running it.
- **Give a recommendation.** Withholding judgement is an unfinished job.
- **Don't assume a defect is ours.** Eliminate with evidence: our code · the environment · the
  content. (A reported "transparency bug" was a Windows setting.)
- **Don't implement a fix inside an investigation** unless asked.

**Report shape:** measured facts → analysis → recommendation → alternatives rejected → confidence.

---

## 3 · Evidence

### 3.1 An absence is evidence only once you have proved you can see

Before believing something is missing, prove the instrument finds something that *is* there — a
**canary**. No canary means the result is **UNUSABLE**, not **CLEAN**.

*(Two installers searched for diagnostic strings both came back empty; the payloads were compressed
and the search was reading nothing.)* Enforced by `scripts/verify-artifact.mjs`.

### 3.2 Three tiers, never blurred

| Tier | Meaning |
|---|---|
| **MEASURED** | Read directly from the running system |
| **DERIVED** | Computed from measured values — inputs shown |
| **UNKNOWN** | Could not be established. Not a guess, never silently upgraded |

"UNKNOWN" is a complete answer. Replacing it with confidence is the most expensive mistake available.

### 3.3 Validate a discriminator on a known positive

A test separating A from B must be shown to fire on a real A. Otherwise "not B" says nothing.

### 3.4 The instrument is part of the experiment

When a measurement contradicts a strong expectation, suspect the instrument first.

| Instrument | Lies because |
|---|---|
| `documentElement.scrollTop` | Always 0 — the reader scrolls inside a closed shadow root |
| Synthetic `WheelEvent` | Never drives native scrolling; only trusted input does |
| Per-second sampling | Misses burst-shaped signals (every window 0/s, session total 452) |
| Whole-string search in a binary | Compilers split literals (`com.sard.diag` → `com.sard` + `ard.diag`) |

For build identity read the **PE version resource** — also what a user sees under Properties, so the
automated and manual checks agree.

### 3.5 Check what a number counted, and what state you measured

- Name a measurement for what it counts. A field called `paragraphs` counted `<p>` elements and had a
  defect filed against it; it is `pTags` now.
- Confirm the intended state: a cover page has no text, a closed drawer is off-screen, a slider at its
  maximum cannot increase.

---

## 4 · Verification

- **Nothing is "fixed" without runtime verification.** Compiling and passing unit tests prove neither.
- **Before and after, always.** Without a baseline, "it works now" is unfalsifiable.
- **Falsify in both directions.** Prove a guard fires by breaking what it guards, then restoring it.
- **Verify the artifact, not the intention.** Extract, install, launch, read the version resource. The
  build directory proves the build; only the package proves the package.
- **"Done" means** typecheck + unit suite + relevant harnesses + a runtime measurement of the
  behaviour changed. If a step was skipped, name it.

---

## 5 · Harnesses

- **A harness must be able to fail.** The two ways it can't: accepting too much, or matching nothing.
  Inspect a fixture before trusting a test built on it.
- **Pair every hostile case with a benign control**, or you cannot tell "it worked" from "nothing
  loaded".
- **A harness restores the environment** on every exit path, including a crash. Data preservation is a
  requirement of the harness, not of the person running it.
- **Cleanup must not depend on the run going well.** Prefer removal that needs no app and can be
  proven correct (library files are content-hash named, so the target is verifiable before deletion).
- **Report structure; assert behaviour.** Asserting a *predicted* shape fails when the prediction is
  wrong, which is not a defect.
- Harnesses live on `develop` and never reach `main`.

---

## 6 · Decision boundaries

**Verification may proceed. Product behaviour needs approval.**

| Proceed freely | Ask first, every time |
|---|---|
| Measuring whether something is true | Product behaviour |
| Reproducing a failure | UI and UX |
| Building a fixture, harness or probe | Workflows and interactions |
| Fixing something measurably wrong | Visual decisions |
| Renaming a thing that misdescribes itself | Anything a user could have an opinion about |

Verification changes what we **know**; product changes what the user **gets**. Engineering answers
technical correctness — the owner decides product and UX.

**Two traps:**

- **A filed observation is not an authorisation.** A postponed-items entry says someone noticed
  something, not that the answer is "change it".
- **"Go ahead" answers the question that was asked.** Where a request could mean either, pin it down
  *before* building — afterwards the finished work applies pressure to keep it.

**Record decisions as a failing test**, not a comment, and say in the test that it guards a
*preference* so a deliberate redesign updates it rather than fighting it
(`tests/harness/rtl-panel.mjs`).

---

## 7 · Diagnostics

- **The subsystem is complete.** Reopened only when a real bug is found in it, a real investigation
  needs a capability it lacks, or the owner asks.
- **A diagnostic must never invent a failure.** Ask "is there anything to judge?" first; answer NOT
  APPLICABLE when there isn't. Stale state is found and labelled, never adopted as current.
- **A diagnostic build must prove it is instrumented.** The inverse failure is real — a tester once
  installed a diagnostic package and got a build with none.
- **Instrumentation is compiled out, not switched off**, so its absence is measurable.

---

## 8 · Naming and traceability

- Every finding, fixture and harness names its work: `WP-n`, `NAV-n`, `TRACK-n`, `PPC-n`, `FUTURE-n`.
  The rule is traceability, not the prefix — add a new class to the guard rather than disguising the
  artifact.
- A finding's title states the **observation**, not the presumed cause.

---

## 9 · Builds and packaging

Mechanics in `WORKFLOW.md`. The principles:

- **Identity is data, not convention.** Two builds differing only by folder are indistinguishable once
  either is copied. Identity travels with the artifact.
- **Every build carries a BUILD ID** — the first thing to request on any report.
- **The verifier gates packaging**; it runs before anything is staged.
- **Never select an artifact by folder order.** `readdirSync(...)[0]` is alphabetical and once chose a
  build eleven weeks old. Derive the name; require it newer than the binary just verified.
- **Nothing archived may live in `public/`** — it is compiled into the executable. A 47 MB leftover
  once tripled every build for two days.
- **Channels do not borrow each other's rules.** A private Beta is not a pre-release of the public one.

---

## 10 · Regression prevention

- **A net that has never caught anything is unproven.** Test it by breaking what it guards.
- **A net that measures one mode measures one mode.** A baseline capturing only scrolled rendering
  recorded `columns: 1` for every book, so a pagination collapse was byte-identical and shipped.
- **Record configuration with the capture**, and report drift as *"not a code change — re-baseline"*,
  distinct from a regression.
- **Adopting a baseline means re-capturing it if it has drifted.** A gate failing for reasons nobody
  can act on is one people learn to ignore.

---

## 11 · Mistakes

- **Record near-misses where they happened**, in the code: what it was, why it looked right, what
  caught it.
- **Classify the mistake, not the instance** — fixing one occurrence leaves the class alive.

| Class | Shape |
|---|---|
| Believing an absence | A search that cannot read reports "clean" |
| Failing open | `if A … else if B …` stops covering anything when a C appears |
| The wrong instrument | The measurement is real and about the wrong thing |
| Selecting by convenience | First-in-folder, first-match, alphabetical |
| Authorisation drift | A filed observation or an ambiguous "go ahead" read as approval |

- **A post-mortem separates the delivery from the defect.** Fixing the delivery fixes one incident;
  fixing the defect fixes the class.
- **Report faithfully.** Failing tests get quoted, skipped steps get named, finished work is stated
  plainly without hedging.

---

## 12 · Working rhythm

**Feature work** — understand the requirement (and what it is not) → check architectural fit →
approval if product/UI/UX changes (§6) → smallest correct implementation → measure before and after
(§4) → run the gates → report honestly, including what was not done.

**Investigation work** — the sequence in §2, ending in the report shape given there.

**Cleanup** — until Feature Freeze the answer is **no**, except for a mess that is *actively costing*
something: that is a defect, and defects are product work. Cadence and checklist: `WORKFLOW.md`.

---

## 13 · Maintaining this handbook

**It is a living document, and it is kept short.**

- **Update it in the same change that taught the lesson.** Not afterwards. A lesson recorded a week
  later is half lost; one recorded nowhere is paid for twice.
- **Add only reusable principles.** An incident earns a place only when it teaches one, and then as
  the principle with the incident as a single clause of evidence — never as a story.
- **Keep every rule to a few lines.** A short rule with its reason beats a passage of narrative.
- **Never duplicate a rule between documents.** Point at the owner; two copies drift and the reader
  cannot tell which is current.
- **Edit or delete obsolete guidance** in the same change. A superseded rule is worse than none — it
  is followed by someone who does not know it was superseded. Check the other places stating it.
- **Merge and simplify periodically.** If a section outgrows its usefulness, cut it, or move the
  detail to its own document and leave a one-line summary and a link.

*Someone reading only this document should understand how engineering work is performed on Sard — in
a few minutes.*
