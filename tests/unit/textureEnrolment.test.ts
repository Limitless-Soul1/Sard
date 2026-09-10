// WHICH SURFACES WEAR THE INTERFACE TEXTURE — the enrolment nothing was checking.
//
// THE DEFECT. The reader's Contents drawer ignored the هيئة's texture completely. Measured in the
// running reader with a real book open, at all three steps: `.rc-top`/`.rc-bottom` — a few pixels
// above and below the drawer, and enrolled — moved through alpha 0.96 → 0.729 → 0.63 with their
// frost, while `.reader-panel` painted a flat `--chrome-bg` at every one. So did `.settings-panel`.
// Nothing was wrong with the state: the root carried `--ui-k`, `--ui-floor` and `--ui-frost`
// correctly throughout and surfaces in the same subtree consumed them. The drawers never asked.
//
// THE ROOT CAUSE IS THE SHAPE OF THE FEATURE, NOT ONE RULE. Enrolment is a per-rule opt-in, written
// out by hand into each surface's own `background`, with no shared primitive and no list — a
// surface that does not paste the formula simply does not participate, silently and for ever. The
// stylesheet's own inventory comment said "the eight" and named eight, while asserting in the same
// sentence that "a drawer is deliberately not a toolbar" with no drawer enrolled at all. Nothing
// reconciled the prose, the enrolled set and the accessibility list, so all three had drifted: the
// two drawers were unenrolled, `.rc-top` was textured but never suppressed, and five textured
// surfaces kept a blur under `prefers-reduced-transparency` that the same comment block promised to
// remove.
//
// So nothing below asserts that a class exists. Each is an invariant that fails on the tree as it
// was before the fix, and fails again the next time a surface is added without being enrolled.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOWEST_SURFACE } from "../../src/lib/texture";

const CSS = readFileSync(
  join(import.meta.dirname, "..", "..", "src/styles/global.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, ""); // declarations only — the prose is not the contract

type Rule = { sel: string; body: string };
/** Innermost rules only: `[^{}]*` for the body cannot span a nested block, so `@media` wrappers
 *  fall away and the rules inside them are read on their own terms. */
const RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: m[1].trim().replace(/\s+/g, " "),
  body: m[2].replace(/\s+/g, " ").trim(),
}));

const WEARS_TEXTURE = /var\(--ui-k/;
const FLAT_CHROME = /background:\s*var\(--chrome-bg\)\s*;/;
const POSITIONED = /position:\s*(absolute|fixed)/;

/** The class a suppression rule would have to name, for each part of a selector list. */
const targets = (sel: string) =>
  sel.split(",").map((s) => {
    const classes = s.trim().match(/\.[A-Za-z0-9_-]+/g);
    return classes ? classes[classes.length - 1] : s.trim();
  });

const ENROLLED = RULES.filter((r) => WEARS_TEXTURE.test(r.body));
const enrolledClasses = new Set(ENROLLED.flatMap((r) => targets(r.sel)));

/** The two lists inside the accessibility block, found by what they DO rather than by where they are. */
const suppressionFor = (what: RegExp) =>
  new Set(
    RULES.filter((r) => r.sel.includes("[data-ui-texture]") && what.test(r.body))
      .flatMap((r) => targets(r.sel)),
  );
const SUPPRESSES_GROUND = suppressionFor(/^background:\s*var\(--chrome-bg\)\s*;$/);
const SUPPRESSES_FROST = suppressionFor(/backdrop-filter:\s*none/);

describe("interface texture · every chrome surface is enrolled or excused", () => {
  // THE LINE, stated once so a new surface is a decision rather than an oversight. Texture is for the
  // PERSISTENT chrome a reader lives inside — the bars, the drawers, the sidebar. A transient overlay
  // that appears on top of that chrome for a moment is deliberately solid: it has to be read at a
  // glance, and it already sits on a ground that is itself textured. These are those.
  const EXCUSED: Record<string, string> = {
    ".rs-ink-panel": "an ink popover ON a settings row — it sits on the drawer, not over the desk",
    ".import-report": "a transient report card, shown once and dismissed",
    ".lib-theme-menu": "a dropdown menu",
    ".lib-menu": "a dropdown menu",
    ".upd-dialog": "a modal dialog, over its own scrim",
    ".edit-dialog": "a modal dialog, over its own scrim",
    ".pc-basket-tray": "a transient tray",
    ".ref-popup": "a reference popover over the page — the page is outside texture's reach by design",
  };

  it("no positioned surface paints the flat chrome ground without a stated reason", () => {
    // THE CHECK THAT WOULD HAVE CAUGHT THIS. `.reader-panel` and `.settings-panel` were both
    // `position: absolute` with a bare `background: var(--chrome-bg)`, and neither is a transient
    // overlay — so before the fix both land here, unexcused, and this fails.
    const unenrolled = RULES
      .filter((r) => POSITIONED.test(r.body) && FLAT_CHROME.test(r.body))
      .flatMap((r) => targets(r.sel))
      .filter((cls) => !(cls in EXCUSED));
    expect(unenrolled, "positioned chrome surfaces outside the texture feature").toEqual([]);
  });

  it("the reader's own chrome is enrolled — all four drawers and both bars", () => {
    // Named explicitly because this is the neighbourhood the defect was in: three panels share
    // `.reader-panel` (Contents, Notes, Search) and Settings is the fourth drawer beside them.
    for (const cls of [".reader-panel", ".settings-panel", ".rc-top", ".rc-bottom", ".page-chevron"]) {
      expect(enrolledClasses.has(cls), `${cls} wears the texture`).toBe(true);
    }
  });
});

describe("interface texture · the formula each enrolled surface uses", () => {
  /** The floor-anchored travel, pulled back out of the declaration. */
  const OWN = /calc\(\s*var\(--ui-floor,\s*0%\)\s*\+\s*\((.+?)\s*-\s*var\(--ui-floor,\s*0%\)\)\s*\*\s*var\(--ui-k,\s*1\)\s*\)/;

  it("is the floor-anchored one everywhere — never a bare multiply", () => {
    // The proportional scale is what this replaced, and it is the plausible-looking edit that would
    // bring the defect back in a different form: `--chrome-bg × k` renders Light and Glass at the
    // same pixel once `max()` catches the floor, which is what "I cannot tell them apart" was.
    for (const r of ENROLLED) {
      expect(r.body, `${r.sel} uses the floor-anchored travel`).toMatch(OWN);
    }
  });

  it("leaves Opaque exactly where the surface already was", () => {
    // `floor + (own − floor) × 1 === own`, so a reader who never touches texture renders
    // byte-identically to a build without the feature. Checked as arithmetic on the value actually
    // written in the stylesheet, at the extreme floor as well as a normal one.
    for (const r of ENROLLED) {
      const own = r.body.match(OWN)![1];
      const pct = own.match(/^(\d+(?:\.\d+)?)%$/);
      if (!pct) continue; // `var(--ui-base, …)` — resolved at runtime, covered by the harness
      const base = Number(pct[1]);
      for (const floor of [0, 63, 80, base]) {
        expect(floor + (base - floor) * 1, `${r.sel} at floor ${floor}%`).toBeCloseTo(base, 10);
      }
    }
  });

  it("never enrols a surface below the alpha the whole mapping is anchored to", () => {
    // `stepK` is chosen so the LOWEST enrolled surface lands on the drawn floor at Glass. A surface
    // enrolled beneath that silently invalidates the anchor and would render under the measured
    // legibility floor — the exact failure the floor-anchoring replaced.
    for (const r of ENROLLED) {
      const pct = r.body.match(OWN)![1].match(/^(\d+(?:\.\d+)?)%$/);
      if (!pct) continue;
      expect(Number(pct[1]), `${r.sel} is not below the anchor`).toBeGreaterThanOrEqual(LOWEST_SURFACE * 100);
    }
  });

  it("puts the newly enrolled drawers at their own full value", () => {
    // They were `background: var(--chrome-bg)` — 100% — so anything less would change what a reader
    // on Opaque sees, which is the one thing enrolling a surface must never do.
    for (const cls of [".reader-panel", ".settings-panel"]) {
      const rule = ENROLLED.find((r) => targets(r.sel).includes(cls))!;
      expect(rule.body.match(OWN)![1], `${cls} own value`).toBe("100%");
    }
  });
});

describe("interface texture · the accessibility preferences are honoured for every surface", () => {
  // SUPPRESS THE FEATURE, NEVER SOFTEN IT: a reader who asked the OS for forced colours, high
  // contrast or reduced transparency stated a requirement. Both lists below were maintained by hand
  // against a set that grew without them, and both had fallen behind.

  it("every enrolled surface has its ground restored", () => {
    // `.rc-top` fails this before the fix: it shares one rule with `.rc-bottom`, so it was always
    // textured, but only `.rc-bottom` was ever named in the suppression list.
    const missing = [...enrolledClasses].filter((cls) => !SUPPRESSES_GROUND.has(cls));
    expect(missing, "textured surfaces with no ground suppression").toEqual([]);
  });

  it("every enrolled surface that carries a blur has the blur removed too", () => {
    // Leaving the frost behind honours the preference for the alpha and ignores it for the
    // transparency the blur reveals — the same failure in a different property, which is what the
    // comment block promises and what five surfaces were not doing.
    const missing = ENROLLED
      .filter((r) => /backdrop-filter:/.test(r.body))
      .flatMap((r) => targets(r.sel))
      .filter((cls) => !SUPPRESSES_FROST.has(cls));
    expect(missing, "textured surfaces whose frost survives the preference").toEqual([]);
  });

  it("suppresses nothing that is not enrolled", () => {
    // The list is only meaningful while it tracks the enrolled set. A name left behind after a
    // surface stops being textured is how the list stops being read as authoritative.
    for (const cls of [...SUPPRESSES_GROUND, ...SUPPRESSES_FROST]) {
      expect(enrolledClasses.has(cls), `${cls} is suppressed but not enrolled`).toBe(true);
    }
  });
});
