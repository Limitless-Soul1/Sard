// READING A PASTED DESIGN — everything Quick Customization decides before anything is kept.
//
// WHY THIS IS NOT IN THE SHEET. "Reading a design must not create a هيئة" is a promise, and a
// promise inside a component is checked by reading the component carefully. Here it is a property of
// the code instead: this module cannot create anything, because it imports no store, no IPC and no
// filesystem. There is nothing for it to write to.
//
// That is the same reason `inspectPackage` is pure — the import sheet's own rule is that nothing
// reaches the database until the reader has seen what arrived and said yes, and a pure read step is
// how that rule stops depending on anyone remembering it.

import { measureAppearance } from "./measure";
import { PALETTE_KEYS, REFERENCE_KEYS, VOICE_KEYS, inspectRecipe, type Refusal } from "./recipe";
import { buildReport, type ReportLine } from "./report";
import { translateRecipe, type Translation } from "./translate";

export type ReadOutcome =
  /** The whole document was turned away. Four reasons only — see `inspectRecipe`. */
  | { ok: false; refusal: Refusal; detail: string | null }
  /** A design was understood. Nothing has been created; `out.data` is a هيئة nobody owns yet. */
  | {
      ok: true;
      out: Translation;
      report: ReportLine[];
      /**
       * WHICH BLOCKS THE DESIGN ACTUALLY SPOKE ABOUT.
       *
       * A recipe is translated into a COMPLETE `ProfileData` — every field it did not mention takes
       * Sard's own default, which is right when a design becomes a هيئة of its own. It is wrong when
       * the design is being brought into a draft somebody is already working on: a design that says
       * nothing about the background would silently undo the presence and blur they had just tuned
       * by hand, which reads as "the design did not apply" when in fact it applied too much.
       *
       * So the caller is told what was stated. Blocks named here come from the design; blocks absent
       * from it are left exactly as the reader had them.
       */
      stated: readonly string[];
    };

/**
 * Read pasted text as a design.
 *
 * Two gates in the order `package.ts` established: `inspectRecipe` refuses a whole document in
 * words, and `translateRecipe` reports on each field. Neither alters a value — a field Sard cannot
 * represent is dropped and named, and the reader's own value stands in its place.
 */
export function readPastedDesign(text: string): ReadOutcome {
  const seen = inspectRecipe(text);
  if (!seen.ok) {
    return {
      ok: false,
      refusal: seen.refusal,
      // The one detail worth showing beside the sentence: which field reached too far, or which
      // version was asked for. Everything else the refusal says, it says in its own words.
      detail:
        "field" in seen.refusal ? seen.refusal.field
          : "found" in seen.refusal ? seen.refusal.found
            : null,
    };
  }
  const out = translateRecipe(seen.raw, seen.findings);
  /**
   * NAMING A FIELD IS NOT THE SAME AS SAYING SOMETHING, and the difference was a real defect.
   *
   * `stated` decides which blocks the caller copies into a draft the reader is already working on.
   * It was every top-level key the document mentioned — but a translated recipe is a COMPLETE هيئة,
   * so a key whose value did not survive translation carries SARD'S DEFAULT rather than nothing.
   * Copying it therefore replaced the reader's own value with a default, which is precisely what the
   * drop contract promises will not happen.
   *
   * MEASURED, in the running application: an appearance whose texture the reader had set to `glass`,
   * given a recipe asking for `"texture": "frosted"`, came back `opaque`. The value was correctly
   * dropped and correctly reported — and then applied anyway, as a default wearing the design's name.
   *
   * A drop finding's `path` is the exact field, so a top-level scalar that was dropped is named here
   * and leaves. A field dropped INSIDE a block (`palette.reading.accent`) does not match the block's
   * own key, so the block stays stated and its surviving siblings still apply — which is the
   * one-bad-field-among-many rule, unchanged.
   */
  const lost = new Set(out.findings.filter((f) => f.kind === "drop").map((f) => f.path));
  /**
   * AND A BLOCK IS ONLY STATED IF SOMETHING INSIDE IT SURVIVED.
   *
   * The scalar rule above closed the case where the dropped field IS the key. A block has the same
   * hole one level down, and it is worse: `voice` with four bad colours, or `palette.reading` with
   * every colour malformed, was still reported as spoken about — so the caller copied a block that
   * had become Sard's own defaults. Measured on this branch: a reading palette in which every colour
   * was invalid came back with `paperBg` at Sard's `#F5EEDD`, and `voice` and `reference` came back
   * `null`, each wiping whatever the reader had set by hand.
   *
   * "Something survived" is asked of the fields the recipe actually NAMED, against the names this
   * dialect knows: a block of pure nonsense says nothing, and one good colour among four bad ones is
   * still a design speaking — which is the one-bad-field rule, unchanged.
   */
  const survived = (prefix: string, known: readonly string[]): boolean => {
    const block = seen.raw[prefix.includes(".") ? prefix.split(".")[0] : prefix];
    if (!block || typeof block !== "object") return false;
    const o = (prefix.includes(".")
      ? (block as Record<string, unknown>)[prefix.split(".")[1]]
      : block) as Record<string, unknown> | undefined;
    if (!o || typeof o !== "object") return false;
    return Object.keys(o).some(
      (k) => known.includes(k) && o[k] !== undefined && !lost.has(`${prefix}.${k}`),
    );
  };
  const stated: string[] = Object.keys(seen.raw)
    .filter((k) => seen.raw[k] !== undefined && !lost.has(k))
    .filter((k) => (k === "voice" ? survived("voice", VOICE_KEYS)
      : k === "reference" ? survived("reference", REFERENCE_KEYS)
        : true));
  for (const block of ["palette"] as const) {
    const v = seen.raw[block];
    if (v && typeof v === "object") {
      for (const scope of ["library", "reading"]) {
        if ((v as Record<string, unknown>)[scope] === undefined) continue;
        // Same rule, per surface: a palette in which nothing survived is not a palette the design
        // stated, and copying it would hand the reader Sard's defaults under the design's name.
        if (survived(`${block}.${scope}`, PALETTE_KEYS)) stated.push(`${block}.${scope}`);
      }
    }
  }
  return {
    ok: true,
    out,
    report: buildReport(out.findings, measureAppearance(out.data, out.claims)),
    stated,
  };
}
