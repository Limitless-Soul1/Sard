// Typing a colour code, against the design's own rule (frame 2a `onNHex`).
//
// The Paper chapter had NO hex field at all — the colour controls sat behind a button and a dialog —
// so none of this behaviour existed to be tested. These cases are the design's, not invented: the
// automatic `#`, three-digit expansion, upper-case commit, and a warning that waits until there is
// something to warn about.
import { describe, expect, it } from "vitest";

import { editHex } from "../../src/features/profiles/model/hex";

describe("editHex", () => {
  it("accepts a full six-digit code and commits it upper-case", () => {
    const r = editHex("#3a7bff");
    expect(r.ok).toBe(true);
    expect(r.full).toBe("#3A7BFF");
    expect(r.bad).toBe(false);
    expect(r.draft).toBe("#3a7bff"); // the reader's own text survives in the field
  });

  it("supplies the # the reader did not type — pasting a bare code works", () => {
    const r = editHex("3A7BFF");
    expect(r.draft).toBe("#3A7BFF");
    expect(r.full).toBe("#3A7BFF");
    expect(r.ok).toBe(true);
  });

  it("expands three digits to six", () => {
    expect(editHex("#abc").full).toBe("#AABBCC");
    expect(editHex("fff").full).toBe("#FFFFFF");
    expect(editHex("#0a0").full).toBe("#00AA00");
  });

  it("trims surrounding whitespace, as a paste often carries", () => {
    expect(editHex("  #3A7BFF \n").full).toBe("#3A7BFF");
  });

  it("treats a lone # as an emptied field, not an error", () => {
    const r = editHex("#");
    expect(r.draft).toBe("");
    expect(r.ok).toBe(false);
    expect(r.bad).toBe(false); // backspacing to nothing must not shout
  });

  it("treats an empty field as neither valid nor wrong", () => {
    const r = editHex("");
    expect(r.ok).toBe(false);
    expect(r.bad).toBe(false);
    expect(r.full).toBeNull();
  });

  it("warns on an incomplete code once there is more than one character", () => {
    // The threshold is the DESIGN's: `v.length > 1 && !ok`. "#3" is already two characters, so the
    // hint appears from the first digit. Verified against frame 2a rather than assumed — my first
    // reading of this expected silence at "#3" and was wrong.
    expect(editHex("#3").bad).toBe(true);
    expect(editHex("#3A").bad).toBe(true);
    expect(editHex("#3A7B").bad).toBe(true);
    expect(editHex("#3A7BF").bad).toBe(true); // five digits is not a colour
    // ...but the two states that are not "wrong" stay quiet:
    expect(editHex("#").bad).toBe(false);
    expect(editHex("").bad).toBe(false);
  });

  it("rejects non-hex characters and never commits them", () => {
    for (const bad of ["#zzzzzz", "#12345g", "hello", "#3A7BFF0"]) {
      const r = editHex(bad);
      expect(r.ok).toBe(false);
      expect(r.full).toBeNull();
      expect(r.bad).toBe(true);
    }
  });

  it("is case-insensitive on input and always upper-case on commit", () => {
    expect(editHex("#AbCdEf").full).toBe("#ABCDEF");
    expect(editHex("#abcdef").full).toBe("#ABCDEF");
  });

  it("never throws, whatever it is handed", () => {
    for (const v of ["", "#", "#".repeat(40), "!!!", "###abc", " ", "\t\n"]) {
      expect(() => editHex(v)).not.toThrow();
    }
  });
});
