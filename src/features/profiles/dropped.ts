// A profile package dropped onto the window, waiting to be previewed.
//
// WHY A STORE AND NOT A PROP. The drop event is owned by the Library's webview listener, but the
// import preview belongs to Profiles and is otherwise only mounted inside Settings. Rather than
// teach the Library about profile UI, the drop leaves the already-inspected manifest here and the
// app-level sheet picks it up — the same shape the unsaved-change dialog already uses.
import { create } from "zustand";

interface DroppedState {
  /** The manifest text `profile_import_inspect` returned, or null when nothing is waiting. */
  text: string | null;
  offer: (text: string) => void;
  clear: () => void;
}

export const useDropped = create<DroppedState>((set) => ({
  text: null,
  offer: (text) => set({ text }),
  clear: () => set({ text: null }),
}));
