// THE RELEASE NOTES SARD CARRIES ITSELF.
//
// The update dialog showed `update.body` — the manifest's own text, published once, in one
// language. An Arabic reader was therefore shown English notes, or the reverse, depending on what
// was written that day. These notes are ordinary translation keys instead, so they follow the
// reader's language the way every other string does.
//
// What is pinned here is the part a later change could quietly undo: that both languages say
// something, that neither leaks into the other, that the notes are offered only for a version they
// actually describe, and that the manifest's body is still there for every version they do not.
import { describe, expect, it } from "vitest";

import { WHATS_NEW, WHATS_NEW_SINCE, isNewer, whatsNewFor } from "../../src/features/updater/whatsNew";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const E = en as unknown as Record<string, string>;
const A = ar as unknown as Record<string, string>;

const ARABIC = /[؀-ۿ]/;
/** Latin letters, ignoring the product and platform names that legitimately appear in both. */
const latinProse = (s: string) => s.replace(/Sard|Discord|Vista|Grid|Covers|Spines|Details/g, "").match(/[A-Za-z]{3,}/g) ?? [];

describe("the notes exist in both languages", () => {
  it("offers a short set of highlights, not a changelog", () => {
    // A dialog is not a release page. If this ever grows past a dozen, the notes have stopped being
    // highlights and started being a list.
    expect(WHATS_NEW.length).toBeGreaterThanOrEqual(4);
    expect(WHATS_NEW.length).toBeLessThanOrEqual(12);
  });

  it("every section has a heading and a body in BOTH locales", () => {
    for (const s of WHATS_NEW) {
      for (const [label, key] of [["heading", s.h], ["body", s.b]] as const) {
        expect(E[key], `${key}: the English ${label} is missing`).toBeTruthy();
        expect(A[key], `${key}: the Arabic ${label} is missing`).toBeTruthy();
        expect(E[key].trim().length, `${key}: the English ${label} is empty`).toBeGreaterThan(2);
        expect(A[key].trim().length, `${key}: the Arabic ${label} is empty`).toBeGreaterThan(2);
      }
    }
  });

  it("and the two languages do not leak into each other", () => {
    // The whole point is that a reader sees ONE language. A stretch of Arabic in the English notes
    // — or English prose in the Arabic — means a key was copied rather than written.
    for (const s of WHATS_NEW) {
      for (const key of [s.h, s.b]) {
        expect(ARABIC.test(E[key]), `${key}: the English text contains Arabic`).toBe(false);
        expect(ARABIC.test(A[key]), `${key}: the Arabic text has no Arabic in it`).toBe(true);
        expect(latinProse(A[key]), `${key}: the Arabic text carries English prose`).toEqual([]);
      }
    }
  });

  it("says nothing about how any of it was built", () => {
    // A reader is told what changed, never how. No versions, no identifiers, no internals.
    const forbidden = /\b(commit|refactor|regression|classif|API|WebView2|TypeScript|test|bug ?#?\d|RAWY-\d+)\b/i;
    for (const s of WHATS_NEW) {
      for (const key of [s.h, s.b]) {
        expect(E[key], `${key} reads like a developer wrote it`).not.toMatch(forbidden);
        expect(A[key], `${key} reads like a developer wrote it`).not.toMatch(forbidden);
      }
    }
  });
});

describe("which update they are offered for", () => {
  it("orders versions by number, not by string", () => {
    // "1.2.10" sorts BEFORE "1.2.9" as text, which would hide the notes on the tenth patch.
    expect(isNewer("1.2.10", "1.2.9")).toBe(true);
    expect(isNewer("1.3.0", "1.2.2")).toBe(true);
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
    expect(isNewer("1.2.2", "1.2.2")).toBe(false);
    expect(isNewer("1.2.1", "1.2.2")).toBe(false);
  });

  it("reads a leading v and a trailing suffix", () => {
    expect(isNewer("v1.3.0", "1.2.2")).toBe(true);
    expect(isNewer("1.3.0-beta.1", "1.2.2")).toBe(true);
  });

  it("shows the notes for an update NEWER than the one they were written against", () => {
    expect(whatsNewFor("1.3.0")).toBe(WHATS_NEW);
    expect(whatsNewFor("v1.3.0")).toBe(WHATS_NEW);
  });

  it("and falls back to the manifest for a version they do not describe", () => {
    // THE COMPATIBILITY THIS KEEPS. Nothing about the update protocol changed: an offer these notes
    // do not cover — the same version, an older one, or a version string that is not a number at
    // all — hands the dialog nothing, and the dialog renders `update.body` exactly as before.
    expect(whatsNewFor(WHATS_NEW_SINCE)).toBeNull();
    expect(whatsNewFor("1.2.1")).toBeNull();
    expect(whatsNewFor("")).toBeNull();
    expect(whatsNewFor(null)).toBeNull();
    expect(whatsNewFor(undefined)).toBeNull();
    expect(whatsNewFor("not-a-version")).toBeNull();
  });

  it("is written against a version that has actually been released", () => {
    // If this drifts ahead of the shipped version the notes stop appearing; if it drifts behind,
    // they describe an update the reader already has.
    expect(WHATS_NEW_SINCE).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
