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
import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { AutoCover, autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { progressPct, isFinished, spineWidth, type DesignView } from "./model";

/** Cover heights per density step, for Spines. The design's numbers. */
const SPINE_HEIGHTS = [104, 132, 168, 208];
const SPINE_LABEL_MAX = [96, 124, 160, 200];

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export interface BookTileProps {
  book: BookRow;
  view: DesignView;
  density: number;
  /** Rendered width for a cover tile; Spines derives its own from the book. */
  itemW: number;
  selected: boolean;
  /** True while this book is the one being carried in arrange mode. */
  inHand: boolean;
  arrangeOn: boolean;
  selectOn: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleSelect: () => void;
  onPickUp: (clientX: number, clientY: number) => void;
  /** null when the shelf cannot give a book up (a rule shelf). */
  onRemoveFromShelf: (() => void) | null;
  onSetFinished: (finished: boolean) => void;
}

export function BookTile(props: BookTileProps) {
  const { book, view, density, itemW, selected, inHand, arrangeOn, selectOn } = props;
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const spines = view === "spines";
  const vista = view === "vista";
  const meta = resolveBookMeta(book);
  const title = displayTitle(meta, t);
  const arabic = book.dir === "rtl" || ARABIC.test(title);
  const paint = autoCoverPaint(title);
  const src = coverSrc(book);
  const drawn = !src || imgFailed;
  const pct = progressPct(book);
  const finished = isFinished(book);
  const w = spines ? spineWidth(book, density) : itemW;

  // The design shows the caption always in Covers, on hover/selection in Vista, never in Spines.
  const showCap = vista ? hover || selected : !spines;
  const showDots = !selectOn && (hover || menuOpen);

  const press = (e: React.PointerEvent) => {
    if (arrangeOn || selectOn) return;
    // Press-and-hold picks a book up outside arrange mode — the design's own affordance.
    const x = e.clientX;
    const y = e.clientY;
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null;
      props.onPickUp(x, y);
    }, 340);
  };
  const release = () => {
    if (holdRef.current) {
      window.clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };
  const holdRef = useHoldRef();

  const click = (e: React.MouseEvent) => {
    if (arrangeOn) {
      e.stopPropagation();
      props.onPickUp(e.clientX, e.clientY);
      return;
    }
    if (selectOn) {
      props.onToggleSelect();
      return;
    }
    props.onOpen();
  };

  const cardStyle: React.CSSProperties = spines
    ? {
        position: "relative",
        display: "flex",
        alignItems: "flex-end",
        width: w,
        cursor: "pointer",
        opacity: inHand ? 0.25 : undefined,
        transition: "transform .14s ease-out",
        transform: hover ? (arrangeOn ? "translateY(-5px)" : "translateY(-3px)") : undefined,
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
        transition: "transform .14s ease-out",
        transform: hover ? (arrangeOn ? "translateY(-5px)" : "translateY(-3px)") : undefined,
      };

  // Vista gives the cover real thickness — the design's own shadow stack for that view.
  const vistaCover =
    "0 22px 26px -16px rgba(24,14,6,.55), 0 6px 12px -6px rgba(24,14,6,.42), 0 1px 2px rgba(24,14,6,.32)," +
    "inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.07)";

  const coverStyle: React.CSSProperties = spines
    ? {
        position: "relative",
        width: w,
        height: SPINE_HEIGHTS[density],
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
      style={cardStyle}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        release();
      }}
      onPointerDown={press}
      onPointerUp={release}
      onClick={click}
    >
      {showDots && (
        <button
          title={t("lib.bookActions")}
          aria-label={t("lib.bookActions")}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          style={{
            position: "absolute",
            zIndex: 12,
            insetBlockStart: spines ? -26 : 6,
            insetInlineEnd: spines ? -4 : 6,
            width: 24,
            height: 24,
            borderRadius: 8,
            background: "var(--chr)",
            border: "1px solid var(--brd)",
            boxShadow: "var(--sh2)",
            color: "var(--txt)",
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ⋯
        </button>
      )}

      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            zIndex: 30,
            insetBlockStart: 34,
            insetInlineEnd: 0,
            width: 206,
            background: "var(--chr)",
            border: "1px solid var(--brd)",
            borderRadius: 11,
            boxShadow: "var(--sh4)",
            padding: 6,
            animation: "sard-rise .12s ease-out",
          }}
        >
          {[
            { label: t("lib.editDetails"), run: props.onEdit },
            { label: t("lib.openBook"), run: props.onOpen },
            {
              label: finished ? t("lib.markUnread") : t("lib.markRead"),
              run: () => props.onSetFinished(!finished),
            },
            ...(props.onRemoveFromShelf
              ? [{ label: t("lib.removeFromShelf"), run: props.onRemoveFromShelf }]
              : []),
          ].map((a) => (
            <button
              key={a.label}
              className="libd-hov"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                a.run();
              }}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                textAlign: "start",
                padding: "7px 10px",
                borderRadius: 8,
                font: "500 .8125rem var(--ui)",
                color: "var(--mut)",
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div style={coverStyle}>
        {spines ? (
          <span
            style={{
              transform: "rotate(-90deg)",
              transformOrigin: "center",
              whiteSpace: "nowrap",
              maxWidth: SPINE_LABEL_MAX[density],
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: paint.ink,
              font: arabic ? "700 .8125rem var(--ar)" : "500 .75rem var(--ui)",
            }}
          >
            {title}
          </span>
        ) : drawn ? (
          <AutoCover title={title} author={meta.author} dir={book.dir} />
        ) : (
          <img
            src={src ?? undefined}
            alt=""
            onError={() => setImgFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
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
              ✓
            </div>
          </>
        )}
      </div>

      {showCap && (
        <>
          <div
            style={{
              font: arabic ? "600 .875rem/1.4 var(--ar)" : "500 .8125rem/1.3 var(--ui)",
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
            style={{
              font: "400 .6875rem var(--ui)",
              color: "var(--faint)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.author ?? ""}
          </div>
        </>
      )}
    </div>
  );
}

/** A timer handle that survives re-render without re-creating the tile's callbacks. */
function useHoldRef() {
  const [ref] = useState(() => ({ current: null as number | null }));
  return ref;
}
