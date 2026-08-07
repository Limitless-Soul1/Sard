# CHECKPOINT — 2026-08-07 · frozen, awaiting external evidence

**Internal engineering document.** Not for testers, not for users. Written so that work can resume
after an arbitrary gap without rereading any conversation.

| | |
|---|---|
| **State** | **FROZEN.** No further changes until the tester's evidence arrives. |
| **Blocking on** | One tester running the diagnostic package below and reporting the result. Tester is unavailable; no ETA. |
| **Tree** | `M:\eRawy`, branch `main`, HEAD `dd23765`. **Nothing committed** — by standing instruction. |
| **Rule in force** | Do not implement while waiting. Do not revive discarded hypotheses without new evidence. |

---

## 1. The blocking investigation — one tester received a non-diagnostic build

### 1.1 The report

Four testers installed the same diagnostic package. Three received working diagnostics. One did not:
no red export button, no diagnostic functionality, and the application "behaved exactly like an older
normal build."

**Owner correction, 2026-08-06 — binding:** that tester **installed and launched the new
`Sard-Setup.exe`**. They did **not** run an old `Sard-standalone.exe`. The standalone hypothesis is
**DISCARDED**. Do not try to make it fit. Revive only if new evidence brings it back.

### 1.2 Proven, measured — do not re-derive

- **Diagnostics have no runtime gate.** `diagStart()` is unconditional at `src/App.tsx:68`, inside
  `useEffect(…, [])`. No env var, no setting, no localStorage, no build flag. **Therefore: if the red
  button is absent, the running frontend is not the diagnostic one.** This is the single most useful
  fact in the investigation.
- **The shipped package was self-consistent** — installer SHA-256 matched `BUILD-INFO.txt` exactly.
- **`beforeBuildCommand: "npm run build"`** — `tauri build` regenerates `dist/`, so a stale frontend
  *inside* the exe is impossible.
- **The asset protocol returns no cache directives at all** — no `Cache-Control`, `ETag`,
  `Last-Modified`, `Expires`. Only CORS, CSP, content-type. Caching is therefore heuristic and
  machine-dependent.
- **`%LOCALAPPDATA%\com.sard.app\EBWebView` is keyed by bundle identifier, not install directory** —
  it survives uninstall and reinstall.
- **Three distinct builds all report version `1.1.0`** (public release, Beta-1, diagnostic), all from
  `dd23765`, and none surfaced a BUILD ID anywhere in the UI or in the exported report.
- **`pack-diag.mjs` does not build.** It copies whatever is at
  `src-tauri/target/release/bundle/nsis/Sard_1.1.0_x64-setup.exe` — hardcoded, version-named, never
  cleaned — and records the *source-tree* fingerprint. Nothing verifies the two correspond.
- **Installer facts, read from our own generated `src-tauri/target/release/nsis/x64/installer.nsi`:**
  - `INSTALLMODE "currentUser"` → `$LOCALAPPDATA\Sard`, `RequestExecutionLevel user`.
  - `Call RestorePreviousInstallLocation` — **the install directory is derived from registry
    history**, plus an explicit `$WixMode` branch for migrating from a previous MSI. We build MSI too
    (`bundle.targets: "all"`).
  - `CheckIfAppIsRunning` (`utils.nsh:22`) runs *before* the binary copy and either kills the process
    or **aborts loudly**. A running app therefore cannot silently leave a stale exe.
  - Residual hole: `FindProcessCurrentUser` only sees the current user's processes, and there is **no
    `IfErrors` after `File "${MAINBINARYSRCPATH}"`** (installer.nsi:638), so an unseen lock falls
    through to NSIS's generic Abort/Retry/**Ignore** — and *Ignore* completes the install with the
    old binary.
  - **Same-version reinstall page**: with `$R0 = 0` the default radio goes to `reinst_done` —
    proceeds **without uninstalling**.
- **Updater is enabled in diagnostic builds**, pointing at the public release channel
  (`tauri.conf.json` plugins.updater, `installMode: "passive"`). No tag above `v1.1.0` exists, so it
  cannot have fired — but it is a live hazard the moment 1.1.1 ships.

### 1.3 Eliminated

| | why |
|---|---|
| Standalone exe launched instead | Owner states the installer was used — **discarded** |
| Per-machine config disabled diagnostics | No gate exists in source |
| Stale `dist/` embedded in the exe | `beforeBuildCommand` rebuilds it |
| Stale installer inside the package | Three testers got working diagnostics from the same file |
| Missing packaged resources | Diagnostics live in the frontend bundle *inside* the exe, not in `resources/` |
| Updater replaced it with a release | No tag above v1.1.0 |
| App running during install → silent stale exe | Template aborts loudly |

### 1.4 Live hypotheses, ranked

| | hypothesis | needs a user mistake? |
|---|---|---|
| **M1** | Files landed in a **different directory** than the shortcut launches (`RestorePreviousInstallLocation` / `$WixMode`) | No |
| **M2** | **Stale frontend** served from the persistent WebView2 cache — new exe, old bundle | No |
| **M3** | Same-version reinstall + an unseen file lock + user clicked **Ignore** | Yes |
| **M4** | `diagStart()` **threw** (it is unguarded and runs *before* `initBackground()` / `registerOutcomeRecorder()` in the same effect) | No |
| **M5** | AV / Controlled Folder Access blocked the write | No |

**M1 and M2 lead** — neither requires the tester to have done anything wrong.

### 1.5 A failed discriminator — do not repeat it

Searching the binary for the export button's Arabic string returned **0 hits on both** a
known-diagnostic and a known-non-diagnostic executable. Tauri embeds frontend assets **compressed**,
so a plain string search has no discriminating power. Discarded, not treated as evidence.

---

## 2. The instrument built to settle it

### 2.1 Design constraint

If the tester runs an **older binary**, nothing added to the new build executes. A frontend-written
report cannot separate *"old binary ran"* from *"new binary ran, frontend dead"* — **both produce no
file**. So the record is written by **Rust at startup**, before the DB opens and before any frontend
code runs, and **absence of the file is itself evidence**.

### 2.2 What was added — diagnostic-only, four files

| file | change |
|---|---|
| `src-tauri/src/diag_startup.rs` **(new)** | The whole startup record. Panic-guarded; every failure swallowed |
| `src-tauri/src/lib.rs` | `pub mod diag_startup;`, **one** call in `setup()` (owner-approved), command registration |
| `src-tauri/src/commands/mod.rs` | `diag_startup_mark` — appends the frontend's section; computes nothing |
| `src/lib/diag.ts` | `startupMark()`, `frontendFacts()`, try/catch around `diagStart`'s body that **records and rethrows** |

**The rethrow is deliberate.** Swallowing would change behaviour on the machine under investigation.
This build observes that machine; it must not alter it.

The packaging change originally proposed was **dropped as unnecessary**: the record is
self-verifying — its existence proves the binary is a diagnostic build.

### 2.3 What the record contains

Written to `Documents\Sard Diagnostics\sard-startup-<epoch>.txt`:

exe path / installDir / size / mtime / **sha256** · install-directory listing (detects partial
deployment) · **other Sard executables** in the standard install roots, deduplicated on canonical path
· appDataDir / dbPresent / **webview2Version** · **EBWebView `Cache` / `Code Cache` / `Local Storage`**
file counts with newest+oldest mtime and a derived *"ENTIRELY OLDER THAN THE EXECUTABLE by Ns"*
comparison · a `FRONTEND HANDSHAKE — PLACEHOLDER` section that later `FRONTEND PHASE` sections
supersede.

Frontend phases append: `PHASE 1 ENTERED` → `PHASE 2 COMPLETED | EXCEPTION`, carrying
`liveDocumentAssets` vs `embeddedIndexAssets` (fetched `cache: "no-store"`, i.e. from *this* exe) and
`assetsMatch`, plus the export button's box and computed `display`/`visibility`/`opacity`/`zIndex`
and `windowInnerSize` / `devicePixelRatio`.

**Measured cost:** SHA-256 of the ~75 MB exe = **52–65 ms warm**.

**Two output defects were found and fixed during verification** (a misleading report is the exact
failure mode being eliminated): the same file was listed twice as two installs (case-insensitive
paths — now deduplicated), and the placeholder said `NOT REACHED` while being contradicted by
appended sections below it.

---

## 3. The package that is waiting to be sent

| | |
|---|---|
| **Archive** | `M:\Sard-Diagnostic\Sard-Diagnostic-20260806214427.rar` · 74,528,431 bytes |
| **Installer inside** | `Sard-Setup.exe` · 74,521,478 bytes |
| **BUILD ID** | `DIAG-20260806214427-dd23765` |
| **Source fingerprint** | `845F4673EFE4E1A6B3FD714738D8E22D786DEC57AD3ABAE08606BC2EB1BBD6C1` |
| **Installer SHA-256** | `14EA73A9E159B0C8CDDA6EE5FC10E2FA6A51F12EFEA06C6D243CC12FCB21C2B4` |
| **Bundled raw exe** | `sard.exe` · 75,323,392 B · SHA-256 `73de10887af3ff257ced3fbb0e2d22ae906513e2fef8a09bc88c82d7d02b88e4` |
| **Contents** | `Sard-Setup.exe`, `README.txt`, `BUILD-INFO.txt` |

**Verified:** built installer = package copy = BUILD-INFO = extracted-from-RAR, all identical;
archive integrity `All OK`; and the exact bundled binary was executed and produced a startup record
reporting its own hash with `PHASE 1 ENTERED` / `PHASE 2 COMPLETED`. The previous installer was moved
aside before building, so a failed build would have thrown rather than silently repackaging it.

**Reference copies that exist nowhere else:**
- `M:\eRawy\_prev-installer-20260806.exe.bak` — the **previously shipped** diagnostic installer,
  `BUILD ID DIAG-20260806034246-dd23765`, SHA-256 `44E0B6AA…41307F`. `pack-diag` wipes its output
  folder, so this backup is the only copy of what the other three testers are running. Untracked in
  git. **Do not delete without a decision.**
- `M:\Sard-Share\` — Beta-1, `BUILD ID 20260805181146-dd23765`, fingerprint `51792F55…`.

### 3.1 What the tester was instructed to do

`README.txt` in the package is the **older** one (dated 2026-08-06 06:32). It tells the tester to
press the red button — **which for this tester never appears**, so its instructions dead-end. The
instruction below was therefore supplied in the owner's covering message, not in the package:

> After installing, open Sard once and leave it ~20 seconds, then close it.
> Open `Documents\Sard Diagnostics` and send the newest file starting with **`sard-startup-`**.
> **If the folder is empty or there is no such file, say so — that answer is just as useful.**

---

## 4. Outcome → interpretation → next action

**Read the returned file against this table first. Do not re-open the investigation from scratch.**

| Evidence | Proven cause | Next action |
|---|---|---|
| **No `sard-startup-*.txt` at all** | The new build **never executed** | M1/M3/M5 territory. This is the one branch the instrument cannot narrow further, because nothing of ours ran. Next step becomes the **install-time marker** (`NSIS_HOOK_POSTINSTALL`) — previously **not approved**; re-propose with this evidence |
| `OTHER SARD EXECUTABLES` lists a second copy | **M1 — second installation** | Compare paths/hashes/dates; determine which the shortcut targets. Fix = unique version per build (P2) |
| Install dir missing `piper` or short on files | **Partial deployment** | AV/CFA investigation |
| File exists, **no `FRONTEND PHASE` section** | Binary ran, frontend never reached our code | Total frontend failure — new investigation, start at CSP/asset serving |
| `assetsMatch NO` | **M2 — stale WebView cache** | Fix = `Cache-Control: no-store` for the app shell (P3) |
| `status EXCEPTION` + stack | **M4 — init failure** | Fix at the named frame; also do P4 (guard `diagStart`) |
| `exportButton ABSENT` | Diagnostics ran, button never created | Inspect `installExportButton` mount timing |
| Button present but 0×0 / hidden / off-screen | **Rendering or scaling issue** — a cause not previously considered | New, narrow investigation |
| All green | Diagnostics worked | Re-examine the original report with the tester |

### 4.1 Preventive improvements already designed (none implemented)

| | change | eliminates |
|---|---|---|
| **P1** | Surface BUILD ID in the UI **and** in the diagnostic report | Makes the whole class tester-answerable. **The durable fix** |
| **P2** | Unique version per build (e.g. `1.1.0-diag.20260806214427`) | M1, M3 at the root; also the updater hazard |
| **P3** | `Cache-Control: no-store` for the app shell | M2 structurally |
| **P4** | try/catch `diagStart()` and move it *after* the product initialisers | M4, and a contract violation — a subsystem documented "observes, never intervenes" can currently break the user's background and the outcome recorder |
| **P5** | `pack-diag.mjs` must build, or verify the installer against the fingerprint | The latent staleness trap |
| **P6** | Disable the updater in diagnostic builds | The 1.1.1 hazard |
| **P7** | README: "you should see a red button — if not, tell us before testing" | Converts silent failure into an immediate report. **Zero code; would have caught this in one minute** |

---

## 5. Everything else, frozen in place

### 5.1 ResizeObserver storm — **APPROVED, NOT STARTED**

Root cause **proven causally**. Two teardown defects in vendored foliate leave live observations on
nodes in detached trees; Blink emits *"ResizeObserver loop completed with undelivered notifications"*
**once per animation frame, forever, without ever invoking the JS callback**:

```js
paginator.js:572   this.#observer.observe(this.#container)
paginator.js:1163  this.#observer.unobserve(this)      // `this` was never observed — NO-OP
paginator.js:427   destroy() { if (this.document) this.#observer.unobserve(this.document.body) }
                   // measured: unobserve() calls = 0 — the guard is falsy at teardown
```

Measured: `disconnect()` → **0 errors/8 s**; re-arm by opening another book → **240/s** again.
240.0/s at a 4.17 ms frame mean = exactly 1 per frame; the tester's 109/s is the same model at their
frame rate. **No measurable frame cost** (storm 4.17 ms mean vs 4.35 ms clean, zero frames >20 ms).
**No accumulation** (10 observers leaked, still 240/s).

**My retention hypothesis was REFUTED:** `disconnect()` on all 8 released Documents +0, Frames +0,
Nodes +0, Heap +0.0 MB.

**Justification for repairing is correctness + diagnosability, NOT smoothness** — it consumed
**3,807 of 4,326 events (88%)** of the tester's report and inflated it to 1.8 MB.

**Approved repair (A/F):** `disconnect()` in both `Paginator.destroy()` and `View.destroy()`, as
documented vendored **LOCAL PATCH 9**. Risk: `View.destroy()` currently no-ops, so this is a real
behaviour change on the teardown path — must be regression-tested, not assumed. Also an upstream
foliate bug; reporting it upstream is an open owner decision.

### 5.2 Separate defect found while measuring the above — **NOT INVESTIGATED**

Retention **is** real and is **not** the observers: **+2.25 Documents, +1.25 Frames, +953 Nodes,
+1.38 MB per open/leave cycle**, measured after forced GC, **with no read-aloud involved**. RAWY-286
recorded a control that *"a cycle whose Listen never started grew by exactly zero"* — **this
contradicts it.** Either a regression since, or a methodological difference. Own package.

### 5.3 Priority 2 — diagnostic subsystem defects, **NOT STARTED**

1. **Autopsy issues a false verdict when exported from the library.** It analyses a *detached* leftover
   document (`host size 0x0`, topmost `<header.lib-head>`, `lib-root` overlay) and prints
   *"THE DOCUMENT IS EMPTY"*. `black-screen.mjs` never caught it because its EMPTY control empties a
   **live** document. **Highest priority of the four — it will corrupt the next tester report.**
2. **Stale ledger reason.** Every EPUB stage 4–14 carries `reason = this book is a PDF …` while
   reporting real EPUB data. `renderDiagNotEpub()` (`renderDiag.ts:82`) stamps stages 2–14; a later
   successful `ok()` overwrites data but never clears the reason.
3. **Durations are session spans, not per-book** (EPUB stage 1 "50,613 ms" = first-open → last-open
   across four books). Same root cause as the bogus PDF "stage 8 = 14,614 ms" (the chain probe
   re-stamps; the ledger takes the *last* completion as `end` — the real import was **425 ms**).
4. **No BUILD ID in reports.** Same defect as P1.

### 5.4 Not started, previously assigned

- **Book cover replacement investigation** — first replacement usually succeeds, second often fails;
  some formats unexpectedly rejected. Full pipeline trace required before any repair.
- **Reader zoom feature study** — slider + Ctrl+Wheel, no reload, preserve position and pagination,
  no glitches, large-book performance. Multiple approaches to be compared on measured smoothness.

### 5.5 Closed this cycle

- **WP-6B** (NCX contents) and **WP-8** (invalid-XHTML fallback) — implemented, verified, **closed by
  owner**; do not reopen without new evidence.
- **PDF investigation** and **black-screen investigation** — closed by owner. Tester's evidence: PDF
  fetch 200 OK, 42,215,421 bytes, chain probe 7/7, no failure reproduced; no black page occurred;
  TTS tracking worked in both sessions.
- **FINDING-5 / PPC-3** — closed as an instrumentation artifact. ⚠ `BETA-1.md:106` and
  `REMEDIATION_PLAN.md` still list it as open. **Correct on resume.**

### 5.6 Open, owner's call

`PPC-1` inline `<style>` bypass · `PPC-2` paginated byte-identity baseline · `PPC-4` RTL typography
sliders · `PPC-5` adopt `resilience-1-final` baseline · `PPC-6` English UI audit (blocked, no
screenshot) · `PPC-7` metadata backfill · corpus scan (blocked, needs 200–500 mixed EPUBs) · spec-text
verification for AR-4 · consumer enumeration of `toc`/`tocSecMap`.

### 5.7 Housekeeping

- **Nothing committed.** 74+ changed paths, ~40 untracked. Cleanup/commit phase deferred by
  instruction.
- **VENDOR.txt numbering disagrees with the code comments** — code says PATCH 4/5/6 where the
  register says 5/6/7; only 8 agrees. A re-vendor would mislead. Direction of fix undecided.
- The vault (`M:\ProjectDocs\sard\`) and `M:\Sard Desktop\` contain **none** of the RESILIENCE-1
  campaign, WP-6B, WP-8, or any of this. Single point of failure.

---

## 6. Resume procedure

1. Read this file. Do not reread conversations.
2. If the tester's file arrived → §4 table → act on that row only.
3. If it did not → the queue is §5.1 (approved, ready), then §5.3 item 1, then §5.4.
4. Standing rules unchanged: investigate before implementing, measure before concluding, try to
   falsify first, label measured vs inferred vs judgement, keep scope tight, no commits.
