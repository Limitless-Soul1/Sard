// INSIDE THE DRAWER — the book's own wall of slips.
//
// Once a drawer is pulled open, the book IS the room you are standing in: the cluster header that
// grouped the cabinet is gone, the book's identity has moved up into the band above, and what remains
// is only what was kept from that one book.
//
// An annotation is a slip of paper, not a table row. Each slip is sized by its own content in a packed
// column, so a three-word note does not get the box a three-hundred-word one needs. The passage carries
// the REAL word-shaped mark, composited by Sard's own rule — a slip looks like the page it came from,
// and the ink is the identity rather than a border or a tint. A note slip has no mark at all: bare
// paper, a pen glyph and the interface face, so the two are told apart from across the room.

import type { CSSProperties } from "react";

import { Icon } from "../../../components/Icon";
import type { AnnoItem } from "../../../lib/ipc";
import { resolveHighlightInk } from "../../../lib/highlightInk";
import { markStyle } from "./mark";
import { colorValue } from "../../reader/highlightColors";
import { scriptOf } from "../../../lib/typography";
import type { ThemeColors } from "../../../theme/tokens";

// ONE CARD, ONE SIZE. Every slip on this wall is the same height, and the content fits the card —
// the card never grows to fit the content. Capping the passage alone was not enough: a slip with a
// note was still taller than one without, so rows stayed ragged and short cards left holes beside
// tall ones. The frame is fixed in CSS; what follows is only the point past which text is faded
// rather than simply ending, which the reference decides by length.
//
// The thresholds move with the allowances: a passage now has 96px to itself and 60 when a note
// shares the slip, so the point past which it is faded rather than simply ending comes sooner.
const LONG_PLAIN = 100;
const LONG_SHARED = 63;
const LONG_NOTE = 80;

/**
 * THE COLOUR A SLIP'S TAB WEARS, taken from the annotation itself and from nothing else.
 *
 * A highlight has an ink, and that ink is the tab: a stored palette slot resolved against the live
 * theme, or a literal hex kept as it is — the same `colorValue` every other surface uses, so two
 * highlights in different inks cannot come out the same colour here.
 *
 * A note may carry a colour too — `note_create` accepts one — and when it does, that is its tab. A
 * note written on its own with none has nothing of its own to show, and the reference answers that
 * case itself: its slip chip is the accent for a note and the ink for a highlight. So the accent is
 * the note's fallback, not a new colour model invented for the tab.
 */
export function tabColor(it: AnnoItem, hl: ThemeColors["highlight"], accent: string): string {
  if (it.color) return colorValue(it.color, hl);
  return accent;
}

interface Props {
  items: AnnoItem[];
  hl: ThemeColors["highlight"];
  dark: boolean;
  paper: string;
  /** The theme's accent — the tab a note with no colour of its own wears. */
  accent: string;
  /** How large a slip is, as a multiple of the smallest. One variable sizes the whole wall. */
  scale: number;
  noteLabel: string;
  /** The chapter a mark sits in, and when it was made — separate, because the reference separates them. */
  chapter: (it: AnnoItem) => string;
  when: (it: AnnoItem) => string;
  /** Whose mark it is, for a slip that arrived in a deposit. Empty for one the reader made himself. */
  from: (it: AnnoItem) => string;
  /** "read the sheet" — shown only on a slip that had to hide something. */
  readAll: string;
  onOpen: (it: AnnoItem) => void;
}

export function SlipWall({ items, hl, dark, paper, accent, scale, noteLabel, chapter, when, from, readAll, onOpen }: Props) {
  return (
    // TWO BOXES, DELIBERATELY. The scroller owns the height; the column box owns the columns and is
    // left to grow. A multi-column box with a DEFINITE height does not overflow downwards — it makes
    // more columns beside itself, off the side of the pane, where nothing can scroll to them. Giving
    // the columns their own auto-height box is what makes a long wall scroll instead of vanish.
    <div className="arch-wall">
      <div
        className="arch-wall-cols"
        style={{
          ["--arch-scale" as string]: String(scale),
          // A LINE COUNT CANNOT BE COMPUTED IN CSS, so the note's clamp is handed down. Two lines at
          // the smallest card — the approved baseline — rising with the card, so a note reveals more
          // as the wall opens out without ever claiming the room the passage grows into.
          ["--arch-note-lines" as string]: String(Math.round(2 + (scale - 1) * 3.5)),
        }}
      >
      {items.map((it) => (
        <Slip
          key={`${it.kind}-${it.id}`}
          it={it}
          hl={hl}
          dark={dark}
          paper={paper}
          accent={accent}
          noteLabel={noteLabel}
          chapter={chapter}
          when={when}
          from={from}
          readAll={readAll}
          onOpen={onOpen}
        />
      ))}
      </div>
    </div>
  );
}

function Slip({ it, hl, dark, paper, accent, noteLabel, chapter, when, from, readAll, onOpen }: { it: AnnoItem } & Omit<Props, "items" | "scale">) {
  // The SCRIPT chooses the face; it does not choose a direction. The slip belongs to the interface's
  // own layout, so an English passage marked inside an Arabic book stays in the Arabic wall rather
  // than turning one card around inside it.
  const arabic = scriptOf(it.text, it.book_dir) === "arabic";

  // STRUCTURE COMES FROM `kind`, NOT FROM THE COLLECTION PREDICATE — and getting that wrong is what
  // broke this card. `annoIsNote` answers "which shelf does this row belong to", and it says YES for
  // a highlight that carries a note, because such a row must appear under Notes. Used here as though
  // it described the row's SHAPE, it emptied the passage of every annotated highlight, moved that
  // passage into the note block as if the reader had written it, and dropped the actual note entirely
  // — so a marked passage lost its ink and a real note vanished from the wall.
  //
  // The shape is two independent questions, and the row answers both directly: a HIGHLIGHT keeps the
  // book's word in `text`; a NOTE — standalone — keeps the reader's word there instead and has no
  // stored passage at all. `note` is the reader's word attached to a highlight.
  const isStandaloneNote = it.kind === "note";
  const excerpt = isStandaloneNote ? "" : (it.text ?? "").trim();
  const note = (isStandaloneNote ? it.text : it.note)?.trim() ?? "";

  // Only a passage wears ink; a note's block carries the accent rail instead.
  const ink = excerpt && it.color ? resolveHighlightInk({ ink: colorValue(it.color, hl), dark, paper }) : null;
  const inkStyle: CSSProperties | undefined = ink ? markStyle(ink, paper) : undefined;

  // THE FRAME IS FIXED; ONLY THE FADE IS CONDITIONAL. A passage that overruns the room the frame
  // gives it is faded out; one that fits is left alone, because fading text that had room to be read
  // is what made passages unreadable.
  const longExcerpt = excerpt.length > (note ? LONG_SHARED : LONG_PLAIN);
  const longNote = note.length > LONG_NOTE;

  return (
    <button
      className={`arch-slip${isStandaloneNote ? " note" : ""}${note ? " has-note" : ""}`}
      onClick={() => onOpen(it)}
    >
      <span className="arch-slip-tab" style={{ background: tabColor(it, hl, accent) }} aria-hidden />

      {/* THE BOOK'S WORD, wearing the mark it wears on the page. */}
      {excerpt && (
        <span className={`arch-slip-exc${arabic ? " ar" : ""}${longExcerpt ? " long" : ""}`}>
          {ink ? <span className="arch-ink" style={inkStyle}>{excerpt}</span> : excerpt}
        </span>
      )}

      {/* THE READER'S OWN WORD, in its own block: an accent rail down the leading edge, a pen and a
          name above it, and three lines of the note itself. This is the part that was missing — a
          note on the wall showed a fragment of something with no sign of whose words they were. */}
      {note && (
        <span className="arch-slip-noteblock">
          <span className="arch-slip-notelabel">
            <Icon name="markNote" size="sm" />
            {noteLabel}
          </span>
          <span className={`arch-slip-notebody${longNote ? " long" : ""}`}>{note}</span>
        </span>
      )}

      {/* The chip is the annotation's colour where the reference puts it: beside its chapter. */}
      <span className="arch-slip-meta">
        <span className="arch-slip-chip" style={{ background: tabColor(it, hl, accent) }} aria-hidden />
        <span className="arch-slip-chapter">{chapter(it)}</span>
        {/* WHOSE MARK IT IS, when it is not yours. A slip you made says nothing here, so the line only
            ever appears where there is a distinction to draw. */}
        {from(it) && <span className="arch-slip-from">{from(it)}</span>}
        <span className="arch-slip-when">{when(it)}</span>
      </span>

      {/* A slip that could not show everything says so, instead of just stopping. */}
      {(longExcerpt || longNote) && (
        <span className="arch-slip-more">
          {readAll}
          <Icon name="caretRight" size="sm" />
        </span>
      )}
    </button>
  );
}
