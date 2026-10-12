// EACH RELEASE'S OWN NOTES.
//
// The notes are translation keys, so they follow the reader's language the way every other string
// does. They describe the build that carries them: shown once after updating to it, and published by
// the release workflow as the update manifest's notes, which is what an installed copy shows when it
// offers the update. The prompt never shows the installed build's own notes — those describe what the
// reader already has.
//
// What is pinned here is the part a later change could quietly undo: that both languages say
// something and neither leaks into the other; that the notes are never behind the app's version;
// that the prompt reads the manifest; and that the manifest text is rendered from these same strings
// and refused for a version they do not describe.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { manifestNotes } from "../../src/features/updater/manifestNotes";
import {
  NOTES_DIVIDER,
  WHATS_NEW,
  WHATS_NEW_VERSION,
  isNewer,
  manifestSections,
  shouldShowAfterUpdate,
} from "../../src/features/updater/whatsNew";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const E = en as unknown as Record<string, string>;
const A = ar as unknown as Record<string, string>;
const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ARABIC = /[؀-ۿ]/;
/** Latin letters, ignoring the product and platform names that legitimately appear in both. */
const latinProse = (s: string) =>
  s.replace(/Sard|Discord|Vista|Grid|Covers|Spines|Details|Microsoft|Edge/g, "").match(/[A-Za-z]{3,}/g) ?? [];

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
    // A reader is told what changed, never how. No identifiers, no internals.
    const forbidden = /\b(commit|refactor|regression|classif|API|WebView2|TypeScript|test|bug ?#?\d|RAWY-\d+)\b/i;
    for (const s of WHATS_NEW) {
      for (const key of [s.h, s.b]) {
        expect(E[key], `${key} reads like a developer wrote it`).not.toMatch(forbidden);
        expect(A[key], `${key} reads like a developer wrote it`).not.toMatch(forbidden);
      }
    }
  });
});

describe("which version they describe", () => {
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

  it("is a plain released-version number", () => {
    expect(WHATS_NEW_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is never BEHIND the app's own version", () => {
    // Behind means the version was bumped and the notes were not rewritten: the release would publish
    // — and show after updating — the previous release's news. Ahead is the window between writing a
    // release's notes and bumping its version.
    const app = (JSON.parse(read("package.json")) as { version: string }).version;
    expect(isNewer(app, WHATS_NEW_VERSION), `notes describe ${WHATS_NEW_VERSION}, the app is ${app}`).toBe(false);
  });
});

describe("after updating, the new version shows its own notes once", () => {
  it("in the version they describe, when that version has not been shown yet", () => {
    expect(shouldShowAfterUpdate(WHATS_NEW_VERSION, null)).toBe(true); // updated from a build with no record
    expect(shouldShowAfterUpdate(WHATS_NEW_VERSION, "")).toBe(true);
    expect(shouldShowAfterUpdate("1.4.1", "1.4.0", "1.4.1")).toBe(true); // an older version was recorded
    expect(shouldShowAfterUpdate("v1.4.1", null, "1.4.1")).toBe(true);
  });

  it("not again once this version has been shown", () => {
    expect(shouldShowAfterUpdate(WHATS_NEW_VERSION, WHATS_NEW_VERSION)).toBe(false);
    expect(shouldShowAfterUpdate("1.4.1", "1.4.2", "1.4.1")).toBe(false); // a record from a later version
  });

  it("and a later version that brings its own notes is eligible again", () => {
    expect(shouldShowAfterUpdate("1.4.2", "1.4.1", "1.4.2")).toBe(true);
    expect(shouldShowAfterUpdate("1.5.0", "1.4.1", "1.5.0")).toBe(true);
  });

  it("never in a build the notes do not describe", () => {
    // A development build still numbered as the last release must not present the next one's notes.
    expect(shouldShowAfterUpdate("1.4.0", null, "1.4.1")).toBe(false);
    expect(shouldShowAfterUpdate("1.4.2", "1.4.1", "1.4.1")).toBe(false);
    expect(shouldShowAfterUpdate("", null)).toBe(false);
    expect(shouldShowAfterUpdate(null, null)).toBe(false);
  });
});

describe("the update prompt shows the OFFERED version's notes", () => {
  const published = manifestNotes(WHATS_NEW_VERSION);

  it("in Arabic for an Arabic reader", () => {
    expect(manifestSections(published, "ar")).toEqual(WHATS_NEW.map((s) => ({ h: A[s.h], b: A[s.b] })));
  });

  it("in English for an English reader", () => {
    expect(manifestSections(published, "en")).toEqual(WHATS_NEW.map((s) => ({ h: E[s.h], b: E[s.b] })));
  });

  it("whatever line endings the notes arrive with", () => {
    expect(manifestSections(published.replace(/\n/g, "\r\n"), "ar")).toEqual(manifestSections(published, "ar"));
    expect(manifestSections(published.replace(/\n/g, "\r\n"), "en")).toEqual(manifestSections(published, "en"));
  });

  it("shows single-language notes as they are, in either language", () => {
    // Notes published before both languages were carried: one block, hard-wrapped, as v1.4.0's were.
    const old = "Updates when you open Sard\nSard now looks for a new version\neach time it opens.\n\nFaster\nIt is.";
    const want = [
      { h: "Updates when you open Sard", b: "Sard now looks for a new version each time it opens." },
      { h: "Faster", b: "It is." },
    ];
    expect(manifestSections(old, "en")).toEqual(want);
    expect(manifestSections(old, "ar")).toEqual(want);
  });

  it("gives the dialog nothing when there is nothing to show", () => {
    expect(manifestSections("", "en")).toBeNull();
    expect(manifestSections("   \n  ", "ar")).toBeNull();
    expect(manifestSections(null, "en")).toBeNull();
    expect(manifestSections(undefined, "ar")).toBeNull();
  });

  it("and the dialog reads the manifest, never this build's own notes", () => {
    // The installed build cannot know what a future release contains; its own notes describe what the
    // reader already has. This is the line that put old news in front of 1.3.0 and 1.4.0 readers.
    const src = read("src/features/updater/UpdateDialog.tsx");
    expect(src).toMatch(/manifestSections\(state\.notes, lang\)/);
    expect(src).not.toMatch(/\bWHATS_NEW\b|whatsNewFor/);
  });
});

describe("the release publishes these notes, and refuses any other", () => {
  it("renders the English block, the divider, then the Arabic block, from the same strings", () => {
    const text = manifestNotes(WHATS_NEW_VERSION);
    const [english, arabic, ...rest] = text.split(`\n\n${NOTES_DIVIDER}\n\n`);
    expect(rest).toEqual([]);
    expect(english).toBe(WHATS_NEW.map((s) => `${E[s.h]}\n${E[s.b]}`).join("\n\n"));
    expect(arabic.trimEnd()).toBe(WHATS_NEW.map((s) => `${A[s.h]}\n${A[s.b]}`).join("\n\n"));
  });

  it("accepts the release version written with a leading v", () => {
    expect(manifestNotes(`v${WHATS_NEW_VERSION}`)).toBe(manifestNotes(WHATS_NEW_VERSION));
  });

  it("refuses a version the notes do not describe", () => {
    const describes = new RegExp(`describe ${WHATS_NEW_VERSION.replace(/\./g, "\\.")}`);
    expect(() => manifestNotes("0.0.1")).toThrow(describes);
    expect(() => manifestNotes("999.0.0")).toThrow(/before releasing it/);
    expect(() => manifestNotes("")).toThrow();
  });

  it("and the release workflow is wired to it rather than to the tag's annotation", () => {
    const wf = read(".github/workflows/release.yml");
    expect(wf).toMatch(/npx esbuild src\/features\/updater\/manifestNotes\.ts/);
    expect(wf).toMatch(/m\.manifestNotes\(process\.argv\[2\]\)/);
    expect(wf).toMatch(/releaseBody: \$\{\{ steps\.notes\.outputs\.body \}\}/);
    expect(wf).not.toMatch(/contents:body|%\(contents\)/);
  });
});
