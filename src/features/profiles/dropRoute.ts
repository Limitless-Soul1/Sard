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
import { depositInspect } from "../../lib/ipc";
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
  }
  fallback(paths);
}
