// "AROUND THE PAGE" — how much of the reading sheet shows behind a PDF page.
//
// The area around a PDF page is `.page-sheet`, the EPUB paper (colour, edge shadow, grain), which a PDF
// inherits. The setting changes that layer's PAINT and nothing else: the 18px page gap is structural
// (the fit arithmetic and the separation between pages depend on it) and is left alone. Measured in the
// running application: page frames, rendered bitmap sizes, scroll extent and position are identical in
// all three states, in both renderers, at four zooms.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDF_SURROUND_DEFAULT, PDF_SURROUND_KEY, isPdfSurround, parsePdfSurround } from "../../src/reader-engine/pdfView";
import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";

const root = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(root, "src/styles/global.css"), "utf8");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const reader = readFileSync(join(root, "src/features/reader/Reader.tsx"), "utf8");
const panel = readFileSync(join(root, "src/features/reader/SettingsPanel.tsx"), "utf8");
const scroll = readFileSync(join(root, "public/foliate-js/fixed-layout-scroll.js"), "utf8");

/** Every rule whose selector names the setting — the frame's own rules (pdfFrame.test.ts) aside. */
const surroundRules = [...rules.matchAll(/([^{}]*data-pdf-surround[^{}]*)\{([^}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), body: m[2] }))
  .filter((r) => !r.sel.includes("data-pdf-frame"));

describe("the stored value", () => {
  it("defaults to Normal, so an absent or unknown row changes nothing", () => {
    expect(PDF_SURROUND_DEFAULT).toBe("normal");
    expect(parsePdfSurround(null)).toBe("normal");
    expect(parsePdfSurround("")).toBe("normal");
    expect(parsePdfSurround("bogus")).toBe("normal");
    for (const v of ["normal", "reduced", "none"]) expect(parsePdfSurround(v)).toBe(v);
    expect(isPdfSurround("none")).toBe(true);
  });

  it("is one global key, like the PDF appearance", () => {
    expect(PDF_SURROUND_KEY).toBe("pdf_surround");
    expect(reader).toContain("settingsGet(PDF_SURROUND_KEY)");
    expect(reader).toContain("settingsSet(PDF_SURROUND_KEY, v)");
    expect(reader).toContain("setPdfSurround(parsePdfSurround(pdfSurroundRaw))");
  });
});

describe("it only ever changes paint", () => {
  it("there are rules for Reduced and None, and none for Normal", () => {
    expect(surroundRules.some((r) => r.sel.includes('"reduced"'))).toBe(true);
    expect(surroundRules.some((r) => r.sel.includes('"none"'))).toBe(true);
    expect(surroundRules.some((r) => r.sel.includes('"normal"'))).toBe(false);
  });

  it("every rule is scoped to a PDF desk, so an EPUB can never match", () => {
    for (const r of surroundRules) expect(r.sel).toContain(".reader-desk.pdf-view[data-pdf-surround=");
  });

  it("touches only the sheet and its grain — never the host, the renderer or the page", () => {
    for (const r of surroundRules) expect(r.sel).toMatch(/\.page-(sheet|grain)$/);
  });

  it("sets no property that could size, place, clip or transform anything", () => {
    for (const r of surroundRules) {
      const props = r.body.split(";").map((d) => d.split(":")[0].trim()).filter(Boolean);
      for (const p of props) expect(["background", "box-shadow", "display"], `${r.sel} sets ${p}`).toContain(p);
      // `display: none` is allowed only on the grain, an absolutely positioned overlay with no layout role.
      if (props.includes("display")) expect(r.sel).toMatch(/\.page-grain$/);
    }
  });

  it("Reduced scales the paper's own strength, so a translucent sheet stays proportionally lighter", () => {
    const reduced = surroundRules.find((r) => r.sel.includes('"reduced"') && r.sel.endsWith(".page-sheet"))!;
    expect(reduced.body).toContain("calc(var(--bg-page-opacity, 100%) * 0.4)");
    expect(reduced.body).toContain("box-shadow: none");
  });

  it("outranks the wallpaper variants of the sheet's shadow (0,5,0), which sit later in the file", () => {
    for (const r of surroundRules) expect(r.sel.startsWith(":root .reader-root .reader-desk.pdf-view")).toBe(true);
  });

  it("the page gap is untouched structural spacing", () => {
    expect(scroll).toContain("const PAGE_GAP = 18");
    expect(rules).toContain('.reader-desk.pdf-view[data-pdf-mode="pages"] .page-host foliate-view { box-sizing: border-box; padding: 18px; }');
  });
});

describe("the desk and the panel", () => {
  it("the attribute is absent for Normal and for every EPUB", () => {
    expect(reader).toContain('data-pdf-surround={isPdf && pdfSurround !== "normal" ? pdfSurround : undefined}');
  });

  it("the panel offers the three states on the shared segmented control, with a hint", () => {
    const at = panel.indexOf('<Section label={t("pdf.surround")}>');
    expect(at).toBeGreaterThan(0);
    const sec = panel.slice(at, panel.indexOf("</Section>", at));
    expect(sec).toContain("<Segmented<PdfSurround>");
    for (const k of ["normal", "reduced", "none"]) expect(sec).toContain(`{ key: "${k}", label: t("pdf.surround.${k}") }`);
    expect(sec).toContain('t("pdf.surround.hint")');
  });

  it("both languages name it as the space AROUND the page", () => {
    for (const k of ["pdf.surround", "pdf.surround.normal", "pdf.surround.reduced", "pdf.surround.none", "pdf.surround.hint"] as const) {
      expect((ar as Record<string, string>)[k], k).toBeTruthy();
      expect((en as Record<string, string>)[k], k).toBeTruthy();
    }
    expect(en["pdf.surround" as keyof typeof en]).toBe("Around the page");
    expect(ar["pdf.surround" as keyof typeof ar]).toBe("ما حول الصفحة");
  });
});
