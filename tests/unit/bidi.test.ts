// Book metadata is bidirectional; the interface around it is not. Keeping those apart is the
// whole of this rule, and the Details view was mixing them in two separate ways.
//
// One: a single "is this Arabic" flag was computed from the TITLE and used to set the AUTHOR's
// face too, so an Arabic book by an English author printed that author in the Arabic face at
// Arabic metrics, and the reverse pair printed an Arabic author in the Latin one.
//
// Two: alignment followed each field's own direction. In an Arabic interface an English title sat
// at the left of its column while the Arabic author beside it sat at the right, the two drifted to
// opposite ends of their cells, and the title appeared to be under the Author heading.

import { describe, it, expect } from "vitest";
import { fieldScript, fieldStyle, isArabicText } from "../../src/features/library/design/bidi";

const AR_TITLE = "البؤساء";
const AR_AUTHOR = "فيكتور هيجو";
const EN_TITLE = "Les Misérables";
const EN_AUTHOR = "Victor Hugo";
const AR_LONG = "الأعمال الكاملة لمحمد بن عبد الله بن أحمد الطويل جدًا في المجلد الثاني";
const EN_LONG = "The Exceptionally Long And Rather Overwrought Title Of A Nineteenth Century Novel";

describe("which face a metadata field takes", () => {
  it("judges a field by its own script, never by its neighbour's", () => {
    // The matrix the reader asked for, read as pairs: each field answers for itself.
    const pairs: [string, string, "arabic" | "latin", "arabic" | "latin"][] = [
      [EN_TITLE, EN_AUTHOR, "latin", "latin"],
      [AR_TITLE, AR_AUTHOR, "arabic", "arabic"],
      [AR_TITLE, EN_AUTHOR, "arabic", "latin"], // mixed
      [EN_TITLE, AR_AUTHOR, "latin", "arabic"], // reverse mixed
      [AR_LONG, EN_LONG, "arabic", "latin"],
      [EN_LONG, AR_LONG, "latin", "arabic"],
    ];
    for (const [title, author, wantTitle, wantAuthor] of pairs) {
      expect(fieldScript(title)).toBe(wantTitle);
      expect(fieldScript(author)).toBe(wantAuthor);
    }
  });

  it("does not let the book's declared direction override a field that states its own", () => {
    // An Arabic book with an English author's name: `dir: rtl` describes the BOOK, not the name.
    expect(fieldScript(EN_AUTHOR, "rtl")).toBe("latin");
    expect(fieldScript(AR_AUTHOR, "ltr")).toBe("arabic");
  });

  it("falls back to the declared direction only when the field has no script of its own", () => {
    // A title of digits and punctuation has nothing to go on; the book's own direction is then
    // the best evidence available.
    expect(fieldScript("1984", "rtl")).toBe("latin"); // strong-ish content: believe the field
    expect(fieldScript("", "rtl")).toBe("arabic");
    expect(fieldScript(null, "rtl")).toBe("arabic");
    expect(fieldScript("   ", "rtl")).toBe("arabic");
    expect(fieldScript(undefined, null)).toBe("latin");
  });

  it("finds Arabic anywhere in the string, not only at the start", () => {
    expect(isArabicText("Vol. 2 — البؤساء")).toBe(true);
    expect(isArabicText("البؤساء (Volume 2)")).toBe(true);
    expect(isArabicText("Les Misérables")).toBe(false);
  });

  it("treats presentation forms as Arabic too", () => {
    expect(isArabicText("ﺠﺎ")).toBe(true);
  });
});

describe("how a metadata cell is placed", () => {
  it("takes its alignment from the INTERFACE, not from the text", () => {
    // This is the fix for the apparent column swap: every cell in an Arabic interface hugs the
    // same edge, so the columns stay under their headings whatever script fills them.
    expect(fieldStyle(true).textAlign).toBe("right");
    expect(fieldStyle(false).textAlign).toBe("left");
  });

  it("isolates every field so a neighbour cannot reorder it", () => {
    // A trailing bracket, dash or digit is a neutral character; without isolation it can be
    // reordered across the boundary between two fields.
    expect(fieldStyle(true).unicodeBidi).toBe("isolate");
    expect(fieldStyle(false).unicodeBidi).toBe("isolate");
  });

  it("gives the same alignment to every cell of one interface, whatever the content", () => {
    // The property that makes "Title = Title, Author = Author" hold: alignment cannot vary with
    // the field, so two adjacent fields can never drift to opposite ends of their columns.
    const rtl = fieldStyle(true);
    const ltr = fieldStyle(false);
    for (const _ of [AR_TITLE, EN_TITLE, AR_LONG, EN_LONG]) {
      expect(fieldStyle(true)).toEqual(rtl);
      expect(fieldStyle(false)).toEqual(ltr);
    }
  });
});
