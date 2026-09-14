// Where a dropped file goes — the four decisions the router makes.
//
// This is NOT a native-drop test. A real OS drag cannot be driven here, so these call the router
// directly with representative paths and assert which of the two destinations it chose. What a real
// drop still has to prove is that the Library's listener hands over the paths at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const inspect = vi.fn();
const depositOf = vi.fn();
const pending = vi.fn(() => false);
const fontOf = vi.fn();
const fontImport = vi.fn();
const reload = vi.fn(async () => {});

vi.mock("../../src/lib/ipc", () => ({
  profileImportInspect: (p: string) => inspect(p),
  depositInspect: (p: string) => depositOf(p),
  fontInspect: (p: string) => fontOf(p),
  fontImportDropped: (p: string) => fontImport(p),
}));
// The store is only asked to re-read itself after an import; the real one would reach IPC.
vi.mock("../../src/lib/fonts", () => ({ useFonts: { getState: () => ({ reload }) } }));
vi.mock("../../src/features/profiles/session", () => ({ profileChangePending: () => pending() }));

import { routeDroppedPaths } from "../../src/features/profiles/dropRoute";
import { useDropped } from "../../src/features/profiles/dropped";
import { useIncomingDeposit } from "../../src/features/deposit/store";
import { useFontDrop } from "../../src/features/fonts/dropped";

const MANIFEST = '{"package":1,"data":{"v":1}}';

describe("routeDroppedPaths", () => {
  beforeEach(() => {
    inspect.mockReset();
    depositOf.mockReset().mockRejectedValue("dep.err.notSard");
    pending.mockReset().mockReturnValue(false);
    useDropped.getState().clear();
    useIncomingDeposit.getState().clear();
    fontOf.mockReset().mockRejectedValue("not a font at all");
    fontImport.mockReset();
    reload.mockClear();
    useFontDrop.getState().clear();
  });

  it("offers a deposit to the deposit sheet, and never to the profile gate or the bookshelf", async () => {
    depositOf.mockResolvedValue('{"deposit":1}');
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/a-reading.sard-deposit"], books);
    expect(useIncomingDeposit.getState().path).toBe("C:/x/a-reading.sard-deposit");
    expect(inspect).not.toHaveBeenCalled();
    expect(books).not.toHaveBeenCalled();
  });

  it("REFUSES to stack on an unsaved-change dialog — the same precedence a profile obeys", async () => {
    depositOf.mockResolvedValue('{"deposit":1}');
    pending.mockReturnValue(true);
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/a-reading.sard-deposit"], books);
    // Not shown, and NOT handed to the importer either: answering a deposit with a book error would be
    // the wrong reaction to the right file.
    expect(useIncomingDeposit.getState().path).toBeNull();
    expect(books).not.toHaveBeenCalled();
  });

  it("a deposit dropped alongside other files is a shelf of books, not a deposit", async () => {
    depositOf.mockResolvedValue('{"deposit":1}');
    const books = vi.fn();
    const many = ["C:/x/a.sard-deposit", "C:/x/b.epub"];
    await routeDroppedPaths(many, books);
    expect(useIncomingDeposit.getState().path).toBeNull();
    expect(books).toHaveBeenCalledWith(many);
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

// ---- a dropped FONT ------------------------------------------------------------------------------
//
// The font gate is asked LAST, after the deposit and the هيئة, and that order is the whole of why this
// change cannot disturb the two above it: both of those files are ZIPs and have already answered by
// the time the font gate runs. What these hold is that a font reaches the font importer, that a file
// which is not a font still reaches the bookshelf, and that a BROKEN font is refused in words rather
// than handed to the book importer to be called "not an EPUB".
describe("routeDroppedPaths — fonts", () => {
  const FACTS = { family: "Amiri Quran", style: null, format: "ttf", named_by_font: true };

  // Its own reset: the two gates above the font one must be told to decline, or they answer first
  // and the font gate is never reached — which is the correct behaviour, and not what these test.
  beforeEach(() => {
    // BOTH gates above must REJECT, the way the real commands do for a file that is not theirs — a
    // bare `mockReset()` resolves `undefined`, and the هيئة gate's test is `text !== null`, so an
    // unconfigured mock is indistinguishable from a هيئة and answers before the font gate is reached.
    inspect.mockReset().mockRejectedValue("pkg.err.notSard");
    depositOf.mockReset().mockRejectedValue("dep.err.notSard");
    pending.mockReset().mockReturnValue(false);
    fontOf.mockReset().mockRejectedValue("not a font at all");
    fontImport.mockReset();
    reload.mockClear();
    useDropped.getState().clear();
    useIncomingDeposit.getState().clear();
    useFontDrop.getState().clear();
  });

  it("imports a dropped font, and never hands it to the bookshelf", async () => {
    fontOf.mockResolvedValue(FACTS);
    fontImport.mockResolvedValue({ outcome: "imported", family: "Amiri Quran", style: null, format: "ttf" });
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/AmiriQuran-Regular.ttf"], books);
    expect(fontImport).toHaveBeenCalledWith("C:/x/AmiriQuran-Regular.ttf");
    expect(books).not.toHaveBeenCalled();
    // The picker's list is a store: without this the font is installed and invisible until relaunch.
    expect(reload).toHaveBeenCalled();
    const n = useFontDrop.getState().notice;
    expect(n?.key).toBe("font.drop.imported");
    expect(n?.name).toBe("Amiri Quran");
    expect(n?.bad).toBe(false);
  });

  it("says so when the family is already installed, and imports nothing twice", async () => {
    fontOf.mockResolvedValue(FACTS);
    fontImport.mockResolvedValue({ outcome: "duplicate", family: "Amiri Quran", style: null, format: "ttf" });
    await routeDroppedPaths(["C:/x/AmiriQuran-Regular.ttf"], vi.fn());
    expect(useFontDrop.getState().notice?.key).toBe("font.drop.duplicate");
  });

  it("refuses a font-shaped file that is not a font, IN WORDS, not as a book", async () => {
    // A `font.err.*` key means the gate recognised the shape and rejected the contents. Handing that
    // to the book importer would answer a renamed font with "not an EPUB".
    fontOf.mockRejectedValue("font.err.invalid");
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/renamed.ttf"], books);
    expect(books).not.toHaveBeenCalled();
    expect(fontImport).not.toHaveBeenCalled();
    const n = useFontDrop.getState().notice;
    expect(n?.key).toBe("font.err.invalid");
    expect(n?.bad).toBe(true);
  });

  it("an EPUB is not a font's business, and still reaches the bookshelf", async () => {
    // THE REGRESSION THIS PINS, and it was measured before it was written: `font.err.type` means the
    // EXTENSION is not a font's — which is every EPUB a reader drops. Answering it in words SWALLOWED
    // the drop; the book never reached the importer. Only the CONTENT refusals belong to this gate.
    fontOf.mockRejectedValue("font.err.type");
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/a-book.epub"], books);
    expect(books).toHaveBeenCalledWith(["C:/x/a-book.epub"]);
    expect(useFontDrop.getState().notice).toBeNull();
  });

  it("lets an ordinary file go on to the bookshelf untouched", async () => {
    // The gate declines anything that is not font-shaped, silently — a reader dropping a book must
    // never meet a font's refusal.
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/a-book.epub"], books);
    expect(books).toHaveBeenCalledWith(["C:/x/a-book.epub"]);
    expect(useFontDrop.getState().notice).toBeNull();
  });

  it("never reaches the font gate for a deposit or a هيئة", async () => {
    depositOf.mockResolvedValue('{"deposit":1}');
    await routeDroppedPaths(["C:/x/a.sard-deposit"], vi.fn());
    expect(fontOf).not.toHaveBeenCalled();

    depositOf.mockRejectedValue("dep.err.notSard");
    inspect.mockResolvedValue(MANIFEST);
    await routeDroppedPaths(["C:/x/a.sardprofile"], vi.fn());
    expect(fontOf).not.toHaveBeenCalled();
  });

  it("a multi-file drop is a shelf of books, whatever is in it", async () => {
    const books = vi.fn();
    await routeDroppedPaths(["C:/x/a.ttf", "C:/x/b.ttf"], books);
    expect(fontOf).not.toHaveBeenCalled();
    expect(books).toHaveBeenCalled();
  });
});
