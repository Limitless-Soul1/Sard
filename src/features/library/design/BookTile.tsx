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
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { AutoCover, autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { progressPct, isFinished, spineWidth, type DesignView } from "./model";
import { coverPresentation, type CoverMode } from "./coverPresentation";
import { Icon } from "../../../components/Icon";

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
  /** Arrange mode: the pointer went down on this book. The surface decides when it becomes a drag. */
  onArrangeDown: (clientX: number, clientY: number, el: Element) => void;
  /** null when the shelf cannot give a book up (a rule shelf). */
  onRemoveFromShelf: (() => void) | null;
  onSetFinished: (finished: boolean) => void;
  /** The library's Crop/Fit setting, which a book with no per-book fit follows. */
  libraryCoverMode: CoverMode;
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
  const capVisible = vista ? hover || selected : true;
  const showDots = !selectOn && (hover || menuOpen);

  const press = (e: React.PointerEvent) => {
    if (selectOn) return;
    // ARRANGE MODE IS A DRAG. Pressing a book takes hold of it immediately; the surface starts
    // carrying it once the pointer has actually travelled, and releasing over a slot places it.
    // It used to be a click to pick up and a second click on a destination, which is a different
    // manipulation from the one every other level of the hierarchy uses.
    if (arrangeOn) {
      e.preventDefault(); // no text selection, and no click reaching the cover underneath
      props.onArrangeDown(e.clientX, e.clientY, e.currentTarget as Element);
      return;
    }
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
    // Arrange is handled by the pointer handlers; a click here would pick the book up a second
    // time at the end of every drag.
    if (arrangeOn) {
      e.stopPropagation();
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
      style={{ ...cardStyle, ...(arrangeOn ? { cursor: inHand ? "grabbing" : "grab", touchAction: "none" } : {}) }}
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
          <Icon name="more" size="sm" />
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
            // Distinct from Open, which opens the book INSIDE Sard. This hands the file to the
            // OS file manager, revealing it where it actually lives on disk.
            { label: t("lib.openInFolder"), run: () => revealItemInDir(book.file_path).catch(() => {}) },
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
                maxWidth: SPINE_LABEL_MAX[density],
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: paint.ink,
                font: arabic ? "700 .8125rem var(--ar)" : "500 .75rem var(--ui)",
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
              ✓
            </div>
          </>
        )}
      </div>

      {capRendered && (
        <div
          aria-hidden={!capVisible}
          style={{
            // Occupies its space unconditionally; only the paint changes. `visibility` rather
            // than unmounting is what holds the row's height steady under the pointer.
            opacity: capVisible ? 1 : 0,
            visibility: capVisible ? "visible" : "hidden",
            transition: "opacity .14s ease-out",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            dir="auto"
            style={{
              unicodeBidi: "isolate",
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

/** A timer handle that survives re-render without re-creating the tile's callbacks. */
function useHoldRef() {
  const [ref] = useState(() => ({ current: null as number | null }));
  return ref;
}
