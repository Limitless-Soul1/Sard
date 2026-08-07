// RESILIENCE-1 / WP-1 — the generic failure framework.
//
// THE ONE IDEA. A user-facing failure is not described by the exception that caused it. It is
// described by three answers: WHAT failed, WHOSE responsibility it is, and WHAT THE USER DOES NEXT.
// The exception is an input to that mapping and nothing more — it belongs in diagnostics, never in
// the primary message.
//
// This module is deliberately GENERIC and knows nothing about books. `bookErrors.ts` layers the
// book-opening rules on top; WP-5's TTS language compatibility will layer its own rules on the same
// core. That is the point: every user-visible failure in Sard should end up flowing through ONE
// classification pipeline rather than each subsystem growing its own (which is how the reader ended
// up printing `String(e)` while the updater already had a proper classifier).

import type { TKey } from "../i18n/locales/en";
import { settingsGet, settingsSet } from "./ipc";

/**
 * WHOSE responsibility the failure is. This is the question a user actually asks first — "did I
 * break it, is my machine wrong, or is this app broken?" — and answering it plainly is what stops a
 * malformed book from reading as a Sard crash.
 */
export type Fault =
  /** The file is wrong: unreadable, damaged, or structurally broken. Sard and the machine are fine. */
  | "book"
  /** The machine or the OS runtime is the limit — an outdated WebView2, a missing file, no network. */
  | "environment"
  /** A choice the user made can be changed to fix it (e.g. a voice that cannot speak this book).
   *  No WP-1 failure emits this; it exists because WP-5 needs it and the vocabulary must be shared. */
  | "configuration"
  /** Sard itself. Anything unmapped lands here, on purpose — see `classify` below. */
  | "sard";

/**
 * What the user can DO. Ordered by the presentation, first = primary.
 * Every presentation must offer at least one non-`details` action: a dialog with no way forward is
 * a dead end, and dead ends are what this package exists to remove.
 */
export type RecoveryAction =
  | "retry"
  | "update-runtime"
  | "reimport"
  | "remove-book"
  | "back"
  | "details";

/** How a failure is PRESENTED. Several internal kinds may share one presentation — see below. */
export interface Presentation {
  fault: Fault;
  titleKey: TKey;
  bodyKey: TKey;
  actions: readonly RecoveryAction[];
}

/**
 * A classified failure: an internal `kind` for diagnostics, and the presentation the user sees.
 *
 * `kind` and presentation are SEPARATE on purpose. Two technical failures that need the same user
 * action must produce the same experience — but their distinct diagnostics are still worth keeping,
 * because that is what makes a future compatibility problem diagnosable without reproducing it.
 * So the kinds stay distinct internally and converge visually.
 */
export interface Classified<K extends string = string> {
  kind: K;
  presentation: Presentation;
  /** The normalised exception text. NEVER rendered unless the user opens Details. */
  raw: string;
  /** Structured context captured at the failure site (book id, format, capability…). */
  context: Readonly<Record<string, string | number | boolean | null>>;
}

// ---------------------------------------------------------------------------
// Normalising a throwable
// ---------------------------------------------------------------------------

const RAW_CAP = 4000; // a runaway string must not bloat the settings row

/**
 * Turn anything at all into one diagnostic string, following `cause` chains.
 *
 * Deliberately lossless-ish and deliberately UGLY: this is the text a developer reads, so it keeps
 * the constructor name (`UnknownErrorException`, `NotFoundError`) that the classifier matches on and
 * that a bug report needs.
 */
export function describeError(e: unknown, depth = 0): string {
  if (e == null) return "";
  if (typeof e === "string") return e.slice(0, RAW_CAP);
  if (e instanceof Error) {
    // The class name matters — it is what the classifier matches on and what a bug report needs.
    // Two different conventions are in play and BOTH must be read:
    //   * PDF.js sets it explicitly (`BaseException` assigns `this.name`), so `e.name` works.
    //   * foliate does NOT: `class NotFoundError extends Error {}` (view.js:66-68) inherits
    //     `name === "Error"`, and the real name only exists on the constructor.
    // Reading `e.name` alone silently dropped every foliate error class — caught by the WP-1 tests.
    // (Safe here because `public/foliate-js/` is served raw: Vite never minifies it, so constructor
    // names survive into the build.)
    const ctorName = (e as { constructor?: { name?: string } }).constructor?.name;
    const name = e.name && e.name !== "Error" ? e.name : ctorName && ctorName !== "Error" ? ctorName : "";
    const head = name ? `${name}: ${e.message}` : e.message || String(e);
    const cause = depth < 3 && (e as { cause?: unknown }).cause != null
      ? `\ncaused by: ${describeError((e as { cause?: unknown }).cause, depth + 1)}`
      : "";
    return `${head}${cause}`.slice(0, RAW_CAP);
  }
  if (typeof e === "object") {
    const o = e as { name?: unknown; message?: unknown };
    if (typeof o.message === "string") {
      return `${typeof o.name === "string" ? `${o.name}: ` : ""}${o.message}`.slice(0, RAW_CAP);
    }
    try {
      return JSON.stringify(e).slice(0, RAW_CAP);
    } catch {
      return String(e).slice(0, RAW_CAP);
    }
  }
  return String(e).slice(0, RAW_CAP);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** One rule: if `test` matches the normalised text, the failure is `kind`. */
export interface Rule<K extends string> {
  kind: K;
  test: RegExp;
  /** Why this rule exists — kept beside it so a future edit knows what it was protecting. */
  note: string;
}

/**
 * Run an ordered rule list against a normalised error string.
 *
 * `fallback` is returned when nothing matches, and that MUST be the "Sard's fault" kind. Following
 * the precedent `updater.ts` already set: anything unrecognised gets the honest generic answer
 * rather than being force-fitted into a category that would tell the reader something untrue about
 * their own book or machine. A wrong confident message is worse than an honest vague one.
 */
export function matchRule<K extends string>(raw: string, rules: readonly Rule<K>[], fallback: K): K {
  for (const r of rules) if (r.test.test(raw)) return r.kind;
  return fallback;
}

// ---------------------------------------------------------------------------
// Diagnostics — a permanent debugging tool, not a debug-build nicety
// ---------------------------------------------------------------------------

/**
 * One recorded failure. Structured so a compatibility problem reported months from now can be
 * understood WITHOUT reproducing it: the kind, the fault, the raw exception and the context that
 * was true at the moment it happened.
 */
export interface Diagnostic {
  /** Epoch ms. */
  at: number;
  /** Which pipeline produced it: "book-open", "import", later "tts". */
  scope: string;
  kind: string;
  fault: Fault;
  raw: string;
  context: Record<string, string | number | boolean | null>;
}

const DIAG_KEY = "diagnostics"; // a settings key/value row — no migration (the D-§7.11 pattern)
const DIAG_MAX = 60; // bounded ring: enough to span a session's worth of failures, small enough to paste

let cache: Diagnostic[] | null = null;

/** Read the recorded diagnostics (newest last). Never throws. */
export async function readDiagnostics(): Promise<Diagnostic[]> {
  if (cache) return cache;
  try {
    const raw = await settingsGet(DIAG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as Diagnostic[]) : [];
  } catch {
    cache = []; // a corrupt/legacy value means "nothing recorded", never a throw
  }
  return cache;
}

/**
 * Append a diagnostic. FIRE AND FORGET — recording a failure must never itself fail, and must never
 * delay the message the user is waiting for.
 */
export function recordDiagnostic(d: Diagnostic): void {
  void (async () => {
    try {
      const list = await readDiagnostics();
      const next = [...list, d].slice(-DIAG_MAX);
      cache = next;
      await settingsSet(DIAG_KEY, JSON.stringify(next));
    } catch {
      /* diagnostics are best-effort by construction */
    }
  })();
}

/** Drop the in-memory copy (tests, and after a settings reset). */
export function resetDiagnosticsCache(): void {
  cache = null;
}

/** Build a diagnostic from a classified failure. */
export function toDiagnostic(scope: string, c: Classified): Diagnostic {
  return {
    at: Date.now(),
    scope,
    kind: c.kind,
    fault: c.presentation.fault,
    raw: c.raw,
    context: { ...c.context },
  };
}

/**
 * One plain-text block for a bug report: the environment, then the recorded failures, newest last.
 * This is what the Details panel's copy button emits — the whole point of principle 5 is that the
 * user can hand over something useful without anyone having to reproduce the problem first.
 */
export function formatDiagnostics(entries: readonly Diagnostic[], env: Record<string, string>): string {
  const head = Object.entries(env)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const body = entries
    .map((d) => {
      const ctx = Object.entries(d.context)
        .filter(([, v]) => v !== null && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `[${new Date(d.at).toISOString()}] ${d.scope} · ${d.kind} · fault=${d.fault}${ctx ? `\n  ${ctx}` : ""}\n  ${d.raw.replace(/\n/g, "\n  ")}`;
    })
    .join("\n\n");
  return `${head}\n\n--- ${entries.length} recorded failure(s) ---\n\n${body || "(none)"}`;
}
