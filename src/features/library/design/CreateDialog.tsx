/**
 * MAKING A SHELF, OR A CASE — one dialog, whichever door the reader came through.
 *
 * WHAT THIS REPLACED. Creation used to happen inside the sidebar: a bare text field appeared in
 * the list, with a row of small chips above it for the destination. It worked, and it read as
 * plumbing — a form wedged into a navigation column, at the sidebar's 244px, sharing the column
 * with the rows it was about to add to. It also existed TWICE, once at the foot of the list and
 * once inside each case's ⋯ menu, with a piece of state that had to say which of the two was
 * open; getting that wrong opened both at once and lost the typed name.
 *
 * So the form left the sidebar. The sidebar asks for a shelf and says which case it was asked
 * from; this dialog is the only thing that knows what making one involves. `ViewGrouped`'s own
 * "+ new shelf" came here too — it used to create a shelf called «رفّ بلا اسم» outright, with no
 * name asked and no destination shown.
 *
 * IT IS BUILT FROM WHAT THE OTHER DIALOGS ARE BUILT FROM. `BookDetails` and `CaseEditor` set the
 * house style — the scrim at .34, `sard-fade` under `sard-rise`, `--chr` on `--brd` at `--r-xl`
 * with `--sh4`, a standing label over a `--soft` field, a ruled head and a ruled foot. Nothing
 * here is a new colour, a new radius or a new shadow; a theme Sard does not have yet gets this
 * dialog for free, and so does a theme that changes its mind about any of those.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not offer a colour, an icon or a rule, because a
 * shelf's ink is set from the shelf's own ⋯ menu and a rule shelf is a different act. Options
 * added to fill the dialog out would be options the reader has to dismiss every time they make
 * an ordinary shelf.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CaseNode } from "../../../lib/ipc";
import { useI18n } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import { InkPicker } from "./Menus";
import { isArabicText, labelFaceFor } from "../../../lib/typography";
import { useDialog } from "../../../components/useDialog";

export type CreateKind = "shelf" | "case";

export interface CreateRequest {
  kind: CreateKind;
  /**
   * The case to arrive with, when the reader asked from somewhere that implies one — a case's own
   * ⋯ menu, or standing inside that case. `null` means "outside every case"; it is a STARTING
   * POINT and never a decision, which is why the field is shown either way.
   */
  preselect: string | null;
  /**
   * RENAMING GOES THROUGH THE SAME DIALOG. A shelf's name was edited in place in the sidebar — a
   * field appearing in the navigation column, which is the thing the creation form was moved out
   * of it for. Naming and re-naming are the same act on the same field; the only differences are
   * what the box starts with and what the button says, so they are the same dialog.
   *
   * It carries the NAME only. Where a shelf lives and what colour it is are settings with their
   * own rows in the shelf's ⋯ menu, and folding them in here would make "rename" a small editor
   * the reader has to read before they can retype one word.
   */
  rename?: { id: string; name: string } | null;
}

/**
 * A LABEL THAT DOES NOT BREAK ARABIC.
 *
 * The dialogs' standing labels are tracked uppercase — `.1em` of letter-spacing over a 10px
 * caption. Arabic has no capitals for `text-transform` to reach, and letter-spacing severs the
 * cursive joins, so the same rule that reads as a quiet caption in English renders «اسم الرفّ» as
 * loose disconnected letters. The stylesheet already learned this once, at `.libd-place-cat`,
 * where a category run in Covers and Spines had to stop being tracked capitals.
 *
 * So the treatment follows the script of the words themselves: tracked and uppercased for Latin,
 * and for Arabic the same size and colour with the tracking removed and the face set to `--ar`.
 */
const fieldLabel = (text: string): React.CSSProperties => {
  const arabic = isArabicText(text);
  return {
    display: "block",
    marginBottom: "var(--sp-3)",
    font: `600 ${arabic ? ".75rem" : ".625rem"} ${labelFaceFor(text)}`,
    letterSpacing: arabic ? "normal" : ".1em",
    textTransform: arabic ? "none" : "uppercase",
    color: "var(--faint)",
    textAlign: "start",
  };
};

export interface CreateDialogProps {
  request: CreateRequest;
  cases: CaseNode[];
  /** Existing names in the same family, to notice a repeat with. Never to refuse one. */
  taken: string[];
  busy?: boolean;
  onCancel: () => void;
  /** `caseId` is meaningless for a case and is passed as null. */
  onCreate: (name: string, caseId: string | null, ink: string | null) => void;
}

export function CreateDialog(props: CreateDialogProps) {
  const { t } = useI18n();
  const shelf = props.request.kind === "shelf";
  const renaming = !!props.request.rename;
  const [name, setName] = useState(props.request.rename?.name ?? "");
  const [where, setWhere] = useState<string | null>(props.request.preselect);
  const [ink, setInk] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Viewport coordinates for the destination list. See the layout effect below. */
  const [box, setBox] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);

  const clean = name.trim();
  const valid = clean.length > 0;
  // The model puts no UNIQUE on `collections.name`, and two shelves may honestly share one — a
  // «قيد القراءة» inside two different cases is not a mistake. So a repeat is SAID and never
  // refused: inventing a rule the database does not have would be this dialog overruling it.
  const repeat = valid && props.taken.some((n) => n.trim() === clean);

  const options = useMemo(
    () => [{ id: null as string | null, label: t("lib.unfiled") }, ...props.cases.map((c) => ({ id: c.id, label: c.name }))],
    [props.cases, t],
  );
  const chosen = options.find((o) => o.id === where) ?? options[0];

  useEffect(() => {
    inputRef.current?.focus();
    // Renaming starts with the old name in the box and all of it selected: typing replaces it,
    // and an arrow key still puts the caret in it to edit a word.
    if (props.request.rename) inputRef.current?.select();
  }, [props.request.rename]);

  /**
   * THE LIST IS PLACED AGAINST THE VIEWPORT, NOT AGAINST THE FIELD.
   *
   * It began as `position: absolute` under the field, which is the obvious way and the wrong one:
   * the fields it sits among scroll, and an absolutely-positioned child of a scrolling box is
   * CLIPPED by it. Measured at 1400x900 — the list was cut off at the container's edge, the box
   * grew a scrollbar of its own, and the list slid up over the name field the reader had just
   * typed into, hiding it completely.
   *
   * Fixed coordinates leave every clipping ancestor behind, and they make the second requirement
   * answerable in the same breath: the list is clamped to the window, so it can neither run off
   * the bottom nor off either side, whatever the window size or the writing direction. It opens
   * downward when there is room and upward when there is not, and its height is whatever is
   * actually left rather than a number chosen in advance.
   */
  useLayoutEffect(() => {
    if (!listOpen) return;
    const place = () => {
      const r = fieldRef.current?.getBoundingClientRect();
      if (!r) return;
      const GAP = 6;
      const MARGIN = 12;
      const wanted = Math.min(260, options.length * 40 + 52);
      const below = window.innerHeight - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const downward = below >= Math.min(wanted, 132) || below >= above;
      const maxH = Math.max(96, Math.min(wanted, downward ? below : above));
      setBox({
        top: downward ? r.bottom + GAP : r.top - GAP - maxH,
        left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - r.width - MARGIN)),
        width: r.width,
        maxH,
      });
    };
    place();
    setCursor(Math.max(0, options.findIndex((o) => o.id === where)));
    // A resize while it is open would otherwise leave it pinned where the field used to be.
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [listOpen, options, where]);

  useEffect(() => {
    if (!listOpen) return;
    listRef.current?.querySelector<HTMLElement>(`[data-at="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, listOpen]);

  // THE LIST TAKES THE KEYBOARD WHEN IT OPENS, and hands it back to the field when it closes.
  // Without this its own arrow keys never fire — focus is still in the name box, where ArrowDown
  // means "move the caret" — so the list would be openable by keyboard and not navigable by it.
  useEffect(() => {
    if (listOpen) listRef.current?.focus();
  }, [listOpen]);

  /**
   * THE TRAP, THE NAME AND THE RETURN come from the shared primitive; ESCAPE STAYS HERE. This dialog
   * has a nested layer of its own — the destination list — and "close the nearer thing first" is a
   * rule only this component knows. `useDialog` is given no `onDismiss` for exactly that reason.
   */
  // ESCAPE CLOSES THE NEARER THING FIRST. With the destination list open, Escape puts the list
  // away and leaves the reader in the dialog they were filling in; only then does it close the
  // dialog. Captured at the window, as the other dialogs do it, so it works wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (listOpen) setListOpen(false);
      else props.onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listOpen, props]);

  const submit = () => {
    if (!valid || props.busy) return;
    props.onCreate(clean, shelf ? where : null, ink);
  };

  const title = renaming
    ? shelf ? t("lib.rename.shelfTitle") : t("lib.rename.caseTitle")
    : shelf ? t("lib.create.shelfTitle") : t("lib.create.caseTitle");
  const hint = renaming
    ? t("lib.rename.hint")
    : shelf ? t("lib.create.shelfHint") : t("lib.create.caseHint");
  const colourLabel = shelf ? t("lib.create.shelfColour") : t("lib.create.caseColour");
  const dlg = useDialog({ label: title });

  return (
    <div
      onClick={props.onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 180,
        background: "rgba(0,0,0,.34)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
        animation: "sard-fade .14s ease-out",
      }}
    >
      <div
        className="libd-dialog"
        ref={dlg.ref}
        {...dlg.props}
        onClick={(e) => e.stopPropagation()}
        style={{
          // Small and focused. `BookDetails` is 640 because it carries a jacket and a shelf tree;
          // this carries two fields, and a wide box around two fields reads as an empty one.
          width: "min(440px,100%)",
          maxHeight: "100%",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          background: "var(--chr)",
          border: "1px solid var(--brd)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--sh4)",
          animation: "sard-rise .16s ease-out",
          opacity: props.busy ? 0.7 : 1,
          transition: "opacity .12s ease-out",
        }}
      >
        {/* ---- head ------------------------------------------------------------------
            The title carries the weight; the line under it is one sentence saying what the
            thing IS, for a reader who has not met Sard's vocabulary yet. It is not a
            paragraph, and there is no second one. */}
        <div style={{ padding: "var(--sp-7) var(--sp-7) var(--sp-5)" }}>
          <h2
            style={{
              margin: 0,
              font: `600 1.0625rem ${labelFaceFor(title)}`,
              color: "var(--txt)",
              textAlign: "start",
            }}
          >
            {title}
          </h2>
          <p
            style={{
              margin: "var(--sp-3) 0 0",
              font: `400 .8125rem ${labelFaceFor(hint)}`,
              lineHeight: 1.5,
              color: "var(--mut)",
              textAlign: "start",
            }}
          >
            {hint}
          </p>
        </div>

        {/* ---- the fields ---- */}
        <div
          style={{
            padding: "0 var(--sp-7) var(--sp-7)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-6)",
          }}
        >
          <div>
            <label htmlFor="create-name" style={fieldLabel(shelf ? t("lib.create.shelfName") : t("lib.caseName"))}>
              {shelf ? t("lib.create.shelfName") : t("lib.caseName")}
            </label>
            <input
              id="create-name"
              ref={inputRef}
              className="libd-field"
              value={name}
              // `auto`, so a reader naming an English shelf in an Arabic interface gets their own
              // direction inside the box while the dialog around it stays as it was.
              dir="auto"
              maxLength={120}
              placeholder={shelf ? t("lib.create.shelfNameHint") : t("lib.create.caseNameHint")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {repeat && (
              <div
                style={{
                  marginTop: "var(--sp-3)",
                  font: `500 .75rem ${labelFaceFor(title)}`,
                  color: "var(--mut)",
                  textAlign: "start",
                }}
              >
                {shelf ? t("lib.create.shelfRepeat") : t("lib.create.caseRepeat")}
              </div>
            )}
          </div>

          {/* ---- where it goes ---------------------------------------------------------
              A shelf belongs somewhere, and the reader decides where. This is the whole
              reason the dialog exists rather than a naked name box. */}
          {shelf && !renaming && (
            <div style={{ position: "relative" }}>
              <span style={fieldLabel(t("lib.create.where"))}>{t("lib.create.where")}</span>
              <button
                ref={fieldRef}
                type="button"
                className="libd-field libd-field-btn"
                aria-haspopup="listbox"
                aria-expanded={listOpen}
                onClick={() => setListOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setListOpen(true);
                  }
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "start",
                    color: "var(--txt)",
                  }}
                >
                  {chosen.label}
                </span>
                {/* The caret turns rather than swapping glyph, so opening and closing read as
                    one control moving instead of two states alternating. */}
                <span
                  aria-hidden
                  style={{
                    flex: "none",
                    display: "flex",
                    color: "var(--faint)",
                    transform: listOpen ? "rotate(180deg)" : "none",
                    transition: "transform .16s ease-out",
                  }}
                >
                  <Icon name="caretDown" size="sm" />
                </span>
              </button>

              {listOpen && (
                <>
                  {/* Takes the next press anywhere else, so the list closes the way every other
                      menu in the library closes. It sits under the list and over the dialog. */}
                  <div
                    onClick={() => setListOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 1 }}
                  />
                  <div
                    ref={listRef}
                    role="listbox"
                    aria-label={t("lib.create.where")}
                    tabIndex={-1}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        setCursor((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
                      } else if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setWhere(options[cursor].id);
                        setListOpen(false);
                        fieldRef.current?.focus();
                      }
                    }}
                    style={{
                      position: "fixed",
                      top: box?.top ?? -9999,
                      left: box?.left ?? -9999,
                      width: box?.width,
                      zIndex: 2,
                      maxHeight: box?.maxH ?? 244,
                      overflowY: "auto",
                      padding: "var(--sp-2)",
                      background: "var(--chr)",
                      border: "1px solid var(--brd)",
                      borderRadius: "var(--r-lg)",
                      boxShadow: "var(--sh3)",
                      animation: "sard-rise .12s ease-out",
                    }}
                  >
                    {options.map((o, i) => {
                      const on = o.id === where;
                      // The one case with no case above it is named first and then ruled off, so
                      // «خارج الخزائن» reads as the alternative to filing rather than as one more
                      // case in the list.
                      const heads = i === 1;
                      return (
                        <div key={o.id ?? "__none"}>
                          {heads && (
                            <div
                              style={{
                                margin: "var(--sp-2) var(--sp-3) var(--sp-1)",
                                paddingTop: "var(--sp-2)",
                                borderTop: "1px solid var(--brd)",
                                font: `600 .6875rem ${labelFaceFor(t("lib.create.caseGroup"))}`,
                                color: "var(--faint)",
                                textAlign: "start",
                              }}
                            >
                              {t("lib.create.caseGroup")}
                            </div>
                          )}
                          <button
                            type="button"
                            role="option"
                            data-at={i}
                            aria-selected={on}
                            className="libd-opt"
                            onMouseEnter={() => setCursor(i)}
                            onClick={() => {
                              setWhere(o.id);
                              setListOpen(false);
                              fieldRef.current?.focus();
                            }}
                            data-cursor={cursor === i ? "1" : undefined}
                          >
                            <span
                              aria-hidden
                              className="libd-opt-mark"
                              data-on={on ? "1" : undefined}
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
                              {o.label}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                    {props.cases.length === 0 && (
                      <div
                        style={{
                          padding: "var(--sp-4) var(--sp-3) var(--sp-3)",
                          font: `400 .75rem ${labelFaceFor(t("lib.create.noCases"))}`,
                          color: "var(--faint)",
                          textAlign: "start",
                        }}
                      >
                        {t("lib.create.noCases")}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- its colour, if it wants one -------------------------------------------
              THE INK ALREADY EXISTS, and this is the same `InkPicker` the shelf's and the
              case's own ⋯ menus open — the same swatches, the same "no colour", writing the
              same field. Nothing new is stored and no second notion of identity is invented.

              A case takes its ink in the same breath as its name: `case_create` has always
              accepted one. A shelf's is a second call, made only when a colour was actually
              chosen, so the ordinary case is still one write.

              It comes last, and no colour is a perfectly good answer — the dialog must not
              read as three things that have to be filled in. */}
          {!renaming && (
          <div>
            {/* Named for the thing it colours, not just «Colour» — the dialog is short enough
                that a bare noun reads as a heading over the whole form rather than a field. */}
            <span style={fieldLabel(colourLabel)}>{colourLabel}</span>
            {/* `InkPicker` carries a menu's own padding; pulled back so its first swatch lines
                up with the fields above rather than sitting indented under them. */}
            <div style={{ margin: "calc(-1 * var(--sp-2)) -10px 0" }}>
              <InkPicker value={ink} onPick={setInk} />
            </div>
          </div>
          )}
        </div>

        {/* ---- what to do ------------------------------------------------------------
            Ruled off from the fields, and set to the END of the line, so the primary action
            lands where the reader's eye leaves the form in either direction. */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--sp-4)",
            padding: "var(--sp-5) var(--sp-7)",
            borderTop: "1px solid var(--brd)",
          }}
        >
          <button type="button" className="libd-btn libd-btn-quiet" onClick={props.onCancel}>
            {t("lib.cancel")}
          </button>
          <button
            type="button"
            className="libd-btn libd-btn-primary"
            disabled={!valid || props.busy}
            onClick={submit}
          >
            {renaming ? t("lib.rename.do") : shelf ? t("lib.create.shelfDo") : t("lib.create.caseDo")}
          </button>
        </div>
      </div>
    </div>
  );
}
