// The translation view's bookkeeping for a section: shown when the section loads, shown again, read again from the
// edition. The page work itself (`applyToDocument`, `showsAlready`) needs a browser and is checked in a real WebView2;
// here it is a stand-in that remembers what each document shows.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParagraphView, ShowView } from "../../src/features/translation/reader/api";
import type { Labels } from "../../src/features/translation/reader/apply";

const h = vi.hoisted(() => ({
  /** The edition's sections, as the backend returns them. */
  stored: new Map<number, unknown>(),
  /** What each document shows: the views last applied to it. */
  shown: new Map<object, string>(),
}));

vi.mock("../../src/features/translation/reader/api", () => ({
  readerSection: vi.fn(async (_edition: string, index: number) => structuredClone(h.stored.get(index) ?? [])),
  readerStatus: vi.fn(),
  readerEdition: vi.fn(),
  readerTranslate: vi.fn(),
  onEditionEvent: vi.fn(),
}));
vi.mock("../../src/features/translation/reader/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/translation/reader/apply")>()),
  applyToDocument: vi.fn((doc: object, views: unknown[]) => {
    h.shown.set(doc, JSON.stringify(views));
    return views.length;
  }),
  clearDocument: vi.fn((doc: object) => {
    h.shown.delete(doc);
  }),
  showsAlready: vi.fn((doc: object, views: unknown[]) => h.shown.get(doc) === JSON.stringify(views)),
}));

import { readerSection } from "../../src/features/translation/reader/api";
import { applyToDocument } from "../../src/features/translation/reader/apply";
import { Layer } from "../../src/features/translation/reader/useBookTranslation";

const labels: Labels = { review: "R", reviewHint: "RH", notTranslated: "NT", keptOriginal: "KO" };
/** A section's document, still on screen. */
const page = () => ({ defaultView: {} }) as unknown as Document;
const pv = (ordinal: number, show: ShowView): ParagraphView => ({ ordinal, path: [ordinal], tag: "p", text: `P${ordinal}.`, show });
const tr = (text: string, review = false): ShowView => ({ kind: "translation", text, review });
const pending: ShowView = { kind: "pending" };
const settle = () => new Promise((r) => setTimeout(r, 0));
const appliedTo = (doc: Document) => vi.mocked(applyToDocument).mock.calls.filter(([d]) => d === doc).length;

beforeEach(() => {
  h.stored.clear();
  h.shown.clear();
  vi.clearAllMocks();
});

describe("the translation view of a section", () => {
  it("is shown once on a first visit, when the edition has been read", async () => {
    h.stored.set(1, [pv(0, tr("أ")), pv(1, pending)]);
    const doc = page();
    new Layer("e", labels).apply(doc, 1);
    expect(appliedTo(doc)).toBe(0);
    await settle();
    expect(appliedTo(doc)).toBe(1);
  });

  it("is shown at once from what is known on a return, and not a second time when nothing new was stored", async () => {
    h.stored.set(1, [pv(0, tr("أ")), pv(1, tr("ب", true)), pv(2, { kind: "not_translated" }), pv(3, { kind: "kept_original" })]);
    const layer = new Layer("e", labels);
    layer.apply(page(), 1);
    await settle();
    // The section loads again: a new document.
    const back = page();
    layer.apply(back, 1);
    expect(appliedTo(back)).toBe(1);
    await settle();
    expect(readerSection).toHaveBeenCalledTimes(2);
    expect(appliedTo(back)).toBe(1);
  });

  it("shows translations that arrived since, when the edition is read again", async () => {
    h.stored.set(1, [pv(0, tr("أ")), pv(1, pending)]);
    const layer = new Layer("e", labels);
    const doc = page();
    layer.apply(doc, 1);
    await settle();
    h.stored.set(1, [pv(0, tr("أ")), pv(1, tr("ب"))]);
    layer.refresh();
    await settle();
    expect(appliedTo(doc)).toBe(2);
    expect(h.shown.get(doc)).toBe(JSON.stringify(h.stored.get(1)));
  });

  it("shows a paragraph that changed — its translation, its review mark, a failure — when the edition is read again", async () => {
    for (const changed of [tr("ج"), tr("أ", true), { kind: "not_translated" } as ShowView]) {
      h.stored.set(1, [pv(0, tr("أ"))]);
      const layer = new Layer("e", labels);
      const doc = page();
      layer.apply(doc, 1);
      await settle();
      h.stored.set(1, [pv(0, changed)]);
      layer.refresh();
      await settle();
      expect(appliedTo(doc)).toBe(2);
      expect(h.shown.get(doc)).toBe(JSON.stringify([pv(0, changed)]));
    }
  });

  it("is shown again at once when the engine shows it again on the same page (new sizes), and not once more after", async () => {
    h.stored.set(1, [pv(0, tr("أ"))]);
    const layer = new Layer("e", labels);
    const doc = page();
    layer.apply(doc, 1);
    await settle();
    layer.apply(doc, 1);
    expect(appliedTo(doc)).toBe(2);
    await settle();
    expect(appliedTo(doc)).toBe(2);
  });

  it("is taken off by the original and shown again by the next translation view", async () => {
    h.stored.set(1, [pv(0, tr("أ"))]);
    const doc = page();
    const first = new Layer("e", labels);
    first.apply(doc, 1);
    await settle();
    // The original: the layer is let go and the view taken off the page.
    first.dispose();
    first.clear(doc);
    expect(h.shown.has(doc)).toBe(false);
    // The translation again: a new layer for the edition.
    new Layer("e", labels).apply(doc, 1);
    await settle();
    expect(h.shown.get(doc)).toBe(JSON.stringify([pv(0, tr("أ"))]));
  });

  it("changes nothing once let go, or once the section has left the screen", async () => {
    h.stored.set(1, [pv(0, tr("أ"))]);
    const doc = page();
    const layer = new Layer("e", labels);
    layer.apply(doc, 1);
    layer.dispose();
    await settle();
    expect(appliedTo(doc)).toBe(0);
    const gone = { defaultView: null } as unknown as Document;
    new Layer("e", labels).apply(gone, 1);
    await settle();
    expect(appliedTo(gone)).toBe(0);
  });
});
