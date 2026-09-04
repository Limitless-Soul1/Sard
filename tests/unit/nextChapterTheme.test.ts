import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE REINTRODUCTION GUARD FOR THE NEXT-CHAPTER PLATE.
 *
 * The control's ten `--nc-*` tokens were once sixteen hand-written blocks, one per built-in paper, keyed
 * on `:root[data-theme="<id>"]`. A theme the reader MAKES carries `data-theme="u:<id>"`, matched none of
 * them, and fell through to the base block — Ivory, in hex. Measured in the running application with a
 * reader-made theme whose paper is #2A1B3D and whose accent is #7CF0C8: the plate rendered
 * rgb(245,238,221) and took Ivory's ink for its cap. Every custom theme drew an Ivory plate.
 *
 * The table was one rule written sixteen times — paper is the theme's `paperBg`, ink is its `text`, and
 * the cap is the ink on light papers and the ACCENT on dark ones — so it is now stated once and derived,
 * the same answer `vistaTokens.ts` gives for Vista's furniture.
 *
 * Two invariants keep it that way: no per-theme block may declare these tokens again, and the label must
 * stay on the interface face rather than the reading faces it used to borrow.
 */
// The stylesheet is CRLF on disk; normalise so an assertion can span lines without depending on it.
const CSS = readFileSync(join(__dirname, "../../src/styles/global.css"), "utf8").split("\r\n").join("\n");

describe("the next-chapter plate follows the active theme", () => {
  it("no per-theme block declares the plate's tokens", () => {
    // Any `:root[data-theme=…] { … --nc-… }` is the table coming back, and with it every custom theme
    // losing its colours again.
    const offenders = CSS.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("data-theme=") && line.includes("--nc-"));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim().slice(0, 60)}`)).toEqual([]);
  });

  it("the tokens are derived from the theme's own values", () => {
    const root = CSS.slice(CSS.indexOf("--nc-paper:"), CSS.indexOf("--nc-wash:") + 200);
    expect(root).toMatch(/--nc-paper:\s*var\(--paper-bg\)/);
    expect(root).toMatch(/--nc-ink:\s*var\(--text\)/);
    expect(root).toMatch(/--nc-cap:\s*var\(--text\)/); // light papers: the cap carries the ink
  });

  it("a dark paper takes the theme's accent on the cap", () => {
    // The concept's dark-paper rule, and the only reason Moonlit's gilt cap needs no special case.
    const dark = CSS.slice(CSS.indexOf(':root[data-dark="true"] {\n  --nc-cap'));
    expect(dark.slice(0, 400)).toMatch(/--nc-cap:\s*var\(--accent\)/);
  });

  it("the label is set in the interface face, not a reading face", () => {
    const label = CSS.slice(CSS.indexOf(".tts-next-plate .tts-next-label {"));
    const block = label.slice(0, label.indexOf("}"));
    expect(block).toMatch(/var\(--ui\)/);
    expect(block).not.toMatch(/var\(--(ar|book)\)/);
  });
});
