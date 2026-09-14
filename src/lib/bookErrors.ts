// RESILIENCE-1 / WP-1 — classifying a book-opening failure.
//
// Layered on the generic core in `errors.ts`. Every failure to open a book — EPUB or PDF, from the
// reader or from a cross-book follow — passes through `classifyBookError`, so there is exactly ONE
// place where "what went wrong" becomes "what the user is told".
//
// WHAT REPLACED WHAT. `Reader.tsx` used to do `set({ status: "error", error: String(e) })` and print
// that string verbatim in the error card. That is how a tester saw
// `UnknownErrorException: hashOriginal.toHex is not a function` — a PDF.js internal, in a dialog
// whose only offer was "Try again", for a failure that retrying can never fix.

import {
  matchRule,
  describeError,
  type Classified,
  type Presentation,
  type Rule,
} from "./errors";
import { canRender, currentEnv, engineIsBehind, missingFeatures } from "./runtime";

/**
 * The internal kinds. These exist for DIAGNOSTICS and for rule-matching; several of them share one
 * presentation on purpose (see `PRESENTATION`) because they need the same thing from the user.
 */
export type BookErrorKind =
  /**
   * The ENGINE is behind: something the vendored code needs is missing AND is not something Sard
   * supplies for it. This is the only condition under which "update WebView2" is a fact.
   */
  | "runtime-outdated"
  /**
   * A capability is missing that the compatibility layer was supposed to install, so the layer did
   * not reach the realm that needed it. The engine's age is NOT what this establishes.
   */
  | "runtime-incomplete"
  /** The managed copy is gone: the OS or the protocol said not-found about this exact path. */
  | "file-missing"
  /**
   * The file was REFUSED, not missing. A permission denial, a lock held by another program, a
   * drive that will not answer — the bytes were never read, and nothing says the file is gone.
   */
  | "file-access-denied"
  /**
   * The protocol that serves the file failed on its own account — a 5xx from the asset handler. It
   * says nothing whatever about the file: it says the thing fetching it broke.
   */
  | "file-protocol-error"
  /** The archive is damaged / truncated / not readable as a container. */
  | "corrupt"
  /** Readable as a file, and its own structure is provably not a book Sard can build. */
  | "book-malformed"
  /**
   * ONE PART of the book would not display. That is not the same as a broken book: a section fails
   * to load when its own markup is bad, and equally when a stylesheet, a resource or the renderer
   * around it fails. Which of those happened is not established.
   */
  | "section-load-failed"
  /** Not a format Sard renders. */
  | "unsupported-format"
  /** A momentary condition; trying again is genuinely reasonable. */
  | "temporary"
  /**
   * Unmapped — the failure matched no rule, so nothing about its origin has been established.
   *
   * The name is historical and stays because it is written into diagnostics rows already saved. Its
   * `fault` is `unknown`, not `sard`: see the presentation below.
   */
  | "internal";

/**
 * The presentations. Note there are SIX kinds above and FIVE presentations below: `book-malformed`
 * and `unsupported-format` deliberately share one.
 *
 * WHY THEY SHARE. Both mean "this file is not going to open, and re-importing the same file will
 * not change that", so both leave the user with the same decision — remove it, or go back. Telling
 * one user "the structure is malformed" and another "the format is unsupported" would be a
 * distinction that changes nothing they can do. The kinds stay separate in the diagnostics, which
 * is where the distinction is actually useful.
 */
const PRESENTATION: Record<BookErrorKind, Presentation> = {
  "runtime-outdated": {
    fault: "environment",
    titleKey: "err.runtime.title",
    bodyKey: "err.runtime.body",
    actions: ["update-runtime", "back", "details"],
  },
  /**
   * WHAT IS ESTABLISHED: the OS or the asset protocol answered not-found for this exact path. The
   * managed copy really is gone, so offering to re-import it or to drop the row is the right pair of
   * doors — that is what those two actions are FOR, and they stay.
   */
  "file-missing": {
    fault: "environment",
    titleKey: "err.missing.title",
    bodyKey: "err.missing.body",
    actions: ["reimport", "remove-book", "back", "details"],
  },
  /**
   * REFUSED OR UNREACHABLE — and deliberately NOT offered «حذف من المكتبة».
   *
   * This is the defect that made the distinction necessary. A 403, a lock held by another program
   * and a 5xx from the protocol handler were all classified as "file-missing", so a reader whose
   * book was merely locked by a virus scanner was told it was gone from disk and handed a delete
   * button. The action is not removed because it is inconvenient; it is removed because for THIS
   * classification the premise it rests on has not been established, and pressing it would throw
   * away the library row for a file that is still there. `retry` replaces it, which is the action
   * that can actually succeed once the lock clears.
   *
   * `file-protocol-error` shares the wording — the reader's decision is identical — while keeping
   * its own `fault`, because a refusal is the machine's doing and a 5xx is nobody's until someone
   * looks.
   */
  "file-access-denied": {
    fault: "environment",
    titleKey: "err.unreachable.title",
    bodyKey: "err.unreachable.body",
    actions: ["retry", "back", "details"],
  },
  "file-protocol-error": {
    fault: "unknown",
    titleKey: "err.unreachable.title",
    bodyKey: "err.unreachable.body",
    actions: ["retry", "back", "details"],
  },
  corrupt: {
    fault: "book",
    titleKey: "err.damaged.title",
    bodyKey: "err.damaged.body",
    actions: ["reimport", "remove-book", "back", "details"],
  },
  // ↓ these two share a presentation ↓
  "book-malformed": {
    fault: "book",
    titleKey: "err.unreadable.title",
    bodyKey: "err.unreadable.body",
    actions: ["remove-book", "back", "details"],
  },
  "unsupported-format": {
    fault: "book",
    titleKey: "err.unreadable.title",
    bodyKey: "err.unreadable.body",
    actions: ["remove-book", "back", "details"],
  },
  /**
   * The layer did not reach the realm that needed it. `update-runtime` is kept — an engine old
   * enough to need the layer is worth updating anyway, and the page behind that button is
   * instructions, not a claim — but it is no longer the FIRST action and the copy no longer says
   * the update will fix anything. `retry` leads, because a layer that failed to load once may load.
   */
  "runtime-incomplete": {
    fault: "unknown",
    titleKey: "err.incomplete.title",
    bodyKey: "err.incomplete.body",
    actions: ["retry", "update-runtime", "back", "details"],
  },
  /**
   * A section would not display. Retry first: a resource that failed once may load. No blame is
   * assigned, and `remove-book` is not offered — nothing here says the book is at fault.
   */
  "section-load-failed": {
    fault: "unknown",
    titleKey: "err.section.title",
    bodyKey: "err.section.body",
    actions: ["retry", "back", "details"],
  },
  temporary: {
    fault: "environment",
    titleKey: "err.temporary.title",
    bodyKey: "err.temporary.body",
    actions: ["retry", "back", "details"],
  },
  /**
   * WHAT IS ACTUALLY KNOWN HERE, AND WHAT IS NOT.
   *
   * Known: opening this book was attempted and threw; the capability pre-flight had said this
   * format is renderable; and the exception matched none of the rules above.
   *
   * Not known: anything about WHERE it came from. An unrecognised message can be a Sard defect, but
   * it can equally be a book broken in a way no rule names, a WebView2 or engine failure phrased
   * differently than the rules expect, a filesystem or permission refusal, an installation that is
   * not intact, or something no one has seen yet. The rules recognise specific signatures; they do
   * not exhaust the failures the world can produce.
   *
   * So the fault is `unknown` and the copy says so. It read «الخطأ من سَرْد، لا من كتابك ولا من
   * جهازك» — three claims, in the one case where the classifier has established none of them, and
   * the middle one could talk a reader out of suspecting a genuinely broken file.
   */
  internal: {
    fault: "unknown",
    titleKey: "err.internal.title",
    bodyKey: "err.internal.body",
    actions: ["retry", "back", "details"],
  },
};

/**
 * Ordered, most specific first. Every pattern is anchored on a string a REAL failure produces —
 * quoted from the engine source, not imagined.
 */
const RULES: readonly Rule<BookErrorKind>[] = [
  {
    // WHY THIS IS NO LONGER `runtime-outdated`. The rule predates the compatibility layer, and the
    // layer changed what this message means. PDF.js's "<built-in> is not a function" once proved the
    // engine was old; now Sard installs every one of those built-ins, in the page and in the worker
    // realm, so seeing this means the layer was NOT there when the engine reached for it. That is
    // this installation's problem, not the reader's WebView2 — and the old copy denied exactly the
    // cause while promising an update that would not have helped.
    kind: "runtime-incomplete",
    test: /(?:toHex|toBase64|fromBase64|groupBy|withResolvers|fromAsync)\b[\s\S]{0,40}?is not a (?:function|constructor)/i,
    note: "a built-in the compatibility layer supplies was absent where the engine used it",
  },
  {
    // REFUSED, NOT MISSING — and this rule sits above `file-missing` so it wins.
    // 403 is a refusal; `os error 5` is Windows' access-denied; `os error 32` is the file held open
    // by another process, which on Windows is usually a virus scanner mid-scan. In every one of them
    // the file may be perfectly present.
    kind: "file-access-denied",
    test: /\b403\b|Forbidden|EACCES|EPERM|permission denied|access is denied|being used by another process|os error 5\b|os error 32\b/i,
    note: "the file was refused, not found to be absent — nothing here says it was deleted",
  },
  {
    // The asset protocol failed on its own account. It says nothing about the file at all.
    kind: "file-protocol-error",
    test: /ResponseError:\s*5\d\d\b|\b5(?:00|02|03|04)\b\s*(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)|Internal Server Error|Bad Gateway|Service Unavailable/i,
    note: "the protocol serving the file failed — the file itself was never reached",
  },
  {
    // NOT-FOUND, AND ONLY NOT-FOUND. `ResponseError` used to appear here bare, which swept every
    // status — 403 and 500 included — into "this file is no longer on disk", beside a button that
    // deletes the library row. Only the statuses and the OS errors that actually mean "not there"
    // remain: foliate's `NotFoundError` (view.js:87, thrown for a zero-size file), the OS's own
    // not-found, and a 404 from the asset protocol.
    kind: "file-missing",
    test: /NotFoundError|File not found|no such file|os error 2\b|cannot find the (?:file|path)|ResponseError:\s*404\b|\b404\b/i,
    note: "the managed copy is gone — not-found is what was actually reported",
  },
  {
    kind: "unsupported-format",
    test: /UnsupportedTypeError|not a supported|unsupported (?:file )?type/i,
    note: "foliate's makeBook fell through every format branch (view.js:68)",
  },
  {
    kind: "corrupt",
    // zip.js / PDF.js container failures — the bytes WERE read and are not a usable archive.
    test: /InvalidPDFException|Invalid PDF|end of central directory|central directory|invalid or unsupported zip|zip|unexpected end of|corrupt|truncat/i,
    note: "the container itself is damaged — re-importing a fresh copy is the meaningful action",
  },
  {
    // WHAT ACTUALLY PROVES THE BOOK IS AT FAULT. epub.js:178 `Object.groupBy($metadata.children, …)`
    // throws exactly this when the OPF has no <metadata> element or it is namespace-mismatched; the
    // container and rootfile names come from the archive's own structure. Each of these is a
    // statement about the file, so the copy may be a statement about the file.
    kind: "book-malformed",
    test: /reading 'children'|Invalid XHTML|rootfile|container\.xml|opf/i,
    note: "the book's own structure is what failed — re-importing the same bytes cannot help",
  },
  {
    // WHAT DOES NOT PROVE IT. "Failed to load section" (paginator.js:1038) and a `parsererror` are
    // produced when a section's markup is bad — and equally when a stylesheet, an image, a font or
    // the renderer around it fails, or a content rule refuses a resource. Reading them as proof of a
    // broken book told readers their file was at fault for failures that were not theirs, and the
    // book is not offered for removal on that evidence.
    kind: "section-load-failed",
    test: /Failed to load section|parsererror/i,
    note: "a section would not display — its cause is not established by this message alone",
  },
  {
    kind: "temporary",
    // Deliberately narrow: only conditions where trying again is genuinely reasonable.
    test: /database is locked|database is busy|SQLITE_BUSY|ECONNRESET|temporarily unavailable/i,
    note: "a momentary condition — retry is honest here, and only here",
  },
];

export interface BookErrorContext {
  bookId?: string | null;
  format?: string | null;
  /** Where the failure came from, so diagnostics can tell an open from a pre-flight refusal. */
  stage?: string;
}

/**
 * Classify a book-opening failure. `e` may be anything at all — this never throws.
 *
 * The PRE-FLIGHT case is first and deliberately does not look at `e`: if the runtime cannot render
 * this format, that is the answer regardless of what the engine eventually said. It is also what
 * makes the runtime path robust when a future engine changes its message — the message rule above
 * is the backstop, not the mechanism.
 */
export function classifyBookError(e: unknown, ctx: BookErrorContext = {}): Classified<BookErrorKind> {
  const raw = describeError(e);
  const format = (ctx.format ?? "").toLowerCase();

  const env = currentEnv();

  let kind: BookErrorKind;
  if ((format === "pdf" && !canRender("pdf")) || !canRender("epub")) {
    // WHICH capability failed decides WHAT was established. The EPUB set is `Object.groupBy` and
    // `Map.groupBy`, neither of which Sard supplies — missing means the engine is genuinely behind.
    // Every feature in the PDF set is one the compatibility layer installs, so missing there means
    // the layer was not present, and calling that an outdated runtime would be a guess pointed at
    // the reader's machine.
    const failing: "epub" | "pdf" = format === "pdf" && !canRender("pdf") ? "pdf" : "epub";
    kind = engineIsBehind(env, failing) ? "runtime-outdated" : "runtime-incomplete";
  } else {
    kind = matchRule(raw, RULES, "internal");
  }

  return {
    kind,
    presentation: PRESENTATION[kind],
    raw,
    context: {
      bookId: ctx.bookId ?? null,
      format: ctx.format ?? null,
      stage: ctx.stage ?? "open",
      // Recorded on EVERY book failure, not just runtime ones: "which features did this machine
      // have when it broke" is the first question a compatibility report needs answered, and it is
      // free to capture.
      missingForFormat:
        format === "pdf" ? missingFeatures(env, "pdf").join(",") || "none" : missingFeatures(env, "epub").join(",") || "none",
    },
  };
}

/** A pre-flight refusal: this runtime cannot render this format, before anything is attempted. */
export function runtimeRefusal(format: string, ctx: BookErrorContext = {}): Classified<BookErrorKind> {
  const cap = format.toLowerCase() === "pdf" ? "pdf" : "epub";
  const env = currentEnv();
  const missing = missingFeatures(env, cap);
  // The same distinction the open path makes: only a gap Sard does not fill says the engine is old.
  const kind: BookErrorKind = engineIsBehind(env, cap) ? "runtime-outdated" : "runtime-incomplete";
  return {
    kind,
    presentation: PRESENTATION[kind],
    raw: `pre-flight: this WebView2 runtime lacks ${missing.join(", ") || "(unknown)"} — required to render ${cap.toUpperCase()}`,
    context: {
      bookId: ctx.bookId ?? null,
      format,
      stage: "pre-flight",
      missingForFormat: missing.join(",") || "none",
    },
  };
}

/** Exposed for tests: the rule table is the contract, so the tests read it rather than re-listing it. */
export const __rules = RULES;
export const __presentation = PRESENTATION;
