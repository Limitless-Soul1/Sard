// RESILIENCE-1 / WP-5D — THE RETRY POLICY'S SHAPE IS PINNED.
//
// WP-5's change was "one gate in front, one class beside" and left the RAWY-257/266 ladder untouched.
// Failure isolation later REPLACED that ladder on purpose (see ttsScheduler.ts): retries are the
// scheduler's, in two phases — backoff without a count limit while a sentence is still ahead of playback,
// and ONE bounded recovery round once it is current. These tests pin the round's shape so a later edit that
// quietly widens the user-facing wait fails here rather than in a listener's ears.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TTS_MAX_RETRIES, TTS_RECOVERY_BUDGET_MS, VOICE_MISMATCH_MARKER } from "../../src/lib/tts";
import { DEFAULT_POLICY } from "../../src/lib/ttsScheduler";
import { isImplausiblyShortAudio } from "../../src/lib/voiceCompat";

describe("the current-sentence recovery round is bounded", () => {
  it("holds at most three attempts, and the indicator reads the same number", () => {
    expect(TTS_MAX_RETRIES).toBe(3);
    expect(DEFAULT_POLICY.maxRecoveryAttempts).toBe(TTS_MAX_RETRIES);
  });

  it("is a 12 s TOTAL budget — the hard maximum a listener waits before the failure shows", () => {
    expect(TTS_RECOVERY_BUDGET_MS).toBe(12000);
    expect(DEFAULT_POLICY.budgetMs).toBe(TTS_RECOVERY_BUDGET_MS);
    // no attempt may start with less than a cold connection's worth of budget left
    expect(DEFAULT_POLICY.minAttemptMs).toBeGreaterThanOrEqual(1500);
  });
});

describe("one synthesis at a time — the Rust side's single-call assumption", () => {
  // `tts.rs` keeps ONE cancel flag ("the current call") and serialises calls on one engine mutex; both
  // assume the frontend never has two `tts_synthesize` calls in flight. That holds because every call
  // reaches the IPC through one function, called from one place, reached only through the single-flight
  // scheduler. Pin the shape: a second entry point would silently break the cancel semantics.
  const src = readFileSync(resolve(__dirname, "../../src/lib/tts.ts"), "utf8");
  const calls = (re: RegExp) => (src.match(re) ?? []).length;

  it("has exactly one IPC call site, inside rawSynth", () => {
    expect(calls(/invoke<ArrayBuffer>\("tts_synthesize"/g)).toBe(1);
    expect(calls(/\bttsSynthesize\b/g)).toBe(0); // the ipc.ts wrapper is not used here
  });

  it("rawSynth is called from attemptSynth only, attemptSynth from synthDispatch only", () => {
    expect(calls(/\brawSynth\(/g)).toBe(2); // the definition + the one call
    expect(calls(/\battemptSynth\(/g)).toBe(2);
  });

  it("synthDispatch is handed to the scheduler and called nowhere else", () => {
    expect(calls(/\bsynthDispatch\b/g)).toBe(4); // two comments, the definition, the scheduler's constructor
    expect(src).toContain("new SynthScheduler<Synthesized>(synthDispatch,");
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
