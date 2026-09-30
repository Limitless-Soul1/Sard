// A RE-SAVED CARD MUST NOT KEEP ITS OLD PICTURE IN THE GALLERY.
//
// ## The defect
//
// A card's PNG lives at `photocards/<card-id>.png`. Re-saving REWRITES that file, so the path — and
// therefore `convertFileSrc(path)` — is byte-identical before and after. The gallery renders its
// tiles with `key={c.id}`, which is stable across an edit, so React finds the same key and the same
// `src`, touches neither, and the `<img>` goes on painting the picture it decoded the first time.
// Nothing in that path ever asks for the new bytes.
//
// ## What was measured in the running gallery
//
// Changing a card's paper and saving:
//     PNG on disk        96,481 -> 96,072 bytes, mtime advanced   (written at once)
//     editor             the new paper, immediately
//     gallery thumbnail  the OLD colour
//     fetch(url, {cache:"no-store"})  ->  200, the NEW bytes, headers only
//                                          {content-length, content-type}
// so the file, the database and the protocol were all correct and current. Then, in one clean
// session with no fetch to disturb the cache:
//     after the save                          the old colour
//     <img> replaced by a clone, same src      STILL the old colour
//     src given a changing token               the new colour
// A remount is therefore NOT enough — the browser answers for that URL from its own memory. Only a
// URL that differs fetches the new bytes.
//
// ## Why a token here and not for covers
//
// `coverSrc.ts` refuses `?v=` and is right to: a cover's filename carries a HASH OF ITS BYTES, so
// its URL already changes if and only if the image does. A photo card's filename carries its
// IDENTITY, so its URL cannot change on its own. Content-addressing these files the way covers are
// is the consistent long answer; the token is the smallest correct one today. What these pin is
// that it stays PRECISE: one card, the one that was edited, and nothing else.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const GALLERY = readFileSync(join(process.cwd(), "src/features/photo/PhotoGallery.tsx"), "utf8");
const COVERS = readFileSync(join(process.cwd(), "src/features/library/coverSrc.ts"), "utf8");
/** Source with comment lines stripped — the prose above quotes the old shape on purpose. */
const code = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

describe("the gallery asks for the picture of the card it is drawing now", () => {
  it("every card picture goes through one function, so the rule cannot be copied and drift", () => {
    expect(code(GALLERY)).toContain("function cardSrc(imagePath: string, stamp?: number): string {");
    // No tile, lightbox or export builds its own URL any more.
    expect(code(GALLERY)).not.toMatch(/convertFileSrc\((c|open|card)\.image_path\)/);
    expect(code(GALLERY).match(/convertFileSrc\(/g)?.length).toBe(1);
  });

  it("the token is only added when there is one — an untouched card's URL is unchanged", () => {
    expect(code(GALLERY)).toContain("return stamp ? `${url}${url.includes(\"?\") ? \"&\" : \"?\"}v=${stamp}` : url;");
  });

  it("closing the composer stamps exactly the card that was open, and no other", () => {
    const c = code(GALLERY);
    expect(c).toContain("const id = editing.id;");
    expect(c).toContain("setResaved((m) => ({ ...m, [id]: Date.now() }));");
    // A blanket wipe would re-fetch every picture in the gallery on every edit.
    expect(c).not.toMatch(/setResaved\(\{\}\)/);
    expect(c).not.toMatch(/setResaved\(\(\)\s*=>\s*\(\{\}\)\)/);
  });

  it("the thumbnail, the enlarged view and the export all read the same stamp", () => {
    const c = code(GALLERY);
    expect(c).toContain("cardSrc(c.image_path, resaved[c.id])");
    expect(c).toContain("cardSrc(open.image_path, resaved[open.id])");
    // Exporting a card just re-saved must not hand back the bytes the thumbnail was caught holding.
    expect(c).toContain("cardBlob(card.image_path, resaved[card.id])");
    expect(c).toContain("async function cardBlob(imagePath: string, stamp?: number)");
    expect(c).toContain("const res = await fetch(cardSrc(imagePath, stamp));");
  });

  it("the rows still come back from the database on close — the token is not a substitute", () => {
    // The stamp only makes the browser ask again. What it asks FOR still comes from `load()`.
    expect(code(GALLERY)).toContain("setEditing(null);");
    expect(code(GALLERY)).toMatch(/setResaved\(\(m\) => \(\{ \.\.\.m, \[id\]: Date\.now\(\) \}\)\);\s*\n\s*load\(\);/);
  });
});

describe("covers are left exactly as they are", () => {
  it("their own rule is untouched: content-addressed, and no cache-busting", () => {
    // If covers ever gain a `?v=`, the reason recorded in that file has been lost.
    expect(code(COVERS)).not.toMatch(/\?v=/);
    expect(COVERS).toContain("There is no cache-busting here, and there");
  });
});
