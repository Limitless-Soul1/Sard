// Details — sortable metadata.
//
// SOURCE: `Sard Library (standalone).html`, the design's `isDetails` path. The six-column
// grid (44px thumb · 1.6fr title · 1fr author · 54px format · 118px progress · 68px read)
// and the sticky header are the design's own measurements.

import { Fragment } from "react";
import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { fieldScript, fieldStyle } from "./bidi";
import { useBookPickup } from "./bookPickup";
import { BookActions, type BookActionsProps } from "./BookActions";
import type { CardOrder } from "../Library";
import { daysAgo, isFinished, pctText, progressPct, type DesignSort } from "./model";
import { labelFace } from "../../../lib/typography";


// THE ⋯ HAS A COLUMN OF ITS OWN — the seventh, and the reason it exists.
//
// It used to be positioned absolutely at the row's inline-end, which put it ON TOP of whichever
// column happened to sit at that edge: in Arabic that is the last one, so the control was drawn
// over the reading figures it was meant to sit beside. Floating it also left it belonging to
// nothing — near a row rather than part of one.
//
// A column costs 34px and answers both: the cell is laid out by the same grid as every other, so
// it cannot overlap anything, and it flips with the writing direction for free.
const COLUMNS = "44px minmax(0,1.6fr) minmax(0,1fr) 54px 118px 68px 34px";

export interface DetailsProps {
  /** Already ordered and filtered by the caller. */
  books: BookRow[];
  /** Where each book lives, for the second line under the title. */
  placeOf: (bookId: string) => string;
  sort: DesignSort;
  onSort: (s: DesignSort) => void;
  selected: Set<string>;
  selectOn: boolean;
  onOpenBook: (b: BookRow) => void;
  onToggleSelect: (id: string) => void;

  // ---- reordering ------------------------------------------------------------------------------
  //
  // Details joins the SHARED ordering protocol rather than growing one of its own. All it has to do
  // is say which book each row draws and where a book may land; the pickup gesture comes from
  // `useBookPickup`, and the drag itself — the ghost, the lit target, the hit-test and the release
  // — belongs to `LibraryDesign`'s window listeners and is not reimplemented here.
  //
  /**
   * A landing place before this row, when the book is a shelf-mate of the one in hand — and the
   * place after the whole list. A flat list can span many shelves, so a place cannot simply sit
   * between two neighbours: it belongs to one shelf, and carries that shelf's index.
   */
  gap: (b: BookRow) => React.ReactNode;
  /** The end of this book's container, when this book is the last of it on screen. */
  gapAfter: (b: BookRow) => React.ReactNode;
  /** The pickup descriptor for one book, carrying ITS shelf. Undefined when it is filed nowhere. */
  order: (b: BookRow) => CardOrder | undefined;
  /**
   * What can be done with a book. Details had NO book actions at all — no ⋯, no Open in folder, no
   * Mark read — so the same book offered a different set of choices depending only on the format
   * the reader had selected. It gets the same ones as every other view.
   */
  actions: (b: BookRow) => BookActionsProps;
  arrangeOn: boolean;
}

/** One row's share of the gesture. A hook cannot be called in a loop, so each row is a component. */
function DetailsRow(props: {
  book: BookRow;
  arrangeOn: boolean;
  /** The shared pickup descriptor, carrying this book's own shelf. Undefined when it has none. */
  order?: CardOrder;
  actions: BookActionsProps;
  selectOn: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  // Called unconditionally, as a hook must be — and told the truth about BOTH questions.
  //
  // This used to report `arrangeOn: props.arrangeOn && !!props.order`, which folded "the mode is
  // running" into "this row can be reordered". A row for a book filed nowhere then believed the
  // mode was off and opened its book on a click, with Manual Ordering plainly switched on above it.
  // The mode is a property of the screen; orderability is a property of the row. Kept apart, the
  // hook makes such a row INERT: the press is answered, nothing is armed, nothing opens.
  const orderable = props.order?.orderable === true;
  const pickup = useBookPickup({
    arrangeOn: props.arrangeOn,
    orderable,
    selectOn: props.selectOn,
    onArrangeDown: props.order?.onArrangeDown ?? (() => {}),
    onPickUp: props.order?.onPickUp ?? (() => {}),
    onOpen: props.onOpen,
    onToggleSelect: props.onToggleSelect,
  });
  const inHand = props.order?.inHand === true;
  // WHEN THE PRESS NEEDS ANSWERING AT ALL — this row can be lifted, or the mode is on and an open
  // has to be suppressed. Answering it otherwise would arm the press-and-hold on a book with no
  // shelf to be lifted from, and a hold SPENDS the press: it swallows the click that follows, so a
  // slightly slow press on an ordinary row would quietly stop opening the book.
  const wantsPress = orderable || props.arrangeOn;
  return (
    <div
      // The row names the book it draws, exactly as a tile does, so a reorder and a check can both
      // address it by identity. Details rows carried no identity at all before this.
      // The row names the book it draws, and where that book is filed — the shelf and index are
      // what let a release OVER THIS ROW resolve to a real position. See `dropTarget`.
      data-book={props.order ? props.order.bookId : undefined}
      data-shelf={props.order?.shelfId ?? undefined}
      data-index={props.order && props.order.index >= 0 ? props.order.index : undefined}
      onPointerDown={wantsPress ? pickup.onPointerDown : undefined}
      onPointerUp={wantsPress ? pickup.cancelHold : undefined}
      onPointerLeave={wantsPress ? pickup.cancelHold : undefined}
      onClick={pickup.onClick}
      style={{
        ...props.style,
        // The row anchors its own ⋯ menu, which is absolutely positioned like every other format's.
        position: "relative",
        // Whatever the gesture offers — `grab` on a row that can move, `default` on one that
        // cannot, and never `pointer`, because nothing here opens while the mode is on.
        cursor: props.arrangeOn ? (inHand ? "grabbing" : pickup.cursor) : props.style.cursor,
        // Only a row that can actually be dragged gives up touch scrolling over itself.
        ...(props.arrangeOn && orderable ? { touchAction: "none" as const } : {}),
        ...(inHand ? { opacity: 0.25 } : {}),
      }}
    >
      {props.children}
      {!props.selectOn && (
        <BookActions
          {...props.actions}
          // `.libd-dots` is hidden until `.libd-tile:hover`, and a row is not a tile — so without
          // this the control exists, occupies space and can never be clicked. Rows are sparse
          // enough to carry it openly.
          //
          // `position: static` is what puts it IN the grid: the shared control positions itself
          // absolutely by default, which is right for a tile drawn over a cover and wrong for a row
          // that has a column waiting for it. Everything else about its appearance — ground,
          // border, glyph colour, the pressed and focus states — is left to the shared component,
          // so this row cannot drift from the other four formats.
          buttonStyle={{
            position: "static",
            visibility: "visible",
            justifySelf: "center",
            alignSelf: "center",
          }}
        />
      )}
    </div>
  );
}

export function ViewDetails(props: DetailsProps) {
  const { t, lang } = useI18n();
  const num = (n: number) => localeNum(n, lang);



  const columns: { key: DesignSort | null; label: string; align?: "end" }[] = [
    { key: null, label: "" },
    { key: "title", label: t("lib.col.title") },
    { key: "author", label: t("lib.col.author") },
    { key: null, label: t("lib.col.format") },
    { key: "progress", label: t("lib.col.progress") },
    { key: "recent", label: t("lib.col.read"), align: "end" },
    // The ⋯ column. Unlabelled and unsortable — it holds a control, not a field.
    { key: null, label: "" },
  ];

  // ALIGNMENT FROM THE INTERFACE, direction from the content. `text-align: start` would follow
  // each cell's own auto-direction, which is what let an English title and an Arabic author drift
  // to opposite ends of their columns and read as though they had swapped places.
  const cell = fieldStyle(lang === "ar");

  const lastReadLabel = (b: BookRow) => {
    const d = daysAgo(b.read_at);
    if (d == null) return "—";
    return d === 0 ? t("lib.today") : t("lib.daysAgo", { n: num(d) });
  };

  return (
    <div style={{ padding: "0 32px" }}>
      {/* THE COLUMN RAIL.
          It was a row of bare buttons in uppercase micro-caps with a hairline under it — scaffolding
          rather than a heading, and `text-transform: uppercase` does nothing to Arabic at all, so in
          the language this library is mostly read in it bought only a loss of letterform. What it
          needs is what a printed table gives its columns: a little air, one weight of type, and a
          rule that reads as the start of the body rather than as a box around the header. */}
      <div
        className="vd-rail"
        style={{
          display: "grid",
          gridTemplateColumns: COLUMNS,
          gap: 16,
          alignItems: "baseline",
          // Room above the labels as well as below. At 2px the Arabic ascenders sat hard against
          // the rail's top edge and the row read as cropped.
          padding: "12px 12px 10px",
          position: "sticky",
          top: 0,
          background: "var(--pap)",
          zIndex: 5,
          boxShadow: "inset 0 -1px 0 var(--rule)",
        }}
      >
        {columns.map((c, i) => (
          <button
            key={i}
            onClick={() => c.key && props.onSort(c.key)}
            disabled={!c.key}
            className={`vd-col${c.key ? " vd-col--sortable" : ""}${c.key && props.sort === c.key ? " on" : ""}`}
            style={{ justifyContent: c.align === "end" ? "flex-end" : "flex-start" }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {props.books.map((b) => {
        const meta = resolveBookMeta(b);
        const title = displayTitle(meta, t);
        // Each field is judged on its OWN script. One flag taken from the title used to set the
        // author's face too, so an Arabic book by an English author got the English name in the
        // Arabic face, and the reverse pair got the Arabic name in the Latin one.
        const titleAr = fieldScript(title, b.dir) === "arabic";
        const authorAr = fieldScript(meta.author) === "arabic";
        const paint = autoCoverPaint(title);
        const src = coverSrc(b);
        const pct = progressPct(b);
        const done = isFinished(b);
        const sel = props.selected.has(b.id);
        return (
          <Fragment key={b.id}>
          {props.gap(b)}
          <DetailsRow
            book={b}
            arrangeOn={props.arrangeOn}
            order={props.order(b)}
            actions={props.actions(b)}
            selectOn={props.selectOn}
            onOpen={() => props.onOpenBook(b)}
            onToggleSelect={() => props.onToggleSelect(b.id)}
            style={{
              display: "grid",
              gridTemplateColumns: COLUMNS,
              gap: 16,
              alignItems: "center",
              padding: "10px 12px",
              borderRadius: 8,
              cursor: "pointer",
              boxShadow: "inset 0 -1px 0 var(--brd)",
              background: sel ? "var(--act)" : undefined,
            }}
          >
            <div
              style={{
                width: 34,
                height: 50,
                borderRadius: "2px 3px 3px 2px",
                background: src ? "var(--lbox)" : paint.bg,
                boxShadow: "var(--sh1)",
                overflow: "hidden",
              }}
            >
              {src && (
                <img
                  src={src}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                dir="auto"
                style={{
                  font: `${titleAr ? 700 : 500} ${titleAr ? "1rem" : ".9375rem"} ${labelFace(titleAr)}`,
                  ...cell,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </div>
              <div
                dir="auto"
                style={{
                  font: "400 .6875rem var(--ui)",
                  color: "var(--faint)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  ...cell,
                }}
              >
                {props.placeOf(b.id)}
              </div>
            </div>
            <div
              dir="auto"
              style={{
                // `rowAuthorStyle` in the design of record, exactly: Amiri for Arabic, the chrome
                // face for Latin. The two scripts differ here BY DESIGN — Arabic is always Amiri —
                // and the field decides its own script, so an English author under an Arabic title
                // is not dragged into the Arabic face by the title beside it.
                font: `${authorAr ? "400 .9375rem" : "400 .8125rem"} ${labelFace(authorAr)}`,
                ...cell,
                color: "var(--mut)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {meta.author ?? ""}
            </div>
            <div
              style={{
                font: "500 .6875rem var(--ui)",
                color: "var(--faint)",
                letterSpacing: ".06em",
              }}
            >
              {(b.format ?? "").toUpperCase()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: "var(--lbox)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: 4,
                    width: `${pct}%`,
                    background: done ? "var(--done)" : "var(--acc)",
                  }}
                />
              </div>
              <span
                style={{
                  font: "500 .6875rem var(--ui)",
                  width: 34,
                  textAlign: "end",
                  color: done ? "var(--done)" : "var(--mut)",
                }}
              >
                {pctText(b, t("lib.finished"))}
              </span>
            </div>
            <div
              style={{
                font: "400 .75rem var(--ui)",
                color: "var(--faint)",
                textAlign: "end",
              }}
            >
              {lastReadLabel(b)}
            </div>
          </DetailsRow>
          {props.gapAfter(b)}
          </Fragment>
        );
      })}
    </div>
  );
}
