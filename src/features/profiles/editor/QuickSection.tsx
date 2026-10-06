// QUICK CUSTOMIZATION — one chapter of the appearance editor, and a door rather than a second editor.
//
// TWO BANDS, IN THIS ORDER, AND THE ORDER IS THE POINT.
//
//   THE DESIGN   a brief out and a recipe back, writing the VISUAL IDENTITY into the draft: both
//                palettes, the marks' colours, the texture. Then the picture it was designed
//                against, and how the reader shows it.
//   YOUR TYPE    the faces and the text size — the reader's own, rendered here by the very
//                components the Fonts and measure chapters use, against the same draft.
//
// A PLACE TO FINISH A هيئة, NOT A SIGNPOST TO FIVE OTHERS. An earlier version of this chapter put a
// compact picture chooser here and sent the reader to «الخلفية» for everything else about that
// picture — how present it is, how far it is blurred, what the book page wears. Tested in the
// running application that reads as a landing page: the one chapter meant to get a هيئة finished
// could not finish one. So the controls are HERE, and they are the background chapter's own
// `BackgroundSection`s and the book palette's own `InlineColours`, over this same draft. Moving a
// slider here moves the same value the other chapter shows, because it IS that control.
//
// THE STEPS OF THE FIRST BAND ARE A SEQUENCE, and the picture has to come first. The brief publishes
// what Sard MEASURED about the bound picture — its dimensions, its mean luminance — so a brief copied
// before a picture is bound truthfully reports knowing nothing about the very thing the design is
// meant to be built around.
//
// WHAT THE READER MAY TOUCH HERE IS NOT WHAT A DESIGN MAY TOUCH. The treatment controls in this
// chapter are the reader's: presence, blur, the focal point, the page's solidity. A recipe still
// cannot carry any of them — `translateRecipe` has no branch that reaches `bg` — and putting the
// controls on this page changes nothing about that. The two facts are independent and both hold.
//
// WHY THE SECOND BAND IS SAFE FROM THE FIRST. Not because this file is careful: because the dialect
// cannot carry a typographic field at all. `translateRecipe` writes `theme`, `voice`, `refs` and
// `texture`, and there is no branch in it that can reach `type`. The guarantee is structural, and
// `exchangeQuick.test.ts` asserts it rather than trusting this comment.
//
// THIS CHAPTER OWNS NO RENDERER AND NO COLOUR CONTROL. The stage on the right is the editor's. A
// colour the design set is edited in the chapter that already owns it — Library colours, Book
// colours, Marks, Read-aloud, References, Texture — and «ما تغيّر» links straight there. Duplicating
// even one swatch here would make two places to change one value.
import { useState, type ReactNode } from "react";

import { useI18n, type Lang } from "../../../i18n";
import type { TKey } from "../../../i18n/locales/en";
import { localeDigits } from "../../../lib/format";
import type { BackgroundRow } from "../../../lib/ipc";
import { buildBrief, pictureFrom } from "../model/exchange/brief";
import { readPastedDesign } from "../model/exchange/read";
import type { ReportLine } from "../model/exchange/report";
import type { Profile, ProfileData } from "../model/profile";
import type { ChapterId } from "./chapters";

/** Which chapter owns each block a design can write, for the «ما تغيّر» hand-off. */
const WENT_TO: readonly { block: string; chapter: ChapterId; name: TKey }[] = [
  // THE NAME IS THE FIRST THING A READER SEES OF A DESIGN, so the chapter that owns it is named
  // first when the design brought one.
  { block: "name", chapter: "identity", name: "profiles.chapter.identity" },
  { block: "palette.library", chapter: "paper", name: "profiles.chapter.paperLibrary" },
  { block: "palette.reading", chapter: "paperBook", name: "profiles.chapter.paperBook" },
  { block: "voice", chapter: "voice", name: "profiles.chapter.voice" },
  { block: "reference", chapter: "refs", name: "profiles.chapter.refs" },
  { block: "texture", chapter: "texture", name: "profiles.chapter.texture" },
];

type Phase =
  | { at: "design" }
  | { at: "read"; report: ReportLine[]; went: readonly { chapter: ChapterId; name: TKey }[] }
  | { at: "refused"; why: string };

export function QuickSection({
  draft,
  patch,
  rows,
  background,
  typography,
  onName,
  onGoTo,
}: {
  draft: Profile;
  patch: (f: (d: ProfileData) => void) => void;
  rows: readonly BackgroundRow[];
  /**
   * Step one: the picture this design is built around, and how the reader shows it.
   *
   * The background chapter's own body, composed by the editor — for the same reason `typography` is.
   * This chapter owns no store and no second copy of a control that exists elsewhere; it decides
   * only WHERE in the flow each one appears.
   */
  background: ReactNode;
  /** The reader's own controls, composed by the editor from the components their chapters use. */
  typography: ReactNode;
  /**
   * The هيئة's own name, when the design brought one.
   *
   * `patch` writes `ProfileData`, and the name is not in it — it is the ROW's, beside the icon and
   * the seal. So this is a separate door, held by the editor, for the same reason `background` and
   * `typography` are: this chapter owns no state of its own.
   */
  onName: (name: string) => void;
  onGoTo: (chapter: ChapterId) => void;
}) {
  const { t, lang } = useI18n();
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<Phase>({ at: "design" });

  const copyBrief = async () => {
    // BUILT FROM THE DRAFT, so it describes the picture the reader has chosen rather than whatever
    // was bound when the editor opened.
    const brief = buildBrief({
      picture: pictureFrom(draft.data, rows),
      current: draft.data,
    });
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  const use = () => {
    const r = readPastedDesign(text);
    if (!r.ok) {
      setPhase({ at: "refused", why: t(r.refusal.code as TKey) });
      return;
    }
    const said = new Set(r.stated);
    const d = r.out.data;

    // BLOCK BY BLOCK, AND ONLY THE BLOCKS THE DESIGN SPOKE ABOUT. A translated recipe is a COMPLETE
    // هيئة — every field it never mentioned carries Sard's own default — so copying it wholesale
    // would quietly undo whatever the reader had already set. `type` is never among these: the
    // reader's faces, text size and indent are untouched by any design, by construction.
    /**
     * THE NAME THE DESIGN GAVE IT.
     *
     * `SARD-THEME/1` has carried `name` from the beginning — `translateRecipe` validates it into
     * `meta.name` (a trimmed string, capped at 80) and every recipe states one. It was simply never
     * applied, so a design arrived and the هيئة kept whatever it had been called; the owner reported
     * arriving at Save with an unnamed appearance.
     *
     * Applied EXACTLY as given: not beautified, not normalised, not made unique. It lands in the
     * Identity chapter's own field, so it is editable before Save by the control that already owns
     * naming, and «ما تغيّر» points there. A design that states no usable name changes nothing — the
     * هيئة keeps the name it had, which is what `stated` already guarantees for every other block.
     */
    if (said.has("name") && r.out.meta.name) onName(r.out.meta.name);

    patch((now) => {
      if (said.has("palette.library")) now.theme.library = d.theme.library;
      if (said.has("palette.reading")) now.theme.reading = d.theme.reading;
      if (said.has("voice")) now.voice = d.voice;
      if (said.has("reference")) now.refs = d.refs;
      if (said.has("texture")) now.texture = d.texture;
    });

    setPhase({
      at: "read",
      report: r.report,
      went: WENT_TO.filter((w) => said.has(w.block)).map(({ chapter, name }) => ({ chapter, name })),
    });
  };

  if (phase.at === "read") {
    return (
      <div className="pf-quick-ch">
        <div className="pf-quick-band">{t("profiles.quick.changed")}</div>
        {phase.went.length > 0 ? (
          <ul className="pf-quick-went">
            {phase.went.map((w) => (
              <li key={w.chapter}>
                <button className="pf-quick-link" onClick={() => onGoTo(w.chapter)}>{t(w.name)}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pf-quick-note">{t("profiles.quick.changedNothing")}</p>
        )}

        {phase.report.length > 0 && (
          <ul className="pf-quick-report">
            {phase.report.map((line, i) => <li key={i}>{reportText(line, t, lang)}</li>)}
          </ul>
        )}

        <div className="pf-quick-row">
          <button className="pf-btn primary" onClick={() => { setPhase({ at: "design" }); setText(""); }}>
            {t("profiles.quick.done")}
          </button>
          <button className="pf-btn" onClick={() => setPhase({ at: "design" })}>
            {t("profiles.quick.another")}
          </button>
        </div>
        <p className="pf-quick-note pf-quick-fine">{t("profiles.quick.doneNote")}</p>

        <div className="pfe-ch-rule" role="separator" />
        <div className="pf-quick-band">{t("profiles.quick.yourType")}</div>
        <p className="pf-quick-note pf-quick-fine">{t("profiles.quick.yourTypeNote")}</p>
        {typography}
      </div>
    );
  }

  return (
    <div className="pf-quick-ch">
      <div className="pf-quick-band">{t("profiles.quick.theDesign")}</div>
      <p className="pf-quick-note">{t("profiles.quick.body")}</p>

      {/* THE EXCHANGE FIRST, AND THAT IS THE WHOLE POINT OF THIS ORDER.
          A previous version opened with the picture and all of its settings, which tested badly for
          a reason worth recording: the three controls this chapter EXISTS for — copy, paste, use —
          were below the fold, under a column of sliders. A reader opening «التخصيص السريع» must see
          the exchange immediately; the picture is what they design AGAINST, and it reads perfectly
          well underneath. */}
      <div className="pf-quick-row">
        <button className="pf-btn primary pf-quick-copy" onClick={copyBrief}>
          {t("profiles.quick.copyBrief")}
        </button>
        {copied && <span className="pf-quick-copied">{t("profiles.quick.copied")}</span>}
      </div>
      <p className="pf-quick-note pf-quick-fine">{t("profiles.quick.privacy")}</p>

      <label className="pf-quick-label" htmlFor="pf-quick-paste">{t("profiles.quick.pasteLabel")}</label>
      <textarea
        id="pf-quick-paste"
        className="pf-quick-paste"
        dir="ltr"
        spellCheck={false}
        rows={4}
        value={text}
        placeholder={t("profiles.quick.pastePlaceholder")}
        onChange={(e) => { setText(e.target.value); if (phase.at === "refused") setPhase({ at: "design" }); }}
      />
      {phase.at === "refused" && <p className="pf-quick-note pf-quick-refused">{phase.why}</p>}
      <div className="pf-quick-row">
        <button className="pf-btn primary" disabled={text.trim().length === 0} onClick={use}>
          {t("profiles.quick.apply")}
        </button>
      </div>

      <div className="pfe-ch-rule" role="separator" />

      {/* THE PICTURE AND ITS SETTINGS, under the exchange. These are the background chapter's own
          `BackgroundSection`s over this same draft — compact only in how they are drawn. A value
          moved here is the value that chapter shows, because it is the same control.

          NO PAGE-COLOUR EDITOR HERE. It was tried and removed: the page's colour is the DESIGN's to
          choose, the brief now says so at length, and a palette editor beside the paste box invited
          the reader to do by hand the thing they had just commissioned. «ألوان الكتب» still owns it. */}
      <div className="pf-quick-sub">{t("profiles.quick.picture")}</div>
      <p className="pf-quick-note pf-quick-fine">{t("profiles.quick.pictureNote")}</p>
      <div className="pf-quick-bg">{background}</div>

      <div className="pfe-ch-rule" role="separator" />

      <div className="pf-quick-band">{t("profiles.quick.yourType")}</div>
      <p className="pf-quick-note pf-quick-fine">{t("profiles.quick.yourTypeNote")}</p>
      {typography}
    </div>
  );
}

/**
 * One line for one finding, in the reader's language.
 *
 * The report carries no prose — it is structured data — so this is the single place the wording
 * lives, and the only place a count becomes a sentence. A dropped field and a field this format
 * cannot carry are DIFFERENT sentences on purpose: one is a value Sard refused, the other is a
 * value Sard has no way to say, and a reader deciding whether to go back to their model needs to
 * know which happened.
 */
export function reportText(line: ReportLine, t: (k: TKey, v?: Record<string, string | number>) => string, lang: Lang): string {
  const n = (x: number | string) => localeDigits(String(x), lang);
  switch (line.kind) {
    case "pageInk":
      return t(line.meets ? "profiles.quick.rep.ink" : "profiles.quick.rep.inkLow",
        { n: n(Number(line.ratio.toFixed(1))) });
    case "dropped":
      return t("profiles.quick.rep.dropped", { n: n(line.count) });
    case "notExpressible":
      return t("profiles.quick.rep.notExpressible", { n: n(line.count) });
    case "polarity":
      return t("profiles.quick.rep.polarity");
    case "resolved":
      return t("profiles.quick.rep.resolved");
    case "claimsDisagree":
      return t("profiles.quick.rep.claims", {
        claimed: n(Number(line.worst.claimed.toFixed(1))),
        measured: n(Number(line.worst.measured.toFixed(1))),
      });
  }
}
