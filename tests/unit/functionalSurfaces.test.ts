// CONTENT SURFACE FIRST, BACKGROUND IMAGE SECOND.
//
// THE RULE THIS PINS, and it is already written into the codebase rather than invented here. The
// owner's ruling that took the library's scrim floor to zero — so a chosen photograph can actually
// be seen — says in as many words what pays for it: «the chrome that carries text — the sidebar, the
// toolbar's control plates, the dialogs — keeps its own opaque ground». See `LIB_SCRIM_MIN`.
//
// WHAT WENT WRONG. References & Replacements, and the bookmarks shelf, built their surfaces on the
// interface-texture ladder — `color-mix(chrome, transparent)` at an alpha that travels with the
// reader's texture step. Every surface in that section carries words: the reference rows, the
// replacement rules and their switches, the search field, the tabs, and the back button. Measured on
// the running application over a photograph at full presence, with the ladder at its MOST OPAQUE
// rung, the back button composited to 2.92:1 and the search field to 3.23:1 — both under AA, before
// the reader had touched the texture control at all. At «glass» they collapse to the floor.
//
// The floor was not the mistake. It was derived when the library still had a 0.77 scrim beneath it.
// What was missing was the distinction the ruling had already drawn:
//
//   ATMOSPHERIC   a page's ground, a decorative sheet — may be as glassy as the reader asks.
//   FUNCTIONAL    anything bearing words, a control, a status, a navigation — may not.
//
// TWO LAYERS, NOT A HIGHER ALPHA. Raising a translucent surface's alpha is the tempting fix and is
// not one: the composite still moves with the picture, so the guarantee becomes "usually legible".
// An opaque colour with the chrome tint painted over it holds whatever a theme, a texture step or a
// scrim does afterwards.
import { describe, expect, it } from "vitest";

const read = async (file: string) => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  return readFileSync(resolve(__dirname, "../../", file), "utf8");
};

/** The two layers, as they must appear on any surface that carries words. */
const SOLID_BASE = "background-color: var(--solid-base);";
const SOLID_TINT = "background-image: linear-gradient(var(--solid-tint), var(--solid-tint));";

describe("the rule is stated once, where anything can reach it", () => {
  it("`global.css` declares the tokens and the pattern", async () => {
    const css = await read("src/styles/global.css");
    expect(css).toContain("--solid-base: var(--paper-bg);");
    expect(css).toContain("--solid-tint: var(--chrome-bg);");
    const solid = css.slice(css.indexOf(".ui-solid {"), css.indexOf(".ui-solid {") + 400);
    expect(solid).toContain(SOLID_BASE);
    expect(solid).toContain(SOLID_TINT);
    // A blur under an opaque ground is paint nobody can see, and leaving it declared invites the
    // next reader to conclude the surface is meant to be see-through.
    expect(solid).toContain("backdrop-filter: none;");
    expect(solid).toContain("isolation: isolate;");
  });

  it("and the framed page title, conditional on there being a picture at all", async () => {
    const css = await read("src/styles/global.css");
    const at = css.indexOf('[data-bg-library="on"] .ui-page-title');
    // To the rule's own closing brace: a character budget goes stale the moment the rule grows.
    const rule = css.slice(at, css.indexOf("}", at));
    // With no photograph there is nothing to protect against, and a box around a title on plain
    // paper is noise. The treatment appears with the condition that makes it necessary.
    expect(rule).toContain(SOLID_BASE);
    expect(rule).toContain(SOLID_TINT);
  });
});

describe("every collection page's title stands on a ground of its own", () => {
  // WHY SOME PAGES HAD A FRAME AND OTHERS DID NOT: there was no shared page header. Each page had
  // written its own, and three of the five drew the title as bare text on the page. Measured over a
  // photograph at full presence, those three came out at 4.03-4.20 against what was behind them —
  // under AA — while the two that framed the title measured 11.78 and higher.
  const PAGES: [string, string][] = [
    ["src/features/library/Inbox.tsx", "the notes archive"],
    ["src/features/library/BookmarksShelf.tsx", "the bookmarks shelf"],
    ["src/features/photo/PhotoGallery.tsx", "the saved cards"],
  ];

  for (const [file, what] of PAGES) {
    it(what + " frames its title", async () => {
      expect(await read(file), file + " draws its title as bare text").toContain("ui-page-title");
    });
  }

  it("and the library's own title plate is solid rather than glass", async () => {
    const css = await read("src/styles/library-design.css");
    const rule = css.slice(css.indexOf(".libd-console .libd-plate,"));
    expect(rule.slice(0, 700)).toContain(SOLID_BASE);
    expect(rule.slice(0, 700)).toContain(SOLID_TINT);
    // It carried the page's words at 85% with a blur — the heading sat on whatever the picture did.
    expect(rule.slice(0, 700)).not.toContain("var(--bg-lib-sidebar, 85%)");
  });
});

describe("References & Replacements: functional means solid", () => {
  it("the ladder's content rungs resolve to the shared solid tokens", async () => {
    const css = await read("src/styles/refsreps.css");
    const ladder = css.slice(css.indexOf(".rr {"), css.indexOf("/* ---- header ---"));
    expect(ladder).toContain("--rr-plate: var(--solid-tint);");
    expect(ladder).toContain("--rr-control: var(--solid-tint);");
    // …and the frost is off for them. It stays DEFINED for the atmospheric sheet, so the
    // distinction survives in the file rather than being deleted from it.
    expect(ladder).toContain("--rr-frost: none;");
    expect(ladder).toContain("--rr-frost-sheet:");
    // The page's own sheet keeps the ladder — the picture may still show through what carries no words.
    expect(ladder).toContain("--rr-sheet: color-mix(");
  });

  it("and the two layers are stated LAST, where the shorthand cannot flatten them", async () => {
    const css = await read("src/styles/refsreps.css");
    const at = css.lastIndexOf(SOLID_TINT);
    // Every selector above sets `background:` — the shorthand, which resets `background-image`. A
    // two-layer ground declared before them is silently flattened by the rules it exists to protect.
    const lastShorthand = Math.max(
      css.lastIndexOf("background: var(--rr-plate)"),
      css.lastIndexOf("background: var(--rr-control)"),
    );
    expect(at).toBeGreaterThan(lastShorthand);
    const tail = css.slice(css.lastIndexOf(".rr-back,"));
    for (const sel of [".rr-back", ".rr-search", ".rr-tabs", ".rr-plate", ".rr-def-wrap", ".rr-rule-row"]) {
      // The tail begins at the group rule, so a bare mention of the selector is unambiguous.
      expect(tail.slice(0, 300), sel + " is not on the solid ground").toContain(sel);
    }
  });

  it("the way out of a page is not secondary text", async () => {
    // `--muted` is derived to a 3:1 floor — right for a caption, wrong for the control a reader
    // reaches for to leave. Measured on its own opaque plate: 3.03:1 at rest, and it was already
    // drawn at 11.5:1 on hover, so the resting state was the only thing that had to change.
    const css = await read("src/styles/refsreps.css");
    const back = css.slice(css.indexOf(".rr-back {"), css.indexOf(".rr-back:hover"));
    expect(back).toContain("color: var(--text);");
    expect(back).not.toContain("color: var(--muted);");
  });
});

describe("the audit found the same two controls on the bookmarks shelf", () => {
  it("its back button and its search field are solid too", async () => {
    const css = await read("src/styles/bookmarks.css");
    const tail = css.slice(css.lastIndexOf(".bm-back,"));
    expect(tail).toContain(".bm-find {");
    expect(tail).toContain(SOLID_BASE);
    expect(tail).toContain(SOLID_TINT);
    expect(tail).toContain("backdrop-filter: none;");
  });

  it("its back button carries the same ink as the other one", async () => {
    const css = await read("src/styles/bookmarks.css");
    const back = css.slice(css.indexOf(".bm-back {"), css.indexOf(".bm-back:hover"));
    expect(back).toContain("color: var(--text);");
  });

  it("but the shelf's own cards are left alone — they already stood on an opaque ground", async () => {
    // The audit is looking for surfaces that carry words over a picture, not sweeping glass out of
    // Sard. `.bm-row` and `.arch-slip` already name `--chrome-bg` and `--paper-bg`.
    const bm = await read("src/styles/bookmarks.css");
    expect(bm.slice(bm.indexOf(".bm-row {"), bm.indexOf(".bm-row {") + 400)).toContain("var(--chrome-bg)");
    const arch = await read("src/styles/archive.css");
    expect(arch.slice(arch.indexOf(".arch-slip {"), arch.indexOf(".arch-slip {") + 900)).toContain("var(--paper-bg)");
  });
});

describe("glass is not removed from Sard, only from what has to be read", () => {
  it("the library's own background layer is untouched", async () => {
    const css = await read("src/styles/global.css");
    // The picture, its scrim, its falloff and its grain are the atmosphere the feature exists for.
    expect(css).toContain(':root[data-bg-library="on"] .lib-root::before');
    expect(css).toContain(':root[data-bg-library="on"] .lib-root::after');
  });

  it("and the interface-texture ladder still governs what carries no words", async () => {
    const css = await read("src/styles/refsreps.css");
    expect(css).toContain("var(--ui-k, 1)");
  });
});

describe("a title plate wraps its content, never the page", () => {
  // THE DEFECT THIS PINS. `ui-page-title` was put on the notes archive's own header ROW, and that row
  // is a child of a COLUMN flex container — so `align-items: stretch`, the default, pulled the plate
  // across the full width of the pane and the chip became a band over the whole top of the page.
  //
  // `display: inline-flex` did not save it: that decides how an element lays out its OWN children and
  // says nothing about how its parent sizes it. Two things were wrong at once, and both are fixed
  // here rather than in the archive alone:
  //
  //   1. the plate now refuses to be stretched or grown, whatever holds it;
  //   2. the class goes on the CONTENT — a page's header row carries the page's padding, and a plate
  //      drawn around that padding is a panel rather than a chip.
  it("refuses to be stretched by whatever holds it", async () => {
    const css = await read("src/styles/global.css");
    const rule = css.slice(css.indexOf('[data-bg-library="on"] .ui-page-title'));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body, "a flex or grid parent can still stretch it").toContain("align-self: start;");
    expect(body, "a main axis can still grow it").toContain("flex: 0 0 auto;");
    expect(body, "it can still fill its line").toContain("width: fit-content;");
    // …and it stays inside a narrow pane rather than forcing one open.
    expect(body).toContain("max-width: 100%;");
  });

  it("and the archive puts it on the words, not on its padded header row", async () => {
    const src = await read("src/features/library/Inbox.tsx");
    // The row keeps its own padding; the words inside it get the ground.
    expect(src).toContain(`<div className="arch-head-top">`);
    expect(src, "the plate is back on the page's header row").not.toContain("arch-head-top ui-page-title");
  });

  it("every page that frames a title wraps content rather than a row", async () => {
    // Each of these wraps the title and its count in an element of its own. Measured in the running
    // application, each plate came out 13-17px wider than the words inside it — a padding and a
    // border — and spanned 10-27% of its pane.
    for (const file of [
      "src/features/library/Inbox.tsx",
      "src/features/library/BookmarksShelf.tsx",
      "src/features/photo/PhotoGallery.tsx",
    ]) {
      const src = await read(file);
      expect(src, file + " has no wrapper for the plate").toMatch(/<span className="ui-page-title[ "]/);
    }
  });

  it("a gallery cell carries its own label, on both shelves that have one", async () => {
    // The saved cards and the bookmarks shelf draw the same object — a picture with words under it —
    // so they take the same treatment. Measured: a card's title went from 1.11:1 to 7.67:1, and the
    // number is now identical over a light picture and a dark one, which is the property that
    // matters: the photograph no longer takes part.
    const sel = await read("src/styles/selection.css");
    expect(sel).toContain('[data-bg-library="on"] .pg-cell');
    const bm = await read("src/styles/bookmarks.css");
    expect(bm).toContain('[data-bg-library="on"] .bm-book');
  });
});

describe("informational text is classified, not blanket-framed", () => {
  // THE SWEEP THAT FOUND IT. Every leaf carrying words on the five collection pages was measured
  // over a photograph at full presence — not by max contrast inside its box, which a sentence that
  // dies mid-word still scores 15:1 on, but band by band, reported at its WORST point. Exactly one
  // failed: the cabinet's instruction, at 1.03:1. Every other bare line cleared AA and was left
  // alone, which is the point — the answer to unreadable text is not a box round everything.
  it("the cabinet's instruction joins the header block rather than getting a box of its own", async () => {
    const src = await read("src/features/library/Inbox.tsx");
    const at = src.indexOf(`<header className="arch-head">`);
    const head = src.slice(at, src.indexOf("</header>", at));
    // Inside the plate: one surface saying one thing, rather than a second floating box under the first.
    expect(head).toContain("ui-page-title ui-page-title--stack");
    expect(head).toContain(`<p className="arch-lede">`);
    const plate = head.indexOf("ui-page-title--stack");
    expect(head.indexOf(`<p className="arch-lede">`), "the sentence is outside the plate again")
      .toBeGreaterThan(plate);
  });

  it("and the block stacks without the plate growing a page's padding", async () => {
    const css = await read("src/styles/global.css");
    const rule = css.slice(css.indexOf(".ui-page-title--stack {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("flex-direction: column;");
    expect(body).toContain("align-items: flex-start;");
    // The sentence takes the plate's padding, not the page's — or the chip inherits a page indent
    // and becomes a panel again.
    expect(css).toContain(".ui-page-title .arch-lede { padding: 0; }");
  });
});
