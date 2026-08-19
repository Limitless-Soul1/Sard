// 7.2 — the reintroduction guard.
//
// Fails when inline JSX geometry reappears that the token system already covers. It enforces
// exactly the two rules Stage 7 established and nothing more:
//
//   R1  a bare numeric geometry literal whose value IS a token's value  -> use the token
//   R2  a bare numeric borderRadius inside Decision 3's 6-10 band       -> collapses to --r-md
//
// It deliberately does NOT flag: values with no token (content dimensions), structural values
// (0, 1, 1.5, 2 hairlines and rules), compound values ("8px 12px"), dynamic expressions, already
// tokenised values, or colour literals -- see LIMITATIONS at the foot of this file.
//
// Parsing is the validated jsx-scan module: comment blanking, brace depth and string state were all
// fixed and self-tested there. Do not reimplement them here.

const fs = require("fs");
const path = require("path");
const JSX = require("./jsx-scan.cjs");

// The files Stage 7 units 1 and 2 actually cleaned. PROTECTED (SardMini, ProfileCard) and
// surfaces that cannot be reached for runtime verification (ViewVista, ViewDetails, reader, photo)
// are out of scope by construction, not by exclusion rule.
const ENFORCED = [
  "src/features/library/design/CaseEditor.tsx",
  "src/features/library/design/BookDetails.tsx",
  "src/features/library/design/Chrome.tsx",
  "src/features/library/design/Menus.tsx",
  "src/features/library/design/LibraryDesign.tsx",
  "src/features/library/design/BookTile.tsx",
  "src/features/library/design/ViewGrouped.tsx",
];

const RAD = new Set(["borderRadius", "borderStartStartRadius", "borderStartEndRadius",
  "borderEndStartRadius", "borderEndEndRadius"]);
const SIZE = new Set(["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"]);
const SP = new Set(["gap", "rowGap", "columnGap", "padding", "margin", "marginTop", "marginBottom",
  "marginInlineEnd", "marginInlineStart", "paddingInline", "paddingBlock"]);

const RADT = { 3: "--r-xs", 6: "--r-sm", 9: "--r-md", 12: "--r-lg", 16: "--r-xl" };
const CTLT = { 22: "--ctl-xs", 26: "--ctl-sm", 30: "--ctl-md", 34: "--ctl-lg", 38: "--ctl-xl", 44: "--ctl-2xl" };
const ICOT = { 14: "--icon-sm", 16: "--icon-md", 20: "--icon-lg", 24: "--icon-xl" };
const SPT = { 2: "--sp-1", 4: "--sp-2", 6: "--sp-3", 8: "--sp-4", 12: "--sp-5", 16: "--sp-6", 24: "--sp-7", 32: "--sp-8" };

// `|$` matters: a style block body excludes its closing brace, so the LAST pair in every block has
// no trailing delimiter. Without it the last pair can never match -- which is exactly how nine
// violations survived units 1 and 2 unnoticed.
const PAIR = /([A-Za-z][A-Za-z0-9]*)(\s*:\s*)(-?\d+)(\s*)(?=[,}\n]|$)/g;

function tokenFor(key, n) {
  if (RAD.has(key)) return RADT[n] || null;
  if (SIZE.has(key)) return CTLT[n] || ICOT[n] || null;
  if (SP.has(key)) return SPT[n] || null;
  return null;
}

/** Violations in one source text. `label` is only used for reporting. */
function checkText(src, label) {
  const out = [];
  const blanked = JSX.blankComments(src);
  for (const range of JSX.blockRanges(src)) {
    const body = blanked.slice(range[0], range[1]);
    PAIR.lastIndex = 0;
    let m;
    while ((m = PAIR.exec(body)) !== null) {
      const key = m[1], n = Number(m[3]);
      const line = src.slice(0, range[0] + m.index).split("\n").length;
      const tok = tokenFor(key, n);
      if (tok) {
        out.push({ file: label, line: line, rule: "R1", key: key, value: n, expected: "var(" + tok + ")",
          why: "this value IS " + tok });
        continue;
      }
      if (RAD.has(key) && n >= 6 && n <= 10) {
        out.push({ file: label, line: line, rule: "R2", key: key, value: n, expected: "var(--r-md)",
          why: "radius " + n + " is inside Decision 3's 6-10 band" });
      }
    }
  }
  return out;
}

function checkFiles(files) {
  const all = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error("guard: missing file " + f); process.exitCode = 2; continue; }
    for (const v of checkText(fs.readFileSync(f, "utf8"), f.split(path.sep).join("/"))) all.push(v);
  }
  return all;
}

// ---------------------------------------------------------------------------------------------
// Self-test. Fixtures with a KNOWN answer, run before the guard is trusted on real files.
// ---------------------------------------------------------------------------------------------
function selfTest() {
  const MUST_FLAG = [
    ["exact radius token", 'const a = <i style={{ borderRadius: 9, color: "red" }} />;', "R1"],
    ["radius inside the band", 'const b = <i style={{ borderRadius: 8, color: "red" }} />;', "R2"],
    ["exact spacing token", 'const c = <i style={{ gap: 8, color: "red" }} />;', "R1"],
    ["exact control height", 'const d = <i style={{ height: 30, color: "red" }} />;', "R1"],
    // the regression that slipped past units 1 and 2:
    ["violation as the LAST pair in a block", 'const e = <i style={{ display: "flex", gap: 4 }} />;', "R1"],
    ["exact icon size", 'const f = <i style={{ width: 16, height: 16 }} />;', "R1"],
  ];
  const MUST_NOT_FLAG = [
    ["already tokenised", 'const g = <i style={{ borderRadius: "var(--r-md)" }} />;'],
    ["structural hairline", 'const h = <i style={{ height: 1, width: 0 }} />;'],
    ["structural fractional", 'const i = <i style={{ height: 1.5 }} />;'],
    ["radius below the band, not a token", 'const j = <i style={{ borderRadius: 2 }} />;'],
    ["content dimension", 'const k = <i style={{ maxWidth: 430, height: 176 }} />;'],
    ["dynamic expression", 'const l = <i style={{ padding: props.big ? 12 : 4 }} />;'],
    ["compound value", 'const m = <i style={{ padding: "8px 12px" }} />;'],
    ["colour literal (out of declared scope)", 'const n = <i style={{ color: "#fff" }} />;'],
    ["non-geometry key", 'const o = <i style={{ zIndex: 30, opacity: 1 }} />;'],
    ["value in a comment", 'const p = <i style={{ display: "flex" /* gap: 8 */ }} />;'],
  ];

  let bad = 0;
  console.log("  positive cases (guard MUST flag):");
  for (const c of MUST_FLAG) {
    const v = checkText(c[1], "fixture");
    const ok = v.length > 0 && v.some((x) => x.rule === c[2]);
    if (!ok) bad++;
    console.log("    " + (ok ? "ok   " : "FAIL ") + c[0].padEnd(42) + (v.length ? v[0].rule + " " + v[0].key + "=" + v[0].value : "NOT FLAGGED"));
  }
  console.log("  negative cases (guard MUST NOT flag):");
  for (const c of MUST_NOT_FLAG) {
    const v = checkText(c[1], "fixture");
    const ok = v.length === 0;
    if (!ok) bad++;
    console.log("    " + (ok ? "ok   " : "FAIL ") + c[0].padEnd(42) + (ok ? "clean" : "flagged: " + JSON.stringify(v.map((x) => x.key + "=" + x.value))));
  }
  return bad;
}

// ---------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args[0] === "--selftest") {
  console.log("geometry-guard self-test");
  const bad = selfTest();
  console.log(bad ? "\n  " + bad + " FAILED" : "\n  self-test clean");
  process.exit(bad ? 1 : 0);
}

const files = args.length ? args : ENFORCED;
const violations = checkFiles(files);
if (violations.length === 0) {
  console.log("geometry-guard: PASS — " + files.length + " file(s), no reintroduced geometry");
  process.exit(0);
}
console.log("geometry-guard: FAIL — " + violations.length + " violation(s)");
for (const v of violations) {
  console.log("  " + v.file + ":" + v.line + "  [" + v.rule + "] " + v.key + ": " + v.value +
    "  ->  " + v.expected + "   (" + v.why + ")");
}
process.exit(1);

// LIMITATIONS (recorded, not hidden)
// - Colour literals are NOT enforced. 7.2's scope names them, but the enforced files still hold 98
//   of them; turning the rule on would fail the production tree rather than guard it. Enforcing
//   colour requires a cleaning pass first.
// - Only `style={{ ... }}` blocks are seen. Geometry inside `const x: React.CSSProperties = {...}`
//   objects is invisible to this guard.
// - CSS files are out of scope; 7.1 and 7.2 are about inline JSX geometry.
