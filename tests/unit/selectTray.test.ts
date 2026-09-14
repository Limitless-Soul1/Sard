// WHAT MAY BE DONE WITH THE BOOKS THAT HAVE BEEN CHOSEN — the tray, not the choosing.
//
// The tray is CSS and JSX, so it is read as FILES here, the way this repo's other structural guards
// are. What is guarded is exactly what was wrong, measured in the running library before the change:
//
//   • Its buttons were painted by WINDOWS. Measured in Arabic with three books chosen, «حذف الكتاب»
//     and «تمّ» were drawn on rgb(240,240,240) with a 2px rgb(0,0,0) edge — ButtonFace and its
//     outset border. The tray hangs beside `.libd-stage`, so the `appearance: none` reset that names
//     the four other floating surfaces never reached it. On a dark theme those were near-white
//     slabs, which is why the surface did not read as Sard at all.
//   • Nothing answered a press. The whole appearance was inline style, and inline style has no
//     `:hover`, no `:active` and no `:focus-visible`.
//   • Everything weighed the same: an accent fill, a bordered red chip and a bordered grey chip in a
//     row, so "which of these is destructive" and "which of these leaves" were not readable.
//   • Its padding was PHYSICAL (`9px 10px 9px 16px`), so in Arabic the wider side landed on the
//     wrong edge.
//
// And one thing that must NOT drift: the tray does not own the selection. It calls the three
// callbacks it is given and touches no selection state, so a redesign here can never change what
// ticking a book does.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");

/** The rule for `sel` that DECLARES `must` — a selector appears in several rules (the shared
 *  shape, a state, the reduced-motion override), and only one of them is the one under test. */
const blockOf = (css: string, sel: string, must: string): string => {
  for (let at = css.indexOf(sel + " {"); at >= 0; at = css.indexOf(sel + " {", at + 1)) {
    const body = css.slice(at, css.indexOf("}", at));
    if (body.includes(must)) return body;
  }
  return "";
};

const CSS = read("src/styles/library-design.css");
const MENUS = read("src/features/library/design/Menus.tsx");
const LIB = read("src/features/library/design/LibraryDesign.tsx");

/** The tray's own block of the stylesheet — from its banner to the end of the file. */
const TRAY_CSS = CSS.slice(CSS.indexOf("WHAT MAY BE DONE WITH THE BOOKS THAT HAVE BEEN CHOSEN"));
/** `SelectTray`'s body — from its declaration to the end of the component. */
const TRAY_TSX = (() => {
  const at = MENUS.indexOf("export function SelectTray(");
  expect(at).toBeGreaterThan(0);
  return MENUS.slice(at);
})();

describe("the platform never paints this surface again", () => {
  it("names the tray in the container reset that declines the platform's own chrome", () => {
    // The reset lists the surfaces that float over the library; the tray was missing from it.
    const reset = CSS.slice(CSS.indexOf(".libd-chrome button:not(.lib-settings-btn)"));
    const head = reset.slice(0, reset.indexOf("{"));
    expect(head).toContain(".libd-seltray button");
    expect(reset.slice(0, reset.indexOf("}"))).toContain("appearance: none");
  });

  it("scopes its own controls so they OUTRANK that reset", () => {
    // `.libd-seltray button` is (0,1,1). A bare `.libd-seltray-move` is (0,1,0) and would lose its
    // ground, its border and its font to the reset — silently, which is how this class of bug hides.
    for (const cls of ["libd-seltray-move", "libd-seltray-del", "libd-seltray-done"]) {
      const decl = TRAY_CSS.match(new RegExp(`^\\s*\\.[^\\n]*\\.${cls}[^\\n]*$`, "gm")) ?? [];
      expect(decl.length).toBeGreaterThan(0);
      for (const line of decl) expect(line).toMatch(/\.libd-seltray\s+\.libd-seltray-/);
    }
  });

  it("gives every control a ground, an edge and a radius of its own", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-done", "appearance: none");
    expect(block).toContain("appearance: none");
    expect(block).toContain("border: 1px solid transparent");
    expect(block).toContain("border-radius: var(--r-md)");
  });
});

describe("a press can be felt", () => {
  it("states hover, press and focus for all three controls", () => {
    // Measured OUTSIDE the reduced-motion block: that block also names every `:active` rule, to
    // take the movement back, so a guard that searched the whole sheet was satisfied by the
    // cancellation even after the states themselves had gone.
    const states = TRAY_CSS.replace(/@media \(prefers-reduced-motion[\s\S]*?\n\}/, "");
    for (const cls of ["libd-seltray-move", "libd-seltray-del", "libd-seltray-done"]) {
      expect(states).toContain(`.libd-seltray .${cls}:hover`);
      expect(states).toContain(`.libd-seltray .${cls}:active`);
      expect(states).toContain(`.libd-seltray .${cls}:focus-visible`);
    }
  });

  it("and takes the press animation back where motion is not wanted", () => {
    const rm = TRAY_CSS.slice(TRAY_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm.slice(0, 420)).toContain("transform: none");
    expect(rm.slice(0, 420)).toContain("animation: none");
  });
});

describe("three actions, three different weights", () => {
  it("the move is the one accent fill, and carries no icon", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-move", "background: var(--acc)");
    expect(block).toContain("background: var(--acc)");
    expect(block).toContain("color: var(--pap)");
    // Sard's accent primaries are a label and nothing else.
    const jsx = TRAY_TSX.slice(TRAY_TSX.indexOf('className="libd-seltray-move"'));
    expect(jsx.slice(0, jsx.indexOf("</button>"))).not.toContain("<Icon");
  });

  it("the deletion is danger INK at rest, tinted only under the pointer", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-del", "#B24A4A");
    expect(block).toContain("background: none"); // never a second filled block beside the primary
    expect(block).toContain("#B24A4A"); // the danger red Sard uses everywhere else
    expect(TRAY_CSS).toMatch(/\.libd-seltray-del:hover \{ background: color-mix\(in srgb, #B24A4A/);
    // And the dark themes get the lighter pair, as every other destructive control does.
    expect(TRAY_CSS).toMatch(/:root\[data-dark="true"\] \.libd-seltray \.libd-seltray-del \{[^}]*#E88C8C/);
  });

  it("«تمّ» is a quiet: no ground and no edge until it is wanted", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-done", "color: var(--mut)");
    expect(block).toContain("color: var(--mut)");
    expect(block).not.toContain("background:");
    expect(block).not.toContain("border:");
  });

  it("and the count is a figure with a caption, not a sentence in one weight", () => {
    expect(TRAY_CSS).toContain("font-variant-numeric: tabular-nums");
    expect(TRAY_TSX).toContain('<span className="libd-seltray-n">{localeNum(selected.length, lang)}</span>');
    expect(TRAY_TSX).toContain('<span className="libd-seltray-lbl">{t("lib.selected")}</span>');
  });
});

describe("both directions, from one set of rules", () => {
  it("uses logical properties throughout — with one stated exception", () => {
    // A physical `left`/`right`/`top`/`bottom` or a four-value `padding`/`margin` shorthand is how a
    // surface ends up mirrored wrongly in Arabic. The single exception is the menu's centring, where
    // `inset-inline-start: 50%` would resolve to the RIGHT edge in Arabic and push the menu off its
    // control; `left: 50%` with a symmetric translate is the direction-neutral answer.
    // Comments out first: this sheet explains itself at length, and a sentence that happens to
    // begin with the word "bottom" is not a declaration.
    const declarations = TRAY_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = declarations.split("\n").filter((l) => {
      const d = l.trim();
      if (!d) return false;
      if (/left: 50%|translateX\(-50%\)/.test(d)) return false; // the stated exception
      return /^(left|right|top|bottom|padding-(left|right|top|bottom)|margin-(left|right|top|bottom)|border-(left|right|top|bottom)-)\s*:/.test(d);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the count leading and the way out trailing by ORDER, not by side", () => {
    const order = ["libd-seltray-count", "libd-seltray-rule", "libd-seltray-ops", "libd-seltray-rule", "libd-seltray-done"];
    let at = TRAY_TSX.indexOf('className="libd-seltray-plate"');
    for (const cls of order) {
      const next = TRAY_TSX.indexOf(cls, at);
      expect(next, `${cls} in reading order`).toBeGreaterThan(at);
      at = next + 1;
    }
  });

  it("and lets each shelf name read in its own direction", () => {
    expect(TRAY_TSX).toContain('<span className="libd-seltray-target" dir="auto">{m.name}</span>');
  });
});

describe("the move menu tells a case from a shelf from a category", () => {
  it("prints the case once as a heading instead of folding it into every label", () => {
    expect(TRAY_TSX).not.toContain("`${c.name} · `"); // the old flat prefix
    expect(TRAY_TSX).toContain("addShelf(s, c.name,");
    expect(TRAY_TSX).toContain('className="libd-menu-legend libd-seltray-group"');
    // With no case anywhere, a heading over the only group there is would say nothing.
    expect(TRAY_TSX).toContain("anyCase ? t(\"lib.unfiled\") : null");
  });

  it("marks a shelf with a square and a category with the smaller round mark", () => {
    expect(TRAY_CSS).toContain(".libd-seltray .libd-seltray-ink.is-sub");
    expect(TRAY_TSX).toContain("`libd-seltray-ink${m.sub ? \" is-sub\" : \"\"}`");
  });

  it("hangs the menu from the control that opened it, clearing the plate's own edge", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-menu", "position: absolute");
    // `100%` is the CONTROL's height; the control sits one padding step inside the plate, so the
    // padding has to be cleared too or the two borders cross (measured: a 2px overlap).
    expect(block).toContain("inset-block-end: calc(100% + var(--seltray-pad) + var(--sp-3))");
    expect(block).toContain("left: 50%");
    expect(block).toContain("transform: translateX(-50%)");
    // The shared rise animates `transform` from nothing and would drop the centring mid-animation.
    expect(block).toContain("animation: libd-seltray-rise");
    expect(TRAY_CSS).toContain("@keyframes libd-seltray-rise");
    expect(TRAY_CSS).toMatch(/@keyframes libd-seltray-rise \{[^}]*translateX\(-50%\)/);
  });

  it("sizes itself to its content rather than standing at a fixed width", () => {
    const block = blockOf(TRAY_CSS, ".libd-seltray .libd-seltray-menu", "inline-size: max-content");
    expect(block).toContain("inline-size: max-content");
    expect(block).toContain("min-inline-size");
    expect(block).toMatch(/max-inline-size: min\(272px, calc\(100vw/); // never off the window
  });

  it("and uses the library's own menu rows, whose states the tray now inherits", () => {
    expect(TRAY_TSX).toContain('className="libd-menu-item"');
    for (const state of [":hover", ":active", ":focus-visible"]) {
      const list = CSS.slice(CSS.indexOf(`.libd-stage .libd-menu-item${state}`));
      expect(list.slice(0, list.indexOf("{"))).toContain(`.libd-seltray .libd-menu-item${state}`);
    }
  });
});

describe("the tray does not own the selection", () => {
  it("calls the three callbacks it is given, with the arguments it was always given", () => {
    expect(TRAY_TSX).toContain("onMove(pendingTarget.shelfId, pendingTarget.categoryId, id)");
    expect(TRAY_TSX).toContain("onMove(pendingTarget.shelfId, pendingTarget.categoryId, null)");
    expect(TRAY_TSX).toContain("onMove(target.shelfId, target.categoryId, source.shelfId)");
    expect(TRAY_TSX).toContain("onClick={onDelete}");
    expect(TRAY_TSX).toContain("onClick={onClear}");
  });

  it("writes no selection state of its own", () => {
    // A tray that could tick, untick or clear a book itself is a second selection implementation.
    expect(TRAY_TSX).not.toMatch(/setSelected|toggleIn|toggleAllIn|setMode\(/);
  });

  it("is drawn only while something is chosen, and the mode alone never raises it", () => {
    expect(TRAY_TSX).toContain("if (!selected.length) return null;");
  });

  it("and no longer asks for the book rows it only used for decoration", () => {
    // Four paint blocks stood in for the books, capped at four however many were chosen — so at
    // five they were simply untrue, on the noisiest part of the surface.
    const props = TRAY_TSX.slice(0, TRAY_TSX.indexOf("const { t, lang }"));
    expect(props).not.toContain("byId");
    expect(props).not.toContain("autoCoverPaint");
    const call = LIB.slice(LIB.indexOf("<SelectTray"), LIB.indexOf("/>", LIB.indexOf("<SelectTray")));
    expect(call).not.toContain("byId=");
    expect(call).toContain("onMove={bulkMove}");
    expect(call).toContain("onDelete=");
    expect(call).toContain("onClear=");
  });
});
