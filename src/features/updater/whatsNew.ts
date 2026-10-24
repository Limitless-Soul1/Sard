// WHAT'S NEW — each release's own notes, in the reader's own language.
//
// THE NOTES DESCRIBE THE BUILD THAT CARRIES THEM. They used to be offered for any update newer than
// the version they were written against — but the dialog that offers an update is drawn by the copy
// the reader already has, which cannot know what a FUTURE release contains. So an installed 1.4.0
// showed its own highlights for whatever it was offered next: news the reader already had.
//
// Two places show them now, and both describe a version that actually contains the change:
//
//   AFTER UPDATING — `WhatsNewDialog` shows these sections once, in the build they describe.
//   BEFORE UPDATING — the update prompt shows the manifest's notes, because only the manifest can
//                     speak for the version on offer. The release workflow renders that manifest text
//                     from these same sections (`manifestNotes.ts`), in both languages, so the two
//                     cannot drift: one set of strings, read here and published there.
//
// When a release is prepared, `WHATS_NEW_VERSION` moves to it and the sections are rewritten. The
// release workflow refuses to publish a version these notes do not describe.

import type { Lang } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { isArabicText } from "../../lib/typography";

/** The version these notes describe: the release that contains them. */
export const WHATS_NEW_VERSION = "1.4.2";

/** The settings row recording the version whose notes this installation has already been shown. */
export const SEEN_KEY = "whats_new_seen_version";

/** One highlight: a heading and a sentence or two. Both are ordinary translation keys. */
export interface WhatsNewSection {
  h: TKey;
  b: TKey;
}

/**
 * The highlights of this release, in the order a reader meets them.
 *
 * Deliberately short. This is what changed that a reader would notice and use — not a list of
 * everything that moved. The keys are written out rather than built from a template, so a missing
 * one is a compile error instead of an identifier printed into the dialog.
 */
export const WHATS_NEW: readonly WhatsNewSection[] = [
  { h: "wn.readAloud.h", b: "wn.readAloud.b" },
  { h: "wn.secondServer.h", b: "wn.secondServer.b" },
  { h: "wn.busyServer.h", b: "wn.busyServer.b" },
  { h: "wn.busyWait.h", b: "wn.busyWait.b" },
];

/** `1.2.10` is newer than `1.2.9`, which a string comparison gets wrong. Missing parts read as 0. */
function order(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/, 3)
    .map((n) => {
      const x = Number.parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
}

/** Is `offered` a later version than `base`? */
export function isNewer(offered: string, base: string): boolean {
  const a = order(offered);
  const b = order(base);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The same release, written with or without a leading `v`. */
export function sameVersion(a: string, b: string): boolean {
  return a.trim().replace(/^v/i, "") === b.trim().replace(/^v/i, "");
}

/**
 * Should this launch show the after-update notes?
 *
 * Only in the build the notes describe — a development build still numbered as the last release
 * must not present the next one's notes as news — and only when this version has not been shown
 * yet: no record at all (an installation that predates the record, i.e. one that was just updated),
 * or a record of an older version. A first run records its own version before the library opens,
 * so a fresh install never reaches this with nothing recorded.
 */
export function shouldShowAfterUpdate(
  appVersion: string | null | undefined,
  seen: string | null | undefined,
  notesVersion: string = WHATS_NEW_VERSION,
): boolean {
  if (!appVersion || !sameVersion(appVersion, notesVersion)) return false;
  if (!seen || !seen.trim()) return true;
  return isNewer(appVersion, seen);
}

// ---- the manifest's notes ----------------------------------------------------------------------
//
// The workflow publishes the notes as plain text, readable as it stands on the release page and in
// any older Sard that shows it verbatim: the English block, a divider line, then the Arabic block.
// Each block is a sequence of sections separated by a blank line — a heading line, then its body.

/** The line between the English and the Arabic block. */
export const NOTES_DIVIDER = "⁂";

/** One section of the manifest's notes, as text. */
export interface NoteSection {
  h: string;
  b: string;
}

const DIVIDER_LINE = /^[ \t]*⁂[ \t]*$/m;

/** A block's sections: blank-line separated, heading first. Any line ending is accepted. */
function sections(block: string): NoteSection[] {
  const out: NoteSection[] = [];
  for (const chunk of block.split(/\r?\n[ \t]*\r?\n/)) {
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    out.push(lines.length === 1 ? { h: "", b: lines[0] } : { h: lines[0], b: lines.slice(1).join(" ") });
  }
  return out;
}

/**
 * The manifest's notes for this reader: the block in their language, as sections.
 *
 * A block is Arabic when its first line is. Notes with a single block — anything published before the
 * notes carried both languages — are shown as they are. `null` when there is nothing to show, so the
 * dialog can fall back to the text exactly as it arrived.
 */
export function manifestSections(body: string | null | undefined, lang: Lang): NoteSection[] | null {
  if (!body || !body.trim()) return null;
  const blocks = body.split(DIVIDER_LINE).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return null;
  const isArabic = (b: string) => isArabicText(b.split(/\r?\n/, 1)[0]);
  const chosen = blocks.length === 1 ? blocks[0] : (blocks.find((b) => isArabic(b) === (lang === "ar")) ?? blocks[0]);
  const out = sections(chosen);
  return out.length ? out : null;
}
