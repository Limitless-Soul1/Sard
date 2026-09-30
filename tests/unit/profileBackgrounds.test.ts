// ONE PICTURE DRESSES BOTH SURFACES — the rule, and the four cases it turns on.
//
// The product decision is that a هيئة is designed around ONE picture. A reader who chooses one means
// it for the application in front of them, not for the library and then again for the page. Before
// this, choosing a library picture left the book page bare and choosing a book picture left the
// library bare — and the second also stranded the design brief, which measures the LIBRARY's picture
// and therefore reported that Sard knew of no picture at all.
//
// The counterweight is that an arrangement a reader has already separated must never be silently
// merged. Every rule here acts only where there is nothing to overwrite, and these tests exist to
// keep those two obligations from trading against each other unnoticed.
import { describe, expect, it } from "vitest";

import { BG_NO_OVERLAY } from "../../src/lib/background";
import { bindPicture, linkPictures, parseProfileData } from "../../src/features/profiles/model/profile";
import { defaultProfileData } from "../../src/features/profiles/store";

const bg = () => parseProfileData("{}").bg;
/** What the two surfaces are actually wearing, which is the only thing a reader can see. */
const worn = (b: ReturnType<typeof bg>) => ({
  library: b.library.ref,
  book: b.reading.sameAsLibrary ? b.library.ref : b.reading.ref,
  linked: b.reading.sameAsLibrary,
});

describe("the first picture dresses both surfaces", () => {
  it("chosen for the library, with the book bare", () => {
    const b = bg();
    bindPicture(b, "library", "one");
    expect(worn(b)).toEqual({ library: "one", book: "one", linked: true });
  });

  it("chosen for the book, with the library bare — it becomes the SHARED picture", () => {
    // With no library picture there is nothing for "an image of its own" to be distinct FROM, and
    // leaving the library bare is exactly what stranded the brief.
    const b = bg();
    bindPicture(b, "reading", "one");
    expect(worn(b)).toEqual({ library: "one", book: "one", linked: true });
    expect(b.reading.ref).toBeNull();
  });

  it("either way, one reference is stored rather than two", () => {
    for (const surface of ["library", "reading"] as const) {
      const b = bg();
      bindPicture(b, surface, "one");
      expect([b.library.ref, b.reading.ref].filter(Boolean)).toEqual(["one"]);
    }
  });
});

describe("a reader who has separated them is never merged back", () => {
  it("a library picture does not reach a book that has its own", () => {
    const b = bg();
    bindPicture(b, "library", "one");   // both wear "one"
    linkPictures(b, false);             // the reader parts them
    bindPicture(b, "reading", "book");  // and gives the book its own
    bindPicture(b, "library", "lib");   // then changes the library's
    expect(worn(b)).toEqual({ library: "lib", book: "book", linked: false });
  });

  it("and a book picture does not reach back into the library", () => {
    const b = bg();
    bindPicture(b, "library", "lib");
    linkPictures(b, false);
    bindPicture(b, "reading", "book");
    bindPicture(b, "reading", "book2");
    expect(worn(b)).toEqual({ library: "lib", book: "book2", linked: false });
    expect(b.library.ref).toBe("lib");
  });

  it("binding to the library leaves an already-separated book alone", () => {
    const b = bg();
    b.library.ref = "lib";
    b.reading.ref = "book";
    b.reading.sameAsLibrary = false;
    bindPicture(b, "library", "lib2");
    expect(worn(b)).toEqual({ library: "lib2", book: "book", linked: false });
  });
});

describe("parting and re-linking", () => {
  it("parting leaves the page wearing what it already wore", () => {
    // THE DEFECT THIS CLOSES: parting used to leave `reading.ref` null, so the page went blank and
    // the reader had to find the same file again to get back what they were looking at.
    const b = bg();
    bindPicture(b, "library", "one");
    linkPictures(b, false);
    expect(worn(b)).toEqual({ library: "one", book: "one", linked: false });
  });

  it("and then the library can take a different one, with the book unmoved", () => {
    const b = bg();
    bindPicture(b, "library", "one");
    linkPictures(b, false);
    bindPicture(b, "library", "two");
    expect(worn(b)).toEqual({ library: "two", book: "one", linked: false });
  });

  it("re-linking puts the book back on the library's, keeping its own in reserve", () => {
    const b = bg();
    bindPicture(b, "library", "one");
    linkPictures(b, false);
    bindPicture(b, "reading", "book");
    linkPictures(b, true);
    expect(worn(b)).toEqual({ library: "one", book: "one", linked: true });
    // Not destroyed: parting again restores what the book had, rather than blanking it.
    linkPictures(b, false);
    expect(worn(b).book).toBe("book");
  });

  it("parting twice does not overwrite what the book kept", () => {
    const b = bg();
    bindPicture(b, "library", "one");
    linkPictures(b, false);
    bindPicture(b, "reading", "book");
    linkPictures(b, true);
    linkPictures(b, false);
    expect(b.reading.ref).toBe("book");
  });
});

describe("what the rules do not touch", () => {
  it("nothing here moves a surface's treatment", () => {
    const b = bg();
    const before = JSON.stringify({ l: b.library.params, r: b.reading.params });
    bindPicture(b, "library", "one");
    linkPictures(b, false);
    bindPicture(b, "reading", "two");
    expect(JSON.stringify({ l: b.library.params, r: b.reading.params })).toBe(before);
  });

  it("a stored appearance that never said `sameAsLibrary` is still read as separate", () => {
    // The default is NOT flipped: an appearance saved before any of this keeps the arrangement it
    // was saved with, and only a fresh binding can link the two.
    expect(parseProfileData(JSON.stringify({ bg: { library: { ref: "a" }, reading: { ref: "b" } } }))
      .bg.reading.sameAsLibrary).toBe(false);
  });
});

describe("the colour behind the page", () => {
  // `overlay` is the colour laid BETWEEN the picture and the page. It is the reader's treatment of
  // the reader's own picture, and a new هيئة lays none: the picture shows as it is until they decide
  // otherwise. `null` is a different answer — it means "whatever colour this theme would use" — and
  // that is a decision a fresh appearance has not made.
  it("a NEW appearance lays no colour at all", () => {
    expect(defaultProfileData().bg.reading.overlay).toBe(BG_NO_OVERLAY);
  });

  it("an appearance that names a colour keeps it", () => {
    expect(parseProfileData(JSON.stringify({ bg: { reading: { overlay: "#362B4A" } } }))
      .bg.reading.overlay).toBe("#362B4A");
  });

  it("and one written before any of this is not migrated", () => {
    // Absent still parses to `null` — the theme's own colour — which is what every appearance saved
    // before this has been wearing. Changing THAT would have repainted them all.
    expect(parseProfileData("{}").bg.reading.overlay).toBeNull();
    expect(parseProfileData(JSON.stringify({ bg: { reading: { ref: "a" } } })).bg.reading.overlay).toBeNull();
  });
});
