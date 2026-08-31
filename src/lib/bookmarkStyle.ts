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
// Marker HEIGHT in px (RAWY-48). The <BookmarkShape> scales entirely by this. User-sizable so the
// on-page marker can be made bigger or smaller; the RAWY-42 non-occlusion offset still applies.
export const BOOKMARK_SIZE_MIN = 40;
/**
 * 200, raised from 120.
 *
 * VERIFIED THROUGH THE RENDERER, not just at the slider. `BookmarkShape` derives every dimension
 * from `h` — the box, the strip, the notch — and `.page-bookmark` puts no size of its own on the
 * element. Measured in the editor's preview before the change: 40 -> 27px, 80 -> 54px, 120 -> 81px,
 * exactly linear, so nothing between the value and the pixels was capping it. The only two limits
 * were this constant and the profile parser's clamp against it, and both move together.
 */
export const BOOKMARK_SIZE_MAX = 200;
const DEFAULT_SIZE = 68; // the RAWY-42 on-page height

const K_SHAPE = "bookmark_style";
const K_COLOR = "bookmark_color";
const K_POS = "bookmark_pos";
const K_SIZE = "bookmark_size";

const clampSize = (n: number) => Math.max(BOOKMARK_SIZE_MIN, Math.min(BOOKMARK_SIZE_MAX, Math.round(n)));

interface BookmarkStyleState {
  shape: BookmarkShapeKey;
  color: string;
  pos: number;
  size: number;
  setShape: (s: BookmarkShapeKey) => void;
  setColor: (c: string) => void;
  setPos: (p: number, persist?: boolean) => void;
  setSize: (n: number) => void;
}

export const useBookmarkStyle = create<BookmarkStyleState>((set) => ({
  shape: DEFAULT_SHAPE,
  color: DEFAULT_COLOR,
  pos: DEFAULT_POS,
  size: DEFAULT_SIZE,
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
  setSize: (n) => {
    const s = clampSize(n);
    set({ size: s });
    settingsSet(K_SIZE, String(s)).catch(console.error);
  },
}));

const isShape = (s: string | null): s is BookmarkShapeKey =>
  !!s && BOOKMARK_SHAPES.some((x) => x.key === s);

/** Load persisted bookmark style/colour/position. Call once at startup. */
export async function initBookmarkStyle(): Promise<void> {
  const [shape, color, pos, size] = await Promise.all([
    settingsGet(K_SHAPE).catch(() => null),
    settingsGet(K_COLOR).catch(() => null),
    settingsGet(K_POS).catch(() => null),
    settingsGet(K_SIZE).catch(() => null),
  ]);
  const p = pos != null ? Number(pos) : NaN;
  const sz = size != null ? Number(size) : NaN;
  useBookmarkStyle.setState({
    shape: isShape(shape) ? shape : DEFAULT_SHAPE,
    color: color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR,
    pos: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : DEFAULT_POS,
    size: Number.isFinite(sz) ? clampSize(sz) : DEFAULT_SIZE,
  });
}
