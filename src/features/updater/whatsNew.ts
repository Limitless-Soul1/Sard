// WHAT'S NEW — the release notes Sard carries itself, in the reader's own language.
//
// WHY NOT THE RELEASE BODY. The dialog has always shown `update.body`, the text from the update
// manifest. That is one string, published once, in one language — so an Arabic reader was shown
// English notes, or an English reader Arabic ones, depending on what was written that day. Notes
// that live here are looked up through `t()` like every other string in the product, so they follow
// the language the reader chose and the direction that language reads in.
//
// THE REMOTE BODY IS NOT REMOVED. It stays as the fallback, and it is what an older Sard keeps
// showing: a build that predates this file has no local notes and reads the manifest exactly as
// before. Nothing about the update protocol changes, and nothing needs to be published differently.
//
// KEEPING THEM HONEST. `WHATS_NEW_SINCE` is the last version these notes were written against, so
// they are offered only for an update NEWER than that. When the next release is prepared, that
// constant moves and the sections below are rewritten; until then a version that is not newer falls
// back to the manifest rather than showing a reader the highlights of an update they already have.

import type { TKey } from "../../i18n/locales/en";

/**
 * The released version these notes describe the changes SINCE.
 *
 * Not the version they will ship AS — that number is chosen when the release is cut, and writing it
 * here would mean guessing it. Any offered version newer than this one gets these notes.
 */
export const WHATS_NEW_SINCE = "1.2.2";

/** One highlight: a heading and a sentence or two. Both are ordinary translation keys. */
export interface WhatsNewSection {
  h: TKey;
  b: TKey;
}

/**
 * The highlights of this update, in the order a reader meets them.
 *
 * Deliberately short. This is what changed that a reader would notice and use — not a list of
 * everything that moved. The keys are written out rather than built from a template, so a missing
 * one is a compile error instead of an identifier printed into the dialog.
 */
export const WHATS_NEW: readonly WhatsNewSection[] = [
  { h: "wn.profiles.h", b: "wn.profiles.b" },
  { h: "wn.replacements.h", b: "wn.replacements.b" },
  { h: "wn.views.h", b: "wn.views.b" },
  { h: "wn.deposit.h", b: "wn.deposit.b" },
  { h: "wn.presence.h", b: "wn.presence.b" },
  { h: "wn.marks.h", b: "wn.marks.b" },
  { h: "wn.cards.h", b: "wn.cards.b" },
  { h: "wn.more.h", b: "wn.more.b" },
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

/**
 * The notes to show for this offered version, or `null` to use the manifest's own body.
 *
 * A version that cannot be read as a number at all falls back rather than guessing.
 */
export function whatsNewFor(offered: string | null | undefined): readonly WhatsNewSection[] | null {
  if (!offered) return null;
  return isNewer(offered, WHATS_NEW_SINCE) ? WHATS_NEW : null;
}
