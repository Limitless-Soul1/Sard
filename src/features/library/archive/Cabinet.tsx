// THE CABINET — one shallow drawer per book, and the slips showing above the edge.
//
// The entry level of the Library's archive. A cover grid would say "these are books"; a drawer says
// "this is where what I kept from that book lives" — the same object family as the slips inside it,
// one scale up. So the cover is a PLATE set into the drawer face rather than a poster, and beside it
// sit the written label, the tally, the ink spectrum and — the part that makes this a memory instead
// of a listing — the newest thing marked in that book, quoted in the reading face with its real ink.
//
// Nothing here is faked or newly stored: every value is derived in `model.ts` from rows that already
// existed. The reader's own annotations panel and the Bookmarks shelf are untouched by this file.

import type { CSSProperties } from "react";

import { autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { Icon } from "../../../components/Icon";
import { colorValue } from "../../reader/highlightColors";
import { resolveHighlightInk } from "../../../lib/highlightInk";
import { markStyle } from "./mark";
import { isArabicText, scriptOf } from "../../../lib/typography";
import type { ThemeColors } from "../../../theme/tokens";
import { letterOf, MAX_TABS, tabHeight, type Drawer } from "./model";

/** The design's tab geometry: a 44px slip on a 52px pitch, starting clear of the plate's corner. */
const TAB_START = 34;
const TAB_PITCH = 52;

interface Props {
  drawers: Drawer[];
  hl: ThemeColors["highlight"];
  dark: boolean;
  /** The surface a drawer face is painted on — the ground its quoted mark is resolved against. */
  face: string;
  /** Localised strings the face writes, resolved by the caller so this stays presentational. */
  text: {
    tally: (h: number, n: number) => string;
    opened: (at: number | null) => string;
    pull: string;
  };
  onOpen: (d: Drawer) => void;
}

export function Cabinet({ drawers, hl, dark, face, text, onOpen }: Props) {
  return (
    <div className="arch-grid">
      {drawers.map((d) => (
        <DrawerFace key={d.bookId} d={d} hl={hl} dark={dark} face={face} text={text} onOpen={onOpen} />
      ))}
    </div>
  );
}

function DrawerFace({ d, hl, dark, face, text, onOpen }: { d: Drawer } & Omit<Props, "drawers">) {
  const src = coverSrc({ cover_path: d.coverPath });
  const titleArabic = isArabicText(d.title);
  // The same generated ground the Library's own covers use, so a coverless book looks like itself
  // wherever it appears rather than like a second, unrelated placeholder.
  const paint = autoCoverPaint(d.title);
  const busiest = d.inks.length > 0 ? d.inks[0].count : 0;
  // The silhouette is trimmed to what the face can carry; the dot spectrum below stays complete.
  const tabs = d.inks.slice(0, MAX_TABS);

  // The quoted line wears the ink it was marked in, composited by Sard's own rule so the slip looks
  // like the page it came from. A mark with no colour (a bare note) is quoted as plain paper.
  const quoteInk = d.latest?.color ? colorValue(d.latest.color, hl) : null;
  // RESOLVED AGAINST THE GROUND IT ACTUALLY SITS ON. On a dark paper the resolver carries the ink
  // into the surface behind it, so handing it the reading paper while the quote is painted on the
  // drawer face produced a mark mixed for a page it is not on. The face is the ground here.
  const ink = quoteInk ? resolveHighlightInk({ ink: quoteInk, dark, paper: face }) : null;
  const inkStyle: CSSProperties | undefined = ink ? markStyle(ink, face) : undefined;

  const quoteArabic = scriptOf(d.latest?.text ?? null, d.dir) === "arabic";

  return (
    <button
      className="arch-drawer"
      onClick={() => onOpen(d)}
      aria-label={`${d.title} — ${text.tally(d.highlights, d.notes)}`}
    >
      {tabs.map((t, i) => (
        <span
          key={t.color}
          className="arch-tab"
          aria-hidden
          style={{
            insetInlineStart: `${TAB_START + TAB_PITCH * i}px`,
            height: `${tabHeight(t.count, busiest)}px`,
            background: colorValue(t.color, hl),
          }}
        />
      ))}

      <span className="arch-face">
        <span className="arch-plate">
          {src ? (
            <img src={src} alt="" />
          ) : (
            <span
              className={`arch-plate-letter${titleArabic ? " ar" : ""}`}
              style={{ background: paint.bg, color: paint.ink }}
              aria-hidden
            >
              {letterOf(d.title)}
            </span>
          )}
        </span>

        {/* DIRECTION IS THE APPLICATION'S, NEVER THE CONTENT'S. Nothing in this card sets `dir`. A
            Latin title in an Arabic interface, or an English passage marked in an Arabic book, used to
            flip its own block and leave one card running the other way inside an otherwise mirrored
            cabinet. The interface's language decides the layout; the SCRIPT of a run of text still
            decides its FACE, which is a typographic choice and not a directional one, and Unicode's
            own bidi ordering handles a foreign run inside a line without moving anything around it. */}
        <span className="arch-label">
          <span className="arch-book">{d.title}</span>
          {d.author && <span className="arch-author">{d.author}</span>}

          <span className="arch-tally-row">
            <span className="arch-tally">{text.tally(d.highlights, d.notes)}</span>
            <span className="arch-spectrum" aria-hidden>
              {d.inks.map((t) => (
                <span key={t.color} className="arch-dot" style={{ background: colorValue(t.color, hl) }} />
              ))}
            </span>
          </span>

          {d.latest && (
            <span className={`arch-quote${quoteArabic ? " ar" : ""}`}>
              <span className="arch-ink" style={inkStyle}>
                {d.latest.text}
              </span>
            </span>
          )}

          <span className="arch-foot">
            <span className="arch-opened">{text.opened(d.lastOpenedAt)}</span>
            <span className="arch-cue" aria-hidden>
              {text.pull}
              <Icon name="caretRight" size="sm" />
            </span>
          </span>
        </span>

        <span className="arch-handle" aria-hidden />
      </span>
    </button>
  );
}
