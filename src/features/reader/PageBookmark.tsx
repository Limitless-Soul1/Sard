// On-page bookmark marker (RAWY-41) — the chosen shape+colour, hung from the TOP edge of the page
// sheet at the app-wide horizontal position. It renders in the chrome layer (ABOVE foliate's
// iframe), so it draws cleanly and can be DRAGGED along the top edge (pointer-capture keeps the
// drag smooth even over the iframe). Position is FIXED (physical `left`, does not flip with the UI
// language — RAWY-32/D21) and shared by every page; dragging updates the global `bookmark_pos`.
// The caller renders this ONLY when a bookmark is at the visible location (show-where-placed).

import { useRef } from "react";

import { useBookmarkStyle } from "../../lib/bookmarkStyle";
import { BookmarkShape } from "./BookmarkShape";

export function PageBookmark({ title }: { title?: string }) {
  const { shape, color, pos, setPos } = useBookmarkStyle();
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    const sheet = ref.current?.parentElement;
    if (!sheet) return;
    e.preventDefault();
    dragging.current = true;
    const rect = sheet.getBoundingClientRect();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const compute = (clientX: number) => (clientX - rect.left) / Math.max(1, rect.width);
    const move = (ev: PointerEvent) => {
      if (dragging.current) setPos(compute(ev.clientX), false);
    };
    const up = (ev: PointerEvent) => {
      dragging.current = false;
      setPos(compute(ev.clientX), true); // persist on release
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={ref}
      className="page-bookmark"
      style={{ left: `${pos * 100}%` }}
      onPointerDown={onPointerDown}
      title={title}
      role="img"
    >
      <BookmarkShape shape={shape} color={color} h={46} />
    </div>
  );
}
