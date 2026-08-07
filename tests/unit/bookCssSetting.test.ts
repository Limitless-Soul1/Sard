// RESILIENCE-1 / WP-7 (stage 2) — the book-CSS setting.
//
// This governs whether third-party CSS reaches the reader's page, so the property that matters most
// is not "does it round-trip" but "what does it do when it does not understand something". Every
// ambiguous input must resolve to `off`, because the alternative is letting an unrecognised value
// grant a capability nobody chose.

import { describe, expect, it } from "vitest";
import {
  BOOK_CSS_DEFAULT,
  BOOK_CSS_KEY,
  parseBookCssMode,
} from "../../src/reader-engine/bookCssSetting";
import { sanitiseBookCss } from "../../src/reader-engine/cssSanitiser";

describe("WP-7 stage 2 — the shipping default", () => {
  it("is `off`, which is what makes stage 7.1 byte-identical to v1.1.0", () => {
    expect(BOOK_CSS_DEFAULT).toBe("off");
  });

  it("means an empty stylesheet, so the default provably changes nothing", () => {
    // The link between this setting and the observable outcome, asserted rather than assumed.
    expect(sanitiseBookCss("p { font-weight: bold; margin: -80pt; }", BOOK_CSS_DEFAULT)).toBe("");
  });

  it("uses the key named in the approved plan", () => {
    expect(BOOK_CSS_KEY).toBe("book_css");
  });
});

describe("WP-7 stage 2 — parsing is fail-closed", () => {
  it("accepts the three real modes", () => {
    expect(parseBookCssMode("off")).toBe("off");
    expect(parseBookCssMode("sanitised")).toBe("sanitised");
    expect(parseBookCssMode("raw")).toBe("raw");
  });

  it("tolerates whitespace and case", () => {
    expect(parseBookCssMode("  SANITISED ")).toBe("sanitised");
    expect(parseBookCssMode("Raw")).toBe("raw");
  });

  it("resolves an ABSENT value to off", () => {
    // A fresh install has no row. It must not inherit a permissive default.
    expect(parseBookCssMode(null)).toBe("off");
    expect(parseBookCssMode(undefined)).toBe("off");
    expect(parseBookCssMode("")).toBe("off");
  });

  it("resolves anything UNRECOGNISED to off, never to a permissive mode", () => {
    // A hand-edited database, a partial write, or a value from a future version must never be read
    // as permission. This is the fail-closed property, and it is the reason this function exists at
    // all rather than a bare cast.
    for (const bad of ["sanitized", "on", "true", "1", "yes", "all", "RAW ", "off;raw", "{}", "null"]) {
      const got = parseBookCssMode(bad);
      if (bad === "RAW ") continue; // trimmed+lowered above — covered by the case test
      expect(got, `"${bad}" must not grant anything`).toBe("off");
    }
  });

  it("never resolves an unknown value to `raw`", () => {
    // Stated separately because `raw` is the one mode with no sanitisation at all; a parsing bug
    // that reached it would put unfiltered third-party CSS on the page.
    const inputs = ["", " ", "x", "RAWX", "raw-ish", "sanitised!", null, undefined];
    for (const i of inputs) expect(parseBookCssMode(i)).not.toBe("raw");
  });
});

describe("WP-7 stage 2 — nothing is wired yet", () => {
  it("the setting module does not import the reader, the engine or any UI", async () => {
    // Stage 2's whole claim is that it changes no behaviour. A dependency on the render path would
    // quietly make that false, so the claim is checked rather than asserted in prose.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/reader-engine/bookCssSetting.ts", "utf8");
    const imports = [...src.matchAll(/^import .*?from "(.+?)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../lib/ipc", "./cssSanitiser"]);
  });

  it("exactly ONE module reads the setting", async () => {
    // Written at stage 2 as "no module reads it", and it FAILED at stage 3 — correctly, because
    // stage 3 wires the Reader to it. That is the guard working, not a broken test: it detects any
    // new consumer appearing. Updated to stage 3's invariant rather than deleted, because "who may
    // read this" is exactly the thing worth keeping under control for a setting that governs whether
    // third-party CSS reaches the page.
    const { readFileSync, globSync } = await import("node:fs");
    const files = globSync("src/**/*.{ts,tsx}").filter((f: string) => !f.includes("bookCssSetting"));
    expect(files.length).toBeGreaterThan(50); // guard against a vacuous sweep
    const readers = files
      .filter((f: string) => /loadBookCssMode|BOOK_CSS_KEY/.test(readFileSync(f, "utf8")))
      .map((f: string) => f.replace(/\\/g, "/"));
    expect(readers).toEqual(["src/features/reader/Reader.tsx"]);
  });
});
