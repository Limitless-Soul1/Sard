// THE PDF SETTINGS PANEL AND THE ZOOM READOUT — the defects the redesign closed, pinned.
//
// Each was MEASURED in the running application before it was changed:
//
//   · the zoom buttons were styled with `--surface-2`, `--surface-3`, `--line` and `--ink`, none of
//     which is defined anywhere, so they rendered with no border and no background — loose words;
//   · the panel resolved LTR inside the reading root's forced LTR, so in Arabic every label sat on the
//     wrong side and every hint printed its full stop at its START;
//   · `pdfRenderedScale()` returned 1.000 at every zoom (true scales 1.38, 2.23, 2.00), so stepping out
//     of a fit mode restarted from 100% and "+" at fit width made the page SMALLER.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const panel = read("src/features/reader/SettingsPanel.tsx");
const settings = read("src/features/reader/ReadingSettings.tsx");
const css = read("src/styles/global.css");
const controller = read("src/reader-engine/FoliateController.ts");
const ar = read("src/i18n/locales/ar.ts");
const en = read("src/i18n/locales/en.ts");
const pdfBranch = panel.slice(panel.indexOf("if (isPdf) {"), panel.indexOf("// ---- EPUB") > 0 ? panel.indexOf("// ---- EPUB") : undefined);
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("one control language", () => {
  it("the PDF panel is built from the reading settings' own Section and Segmented", () => {
    expect(settings).toContain("export function Section(");
    expect(settings).toContain("export function Segmented<");
    expect(panel).toMatch(/import \{ ReadingSettings, Section, Segmented, Slider \} from "\.\/ReadingSettings";/);
    expect(pdfBranch).toContain("<Section label={t(\"pdf.mode\")}>");
    expect(pdfBranch).toContain("<Segmented<PdfViewMode>");
    expect(pdfBranch).toContain("<Segmented<PdfZoom>");
  });

  it("the segmented control states its choice to assistive technology", () => {
    expect(settings).toContain("aria-pressed={value === o.key}");
  });

  it("no PDF control is styled with a token Sard never defines", () => {
    for (const dead of ["--surface-2", "--surface-3", "var(--line)", "var(--ink)"]) {
      expect(rules, `${dead} is not a Sard token`).not.toContain(dead);
    }
  });

  it("zoom between the fits is Sard's own slider, with drawn caps rather than typed ones", () => {
    expect(settings).toContain("export function Slider(");
    expect(pdfBranch).toContain("<Slider");
    expect(pdfBranch).toContain("lead={<Icon name=\"minus\" size=\"sm\" />}");
    expect(pdfBranch).toContain("trail={<Icon name=\"plus\" size=\"sm\" />}");
    expect(pdfBranch).not.toMatch(/>\s*[−+]\s*</);
  });

  it("keeps the stable hooks the fit controls are found by, in the same order", () => {
    // Asserted on the panel alone: a unit test must pass on a clean checkout, which carries no
    // behavioural harness, so this pins the hook itself rather than any script that uses it.
    expect(pdfBranch).toContain('className: "pdf-zoom-fit"');
    // fit width, then whole page — the harness reads the second with `:last-of-type`
    expect(pdfBranch.indexOf('key: "fit-width"')).toBeLessThan(pdfBranch.indexOf('key: "fit-page"'));
  });
});

describe("the panel reads in the interface's direction", () => {
  it("the PDF panel carries the UI direction, overriding the reading root's forced LTR", () => {
    expect(panel).toContain("const { t, dir: uiDir } = useI18n();");
    expect(pdfBranch).toContain("dir={uiDir}");
  });

  it("only the PDF panel — the EPUB drawer is left to its own work", () => {
    const epubAside = panel.slice(panel.lastIndexOf("<aside"));
    expect(epubAside.slice(0, epubAside.indexOf(">"))).not.toContain("dir={uiDir}");
  });
});

describe("the hierarchy", () => {
  it("how the document moves, then zoom, then appearance, then the limitation", () => {
    const at = (s: string) => pdfBranch.indexOf(s);
    expect(at('label={t("pdf.mode")}')).toBeLessThan(at('label={t("pdf.zoom")}'));
    expect(at('label={t("pdf.zoom")}')).toBeLessThan(at('t("pdf.appearance")'));
    expect(at('t("pdf.appearance")')).toBeLessThan(at("sp-pdf-foot"));
  });

  it("the mode hint describes only the active mode", () => {
    expect(pdfBranch).toContain('"pdf.mode.pagesHint" : "pdf.mode.scrollHint"');
    for (const loc of [ar, en]) {
      expect(loc).toContain('"pdf.mode.scrollHint":');
      expect(loc).toContain('"pdf.mode.pagesHint":');
      expect(loc).not.toContain('"pdf.mode.hint":');
    }
  });

  it("uses the same section label the EPUB uses for the same choice", () => {
    const label = (loc: string, key: string) => loc.match(new RegExp(`"${key.replace(".", "\\.")}": "([^"]+)"`))?.[1];
    expect(label(ar, "pdf.mode")).toBe(label(ar, "mode.label"));
    expect(label(en, "pdf.mode")).toBe(label(en, "mode.label"));
  });

  it("the readout is the scale actually on screen, and the thumb sits where that scale is", () => {
    expect(pdfBranch).toContain("value={`${Math.round((pdfScale ?? 1) * 100)}%`}");
    expect(pdfBranch).toContain("value={zoomToSlider(pdfScale ?? 1)}");
  });
});

describe("the zoom readout is the scale on screen", () => {
  const body = controller.slice(controller.indexOf("  pdfRenderedScale(): number {"), controller.indexOf("  pdfRenderedScale(): number {") + 2200);

  it("is the frame's on-screen width over the page's own intrinsic width", () => {
    expect(body).toContain('querySelector(\'meta[name="viewport"]\')');
    expect(body).toContain("frame.getBoundingClientRect().width");
    expect(body).toContain("shown / intrinsic");
  });

  it("no longer divides an image by itself", () => {
    // pdf.js re-renders at the zoom scale, so an img's CSS and natural sizes grow together and their
    // ratio is always 1 — the measured defect.
    expect(body).not.toContain("naturalWidth");
  });
});

describe("the zoom slider's scale", async () => {
  const { zoomToSlider, sliderToZoom, PDF_ZOOM_MIN, PDF_ZOOM_MAX } = await import("../../src/reader-engine/pdfView");

  it("is logarithmic: equal travel is an equal proportional change", () => {
    // 100→200% and 200→400% are the same distance along the track — one doubling each.
    expect(zoomToSlider(2) - zoomToSlider(1)).toBe(zoomToSlider(4) - zoomToSlider(2));
  });

  it("covers exactly the zoom range, and round-trips", () => {
    expect(sliderToZoom(zoomToSlider(PDF_ZOOM_MIN))).toBeCloseTo(PDF_ZOOM_MIN, 2);
    expect(sliderToZoom(zoomToSlider(PDF_ZOOM_MAX))).toBeCloseTo(PDF_ZOOM_MAX, 1);
    for (const z of [0.67, 1, 1.38, 2.23, 3]) expect(sliderToZoom(zoomToSlider(z))).toBeCloseTo(z, 1);
  });

  it("never produces a scale outside the range, whatever the input", () => {
    expect(sliderToZoom(-9999)).toBe(PDF_ZOOM_MIN);
    expect(sliderToZoom(9999)).toBe(PDF_ZOOM_MAX);
  });

  it("the drag is coalesced to one re-render per frame, like the wheel", () => {
    const reader = read("src/features/reader/Reader.tsx");
    const fn = reader.slice(reader.indexOf("const pdfZoomTo = useCallback"), reader.indexOf("const pdfZoomByWheel = useCallback"));
    expect(fn).toContain("requestAnimationFrame");
    expect(fn).toContain("if (pdfZoomRaf.current !== undefined) return;");
  });
});
