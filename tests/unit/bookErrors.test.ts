// RESILIENCE-1 / WP-1 — the book-error classifier.
//
// The contract these tests defend, in order of importance:
//   1. The REPORTED string classifies as a runtime problem and offers the update path — not "retry".
//   2. NOTHING unmapped is ever dressed up as a known cause (the `updater.ts` precedent).
//   3. No presentation is a dead end.
//   4. Raw engine text never appears in a title or body — only in `raw`, behind Details.

import { describe, it, expect, afterEach } from "vitest";
import { classifyBookError, runtimeRefusal, __presentation, __rules, type BookErrorKind } from "../../src/lib/bookErrors";
import { __setRuntimeForTests, type RuntimeEnv } from "../../src/lib/runtime";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const FULL: RuntimeEnv = {
  objectGroupBy: true,
  mapGroupBy: true,
  promiseTry: true,
  uint8ToHex: true,
  mapGetOrInsertComputed: true,
};
const capable = () => __setRuntimeForTests(FULL);
afterEach(() => __setRuntimeForTests(null));

/** THE reported failure, verbatim from the tester's screen. */
const REPORTED = "UnknownErrorException: hashOriginal.toHex is not a function";

describe("the reported defect", () => {
  it("classifies as a runtime problem, blamed on the environment", () => {
    capable(); // even on a capable machine, the MESSAGE alone must be recognised
    const c = classifyBookError(new Error(REPORTED), { format: "pdf" });
    expect(c.kind).toBe("runtime-outdated");
    expect(c.presentation.fault).toBe("environment");
  });

  it("offers updating the runtime FIRST and never offers a bare retry", () => {
    // The original card's only offer was "Try again" — for a failure retrying could never fix.
    capable();
    const c = classifyBookError(new Error(REPORTED), { format: "pdf" });
    expect(c.presentation.actions[0]).toBe("update-runtime");
    expect(c.presentation.actions).not.toContain("retry");
  });

  it("keeps the raw text for Details and keeps it OUT of the message", () => {
    capable();
    const c = classifyBookError(new Error(REPORTED), { format: "pdf" });
    expect(c.raw).toContain("hashOriginal.toHex");
    expect(en[c.presentation.titleKey]).not.toMatch(/toHex|Exception|undefined/);
    expect(en[c.presentation.bodyKey]).not.toMatch(/toHex|Exception|undefined/);
  });

  it("is caught by the PRE-FLIGHT before the engine is even asked", () => {
    // The robust path: the capability decides, so this stays correct if PDF.js changes its wording.
    __setRuntimeForTests({ ...FULL, uint8ToHex: false });
    const c = classifyBookError(new Error("something else entirely"), { format: "pdf" });
    expect(c.kind).toBe("runtime-outdated");
  });

  it("still lets EPUBs open on a runtime that only lacks the PDF features", () => {
    __setRuntimeForTests({ ...FULL, promiseTry: false, uint8ToHex: false, mapGetOrInsertComputed: false });
    const c = classifyBookError(new Error("Invalid or unsupported zip"), { format: "epub" });
    expect(c.kind).toBe("corrupt"); // classified on its merits, NOT forced to runtime-outdated
  });
});

describe("classification by user action", () => {
  const cases: [string, BookErrorKind][] = [
    // runtime — every vendored-engine feature gap converges here: one message, one action.
    ["TypeError: hashOriginal.toHex is not a function", "runtime-outdated"],
    ["TypeError: this.data.toBase64 is not a function", "runtime-outdated"],
    ["TypeError: Uint8Array.fromBase64 is not a function", "runtime-outdated"],
    ["TypeError: Object.groupBy is not a function", "runtime-outdated"],
    ["TypeError: Map.groupBy is not a function", "runtime-outdated"],
    // environment — the file is gone or unreachable
    ["NotFoundError: File not found", "file-missing"],
    ["failed to read file (os error 2)", "file-missing"],
    // A failed fetch of Sard's OWN managed copy: the bytes were never read, so this is an access
    // problem, not a damaged archive. Calling it "damaged" would be a confident lie about the file.
    ["ResponseError: 404 Not Found", "file-missing"],
    ["ResponseError: 500 Internal Server Error", "file-missing"],
    // book — damaged container (the bytes WERE read and are not a usable archive)
    ["Error: End of central directory not found", "corrupt"],
    ["InvalidPDFException: Invalid PDF structure", "corrupt"],
    // book — structurally broken but intact
    ["TypeError: Cannot read properties of undefined (reading 'children')", "book-malformed"],
    ["Error: Failed to load section 3", "book-malformed"],
    ["parsererror: Invalid XHTML", "book-malformed"],
    // book — not a format we render
    ["UnsupportedTypeError: ", "unsupported-format"],
    // environment — momentary
    ["SqliteFailure: database is locked", "temporary"],
  ];

  for (const [raw, expected] of cases) {
    it(`"${raw.slice(0, 46)}…" → ${expected}`, () => {
      capable();
      expect(classifyBookError(new Error(raw), { format: "epub" }).kind).toBe(expected);
    });
  }

  it("classifies foliate's REAL error classes, built the way the engine builds them", () => {
    // view.js:66-68 declares `class NotFoundError extends Error {}` — no `name` assignment — and
    // throws them at :74/:87/:121 with these exact messages. A classifier that only read `e.name`
    // saw "Error" and filed all three as `internal`.
    capable();
    class ResponseError extends Error {}
    class NotFoundError extends Error {}
    class UnsupportedTypeError extends Error {}
    expect(classifyBookError(new NotFoundError("File not found"), { format: "epub" }).kind).toBe("file-missing");
    expect(classifyBookError(new ResponseError("404 Not Found"), { format: "epub" }).kind).toBe("file-missing");
    expect(classifyBookError(new UnsupportedTypeError("File type not supported"), { format: "epub" }).kind).toBe(
      "unsupported-format",
    );
  });

  it("classifies the real PDF.js exception shape", () => {
    // PDF.js's BaseException sets `this.name`, which is where "UnknownErrorException:" came from.
    capable();
    const e = new Error("hashOriginal.toHex is not a function");
    e.name = "UnknownErrorException";
    expect(classifyBookError(e, { format: "pdf" }).kind).toBe("runtime-outdated");
  });

  it("converges the two 'nothing you can do to this file' kinds onto ONE experience", () => {
    // Principle 5: distinct internally (diagnostics), identical externally (same decision).
    const a = __presentation["book-malformed"];
    const b = __presentation["unsupported-format"];
    expect(a.titleKey).toBe(b.titleKey);
    expect(a.bodyKey).toBe(b.bodyKey);
    expect(a.actions).toEqual(b.actions);
    expect(a.fault).toBe(b.fault);
  });
});

describe("honesty about the unknown", () => {
  it("an unrecognised failure is Sard's fault, not the book's", () => {
    capable();
    const c = classifyBookError(new Error("wibble flarp 42"), { format: "epub" });
    expect(c.kind).toBe("internal");
    expect(c.presentation.fault).toBe("sard");
  });

  it("never throws, whatever it is handed", () => {
    capable();
    for (const junk of [null, undefined, 0, "", "boom", { a: 1 }, [1, 2], new Error(), Symbol("x")]) {
      expect(() => classifyBookError(junk, { format: "epub" })).not.toThrow();
    }
  });

  it("follows a `cause` chain into the raw text", () => {
    capable();
    const c = classifyBookError(new Error("outer", { cause: new Error(REPORTED) }), { format: "pdf" });
    expect(c.raw).toContain("hashOriginal.toHex");
    expect(c.kind).toBe("runtime-outdated"); // matched via the cause
  });
});

describe("no dead ends, and nothing leaks", () => {
  const kinds = Object.keys(__presentation) as BookErrorKind[];

  it("every presentation offers at least one real action besides Details", () => {
    for (const k of kinds) {
      const real = __presentation[k].actions.filter((a) => a !== "details");
      expect(real.length, `${k} is a dead end`).toBeGreaterThan(0);
    }
  });

  it("every presentation lets the user leave", () => {
    for (const k of kinds) expect(__presentation[k].actions, k).toContain("back");
  });

  it("EVERY presentation offers Details — the escape hatch is never conditional", () => {
    // Found in the live end-to-end test: `file-missing` and `temporary` had no Details button, so
    // exactly the two failures a user is most likely to report offered no way to see or copy the
    // diagnostics. Details is quiet and costs nothing; making it universal removes a distinction
    // that served nobody.
    for (const k of kinds) expect(__presentation[k].actions, k).toContain("details");
  });

  it("puts the recovery action first and Details last", () => {
    for (const k of kinds) {
      const a = __presentation[k].actions;
      expect(a[0], `${k} must lead with a real action`).not.toBe("details");
      expect(a[a.length - 1], `${k} must end with Details`).toBe("details");
    }
  });

  it("offers `retry` ONLY where trying again can actually work", () => {
    // The distinction the original card got wrong for every failure it showed.
    for (const k of kinds) {
      const retryable = k === "temporary" || k === "internal";
      expect(__presentation[k].actions.includes("retry"), k).toBe(retryable);
    }
  });

  it("every message exists in BOTH locales and neither leaks implementation detail", () => {
    const forbidden = /TypeError|Exception|undefined|null|stack|epub\.js|pdf\.worker|foliate|WebView2 runtime lacks/;
    for (const k of kinds) {
      const { titleKey, bodyKey } = __presentation[k];
      for (const key of [titleKey, bodyKey] as const) {
        expect(en[key], `${key} missing from en`).toBeTruthy();
        expect(ar[key], `${key} missing from ar`).toBeTruthy();
        expect(en[key], `${key} leaks internals`).not.toMatch(forbidden);
        expect(ar[key], `${key} leaks internals`).not.toMatch(forbidden);
      }
    }
  });

  it("states WHOSE fault it is for every kind", () => {
    for (const k of kinds) {
      expect(["book", "environment", "configuration", "sard"]).toContain(__presentation[k].fault);
    }
  });
});

describe("diagnostics context", () => {
  it("records the book, the format, the stage and the machine's missing features", () => {
    __setRuntimeForTests({ ...FULL, uint8ToHex: false });
    const c = classifyBookError(new Error("x"), { bookId: "abc", format: "pdf", stage: "open" });
    expect(c.context.bookId).toBe("abc");
    expect(c.context.format).toBe("pdf");
    expect(c.context.stage).toBe("open");
    expect(c.context.missingForFormat).toContain("toHex");
  });

  it("runtimeRefusal explains itself without an exception to quote", () => {
    __setRuntimeForTests({ ...FULL, promiseTry: false, uint8ToHex: false, mapGetOrInsertComputed: false });
    const c = runtimeRefusal("pdf", { bookId: "b1" });
    expect(c.kind).toBe("runtime-outdated");
    expect(c.context.stage).toBe("pre-flight");
    expect(c.raw).toContain("Uint8Array.prototype.toHex");
  });
});

describe("the rule table", () => {
  it("documents why every rule exists", () => {
    for (const r of __rules) expect(r.note, `${r.kind} needs a note`).toBeTruthy();
  });

  it("orders rules so the runtime check precedes the generic ones", () => {
    // "…is not a function" would otherwise be swallowed by a broader pattern and become `internal`.
    expect(__rules[0].kind).toBe("runtime-outdated");
  });
});
