// THE END-OF-BOOK CARD.
//
// When read-aloud finishes the last chapter, the pill shows a closing card: an accent book badge, the
// closing line, the question, and a round close button that stops read-aloud. The owner chose this design
// ("Pill card") on 2026-11-25, and asked that it be right in every theme, including the reader's own.
//
// These tests guard a DESIGN DECISION and its theme contract, not a correctness rule. A deliberate redesign
// should update or delete them, not fight them. What they hold:
//   - the card appears ONLY at the end of the book. With a next chapter the chapter-end plate is unchanged,
//     and once the reader has moved off the finished chapter neither shows;
//   - the close still calls `stop`, with the same label, so behaviour does not move;
//   - the owner's exact words;
//   - every colour comes from the pill's own theme tokens. No literal colour and no per-theme block exist,
//     so a reader-made theme (`data-theme="u:<id>"`) cannot fall through to another theme's colours,
//     which is the failure `nextChapterTheme.test.ts` records for the plate;
//   - the badge and the close sit in end slots of the same width, so the card stays balanced.
//
// It renders the real component through `react-dom/server` (no DOM shim, as vitest.config explains). The
// store and the language are supplied directly. Under server rendering a Zustand store answers with its
// INITIAL state, so a `setState` would never reach the markup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ lang: "ar" as "ar" | "en", state: {} as Record<string, unknown> }));

vi.mock("../../src/lib/tts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/tts")>();
  return { ...actual, useTts: (sel: (s: Record<string, unknown>) => unknown) => sel(H.state) };
});
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      lang: H.lang, dir: H.lang === "ar" ? "rtl" : "ltr", ready: true, hasLang: true,
      t: (k: Parameters<typeof actual.translate>[1], v?: Record<string, string | number>) => actual.translate(H.lang, k, v),
      setLang: () => {},
    }),
  };
});

import { TtsPlayer } from "../../src/features/reader/TtsPlayer";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const noop = () => {};
const chapterEndState = (over: Record<string, unknown> = {}) => ({
  active: true, status: "chapter-end", endDismissed: false, engine: "edge", voice: "ar-SA-HamedNeural",
  index: 2, total: 3, speed: 1, volume: 1, chapterLabel: "", error: null, underruns: 0, abandoned: 0,
  lastFailure: null, mismatch: null, debug: false, retryAttempt: 0, retryOf: 0,
  skip: noop, setSpeed: noop, setVolume: noop, retry: noop, resumeEdge: noop, stop: noop, ...over,
});
const render = (hasNextChapter: boolean) =>
  renderToStaticMarkup(createElement(TtsPlayer, { hasNextChapter, onNextChapter: noop, onPlayPause: () => true }));
/** The pill's own class list. */
const pillClasses = (html: string) => (html.match(/<div class="(tts-pill[^"]*)"/)?.[1] ?? "").split(" ");

beforeEach(() => { H.lang = "ar"; H.state = chapterEndState(); });

describe("the end-of-book card shows only at the end of the book", () => {
  it("at the end of the book: the card, on the pill's own body, not the chapter-end plate", () => {
    const html = render(false);
    expect(pillClasses(html)).toContain("book-end");
    expect(pillClasses(html)).not.toContain("chapter-end");
    expect(html).toContain('class="tts-book-end"');
    expect(html).not.toContain("tts-next-plate");
    expect(html).not.toContain("tts-end-msg");
  });

  it("with a next chapter: the chapter-end plate, exactly as before, and no card", () => {
    const html = render(true);
    expect(pillClasses(html)).toContain("chapter-end");
    expect(pillClasses(html)).not.toContain("book-end");
    expect(html).not.toContain("tts-book-end");
    expect(html).toContain("tts-next-plate");
    expect(html).toContain(`>${ar["tts.chapterDone"]}<`);
    expect(html).toContain(`>${ar["tts.nextChapter"]}<`);
  });

  it("after the reader moves off the finished chapter, neither shows (the transport returns)", () => {
    H.state = chapterEndState({ endDismissed: true });
    const html = render(false);
    expect(pillClasses(html)).not.toContain("book-end");
    expect(pillClasses(html)).not.toContain("chapter-end");
    expect(html).toContain("tts-pill-transport");
  });
});

describe("the card's words and its one action", () => {
  it("carries the owner's exact words, in both languages", () => {
    expect(ar["tts.bookEnd"]).toBe("لكل حكاية نهاية، ولكل رحلة أثر.");
    expect(ar["tts.bookEndAsk"]).toBe("ما رأيك في هذه الرحلة؟");
    expect(en["tts.bookEnd"]).toBe("Every story ends, every journey leaves a trace.");
    expect(en["tts.bookEndAsk"]).toBe("What did you think of this journey?");
    for (const lang of ["ar", "en"] as const) {
      H.lang = lang;
      const words = lang === "ar" ? ar : en;
      const html = render(false);
      expect(html).toContain(`<span class="tts-book-end-line">${words["tts.bookEnd"]}</span>`);
      expect(html).toContain(`<span class="tts-book-end-ask">${words["tts.bookEndAsk"]}</span>`);
      expect(html).toContain(`dir="${lang === "ar" ? "rtl" : "ltr"}"`);
    }
  });

  it("has exactly one button, the close, labelled as the ✕ always was", () => {
    const html = render(false);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('class="tts-book-end-close"');
    expect(buttons[0]).toContain(`aria-label="${ar["tts.close"]}"`);
    expect(buttons[0]).toContain(`title="${ar["tts.close"]}"`);
  });

  it("the close still stops read-aloud (same handler as before)", () => {
    // Server rendering drops handlers, so this one is read from the source.
    const src = readFileSync(join(__dirname, "../../src/features/reader/TtsPlayer.tsx"), "utf8");
    expect(src).toMatch(/<button className="tts-book-end-close" onClick=\{stop\}/);
  });

  it("the badge and the close sit in end slots of the same width", () => {
    const html = render(false);
    expect(html.match(/class="tts-book-end-slot"/g) ?? []).toHaveLength(2);
    // The badge is decoration. Only its slot is hidden from assistive technology, never the close.
    expect(html).toMatch(/<span class="tts-book-end-slot" aria-hidden="true"><span class="tts-book-end-badge">/);
    expect(html).toMatch(/<span class="tts-book-end-slot"><button class="tts-book-end-close"/);
  });
});

describe("the card follows every theme, built-in or the reader's own", () => {
  const CSS = readFileSync(join(__dirname, "../../src/styles/global.css"), "utf8").split("\r\n").join("\n");
  const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] }))
    .filter((r) => /tts-book-end|\.book-end\b/.test(r.sel));

  it("has its rules", () => {
    for (const s of [".tts-pill.book-end", ".tts-book-end", ".tts-book-end-slot", ".tts-book-end-badge", ".tts-book-end-line", ".tts-book-end-ask", ".tts-book-end-close", ".tts-book-end-close:hover"]) {
      expect(rules.some((r) => r.sel.split(",").map((x) => x.trim()).includes(s)), s).toBe(true);
    }
  });

  it("names no literal colour and keys nothing on a particular theme", () => {
    for (const r of rules) {
      expect(r.body, r.sel).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
      expect(r.sel, r.sel).not.toMatch(/data-theme|data-dark/);
    }
  });

  it("takes every colour from the pill's own tokens", () => {
    const allowed = new Set(["--text", "--muted", "--accent", "--ui-font"]);
    for (const r of rules) {
      for (const m of r.body.matchAll(/var\((--[\w-]+)/g)) expect(allowed.has(m[1]), `${r.sel}: ${m[1]}`).toBe(true);
    }
  });

  it("keeps the pill's own body: it never takes the chapter-end plate's paper or tokens", () => {
    for (const r of rules) expect(r.body, r.sel).not.toMatch(/--nc-|--paper-bg/);
    // The ground, border, frost and shadow come from `.tts-pill` itself, which `.book-end` does not restate.
    const pill = rules.find((r) => r.sel === ".tts-pill.book-end")!;
    expect(pill.body).not.toMatch(/background|border|box-shadow|backdrop-filter/);
  });

  it("is set in the interface face", () => {
    for (const r of rules.filter((x) => /font\s*:/.test(x.body))) {
      expect(r.body, r.sel).toMatch(/var\(--ui-font\)/);
      expect(r.body, r.sel).not.toMatch(/var\(--(ar|book)\)/);
    }
  });

  it("mirrors through logical flow: no physical left/right in its rules", () => {
    for (const r of rules) expect(r.body, r.sel).not.toMatch(/(^|[;\s])(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/);
  });

  it("respects reduced motion", () => {
    const rm = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce) {\n  .tts-book-end {"));
    expect(rm.slice(0, 200)).toMatch(/\.tts-book-end \{ animation: none; \}/);
  });
});
