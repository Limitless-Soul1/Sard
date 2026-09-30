// THE MEASUREMENT PASS — what Sard tells the reader about a design, and nothing it does to one.
//
// NOTHING IN THIS FILE RETURNS A COLOUR THAT IS THEN STORED. It answers questions: what does this
// palette measure, what will actually be drawn, and does the author's own arithmetic agree with
// Sard's. Every value it produces is for display. A reviewer asking "could this module change a
// design" has one thing to check — no caller is given anything to write, because the return type
// holds numbers and notes rather than a هيئة.
//
// IT CALLS THE REAL RENDERING PATH RATHER THAN IMITATING IT. `themeVars` is the function that turns
// a palette into the CSS custom properties the application sets, and it is pure. Calling it is how
// this pass knows what `--muted` and the two progress-mark registers will actually be, instead of
// re-deriving them here and drifting from the product on the first change. `libraryColors` is called
// for the same reason: a design that set `relief` asked for its panel to move, so the library's
// chrome as DRAWN is what the interface ratios must be measured against.
//
// TWO NUMBERS FOR SOME PAIRS, AND THAT IS THE POINT. A pair whose ink Sard resolves at render time
// has both an AUTHORED ratio — what the design says, which is what its author was claiming about —
// and a DRAWN ratio, which is what the reader will see. Reporting only the first would be a lie
// about the screen; reporting only the second would be a lie about the design. Today this affects
// `muted` alone, and it is long-standing behaviour that applies to every هيئة in Sard.
//
// PURE. No stores, no filesystem, no IPC, no DOM.

import { contrastRatio } from "../../../../lib/contrast";
import { themeVars } from "../../../../theme/applyTheme";
import type { Theme, ThemeColors } from "../../../../theme/tokens";
import { AA_TEXT, AAA_TEXT, NON_TEXT } from "../guidance";
import { libraryColors, type ProfileData } from "../profile";
import { CHECK_PAIRS, SCOPES, type Scope } from "./recipe";

/** One measured pair: its ink, its ground, the ratio, and the floor it is held against. */
export interface PairMeasure {
  /** `readingTextOnPaper` and the eleven others — the same names the brief publishes. */
  name: string;
  scope: Scope;
  ink: string;
  ground: string;
  /** As authored. This is the number the design's own `checks` was claiming about. */
  ratio: number;
  floor: number;
  /** Whether the AUTHORED ink clears the floor — what the design itself achieved. */
  meetsFloor: boolean;
  /** Present only when rendering resolves this ink to something else — `muted`, today. */
  drawnInk?: string;
  drawnRatio?: number;
  /**
   * Whether what the READER WILL SEE clears the floor.
   *
   * Identical to `meetsFloor` for every pair Sard does not resolve, which is most of them. It exists
   * because the two genuinely differ, and the difference is not hypothetical: Sard's OWN default
   * palette authors a `muted` at 2.92 against the desk, below the 3.0 floor, and the long-standing
   * resolver draws it clear. Reporting only the authored number would put a warning on the paper
   * Sard itself ships, which would teach a reader to ignore the warning.
   */
  meetsFloorDrawn: boolean;
}

/** A token whose drawn value differs from the palette's own. Long-standing behaviour, disclosed. */
export interface ResolvedNote {
  scope: Scope;
  token: "muted" | "readMarker" | "readMarkerQuiet";
  /** The colour the design authored, or the one the register derives from. */
  from: string;
  /** What `themeVars` resolves it to — exactly what the application will set. */
  drawn: string;
  /** `false` when the authored colour already cleared its floor and is drawn untouched. */
  moved: boolean;
}

/** The author's arithmetic, beside Sard's. Neither is used for any decision. */
export interface ClaimComparison {
  name: string;
  claimed: number;
  measured: number;
  agrees: boolean;
}

export interface Measurement {
  pairs: PairMeasure[];
  resolved: ResolvedNote[];
  claims: ClaimComparison[];
  /** Claim names Sard does not compute. Not a fault — reported so nothing looks silently ignored. */
  unmatchedClaims: string[];
  /** True when at least one pair, AS THE READER WILL SEE IT, falls below its floor. The report's lead. */
  anyBelowFloor: boolean;
  /** True when the design as AUTHORED falls short somewhere, even if rendering draws it clear. */
  anyAuthoredBelowFloor: boolean;
  /** True when a majority of comparable claims disagree — the tell that arithmetic was guessed. */
  claimsUnreliable: boolean;
}

/**
 * How close a claimed ratio must be to count as agreeing.
 *
 * Wide enough for honest rounding — a model reporting 13.8 for 13.82 did the work — and far too
 * narrow for a guess. The research phase measured the failure this exists to catch: one model
 * claimed 7.81 where the true value was 17.80, and 3.06 and 3.17 against floors of 3.0. It had
 * computed nothing; it had produced numbers shaped like a passing grade.
 */
export const CLAIM_TOLERANCE = 0.15;

/** Which floor each pair is held to, by the pair's own name. Read from the guidance module. */
const FLOORS: Record<(typeof CHECK_PAIRS)[number], number> = {
  TextOnPaper: AAA_TEXT,
  TextOnChrome: AA_TEXT,
  MutedOnPaper: NON_TEXT,
  MutedOnChrome: NON_TEXT,
  MutedOnSurface: NON_TEXT,
  AccentOnChrome: NON_TEXT,
};

/** The ink and ground each pair compares, so the twelve are described once rather than twice. */
const SOURCES: Record<(typeof CHECK_PAIRS)[number], { ink: keyof ThemeColors; ground: keyof ThemeColors }> = {
  TextOnPaper: { ink: "text", ground: "paperBg" },
  TextOnChrome: { ink: "text", ground: "chromeBg" },
  MutedOnPaper: { ink: "muted", ground: "paperBg" },
  MutedOnChrome: { ink: "muted", ground: "chromeBg" },
  MutedOnSurface: { ink: "muted", ground: "surfaceBg" },
  AccentOnChrome: { ink: "accent", ground: "chromeBg" },
};

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The palette as it will actually be DRAWN for a scope.
 *
 * The library's own helper is called for the library, because a design that set `relief` asked for
 * its panels to stand off the desk — that is the design speaking, not Sard correcting it, and the
 * interface ratios have to be measured against the chrome the reader will see. The reading palette
 * has no such control (`profileReadingTheme` does not apply relief), so it is its own colours.
 */
function drawnColors(data: ProfileData, scope: Scope): ThemeColors {
  return scope === "library" ? libraryColors(data.theme.library) : data.theme.reading.colors;
}

/**
 * The CSS custom properties this palette resolves to.
 *
 * `themeVars` reads only `colors` — the id and name below are placeholders it never looks at — so
 * this is the product's own resolution rather than a second implementation of it.
 */
function varsFor(colors: ThemeColors, dark: boolean): Record<string, string> {
  const theme = { id: "ivory", name: "", dark, colors } as unknown as Theme;
  return themeVars(theme);
}

/**
 * Measure an appearance. Reports; changes nothing.
 *
 * `claims` is whatever the design said about itself, carried through the translator untouched. It is
 * compared and displayed and never read for a decision.
 */
export function measureAppearance(
  data: ProfileData,
  claims: Record<string, number> = {},
): Measurement {
  const pairs: PairMeasure[] = [];
  const resolved: ResolvedNote[] = [];

  for (const scope of SCOPES) {
    const colors = drawnColors(data, scope);
    const vars = varsFor(colors, data.theme[scope].dark);
    const drawnMuted = vars["--muted"];

    for (const pair of CHECK_PAIRS) {
      const { ink, ground } = SOURCES[pair];
      const inkHex = colors[ink] as string;
      const groundHex = colors[ground] as string;
      if (typeof inkHex !== "string" || typeof groundHex !== "string") continue;
      const floor = FLOORS[pair];
      const ratio = round(contrastRatio(inkHex, groundHex));
      const m: PairMeasure = {
        name: `${scope}${pair}`,
        scope,
        ink: inkHex,
        ground: groundHex,
        ratio,
        floor,
        meetsFloor: ratio >= floor,
        meetsFloorDrawn: ratio >= floor,
      };
      // Only `muted` is resolved at render time today. Where it is, the reader is shown both.
      if (ink === "muted" && drawnMuted && drawnMuted !== inkHex) {
        m.drawnInk = drawnMuted;
        m.drawnRatio = round(contrastRatio(drawnMuted, groundHex));
        m.meetsFloorDrawn = m.drawnRatio >= floor;
      }
      pairs.push(m);
    }

    resolved.push({
      scope,
      token: "muted",
      from: colors.muted,
      drawn: drawnMuted ?? colors.muted,
      moved: !!drawnMuted && drawnMuted !== colors.muted,
    });
    // The progress marks have no colour of their own: they are derived from the accent and the RAW
    // muted against the panel. Reported so a reader can see where those two colours end up.
    resolved.push({
      scope, token: "readMarker", from: colors.accent,
      drawn: vars["--read-marker"] ?? colors.accent,
      moved: vars["--read-marker"] !== colors.accent,
    });
    resolved.push({
      scope, token: "readMarkerQuiet", from: colors.muted,
      drawn: vars["--read-marker-quiet"] ?? colors.muted,
      moved: vars["--read-marker-quiet"] !== colors.muted,
    });
  }

  const byName = new Map(pairs.map((p) => [p.name, p]));
  const comparisons: ClaimComparison[] = [];
  const unmatched: string[] = [];
  for (const [name, claimed] of Object.entries(claims)) {
    const measured = byName.get(name);
    if (!measured) {
      unmatched.push(name);
      continue;
    }
    comparisons.push({
      name,
      claimed,
      measured: measured.ratio,
      // ROUNDED BEFORE COMPARING, at the same two decimals the ratios are reported at. Without it
      // the boundary is decided by floating-point noise: 13.82 and 13.97 differ by exactly 0.15 to
      // a reader and by 0.15000000000000036 to the machine, so a claim on the line would agree or
      // disagree depending on which numbers it happened to be about. The rule a person can state —
      // "within 0.15 at the precision Sard shows" — is the rule the code should keep.
      agrees: round(Math.abs(measured.ratio - claimed)) <= CLAIM_TOLERANCE,
    });
  }

  const disagreeing = comparisons.filter((c) => !c.agrees).length;
  return {
    pairs,
    resolved,
    claims: comparisons,
    unmatchedClaims: unmatched,
    anyBelowFloor: pairs.some((p) => !p.meetsFloorDrawn),
    anyAuthoredBelowFloor: pairs.some((p) => !p.meetsFloor),
    // A single wrong number is a slip. Most of them wrong means the arithmetic was never done, and
    // that is worth telling the reader — calmly, and about the AUTHOR rather than about the design.
    claimsUnreliable: comparisons.length > 0 && disagreeing * 2 > comparisons.length,
  };
}
