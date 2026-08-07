// SCORE THE CANDIDATE ARCHITECTURES against the real corpus.
//
// The root cause was proven by intervention. A recommendation deserves the same treatment: rather
// than arguing that one design is better, each candidate is EVALUATED over every EPUB we can reach,
// and the outcome per book is counted. The winner should fall out of the numbers.
//
// Outcome classes, defined so they can be counted without judgement:
//
//   AUTHORED     labels and targets come from the book's own navigation metadata (nav or NCX).
//   TITLED       labels come from each document's own <title>; targets are the documents themselves.
//   POSITIONAL   labels are ordinals — the book supplied no label. MISLEADING if presented as chapters.
//   UNNAVIGABLE  <=1 entry for a many-document book: the reader cannot move.
//
// Cost is counted as DOCUMENTS PARSED at open, which is the dominant term (a spine walk parses every
// XHTML document; reading a nav document or an NCX parses one file).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectEpub } from "./epub-nav.mjs";

const files = new Map();
try {
  const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
  for (const b of db.prepare("SELECT title, file_path, format FROM books").all())
    if ((b.format ?? "").toLowerCase() === "epub" && existsSync(b.file_path)) files.set(b.file_path, b.title);
} catch { /* library optional */ }
const corpus = process.env.SARD_CORPUS ?? "M:/ProjectDocs/sard/Corpus";
if (existsSync(corpus))
  for (const n of readdirSync(corpus)) if (n.toLowerCase().endsWith(".epub")) files.set(join(corpus, n), n);

const books = [];
for (const [path, title] of files) {
  try {
    const r = inspectEpub(path);
    if (!r.ok) continue;
    books.push({
      title, spine: r.spine.linear,
      navLinks: r.navDoc.tocLinks ?? 0,
      navResolved: r.navDoc.validation?.resolved ?? 0,
      navCover: r.navDoc.validation?.coverageOfLinearPct ?? 0,
      navPresent: r.navDoc.present,
      ncxPoints: r.ncx.navPoints ?? 0,
      ncxResolved: r.ncx.validation?.resolved ?? 0,
      ncxCover: r.ncx.validation?.coverageOfLinearPct ?? 0,
      titled: r.documents.withTitle, headed: r.documents.withHeading, docs: r.documents.count,
    });
  } catch { /* skip unreadable */ }
}

// Sard's existing degeneracy rule, reproduced here so the simulation matches the product.
const TOC_MIN_ENTRIES = 3, TOC_MIN_RATIO_PCT = 10;
const degenerate = (entries, spine) =>
  spine > TOC_MIN_ENTRIES && entries < Math.max(TOC_MIN_ENTRIES, Math.floor((spine * TOC_MIN_RATIO_PCT) / 100));
// What the CURRENT stack counts: the nav document when present, else the NCX.
const countedEntries = (b) => (b.navPresent ? b.navLinks : b.ncxPoints);
// A source is usable when it is not degenerate for this spine AND its targets resolve into it.
const usable = (entries, resolved, cover, spine) => entries > 0 && !degenerate(entries, spine) && resolved > 0 && cover >= 25;

const CANDIDATES = {
  // A — status quo: engine picks nav-if-present; Sard synthesises from the spine when flagged.
  A: (b) => {
    const flagged = degenerate(countedEntries(b), b.spine);
    if (!flagged) {
      const navOk = b.navPresent && b.navLinks > 0;
      return { outcome: navOk ? "AUTHORED" : b.ncxPoints > 1 ? "AUTHORED" : "UNNAVIGABLE", parsed: 1, deterministic: true };
    }
    return { outcome: b.headed >= b.docs * 0.5 ? "TITLED" : "POSITIONAL", parsed: b.docs, deterministic: false, misleading: true };
  },
  // B — minimal patch: same, but consult the NCX before synthesising.
  B: (b) => {
    const flagged = degenerate(countedEntries(b), b.spine);
    if (!flagged) return { outcome: b.navPresent && b.navLinks > 0 ? "AUTHORED" : b.ncxPoints > 1 ? "AUTHORED" : "UNNAVIGABLE", parsed: 1, deterministic: true };
    if (usable(b.ncxPoints, b.ncxResolved, b.ncxCover, b.spine)) return { outcome: "AUTHORED", parsed: 1, deterministic: true };
    return { outcome: b.headed >= b.docs * 0.5 ? "TITLED" : "POSITIONAL", parsed: b.docs, deterministic: false, misleading: true };
  },
  // C — validated ranking, one selector shared by the flag and the display.
  C: (b) => {
    if (usable(b.navLinks, b.navResolved, b.navCover, b.spine)) return { outcome: "AUTHORED", parsed: 1, deterministic: true };
    if (usable(b.ncxPoints, b.ncxResolved, b.ncxCover, b.spine)) return { outcome: "AUTHORED", parsed: 1, deterministic: true };
    if (b.titled >= b.docs - 2 && b.docs > 3) return { outcome: "TITLED", parsed: b.docs, deterministic: false };
    if (b.headed >= b.docs * 0.5) return { outcome: "TITLED", parsed: b.docs, deterministic: false };
    return { outcome: "POSITIONAL", parsed: b.docs, deterministic: false, misleading: false }; // labelled honestly
  },
  // D — patch the vendored engine to validate the nav document; no Sard-side recovery at all.
  D: (b) => {
    if (usable(b.navLinks, b.navResolved, b.navCover, b.spine)) return { outcome: "AUTHORED", parsed: 1, deterministic: true };
    if (usable(b.ncxPoints, b.ncxResolved, b.ncxCover, b.spine)) return { outcome: "AUTHORED", parsed: 1, deterministic: true };
    return { outcome: "UNNAVIGABLE", parsed: 1, deterministic: true };
  },
  // E — no recovery: show exactly what the engine returns today.
  E: (b) => {
    const navOk = b.navPresent && b.navLinks > 0;
    if (navOk) return { outcome: b.navLinks > 1 ? "AUTHORED" : "UNNAVIGABLE", parsed: 1, deterministic: true };
    return { outcome: b.ncxPoints > 1 ? "AUTHORED" : "UNNAVIGABLE", parsed: 1, deterministic: true };
  },
};

console.log(`\nBooks evaluated: ${books.length}\n`);
const header = ["cand", "AUTHORED", "TITLED", "POSITIONAL", "UNNAVIG", "MISLEADING", "docs parsed", "non-determ"];
console.log(header.map((h, i) => (i === 0 ? h.padEnd(5) : h.padStart(12))).join(""));
const results = {};
for (const [name, fn] of Object.entries(CANDIDATES)) {
  const rs = books.map(fn);
  const count = (o) => rs.filter((r) => r.outcome === o).length;
  const row = {
    authored: count("AUTHORED"), titled: count("TITLED"), positional: count("POSITIONAL"),
    unnav: count("UNNAVIGABLE"), misleading: rs.filter((r) => r.misleading).length,
    parsed: rs.reduce((a, r) => a + r.parsed, 0), nondet: rs.filter((r) => !r.deterministic).length,
  };
  results[name] = row;
  console.log(
    name.padEnd(5) +
      String(row.authored).padStart(12) + String(row.titled).padStart(12) + String(row.positional).padStart(12) +
      String(row.unnav).padStart(12) + String(row.misleading).padStart(12) +
      row.parsed.toLocaleString("en-US").padStart(12) + String(row.nondet).padStart(12),
  );
}

// Which books change relative to the status quo — the regression surface of each candidate.
console.log(`\nBooks whose contents CHANGE vs candidate A (the status quo):`);
for (const name of ["B", "C", "D", "E"]) {
  const changed = books.filter((b, i) => CANDIDATES[name](b).outcome !== CANDIDATES.A(b).outcome);
  console.log(`  ${name}: ${changed.length}`);
  for (const b of changed.slice(0, 6))
    console.log(`       ${String(b.title).slice(0, 36).padEnd(36)} A=${CANDIDATES.A(b).outcome.padEnd(11)} ${name}=${CANDIDATES[name](b).outcome}`);
}
