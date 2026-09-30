// THE LINE THE DIALECT IS DRAWN ALONG, asserted rather than described.
//
// A design decides the VISUAL IDENTITY. The reader decides the TYPOGRAPHY. The guarantee is not
// that the brief asks politely: it is that `translateRecipe` has no branch that can reach a
// typographic field, so a recipe naming one changes nothing whatever the document said.
//
// The measured reason this boundary exists: on an earlier dialect that DID publish the measure, ten
// cold runs across two models chose a text size within 1.1..1.15 of a 0.8..2.5 range, and removing
// the examples suspected of anchoring it moved nothing at all. Wording could not shift it; the
// format can.
import { describe, expect, it } from "vitest";

import { NOT_EXPRESSIBLE, PALETTE_KEYS, RECIPE_FENCE, RECIPE_FORMAT, TOP_KEYS } from "../../src/features/profiles/model/exchange/recipe";
import { readPastedDesign } from "../../src/features/profiles/model/exchange/read";
import { parseProfileData } from "../../src/features/profiles/model/profile";

const PENS = {
  amber: "#C9A45A", marigold: "#C48C4E", coral: "#BE7A6E", rose: "#B06E86",
  purple: "#9484B4", sky: "#7A9CB4", teal: "#6FA39A", green: "#8AA677",
};

const paste = (recipe: unknown) =>
  readPastedDesign("```" + RECIPE_FENCE + "\n" + JSON.stringify(recipe) + "\n```");

const ok = (recipe: unknown) => {
  const r = paste(recipe);
  if (!r.ok) throw new Error(`refused: ${r.refusal.code}`);
  return r;
};

/** A full reading palette, so the ink and the paper can be asserted together. */
const READING = {
  dark: false, paperBg: "#F1E6D6", surfaceBg: "#2B2333", chromeBg: "#E8DCCB",
  chromeBorder: "rgba(90,70,58,0.22)", text: "#2A2230", muted: "#6B5A63", accent: "#9C5A3C",
  selection: "rgba(156,90,60,0.22)", highlight: { ...PENS },
};

describe("the visual identity is the AI's", () => {
  it("carries the MAIN TEXT COLOUR — the one field this version most had to keep", () => {
    const d = ok({ format: RECIPE_FORMAT, name: "n", palette: { reading: READING } }).out.data;
    expect(d.theme.reading.colors.text).toBe("#2A2230");
  });

  it("carries both palettes, each on its own", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { library: { ...READING, paperBg: "#241D30" }, reading: READING },
    }).out.data;
    expect(d.theme.library.colors.paperBg).toBe("#241D30");
    expect(d.theme.reading.colors.paperBg).toBe("#F1E6D6");
  });

  it("carries every colour of a palette, including the eight pens", () => {
    const d = ok({ format: RECIPE_FORMAT, name: "n", palette: { reading: READING } }).out.data;
    const c = d.theme.reading.colors;
    expect(c.paperBg).toBe("#F1E6D6");
    expect(c.surfaceBg).toBe("#2B2333");
    expect(c.chromeBg).toBe("#E8DCCB");
    expect(c.chromeBorder).toBe("rgba(90,70,58,0.22)");
    expect(c.muted).toBe("#6B5A63");
    expect(c.accent).toBe("#9C5A3C");
    expect(c.selection).toBe("rgba(156,90,60,0.22)");
    expect(c.highlight).toMatchObject(PENS);
  });

  it("carries the bookmark's colour, the page numbers' ink and the library's relief", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { library: { ...READING, relief: 0.04 }, reading: { ...READING, bookmark: "#7B5AA6", numbers: "#6B5A5F" } },
    }).out.data;
    expect(d.theme.reading.bookmark).toBe("#7B5AA6");
    expect(d.theme.reading.numbers).toBe("#6B5A5F");
    expect(d.theme.library.relief).toBe(0.04);
  });

  it("carries the read-aloud marks' colours and strengths, and the reference rule's colour", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      voice: { sentenceColor: "#8E79B8", sentenceOpacity: 0.22, wordColor: "#B86A34", wordOpacity: 0.4 },
      reference: { color: "#9C5A3C" },
    }).out.data;
    expect(d.voice?.ttsSpotlightColor).toBe("#8E79B8");
    expect(d.voice?.ttsSpotlightOpacity).toBe(0.22);
    expect(d.voice?.ttsKaraokeColor).toBe("#B86A34");
    expect(d.voice?.ttsKaraokeOpacity).toBe(0.4);
    expect(d.refs?.refRuleColor).toBe("#9C5A3C");
  });

  it("carries the material", () => {
    expect(ok({ format: RECIPE_FORMAT, name: "n", texture: "glass" }).out.data.texture).toBe("glass");
  });
});

describe("the material, end to end", () => {
  // TEXTURE IS THE ONE NON-COLOUR THE DESIGN OWNS, and it was reported as not arriving. These walk
  // the whole chain the report named — recipe -> parser -> translator -> ProfileData -> what the
  // editor displays and what `applyTexture` is handed — so that a future break says WHICH link went.
  const DEFAULT = parseProfileData("{}").texture;

  it("a new appearance starts opaque, so a design asking for anything else is a visible change", () => {
    expect(DEFAULT).toBe("opaque");
  });

  for (const step of ["opaque", "light", "glass"] as const) {
    it(`carries \`${step}\` into the appearance`, () => {
      expect(ok({ format: RECIPE_FORMAT, name: "n", texture: step }).out.data.texture).toBe(step);
    });
  }

  it("names texture among the blocks the design spoke about, which is what applies it", () => {
    // Quick Customization copies a block ONLY when the design stated it. A recipe whose texture was
    // translated correctly but never reported as stated would be silently discarded on import — the
    // exact shape of "the texture does not change".
    expect(ok({ format: RECIPE_FORMAT, name: "n", texture: "glass" }).stated).toContain("texture");
    expect(ok({ format: RECIPE_FORMAT, name: "n" }).stated).not.toContain("texture");
  });

  it("drops an unsupported texture rather than coercing it, and keeps the reader's", () => {
    for (const bad of ["frosted", "GLASS", "", 3, null, { step: "glass" }]) {
      const r = ok({ format: RECIPE_FORMAT, name: "n", texture: bad });
      expect(r.out.data.texture, JSON.stringify(bad)).toBe(DEFAULT);
    }
  });

  it("and does NOT report a dropped texture as stated — the defect that made it apply anyway", () => {
    // MEASURED IN THE RUNNING APPLICATION: an appearance the reader had set to `glass`, given a
    // recipe asking for `"texture": "frosted"`, came back `opaque`. The value was dropped and
    // reported correctly — and then applied anyway, because `stated` said the design had spoken
    // about texture and the caller copies what a design speaks about. A translated recipe is a
    // COMPLETE هيئة, so the thing it copied was Sard's default wearing the design's name.
    expect(ok({ format: RECIPE_FORMAT, name: "n", texture: "frosted" }).stated).not.toContain("texture");
    // The valid one still is, or nothing would ever apply.
    expect(ok({ format: RECIPE_FORMAT, name: "n", texture: "glass" }).stated).toContain("texture");
  });

  it("but one bad field inside a block leaves the block stated, and its siblings apply", () => {
    // The two rules are different on purpose: a dropped SCALAR leaves nothing behind, while a
    // dropped field among many leaves the rest, which must still reach the draft.
    const r = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { ...READING, accent: "not-a-colour" } },
    });
    expect(r.stated).toContain("palette.reading");
    expect(r.out.data.theme.reading.colors.paperBg).toBe("#F1E6D6");
  });

  it("reports the bad one as dropped, not as a field the format cannot carry", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "n", texture: "frosted" });
    expect(r.report.map((l) => l.kind)).toContain("dropped");
  });

  it("a bad texture does not take the rest of the design down with it", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n", texture: "frosted",
      palette: { reading: READING },
    }).out.data;
    expect(d.texture).toBe(DEFAULT);
    expect(d.theme.reading.colors.paperBg).toBe("#F1E6D6");
  });
});

describe("the colour behind the page is the reader's, not the design's", () => {
  // `bg.reading.overlay` is the scrim's own colour — what shows between the picture and the page,
  // and «لون خلف الصفحة» in the appearance editor. It is the reader's treatment of the reader's
  // picture, so no recipe may reach it however it is spelled.
  const untouched = parseProfileData("{}").bg.reading.overlay;

  const spellings: [string, Record<string, unknown>][] = [
    ["inside the background block", { background: { reading: { overlay: "#362B4A" } } }],
    ["inside the reading palette", { palette: { reading: { ...READING, overlay: "#362B4A" } } }],
    ["inside the library palette", { palette: { library: { ...READING, overlay: "#362B4A" } } }],
    ["at the top level", { overlay: "#362B4A" }],
    ["as the word that removes it", { background: { reading: { overlay: "none" } } }],
  ];

  for (const [where, block] of spellings) {
    it(`ignores it ${where}`, () => {
      const d = ok({ format: RECIPE_FORMAT, name: "n", ...block }).out.data;
      expect(d.bg.reading.overlay).toBe(untouched);
    });
  }

  it("is not a palette field, however much it looks like one", () => {
    expect(PALETTE_KEYS as readonly string[]).not.toContain("overlay");
    expect(TOP_KEYS as readonly string[]).not.toContain("overlay");
  });

  it("is named among the things a design does not decide, with its reason", () => {
    expect(Object.keys(NOT_EXPRESSIBLE)).toContain("overlay");
    expect(NOT_EXPRESSIBLE.overlay).toMatch(/reader/i);
  });

  it("and the page's own colour still IS the design's — the two are not confused", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { ...READING, overlay: "#362B4A" } },
    }).out.data;
    expect(d.theme.reading.colors.paperBg).toBe("#F1E6D6");
    expect(d.bg.reading.overlay).toBe(untouched);
  });
});

describe("the typography is the reader's, and the format cannot carry it", () => {
  // EACH OF THESE IS A FIELD A MODEL MIGHT REASONABLY SEND. None may reach the draft, and the
  // reader's own value — Sard's default here, since nothing was carried — must stand untouched.
  const untouched = parseProfileData("{}").type.reading;

  const cases: [string, Record<string, unknown>][] = [
    ["font family", { type: { arabic: "amiri", latin: "literata", ui: "Inter" } }],
    ["text size", { measure: { zoom: 1.4 } }],
    ["first-line indent", { measure: { firstLineIndent: true } }],
    ["page width", { measure: { pageWidth: 0.42 } }],
    ["line height", { measure: { lineHeight: 2.1 } }],
    ["font weight", { measure: { fontWeight: 700 } }],
    ["alignment", { measure: { align: "center" } }],
    ["diacritics", { measure: { diacritics: "hide" } }],
    ["margins", { measure: { marginPx: 40 } }],
    ["letter spacing", { measure: { letterSpacing: 1.2 } }],
    ["paragraph spacing", { measure: { paragraphSpacing: 12 } }],
  ];

  for (const [what, block] of cases) {
    it(`ignores ${what}`, () => {
      const d = ok({ format: RECIPE_FORMAT, name: "n", ...block }).out.data;
      expect(d.type.reading).toEqual(untouched);
      expect(d.type.arabic).toBe(parseProfileData("{}").type.arabic);
      expect(d.type.latin).toBe(parseProfileData("{}").type.latin);
      expect(d.type.ui).toBe(parseProfileData("{}").type.ui);
    });
  }

  it("never names a typographic block among the keys it accepts", () => {
    for (const forbidden of ["type", "measure"]) {
      expect(TOP_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe("the picture's treatment is the reader's too", () => {
  const untouched = parseProfileData("{}").bg;

  const cases: [string, Record<string, unknown>][] = [
    ["presence", { background: { reading: { presence: 190 } } }],
    ["blur", { background: { reading: { blur: 26 } } }],
    ["page opacity", { background: { reading: { pageOpacity: 0.88 } } }],
    ["the scrim's colour", { background: { reading: { overlay: "#362B4A" } } }],
    ["the focal point", { background: { library: { focalX: 30, focalY: 70 } } }],
    ["a picture binding", { background: { library: { ref: "deadbeef" } } }],
  ];

  for (const [what, block] of cases) {
    it(`ignores ${what}`, () => {
      expect(ok({ format: RECIPE_FORMAT, name: "n", ...block }).out.data.bg).toEqual(untouched);
    });
  }

  it("never names the background block among the keys it accepts", () => {
    expect(TOP_KEYS as readonly string[]).not.toContain("background");
  });

  it("carries no image, however one is offered", () => {
    const r = ok({
      format: RECIPE_FORMAT, name: "n",
      background: { reading: { image: "data:image/png;base64,iVBORw0KGgo=" } },
      image: "iVBORw0KGgo=",
    });
    expect(JSON.stringify(r.out.data)).not.toContain("base64");
    expect(JSON.stringify(r.out.data)).not.toContain("iVBORw0KGgo");
  });
});

describe("the marks' shapes stay with the reader; only their colours travel", () => {
  const untouched = parseProfileData("{}").marks;

  it("ignores the bookmark's shape, size and position, and the progress mark's style", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      marks: { bookmarkShape: "feather", bookmarkSize: "large", bookmarkPos: 0.8, readMarker: "waxSeal" },
    }).out.data;
    expect(d.marks).toEqual(untouched);
  });

  it("ignores the seal", () => {
    const d = ok({ format: RECIPE_FORMAT, name: "n", seal: { face: "amiri", glyph: "diamond" } }).out.data;
    expect(d.seal).toEqual(parseProfileData("{}").seal);
  });

  it("still carries the bookmark's COLOUR, which is a palette field", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n", palette: { reading: { ...READING, bookmark: "#7B5AA6" } },
    }).out.data;
    expect(d.theme.reading.bookmark).toBe("#7B5AA6");
  });
});

describe("the import rules that were settled before, and still hold", () => {
  it("drops one bad field and keeps its siblings", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { ...READING, accent: "not-a-colour" } },
    }).out.data;
    expect(d.theme.reading.colors.accent).not.toBe("not-a-colour");
    expect(d.theme.reading.colors.paperBg).toBe("#F1E6D6");
    expect(d.theme.reading.colors.text).toBe("#2A2230");
  });

  it("drops one bad pen and keeps the other seven", () => {
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { ...READING, highlight: { ...PENS, amber: "not-a-colour" } } },
    }).out.data;
    expect(d.theme.reading.colors.highlight.amber).not.toBe("not-a-colour");
    expect(d.theme.reading.colors.highlight.marigold).toBe(PENS.marigold);
  });

  it("drops an out-of-range value rather than clamping it to the nearest legal one", () => {
    // 9 is far above the ceiling. A clamped value would be the ceiling; a dropped one is absent,
    // and absence is how the reader's own value shows through.
    const d = ok({
      format: RECIPE_FORMAT, name: "n",
      voice: { sentenceOpacity: 9, wordColor: "#B86A34" },
    }).out.data;
    expect(d.voice?.ttsSpotlightOpacity).not.toBe(9);
    expect(d.voice?.ttsSpotlightOpacity).not.toBe(1);
    expect(d.voice?.ttsKaraokeColor).toBe("#B86A34");
  });

  it("reports what it could not use, and what it cannot carry, as different things", () => {
    const r = ok({
      format: RECIPE_FORMAT, name: "n",
      palette: { reading: { ...READING, accent: "not-a-colour" } },
      measure: { zoom: 1.4, marginPx: 40 },
    });
    const kinds = r.report.map((l) => l.kind);
    expect(kinds).toContain("dropped");
    expect(kinds).toContain("notExpressible");
    const dropped = r.report.find((l) => l.kind === "dropped");
    const cannot = r.report.find((l) => l.kind === "notExpressible");
    expect(dropped && "count" in dropped ? dropped.count : 0).toBeGreaterThan(0);
    expect(cannot && "count" in cannot ? cannot.count : 0).toBeGreaterThan(0);
  });

  it("refuses a document that is not a design at all, and applies nothing", () => {
    const r = paste({ hello: "world" });
    expect(r.ok).toBe(false);
  });

  it("tells the caller which blocks the design actually spoke about", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "n", palette: { reading: READING }, texture: "light" });
    expect(r.stated).toContain("palette.reading");
    expect(r.stated).toContain("texture");
    expect(r.stated).not.toContain("palette.library");
    expect(r.stated).not.toContain("voice");
  });
});

describe("a block that said nothing usable is not a block the design stated", () => {
  // THE SAME DEFECT AS THE DROPPED SCALAR, one level down, and found by auditing for it rather than
  // by a report. A translated recipe is a COMPLETE هيئة, so a block whose every field was dropped
  // carries SARD'S DEFAULTS. Reporting it as stated made the caller copy those defaults over
  // whatever the reader had set by hand — a silent reset wearing the design's name.
  //
  // MEASURED before the fix: `palette.reading` with every colour malformed came back with `paperBg`
  // at Sard's own #F5EEDD; `voice` and `reference` came back `null`.
  it("a reading palette in which nothing survived", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "n",
      palette: { reading: { paperBg: "nope", text: "nope", accent: "nope" } } });
    expect(r.stated).not.toContain("palette.reading");
  });

  it("a voice block in which nothing survived", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "n",
      voice: { sentenceColor: "nope", wordColor: "nope", sentenceOpacity: 9, wordOpacity: 9 } });
    expect(r.stated).not.toContain("voice");
  });

  it("a reference block whose only field was dropped", () => {
    expect(ok({ format: RECIPE_FORMAT, name: "n", reference: { color: "nope" } }).stated)
      .not.toContain("reference");
  });

  it("but ONE good field among bad ones still counts — the design is speaking", () => {
    const one = ok({ format: RECIPE_FORMAT, name: "n",
      palette: { reading: { paperBg: "#F1E6D6", text: "nope", accent: "nope" } } });
    expect(one.stated).toContain("palette.reading");
    expect(one.out.data.theme.reading.colors.paperBg).toBe("#F1E6D6");

    const v = ok({ format: RECIPE_FORMAT, name: "n",
      voice: { sentenceColor: "#8E79B8", wordColor: "nope", sentenceOpacity: 9 } });
    expect(v.stated).toContain("voice");
    expect(v.out.data.voice?.ttsSpotlightColor).toBe("#8E79B8");
  });

  it("and a block of pure nonsense says nothing at all", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "n", voice: { nonsense: 1, alsoNonsense: "x" } });
    expect(r.stated).not.toContain("voice");
  });

  it("the library and the book palettes are judged one at a time", () => {
    // A design may ruin one surface and get the other right; the good one must still apply.
    const r = ok({ format: RECIPE_FORMAT, name: "n",
      palette: { library: { paperBg: "nope" }, reading: READING } });
    expect(r.stated).not.toContain("palette.library");
    expect(r.stated).toContain("palette.reading");
  });
});

describe("the design names the appearance it made", () => {
  // `SARD-THEME/1` has carried `name` from the beginning — it was validated and then never applied,
  // so a reader arrived at Save with an unnamed هيئة. These pin the field's semantics, which are the
  // ordinary ones: valid is taken exactly, malformed is dropped, absent changes nothing.
  it("a valid name comes through exactly as given", () => {
    const r = ok({ format: RECIPE_FORMAT, name: "Breakwater Dusk", texture: "glass" });
    expect(r.out.meta.name).toBe("Breakwater Dusk");
    expect(r.stated).toContain("name");
  });

  it("it is not beautified, normalised or made unique", () => {
    for (const given of ["ليل البحر", "dusk", "A  B", "Ünderscore_9"]) {
      expect(ok({ format: RECIPE_FORMAT, name: given }).out.meta.name).toBe(given);
    }
  });

  it("surrounding space is trimmed, and a long one is capped at the model's limit", () => {
    expect(ok({ format: RECIPE_FORMAT, name: "   Dusk   " }).out.meta.name).toBe("Dusk");
    expect(ok({ format: RECIPE_FORMAT, name: "x".repeat(200) }).out.meta.name).toHaveLength(80);
  });

  it("a malformed name yields none, so nothing is applied over the reader's", () => {
    for (const bad of [42, null, "", "   ", {}, []]) {
      const r = paste({ format: RECIPE_FORMAT, name: bad, texture: "glass" });
      if (!r.ok) continue;                       // refused outright is also "nothing applied"
      expect(r.out.meta.name, JSON.stringify(bad)).toBeNull();
    }
  });

  it("and naming the appearance does not disturb the design it came with", () => {
    const d = ok({ format: RECIPE_FORMAT, name: "Plum", palette: { reading: READING } }).out.data;
    expect(d.theme.reading.colors.paperBg).toBe("#F1E6D6");
  });
});

describe("the picture's presence is the reader's, named or not", () => {
  // Unlocking the control in the editor changes nothing about who OWNS the value: a recipe still
  // cannot carry it, under any spelling.
  const untouched = parseProfileData("{}").bg;
  for (const [where, block] of [
    ["as a background field", { background: { reading: { presence: 42 } } }],
    ["at the top level", { presence: 42 }],
    ["inside the palette", { palette: { reading: { ...READING, presence: 42 } } }],
  ] as [string, Record<string, unknown>][]) {
    it(`ignores a presence given ${where}`, () => {
      const d = ok({ format: RECIPE_FORMAT, name: "n", ...block }).out.data;
      expect(d.bg.reading.params.presence).toBe(untouched.reading.params.presence);
      expect(d.bg.library.params.presence).toBe(untouched.library.params.presence);
    });
  }

  it("and the two surfaces keep their own starting values", () => {
    expect(untouched.library.params.presence).toBe(100);
    expect(untouched.reading.params.presence).toBe(260);
  });
});
