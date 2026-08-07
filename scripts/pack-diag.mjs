// Package the DIAGNOSTIC build for the tester.
//
// Same discipline as `pack-share.mjs`: a source fingerprint, artifact hashes, and an archive built
// from a CLEAN TREE rather than from a directory. That last point is not pedantry — packing the
// share build by naming files with `-r` made Rar search subdirectories for those names and sweep up
// every historical Sard-Setup.exe out of the archive folders: 511 MB of stale binaries. Copying the
// intended files into an empty directory first makes that mistake unrepresentable.
//
// This package is deliberately SEPARATE from Sard-Share so a diagnostic build can never be mistaken
// for, or shipped as, the beta.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const OUT = "M:/Sard-Diagnostic";
const RAR = "C:/Program Files/WinRAR/Rar.exe";
const now = new Date();
const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();
const git = (a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Source fingerprint — two packages with the same fingerprint are the same code.
const sourceFiles = ["src", "src-tauri/src", "public"]
  .map((d) => join(REPO, d)).filter(existsSync).flatMap((d) => walk(d))
  .map((p) => relative(REPO, p).replace(/\\/g, "/")).sort();
const fp = createHash("sha256");
let bytes = 0;
for (const rel of sourceFiles) {
  const b = readFileSync(join(REPO, rel));
  fp.update(rel); fp.update(b); bytes += b.length;
}
const fingerprint = fp.digest("hex").toUpperCase();
const head = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
const buildId = `DIAG-${stamp}-${head}`;

// Fresh output directory every time — no chance of carrying anything forward.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const setupSrc = join(REPO, "src-tauri/target/release/bundle/nsis/Sard_1.1.0_x64-setup.exe");
if (!existsSync(setupSrc)) throw new Error(`installer not found: ${setupSrc}`);
cpSync(setupSrc, join(OUT, "Sard-Setup.exe"));
cpSync(join(REPO, "DIAG-README.txt"), join(OUT, "README.txt"));

const setupBytes = readFileSync(join(OUT, "Sard-Setup.exe"));
const info = `SARD - DIAGNOSTIC BUILD (PDF + READ-ALOUD + BLACK PAGE)
=======================================================
This is NOT a release. It is an instrumented build whose only purpose is to
record evidence for problems that cannot be reproduced on the development
machines. One build covers all three, so the tester installs Sard once:

  1. Opening a PDF fails with "TypeError: Failed to fetch" on one machine while
     the same file opens on two others.
  2. Read-aloud plays audio with no highlighting at all.
  3. A book opens and the page is completely BLACK - no text - and changing the
     theme has no effect.

BUILD ID          ${buildId}
Built (UTC)       ${now.toISOString().replace("T", " ").slice(0, 19)}
App version       ${JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version}
Git HEAD          ${head}  (+ ${dirty} uncommitted path(s))
Source fingerprint ${fingerprint}
                  (${sourceFiles.length} files, ${bytes.toLocaleString("en-US")} bytes)

Sard-Setup.exe    ${sha(setupBytes)}
                  ${setupBytes.length.toLocaleString("en-US")} bytes

HOW IT DIFFERS FROM THE NORMAL BUILD
  - collects a diagnostic timeline at runtime (observe-only, wrapped so it can
    never alter or break playback or rendering)
  - a red EXPORT BUTTON at the bottom-left of every screen writes a report to
    Documents\\Sard Diagnostics and opens the folder
  - Ctrl+Shift+D does the same
  - NO behaviour changes, NO fixes for the reported issues - it only observes

EXPORT FIX IN THIS BUILD (the previous build could not be exported at all)
  Both testers reported Ctrl+Shift+D did nothing. Measured with real key events
  routed through the browser's input pipeline:
    library, nothing open -> reaches the window, handler runs, report written
    A BOOK IS OPEN        -> the event NEVER REACHES THE TOP-LEVEL WINDOW
  The reading content is an iframe inside <foliate-view>'s CLOSED shadow root;
  once a book is open the focus is inside it, and key events fire in that
  iframe's window without propagating to the parent. The listener lived only on
  the parent. Every tester had to open a book to reproduce anything, so every
  tester was in the broken state before they tried to export.
  Fixed three ways: a visible button that needs no keyboard, the shortcut also
  attached to every section document, and the key matched on event.code as well
  as event.key so a non-Latin keyboard layout cannot break it.
  Verified with real input, 5 of 5: library / book open / focus in the iframe /
  Arabic layout character / button click with no keyboard at all.

WHAT THE REPORT CONTAINS
  A PDF PIPELINE STAGE LEDGER: 13 stages from the click to the first rendered
  page, each declared in advance so a step that never ran is reported as
  NOT ENTERED rather than merely being absent. Every stage carries start, end,
  duration, metadata and - on failure - the reason, the full stack and the raw
  serialized error.

  A CHAIN PROBE that re-walks pdf.js dependencies one link at a time (fetch the
  engine bytes, import the module, fetch each CSS file, construct the Worker),
  global window.onerror / unhandledrejection capture (where a rejected dynamic
  import actually surfaces, and which an earlier build was blind to), and
  on-disk file facts read from Rust.

  A PDF ATTEMPT COMPARISON, for the report that the FIRST open of a file fails
  and a SECOND open of the same file succeeds with nothing changed. Every PDF
  attempt in the session is kept as its own ledger - opening another book no
  longer overwrites it - and the attempts are then placed side by side: how far
  each got, where each stopped, and the per-stage outcome and duration, printing
  ONLY the stages that differ. If nothing differs it says so, which is itself a
  finding: the difference is then not in these stages.

  AN EPUB RENDERING STAGE LEDGER: 14 stages from the click to the first painted
  text - book opened, OPF parsed, navigation loaded, section resolved, HTML
  loaded, HTML parsed, frame created, book CSS discovered, Sard CSS injected,
  theme applied, DOM attached, layout completed, first VISIBLE text node, first
  paint. Same discipline: declared in advance, so a step that never ran says so.

  A BLACK / BLANK PAGE AUTOPSY, measured against the LIVE screen at the instant
  the tester presses the keys. It does not report THAT the page is black, it
  reports WHY, choosing between: no document at all; a document with no <body>
  (an XHTML parse failure); an empty document; text that lays out to zero area;
  text hidden by display/visibility/opacity; text whose colour equals its
  background (with the measured contrast ratio); text covered by something
  opaque; or a document that is entirely healthy, which moves the cause outside
  it. Per element it records the box, colour, effective background and where
  that background came from, contrast, display, visibility, opacity, font-size,
  clip-path, filter, mix-blend-mode, transform, and what is topmost at its
  centre. Plus every resource that failed to load inside a section and every
  theme application, so "changing the theme does nothing" can be checked rather
  than believed.

  Every line is tagged MEASURED, DERIVED or UNKNOWN - never a guess.

VERIFIED BEFORE SHIPPING
  PDF, calibrated against a machine where PDFs work:
    stages 1-11  -> all reach "entered / completed"
    chain probe  -> LINK 1 fetch pdf.mjs 828,624 bytes; LINK 5 import SUCCEEDED
                    (pdfjsLib present, version 5.5.207); LINK 6 Worker clean
    stages 12-13 -> NOT OBSERVABLE (no reliable hook into getDocument). This is
                    stated as UNKNOWN, never as failure - an earlier version
                    reported stage 13 FAILED while the PDF was on screen, and
                    that false alarm was found and removed.

  EPUB rendering: all 14 stages reach "entered / completed" on a healthy book,
  with no stage failing. (An earlier version reported stage 11 FAILED on a book
  that rendered perfectly, because it measured the frame before layout. Found
  and removed - a diagnostic that cries wolf on a healthy machine is worthless.)

  Black page: each verdict was PROVEN to fire, by inducing the failure in a real
  book in the real binary and reading the resulting report - 5 of 5 correct:
    untouched book        -> "text is present and measured as visible"
    ink forced to the bg  -> "BLACK ON BLACK ... contrast 1:1"
    visibility: hidden    -> "hidden by a computed style - visibility: hidden"
    opaque box over text  -> "the text is covered"
    body emptied          -> "the document is empty"
  The healthy control matters as much as the failures: a report that shouted
  BLACK ON BLACK at a working page would be worse than no report at all.

  Because these outcomes are known on a healthy machine, any NOT ENTERED or
  FAILED in the tester's report is real signal.

  Two defects in the autopsy itself were found and removed while verifying this
  build, both of which produced confident WRONG verdicts:
    - it judged the first HEALTHY document it found, so a preloaded neighbouring
      section could mask the damaged one actually on screen. It now judges the
      document with the largest visible area in the reading surface, and names
      which document the verdict describes.
    - it took the first hidden element as the explanation. On a book with "hide
      first line" active that element is legitimately hidden, so it announced
      "hidden by a computed style" for a page that was really black-on-black. It
      now reports the condition that explains the MOST sampled elements.

THE ONE PRODUCT FIX IN THIS BUILD (everything else only observes)
  Generated ("synthetic") contents rows were not clickable in any book whose own
  table of contents is unusable. Measured in the running app: view.goTo() takes a
  TARGET to resolve (a number, a {fraction}, a CFI or an href) and was being given
  an already-resolved {index, anchor} object, which resolves to nothing; foliate
  catches that internally and only logs it, so the call returned undefined and the
  reader silently did not move. Proven by calling all three shapes live, and
  mutation-tested by reverting it. All six behaviours now verified: clickable,
  navigates, clicking row k makes row k current, current-chapter detection,
  active highlight, and scroll-to-current.

  The installer is NOT code-signed; SmartScreen will warn on first run.
`;
writeFileSync(join(OUT, "BUILD-INFO.txt"), info, "utf8");

// Archive from a clean tree (see the header).
const rarName = `Sard-Diagnostic-${stamp}.rar`;
const rarPath = join(OUT, rarName);
const tree = join(REPO, `.diagpack-${stamp}`);
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
for (const f of ["Sard-Setup.exe", "README.txt", "BUILD-INFO.txt"]) cpSync(join(OUT, f), join(tree, f));
execFileSync(RAR, ["a", "-r", "-ep1", "-m3", "-idq", rarPath, "*"], { cwd: tree });
rmSync(tree, { recursive: true, force: true });

execFileSync(RAR, ["t", "-idq", rarPath]);
const listing = execFileSync(RAR, ["lb", rarPath], { encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`\n  BUILD ID    ${buildId}`);
console.log(`  fingerprint ${fingerprint}`);
console.log(`  Sard-Setup.exe  ${setupBytes.length.toLocaleString("en-US")} bytes  ${sha(setupBytes).slice(0, 16)}…`);
console.log(`\n  RAR ${rarPath}`);
console.log(`      ${statSync(rarPath).size.toLocaleString("en-US")} bytes · integrity OK · ${listing.length} entries:`);
for (const e of listing) console.log(`        ${e}`);
