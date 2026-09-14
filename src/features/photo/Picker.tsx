// A DROPDOWN THE APPLICATION ACTUALLY DRAWS.
//
// This replaces a native `<select>`, and the reason is not taste. A native select's menu is an
// OS-level popup: it is not in the document, the page's CSS reaches almost none of it, and on this
// WebView its option list came up unreadable — light text on a light system menu, because the
// control had been given a dark colour scheme and the popup had not. That class of bug cannot be
// fixed by styling the closed control, and it cannot be SEEN by anything that inspects the page,
// which is worse: the defect is invisible to every check that is not a human looking at the screen.
//
// So the menu is a real element. It inherits the composer's own surfaces, it honours direction, its
// hover and selected states are the ones used everywhere else here, and — the point — it can be
// photographed and measured like any other part of the editor.
//
// Keyboard: the trigger is a button, the list is a `listbox`, Up/Down move, Enter/Space choose,
// Escape closes. A pointer press anywhere else closes it, which is what a menu should do; it is no
// longer the ONLY way out, because there is a chosen option to press.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface PickerOption {
  value: string;
  label: string;
  /** Drawn in the option's own face, so a font list shows the faces rather than naming them. */
  family?: string;
}

export function Picker({
  value, options, onPick, title, className, width,
}: {
  value: string;
  options: PickerOption[];
  onPick: (v: string) => void;
  title?: string;
  /** Extra class on the trigger, so the toolbar and the panel can size it differently. */
  className?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  // Close on a press anywhere else. Captured on the document because the press that closes this may
  // legitimately belong to something underneath — a toolbar button, the canvas — and must still land.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // Open onto the chosen option rather than the top of the list.
  useLayoutEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
    listRef.current?.focus();
    listRef.current?.querySelector<HTMLElement>(".pcx-opt.on")?.scrollIntoView({ block: "nearest" });
  }, [open, value, options]);

  const choose = (v: string) => { onPick(v); setOpen(false); };

  return (
    <div className="pcx-pickerwrap" ref={rootRef}>
      <button
        type="button"
        className={`pcx-picker${className ? " " + className : ""}${open ? " open" : ""}`}
        style={width ? { width } : undefined}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
        }}
      >
        <span className="pcx-picker-val" style={current?.family ? { fontFamily: current.family } : undefined}>
          {current?.label ?? ""}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="pcx-opts"
          role="listbox"
          ref={listRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setOpen(false); return; }
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(options[active].value); }
          }}
        >
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`pcx-opt${o.value === value ? " on" : ""}${i === active ? " hot" : ""}`}
              style={o.family ? { fontFamily: o.family } : undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(o.value)}
            >
              <span className="pcx-opt-tick" aria-hidden>{o.value === value ? "✓" : ""}</span>
              <span className="pcx-opt-label">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
