// The engine's surface, and whether every part of it can cross the reader-host boundary.
//
// WHAT THIS CAN AND CANNOT PROVE. It reads `FoliateController.ts` as a FILE, the same way
// `ttsUnitStructure.test.ts` does, because the question is a property of the source and needs no
// browser: does every public member of the engine have a recorded answer for "how does this cross?"
// It cannot prove any of those answers is correct — the runtime gate on WebKitGTK does that. What it
// prevents is the failure that has no other detector: someone adds a method to the engine, the
// hosted transport forwards it blindly because nothing said not to, and the first person to find out
// is a reader on Linux whose selection silently stopped working.
//
// It runs on every platform on purpose. The classification is about the engine, not about the host,
// and Windows is where the engine is edited most.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CROSSING } from "../../src/reader-transport/surface";

const SRC = join(import.meta.dirname, "..", "..", "src", "reader-engine", "FoliateController.ts");

/**
 * Public method names declared on the class.
 *
 * Matched at exactly two levels of indentation, which is what a class member has in this file, and
 * deliberately not with a TypeScript parser: the suite runs on Node with no build step, and a regex
 * that over-matches would be caught immediately by the assertions below rather than passing quietly.
 */
function publicMethods(source: string): string[] {
  const names = new Set<string>();
  // The line must END in `{`. Without that the pattern also matched plain CALL statements sitting at
  // the same indentation inside module-level functions — `walk(raw, level);` and
  // `collectLeadingBlocks(body, MAX, blocks);` were both reported as unclassified engine members.
  // A declaration opens a body on the same line here; a call ends in a semicolon.
  // A declaration is a name at member indentation followed by `(`, on a line that does NOT end in a
  // semicolon. Two earlier attempts were both wrong in ways that hid real members:
  //
  //   • forbidding semicolons anywhere lost four members whose signature contains an inline object
  //     type — `getChapterUnits(...): Promise<{ text: string; range: Range | null }[]>`;
  //   • requiring the line to END in `{` lost every MULTI-LINE signature, and `searchBook` is one.
  //     That is the worst kind of miss: the member was invisible, so no classification check could
  //     ever fire on it, and it went to the hosted transport carrying two callbacks and an
  //     AbortSignal that a MessagePort cannot clone.
  //
  // Ending in `;` is what a call statement does (`walk(raw, level);`), and a declaration never does.
  const re = /^ {2}(?:async\s+)?([a-zA-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\((?!.*\);\s*$).*$/gm;
  for (const m of source.matchAll(re)) {
    const name = m[1];
    // Control-flow keywords indent the same way a member does; they are not members.
    if (["if", "for", "while", "switch", "catch", "return", "constructor"].includes(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * A member's full signature: from its name to the brace that opens its body.
 *
 * Scanned with balanced parentheses rather than matched with a regex, because three regex attempts
 * each truncated it somewhere that mattered — at the first `)`, which falls inside
 * `(frac: number) => void`; at the first `{`, which falls inside `opts: { … }`; and a fixed-size
 * window, which over-read into the body and made every void method look suspicious. Each of those
 * hid or invented a problem. Counting brackets is the only version that describes the signature.
 */
function signatureOf(source: string, name: string): string {
  const at = source.search(new RegExp(`^ {2}(?:async\\s+)?${name}\\s*(?:<[^>]*>)?\\(`, "m"));
  if (at < 0) return "";
  const open = source.indexOf("(", at);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) break;
  }
  const brace = source.indexOf("{", i);
  return source.slice(at, brace < 0 ? i + 1 : brace + 1);
}

describe("reader engine surface", () => {
  const source = readFileSync(SRC, "utf8");
  const methods = publicMethods(source);

  it("finds the engine's methods at all", () => {
    // A guard on the guard. If the regex stops matching — the file is reformatted, the class is
    // wrapped — every assertion below would pass vacuously against an empty list.
    expect(methods.length).toBeGreaterThan(50);
    for (const anchor of ["open", "handleNavKey", "getToc", "onSelection", "ttsUnitIndexForRange"]) {
      expect(methods).toContain(anchor);
    }
  });

  it("classifies every member that cannot simply be forwarded", () => {
    // The direction that matters. Anything the engine declares and the map does not mention is
    // treated as plain async forwarding — fine for most methods, wrong and silent for a method that
    // returns synchronously, takes a DOM object, or registers a callback.
    //
    // A new member is not a failure by itself. It fails only if its SHAPE says it cannot be
    // forwarded: a non-promise return, a DOM type, or a callback parameter.
    const unclassified = methods.filter((name) => !(name in CROSSING));
    const suspicious = unclassified.filter((name) => {
      const sig = signatureOf(source, name);
      const returnsPromise = /:\s*Promise</.test(sig);
      const isAsync = /^\s{2}async\s/.test(sig);
      // `sig` now ends at the opening brace, so the void test has to allow for it. Without this the
      // guard flagged every plain `foo(): void {` member in the class.
      const returnsVoid = /:\s*void\s*\{?\s*$/.test(sig.trim());
      // A callback is not always named `cb`. `searchBook(query, { signal, onProgress, onBatch })`
      // hides two functions and an AbortSignal inside an options object, and matching only `cb:`
      // declared it plainly forwardable — it would have thrown DataCloneError the first time search
      // ran on the hosted path. Any function TYPE in the signature counts, however it is spelled,
      // and so does an AbortSignal, which is just as uncloneable and just as easy to miss.
      const takesCallback = /\bcb\s*:/.test(sig) || /=>/.test(sig) || /\bAbortSignal\b/.test(sig);
      const touchesDom = /\b(Range|HTMLElement|Document|Node|Element|Selection)\b/.test(sig);
      return takesCallback || touchesDom || !(returnsPromise || isAsync || returnsVoid);
    });

    expect(
      suspicious,
      "these engine members cannot be forwarded verbatim over a MessagePort and are not in " +
        "src/reader-transport/surface.ts — classify each one before the hosted transport ships it",
    ).toEqual([]);
  });

  it("does not classify members the engine no longer has", () => {
    // The opposite drift: a rename leaves an entry describing a method that is gone, and the map
    // starts documenting history instead of the code.
    const stale = Object.keys(CROSSING).filter((name) => !methods.includes(name));
    expect(stale, "these entries name members FoliateController no longer declares").toEqual([]);
  });
});
