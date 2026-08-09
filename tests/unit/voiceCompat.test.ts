// RESILIENCE-1 / WP-5 — the compatibility matrix, pinned to the MEASUREMENTS.
//
// Every expectation below traces to a live synthesis recorded from live synthesis (
// 10 pairs against the real Edge endpoint). Where there is no measurement there is no warning, and
// these tests assert that too — a speculative warning is the failure mode this design ranks worst,
// because it teaches readers to dismiss the dialog that matters.

import { describe, expect, it } from "vitest";
import {
  isImplausiblyShortAudio,
  isMultilingual,
  MIN_PLAUSIBLE_AUDIO_BYTES,
  primaryLang,
  voiceCompatibility,
} from "../../src/lib/voiceCompat";

const v = (id: string, lang: string) => ({ id, lang });

describe("WP-5A — the pairs that were MEASURED to fail", () => {
  // en/fr/de + Arabic each returned a 6-byte MP3. These are the only combinations with evidence of
  // failure, and they are the only ones allowed to be called incompatible.
  it.each([
    ["en-US-AriaNeural", "en-US"],
    ["fr-FR-DeniseNeural", "fr-FR"],
    ["de-DE-KatjaNeural", "de-DE"],
  ])("%s cannot read an Arabic book", (id, lang) => {
    expect(voiceCompatibility("arabic", v(id, lang))).toBe("incompatible");
  });
});

describe("WP-5A — the pairs that were MEASURED to work must NEVER be warned about", () => {
  it("an Arabic voice reading a Latin book (36,741 bytes) is compatible", () => {
    // The original symmetric plan would have flagged this. It measurably works, and the owner
    // plausibly does it — an Arabic voice on an English book.
    expect(voiceCompatibility("latin", v("ar-EG-SalmaNeural", "ar-EG"))).toBe("compatible");
  });

  it("an English voice reading a Latin book is compatible", () => {
    expect(voiceCompatibility("latin", v("en-US-AriaNeural", "en-US"))).toBe("compatible");
  });

  it("an Arabic voice reading an Arabic book is compatible", () => {
    expect(voiceCompatibility("arabic", v("ar-EG-SalmaNeural", "ar-EG"))).toBe("compatible");
  });

  it("a Multilingual voice is universal, on any book", () => {
    expect(voiceCompatibility("arabic", v("en-AU-WilliamMultilingualNeural", "en-AU"))).toBe("universal");
    expect(voiceCompatibility("latin", v("en-AU-WilliamMultilingualNeural", "en-AU"))).toBe("universal");
    // Multilingual wins over the locale, exactly as the picker's own sorting does.
    expect(isMultilingual("en-AU-WilliamMultilingualNeural")).toBe(true);
    expect(isMultilingual("ar-EG-SalmaNeural")).toBe(false);
  });
});

describe("WP-5A — no speculative warnings", () => {
  it("says nothing about a book whose script was never sniffed", () => {
    // A row imported before WP-2 has no `script_detected`. Warning on it would be a guess.
    expect(voiceCompatibility(null, v("en-US-AriaNeural", "en-US"))).toBe("compatible");
  });

  it("treats other Arabic-SCRIPT locales as able to read Arabic", () => {
    // Not measured, but they render the same script. If one of them is in fact silent, WP-5B's
    // empty-audio net still catches it at synthesis time — with no false positive in the meantime.
    for (const [id, lang] of [
      ["fa-IR-DilaraNeural", "fa-IR"],
      ["ur-PK-AsadNeural", "ur-PK"],
      ["ps-AF-GulNawazNeural", "ps-AF"],
    ]) {
      expect(voiceCompatibility("arabic", v(id, lang)), `${lang} renders Arabic script`).toBe("compatible");
    }
  });

  it("makes no claim about scripts outside the measured set", () => {
    // A Latin book with a Japanese voice is a language mismatch, not a rendering failure, and
    // nothing was measured about it — so it must not warn.
    expect(voiceCompatibility("latin", v("ja-JP-NanamiNeural", "ja-JP"))).toBe("compatible");
  });
});

describe("WP-5A — locale parsing", () => {
  it("parses a primary language from both locale shapes", () => {
    expect(primaryLang("ar-EG")).toBe("ar");
    expect(primaryLang("ar_JO")).toBe("ar");
    expect(primaryLang("EN-us")).toBe("en");
    expect(primaryLang("")).toBe("");
  });
});

describe("WP-5B — the empty-audio net, from the measured numbers", () => {
  it("flags the 6-byte buffer a mismatch actually returns", () => {
    expect(isImplausiblyShortAudio("السلام عليكم", 6)).toBe(true);
  });

  it("accepts the smallest REAL synthesis measured (28,676 bytes)", () => {
    expect(isImplausiblyShortAudio("Hello, this is an English sentence.", 28_676)).toBe(false);
  });

  it("sits in the empty valley between them, nowhere near either edge", () => {
    // The threshold is not finely judged and must not become so: 6 ≪ 512 ≪ 28,676.
    expect(MIN_PLAUSIBLE_AUDIO_BYTES).toBeGreaterThan(6 * 10);
    expect(MIN_PLAUSIBLE_AUDIO_BYTES).toBeLessThan(28_676 / 10);
  });

  it("does NOT call an empty request a compatibility failure", () => {
    // Nothing asked for, nothing back — correct behaviour, not a mismatch.
    expect(isImplausiblyShortAudio("", 0)).toBe(false);
    expect(isImplausiblyShortAudio("   ", 6)).toBe(false);
  });
});
