# Sard — Engineering Handbook

How work is done on this project. Not a style guide and not a transcript: a record of the practices
that produced good outcomes here, and of the specific mistakes that produced bad ones.

Every rule below exists because something went wrong without it. Where a rule has a cost, the cost is
stated, because a rule whose price is hidden gets discarded the first time someone feels it.

**Companion documents**

| | |
|---|---|
| `WORKFLOW.md` (on `develop`) | Branches, merges, build kinds, packaging, release process |
| This document | How to think, investigate, verify, and decide |

**Each document owns its topic and nothing is stated in both.** Where a rule belongs to the other
document, this one points at it rather than restating it — two copies drift, and the reader cannot
tell which is current.

Both are development-only. Neither is ever merged into `main`.

**Contents**

| | | | |
|---|---|---|---|
| [1 Philosophy](#1--development-philosophy) | [2 Investigation](#2--investigation) | [3 Measuring vs assuming](#3--measuring-versus-assuming) | [4 Verification](#4--verification) |
| [5 Harnesses](#5--harnesses) | [6 Decision boundaries](#6--decision-boundaries) | [7 Diagnostics](#7--diagnostics) | [8 Naming](#8--naming-and-traceability) |
| [9 Builds & packaging](#9--builds-ids-and-packaging) | [10 Regression prevention](#10--regression-prevention) | [11 Post-mortems](#11--self-critique-and-post-mortems) | [12 Documentation](#12--documentation) |
| [13 Working rhythm](#13--working-rhythm) | [14 Maintaining this document](#14--maintaining-this-document) | | |

**If you read one section, read [§3](#3--measuring-versus-assuming).** More wrong conclusions on this
project came from believing an absence than from any other cause.

---

## 1 · Development philosophy

**The product is the point.** Tooling, harnesses, diagnostics and documentation exist to make the
product better. When they start consuming the effort, they have stopped doing their job.

**Priority order when two goals conflict:**

> correctness → architecture → maintainability → performance → speed of delivery

Speed is last. That is not a licence to be slow; it means a fast answer that might be wrong loses to a
slower answer that is known to be right.

**UX is the final judge.** A change that measures better but reads worse is not an improvement.
Numbers inform the decision; the reading experience decides it.

**Complexity is not the enemy.** It is a cost to be weighed, not a sin to be avoided. A simpler design
that handles fewer real cases is not simpler in practice — it has moved the complexity into the
failures. State the trade-off; do not pretend one side of it away.

**Do not optimise what you have not measured.** "Faster", "smoother" and "lighter" are claims. Without
a before and an after they are opinions wearing technical clothing.

---

## 2 · Investigation

### 2.1 Investigate before implementing

Understand the failure before designing the fix. A fix built on a guess about the cause will look
correct, pass review, and leave the defect in place.

### 2.2 Never stop at the first explanation

The first explanation is usually *an* explanation, not *the* explanation. Ask what else would produce
the same symptom. If nothing else could, say so and why.

### 2.3 Try to disprove yourself

Before promoting a hypothesis, look for the measurement that would refute it. A hypothesis that
survives an honest attempt to kill it is worth something; one that was never attacked is a belief.

### 2.4 Separate what you measured from what you concluded

Every investigation report distinguishes three tiers, and never blurs them:

| Tier | Meaning |
|---|---|
| **MEASURED** | Read directly from the running system. A number, a string, an observed state. |
| **DERIVED** | Computed or inferred from measured values. The inputs must be shown. |
| **UNKNOWN** | Could not be established. **Not** a guess, and never silently upgraded. |

"UNKNOWN" is a legitimate, complete answer. Replacing it with confidence is the most expensive
mistake available.

### 2.5 Name the cheapest decisive experiment

When uncertain, do not reason further — identify the smallest measurement that would settle it, and
take it. State what result would mean what *before* running it, so the outcome cannot be
rationalised afterwards.

### 2.6 Give a recommendation

Withholding judgement is not neutrality, it is an unfinished job. Investigation reports end with the
strongest recommendation the evidence supports, plus the alternatives considered and the confidence
level. Structure:

1. Measured facts
2. Analysis
3. Recommendation
4. Alternatives rejected, and why
5. Confidence, and what would change it

### 2.7 Bug-origin triage

Never assume a defect is ours. Eliminate, with evidence: **our code · the environment · the content**.
A reported "transparency bug" once turned out to be a Windows setting. Diagnostics must answer
*where* a failure originates, not merely that it occurred.

---

## 3 · Measuring versus assuming

### 3.1 An absence is only evidence once you have proved you can see

This is the single most important rule in this document, and the one most often violated.

> Two installers were searched for diagnostic strings. Neither contained any. The conclusion — "they
> are the same build" — was wrong: Tauri compresses embedded web assets, and the search had been
> reading nothing at all.

**Before believing that something is missing, prove the instrument can find something that IS there.**
Use a *canary*: a string, a value, a marker known to be present in every case. If the canary is
absent, the correct result is **UNUSABLE**, not **CLEAN**.

`scripts/verify-artifact.mjs` implements this and fails loudly rather than passing quietly.

### 3.2 Validate a discriminator on a known positive

A test that distinguishes A from B must first be shown to fire on a real A. An untested discriminator
that reports "not B" has told you nothing.

### 3.3 The instrument is part of the experiment

Instruments lie in ways that look like results. Real examples from this project:

- `documentElement.scrollTop` is permanently `0` — the reader scrolls inside a **closed shadow root**.
  A harness concluded "scrolling is broken".
- **Synthetic `WheelEvent`s never drive native scrolling.** Only trusted input does. A harness
  reported a working feature as broken.
- **Per-second sampling missed a burst-shaped signal.** Every window read `0/s` while the session
  total was 452 — the events fired between samples.
- **Compilers split string literals.** `com.sard.diag` is stored as `com.sard` + `ard.diag`; a search
  for the whole string falsely accused a correct build. Read the PE version resource instead — it is
  also what a user sees under Properties → Details, so the automated and manual checks agree.

When a measurement contradicts a strong expectation, suspect the instrument **before** the product.

### 3.4 Check what a number counted

A field named `paragraphs` counted `<p>` elements. A book that structures text with `<div>` reported
`1` for thousands of characters, and it was filed as a text-extraction defect. It was not: the count
was right and the **name** was a claim the number could not support.

Name things for what they measure. `pTags`, not `paragraphs`.

### 3.5 Measure the right state

Before trusting a reading, confirm you measured the thing you meant to:

- A book's **cover page** has zero characters. Measuring it and reporting on "the book" is wrong.
- A **closed** drawer is still measurable — translated off-screen. Its geometry is meaningless.
- A slider already at its **maximum** cannot increase. Testing only that direction proves nothing.

---

## 4 · Verification

### 4.1 Nothing is "fixed" without runtime verification

A change that compiles, typechecks and passes unit tests has not been shown to fix anything. Drive the
real binary and measure the actual behaviour.

### 4.2 Before and after, always

Capture the defect's measurement *before* changing anything. Without a baseline, "it works now" is
unfalsifiable.

### 4.3 Falsify in both directions

A guard that has never caught anything is a belief. Prove it fires:

> The ResizeObserver repair was verified by measuring 452 and 464 errors before, 0 and 0 after.
> The paged-rendering net was verified by **deliberately reintroducing the original defect**, watching
> every book fail (`columns 418 → 1`), then restoring the fix and watching it go clean.

### 4.4 Verify the artifact, not the intention

Source-level correctness does not survive packaging. Ask the finished file what it is:

> Every source-level intention was correct — no diagnostic code was committed, CI had run once, the
> published installer verified against its signature. What was never checked was the **file**.

Extract the archive. Install it. Launch it. Read the version resource. The build directory proves the
build; only the package proves the package.

### 4.5 Completion means verified, not written

"Done" requires: typecheck, unit suite, the relevant harnesses, and a runtime measurement of the
specific behaviour changed. If a step was skipped, say which.

---

## 5 · Harnesses

### 5.1 A harness must be able to fail

The most dangerous test is one that cannot fail. Two ways it happens:

- **Accepting too much.** An assertion listing `NO SECTION DOCUMENT` as a valid verdict passed while
  the report claimed a book that was visibly rendering was off screen.
- **Matching nothing.** A hostile CSS fixture was generated with no hostile CSS in it. It passed while
  measuring nothing at all.

**Before trusting a fixture, inspect the fixture.** Confirm it contains what the test looks for.

### 5.2 Pair the hostile case with a benign control

If everything vanishes, you cannot tell "the sanitiser worked" from "nothing loaded". Every hostile
declaration is paired with a benign one that must survive.

### 5.3 A harness must restore the environment

Preservation of user data is a requirement **of the harness**, not of the person running it. A harness
that needs a human to tidy up after it is unfinished.

- Snapshot and restore before and after, on every exit path including a crash.
- If the harness creates data outside the restored set, it removes that data itself.
- **Cleanup must not depend on the run going well.** One harness deleted its fixture over IPC, needing
  a fourth app launch — and the app will not start a fourth time. Cleanup died exactly when the run
  had already failed, three times running.
- Where possible, make removal **provable**: library files are named by content hash, so the file to
  delete can be verified before deleting it.

### 5.4 Report what you measured, assert only what matters

A harness that asserts a *predicted* structure fails when the prediction is wrong — which is not the
same as finding a defect. Report structure; assert behaviour.

### 5.5 Harnesses live on `develop`

They are laboratory equipment. They never reach `main`; at the cleanup milestone the reusable ones
move to the external toolbox, and the rest are deleted.

---

## 6 · Decision boundaries

### 6.1 Verification may proceed. Product behaviour needs approval.

| Proceed freely | Ask first, every time |
|---|---|
| Measuring whether something is true | Product behaviour |
| Reproducing a reported failure | UI and UX |
| Building a fixture, harness or probe | Workflows and interactions |
| Fixing something measurably wrong | Visual decisions |
| Renaming a thing that misdescribes itself | Anything a user could have an opinion about |

**Verification changes what we KNOW. Product changes what the user GETS.**

### 6.2 Three kinds of question

| Kind | Who decides | Test |
|---|---|---|
| **Technical correctness** | Evidence | Is it measurably wrong? |
| **Product decision** | The owner | What should the app do? |
| **UX decision** | The owner | How should it feel to use? |

Engineering can answer the first. It can only *inform* the other two.

### 6.3 Two traps

- **A filed observation is not an authorisation.** A line in a postponed-items table records that
  someone noticed something. It does not say the answer is "change it".
- **"Go ahead" answers the question that was asked.** A concern was raised, approval was given, and it
  was read as approval for a design change when it was approval to *work the item*. Where a request
  could reasonably mean either, pin it down **before** building — afterwards the finished work applies
  pressure toward keeping it.

### 6.4 Record decisions where they will be tripped over

A decision recorded only in a comment gets missed. A settings panel that deliberately does not mirror
in RTL was filed as a defect, implemented, and reverted — because the intent was written nowhere.

Record it as a **test that fails** if the behaviour changes, and say in that test that it guards a
*preference*, not a correctness rule, so a future deliberate redesign updates it rather than fighting
it. See `tests/harness/rtl-panel.mjs`.

---

## 7 · Diagnostics

### 7.1 The subsystem is complete

No further improvement, polish or refinement. It is reopened **only** when: a real bug is found in it,
a real investigation needs a capability it lacks, or the owner asks. "While I was in here I noticed" is
not one of them.

### 7.2 A diagnostic must never invent a failure

A diagnostic that reports failures that did not happen costs the next investigation its time and then
its trust.

- The black-page autopsy declared a rendering failure when exported from the library — where no book
  was open. It now answers *"is there anything to judge?"* first and says **NOT APPLICABLE**.
- State stale by design (a closed book's document) must be **found and labelled**, never adopted as
  current evidence.

### 7.3 Instrumentation is compiled out, not switched off

A build whose diagnostic behaviour is decided at runtime can always be mistaken for the other kind.
Diagnostics are removed at compile time (Cargo feature + bundler substitution) so their absence is
**measurable**.

### 7.4 A diagnostic build must prove it is instrumented

The inverse failure is real: a tester once installed a diagnostic package and got a build with no
diagnostics in it. The verifier requires the markers to be **present**.

---

## 8 · Naming and traceability

- Every finding, fixture and harness names the work it belongs to: `WP-n`, `NAV-n`, `TRACK-n`,
  `PPC-n`, `FUTURE-n`. The rule is **traceability**, not the prefix — when a new class of work id
  appears, add it to the guard rather than disguising the artifact.
- Name a measurement for **what it counts**, not what you hope it means.
- A finding's title states the observation, not the presumed cause. "الشوقيات reports `paras: 1`" is a
  finding; "paragraph extraction is broken" is a conclusion smuggled into a title.

---

## 9 · Builds, IDs and packaging

Full mechanics live in `WORKFLOW.md`. The principles:

### 9.1 Identity is data, not convention

Two builds that differ only by which folder they were made in are indistinguishable the moment either
one is copied. Identity travels with the artifact: product name, executable name, bundle identifier,
version, package filename.

### 9.2 Every build carries a BUILD ID

`<KIND>-<utc stamp>-<git sha>[+N uncommitted]`. It is the **first thing to request** on any report,
before debugging begins. Generated once per build and injected into both the Rust core and the web
bundle, so a mismatch between them is measurable — that comparison answers "is this executable running
the frontend it was built with?", which nothing else can.

### 9.3 The verifier gates packaging

Nothing is packaged that has not proved what it is. The check runs *before* anything is staged, and
its exit code stops the script.

### 9.4 Stage into an empty directory

Never archive a folder in place, and never select an artifact by folder order.

> `readdirSync(...)[0]` is alphabetical. It chose `Sard_0.1.0_x64-setup.exe` — a build eleven weeks
> old — and packaged it as the current Beta. Only an unexpected file size caught it.

Derive the artifact name from the configuration being built, and require it to be **newer** than the
binary just verified.

### 9.5 Nothing archived may live in `public/`

Assets under `public/` are copied verbatim into the bundle and compiled into the executable.

> A 47 MB RAR of a previous Beta package sat there for two days. Every build in that window carried it
> inside its own binary — 72 MB instead of 24 MB — including one sent to a tester.

### 9.6 Channels do not borrow each other's rules

A private Beta is not a pre-release of the public channel. Designing its version number around an
updater it never talks to was a mistake made twice before it was recognised.

---

## 10 · Regression prevention

- A safety net that has never caught anything is unproven. Test it by **breaking the thing it guards**.
- A net that measures only one mode measures one mode. The byte-identity baseline recorded
  `columns: 1` for all 16 books because it had only ever captured **scrolled** rendering — so a defect
  that collapsed pagination produced a byte-identical fingerprint and shipped.
- Baselines go stale against settings, not just code. Record the configuration with the capture and
  report configuration drift as **"not a code change — re-baseline"**, distinct from a regression.
- Adopting a baseline means **re-capturing** it if it has drifted. A gate that fails for reasons nobody
  can act on is a gate people learn to ignore.

---

## 11 · Self-critique and post-mortems

### 11.1 Record the almost-bugs

The near-misses are more instructive than the successes, and they are invisible unless written down.
When an approach was wrong and got corrected, record **what it was, why it looked right, and what
caught it** — in the code, at the place it happened.

### 11.2 Classify the mistake, not just the instance

Fixing one occurrence leaves the class alive. Classes that recurred in this project:

| Class | How it shows up |
|---|---|
| **Believing an absence** | A search that could not read the file reports "clean" |
| **Failing open** | `if A … else if B …` stops covering anything when a C appears — this happened **three times** in one file after a third build kind was added |
| **The wrong instrument** | The measurement is real and about the wrong thing |
| **Selecting by convenience** | First-in-folder, first-match, alphabetical order |
| **Authorisation drift** | A filed observation or an ambiguous "go ahead" read as approval |

### 11.3 A post-mortem separates the delivery from the defect

> A user received a diagnostic build. The **delivery** was a stale cloud link. The **defect** was that
> the two builds were indistinguishable once separated from their folders.

Fixing the delivery would have fixed one incident. Fixing the defect fixed the class.

### 11.4 Report faithfully

If tests fail, say so with the output. If a step was skipped, say which. When something is done and
verified, say it plainly without hedging. Do not describe work as complete when part of it is blocked —
finish everything else and state exactly what was left and why.

---

## 12 · Documentation

### 12.1 Update the record when a decision is made

A decision that is not written down will be re-litigated, and usually re-made differently. When a rule,
lesson or principle is established:

1. Update **this handbook** if it is about *how work is done*.
2. Update **`WORKFLOW.md`** if it is about *branches, builds, packaging or release*.
3. Update the **item's own record** (`BETA-1.md`, the relevant plan) if it is about a specific finding.
4. Where the rule can be enforced, add the check — a failing test outlives a paragraph.

### 12.2 Keep status records honest

Stale status is worse than no status. A closed item still listed as open sends the next person to
re-investigate it; more than one item here was already understood and still marked unresolved.

When a section of a document is updated, check the **other** places that state the same fact. Updating
a limitations list and leaving the summary table stale has happened here.

### 12.3 Explain why, not only what

A rule without its reason is a rule that gets waived the first time it is inconvenient. Every entry in
this document carries the reason it exists.

---

## 13 · Working rhythm

### 13.1 Feature work

1. Understand the requirement, including what it is *not*.
2. Investigate the code it touches; state the architectural fit.
3. Get approval if product behaviour, UI or UX changes.
4. Implement the smallest correct version.
5. Measure before and after.
6. Run the gates: typecheck, unit suite, relevant harnesses.
7. Report honestly, including anything not done.

### 13.2 Investigation work

1. State the question precisely.
2. Establish what is already known, and its evidence tier.
3. Name the cheapest decisive experiment.
4. Measure. Validate the instrument first.
5. Attempt to falsify the result.
6. Report: facts → analysis → recommendation → alternatives → confidence.
7. **Do not implement a fix inside the investigation** unless it was asked for.

### 13.3 Cleanup is a milestone

Until Feature Freeze is declared, the answer to "should we tidy this?" is **no** — with one exception:
a mess that is *actively costing* something (a harness that corrupts data, a name collision that
misleads a person) is a defect, and defects are product work.

The cadence, the reasoning and the pre-merge checklist belong to `WORKFLOW.md`.

---

## 14 · Maintaining this document

**This handbook is a living document. It is expected to change as often as the project teaches
something.**

### 14.1 Update it in the same change that taught the lesson

Not afterwards, not in a cleanup pass. A lesson recorded a week later is already half lost; one
recorded nowhere is paid for twice. If a piece of work established a rule, the commit that did the
work also updates this file.

Update it whenever:

- a workflow rule or engineering principle is agreed,
- a mistake reveals a **class** of mistake rather than an instance,
- a decision is made that would otherwise be re-litigated later,
- a new instrument, harness pattern or verification technique proves itself,
- an existing rule turns out to be wrong.

### 14.2 Never duplicate a rule between documents

Each document owns its topic:

| Document | Owns |
|---|---|
| `WORKFLOW.md` | Branches, merge policy, build kinds, packaging, release |
| `docs/engineering/HANDBOOK.md` | How work is done: investigation, evidence, verification, harnesses, decisions, post-mortems |
| `BETA-1.md` and the item records | The status of specific findings |

If a rule belongs elsewhere, **point at it**; do not restate it. Two copies drift, and then the reader
has to guess which is current. This rule exists because both documents were written with nine
overlapping rules before anyone noticed.

### 14.3 Obsolete guidance is removed, not left standing

A rule that no longer holds is worse than no rule: it is followed by someone who does not know it was
superseded. When something changes, **edit or delete the old text** in the same change. Do not append a
correction below it and leave both.

The same applies to status: a closed item still listed as open sends the next person to re-investigate
it. When one place is updated, check the others that state the same fact.

### 14.4 Document principles, not incidents

An incident earns a place here only when it teaches a **reusable** lesson, and then it appears as the
principle with the incident as its one-line evidence — not as a story.

> ✗ "On 7 August a package was built from the wrong installer because …" *(three paragraphs)*
> ✓ "Never select an artifact by folder order. `readdirSync(...)[0]` is alphabetical and once chose a
>   build eleven weeks old."

If an incident teaches nothing reusable, it belongs in the commit message, not here.

### 14.5 Keep it short enough to be finished

A handbook nobody reads to the end protects nobody. Prefer a short rule with its one-line
justification over a passage of narrative. When a section grows past its usefulness, cut it rather
than letting the document become an archive.

Every rule states **why** it exists. A rule without its reason is waived the first time it is
inconvenient.

---

*The goal: someone reading only this document should understand exactly how engineering work is
expected to be performed on Sard.*
