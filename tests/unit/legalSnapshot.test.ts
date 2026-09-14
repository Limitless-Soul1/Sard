// THE LEGAL TEXT SARD SHIPS IS THE LEGAL TEXT SOMEONE APPROVED.
//
// The vendored snapshot is generated from the `sard-legal` repository, and the strong check —
// `sync-legal.mjs --verify` — re-derives it from that source. It needs a checkout of a second
// repository, so it belongs to the release, not to every machine.
//
// This is the half that can run everywhere, and it is the half that catches the likeliest mistake
// by a wide margin: somebody opens the generated file and edits it. Thirty-eight thousand
// characters of legal prose is not a diff anyone reads closely, and a single altered sentence in
// the governing-law clause would ship silently. The snapshot carries a hash of its own content, so
// the edit fails here instead — in the ordinary suite, with no external dependency.
//
// The other assertions are about the PROMISES the feature makes: a revision that derives from its
// parts, an acceptance keyed on that revision rather than on a boolean, and a gate that cannot be
// dismissed. Each of them is a thing a later change could quietly undo.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LEGAL_CONTENT_HASH,
  LEGAL_EFFECTIVE,
  LEGAL_PRIVACY,
  LEGAL_REVISION,
  LEGAL_TERMS,
} from "../../src/legal/content.generated";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const GATE = read("src/features/legal/LegalGate.tsx");
const GENERATED = read("src/legal/content.generated.ts");

describe("the vendored legal snapshot", () => {
  it("hashes to the fingerprint it declares", () => {
    // The same shape and order `sync-legal.mjs` hashes, so the two cannot drift apart.
    const actual = createHash("sha256")
      .update(JSON.stringify({ rev: LEGAL_REVISION, terms: LEGAL_TERMS, privacy: LEGAL_PRIVACY }))
      .digest("hex")
      .slice(0, 32);
    expect(actual, "the generated legal content has been edited by hand").toBe(LEGAL_CONTENT_HASH);
  });

  it("says it is generated, so nobody edits it by accident", () => {
    expect(GENERATED.slice(0, 40)).toContain("GENERATED");
    expect(GENERATED).toContain("DO NOT EDIT");
  });

  it("carries a revision that derives from the two documents", () => {
    // The combined identifier is the thing acceptance is recorded against. If it could be written
    // independently of the versions it names, it would be a string someone typed.
    expect(LEGAL_REVISION).toBe(`terms-${LEGAL_TERMS.version}+privacy-${LEGAL_PRIVACY.version}`);
  });

  it("carries both documents, in both languages, with their headings intact", () => {
    for (const [name, doc] of [["terms", LEGAL_TERMS], ["privacy", LEGAL_PRIVACY]] as const) {
      for (const lang of ["en", "ar"] as const) {
        const blocks = doc[lang];
        expect(blocks.length, `${name}.${lang} is empty`).toBeGreaterThan(10);
        expect(blocks.some((b) => b.k === "h1"), `${name}.${lang} has no title`).toBe(true);
        // Numbered sections are the document's spine; losing them would mean the extractor changed
        // shape without anyone noticing.
        expect(blocks.filter((b) => b.k === "h2").length, `${name}.${lang} sections`).toBeGreaterThan(5);
        expect(blocks.every((b) => b.t.trim().length > 0), `${name}.${lang} has an empty block`).toBe(true);
      }
      // The two languages are translations of one document, so they carry the same sections.
      expect(doc.en.filter((b) => b.k === "h2").length, `${name} section count matches across languages`)
        .toBe(doc.ar.filter((b) => b.k === "h2").length);
    }
  });

  it("states when it takes effect", () => {
    expect(LEGAL_EFFECTIVE.length).toBeGreaterThan(0);
  });

  it("has no unfinished clause left in it", () => {
    // The governing-law section was published as a visible TODO for a month. It is settled now, and
    // a gate that asks someone to accept a document containing the word would be indefensible.
    for (const doc of [LEGAL_TERMS, LEGAL_PRIVACY]) {
      for (const lang of ["en", "ar"] as const) {
        for (const b of doc[lang]) expect(b.t, `unfinished clause in ${lang}`).not.toMatch(/\bTODO\b/);
      }
    }
  });
});

describe("the acceptance gate", () => {
  it("is keyed on the revision, never on a boolean", () => {
    expect(GATE).toContain('LEGAL_KEY = "legal_accepted_revision"');
    // What it stores is the revision itself, and what it compares is that string.
    expect(GATE).toContain("settingsSet(LEGAL_KEY, LEGAL_REVISION)");
    expect(GATE).toMatch(/accepted === LEGAL_REVISION/);
    expect(GATE, "a boolean acceptance flag would make a later revision unaskable")
      .not.toMatch(/settingsSet\(LEGAL_KEY,\s*(true|"true"|"1")/);
  });

  it("cannot be dismissed", () => {
    // `useDialog`'s own contract: omitting `onDismiss` is what makes Escape do nothing. Passing one
    // here — even a harmless-looking close — would turn a legal gate into a notice.
    const call = GATE.slice(GATE.indexOf("useDialog({"), GATE.indexOf("useDialog({") + 160);
    expect(call, "a dismissable legal gate has not asked anything").not.toContain("onDismiss");
    expect(GATE, "the scrim must not answer for the reader").toContain("onPointerDown={(e) => e.stopPropagation()}");
  });

  it("requires an explicit acknowledgement before it will accept", () => {
    expect(GATE).toMatch(/disabled=\{!ack/);
  });
});
