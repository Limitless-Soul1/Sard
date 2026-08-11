# Sard — AI Agent Development Rules

> **If you are an AI agent, coding agent, autonomous agent, or AI-assisted development tool working on
> Sard, you MUST read and follow this file before modifying the repository.**
>
> These rules are **mandatory, not suggestions.** They exist because Sard is an existing production
> application whose architecture, workarounds and release gates were paid for with real defects. Your
> job is correctness, not code volume.

[`WORKFLOW.md`](WORKFLOW.md) is the authoritative repository workflow. This file adds obligations that
apply specifically to AI agents working inside it.

**The operating loop:** UNDERSTAND → VERIFY → CHANGE MINIMALLY → TEST → REPORT → STOP WHEN UNCERTAIN.
Never GUESS → REWRITE → HOPE.

---

## 1. Repository and Git Safety

`main` is **production**. `develop` is the **integration branch**. AI agents do not bypass this workflow.

- AI agents **MUST NOT** commit directly to `main`.
- AI agents **MUST NOT** push directly to `main`.
- AI agents **MUST NOT** create pull requests targeting `main`. `main` is not a merge target — it is a
  published snapshot produced by the release process in [`WORKFLOW.md`](WORKFLOW.md).
- AI agents **MUST NOT** commit directly to `develop`.
- Changes are normally made on a dedicated `feature/*` or `fix/*` branch created from `develop`.
- Pull requests target `develop`.
- **Do not push unfinished work** to use GitHub as remote storage or backup. A branch is pushed when the
  work is complete, tested and ready for someone else to read.
- **Do not push, open a PR, merge, tag, release, or modify protected branches** unless the workflow
  explicitly allows it *and* the required human approval has been given.

Read access is not permission to push. Treat every remote operation as a controlled action.

Additionally, never force-push, never rewrite shared history, never move a published tag, never delete
branches, and never run destructive Git commands (`reset --hard`, `clean -fd`, `checkout --` over
uncommitted work) without explicit human authorisation. Inspect `git status` before you begin: if the
working tree contains unrelated changes, **preserve them and report** rather than working over them.

Stage files by name. Never `git add -A`.

---

## 2. One Task = One Responsibility

**Every PR must have ONE clear purpose.**

- A feature PR implements that feature.
- A bug-fix PR fixes that bug.
- A refactoring PR performs that refactoring.
- A documentation PR changes documentation.

An AI agent **MUST NOT** silently combine unrelated work into the same PR. If asked to fix TTS overlap,
do not also redesign unrelated UI, refactor unrelated components, fix unrelated navigation bugs, update
unrelated dependencies, or reorganise unrelated files — unless those changes are strictly required for
the requested fix.

If you discover another unrelated problem: **document it, report it separately, and leave it out of the
current PR.**

A human should be able to read the PR title and know exactly what it changes.

---

## 3. Understand Before Modifying

Do not modify code blindly. Before implementing:

1. Read the relevant documentation.
2. Understand the repository structure.
3. Inspect the existing implementation.
4. Identify the relevant architecture and dependencies.
5. Understand the current behaviour.
6. Reproduce the problem when possible.
7. Form a hypothesis before changing code.
8. Make the smallest appropriate change.
9. Validate the result.

**Do not treat a user's description of a bug as proof of its root cause.** Do not call something a root
cause merely because it is consistent with the symptoms.

**Do not change architecture because a different architecture appears cleaner.** Prefer repair over
rewrite.

Sard contains deliberate historical fixes. A seemingly redundant timer, guard, retry, state variable,
workaround or branch may exist because it fixed a real regression — many carry an issue reference and an
explanatory comment. **Read the comment. Never remove such logic without proving it obsolete.**

Search for all call sites before changing an API. Understand why existing code exists before replacing it.

---

## 4. Testing Is Mandatory

**An AI agent MUST NOT open a PR merely because the code compiles, unit tests pass, or the
implementation looks correct.** None of those is evidence that the changed behaviour works.

Where practical, a PR should be tested by a real human.

You must clearly distinguish:

- tests performed by the AI agent;
- tests performed by a human;
- tests performed in CI;
- tests that could not be performed, and why.

Testing must cover **the actual behaviour being changed**, not only unrelated automated tests. Exercise
the application as a user would when practical:

- launch the application;
- exercise the affected feature;
- test normal behaviour;
- test important edge cases;
- test failure and recovery behaviour;
- verify unrelated functionality still works.

A PR is not ready because automated tests pass. Test it the way CI will run it — a clean checkout has no
generated fixtures and none of your local state.

---

## 5. Human Verification

Whenever practical, the PR should require a real human verification step. Include a section such as:

```markdown
### Human verification
- [ ] Tested by a human
- [ ] Feature/fix works as expected
- [ ] No obvious regression observed
```

**Explain exactly what the human should test. Never ask a human to "test everything."** Give concrete,
ordered steps with the expected result at each one.

---

## 6. PR Evidence

Every PR must explain what changed and provide evidence of the **result**, not merely the code.

For UI-visible work, include screenshots, recordings or other visual evidence whenever possible:

```
Before: [screenshot]
After:  [screenshot]
```

For bugs: show the previous behaviour when practical, show the corrected behaviour, and explain what
changed.

For non-visual changes, provide test output, logs, benchmark results, artifact inspection, command
output, or a concise technical explanation.

Do not present an inference as a measurement. Label claims **FACT** (directly verified), **INFERENCE**
(supported but not observed), or **UNKNOWN**.

---

## 7. Local Files and Examples

If a change requires local files, configuration, sample data, assets, books, models or other local
resources, the PR must say so clearly. **Do not assume the reviewer has those files.**

State: what resource is required · where it goes · what format it must be · how to reproduce the test ·
whether it is in the repository or must be obtained separately.

Provide a small, safe example or fixture whenever possible.

**Never commit private, sensitive, personal, proprietary or machine-specific files merely to make a PR
easier to test.** See §11 and the `private/` rule in [`WORKFLOW.md`](WORKFLOW.md).

---

## 8. PR Body

PR descriptions must be clear, concise and easy for a human to review. Answer:

1. What changed?
2. Why was it needed?
3. How was it tested?
4. What should the reviewer verify?
5. Are there known limitations or remaining risks?

Avoid unnecessary jargon, long narratives, repeated information, giant pasted logs, and unnecessary
implementation detail. If detailed technical evidence is needed, **summarise it and reference the
investigation** rather than making the PR body unreadable.

---

## 9. Performance Testing

When a change could affect performance, measure it when reasonably possible: startup time · memory
usage · CPU usage · GPU usage · rendering performance · playback latency · TTS latency · database
performance · file loading time · bundle size · build time.

Report **before vs after** with meaningful measurements.

**Never invent performance claims.** Never say "faster" or "smoother" without a measurement. If
performance testing is not practical, state explicitly that it was not performed.

---

## 10. Regression Testing

Every PR must consider regression risk. Identify what existing behaviour could be affected and test
those paths.

For platform-specific changes, verify the affected platforms explicitly. If modifying Linux behaviour:
verify Linux · determine whether Windows/macOS share the affected code path · protect existing behaviour
on other platforms · document exactly what was and was not tested.

Classify each change: `LINUX-SPECIFIC` · `WEBKIT-SPECIFIC` · `WINDOWS-SPECIFIC` · `SHARED` ·
`PLATFORM-ABSTRACTED`. Before changing shared code, prove the behaviour is actually shared.

**Never claim cross-platform safety without evidence or a clear technical justification.** Never fix one
platform by breaking another.

---

## 11. Keep Diagnostics Out of Production

Temporary diagnostic instrumentation is permitted during investigation when necessary. But diagnostic
logging, test harnesses, investigation scripts, internal reports, temporary instrumentation and
experimental files **must not become part of a production release.**

Remove temporary diagnostics before the PR is considered ready, unless they are intentionally part of
the product and that intent is stated.

This must remain consistent with the production-boundary rules in [`WORKFLOW.md`](WORKFLOW.md): the
release audits, builds and ships **the same tree**; two automated gates — one over paths, one over
contents — enforce what `main` may contain; and `private/` never leaves the machine and is never
referenced from public code or documentation.

**Never weaken, disable or bypass a production gate for convenience.** Never assume a file is safe
merely because its path was not explicitly excluded.

---

## 12. Minimal and Focused Changes

Prefer the smallest change that correctly solves the problem. Do not rewrite working systems · refactor
unrelated code · rename unrelated files · reformat unrelated files · update dependencies without reason ·
modify unrelated configuration.

A larger change is acceptable only when you can explain why the smaller change is insufficient.

---

## 13. Stop and Ask When Necessary

Stop and ask a human instead of guessing when:

- requirements are ambiguous;
- two repository rules conflict;
- a destructive operation is required;
- credentials or secrets are required;
- a protected branch would be affected;
- an unrelated issue would need to be changed;
- the correct behaviour cannot be established safely;
- you would need to weaken an existing safety rule;
- you cannot adequately validate the result.

**Do not silently make important product or repository policy decisions.** Do not resolve uncertainty by
making a large change. If evidence is insufficient, stop at diagnosis and report what is needed.

If you conclude the architecture is insufficient, document **CURRENT ARCHITECTURE · OBSERVED LIMITATION ·
EVIDENCE · ALTERNATIVES · RISKS · RECOMMENDED CHANGE** and stop. Do not introduce a new abstraction
unannounced.

---

## 14. PR Readiness Checklist

- [ ] Correct branch created from `develop`
- [ ] PR has one clear responsibility
- [ ] Relevant documentation was read
- [ ] Existing implementation was understood
- [ ] Root cause was investigated where applicable
- [ ] Implementation is complete
- [ ] Automated tests pass
- [ ] Actual feature/fix was manually exercised where practical
- [ ] Human verification instructions are provided
- [ ] Screenshots/recordings/evidence are included when useful
- [ ] Required local files/examples are documented
- [ ] Performance was measured when relevant
- [ ] Regression risks were considered
- [ ] Temporary diagnostics were removed
- [ ] No unrelated changes are included
- [ ] No private or machine-specific material is included
- [ ] PR body is concise and understandable
- [ ] Known limitations are documented
- [ ] CI-relevant testing has been considered

---

## 15. Relationship With `WORKFLOW.md`

[`WORKFLOW.md`](WORKFLOW.md) remains the authoritative repository workflow for branches, releases,
production snapshots, and release safety.

`AGENTS.md` adds mandatory instructions specifically for AI agents working within that workflow.

**If an AI agent encounters a conflict between the two, it must stop and ask for clarification rather
than choosing whichever rule is more convenient.**
