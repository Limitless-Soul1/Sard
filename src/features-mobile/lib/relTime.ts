// When a mark was made, in the reader's own language.
//
// Lifted verbatim from the desk's two cross-book shelves (Inbox.tsx and BookmarksShelf.tsx), which
// carry the same function because they answer the same question. Mobile now has two shelves for the
// same reason, and a third copy of a date rule is how two lists start disagreeing about what "today"
// means. The thresholds are the desk's and are not re-tuned here.

import { uiDateTimeFormat, uiRelativeTimeFormat } from "../../lib/format";

/** "today" / "3 days ago" inside a month, an absolute date beyond it. Empty for a missing timestamp. */
export function relTime(sec: number | null, lang: string): string {
  if (!sec) return "";
  const days = Math.round((Date.now() / 1000 - sec) / 86400);
  const rtf = uiRelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(days) < 1) return rtf.format(0, "day");
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  return uiDateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }).format(new Date(sec * 1000));
}
