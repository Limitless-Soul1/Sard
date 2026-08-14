// Vista — the library on its own ground.
//
// SOURCE: `Sard Library - Vista (standalone).html`, and only that file. The base reference's
// fourth view is a different design (a constellation "field") which is deliberately NOT used
// here. Shelves read top to bottom as bands over a lit environment; each band caps at one row
// and offers "+n" to open the shelf in full.

import type { BookRow, CaseNode, ShelfNode } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { AutoCover } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { BookTile } from "./BookTile";
import { baseWidth, itemWidth, isFinished, isVirtualShelf, progressPct } from "./model";

/** The environment the library stands in — the design's own sky-to-ground gradient. */
export const VISTA_GROUND =
  "radial-gradient(26% 16% at 76% 9%, rgba(255,243,214,.9), transparent 70%)," +
  "radial-gradient(120% 52% at 12% 62%, rgba(184,169,138,.55), transparent 68%)," +
  "linear-gradient(180deg, #BFD3D8 0%, #DCD3BC 40%, #D2AE84 64%, #9A7452 84%, #7A5B41 100%)";

/**
 * Vista's environment.
 *
 * When the reader has chosen a library background, THAT is the environment: the painted ground
 * is skipped entirely and only the veil is drawn, so the image stays visible through Vista's
 * layer instead of being replaced by it. The generated ground is the fallback for a library
 * with no image of its own, not a substitute for one.
 */
export function VistaEnvironment({
  dark,
  hasUserBackground,
}: {
  dark: boolean;
  hasUserBackground: boolean;
}) {
  return (
    <>
      {!hasUserBackground && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            background: VISTA_GROUND,
          }}
        />
      )}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          background: dark
            ? "linear-gradient(180deg, rgba(0,0,0,.34) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,.3) 100%)"
            : "linear-gradient(180deg, rgba(245,238,221,.34) 0%, rgba(245,238,221,0) 20%, rgba(245,238,221,.22) 100%)",
        }}
      />
    </>
  );
}

export interface VistaBand {
  key: string;
  shelf: ShelfNode;
  caseNode: CaseNode | null;
  books: BookRow[];
  /** The category name, when this band is one run of a focused shelf. */
  runName: string | null;
}

export interface VistaProps {
  bands: VistaBand[];
  density: number;
  paneWidth: number;
  focused: boolean;
  mode: "browse" | "select" | "arrange";
  selected: Set<string>;
  carryId: string | null;
  onOpenShelf: (shelfId: string | null) => void;
  onOpenBook: (b: BookRow) => void;
  onEditBook: (b: BookRow) => void;
  onToggleSelect: (id: string) => void;
  onPickUp: (b: BookRow, shelfId: string, x: number, y: number) => void;
  onRemoveFromShelf: (bookId: string, shelfId: string) => void;
  onSetFinished: (b: BookRow, finished: boolean) => void;
  onPlace: (shelfId: string, categoryId: string | null, index: number) => void;
}

export function ViewVista(props: VistaProps) {
  const { t, lang } = useI18n();
  const rtl = lang === "ar";
  const num = (n: number) => localeNum(n, lang);
  const iw = itemWidth(props.density, "vista", props.paneWidth);
  const perRow = Math.max(
    2,
    Math.floor((Math.max(320, props.paneWidth - 96) + 20) / (baseWidth(props.density) + 20)),
  );
  const carrying = props.carryId != null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 30, padding: "0 32px" }}>
      {props.bands.map((band) => {
        const cap = props.focused ? Number.MAX_SAFE_INTEGER : band.books.length > perRow ? perRow - 1 : perRow;
        const shown = band.books.slice(0, cap);
        const more = !props.focused && band.books.length > cap;
        return (
          <div
            key={band.key}
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 16,
              padding: "0 0 2px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "6px 15px",
                  borderRadius: 22,
                  background: "rgba(22,16,10,.42)",
                  backdropFilter: "blur(14px) saturate(1.15)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)",
                  maxWidth: "72%",
                }}
              >
                {band.caseNode?.ink && (
                  <span
                    style={{
                      flex: "none",
                      alignSelf: "center",
                      width: 7,
                      height: 7,
                      borderRadius: 2,
                      background: band.caseNode.ink,
                    }}
                  />
                )}
                <span
                  dir="auto"
                  style={{
                    font: rtl ? "700 1.125rem var(--ar)" : "600 1rem var(--book)",
                    color: "#FDF7E9",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {band.shelf.name}
                  {band.runName ? ` · ${band.runName}` : ""}
                </span>
                <span style={{ font: "500 .6875rem var(--ui)", color: "rgba(253,247,233,.62)" }}>
                  {num(band.books.length)}
                </span>
                {band.caseNode && (
                  <span style={{ font: "400 .75rem var(--ui)", color: "rgba(253,247,233,.6)" }}>
                    {band.caseNode.name}
                  </span>
                )}
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => props.onOpenShelf(props.focused ? null : band.shelf.id)}
                style={{
                  flex: "none",
                  font: "500 .75rem var(--ui)",
                  color: "rgba(253,247,233,.86)",
                  padding: "6px 13px",
                  borderRadius: 22,
                  background: "rgba(22,16,10,.34)",
                  backdropFilter: "blur(12px)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,.16)",
                }}
              >
                {props.focused ? t("lib.vista.allShelves") : t("lib.vista.openShelf")}
              </button>
            </div>

            <div
              style={
                props.focused
                  ? {
                      display: "grid",
                      gridTemplateColumns: `repeat(auto-fill,minmax(${iw}px,1fr))`,
                      gap: "32px 22px",
                      alignItems: "end",
                    }
                  : {
                      display: "grid",
                      gridTemplateColumns: `repeat(${perRow},minmax(0,1fr))`,
                      gap: 22,
                      alignItems: "end",
                    }
              }
            >
              {shown.map((b, i) => (
                <div key={b.id} style={{ display: "contents" }}>
                {carrying && !band.shelf.auto_rule && !isVirtualShelf(band.shelf.id) && band.shelf.order_rule === "hand" && (
                  <button
                    onClick={() => props.onPlace(band.shelf.id, null, i)}
                    title={t("lib.placeHere")}
                    aria-label={t("lib.placeHere")}
                    style={{
                      width: "100%",
                      aspectRatio: "2/3",
                      border: "2px dashed var(--acc)",
                      borderRadius: 3,
                      background: "var(--act)",
                      animation: "sard-open .14s ease-out",
                    }}
                  />
                )}
                <BookTile
                  book={b}
                  view="vista"
                  density={props.density}
                  itemW={iw}
                  selected={props.selected.has(b.id)}
                  inHand={props.carryId === b.id}
                  arrangeOn={props.mode === "arrange"}
                  selectOn={props.mode === "select"}
                  onOpen={() => props.onOpenBook(b)}
                  onEdit={() => props.onEditBook(b)}
                  onToggleSelect={() => props.onToggleSelect(b.id)}
                  onPickUp={(x, y) => props.onPickUp(b, band.shelf.id, x, y)}
                  onRemoveFromShelf={
                    band.shelf.auto_rule ? null : () => props.onRemoveFromShelf(b.id, band.shelf.id)
                  }
                  onSetFinished={(f) => props.onSetFinished(b, f)}
                />
                </div>
              ))}

              {carrying && !band.shelf.auto_rule && band.shelf.order_rule === "hand" && (
                <button
                  onClick={() => props.onPlace(band.shelf.id, null, shown.length)}
                  title={t("lib.placeHere")}
                  aria-label={t("lib.placeHere")}
                  style={{
                    width: "100%",
                    aspectRatio: "2/3",
                    border: "2px dashed var(--acc)",
                    borderRadius: 3,
                    background: "var(--act)",
                    animation: "sard-open .14s ease-out",
                  }}
                />
              )}

              {more && (
                <button
                  onClick={() => props.onOpenShelf(band.shelf.id)}
                  style={{
                    width: "100%",
                    aspectRatio: "2/3",
                    borderRadius: 3,
                    display: "grid",
                    placeItems: "center",
                    font: "500 .8125rem var(--ui)",
                    color: "#FBF3E2",
                    background: "rgba(22,16,10,.34)",
                    backdropFilter: "blur(12px) saturate(1.1)",
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,.20)",
                  }}
                >
                  +{num(band.books.length - cap)}
                </button>
              )}

              {band.books.length === 0 && (
                <div
                  style={{
                    gridColumn: "1/-1",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    font: "400 .75rem var(--ui)",
                    color: "var(--mut)",
                  }}
                >
                  <span
                    style={{
                      flex: "none",
                      width: Math.round(iw * 0.6),
                      aspectRatio: "2/3",
                      border: "1.5px dashed var(--rule)",
                      borderRadius: 3,
                    }}
                  />
                  <span>{t("lib.emptyShelf")}</span>
                </div>
              )}
            </div>

            <div
              aria-hidden
              style={{
                height: 1,
                marginTop: 15,
                background: `linear-gradient(${rtl ? "270deg" : "90deg"}, rgba(255,255,255,.30), rgba(255,255,255,.16) 82%, transparent)`,
                boxShadow: "0 -16px 26px -18px rgba(24,14,6,.55)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hero plate — "Continue reading". Vista-only, per the design.
// ---------------------------------------------------------------------------

export function VistaHero({
  book,
  where,
  onOpen,
  onDetails,
}: {
  book: BookRow | null;
  where: string;
  onOpen: () => void;
  onDetails: () => void;
}) {
  const { t, lang } = useI18n();
  const num = (n: number) => localeNum(n, lang);

  if (!book) return null;
  const meta = resolveBookMeta(book);
  const title = displayTitle(meta, t);
  const pct = progressPct(book);
  const done = isFinished(book);

  return (
    <div
      style={{
        display: "flex",
        gap: 22,
        margin: "0 32px 30px",
        padding: 20,
        borderRadius: 16,
        background: "rgba(22,16,10,.34)",
        backdropFilter: "blur(16px) saturate(1.15)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18), var(--sh3)",
      }}
    >
      <div
        style={{
          flex: "none",
          width: 108,
          aspectRatio: "2/3",
          borderRadius: 3,
          overflow: "hidden",
          boxShadow: "var(--sh3)",
          background: "var(--lbox)",
        }}
      >
        <BookTileCover book={book} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span
            style={{
              font: "600 .625rem var(--ui)",
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "rgba(253,247,233,.72)",
            }}
          >
            {t("lib.hero.eyebrow")}
          </span>
          <span style={{ font: "500 .75rem var(--ui)", color: "rgba(253,247,233,.62)" }}>{where}</span>
        </div>
        <h2
          dir="auto"
          style={{
            margin: "8px 0 0",
            font: "600 1.375rem/1.25 var(--book)",
            color: "#FDF7E9",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </h2>
        <div style={{ font: "400 .875rem var(--ui)", color: "rgba(253,247,233,.72)", marginTop: 4 }}>
          {meta.author ?? ""}
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 9, paddingTop: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ font: "500 .75rem var(--ui)", color: "#FDF7E9" }}>{num(pct)}%</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,.22)", overflow: "hidden" }}>
              <div
                style={{
                  height: 4,
                  width: `${pct}%`,
                  background: done ? "var(--done)" : "var(--acc)",
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <button
              className="libd-hov-bright"
              onClick={onOpen}
              style={{
                height: 34,
                padding: "0 16px",
                borderRadius: 10,
                background: "var(--acc)",
                color: "var(--pap)",
                font: "600 .8125rem var(--ui)",
              }}
            >
              {pct > 0 ? t("lib.hero.continue") : t("lib.hero.start")}
            </button>
            <button
              onClick={onDetails}
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 10,
                font: "500 .8125rem var(--ui)",
                color: "rgba(253,247,233,.86)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22)",
              }}
            >
              {t("lib.hero.details")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The hero's cover — a real image when the book has one, else Sard's drawn jacket. */
function BookTileCover({ book }: { book: BookRow }) {
  const { t } = useI18n();
  const meta = resolveBookMeta(book);
  const title = displayTitle(meta, t);
  const src = coverSrc(book);
  if (!src) {
    return <AutoCover title={title} author={meta.author} dir={book.dir} />;
  }
  return <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
}
