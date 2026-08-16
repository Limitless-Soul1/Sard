// Where a dropped file goes — the four decisions the router makes.
//
// This is NOT a native-drop test. A real OS drag cannot be driven here, so these call the router
// directly with representative paths and assert which of the two destinations it chose. What a real
// drop still has to prove is that the Library's listener hands over the paths at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const inspect = vi.fn();
const pending = vi.fn(() => false);

vi.mock("../../src/lib/ipc", () => ({ profileImportInspect: (p: string) => inspect(p) }));
vi.mock("../../src/features/profiles/session", () => ({ profileChangePending: () => pending() }));

import { routeDroppedPaths } from "../../src/features/profiles/dropRoute";
import { useDropped } from "../../src/features/profiles/dropped";

const MANIFEST = '{"package":1,"data":{"v":1}}';

describe("routeDroppedPaths", () => {
  beforeEach(() => {
    inspect.mockReset();
    pending.mockReset().mockReturnValue(false);
    useDropped.getState().clear();
  });

  it("offers a valid profile to the import preview and never to the bookshelf", async () => {
    inspect.mockResolvedValue(MANIFEST);
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/evening.zip"], books);
    expect(useDropped.getState().text).toBe(MANIFEST);
    expect(books).not.toHaveBeenCalled();
  });

  it("falls through to the bookshelf when the gate refuses — an ordinary zip", async () => {
    inspect.mockRejectedValue("pkg.err.notSard");
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/photos.zip"], books);
    expect(books).toHaveBeenCalledWith(["C:/x/photos.zip"]);
    expect(useDropped.getState().text).toBeNull();
  });

  it("falls through for an unreadable file, and persists nothing", async () => {
    inspect.mockRejectedValue("pkg.err.unreadable");
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/truncated.zip"], books);
    expect(books).toHaveBeenCalledOnce();
    expect(useDropped.getState().text).toBeNull();
  });

  it("discards a profile dropped while the unsaved-change dialog is asking", async () => {
    inspect.mockResolvedValue(MANIFEST);
    pending.mockReturnValue(true);
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/evening.zip"], books);
    // Neither destination: no modal stacked on the dialog, and no book error for a file that is
    // plainly a profile.
    expect(useDropped.getState().text).toBeNull();
    expect(books).not.toHaveBeenCalled();
  });

  it("treats a multi-file drop as a shelf of books without opening the gate", async () => {
    const books = vi.fn();
    await routeDroppedPaths(["a.epub", "b.epub"], books);
    expect(inspect).not.toHaveBeenCalled();
    expect(books).toHaveBeenCalledWith(["a.epub", "b.epub"]);
  });
});
