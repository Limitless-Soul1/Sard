// SARD RENDERING DIAGNOSTIC — a stage ledger for the EPUB rendering pipeline, plus a forensic
// autopsy of a black/blank page. OBSERVATION ONLY: nothing here changes what the reader does.
//
// THE PROBLEM THIS EXISTS FOR. A tester reports that a book opens and the page is completely black:
// no text, and changing the theme does nothing. "The page is black" is an observation, not a cause.
// A black page can be produced by at least eight different failures, and they need opposite fixes:
//
//   the section document never arrived          → nothing to paint
//   the document arrived but has no <body>      → an XML parse failure (measured on one book already:
//                                                 a missing xmlns makes doc.body null)
//   the body is there but carries no text       → an empty or broken section
//   the text is there but lays out to zero area → a layout/column failure
//   the text is laid out but display/visibility/opacity hides it
//   the text is visible but its colour equals its background → BLACK ON BLACK
//   the text is visible but something opaque is painted on top of it
//   everything in the document is fine          → the blackness is outside the document (host layer)
//
// Only the sixth and seventh survive "changing the theme has no effect" in an obvious way, but that
// is a hypothesis and this module exists to replace hypotheses with measurements. So it records the
// pipeline stage by stage, and then — at the moment the tester presses Ctrl+Shift+D, with the black
// page still on screen — walks the live DOM and measures every one of those conditions.
//
// The verdict it prints is derived ONLY from those measurements, is ordered so the earliest failure
// wins, and says UNKNOWN when the evidence does not settle the question. It never guesses.
import { diagNote } from "./diag";
import { errShape, makeLedger, type Stage } from "./stageLedger";

/** Declared up front: a stage that never runs must still appear, marked NOT ENTERED. */
const STAGE_DEFS = [
  ["open.requested", "Book open requested (reader asked to open a target)"],
  ["book.opened", "Book opened by the engine (container/OPF parsed)"],
  ["nav.loaded", "Navigation loaded (TOC / spine available)"],
  ["section.resolved", "Section resolved (spine index chosen for display)"],
  ["html.loaded", "Section HTML loaded (document delivered to the renderer)"],
  ["html.parsed", "Section HTML parsed (document has a <body>)"],
  ["frame.created", "iframe / section document created and reachable"],
  ["css.discovered", "Book CSS discovered (the section's own stylesheets)"],
  ["css.injected", "Sard CSS injected (typography sheet + font sheet)"],
  ["theme.applied", "Theme styles applied (paint sheet written into the document)"],
  ["dom.attached", "DOM attached to a laid-out frame (host has a real box)"],
  ["layout.done", "Layout completed (body reports non-zero content size)"],
  ["text.visible", "First VISIBLE text node detected (measured, not assumed)"],
  ["paint.done", "First paint completed (two animation frames after attach)"],
] as const;

const ledger = makeLedger(STAGE_DEFS, (tier, msg, data) => diagNote("render.stage", tier, msg, data));

export const renderStageEnter = (key: string, meta: Record<string, unknown> = {}): void => ledger.enter(key, meta);
export const renderStageOk = (key: string, meta: Record<string, unknown> = {}): void => ledger.ok(key, meta);
export const renderStageFail = (key: string, e: unknown, meta: Record<string, unknown> = {}): void => ledger.fail(key, e, meta);
export const renderStageUnobservable = (key: string, reason: string, meta: Record<string, unknown> = {}): void =>
  ledger.unobservable(key, reason, meta);
export const renderStages = (): Stage[] => ledger.stages();
export const renderStagesText = (): string => ledger.render("EPUB RENDERING PIPELINE — STAGE LEDGER");

// The controller hands us the live surface so the autopsy can find the document at export time,
// however long after the failure that is. A WeakRef would be tidier but the container outlives the
// report either way, and a plain reference cannot fail to resolve at the moment we need it most.
let surface: HTMLElement | null = null;
let lastDoc: Document | null = null;
let themeChanges: { t: number; themeId: string; mode: string; sheetLen: number; colours: string }[] = [];
let resourceErrors: { t: number; kind: string; url: string; where: string }[] = [];
let t0 = Date.now();

export function renderDiagReset(): void {
  ledger.reset();
  lastDoc = null;
  themeChanges = [];
  resourceErrors = [];
  t0 = Date.now();
}

export function renderDiagSurface(el: HTMLElement | null): void {
  surface = el;
}

/**
 * A PDF does not travel this pipeline at all. Without this, every PDF report would show twelve
 * EPUB stages as NOT ENTERED and read like a catastrophic failure — the same cry-wolf mistake that
 * made an earlier build report a rendered PDF page as a failed stage. Say "does not apply" instead.
 */
export function renderDiagNotEpub(reason: string): void {
  for (const [key] of STAGE_DEFS.slice(1)) ledger.unobservable(key, reason);
}

/**
 * Record a theme application. "Changing the theme has no effect" is one of the reported symptoms, so
 * the report must be able to show whether the theme actually reached the document: the sheet that was
 * written, its length, and the colour declarations inside it. If those change and the page stays
 * black, the theme is not the thing that is broken.
 */
export function renderDiagTheme(themeId: string, mode: string, sheetText: string): void {
  const colours = (sheetText.match(/(?:^|[;{\s])(?:color|background(?:-color)?)\s*:\s*[^;}]+/gi) ?? [])
    .slice(0, 6).map((s) => s.trim().replace(/\s+/g, " ")).join(" | ");
  // Bounded: the recording runs from launch to export, and a reader who plays with the theme panel
  // can apply hundreds of these. Keep the EARLIEST, because the first application is the one that
  // decides what the page looks like when it is opened.
  if (themeChanges.length < 300) themeChanges.push({ t: Date.now() - t0, themeId, mode, sheetLen: sheetText.length, colours });
  ledger.note("theme.applied", { lastThemeId: themeId, lastMode: mode, sheetLen: sheetText.length });
  diagNote("render.theme", "MEASURED", `theme applied — ${themeId} / ${mode}`, { sheetLen: sheetText.length, colours });
}

/**
 * Watch one section document: resource failures inside it (a stylesheet, image or font that never
 * loaded is a first-class suspect for a black page) and the parse-level facts.
 */
export function renderDiagAdoptDoc(doc: Document | undefined, index: number, href?: string): void {
  if (!doc) {
    ledger.fail("html.loaded", new Error("the renderer delivered no document for this section"), { index });
    return;
  }
  lastDoc = doc;
  ledger.ok("section.resolved", { index, href: href ?? "(unknown)" });
  ledger.ok("html.loaded", { index, readyState: doc.readyState, contentType: doc.contentType ?? "(none)" });

  // A missing <body> is not a curiosity — it is exactly what an XHTML parse failure produces, and it
  // has already been measured once on a real book (a missing xmlns). Distinguish it from an empty one.
  const parseError = doc.querySelector("parsererror");
  if (!doc.body) {
    ledger.fail("html.parsed", new Error("the parsed document has NO <body> element"), {
      index,
      hasDocumentElement: !!doc.documentElement,
      rootTag: doc.documentElement?.tagName ?? "(none)",
      parserErrorPresent: !!parseError,
      parserErrorText: parseError?.textContent?.slice(0, 300) ?? "(none)",
      note: "an XHTML parse failure (for example a missing xmlns) produces exactly this",
    });
  } else {
    ledger.ok("html.parsed", {
      index,
      elements: doc.body.getElementsByTagName("*").length,
      textLength: (doc.body.textContent ?? "").trim().length,
      parserErrorPresent: !!parseError,
    });
  }

  const frame = doc.defaultView?.frameElement as HTMLElement | null;
  if (frame) {
    const r = frame.getBoundingClientRect();
    ledger.ok("frame.created", { index, frameTag: frame.tagName, frameW: Math.round(r.width), frameH: Math.round(r.height) });
    // The frame's BOX is deliberately NOT judged here. At `load` the frame has usually not been laid
    // out yet, and a section the engine has preloaded but not displayed is legitimately zero-area —
    // measured: this check reported "stage 11 FAILED" on a machine where the book rendered perfectly.
    // It is re-measured after two animation frames below, where the number means something.
  } else {
    ledger.unobservable("frame.created", "the document reports no frameElement (same-realm access blocked or not framed)", { index });
  }

  const links = [...doc.querySelectorAll("link[rel~='stylesheet']")].map((l) => (l as HTMLLinkElement).getAttribute("href") ?? "");
  const styles = doc.querySelectorAll("style").length;
  ledger.ok("css.discovered", { index, bookStylesheets: links.length, inlineStyleTags: styles, hrefs: links.slice(0, 8) });

  // Capture-phase, because resource errors do not bubble. This is the only way to see a stylesheet or
  // font that failed to load inside the section document.
  doc.addEventListener(
    "error",
    (ev: Event) => {
      const el = ev.target as HTMLElement | null;
      if (!el || !el.tagName) return;
      const url = (el as HTMLImageElement).src || (el as HTMLLinkElement).href || "(none)";
      if (resourceErrors.length < 500) resourceErrors.push({ t: Date.now() - t0, kind: el.tagName.toLowerCase(), url: String(url).slice(0, 200), where: `section ${index}` });
      diagNote("render.resource", "MEASURED", `RESOURCE FAILED to load: <${el.tagName.toLowerCase()}>`, { url: String(url).slice(0, 200), section: index });
    },
    true,
  );

  // Layout and paint are only meaningful after the engine has had its frames.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      try {
        const b = doc.body;
        if (!b) return;
        // Now the frame box is worth reading. Zero area here is still not automatically a failure —
        // a preloaded, not-yet-displayed section is legitimately zero-sized — so it is reported as
        // NOT OBSERVABLE with the measurements attached, and the autopsy settles what is on screen.
        const fr = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
        if (fr && fr.width > 0 && fr.height > 0) {
          ledger.ok("dom.attached", { hostW: Math.round(fr.width), hostH: Math.round(fr.height) });
        } else if (fr) {
          ledger.unobservable("dom.attached", "the section frame still has a zero-area box two frames after load — this is normal for a section the engine has preloaded but is not displaying", { w: Math.round(fr.width), h: Math.round(fr.height) });
        } else {
          ledger.unobservable("dom.attached", "no frameElement is reachable from this document");
        }
        const w = b.scrollWidth, h = b.scrollHeight;
        if (w > 0 && h > 0) ledger.ok("layout.done", { scrollWidth: w, scrollHeight: h });
        else ledger.fail("layout.done", new Error("body reports a ZERO content size after two frames"), { scrollWidth: w, scrollHeight: h });
        ledger.ok("paint.done", { note: "two animation frames elapsed with the document attached" });
        const shot = inspectDocument(doc, index);
        if (shot.visibleTextSamples > 0) {
          ledger.ok("text.visible", { visibleSamples: shot.visibleTextSamples, firstText: shot.firstVisibleText });
        } else {
          ledger.fail("text.visible", new Error("NO text node was measured as visible in this section"), {
            textLength: shot.textLength,
            sampled: shot.sampled,
            reason: shot.dominantReason,
          });
        }
      } catch (e) {
        renderStageFail("paint.done", e, { note: "measuring layout/paint threw" });
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The autopsy
// ---------------------------------------------------------------------------------------------

interface Sample {
  tag: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  color: string;
  bg: string;
  effectiveBg: string;
  bgFrom: string;
  display: string;
  visibility: string;
  opacity: string;
  fontSize: string;
  clipPath: string;
  filter: string;
  mixBlendMode: string;
  transform: string;
  contrast: number | null;
  topmostAtCentre: string;
  covered: boolean;
  hiddenBy: string | null;
}

interface DocShot {
  ok: boolean;
  problem: string | null;
  index: number;
  url: string;
  readyState: string;
  contentType: string;
  hasBody: boolean;
  parserError: string | null;
  elements: number;
  textLength: number;
  htmlLength: number;
  bodyRect: { w: number; h: number } | null;
  htmlBg: string;
  bodyBg: string;
  sampled: number;
  visibleTextSamples: number;
  firstVisibleText: string | null;
  dominantReason: string;
  samples: Sample[];
  sheets: { href: string; rules: number | null; note: string }[];
  sardSheets: { attr: string; length: number; head: string }[];
}

const px = (v: string) => Number.parseFloat(v) || 0;

/** Parse a CSS colour into RGBA. Only the forms a computed style actually returns. */
function parseColour(c: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (!m) return c.trim() === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some(Number.isNaN)) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

const luminance = (c: { r: number; g: number; b: number }) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};

/** WCAG contrast ratio, 1 = identical, 21 = black on white. Below ~1.5 nothing is readable. */
function contrastRatio(fg: string, bg: string): number | null {
  const a = parseColour(fg), b = parseColour(bg);
  if (!a || !b) return null;
  // Composite the text colour over its background if it is itself translucent.
  const mix = a.a >= 1 ? a : { r: a.r * a.a + b.r * (1 - a.a), g: a.g * a.a + b.g * (1 - a.a), b: a.b * a.a + b.b * (1 - a.a) };
  const l1 = luminance(mix), l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Walk up until something actually paints a background, so "the background" is the REAL one. */
function effectiveBackground(el: Element, view: Window): { colour: string; from: string } {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 40) {
    const c = view.getComputedStyle(node).backgroundColor;
    const p = parseColour(c);
    if (p && p.a > 0.05) return { colour: c, from: `${node.tagName.toLowerCase()}${depth === 0 ? " (the element itself)" : ` (${depth} level(s) up)`}` };
    node = node.parentElement;
    depth++;
  }
  return { colour: "rgba(0, 0, 0, 0)", from: "nothing paints a background anywhere up the tree" };
}

/**
 * Measure one section document: does it contain text, is that text laid out, is it visible, and if it
 * is visible is anything painted over it. Every field is read from the live document — none of it is
 * inferred from our own settings.
 */
function inspectDocument(doc: Document, index: number): DocShot {
  const view = doc.defaultView;
  const shot: DocShot = {
    ok: false, problem: null, index,
    url: (doc.URL ?? "").slice(0, 200),
    readyState: doc.readyState,
    contentType: doc.contentType ?? "(none)",
    hasBody: !!doc.body,
    parserError: doc.querySelector("parsererror")?.textContent?.slice(0, 300) ?? null,
    elements: 0, textLength: 0, htmlLength: 0, bodyRect: null,
    htmlBg: "(unknown)", bodyBg: "(unknown)",
    sampled: 0, visibleTextSamples: 0, firstVisibleText: null,
    dominantReason: "not determined",
    samples: [], sheets: [], sardSheets: [],
  };
  if (!view) { shot.problem = "the document has no window (defaultView) — it is detached"; return shot; }
  if (!doc.body) { shot.problem = "the document has NO <body> element"; return shot; }

  const body = doc.body;
  shot.elements = body.getElementsByTagName("*").length;
  shot.textLength = (body.textContent ?? "").trim().length;
  shot.htmlLength = body.innerHTML.length;
  const br = body.getBoundingClientRect();
  shot.bodyRect = { w: Math.round(br.width), h: Math.round(br.height) };
  shot.htmlBg = view.getComputedStyle(doc.documentElement).backgroundColor;
  shot.bodyBg = view.getComputedStyle(body).backgroundColor;

  for (const s of [...doc.styleSheets]) {
    let rules: number | null = null;
    let note = "";
    try { rules = s.cssRules.length; } catch (e) { note = `rules unreadable: ${(e as Error).message}`; }
    shot.sheets.push({ href: (s.href ?? "(inline <style>)").slice(0, 160), rules, note });
  }
  for (const el of [...doc.querySelectorAll("style")]) {
    const attr = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-")).join(",");
    const text = el.textContent ?? "";
    shot.sardSheets.push({ attr: attr || "(no data- attribute)", length: text.length, head: text.slice(0, 160).replace(/\s+/g, " ") });
  }

  // Sample real text-bearing elements rather than the first N elements: a book's first elements are
  // often empty wrappers, and measuring those would describe nothing.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const els: Element[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) && els.length < 12) {
    const t = (n.textContent ?? "").trim();
    if (t.length < 2) continue;
    const p = n.parentElement;
    if (p && !els.includes(p)) els.push(p);
  }

  const reasons: string[] = [];
  for (const el of els) {
    const cs = view.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const eff = effectiveBackground(el, view);
    const contrast = contrastRatio(cs.color, eff.colour);
    const cx = r.left + r.width / 2, cy = r.top + Math.min(r.height / 2, 8);
    let topmost = "(not testable)";
    let covered = false;
    try {
      const hit = r.width > 0 && r.height > 0 ? doc.elementFromPoint(cx, cy) : null;
      if (hit) {
        topmost = hit.tagName.toLowerCase() + (hit.className && typeof hit.className === "string" ? `.${hit.className.split(/\s+/)[0]}` : "");
        covered = hit !== el && !el.contains(hit) && !hit.contains(el);
      }
    } catch { /* cross-realm or detached */ }

    let hiddenBy: string | null = null;
    if (cs.display === "none") hiddenBy = "display: none";
    else if (cs.visibility !== "visible") hiddenBy = `visibility: ${cs.visibility}`;
    else if (px(cs.opacity) < 0.05) hiddenBy = `opacity: ${cs.opacity}`;
    else if (r.width <= 0 || r.height <= 0) hiddenBy = "zero-area layout box";
    else if (px(cs.fontSize) <= 0) hiddenBy = `font-size: ${cs.fontSize}`;
    else if (contrast != null && contrast < 1.5) hiddenBy = `colour ≈ background (contrast ${contrast}:1)`;
    else if (covered) hiddenBy = `covered by <${topmost}>`;

    if (hiddenBy) reasons.push(hiddenBy);
    else {
      shot.visibleTextSamples++;
      shot.firstVisibleText ??= (el.textContent ?? "").trim().slice(0, 60);
    }

    shot.samples.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? "").trim().slice(0, 50),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      color: cs.color, bg: cs.backgroundColor, effectiveBg: eff.colour, bgFrom: eff.from,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, fontSize: cs.fontSize,
      clipPath: cs.clipPath, filter: cs.filter, mixBlendMode: cs.mixBlendMode, transform: cs.transform,
      contrast, topmostAtCentre: topmost, covered, hiddenBy,
    });
  }
  shot.sampled = els.length;
  // The reason that explains the most samples is the one worth naming first.
  const tally = new Map<string, number>();
  for (const r of reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  shot.dominantReason = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (els.length ? "no obstruction found" : "no text to sample");
  shot.ok = shot.visibleTextSamples > 0;
  return shot;
}

/** Every section document reachable right now: the renderer's, plus any same-origin iframe. */
function liveDocs(): { doc: Document; where: string }[] {
  const out: { doc: Document; where: string }[] = [];
  const seen = new Set<Document>();
  const add = (d: Document | null | undefined, where: string) => {
    if (d && !seen.has(d)) { seen.add(d); out.push({ doc: d, where }); }
  };
  try {
    const roots: ParentNode[] = [document];
    if (surface) roots.push(surface);
    for (const root of roots) {
      for (const f of [...root.querySelectorAll("iframe")]) {
        try { add((f as HTMLIFrameElement).contentDocument, `iframe in ${root === document ? "document" : "reader surface"}`); } catch { /* cross-origin */ }
      }
      const view = root.querySelector?.("foliate-view") as any;
      const contents = view?.renderer?.getContents?.() ?? [];
      for (const c of contents) add(c?.doc, "foliate renderer contents");
    }
  } catch { /* the autopsy must never throw */ }
  add(lastDoc, "the last section document handed to us at load");
  return out;
}

export interface BlackScreenReport {
  verdict: string;
  confidence: "MEASURED" | "DERIVED" | "UNKNOWN";
  hostBg: string;
  surfaceRect: { w: number; h: number } | null;
  topmostOverReadingArea: string;
  displayedDoc: string;
  overlays: { tag: string; cls: string; bg: string; opacity: string; z: string; rect: { w: number; h: number } }[];
  docs: DocShot[];
  resourceErrors: typeof resourceErrors;
  themeChanges: typeof themeChanges;
  error: string | null;
}

/**
 * Run the autopsy against whatever is on screen RIGHT NOW.
 *
 * Called at export time on purpose: the tester presses Ctrl+Shift+D while the black page is still in
 * front of them, so this measures the failure itself rather than a reconstruction of it.
 */
export function autopsy(): BlackScreenReport {
  const out: BlackScreenReport = {
    verdict: "UNKNOWN", confidence: "UNKNOWN", hostBg: "(unknown)", surfaceRect: null, topmostOverReadingArea: "(not measured)", displayedDoc: "(not determined)",
    overlays: [], docs: [], resourceErrors: [...resourceErrors], themeChanges: [...themeChanges], error: null,
  };
  try {
    const host = surface ?? document.querySelector<HTMLElement>(".page-host") ?? document.body;
    if (host) {
      const r = host.getBoundingClientRect();
      out.surfaceRect = { w: Math.round(r.width), h: Math.round(r.height) };
      out.hostBg = getComputedStyle(host).backgroundColor;
      // What is actually on top at the middle of the reading area? This single hit-test is worth more
      // than any amount of geometry: if the topmost element there is the view or its frame, nothing
      // is covering the text, whatever else the DOM contains.
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.topmostOverReadingArea = mid
        ? `${mid.tagName.toLowerCase()}${typeof mid.className === "string" && mid.className ? `.${mid.className.split(/\s+/)[0]}` : ""}`
        : "(nothing hit-tested)";

      // Anything painted OVER the reading area that is big and opaque is a candidate for hiding it.
      // Ancestors are not candidates: the reader's own background layers (.reader-root, .reader-desk)
      // are full-size and opaque by design and sit BEHIND their own children. An earlier version
      // listed both of them as "overlays covering the reading area" on a perfectly healthy page —
      // exactly the kind of false alarm that teaches a reader to ignore the report.
      for (const el of [...document.querySelectorAll<HTMLElement>("body *")]) {
        if (el === host || el.contains(host)) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "absolute") continue;
        const er = el.getBoundingClientRect();
        if (er.width < r.width * 0.6 || er.height < r.height * 0.6) continue;
        const bgc = parseColour(cs.backgroundColor);
        if (!bgc || bgc.a < 0.5) continue;
        if (px(cs.opacity) < 0.1 || cs.visibility !== "visible" || cs.display === "none") continue;
        out.overlays.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === "string" ? el.className.slice(0, 60) : "",
          bg: cs.backgroundColor, opacity: cs.opacity, z: cs.zIndex,
          rect: { w: Math.round(er.width), h: Math.round(er.height) },
        });
        if (out.overlays.length >= 6) break;
      }
    }

    const docRefs: Document[] = [];
    for (const { doc, where } of liveDocs()) {
      try {
        docRefs.push(doc);
        const shot = inspectDocument(doc, out.docs.length);
        shot.url = `${shot.url}  [${where}]`;
        out.docs.push(shot);
      } catch (e) {
        out.docs.push({ ...({} as DocShot), problem: `inspecting this document threw: ${(e as Error).message}`, ok: false, samples: [], sheets: [], sardSheets: [] });
      }
    }

    // WHICH document does the verdict describe? The one the reader can SEE.
    //
    // This used to be "the first healthy document, else the first one", and that is wrong in a way
    // that matters: the engine keeps preloaded sections loaded, so a perfectly healthy neighbour can
    // win the vote while the section actually on screen is the broken one. Measured — with a book
    // that keeps siblings loaded, a document damaged to black-on-black was reported as "text is
    // present and measured as visible" because an untouched sibling was found first.
    //
    // Choose by VISIBLE AREA inside the reading surface: the displayed section is the one whose frame
    // overlaps it most. If nothing overlaps (no frame geometry at all), fall back to the first.
    const hostRect = host?.getBoundingClientRect();
    const visibleArea = (shot: DocShot): number => {
      const doc = out.docs.indexOf(shot) >= 0 ? docRefs[out.docs.indexOf(shot)] : null;
      const fr = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
      if (!fr || !hostRect) return 0;
      const w = Math.max(0, Math.min(fr.right, hostRect.right) - Math.max(fr.left, hostRect.left));
      const h = Math.max(0, Math.min(fr.bottom, hostRect.bottom) - Math.max(fr.top, hostRect.top));
      return w * h;
    };
    const ranked = [...out.docs].sort((a, b) => visibleArea(b) - visibleArea(a));
    const d = visibleArea(ranked[0]) > 0 ? ranked[0] : out.docs[0];
    out.displayedDoc = d ? `#${d.index} (visible area ${Math.round(visibleArea(d))} px²of ${out.docs.length} document(s))` : "none";

    // ORDERED verdict: the earliest failure in the pipeline is the one that explains the screen.
    // Each branch names the measurement it rests on, so the reasoning can be checked, not trusted.
    if (out.docs.length === 0) {
      out.verdict = "NO SECTION DOCUMENT EXISTS — nothing was ever rendered into the reading area. The blackness is an empty surface, not hidden text.";
      out.confidence = "MEASURED";
    } else if (d && !d.hasBody) {
      out.verdict = `THE SECTION DOCUMENT HAS NO <body>. The HTML arrived but did not parse into a usable document${d.parserError ? ` (parser error: ${d.parserError.slice(0, 120)})` : ""}. There is nothing to paint, so the page shows the empty background. This is what a malformed XHTML section (for example a missing xmlns) produces.`;
      out.confidence = "MEASURED";
    } else if (d && d.textLength === 0) {
      out.verdict = `THE DOCUMENT IS EMPTY — body carries ${d.elements} element(s) and 0 characters of text. Nothing was hidden; there was nothing to show.`;
      out.confidence = "MEASURED";
    } else if (d && d.ok) {
      out.verdict = `TEXT IS PRESENT AND MEASURED AS VISIBLE (${d.visibleTextSamples} of ${d.sampled} sampled elements, first: "${d.firstVisibleText ?? ""}"). The section document is NOT the cause. If the screen is black, the cause is outside it${out.overlays.length ? ` — and ${out.overlays.length} large opaque overlay(s) were found covering the reading area (see below)` : ", and no covering overlay was found either, which leaves the host/compositing layer"}.`;
      out.confidence = out.overlays.length ? "MEASURED" : "DERIVED";
    } else if (d) {
      // The reason that explains the MOST samples, not the first one encountered. Measured: on a book
      // with Sard's "hide first line" active, the first sampled element is legitimately
      // `visibility: hidden`, so a first-match verdict announced "hidden by a computed style" for a
      // page whose other eleven samples were black-on-black. One deliberately hidden element must
      // never outvote the condition affecting the whole page.
      const worst = d.dominantReason;
      const c = d.samples.find((s) => s.contrast != null)?.contrast ?? null;
      if (/contrast/.test(worst)) {
        const s = d.samples.find((x) => /contrast/.test(x.hiddenBy ?? ""))!;
        out.verdict = `BLACK ON BLACK — the text is present, laid out and not hidden by any property, but its colour is indistinguishable from the background it sits on. Measured: text colour ${s.color} on background ${s.effectiveBg} (taken from ${s.bgFrom}), contrast ratio ${s.contrast}:1 where 1.0 means identical. The characters are being painted; they cannot be seen.`;
      } else if (/zero-area/.test(worst)) {
        out.verdict = `TEXT LAYS OUT TO NOTHING — the document contains ${d.textLength} characters, but the sampled text elements have zero-area boxes. The text exists in the DOM and was never given a size on screen, so a layout/column failure — not a colour problem — is what produced the blank page.`;
      } else if (/covered by/.test(worst)) {
        out.verdict = `THE TEXT IS COVERED — the text is present and styled visibly, but hit-testing at its own centre returns a different element: ${worst}. Something is painted on top of the content.`;
      } else {
        out.verdict = `THE TEXT IS HIDDEN BY A COMPUTED STYLE — ${worst}. The document contains ${d.textLength} characters of text; none of the sampled elements was measured as visible.`;
      }
      out.confidence = "MEASURED";
      if (c != null) out.verdict += ` (contrast of the first measurable sample: ${c}:1)`;
    }
  } catch (e) {
    out.error = `${errShape(e).name}: ${errShape(e).message}`;
    out.verdict = "UNKNOWN — the autopsy itself failed; see the error above. No conclusion is claimed.";
    out.confidence = "UNKNOWN";
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
export function renderBlackScreenText(a: BlackScreenReport): string {
  const L: string[] = [];
  const rule = (c: string) => L.push(c.repeat(78));
  rule("=");
  L.push("BLACK / BLANK PAGE — FORENSIC AUTOPSY");
  rule("=");
  L.push("");
  L.push("Measured against the LIVE screen at the moment the report was exported, so if the");
  L.push("page was black when these keys were pressed, this describes that exact state.");
  L.push("");
  L.push("WHY THE PAGE LOOKS THE WAY IT DOES");
  L.push(`  [${a.confidence}] ${a.verdict}`);
  if (a.error) L.push(`  autopsy error: ${a.error}`);
  L.push("");
  L.push("READING SURFACE");
  L.push(`  host background      ${a.hostBg}`);
  L.push(`  host size            ${a.surfaceRect ? `${a.surfaceRect.w} x ${a.surfaceRect.h}` : "UNKNOWN"}`);
  L.push(`  topmost element at its centre: <${a.topmostOverReadingArea}>`);
  L.push(`  large opaque overlays covering it: ${a.overlays.length}   (ancestors of the reading area are excluded — they paint BEHIND it)`);
  for (const o of a.overlays) {
    L.push(`    <${o.tag} class="${o.cls}">  bg ${o.bg}  opacity ${o.opacity}  z-index ${o.z}  ${o.rect.w} x ${o.rect.h}`);
  }
  L.push("");
  L.push(`SECTION DOCUMENTS FOUND: ${a.docs.length}`);
  L.push(`  the verdict above describes the DISPLAYED document: ${a.displayedDoc}`);
  for (const d of a.docs) {
    L.push("");
    L.push(`  --- document #${d.index} ---`);
    if (d.problem) L.push(`  PROBLEM: ${d.problem}`);
    L.push(`  url                  ${d.url}`);
    L.push(`  readyState           ${d.readyState}     contentType ${d.contentType}`);
    L.push(`  has <body>           ${d.hasBody}`);
    if (d.parserError) L.push(`  PARSER ERROR         ${d.parserError}`);
    L.push(`  elements             ${d.elements}`);
    L.push(`  text in the DOM      ${d.textLength} characters   (innerHTML ${d.htmlLength} bytes)`);
    L.push(`  body box             ${d.bodyRect ? `${d.bodyRect.w} x ${d.bodyRect.h}` : "UNKNOWN"}`);
    L.push(`  html background      ${d.htmlBg}`);
    L.push(`  body background      ${d.bodyBg}`);
    L.push(`  text sampled         ${d.sampled} element(s), ${d.visibleTextSamples} measured VISIBLE`);
    L.push(`  dominant reason      ${d.dominantReason}`);
    L.push(`  stylesheets          ${d.sheets.length}`);
    for (const s of d.sheets) L.push(`    ${s.href}  rules=${s.rules ?? "UNREADABLE"} ${s.note}`);
    L.push(`  <style> tags in doc  ${d.sardSheets.length}`);
    for (const s of d.sardSheets) L.push(`    [${s.attr}] ${s.length} chars :: ${s.head}`);
    L.push("  per-element measurements:");
    for (const s of d.samples) {
      L.push(`    <${s.tag}> "${s.text}"`);
      L.push(`       box ${s.rect.w}x${s.rect.h} at (${s.rect.x},${s.rect.y})   font-size ${s.fontSize}`);
      L.push(`       color ${s.color}   own-bg ${s.bg}   effective-bg ${s.effectiveBg}  <- ${s.bgFrom}`);
      L.push(`       contrast ${s.contrast ?? "UNKNOWN"}:1   display ${s.display}   visibility ${s.visibility}   opacity ${s.opacity}`);
      L.push(`       clip-path ${s.clipPath}   filter ${s.filter}   mix-blend-mode ${s.mixBlendMode}   transform ${s.transform}`);
      L.push(`       topmost element at its centre: <${s.topmostAtCentre}>${s.covered ? "  <== COVERED" : ""}`);
      L.push(`       VERDICT: ${s.hiddenBy ? `HIDDEN — ${s.hiddenBy}` : "visible"}`);
    }
  }
  L.push("");
  L.push(`RESOURCES THAT FAILED TO LOAD INSIDE SECTIONS: ${a.resourceErrors.length}`);
  for (const r of a.resourceErrors) L.push(`  [${r.t} ms] <${r.kind}> ${r.url}   (${r.where})`);
  L.push("");
  L.push(`THEME APPLICATIONS RECORDED: ${a.themeChanges.length}`);
  L.push("  (if these change while the page stays black, the theme reached the document and the");
  L.push("   blackness is not a theme that failed to apply)");
  for (const t of a.themeChanges) {
    L.push(`  [${t.t} ms] ${t.themeId} / ${t.mode}   sheet ${t.sheetLen} chars`);
    if (t.colours) L.push(`             ${t.colours}`);
  }
  L.push("");
  return L.join("\r\n");
}
