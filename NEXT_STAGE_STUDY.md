# Sard — what the next engineering stage should be

**An independent study.** Commissioned 2026-08-04. No implementation.

| | |
|---|---|
| **Question asked** | What should the next major development stage be? Is it macOS and Linux? |
| **Evidence base** | `M:\eRawy` @ `dd23765` (source, read directly) · `PROJECT_MASTER_SUMMARY.md` · `M:\Sard Mobile\` (44 docs, ADR-based) |
| **Standing constraints honoured** | Engineering Contract (measure-then-fix, behaviour preservation, before→after) · D30 (book content never executes script) · D44 (a general reader) · ADR-0001…0007 |
| **Given as settled** | Tauri 2 · mobile will exist · desktop and mobile UIs differ · Rust becomes the centre of gravity · one shared architecture · **Piper is permanently out** |
| **Everything labelled** | `[MEASURED]` = I read it or ran it. `[INFERRED]` = reasoning from measured facts. `[HYPOTHESIS]` = untested. |

---

## 0. The recommendation in one page

> **The next stage is not "macOS and Linux". It is: *remove the sidecar, then prove the reading engine
> on WebKit* — and Linux comes before macOS, not beside it.**

Your intuition points at the right region of the map. The sequence inside it is wrong, and one item
that belongs at the very front is missing from every document I read.

**The recommended order:**

| # | Milestone | Why it is here and not later | Effort `[INFERRED]` |
|---|---|---|---|
| **P0** | **The WebKit probe** — a throwaway Linux CI build that opens one real book | Answers the project's single largest unknown for **≈ $0 and ≈ 1 week**, on hardware you already own. It gates P0→M2 *and* it is mobile validation Gate 1 + Gate 2, answered months early | 1–2 wk |
| **M1** | **Remove Piper** | It is the only per-platform native binary in the tree. Porting before deleting means building an ONNX/eSpeak sidecar for 3 OSes × 2 architectures and then throwing it away | 2–4 wk |
| **M2** | **Linux** | foliate-js's *reference* engine is WebKitGTK. Free CI, no hardware, no account, no notarisation | 3–5 wk |
| **M3** | **macOS** | Every prerequisite (Mac, Apple account, notarisation, a WebKit inspector harness) is a **mobile** prerequisite pulled forward, not a new cost | 5–8 wk |
| **M4** | **The Tauri-free `sard-core` crate** | *After*, not before. Drawn on three platforms' worth of measured evidence instead of imagination | 3–5 wk |

**Running in parallel, blocking nothing:** Windows code signing · verifying the v1.1.0 → v1.2.0
in-app update path · the orphaned-`settings` cascade fix · font subsetting to WOFF2.

**Total: 12–20 weeks** (16–26 if offline speech is replaced rather than dropped) — against the mobile
programme's own estimate of **35–52 weeks**. Roughly **60% of this work is a mobile prerequisite
anyway**. `[INFERRED]`

**What I recommend against:** extracting the core first, building platform abstractions first, a
desktop cleanup pass first, and treating "macOS and Linux" as one unit. Reasons in §3.

---

## 1. Five findings that change the shape of the question

Everything in §0 follows from these. Each was measured against the tree, not taken from a document.

### 1.1 The reading engine's security patch is a WebKit workaround, removed

This is the most consequential thing I found, it is on the critical path of **every** remaining
platform, and **it appears in none of the four validation gates.**

`public/foliate-js/paginator.js:242` — verbatim, Sard's own comment: `[MEASURED]`

> *"Sard patch (RAWY-64, security): upstream sets `allow-scripts` here **only to work around a WebKit
> event-dispatch bug (bugs.webkit.org #218086)** — Sard ships on WebView2 (Chromium), a different
> engine, and doesn't need book content to execute script at all…"*

The same patch is at `fixed-layout.js:84`, described as *"a WebKit-only event workaround Sard's
Chromium/WebView2 runtime doesn't need."*

Read that back with a Linux, macOS or iOS build in mind:

- Upstream sets `allow-scripts` **because WebKit needs it** for events to dispatch into the frame.
- Sard removed it **because Chromium does not** — a correct decision, on Chromium.
- macOS is WKWebView. Linux is WebKitGTK. iOS is WKWebView.
- Every event Sard's reader depends on — `pointerdown`, `pointerup`, `wheel`, `keydown`, selection —
  is wired from parent-context code into that frame.

So the project has a **structural collision between D30 ("book content must never execute script,
full stop" — a verified live code-execution path) and all three remaining WebKit targets**, sitting
in the single most load-bearing file of the reading engine. `[MEASURED — the conflict. HYPOTHESIS — whether 218086 still bites in 2026 WebKit.]`

The bug may well be fixed upstream by now; WebKit has moved a great deal since 2020. **That is
exactly why this is worth an afternoon rather than a quarter.** The cost of finding out is one Linux
CI run. The cost of *not* finding out is discovering it after a front end has been built on it — the
precise failure mode Gate 1 exists to prevent, aimed at the wrong target.

> **This is the single highest-information, lowest-cost action available to the project today.**

The mobile workspace's Gate 1 asks about *columnisation* and Gate 2 about *selection reaching
`rectInParent`*. Both are downstream of this. If events do not dispatch, neither gate is reachable.

### 1.2 The core is already portable — "extract the core first" is solving a solved problem

`[MEASURED]` at `dd23765`:

| Module | LOC | Status |
|---|---|---|
| `audio_identity.rs` | 364 | `#![cfg(target_os = "windows")]` at file level **and** gated in `lib.rs:8` |
| `window_chrome.rs` | 86 | `#[cfg(target_os="windows")]` + an explicit `#[cfg(not(...))]` no-op command |
| `webview_chrome.rs` | 61 | Same — `pub fn harden(_window) {}` on non-Windows |
| **Total Windows-specific** | **511 / 6,071 (8.4%)** | **All three already gated. All three already have fallbacks.** |

The Windows crates are already scoped under `[target.'cfg(windows)'.dependencies]`. The only ungated
Windows dependency in the whole core is `Command::new(eng.join("piper.exe"))` at `tts.rs:183` — which
**M1 deletes**.

The mobile roadmap lists architecture milestone **A1 — "the Windows-specific modules are `cfg`-gated;
the desktop build is provably byte-identical"** as Stage 1 work. `[MEASURED]` **A1 is already done.**
Its remaining content is a verification run, not a project.

The extraction that *would* have value is different: splitting `sard_lib` into a Tauri-free
`sard-core`. That is worth doing — but its value is (a) testing without an `AppHandle`, (b) hosting
the core from a native shell **if Gate 1 fails**, (c) giving Rust Gravity migrations somewhere to land
that is not coupled to the UI framework. All three are hedges against a gate nobody has run.

> **Run the gate. Then draw the crate boundary on what the gate found.** Extracting first means
> guessing where the seam goes, then discovering on three platforms that you guessed wrong — and
> doing it under a contract that forbids architectural rewrites without measured benefit.

### 1.3 Deleting Piper deletes the *only* copyleft dependency in the tree

`NOTICE:19` states the licence position plainly: `[MEASURED]`

> *"Sard bundles eSpeak NG, which is GPL-3.0-or-later… Distributing that binary means the work it is
> conveyed with must be under a GPL-compatible licence."*

eSpeak NG arrives **only** inside `src-tauri/resources/piper/`. Everything else in the tree —
foliate-js (MIT), PDF.js (Apache-2.0), the eight families (OFL), every crate — is permissive.

Therefore: **remove Piper and the entire project becomes relicensable at the owner's sole
discretion.** `[MEASURED — the dependency facts. INFERRED — the licensing conclusion; confirm with counsel before acting.]`

That retires `FW1` (AGPL-3.0 vs App Store distribution terms) **at the root**, rather than working
around it. And it corrects the mobile risk register, which currently retires *"Licensing conflict
blocking iOS distribution"* on the grounds that *"no offline neural engine ships on mobile."*

> **That reasoning is incomplete.** The App Store exposure is not the bundled GPL binary — it is
> **Sard's own AGPL-3.0 licence**, which applies to the app whether or not eSpeak ships with it. As
> sole copyright holder the owner can always grant an exception, so the risk was never fatal; but it
> is not retired by ADR-0004, and the register should not record it as such. **Deleting Piper is what
> actually retires it.**

I am not recommending a licence change. I am recording that M1 converts a permanent constraint into a
free choice — and that this is a strategic asset most projects never get to hold.

### 1.4 Removing Piper turns "port a sidecar to 3 OSes" into nothing

`[MEASURED]` — `src-tauri/resources/piper/` is **22 MB** of Windows PE binaries: `piper.exe`,
`piper_phonemize.dll`, `espeak-ng.dll`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`,
`espeak-ng-data/`, `libtashkeel_model.ort`.

Shipping macOS and Linux **with** Piper means sourcing or building that stack for
`x86_64-apple-darwin`, `aarch64-apple-darwin`, and a glibc baseline for Linux — an ONNX Runtime, a
phonemiser and a tashkeel model per target, each notarised (macOS) and each carrying its GPL
obligations. That is not a port; it is a second engineering project with an ML supply chain in it.

**Port before delete and you build all of that, then throw it away.** This is the ordering argument
for M1 before M2, and it is decisive on its own.

Secondary, real, and free: the installer sheds 22 MB of resources. Combined with font subsetting
(5.4 MB of TTF in `public/fonts/` `[MEASURED]`), the download roughly halves.

### 1.5 foliate-js's *reference* engine is WebKitGTK — which inverts the Linux risk assumption

ADR-0006 records it, and it is easy to skim past: `[MEASURED, from ADR-0006:25]`

> *"foliate-js's primary and most thoroughly tested engine is **WebKitGTK**… Chromium is its stated
> secondary target."*

Upstream Foliate is a GTK application. The 7,669 lines of vendored engine that Sard's entire reading
experience rests on are **developed and tested against WebKitGTK first**. Sard currently runs them on
the *secondary* engine.

This flips the usual intuition. Linux is not "the risky extra platform":

- It is where the engine is **best** tested.
- It needs **no hardware** (a free `ubuntu-latest` runner).
- It needs **no developer account**, no signing, no notarisation.
- It is a **WebKit** target — so it is a real, cheap rehearsal for macOS *and* iOS.

Against that, honestly: WebKitGTK is **not** WKWebView, most sharply on the iframe behaviours Gate 1
cares about; and Linux desktop is a genuine solo-maintainer support burden (distro variance, GPU
drivers, fractional scaling, IME, fontconfig). §4.3 bounds that burden deliberately.

---

## 2. What the port actually costs — a concrete portability audit

Measured against the tree, not estimated. This is the real inventory a macOS/Linux stage inherits.

### 2.1 Rust core — near-clean

| Item | State |
|---|---|
| `library` · `books` · `metadata` · `fonts` · `settings` · `photocards` · `backgrounds` · `db` | **Portable as written.** `[MEASURED]` — `std::path`, `std::env::temp_dir()`, `rusqlite` bundled, `image`. No OS calls. |
| `audio_identity` · `window_chrome` · `webview_chrome` | Gated, with fallbacks. §1.2. |
| `tts.rs:183` `piper.exe` | **The only ungated Windows dependency.** M1 deletes it. |
| `tts.rs` Edge path | Portable — `msedge-tts` + `ureq` + `rustls`, pure network code. |
| `rustls` dual-provider fix (`lib.rs:75`) | Portable, and *still required* — it disambiguates two crypto providers, not two platforms. |
| Legacy `com.erawy.app` migration (`lib.rs:34`) | Portable, but **Windows-only in meaning** — no macOS or Linux install can have that directory. Keep (harmless, one `exists()`), do not port its assumptions. |

**Conclusion:** after M1, `cargo build` for macOS and Linux should succeed with no source changes.
`[HYPOTHESIS — unverified; this is P0's cheapest side-effect to confirm.]`

### 2.2 Front end — where the actual work is

| # | Issue | Evidence | Consequence |
|---|---|---|---|
| **1** | `allow-scripts` dropped from the book iframe | `paginator.js:242`, `fixed-layout.js:84` | §1.1. **Potentially fatal. Test first.** |
| **2** | `scrollbar-color` used as the *mechanism* to reach into foliate's closed shadow root | `global.css:83, 892`; `injectedCss.ts:653, 873` | Safari supported it only from **18.2**; WebKitGTK varies. The recorded lesson (§12.1.12) is that `::-webkit-scrollbar` **cannot cross a shadow boundary** — so where `scrollbar-color` is unsupported there is **no fallback mechanism at all** for the immersive scrollbar hide. Injected *book* CSS can take a `::-webkit-scrollbar` fallback (it lives inside the frame); `global.css:892` cannot. |
| **3** | 5 unprefixed `backdrop-filter` rules of 20 | `global.css:338, 2957, 3609, 3850, **4282**` | 4282 is the **library wallpaper blur** — a headline feature. Silently no-ops on older WebKit. `[MEASURED]` |
| **4** | PDF page canvas → `toDataURL()` | `pdf.js:29` — *"adopting a painted canvas across documents renders blank in Chromium/WebView2"* | The workaround exists **for Chromium**. On WebKit `adoptNode` may work, and WebKit enforces stricter canvas-area limits — so a large PDF page may fail where Chromium succeeds. Verify; do not assume the patch is neutral. |
| **5** | `Intl.Segmenter` — *"present in WebView2/Chromium"* | `FoliateController.ts:2266` | Safari 14.1+ / WebKitGTK 2.32+. Fine on macOS; a tail risk on old Linux. Feature-detect. |
| **6** | `:has()` in injected book CSS | `injectedCss.ts:425` | Safari 15.4+ / WebKitGTK 2.38+. Same shape as #5. |
| **7** | `color-mix(in srgb, …)` | `global.css:83` and throughout | Safari 16.2+ / WebKitGTK 2.40+. Sets the real Linux floor. |
| **8** | CSS `zoom` for text scaling (D6) | `injectedCss.ts:643` | WebKit-origin property, supported — but its interaction with columnisation must be re-verified, since the D6 decision was measured on Chromium. |
| **9** | HTML5 drag-and-drop avoided because *"on Windows that handler swallows native drag events"* | `PhotoBasketTray.tsx:7` | Pointer events were the fix. **Pointer events are the portable choice anyway** — no action, but do not "restore" DnD on another platform. |
| **10** | `F11` fullscreen | `App.tsx:114` | A Windows/Linux convention. macOS expects `Cmd+Ctrl+F` and the green traffic light. Small, real. |
| **11** | Native title-bar theming | `window_chrome.rs` | No-ops elsewhere by design. macOS needs `titleBarStyle`/transparent-titlebar handling or it will look wrong against 16 themes; GNOME/KDE draw their own. |
| **12** | Keyboard | `FoliateController.ts:1498` already handles Ctrl/Cmd | `[MEASURED]` — largely handled. Audit the remainder against lesson §12.3.29 (`e.code`, not `e.key`). |

> **Item 2 is the interesting one architecturally.** It is a case of a *lesson* (prefer an inherited
> property to reach a closed shadow root) that is correct in general and Chromium-shaped in this
> instance. Worth recording as a corollary rather than a contradiction.

### 2.3 Documentation debt with porting consequences

`public/foliate-js/VENDOR.txt` is **three lines** — commit, source, licence. `[MEASURED]`

`PROJECT_MASTER_SUMMARY.md` §2.6 states it *"records every local modification… with the standing
instruction re-apply on any re-vendor"*, and ADR-0006 describes *"nine patch sites, each commented
with its ticket number and a re-apply instruction."*

The **comments are real** and they are excellent — I found them at `paginator.js:242/477/815`,
`fixed-layout.js:84`, `pdf.js:29/135/170/216`. But they live in the patched files, discoverable only
by grep. **`VENDOR.txt` does not contain them.**

That is normally a small documentation defect. It is not small here, because the *first* patch site is
the one that may decide whether Sard can run on WebKit at all (§1.1). **Fix `VENDOR.txt` in P0** — it
costs an hour and it is the map for every future re-vendor.

### 2.4 Build, packaging and release

| Area | Today `[MEASURED]` | Needed |
|---|---|---|
| `tauri.conf.json` bundle | `"targets": "all"` | Already correct — yields `.app`/`.dmg` on macOS, `.deb`/`.rpm`/`.AppImage` on Linux, with no config change |
| `bundle.resources` | `resources/piper → piper` | **Deleted by M1.** Nothing platform-specific remains |
| `capabilities/default.json` | `desktop-schema.json` | Correct for all three desktops. A `mobile-schema` sibling is a mobile-stage concern |
| Updater | `plugins.updater.windows.installMode: passive` | macOS wants `.app.tar.gz`; Linux AppImage. `updaterJsonPreferNsis` stays Windows-scoped. **`latest.json` must merge all platforms into one manifest** — `tauri-action` does this when the matrix targets one release |
| CI | `runs-on: windows-latest`, single job | A **matrix**. Linux needs `libwebkit2gtk-4.1-dev` + `libappindicator3-dev` + `librsvg2-dev` + `patchelf`. macOS needs `x86_64-apple-darwin` **and** `aarch64-apple-darwin` (universal, or two artifacts) |
| Signing | minisign (updater) only | Windows: Authenticode — Azure Trusted Signing is the cheap route. macOS: Developer ID + **notarisation + stapling**, without which Gatekeeper blocks. Linux: none |
| `scripts/build-test.mjs` | Already branches on `process.platform` for cargo; `kill-sard.mjs` and `copy-release.mjs` are Windows-shaped | Make both cross-platform; `copy-release` loses its `piper\` copy after M1 anyway |
| Verification instrument | WebView2 CDP via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (D55) | **Does not transfer.** WebKit speaks the WebKit Inspector Protocol. §4.4 |

> The release workflow's own comment already anticipates this: *"When macOS and Linux land, this
> becomes a matrix and tauri-action merges the per-platform entries into one latest.json."* The
> pipeline was built for this. `[MEASURED]`

---

## 3. Answering the questions asked, directly

### Should the next stage be Linux and macOS?

**Yes in substance. No in form, and no in that order.**

Right, because it is the cheapest way to buy down the mobile programme's largest uncertainty while
also shipping a product. Wrong as stated, for three reasons:

1. **"macOS and Linux" is not one unit.** They differ in cost by roughly an order of magnitude
   (Linux: free runner. macOS: hardware + $99/yr + notarisation), in engine (WebKitGTK vs WKWebView),
   in support burden, and in audience. Bundling them hides that Linux is nearly free and macOS is a
   real investment.
2. **Neither should start before Piper is gone** (§1.4).
3. **Neither should start before the WebKit probe** (§1.1) — because a Gate-1-shaped failure would
   change what "supporting macOS" even means.

### Should the core be extracted first?

**No.** It is 91.6% platform-neutral, all three Windows modules are already `cfg`-gated with
fallbacks, and the mobile roadmap's A1 milestone is already satisfied (§1.2). The extraction with real
value — a Tauri-free `sard-core` — is a hedge against an unrun gate. **Run the gate; then extract with
evidence.** That is M4, and if Gate 1 fails it gets promoted to M1½ immediately, because at that point
the native-shell contingency needs it.

### Should platform abstraction happen first?

**No — with exactly one exception.**

This project already learned this lesson expensively. §7.7: a per-file import lock was *"right in the
abstract and wrong on the machine"*, refuted by measurement. §12.3.1: *"investigate before you edit."*
You cannot abstract what you have not measured, and a solo project with one implementation has nothing
to abstract *from*. Build the second platform concretely, let the duplication appear, then abstract
what actually duplicated.

**The exception is the audio interface.** ADR-0004 already requires the two-verb seam
(`play(bytes, timings)` / `speak(text, voice, rate)`), and it is justified by a *named, specific*
future need rather than by symmetry. M1 forces the question anyway, because deleting Piper deletes
offline speech. **Build the seam in M1 — on desktop, where you have a debugger and no store review.**
That is strictly cheaper than first building it on a phone, and it de-risks mobile Stage 2's Gate 4.

**And one to *not* build yet:** the `PointerInput`/`TouchInput` adapter. Desktop has one input model
and Linux adds none. Design it for an imagined phone and you will get the seam wrong. But note —
**macOS trackpad gestures (two-finger swipe, pinch) are a genuine second input consumer**, arriving in
M3 with real requirements attached. **Let the seam emerge there.** A seam pressured by two real
implementations is a good seam; one pressured by one implementation and a guess is not.

### Should desktop be cleaned before adding platforms?

**Only the items a new platform multiplies.** The test is: *does this get N times more expensive per
platform added?*

| Do it now | Why |
|---|---|
| **Remove Piper** | ×3 platforms × 2 architectures if deferred |
| **`VENDOR.txt`** | ×3 re-vendor risk, and it is the map to §1.1 |
| **The 5 unprefixed `backdrop-filter` rules + a `scrollbar-color` fallback strategy** | ×2 engines if deferred, and both are cheap now |
| **The orphaned-`settings` cascade** (`pdf_invert:<id>` rows survive book deletion — §9.5) | Cheap now; *"painful once a second device exists"* is the mobile docs' own phrasing, and it is a correctness defect regardless |
| **Windows code signing** | Each platform adds a signing story; think about all three once |
| **Font subsetting to WOFF2** | 5.4 MB, platform-independent, pairs naturally with M1's installer shrink |

| Do **not** do it now | Why |
|---|---|
| **PDF in-book search** | Genuine product debt (§9.5, "urgent"), but a new platform does not multiply it. Schedule on **product** grounds, independently |
| **`global.css` at 4,627 lines** | ADR-0005 makes the mobile front end a **sibling tree**. Desktop CSS size never blocks it |
| **`FoliateController.ts` at 3,289 lines / `Reader.tsx` at 1,764** | They work, they are densely commented, and the Contract forbids cleanup commits. Touching them before P0 answers §1.1 risks a rewrite of code that a WebKit finding may reshape |
| **Library virtualization** | Listed as "should happen regardless", but there is **no measured desktop problem** — the recorded library is 10 books / 43.79 MB. Do it when mobile demands it, or when a measurement does |

### Should some work be postponed until mobile?

Yes, and the mobile documents already have most of these right:

- **The Rust Gravity scheduler migration** — ADR-0003 §"First migration" says do it *when the clock
  source changes*. Correct. Do not pull it forward. Moving a ~2,100-line scheduler with years of stall
  fixes, for no functional reason, is the highest-risk zero-benefit change available.
- **The input adapter** — above.
- **Library virtualization** — above.
- **The photo-card rasteriser replacement** — `html-to-image`'s `foreignObject` fidelity problems are
  a WebKit concern, so this *does* surface in M3. Treat it as a **known, contained** M3 defect with a
  stated limit, not as a subsystem rewrite. The design data (5 styles × 16 papers × 4 formats) is
  independent of the rasteriser.

### What sequence minimises long-term cost?

The one in §0, and the mechanism is: **every milestone is either a prerequisite of the next, or a
prerequisite of mobile.** Nothing in it is spent twice.

- **P0** answers a question mobile must answer anyway, on the cheapest available hardware.
- **M1** removes work that would otherwise be done three times and then deleted.
- **M2** validates the engine on its own reference platform, free.
- **M3** buys hardware, accounts and a verification harness that **iOS requires regardless** — and
  turns the "acquire a Mac" line item from a cost into an asset that has already shipped a product.
- **M4** draws the crate boundary with three platforms of evidence instead of none.

The alternative sequences all pay twice:

| Alternative | What it pays twice |
|---|---|
| Platforms before Piper | Three sidecar ports, then deleted |
| Extraction before the gate | A seam designed from imagination, then re-drawn |
| Abstraction before a second implementation | The abstraction itself (§7.7's exact failure) |
| Straight to mobile | Gate 1 answered on the *most expensive* platform, after buying a Mac, with the *worst* debugging story, and with Piper still in the tree |
| macOS before Linux | ~$1,100 and 6 weeks spent before learning what a free CI run would have said |

### What sequence best preserves Sard's architecture?

The architecture's load-bearing properties are: **one IPC seam · one token set · one database
connection · one reading engine, shared verbatim · book content never executes script.**

The proposed sequence protects all five, and one of them is actively **at risk** right now:

- **One reading engine, shared verbatim** (ADR-0006) and **D30** are in direct tension on WebKit
  (§1.1). This is the only sequence that discovers that *before* anything is built on top of it.
  Every other order discovers it later and more expensively.
- **One IPC seam** is untouched by any of P0–M3; M4 preserves it by construction.
- **One token set** is threatened only by CSS that silently no-ops on another engine — which is
  §2.2 items 2 and 3, scheduled in M2.
- **One database connection** is untouched throughout.

---

## 4. The migration strategy

Complete, per your list. Written to be executable, not aspirational.

### 4.1 P0 — The WebKit probe (1–2 weeks)

**Purpose:** answer, for the price of a CI run, whether the reading engine works on WebKit at all.
This is mobile Gate 1 and Gate 2, taken early on a cheaper platform.

**Method** — deliberately a spike. No chrome, no design, no polish, and **it is deleted afterwards**
(the mobile workspace's own Gate discipline rule 5).

1. Add a temporary `ubuntu-latest` job: system deps, `npm ci`, `cargo build`, `tauri build`.
2. Run it headless (Xvfb) and drive it with the **WebKit Inspector Protocol** — the first stone of the
   harness that iOS needs (G7).
3. Open a real multi-section EPUB and answer, in this order:

| # | Question | Fails → |
|---|---|---|
| **A** | **Do `pointerdown`/`pointerup`/`wheel`/`keydown` reach the book document with `sandbox="allow-same-origin"` only?** (§1.1) | Everything below is unreachable. Go to §4.1.1 |
| **B** | Does the paginator columnise correctly? Is `scrolling="no"` honoured? Any content-height expansion? | Gate 1 fails on WebKit generally, not just iOS. ADR-0001 is in question |
| **C** | Does selection reach `rectInParent` with correct parent-space coordinates? | Gate 2's answer, early |
| **D** | Does CFI round-trip byte-identically against a **copy** of a real database? | The most dangerous possible failure. See §4.6 |
| **E** | Does `scrollbar-color` apply? Does unprefixed `backdrop-filter` apply? | §2.2 items 2, 3 — sizes the CSS work |
| **F** | Does the PDF `toDataURL` path render, and at what page size? | §2.2 item 4 |

**Exit:** A–F answered with evidence. `VENDOR.txt` rewritten to carry all nine patch sites. The probe
branch is deleted.

**Do not skip A by reasoning about it.** Two of this project's longest detours were plausible guesses
that measurement destroyed (§12.3.1).

#### 4.1.1 If A fails — the decision tree, decided in advance

Deciding this now is what stops it becoming a crisis later.

| Option | Trade | Verdict |
|---|---|---|
| Restore `allow-scripts` on WebKit only | **Reopens a verified code-execution path** into `__TAURI_INTERNALS__.invoke` on exactly the platforms where notarisation and store review will scrutinise it most | **Rejected.** D30 is not negotiable per platform |
| Serve book content from a **separate origin** so `allow-same-origin` is safe alongside `allow-scripts` | Real, standard, and the right shape: origin isolation replaces sandbox-flag isolation. Costs a custom protocol handler and a re-check of every `contentDocument` access | **The recommended path.** Preserves D30's *guarantee* while satisfying WebKit's *mechanism* |
| Native event shim | Platform code in the reading engine | **Rejected** — violates ADR-0006 |
| Fork the engine per platform | | **Rejected** — ADR-0006 calls divergence a product failure |

**Cost if this branch is taken: +3–5 weeks, once, shared by macOS, Linux and iOS.** `[INFERRED]`
Finding it in P0 rather than in mobile Stage 3 is worth roughly a quarter.

### 4.2 M1 — Remove Piper (2–4 weeks, or 6–10 with a replacement)

**Rust — deletions, and they are clean.** `[MEASURED]`

- `tts.rs`: `VoiceDef`, `VOICES`, `HF_BASE`, `voice_def`, `Running`, `engine_dir`, `voices_dir`,
  `piper_command`, `spawn_piper`, `piper_synthesize`, and the `tts_voice_present` /
  `tts_download_voice` commands. **~250 of 751 lines.**
- `TtsEngine` loses `inner: Mutex<Option<Running>>`; `shutdown` loses the child kill; the
  `RunEvent::ExitRequested` handler in `lib.rs:206` may go entirely.
- `tts_synthesize`'s `match engine` collapses to one arm. Consider keeping the `engine` parameter as a
  **one-value enum** to hold the seam open for the ADR-0004 contingency without a signature change.
- `Cargo.toml`: `ureq` was there *"to download Piper voice models"* — but `msedge-tts` still needs it
  and the RAWY-111 dedup comment depends on it. **Keep `ureq`. Keep the `rustls` provider pin at
  `lib.rs:75`** — it disambiguates two crypto providers, not two engines. Removing it reintroduces a
  first-handshake panic.
- `tauri.conf.json`: delete `bundle.resources` entirely.
- `NOTICE`: delete §2 (Piper/eSpeak/ONNX) and **rewrite the "WHY AGPL" section** — its stated cause no
  longer exists (§1.3).
- Delete `src-tauri/resources/piper/` (22 MB) and its `LICENSES/`.
- `scripts/copy-release.mjs`: drop the `piper\` copy.
- Migration: **delete downloaded voice models** from `<app_data>/voices/` on first run after upgrade —
  up to 60 MB per voice of now-dead weight. One idempotent cleanup, logged, never silent.

**TypeScript — this is where the real work and the real prize are.** `[MEASURED]` — 64 Piper
references in `src/lib/tts.ts` alone, across 12 files. What collapses:

| Collapses | From → to |
|---|---|
| `TtsEngineKind` | `"piper" \| "edge"` → one engine |
| Audio format sniffing | `head[0..3] === "RIFF"` WAV-vs-MP3 detection (`tts.ts:1316`) → **one format** |
| Word-timing degradation | *"Piper emits none → sentence-level only"* → **timings always present**; the `framed()` empty-list path disappears; karaoke is unconditional |
| Failure taxonomy | Two engines × two failure models → one. `curEngine` branching in `playFrom`, `synthDispatch`, the retry ladder |
| Speed handling | The `--length_scale` saturation special case → gone |
| The picker | Piper rows + Edge rows → one catalogue |
| **The "Edge unavailable" pause** | *Retry / **Switch to Piper*** → **Retry / ?** ← **this is the product hole** |

> **This is a genuine simplification of the subsystem with the project's longest defect history.** It
> is the strongest engineering argument for the Piper decision, independent of platforms.

**The product hole, stated plainly.** Deleting Piper deletes offline read-aloud. The Edge-unavailable
state loses its only recovery action. There is no telemetry, so **there is no evidence about how often
Piper is actually used** — the owner's own usage is the only data that exists. Two branches:

| Branch | Cost | Result |
|---|---|---|
| **(a) Ship the regression** | +0 wk | Read-aloud is online-only on desktop, as it will be on mobile v1. Honest release note. The Edge-unavailable pill offers Retry and *"read on"* |
| **(b) Replace with platform speech, via ADR-0004's two-verb seam** | +4–6 wk | Offline speech returns. Windows: WinRT `SpeechSynthesizer` (Arabic available as an optional language pack). macOS: `AVSpeechSynthesizer` — **genuinely good Arabic voices**. Linux: `speech-dispatcher` over D-Bus — weak, and note it reaches system eSpeak **without linking**, so no GPL propagation |

**Recommendation: (b), scoped to Windows and macOS, with Linux honestly degraded.** Reasons: it is the
seam ADR-0004 already requires; building it on desktop is far cheaper than first building it on a
phone; it proves Gate 4's design before mobile depends on it; and it means the Piper decision is a
*simplification* rather than a *loss*. If schedule pressure forces (a), take (a) — but build the
**interface** with both verbs regardless, because that is what costs nothing now and everything later.

**Verification for M1** — this subsystem's history demands more than a build:
- The existing headless scheduler suite stays green throughout. It is pure (no Tauri, no WebAudio, no
  DOM), which is exactly why it can carry this change.
- Before → after on: synthesis latency distribution, underrun rate, `LISTENING-OUTCOMES.md`'s eight
  measurable outcomes.
- Installer size and `Sard.exe` size, before → after.
- **The invariant that must survive verbatim: the engine never changes without an explicit user
  press.** With one engine it becomes trivially true — confirm it is true *structurally*, not by
  absence.

### 4.3 M2 — Linux (3–5 weeks)

Assumes P0 passed or its remediation shipped.

- **Toolchain:** `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`,
  `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`.
- **Packaging: AppImage as the primary artifact**, `.deb` secondary. **Recommend adding Flatpak** —
  it is how this audience actually installs, and it solves the WebKitGTK version-floor problem by
  pinning a runtime.
- **Updater:** the Tauri updater supports AppImage. Flatpak updates through Flathub instead — so the
  in-app updater must **detect its packaging and disable itself** under Flatpak rather than offering
  an update it cannot perform.
- **Set and document a WebKitGTK floor.** §2.2 items 5–7 put it around **2.40**. State it in
  `BUILD.md` and fail gracefully below it, do not crash.
- **Title bar:** GNOME/KDE draw their own. Accept the OS default; `window_chrome` already no-ops.
- **Support tier — bound this deliberately.** Risk #8 (solo-maintainer bandwidth) is the register's
  most under-rated entry. **Recommendation: Linux ships as a first-class *build* with
  community-supported *distro* coverage** — one tested combination (current Ubuntu LTS + Flatpak),
  everything else best-effort. Publish that policy in the README. A stated tier is a boundary; an
  unstated one becomes an obligation.

### 4.4 M3 — macOS (5–8 weeks)

**Prerequisites — all of which are mobile prerequisites (G5, G6, G7):**

| Item | Cost | Note |
|---|---|---|
| Apple silicon Mac | ~$700–1,500 | Gates all iOS work regardless |
| Apple Developer Program | $99/yr | Individual 24–48 h; organisation 1–2 weeks. Also gates TestFlight |
| Developer ID certificate | included | Notarisation identity |

**Work:**
- **Universal binary** — `x86_64-apple-darwin` + `aarch64-apple-darwin`, `lipo`'d, or two artifacts.
  Universal is the better user experience and the smaller support surface.
- **Notarisation + stapling.** Without it, Gatekeeper blocks the first run — the same class of problem
  as Windows SmartScreen, and worse. `tauri-action` supports `APPLE_ID` / `APPLE_PASSWORD` /
  `APPLE_TEAM_ID`. Budget for the first submission failing.
- **Title bar:** decide between `titleBarStyle: "Transparent"` with an inset traffic-light overlay, or
  the standard bar. The transparent option is the one that honours "a page resting on a desk" across
  16 themes; it is also more work.
- **Menu bar.** macOS expects a real application menu. Tauri does not give one for free. This is
  genuinely new UI surface and it is the most under-estimated item in M3.
- **Keyboard:** `Cmd` throughout (largely handled — `FoliateController.ts:1498`); fullscreen convention
  (§2.2 item 10).
- **Trackpad gestures** — two-finger swipe for page turn, pinch for text size. **This is the second
  real input consumer**, and where the input adapter should be allowed to emerge (§3).
- **The WebKit Inspector harness (G7)** — build it here properly. It is the instrument iOS requires,
  and macOS is where it is cheapest to build and easiest to debug. This is the largest single piece of
  *mobile* value in the whole desktop stage.
- **Photo cards** — expect `html-to-image` fidelity problems (risk #12). Record honestly; do not
  rewrite the rasteriser in M3.
- **Updater:** `.app.tar.gz` payload, `installMode` is Windows-only and stays so.

### 4.5 M4 — The `sard-core` crate (3–5 weeks)

Now, and not before, because now you know what actually varies.

```
src-tauri/
  Cargo.toml            workspace
  crates/
    sard-core/          NO tauri dependency
      db · migrations · library · books · metadata · fonts
      settings · photocards · backgrounds · tts (Edge client)
      → domain rules; the destination for Rust Gravity migrations
    sard-tauri/         the shell: #[tauri::command] wrappers, plugins,
                        cfg-gated platform modules, the app lifecycle
```

**The rule that makes it worth doing:** `sard-core` compiles and its tests run **without Tauri**. That
is what makes it hostable by a native shell if Gate 1 ever fails on iOS, and it is what lets Rust
Gravity migrations land somewhere the UI framework cannot reach.

**Verification — this is a refactor with zero intended behaviour change, so it is gated on
byte-identity, not on opinion:**
- The 61-handler `generate_handler!` list is unchanged, name for name.
- Every command signature is byte-identical before and after.
- `cargo test` count is unchanged and green on all three platforms.
- Binary size before → after, on all three.
- A live run on the real database, snapshotted and restored (lesson §12.3.21).

**If the P0 probe fails at A and the origin-isolation path is taken, promote M4 to M1½** — the native
shell contingency needs the core split, and at that point it stops being a hedge.

### 4.6 The one risk that outranks everything else

> **A CFI that resolves differently on two engines silently corrupts every reading position,
> highlight, note, reference and bookmark in the database.**

`reading_progress.locator_cfi`, `highlights.start_cfi`/`end_cfi`, `notes.locator_cfi`,
`bookmarks.locator_cfi` — all of it. ADR-0006 calls this out as the catastrophic case, and it deserves
a **named gate** in every milestone, not a line in a risk table.

CFIs are computed from DOM structure. The DOM comes from the book. But normalisation, whitespace
handling and `Range` boundary behaviour are **engine implementation details**, and Sard's render-time
paragraph pass deliberately *adds classes rather than nodes* precisely because node changes shift CFI
child-step indices (§3.10).

**Therefore, in P0 and again in M2 and M3:**

1. Take a **copy** of a real database (with `-wal` and `-shm` — lesson §12.3.22).
2. On Windows, dump every stored CFI and the text each resolves to.
3. On the new engine, resolve the same CFIs against the same books.
4. **Assert text equality, character for character.** Not "approximately the same place."
5. Also assert the reverse: a highlight made on WebKit resolves identically on Windows.

**If they diverge, the platform does not ship until they do not.** There is no acceptable partial pass
here — a reader who opens their library on a second machine and finds their highlights one paragraph
off has lost trust that no bug fix recovers.

### 4.7 Verification and testing — the honest gap

The project's live-verification instrument is **WebView2 CDP** (D55). `[MEASURED]` **It does not
transfer to WebKit**, on any platform. That is not a small tooling note — it means that on day one of
M2, Sard's own standard of proof (§12.3: *"a harness must be proven to FAIL on the unfixed build
before its pass means anything"*) is **unmeetable on the new platform**.

This is the same problem the mobile workspace files as G7 for iOS, and it arrives two milestones
earlier than they expect.

**Recommendation: build the WebKit Inspector harness in P0, at probe quality, and properly in M3.**
Concretely:
- The remote inspector protocol over a WebSocket, the same shape as the CDP driver.
- The same assertion vocabulary: computed styles with forced reflow (lesson §12.3.9), real gesture
  dispatch not `element.click()` (§12.3.7), positive controls that are proven to fail.
- **One harness, three engines** — the alternative is three harnesses and a quality drift nobody
  notices (risk #7).

**Also needed and currently absent:** `[MEASURED]` — there is **no frontend test runner**
(`package.json` has no test script; no `*.test.*` files exist). The mobile docs repeatedly reference
"the existing headless suite" for the scheduler; whatever form it takes, it is not a checked-in,
runnable suite. **Before M1 touches the scheduler, that suite must exist as something CI runs.**
Otherwise the largest simplification in the project's history lands with no regression net under it.

Rust has `cargo test` (36 tests) plus `tests/backgrounds.rs`. Those run on every platform for free —
add them to the matrix on day one.

### 4.8 Repository structure after the stage

```
M:\eRawy\
├── .github/workflows/release.yml     MATRIX: windows · macos · ubuntu
├── docs/
│   ├── screenshots/
│   └── platform-support.md           NEW — tiers, floors, what is community-supported
├── public/
│   ├── foliate-js/
│   │   └── VENDOR.txt                REWRITTEN — all nine patch sites, with re-apply notes
│   └── fonts/                        WOFF2, subset (5.4 MB → ~1.5 MB)  [INFERRED]
├── scripts/                          cross-platform; no piper copy
├── src/
│   └── lib/tts.ts                    one engine; one audio format; timings always present
└── src-tauri/
    ├── Cargo.toml                    workspace (M4)
    ├── crates/
    │   ├── sard-core/                no tauri  (M4)
    │   └── sard-tauri/               the shell (M4)
    ├── resources/                    DELETED
    └── tauri.conf.json               no bundle.resources
```

`src-tauri/src/sync/mod.rs` — the two-line placeholder — should be **deleted, not filled**. Appendix
B.8 already flags it as *"not a feature and should not be read as one."* An empty seam that survives a
platform expansion starts looking like a commitment.

### 4.9 Effort, and what it buys

`[INFERRED]` — on the roadmap's own basis: one primary developer with AI assistance, at Sard's quality
bar, which roughly doubles nominal figures.

| Milestone | Effort | Also buys |
|---|---|---|
| P0 · WebKit probe | 1–2 wk | **Mobile Gates 1 + 2, early and cheap.** The first stone of G7 |
| M1 · Remove Piper | 2–4 wk | Permissive tree → FW1 retired at the root. −22 MB. The TTS state space halves |
| M1b · Platform speech *(optional)* | +4–6 wk | ADR-0004's two-verb seam, proven on desktop. De-risks Gate 4 |
| M2 · Linux | 3–5 wk | The engine validated on its **reference** platform |
| M3 · macOS | 5–8 wk | **G5 + G6 + G7 all satisfied.** WKWebView evidence. Trackpad → the input seam |
| M4 · `sard-core` | 3–5 wk | The native-shell contingency becomes real. Rust Gravity gets a home |
| Parallel | 2–3 wk | Signing · update-path verification · settings cascade · font subsetting |
| **Total** | **12–20 wk** *(16–26 with M1b)* | |

**The comparison that matters:** the mobile programme estimates **35–52 weeks** and is currently
gated on four unanswered questions. This stage answers two of them, builds the instrument required for
a third, satisfies all four non-technical gates, and **ships two products while doing it.**

Roughly **60% of this effort is work the mobile programme must do anyway.** `[INFERRED]` The marginal
cost of getting macOS and Linux out of it is small — that is the actual argument for your intuition,
and it is stronger than "more platforms is good."

### 4.10 Risks specific to this stage

| # | Risk | Prob. | Impact | Mitigation |
|---|---|---|---|---|
| **1** | **WebKit event dispatch fails without `allow-scripts`** | Medium | **Architecture-changing** | P0, week one. Origin-isolation path pre-decided (§4.1.1) |
| **2** | **CFI divergence between engines** | Low-med | **Catastrophic — silent data corruption** | §4.6. A named blocking gate in P0, M2 and M3 |
| **3** | Removing Piper is felt as a product loss | Med-high | Medium | M1b, or an honest release note. No telemetry means **the owner's own usage is the only evidence** |
| **4** | Verification cannot meet the project's own standard on WebKit | **High if unaddressed** | Slow quality erosion | Build the harness in P0/M3, not when first needed |
| **5** | Linux support burden exceeds a solo maintainer | Medium | Compounding | A **published support tier**. Flatpak to pin the runtime |
| **6** | macOS notarisation / first submission friction | Medium | Schedule only | Budget two attempts. Start the account early (1–2 wk lead) |
| **7** | The scheduler simplification introduces a regression | Medium | High | A runnable headless suite **before** M1 (§4.7). Before→after on all eight listening outcomes |
| **8** | `backdrop-filter` / `scrollbar-color` degrade silently on WebKit | **High** | Low-med | §2.2 items 2–3, scheduled in M2. Silent CSS failure is the hardest kind to notice |

---

## 5. Where I disagree with the existing documents

Recorded plainly, because you asked for challenge rather than agreement.

1. **The risk register retires "licensing conflict blocking iOS distribution" on incorrect grounds.**
   ADR-0004 removes the bundled GPL *binary* from mobile; it does not touch Sard's own AGPL-3.0
   licence, which is the actual App Store exposure. **Deleting Piper is what retires it** (§1.3).
   Recommend: reinstate the risk, then retire it against M1.

2. **Architecture milestone A1 is already complete.** All 511 Windows LOC are `cfg`-gated with
   fallbacks today. Listing it as Stage 1 work overstates the extraction cost and, worse, makes
   "extract the core first" look necessary when it is not (§1.2).

3. **The four validation gates omit the `allow-scripts` question**, which is upstream of two of them
   and is documented in the project's own vendored source (§1.1). Recommend it becomes **Gate 0**.

4. **`VENDOR.txt` does not contain what two authoritative documents say it contains** (§2.3). The
   patch comments are excellent and they are in the source files; the file that claims to index them
   is three lines long. On a re-vendor, that gap is how the §1.1 patch gets silently dropped — or
   silently kept.

5. **The workspace contains no engineering on macOS or Linux at all** — two roadmap mentions and one
   incidental WebKitGTK fact. Given that macOS is the cheapest rehearsal of iOS available and Linux is
   foliate-js's reference engine, that is the largest gap in an otherwise strong document set.

6. **A lesson needs a corollary.** §12.1.12 — *"prefer an inherited property to reach into a closed
   shadow root"* — is correct in general and **Chromium-shaped in this instance**: on engines without
   `scrollbar-color` it leaves no mechanism at all. Recommend appending: *"and check that the
   inherited property exists on every engine you ship, because the selector-based fallback cannot
   cross the boundary."*

---

## 6. What would change this recommendation

Stated up front, so the study can be falsified rather than defended.

- **P0 question A fails and origin isolation proves impractical.** Then Tauri's WebView model is in
  question for WebKit generally, ADR-0001 needs reopening for *all* platforms, and M4 gets promoted
  ahead of M2/M3.
- **CFI divergence is found** (§4.6). Then the shared-engine premise itself needs re-examining, and
  nothing else matters until it is resolved.
- **The owner's measured Piper usage turns out to be high.** Then M1b is not optional, and M1's
  estimate is 6–10 weeks, not 2–4. There is no telemetry, so this can only come from the owner.
- **Mobile becomes urgent for a product reason** — a deadline, a partnership, a competitor. Then P0 and
  M1 still come first (both are on mobile's critical path), but M2 and M3 are deferred and the Mac is
  bought immediately for iOS rather than for macOS.
- **Contributors arrive.** Everything in §4.3's support-tier reasoning, and much of risk #8, changes.

---

## 7. The short version

**Your instinct is directionally right and I would not have arrived anywhere else — but for reasons
that are not the obvious ones, and in an order that is not the stated one.**

macOS and Linux are worth doing next **not because more platforms are good**, but because:

- they are the cheapest possible way to answer the mobile programme's biggest unknown;
- they force the verification instrument that iOS cannot proceed without;
- their prerequisites are mobile's prerequisites, pulled forward rather than added;
- and one of them runs the reading engine on the engine it was actually written for.

But **two things must happen first**, and neither appears in any current plan:

1. **Spend one week finding out whether the reading engine works on WebKit at all** — the answer is
   sitting in a comment in your own vendored `paginator.js`, and it says the patch you applied removes
   a workaround that exists *for WebKit*.
2. **Delete Piper before you port anything**, because it is the only thing in the tree that would
   otherwise have to be built three times and then thrown away — and deleting it hands you a fully
   permissive dependency graph, a 22 MB smaller installer, and a materially simpler read-aloud
   subsystem, all at once.

Do those two, and macOS and Linux stop being a platform expansion. They become **the rehearsal for
mobile that also ships a product** — which is the cheapest thing a solo project can possibly buy.

---

*Independent study. Nothing here was implemented. Every `[MEASURED]` claim was read from the tree at
`dd23765` or run against it; every `[INFERRED]` and `[HYPOTHESIS]` is labelled as such and is the
author's reasoning, not a project decision.*
