// Details — sortable metadata.
//
// SOURCE: `Sard Library (standalone).html`, the design's `isDetails` path. The six-column
// grid (44px thumb · 1.6fr title · 1fr author · 54px format · 118px progress · 68px read)
// and the sticky header are the design's own measurements.

import type { BookRow } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { resolveBookMeta, displayTitle } from "../../../lib/bookMeta";
import { autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { fieldScript, fieldStyle } from "./bidi";
import { daysAgo, isFinished, pctText, progressPct, type DesignSort } from "./model";

const COLUMNS = "44px minmax(0,1.6fr) minmax(0,1fr) 54px 118px 68px";

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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: COLUMNS,
          gap: 16,
          alignItems: "center",
          padding: "0 12px 8px",
          position: "sticky",
          top: 0,
          background: "var(--pap)",
          zIndex: 5,
          borderBottom: "1px solid var(--rule)",
        }}
      >
        {columns.map((c, i) => (
          <button
            key={i}
            onClick={() => c.key && props.onSort(c.key)}
            disabled={!c.key}
            style={{
              font: "600 .625rem var(--ui)",
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: c.key && props.sort === c.key ? "var(--acc)" : "var(--faint)",
              justifyContent: c.align === "end" ? "flex-end" : "flex-start",
              cursor: c.key ? "pointer" : "default",
            }}
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
          <div
            key={b.id}
            onClick={() => (props.selectOn ? props.onToggleSelect(b.id) : props.onOpenBook(b))}
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
                  font: titleAr ? "700 1rem var(--ar)" : "500 .9375rem var(--ui)",
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
                font: authorAr ? "400 .9375rem var(--ar)" : "400 .8125rem var(--ui)",
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
          </div>
        );
      })}
    </div>
  );
}
