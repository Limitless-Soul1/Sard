// THE ONE PLACE A SUCCESSFUL FONT IMPORT IS ANNOUNCED.
//
// Sard has two doors a font can come through — dropped on the window, or chosen in Global Settings —
// and they must end in the same place. This is that place. Neither door decides what happens after a
// successful import; both call this, and it is the only thing that opens the specimen.
//
// IT DOES NOT IMPORT ANYTHING. The storage, the validation, the `custom_fonts` row and the copied
// file are the existing pipeline's, unchanged, and both callers have already finished with it before
// they arrive here. What this owns is the answer to "what now" — which is why adding a third door
// later needs no new decision.
//
// THE FACE IS REGISTERED BEFORE THE SPECIMEN IS OPENED, and that ordering is the whole reason this is
// awaited rather than fired off. `lib/fonts.ts` builds the `@font-face` block once at startup and
// folds it again on `importFont`/`reload`; a family installed without that step is, in its own words,
// "installed and invisible until the next launch". A specimen opened in that window would draw the
// reader's arriving typeface in a FALLBACK and look, to them, like the font they chose. So the caller
// registers first — and `ensureRegistered` re-checks rather than trusting it, because a specimen that
// silently shows the wrong face is worse than one that admits it is still loading.
import { fontInspect, type CustomFont, type FontFacts } from "../../lib/ipc";
import { useFonts } from "../../lib/fonts";
import { useFontPreview } from "./preview";

/**
 * Is this family registered as a usable face in THIS document, now?
 *
 * `document.fonts.check` answers for the family the CSS would resolve, which is exactly the question
 * the specimen depends on. It is asked after `load`, because a face that has been declared but not
 * yet fetched reports as unavailable and would read as a missing font rather than a slow one.
 */
export async function ensureRegistered(family: string): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  const quoted = `12px "${family.replace(/"/g, '\\"')}"`;
  try {
    await document.fonts.load(quoted, "ابجد ABC");
  } catch {
    /* a face that refuses to load is answered by the check below, not by a throw */
  }
  try {
    return document.fonts.check(quoted);
  } catch {
    return false;
  }
}

/**
 * Announce a font that has just been imported: register its face, read what the file says about
 * itself, and open the specimen.
 *
 * `row` is what the pipeline stored. `outcome` distinguishes a family that was already here — the
 * specimen still opens for it, because "you already have this one, and here is what it looks like" is
 * a better answer than silence, and nothing was written either way.
 */
export async function announceImportedFont(
  row: CustomFont,
  outcome: "imported" | "duplicate" = "imported",
): Promise<void> {
  // Registration first, and re-checked: see the note above. A `false` here is not a reason to refuse
  // the specimen — the row exists and the reader asked to see it — but the surface is told, so it can
  // say the face is still arriving instead of drawing a fallback and calling it the font.
  await useFonts.getState().reload().catch(() => {});
  await ensureRegistered(row.family_name);
  // What the FILE says, from its own tables. A failure here is not a failed import: the font is
  // installed and usable; only the coverage and the style are unknown, and the specimen says so.
  let facts: FontFacts | null = null;
  try {
    facts = await fontInspect(row.file_path);
  } catch {
    facts = null;
  }
  useFontPreview.getState().show({ row, facts, outcome });
}
