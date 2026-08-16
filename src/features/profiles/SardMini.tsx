// SardMini — a whole Sard at 1:5, drawn from a profile's own colours.
//
// WHY A MINIATURE AND NOT A SWATCH. Sard already learned this once, measured, and wrote it down in
// `SettingsPanel.tsx`: the eight PDF appearance modes were first drawn as flat swatches and failed,
// because "eight light filters over white read as eight identical white boxes — a filter's effect
// is only visible on the ink-and-paper it transforms". The fix was a miniature page. A profile is a
// whole look rather than one colour, so the same rule applies with more force: the answer to "what
// will Sard look like" is this picture of Sard.
//
// EVERY DIMENSION IS A PERCENTAGE, so one component serves the 54px row in a switcher, the 62px row
// in its menu, and a full-width card, with no size prop and no breakpoints. The glyph is the one
// exception: it scales with `cqw` against the container, which is what keeps the seal readable at
// 54px and proportionate at 320px.
//
// IT DOES NOT MIRROR. Frame 19 of the design states the rule and the reason: "the miniature itself
// does not mirror: it is a picture of Sard in its owner's language, which is the honest thing for a
// Profile that may have come from someone else." So `dir` is fixed to the profile's own direction,
// never the viewer's.

import type { CSSProperties } from "react";

/** Exactly the props the design package's `MiniProfile` carries. */
export interface MiniProfile {
  paper: string;
  desk: string;
  chrome: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  /** The bookmark's colour — the mark on the page edge. */
  ink: string;
  /** A CSS `background-image` value, or `none`. */
  bgImg: string;
  /** 0..1 — how much of the image shows. */
  bgOn: number;
  /** 0..1 — the theme-coloured scrim over it. */
  scrim: number;
  /** A CSS length, e.g. `"18px"`. */
  blur: string;
  /** 0..1 — the interface texture, applied to the sidebar. */
  trans: number;
  /** The face the glyph is drawn in — the profile's own. */
  face: string;
  /** What the page shows: the profile's name, or a word of Sard. */
  glyph: string;
  /** The profile's own writing direction. Not the viewer's — see the note above. */
  dir?: "rtl" | "ltr";
}

const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", ...s });
const rule = (bg: string, opacity: number, extra?: CSSProperties): CSSProperties => ({
  height: 2,
  borderRadius: 2,
  background: bg,
  opacity,
  ...extra,
});

export function SardMini({ p }: { p: MiniProfile }) {
  return (
    <div
      dir={p.dir ?? "rtl"}
      aria-hidden
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 10",
        overflow: "hidden",
        background: p.desk,
        isolation: "isolate",
        containerType: "inline-size",
      }}
    >
      {/* the background image, inset so its blur samples beyond the frame rather than fading to
          nothing at the edges — the same reason the real library background uses negative insets */}
      <div
        style={abs({
          inset: "-14%",
          backgroundImage: p.bgImg,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: `blur(${p.blur})`,
          opacity: p.bgOn,
        })}
      />
      {/* the theme-coloured scrim — never black, so each theme keeps its own temperature */}
      <div style={abs({ inset: 0, background: p.desk, opacity: p.scrim })} />

      {/* the sidebar: where interface texture is actually visible */}
      <div
        style={abs({
          insetBlock: 0,
          insetInlineStart: 0,
          width: "23%",
          background: p.chrome,
          opacity: p.trans,
          borderInlineEnd: `1px solid ${p.border}`,
          padding: "7% 6%",
          display: "flex",
          flexDirection: "column",
          gap: "7%",
        })}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8%" }}>
          <div style={{ width: "26%", aspectRatio: "1", borderRadius: "50%", background: p.accent, opacity: 0.9 }} />
          <div style={{ flex: 1, ...rule(p.text, 0.34) }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "26%", marginTop: "6%" }}>
          <div style={rule(p.accent, 0.85, { height: 3, width: "88%" })} />
          <div style={rule(p.muted, 0.7, { width: "70%" })} />
          <div style={rule(p.muted, 0.55, { width: "78%" })} />
          <div style={rule(p.muted, 0.4, { width: "56%" })} />
        </div>
      </div>

      {/* the library: a head row and four covers */}
      <div
        style={abs({
          insetBlock: 0,
          insetInlineStart: "23%",
          insetInlineEnd: 0,
          padding: "8% 6% 0",
        })}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "5%", marginBottom: "7%" }}>
          <div style={rule(p.text, 0.66, { height: 4, width: "26%" })} />
          <div style={rule(p.muted, 0.6, { width: "9%" })} />
          <div style={{ flex: 1 }} />
          <div style={{ height: "6%", minHeight: 5, width: "16%", borderRadius: 3, background: p.accent }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "7% 6%" }}>
          {([[p.accent, 0.82, 0.28], [p.text, 0.5, 0.24], [p.ink, 0.78, 0.24], [p.muted, 0.55, 0.2]] as const).map(
            ([bg, opacity, shadow], i) => (
              <div
                key={i}
                style={{
                  aspectRatio: "2 / 3",
                  borderRadius: 2,
                  background: bg,
                  opacity,
                  boxShadow: `0 2px 5px rgba(20,14,6,${shadow})`,
                }}
              />
            ),
          )}
        </div>
      </div>

      {/* the page, overlapping the library and running off the bottom edge — the reading surface
          sitting on the desk, which is the idea the whole app is built around */}
      <div
        style={abs({
          insetBlockStart: "22%",
          insetBlockEnd: "-6%",
          insetInlineEnd: "8%",
          width: "36%",
          background: p.paper,
          boxShadow: "0 8px 22px rgba(20,14,6,.30)",
          padding: "9% 8% 0",
          overflow: "hidden",
          // The glyph is sized against THIS box, not the whole miniature. Sizing it against the
          // miniature made it 17% of a width it does not occupy — the page is 36% of the frame — so
          // at card size a 26px word sat in a 64px box and was clipped to its tail ("Evening" read
          // as "ning"). Measured at 212px card and 560px stage.
          containerType: "inline-size",
        })}
      >
        {/* the seal: the profile's own word, in its own face, on its own paper — a type specimen
            rather than clip art, which is what makes one profile recognisable beside another */}
        <div
          // `dir="auto"` so a Latin name reads left-to-right on a page that itself never mirrors.
          dir="auto"
          style={{
            fontFamily: p.face,
            fontSize: "clamp(7px, 22cqw, 26px)",
            lineHeight: 1,
            color: p.text,
            marginBottom: "8%",
            whiteSpace: "nowrap",
            // A name longer than the page ends in an ellipsis rather than bleeding off the edge.
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {p.glyph}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={rule(p.text, 0.5)} />
          <div style={rule(p.text, 0.42, { width: "82%" })} />
          <div style={rule(p.text, 0.46)} />
          {/* the one accented line: a highlight, so the profile's inks are visible too */}
          <div style={rule(p.accent, 0.7, { width: "64%" })} />
          <div style={rule(p.text, 0.4)} />
          <div style={rule(p.text, 0.34, { width: "74%" })} />
        </div>
        {/* the bookmark, at the page's own edge — in the profile's mark colour, not its accent */}
        <div style={abs({ insetBlockStart: -1, insetInlineEnd: "18%", width: "9%", minWidth: 6 })}>
          <div
            style={{
              width: "100%",
              aspectRatio: "1 / 2.6",
              background: p.ink,
              clipPath: "polygon(0 0,100% 0,100% 100%,50% 74%,0 100%)",
              boxShadow: "0 3px 4px rgba(20,14,6,.35)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
