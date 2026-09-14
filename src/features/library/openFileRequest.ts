// A BOOK HANDED IN BY THE OPERATING SYSTEM, ON ITS WAY TO BEING READ.
//
// Double-clicking a book in Explorer, "Open with Sard", or naming a file on the command line all end
// at the same place: a path arrives, and the reader expects to be reading it a moment later. What has
// to happen in between is everything the library already does for a dropped book — refuse a format
// this runtime cannot render, import it, report what was refused and why, refresh the shelves — and
// none of that belongs to the application root, which owns neither the importer nor the shelves.
//
// So the root does not do it. It leaves the paths here, and the library takes them when it mounts.
// That keeps ONE import path in the product: a book added by drop, by the picker, and by a
// double-click are the same book added the same way, and a change to how importing works cannot
// leave this door behind.
//
// WHY A QUEUE AND NOT A CALLBACK. The library is not always mounted — while a book is open the reader
// stands in its place — and a file can arrive at any moment, including before the first render. A
// request that is stored rather than delivered can wait for whoever is going to honour it, and the
// same store makes the wait observable: the root closes the reader when something is waiting, which
// is what mounts the library that will take it.
import { create } from "zustand";

interface OpenFileRequest {
  /** Paths the system handed us that are still waiting for the library. */
  pending: string[];
  /** Leave paths for the library to import and open. */
  hand: (paths: string[]) => void;
  /**
   * Take everything waiting, and forget it.
   *
   * DESTRUCTIVE ON PURPOSE, and it is the same reasoning the backend queue is drained with: a path
   * that has been handed over must never be handed over twice. React's development mode mounts every
   * effect twice, and a non-destructive read would import the reader's book two times over — the
   * second one answering "duplicate" to the first, which is a confusing thing to be told about a
   * file you just opened.
   */
  take: () => string[];
}

export const useOpenFileRequest = create<OpenFileRequest>((set, get) => ({
  pending: [],
  hand: (paths) => {
    if (!paths.length) return;
    set({ pending: [...get().pending, ...paths] });
  },
  take: () => {
    const { pending } = get();
    if (pending.length) set({ pending: [] });
    return pending;
  },
}));
