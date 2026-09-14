// THE REFERENCE MARK — a هيئة's optional opinion about the twin rule under a referenced word.
//
// THE CONTROLS ARE THE READER'S OWN, NOT A COPY. `RefRuleControls` is the group the in-book colour tab
// renders (RAWY-281); it is rendered here unchanged — the same swatches, the same two sliders, the
// same live sample, the same wording. This is the arrangement `VoiceSection` already has with
// `TtsTrackingControls`, and for the same reason: a second implementation would drift from the one the
// reader configures, and the drift would show as a هيئة whose mark was not quite the mark they set.
//
// WHAT THE هيئة CAN SAY ABOUT REFERENCES IS EXACTLY WHAT THE MARK HAS. The reference indicator is two
// drawn strokes, not text — there is no reference glyph, no reference face and no reference size, so
// there is nothing here to expose a font control over. Its three properties are the colour of the
// strokes and the two figures that place them: thickness and distance from the text. Both figures are
// stored as a MULTIPLE of the design value and resolved against the text's own em, which is what makes
// them the mark's typography rather than a pair of pixel numbers: they follow the reader's zoom and the
// book's face, and 100% is the design exactly at every size.
//
// THE ONE THING THIS FILE ADDS is the three-state a profile needs and a settings surface does not:
// «الافتراضيّة» — this هيئة carries no mark of its own, and activating it puts the design's back. The
// whole block is the three-state rather than each field, because `null` inside the block already means
// something ("the theme's accent", "the design's own figure"), exactly as it does for the read-aloud
// marks. Touching any control below opts in.

import { useI18n } from "../../../i18n";
import { RefRuleControls } from "../../reader/RefRuleControls";
import type { ReadingStyle } from "../../../reader-engine/injectedCss";
import { refStyleFor } from "../model/profile";
import type { Profile, ProfileRefs } from "../model/profile";

export function RefsSection({
  draft,
  patch,
  /**
   * The reader's own live mark, which the controls sit at while the هيئة has no opinion.
   *
   * The same shape the read-aloud chapter uses and for the same reason: an unset three-state that
   * showed nothing would tell the reader only that they had not chosen, never what they would be
   * changing. It is also what the block is SEEDED from, so opting in starts from the mark actually on
   * screen rather than from figures nobody chose.
   */
  readerStyle,
}: {
  draft: Profile;
  patch: (f: (d: Profile["data"]) => void) => void;
  readerStyle: ReadingStyle;
}) {
  const { t } = useI18n();
  const refs = draft.data.refs;
  const carried = refs !== null;
  const reading = draft.data.theme.reading;

  // What the controls draw: the هيئة's own mark, or the reader's while it has none.
  // THE SAME DERIVATION THE PREVIEW USES, from the one place that defines it — so the control and the
  // page beside it can never be set from two different rules.
  const shown: ReadingStyle = refStyleFor(draft, readerStyle);

  /**
   * Any change materialises the block, complete.
   *
   * The three fields are taken from `shown`, not from the defaults, so the first touch keeps the mark
   * the reader could see a moment ago and changes only what they moved. A block that arrived by
   * picking a colour would otherwise silently reset the two sizes.
   */
  const update = (p: Partial<ReadingStyle>) =>
    patch((d) => {
      const next: ProfileRefs = {
        refRuleColor: shown.refRuleColor,
        refRuleWeight: shown.refRuleWeight,
        refRuleOffset: shown.refRuleOffset,
      };
      d.refs = { ...next, ...(p as Partial<ProfileRefs>) };
    });

  return (
    <div className="pf-ms">
      <div className="pf-ms-hint">{t("profiles.refs.hint")}</div>

      {/* The same head the measure and read-aloud rows carry, so the way back is where the reader has
          already learned it. It governs the whole group, which is why it stands above rather than in
          a row. */}
      <div className={`pf-ms-row${carried ? " on" : ""}`}>
        <div className="pf-ms-head">
          <span className="pf-ms-label">{t("profiles.refs.label")}</span>
          <span className={`pf-ms-value${carried ? "" : " off"}`}>
            {carried ? t("profiles.refs.carried") : t("profiles.refs.follows")}
          </span>
          {carried && (
            <button
              className="pf-ms-clear"
              onClick={() => patch((d) => { d.refs = null; })}
              title={t("profiles.refs.clear")}
            >
              {t("profiles.refs.follows")}
            </button>
          )}
        </div>
      </div>

      {/* THE BOOK'S OWN PALETTE, not the library's. The mark is drawn on the page, so the swatch that
          means "the theme's own colour" has to be the READING accent — the one the preview beside this
          chapter draws the rules in — and the presets have to be judged against the reading paper's
          polarity, exactly as the read-aloud chapter does it. */}
      <RefRuleControls
        style={shown}
        update={update}
        accent={reading.colors.accent}
        dark={reading.dark}
        t={t}
      />
    </div>
  );
}
