// Bookmark style (RAWY-41, design Band J/J-II) — the SHAPE + COLOUR + edge POSITION of the
// on-page bookmark marker are an app-wide choice (Global Settings). Persisted as `bookmark_style`,
// `bookmark_color`, `bookmark_pos`; re-applied at launch. The shapes are drawn by <BookmarkShape>.

import { create } from "zustand";

import { settingsGet, settingsSet } from "./ipc";

export type BookmarkShapeKey =
  | "ribbon"
  | "corner"
  | "tab"
  | "marker"
  | "feather"
  | "tassel"
  | "pointed"
  | "double"
  | "seal"
  | "clip"
  | "cord"
  | "leaf";

export const BOOKMARK_SHAPES: { key: BookmarkShapeKey; label: string }[] = [
  { key: "ribbon", label: "Ribbon" },
  { key: "pointed", label: "Pointed" },
  { key: "corner", label: "Corner" },
  { key: "tab", label: "Tab" },
  { key: "marker", label: "Marker" },
  { key: "feather", label: "Feather" },
  { key: "tassel", label: "Tassel" },
  { key: "double", label: "Double" },
  { key: "seal", label: "Wax seal" },
  { key: "clip", label: "Brass clip" },
  { key: "cord", label: "Braided cord" },
  { key: "leaf", label: "Pressed leaf" },
];

// The curated palette (Band J-II) — rich, never gaudy.
export const BOOKMARK_COLORS: { key: string; name: string; hex: string }[] = [
  { key: "terracotta", name: "Terracotta", hex: "#9C5A3C" },
  { key: "teal", name: "Deep teal", hex: "#1F6F6B" },
  { key: "burgundy", name: "Burgundy", hex: "#7A2E3A" },
  { key: "forest", name: "Forest", hex: "#3E5E3A" },
  { key: "gold", name: "Gold", hex: "#B8893C" },
  { key: "plum", name: "Plum", hex: "#6A4A6E" },
  { key: "navy", name: "Navy", hex: "#2A3A5E" },
  { key: "cream", name: "Cream", hex: "#E6D9BC" },
];

const DEFAULT_SHAPE: BookmarkShapeKey = "ribbon";
const DEFAULT_COLOR = "#9C5A3C"; // Terracotta
const DEFAULT_POS = 0.84; // fraction along the top edge (0 = left, 1 = right), physical (fixed)

const K_SHAPE = "bookmark_style";
const K_COLOR = "bookmark_color";
const K_POS = "bookmark_pos";

interface BookmarkStyleState {
  shape: BookmarkShapeKey;
  color: string;
  pos: number;
  setShape: (s: BookmarkShapeKey) => void;
  setColor: (c: string) => void;
  setPos: (p: number, persist?: boolean) => void;
}

export const useBookmarkStyle = create<BookmarkStyleState>((set) => ({
  shape: DEFAULT_SHAPE,
  color: DEFAULT_COLOR,
  pos: DEFAULT_POS,
  setShape: (s) => {
    set({ shape: s });
    settingsSet(K_SHAPE, s).catch(console.error);
  },
  setColor: (c) => {
    set({ color: c });
    settingsSet(K_COLOR, c).catch(console.error);
  },
  setPos: (p, persist = true) => {
    const clamped = Math.max(0, Math.min(1, p));
    set({ pos: clamped });
    if (persist) settingsSet(K_POS, String(clamped)).catch(console.error);
  },
}));

const isShape = (s: string | null): s is BookmarkShapeKey =>
  !!s && BOOKMARK_SHAPES.some((x) => x.key === s);

/** Load persisted bookmark style/colour/position. Call once at startup. */
export async function initBookmarkStyle(): Promise<void> {
  const [shape, color, pos] = await Promise.all([
    settingsGet(K_SHAPE).catch(() => null),
    settingsGet(K_COLOR).catch(() => null),
    settingsGet(K_POS).catch(() => null),
  ]);
  const p = pos != null ? Number(pos) : NaN;
  useBookmarkStyle.setState({
    shape: isShape(shape) ? shape : DEFAULT_SHAPE,
    color: color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR,
    pos: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : DEFAULT_POS,
  });
}
