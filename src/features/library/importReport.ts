// RESILIENCE-1 / WP-1 — turning import results into something a user can act on.
//
// THE DEFECT. `summarize()` counted statuses and produced "1 unsupported". The Rust side already
// emits a specific reason per file — "Not a valid EPUB (bad ZIP)", "Not an EPUB (missing epub
// mimetype)", "Couldn't store the file: …" (books/mod.rs:145-166) — and `ImportResult.message`
// carried it all the way to the UI, where it was thrown away. A user whose book was refused had no
// route to finding out why, which is exactly the situation this milestone exists to fix.
//
// Pure module: no React, no IPC. That is what makes it testable, and the counting/attribution rules
// are worth testing.

import type { ImportResult } from "../../lib/ipc";
import type { Fault } from "../../lib/errors";
import type { TKey } from "../../i18n/locales/en";

/** A file that was NOT added, with the reason stated in the user's language. */
export interface ImportProblem {
  /** The title Rust reported — for a failure this is the filename stem, which is what the user sees. */
  name: string;
  /** The localised one-line reason. */
  reasonKey: TKey;
  fault: Fault;
  /** Rust's own message, kept for Details. Never rendered in the primary list. */
  raw: string | null;
  /** For diagnostics. */
  status: string;
}

export interface ImportReport {
  added: number;
  duplicates: number;
  problems: ImportProblem[];
  /** Paths refused before import because this runtime cannot render them (see `splitByCapability`). */
  runtimeBlocked: string[];
}

/** Which reason line a status maps to. `duplicate` is NOT a problem — the book is in the library. */
const REASON: Record<string, { key: TKey; fault: Fault }> = {
  unsupported: { key: "lib.import.reason.unsupported", fault: "book" },
  error: { key: "lib.import.reason.error", fault: "book" },
};

/**
 * Build the report. `runtimeBlocked` are paths that never reached Rust — refused up front because
 * the runtime cannot render that format, so importing them would have produced library entries that
 * are guaranteed to fail on open.
 */
export function buildImportReport(results: readonly ImportResult[], runtimeBlocked: readonly string[] = []): ImportReport {
  const report: ImportReport = { added: 0, duplicates: 0, problems: [], runtimeBlocked: [...runtimeBlocked] };
  for (const r of results) {
    if (r.status === "imported") report.added++;
    else if (r.status === "duplicate") report.duplicates++;
    else {
      const mapped = REASON[r.status] ?? REASON.error;
      report.problems.push({
        name: r.title || "—",
        reasonKey: mapped.key,
        fault: mapped.fault,
        raw: r.message,
        status: r.status,
      });
    }
  }
  for (const path of runtimeBlocked) {
    report.problems.push({
      name: fileName(path),
      reasonKey: "lib.import.reason.runtime",
      // ENVIRONMENT, not book: the PDF is perfectly fine, this machine's runtime is not. Getting the
      // attribution right here is the difference between "your file is broken" (untrue, and the user
      // may delete a good file) and "your Windows component needs updating" (true, and fixable).
      fault: "environment",
      raw: null,
      status: "runtime-blocked",
    });
  }
  return report;
}

/** `true` when the whole batch succeeded — the caller can then use the quiet toast. */
export const isCleanImport = (r: ImportReport): boolean => r.problems.length === 0;

function fileName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(epub|pdf)$/i, "");
}

/**
 * Split candidate paths into those this runtime can actually render and those it cannot.
 *
 * WHY REFUSE RATHER THAN IMPORT-AND-FAIL-LATER: the library should represent usable content. An
 * entry that is guaranteed to fail the moment it is opened is worse than an honest refusal carrying
 * a recovery path — and the refusal is not a dead end, because it names the fix (update WebView2).
 */
export function splitByCapability(paths: readonly string[], canPdf: boolean): { accepted: string[]; blocked: string[] } {
  if (canPdf) return { accepted: [...paths], blocked: [] };
  const accepted: string[] = [];
  const blocked: string[] = [];
  for (const p of paths) (/\.pdf$/i.test(p) ? blocked : accepted).push(p);
  return { accepted, blocked };
}
