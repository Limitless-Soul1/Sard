import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import type { FootnoteHit, NotePresentation } from "../../reader-engine/FoliateController";

// A SECOND SHEET OF THE BOOK'S OWN PAPER.
//
// Sard's reading identity is a page resting on a desk: `.page-sheet` is paper, `.reader-desk` is the
// surface under it, and the measure the reader chose decides how wide the text runs. A note belongs to
// that world, so it is drawn as another sheet of the same paper laid on the same desk — the reading
// ink, the reading face, the reading measure, the reading direction — rather than as a panel of
// interface colour hovering near a word.
//
// COMPOSED, NOT PINNED. The first version anchored itself to the reference's rectangle, and that is
// what made it read as a tooltip: it landed somewhere different for every note, it could never be
// given the reading measure because it had to fit beside the tap, and it was small because the space
// beside a tap is small. This is placed once, in the middle of the desk, at a size chosen for reading.
// What is lost by leaving the word is the sense of connection, and that is paid back in the header:
// the leaf opens with the very numeral the reader touched.
//
// THE DESK DIMS. One surface at a time is the whole idea — the scrim removes the competition rather
// than adding decoration, and it is also the dismissal: a click anywhere on it puts the book back.
//
// THE BOOK'S TEXT IS NEVER ALTERED. `sanitiseNote` removes only what must not run in the application's
// document — scripts, event handlers, and anything that could navigate or fetch on its own. No
// character is substituted, nothing is normalised, and the note's own markup and language are left
// exactly as the book wrote them.
//
// LENGTH, AND WHAT "OPEN IT" MEANS. A note is a sentence or a page and nothing announces which. The
// leaf opens at a comfortable reading height with the overflow faded, and «أفتحها» grows it to fill
// the desk. It deliberately does NOT navigate: the earlier version sent the reader to the notes page
// at the back of the book, which cost them their place and armed a return pill that outlived the note
// — a control still sitting in the reading view long after the note it belonged to had gone. Growing
// the sheet has no navigation state to leave behind, so there is nothing to go stale.
const SHORT_VH = 0.5;

/** Marks a link the book itself declared to be a backlink. See `sanitiseNote`. */
const BACK_ATTR = "data-note-back";
const BACK_TYPES = /(^|\s)(backlink|doc-backlink)(\s|$)/;

/**
 * Brackets, arrows and punctuation — everything a book puts AROUND a backlink and nothing a reader
 * came to read. Used to decide whether a block holds a note or merely the way back out of one.
 */
const FURNITURE = /^[\s[\]()<>«»„“”"'.,;:!?\u2190\u2192\u00b7\u2022*_|\u2010-\u2015]*$/;

/**
 * Take the way back OUT of the note off the note.
 *
 * Books end a note with a backlink — `[\u21901]` in one of these, a bare `\u2190` in another —
 * because in a book that link is the only way back to the sentence. Here it is not: this surface came
 * to the reader rather than the other way round, and it offers three ways out already, all of which
 * leave the reading position exactly where it was. Rendered anyway, the backlink lands at the top of
 * the note in the accent colour and reads as a heading, or worse, as a second and unexplained return
 * control — which is precisely how it was reported.
 *
 * So the note shows the note. This does NOT alter the book: nothing is rewritten, substituted or
 * normalised, and the element is removed from the COPY that is drawn, only when the block holding it
 * contains nothing else but punctuation. A backlink sitting inside a real sentence stays, because
 * there the sentence is the note.
 */
function stripBacklinkFurniture(root: HTMLElement): void {
  for (const a of Array.from(root.querySelectorAll<HTMLElement>(`[${BACK_ATTR}]`))) {
    let node: Element = a;
    let furniture: Element | null = null;
    while (node.parentElement && node.parentElement !== root) {
      const rest = (node.parentElement.textContent ?? "").replace(a.textContent ?? "", "");
      if (!FURNITURE.test(rest)) break;
      furniture = node.parentElement;
      node = node.parentElement;
    }
    furniture?.remove();
  }
}

/**
 * The height the note's text may occupy while the sheet is at its opening size, as it will actually
 * be DRAWN.
 *
 * The reader's size control rides on the sheet as `zoom`, which scales the element's own `max-height`
 * along with everything else, so a flat pixel cap is only that many pixels at the smallest setting.
 * MEASURED in a release at zoom 2.3 in a 720px window: a 320px cap drew 685px and hung off the bottom
 * of the screen. This divides the zoom back out, and takes its bound from the window so the sheet fits
 * whatever it is drawn in.
 *
 * A GROWN sheet has no cap of its own — it fills the desk and the layout bounds the text. An earlier
 * version used a second fraction here, and in a short window the two came out the same: growing moved
 * the sheet by four pixels while claiming to open it.
 */
function textCap(zoom: number): number {
  return Math.round(window.innerHeight * SHORT_VH) / (zoom || 1);
}

/**
 * What may appear in a note.
 *
 * The note comes out of the reader's own book, but it is about to be drawn in the APPLICATION's
 * document rather than in a frame of its own, so anything executable has to go. This drops elements
 * that can run or fetch, every `on*` handler, and any scheme that is not plainly a document link. It
 * does not touch text, presentational attributes, or the note's structure.
 *
 * An `href` survives as DATA, never as a live link: the sheet decides what following one means (see
 * `resolveNoteLink`), and a book's relative URL could not resolve out here in any case.
 */
const DROP_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "STYLE"]);
function sanitiseNote(html: string, isBacklink: (href: string, declared: boolean) => boolean): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (DROP_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    // Read the declaration BEFORE the attributes are stripped. An XHTML `epub:type` arrives here as a
    // plain attribute name, its namespace lost to serialisation, so both spellings are asked for.
    const declaredBack = BACK_TYPES.test(el.getAttribute("epub:type") ?? "")
      || BACK_TYPES.test(el.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "")
      || BACK_TYPES.test(el.getAttribute("role") ?? "");
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if (n === "href" || n === "src" || n === "xlink:href") {
        const v = attr.value.trim();
        el.removeAttribute(attr.name);
        if (n === "href" && v && !/^\s*javascript:/i.test(v)) {
          el.setAttribute("data-note-href", v);
          // The SAME question the click asks, asked once here: a link is a backlink either because the
          // book declared it one or because it resolves into the section the reader is already in.
          if (isBacklink(v, declaredBack)) el.setAttribute(BACK_ATTR, "");
        }
      }
    }
  }
  stripBacklinkFurniture(doc.body);
  return doc.body.innerHTML;
}

export function NoteSheet({
  hit,
  presentation,
  measurePx,
  isBacklink,
  onSelect,
  onSurface,
  onRedraw,
  onEditAt,
  onFollow,
  onClose,
}: {
  hit: FootnoteHit;
  /** The reading surface's own numbers and palette, resolved once by the engine — never re-derived. */
  presentation: NotePresentation | null;
  /** The page's measure, so a note's lines break the way the book's do. It is declared on the desk and
   *  this sheet is the desk's sibling, so it is handed over rather than inherited. */
  measurePx: number;
  /** Whether a link inside the note leads back where the reader already is. One definition, the
   *  engine's, used both to decide what a click means and whether the link is worth drawing. */
  isBacklink: (rawHref: string, declaredBacklink: boolean) => boolean;
  /** Hand a selection made in the note to the engine, which anchors it and publishes it through the
   *  application's one selection channel. Passing null dismisses, exactly as a fresh press does in the
   *  reading frame. */
  onSelect: (sel: {
    pre: string; text: string; post: string;
    rect: { left: number; top: number; width: number; height: number; bottom: number };
    range: Range;
  } | null) => void;
  /** Register the note's text element AND its overlay layer with the engine while the note is open.
   *  The engine segments the text for read-aloud and draws the note's marks into the layer, using the
   *  same overlay class and the same draw functions the book's own page uses. */
  onSurface: (el: HTMLElement | null, layer: HTMLElement | null) => void;
  /** Put the overlay back over the words after the note scrolls or the window changes. */
  onRedraw: () => void;
  /** A double-click in the note's text: the caller asks the engine whether a stored highlight is under
   *  it and, if so, opens the SAME annotation editor the page opens. */
  onEditAt: (x: number, y: number) => void;

  /** A link inside the note, with what the book declared it to be. The caller decides what it means. */
  onFollow: (rawHref: string, declaredBacklink: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const sheet = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  /** Overflowing is not the same as having somewhere to grow INTO. See the measurement below. */
  const [canGrow, setCanGrow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the predicate is stable per note
  const clean = useMemo(() => sanitiseNote(hit.html, isBacklink), [hit.html]);
  const zoom = presentation?.zoom ?? 1;
  const cap = expanded ? undefined : textCap(zoom);

  // The application's document never declares the BOOK's faces — they are injected into the reading
  // frame, which this note is no longer inside. Without them it would fall back to the interface's own
  // font, which is the one thing a note must not do.
  useEffect(() => {
    if (!presentation?.faceCss) return;
    let el = document.head.querySelector<HTMLStyleElement>("style[data-sard-note-faces]");
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-sard-note-faces", "");
      document.head.append(el);
    }
    if (el.textContent !== presentation.faceCss) el.textContent = presentation.faceCss;
  }, [presentation?.faceCss]);

  // MEASURED, AND MEASURED AGAIN WHEN THE TEXT IS FINALLY ITSELF.
  //
  // Whether the note overflows decides whether it is offered any way to grow, so measuring it early is
  // measuring the wrong thing: the book's faces load asynchronously and the note is laid out in a
  // fallback until they arrive. MEASURED at a large reading size, a note that genuinely overflowed
  // reported no overflow one frame after mount and the affordance never appeared. `fonts.ready` is the
  // moment the text is the size it is going to be; the resize covers a window changed while it is open.
  useLayoutEffect(() => {
    let alive = true;
    const measure = () => {
      const host = body.current;
      const box = sheet.current;
      if (!alive || !host) return;
      const over = host.scrollHeight - host.clientHeight > 4;
      setOverflows(over);
      // AND IS THERE ANYWHERE TO GROW? Measured in RENDERED pixels on both sides, because the text
      // carries the reader's `zoom` and the sheet does not, so the two do not share a unit. The sheet
      // may occupy the desk less the scrim's own margin; whatever the head, the padding and the action
      // take is not available to the text. Offering to open a sheet that is already as open as it can
      // be is how the earlier version came to move by four pixels and call it growing.
      const textH = host.getBoundingClientRect().height;
      const furniture = box ? box.getBoundingClientRect().height - textH : 0;
      const roomForText = window.innerHeight * 0.9 - furniture;
      setCanGrow(over && roomForText - textH > 24);
    };
    const id = window.requestAnimationFrame(measure);
    document.fonts?.ready?.then(measure).catch(() => { /* a platform without the promise keeps the frame */ });
    window.addEventListener("resize", measure);
    // THE MARKS FOLLOW THE WORDS. The overlay sits over the note but does not scroll with it, so the
    // rects have to be taken again when the text moves under it - the same reason the reading frame
    // redraws its own overlay when the page relocates.
    const host2 = body.current;
    const follow = () => onRedraw();
    host2?.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => {
      alive = false;
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", measure);
      host2?.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
    };
  }, [clean, cap, expanded]);

  // FOCUS COMES OUT OF THE BOOK, and it has to.
  //
  // A reader's focus lives inside the reading frame, which is a separate document: a key pressed there
  // never reaches the application's own `window`, and the engine's own handler treats Escape as
  // "dismiss the selection". Measured with the sheet open and focus left where it was, Escape did
  // nothing at all. This is the shape of the F11 and Ctrl+F forwarding the engine already carries, but
  // the answer here is better than forwarding a key: this is a dialog, so focus belongs in it while it
  // is open, and Tab then reaches the note's own links and its close control. The caller puts focus
  // back in the book when the note goes away.
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
  }, [hit]);

  // THE NOTE'S OWN DOM, WRITTEN ONCE AND LEFT ALONE.
  //
  // This was `dangerouslySetInnerHTML`, and that is what made every range into the note die. MEASURED
  // with a MutationObserver on this element while read-aloud started: three `childList` mutations, each
  // REMOVING the note's `<dl>` and ADDING an identical one. The element survived; every text node under
  // it did not, so a Range built a moment earlier came back collapsed with zero client rects. That is
  // React re-applying the markup on re-render, which it is entitled to do because it owns the property.
  //
  // So React does not own it. The sanitised fragment is written here, once per note, and the element is
  // left empty in the JSX — React has nothing to re-apply. Everything that needs to point INTO the
  // note (read-aloud's units, a highlight's range, the reader's own selection) can now hold a range for
  // as long as the note is open, which is what this surface's whole integration rests on.
  useEffect(() => {
    const host = body.current;
    if (!host) return;
    const parsed = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
    host.replaceChildren(...Array.from(parsed.body.childNodes));
    onSurface(host, layer.current);
    return () => onSurface(null, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // SELECTING IN A NOTE IS SELECTING IN THE BOOK.
  //
  // The note is the book's text, so selecting it must raise the reading surface's own toolbar with the
  // reading surface's own actions — not a second toolbar that looks like it. What is needed for that
  // is not a component but a MEASUREMENT: the selected text, where it sits on screen, and enough
  // context either side to find the same words again in the document the note came out of. The engine
  // turns that into a CFI and publishes it through the one selection channel the application has.
  //
  // The gesture is the reading frame's, kept deliberately identical: a press dismisses whatever is up
  // and remembers what was selected; a release raises the toolbar only if the selection actually
  // CHANGED. Without that second half, clicking inside an existing selection re-raises the toolbar,
  // which is the behaviour the reading frame carries a named invariant against.
  //
  // The listeners are on the WINDOW, not on the text, because a selection drag routinely ends outside
  // the words it started in — past the last line, over the sheet's margin, on the dimmed desk. A
  // handler bound to the text would miss exactly the gestures that select the most.
  const downText = useRef("");
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    const host = body.current;
    if (!host) return;
    const down = (e: PointerEvent) => {
      if (!host.contains(e.target as Node)) return;
      downText.current = String(window.getSelection() ?? "");
      onSelectRef.current(null);
    };
    const up = () => report();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      // THE TOOLBAR BELONGS TO THE SELECTION, AND THE SELECTION BELONGS TO THE NOTE. Dismissing the
      // note while a toolbar is up would leave it pointing at a surface that had gone.
      onSelectRef.current(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit]);

  const report = () => {
    const host = body.current;
    const sel = window.getSelection();
    if (!host || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)) return;
    const text = range.toString().trim();
    if (!text || String(sel) === downText.current) return;
    // The words either side, taken from the note itself. `findMatchRange` windows this to 40
    // characters and normalises both sides, so a generous slice costs nothing and disambiguates a
    // phrase that occurs more than once in the same note.
    const lead = document.createRange();
    lead.selectNodeContents(host);
    lead.setEnd(range.startContainer, range.startOffset);
    const before = lead.toString();
    const whole = host.textContent ?? "";
    onSelectRef.current({
      range: range.cloneRange(),
      pre: before.slice(-60),
      text,
      post: whole.slice(before.length + range.toString().length).slice(0, 60),
      rect: (({ left, top, width, height, bottom }) => ({ left, top, width, height, bottom }))(
        range.getBoundingClientRect()),
    });
  };

  const label = hit.type === "endnote" ? t("note.endnote")
    : hit.type === "biblioentry" ? t("note.reference")
      : t("note.footnote");

  // The sheet is the BOOK's, so it reads in the book's direction — an RTL book keeps its note RTL even
  // when the interface is not, and the header, the rule and the close control all follow it.
  const dir = presentation?.direction ?? "rtl";

  return (
    <div
      className="note-scrim"
      onPointerDown={onClose}
      style={{ "--page-pref": `${measurePx}px` } as React.CSSProperties}
    >
      <div
        className={`note-sheet${expanded ? " grown" : ""}`}
        ref={sheet}
        tabIndex={-1}
        dir={dir}
        role="dialog"
        aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        style={presentation
          ? {
            background: presentation.paper,
            color: presentation.ink,
            // The note's own numerals and rules are drawn in the reading palette, not the interface's.
            "--note-ink": presentation.ink,
            "--note-muted": presentation.muted,
            "--note-accent": presentation.accent,
            // The fade is the paper running out, so it must BE the paper.
            "--note-paper": presentation.paper,
          } as React.CSSProperties
          : undefined}
      >
        {/* THE HEAD IS SARD'S FRAME, NOT THE BOOK'S TEXT, so it does not mirror when the book does.
            Two groups and `space-between` — what this note is, and the way out — rather than one
            of them shoved across by an automatic margin. Its own direction is fixed, so the close
            control is in the same physical corner whether the book is Arabic or English; only the
            note's TEXT below follows the book. */}
        <header className="note-head">
          <span className="note-ident">
            {/* THE NUMERAL THE READER TOUCHED, in the book's own face. It is the whole of the
                connection between the word left behind and the sheet in front of them, so it is set as
                content rather than as a label: the size of a drop capital, in the accent, read first. */}
            {hit.marker && (
              <span className="note-marker" style={presentation ? { fontFamily: presentation.fontFamily } : undefined}>
                {hit.marker}
              </span>
            )}
            <span className="note-kind">{label}</span>
          </span>
          <button className="note-close" onClick={onClose} aria-label={t("panel.close")}>
            <Icon name="close" size="sm" />
          </button>
        </header>

        <div className="note-text-wrap">
          <div
            className="note-text"
            ref={body}
            style={{
              maxHeight: cap,
              ...(presentation
                ? {
                  fontFamily: presentation.fontFamily,
                  fontSize: presentation.fontSize,
                  lineHeight: presentation.lineHeight,
                  textAlign: presentation.textAlign as "start",
                  zoom,
                }
                : {}),
            }}
            // A DOUBLE-CLICK INSIDE A MARK OPENS ITS EDITOR, which is the gesture the page already uses
            // (RAWY-262). Over plain text the gesture is left alone, so double-click-to-select-a-word
            // keeps working here exactly as it does in the book.
            onDoubleClick={(e) => {
              onEditAt(e.clientX, e.clientY);
            }}
            // A link inside a note is DATA until the reader asks for it — see `sanitiseNote`. One rule
            // for every kind, so what happens is predictable; `resolveNoteLink` decides which kind.
            onClick={(e) => {
              const a = (e.target as HTMLElement)?.closest?.("[data-note-href]") ?? null;
              const href = a?.getAttribute("data-note-href");
              if (!a || !href) return;
              e.preventDefault();
              onFollow(href, a.hasAttribute(BACK_ATTR));
            }}
          />
          {/* THE NOTE'S MARKS. The engine draws into this: the read-aloud spotlight, the word pill and
              any highlight made in the note, through the same overlay class and the same draw functions
              the page uses. It sits INSIDE the sheet, over the words and in their own stacking context,
              because a highlight is painted with `mix-blend-mode` and must blend with the note's paper
              and glyphs rather than with the desk behind the sheet. It is inert. */}
          <div className="note-overlay" ref={layer} aria-hidden />
          {/* The fade is the only sign that there is more, and it is enough: it is the paper itself
              running out, not a scrollbar or a chevron. It goes the moment the sheet has grown. */}
          {overflows && !expanded && <div className="note-fade" aria-hidden />}
        </div>

        {canGrow && !expanded && (
          <button className="note-grow" onClick={() => setExpanded(true)}>{t("note.expand")}</button>
        )}
      </div>
    </div>
  );
}
