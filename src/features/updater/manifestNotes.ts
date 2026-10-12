// THE RELEASE NOTES THE UPDATE MANIFEST CARRIES — rendered from the app's own What's New.
//
// The release workflow bundles this module and calls `manifestNotes(version)`. Its output becomes
// the GitHub release text and the `notes` field of latest.json, which is what an installed Sard shows
// when it offers the update. The text comes from the same `wn.*` strings the new version shows after
// it is installed, so the notes before an update and the notes after it are one source, not two.
//
// Not imported by the application: it pulls in both locale tables to write both languages.

import { ar } from "../../i18n/locales/ar";
import { en } from "../../i18n/locales/en";
import { NOTES_DIVIDER, WHATS_NEW, WHATS_NEW_VERSION, sameVersion } from "./whatsNew";

type Table = Readonly<Record<string, string>>;

function block(table: Table): string {
  return WHATS_NEW.map((s) => `${table[s.h]}\n${table[s.b]}`).join("\n\n");
}

/**
 * The manifest notes for the version being released: the English block, the divider, the Arabic block.
 *
 * Refuses a version the notes do not describe. Publishing anyway would put the previous release's
 * notes — or none — in front of every reader offered this one, which is the failure this replaces.
 */
export function manifestNotes(releasing: string): string {
  if (!releasing || !sameVersion(releasing, WHATS_NEW_VERSION)) {
    throw new Error(
      `the What's New notes describe ${WHATS_NEW_VERSION}, but the version being released is ` +
        `'${releasing}'. Write this release's notes (WHATS_NEW_VERSION and the wn.* strings in both ` +
        `locales) before releasing it.`,
    );
  }
  for (const s of WHATS_NEW) {
    for (const key of [s.h, s.b]) {
      if (!(en as Table)[key]?.trim() || !(ar as Table)[key]?.trim()) {
        throw new Error(`the What's New string '${key}' is missing in one of the locales.`);
      }
    }
  }
  return `${block(en as Table)}\n\n${NOTES_DIVIDER}\n\n${block(ar as Table)}\n`;
}
