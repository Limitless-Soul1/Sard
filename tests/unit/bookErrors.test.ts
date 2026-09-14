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
  uint8ToHex: true,
  promiseTry: true,
  promiseWithResolvers: true,
  mapGetOrInsertComputed: true,
};
const capable = () => __setRuntimeForTests(FULL);
afterEach(() => __setRuntimeForTests(null));

/** THE reported failure, verbatim from the tester's screen. */
const REPORTED = "UnknownErrorException: hashOriginal.toHex is not a function";

describe("the reported defect", () => {
  it("is recognised as a runtime problem — but NOT as an outdated engine", () => {
    // WHAT CHANGED, AND WHY. This message used to prove the engine was old, because nothing supplied
    // `toHex` and only a newer WebView2 carried it. The compatibility layer supplies it now — in the
    // page and inside the worker's own realm — so on a machine whose capabilities read as present,
    // seeing this proves the layer was NOT there when the engine reached for it. That is this
    // installation's problem. Blaming the reader's runtime for it is a guess, and one that sends
    // them to install an update that would not have helped.
    capable(); // a capable machine: the message alone must NOT convict the engine
    const c = classifyBookError(new Error(REPORTED), { format: "pdf" });
    expect(c.kind).toBe("runtime-incomplete");
    expect(c.presentation.fault).toBe("unknown");
    expect(en[c.presentation.bodyKey], "must not send a capable machine to update WebView2").not.toMatch(/WebView2/i);
  });

  it("offers retry first, and keeps the update available rather than demanding it", () => {
    // The original card's only offer was "Try again" for a failure retrying could never fix; the
    // correction then made the update compulsory. Neither is right here: a layer that failed to
    // load once may load, so retry leads — and the update stays reachable, because an engine old
    // enough to need the layer is worth updating even though nothing here proves it is.
    capable();
    const c = classifyBookError(new Error(REPORTED), { format: "pdf" });
    expect(c.presentation.actions[0]).toBe("retry");
    expect(c.presentation.actions).toContain("update-runtime");
    expect(c.presentation.actions).toContain("back");
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
    // `toHex` is one Sard supplies, so its absence says the layer is missing, not the engine's age.
    __setRuntimeForTests({ ...FULL, uint8ToHex: false });
    const c = classifyBookError(new Error("something else entirely"), { format: "pdf" });
    expect(c.kind).toBe("runtime-incomplete");
  });

  it("and a GENUINELY old engine is still called what it is", () => {
    // `Object.groupBy` and `Map.groupBy` are the whole EPUB capability and Sard supplies neither, so
    // their absence is a fact about the engine. This is the case the update message exists for, and
    // it must keep working exactly as it did.
    __setRuntimeForTests({ ...FULL, objectGroupBy: false, mapGroupBy: false });
    const c = classifyBookError(new Error("something else entirely"), { format: "epub" });
    expect(c.kind).toBe("runtime-outdated");
    expect(c.presentation.fault).toBe("environment");
    expect(c.presentation.actions[0]).toBe("update-runtime");
  });

  it("still lets EPUBs open on a runtime that only lacks the PDF features", () => {
    __setRuntimeForTests({ ...FULL, uint8ToHex: false, promiseTry: false, mapGetOrInsertComputed: false });
    const c = classifyBookError(new Error("Invalid or unsupported zip"), { format: "epub" });
    expect(c.kind).toBe("corrupt"); // classified on its merits, NOT forced to runtime-outdated
  });
});

describe("classification by user action", () => {
  const cases: [string, BookErrorKind][] = [
    // A built-in the layer supplies was absent where the engine used it. The engine's age is not
    // what that establishes — see "the reported defect" above.
    ["TypeError: hashOriginal.toHex is not a function", "runtime-incomplete"],
    ["TypeError: this.data.toBase64 is not a function", "runtime-incomplete"],
    ["TypeError: Uint8Array.fromBase64 is not a function", "runtime-incomplete"],
    ["TypeError: Object.groupBy is not a function", "runtime-incomplete"],
    ["TypeError: Map.groupBy is not a function", "runtime-incomplete"],
    // environment — NOT-FOUND, and only not-found, is allowed to mean the copy is gone.
    ["NotFoundError: File not found", "file-missing"],
    ["failed to read file (os error 2)", "file-missing"],
    ["ResponseError: 404 Not Found", "file-missing"],
    // REFUSED, NOT GONE. A 403 and a lock held by another program say the bytes could not be read;
    // neither says the file was deleted. Both used to land on "no longer on disk", beside a button
    // that drops the library row.
    ["ResponseError: 403 Forbidden", "file-access-denied"],
    ["Access is denied. (os error 5)", "file-access-denied"],
    ["The process cannot access the file because it is being used by another process. (os error 32)", "file-access-denied"],
    // The protocol serving the file broke. That is a fact about the protocol, not about the file.
    ["ResponseError: 500 Internal Server Error", "file-protocol-error"],
    ["ResponseError: 503 Service Unavailable", "file-protocol-error"],
    // book — damaged container (the bytes WERE read and are not a usable archive)
    ["Error: End of central directory not found", "corrupt"],
    ["InvalidPDFException: Invalid PDF structure", "corrupt"],
    // book — structurally broken but intact. Each of these is a statement about the FILE: the OPF
    // metadata element, the container, the rootfile.
    ["TypeError: Cannot read properties of undefined (reading 'children')", "book-malformed"],
    ["Error: no rootfile in container.xml", "book-malformed"],
    // NOT the book, or at least not provably. A section fails to load when its own markup is bad and
    // equally when a stylesheet, a resource or the renderer around it fails; a parser error can come
    // from either side. Reading them as proof blamed readers' files for failures that were not
    // theirs — and offered to delete the book on that evidence.
    ["Error: Failed to load section 3", "section-load-failed"],
    ["parsererror: mismatched tag", "section-load-failed"],
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
    expect(classifyBookError(e, { format: "pdf" }).kind).toBe("runtime-incomplete");
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
  it("an unrecognised failure is attributed to NOBODY — not the book, not the machine, not Sard", () => {
    // What is established at this point is only that the open threw and that no rule recognised
    // what it said. Which layer produced it has not been determined, so no layer is named. It used
    // to answer `sard` here, which is a guess — and one that both misdirects a bug report and can
    // talk a reader out of suspecting a genuinely broken file.
    capable();
    const c = classifyBookError(new Error("wibble flarp 42"), { format: "epub" });
    expect(c.kind).toBe("internal");
    expect(c.presentation.fault).toBe("unknown");
    expect(["book", "environment", "sard", "configuration"]).not.toContain(c.presentation.fault);
  });

  it("and says so in both languages, without naming a culprit", () => {
    // The copy is held to the same standard as the classification. A body that claims the fault is
    // Sard's — or that it is NOT the reader's book or machine — states what nothing established.
    const { titleKey, bodyKey } = __presentation.internal;
    // "not your book" / "not your computer" in either language, and "Sard" as the stated subject of
    // the failure rather than as one possibility among several.
    expect(en[bodyKey]).not.toMatch(/\bnot on your\b|\bis on Sard\b|\bSard'?s fault\b/i);
    expect(en[titleKey]).not.toMatch(/\bSard\b/);
    expect(ar[bodyKey]).not.toMatch(/لا من كتابك|لا من جهازك|الخطأ من/);
    expect(ar[titleKey]).not.toMatch(/سَرْد/);
    // It must still say the cause is unsettled rather than simply omitting the question.
    expect(ar[bodyKey], "the Arabic body must say the cause is not established").toMatch(/لم يتبيّن|غير معروف/);
    expect(en[bodyKey], "the English body must say the cause is not established").toMatch(/not clear|not known|unclear/i);
  });

  it("NO presentation declares anyone innocent, or promises a cure", () => {
    // MUTATION-DRIVEN. Two mutations that put the old wording back — «This is a problem with the
    // book, not with Sard» and «Nothing is wrong with the book or with Sard — updating WebView2 will
    // fix it» — passed the whole suite, because the only copy test looked at `internal`. The claims
    // are the defect, so every body is held to them, not one.
    //
    // What is forbidden is the SECOND claim and the blanket acquittal. Naming what actually failed
    // is not forbidden: "its internal structure isn't something Sard can render" is a statement
    // about the file, and the file is what the classification established.
    const ACQUITTALS_EN = [
      /not with Sard/i,
      /not on your/i,
      /is on Sard/i,
      /Sard'?s fault/i,
      /nothing is wrong with/i,
    ];
    const PROMISES_EN = [/will fix it/i, /will solve/i, /guaranteed/i];
    const ACQUITTALS_AR = [/لا من كتابك/, /لا من جهازك/, /لا في «سَرْد»/, /الخطأ من «سَرْد»/];
    const PROMISES_AR = [/يحلّ الأمر/, /سيحلّ/];

    for (const k of Object.keys(__presentation) as BookErrorKind[]) {
      const { bodyKey, titleKey } = __presentation[k];
      for (const re of ACQUITTALS_EN) {
        expect(en[bodyKey], `${k}: English body acquits someone (${re})`).not.toMatch(re);
      }
      for (const re of PROMISES_EN) {
        expect(en[bodyKey], `${k}: English body promises an outcome (${re})`).not.toMatch(re);
      }
      for (const re of ACQUITTALS_AR) {
        expect(ar[bodyKey], `${k}: Arabic body acquits someone (${re})`).not.toMatch(re);
      }
      for (const re of PROMISES_AR) {
        expect(ar[bodyKey], `${k}: Arabic body promises an outcome (${re})`).not.toMatch(re);
      }
      expect(en[titleKey], `${k}: the title is not the place for a verdict`).not.toMatch(/fault|blame/i);
    }
  });

  it("a refused or unreachable file is told, in words, that deletion is not implied", () => {
    // The counterpart of the classification fix: it is not enough that the copy stops saying the
    // file is gone — it has to say that it might not be, because the actions beside it are what the
    // reader will otherwise infer from.
    for (const k of ["file-access-denied", "file-protocol-error"] as const) {
      const { bodyKey } = __presentation[k];
      expect(en[bodyKey], `${k}: must not claim the file is gone`).not.toMatch(/no longer on disk/i);
      expect(en[bodyKey], `${k}: must say deletion is not implied`).toMatch(/does not mean it has been deleted/i);
      expect(ar[bodyKey], `${k}: must not claim the file is gone`).not.toMatch(/لم تعد .* موجودة على القرص/);
      expect(ar[bodyKey], `${k}: must say deletion is not implied`).toMatch(/لا يعني أنّه حُذف/);
    }
    // and the one kind that DID establish it keeps saying so
    expect(en[__presentation["file-missing"].bodyKey]).toMatch(/no longer on disk/i);
  });

  it("does not promise a reporting channel that does not exist", () => {
    // It offered «ما ترسله إلينا» — something to send us — while the details note beside it says
    // nothing is ever sent anywhere, and Sard has no reporting endpoint at all.
    expect(en[__presentation.internal.bodyKey]).not.toMatch(/send us|send it to us/i);
    expect(ar[__presentation.internal.bodyKey]).not.toMatch(/ترسله إلينا|إرساله إلينا/);
  });

  it("classifies on the REDACTED text, and the redaction costs it nothing", () => {
    // `describeError` replaces an absolute path with its shape before anything else sees the
    // string, so the classifier already works on the safe representation — which is what keeps a
    // reader's folder names out of both the Details pane and the rule matching.
    //
    // The risk in that arrangement runs the other way: a redaction greedy enough to swallow the
    // words a rule matches on would quietly turn every path-bearing failure into `internal`, and
    // the suite would stay green while the classifier stopped classifying. These are the real
    // messages with real paths in them; each must still land where it belongs AND carry no path.
    capable();
    const PATH = /(?:[A-Za-z]:[\\\/](?!\/)|\\\\[^\\]+\\|\/(?:home|Users|mnt)\/)/;
    const cases: [string, BookErrorKind][] = [
      ["The system cannot find the file specified. (os error 2): D:\\Books\\book.epub", "file-missing"],
      ["Access is denied. (os error 5): C:\\Users\\someone\\My Private Book.epub", "file-access-denied"],
      ["ResponseError: 500 Internal Server Error for C:\\Books\\x.epub", "file-protocol-error"],
      ["End of central directory not found in C:\\books\\x.epub", "corrupt"],
      ["Failed to load section 4 of /home/reader/Books/Another Title.epub", "section-load-failed"],
    ];
    for (const [message, expected] of cases) {
      const c = classifyBookError(new Error(message), { format: "epub" });
      expect(c.kind, `${message.slice(0, 44)}… must still classify`).toBe(expected);
      expect(c.raw, "and must carry no filesystem path").not.toMatch(PATH);
      expect(c.raw, "while keeping the shape that makes it a diagnostic").toMatch(/<path/);
    }
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
    expect(c.kind).toBe("runtime-incomplete"); // matched via the cause
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
    // The distinction the original card got wrong for every failure it showed. Each kind below can
    // succeed on a second attempt, and each one that is absent cannot:
    //   temporary            a lock or a busy database clears on its own
    //   internal             nothing is established, so nothing rules a second attempt out
    //   file-access-denied   the scanner finishes, the drive reconnects, the permission is granted
    //   file-protocol-error  the handler that failed may not fail again
    //   runtime-incomplete   a layer that failed to load once may load
    //   section-load-failed  a resource that failed once may arrive
    // A missing file, a damaged archive, an unrenderable structure and an engine that lacks a
    // built-in are all unchanged by trying again, and none of them offers it.
    const retryable = new Set<BookErrorKind>([
      "temporary", "internal", "file-access-denied", "file-protocol-error",
      "runtime-incomplete", "section-load-failed",
    ]);
    for (const k of kinds) {
      expect(__presentation[k].actions.includes("retry"), k).toBe(retryable.has(k));
    }
  });

  it("offers to DELETE the book only where the evidence supports it", () => {
    // THE DATA-LOSS PATH THIS CLOSES. «حذف من المكتبة» drops the library row. Offering it beside a
    // failure that has not established anything about the file is how a reader is invited to throw
    // away a book whose file is merely locked, refused, or behind a protocol that broke.
    const mayOfferRemoval = new Set<BookErrorKind>([
      "file-missing",        // not-found was actually reported about this path
      "corrupt",             // the bytes were read and are not a usable archive
      "book-malformed",      // the file's own structure is what failed
      "unsupported-format",  // it is not a format Sard renders, and never will be
    ]);
    for (const k of kinds) {
      expect(__presentation[k].actions.includes("remove-book"), k).toBe(mayOfferRemoval.has(k));
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
      expect(["book", "environment", "configuration", "sard", "unknown"]).toContain(__presentation[k].fault);
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
    // Only features Sard supplies are missing, so the refusal must not call the engine outdated.
    __setRuntimeForTests({ ...FULL, uint8ToHex: false, promiseTry: false, mapGetOrInsertComputed: false });
    const c = runtimeRefusal("pdf", { bookId: "b1" });
    expect(c.kind).toBe("runtime-incomplete");
    expect(c.context.stage).toBe("pre-flight");
    expect(c.raw).toContain("Uint8Array.prototype.toHex");
  });

  it("and calls the engine outdated when the gap is one Sard cannot fill", () => {
    __setRuntimeForTests({ ...FULL, objectGroupBy: false, mapGroupBy: false });
    const c = runtimeRefusal("epub", { bookId: "b1" });
    expect(c.kind).toBe("runtime-outdated");
    expect(c.raw).toContain("Object.groupBy");
  });
});

describe("the rule table", () => {
  it("documents why every rule exists", () => {
    for (const r of __rules) expect(r.note, `${r.kind} needs a note`).toBeTruthy();
  });

  it("orders rules so the runtime check precedes the generic ones", () => {
    // "…is not a function" would otherwise be swallowed by a broader pattern and become `internal`.
    expect(__rules[0].kind).toBe("runtime-incomplete");
  });

  it("puts the refusal and protocol rules AHEAD of not-found", () => {
    // ORDER IS THE FIX. `file-missing` still matches a bare 404, and a refusal or a 5xx must be
    // recognised before anything can read them as "this file is gone".
    const at = (k: string) => __rules.findIndex((r) => r.kind === k);
    expect(at("file-access-denied")).toBeGreaterThan(-1);
    expect(at("file-protocol-error")).toBeGreaterThan(-1);
    expect(at("file-access-denied")).toBeLessThan(at("file-missing"));
    expect(at("file-protocol-error")).toBeLessThan(at("file-missing"));
  });

  it("no longer sweeps every ResponseError into `file-missing`", () => {
    // The exact root cause: a bare `ResponseError` in the not-found pattern matched EVERY status.
    const missing = __rules.find((r) => r.kind === "file-missing");
    expect(missing, "the file-missing rule must still exist").toBeTruthy();
    expect(missing!.test.source, "a bare ResponseError alternative would match 403 and 500 again")
      .not.toMatch(/(^|\|)ResponseError(\||$)/);
  });

  it("puts the structural book rule ahead of the section rule, and keeps them apart", () => {
    const at = (k: string) => __rules.findIndex((r) => r.kind === k);
    expect(at("book-malformed")).toBeLessThan(at("section-load-failed"));
    const malformed = __rules.find((r) => r.kind === "book-malformed")!;
    expect(malformed.test.source, "a section-load failure must not prove a malformed book")
      .not.toMatch(/Failed to load section|parsererror/);
  });
});
