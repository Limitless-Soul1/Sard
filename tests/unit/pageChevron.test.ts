// THE PAGE-TURN CONTROL — a drawn mark, and four states a hand can feel.
//
// WHAT IT WAS. A 42px disc carrying the TEXT characters `‹` and `›` at
// `font: 300 1.375rem var(--ui-font)`. Three consequences followed, and none of them were design
// decisions: the mark's weight and size were whatever the interface face — or whatever the system
// substituted for it — drew, so the two chevrons were the only marks in Sard not on the icon set's
// stroke; a text glyph sits on a BASELINE, so its optical centre moved with the face while the
// disc's centre did not; and a character cannot take `--icon-stroke` at all.
//
// WHAT THE CONTROL MUST NOT LOSE, and what the rest of this file guards: the two buttons mean
// PREVIOUS and NEXT in every book, whatever direction it reads (RAWY-33 — they used to move the
// page physically, so `‹` advanced an Arabic book), and the mark must therefore NOT be mirrored in
// Arabic. Mirroring it would reintroduce the exact inversion that note describes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(root, "src/styles/global.css"), "utf8");
const reader = readFileSync(join(root, "src/features/reader/Reader.tsx"), "utf8");

/** The two buttons, as they are written in the Reader. */
const buttons = [...reader.matchAll(/<button\s+className="page-chevron page-chevron-(left|right)"[\s\S]*?<\/button>/g)]
  // Prose stripped for the same reason the stylesheet's is below: a note explaining which character
  // the control USED to draw must not be able to satisfy — or fail — a check about what it draws.
  .map((m) => ({
    side: m[1],
    src: m[0].replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, ""),
  }));

/** The `.page-chevron` rules, start of the block to the end of the dark-theme lines. */
const block = css.slice(css.indexOf("/* PAGE-TURN CONTROLS"), css.indexOf(".page-chevron-left {"));
/** The same block with its prose removed — the rules say what the control IS; the prose may quote
 *  what it used to be, and a check that cannot tell the two apart is worse than no check. */
const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the mark comes from Sard's own set", () => {
  it("both controls are still drawn, and there are exactly two", () => {
    expect(buttons.map((b) => b.side)).toEqual(["left", "right"]);
  });

  it("neither carries a text glyph any more", () => {
    for (const b of buttons) {
      expect(b.src, `${b.side} still draws a character`).not.toMatch(/[‹›◂▸]/);
      expect(b.src).toContain("<Icon name=");
    }
  });

  it("the leading control draws the leading caret and the trailing one the trailing caret", () => {
    expect(buttons.find((b) => b.side === "left")!.src).toContain('name="caretLeft"');
    expect(buttons.find((b) => b.side === "right")!.src).toContain('name="caretRight"');
  });

  it("the control no longer sets a font, because there is no text in it", () => {
    expect(rules).not.toMatch(/font:/);
  });

  it("the mark is NOT mirrored in Arabic — the button means previous/next, not left/right", () => {
    // RAWY-33: `‹` is ALWAYS previous. A mirror rule here would make it advance in an Arabic book.
    expect(css).not.toMatch(/\[dir="rtl"\][^{]*\.page-chevron[^{]*\{[^}]*scaleX\(-1\)/);
    expect(css).not.toMatch(/\.page-chevron[^{]*\{[^}]*scaleX\(-1\)/);
  });
});

describe("the actions are unchanged", () => {
  it("the leading control goes backward and the trailing one forward", () => {
    expect(buttons.find((b) => b.side === "left")!.src).toContain("ctrlRef.current?.backward()");
    expect(buttons.find((b) => b.side === "right")!.src).toContain("ctrlRef.current?.forward()");
  });

  it("each is still named, for the pointer and for a screen reader", () => {
    for (const b of buttons) {
      expect(b.src).toMatch(/title=\{t\("reader\.(prev|next)"\)\}/);
      expect(b.src).toMatch(/aria-label=\{t\("reader\.(prev|next)"\)\}/);
    }
  });
});

describe("four states, and a press that is felt", () => {
  // The control was redesigned from a 38px disc into a tall edge rail (the disc, resting at 0.38, was
  // barely findable on a photographic desk). What is pinned is the RULE of each state, not the old
  // disc's numbers: a redesign may move the values, it may not lose a state.
  const base = rules.slice(rules.indexOf(".page-chevron {"));
  const baseBody = base.slice(0, base.indexOf("}"));

  it("rests present but quiet, and comes fully forward under the pointer", () => {
    const rest = Number(baseBody.match(/opacity:\s*([0-9.]+)/)?.[1]);
    expect(rest).toBeGreaterThan(0.5);   // findable on any desk — the old 0.38 was not
    expect(rest).toBeLessThan(1);        // but quiet while reading
    expect(rules).toMatch(/\.page-chevron:hover\s*\{[\s\S]*?opacity:\s*1/);
  });

  it("is a tall target, not a dot", () => {
    // Anchored on the start of a declaration so `min-width` / `line-height` can never be read instead.
    const w = Number(baseBody.match(/(?:^|[\s;{])width:\s*(\d+)px/)?.[1]);
    const h = Number(baseBody.match(/(?:^|[\s;{])height:\s*(\d+)px/)?.[1]);
    expect(h).toBeGreaterThanOrEqual(80);
    expect(h).toBeGreaterThan(w);
    expect(w).toBeGreaterThanOrEqual(36); // comfortably clickable across
  });

  it("answers the press within the frame, and moves the way the page will", () => {
    expect(rules).toMatch(/\.page-chevron:active:not\(:disabled\)\s*\{[\s\S]*?transition:\s*none/);
    expect(rules).toMatch(/\.page-chevron-left:active:not\(:disabled\) > svg \{ transform: translateX\(-\d+px\); \}/);
    expect(rules).toMatch(/\.page-chevron-right:active:not\(:disabled\) > svg \{ transform: translateX\(\d+px\); \}/);
  });

  it("keeps its vertical centring through the press", () => {
    // `.page-chevron` centres itself with `translateY(-50%)`; a pressed state that stated only the
    // scale would replace that transform and drop the button by half its height.
    const active = rules.slice(rules.indexOf(".page-chevron:active:not(:disabled) {"));
    expect(active.slice(0, active.indexOf("}"))).toContain("translateY(-50%)");
  });

  it("shows the keyboard where it is, and only the keyboard", () => {
    expect(rules).toMatch(/\.page-chevron:focus-visible\s*\{[\s\S]*?outline:\s*[\d.]+px solid var\(--accent\)/);
  });

  it("says when it is spent instead of disappearing", () => {
    expect(rules).toMatch(/\.page-chevron:disabled\s*\{[\s\S]*?cursor:\s*default/);
    // Still in the layout — a control that vanishes at the last page makes the desk jump.
    expect(rules).not.toMatch(/\.page-chevron:disabled\s*\{[^}]*display:\s*none/);
  });

  it("stands clear of the Scroll renderer's scrollbar", () => {
    expect(css).toContain('.reader-desk.pdf-view[data-pdf-mode="scroll"] .page-chevron-right');
  });
});

describe("spent only where Sard actually knows", () => {
  it("the end-of-document state is derived the same way the page readout is", () => {
    // If the toolbar says page 1, the «previous» control is off. One derivation, so the two cannot
    // contradict each other on screen.
    expect(reader).toContain("Math.round(fraction * pdfPageCount - 0.5) + 1");
    expect(reader).toMatch(/const atFirstPage = pdfPage1 === 1;/);
    expect(reader).toMatch(/const atLastPage = pdfPage1 > 0 && pdfPage1 === pdfPageCount;/);
  });

  it("an EPUB's chevrons are never disabled — a spine has no exact answer to give", () => {
    expect(reader).toMatch(/const pdfPage1 = isPdf && pdfPageCount/);
  });
});
