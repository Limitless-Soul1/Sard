// WP-0 (RESILIENCE-1) — tests for the harnesses themselves.
//
// A drift detector that has only ever been observed saying "no drift" is not a detector. These feed
// `diff()` known differences and assert it finds each one, offline and in milliseconds — so the
// expensive app-driving run is trusted for the right reason.

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-expect-error — .mjs harness, intentionally untyped
import { diff, dumpDiff, TRACKED_PROPS } from "./byte-identity.mjs";
// @ts-expect-error — .mjs harness
import { VARIANTS } from "./csp.mjs";

// The current control fingerprint. `nav-fix.json` is the post-navigation-fix control; the WP-1 state was proven byte-identical to a rebuilt pre-WP-1
// binary across all 15 corpus books, so it is a valid stand-in for the pre-milestone rendering.
const BASELINE = join(import.meta.dirname, "fingerprints", "nav-fix.json");

/** A minimal, valid capture — the smallest thing `diff` should call identical to itself. */
const capture = () => ({
  tag: "t",
  engine: "Chrome/150.0.0.0",
  config: { theme_id: "moonlit", book_theme_id: "trueblack", pageOpacity: "1", zoom: "2" },
  books: {
    "a.epub": {
      sectionCount: 10,
      tocCount: 9,
      bookDir: "rtl",
      sampleCount: 2,
      root: { direction: "rtl", columnWidth: "600px", columnGap: "40px", overflow: "hidden" },
      body: { direction: "rtl", zoom: "1.15", backgroundColor: "rgb(250, 247, 240)", color: "rgb(40, 33, 24)", maxWidth: "none" },
      layout: { flow: "paginated", pages: 9, columns: 23, paragraphs: 26 },
      sheets: ["inline", "inline"],
      sample: [
        { i: 0, tag: "p", cls: "para", direction: "rtl", textAlign: "start", fontSize: "16px", lineHeight: "30.4px", fontWeight: "400", fontFamily: "SardArabic", letterSpacing: "normal", textIndent: "0px", marginBlockStart: "16px", marginBlockEnd: "16px", color: "rgb(40, 33, 24)", backgroundColor: "rgba(0, 0, 0, 0)" },
        { i: 1, tag: "p", cls: "para", direction: "rtl", textAlign: "start", fontSize: "16px", lineHeight: "30.4px", fontWeight: "400", fontFamily: "SardArabic", letterSpacing: "normal", textIndent: "0px", marginBlockStart: "16px", marginBlockEnd: "16px", color: "rgb(40, 33, 24)", backgroundColor: "rgba(0, 0, 0, 0)" },
      ],
    },
  },
});

describe("byte-identity diff", () => {
  it("reports no difference for an identical capture", () => {
    expect(diff(capture(), capture())).toEqual([]);
  });

  it("detects a change in EVERY tracked style property", () => {
    // The property list is the whole contract. If a property is tracked but not actually compared,
    // a real regression in it would pass silently — so each one is exercised individually.
    for (const prop of TRACKED_PROPS as string[]) {
      const a = capture();
      const b = capture();
      (b.books["a.epub"].sample[0] as Record<string, unknown>)[prop] = "CHANGED";
      const d = diff(a, b);
      expect(d.length, `a change in ${prop} must be reported`).toBeGreaterThan(0);
      expect(d.join("\n"), `the report must name ${prop}`).toContain(prop);
    }
  });

  it("detects structural changes: section count, TOC count, book direction", () => {
    for (const [key, value] of [
      ["sectionCount", 11],
      ["tocCount", 3],
      ["bookDir", "ltr"],
    ] as const) {
      const b = capture();
      (b.books["a.epub"] as any)[key] = value;
      expect(diff(capture(), b).join("\n"), key).toContain(key);
    }
  });

  it("detects a LAYOUT change — the dimension that could not see the pagination defect", () => {
    // Added after paged-mode fragmentation was found broken: the fingerprint tracked computed STYLE
    // only, so a bug that collapsed every chapter into one unbreakable column — clipping ~97% of it
    // — produced a byte-IDENTICAL fingerprint. It could neither catch the bug nor see the fix.
    const b1 = capture();
    b1.books["a.epub"].layout.columns = 1; // the defect's signature: no fragmentation
    expect(diff(capture(), b1).join("\n")).toContain("layout.columns");

    const b2 = capture();
    b2.books["a.epub"].layout.pages = 3;
    expect(diff(capture(), b2).join("\n")).toContain("layout.pages");

    const b3 = capture();
    b3.books["a.epub"].layout.flow = "scrolled";
    expect(diff(capture(), b3).join("\n")).toContain("layout.flow");
  });

  it("detects a change in the injected document-level values (root / body)", () => {
    const b1 = capture();
    b1.books["a.epub"].root.direction = "ltr";
    expect(diff(capture(), b1).join("\n")).toContain("root.direction");

    const b2 = capture();
    b2.books["a.epub"].body.zoom = "1.0";
    expect(diff(capture(), b2).join("\n")).toContain("body.zoom");
  });

  it("detects a change in the stylesheet list", () => {
    // Recorded and compared, but see the WP-7 note below: this is NOT the gate for book CSS.
    const b = capture();
    b.books["a.epub"].sheets = ["inline", "inline", "external"];
    expect(diff(capture(), b).join("\n")).toContain("stylesheets");
  });

  it("reports a SETTINGS change as configuration drift, never as a code regression", () => {
    // The WP-1 finding: changing the reading background's page opacity moved
    // `body.backgroundColor` on all fifteen books at once — indistinguishable from a catastrophic
    // regression until a pre-change binary was rebuilt to clear it. Configuration is now recorded
    // and reported separately, so a slider can never impersonate a bug.
    const b = capture();
    b.config.pageOpacity = "0.84";
    const d = diff(capture(), b);
    expect(d.some((p: string) => p.startsWith("CONFIG pageOpacity"))).toBe(true);
    expect(d.join("\n")).toContain("re-baseline");
  });

  it("flags a capture that predates configuration recording instead of trusting it", () => {
    const old = capture();
    delete (old as { config?: unknown }).config;
    expect(diff(old, capture()).join("\n")).toContain("CONFIG");
  });

  it("reports a book that appears or disappears between captures", () => {
    const b = capture();
    delete (b.books as any)["a.epub"];
    expect(diff(capture(), b).join("\n")).toContain("present in only one capture");
  });

  it("reports a book whose open-error changed, without drowning in style diffs", () => {
    const a = capture();
    const b = capture();
    (a.books["a.epub"] as any) = { error: "reader error: X" };
    (b.books["a.epub"] as any) = { error: "reader error: Y" };
    const d = diff(a, b);
    expect(d).toHaveLength(1);
    expect(d[0]).toContain("error changed");
  });
});

// FINDING-9 (found by the FINDING-2 dump, 2026-08-05): a compare reported 15 differences while
// running Chrome/151 against a Chrome/150 baseline, and nothing said so. WebView2 updates itself.
describe("byte-identity engine guard", () => {
  it("reports a WebView2 engine change rather than blaming our code", () => {
    const b = capture();
    b.engine = "Chrome/151.0.0.0";
    const d = diff(capture(), b).join("\n");
    expect(d).toContain("ENGINE");
    expect(d).toContain("Chrome/150.0.0.0 → Chrome/151.0.0.0");
    expect(d).toContain("re-baseline");
  });

  it("does not fire when the engine is unchanged", () => {
    expect(diff(capture(), capture()).join("\n")).not.toContain("ENGINE");
  });

  it("treats an unrecorded engine on one side as untrustworthy", () => {
    const old = capture();
    delete (old as { engine?: string }).engine;
    expect(diff(old, capture()).join("\n")).toContain("ENGINE");
  });
});

// FINDING-2: an intermittent divergence was reported once, never reproduced, and lost. `dumpDiff`
// is the fix, so it needs the same treatment `diff` gets — proven against a known difference
// offline, not trusted because it looks right.
describe("byte-identity diff dump (FINDING-2)", () => {
  const dumpDir = join(tmpdir(), `sard-dump-${process.pid}-${Math.random().toString(36).slice(2)}`);
  afterAll(() => rmSync(dumpDir, { recursive: true, force: true }));

  /**
   * Run a real diff and dump it, the way the failing compare path does. `seed` runs on BOTH
   * captures first (books present on only one side diff as a single "present in only one capture"
   * line, which is not the shape we want to exercise); `mutate` then diverges only the current one.
   */
  // `capture()` infers `books` with the single literal key "a.epub"; these tests add books, so the
  // record is widened here rather than loosening the shared helper every other test relies on.
  type Book = ReturnType<typeof capture>["books"]["a.epub"];
  type Capture = Omit<ReturnType<typeof capture>, "books"> & { books: Record<string, Book> };
  const run = (mutate: (b: Capture) => void, now = Date.now(), seed?: (b: Capture) => void) => {
    const baseline: Capture = capture();
    const current: Capture = capture();
    seed?.(baseline);
    seed?.(current);
    mutate(current);
    const problems = diff(baseline, current);
    const path = dumpDiff({ tag: "t", baseline, current, problems, dir: dumpDir, now });
    return { path, problems, dump: JSON.parse(readFileSync(path!, "utf8")) };
  };

  it("writes the complete diff, both sides of the affected book, and both configs", () => {
    const { dump, problems } = run((b) => {
      b.books["a.epub"].sample[0].fontSize = "22px";
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(dump.problemCount).toBe(problems.length);
    expect(dump.problems).toEqual(problems);
    // Both sides verbatim — the file must be re-diffable after the captures are gone.
    expect(dump.books["a.epub"].baseline.sample[0].fontSize).toBe("16px");
    expect(dump.books["a.epub"].current.sample[0].fontSize).toBe("22px");
    expect(dump.config.baseline).toEqual(capture().config);
    expect(dump.engine.current).toBe("Chrome/150.0.0.0");
  });

  it("keeps every problem when the console would truncate at 60", () => {
    // FINDING-2 itself was only 3 differences, but the console cap is the reason evidence can be
    // lost at all; a dump that inherited the cap would reintroduce the bug it exists to prevent.
    const { dump } = run(
      (b) => {
        for (let i = 0; i < 40; i++) {
          b.books[`bulk-${i}.epub`].sample[0].lineHeight = `${i + 1}px`;
          b.books[`bulk-${i}.epub`].sample[1].fontSize = `${i + 1}px`;
        }
      },
      Date.now(),
      (b) => {
        for (let i = 0; i < 40; i++) b.books[`bulk-${i}.epub`] = JSON.parse(JSON.stringify(b.books["a.epub"]));
      },
    );
    expect(dump.problemCount).toBeGreaterThan(60);
    expect(dump.problems.length).toBe(dump.problemCount);
    // The 61st problem onward is exactly what the console drops and the file must keep.
    expect(dump.problems.join("\n")).toContain("bulk-39.epub");
  });

  it("never overwrites an earlier failure", () => {
    const a = run((b) => (b.books["a.epub"].sample[0].color = "rgb(1, 1, 1)"), 1_700_000_000_000);
    const c = run((b) => (b.books["a.epub"].sample[0].color = "rgb(2, 2, 2)"), 1_700_000_060_000);
    expect(a.path).not.toBe(c.path);
    expect(existsSync(a.path!)).toBe(true);
    expect(JSON.parse(readFileSync(a.path!, "utf8")).books["a.epub"].current.sample[0].color).toBe("rgb(1, 1, 1)");
  });

  it("omits books that did not differ, so a real divergence is not buried", () => {
    // FINDING-2 was 3 differences inside a 15-book capture. Carrying the 12 identical books into
    // the dump is how 3 lines become unreadable.
    const { dump } = run(
      (b) => (b.books["a.epub"].sample[1].textIndent = "40px"),
      Date.now(),
      (b) => (b.books["quiet.epub"] = JSON.parse(JSON.stringify(b.books["a.epub"]))),
    );
    expect(Object.keys(dump.books)).toEqual(["a.epub"]);
  });

  it("returns null instead of throwing when the dump cannot be written", () => {
    // The compare path is already failing here. Losing the exit code to a disk error would be a
    // worse outcome than losing the dump, so this must degrade, never throw.
    const path = dumpDiff({
      tag: "t",
      baseline: capture(),
      current: capture(),
      problems: ["x"],
      dir: join(dumpDir, "a-file-not-a-dir", "nested"),
      now: Date.now(),
    });
    // Either it succeeded (mkdir recursive) or it degraded — what it must never do is throw.
    expect(path === null || typeof path === "string").toBe(true);
  });
});

describe("CSP harness variants", () => {
  it("declares the four variants that isolate the cause, each with a stated expectation", () => {
    expect(Object.keys(VARIANTS).sort()).toEqual(
      ["no-csp", "no-sandbox", "sard-as-shipped", "style-src-with-blob"].sort(),
    );
    for (const [name, v] of Object.entries(VARIANTS as Record<string, any>)) {
      expect(typeof v.expectApplied, `${name} must state an expectation`).toBe("boolean");
      expect(v.why, `${name} must say why it exists`).toBeTruthy();
    }
  });

  it("encodes the finding: only style-src blob: changes the outcome, not the sandbox", () => {
    const V = VARIANTS as Record<string, any>;
    expect(V["sard-as-shipped"].expectApplied).toBe(false);
    expect(V["style-src-with-blob"].expectApplied).toBe(true);
    expect(V["no-sandbox"].expectApplied).toBe(false); // the control that rules the sandbox out
    expect(V["no-csp"].expectApplied).toBe(true);
  });
});

describe.skipIf(!existsSync(BASELINE))("the captured rendering baseline", () => {
  // Read LAZILY. `describe.skipIf` still evaluates the callback at collection time, so a top-level
  // `readFileSync` here threw ENOENT and failed the whole FILE on a machine with no baseline —
  // precisely the "skips must be skips, never failures" property the suite is built on.
  const base = () => JSON.parse(readFileSync(BASELINE, "utf8"));

  it("covers every EPUB in the corpus", () => {
    expect(Object.keys(base().books).length).toBeGreaterThanOrEqual(15);
  });

  it("pins the WP-7 trap: external sheets ARE listed even though none of them apply", () => {
    // MEASURED on v1.1.0, and it corrects an assumption that would have mis-verified WP-7.
    //
    // Every book with stylesheets has them present in `document.styleSheets` — Alice 3, the Word
    // book 2, halaqat-alhatmiyya 0 (it genuinely ships none) — matching each book's CSS file count.
    // Yet RAWY-195's measurements and tests/harness/csp.mjs both show NONE of their rules reach
    // computed style. The sheet objects load and are inert.
    //
    // Consequence: `sheets` will look the SAME before and after the CSP change, so it cannot gate
    // stage 7.1. The computed-style sample is the gate. This test exists to stop anyone
    // "verifying" WP-7 by counting sheets.
    const withExternal = Object.entries(base().books as Record<string, any>).filter(
      ([, fp]) => !fp.error && fp.sheets.some((s: string) => s === "external"),
    );
    expect(withExternal.length, "most corpus books do ship stylesheets").toBeGreaterThan(10);

    // …and the inertness itself, from the other side: the sampled elements carry Sard's injected
    // font stack, never a book-declared family. If a book's CSS ever did apply, this breaks.
    for (const [file, fp] of Object.entries(base().books as Record<string, any>)) {
      if (fp.error || !fp.sample?.length) continue;
      expect(fp.sample[0].fontFamily, `${file} first sampled element`).toMatch(/Sard(Arabic|Latin)/);
    }
  });

  it("records the Arabic books as rendering RTL", () => {
    for (const file of ["poetry-rtl--shawqiyyat.epub", "rtl-declared--les-miserables.epub"]) {
      const fp = (base().books as any)[file];
      if (!fp || fp.error) continue;
      expect(fp.body.direction, file).toBe("rtl");
    }
  });
});
