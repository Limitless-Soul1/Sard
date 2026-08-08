// RESILIENCE-1 / WP-7 (stage 2) — WHERE THE BOOK-CSS DECISION LIVES.
//
// The CSP is compiled into the binary and cannot be changed at runtime, so "should a book's own
// stylesheet apply?" CANNOT be answered by the CSP — flipping it would need a release, and would
// apply to every book at once with no way back. The decision therefore lives HERE, in a persisted
// runtime setting, and the CSP only ever grants the *capability*. That separation is the whole
// safety argument for the staged rollout:
//
//     CSP  = "a stylesheet may reach the frame at all"      (compiled in, stage 4)
//     this = "and this is what it is allowed to contain"    (runtime, revocable, per install)
//
// So the risky capability ships INERT behind a value that defaults to `off`, and a bad outcome in
// the field is a setting change rather than a release.
//
// STAGE 2 SCOPE, deliberately narrow: this module owns the key, its validation and its persistence.
// NOTHING READS IT YET. The sanitiser (stage 1) is still wired to nothing, integration is stage 3,
// and the CSP token is stage 4. Each stage is verifiable on its own, which is the point.
//
// There is intentionally no UI. A control for a capability that cannot yet do anything would be a
// lie to the reader; it belongs with stage 4, when flipping the value has a visible effect.

import { settingsGet, settingsSet } from "../lib/ipc";
import type { BookCssMode } from "./cssSanitiser";

/** The persisted key. Named in the approved plan; nothing else in the app claims it. */
export const BOOK_CSS_KEY = "book_css";

/**
 * The SHIPPING DEFAULT, and the reason stage 7.1 is byte-identical to v1.1.0.
 *
 * `off` makes the sanitiser return an empty sheet, so a book's stylesheet loads and contributes
 * nothing. Every other value is opt-in, and none is reachable until stage 4.
 */
export const BOOK_CSS_DEFAULT: BookCssMode = "off";

const VALID: readonly BookCssMode[] = ["off", "sanitised", "raw"];

/**
 * Coerce any stored text to a mode.
 *
 * Anything unrecognised — a hand-edited database, a value written by a future version, a partial
 * write — resolves to `off`. For a setting that governs whether third-party CSS reaches the reader's
 * page, the only safe reading of "I don't understand this" is the most restrictive one.
 */
export function parseBookCssMode(raw: string | null | undefined): BookCssMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (VALID as readonly string[]).includes(v) ? (v as BookCssMode) : BOOK_CSS_DEFAULT;
}

/** Read the persisted mode. A failed read is not an error — it is `off`, for the same reason. */
export async function loadBookCssMode(): Promise<BookCssMode> {
  const raw = await settingsGet(BOOK_CSS_KEY).catch(() => null);
  return parseBookCssMode(raw);
}

/** Persist a mode. Rejects nothing: an invalid value is stored as the default rather than thrown. */
export async function saveBookCssMode(mode: BookCssMode): Promise<void> {
  await settingsSet(BOOK_CSS_KEY, parseBookCssMode(mode)).catch(() => {});
}
