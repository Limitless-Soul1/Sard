// WHO MOVED THE CURSOR — the question both measurement instruments could not answer.
//
// THE DEFECT, and what it cost. A real listening session recorded six `advance` events 33 ms apart, no
// `skip` event, every unit `reachedReady`, and ~22.6 s of decoded audio apparently consumed without
// being heard. It looked exactly like a playback cascade discarding prepared audio, and it was
// investigated as one. It was not. 33 ms is the platform's KEY AUTO-REPEAT interval: the reader had
// held an arrow key, and each repeat skipped one sentence. Reproduced in the running application —
// six injected ArrowRight repeats over 277 ms moved the cursor six sentences and produced six
// `advance` events with no `skip`.
//
// The instruments could not see it, because both classified a cursor move by its SIZE:
//
//     if (delta === 1) -> "advance"      // a sentence finished and playback went on
//     else             -> "skip"         // the reader moved
//
// A single-step skip has a delta of one. So every one of them was recorded as a sentence listened
// through: `unitsAdvanced` was inflated, `meanUnitSeconds` (sounding time / advances) was diluted by
// sentences nobody heard, and a deliberate skip was indistinguishable from audio going missing.
//
// The store now STATES who moved the cursor — `cursorEpoch()` ticks only when the reader asks — so the
// classification is read, not guessed. This file pins that rule from both ends: the epoch must move
// for a reader's move and must NOT move for an automatic advance, and both recorders must consult it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", "src", p), "utf8");
const tts = src("lib/tts.ts");
const resilience = src("lib/ttsTelemetry.ts");
const outcomes = src("lib/listeningOutcomes.ts");

/** The body of a top-level function, from its signature to the first closing brace at column 0. */
const body = (source: string, signature: string): string => {
  const at = source.indexOf(signature);
  expect(at, signature + " should exist").toBeGreaterThan(-1);
  const rest = source.slice(at);
  const end = rest.indexOf("\n}");
  return rest.slice(0, end === -1 ? 4000 : end);
};

describe("the store says who moved the cursor", () => {
  it("exposes a counter, and it is not store state", () => {
    expect(tts).toContain("export function cursorEpoch(): number");
    // Store state would re-render every subscriber on a skip. This is module state, read at snapshot time.
    expect(tts).toMatch(/let userCursorEpoch = 0;/);
  });

  it("ticks inside skip(), before the write that moves the index", () => {
    const skip = tts.slice(tts.indexOf("  skip: (delta) => {"), tts.indexOf("  setSpeed: (s) => {"));
    expect(skip).toContain("userCursorEpoch++");
    // It must be stamped before BOTH branches that move the cursor: the ordinary landing and the
    // forward-off-the-end that enters chapter-end.
    expect(skip.indexOf("userCursorEpoch++")).toBeLessThan(skip.indexOf('landing.kind === "chapter-end"'));
    expect(skip.indexOf("userCursorEpoch++")).toBeLessThan(skip.indexOf("const target = landing.index"));
  });

  it("does NOT tick anywhere playback advances by itself", () => {
    // `playFrom` is the automatic path: a sentence ended and the next one begins. If it stamped the
    // epoch, every ordinary advance would be recorded as a skip — the same defect, mirrored.
    const playFrom = body(tts, "async function playFrom(");
    expect(playFrom).not.toContain("userCursorEpoch");
    // …and the whole module must touch it in exactly one place beyond its declaration and reader.
    expect(tts.match(/userCursorEpoch\+\+/g) ?? []).toHaveLength(1);
  });
});

describe("the resilience recorder classifies by cause, not by step size", () => {
  it("reads the epoch into its snapshot", () => {
    expect(resilience).toContain("userEpoch: cursorEpoch()");
    expect(resilience).toMatch(/import \{[^}]*cursorEpoch[^}]*\} from "\.\/tts";/);
  });

  it("counts a sentence as advanced only when the reader did NOT move the cursor", () => {
    expect(resilience).toContain("const byReader = s.userEpoch !== p.userEpoch");
    expect(resilience).toContain('if (!byReader && delta === 1) { cur.unitsAdvanced++; pushEvent("advance", s.index); }');
  });

  it("names a reader's single-step move a skip or a back — never an advance", () => {
    const rule = resilience.slice(resilience.indexOf("const byReader ="), resilience.indexOf("if (typeof st.bufferedSeconds"));
    expect(rule).toContain('byReader ? (delta > 0 ? "skip" : "back")');
    // The old size-only rule must not survive anywhere in that decision.
    expect(rule).not.toMatch(/if \(delta === 1\) \{ cur\.unitsAdvanced/);
  });
});

describe("the listening recorder follows the same rule", () => {
  it("reads the epoch and excludes a reader's move from unitsAdvanced", () => {
    expect(outcomes).toContain("userEpoch: cursorEpoch()");
    expect(outcomes).toContain("const byReader = s.userEpoch !== p.userEpoch");
    expect(outcomes).toContain("if (lastCursorDelta === 1 && !byReader) cur.unitsAdvanced++");
  });
});

describe("a held arrow key does not skip at the platform's repeat rate", () => {
  const arrow = body(tts, "export function skipSentenceForArrow(");

  it("takes the platform's own repeat flag rather than inferring one from timing", () => {
    expect(tts).toContain("export function skipSentenceForArrow(key: string, repeat = false): boolean");
    expect(arrow).toContain("if (repeat)");
  });

  it("paces repeats above the auto-repeat interval and below a human's fastest pressing", () => {
    const ms = Number(tts.match(/const ARROW_REPEAT_MIN_MS = (\d+);/)?.[1]);
    expect(ms).toBeGreaterThan(33);      // the platform's repeat interval, which is what ran away
    expect(ms).toBeLessThanOrEqual(200); // a deliberate press is never sustained this fast
  });

  it("a throttled repeat is CLAIMED, never handed back", () => {
    // Returning false would send the key on to `handleNavKey`, which turns the PAGE — so a reader
    // holding the arrow would skip sentences and page the book at the same time.
    expect(arrow).toContain("return true; // claimed, deliberately nothing");
  });

  it("a fresh press is never throttled", () => {
    const gate = arrow.slice(arrow.indexOf("const now = performance.now()"));
    expect(gate).toMatch(/if \(repeat\) \{[\s\S]*?\} else \{[\s\S]*?\}[\s\S]*?st\.skip\(/);
  });

  it("the platform flag reaches it through the one key owner", () => {
    const fc = src("reader-engine/FoliateController.ts");
    expect(fc).toContain("handleNavKey(key: string, repeat = false): boolean {");
    expect(fc).toContain("this.arrowCb?.(key, repeat)");
    expect(fc).toContain("this.handleNavKey(ev.key, ev.repeat)");
    expect(src("features/reader/Reader.tsx")).toContain("handleNavKey(e.key, e.repeat)");
    // The hosted transport keeps its own copy of the arrow branch; it must not drift from this one.
    expect(src("reader-transport/hosted.ts")).toContain("arrow?.(key, repeat)");
  });
});

describe("what was NOT changed, because it was not broken", () => {
  it("one ended event still advances exactly once", () => {
    const pf = body(tts, "async function playFrom(");
    expect(pf).toContain("let advanced = false;");
    expect(pf).toContain("if (advanced || myGen !== gen) return;");
    expect(pf).toContain("advanced = true;");
  });

  it("a stopped sentence still cannot advance the queue", () => {
    expect(tts).toContain("mediaEl.onended = null;");
  });

  it("the skip audio debounce is untouched — a hold still plays only the landing", () => {
    expect(tts).toContain("skipLastTarget = target;");
    expect(tts).toMatch(/SKIP_CONTINUE_MS/);
  });
});
