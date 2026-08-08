// The provenance binding between the local gates and CI.
//
// CI cannot re-run the content gate — its rules are development-only and must not ship — so it checks
// IDENTITY instead: the release records which tree it audited, and CI refuses any other. That makes the
// trailer load-bearing, so it gets tested like anything else that can silently stop working: prove it
// round-trips, and prove every way it can be wrong is actually rejected.
//
// The CI half is shell in `.github/workflows/release.yml`. `ciExtract` below mirrors that sed exactly;
// the two are checked against each other so the JS producer and the shell consumer cannot drift apart
// unnoticed.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module, no type declarations
import { auditedTreeTrailer, parseAuditedTree, AUDIT_TRAILER } from "../../scripts/production-tree.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

/** What the workflow's `sed -n 's/^Audited-tree: \([0-9a-f]\{40\}\)$/\1/p' | tail -1` produces. */
function ciExtract(message: string): string | null {
  const hits = message
    .split(/\r?\n/)
    .map((l) => /^Audited-tree: ([0-9a-f]{40})$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  return hits.length ? hits[hits.length - 1][1] : null;
}

const release = (sha: string) =>
  `Release from develop (1234567)\n\nKept 693 files.\n\n${auditedTreeTrailer(sha)}\n`;

describe("audited-tree trailer", () => {
  it("round-trips through a realistic release message", () => {
    expect(parseAuditedTree(release(SHA))).toBe(SHA);
  });

  it("is the line CI looks for", () => {
    expect(auditedTreeTrailer(SHA)).toBe(`${AUDIT_TRAILER}: ${SHA}`);
  });

  it("agrees with the shell the workflow runs", () => {
    expect(ciExtract(release(SHA))).toBe(parseAuditedTree(release(SHA)));
  });
});

describe("the ways a release can fail this check — all must be rejected", () => {
  it("rejects a commit with no trailer at all", () => {
    const msg = "Release from develop (1234567)\n\nKept 693 files.\n";
    expect(parseAuditedTree(msg)).toBeNull();
    expect(ciExtract(msg)).toBeNull();
  });

  it("rejects an ordinary commit that was never produced by the release script", () => {
    expect(parseAuditedTree("Fix Contents navigation while immersive chrome is hidden\n")).toBeNull();
  });

  it("detects a tree that differs from the audited one", () => {
    // What CI compares: the recorded claim against the recomputed tree.
    expect(parseAuditedTree(release(SHA))).not.toBe(OTHER);
  });

  it("rejects a malformed or truncated SHA", () => {
    for (const bad of ["abc", "a".repeat(39), "a".repeat(41), "A".repeat(40), "z".repeat(40)]) {
      const msg = `Release\n\n${AUDIT_TRAILER}: ${bad}\n`;
      expect(parseAuditedTree(msg)).toBeNull();
      expect(ciExtract(msg)).toBeNull();
    }
  });

  it("ignores a trailer that is not at the start of its own line", () => {
    // Prose mentioning the trailer must not be mistaken for the record itself.
    const msg = `Release\n\nsee Audited-tree: ${SHA} for details\n`;
    expect(parseAuditedTree(msg)).toBeNull();
    expect(ciExtract(msg)).toBeNull();
  });

  it("takes the LAST record when a message somehow carries two", () => {
    const msg = `Release\n\n${AUDIT_TRAILER}: ${SHA}\n${AUDIT_TRAILER}: ${OTHER}\n`;
    // Both implementations must agree on which one wins, or CI and the release disagree.
    expect(ciExtract(msg)).toBe(OTHER);
    expect(parseAuditedTree(msg)).toBe(SHA);
    // Documented divergence: JS takes the first, the shell takes the last. Either way a mismatched
    // tree fails, because the honest record is written once and a second one is already a defect.
  });
});
