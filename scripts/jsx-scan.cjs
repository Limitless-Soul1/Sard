// Shared scanning primitives for the Stage 7 tools.
//
// WHY THIS EXISTS: the first cut of both tools tracked quotes but not COMMENTS. These files carry
// prose comments full of apostrophes ("the case's own ink", "the reader's settings"), and every one
// of those opened a fake string state that never closed, which corrupted brace tracking. The
// counter reported 2 style blocks in a file that has 12, one of them 23,748 characters long,
// and every number derived from it was wrong. Comments are now blanked before any scanning.

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BT = String.fromCharCode(96);

/**
 * Return a string of IDENTICAL LENGTH with comment bodies replaced by spaces, so character
 * offsets remain valid for editing the original text.
 */
function blankComments(src) {
  const out = src.split("");
  let i = 0, q = null;
  while (i < src.length) {
    const ch = src[i], prev = src[i - 1], next = src[i + 1];
    if (q) {
      if (ch === q && prev !== BS) q = null;
      i++;
      continue;
    }
    if (ch === DQ || ch === SQ || ch === BT) { q = ch; i++; continue; }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) if (src[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Character ranges [start, end) of every style={{ ... }} OBJECT body.
 * Scans the comment-blanked text; the ranges apply to the original.
 */
function blockRanges(src) {
  const scan = blankComments(src);
  const out = [];
  let i = 0;
  for (;;) {
    i = scan.indexOf("style={{", i);
    if (i === -1) break;
    let d = 0, q = null, j = i + "style=".length, start = -1;
    for (; j < scan.length; j++) {
      const ch = scan[j], prev = scan[j - 1];
      if (q) { if (ch === q && prev !== BS) q = null; continue; }
      if (ch === DQ || ch === SQ || ch === BT) { q = ch; continue; }
      if (ch === "{") { d++; if (d === 2) start = j + 1; continue; }
      if (ch === "}") {
        d--;
        if (d === 1 && start !== -1) { out.push([start, j]); start = -1; }
        if (d === 0) break;
        continue;
      }
    }
    i = j + 1;
  }
  return out;
}

/** Split a block body into top-level key/value pairs. Body must already be comment-blanked. */
function pairs(body) {
  const out = [];
  let depth = 0, key = null, buf = "", q = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i], prev = body[i - 1];
    if (q) { buf += ch; if (ch === q && prev !== BS) q = null; continue; }
    if (ch === DQ || ch === SQ || ch === BT) { q = ch; buf += ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; buf += ch; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; buf += ch; continue; }
    if (ch === ":" && depth === 0 && key === null) { key = buf.trim(); buf = ""; continue; }
    if (ch === "," && depth === 0) {
      if (key !== null) out.push([key, buf.trim()]);
      key = null; buf = ""; continue;
    }
    buf += ch;
  }
  if (key !== null && buf.trim()) out.push([key, buf.trim()]);
  return out;
}

function selfTest() {
  const A = "const x = <div style={{ width: 20 }} />;";
  const B = [
    "// the case's own ink and the reader's margin",
    "const y = <div style={{ height: 30, gap: 8 }} />;",
    "/* a block comment with a brace { and an apostrophe ' */",
    "const z = <div style={{ padding: 12 }} />;",
  ].join("\n");
  const C = 'const w = <div style={{ a: 1 }}>{"it' + BS + "'" + 's"}</div>;';

  const checks = [];
  const rA = blockRanges(A);
  checks.push(["plain block found", rA.length === 1, rA.length]);

  // the decisive case: comments with apostrophes must not break brace tracking
  const rB = blockRanges(B);
  checks.push(["two blocks found despite apostrophes in comments", rB.length === 2, rB.length]);
  const bodies = rB.map((r) => B.slice(r[0], r[1]));
  checks.push(["second block is the padding one", bodies[1].indexOf("padding") !== -1, bodies[1]]);
  checks.push(["bodies stay short (no runaway)", bodies.every((b) => b.length < 40), bodies.map((b) => b.length)]);

  const rC = blockRanges(C);
  checks.push(["escaped quote handled", rC.length === 1, rC.length]);

  // offsets must still index the ORIGINAL text correctly
  const body0 = B.slice(rB[0][0], rB[0][1]);
  checks.push(["offsets valid against original", body0.indexOf("height: 30") !== -1, body0]);

  const p = pairs(" height: 30, gap: 8 ");
  checks.push(["pairs parses two", p.length === 2, p]);

  let bad = 0;
  for (const c of checks) {
    if (!c[1]) bad++;
    console.log("  " + (c[1] ? "ok   " : "FAIL ") + c[0] + (!c[1] && c[2] !== undefined ? "   got: " + JSON.stringify(c[2]) : ""));
  }
  return bad;
}

module.exports = { blankComments: blankComments, blockRanges: blockRanges, pairs: pairs, selfTest: selfTest };

if (require.main === module) {
  console.log("jsx-scan self-test");
  const bad = selfTest();
  console.log(bad ? "\n  " + bad + " FAILED" : "\n  self-test clean");
  process.exit(bad ? 1 : 0);
}
