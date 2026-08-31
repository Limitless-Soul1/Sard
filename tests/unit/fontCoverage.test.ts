import { describe, expect, it } from "vitest";
import { chromeStack, coverageOf, FONT_CATALOGUE } from "../../src/lib/fonts";

/**
 * ONE APPLICATION FONT, AND A FALLBACK THAT WAS CHOSEN RATHER THAN STUMBLED INTO.
 *
 * The reader picks one family and every typography role is built from it. A face that cannot draw a
 * script must not be put in front of that script — measured in the running app, picking Aref Ruqaa
 * set every Latin label in Aref Ruqaa's rudimentary Latin, because the face does carry a few Latin
 * glyphs and so the browser never fell through.
 */
describe("application font coverage", () => {
  it("knows which scripts each built-in face covers", () => {
    expect(coverageOf("Literata")).toEqual({ latin: true, arabic: false });
    expect(coverageOf("Inter")).toEqual({ latin: true, arabic: false });
    expect(coverageOf("SourceSerif4")).toEqual({ latin: true, arabic: false });
    expect(coverageOf("NotoNaskhArabic")).toEqual({ latin: false, arabic: true });
    expect(coverageOf("ArefRuqaa")).toEqual({ latin: false, arabic: true });
    expect(coverageOf("Amiri")).toEqual({ latin: true, arabic: true });
  });

  it("treats an imported face as covering both, because nothing honest says otherwise", () => {
    // A file name is not evidence. The browser's per-glyph fallback decides instead.
    expect(coverageOf("thmanyahserifdisplay")).toEqual({ latin: true, arabic: true });
  });

  it("puts a Latin-only pick in front, and an Arabic-only pick behind the Latin default", () => {
    // Chrome is ONE stack for both scripts, so ORDER is the only lever.
    expect(chromeStack("Literata")).toMatch(/^"Literata", "SardUILatin"/);
    // Arabic-only: Latin must reach Plex first, and Arabic still reaches the pick right after.
    const ar = chromeStack("ArefRuqaa");
    expect(ar.indexOf('"SardUILatin"')).toBeLessThan(ar.indexOf('"ArefRuqaa"'));
    expect(ar.indexOf('"ArefRuqaa"')).toBeLessThan(ar.indexOf('"SardUIArabic"'));
    // and SardUILatin appears once, not twice
    expect(ar.match(/"SardUILatin"/g)).toHaveLength(1);
  });

  it("declares an @font-face for every face the app-font picker offers", () => {
    // Noto Naskh was offered here and registered only for the book iframe, so choosing it as the
    // APPLICATION font silently did nothing: the family was unknown to the chrome document.
    const css = require("node:fs").readFileSync("src/styles/global.css", "utf8") as string;
    for (const f of FONT_CATALOGUE) {
      if (!f.css) continue; // the empty id means "the Plex default pair"
      expect(css, `${f.css} has an @font-face`).toContain(`font-family: "${f.css}"`);
    }
  });
});
