// The library's skeleton — the permanent body the views are drawn inside.
//
// SOURCE: `Sard Library - Vista (standalone).html`, whose chrome is the design of record.
// Sidebar geometry (244px, 18/12/12 padding), the cases tree with its discs and grips, the
// breadcrumb line, the title row with Select / Arrange by hand / Add books, and the console
// row with search, the view switcher, the density steps and the sort menu — all carried over
// with the design's own measurements.

import { useState } from "react";
import type { CaseNode, ShelfNode } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { localeNum } from "../../../lib/format";
import { Hoopoe } from "../Hoopoe";
import { CaseManageMenu } from "./Menus";
import { DENSITY_STEPS, DESIGN_SORTS, type DesignSort, type DesignView } from "./model";

export type Section = "library" | "inbox" | "cards" | "bookmarks";

/** What the main pane is currently scoped to. */
export interface Scope {
  caseId: string | null;
  shelfId: string | null;
}

interface SidebarProps {
  section: Section;
  onSection: (s: Section) => void;
  cases: CaseNode[];
  loose: ShelfNode[];
  bookCount: number;
  scope: Scope;
  onScope: (s: Scope) => void;
  openCases: Set<string>;
  onToggleCase: (id: string) => void;
  onNewCase: (name: string) => void;
  onNewShelf: (caseId: string | null, name: string) => void;
  onRenameCase: (id: string, name: string) => void;
  onDeleteCase: (id: string) => void;
  /** Direction is -1 (earlier) or +1 (later) among the case's peers. */
  onMoveCase: (id: string, direction: number) => void;
  onNewRuleShelf: (caseId: string) => void;
  /** RAWY-31's shelf rename, used by the sidebar's inline editor. */
  onRenameShelf: (id: string, name: string) => void;
  onSettings: () => void;
  themeName: string;
  langName: string;
}

const navGlyph = (id: string): React.CSSProperties => ({
  flex: "none",
  width: 13,
  height: 13,
  border: "1.5px solid currentColor",
  borderRadius: id === "reading" ? "50%" : id === "inbox" ? 3 : 1,
  opacity: 0.85,
});

const navRow = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  height: 34,
  padding: "0 10px",
  borderRadius: 8,
  font: "500 .8125rem var(--ui)",
  color: active ? "var(--txt)" : "var(--mut)",
  background: active ? "var(--act)" : "transparent",
  textAlign: "start",
});

export function Sidebar(props: SidebarProps) {
  const { t, lang } = useI18n();
  const [creatingCase, setCreatingCase] = useState(false);
  const [creatingShelfIn, setCreatingShelfIn] = useState<string | null | false>(false);
  const [renamingShelf, setRenamingShelf] = useState<string | null>(null);
  const [renamingCase, setRenamingCase] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const num = (n: number) => localeNum(n, lang);

  const nav: { id: Section | "reading"; label: string; count?: number }[] = [
    { id: "library", label: t("lib.nav.library"), count: props.bookCount },
    { id: "reading", label: t("lib.nav.readingNow") },
    { id: "inbox", label: t("lib.nav.highlights") },
    { id: "bookmarks", label: t("lib.nav.bookmarks") },
    { id: "cards", label: t("lib.nav.cards") },
  ];

  const commit = (fn: (name: string) => void) => {
    const name = draft.trim();
    setDraft("");
    setCreatingCase(false);
    setCreatingShelfIn(false);
    if (name) fn(name);
  };

  const draftInput = (onCommit: () => void, placeholder: string, style: React.CSSProperties) => (
    <input
      autoFocus
      value={draft}
      dir="auto"
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") {
          setDraft("");
          setCreatingCase(false);
          setCreatingShelfIn(false);
        }
      }}
      onBlur={onCommit}
      style={{
        background: "var(--soft)",
        border: "1px solid var(--brd)",
        outline: "none",
        ...style,
      }}
    />
  );

  // The design's shelf row: a mark, the name, the count. Shelf management lives in the shelf's
  // own order popover in the main pane, which is where the design puts it — not here.
  const shelfRow = (s: ShelfNode) => {
    const active = props.scope.shelfId === s.id;
    if (renamingShelf === s.id) {
      return (
        <span key={s.id}>
          {draftInput(
            () => {
              const name = draft.trim();
              setRenamingShelf(null);
              setDraft("");
              if (name) props.onRenameShelf(s.id, name);
            },
            t("lib.shelf.namePlaceholder"),
            { margin: "3px 8px 3px 10px", borderRadius: 6, padding: "5px 8px", font: "500 .75rem var(--ui)" },
          )}
        </span>
      );
    }
    return (
      <button
        key={s.id}
        className="libd-hov"
        onClick={() => props.onScope({ caseId: s.case_id, shelfId: active ? null : s.id })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 28,
          padding: "0 10px",
          borderRadius: 7,
          font: "500 .75rem var(--ui)",
          color: active ? "var(--txt)" : "var(--mut)",
          background: active ? "var(--act)" : "transparent",
        }}
      >
        <span
          style={{
            flex: "none",
            width: 5,
            height: 5,
            borderRadius: s.auto_rule ? "50%" : 1,
            background: active ? "var(--acc)" : "var(--faint)",
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "start",
          }}
        >
          {s.name}
        </span>
        <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>{num(s.count)}</span>
      </button>
    );
  };

  return (
    // `.lib-sidebar` carries the BACKGROUND only. RAWY-278 makes it translucent with a
    // blur that follows the blur slider whenever a library image is set, and that rule cannot
    // win against an inline `background`, so this one is not set inline. The design's geometry
    // — 244px, its own padding — is inline and so still overrides the class's own 228px.
    <aside
      className="lib-sidebar"
      style={{
        width: 244,
        flex: "none",
        borderInlineEnd: "1px solid var(--brd)",
        display: "flex",
        flexDirection: "column",
        padding: "18px 12px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 8px 18px" }}>
        <Hoopoe size={22} />
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, direction: "ltr" }}>
          <b style={{ font: "600 1.0625rem/1 var(--ui)" }}>Sard</b>
          <i
            style={{
              width: 1.5,
              height: 16,
              alignSelf: "center",
              background: "currentColor",
              opacity: 0.28,
            }}
          />
          <em style={{ font: "700 1.1875rem/1 var(--ar)", fontStyle: "normal" }}>سَرْد</em>
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {nav.map((n) => (
          <button
            key={n.id}
            className="libd-hov"
            disabled={n.id === "reading"}
            onClick={() => n.id !== "reading" && props.onSection(n.id as Section)}
            style={{
              ...navRow(n.id === props.section),
              opacity: n.id === "reading" ? 0.6 : undefined,
              cursor: n.id === "reading" ? "default" : "pointer",
            }}
          >
            <span style={navGlyph(n.id)} />
            <span
              style={{
                flex: 1,
                textAlign: "start",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.label}
            </span>
            {n.count != null && (
              <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>
                {num(n.count)}
              </span>
            )}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 10px 6px",
        }}
      >
        <span
          style={{
            font: "600 .625rem var(--ui)",
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: "var(--faint)",
          }}
        >
          {t("lib.cases")}
        </span>
        <button
          className="libd-hov libd-hov-txt"
          title={t("lib.newCase")}
          aria-label={t("lib.newCase")}
          onClick={() => {
            setDraft("");
            setCreatingCase(true);
          }}
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: "grid",
            placeItems: "center",
            color: "var(--mut)",
            fontSize: 15,
            lineHeight: 1,
          }}
        >
          +
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          scrollbarWidth: "thin",
          paddingBottom: 8,
        }}
      >
        {props.cases.map((c) => {
          const open = props.openCases.has(c.id);
          const active = props.scope.caseId === c.id && !props.scope.shelfId;
          if (renamingCase === c.id) {
            return (
              <span key={c.id}>
                {draftInput(
                  () => {
                    const name = draft.trim();
                    setRenamingCase(null);
                    setDraft("");
                    if (name) props.onRenameCase(c.id, name);
                  },
                  t("lib.caseName"),
                  { margin: "4px 2px", borderRadius: 7, padding: "7px 9px", font: "500 .8125rem var(--ui)" },
                )}
              </span>
            );
          }
          return (
            <div key={c.id} style={{ position: "relative" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  borderRadius: 8,
                  padding: "0 6px 0 2px",
                  background: active ? "var(--act)" : "transparent",
                }}
              >
                <button
                  className="libd-hov"
                  onClick={() => props.onToggleCase(c.id)}
                  aria-label={c.name}
                  style={{ flex: "none", width: 20, height: 24, borderRadius: 6 }}
                >
                  <span
                    style={{
                      width: 0,
                      height: 0,
                      borderInlineStart: "4px solid currentColor",
                      borderBlockStart: "3.5px solid transparent",
                      borderBlockEnd: "3.5px solid transparent",
                      color: "var(--faint)",
                      transform: open ? "rotate(90deg)" : undefined,
                      transition: "transform .14s ease-out",
                    }}
                  />
                </button>
                <button
                  onClick={() => props.onScope({ caseId: c.id, shelfId: null })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    textAlign: "start",
                    padding: "6px 0",
                  }}
                >
                  {c.ink && (
                    <span
                      style={{
                        flex: "none",
                        width: 7,
                        height: 7,
                        borderRadius: 2,
                        background: c.ink,
                      }}
                    />
                  )}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      font: "600 .8125rem var(--ui)",
                      color: active ? "var(--txt)" : "var(--txt)",
                    }}
                  >
                    {c.name}
                  </span>
                  <span style={{ font: "500 .6875rem var(--ui)", color: "var(--faint)" }}>
                    {num(c.count)}
                  </span>
                </button>
                <span style={{ position: "relative", flex: "none" }}>
                  <button
                    className="libd-hov libd-hov-txt"
                    title={t("lib.manage")}
                    aria-label={t("lib.manage")}
                    onClick={() => setManaging((m) => (m === c.id ? null : c.id))}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      color: "var(--faint)",
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    ⋯
                  </button>
                  {managing === c.id && (
                    <CaseManageMenu
                      onRename={() => {
                        setDraft(c.name);
                        setRenamingCase(c.id);
                      }}
                      onNewShelf={() => {
                        setDraft("");
                        setCreatingShelfIn(c.id);
                      }}
                      onNewRuleShelf={() => props.onNewRuleShelf(c.id)}
                      onMoveUp={() => props.onMoveCase(c.id, -1)}
                      onMoveDown={() => props.onMoveCase(c.id, 1)}
                      onDelete={() => props.onDeleteCase(c.id)}
                      onClose={() => setManaging(null)}
                    />
                  )}
                </span>
              </div>

              {open && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    padding: "1px 0 6px 0",
                    marginInlineStart: 22,
                    borderInlineStart: "1px solid var(--brd)",
                  }}
                >
                  {c.shelves.map(shelfRow)}
                  {creatingShelfIn === c.id
                    ? draftInput(() => commit((n) => props.onNewShelf(c.id, n)), t("lib.shelf.namePlaceholder"), {
                        margin: "3px 8px 3px 10px",
                        borderRadius: 6,
                        padding: "5px 8px",
                        font: "500 .75rem var(--ui)",
                      })
                    : (
                      <button
                        className="libd-hov-txt"
                        onClick={() => {
                          setDraft("");
                          setCreatingShelfIn(c.id);
                        }}
                        style={{
                          justifyContent: "flex-start",
                          padding: "5px 10px",
                          font: "500 .6875rem var(--ui)",
                          color: "var(--faint)",
                        }}
                      >
                        + {t("lib.newShelf")}
                      </button>
                    )}
                </div>
              )}
            </div>
          );
        })}

        {creatingCase &&
          draftInput(() => commit(props.onNewCase), t("lib.caseName"), {
            margin: "4px 2px",
            borderRadius: 7,
            padding: "7px 9px",
            font: "500 .8125rem var(--ui)",
          })}

        {props.loose.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingTop: 8 }}>
            <span
              style={{
                font: "600 .625rem var(--ui)",
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: "var(--faint)",
                padding: "6px 10px 4px",
              }}
            >
              {t("lib.unfiled")}
            </span>
            {props.loose.map(shelfRow)}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "auto",
          paddingTop: 10,
          borderTop: "1px solid var(--brd)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          font: "500 .75rem var(--ui)",
          color: "var(--mut)",
        }}
      >
        <button className="libd-hov-txt" onClick={props.onSettings} style={{ padding: "6px 8px" }}>
          {props.langName}
        </button>
        <button className="libd-hov-txt" onClick={props.onSettings} style={{ padding: "6px 8px" }}>
          {props.themeName}
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header — breadcrumbs, title row, and the console row.
// ---------------------------------------------------------------------------

interface HeaderProps {
  crumbs: { label: string; go: () => void }[];
  heading: string;
  subcount: string;
  mode: "browse" | "select" | "arrange";
  onToggleSelect: () => void;
  onToggleArrange: () => void;
  onAddBooks: () => void;
  importing: boolean;
  query: string;
  onQuery: (q: string) => void;
  view: DesignView;
  onView: (v: DesignView) => void;
  density: number;
  onDensity: (d: number) => void;
  sort: DesignSort;
  onSort: (s: DesignSort) => void;
  /** Vista floats its header over the environment. */
  overEnvironment: boolean;
  /** Grid's own control, shown only while Grid is the view — as it was before. */
  coverMode: "crop" | "fit";
  onCoverMode: () => void;
  format: string | null;
  onFormat: (f: string | null) => void;
}

const ctlBtn = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 32,
  padding: "0 12px",
  borderRadius: 9,
  font: "500 .8125rem var(--ui)",
  border: `1px solid ${active ? "var(--acc)" : "var(--brd)"}`,
  color: active ? "var(--acc)" : "var(--mut)",
  background: active ? "var(--act)" : "var(--pap)",
});

const VIEW_ICONS: Record<DesignView, string> = {
  grid: "linear-gradient(90deg,currentColor 45%,transparent 45%),linear-gradient(180deg,currentColor 45%,transparent 45%)",
  covers:
    "linear-gradient(90deg,currentColor 45%,transparent 45%),linear-gradient(180deg,currentColor 45%,transparent 45%)",
  spines: "repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 4px)",
  details: "repeating-linear-gradient(180deg,currentColor 0 2px,transparent 2px 5px)",
  vista: "radial-gradient(circle at 50% 70%, currentColor 30%, transparent 32%)",
};

export function Header(props: HeaderProps) {
  const { t } = useI18n();
  const [sortOpen, setSortOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);

  const views: { id: DesignView; label: string; hint: string }[] = [
    { id: "grid", label: t("lib.view.grid"), hint: t("lib.view.gridHint") },
    { id: "covers", label: t("lib.view.covers"), hint: t("lib.view.coversHint") },
    { id: "spines", label: t("lib.view.spines"), hint: t("lib.view.spinesHint") },
    { id: "details", label: t("lib.view.details"), hint: t("lib.view.detailsHint") },
    { id: "vista", label: t("lib.view.vista"), hint: t("lib.view.vistaHint") },
  ];

  const sortLabel: Record<DesignSort, string> = {
    recent: t("lib.sort.recent"),
    added: t("lib.sort.added"),
    title: t("lib.sort.title"),
    author: t("lib.sort.author"),
    progress: t("lib.sort.progress"),
  };

  const groupStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: 3,
    borderRadius: 11,
    background: "var(--soft)",
    border: "1px solid var(--brd)",
  };

  return (
    <header
      style={{
        flex: "none",
        position: "relative",
        zIndex: 3,
        padding: "16px 32px 14px",
        background: props.overEnvironment ? "transparent" : "var(--pap)",
        borderBottom: props.overEnvironment ? "none" : "1px solid var(--brd)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          font: "500 .75rem var(--ui)",
          color: "var(--faint)",
          marginBottom: 6,
          minHeight: 18,
        }}
      >
        {props.crumbs.map((cr, i) => (
          <span key={`${cr.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            {i > 0 && <span style={{ fontSize: 10 }}>›</span>}
            <button className="libd-hov-txt" onClick={cr.go} style={{ color: "inherit" }}>
              {cr.label}
            </button>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <h1
            dir="auto"
            style={{
              margin: 0,
              font: "600 1.5rem/1.2 var(--book)",
              color: "var(--txt)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {props.heading}
          </h1>
          <span style={{ font: "500 .8125rem var(--ui)", color: "var(--faint)", whiteSpace: "nowrap" }}>
            {props.subcount}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button onClick={props.onToggleSelect} style={ctlBtn(props.mode === "select")}>
            {t("lib.select")}
          </button>
          <button onClick={props.onToggleArrange} style={ctlBtn(props.mode === "arrange")}>
            {props.mode === "arrange" ? t("lib.arranging") : t("lib.arrange")}
          </button>
          <button
            className="libd-hov-bright"
            onClick={props.onAddBooks}
            disabled={props.importing}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 9,
              background: "var(--acc)",
              color: "var(--pap)",
              font: "600 .75rem var(--ui)",
              boxShadow: "var(--sh1)",
              opacity: props.importing ? 0.7 : 1,
            }}
          >
            {t(props.importing ? "lib.importing" : "lib.add")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 34,
            minWidth: 240,
            flex: "0 1 320px",
            padding: "0 11px",
            borderRadius: 10,
            background: "var(--soft)",
            border: "1px solid var(--brd)",
          }}
        >
          <span style={{ color: "var(--faint)", fontSize: 13 }} aria-hidden>
            ⌕
          </span>
          <input
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder={t("lib.searchWide")}
            aria-label={t("lib.searchWide")}
            style={{
              flex: 1,
              minWidth: 0,
              background: "none",
              border: 0,
              outline: "none",
              font: "400 .8125rem var(--ui)",
            }}
          />
          {props.query && (
            <button
              onClick={() => props.onQuery("")}
              aria-label={t("lib.clearSearch")}
              style={{ color: "var(--faint)", fontSize: 12, padding: "0 2px" }}
            >
              ✕
            </button>
          )}
        </div>

        <div style={groupStyle} role="tablist">
          {views.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={props.view === v.id}
              title={v.hint}
              onClick={() => props.onView(v.id)}
              style={{
                ...ctlBtn(props.view === v.id),
                height: 28,
                padding: "0 10px",
                border: "none",
                background: props.view === v.id ? "var(--act)" : "transparent",
                color: props.view === v.id ? "var(--acc)" : "var(--mut)",
              }}
            >
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 12,
                  height: 12,
                  opacity: 0.85,
                  background: VIEW_ICONS[v.id],
                }}
              />
              <span style={{ font: "500 .8125rem var(--ui)" }}>{v.label}</span>
            </button>
          ))}
        </div>

        {props.view === "grid" && (
          <button onClick={props.onCoverMode} style={ctlBtn(false)}>
            {t(props.coverMode === "crop" ? "lib.cover.crop" : "lib.cover.fit")}
            <span style={{ color: "var(--faint)", fontSize: 9 }}>▾</span>
          </button>
        )}

        {props.view !== "details" && props.view !== "grid" && (
          <div style={groupStyle}>
            {Array.from({ length: DENSITY_STEPS }, (_, i) => (
              <button
                key={i}
                onClick={() => props.onDensity(i)}
                aria-label={`${i + 1}`}
                title={`${i + 1}`}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: props.density === i ? "var(--act)" : "transparent",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: 4 + i * 3,
                    height: 13,
                    borderRadius: 1,
                    background: props.density === i ? "var(--acc)" : "var(--faint)",
                  }}
                />
              </button>
            ))}
          </div>
        )}

        {/* RAWY-15's format filter, carried over from the old toolbar. It filters in SQL. */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setFormatOpen((v) => !v)}
            title={t("lib.filter")}
            aria-label={t("lib.filter")}
            style={ctlBtn(!!props.format)}
          >
            ⛛ {props.format ? props.format.toUpperCase() : t("lib.filter.all")}
          </button>
          {formatOpen && (
            <>
              <div onClick={() => setFormatOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 69 }} />
              <div
                style={{
                  position: "absolute",
                  insetInlineEnd: 0,
                  top: "calc(100% + 6px)",
                  zIndex: 70,
                  width: 180,
                  background: "var(--chr)",
                  border: "1px solid var(--brd)",
                  borderRadius: 12,
                  boxShadow: "var(--sh4)",
                  padding: 6,
                  animation: "sard-rise .12s ease-out",
                }}
              >
                {[null, "epub", "pdf"].map((f) => (
                  <button
                    key={f ?? "all"}
                    className="libd-hov"
                    onClick={() => {
                      props.onFormat(f);
                      setFormatOpen(false);
                    }}
                    style={{
                      width: "100%",
                      justifyContent: "flex-start",
                      padding: "7px 10px",
                      borderRadius: 8,
                      font: "500 .8125rem var(--ui)",
                      color: props.format === f ? "var(--txt)" : "var(--mut)",
                      background: props.format === f ? "var(--act)" : "transparent",
                    }}
                  >
                    {f ? f.toUpperCase() : t("lib.filter.all")}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ position: "relative" }}>
          <button onClick={() => setSortOpen((v) => !v)} style={ctlBtn(false)}>
            <span
              style={{
                color: "var(--faint)",
                font: "600 .625rem var(--ui)",
                letterSpacing: ".12em",
                textTransform: "uppercase",
              }}
            >
              {t("lib.sortEyebrow")}
            </span>
            <span style={{ font: "500 .8125rem var(--ui)" }}>{sortLabel[props.sort]}</span>
            <span style={{ color: "var(--faint)", fontSize: 9 }}>▾</span>
          </button>
          {sortOpen && (
            <>
              <div
                onClick={() => setSortOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 69 }}
              />
              <div
                style={{
                  position: "absolute",
                  insetInlineEnd: 0,
                  top: "calc(100% + 6px)",
                  zIndex: 70,
                  width: 216,
                  background: "var(--chr)",
                  border: "1px solid var(--brd)",
                  borderRadius: 12,
                  boxShadow: "var(--sh4)",
                  padding: 6,
                  animation: "sard-rise .12s ease-out",
                }}
              >
                {DESIGN_SORTS.map((s) => (
                  <button
                    key={s}
                    className="libd-hov"
                    onClick={() => {
                      props.onSort(s);
                      setSortOpen(false);
                    }}
                    style={{
                      width: "100%",
                      justifyContent: "space-between",
                      padding: "7px 10px",
                      borderRadius: 8,
                      font: "500 .8125rem var(--ui)",
                      color: props.sort === s ? "var(--txt)" : "var(--mut)",
                    }}
                  >
                    <span>{sortLabel[s]}</span>
                    <span style={{ color: "var(--acc)", fontSize: 11 }}>
                      {props.sort === s ? "✓" : ""}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div
          style={{
            font: "400 .75rem var(--ui)",
            color: "var(--faint)",
            flex: "1 1 220px",
            minWidth: 0,
            textWrap: "pretty",
          }}
        >
          {props.mode === "arrange" ? t("lib.arrangeHintOn") : t("lib.arrangeHintOff")}
        </div>
      </div>
    </header>
  );
}
