/**
 * A BOOK THAT IS ALREADY HERE, ASKED ABOUT RATHER THAN ANNOUNCED.
 *
 * An import that finds the reader already has a book used to say only «already in library». It now
 * asks whether to replace the stored copy from the file that just arrived. Keeping is the default —
 * Escape, the scrim and «Keep existing» all keep — and focus lands on the dialog, never on «Replace»,
 * so Enter on arrival cannot replace anything.
 *
 * What «Replace» does is decided in `books::replace_file`: the file is the same book (a duplicate is
 * recognised by its content), so the book keeps its id, its place, its notes, highlights and reading
 * position, and only a missing or damaged stored copy — or a missing extracted cover — is written.
 *
 * It is drawn the way `ConfirmDeleteBook` is drawn, so the two questions the library asks about a
 * book look like one family: the same scrim, sheet, type and button shapes — and, like it, it is
 * portalled into the library's overlay host, inside the shell where those tokens are defined.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../../components/useDialog";
import { overlayHost } from "./design/overlay";
import type { TKey } from "../../i18n/locales/en";
import type { DuplicateOffer } from "./importReport";

export function ConfirmReplace({
  books,
  t,
  onKeep,
  onReplace,
}: {
  books: DuplicateOffer[];
  t: (k: TKey, vars?: Record<string, string>) => string;
  onKeep: () => void;
  onReplace: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const dlg = useDialog({ onDismiss: onKeep, initialFocus: "none" });
  const many = books.length > 1;
  const NAMED = 4; // as many as fit before the list stops being read and starts being scrolled
  const titles = books.slice(0, NAMED).map((b) => b.title);
  const rest = books.length - titles.length;
  return createPortal(
    <div
      onClick={onKeep}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.34)",
        display: "grid", placeItems: "center", padding: "var(--sp-6)",
        animation: "sard-fade .14s ease-out",
      }}
    >
      <div
        className="libd-dialog"
        ref={dlg.ref}
        {...dlg.props}
        data-replace-dialog=""
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px,100%)", maxHeight: "100%", overflowY: "auto",
          background: "var(--chr)", border: "1px solid var(--brd)",
          borderRadius: "var(--r-xl)", boxShadow: "var(--sh4)",
          padding: "var(--sp-7)", animation: "sard-rise .16s ease-out",
        }}
      >
        <div id={dlg.titleId} style={{ font: "600 1.0625rem var(--ui)", color: "var(--txt)", marginBottom: "var(--sp-4)" }}>
          {many ? t("lib.replace.titleMany", { n: String(books.length) }) : t("lib.replace.title")}
        </div>
        <div style={{ marginBottom: "var(--sp-3)" }}>
          {titles.map((name, i) => (
            <div key={i} dir="auto" style={{ font: "600 .875rem/1.55 var(--ui)", color: "var(--txt)" }}>
              {name}
            </div>
          ))}
          {rest > 0 && (
            <div style={{ font: "500 .8125rem/1.55 var(--ui)", color: "var(--mut)" }}>
              {t("lib.replace.andMore", { n: String(rest) })}
            </div>
          )}
        </div>
        <p style={{ margin: "0 0 var(--sp-7)", font: "400 .8125rem/1.7 var(--ui)", color: "var(--mut)" }}>
          {many ? t("lib.replace.questionMany") : t("lib.replace.question")}
        </p>
        <div style={{ display: "flex", gap: "var(--sp-4)", justifyContent: "flex-end" }}>
          <button
            className="libd-hov"
            data-replace-keep=""
            onClick={onKeep}
            disabled={busy}
            style={{
              minHeight: "var(--ctl-lg)", padding: "0 16px", borderRadius: "var(--r-md)",
              border: "1px solid var(--brd)", background: "transparent",
              font: "500 .8125rem var(--ui)", color: "var(--txt)",
            }}
          >
            {t("lib.replace.keep")}
          </button>
          <button
            data-replace-confirm=""
            onClick={() => {
              // ONE ANSWER PER QUESTION: the press is spent the moment it is made.
              if (busy) return;
              setBusy(true);
              onReplace();
            }}
            disabled={busy}
            style={{
              minHeight: "var(--ctl-lg)", padding: "0 16px", borderRadius: "var(--r-md)",
              border: "none", background: "var(--acc)", color: "var(--pap)",
              font: "600 .8125rem var(--ui)", cursor: busy ? "default" : "pointer",
            }}
          >
            {t("lib.replace.replace")}
          </button>
        </div>
      </div>
    </div>,
    overlayHost(),
  );
}
