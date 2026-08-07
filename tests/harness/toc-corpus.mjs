// HOW MANY BOOKS WOULD CHANGE if the contents list were recovered from the NCX instead of synthesised?
//
// The investigation established what the three reported books contain. Before anyone decides whether
// to preserve, redesign or replace the synthetic contents, the question that decides the blast radius
// is: across the whole library, which books would get a DIFFERENT contents list, and would it be
// better or merely different?
//
// This reads every EPUB in the library directly (never through foliate) and classifies it by the
// tiers under discussion:
//
//   TIER 1  flagged degenerate AND carries a usable NCX  -> the book's own titles are recoverable
//   TIER 2  flagged, no usable NCX, but every document has a <title>  -> in-file labels available
//   TIER 3  flagged, neither                              -> numbering is the only honest answer
//   UNAFFECTED  not flagged — its nav document is fine and nothing would change
//
// Read-only: it opens the database read-only and never launches the app.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { inspectEpub } from "./epub-nav.mjs";

const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
const books = db.prepare("SELECT id, title, file_path, format, toc_degenerate FROM books ORDER BY title").all();

const rows = [];
for (const b of books) {
  if ((b.format ?? "").toLowerCase() !== "epub" || !existsSync(b.file_path)) continue;
  let r;
  try {
    r = inspectEpub(b.file_path);
  } catch (e) {
    rows.push({ title: b.title, tier: "UNREADABLE", note: e.message.slice(0, 60) });
    continue;
  }
  if (!r.ok) { rows.push({ title: b.title, tier: "UNREADABLE", note: "no OPF" }); continue; }

  const spine = r.spine.linear;
  const nav = r.navDoc.tocLinks ?? 0;
  const ncx = r.ncx.navPoints ?? 0;
  const flagged = b.toc_degenerate === 1;
  // "Usable" is deliberately the same shape as the existing degeneracy rule, applied to the NCX: a
  // source is usable when it is not itself far too small for the spine it claims to describe.
  const ncxUsable = ncx >= Math.max(3, Math.floor(spine * 0.1));
  const titles = r.documents.withTitle;
  const allTitled = titles >= r.documents.count - 2;

  const tier = !flagged ? "UNAFFECTED" : ncxUsable ? "TIER 1 (NCX)" : allTitled ? "TIER 2 (<title>)" : "TIER 3 (numbering)";
  rows.push({ title: b.title, tier, spine, nav, ncx, titles, headings: r.documents.withHeading, flagged });
}

const by = (t) => rows.filter((r) => r.tier === t);
console.log(`\nEPUBs examined: ${rows.length}\n`);
console.log("  tier                 books");
for (const t of ["TIER 1 (NCX)", "TIER 2 (<title>)", "TIER 3 (numbering)", "UNAFFECTED", "UNREADABLE"]) {
  console.log(`  ${t.padEnd(20)} ${by(t).length}`);
}

console.log(`\nBooks whose contents list WOULD CHANGE (currently synthesised):`);
for (const r of rows.filter((x) => x.flagged)) {
  console.log(
    `  ${r.tier.padEnd(19)} ${String(r.title).slice(0, 34).padEnd(34)} ` +
      `spine ${String(r.spine).padStart(5)}   nav ${String(r.nav).padStart(4)}   ncx ${String(r.ncx).padStart(5)}   ` +
      `<title> ${String(r.titles).padStart(5)}   headings ${String(r.headings).padStart(4)}`,
  );
}

// A book that is NOT flagged but whose NCX disagrees with its nav document is worth knowing about: it
// would be untouched by any of this, and that is the point — no change is proposed for those.
const disagree = rows.filter((r) => !r.flagged && r.ncx > 0 && r.nav > 0 && Math.abs(r.ncx - r.nav) > Math.max(5, r.nav * 0.2));
console.log(`\nUnflagged books whose NCX and nav document disagree substantially: ${disagree.length}`);
for (const r of disagree.slice(0, 10)) {
  console.log(`  ${String(r.title).slice(0, 40).padEnd(40)} nav ${r.nav}   ncx ${r.ncx}   spine ${r.spine}`);
}
