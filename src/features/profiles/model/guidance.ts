// PROFILES — contrast guidance that repairs rather than refuses.
//
// THE HOUSE RULE, and it is not new. Sard already resolves an unreadable colour three times, in
// three places, the same way every time: keep the reader's colour when it clears the floor, and
// otherwise carry it toward legibility in 5% steps, stopping at the FIRST step that clears.
//
//   `resolveReadMarker`  (theme/applyTheme.ts)  the chapter marker on chrome, 3:1
//   `regroundFaint`      (lib/background.ts)    `--lib-faint` over a photograph, 3:1
//   `resolveMarkOnGround`(lib/highlightInk.ts)  an on-page mark against the paper, 3:1
//
// The comment on the first states why the step matters: it is what lets "each theme keep as much of
// Sard's terracotta identity as it can, instead of the marker turning flatly grey". A single jump to
// black would always clear and would always be wrong.
//
// WHAT IS DIFFERENT HERE. Those three REPLACE a colour silently, because they are protecting a mark
// the reader never chose. This one does not replace anything: the reader picked this ink on purpose,
// so the verdict is reported and the repair is OFFERED. Nothing here writes a colour.

import { contrast, isHex, luminance, mix } from "./palette";

/** Body text on its own ground. */
export const AA_TEXT = 4.5;
/** Body text where Sard holds itself to the higher standard — the reading page. */
export const AAA_TEXT = 7;
/** Non-text: rules, marks, indicators. WCAG 1.4.11. */
export const NON_TEXT = 3;

/** How far each step moves toward legibility. Matches the three existing resolvers exactly. */
const STEP = 0.05;

export interface Verdict {
  /** The measured WCAG ratio, 1..21. Shown to the reader — never rounded away to a verdict alone. */
  ratio: number;
  /** The floor this pairing is held to. */
  floor: number;
  /** Whether the reader's own colour clears it. */
  passes: boolean;
  /**
   * The nearest colour that clears, keeping as much of the reader's hue as the floor allows —
   * or `null` when their colour already clears and nothing needs offering.
   */
  nearest: string | null;
}

/**
 * Judge an ink against a ground, and offer the smallest repair if it fails.
 *
 * The repair carries the ink toward whichever pole is further from the GROUND — black on a light
 * ground, white on a dark one — so it always converges, and stops at the first 5% step that clears.
 * That keeps the reader's hue as far as it can be kept: a terracotta that fails on ivory comes back
 * a deeper terracotta, not grey.
 */
export function guide(ink: string, ground: string, floor: number = AA_TEXT): Verdict {
  if (!isHex(ink) || !isHex(ground)) {
    // A malformed colour is not a contrast question. Report it as failing with nothing to offer
    // rather than inventing a repair for a value that should never have reached here.
    return { ratio: 1, floor, passes: false, nearest: null };
  }

  const ratio = contrast(ink, ground);
  if (ratio >= floor) return { ratio, floor, passes: true, nearest: null };

  // Away from the ground, not away from the ink: on a light page the ink must get darker, on a dark
  // page lighter, regardless of what the reader picked.
  const pole = luminance(ground) > 0.5 ? "#000000" : "#FFFFFF";
  for (let k = STEP; k <= 1.0001; k += STEP) {
    const candidate = mix(ink, pole, k);
    if (contrast(candidate, ground) >= floor) {
      return { ratio, floor, passes: false, nearest: candidate };
    }
  }
  // Unreachable in practice — the pole itself is the maximum available contrast against any ground,
  // and every floor Sard uses is below 21. Returned rather than thrown so a guidance call can never
  // be the thing that breaks an editor.
  return { ratio, floor, passes: false, nearest: pole };
}

/**
 * What a custom palette is judged on.
 *
 * TWO GATES AND TWO READINGS, and the split is measured rather than chosen. Holding the whole
 * palette to AA would declare most of Sard unreadable:
 *
 *   muted on paper   Sepia 2.98 · Linen 3.04 · Rose Quartz 3.33 · Ivory 3.43 · Sage 3.44 ·
 *                    Parchment 3.49 — SIX of the seven light themes sit below AA, and `global.css`
 *                    records the same fact from the other side: `--lib-faint` measures 1.88–3.51:1
 *                    and is under 3:1 on thirteen of the sixteen.
 *   accent on chrome Parchment 2.79 — below the non-text floor, and `applyTheme.ts` names it
 *                    explicitly as a TOKEN-CEILING failure that alpha cannot rescue.
 *
 * Neither is a defect. Sard repairs the MARKS derived from those colours — `resolveReadMarker`
 * blends the chapter marker until it clears, `regroundFaint` re-inks `--lib-faint` over a
 * photograph — and leaves the source colour alone, precisely so a theme keeps its identity. A
 * profile editor that refused what Sard itself ships would be wrong about the product.
 *
 * So the gates are the two pairings that carry BODY TEXT and that nothing downstream repairs.
 */
export interface PaletteVerdicts {
  /** GATE. Body text on the page; Sard holds the reading surface to AAA. */
  textOnPaper: Verdict;
  /** GATE. Body text on panels — menus, bars, the sidebar. AA. */
  textOnChrome: Verdict;
  /**
   * READING, not a gate. Secondary text — small titles, counts. Shown at the non-text floor because
   * that is the honest bar for it, and most shipped themes still sit near or below it. When it
   * fails, what the reader should see is "this will read faintly", not "this is not allowed".
   */
  mutedOnPaper: Verdict;
  /**
   * READING, not a gate. The accent against chrome. `--read-marker` is derived from it and IS
   * repaired to clear 3:1; the accent itself is left as the reader chose it.
   */
  accentOnChrome: Verdict;
}

export function judgePalette(c: {
  paperBg: string;
  chromeBg: string;
  text: string;
  muted: string;
  accent: string;
}): PaletteVerdicts {
  return {
    textOnPaper: guide(c.text, c.paperBg, AAA_TEXT),
    textOnChrome: guide(c.text, c.chromeBg, AA_TEXT),
    mutedOnPaper: guide(c.muted, c.paperBg, NON_TEXT),
    accentOnChrome: guide(c.accent, c.chromeBg, NON_TEXT),
  };
}

/**
 * Whether the theme's BODY TEXT reads — what decides if a profile card carries a quiet mark.
 *
 * Deliberately the two gates only. Every one of the sixteen shipped themes satisfies this, which is
 * the test that matters: the standard a generated theme is held to is the standard Sard meets.
 */
export const paletteReads = (v: PaletteVerdicts): boolean =>
  v.textOnPaper.passes && v.textOnChrome.passes;
