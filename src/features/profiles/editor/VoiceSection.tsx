// THE READ-ALOUD MARKS — a هيئة's optional opinion about the reading cursor.
//
// THE CONTROLS ARE THE READER'S OWN, NOT A COPY. `TtsTrackingControls` is the component the in-book
// panel and Global Settings both render (RAWY-200), and it is rendered here unchanged: the same
// swatches, the same sliders, the same contrast guard, the same wording. Recreating it would have
// given this chapter a second implementation of a look the two other surfaces already agree on, and
// the drift would have shown up as a هيئة whose marks were not quite the marks the reader configured.
//
// THE ONE THING THIS FILE ADDS is the three-state a profile needs and a settings surface does not:
// «الافتراضيّة» — this هيئة carries no marks of its own, and activating it puts them back to
// Sard's. The measure chapter spells that per field; here it is the whole block, because `null` inside
// the block already means "the theme's own colour" (see `ProfileVoice`). So the header row says which
// of the two states the هيئة is in and offers the way back, and touching any control below opts in.
//
// IT IS NOT "LEAVE THEM ALONE", and the difference is the point: a هيئة is a complete look, so one
// that carries no marks must not be worn in the marks of the هيئة before it. `readingPatch` writes
// all seven either way — see the note there.

import { useI18n } from "../../../i18n";
import { TtsTrackingControls } from "../../reader/TtsTrackingControls";
import type { ReadingStyle } from "../../../reader-engine/injectedCss";
import type { Profile, ProfileVoice } from "../model/profile";

export function VoiceSection({
  draft,
  patch,
  /**
   * The reader's own live marks, which the controls sit at while the هيئة has no opinion.
   *
   * The same shape the measure chapter uses, and for the same reason: a three-state control whose
   * unset state shows nothing tells the reader only that they have not chosen, never what they would
   * be changing. Here it does one more thing — it is what the block is SEEDED from, so opting in
   * starts from the marks that are actually on screen rather than from a set of defaults nobody
   * chose.
   *
   * IT IS WHAT THE CONTROLS SHOW, NOT WHAT ACTIVATION WOULD ASSERT. A هيئة carrying nothing activates
   * to Sard's own marks; what the reader happens to be reading with today is what they would be
   * departing from, which is the more useful thing to draw while they decide.
   */
  readerStyle,
}: {
  draft: Profile;
  patch: (f: (d: Profile["data"]) => void) => void;
  readerStyle: ReadingStyle;
}) {
  const { t } = useI18n();
  const voice = draft.data.voice;
  const carried = voice !== null;
  const reading = draft.data.theme.reading;

  // What the controls draw: the هيئة's own marks, or the reader's while it has none.
  const shown: ReadingStyle = carried ? { ...readerStyle, ...voice } : readerStyle;

  /**
   * Any change materialises the block, complete.
   *
   * The seven fields are taken from `shown` and not from the defaults, so the first touch keeps every
   * mark the reader could see a moment ago and changes only the one they moved. A block that arrived
   * by picking one colour would otherwise silently reset the other six.
   */
  const update = (p: Partial<ReadingStyle>) =>
    patch((d) => {
      const next: ProfileVoice = {
        ttsSpotlightOn: shown.ttsSpotlightOn,
        ttsSpotlightColor: shown.ttsSpotlightColor,
        ttsSpotlightOpacity: shown.ttsSpotlightOpacity,
        ttsSpotlightRule: shown.ttsSpotlightRule,
        ttsKaraokeOn: shown.ttsKaraokeOn,
        ttsKaraokeColor: shown.ttsKaraokeColor,
        ttsKaraokeOpacity: shown.ttsKaraokeOpacity,
      };
      d.voice = { ...next, ...(p as Partial<ProfileVoice>) };
    });

  return (
    <div className="pf-ms">
      <div className="pf-ms-hint">{t("profiles.voice.hint")}</div>

      {/* The same head the measure rows carry, so the way back is in the place the reader has already
          learned it. It governs the whole group rather than one control, which is why it stands above
          them instead of inside a row. */}
      <div className={`pf-ms-row${carried ? " on" : ""}`}>
        <div className="pf-ms-head">
          <span className="pf-ms-label">{t("profiles.voice.label")}</span>
          <span className={`pf-ms-value${carried ? "" : " off"}`}>
            {carried ? t("profiles.voice.carried") : t("profiles.voice.follows")}
          </span>
          {carried && (
            <button
              className="pf-ms-clear"
              onClick={() => patch((d) => { d.voice = null; })}
              title={t("profiles.voice.clear")}
            >
              {t("profiles.voice.follows")}
            </button>
          )}
        </div>
      </div>

      {/* THE BOOK'S OWN PALETTE, not the library's. These marks are drawn on the page, so the
          contrast guard has to be told about the paper they will actually sit on and the ink they
          have to stay readable behind — the reading palette, exactly as the preview beside this
          chapter draws it. */}
      <TtsTrackingControls
        style={shown}
        update={update}
        dark={reading.dark}
        paperBg={reading.colors.paperBg}
        themeInk={reading.colors.text}
        deskBg={reading.colors.surfaceBg}
      />
    </div>
  );
}
