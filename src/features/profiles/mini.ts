// Turning a profile — or one of the sixteen — into the miniature's props.
//
// One place, because the card, the first-run state, the switcher and the editor's stage all draw
// the same picture and must never disagree about what a profile looks like.

import { scrimAlpha } from "../../lib/background";
import { FONT_CATALOGUE } from "../../lib/fonts";
import type { Theme } from "../../theme/tokens";
import type { MiniProfile } from "./SardMini";
import { SEAL_DIAMOND, TEXTURE_ALPHA, type Profile } from "./model/profile";

/**
 * A book-font key → the CSS family that renders it.
 *
 * Built-in keys resolve through the shared catalogue rather than a second table, so a face added
 * there appears here without anyone remembering to. An IMPORTED font is stored by its own family
 * name and is already a CSS family, so it passes through — which is also why the fallback is the
 * value itself rather than a default: an unrecognised key is far more likely to be an imported
 * family than a mistake.
 */
export function bookFaceCss(key: string): string {
  const cat = FONT_CATALOGUE.find((f) => f.bookArabic === key || f.bookLatin === key);
  if (!cat) return `"${key}", serif`;
  // An empty `css` is the catalogue's way of saying "the default Plex pair", which the app font
  // stack already provides.
  return cat.css ? `"${cat.css}", serif` : `"SardUIArabic", "SardUILatin", serif`;
}

/** The word a profile's page shows: its own name, or a word of Sard when it has none. */
export const miniGlyph = (name: string | null): string => {
  const n = (name ?? "").trim();
  return n ? n.slice(0, 12) : "سَرْد";
};

/**
 * What a profile's seal shows, and the face it is set in.
 *
 * ONE PLACE, because a seal is drawn in five: the card, the switcher, the editor's toolbar, the
 * identity chapter and the library face's chip. They are pictures of one thing and must never
 * disagree about what that thing looks like — which they would the moment any of them decided the
 * font or the letter for itself.
 */
export function sealOf(p: Profile): { text: string; fontFamily: string } {
  const face = p.data.seal.face === "profile" ? p.data.type.arabic : p.data.seal.face;
  return {
    text: p.data.seal.glyph === "diamond"
      ? SEAL_DIAMOND
      : (p.name ?? "").trim().slice(0, 1) || "س",
    fontFamily: bookFaceCss(face),
  };
}

/**
 * The miniature for a saved profile.
 *
 * `bgUrl` is the profile's LIBRARY image, already resolved to a URL by whoever holds the managed
 * rows — the miniature is a pure component and does not go looking for files.
 *
 * THE BACKGROUND AND THE TEXTURE USED TO BE STUBBED OUT HERE. The note said "backgrounds enter a
 * profile in stage 4; until then a profile shows its own colours" — and they did enter, but this
 * never caught up, so `SardMini` was handed `bgImg: "none"` and `trans: 1` however the profile was
 * actually configured. The miniature has carried these four props since it was written; it was the
 * caller that had nothing to put in them. Measured before the fix: zero elements with a background
 * image anywhere in the library specimen, whatever the profile said.
 *
 * The numbers are PRODUCTION'S OWN. `scrimAlpha` is the function the real library surface uses to
 * turn a presence slider into a scrim, so the miniature and the thing it depicts cannot drift.
 */
export function miniOf(p: Profile, bgUrl?: string | null): MiniProfile {
  const c = p.data.theme.colors;
  const lib = p.data.bg.library.params;
  return {
    paper: c.paperBg,
    desk: c.surfaceBg,
    chrome: c.chromeBg,
    border: c.chromeBorder,
    text: c.text,
    muted: c.muted,
    accent: c.accent,
    ink: p.data.theme.bookmark ?? c.accent,
    bgImg: bgUrl ? `url("${bgUrl}")` : "none",
    // The image is drawn in full and the SCRIM is what the presence slider moves — the same
    // division of labour the real surface uses, rather than a second interpretation of "presence".
    bgOn: bgUrl ? 1 : 0,
    scrim: bgUrl ? scrimAlpha(lib.presence, "library") : 0,
    blur: `${bgUrl ? lib.blur : 0}px`,
    trans: TEXTURE_ALPHA[p.data.texture],
    face: bookFaceCss(p.data.type.arabic),
    glyph: miniGlyph(p.name),
  };
}

/** The miniature for one of the sixteen — used for the starting profiles and the first-run state. */
export function miniOfTheme(t: Theme, name: string, face = "amiri"): MiniProfile {
  const c = t.colors;
  return {
    paper: c.paperBg,
    desk: c.surfaceBg,
    chrome: c.chromeBg,
    border: c.chromeBorder,
    text: c.text,
    muted: c.muted,
    accent: c.accent,
    ink: c.accent,
    bgImg: "none",
    bgOn: 0,
    scrim: 0,
    blur: "0px",
    trans: 1,
    face: bookFaceCss(face),
    glyph: miniGlyph(name),
  };
}
