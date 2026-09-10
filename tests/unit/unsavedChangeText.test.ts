// The sentence that names what changed — set in the script the reader is reading.
//
// NOT a dialog test: it calls the describer directly with each locale's REAL strings. The defect it
// pins was invisible to every existing test and to the compiler — a hardcoded «، » (U+060C, the
// Arabic comma) joined the list in both languages, so an English reader was told
// "You changed the paper، the book's paper". Only a human reading English could see it.
import { describe as suite, expect, it, vi } from "vitest";

// The component pulls the profile store (and through it Tauri IPC) at module load. None of that is
// exercised here — the describer is pure — so the graph is stubbed rather than run.
vi.mock("../../src/lib/ipc", () => ({}));
vi.mock("../../src/features/profiles/store", () => ({
  applyProfile: vi.fn(),
  captureCurrent: vi.fn(),
  createProfile: vi.fn(),
  saveProfile: vi.fn(),
  useProfiles: Object.assign(vi.fn(), { getState: () => ({ profiles: [], activeId: null }) }),
}));

import { describe as describeChanges } from "../../src/features/profiles/UnsavedChange";
import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";
import type { SessionKey } from "../../src/features/profiles/session";

const t = (table: Record<string, string>) => (k: string) => table[k];
const BOTH: SessionKey[] = ["theme_id", "book_theme_id"];

/** Arabic comma, semicolon and question mark — punctuation that belongs to Arabic, not English. */
const ARABIC_PUNCT = /[،؛؟]/;

suite("describe — the list of changed values", () => {
  it("joins with an English comma in English, and no Arabic punctuation survives", () => {
    const s = describeChanges(BOTH, t(en) as never);
    expect(s).toBe("the paper, the book’s paper");
    expect(ARABIC_PUNCT.test(s)).toBe(false);
  });

  it("joins with the Arabic comma in Arabic — the original behaviour, unchanged", () => {
    const s = describeChanges(BOTH, t(ar) as never);
    expect(s).toBe("الورق، ورق الكتاب");
  });

  it("names a single change without any separator at all", () => {
    expect(describeChanges(["theme_id"], t(en) as never)).toBe("the paper");
    expect(describeChanges(["theme_id"], t(ar) as never)).toBe("الورق");
  });

  it("names all four, still in the reader's own script", () => {
    const all: SessionKey[] = ["theme_id", "book_theme_id", "arabicFont", "latinFont"];
    const e = describeChanges(all, t(en) as never);
    expect(e).toBe("the paper, the book’s paper, the Arabic face, the Latin face");
    expect(ARABIC_PUNCT.test(e)).toBe(false);
    expect(describeChanges(all, t(ar) as never)).toContain("الخطّ اللاتيني");
  });

  it("defines the separator in BOTH locales — a missing key would join with `undefined`", () => {
    expect(en["profiles.unsaved.listSep"]).toBe(", ");
    expect(ar["profiles.unsaved.listSep"]).toBe("، ");
  });
});

// ---- what the dialog PROMISES must be what Save writes --------------------------------------------
//
// THE DEFECT THIS PINS, and it is the whole of the reported "Appearance settings are lost".
//
// `driftOf` asks what changed by comparing the هيئة against `liveValues()`, and `liveValues` falls
// back to the persisted `reading_style` row when no book is open — deliberately, because هيئات are
// switched from the LIBRARY, where `useReader.style` is null. The SAVE read `useReader.getState()
// .style` alone. So leaving a book and switching هيئة reported the size, the leading, the margins and
// the read-aloud marks as changed, named them in the dialog — and then wrote a payload in which every
// one of them had been restored from the هيئة itself, because the live reader was null.
//
// MEASURED, same scenario both ways: with the two sources disagreeing, «احفظ في هذه الهيئة» left
// `zoom`, `marginPx`, `lineHeight` and `voice` all null after the reader had set 1.45 / 128 / 2.2 and
// a spotlight colour; with them agreeing, the هيئة held exactly those values, and still held them
// after switching away, back, and reloading the application.
//
// The two reads must therefore be the same expression. A unit test cannot switch a هيئة, but it can
// refuse to let the two drift apart again.
suite("the drift that is reported and the drift that is saved read one source", () => {
  it("the save resolves the live style the same way `liveValues` does", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dialog = readFileSync(resolve(__dirname, "../../src/features/profiles/UnsavedChange.tsx"), "utf8");
    const session = readFileSync(resolve(__dirname, "../../src/features/profiles/session.ts"), "utf8");
    const EXPR = "useReader.getState().style ?? peekGlobalStyle()";
    expect(session).toContain(EXPR);
    expect(dialog).toContain(EXPR);
    // And the guarded block must not fall back to the live reader alone.
    expect(dialog).not.toContain("const liveStyle = useReader.getState().style;");
  });

  it("a هيئة with no read-aloud opinion does not acquire one from an unrelated change", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dialog = readFileSync(resolve(__dirname, "../../src/features/profiles/UnsavedChange.tsx"), "utf8");
    // The marks are written only once one of them has actually moved — the same rule the measure
    // follows. Without this, confirming a colour change would turn `voice: null` ("leave the reader's
    // own marks alone") into seven asserted values.
    expect(dialog).toContain('if (TTS_TRACKING_KEYS.some((k) => String(liveStyle[k] ?? "") !== asserted[k])) {');
  });
});
