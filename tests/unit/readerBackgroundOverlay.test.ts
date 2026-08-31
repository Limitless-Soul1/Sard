// THE READING BACKGROUND'S OVERLAY, AND THE POPUP THAT KEPT LEAVING THE WINDOW.
//
// Two unrelated defects, guarded in one place because both are about something escaping the bounds
// it was supposed to respect: a colour layer that could not be turned off, and a floating panel that
// could not stay on screen.
//
// The overlay's rendering is CSS and JSX, so those parts are read as FILES the way this repo's other
// structural guards are; the model itself is real code and is exercised directly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BG_NO_OVERLAY,
  bgOverlayOf,
  overlayTint,
  LIB_SCRIM_MIN,
  READ_SCRIM_MIN,
  scrimAlpha,
  scrimMinFor,
} from "../../src/lib/background";
import { anchorStyle, fitsBelow, POP_EDGE } from "../../src/features/reader/AnnotationLayer";
import { parseProfileData } from "../../src/features/profiles/model/profile";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const R = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(R, p), "utf8");
const CSS = read("src/styles/global.css");
const READER = read("src/features/reader/Reader.tsx");
const SETTINGS = read("src/features/reader/ReadingSettings.tsx");
const EDITOR = read("src/features/profiles/ProfileEditor.tsx");
const BG = read("src/lib/background.ts");

describe("the reading overlay has three states, and one of them is none", () => {
  it("absent still means the theme, so nothing stored moves", () => {
    expect(bgOverlayOf(null).kind).toBe("theme");
    expect(bgOverlayOf(undefined).kind).toBe("theme");
    expect(bgOverlayOf("").kind).toBe("theme");
  });

  it("a hex still means that colour", () => {
    const o = bgOverlayOf("#1C1C1E");
    expect(o.kind).toBe("colour");
    expect(o.kind === "colour" && o.hex).toBe("#1C1C1E");
    expect(bgOverlayOf("#abc").kind).toBe("colour");
    expect(bgOverlayOf("#11223344").kind).toBe("colour");
  });

  it("and the sentinel means no layer at all", () => {
    expect(bgOverlayOf(BG_NO_OVERLAY).kind).toBe("none");
    // it must never be mistakeable for a colour
    expect(BG_NO_OVERLAY.startsWith("#")).toBe(false);
    expect(bgOverlayOf(BG_NO_OVERLAY).kind).not.toBe("colour");
  });

  it("nonsense reads as the theme rather than throwing", () => {
    for (const v of ["rgb(1,2,3)", "#12", "wheat", "  ", "#GGGGGG"]) {
      expect(bgOverlayOf(v).kind, v).toBe("theme");
    }
  });

  it("none is an ABSENCE, not a transparent colour", () => {
    // The distinction that matters: `paint: false` means the caller draws nothing, rather than
    // drawing something at zero. A 0% colour would look the same today and would still be a
    // compositing step for a later change to put a value back into.
    const none = overlayTint(bgOverlayOf(BG_NO_OVERLAY));
    expect(none.paint).toBe(false);
    expect(none.tint).toBeNull();

    const theme = overlayTint(bgOverlayOf(null));
    expect(theme.paint).toBe(true);
    expect(theme.tint).toBeNull(); // null tint = fall through to the desk colour

    const hex = overlayTint(bgOverlayOf("#402010"));
    expect(hex.paint).toBe(true);
    expect(hex.tint).toBe("#402010");
  });
});

describe("no overlay means the picture is composited under nothing", () => {
  it("the stylesheet removes the layer rather than fading it", () => {
    expect(CSS).toContain(':root[data-bg-reading="on"] .reader-desk[data-overlay="off"]::after { content: none; }');
  });

  it("the picture layer itself is untouched by the rule", () => {
    // ::before is the photograph. Only ::after — the scrim and grain — is dropped, so blur, focal
    // point and flip keep doing exactly what the reader set them to.
    const rule = CSS.slice(CSS.indexOf('.reader-desk[data-overlay="off"]'));
    expect(rule.slice(0, 120)).not.toContain("::before");
  });

  it("the Reader marks the desk from the shared model, not from its own test", () => {
    expect(READER).toContain("const bgOverlay = bgOverlayOf(style?.backgroundColor)");
    expect(READER).toContain("const overlayPaint = overlayTint(bgOverlay)");
    expect(READER).toContain('data-overlay={overlayPaint.paint ? undefined : "off"}');
  });

  it("and it no longer reads the stored value directly for the tint", () => {
    // It used to be `style?.backgroundColor ? { … }`, which cannot express a third state: any
    // non-empty string is truthy, so "none" would have been painted AS a colour. The tint is now
    // read through the shared model, and it is the OVERRIDE over the desk rather than a conditional
    // property — the desk always has a named colour underneath it (see the boundary suite).
    expect(READER).toContain("overlayPaint.tint ??");
    expect(READER).not.toContain('...(style?.backgroundColor ? { "--reader-bg": style.backgroundColor } : {})');
  });
});

describe("paper colour no longer forces a layer onto the picture", () => {
  it("the theme state still tints from the desk, which is the design", () => {
    // Unchanged on purpose: a scrim in the theme's own colour is what makes a photograph read as lit
    // by the theme. What was missing was a way to decline it.
    expect(CSS).toContain("color-mix(in srgb, var(--reader-bg, var(--app-bg)) var(--bg-rd-scrim, 100%), transparent)");
  });

  it("but the none state reaches the picture through no colour at all", () => {
    const none = overlayTint(bgOverlayOf(BG_NO_OVERLAY));
    expect(none.tint).toBeNull();
    expect(none.paint).toBe(false);
    // there is no path from a palette value to a painted layer once paint is false
    expect(BG).toContain('if (o.kind === "none") return { paint: false, tint: null };');
  });
});

describe("the Reader and the editor read one definition", () => {
  it("both call the same two functions", () => {
    for (const src of [READER, EDITOR]) {
      expect(src).toContain("bgOverlayOf(");
      expect(src).toContain("overlayTint(");
    }
  });

  it("the editor's preview drops its scrim element too", () => {
    expect(EDITOR).toContain("const readOverlay = overlayTint(bgOverlayOf(");
    expect(EDITOR).toContain("{bookBg.paint && (");
  });

  it("neither surface computes its own answer", () => {
    // The failure this prevents is the one the page-opacity work already had to undo: a preview that
    // arrives at its own number and disagrees with the thing it depicts.
    expect(EDITOR).not.toContain('style={{ opacity: bookBg.scrim }}');
  });
});

describe("the third state is offered where it makes sense and nowhere else", () => {
  it("the background row offers it", () => {
    const at = SETTINGS.indexOf('label={t("color.background")}');
    expect(at).toBeGreaterThan(-1);
    expect(SETTINGS.slice(at, at + 200)).toContain("offerNone");
  });

  it("the page row does not", () => {
    // "No paper" is not a reading surface — it would put the words onto whatever is behind them.
    const at = SETTINGS.indexOf('label={t("color.page")}');
    expect(at).toBeGreaterThan(-1);
    expect(SETTINGS.slice(at, at + 200)).not.toContain("offerNone");
  });

  it("it is named in both languages", () => {
    expect(ar["color.none"]).toBeTruthy();
    expect(en["color.none"]).toBeTruthy();
  });

  it("the swatch is hollow, because it stands for the absence of a colour", () => {
    expect(CSS).toContain(".rs-ink-none");
    expect(SETTINGS).toContain('className={`rs-ink rs-ink-none${overlay.kind === "none" ? " on" : ""}`}');
  });
});

describe("the library's background is not part of this", () => {
  it("its floor, its a11y floor and its presence are untouched", () => {
    expect(LIB_SCRIM_MIN).toBe(0);
    expect(READ_SCRIM_MIN).toBe(0.62);
    expect(scrimMinFor("library")).toBe(LIB_SCRIM_MIN);
    expect(scrimAlpha(100, "library")).toBe(0);
  });

  it("no library rule learned about the overlay attribute", () => {
    const lib = CSS.slice(CSS.indexOf("--bg-lib-image"));
    expect(lib.slice(0, 4000)).not.toContain("data-overlay");
  });
});

describe("the selection popup stays inside the window", () => {
  const rects = [
    { left: 0, top: 0, width: 10, height: 10, bottom: 10, right: 10 },
    { left: 1900, top: 1050, width: 200, height: 20, bottom: 1070, right: 2100 },
    { left: 640, top: 400, width: 120, height: 18, bottom: 418, right: 760 },
    { left: -50, top: -30, width: 40, height: 12, bottom: -18, right: -10 },
  ];
  const boxes = [
    { w: 280, h: 120 },   // the popup as it opens
    { w: 320, h: 380 },   // with the colour picker inside it
    { w: 900, h: 1400 },  // absurd, to prove the clamp does not invert
  ];
  const viewports = [
    [1280, 800], [1920, 1080], [800, 600], [420, 380],
  ] as const;

  it("never places the popup outside the viewport, on either axis", () => {
    for (const [vw, vh] of viewports) {
      for (const box of boxes) {
        for (const r of rects) {
          const below = fitsBelow(r, box.h, vh);
          const st = anchorStyle(r, below, box, vw, vh) as { left: number; top: number };
          // `translate(-50%, …)`: the painted box runs from left-halfW to left+halfW
          const l = st.left - box.w / 2;
          const rgt = st.left + box.w / 2;
          const t = below ? st.top : st.top - box.h;
          const b = below ? st.top + box.h : st.top;
          const label = `${vw}x${vh} box ${box.w}x${box.h} rect ${r.left},${r.top}`;
          // a popup larger than the window is pinned at the margin, never centred off-screen
          if (box.w + 2 * POP_EDGE <= vw) {
            expect(l, label + " left").toBeGreaterThanOrEqual(POP_EDGE - 0.5);
            expect(rgt, label + " right").toBeLessThanOrEqual(vw - POP_EDGE + 0.5);
          } else {
            expect(l, label + " left pinned").toBeLessThanOrEqual(POP_EDGE + 0.5);
          }
          if (box.h + 2 * POP_EDGE <= vh) {
            expect(t, label + " top").toBeGreaterThanOrEqual(POP_EDGE - 0.5);
            expect(b, label + " bottom").toBeLessThanOrEqual(vh - POP_EDGE + 0.5);
          } else {
            expect(t, label + " top pinned").toBeLessThanOrEqual(POP_EDGE + 0.5);
          }
        }
      }
    }
  });

  it("prefers above when it fits there, which is the design's own placement", () => {
    const roomy = { left: 640, top: 500, width: 100, height: 20, bottom: 520, right: 740 };
    expect(fitsBelow(roomy, 120, 800)).toBe(false);
  });

  it("flips below when there is no room above", () => {
    const high = { left: 640, top: 30, width: 100, height: 20, bottom: 50, right: 740 };
    expect(fitsBelow(high, 300, 800)).toBe(true);
  });

  it("takes the larger side when neither fits, rather than picking blind", () => {
    const mid = { left: 640, top: 200, width: 100, height: 20, bottom: 220, right: 740 };
    // 182 above, 562 below, popup 600 — neither fits, below is larger
    expect(fitsBelow(mid, 600, 800)).toBe(true);
  });

  it("the caller measures instead of guessing from the anchor", () => {
    const SRC = read("src/features/reader/AnnotationLayer.tsx");
    expect(SRC).toContain("const [popRef, popBox] = useMeasured();");
    expect(SRC).toContain("anchorStyle(sel.rect, below, popBox)");
    expect(SRC).toContain("ResizeObserver");
    // the old constant-driven clamp is gone
    expect(SRC).not.toContain("Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);\n  return below");
  });
});

describe("the relief control's name", () => {
  it("reads القوائم, not الحواشي", () => {
    expect(ar["profiles.relief.name"]).toBe("بروز القوائم");
    expect(ar["profiles.relief.name"]).not.toContain("الحواشي");
  });

  it("and nothing else was renamed with it", () => {
    // The colour row still names the same surface الحواشي; changing that was not asked for and is a
    // separate decision.
    expect(ar["profiles.colour.chrome"]).toBe("الحواشي");
  });
});

describe("the appearance editor carries the same choice", () => {
  const PROFILE = read("src/features/profiles/model/profile.ts");

  it("a profile stores the overlay, and absent still means the theme", () => {
    const p = parseProfileData(JSON.stringify({ bg: { reading: {} } }));
    expect(p.bg.reading.overlay).toBeNull();
    expect(bgOverlayOf(p.bg.reading.overlay).kind).toBe("theme");
  });

  it("it stores the same three states the Reader has, read by the same function", () => {
    const at = (overlay: unknown) =>
      parseProfileData(JSON.stringify({ bg: { reading: { overlay } } })).bg.reading.overlay;
    expect(at(BG_NO_OVERLAY)).toBe(BG_NO_OVERLAY);
    expect(at("#402010")).toBe("#402010");
    expect(at(null)).toBeNull();
    // nonsense is not stored as a colour
    expect(at("wheat")).toBeNull();
    expect(at(7)).toBeNull();
    for (const v of [BG_NO_OVERLAY, "#402010", null]) {
      expect(bgOverlayOf(at(v)).kind).toBe(bgOverlayOf(v as string | null).kind);
    }
  });

  it("activating a profile writes it into the reading style", () => {
    // Always written, like the number ink: omitting it on clear would leave the previous choice
    // standing in `reading_style` with nothing able to drop it.
    expect(PROFILE).toContain("out.backgroundColor = p.data.bg.reading.overlay;");
  });

  it("the editor offers exactly the three states", () => {
    const at = EDITOR.indexOf('open === "overlay" && (');
    expect(at).toBeGreaterThan(-1);
    const row = EDITOR.slice(at, at + 2200);
    expect(row).toContain("d.bg.reading.overlay = null;");
    expect(row).toContain("d.bg.reading.overlay = BG_NO_OVERLAY;");
    expect(row).toContain("d.bg.reading.overlay = hex;");
  });

  it("it lives in the BOOK COLOURS chapter, beside the other inks", () => {
    // Under «الخلفيّة» it read as a property of the picture. It is a colour of the reading surface,
    // so it belongs with the reading surface's other colours.
    const at = EDITOR.indexOf('aria-label={t("color.behindPage")}');
    expect(at).toBeGreaterThan(-1);
    const before = EDITOR.slice(0, at);
    // the chapter is `InlineColours`, and the row is gated to the reading scope like «الأرقام»
    expect(before.lastIndexOf("function InlineColours")).toBeGreaterThan(-1);
    expect(EDITOR.slice(at - 900, at)).toContain('scope === "reading"');
  });

  it("and it uses the editor's INLINE picker, never a floating panel", () => {
    // Measured in the running editor: the floating panel was the only picker that could reach the
    // preview; all four inline ones covered none of it at any window size. The editor no longer
    // imports the floating one at all.
    const at = EDITOR.indexOf('open === "overlay" && (');
    expect(EDITOR.slice(at, at + 900)).toContain('className="pf-ink-picker"');
    expect(EDITOR).not.toContain('import { InkCustom }');
    expect(EDITOR).not.toContain("<InkCustom");
  });

  it("the row reads no paper value, so the two cannot re-couple", () => {
    // BOUNDED BY REAL MARKERS, not a character count: the window used to start 1400 characters
    // back and swallowed the «الأرقام» picker above, whose `contrastAgainst={c.paperBg}` is
    // legitimate. Comments are stripped too, since the block's own prose names the thing.
    const from = EDITOR.indexOf("THE COLOUR BEHIND THE PAGE");
    const to = EDITOR.indexOf('{t("color.behindPageHint")}');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = EDITOR.slice(from, to)
      .split(String.fromCharCode(10))
      .filter((l) => { const x = l.trim();
        return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); })
      .join(String.fromCharCode(10));
    expect(block).not.toContain("paperBg");
  });

  it("and its preview follows the draft rather than the live reader", () => {
    expect(EDITOR).toContain("overlayTint(bgOverlayOf(draft.data.bg.reading.overlay))");
  });

  it("the LIBRARY background gained no such field", () => {
    const p = parseProfileData(JSON.stringify({ bg: { library: { overlay: "none" } } }));
    expect((p.bg.library as unknown as Record<string, unknown>).overlay).toBeUndefined();
  });

  it("the page colour is still a separate setting on a separate surface", () => {
    // The three must not collapse into each other: the page is the reading surface, the picture is
    // the picture, and the overlay is only the layer between them.
    expect(SETTINGS).toContain('label={t("color.page")}');
    expect(EDITOR).toContain('{t("color.behindPage")}');
    expect(EDITOR).not.toContain("d.bg.reading.overlay = d.theme.reading.colors.paperBg");
  });

  it("one setting has one name in both places", () => {
    // «لون الخلفية» was read as a property of the picture — the confusion that put the control in
    // the wrong chapter in the first place. Both surfaces now say the same thing.
    expect(ar["color.background"]).toBe(ar["color.behindPage"]);
    expect(en["color.background"]).toBe(en["color.behindPage"]);
    expect(ar["color.behindPageHint"]).toBeTruthy();
    expect(en["color.behindPageNote"]).toBeTruthy();
  });
});

describe("the custom colour panel stays in the window", () => {
  const INK = read("src/components/InkCustom.tsx");

  it("the shift is written to the element, not handed to React", () => {
    // THE DEFECT THIS REPLACES. The first attempt computed the offset and passed it as a style prop.
    // `place()` must clear the transform before measuring, and when the newly computed offset equalled
    // the one already in state React re-rendered nothing and never put it back — so the panel measured
    // exactly as far outside the window as before the fix. Fifteen of fifteen, in the running reader.
    expect(INK).toContain('el.style.transform = "none";');
    expect(INK).toContain("el.style.transform = dx ? `translateX(${dx}px)` : \"\";");
    expect(INK).not.toContain("style={fit.dx");
  });

  it("the flip is measured from the swatch, which does not move when it flips", () => {
    // Measuring room from the PANEL's own top is a question whose answer changes the moment the flip
    // happens, so it oscillated and settled on "below" every time.
    expect(INK).toContain("const anchor = wrap.current?.getBoundingClientRect();");
    expect(INK).toContain("const roomBelow = vh - anchor.bottom - GAP - PANEL_EDGE;");
    expect(INK).toContain("const roomAbove = anchor.top - GAP - PANEL_EDGE;");
  });

  it("it re-places on resize and on a scroll anywhere, including the drawer's", () => {
    expect(INK).toContain('window.addEventListener("resize", place)');
    expect(INK).toContain('document.addEventListener("scroll", place, true)');
    expect(INK).toContain("ResizeObserver");
  });

  it("a panel wider than the window is pinned rather than hung off both edges", () => {
    expect(INK).toContain("if (r.width > vw - 2 * PANEL_EDGE) dx = PANEL_EDGE - r.left;");
  });

  it("the stylesheet owns only the flip, not the nudge", () => {
    expect(CSS).toContain(".rs-ink-panel.above { top: auto; bottom: calc(100% + 10px); }");
  });
});

describe("presence and the overlay are two settings, not one", () => {
  const EDITOR_SRC = read("src/features/profiles/ProfileEditor.tsx");
  const RS = read("src/features/reader/ReadingSettings.tsx");
  const codeOf = (src: string) =>
    src.split(String.fromCharCode(10))
      .filter((l) => { const x = l.trim();
        return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*") && !x.startsWith("{/*"); })
      .join(String.fromCharCode(10));

  // WHAT WENT WRONG. Presence is the strength of the colour layer — `scrimAlpha` becomes that
  // layer's opacity and nothing else — and «بلا لون» removes the layer. The slider was left fully
  // interactive over nothing: measured on the owner's own profile, a real mouse drag produced 669
  // `input` events, swept the whole 0..260 range, and could not change a single pixel, because
  // `.pf-stage-scrim` was not in the document at all.

  it("theme default: the layer exists, so presence has something to act on", () => {
    const o = overlayTint(bgOverlayOf(null));
    expect(o.paint).toBe(true);
    expect(scrimAlpha(0, "reading")).toBe(1);
    expect(scrimAlpha(260, "reading")).toBeLessThan(0.02);
  });

  it("a custom colour: the same", () => {
    const o = overlayTint(bgOverlayOf("#402010"));
    expect(o.paint).toBe(true);
    expect(o.tint).toBe("#402010");
  });

  it("no colour: the overlay is genuinely absent", () => {
    const o = overlayTint(bgOverlayOf(BG_NO_OVERLAY));
    expect(o.paint).toBe(false);
    expect(o.tint).toBeNull();
    // and the layer is dropped, not faded — unchanged by this work
    expect(CSS).toContain(':root[data-bg-reading="on"] .reader-desk[data-overlay="off"]::after { content: none; }');
  });

  it("and presence is then disabled, in BOTH places, from the same function", () => {
    const ed = codeOf(EDITOR_SRC);
    expect(ed).toContain('const overlayOff = reading && bgOverlayOf(draft.data.bg.reading.overlay).kind === "none";');
    expect(ed).toContain("disabled={overlayOff}");
    const rs = codeOf(RS);
    expect(rs).toContain('const overlayOff = useReader((st) => bgOverlayOf(st.style?.backgroundColor).kind === "none");');
    expect(rs).toContain("disabled={overlayOff}");
  });

  it("it is disabled rather than hidden, and says why", () => {
    // A control that vanishes teaches a reader their value was thrown away.
    expect(EDITOR_SRC).toContain('{overlayOff && <div className="pf-hint">{t("gs.bg.presenceNoOverlay")}</div>}');
    expect(ar["gs.bg.presenceNoOverlay"]).toBeTruthy();
    expect(en["gs.bg.presenceNoOverlay"]).toBeTruthy();
    expect(CSS).toContain(".gs-slider:disabled");
  });

  it("the LIBRARY's presence is never disabled — it has no overlay", () => {
    const ed = codeOf(EDITOR_SRC);
    // the guard is gated on `reading`, so the library surface can never reach it
    expect(ed).toContain("const overlayOff = reading &&");
  });

  it("turning the overlay off does not touch the stored presence", () => {
    const d = parseProfileData(JSON.stringify({
      bg: { reading: { overlay: null, params: { presence: 173 } } },
    }));
    expect(d.bg.reading.params.presence).toBe(173);
    const off = parseProfileData(JSON.stringify({
      bg: { reading: { overlay: BG_NO_OVERLAY, params: { presence: 173 } } },
    }));
    // the value survives the state it is inapplicable in, so choosing a colour again restores it
    expect(off.bg.reading.params.presence).toBe(173);
    expect(off.bg.reading.overlay).toBe(BG_NO_OVERLAY);
  });

  it("and changing presence does not touch the stored overlay", () => {
    const d = parseProfileData(JSON.stringify({
      bg: { reading: { overlay: "#402010", params: { presence: 40 } } },
    }));
    expect(d.bg.reading.overlay).toBe("#402010");
    const moved = parseProfileData(JSON.stringify({
      bg: { reading: { overlay: "#402010", params: { presence: 210 } } },
    }));
    expect(moved.bg.reading.overlay).toBe("#402010");
    expect(moved.bg.reading.params.presence).toBe(210);
  });

  it("coming back from no-colour re-enables it at the value it had", () => {
    // The round trip a reader actually makes: a colour, then none, then a colour again.
    const withColour = parseProfileData(JSON.stringify({
      bg: { reading: { overlay: "#123456", params: { presence: 88 } } },
    }));
    const none = { ...withColour, bg: { ...withColour.bg,
      reading: { ...withColour.bg.reading, overlay: BG_NO_OVERLAY } } };
    const back = { ...none, bg: { ...none.bg,
      reading: { ...none.bg.reading, overlay: "#123456" } } };
    expect(overlayTint(bgOverlayOf(none.bg.reading.overlay)).paint).toBe(false);
    expect(overlayTint(bgOverlayOf(back.bg.reading.overlay)).paint).toBe(true);
    expect(back.bg.reading.params.presence).toBe(88);
    // the presence value was never rewritten by either transition
    expect(none.bg.reading.params.presence).toBe(88);
  });
});
