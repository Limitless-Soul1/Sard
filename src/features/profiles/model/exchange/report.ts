// WHAT TO TELL THE READER ABOUT AN ARRIVING DESIGN — and nothing about how to draw it.
//
// THE BOUNDARY THIS FILE RESPECTS. Quick Customization is an entry point into the Appearance
// settings that already exist. A recipe is parsed into an ORDINARY هيئة, shown in the preview Sard
// already has, and saved through the path every other هيئة takes. There is no second Appearance
// system, no second renderer, and no "AI appearance" — so this module deliberately owns none of
// that. It answers one question the existing editor cannot: a design that came from outside may
// have asked for things this copy could not carry, and the reader should be told which.
//
// AN EARLIER DRAFT OF THIS FILE ALSO RESOLVED THE PALETTE and handed the faces their colours. That
// was a second renderer wearing a helpful name, and it raised a question about matching the editor's
// own stage that should never have been asked: the preview is the editor's stage, showing an
// ordinary هيئة, and an imported design is previewed exactly as a hand-made one is. Whatever the
// stage does, it does for both. That is the correct answer and it needs no new decision.
//
// STRUCTURED, NOT WRITTEN. Each line carries what happened and the values involved; none carries a
// sentence. Wording belongs with the interface, in the reader's own language.
//
// PURE. No DOM, no stores, no IPC.

import type { Measurement } from "./measure";
import type { Finding, Scope } from "./recipe";

export type ReportLine =
  /** The page's ink, always — good news or bad. Stating it only when poor makes absence the warning. */
  | { kind: "pageInk"; ratio: number; floor: number; meets: boolean }
  /** Fields Sard could not represent. The reader's own values stand in their place. */
  | { kind: "dropped"; count: number; findings: Finding[] }
  /** Fields a هيئة owns that SARD-THEME/1 cannot carry — asked for reasonably, not invented. */
  | { kind: "notExpressible"; count: number; findings: Finding[] }
  /** A palette that says one polarity and whose paper measures the other. Reported, not corrected. */
  | { kind: "polarity"; findings: Finding[] }
  /**
   * An existing Sard rendering rule moved a colour — `muted` and the progress-mark registers.
   *
   * NOT AN AI-SPECIFIC CORRECTION. It is how every appearance in Sard is drawn, including ones made
   * by hand, and it is reported here only because a reader meeting an unfamiliar design is owed the
   * same information the designer was given in the brief.
   */
  | { kind: "resolved"; scope: Scope; token: string; from: string; drawn: string }
  /** The author's arithmetic disagreed with Sard's, mostly. A fact about the author, not the design. */
  | { kind: "claimsDisagree"; count: number; worst: { name: string; claimed: number; measured: number } };

/**
 * What there is to say about a design that just arrived.
 *
 * `findings` come from the translator and `measurement` from the measurement pass, both untouched.
 * Nothing here reads either for a decision, and nothing here can alter a هيئة — it is handed none.
 */
export function buildReport(
  findings: readonly Finding[] = [],
  measurement?: Measurement,
): ReportLine[] {
  const out: ReportLine[] = [];

  if (measurement) {
    const page = measurement.pairs.find((p) => p.name === "readingTextOnPaper");
    if (page) out.push({ kind: "pageInk", ratio: page.ratio, floor: page.floor, meets: page.meetsFloorDrawn });

    for (const note of measurement.resolved) {
      if (note.moved) {
        out.push({ kind: "resolved", scope: note.scope, token: note.token, from: note.from, drawn: note.drawn });
      }
    }

    const off = measurement.claims.filter((c) => !c.agrees);
    if (measurement.claimsUnreliable && off.length > 0) {
      const worst = off.reduce((a, b) =>
        Math.abs(a.measured - a.claimed) >= Math.abs(b.measured - b.claimed) ? a : b);
      out.push({
        kind: "claimsDisagree",
        count: off.length,
        worst: { name: worst.name, claimed: worst.claimed, measured: worst.measured },
      });
    }
  }

  // Two counts, kept apart, because they are different news. An invented field means the author was
  // guessing; a field this dialect cannot carry means they asked for something reasonable.
  const notExpressible = findings.filter((f) => f.code === "rcp.drop.notExpressible");
  const dropped = findings.filter((f) => f.kind === "drop" && f.code !== "rcp.drop.notExpressible");
  if (dropped.length > 0) out.push({ kind: "dropped", count: dropped.length, findings: dropped });
  if (notExpressible.length > 0) {
    out.push({ kind: "notExpressible", count: notExpressible.length, findings: notExpressible });
  }

  const polarity = findings.filter((f) => f.code === "rcp.note.polarity");
  if (polarity.length > 0) out.push({ kind: "polarity", findings: polarity });

  return out;
}

/** True when a design arrived with nothing to report — the common, quiet case. */
export const isClean = (r: readonly ReportLine[]): boolean =>
  r.every((l) => l.kind === "pageInk" && l.meets);
