// THE BRIEF IS GENERATED, AND THESE TESTS ARE WHY THAT MATTERS.
//
// A document that restates the product's ranges by hand falls behind it on the first change. So no
// range, name or floor in the brief is a literal, and each assertion below reads the same constant
// the brief read. Move `RELIEF_MAX` and the brief moves; add a highlight pen and it appears here;
// declare a field NOT_EXPRESSIBLE and it leaves the vocabulary and joins the list of things a
// design does not decide. The document a model is handed and the validator that judges its reply
// are the same source of truth, or these fail.
import { describe, expect, it } from "vitest";

import { buildBrief, pictureFrom } from "../../src/features/profiles/model/exchange/brief";
import {
  BOUNDS,
  NOT_EXPRESSIBLE,
  RECIPE_FENCE,
  RECIPE_FORMAT,
  SLOT_KEYS,
  TEXTURES,
} from "../../src/features/profiles/model/exchange/recipe";
import { AAA_TEXT, AA_TEXT, NON_TEXT } from "../../src/features/profiles/model/guidance";
import { RELIEF_MAX } from "../../src/features/profiles/model/palette";
import { parseProfileData } from "../../src/features/profiles/model/profile";

const brief = (o: Parameters<typeof buildBrief>[0] = {}) => buildBrief(o);
/** `row()` wraps its notes, so a sentence inside one spans lines. Flatten before matching. */
const flat = (t: string) => t.replace(/\s+/g, " ");

describe("what the design decides", () => {
  const t = brief();

  it("says it is commissioning a visual identity, not a whole appearance", () => {
    expect(t).toContain("VISUAL IDENTITY");
  });

  it("names the main text colour as the design's own, and says why it matters", () => {
    expect(flat(t)).toContain("THE MAIN TEXT COLOUR");
    expect(flat(t)).toContain("the ink the book is read in");
  });

  it("offers both palettes and every colour in one", () => {
    expect(t).toContain("palette.library and palette.reading");
    for (const field of ["paperBg", "surfaceBg", "chromeBg", "chromeBorder", "text", "muted", "accent", "selection"]) {
      expect(t).toContain(field);
    }
  });

  it("names every pen the product has, and no others", () => {
    for (const slot of SLOT_KEYS) expect(t).toContain(slot);
    expect(t).toContain(SLOT_KEYS.join(" | "));
  });

  it("offers the marks' colours and the material", () => {
    expect(t).toContain("voice.sentenceColor");
    expect(t).toContain("voice.wordColor");
    expect(t).toContain("reference.color");
    expect(t).toContain(TEXTURES.join(" | "));
  });

  it("prints relief's bound from the constant that defines it", () => {
    expect(t).toContain(`${-RELIEF_MAX} to ${RELIEF_MAX}`);
    expect(t).toContain(`${BOUNDS["palette.relief"].min} to ${BOUNDS["palette.relief"].max}`);
  });

  it("prints the contrast floors from the guidance module", () => {
    expect(t).toContain(AAA_TEXT.toFixed(1));
    expect(t).toContain(AA_TEXT.toFixed(1));
    expect(t).toContain(NON_TEXT.toFixed(1));
  });
});

describe("what the reader decides, said plainly", () => {
  const t = flat(brief());

  it("states in the opening that the faces, the size and the indent are not the design's", () => {
    expect(t).toContain("You do not choose how the reader reads");
    expect(t).toContain("the faces, the text size and the indent are theirs");
  });

  it("names every excluded field with its reason, from the one list that defines them", () => {
    for (const [field, why] of Object.entries(NOT_EXPRESSIBLE)) {
      expect(t).toContain(field);
      expect(t).toContain(why.split(";")[0].trim());
    }
  });

  it("covers each thing the boundary excludes", () => {
    for (const field of [
      "ui", "arabic", "latin", "zoom", "firstLineIndent",
      "pageWidth", "lineHeight", "presence", "blur", "pageOpacity", "bookmarkShape",
    ]) {
      expect(Object.keys(NOT_EXPRESSIBLE)).toContain(field);
    }
  });

  it("says naming one changes nothing rather than inviting the model to try", () => {
    expect(t).toContain("cannot carry them, so naming one changes nothing");
  });

  it("does not ask for a single excluded field in the reply shape", () => {
    const shape = brief().slice(brief().indexOf("HOW TO REPLY"));
    for (const field of ["zoom", "pageWidth", "lineHeight", "presence", "blur", "pageOpacity", "bookmarkShape"]) {
      expect(shape).not.toContain(`"${field}"`);
    }
  });
});

describe("the picture", () => {
  it("passes on what Sard measured when a picture is bound", () => {
    const t = brief({ picture: { width: 1920, height: 1010, meanLuma: 0.22 } });
    expect(t).toContain("1920 x 1010");
    expect(t).toContain("0.22");
    expect(t).toContain("a dark picture");
  });

  it("invents nothing when Sard has none bound, and does not claim there is none", () => {
    const t = brief({ picture: null });
    expect(t).toContain("Sard has none bound yet");
    expect(t).toContain("It does not");
    expect(flat(t)).toContain("mean there is no picture");
    expect(t).not.toContain("mean luminance is");
  });

  it("tells the design it decides the colours and not how the picture is shown", () => {
    expect(flat(brief())).toContain("You do not decide how the picture is SHOWN");
  });
});

describe("the page colour is commissioned, not defaulted", () => {
  // WHY THESE EXIST. Run against real models, the earlier brief kept coming back with a white or
  // near-white reading page beside a picture that plainly had a palette of its own. Nothing was
  // wrong with the format -- `paperBg` was offered all along -- so the fix is what the document
  // SAYS about it. These tests pin the emphasis, not a colour: the brief must make the page's
  // colour a decision owed to the reader and must still refuse to pick it.
  const t = flat(brief());
  const raw = brief();

  it("makes the page colour a decision rather than a default", () => {
    expect(t).toContain("THE PAGE'S COLOUR IS A DESIGN DECISION YOU OWE THE READER, NOT A DEFAULT");
  });

  it("ties it to the supplied picture, and names it the first thing decided from it", () => {
    expect(t).toContain("choose it FROM THE PICTURE");
    expect(t).toContain("THE PAGE'S COLOUR IS THE FIRST THING YOU DECIDE FROM IT");
    expect(t).toContain("page and picture read as one design");
  });

  it("says white is not the safe answer, without forbidding it", () => {
    expect(t).toContain("A WHITE PAGE IS A CHOICE LIKE ANY OTHER AND IS RARELY THIS ONE");
    expect(t).toContain("right only when the picture itself asks for them");
    // Not a ban: a picture that wants a white page must still be able to have one.
    expect(t).not.toMatch(/never use white|white is (not allowed|forbidden|banned)/i);
  });

  it("makes the ink follow the page rather than the other way round", () => {
    expect(t).toContain("choose `text` against the paper you actually chose");
  });

  it("says the arithmetic is not a reason to avoid a coloured page", () => {
    expect(t).toContain("comfortable is a matter of contrast and tone, not of being pale");
    expect(t).toContain("it is not a reason to avoid one");
  });

  it("asks for the whole identity to be designed together", () => {
    expect(t).toContain("Design them TOGETHER, as one identity built around the picture");
    expect(t).toContain("a picture behind a default");
  });

  it("repeats it where the field itself is defined", () => {
    expect(t).toContain("do not leave it white by default");
  });

  it("says it in the FIRST paragraph, before any field is named", () => {
    // Placement is part of the change: the document used to make its case in rule 1, several
    // hundred words in, and models had already settled on a light page by then.
    const opening = flat(brief().slice(0, brief().indexOf("THE PICTURE")));
    expect(opening).toContain("The largest colour here is the PAGE they read on");
    expect(opening).toContain("Decide the page first, and decide it from the picture");
  });

  it("ends by asking for an ACT, not another opinion", () => {
    // THE LEVER. Everything else argues; this asks the model to compare two specific things at a
    // specific moment and gives exactly two ways out. It is the last thing in the document.
    const tail = flat(brief().slice(brief().indexOf("BEFORE YOU SEND IT")));
    expect(tail).toContain("BEFORE YOU SEND IT, LOOK AT `paperBg` ONE MORE TIME");
    expect(tail).toContain("Hold it beside the picture");
    expect(tail).toContain("then you defaulted instead of deciding");
    expect(tail).toContain("Two ways out, and only two");
    expect(tail).toContain("write in `notes` what about THIS picture makes a near-colourless page");
    // And it closes the three escapes a model reaches for instead of choosing.
    expect(tail).toContain("Saying it is safer, or more readable, or more neutral is not an answer");
  });

  it("puts that check last, where it is acted on rather than remembered", () => {
    const t2 = brief();
    expect(t2.indexOf("BEFORE YOU SEND IT")).toBeGreaterThan(t2.indexOf("HOW TO REPLY"));
    expect(t2.trimEnd().endsWith("this asks you not to reach for.")).toBe(true);
  });

  it("still leaves a near-white page reachable, on a reason", () => {
    // The requirement is that white stop being the DEFAULT, not that it become unavailable. A model
    // designing for a snowfield or a bleached studio must still be able to answer white.
    const t2 = flat(brief());
    expect(t2).toContain("keep it and write in `notes`");
    expect(t2).not.toMatch(/must not be white|white is (forbidden|banned|not allowed)/i);
  });

  it("PRESCRIBES NO COLOUR -- not one hex, not one family name", () => {
    // The whole point is that the model derives the colour from the picture. A brief that named a
    // colour would be a brief that designed the appearance itself.
    const hexes = raw.match(/#[0-9A-Fa-f]{6}/g) ?? [];
    // #RRGGBB is the format placeholder, and #FFFFFF appears only as the thing NOT to default to.
    expect(hexes).toEqual(["#FFFFFF"]);
    // Whole words: "tan" lives inside "constant" and "important", and a naive substring test here
    // failed on the brief's own prose rather than on a prescribed colour.
    for (const family of ["beige", "cream", "sepia", "ivory", "parchment", "tan", "brown", "ecru", "off-white"]) {
      expect(raw).not.toMatch(new RegExp(`\\b${family}\\b`, "i"));
    }
  });

  it("still keeps the picture's TREATMENT out of the design's hands", () => {
    expect(t).toContain("You do not decide how the picture is SHOWN");
    for (const field of ["presence", "blur", "pageOpacity"]) {
      expect(Object.keys(NOT_EXPRESSIBLE)).toContain(field);
    }
  });
});

describe("which picture the brief is about", () => {
  // QUICK CUSTOMIZATION'S FIRST STEP BINDS ONE SLOT, and this is the function that decides which one
  // it had to be. The compact control there writes `bg.library.ref` because that is what the brief
  // measures; if this ever read the reading slot instead, the reader would bind a picture in step one
  // and the brief would go out reporting that Sard knew of no picture at all.
  const row = {
    id: "aa11", original_path: "M:/managed/aa11.jpg", derivative_path: null,
    source_name: "dusk.jpg", width: 1920, height: 1010, mean_luma: 0.22, added_at: 0,
  };
  const withRefs = (library: string | null, reading: string | null) => {
    const d = parseProfileData("{}");
    d.bg.library.ref = library;
    d.bg.reading.ref = reading;
    return d;
  };

  it("measures the LIBRARY slot, which is the picture the appearance is built around", () => {
    expect(pictureFrom(withRefs("aa11", null), [row])).toEqual({
      width: 1920, height: 1010, meanLuma: 0.22,
    });
  });

  it("reports nothing when only the book page has its own picture", () => {
    expect(pictureFrom(withRefs(null, "aa11"), [row])).toBeNull();
  });

  it("reports nothing when nothing is bound, so the brief admits the absence", () => {
    expect(pictureFrom(parseProfileData("{}"), [row])).toBeNull();
    expect(buildBrief({ picture: pictureFrom(parseProfileData("{}"), [row]) }))
      .toContain("Sard has none bound yet");
  });

  it("invents no measurement from a reference whose row is gone", () => {
    // A stale ref is the one case where a bound picture and a measurable picture differ. Absence is
    // the honest answer; a zero-sized one would be a measurement Sard never took.
    expect(pictureFrom(withRefs("missing", null), [row])).toBeNull();
  });

  it("puts the measurements in the brief and NO image whatsoever", () => {
    // WHAT LEAVES SARD IS TEXT. The reader shows their picture to their model themselves — the brief
    // carries what was measured and not one byte, one path or one managed id of the file itself.
    const t = buildBrief({ picture: pictureFrom(withRefs("aa11", null), [row]) });
    expect(t).toContain("1920 x 1010");
    expect(t).not.toContain("base64");
    expect(t).not.toContain("data:image");
    expect(t).not.toContain(row.original_path);
    expect(t).not.toContain(row.source_name);
    expect(t).not.toContain(row.id);
  });
});

describe("the reply it asks for", () => {
  const t = brief();

  it("names the format and the fence from their own constants", () => {
    expect(t).toContain(RECIPE_FORMAT);
    expect(t).toContain(RECIPE_FENCE);
  });

  it("says the block carries no image", () => {
    expect(flat(t)).toContain("The block carries no image");
  });

  it("carries the reader's current appearance only when it is offered", () => {
    expect(brief()).not.toContain("WHAT THE READER HAS NOW");
    expect(brief({ current: parseProfileData("{}") })).toContain("WHAT THE READER HAS NOW");
  });
});

describe("the shape of the document", () => {
  it("stays short enough that a model reads it rather than skims it", () => {
    // ~230 lines and ~12.1 KB. The ceiling exists so length stays a decision rather than a drift,
    // and this is the decision: it was 12 KB until the page-colour emphasis below was added, which
    // is a fix for a MEASURED failure -- real models kept returning a white page beside a picture
    // with a strong palette of its own. Twelve lines to stop that is worth more than the 250 bytes
    // they cost, and the ceiling moves with a reason rather than the text drifting past it.
    const t = brief();
    expect(t.split("\n").length).toBeLessThan(250);
    expect(t.length).toBeLessThan(13 * 1024);
  });

  it("is plain ASCII, so nothing is mangled by a chat window", () => {
    // A stray typographic dash or a non-Latin glyph here has been a real corruption class before.
    const offenders = [...brief()].filter((c) => c.charCodeAt(0) > 126);
    expect(offenders).toEqual([]);
  });

  it("prescribes no value for anything it does offer", () => {
    const t = flat(brief());
    expect(t).not.toMatch(/use (a )?(high|low) /i);
    expect(t).not.toMatch(/we recommend/i);
  });
});
