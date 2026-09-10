// Where a dropped file goes.
//
// ONE PIPELINE, ONE REACTION. The window has a single drop listener and it belongs to the Library.
// Rather than add a second listener — which would make both a profile preview and a book-import
// attempt answer the same gesture — the existing listener asks this one question first.
//
// THE EXTENSION IS NOT THE TEST. A dropped file is offered to the real import gate and CLASSIFIED BY
// WHAT IT CONTAINS: `profile_import_inspect` opens it, finds `profile.json`, and validates it. A book
// renamed `.zip`, or a profile renamed anything at all, both land where they belong. Nothing is
// unpacked and nothing is written — inspect reads one bounded member into memory and returns text.
import { profileImportInspect } from "../../lib/ipc";
import { depositInspect, fontImportDropped, fontInspect } from "../../lib/ipc";
import { useFontDrop } from "../fonts/dropped";
import { useFonts } from "../../lib/fonts";
import { useIncomingDeposit } from "../deposit/store";
import { useDropped } from "./dropped";
import { profileChangePending } from "./session";

/**
 * Route dropped paths, preferring the profile gate and falling through to books.
 *
 * `fallback` is the Library's own importer, called with the untouched paths, so a book behaves
 * exactly as it did before this existed.
 */
export async function routeDroppedPaths(
  paths: string[],
  fallback: (paths: string[]) => void,
): Promise<void> {
  // A profile package is one file. A multi-file drop is a shelf of books by definition.
  if (paths.length === 1) {
    // A READING DEPOSIT IS ASKED ABOUT FIRST, and asked the cheapest way there is: `deposit_inspect`
    // reads one member and changes nothing. A file that is not one is refused silently and goes on to
    // have its ordinary turn below — a reader who dropped a book must not meet a deposit's error.
    let deposit: string | null = null;
    try {
      deposit = await depositInspect(paths[0]);
    } catch {
      /* not a deposit — fall through */
    }
    if (deposit !== null) {
      // THE SAME PRECEDENCE A PROFILE OBEYS. An unsaved-change dialog is already asking a question, and
      // a deposit sheet stacked on it would be a second question over the first. The drop is dropped —
      // and it is NOT handed to the book importer either, because this file is a deposit and answering
      // it with a book error would be the wrong reaction.
      if (profileChangePending()) return;
      useIncomingDeposit.getState().offer(paths[0]);
      return;
    }

    let text: string | null = null;
    try {
      text = await profileImportInspect(paths[0]);
    } catch {
      // Refused — not a Sard profile, or unreadable. Books get their ordinary turn below, and the
      // refusal itself is deliberately silent: the reader dropped a book, not a broken profile.
    }
    if (text !== null) {
      // Stage 5 precedence: an unsaved-change dialog is already asking a question. Never stack a
      // second modal on it. The drop is dropped, and it is NOT handed to the book importer either —
      // this file is a profile, and answering it with a book error would be a wrong reaction.
      if (profileChangePending()) return;
      useDropped.getState().offer(text, paths[0]);
      return;
    }

    // A FONT, ASKED LAST AND THE SAME WAY. `font_inspect` reads the file, validates the container and
    // parses its `name` table, and changes nothing — so a file that is not a font is refused here for
    // free and goes on to have its ordinary turn as a book below. Asking last is what keeps this
    // change incapable of affecting the two gates above it: a deposit and a هيئة are both ZIPs and
    // have already answered by the time this runs.
    //
    // NO PRECEDENCE GUARD, unlike the two above, and the difference is the point: those open a SHEET,
    // so they must not stack a second question on an unsaved-change dialog. A font import asks
    // nothing — it reports. There is no question to stack.
    let font: Awaited<ReturnType<typeof fontInspect>> | null = null;
    try {
      font = await fontInspect(paths[0]);
    } catch (e) {
      // A `font.err.*` key means "this IS a font-shaped file and it is not acceptable" — a renamed
      // text file, a truncated face, a format Sard will not take. Say so rather than handing it to
      // the book importer, which would answer a broken font with "not an EPUB".
      const key = String(e);
      // WHICH REFUSALS ARE THIS GATE'S TO ANSWER, and it is not all of them.
      //
      // `font.err.type` means the EXTENSION is not a font's — which is every EPUB, every image, every
      // ordinary file a reader drops. Answering those in words would have swallowed the drop: measured,
      // a dropped `.epub` reached the bookshelf before this gate existed and stopped reaching it after,
      // because the gate refused it as "not a font Sard takes" and returned. It falls through instead,
      // silently, exactly as a file that is not a deposit does.
      //
      // The CONTENT refusals are this gate's: a `.ttf` that is a renamed text file, a truncated face, a
      // file that cannot be read. Those are font-shaped and the reader meant them as fonts, so handing
      // them to the book importer would answer a broken font with "not an EPUB".
      if (key.startsWith("font.err.") && key !== "font.err.type") {
        useFontDrop.getState().say({ key: key as never, bad: true });
        return;
      }
      // Anything else — including a file whose extension was never a font's. Fall through, silently.
    }
    if (font) {
      try {
        const done = await fontImportDropped(paths[0]);
        // The picker's list is a store, so it has to be told; otherwise the font is installed and
        // invisible until the next launch.
        await useFonts.getState().reload();
        useFontDrop.getState().say({
          key: done.outcome === "imported" ? "font.drop.imported" : "font.drop.duplicate",
          name: done.family,
          bad: false,
        });
      } catch (e) {
        const key = String(e);
        useFontDrop.getState().say({
          key: key.startsWith("font.err.") ? (key as never) : "font.err.failed",
          bad: true,
        });
      }
      return;
    }
  }
  fallback(paths);
}
