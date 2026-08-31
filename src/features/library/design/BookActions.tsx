// THE ⋯ MENU ON A BOOK — one implementation, for every surface that draws one.
//
// It lived inside `BookTile`, which is fine while Vista, Covers and Spines are the only places a
// book is drawn. Grid draws a `BookCard` instead, so it inherited none of it: its ⋯ was a single
// button wired straight to Sard's older editor, and the reader met a different set of actions and a
// different editor depending only on which format they happened to be looking at. Edit details,
// Open in folder and Mark read simply did not exist there.
//
// That is the shape of the problem rather than one instance of it: a user concept — "what can I do
// with this book" — implemented once per view drifts once per view. Owned here, an action added is
// added everywhere, and a format can differ in how it LOOKS without differing in what it can do.
//
// What this does not own is the editor. It raises `onEditDetails`, and the owner decides what that
// opens, so there is exactly one answer to that question too.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon, type IconName } from "../../../components/Icon";
import { openTransient } from "./transient";
import { overlayHost } from "./overlay";

export interface BookActionsProps {
  /** Where the file lives, for handing it to the OS file manager. */
  filePath: string;
  finished: boolean;
  onEditDetails: () => void;
  onOpen: () => void;
  onSetFinished: (finished: boolean) => void;
  /** Absent where there is no shelf to leave — a rule shelf, or the unshelved run. */
  onRemoveFromShelf?: (() => void) | null;
  /**
   * DELETE THE BOOK ITSELF — a different act from leaving a shelf, and always available.
   *
   * «إزالة من هذا الرفّ» takes a book off a shelf and leaves it in the library; this removes the
   * book. The menu offered only the first, and in a view where a book sits on no shelf it offered
   * neither — so from the three-dot menu there was no way to delete a book at all. The reader had
   * to open «تحرير البيانات» and find the delete inside that dialog's footer.
   *
   * Never `null`: a book can always be deleted, wherever it happens to be filed.
   */
  onDelete: () => void;
  /**
   * Where the button sits, which is the one thing a format legitimately decides for itself.
   *
   * Giving a `className` means the format positions the control from its own stylesheet — Grid's
   * `.lib-card-edit` already does — so the default inline placement is left off entirely rather
   * than fighting it.
   */
  className?: string;
  buttonStyle?: React.CSSProperties;
  /**
   * Whether the menu is open, for a format whose control is only visible on hover — a tile hides
   * its ⋯ until the pointer is over it, and must keep it visible while its own menu is up.
   */
  onOpenChange?: (open: boolean) => void;
}

/** The reference's width for this menu; the placement needs it before the menu has been drawn. */
const MENU_WIDTH = 206;

export function BookActions(props: BookActionsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  /**
   * WHERE THE MENU GOES — decided here, in window coordinates, and drawn outside the book.
   *
   * It used to be an absolutely positioned child of the tile, which meant its stacking order was
   * settled among the tile's SIBLINGS. In Spines that is fatal: the tiles are twenty-two pixels
   * apart and sit against the sidebar, so a 206-wide menu opened straight underneath it. Measured —
   * the sidebar's edge at x=1196, the menu spanning 1130 to 1336, and the press meant for «تعديل
   * التفاصيل» landing on a shelf row in the sidebar instead. The menu was drawn, on screen, and
   * unusable; Covers escaped only because a cover is wide enough that the menu cleared the edge.
   *
   * Raising the tile could not fix that, because the sidebar is not the tile's sibling. A menu is
   * not really part of the book it belongs to — it is a thing laid over the whole window — so it is
   * drawn on `document.body` and positioned from the button's own rectangle, clamped to stay on
   * screen. That is one rule for all five formats and for whatever the layout does next to them.
   */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const m = menuRef.current?.getBoundingClientRect();
      const w = m?.width || MENU_WIDTH;
      const h = m?.height || 200;
      const rtl = getComputedStyle(document.documentElement).direction === "rtl";
      // Hanging from the control, opening back along the reading direction.
      const wanted = rtl ? b.right - w : b.left;
      const next = {
        left: Math.max(8, Math.min(wanted, window.innerWidth - w - 8)),
        top: Math.max(8, Math.min(b.bottom + 6, window.innerHeight - h - 8)),
      };
      setAt((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    // Once more when the menu exists, so its real height decides whether it had to move up.
    const again = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(again);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // One owner for every transient surface: opening this closes whatever was open, a press outside
  // closes it, and Escape is spent here before it reaches the view behind.
  useEffect(() => {
    if (!open) return;
    // Escape and the press outside both arrive here, and both hand focus back.
    return openTransient(close, () => menuRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { props.onOpenChange?.(open); }, [open]);

  /**
   * A MENU, FOR THE KEYBOARD TOO.
   *
   * Measured before this: the surface carried no role, its five items were five ordinary tab stops,
   * focus stayed on the ⋯ when the menu opened, one Tab left the menu entirely and landed on a book
   * tile, ArrowDown did nothing, and Escape closed it without giving focus back. It was a popover of
   * buttons that only a pointer could use.
   *
   * `active` is the roving index a menu keeps: ONE tab stop for the whole menu, the arrows moving
   * within it. The arrows are UP and DOWN here — the list runs down the page in both languages, so
   * nothing mirrors and Arabic needs no second rule.
   */
  const [active, setActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) return;
    setActive(0);
    // After the frame that places the menu, or the focus lands on an element still at 0,0.
    const id = requestAnimationFrame(() => itemRefs.current[0]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open]);

  /** Closing by any route puts focus back on the control that opened the menu. */
  const close = () => {
    setOpen(false);
    btnRef.current?.focus({ preventScroll: true });
  };

  // EACH ACTION CARRIES ITS OWN MARK, and the mark says what the action does rather than decorating
  // it: the nib writes, the spread opens, the folder holds, the tick completes, the bin takes away.
  // They are the shared `Icon` set at one size and one weight, so the menu cannot drift from the
  // rest of Sard's marks, and a future action names an icon the same way it names a label.
  const items: { label: string; icon: IconName; run: () => void; danger?: boolean }[] = [
    { label: t("lib.editDetails"), icon: "edit", run: props.onEditDetails },
    { label: t("lib.openBook"), icon: "bookOpen", run: props.onOpen },
    // Distinct from Open, which opens the book INSIDE Sard. This hands the file to the OS file
    // manager, revealing it where it actually lives on disk.
    { label: t("lib.openInFolder"), icon: "folder", run: () => revealItemInDir(props.filePath).catch(() => {}) },
    {
      label: props.finished ? t("lib.markUnread") : t("lib.markRead"),
      icon: "check",
      run: () => props.onSetFinished(!props.finished),
    },
    ...(props.onRemoveFromShelf
      ? [{ label: t("lib.removeFromShelf"), icon: "trash" as IconName, run: props.onRemoveFromShelf }]
      : []),
    // LAST, AND MARKED. The order runs from the everyday to the irreversible, and the one act that
    // cannot be undone sits at the end in the colour the rest of Sard uses for danger.
    { label: t("edit.delete"), icon: "trash" as IconName, run: props.onDelete, danger: true },
  ];

  return (
    <>
      <button
        ref={btnRef}
        className={props.className ?? "libd-dots"}
        data-book-actions="1"
        title={t("lib.bookActions")}
        aria-label={t("lib.bookActions")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        // The press is what the dismissal stack listens for, and it must not be read as a press
        // OUTSIDE the menu this very click is about to open.
        onPointerDown={(e) => e.stopPropagation()}
        style={
          props.className
            ? props.buttonStyle
            : {
                position: "absolute",
                zIndex: 12,
                insetBlockStart: 6,
                insetInlineEnd: 6,
                // A CONTROL SIZE, NOT AN ICON SIZE.
                //
                // This was `--icon-xl` (24px) — an ICON token used as the BUTTON's box. The glyph
                // inside is 14px, so it filled 58% of the control where Grid's `.lib-card-edit`
                // leaves it at 47%, and the button read as cramped. `--ctl-md` is the design
                // system's own words for this: "DEFAULT — Book Details' own height", 30px, which
                // is exactly the literal Grid has been using. One control, one size.
                width: "var(--ctl-md)",
                height: "var(--ctl-md)",
                // THE CONTROL DEFINES ITSELF, rather than inheriting its layout from wherever it
                // happens to be mounted.
                //
                // These four came from `.libd-stage button` — the shell's reset. Vista does not
                // render into `.libd-stage`; its tiles live in `.v-room > .v-scroll > .v-books`,
                // so the reset never matched and the ⋯ fell back to a raw platform button there:
                // `display: block`, the user agent's own `padding: 1px 6px`, and no centring at
                // all. Measured, the glyph sat 4px off-centre in Vista and dead-centre in the
                // other three — one component rendering differently by ancestry alone.
                //
                // Stating them here fixes it everywhere at once and makes the control independent
                // of its container, which is what a shared component should be. Adding `.v-room`
                // to the reset list was the other option and is NOT safe: that selector is (0,1,1)
                // and `.v-piece` is (0,1,0), so it would override Vista's own furniture layout
                // (`display: flex; flex-direction: column; justify-content: flex-end`).
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                // …and the cursor, which comes from the same reset and was missed the first time.
                // Vista offered the platform's default arrow over a control the other three views
                // give a pointer to. Measured: grid/covers/spines "pointer", vista "default".
                cursor: "pointer",
                borderRadius: "var(--r-md)",
                // THROUGH A CUSTOM PROPERTY SO THE STYLESHEET CAN ANSWER THE POINTER.
                //
                // The design states its buttons' appearance inline, because the shell resets every
                // button inside `.libd-stage` and a class would lose to it. Inline also beats a
                // `:hover` rule, though — so a hover or pressed state written in CSS could never
                // take effect on this control, and it had none. Naming the ground and the edge as
                // variables leaves the inline declaration in charge of the DEFAULT while letting
                // `.libd-dots:hover` change what that default resolves to. Both still come from the
                // theme; nothing here states a colour of its own.
                // AN OPAQUE GROUND, DELIBERATELY, and this is where the design views should NOT
                // follow Grid. Grid's control is 88% translucent; matched here, the format badge
                // an auto-drawn cover paints in this very corner reads straight THROUGH the
                // button, so a stray "S" sits beside the three dots. Grid has that today and it is
                // no better there — but it was not what this fix was asked to change, and copying
                // it would have traded a proportion problem for a legibility one. The ground stays
                // solid; `--dots-bg` still leaves `.libd-dots:hover` in charge of the hovered state.
                background: "var(--dots-bg, var(--chr))",
                border: "1px solid var(--dots-brd, var(--brd))",
                // ONE STEP DOWN THE ELEVATION SCALE, because this is a control resting ON a card,
                // not a card.
                //
                // It carried `--sh2`, which is the JACKET's own elevation — measured, the button's
                // shadow and the Covers cover's shadow resolved to the identical string,
                // `rgba(0,0,0,.55) 0 3px 10px`. In Covers that coincidence hides the mistake: chip
                // and jacket sit on the same plane and read as one surface. Vista gives its cover
                // real thickness (`vistaCover` — three layers plus a lit top edge), and against
                // that a 24px chip wearing card-weight elevation stops sitting on the book and
                // starts hovering over the artwork, its dark halo the only thing defining it.
                //
                // `--sh1` is the same scale's control step, and it is what Grid's own `.lib-card-edit`
                // already does by hand (`0 1px 3px rgba(0,0,0,.28)`). Nothing else about the control
                // changes: same size, ground, border, radius, position, behaviour.
                boxShadow: "var(--sh1)",
                color: "var(--txt)",
                fontSize: 12,
                lineHeight: 1,
                ...props.buttonStyle,
              }
        }
      >
        <Icon name="more" size="sm" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          data-book-menu="1"
          role="menu"
          aria-label={t("lib.bookActions")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            const last = items.length - 1;
            const go = (i: number) => {
              e.preventDefault();
              setActive(i);
              itemRefs.current[i]?.focus({ preventScroll: true });
            };
            if (e.key === "ArrowDown") go(active >= last ? 0 : active + 1);
            else if (e.key === "ArrowUp") go(active <= 0 ? last : active - 1);
            else if (e.key === "Home") go(0);
            else if (e.key === "End") go(last);
            else if (e.key === "Tab") {
              // A menu is one stop. Tab leaves it rather than walking its items into the page
              // behind — which is exactly what it used to do.
              e.preventDefault();
              close();
            } else if (e.key === "Enter" || e.key === " ") {
              // ACTIVATING A MENU ITEM BELONGS TO THE MENU, NOT TO THE CARD BEHIND IT.
              //
              // This menu is rendered by `createPortal` into the overlay host, so in the DOM it is
              // nowhere near the book card. React, however, propagates events through the REACT
              // tree, not the DOM tree — and `<BookActions>` is a child of the card. So a keydown
              // on a menu item still reached the card's own `onKeyDown` (Library.tsx), which claims
              // Enter and Space for "open this book" and calls `preventDefault()`.
              //
              // Measured, in the real app: `End` focused «حذف الكتاب» correctly, and Enter then
              // opened the BOOK — no confirmation, no deletion. The card's `preventDefault()` had
              // suppressed the button's own activation on the way past. Clicking the identical item
              // in the identical state opened the dialog, because a click carries no such key. It
              // was not specific to delete: the first item, «تحرير البيانات…», did the same.
              //
              // `stopPropagation` only — deliberately NOT `preventDefault`, which is what would
              // cancel the button's activation and reintroduce the very defect. Escape is unaffected:
              // it is owned by `openTransient` at the document level, not by this handler.
              e.stopPropagation();
            }
          }}
          style={{
            position: "fixed",
            top: at?.top ?? 0,
            left: at?.left ?? 0,
            // Hidden for the single frame before it has been measured, so it is never seen in the
            // corner on its way to the book it belongs to.
            visibility: at ? "visible" : "hidden",
            zIndex: 120,
            width: MENU_WIDTH,
            background: "var(--chr)",
            border: "1px solid var(--brd)",
            borderRadius: "var(--r-lg)",
            boxShadow: "var(--sh4)",
            padding: "var(--sp-3)",
            animation: "sard-rise .12s ease-out",
          }}
        >
          {items.map((a, i) => (
            <button
              key={a.label}
              ref={(el) => { itemRefs.current[i] = el; }}
              role="menuitem"
              tabIndex={i === active ? 0 : -1}
              className={`libd-menu-item${a.danger ? " danger" : ""}`}
              onFocus={() => setActive(i)}
              onClick={(e) => {
                e.stopPropagation();
                // `close`, not `setOpen(false)`: it hands focus back to the ⋯ first, so an action
                // that opens a dialog has a real element to return focus to when it closes.
                close();
                a.run();
              }}
              style={{
                width: "100%",
                // The mark and its words are one row. `gap` and `flex-start` are WRITING-DIRECTION
                // aware, so the icon leads the label in Arabic exactly as it does in English —
                // there is no left or right stated anywhere here, which is what keeps the two
                // languages from needing two rules.
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-3)",
                justifyContent: "flex-start",
                textAlign: "start",
                padding: "7px 10px",
                borderRadius: "var(--r-md)",
                font: "500 .8125rem var(--ui)",
                // `currentColor` is what the mark is drawn in, so the icon and its label can never
                // be two different colours — including in every state below. A destructive row says
                // so in its ink; the class carries that, so it is not stated twice.
                ...(a.danger ? {} : { color: "var(--txt)" }),
              }}
            >
              <Icon name={a.icon} size="sm" />
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.label}
              </span>
            </button>
          ))}
        </div>,
        // Inside the shell, so the design tokens resolve; above every layer, so the sidebar cannot
        // cover it. See `overlay.ts` for what happened when it was one or the other.
        overlayHost(),
      )}
    </>
  );
}
