// Vista — The Casement.
//
// Vista is the Sard Library with the frosted pane lifted off the stage. The sidebar and the toolbar
// are the shipping components at their shipping size, drawn on glass; the stage below them is where
// the reader's photograph shows through unveiled, and where the library's containers stand as
// furniture.
//
// THREE THINGS DECIDE EVERY CHOICE HERE.
//
//  1. CONTENT STATES THE FACT; GEOMETRY ONLY ACCELERATES THE SCAN. An aperture's own line reads
//     "11 books · 4 shelves" — it holds shelves. A sill's reads "6 books" — it holds books. Nothing
//     has to be decoded before the stage makes sense; proportion only makes the second glance
//     instant. Two earlier designs failed this test — one labelled every container "Case ·"/"Shelf
//     ·", the other asked the reader to count nested 7px frame insets — and both were rejected.
//
//  2. NO COVER IS EVER CROPPED. A piece of furniture is a COLUMN — recess, sample, sill, plate —
//     so the row the books stand in has a height of its own and nothing can be pushed past an
//     edge. Covers keep their own aspect ratio, and `fitSample` measures each row and shows one
//     fewer book rather than clipping one. The book is the primary visual content.
//
//  3. NOTHING FLOATS. Every book is inside a named container, including the books on no shelf:
//     خارج الأرفف is a container with a name, a count and a ghosted sill — the container is real,
//     the shelf inside it is not. An earlier design scattered those books across the photograph,
//     which read as debris rather than as a state of the library.

import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { BookTile } from "./BookTile";
import { AutoCover } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { atDensity, baseWidth, DENSITY_STEPS, itemWidth, type NavScope, type VistaChild, type VistaView } from "./model";
import { coverPresentation, type CoverMode } from "./coverPresentation";

/**
 * Vista's environment.
 *
 * When the reader has chosen a library background, THAT is the environment: the painted ground is
 * skipped entirely and only the grain is drawn, so the image stays visible through Vista's layer
 * instead of being replaced by it. The generated ground is the fallback for a library with no image
 * of its own, not a substitute for one.
 */
export const VISTA_GROUND =
  "radial-gradient(26% 16% at 76% 9%, rgba(255,243,214,.9), transparent 70%)," +
  "radial-gradient(120% 52% at 12% 62%, rgba(184,169,138,.55), transparent 68%)," +
  "linear-gradient(180deg, #BFD3D8 0%, #DCD3BC 40%, #D2AE84 64%, #9A7452 84%, #7A5B41 100%)";

export function VistaEnvironment({ hasUserBackground }: { dark: boolean; hasUserBackground: boolean }) {
  return (
    <>
      {!hasUserBackground && (
        <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: 0, background: VISTA_GROUND }} />
      )}
      <div aria-hidden className="v-grain" />
    </>
  );
}

export interface VistaProps {
  view: VistaView;
  density: number;
  /** Library preference: keep book names hidden until a book is touched. Covers and Vista only. */
  hideTitles?: boolean;
  paneWidth: number;
  mode: "browse" | "select" | "arrange";
  selected: Set<string>;
  carryId: string | null;
  /** Walk into a container. */
  onGo: (to: NavScope) => void;
  onOpenBook: (b: BookRow) => void;
  onEditBook: (b: BookRow) => void;
  /** The book's real position on a shelf — see `positionIn` in LibraryDesign. */
  positionIn: (shelfId: string | null | undefined, bookId: string) => number;
  onToggleSelect: (id: string) => void;
  onPickUp: (b: BookRow, shelfId: string, x: number, y: number) => void;
  onArrangeDown: (b: BookRow, shelfId: string, x: number, y: number, el: Element) => void;
  onRemoveFromShelf: (bookId: string, shelfId: string) => void;
  /** Delete the book itself — the library's one delete path. */
  onDeleteBook: (book: BookRow) => void;
  onSetFinished: (b: BookRow, finished: boolean) => void;
  libraryCoverMode: CoverMode;
  onPlace: (gap: { container: string; before: string | null }, categoryId: string | null) => void;
  /** The one ordering-gap renderer. A view says how a gap LOOKS; it never says what it means. */
  orderGap: (o: { section: string; before: string | null; key: string; className?: string;
    style?: React.CSSProperties; label?: string }) => React.ReactNode;
  /** A book lifted from خارج الأرفف is not on a shelf, so it cannot be taken off one. */
}

const CHIP_W = 42;
const SAMPLE_GAP = 12;
const GRID_GAP = 22;

/**
 * WHAT THE DENSITY CONTROL DOES IN VISTA.
 *
 * The reader's density setting is a COVER WIDTH — `DENSITY_WIDTHS` in the model, the same four
 * steps Covers and Spines size themselves from. Vista reads that same state, and grows the
 * CONTAINER around it: a bigger cover needs a bigger sill to stand on, so the shelf's own width
 * moves with the step and its height follows from the proportion that says it is a shelf.
 *
 * The columns are fixed rather than stretched (`repeat(auto-fill, var(--v-col))`, not `1fr`), which
 * is what makes every step visibly different — a stretched track absorbs the step into the column
 * count and two adjacent settings come out identical. What the containers do not take is left as
 * photograph, which is the composition's own intent rather than a gap.
 */
const SHELF_COL = [300, 348, 410, 490];
/** A shelf is landscape and a case is portrait, at every step and every pane width. */
const SHELF_RATIO = 1.62;
const CASE_RATIO = 0.8;
const CASE_COL_SCALE = 0.72;

/**
 * A case shows a smaller sample than a shelf, and its aperture is sized to hold TWO of them.
 *
 * Two covers you can recognise beat three you cannot, and beat one: one book in a case does not read
 * as a container of books. The aperture's width is therefore whichever is larger — its proportion to
 * the shelf beside it, or the room two of its own covers and the +N chip actually need. The
 * proportion that says it is a case is preserved either way, because the height follows the width.
 */
const CASE_COVER_SCALE = 0.72;

function metrics(density: number, paneWidth: number): React.CSSProperties {
  // A POSITION, NOT A STEP. This floored density to an index and then read `SHELF_COL[d]`, which
  // would have made the shelf column jump while every other measure moved smoothly.
  const d = Math.max(0, Math.min(DENSITY_STEPS - 1, density));
  // The stage's own padding, so a container never overflows a narrow pane.
  const avail = Math.max(240, (paneWidth || 1180) - 44);
  const col = Math.min(Math.round(atDensity(SHELF_COL, d)), avail);
  const cover = baseWidth(d);
  const caseCover = Math.round(cover * CASE_COVER_SCALE);
  // 2 covers + the gap between them + the chip and its gap + the sample's own side padding.
  const twoUp = 2 * caseCover + SAMPLE_GAP * 2 + CHIP_W + 42;
  const caseCol = Math.min(Math.max(Math.round(col * CASE_COL_SCALE), twoUp), avail);
  return {
    ["--v-col" as string]: col + "px",
    ["--v-row" as string]: Math.round(col / SHELF_RATIO) + "px",
    ["--v-case-col" as string]: caseCol + "px",
    ["--v-case-row" as string]: Math.round(caseCol / CASE_RATIO) + "px",
    ["--v-gap" as string]: GRID_GAP + "px",
    // The cover's own ceiling, straight from the reader's setting.
    ["--v-cover-w" as string]: cover + "px",
    ["--v-case-cover-w" as string]: caseCover + "px",
  } as React.CSSProperties;
}

/**
 * One cover, whole.
 *
 * An `<img>` bounded by a max height AND a max width with both dimensions left `auto`, so the
 * browser fits it inside that box AT ITS OWN ASPECT RATIO. A landscape cover comes out wide and
 * short, a tall one narrow and tall, and both are complete — nothing is cropped to a 2:3 rectangle.
 * A book with no cover file gets Sard's typeset jacket, which has no natural aspect and therefore
 * takes the 2:3 box the jacket is drawn for.
 */
function SampleCover({ book, coverMode, onSettled }: {
  book: BookRow; coverMode: CoverMode;
  onSettled: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const { t } = useI18n();
  const src = coverSrc(book);
  const pres = coverPresentation(book, !!src, { bg: "", ink: "" }, coverMode);
  if (pres.kind === "image" && src) {
    return (
      <img className="v-cover" src={src} alt="" draggable={false}
        onLoad={onSettled} onError={onSettled} />
    );
  }
  const meta = resolveBookMeta(book);
  // A typeset jacket has no natural aspect, so it takes the 2:3 box the jacket is drawn for. The
  // ceiling is the same one a cover file gets, so the two never disagree about size.
  return (
    <span className="v-cover v-cover-drawn">
      <AutoCover title={displayTitle(meta, t)} author={meta.author} dir={book.dir} />
    </span>
  );
}

/**
 * A row of sample covers inside a container.
 *
 * Every candidate is laid out; `fitSample` then removes covers from the END until the row fits,
 * having reserved the +N chip's own width first. Fewer books, never a clipped one — which is why
 * the total lives in `data-total` and the chip's text is written after measuring.
 */
function Sample({ c, slot, coverMode, onSettled, onPlace }: {
  c: VistaChild;
  slot: boolean;
  coverMode: CoverMode;
  onSettled: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  onPlace: (gap: { container: string; before: string | null }, categoryId: string | null) => void;
}) {
  const { t } = useI18n();
  const label = c.dropKind === "unfile" ? t("lib.takeOffShelf") : t("lib.placeHere");
  return (
    <span className="v-samplewrap">
      <span className="v-sample" data-total={c.total}>
        {slot && (
          <button
            className="v-slot"
            data-drop-shelf={c.drop!.shelfId}
            data-drop-cat={c.drop!.categoryId ?? ""}
            // A book dropped on a container it is not inside JOINS THE END of it — the reader is
            // filing it here, not saying it should come first.
            data-drop-before=""
            onClick={(e) => { e.stopPropagation(); onPlace({ container: c.drop!.shelfId, before: null }, c.drop!.categoryId); }}
            title={label}
            aria-label={label}
          />
        )}
        {c.books.map((b) => (
          <SampleCover key={b.id} book={b} coverMode={coverMode} onSettled={onSettled} />
        ))}
        <span className="v-more" dir="ltr" aria-hidden style={{ width: CHIP_W, display: "none" }} />
      </span>
    </span>
  );
}

/**
 * Decide how many covers each sample row can show whole.
 *
 * Imperative on purpose: the answer depends on laid-out widths, which no amount of React state can
 * know before the browser has measured them. Only `display` on the covers and the chip's own text
 * are touched, and neither is a React-controlled prop, so nothing here fights the renderer.
 */
function fitSample(row: HTMLElement, latn: (n: number) => string) {
  const total = Number(row.dataset.total) || 0;
  const chip = row.querySelector<HTMLElement>(".v-more");
  const slot = row.querySelector<HTMLElement>(".v-slot");
  const covers = [...row.querySelectorAll<HTMLElement>(".v-cover")];
  if (!chip) return;
  chip.style.display = "none";
  for (const c of covers) c.style.display = "";
  const avail = row.clientWidth;
  const base = slot ? slot.offsetWidth + SAMPLE_GAP : 0;
  const widths = covers.map((c) => c.offsetWidth);
  const fits = (n: number) => {
    let x = base;
    for (let i = 0; i < n; i++) x += widths[i] + (i ? SAMPLE_GAP : 0);
    if (total > n) x += (n ? SAMPLE_GAP : 0) + CHIP_W;
    return x <= avail;
  };
  let shown = covers.length;
  while (shown > 0 && !fits(shown)) shown--;
  covers.forEach((c, i) => { if (i >= shown) c.style.display = "none"; });
  if (total > shown) {
    chip.style.display = "grid";
    chip.textContent = "+" + latn(total - shown);
  }
}

export function ViewVista(props: VistaProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  const num = (n: number) => localeNum(n, lang);
  const { view } = props;
  const carrying = props.carryId != null;
  const iw = itemWidth(props.density, "vista", props.paneWidth);
  const stage = useRef<HTMLDivElement | null>(null);
  // The latest formatter, for the re-fit a cover triggers when it lands — which happens outside
  // React's own render, so it cannot close over a stale one.
  const numRef = useRef(num);
  numRef.current = num;
  const onCoverSettled = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const row = e.currentTarget.closest<HTMLElement>(".v-sample");
    if (row) fitSample(row, numRef.current);
  };

  const count = (n: number) => t("lib.count", { n: num(n) });

  // Re-measure after every render, and again whenever the stage changes width. A `ResizeObserver`
  // rather than a window listener, because the pane also changes width when a scrollbar appears —
  // which no resize event reports.
  useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    for (const row of host.querySelectorAll<HTMLElement>(".v-sample")) fitSample(row, num);
  });
  useEffect(() => {
    const host = stage.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      for (const row of host.querySelectorAll<HTMLElement>(".v-sample")) fitSample(row, num);
    });
    ro.observe(host);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // ---- one container ------------------------------------------------------------------------------
  const aperture = (c: VistaChild) => {
    const empty = c.total === 0 && c.children === 0;
    return (
      <button
        key={c.key}
        className={`v-piece v-aperture${empty ? " v-empty" : ""}`}
        onClick={() => props.onGo(c.enter)}
        title={t("lib.vista.openCase")}
      >
        <span aria-hidden className="v-bed" />
        <Sample c={c} slot={false} coverMode={props.libraryCoverMode} onSettled={onCoverSettled} onPlace={props.onPlace} />
        <span aria-hidden className="v-shelfline" />
        <span className="v-plate">
          <span
            dir="auto"
            className={`v-name v-name-case${c.ink ? " v-inked" : ""}`}
            style={c.ink ? ({ ["--v-ink-rule" as string]: c.ink } as React.CSSProperties) : undefined}
          >
            {c.name}
          </span>
          <span className="v-count">
            {empty
              ? t("lib.emptyCase")
              : `${count(c.filed ?? c.total)} · ${t("lib.shelvesCount", { n: num(c.children) })}`}
          </span>
          {/* THE COVERS ON THIS PLATE ARE NOT ALL FILED HERE. A rule shelf inside the case fills
              itself, so its books show through without belonging to the case — which is why the
              count above can read nothing while the plate is full. Said plainly rather than
              resolved by quietly adopting whichever number looks less odd. */}
          {c.filed !== undefined && c.total > c.filed && (
            <span className="v-count v-byrule">
              {t("lib.vista.shownByRule", { n: num(c.total - c.filed) })}
            </span>
          )}
        </span>
      </button>
    );
  };

  const sill = (c: VistaChild) => {
    const rule = c.kind === "rule";
    const open = c.kind === "unshelved";
    const empty = c.total === 0;
    // خارج الأرفف offers its slot only to a book that is ON a shelf; one already off every shelf
    // has nothing to be taken off.
    // No exception for a book that came from the unfiled run: that run is a container like any
    // other, and refusing it here is what let the same book be reorderable in one format only.
    const slot = carrying && !!c.drop;
    return (
      <button
        key={c.key}
        className={
          `v-piece v-sill${c.wide ? " v-wide" : ""}${rule ? " v-rule" : ""}` +
          `${open ? " v-open" : ""}${empty ? " v-empty" : ""}`
        }
        onClick={() => props.onGo(c.enter)}
        title={t("lib.vista.openShelf")}
      >
        <span aria-hidden className="v-bed" />
        <Sample c={c} slot={slot} coverMode={props.libraryCoverMode} onSettled={onCoverSettled} onPlace={props.onPlace} />
        {/* THE SILL, AND IT IS ONLY EVER REINFORCEMENT — the plate says it first.
            lit — a shelf, and its books stand on it.
            blank — a rule shelf: nothing rests here because nothing can be filed here.
            ghosted — خارج الأرفف: the shelf that is not there. */}
        <span aria-hidden className={`v-shelfline${rule ? " v-blank" : open ? " v-ghost" : ""}`} />
        {rule && <span aria-hidden className="v-rulemark" />}
        <span className="v-plate">
          <span dir="auto" className="v-name v-name-shelf">{c.name}</span>
          <span className="v-count">{empty ? t("lib.emptyShelfShort") : count(c.total)}</span>
        </span>
      </button>
    );
  };

  const tray = (c: VistaChild) => (
    <button
      key={c.key}
      className={`v-piece v-tray${c.name ? "" : " v-loose"}`}
      onClick={() => props.onGo(c.enter)}
      title={t("lib.vista.openCategory")}
    >
      <span aria-hidden className="v-bed" />
      <span className="v-tray-txt">
        <span dir="auto" className="v-name v-name-shelf">{c.name || t("lib.uncategorised")}</span>
        <span className="v-count">{count(c.total)}</span>
      </span>
      <Sample c={c} slot={carrying && !!c.drop} coverMode={props.libraryCoverMode} onSettled={onCoverSettled} onPlace={props.onPlace} />
    </button>
  );

  const furniture = (c: VistaChild) =>
    c.kind === "case" ? aperture(c) : c.kind === "category" ? tray(c) : sill(c);

  // ---- the books themselves -------------------------------------------------------------------------
  // A LANDING PLACE BEFORE EVERY BOOK, AND ONE AT THE TAIL — indices 0..n, exactly as the grouped
  // views have always drawn them. Rendering a single slot at index 0, as an earlier pass did, meant
  // a carried book could be placed FIRST and nowhere else: the drag worked, the mode worked, and
  // manual ordering was still impossible.
  // In front of a named book, or at the end when there is none. See `ViewGrouped`'s `gap`.
  /**
   * A LANDING PLACE, DRAWN BY THE ONE RENDERER THAT KNOWS WHAT ONE MEANS.
   *
   * This used to build its own `<button data-drop-shelf=…>`. A release hit-tests the point under the
   * pointer, found that MEMBERSHIP attribute, and classified an ordering gap as a move — which then
   * did nothing at all, because the book was already in that container. Measured on the reader's
   * library, on this very element: releasing on it moved a book from position 0 to position 0 in
   * silence, while CLICKING it moved it to 5 and said so. Vista knows what a gap looks like; it does
   * not get to decide what one means.
   */
  const gap = (before: string | null) =>
    carrying && view.bookDrop
      ? props.orderGap({
          section: view.bookDrop.categoryId
            ? `${view.bookDrop.shelfId}/${view.bookDrop.categoryId}`
            : view.bookDrop.shelfId,
          before,
          key: "gap-" + (before ?? "end"),
          className: "v-bookslot",
        })
      : null;

  // WHETHER THIS STAGE HAS AN ORDER OF ITS OWN — a computed shelf fills itself and خارج الأرفف is
  // not a collection, so neither keeps one. This still decides whether landing places are drawn
  // here, and whether the note below is shown.
  const ownOrder = !!view.bookDrop;
  // WHETHER A BOOK HERE CAN BE PICKED UP — which is a different question, and the answer is yes
  // wherever real books are drawn. A book outside a shelf has no order to change but can still be
  // carried to one; refusing to lift it was the reader's complaint.
  const arrangeable = view.books.length > 0;

  /**
   * FIXED TRACKS, NOT STRETCHED ONES — the rule this view already states for its containers, applied
   * to the books inside them.
   *
   * `minmax(iw, 1fr)` divides whatever is left over between the columns, and what is left over is
   * almost never a multiple of the column count. Measured on a real shelf: the tracks came out
   * 123.328px, four of five tiles began on a fractional x, and every tile had a fractional width —
   * against Covers, where every tile began and ended on a whole pixel.
   *
   * That is invisible on a photograph and very visible on a small control. The ⋯ is 24px with a 1px
   * hairline border, positioned against the tile; on a tile starting at x.67 the border is
   * antialiased across two pixel columns and the icon's strokes soften with it. Nothing about the
   * control differed between the two formats — same component, same tokens, same computed
   * background, border, radius, shadow and icon — it was simply being rasterised off the grid.
   *
   * `iw` is already an integer (`itemWidth` floors it), so a fixed track lands every tile, and every
   * control on one, on a whole pixel. What the row does not take is left as photograph, which is
   * this composition's own intent rather than a gap — the same sentence the density note above makes
   * about the shelves themselves.
   */
  const bookGrid = () => (
    <div className="v-books" style={{ gridTemplateColumns: `repeat(auto-fill,${iw}px)` }}>
      {view.books.map((b) => (
        <Fragment key={b.id}>
          {gap(b.id)}
            <BookTile
            book={b}
          view="vista"
          density={props.density}
          hideTitles={props.hideTitles}
          itemW={iw}
          selected={props.selected.has(b.id)}
          inHand={props.carryId === b.id}
          arrangeOn={props.mode === "arrange"}
          orderable={arrangeable}
          srcShelfId={view.bookSource ? view.bookSource.id : null}
          srcIndex={props.positionIn(view.bookSource ? view.bookSource.id : null, b.id)}
          selectOn={props.mode === "select"}
          onOpen={() => props.onOpenBook(b)}
          onEdit={() => props.onEditBook(b)}
          onToggleSelect={() => props.onToggleSelect(b.id)}
          onPickUp={(x, y) => view.bookSource && props.onPickUp(b, view.bookSource.id, x, y)}
          onArrangeDown={(x, y, el) =>
            view.bookSource && props.onArrangeDown(b, view.bookSource.id, x, y, el)}
          onRemoveFromShelf={
            view.bookSource && !view.bookSource.auto_rule
              ? () => props.onRemoveFromShelf(b.id, view.bookSource!.id)
              : null
          }
          onDelete={() => props.onDeleteBook(b)}
            onSetFinished={(f) => props.onSetFinished(b, f)}
            libraryCoverMode={props.libraryCoverMode}
          />
        </Fragment>
      ))}
      {gap(null)}
    </div>
  );

  // An empty place says what is MISSING from it. The toolbar has already named the container, so
  // the stage does not repeat the name — it states the one useful thing instead, which is what
  // makes an empty container read as intentional rather than as something having gone wrong.
  const emptyLine =
    view.here?.kind === "case"
      ? t("lib.vista.noShelves")
      : view.here?.kind === "category"
        ? t("lib.vista.noBooksCat")
        : view.here
          ? t("lib.vista.noBooksShelf")
          : t("lib.vista.nothingHere");

  const nothing = view.cases.length === 0 && view.children.length === 0 && view.books.length === 0;
  const trays = view.children.length > 0 && view.children[0].kind === "category";

  return (
    <div className="v-room" ref={stage} dir={rtl ? "rtl" : "ltr"}
      style={metrics(props.density, props.paneWidth)}>
      {/* THE CASE'S INK IS NOT DRAWN ACROSS THE STAGE ANY MORE.
          It was a 2px strip spanning the pane at the head of the room, `.v-stageink`, and it was
          the THIRD place the same fact was stated: the case's bar down its row in the sidebar,
          the ink underline beneath the case's name in the toolbar, and then this. Measured at the
          case scope — the strip at y=193, 1156x2, sitting exactly on the toolbar's bottom edge,
          which is what made it read as a separator ruled under the controls rather than as that
          case's colour. Nothing replaces it: the other two are attached to the thing they
          identify, and both are still drawn on the same screen. */}
      <div className="v-scroll">
        {nothing ? (
          <div className="v-nothing">
            <i aria-hidden />
            <span>{emptyLine}</span>
          </div>
        ) : view.books.length > 0 ? (
          <>
            {/* WHY THE CONTROL IS NOT THERE.
                Manual Ordering is no longer offered on a shelf whose order is not the reader's, so
                the note can no longer wait for the mode to be switched on — the reader would have
                to guess at an absence. It is stated whenever books are on screen that cannot be
                reordered, quietly, as a property of the shelf rather than a warning. */}
            {!ownOrder && (
              <div className="v-nudge v-nudge-static">
                {view.here?.rule ? t("lib.cannotPlace") : t("lib.vista.orderNotYours")}
              </div>
            )}
            {bookGrid()}
          </>
        ) : (
          <>
            {view.cases.length > 0 && <div className="v-grid v-cases">{view.cases.map(furniture)}</div>}
            {view.cases.length > 0 && view.children.length > 0 && (
              <div aria-hidden className="v-bandrule" />
            )}
            {view.children.length > 0 && (
              <div className={`v-grid ${trays ? "v-trays" : "v-shelves"}`}>
                {view.children.map(furniture)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
