// WHAT SARD IS READING IN, ASKED FROM OUTSIDE THE READER — and why it must not depend on who asks.
//
// THE DEFECT THIS PINS. `driftOf` answers "has the worn هيئة been changed?" by comparing what the
// هيئة asserts against what Sard is showing. With no book open the second half comes from this
// cache, and the cache used to store the RESOLVED style — the persisted row merged over
// `defaultsForDir(dir)` — so whatever direction the CALLER passed decided what every ABSENT field
// became.
//
// The هيئة editor calls `loadGlobalStyle()` with no direction, because all it wants is the two font
// names. That is correct for the editor and was ruinous for the cache: it rewrote the shared answer
// from an Arabic resolution to a Latin one, and a field the row does not carry — `align` — changed
// from "start" to "justify" underneath everyone.
//
// MEASURED in the running app, on a byte-identical row that carries no `align` at all: `driftOf`
// answered ["zoom","marginPx"] before the editor was opened and ["zoom","marginPx","align"] after,
// with the recorded direction "rtl" at both moments and the هيئة asserting "start" at both. Nothing
// about the reader's appearance had changed; the comparison had simply been given a different
// baseline by a third party.
//
// The rule now: the cache holds the ROW, and resolution happens on READ against the direction the
// cache itself records. Two identical questions therefore get identical answers, whoever else has
// been reading in between.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/lib/ipc", () => ({
  settingsGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
  settingsSet: async (k: string, v: string) => { store.set(k, v); },
}));

const { loadGlobalStyle, noteGlobalStyleRow, peekGlobalStyle, peekGlobalDir, saveGlobalStyle } = await import(
  "../../src/features/reader/perBookSettings"
);
const { defaultsForDir } = await import("../../src/reader-engine/injectedCss");

/** A row that carries a size but names no alignment — the shape the defect needed. */
const ROW_WITHOUT_ALIGN = JSON.stringify({ zoom: 1.42, marginPx: 96 });

describe("the cached reading style is resolved on read, not on load", () => {
  beforeEach(() => {
    store.clear();
    store.set("reading_style", ROW_WITHOUT_ALIGN);
  });

  it("resolves an absent field against the direction the CACHE records", async () => {
    await loadGlobalStyle("rtl");
    expect(peekGlobalDir()).toBe("rtl");
    expect(peekGlobalStyle()?.align).toBe(defaultsForDir("rtl").align);
  });

  it("a caller that passes no direction cannot change what everyone else sees", async () => {
    await loadGlobalStyle("rtl");
    const before = peekGlobalStyle();

    // Exactly what the هيئة editor does: it wants the font names and has no book, so it asks with
    // no direction. Its OWN answer resolves against the Latin baseline, which is right for it.
    const editorsAnswer = await loadGlobalStyle();
    expect(editorsAnswer.align).toBe(defaultsForDir(undefined).align);

    // …and the shared answer is untouched.
    expect(peekGlobalDir()).toBe("rtl");
    expect(peekGlobalStyle()).toEqual(before);
    expect(peekGlobalStyle()?.align).toBe(defaultsForDir("rtl").align);
  });

  it("the two baselines really do differ, or this test would prove nothing", () => {
    expect(defaultsForDir("rtl").align).not.toBe(defaultsForDir(undefined).align);
  });

  it("asking twice with nothing in between gives the same answer", async () => {
    await loadGlobalStyle("rtl");
    expect(peekGlobalStyle()).toEqual(peekGlobalStyle());
  });

  it("a field the row DOES carry is returned as stored, whatever the direction", async () => {
    store.set("reading_style", JSON.stringify({ zoom: 1.42, align: "center" }));
    await loadGlobalStyle("rtl");
    expect(peekGlobalStyle()?.align).toBe("center");
    await loadGlobalStyle();
    expect(peekGlobalStyle()?.align).toBe("center");
  });

  it("a real direction still updates the cache — it moves forward, it just never clears", async () => {
    await loadGlobalStyle("rtl");
    await loadGlobalStyle();
    expect(peekGlobalDir()).toBe("rtl");
    await loadGlobalStyle("ltr");
    expect(peekGlobalDir()).toBe("ltr");
    expect(peekGlobalStyle()?.align).toBe(defaultsForDir("ltr").align);
  });

  it("saving keeps the cache in step without a re-read", async () => {
    await loadGlobalStyle("rtl");
    saveGlobalStyle({ ...defaultsForDir("rtl"), zoom: 1.9, align: "end" });
    expect(peekGlobalStyle()?.zoom).toBe(1.9);
    expect(peekGlobalStyle()?.align).toBe("end");
    expect(peekGlobalDir()).toBe("rtl", "and it does not forget the direction");
  });

  it("an unreadable row still leaves a usable, direction-correct answer", async () => {
    store.set("reading_style", "{not json");
    await loadGlobalStyle("rtl");
    expect(peekGlobalStyle()?.align).toBe(defaultsForDir("rtl").align);
  });
});

describe("a هيئة that is worn does not leave the cache arguing with the row", () => {
  // THE «سلمان» DEFECT. Wearing a هيئة writes `reading_style` through `patchReadingStyle`, which
  // assembles the row itself and persists it with a bare `settingsSet` — straight past this cache.
  // `driftOf` then compared the freshly-applied هيئة against the PREVIOUS one's values and reported
  // changes the reader had never made, every time they returned to it.
  //
  // MEASURED before the fix: a هيئة saved with the Noto Naskh face at 135% and worn immediately
  // reported eleven drifted fields — the هيئة asking for `notoNaskh`/1.35, the ROW already holding
  // `notoNaskh`/1.35, and the cache still holding `plexArabic`/2.5. A restart cleared it, which is
  // the signature of a stale copy rather than a data fault.
  beforeEach(() => {
    store.clear();
    store.set("reading_style", JSON.stringify({ arabicFont: "plexArabic", zoom: 2.5 }));
  });

  it("the row's writer can tell the cache what it wrote", async () => {
    await loadGlobalStyle("rtl");
    expect(peekGlobalStyle()?.arabicFont).toBe("plexArabic");
    expect(peekGlobalStyle()?.zoom).toBe(2.5);

    // exactly what `patchReadingStyle` does: assemble the row, persist it, then say so
    const row = { arabicFont: "notoNaskh", zoom: 1.35 };
    store.set("reading_style", JSON.stringify(row));
    noteGlobalStyleRow(row);

    expect(peekGlobalStyle()?.arabicFont).toBe("notoNaskh");
    expect(peekGlobalStyle()?.zoom).toBe(1.35);
  });

  it("and announcing a row does not lose the direction the comparison needs", async () => {
    await loadGlobalStyle("rtl");
    noteGlobalStyleRow({ zoom: 1.35 });
    expect(peekGlobalDir()).toBe("rtl");
    expect(peekGlobalStyle()?.align).toBe(defaultsForDir("rtl").align);
  });

  it("a field the new row CLEARS falls back to the baseline, not to the old value", async () => {
    // `patchReadingStyle` deletes a field the هيئة does not name, so the cache must forget it too —
    // otherwise the previous هيئة's margin survives in the answer to "what is Sard showing?".
    store.set("reading_style", JSON.stringify({ zoom: 2.5, marginPx: 136 }));
    await loadGlobalStyle("rtl");
    expect(peekGlobalStyle()?.marginPx).toBe(136);
    noteGlobalStyleRow({ zoom: 1.35 }); // margin cleared by the new هيئة
    expect(peekGlobalStyle()?.marginPx).toBe(defaultsForDir("rtl").marginPx);
  });
});

describe("the row has exactly one writer, and it announces itself", () => {
  // The guard that actually prevents the regression: a second writer that forgets to tell the cache
  // reintroduces the whole class of bug, silently and only in the running app.
  it("`patchReadingStyle` calls `noteGlobalStyleRow` after persisting", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/features/profiles/store.ts"), "utf8");
    const body = src.slice(src.indexOf("async function patchReadingStyle"));
    // Cut at the function's own closing brace — the first `}` at column 0. Matched by pattern rather
    // than by a literal newline, because this file is stored with CRLF and a "\n}" search finds none.
    const close = /\r?\n\}/.exec(body);
    const fn = body.slice(0, close ? close.index : body.length);
    expect(fn).toContain("settingsSet(READING_KEY");
    expect(fn, "the row was written without telling the cache").toContain("noteGlobalStyleRow(");
  });

  it("nothing else writes the reading row behind the cache's back", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const root = resolve(__dirname, "../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (/settingsSet\(\s*("reading_style"|READING_KEY)/.test(text)) hits.push(full.replace(root, "src"));
      }
    };
    walk(root);
    expect(hits.length, "writers of the reading row: " + hits.join(", ")).toBe(1);
  });
});
