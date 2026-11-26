// THE TWO READ-ALOUD SWITCHES BELONG TO THE READER, NOT TO A هيئة.
//
// The report: the reader turns «إبراز الجملة» off, then designs or receives a new هيئة and wears it,
// and the highlight is back on. Every هيئة used to carry both switches, and wearing one wrote them over
// the reader's own row, so the answer the reader gave lasted only until the next switch of هيئة. A
// هيئة carrying no read-aloud block wrote Sard's default, which is ON.
//
// The rule now: «إبراز الجملة» and «إبراز الكلمة» are on or off because the reader said so, and only
// the reader changes them. Their COLOUR and STRENGTH still come from the هيئة, exactly as before.
//
// Each case below starts from the reader's own row with both switches OFF and a colour picked, and
// performs a path the owner reported, composing the patch the way `store.ts` applies it.
import { describe, expect, it } from "vitest";

import { RECIPE_FENCE, RECIPE_FORMAT } from "../../src/features/profiles/model/exchange/recipe";
import { readPastedDesign } from "../../src/features/profiles/model/exchange/read";
import { inspectPackage, manifestText, serialiseProfile } from "../../src/features/profiles/model/package";
import { parseProfileData, readingPatch, type Profile } from "../../src/features/profiles/model/profile";
import { SESSION_KEYS, changesBetween, profileValues } from "../../src/features/profiles/session";
import { defaultProfileData } from "../../src/features/profiles/store";
import {
  resolveAppearanceStyle, splitReadingEdit, withReadingEdit, withReadingMeasure,
} from "../../src/features/reader/bookAppearance";
import { ARABIC_DEFAULTS, TTS_TRACKING_DEFAULTS, type ReadingStyle } from "../../src/reader-engine/injectedCss";
import type { CustomThemeId } from "../../src/theme/tokens";

const prof = (id: string, data = parseProfileData("{}")): Profile => ({
  id: id as CustomThemeId, name: id, description: null, author: null, iconKind: "seal", iconRef: null,
  derivedFrom: null, createdAt: 1, updatedAt: 1, data,
});
const withVoice = (id: string, voice: Partial<typeof TTS_TRACKING_DEFAULTS>) =>
  prof(id, parseProfileData(JSON.stringify({ voice: { ...TTS_TRACKING_DEFAULTS, ...voice } })));

/** `patchReadingStyle` in store.ts: clear, then write. */
const wear = (row: Record<string, unknown>, p: Profile) => {
  const patch = readingPatch(p);
  for (const k of patch.clear) delete row[k];
  Object.assign(row, patch.set);
  return row;
};

/** The reader wears A, picks a colour, then turns BOTH highlights off in the reading panel. */
const readerTurnedThemOff = (a: Profile = prof("u:a")) => {
  const row = wear({}, a);
  row.ttsSpotlightColor = "#7E6A9E";
  row.ttsSpotlightOn = false;
  row.ttsKaraokeOn = false;
  return row;
};
const off = (row: Record<string, unknown>) => ({ spot: row.ttsSpotlightOn, word: row.ttsKaraokeOn });

const paste = (recipe: unknown) => {
  const r = readPastedDesign("```" + RECIPE_FENCE + "\n" + JSON.stringify(recipe) + "\n```");
  if (!r.ok) throw new Error("refused " + r.refusal.code);
  return r.out.data;
};
const viaPackage = (p: Profile) => {
  const seen = inspectPackage(manifestText(serialiseProfile(p, "1.4.3")));
  if (!seen.ok) throw new Error("refused " + seen.refusal.code);
  return prof("u:received", seen.data);
};

describe("switched off, the highlights stay off whatever هيئة is worn next", () => {
  it("a NEW هيئة made in the editor", () => {
    const row = readerTurnedThemOff();
    const data = withReadingMeasure(defaultProfileData(), { ...ARABIC_DEFAULTS, ...row } as ReadingStyle);
    wear(row, prof("u:new", data));
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a SARD-THEME recipe that names the marks' colours", () => {
    const row = readerTurnedThemOff();
    wear(row, prof("u:recipe", paste({ format: RECIPE_FORMAT, name: "R", voice: { sentenceColor: "#6E7F5B", wordColor: "#B08968" } })));
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a recipe that says nothing about read-aloud", () => {
    const row = readerTurnedThemOff();
    wear(row, prof("u:recipe2", paste({ format: RECIPE_FORMAT, name: "R2", texture: "opaque" })));
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a recipe pasted into the هيئة being WORN (the editor replaces its block; saving re-applies it)", () => {
    const worn = prof("u:worn");
    const row = readerTurnedThemOff(worn);
    const pasted = paste({ format: RECIPE_FORMAT, name: "R3", voice: { sentenceColor: "#6E7F5B" } });
    wear(row, prof("u:worn", { ...worn.data, voice: pasted.voice })); // QuickSection: now.voice = d.voice
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a shared package whose sender reads with both highlights ON", () => {
    const row = readerTurnedThemOff();
    wear(row, viaPackage(withVoice("u:sender", { ttsSpotlightColor: "#B08968" })));
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a shared package whose هيئة carries no read-aloud block", () => {
    const row = readerTurnedThemOff();
    wear(row, viaPackage(prof("u:sender2")));
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("switching between existing هيئات, and back to the one they were turned off in", () => {
    const a = prof("u:a");
    const row = readerTurnedThemOff(a);
    wear(row, prof("u:b"));
    expect(off(row)).toEqual({ spot: false, word: false });
    wear(row, withVoice("u:c", { ttsSpotlightColor: "#9FB07E" }));
    expect(off(row)).toEqual({ spot: false, word: false });
    wear(row, a);
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("and the reverse: a reader who keeps them ON is not switched off by a هيئة saved with them off", () => {
    const row = wear({}, prof("u:a"));
    row.ttsSpotlightOn = true;
    row.ttsKaraokeOn = true;
    wear(row, withVoice("u:saved-off", { ttsSpotlightOn: false, ttsKaraokeOn: false }));
    expect(off(row)).toEqual({ spot: true, word: true });
  });

  it("each switch is independent: one off and one on both survive", () => {
    const row = wear({}, prof("u:a"));
    row.ttsSpotlightOn = false;
    row.ttsKaraokeOn = true;
    wear(row, withVoice("u:x", { ttsSpotlightOn: true, ttsKaraokeOn: false }));
    expect(off(row)).toEqual({ spot: false, word: true });
  });
});

describe("the COLOUR still follows the هيئة", () => {
  it("a هيئة with its own colours brings them; one with none puts Sard's back", () => {
    const row = readerTurnedThemOff();
    wear(row, withVoice("u:green", { ttsSpotlightColor: "#6E7F5B", ttsSpotlightOpacity: 0.4, ttsKaraokeColor: "#B08968" }));
    expect(row.ttsSpotlightColor).toBe("#6E7F5B");
    expect(row.ttsSpotlightOpacity).toBe(0.4);
    expect(row.ttsKaraokeColor).toBe("#B08968");
    wear(row, prof("u:none"));
    expect(row.ttsSpotlightColor, "no leak of the previous هيئة's colour").toBeNull();
    expect(row.ttsSpotlightOpacity).toBeNull();
    expect(row.ttsKaraokeColor).toBeNull();
    expect(off(row)).toEqual({ spot: false, word: false });
  });

  it("a recipe's colour reaches the page", () => {
    const row = readerTurnedThemOff();
    wear(row, prof("u:recipe", paste({ format: RECIPE_FORMAT, name: "R", voice: { sentenceColor: "#6E7F5B", sentenceOpacity: 0.3 } })));
    expect(row.ttsSpotlightColor).toBe("#6E7F5B");
    expect(row.ttsSpotlightOpacity).toBe(0.3);
  });

  it("the other read-aloud fields stay the هيئة's (underline, spoken symbols)", () => {
    const row = readerTurnedThemOff();
    wear(row, withVoice("u:v", { ttsSpotlightRule: false, ttsSpeakSymbols: true }));
    expect(row.ttsSpotlightRule).toBe(false);
    expect(row.ttsSpeakSymbols).toBe(true);
  });
});

describe("turning a highlight off is not an edit to the worn هيئة", () => {
  it("the هيئة asserts no switch, so switching one cannot make it look unsaved", () => {
    const values = profileValues(prof("u:a")) as Record<string, string | undefined>;
    expect(values.ttsSpotlightOn).toBeUndefined();
    expect(values.ttsKaraokeOn).toBeUndefined();
    // Nor is either among the values the unsaved-change check compares at all.
    expect(SESSION_KEYS).not.toContain("ttsSpotlightOn");
    expect(SESSION_KEYS).not.toContain("ttsKaraokeOn");
    expect(SESSION_KEYS).toContain("ttsSpotlightColor");
  });

  it("two هيئات that differ only in a stored switch have no difference to report", () => {
    const a = withVoice("u:a", { ttsSpotlightOn: true, ttsKaraokeOn: true });
    const b = withVoice("u:a", { ttsSpotlightOn: false, ttsKaraokeOn: false });
    expect(changesBetween(a, b)).toEqual([]);
  });

  it("but a changed colour still is one", () => {
    const a = withVoice("u:a", {});
    const b = withVoice("u:a", { ttsSpotlightColor: "#6E7F5B" });
    expect(changesBetween(a, b)).toContain("ttsSpotlightColor");
  });
});

describe("a book wearing a هيئة of its own follows the reader's switches too", () => {
  it("the book's هيئة resolves with the reader's answer, and its own colour", () => {
    const session = { ...ARABIC_DEFAULTS, ttsSpotlightOn: false, ttsKaraokeOn: false } as ReadingStyle;
    const own = withVoice("u:book", { ttsSpotlightColor: "#6E7F5B" });
    const s = resolveAppearanceStyle(own, "rtl", session);
    expect([s.ttsSpotlightOn, s.ttsKaraokeOn]).toEqual([false, false]);
    expect(s.ttsSpotlightColor).toBe("#6E7F5B");
  });

  it("a switch flipped in that book is written to the reader's row, never into the book's هيئة", () => {
    const split = splitReadingEdit({ ttsSpotlightOn: false, ttsKaraokeOn: false, ttsSpotlightColor: "#6E7F5B" });
    expect(split.session).toEqual({ ttsSpotlightOn: false, ttsKaraokeOn: false });
    expect(split.appearance).toEqual({ ttsSpotlightColor: "#6E7F5B" });
    const p = prof("u:book");
    expect(withReadingEdit(p, { ttsSpotlightOn: false, ttsKaraokeOn: false })).toBe(p);
  });
});

describe("a fresh reader still starts with both highlights on", () => {
  it("wearing a هيئة leaves the switches absent, and absent resolves to the engine's default", () => {
    const set = readingPatch(withVoice("u:a", { ttsSpotlightOn: false, ttsKaraokeOn: false })).set;
    expect(Object.hasOwn(set, "ttsSpotlightOn")).toBe(false);
    expect(Object.hasOwn(set, "ttsKaraokeOn")).toBe(false);
    expect(ARABIC_DEFAULTS.ttsSpotlightOn).toBe(true);
    expect(ARABIC_DEFAULTS.ttsKaraokeOn).toBe(true);
  });
});

describe("existing packages still import", () => {
  it("a package whose block names both switches is accepted, and they are kept as data", () => {
    const received = viaPackage(withVoice("u:old", { ttsSpotlightOn: false, ttsKaraokeOn: true }));
    expect(received.data.voice?.ttsSpotlightOn).toBe(false);
    expect(received.data.voice?.ttsKaraokeOn).toBe(true);
  });
});
