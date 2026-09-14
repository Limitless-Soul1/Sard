// THE DEPOSIT WAITING TO BE READ.
//
// A path, never a payload: choosing a file, or dropping one, only says WHERE it is. Nothing is opened,
// unpacked or written until the sheet asks `deposit_inspect` — and nothing enters the database until
// the reader accepts.
//
// It is a store rather than a prop because a deposit can arrive by more than one door — the library's
// own «افتح وديعة», a drop onto the window, and later a file association — and every door should end at
// the same sheet.
import { create } from "zustand";

interface IncomingDeposit {
  path: string | null;
  /**
   * A received deposit asked to be SHOWN — «افتح الأرشيف», the one thing its done state offers.
   *
   * It lives here rather than in a store of its own because the request crosses two surfaces: the
   * reader may be open, so the page has to come back to the library before the library can change
   * section. Whoever honours it clears it, so a stale flag cannot survive to hijack a later visit.
   */
  showArchive: boolean;
  /**
   * TRUE WHILE THE READER IS BINDING A DEPOSIT OF HIS OWN.
   *
   * A sheet that arrives on top of one already open is the thing Sard's drop routing exists to prevent
   * — `profileChangePending` stands aside for exactly this reason. A composition is a stronger case
   * still: the sending sheet holds an inscription that has been written and not yet saved anywhere.
   *
   * So the offer is KEPT rather than refused. The path is recorded the moment it is dropped, and the
   * receiving sheet simply waits its turn; closing the sending sheet is what lets it through. Nothing
   * is discarded, nothing is stacked, and the drop is not silently swallowed either.
   */
  composing: boolean;
  /**
   * Bumped whenever a deposit is actually applied.
   *
   * A commit writes books and marks straight into the database, so the shelf the reader is looking at
   * is out of date the moment it returns — measured: the book was in the library with its cover and
   * the tile was not on screen at all until a reload. The library watches this and refreshes through
   * its OWN loaders, the same ones its importer uses.
   */
  received: number;
  offer: (path: string) => void;
  clear: () => void;
  askArchive: () => void;
  archiveShown: () => void;
  noteReceived: () => void;
  setComposing: (v: boolean) => void;
}

export const useIncomingDeposit = create<IncomingDeposit>((set) => ({
  path: null,
  showArchive: false,
  received: 0,
  composing: false,
  offer: (path) => set({ path }),
  clear: () => set({ path: null }),
  askArchive: () => set({ showArchive: true }),
  archiveShown: () => set({ showArchive: false }),
  noteReceived: () => set((s) => ({ received: s.received + 1 })),
  setComposing: (v) => set({ composing: v }),
}));
