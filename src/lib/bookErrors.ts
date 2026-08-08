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
import { canRender, currentEnv, missingFeatures } from "./runtime";

/**
 * The internal kinds. These exist for DIAGNOSTICS and for rule-matching; several of them share one
 * presentation on purpose (see `PRESENTATION`) because they need the same thing from the user.
 */
export type BookErrorKind =
  /** The vendored engine needs browser features this WebView2 runtime does not have. */
  | "runtime-outdated"
  /** The managed copy is gone from app data. */
  | "file-missing"
  /** The archive is damaged / truncated / not readable as a container. */
  | "corrupt"
  /** Readable as a file, but its internal structure is broken beyond recovery. */
  | "book-malformed"
  /** Not a format Sard renders. */
  | "unsupported-format"
  /** A momentary condition; trying again is genuinely reasonable. */
  | "temporary"
  /** Unmapped. Sard's fault until proven otherwise. */
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
  "file-missing": {
    fault: "environment",
    titleKey: "err.missing.title",
    bodyKey: "err.missing.body",
    actions: ["reimport", "remove-book", "back", "details"],
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
  temporary: {
    fault: "environment",
    titleKey: "err.temporary.title",
    bodyKey: "err.temporary.body",
    actions: ["retry", "back", "details"],
  },
  internal: {
    fault: "sard",
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
    kind: "runtime-outdated",
    // The exact shape of the reported defect, plus its siblings. PDF.js 5.5 calls
    // `hashOriginal.toHex()`, `this.data.toBase64()` and `Uint8Array.fromBase64()`; foliate's
    // epub.js calls `Object.groupBy` / `Map.groupBy`. On an older engine each surfaces as
    // "<name> is not a function" — one message shape, one user action: update the runtime.
    test: /(?:toHex|toBase64|fromBase64|groupBy|withResolvers|fromAsync)\b[\s\S]{0,40}?is not a (?:function|constructor)/i,
    note: "vendored engines need a newer WebView2 (PDF.js 5.5 / foliate epub.js) — the reported defect",
  },
  {
    kind: "file-missing",
    // foliate's `NotFoundError` (view.js:87 — thrown for a zero-size file), Rust/OS not-found, and
    // `ResponseError` (view.js:74), which is a FAILED FETCH OF SARD'S OWN MANAGED COPY over the
    // asset protocol. That is an access problem, not a damaged archive: the bytes were never read,
    // so calling it "damaged" would tell the reader something untrue about their file.
    test: /NotFoundError|ResponseError|File not found|no such file|os error 2|cannot find the (?:file|path)|\b404\b/i,
    note: "the managed copy is gone or unreachable — re-import restores it",
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
    kind: "book-malformed",
    // epub.js:178 `Object.groupBy($metadata.children, …)` throws exactly this when the OPF has no
    // <metadata> element (or it is namespace-mismatched). Also XHTML parse failures and a section
    // that could not be loaded (paginator.js:1038 warns "Failed to load section N").
    test: /reading 'children'|parsererror|Invalid XHTML|Failed to load section|rootfile|container\.xml|opf/i,
    note: "structurally broken but intact as a file — re-importing the same bytes cannot help",
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

  let kind: BookErrorKind;
  if ((format === "pdf" && !canRender("pdf")) || !canRender("epub")) {
    kind = "runtime-outdated";
  } else {
    kind = matchRule(raw, RULES, "internal");
  }

  const env = currentEnv();
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
  const missing = missingFeatures(currentEnv(), cap);
  return {
    kind: "runtime-outdated",
    presentation: PRESENTATION["runtime-outdated"],
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
