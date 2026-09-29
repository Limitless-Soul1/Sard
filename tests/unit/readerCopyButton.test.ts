// COPY IN THE SELECTION TOOLBAR — take the passage, and leave everything else exactly as it was.
//
// ## Where this lives, and why that is the interesting part
//
// The toolbar that rises over a selection is the row that offers to do things WITH that passage:
// listen to it, note it, cite it, replace it, put it on a card. Copy belongs there and was there
// once — RAWY-124 named it third of five — before it was taken out on the reasoning that the row was
// full and Ctrl+C still worked. It is back at the owner's decision, in its original place.
//
// ## Why these are written against the source
//
// The act is irreducibly DOM and clipboard, and a jsdom stand-in would prove only that the stand-in
// behaves. So the SHAPE is pinned against the source, the way the in-book search walk is, and the
// strings are read as real values from the real locale modules.
//
// ## What is worth protecting
//
// 1. It copies the passage the ROW is acting on — `selection.text`, the same text every sibling uses.
// 2. It confirms only a copy that really happened; a refused clipboard claims nothing.
// 3. It is the one action here that does NOT dismiss the row or clear the selection.
// 4. Adding it dropped none of the actions that were already there.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "../../src/i18n/locales/en";
import { ar } from "../../src/i18n/locales/ar";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const layer = read("src/features/reader/AnnotationLayer.tsx");
const css = read("src/styles/global.css");
/** Source with comment lines stripped — the prose deliberately names the history and the cases. */
const code = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
const src = code(layer);

/** The handler that does the copying, bounded at the end of its own declaration. */
const handler = (() => {
  const from = src.indexOf("const onCopySel = async");
  return src.slice(from, src.indexOf("const onReplace", from));
})();
/** The action row itself. */
const row = (() => {
  const from = src.indexOf('<div className="hl-pop-actions">');
  return src.slice(from, src.indexOf("</div>", from));
})();

describe("copying the selected passage", () => {
  it("takes the text the row is acting on, not a fresh reading of the DOM", () => {
    expect(handler).toContain("const text = selection?.text.trim()");
    // Every sibling action works from `selection.text`; copying must not disagree with them about
    // what the passage is.
    expect(src).toContain("const phrase = s.text.trim();"); // Replace, for comparison
  });

  it("writes it to the system clipboard", () => {
    expect(handler).toContain("const cb = navigator.clipboard;");
    expect(handler).toContain("await cb.writeText(text);");
  });

  it("answers whether the write actually happened", () => {
    expect(src).toContain("const onCopySel = async (): Promise<boolean>");
    expect(handler).toContain("return true;");
    // Nothing to copy, or no clipboard at all: false, and nothing written.
    expect(handler).toContain("if (!text || !cb) return false;");
    // A clipboard can refuse on focus or permissions.
    expect(handler).toContain("} catch {");
    expect(handler).toContain("return false;");
  });

  it("the row confirms only a real copy", () => {
    expect(src).toContain("void onCopy().then((ok) => {");
    expect(src).toContain("if (!ok) return;");
    // The tick is set after that guard, never before it.
    expect(src.indexOf("if (!ok) return;")).toBeLessThan(src.indexOf("setCopied(true)"));
  });
});

describe("it leaves the reader exactly as it found them", () => {
  it("does not dismiss the toolbar or clear the selection, unlike every sibling action", () => {
    // Note, Replace, Add-to-card and Create-card all take the reader somewhere, so each of them ends
    // the selection. Copying goes nowhere, so the passage stays selected and can still be highlighted.
    expect(handler).not.toContain("setSelection(null)");
    expect(handler).not.toContain("clearSel()");
    // The siblings really do — so this is a difference, not an oversight.
    const replace = src.slice(src.indexOf("const onReplace"), src.indexOf("const onReplace") + 400);
    expect(replace).toContain("setSelection(null)");
    expect(replace).toContain("clearSel()");
  });

  it("touches no other reader state", () => {
    for (const forbidden of [
      "createHighlight", "addAnnotation", "store()", "setActive", "setRepDialog", "onPhotoCard",
      "progressSave", "goToLocator", "goToSection", "searchBook", "startListen", "setBasket",
    ]) {
      expect(handler, `the copy handler must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("its confirmation is bounded in time and cleaned up", () => {
    expect(src).toContain("copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);");
    expect(src).toContain("return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); };");
  });

  it("the confirmation belongs to ONE passage, so a new selection never inherits it", () => {
    // Keyed on the same `key` the placement uses (cfi + text), which also means the constant
    // re-renders a scroll causes cannot cut the confirmation short.
    expect(src).toContain("const key = sel.cfi + \"\\u0000\" + sel.text;");
    const effect = src.slice(src.indexOf("useEffect(() => {\n    setCopied(false);"), src.indexOf("const pressCopy"));
    expect(effect).toContain("}, [key]);");
  });
});

describe("the control in the row", () => {
  it("is built from the row's own parts", () => {
    expect(row).toContain('<button className="hl-pop-act" onClick={pressCopy}');
    expect(row).toContain("{copied ? <CopiedIcon /> : <CopyIcon />}");
    expect(row).toContain('{copied ? t("reader.copied") : t("reader.copy")}');
  });

  it("stands third, after Note — the place RAWY-124 gave it", () => {
    const order = [...row.matchAll(/onClick=\{(on[A-Za-z]+|pressCopy)\}/g)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(["onListen", "onNote", "pressCopy"]);
  });

  it("adding it dropped none of the actions that were already there", () => {
    // RAWY-124's standing warning: never lose one of these silently.
    for (const act of ["onListen", "onNote", "onReference", "onReplace", "onAddToCard", "onPhotoCard"]) {
      expect(row, `${act} must still be in the row`).toContain(`onClick={${act}}`);
    }
    expect(order(row)).toHaveLength(7);
  });

  it("its mark is drawn at this row's size and weight, not borrowed from the chrome's icon set", () => {
    const icon = src.slice(src.indexOf("const CopyIcon"), src.indexOf("const CopiedIcon"));
    expect(icon).toContain('width="16" height="16"');
    expect(icon).toContain('strokeWidth="1.7"');
    // The row's other marks agree.
    expect(src).toContain("const ReplaceIcon = () => (");
  });

  it("the mark is symmetric, so nothing has to mirror it between RTL and LTR", () => {
    const icon = src.slice(src.indexOf("const CopyIcon"), src.indexOf("const CopiedIcon"));
    expect(icon).not.toMatch(/rtl|dir\s*===/);
    // The row itself already mirrors as a row; the button adds no direction logic of its own.
    const btn = row.slice(row.indexOf("onClick={pressCopy}") - 120, row.indexOf("onClick={pressCopy}") + 260);
    expect(btn).not.toMatch(/rtl|dir\s*===/);
  });

  it("announces the copy once, in a region that takes no space", () => {
    expect(row).toContain('<span className="sr-live" role="status" aria-live="polite">{copied ? t("reader.copied") : ""}</span>');
    expect(css).toContain(".sr-live {");
    const live = css.slice(css.indexOf(".sr-live {"), css.indexOf(".sr-live {") + 260);
    expect(live).toContain("clip-path: inset(50%)");
    expect(live).not.toContain("display: none");
  });

  it("names what it acts on, for anyone reading it by label alone", () => {
    expect(row).toContain('aria-label={copied ? t("reader.copied") : t("reader.copyAria")}');
  });
});

describe("its words, in both languages", () => {
  it("English names the action, what it acts on, and what it did", () => {
    expect(en["reader.copy"]).toBe("Copy");
    expect(en["reader.copyAria"]).toBe("Copy the selected text");
    expect(en["reader.copied"]).toBe("Copied");
  });

  it("Arabic says the same three things, in Arabic", () => {
    for (const key of ["reader.copy", "reader.copyAria", "reader.copied"] as const) {
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], key).toMatch(/[\u0600-\u06FF]/);
      expect(ar[key], key).not.toBe(en[key]);
    }
  });

  it("the label is short enough to sit in a row of seven", () => {
    // The row is already full; a long label is what would break its layout rather than the button.
    expect(en["reader.copy"].length).toBeLessThanOrEqual(8);
    expect(ar["reader.copy"].length).toBeLessThanOrEqual(8);
  });
});

/** The actions in the row, in source order. */
function order(rowSrc: string): string[] {
  return [...rowSrc.matchAll(/onClick=\{(on[A-Za-z]+|pressCopy)\}/g)].map((m) => m[1]);
}
