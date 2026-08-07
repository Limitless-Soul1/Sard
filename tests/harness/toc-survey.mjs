// A NAVIGATION SURVEY over every EPUB we can reach — the library AND the corpus.
//
// This exists to convert two named unknowns into measured facts before any design is committed:
//
//   U1  Is there a real book whose NCX is COMPLETE BUT WRONG — many entries that resolve nowhere?
//       Entry count alone would rate such a source excellent. If U1 occurs, ranking sources by
//       authority is unsafe without validating targets, and the validation is not optional.
//
//   U2  Is there a book with a PARTIALLY populated nav document — not one junk entry, not complete,
//       but somewhere in between? That is the case most likely to embarrass a "pick the best source"
//       design, because "usable" stops being obvious.
//
// It reports every source's resolution rate and spine coverage, so a source is judged by whether it
// describes THIS book rather than by how many rows it happens to contain.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectEpub } from "./epub-nav.mjs";

const files = new Map(); // path -> label

try {
  const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
  for (const b of db.prepare("SELECT title, file_path, format, toc_degenerate FROM books").all()) {
    if ((b.format ?? "").toLowerCase() === "epub" && existsSync(b.file_path)) {
      files.set(b.file_path, { title: b.title, flagged: b.toc_degenerate === 1, source: "library" });
    }
  }
} catch (e) {
  console.log(`(library unavailable: ${e.message})`);
}

// Corpus books are third-party works living OUTSIDE the repo and are only ever read locally.
const corpus = process.env.SARD_CORPUS ?? "M:/ProjectDocs/sard/Corpus";
if (existsSync(corpus)) {
  for (const n of readdirSync(corpus)) {
    if (!n.toLowerCase().endsWith(".epub")) continue;
    const p = join(corpus, n);
    if (!files.has(p)) files.set(p, { title: n.replace(/\.epub$/i, ""), flagged: null, source: "corpus" });
  }
}

const rows = [];
for (const [path, meta] of files) {
  let r;
  try {
    r = inspectEpub(path);
  } catch (e) {
    rows.push({ ...meta, error: e.message.slice(0, 50) });
    continue;
  }
  if (!r.ok) { rows.push({ ...meta, error: "no OPF" }); continue; }
  const nav = r.navDoc.validation, ncx = r.ncx.validation;
  rows.push({
    ...meta,
    spine: r.spine.linear,
    navLinks: r.navDoc.tocLinks ?? 0,
    navResolved: nav?.resolved ?? 0,
    navUnresolved: nav?.unresolved ?? 0,
    navCover: nav?.coverageOfLinearPct ?? 0,
    ncxPoints: r.ncx.navPoints ?? 0,
    ncxResolved: ncx?.resolved ?? 0,
    ncxUnresolved: ncx?.unresolved ?? 0,
    ncxCover: ncx?.coverageOfLinearPct ?? 0,
    titled: r.documents.withTitle,
    headed: r.documents.withHeading,
    docs: r.documents.count,
    ncxMisses: ncx?.sampleMisses ?? [],
    navMisses: nav?.sampleMisses ?? [],
  });
}

const ok = rows.filter((r) => !r.error);
console.log(`\nEPUBs surveyed: ${rows.length}  (library ${rows.filter((r) => r.source === "library").length}, corpus ${rows.filter((r) => r.source === "corpus").length}); unreadable ${rows.length - ok.length}\n`);

// U1 — a source with many entries that resolve nowhere.
const u1 = ok.filter((r) => r.ncxPoints >= 5 && r.ncxUnresolved > 0);
console.log(`U1  NCXs with >=5 entries and ANY unresolvable target: ${u1.length}`);
for (const r of u1) {
  console.log(`      ${r.title.slice(0, 38).padEnd(38)} points ${r.ncxPoints}  resolved ${r.ncxResolved}  UNRESOLVED ${r.ncxUnresolved}  e.g. ${JSON.stringify(r.ncxMisses[0] ?? null)}`);
}
const navBad = ok.filter((r) => r.navLinks >= 5 && r.navUnresolved > 0);
console.log(`    nav documents with >=5 links and ANY unresolvable target: ${navBad.length}`);
for (const r of navBad) {
  console.log(`      ${r.title.slice(0, 38).padEnd(38)} links ${r.navLinks}  resolved ${r.navResolved}  UNRESOLVED ${r.navUnresolved}  e.g. ${JSON.stringify(r.navMisses[0] ?? null)}`);
}

// U2 — nav documents that are neither trivially broken nor complete.
const partial = ok.filter((r) => r.navLinks > 1 && r.navCover > 0 && r.navCover < 60);
console.log(`\nU2  nav documents covering >0% but <60% of the linear spine: ${partial.length}`);
for (const r of partial) {
  console.log(`      ${r.title.slice(0, 38).padEnd(38)} spine ${String(r.spine).padStart(5)}  navLinks ${String(r.navLinks).padStart(5)}  coverage ${String(r.navCover).padStart(3)}%  ncx ${String(r.ncxPoints).padStart(5)} (${r.ncxCover}%)`);
}

// Where would each book's contents come from under a validated ranking?
const tierOf = (r) => {
  const usable = (entries, cover) => entries >= 3 && cover >= 25;
  if (usable(r.navResolved, r.navCover)) return "A nav";
  if (usable(r.ncxResolved, r.ncxCover)) return "B ncx";
  if (r.titled >= r.docs - 2 && r.docs > 3) return "C title";
  if (r.headed >= Math.floor(r.docs * 0.5)) return "D heading";
  return "E numbering";
};
const tally = new Map();
for (const r of ok) tally.set(tierOf(r), (tally.get(tierOf(r)) ?? 0) + 1);
console.log(`\nSource that a VALIDATED ranking would choose:`);
for (const [t, n] of [...tally].sort()) console.log(`      ${t.padEnd(12)} ${n}`);

console.log(`\nBooks where the chosen source would NOT be the nav document:`);
for (const r of ok.filter((x) => tierOf(x) !== "A nav")) {
  console.log(
    `      ${tierOf(r).padEnd(11)} ${r.title.slice(0, 34).padEnd(34)} [${r.source}] spine ${String(r.spine).padStart(5)}  ` +
      `nav ${String(r.navLinks).padStart(4)}/${String(r.navCover).padStart(3)}%  ncx ${String(r.ncxPoints).padStart(5)}/${String(r.ncxCover).padStart(3)}%  ` +
      `titled ${r.titled}/${r.docs}  headed ${r.headed}`,
  );
}
