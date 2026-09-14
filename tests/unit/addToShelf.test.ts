// ADD IS NOT MOVE.
//
// Two verbs that write to the same table and differ only in what they leave behind, which is exactly
// the pair that gets conflated. The history is on record: a drag that only ever joined the
// destination and never left the source was read by the reader as the book having been COPIED, and
// the repair at the time was to make arriving somewhere mean leaving everywhere. Now both are
// wanted, so both exist — and what keeps them apart is that they are separate calls with separate
// names, end to end, rather than one call with a flag.
//
// This pins that separation at each layer it could quietly collapse in.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");
const COMMANDS = read("src-tauri/src/commands/mod.rs");
const REGISTER = read("src-tauri/src/lib.rs");
const IPC = read("src/lib/ipc.ts");
const DETAILS = read("src/features/library/design/BookDetails.tsx");
const DESIGN = read("src/features/library/design/LibraryDesign.tsx");

/**
 * One Rust function body, by the signature line that starts it.
 *
 * The closing brace is matched whatever the line endings are. This file is stored with CRLF, so an
 * LF-only needle found nothing and `indexOf` answered -1 — `slice(at, -1)` then returned almost the
 * whole rest of the file, and the "body" under test quietly became every command that follows it. A
 * `not.toContain` catches that by failing; a `toContain` would have passed on text belonging to some
 * other function entirely. So the terminator is now required to exist, and its absence is a failure
 * with a name rather than a silently enormous slice.
 */
const rustFn = (name: string): string => {
  const at = COMMANDS.indexOf(`pub fn ${name}(`);
  expect(at, `no command ${name}`).toBeGreaterThan(-1);
  const end = COMMANDS.slice(at).search(/\r?\n\}\r?\n/);
  expect(end, `no closing brace for ${name}`).toBeGreaterThan(-1);
  return COMMANDS.slice(at, at + end);
};

describe("the additive command", () => {
  it("adds rather than moves, and is reachable", () => {
    // `ensure_on` keeps every other membership AND leaves the book where it already sits on that
    // shelf; `place_book` sweeps. The command must call the first — calling the second would make
    // «add to shelf» a move wearing the wrong label.
    //
    // The additive side is two functions, and the distinction is real: `add_to` positions (no
    // neighbour named means the END of the shelf), while `ensure_on` says nothing about position,
    // which is what choosing a shelf from a list means. Neither sweeps.
    const add = rustFn("library_add_book_to_shelf");
    expect(add).toContain("placement::ensure_on");
    expect(add).not.toContain("place_book");
    expect(REGISTER).toContain("commands::library_add_book_to_shelf");
  });

  it("is a different command from the one that moves", () => {
    // Separate entry points, so a reader of any call site can see which verb it is.
    const move = rustFn("library_place_book");
    expect(move).toContain("placement::move_between");
    expect(IPC).toContain('invoke<PlaceResult>("library_add_book_to_shelf"');
    expect(IPC).toContain('invoke<PlaceResult>("library_place_book"');
  });

  it("never removes a membership the caller did not name", () => {
    // THE REACHABLE LOSS THIS PINS SHUT. `library_place_book` swept when given no source, and the
    // select tray's «keep where they are» passes exactly that — a choice the calling code itself
    // documents as «an honest add». Measured through the command: a book on two shelves moved with
    // no source came back on one. A move leaves the shelf it is told to leave and no other.
    const move = rustFn("library_place_book");
    expect(move).not.toContain("placement::place_book");
    expect(move).toMatch(/None => library::placement::add_to/);
  });
});

describe("Book Details", () => {
  it("takes every membership, not one", () => {
    // The prop is plural. A singular one forced whoever computed it to choose among several and
    // present the choice as the answer — and the panel's «move» would then have destroyed a
    // membership the reader never named.
    expect(DETAILS).toMatch(/placements: \{[^}]*shelf: ShelfNode[^}]*\}\[\];/);
    expect(DETAILS).not.toMatch(/placement: \{[^}]*\} \| null;/);
    expect(DESIGN).toContain("placements={placementsOf(");
  });

  it("lists them from the arrangement without picking a home", () => {
    // `placementsOf` maps EVERY membership. If it ever reached for a single container again, the
    // list would collapse back to one row.
    const at = DESIGN.indexOf("const placementsOf = useCallback(");
    expect(at).toBeGreaterThan(-1);
    const body = DESIGN.slice(at, DESIGN.indexOf("  );", at));
    expect(body).toContain("membershipsOf(");
    expect(body).not.toContain("soleContainerOf(");
  });

  it("adds with the additive call and removes one named shelf", () => {
    expect(DETAILS).toContain("libraryAddBookToShelf(book.id,");
    // Removal names its shelf. It used to remove «the» shelf the book was on, which only meant
    // something while a book had one.
    expect(DETAILS).toMatch(/const removeFrom = async \(shelfId: string\)/);
    expect(DETAILS).toContain("collectionRemoveBook(shelfId, book.id)");
  });

  it("offers every shelf in the library except the ones already held", () => {
    // TWO PROPERTIES. It must reach the WHOLE library — it once offered `shelvesOf(effectiveCase)`,
    // and a book across several cabinets has no chosen cabinet, so it saw the loose shelves and
    // nothing else. And it must never offer a shelf the book is already on: adding there is a
    // no-op, and for a move it would be a move that went nowhere.
    expect(DETAILS).toMatch(/const everyShelf:[\s\S]{0,400}props\.cases\.flatMap/);
    expect(DETAILS).toMatch(/const everyShelf:[\s\S]{0,400}props\.loose\.map/);
    expect(DETAILS).toContain(
      "const addable = everyShelf.filter((e) => !places.some((pl) => pl.shelf.id === e.shelf.id));");
    const at = DETAILS.indexOf("const destinationGroups = (exclude: string | null) => {");
    expect(at).toBeGreaterThan(-1);
    const body = DETAILS.slice(at, at + 900);
    expect(body).toContain("e.shelf.id !== exclude");
    expect(body).toContain("!places.some((pl) => pl.shelf.id === e.shelf.id)");
  });

  it("keeps destinations behind one control rather than on the panel", () => {
    // The wall this replaced: one chip per shelf, always drawn, four such rows competing. A
    // library of thirty shelves put thirty controls on the panel before the reader had asked for
    // any of them. Destinations now live in the chooser, grouped by cabinet and searchable.
    expect(DETAILS).toContain("function Chooser(props: {");
    expect(DETAILS).toContain('data-add-open="1"');
    // GROUPED BY CABINET, and each group carries that cabinet's ink — which is the only thing that
    // separates two shelves called «المفضّلة». A flat list of shelf names cannot.
    expect(DETAILS).toMatch(/groups: \{[^}]*ink: string \| null;[^;]*items:/);
    expect(DETAILS).toContain("ink: c.ink ?? null");
    // IN THE FLOW, not floating over the dialog: no absolute placement, no flip, no shadow.
    const at = DETAILS.indexOf("function Chooser(props: {");
    // A bounded window rather than a search for the closing brace: line endings are CRLF here, so
    // "\n}" lands on the first thing that merely looks like one.
    const body = DETAILS.slice(at, at + 6000);
    expect(body).not.toContain('position: "absolute"');
    expect(body).not.toContain("boxShadow");
    expect(body).toContain("borderInlineStart");
    // …and the old picker is gone, so a held shelf cannot be drawn as a destination at all.
    expect(DETAILS).not.toContain("shelvesOf(effectiveCase).map(");
    expect(DETAILS).not.toContain('{on ? `${s.name}  ✕` : s.name}');
  });

  it("gives every membership its own move and its own remove", () => {
    // A move leaves ONE shelf, and the row is the shelf it leaves — which is why the control sits
    // on the row. The Case → Shelf picker it replaces had no way to name which membership it acted
    // on, so it only ever worked for a book that had exactly one.
    expect(DETAILS).toContain("data-move-from={pl.shelf.id}");
    expect(DETAILS).toContain("data-remove-shelf={pl.shelf.id}");
    expect(DETAILS).toMatch(/const moveMembership = async \(from: string, to: ShelfNode\)/);
    expect(DETAILS).toContain("libraryPlaceBook(book.id, to.id, null, null, from)");
  });

  it("tells the three membership states apart", () => {
    // `place` is null both for a book on no shelf and for a book on several, and the panel read
    // that null as «not filed» — so a book listed on two shelves was told it was on none.
    expect(DETAILS).toContain("const multi = places.length > 1;");
    expect(DETAILS).toContain("const unfiled = places.length === 0;");
    expect(DETAILS).toMatch(/unfiled\s*\?\s*t\("lib\.notFiledHint"\)/);
    // …and no chip is lit for a book whose cabinet cannot be named.
    expect(DETAILS).toMatch(/multi \? undefined : \(place\?\.caseNode\?\.id \?\? null\)/);
  });
});
