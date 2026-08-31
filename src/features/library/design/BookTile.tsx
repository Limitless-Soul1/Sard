// One book, as the design draws it.
//
// SOURCE NOTE. This tile is the one piece both reference files agree on exactly: the
// `bookModel`/`deco` block that produces it is byte-identical in `Sard Library
// (standalone).html` and `Sard Library - Vista (standalone).html`. Covers, Spines and Vista
// therefore share it by the design's own construction, not by a decision made here — the
// only branches are on VIEW (`spines`, `vista`), exactly as authored.
//
// The declarations below are the design's, carried over verbatim; `library-design.css`
// binds the short variable names they use to Sard's theme tokens.

import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { AutoCover, autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { atDensity, progressPct, isFinished, spineWidth, type DesignView } from "./model";
import { coverPresentation, type CoverMode } from "./coverPresentation";
import { Icon } from "../../../components/Icon";
import { useBookPickup } from "./bookPickup";
import { BookActions } from "./BookActions";
import { labelFace, scriptOf } from "../../../lib/typography";


/** Cover heights per density step, for Spines. The design's numbers — now read by `atDensity`, so
    a position between two steps lands between two heights and the authored values still render
    exactly at 0, 1, 2 and 3. Height is what density MEANS in Spines: its width moves only 23→32px
    across the whole range, measured, while this doubles. */
const SPINE_HEIGHTS = [104, 132, 168, 208];
const SPINE_LABEL_MAX = [96, 124, 160, 200];


export interface BookTileProps {
  book: BookRow;
  view: DesignView;
  density: number;
  /** Rendered width for a cover tile; Spines derives its own from the book. */
  itemW: number;
  selected: boolean;
  /** True while this book is the one being carried in arrange mode. */
  inHand: boolean;
  /** The ordering mode is on. A book must never open while it is, whatever else is true. */
  arrangeOn: boolean;
  /**
   * This shelf's order is the reader's to set. False on a computed shelf and on the unshelved run,
   * where the gesture has nowhere to go — the tile then offers nothing, but it still does not open.
   */
  orderable?: boolean;
  /**
   * The shelf this tile is drawn under, and its index there — what makes the tile itself a landing
   * place. A release over a book resolves to "this shelf, at this index"; without it the only thing
   * that accepted a release was the dashed placeholder between two covers. See `dropTarget`.
   */
  srcShelfId?: string | null;
  srcIndex?: number;
  selectOn: boolean;
  /**
   * The reader has asked the Library to keep book names out of the way until a book is touched.
   * Only the COVER-LED views honour it — Spines draws its title onto the spine itself, where the
   * words are the artwork, and Details lists it in a column under its own heading. Hiding it in
   * either would empty the view rather than quiet it.
   */
  hideTitles?: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleSelect: () => void;
  onPickUp: (clientX: number, clientY: number) => void;
  /** Arrange mode: the pointer went down on this book. The surface decides when it becomes a drag. */
  onArrangeDown: (clientX: number, clientY: number, el: Element) => void;
  /** null when the shelf cannot give a book up (a rule shelf). */
  onRemoveFromShelf: (() => void) | null;
  /** Delete the book itself, wherever it is filed — see `BookActionsProps.onDelete`. */
  onDelete: () => void;
  onSetFinished: (finished: boolean) => void;
  /** The library's Crop/Fit setting, which a book with no per-book fit follows. */
  libraryCoverMode: CoverMode;
}

export function BookTile(props: BookTileProps) {
  const { book, view, density, itemW, selected, inHand, arrangeOn, selectOn } = props;
  const orderable = props.orderable !== false;
  const { t } = useI18n();
  /**
   * HOVER IS NOT STATE. It was, and crossing a shelf therefore re-rendered every tile the pointer
   * touched: measured at 11 React commits, 55 DOM mutations and 138 style recalculations for sixty
   * moves across nineteen books, where the previous implementation cost 62 recalculations and
   * nothing else at all. Removing the state alone returned all four numbers to that baseline
   * exactly.
   *
   * What hover drove — the caption, the ⋯, and the tile's lift — is now driven by `:hover` in the
   * stylesheet, which the compositor handles without telling React anything. The two things that
   * genuinely ARE state, because CSS cannot know them, are handed to CSS as attributes instead:
   * `data-menu` while this tile's menu is open, and `data-selected`. Both change rarely, so they
   * cost a render when they happen and nothing while the pointer moves.
   */
  // Owned by `BookActions` now; the tile only mirrors it, because `.libd-dots` is hidden until the
  // tile is hovered and must stay visible while its own menu is up.
  const [menuOpen, setMenuOpen] = useState(false);

  const [imgFailed, setImgFailed] = useState(false);

  const spines = view === "spines";
  const vista = view === "vista";
  const meta = resolveBookMeta(book);
  const title = displayTitle(meta, t);
  const arabic = scriptOf(title, book.dir) === "arabic";
  // One resolver decides the jacket, so the Book Details controls are wired to every view by
  // construction — the crop/contain/default buttons used to persist a `cover_fit` no view read.
  const derived = autoCoverPaint(title);
  const pres = coverPresentation(book, !!coverSrc(book), derived, props.libraryCoverMode);
  const paint = { bg: pres.paint, ink: pres.ink };
  const src = pres.kind === "image" ? coverSrc(book) : null;
  const spineSrc = book.spine_image ? convertFileSrc(book.spine_image) : null;
  const drawn = !src || imgFailed;
  const pct = progressPct(book);
  const finished = isFinished(book);
  const w = spines ? spineWidth(book, density) : itemW;

  // The design shows the caption always in Covers, on hover/selection in Vista, never in Spines.
  // The caption is always LAID OUT wherever it belongs, and only its visibility changes.
  //
  // Vista shows a caption on hover. Mounting it on hover grew the tile, and because the band is a
  // grid with `align-items: end`, a taller tile raised the whole row and shoved every band below
  // it — so running the pointer along a shelf made the page jump under the reader. Reserving the
  // space keeps the design's behaviour (the caption appears when you point at a book) while the
  // geometry stays fixed. `translateY` was never the problem: transforms are composited and do
  // not reflow.
  const capRendered = !spines;
  // EVERY CAPTION THAT IS DRAWN AT ALL IS DRAWN ALWAYS.
  //
  // Vista used to withhold its titles until the pointer arrived, to keep the reader's own
  // background image as clear as possible — that view exists to show it off. But a shelf of
  // unlabelled covers cannot be read, only pointed at one book at a time, and the reader asked
  // for the names. The space was already reserved for them (`capRendered`), so nothing moves
  // and no layout shifts; Vista keeps the shadow under its text that makes it legible over an
  // arbitrary photograph. Spines draw no caption at all and are unaffected.
  // …and the reader can now ask for that first behaviour back. `capAlways` was hardcoded `true` when
  // the names were restored; it is once more the thing that decides, driven by a Library preference
  // instead of by the view. Spines is unaffected either way — it renders no caption at all.
  const capAlways = !props.hideTitles;
  // The ⋯ is always MOUNTED and hidden with `visibility`, which keeps it out of the tab order and
  // out of hit-testing exactly as unmounting did — without a render every time a pointer crosses.
  const showDots = !selectOn;

  // THE GESTURE LIVES IN `bookPickup`, and Details uses the same one. What a press means — arm a
  // drag, hold to lift, never open under arrange, and swallow the click a hold has already spent —
  // is one behaviour, not a set of per-view settings.
  const pickup = useBookPickup({
    arrangeOn,
    orderable,
    selectOn,
    onArrangeDown: props.onArrangeDown,
    onPickUp: props.onPickUp,
    onOpen: props.onOpen,
    onToggleSelect: props.onToggleSelect,
  });

  const cardStyle: React.CSSProperties = spines
    ? {
        position: "relative",
        display: "flex",
        alignItems: "flex-end",
        width: w,
        cursor: "pointer",
        opacity: inHand ? 0.25 : undefined,
      }
    : {
        position: "relative",
        zIndex: vista ? 1 : undefined,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "100%",
        cursor: "pointer",
        opacity: inHand ? 0.25 : undefined,
      };

  // Vista gives the cover real thickness — the design's own shadow stack for that view.
  const vistaCover =
    "0 22px 26px -16px rgba(24,14,6,.55), 0 6px 12px -6px rgba(24,14,6,.42), 0 1px 2px rgba(24,14,6,.32)," +
    "inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.07)";

  const coverStyle: React.CSSProperties = spines
    ? {
        position: "relative",
        width: w,
        height: Math.round(atDensity(SPINE_HEIGHTS, density)),
        background: paint.bg,
        borderRadius: "2px 2px 1px 1px",
        boxShadow: "var(--sh1), inset 0 0 0 1px rgba(255,255,255,.07)",
        display: "grid",
        placeItems: "center",
        outline: selected ? "2px solid var(--acc)" : undefined,
        outlineOffset: selected ? 2 : undefined,
        overflow: "hidden",
      }
    : {
        position: "relative",
        aspectRatio: "2/3",
        overflow: "hidden",
        background: drawn ? paint.bg : "var(--lbox)",
        ...(vista
          ? {
              borderStartStartRadius: 2,
              borderStartEndRadius: 5,
              borderEndEndRadius: 5,
              borderEndStartRadius: 2,
              boxShadow: vistaCover,
            }
          : { borderRadius: 3, boxShadow: "var(--sh2)" }),
      };

  return (
    <div
      style={{
        ...cardStyle,
        // `grabbing` while this very book is the one in hand; otherwise whatever the gesture
        // offers. The hook owns that decision, so Details cannot drift from it.
        ...(arrangeOn
          ? { cursor: inHand ? "grabbing" : pickup.cursor, touchAction: "none" }
          : {}),
      }}
      className="libd-tile"
      // THE BOOK IS NAMED EVEN WHEN ITS NAME IS NOT DRAWN.
      //
      // `.libd-cap` hides with `visibility`, which — deliberately — also takes the caption out of
      // the accessibility tree. That is right while the name is merely waiting for a pointer, and
      // wrong once the reader has asked for it to stay hidden: a screen reader would then meet a
      // shelf of books with no names at all. The title moves onto the tile itself, so it is spoken
      // whether or not it is painted, and the native tooltip gives the pointer the same answer.
      title={title}
      aria-label={title}
      // SPINES HANG THE ⋯ CLEAR OF THE TILE, which leaves a band of nothing between the two.
      // The stylesheet bridges it while the tile is hovered; it needs to know which format
      // this is, and asking the DOM to work that out from geometry would be worse.
      data-spine={spines ? "1" : undefined}
      // What CSS cannot work out for itself. Both change rarely; neither changes on a pointer move.
      data-menu={menuOpen ? "1" : undefined}
      data-selected={selected ? "1" : undefined}
      data-arrange={arrangeOn ? "1" : undefined}
      onPointerLeave={pickup.cancelHold}
      // The tile names the book it draws, the same way a landing place names its destination.
      // Nothing in the product reads it; it is what lets a check address a book by identity
      // instead of inferring one from its styling, which is how several false readings were had.
      data-book={book.id}
      data-shelf={props.srcShelfId ?? undefined}
      data-index={typeof props.srcIndex === "number" ? props.srcIndex : undefined}
      onPointerDown={pickup.onPointerDown}
      onPointerUp={pickup.cancelHold}
      onClick={pickup.onClick}
      /* THE BOOK IS A KEYBOARD STOP — in Covers and Vista, which is where a reader needs one.
       *
       * It had none. `.libd-tile` carried no `tabIndex`, so no book in either format could be
       * reached by Tab at all, and the ⋯ inside it is `visibility: hidden` until hover — which
       * takes it out of the tab order too. The `:focus-within` rule that reveals a hidden caption
       * was already written and could never fire, because nothing here could hold focus. That
       * mattered more once «إخفاء الأسماء» existed: a keyboard reader met a shelf of unnamed
       * covers with no way to ask any of them what they were.
       *
       * SPINES IS INCLUDED TOO. It was left out when this was first written, because it draws no
       * caption (`capRendered`) and «إخفاء الأسماء» therefore never reaches it — but "no caption"
       * was never a reason a book should be unreachable, and a keyboard reader in Spines could not
       * get to one at all. The same handler, the same ring, the same reveal; the only thing Spines
       * needed of its own was a focus ring that does not collide with its selection outline.
       *
       * AND NO `role="button"`, though the Grid card next door carries one. ARIA makes a button's
       * children PRESENTATIONAL, so the role would prune the ⋯ out of the accessibility tree —
       * spending the keyboard fix on one control to break another. A focusable element with an
       * `aria-label` is named just as well and keeps everything inside it reachable. */
      tabIndex={0}
      onKeyDown={pickup.onKeyDown}
    >
      {showDots && (
        <BookActions
          filePath={book.file_path}
          finished={finished}
          onEditDetails={props.onEdit}
          onOpen={props.onOpen}
          onSetFinished={props.onSetFinished}
          onRemoveFromShelf={props.onRemoveFromShelf}
          onDelete={props.onDelete}
          onOpenChange={setMenuOpen}
          // Spines hang their control clear of a very narrow tile; that is a matter of layout, and
          // the only thing a format is allowed to decide for itself here.
          // RETUNED FOR THE CONTROL'S TRUE SIZE. This was -26, hand-fitted to a 24px button so it
          // hung 2px clear of the spine — "a band of nothing between the two", as the rule below
          // puts it. The control is now 30px (`--ctl-md`, its correct size), which pushed its
          // bottom edge 4px INTO the spine; -32 restores the same 2px band. The hover bridge
          // (`[data-spine]:hover::before`, -32px for 36px) already spans exactly this.
          buttonStyle={spines ? { insetBlockStart: -32, insetInlineEnd: -4 } : undefined}
        />
      )}

      {/* Named so the focus ring can go on the JACKET rather than around the whole tile, which is
          what `.lib-card:focus-visible .lib-cover` already does in Grid. Ringing the tile would
          enclose the caption's reserved space as well, and with the names hidden that is an empty
          band — the ring would read as a box with a gap in it. */}
      <div className="libd-tile-cover" style={coverStyle}>
        {spines ? (
          spineSrc ? (
            // A chosen spine image is the whole spine — the drawn label would sit on top of it.
            <img
              src={spineSrc}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <span
              style={{
                transform: "rotate(-90deg)",
                transformOrigin: "center",
                whiteSpace: "nowrap",
                maxWidth: Math.round(atDensity(SPINE_LABEL_MAX, density)),
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: paint.ink,
                font: `${arabic ? 700 : 500} ${arabic ? ".8125rem" : ".75rem"} ${labelFace(arabic)}`,
              }}
            >
              {title}
            </span>
          )
        ) : drawn ? (
          <AutoCover title={title} author={meta.author} dir={book.dir} />
        ) : (
          <img
            src={src ?? undefined}
            alt=""
            onError={() => setImgFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: pres.objectFit, display: "block" }}
          />
        )}

        {!spines && pct > 0 && (
          <div
            style={{
              position: "absolute",
              insetInline: 0,
              bottom: 0,
              height: 3,
              background: "rgba(0,0,0,.22)",
            }}
          >
            <div
              style={{
                height: 3,
                width: `${pct}%`,
                background: finished ? "var(--done)" : "var(--acc)",
              }}
            />
          </div>
        )}

        {selected && !spines && (
          <>
            <div
              style={{
                position: "absolute",
                inset: 0,
                boxShadow: "inset 0 0 0 2px var(--acc)",
                background: "var(--act)",
              }}
            />
            <div
              style={{
                position: "absolute",
                insetBlockStart: 6,
                insetInlineEnd: 6,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "var(--acc)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                fontSize: 10,
              }}
            >
              <Icon name="check" size="sm" />
            </div>
          </>
        )}
      </div>

      {capRendered && (
        <div
          // Occupies its space unconditionally; only the paint changes. `visibility` rather than
          // unmounting is what holds the row's height steady under the pointer — and it is also
          // what keeps the hidden caption out of the accessibility tree without an `aria-hidden`
          // that React would have to maintain.
          className={capAlways ? "libd-cap libd-cap-always" : "libd-cap"}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-1)",
          }}
        >
          <div
            dir="auto"
            style={{
              unicodeBidi: "isolate",
              font: `${arabic ? 600 : 500} ${arabic ? ".875rem/1.4" : ".8125rem/1.3"} ${labelFace(arabic)}`,
              color: "var(--txt)",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              ...(vista ? { textShadow: "0 1px 0 var(--libd-cap-shadow)" } : {}),
            }}
          >
            {title}
          </div>
          <div
            dir="auto"
            style={{
              unicodeBidi: "isolate",
              font: "400 .6875rem var(--ui)",
              color: "var(--faint)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minHeight: "1.2em",
            }}
          >
            {meta.author ?? ""}
          </div>
        </div>
      )}
    </div>
  );
}
