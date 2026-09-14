// FILES THE SYSTEM HANDS SARD, AND THE ONE RULE THAT KEEPS THEM STRAIGHT.
//
// A double-clicked book travels from the operating system, through the application root, to the
// library — which is the only part that knows how to import anything. The queue between them is small
// enough to hold in the head and important enough to pin down: everything that is handed over is
// delivered, in order, exactly once.
//
// "Exactly once" is the half that cost something to learn. React mounts every effect twice in
// development, and a queue that could be read without being emptied imported the reader's book a
// second time — the second attempt answering "duplicate" to the first, which is a baffling thing to
// be told about a file you have just opened.
import { describe, expect, it, beforeEach } from "vitest";
import { useOpenFileRequest } from "../../src/features/library/openFileRequest";

const reset = () => useOpenFileRequest.setState({ pending: [] });

describe("the queue of files the system handed us", () => {
  beforeEach(reset);

  it("hands over what it was given", () => {
    useOpenFileRequest.getState().hand(["C:/books/one.epub"]);
    expect(useOpenFileRequest.getState().take()).toEqual(["C:/books/one.epub"]);
  });

  it("delivers each path exactly once", () => {
    useOpenFileRequest.getState().hand(["C:/books/one.epub"]);
    expect(useOpenFileRequest.getState().take()).toEqual(["C:/books/one.epub"]);
    // The second ask is empty. This is what stops a book being imported twice when the effect that
    // drains the queue is mounted twice.
    expect(useOpenFileRequest.getState().take()).toEqual([]);
  });

  it("keeps a second arrival behind the first rather than replacing it", () => {
    // Two double-clicks in quick succession, before the library has taken either.
    useOpenFileRequest.getState().hand(["C:/books/first.epub"]);
    useOpenFileRequest.getState().hand(["C:/books/second.epub"]);
    expect(useOpenFileRequest.getState().take()).toEqual(["C:/books/first.epub", "C:/books/second.epub"]);
  });

  it("keeps several files from one launch together", () => {
    // Selecting several books in Explorer and pressing Enter is ONE launch with several arguments.
    useOpenFileRequest.getState().hand(["a.epub", "b.pdf", "c.epub"]);
    expect(useOpenFileRequest.getState().take()).toEqual(["a.epub", "b.pdf", "c.epub"]);
  });

  it("is not disturbed by being handed nothing", () => {
    // The router calls the fallback with whatever it did not recognise, and that can be nothing at
    // all. An empty hand must not wake the library or leave a request behind it will act on.
    useOpenFileRequest.getState().hand([]);
    expect(useOpenFileRequest.getState().pending).toEqual([]);
  });

  it("leaves nothing waiting once it has been drained", () => {
    // The root watches `pending` to decide whether to leave the reader, so a drained queue has to
    // read as empty — not merely return empty.
    useOpenFileRequest.getState().hand(["x.epub"]);
    expect(useOpenFileRequest.getState().pending.length).toBe(1);
    useOpenFileRequest.getState().take();
    expect(useOpenFileRequest.getState().pending).toEqual([]);
  });
});
