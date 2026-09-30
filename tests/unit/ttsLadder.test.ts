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
  // assume the frontend never has two `tts_synthesize` calls in flight.
  //
  // THIS USED TO BE READ OFF THE CALL GRAPH — one IPC site, one caller, one scheduler — and that shape no
  // longer holds: cross-chapter preparation is a second, legitimate caller that is not the scheduler. The
  // property itself is unchanged and is now enforced where it belongs, by the turnstile every caller goes
  // through (`engineTurnstile.ts`, with its own behavioural suite). What is pinned here is that NOTHING
  // reaches the engine around it: a third caller, or a call that skips the gate, fails this file.
  const src = readFileSync(resolve(__dirname, "../../src/lib/tts.ts"), "utf8");
  const calls = (re: RegExp) => (src.match(re) ?? []).length;
  /** `rawSynth(...)` call sites, with the text that precedes each one on its own line. */
  const rawSynthCallSites = src
    .split(/\r?\n/)
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\brawSynth\(/.test(line) && !/^(async )?function rawSynth\(/.test(line.trim()));

  it("has exactly one IPC call site, inside rawSynth", () => {
    expect(calls(/invoke<ArrayBuffer>\("tts_synthesize"/g)).toBe(1);
    expect(calls(/\bttsSynthesize\b/g)).toBe(0); // the ipc.ts wrapper is not used here
  });

  it("has exactly two callers of rawSynth: the scheduler's attempt and the background preparation", () => {
    expect(rawSynthCallSites).toHaveLength(2);
    expect(calls(/\battemptSynth\(/g)).toBe(2); // the definition + the one call, from synthDispatch
  });

  it("every one of them runs inside the single-call turnstile", () => {
    // `attemptSynth` wraps its call in `engine.run(..., { preempt: true })` — the listener's own synthesis,
    // which may pre-empt. `runPrepare` wraps its own in `engine.run(...)` without pre-emption, because a
    // background preparation must never displace a listener-facing call.
    expect(src).toContain("engine.run(() => synthInvoke(i, ctx.budgetMs, ctx.firstAudioMs), { preempt: true })");
    expect(src).toMatch(/const out = await engine\.run\(async \(\) => \{[\s\S]*?rawSynth\(curEngine, curVoice, engineTextFor\(text\), PREPARE_UNIT\)/);
    // and the gate is the only thing that owns the turn
    expect(calls(/new EngineTurnstile\(\)/g)).toBe(1);
  });

  it("only the yieldable caller installs a way to be abandoned, and clears it on every exit", () => {
    // A listener-facing dispatch never installs a yielder, so it can never be asked to abandon; the
    // preparation installs one for its own call only and clears it in a `finally`.
    expect(calls(/engine\.setYielder\(/g)).toBe(2); // install + clear, both inside runPrepare
    expect(src).toMatch(/\} finally \{\s*\r?\n?\s*engine\.setYielder\(null\);/);
  });

  it("a cancelled or stopped session cannot leave a preparation running", () => {
    // `discardPrepared()` drops the audio AND asks a holder to yield; both the stop path and the voice
    // change path call it, so no prepared result can appear after the session that asked for it is gone.
    expect(src).toMatch(/function discardPrepared\(\): void \{[\s\S]*?prepared\.clear\(\);[\s\S]*?engine\.run\(async \(\) => undefined, \{ preempt: true \}\)/);
    expect(calls(/discardPrepared\(\);/g)).toBe(2); // stop() and setVoice()
  });

  it("synthDispatch is handed to the scheduler and called nowhere else", () => {
    // Counted over CODE only: prose may name it as often as it needs to.
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const mentions = code.filter((l) => /\bsynthDispatch\b/.test(l));
    expect(mentions).toHaveLength(2); // the definition, and the scheduler it is handed to
    expect(mentions.some((l) => /^async function synthDispatch\(/.test(l))).toBe(true);
    expect(src).toContain("new SynthScheduler<Synthesized>(synthDispatch,");
  });
});

describe("prepared audio can only ever answer the sentence it was made from", () => {
  const src = readFileSync(resolve(__dirname, "../../src/lib/tts.ts"), "utf8");
  const calls = (re: RegExp) => (src.match(re) ?? []).length;

  it("is looked up by content, never by index", () => {
    // The lookup key is built from the sentence's own text; nothing indexes `prepared` by unit number.
    expect(src).toContain("const key = prepKey(sentences[i]);");
    expect(src).toContain("const ready = prepared.get(key);");
    expect(src).not.toMatch(/prepared\.get\(\s*(i|idx|unit)\s*\)/);
  });

  it("carries every input the produced bytes depend on: engine, voice, and the exact engine string", () => {
    expect(src).toMatch(/const prepKey = \(text: string\): string =>\s*`\$\{curEngine\}\|\$\{curVoice\}\|\$\{engineTextFor\(text\)\}`/);
    // and the request is built from the same three, so the key cannot describe a different call
    expect(src).toContain("rawSynth(curEngine, curVoice, engineTextFor(text), i, budgetMs, firstAudioMs)");
    expect(calls(/function engineTextFor\(/g)).toBe(1);
  });

  it("does not key on speed, because speed is applied at playback and not at synthesis", () => {
    // RAWY-264: the same bytes serve every speed. If synthesis ever took the speed, this assertion is the
    // one that fails — and the key would have to gain it before prepared audio could be reused again.
    expect(src).toMatch(/invoke<ArrayBuffer>\("tts_synthesize", \{ engine, id, text, budgetMs: budgetMs \?\? null, firstAudioMs: firstAudioMs \?\? null \}\)/);
    expect(src).not.toMatch(/prepKey[\s\S]{0,200}speed/);
  });

  it("is consumed on use, so it can never be served twice", () => {
    expect(src).toMatch(/const ready = prepared\.get\(key\);[\s\S]{0,120}prepared\.delete\(key\);/);
  });

  it("is swept when a new queue cannot use it, and dropped outright on stop or a voice change", () => {
    expect(src).toContain("sweepPrepared(units.slice(Math.min(startIndex, units.length - 1)))");
    expect(src).toMatch(/function sweepPrepared\(units: string\[\]\): void \{[\s\S]*?const wanted = new Set\(units\.slice\(0, PREPARE_UNITS \+ 1\)\.map\(prepKey\)\);/);
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
