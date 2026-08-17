// The editor stage's LIBRARY face — Sard's library as this profile would draw it.
//
// WHY THIS IS NOT `SardMini`. The card's miniature is a 16:10 thumbnail: it answers "which profile
// is this" at a glance, in a box the size of a postage stamp. The editor's stage answers a different
// question — "what will Sard look like" — at nearly the size of the real thing, and the design draws
// it as a stage-FILLING composition: a sidebar, a real header row, and a shelf of ten spines. Those
// are now sized from the reference window rather than transcribed — a 102px sidebar and an
// eight-column shelf, which is what 244px of chrome and a 138.6px cover pitch come to at 1440. Ten
// spines across eight columns leaves a short second row, which is exactly what a real shelf's last
// row looks like; the count stays the design's ten cloths rather than being padded to fill a
// rectangle. Reusing the thumbnail here was the original mismatch; it put a centred specimen card
// where the design has a room, which is why the focus insets, the reading bar and the page geometry
// all had nowhere to land. `SardMini` is still exactly right for the cards and is untouched.
//
// THE COLOURS ARE NOT PROPS. Every surface here reads the `--p*` custom properties the stage sets
// from the draft, which is the design's own model: the stage is the palette scope, and a face is a
// shape drawn in whatever colours that scope currently holds. It also means a colour typed into the
// Paper chapter repaints both faces without a single value being threaded through.

import { useI18n } from "../../../../i18n";
import { localeNum } from "../../../../lib/format";
import type { BgParams } from "../../../../lib/background";
import { sealOf } from "../../mini";
import type { Profile } from "../../model/profile";

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

export function LibraryFace({
  profile,
  iconUrl,
  bg,
}: {
  profile: Profile;
  iconUrl?: string | null;
  /** The library's own picture, already resolved. The face owns it — see the note below. */
  bg?: { url: string; params: BgParams; scrim: number } | null;
}) {
  const { t, lang } = useI18n();

  return (
    <div className="pf-lib" aria-hidden>
      {/* THE LIBRARY'S PICTURE, INSIDE THE LIBRARY. It used to hang on the composition, whose clip
          is the stage — so the face's own `overflow: hidden` could never reach it and the image was
          painted across the margins around the face as well as through it. Measured: the image ran
          from x 869 to 2215 against a face of 990 to 2094, and `elementFromPoint` returned the image
          layer at the left, right and bottom margins. A face cannot confine a layer it does not own.
          As a descendant, the face's existing boundary IS the image's boundary: `.pf-lib` is already
          `position: absolute`, so it is the containing block, and already `overflow: hidden`, so it
          is the clipper. Nothing is opaque here — the sidebar keeps its texture alpha and the main
          area keeps no background, so the picture is still seen THROUGH the library. */}
      {bg && (
        <>
          <span
            className="pf-lib-bg"
            style={{
              backgroundImage: `url("${bg.url}")`,
              backgroundPosition: `${bg.params.focalX}% ${bg.params.focalY}%`,
              filter: `blur(${bg.params.blur}px)`,
              transform: `scaleX(${bg.params.flip ? -1 : 1})`,
            }}
          />
          <span className="pf-lib-scrim" style={{ opacity: bg.scrim }} />
        </>
      )}
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
        {/* The active profile, where Sard actually shows it. This is what `identity` points at, so
            it draws the profile's REAL icon — the design's mock only ever has a picture, but a
            profile wearing a colour or a letter would otherwise show a blank square here and the
            identity chapter would be pointing at nothing. Same three-way as the card. */}
        <span className="pf-lib-chip">
          {profile.iconKind === "color" && profile.iconRef ? (
            <i className="pf-lib-avatar" style={{ background: profile.iconRef }} />
          ) : iconUrl ? (
            <i className="pf-lib-avatar" style={{ backgroundImage: `url("${iconUrl}")` }} />
          ) : (
            <i className="pf-lib-avatar seal" style={{ fontFamily: sealOf(profile).fontFamily }}>
              {sealOf(profile).text}
            </i>
          )}
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
