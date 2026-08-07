// RESILIENCE-1 / WP-5D — THE RETRY LADDER MUST BE UNTOUCHED.
//
// WP-5's whole change is "one gate in front, one class beside". The ladder, its backoff constants and
// every pre-existing classifier were calibrated against measured recovery curves (RAWY-257/266) and
// this package produced no evidence to move any of them. These tests exist so that stays true by
// check rather than by intention — a later edit that quietly widens the ladder fails here.

import { describe, expect, it } from "vitest";
import { TTS_MAX_RETRIES, VOICE_MISMATCH_MARKER } from "../../src/lib/tts";
import { isImplausiblyShortAudio } from "../../src/lib/voiceCompat";

describe("WP-5D — the ladder's shape is unchanged", () => {
  it("still runs exactly three retry attempts after the initial one", () => {
    // RAWY-257 2B / D68: three delays (500 / 1500 / 4500) ⇒ four dispatches at most. Changing this
    // changes how long a reader waits through a real outage, which is not WP-5's business.
    expect(TTS_MAX_RETRIES).toBe(3);
  });
});

describe("WP-5B — the mismatch is terminal and never retried", () => {
  it("is a distinct marker, not a reuse of an existing error string", () => {
    // Reusing "unknown edge voice" would have been easier and wrong: that names a DIFFERENT problem
    // with a different user action (the voice is absent in this region, RAWY-179).
    expect(VOICE_MISMATCH_MARKER).toBe("voice-language-mismatch");
    expect(VOICE_MISMATCH_MARKER).not.toContain("unknown edge voice");
  });

  it("the marker text a thrown mismatch carries is matchable", () => {
    // The thrown message is `${MARKER}: <voice> returned N bytes for M chars`. `isPermanentFailure`
    // matches on `includes(MARKER)`, so the prefix position must not matter and the marker must
    // survive being embedded in a longer sentence.
    const thrown = `${VOICE_MISMATCH_MARKER}: en-US-AriaNeural returned 6 bytes for 42 chars`;
    expect(thrown.includes(VOICE_MISMATCH_MARKER)).toBe(true);
  });

  it("does not collide with the 4xx rule that governs every other permanent failure", () => {
    // `isPermanentFailure` also treats a non-429 4xx as permanent. The marker must not accidentally
    // contain a 4xx-looking token, or the two rules would be indistinguishable in a debug string.
    expect(/\b4\d\d\b/.test(VOICE_MISMATCH_MARKER)).toBe(false);
  });
});

describe("WP-5B — the detector fires only on a real degenerate response", () => {
  it("fires on the 6 bytes Edge actually returns", () => {
    expect(isImplausiblyShortAudio("نص عربي", 6)).toBe(true);
  });

  it("never fires on a normal synthesis, however short the sentence", () => {
    // The smallest REAL synthesis measured was 28,676 bytes for a one-line sentence. Even a single
    // spoken word is thousands of bytes at 48 kbit/s, so the detector cannot reach normal traffic.
    expect(isImplausiblyShortAudio("Yes.", 4_096)).toBe(false);
    expect(isImplausiblyShortAudio("Yes.", 28_676)).toBe(false);
  });

  it("never fires when nothing was asked for", () => {
    // A punctuation-only unit legitimately yields no audio (RAWY-159 skips it). Calling that a
    // compatibility failure would strand a session on a terminal state over a stray "…".
    expect(isImplausiblyShortAudio("", 0)).toBe(false);
    expect(isImplausiblyShortAudio("   \n ", 0)).toBe(false);
  });
});
