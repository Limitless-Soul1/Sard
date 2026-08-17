// The editor stage's LIBRARY face — Sard's library as this profile would draw it.
//
// WHY THIS IS NOT `SardMini`. The card's miniature is a 16:10 thumbnail: it answers "which profile
// is this" at a glance, in a box the size of a postage stamp. The editor's stage answers a different
// question — "what will Sard look like" — at nearly the size of the real thing, and the design draws
// it as a stage-FILLING composition: a 132px sidebar, a real header row, and a five-column shelf of
// ten spines. Reusing the thumbnail here was the original mismatch; it put a centred specimen card
// where the design has a room, which is why the focus insets, the reading bar and the page geometry
// all had nowhere to land. `SardMini` is still exactly right for the cards and is untouched.
//
// THE COLOURS ARE NOT PROPS. Every surface here reads the `--p*` custom properties the stage sets
// from the draft, which is the design's own model: the stage is the palette scope, and a face is a
// shape drawn in whatever colours that scope currently holds. It also means a colour typed into the
// Paper chapter repaints both faces without a single value being threaded through.

import { useI18n } from "../../../../i18n";
import { localeNum } from "../../../../lib/format";

/**
 * The ten spines, in the design's order.
 *
 * FIXED COLOURS ON PURPOSE — they are not theme values and must not become them. A shelf is the one
 * place a reader sees their own palette against colours it does not control, which is what makes a
 * paper look like paper rather than like a tint over everything. The design picks ten book cloths.
 */
const SPINES = [
  "#8E6B4E", "#3E4F63", "#6A4D86", "#9C5A3C", "#4E6A5C",
  "#2A3A5E", "#B8893C", "#6E4A2F", "#1F6F6B", "#7A2E3A",
] as const;

/** The design's specimen count. A picture of a full library, not a reading of this one. */
const SHELF_COUNT = 216;

export function LibraryFace({ iconUrl }: { iconUrl?: string | null }) {
  const { t, lang } = useI18n();

  return (
    <div className="pf-lib" aria-hidden>
      {/* Where interface texture is actually visible — the same surface `SardMini` fades. */}
      <div className="pf-lib-side">
        <span className="pf-lib-brand">
          <i className="pf-lib-brand-dot" />
          <i className="pf-lib-brand-rule" />
        </span>
        <span className="pf-lib-bars">
          <i className="pf-lib-bar a" />
          <i className="pf-lib-bar b" />
          <i className="pf-lib-bar c" />
          <i className="pf-lib-bar d" />
        </span>
        {/* The active profile, where Sard actually shows it. This is what `identity` points at. */}
        <span className="pf-lib-chip">
          <i
            className="pf-lib-avatar"
            style={iconUrl ? { backgroundImage: `url("${iconUrl}")` } : undefined}
          />
          <i className="pf-lib-chip-rule" />
        </span>
      </div>

      <div className="pf-lib-main">
        <div className="pf-lib-head">
          <span className="pf-lib-title">{t("profiles.editor.stageLibrary")}</span>
          <span className="pf-lib-count">{localeNum(SHELF_COUNT, lang)}</span>
          <span className="pf-lib-spacer" />
          <span className="pf-lib-add">{t("profiles.preview.add")}</span>
        </div>
        <div className="pf-lib-grid">
          {SPINES.map((c) => (
            <span key={c} className="pf-lib-spine" style={{ background: c }} />
          ))}
        </div>
      </div>
    </div>
  );
}
