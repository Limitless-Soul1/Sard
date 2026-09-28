// WHOLE-WORD IN-BOOK SEARCH — the second matching mode, and the promise that the first one did not move.
//
// Sard's search is a substring search: «أودر» finds «أودري», and with the switch off it still does. With
// it on, a hit counts only where the query stands as a word of its own.
//
// The cases below run the REAL matcher (public/foliate-js/search.js) and the REAL filter
// (public/foliate-js/sard-wordmatch.js), in the same order and on the same data as the patched
// `searchMatcher`: match first, then test the hit's own offsets against the section's strings. No DOM is
// involved — the filter is applied before a Range is ever built — so this is the matching semantics
// itself, not a re-implementation of them.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain ES modules served from public/, with no type declarations.
import { search } from "../../public/foliate-js/search.js";
// @ts-expect-error — as above.
import { isWholeWordHit, SEARCH_WORD_CHAR } from "../../public/foliate-js/sard-wordmatch.js";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const searchJs = read("public/foliate-js/search.js");
const controller = read("src/reader-engine/FoliateController.ts");
const reader = read("src/features/reader/Reader.tsx");
const panel = read("src/features/reader/SearchPanel.tsx");
const references = read("src/lib/references.ts");
const vendor = read("public/foliate-js/VENDOR.txt");

/** The engine's own options for an in-book search — what `searchMatcher` builds for a book with no lang. */
const ENGINE = { locales: "ar", granularity: "grapheme", sensitivity: "base" } as const;

type Range = { startIndex: number; startOffset: number; endIndex: number; endOffset: number };
type Hit = { range: Range; excerpt: { pre: string; match: string; post: string } };

/** Every hit, exactly as the matcher yields them — the search Sard has always done. */
const found = (strs: string[], query: string): Hit[] => [...search(strs, query, ENGINE)] as Hit[];
/** …and the same hits with whole-word on, filtered where the patched matcher filters them. */
const foundWhole = (strs: string[], query: string): Hit[] =>
  found(strs, query).filter((h) => isWholeWordHit(strs, h.range));

const matches = (text: string | string[], query: string) =>
  foundWhole(Array.isArray(text) ? text : [text], query).length > 0;

describe("Arabic — the word must stand on its own", () => {
  it("finds the word itself", () => {
    expect(matches("أودر", "أودر")).toBe(true);
    expect(matches("جاءت أودر ثم تحدثت", "أودر")).toBe(true);
  });

  it("does not find it inside a longer word", () => {
    for (const longer of ["أودري", "أودرت", "أودرون", "أودرها", "ٱلأودر"]) {
      expect(matches(longer, "أودر"), longer).toBe(false);
    }
  });

  it("the prefixed definite article makes a different word", () => {
    expect(matches("الأودر", "أودر")).toBe(false);
    expect(matches("والأودر", "أودر")).toBe(false);
  });

  it("Arabic punctuation is a boundary", () => {
    for (const text of ["أودر، ثم", "ثم أودر؟", "أودر؛ ثم", "قال: أودر", "أودر٫ ثم", "«أودر»", "‹أودر›"]) {
      expect(matches(text, "أودر"), text).toBe(true);
    }
  });

  it("Latin punctuation, brackets and quotes are boundaries too", () => {
    for (const text of ["أودر.", "(أودر)", "[أودر]", "{أودر}", '"أودر"', "'أودر'", "أودر- ثم", "أودر—ثم"]) {
      expect(matches(text, "أودر"), text).toBe(true);
    }
  });

  it("the beginning and the end of the text are boundaries", () => {
    expect(matches("أودر ثم تحدثت", "أودر")).toBe(true);   // beginning
    expect(matches("ثم تحدثت أودر", "أودر")).toBe(true);   // end
    expect(matches("أودر", "أودر")).toBe(true);            // both
  });

  it("every kind of whitespace and line break is a boundary", () => {
    for (const gap of [" ", "\n", "\r\n", "\t", " ", " ", "　"]) {
      expect(matches(`ثم${gap}أودر${gap}ثم`, "أودر"), JSON.stringify(gap)).toBe(true);
    }
  });

  it("an invisible formatting character is a boundary, not a letter", () => {
    // U+200F RIGHT-TO-LEFT MARK and friends are ordinary in Arabic EPUB text. This is the case the
    // engine's own `matchWholeWords` got wrong — measured — which is why Sard filters instead.
    for (const mark of ["‏", "‎", "​", "؜"]) {
      expect(matches(`أودر${mark}ثم`, "أودر"), JSON.stringify(mark)).toBe(true);
    }
  });

  it("tashkīl is ignored in whole-word mode exactly as it is in the default mode", () => {
    // The matcher and its collator are untouched, so both modes fold the same way.
    expect(matches("أُودِر", "أودر")).toBe(true);
    expect(matches("أودرٌ هنا", "أودر")).toBe(true);          // a tanwīn on the last letter
    expect(matches("الليل", "اللَّيْلُ")).toBe(true);
    expect(matches("اللَّيْلُ", "الليل")).toBe(true);
    // …and folding never turns a longer word into a match.
    expect(matches("أُودِري", "أودر")).toBe(false);
  });

  it("a multi-word query matches as a phrase, with a boundary at each end", () => {
    expect(matches("في الضباب الرمادي", "الضباب الرمادي")).toBe(true);
    expect(matches("في الضباب الرماديّة", "الضباب الرمادي")).toBe(false);
  });
});

describe("Latin and mixed script", () => {
  it("matches the word and refuses it inside longer ones", () => {
    expect(matches("the cat sat", "cat")).toBe(true);
    expect(matches("catalog", "cat")).toBe(false);
    expect(matches("bobcat", "cat")).toBe(false);
    expect(matches("ordering", "order")).toBe(false);
    expect(matches("order", "order")).toBe(true);
    expect(matches("users", "user")).toBe(false);
    expect(matches("AIs", "AI")).toBe(false);
    expect(matches("the AI spoke", "AI")).toBe(true);
  });

  it("case is ignored in whole-word mode exactly as it is in the default mode", () => {
    expect(matches("CAT", "cat")).toBe(true);
    expect(matches("Order", "order")).toBe(true);
  });

  it("an apostrophe keeps a possessive out, as the reference rule already does", () => {
    expect(matches("the cat's bowl", "cat")).toBe(false);
    expect(matches("the cat’s bowl", "cat")).toBe(false);
  });

  it("a script change is a boundary only where there is one", () => {
    expect(matches("أودر order", "أودر")).toBe(true);
    expect(matches("أودر order", "order")).toBe(true);
    // Nothing separates them here, so this is one run of word characters and neither half is a word.
    expect(matches("أودرorder", "أودر")).toBe(false);
    expect(matches("أودرorder", "order")).toBe(false);
  });

  it("digits are word characters, so a number is a word like any other", () => {
    expect(matches("الفصل 801", "801")).toBe(true);
    expect(matches("الفصل 8012", "801")).toBe(false);
    expect(matches("801.", "801")).toBe(true);
    expect(matches("v801", "801")).toBe(false);
  });
});

describe("a word split across inline markup — why the excerpt is not enough", () => {
  // MEASURED: the excerpt's pre/post are built from the matched text node alone, so `["bob","cat"]`
  // searching «cat» arrives with pre="" and post="" and would read as a word standing alone. The filter
  // is given the section's strings instead, which is what the matcher itself searched.
  it("the excerpt alone cannot see the other half of the word", () => {
    const [hit] = found(["bob", "cat"], "cat");
    expect(hit.excerpt.pre).toBe("");
    expect(hit.excerpt.post).toBe("");
  });

  it("…and the filter still refuses it, on both sides and in both scripts", () => {
    expect(matches(["bob", "cat"], "cat")).toBe(false);
    expect(matches(["cat", "alog"], "cat")).toBe(false);
    expect(matches(["أود", "ري"], "ري")).toBe(false);
    expect(matches(["أود", "ري"], "أود")).toBe(false);
  });

  it("a whole word really split across nodes is still found", () => {
    expect(matches(["أود", "ري"], "أودري")).toBe(true);
    expect(matches(["قال ", "أودر", " ثم"], "أودر")).toBe(true);
    expect(matches(["hello ", "cat"], "cat")).toBe(true);
    expect(matches(["cat", " sat"], "cat")).toBe(true);
  });
});

describe("the default mode is untouched", () => {
  it("every hit the matcher yields is still yielded when the switch is off", () => {
    const cases: [string[], string][] = [
      [["أودري"], "أودر"], [["أودرت"], "أودر"], [["catalog"], "cat"], [["bobcat"], "cat"],
      [["جاءت أودر ثم تحدثت مع أودري"], "أودر"], [["أودرorder"], "أودر"], [["users"], "user"],
    ];
    for (const [strs, q] of cases) {
      // The patched matcher only ever SKIPS; with the option off it never evaluates the filter at all.
      expect(found(strs, q).length, `${strs.join("|")} / ${q}`).toBeGreaterThan(0);
    }
  });

  it("the substring search still finds a word inside a longer one", () => {
    expect(found(["أودري"], "أودر").length).toBe(1);
    expect(found(["bobcat"], "cat").length).toBe(1);
  });

  it("the filter is applied only when the option is on, and before any Range is built", () => {
    const fn = searchJs.slice(searchJs.indexOf("export const searchMatcher"));
    expect(fn).toContain("if (sardWholeWords && !isWholeWordHit(strs, result.range)) continue");
    expect(fn.indexOf("isWholeWordHit")).toBeLessThan(fn.indexOf("result.range = makeRange("));
    // Upstream's own whole-word option is still there, still wired to the granularity, still unused by Sard.
    expect(fn).toContain("granularity: matchWholeWords ? 'word' : 'grapheme'");
    expect(vendor).toMatch(/^ 15\. .*search\.js/m);
  });
});

describe("counts, snippets, highlighting and navigation all read ONE list", () => {
  const sentence = "جاءت أودر ثم تحدثت مع أودري";

  it("the count is the filtered count", () => {
    expect(found([sentence], "أودر").length).toBe(2);       // today: the word and the longer one
    expect(foundWhole([sentence], "أودر").length).toBe(1);  // whole word: only the word
  });

  it("the highlighted range is the word itself, and never the substring inside the longer word", () => {
    const hits = foundWhole([sentence], "أودر");
    expect(hits.map((h) => h.excerpt.match)).toEqual(["أودر"]);
    // The surviving hit is the FIRST occurrence — the one that stands alone — not the one inside «أودري».
    expect(hits[0].range.startOffset).toBe(sentence.indexOf("أودر"));
    expect(sentence.slice(hits[0].range.startOffset, hits[0].range.endOffset)).toBe("أودر");
  });

  it("the snippet still carries its surroundings, so a result still reads as a sentence", () => {
    const [hit] = foundWhole([sentence], "أودر");
    expect(hit.excerpt.pre).toBe("جاءت ");
    expect(hit.excerpt.post).toContain("ثم تحدثت");
  });

  it("the excluded hit is gone from the list the panel is handed, not merely unhighlighted", () => {
    // The engine filters, so there is no second list anywhere that could disagree with the count:
    // the hits that reach the panel, the rows it renders and the cfi a jump uses are the same objects.
    const engine = controller.slice(controller.indexOf("  async searchBook("), controller.indexOf("  /** RAWY-88: jump to a search hit"));
    expect(engine).toContain("sardWholeWords: !!opts.wholeWord");
    expect(engine).toContain("wholeWord?: boolean;");
  });
});

describe("the two word rules are one rule", () => {
  it("search folds the same characters into a word that the reference rule does", () => {
    // `src/lib/references.ts` decides that «Klein» is not inside "Klein's". Search must not invent a
    // second answer to the same question, so the two classes are held together here.
    const refClass = references.match(/const WORD_CHAR = (\/\[.*?\]\/u)/)?.[1];
    expect(refClass).toBeTruthy();
    expect(String(SEARCH_WORD_CHAR)).toBe(refClass);
  });

  it("…and asks one more question of an apostrophe, which the reference rule does not", () => {
    // Joining two word characters, it is one: a possessive stays out of a whole-word search.
    expect(matches("the cat's bowl", "cat")).toBe(false);
    expect(matches("don't", "don")).toBe(false);
    // Joining nothing, it is a quotation mark, and a quoted word is still a word.
    expect(matches("'cat'", "cat")).toBe(true);
    expect(matches("'أودر'", "أودر")).toBe(true);
    expect(matches("’أودر’", "أودر")).toBe(true);
    expect(matches("the cats' bowls", "cats")).toBe(true);
  });
});

describe("the reader and the panel", () => {
  it("the option is OFF by default and per book, like the spoiler switch beside it", () => {
    expect(reader).toContain("const [searchWholeWord, setSearchWholeWord] = useState(false);");
    expect(reader).toContain('setSearchWholeWord(wholeWordRaw === "1");');
    expect(reader).toContain("settingsSet(`search_whole_word:${bookRef.current}`, next ? \"1\" : \"0\")");
    expect(reader).toContain("settingsGet(`search_whole_word:${target.id}`)");
  });

  it("changing the mode re-runs the search rather than filtering what is on screen", () => {
    // The mode is part of the QUERY, not a filter over results already on screen. The spoiler seal
    // joined it for the same reason — sealed, the sections ahead are never scanned, so answering
    // "show them anyway" has to scan again rather than un-hide something already found. This asserts
    // the rule the array encodes rather than its exact length, so a later input that also belongs to
    // the query can be added without loosening what is being promised here.
    expect(reader).toContain("}, [searchQuery, searchWholeWord");
    expect(reader).toContain("wholeWord: searchWholeWord,");
  });

  it("the panel offers it as a switch, in both languages, following the interface direction", () => {
    expect(panel).toContain('<button className="sp-spoiler sp-opt" onClick={onToggleWholeWord} aria-pressed={wholeWord}>');
    expect(panel).toContain('{t("search.wholeWord")}');
    expect(panel).toContain('{t("search.wholeWordSub")}');
  });

  it("both languages name it", async () => {
    const { ar } = await import("../../src/i18n/locales/ar");
    const { en } = await import("../../src/i18n/locales/en");
    for (const k of ["search.wholeWord", "search.wholeWordSub"] as const) {
      expect((ar as Record<string, string>)[k], k).toBeTruthy();
      expect((en as Record<string, string>)[k], k).toBeTruthy();
    }
    expect(en["search.wholeWord" as keyof typeof en]).toBe("Whole word");
    expect(ar["search.wholeWord" as keyof typeof ar]).toBe("الكلمة كاملة");
  });

  it("it crosses the hosted transport as a plain value beside the query", async () => {
    const hosted = read("src/reader-transport/hosted.ts");
    const host = read("src/reader-host/main.ts");
    expect(hosted).toContain('args: [query, !!opts.wholeWord]');
    expect(host).toContain("wholeWord: !!msg.args[1],");
  });
});
