# Sard — Cross-platform & Mobile Handoff

**Purpose:** let a new session locate every cross-platform and mobile plan **on disk** and continue
without guessing. Written 2026-08-07.

> ⚠ **CRITICAL SCOPE NOTE.** The plan files listed below were located and enumerated on disk during
> this task. Their **contents were NOT read in this session** — only their paths, structure and
> self-describing titles were verified. Every statement about what a document *decides* is therefore
> marked **UNVERIFIED (title-level)** unless it is corroborated by the repository itself.
> **A new session must read the actual documents before acting on them.**

---

## 1 · Where the plans live

Sard's forward planning is deliberately kept **outside the source tree**, in three locations:

| Location | What it is | Verified |
|---|---|---|
| `M:\Sard Desktop\` | **Cross-platform (Linux/macOS) workspace** — 40 Markdown files, ADR-based | ✔ enumerated |
| `M:\Sard Mobile\` | **Mobile (Android/iOS) workspace** — 44 Markdown files, ADR-based | ✔ enumerated |
| `M:\ProjectDocs\sard\` | **General documentation vault** — state, decisions, lessons, evidence | ✔ enumerated |
| `M:\eRawy\` | The repository. Holds a few *superseded* in-repo studies | ✔ |

Both workspaces use the same numbered structure: `00-foundations`, `10-…`, `20-…`, `30-…`,
`40-decisions` (ADRs), `50-policies`, `60-knowledge`, `70-roadmap`, `80-operations` (desktop only),
`90-meta`, plus `INDEX.md` and `README.md`. **Start with `INDEX.md` in either workspace.**

---

## 2 · Existing Plan Files

### Cross-platform — `M:\Sard Desktop\` (CANONICAL for Linux/macOS)

| Area | Exact path | Purpose | Status |
|---|---|---|---|
| Entry | `M:\Sard Desktop\INDEX.md`, `README.md` | Workspace index | **Read first** |
| Foundations | `00-foundations\01-what-this-workspace-is.md`, `02-desktop-philosophy.md`, `03-independent-review-of-prior-conclusions.md` | Scope, philosophy, review of earlier conclusions | Canonical |
| Current state | `10-current-state\01-architecture-as-built.md`, `02-subsystem-portability-inventory.md`, `03-dependency-analysis.md`, `04-windows-specific-surface.md` | **What is reusable vs Windows-bound** | Canonical |
| Linux | `20-platform\01-linux.md` | Linux plan | Canonical |
| macOS | `20-platform\02-macos.md` | macOS plan | Canonical |
| Windows | `20-platform\03-windows-preservation.md` | Not regressing Windows | Canonical |
| Architecture | `30-architecture\01-target-architecture.md`, `02-abstraction-strategy.md`, `03-rendering-engine-compatibility.md`, `04-tts-strategy.md` | Target design, seams, engine compatibility, TTS | Canonical |
| Policies | `50-policies\01-development-rules.md`, `02-verification-policy.md`, `03-platform-parity-policy.md` | How the stage is worked | Canonical |
| Knowledge | `60-knowledge\01-risk-register.md`, `02-open-questions.md` | Risks and unknowns | Canonical |
| Roadmap | `70-roadmap\01-roadmap-and-phases.md`, `02-validation-gates.md` | Phases and gates | Canonical |
| Operations | `80-operations\01-packaging-strategy.md`, `02-release-and-update-strategy.md`, `03-testing-strategy.md` | Packaging, updates, testing | Canonical |
| Meta | `90-meta\01-maintaining-this-workspace.md`, `02-changelog.md` | Upkeep | Canonical |

**Desktop ADRs — `M:\Sard Desktop\40-decisions\`** (titles verified on disk; **contents unread**):

| ADR | File |
|---|---|
| 0001 | `ADR-0001-tauri-2-remains-the-desktop-shell.md` |
| 0002 | `ADR-0002-no-crate-split-before-mobile.md` |
| 0003 | `ADR-0003-three-seams-no-service-layer.md` |
| 0004 | `ADR-0004-edge-primary-platform-speech-offline.md` |
| 0005 | `ADR-0005-piper-is-retired-not-removed-first.md` |
| 0006 | `ADR-0006-native-window-decorations.md` |
| 0007 | `ADR-0007-linux-engineering-first-macos-release-first.md` |
| 0008 | `ADR-0008-appimage-first-flatpak-deferred.md` |

### Mobile — `M:\Sard Mobile\` (CANONICAL for Android/iOS)

| Area | Exact path | Purpose | Status |
|---|---|---|---|
| Entry | `M:\Sard Mobile\INDEX.md`, `README.md` | Workspace index | **Read first** |
| Foundations | `00-foundations\01-what-sard-is.md`, `02-design-and-reading-philosophy.md`, `03-offline-first-and-privacy.md`, `04-long-term-vision.md` | Product identity, privacy stance, vision | Canonical |
| Desktop baseline | `10-desktop-baseline\00-how-to-use-this-section.md`, `01-feature-inventory.md`, `02-reading-engine.md`, `03-typography-and-themes.md`, `04-annotations-and-references.md`, `05-read-aloud.md`, `06-library-import-and-data.md` | **Mirrored from desktop** — the baseline mobile must meet | Mirror (desktop is source) |
| Architecture | `20-architecture\01-system-overview.md`, `02-frontend-and-state.md`, `03-rust-core-and-ipc.md`, `04-database-and-schema.md`, `05-audio-and-tts-architecture.md`, `06-repository-map.md` | Shared architecture | Canonical |
| **Mobile design** | `30-mobile\01-mobile-philosophy.md`, `02-interaction-model.md`, `03-platform-equality-and-divergence.md`, `04-mobile-architecture.md`, `05-native-service-layer.md` | **The mobile-specific plan** | Canonical |
| Policies | `50-policies\01-rust-gravity-policy.md`, `02-development-rules.md`, `03-verification-policy.md` | How mobile work is done | Canonical |
| Knowledge | `60-knowledge\01-inherited-decisions-and-constraints.md`, `02-lessons-learned.md`, `03-risk-register.md`, `04-open-questions-and-opportunities.md` | Constraints, risks, unknowns | Canonical |
| Roadmap | `70-roadmap\01-roadmap-and-milestones.md`, `02-validation-gates.md` | Milestones and gates | Canonical |
| Meta | `90-meta\01-maintaining-this-documentation.md`, `02-templates.md`, `03-changelog.md` | Upkeep | Canonical |

**Mobile ADRs — `M:\Sard Mobile\40-decisions\`** (titles verified; **contents unread**):

| ADR | File |
|---|---|
| 0001 | `ADR-0001-tauri-2-as-the-mobile-architecture.md` |
| 0002 | `ADR-0002-alternatives-considered-and-rejected.md` |
| 0003 | `ADR-0003-rust-gravity.md` |
| 0004 | `ADR-0004-edge-tts-primary.md` |
| 0005 | `ADR-0005-mobile-is-not-a-port.md` |
| 0006 | `ADR-0006-shared-reading-engine.md` |
| 0007 | `ADR-0007-android-and-ios-are-equal.md` |
| — | `README.md` |

### Documentation vault — `M:\ProjectDocs\sard\`

| File | Purpose | Status |
|---|---|---|
| `STATE.md` | **Hot layer, ~4 KB — read to start any task.** Its own header forbids reading `archive\PROJECT.md` (1.6 MB) | Canonical, but ⚠ **stale as of 2026-08-04** |
| `DECISIONS.md` | Decision log | Canonical |
| `LESSONS.md` | Accumulated rules (incl. the PowerShell/Arabic corruption rule) | Canonical |
| `HISTORY.md` | Narrative history | Canonical |
| `ENGINEERING-CONTRACT.md` | The engineering contract | Canonical |
| `OPEN.md`, `FEEDBACK-BACKLOG.md`, `SARD-BACKLOG-V3.md` | Open items and backlog | Canonical |
| `SETTINGS-INVENTORY.md`, `LISTENING-BASELINE.md`, `LISTENING-OUTCOMES.md`, `SHARE-RELEASE.md`, `RAWY-197-report.md` | Subsystem inventories and reports | Supporting |
| `WORKFLOW.md` | **Mirror of the repo workflow doc** (copied 2026-08-07, 614 lines) | Mirror |
| `Reports\`, `Evidence\`, `DB-Snapshots\`, `Corpus\`, `Designs\`, `Notes\`, `Tools\`, `Secrets\`, `archive\` | Evidence and support | Supporting |

### In-repository studies — `M:\eRawy\` (mostly SUPERSEDED)

| File | Purpose | Status |
|---|---|---|
| `DESKTOP_CROSSPLATFORM_PLAN.md` | Early cross-platform plan | ⚠ **SUPERSEDED by `M:\Sard Desktop\`** |
| `NEXT_STAGE_STUDY.md` | Next-stage study | Historical |
| `PROJECT_MASTER_SUMMARY.md` | Master summary — useful orientation while `STATE.md` is stale | Supporting |
| `EPUB_COMPATIBILITY_STUDY.md`, `TOC_SINGLE_CHAPTER_INVESTIGATION.md` | EPUB investigations | Historical |
| `LIBRARY_COMPATIBILITY_AUDIT.md`, `UX_AND_PDF_STRESS_AUDIT.md`, `PDF_FEATURES_RAWY-291.md` | **This session's audits** | Current |
| `BETA-1.md`, `REMEDIATION_PLAN.md`, `CHECKPOINT-2026-08-07.md`, `BUILD.md` | Beta, remediation, checkpoint, build notes | Current |

---

## 3 · Canonical source per area

| Area | Canonical | Superseded / supporting |
|---|---|---|
| Cross-platform (Linux/macOS) | `M:\Sard Desktop\` | `M:\eRawy\DESKTOP_CROSSPLATFORM_PLAN.md` |
| Linux | `M:\Sard Desktop\20-platform\01-linux.md` | — |
| macOS | `M:\Sard Desktop\20-platform\02-macos.md` | — |
| Android | `M:\Sard Mobile\` (`30-mobile\`, `40-decisions\`) | — |
| iOS | `M:\Sard Mobile\` (same) | — |
| Mobile architecture | `M:\Sard Mobile\30-mobile\04-mobile-architecture.md`, `05-native-service-layer.md` | — |
| Mobile TTS | `M:\Sard Mobile\20-architecture\05-audio-and-tts-architecture.md` + `ADR-0004-edge-tts-primary.md` | — |
| Desktop TTS (cross-platform) | `M:\Sard Desktop\30-architecture\04-tts-strategy.md` + `ADR-0004`, `ADR-0005` | — |
| PDF | `M:\eRawy\PDF_FEATURES_RAWY-291.md`, `UX_AND_PDF_STRESS_AUDIT.md`, `docs\engineering\PROJECT_HANDOFF.md` §7–8 | — |
| EPUB compatibility | `M:\eRawy\LIBRARY_COMPATIBILITY_AUDIT.md` | `EPUB_COMPATIBILITY_STUDY.md` |
| Process | `M:\eRawy\docs\engineering\WORKFLOW.md` | vault mirror |
| Method | `M:\eRawy\docs\engineering\HANDBOOK.md` | — |
| Project state | `M:\eRawy\docs\engineering\PROJECT_HANDOFF.md` | vault `STATE.md` (stale) |

---

## 4 · Platform status

**PROVEN from the repository** (this is the only platform evidence in the code):

| Platform | Status | Evidence |
|---|---|---|
| **Windows** | **IMPLEMENTED and shipping** | v1.1.0; Tauri 2 + WebView2; `.github/workflows/release.yml` runs on `windows-latest` only |
| Linux | **PLANNED** — not built | Only `M:\Sard Desktop\20-platform\01-linux.md`; no CI, no Linux target in the repo |
| macOS | **PLANNED** — not built | Only `M:\Sard Desktop\20-platform\02-macos.md`; no CI |
| Android | **PLANNED** — not built | Only `M:\Sard Mobile\`; no `src-tauri/gen/android`, no mobile CI |
| iOS | **PLANNED** — not built | Only `M:\Sard Mobile\`; no iOS project |

**UNVERIFIED (title-level only, from ADR filenames — read the documents before relying on any of it):**
Tauri 2 as both the desktop shell and the mobile architecture; no crate split before mobile; three
seams rather than a service layer; Edge TTS primary with platform speech offline; Piper retired but
not removed first; native window decorations; Linux engineering-first / macOS release-first; AppImage
first with Flatpak deferred; Rust gravity; mobile is not a port; shared reading engine; Android and
iOS treated as equal.

**Not found anywhere on disk during this search — treat as UNKNOWN, not as decided:** any App Store /
Google Play submission checklist, code-signing/notarisation procedure for macOS, Android keystore
policy, or licensing analysis for neural voices. If these exist they were not in the three locations
enumerated above.

---

## 5 · Stage status

**PROVEN from project memory and repository state:** the **desktop cross-platform stage is the active
one**; the **mobile stage is PAUSED**. The current session's work was neither — it was Windows PDF
stabilisation. Nothing in the repository has been changed for Linux, macOS, Android or iOS.

⚠ One recorded note says "Piper removed" in an older memory; the desktop workspace's
`ADR-0005-piper-is-retired-not-removed-first.md` indicates that was **reversed to scope-then-retire**.
Piper **is still bundled** — `scripts/build-test.mjs` copies `test-build/piper` on every build
(PROVEN, observed in build output this session). Do not act on the older note.

---

## 6 · Workflow for cross-platform / mobile work

Identical to all Sard work — see `docs/engineering/WORKFLOW.md`:

- Development happens on **`develop`** in `M:\eRawy`. `main` is a published snapshot, never a merge
  target. **`develop` must never be pushed to `origin`** (the public repo).
- Verification is against the **real binary** (`npm run build:test` → harnesses in `tests/harness/`),
  never against intent.
- Commits describe the change; housekeeping is exactly `Repository maintenance`; **no assistant or
  vendor references anywhere**.
- Product/UI/UX changes require the owner's approval; verification does not.
- The plan workspaces (`M:\Sard Desktop\`, `M:\Sard Mobile\`) are **outside the repository** — edits
  there are not version-controlled by this repo. Each has `90-meta\01-maintaining-this-*.md` and a
  changelog; follow them.

---

## 7 · Final handoff

**PROVEN**
- Windows is the only implemented platform (v1.1.0, WebView2, Windows-only CI).
- 40 cross-platform documents at `M:\Sard Desktop\`; 44 mobile documents at `M:\Sard Mobile\`; both
  ADR-structured with `INDEX.md` entry points.
- Piper is still bundled by the build.
- The vault's `STATE.md` is the intended hot-layer entry point and forbids reading the 1.6 MB archive.

**IMPLEMENTED** Windows desktop only. No Linux, macOS, Android or iOS code exists in the repository.

**PLANNED** Linux, macOS, Android, iOS — documented, not built.

**BLOCKED** Mobile stage is paused by decision. The current release blocker is unrelated (PDF TTS
audio — `PROJECT_HANDOFF.md` §8).

**UNVERIFIED** Everything the ADRs decide (titles read, contents not); store/licensing/signing
constraints; whether `M:\eRawy\DESKTOP_CROSSPLATFORM_PLAN.md` conflicts with the newer workspace;
the staleness extent of vault `STATE.md`.

**The next session should, in order:**
1. Read `M:\Sard Desktop\INDEX.md` and `M:\Sard Desktop\40-decisions\` (all 8 ADRs).
2. Read `M:\Sard Desktop\10-current-state\02-subsystem-portability-inventory.md` — the reusable-vs-
   Windows-bound split.
3. If mobile: read `M:\Sard Mobile\INDEX.md`, `30-mobile\`, and all 7 mobile ADRs.
4. Reconcile `M:\eRawy\DESKTOP_CROSSPLATFORM_PLAN.md` against the workspace and mark it superseded
   in-place if it conflicts.
5. Only then propose architectural work.

**Must not be accidentally reversed:** Tauri 2 as the shell (ADR-0001 both workspaces); mobile is not
a port (mobile ADR-0005); Android and iOS are equal (mobile ADR-0007); Piper retired **not removed
first** (desktop ADR-0005); repository neutrality; `develop` never pushed to `origin`.
