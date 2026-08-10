// PROBE-ONLY — throwaway branch, never merged.
//
// The runtime gate for the WIRED reader. Earlier probes hand-rolled their own messages, which proved
// the host answered but said nothing about the transport the product actually uses. This one calls
// `createReader()` and then drives the result through `FoliateController`'s own surface, so what is
// measured is the shipping code path: the proxy, the mirror, the event pushes, the local decisions.
// The REAL UI stylesheet, so the typography measurement below sees the actual font stack, the
// actual @font-face rules and the actual unicode-ranges — not a re-creation of them.
import "../styles/global.css";
import { createReader, needsReaderHost } from "../reader-transport";
import type { FoliateController } from "../reader-engine/FoliateController";

const COLLECT = "http://127.0.0.1:8792/report";

// Ask the real host to run its boundary self-check. Set before `createReader()` mounts the frame.
(globalThis as { __sardHostSelfcheck?: boolean }).__sardHostSelfcheck = true;

interface Result {
  stage: string;
  seq?: number;
  appOrigin: string;
  needsHost: boolean;
  bookBytes: number;
  open: string;
  surface: Record<string, unknown>;
  sync: Record<string, unknown>;
  events: Record<string, number>;
  keyboard: Record<string, unknown>;
  errors: string[];
}

const R: Result = {
  stage: "boot",
  appOrigin: location.origin,
  needsHost: needsReaderHost(),
  bookBytes: 0,
  open: "untried",
  surface: {},
  sync: {},
  events: {},
  keyboard: {},
  errors: [],
};

let seq = 0;
function emit(stage: string): void {
  R.stage = stage;
  R.seq = ++seq;
  const body = JSON.stringify(R);
  void fetch(COLLECT, { method: "POST", body, headers: { "Content-Type": "text/plain" } }).catch(() => {});
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a: unknown) => unknown } })
    .__TAURI_INTERNALS__?.invoke;
  try {
    if (inv) void Promise.resolve(inv("probe_write", { payload: body })).catch(() => {});
  } catch {
    /* the collector already has it */
  }
}

addEventListener("message", (e: MessageEvent) => {
  const d = e.data as { __sardProbeHost?: boolean; report?: string } | null;
  if (!d?.__sardProbeHost) return;
  try {
    R.surface["hostSelfcheck"] = JSON.parse(d.report ?? "null");
  } catch {
    R.surface["hostSelfcheck"] = d.report ?? null;
  }
});

addEventListener("error", (e) => {
  R.errors.push(`jserror: ${e.message} @${e.filename}:${e.lineno}`);
  emit("jserror");
});
addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  const stack = r instanceof Error && r.stack ? r.stack.slice(0, 600) : "";
  R.errors.push(`unhandled: ${String(r).slice(0, 200)} :: ${stack}`);
  emit("unhandled");
});

emit("boot");

async function step<T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> {
  try {
    const v = await run();
    R.surface[name] = v === undefined ? "ok" : (JSON.parse(JSON.stringify(v ?? null)) as unknown);
    emit(`step-${name}`);
    return v;
  } catch (e) {
    R.surface[name] = `FAIL:${e instanceof Error ? e.message : String(e)}`;
    emit(`step-${name}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  // ---- ARABIC BASELINE: measure, do not theorise ------------------------------------------------
  //
  // Reported on a real Linux machine: within one line, the words carrying tashkīl sit higher than
  // their neighbours — «رفّ» in «+ رفّ جديد», «أولًا» in the shelves hint. Two hypotheses were killed
  // by reading alone: IBM Plex Sans Arabic DOES contain U+0651 and U+064B, and the face's
  // unicode-range U+0600-06FF DOES cover them. So this measures instead.
  //
  // Each word is boxed separately and compared against the same word with its marks stripped, and
  // against the same word forced to a single family. If a marked word's box starts higher than an
  // unmarked neighbour on the same line, the raise is real and measurable.
  R.surface["typography"] = (() => {
    const host = document.createElement("div");
    host.setAttribute(
      "style",
      "position:fixed;left:0;top:0;visibility:hidden;font-family:var(--ui-font);font-size:16px;line-height:1.5",
    );
    host.dir = "rtl";
    document.body.appendChild(host);

    const line = document.createElement("div");
    host.appendChild(line);
    const words = ["+", "رفّ", "جديد", "أولًا", "أولا", "رف", "الشريط"];
    const spans = words.map((w) => {
      const el = document.createElement("span");
      el.textContent = w;
      el.style.cssText = "display:inline-block";
      line.appendChild(el);
      line.appendChild(document.createTextNode(" "));
      return el;
    });

    const out: Record<string, unknown> = {};
    spans.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      out[words[i]] = { top: +r.top.toFixed(2), height: +r.height.toFixed(2), bottom: +r.bottom.toFixed(2) };
    });

    // Does the browser have the faces it should?
    out["fontsReady"] = {
      SardUIArabic: document.fonts.check('16px "SardUIArabic"', "رف"),
      SardUILatin: document.fonts.check('16px "SardUILatin"', "A"),
      loadedFamilies: [...document.fonts].map((f) => (f as FontFace).family).join(","),
    };
    out["uiFontStack"] = getComputedStyle(document.documentElement).getPropertyValue("--ui-font").trim();
    document.body.removeChild(host);
    return out;
  })();
  emit("typography");

  const ctrl: FoliateController = await createReader();
  emit("reader-created");

  // Every callback the application registers in the real reader. Counting them proves the host's
  // event push and the proxy's registration both work end to end.
  for (const name of ["onSelection", "onShowAnnotation", "onActivity", "onZoomIntent", "onScrollIntent", "onReadingRedraw", "onRelocate", "onReferenceHit"] as const) {
    R.events[name] = 0;
    try {
      (ctrl as unknown as Record<string, (cb: (...a: unknown[]) => void) => void>)[name]((...args: unknown[]) => {
        R.events[name] = (R.events[name] ?? 0) + 1;
        if (name === "onSelection" && args[0]) {
          const sel = args[0] as { cfi?: string };
          R.surface["selection.payload"] = JSON.parse(JSON.stringify(sel));
          if (sel.cfi) realCfi = sel.cfi; // a CFI the engine itself produced, over real text
        }
      });
    } catch (e) {
      R.errors.push(`register ${name}: ${String(e)}`);
    }
  }
  // The two synchronous callbacks. Neither may cross the port.
  let realCfi: string | null = null;
  let arrowAsked = 0;
  let spaceAsked = 0;
  ctrl.onArrow(() => {
    arrowAsked++;
    return false; // decline, so the page turn still happens — that is the engine's own branch
  });
  ctrl.onSpace(() => {
    spaceAsked++;
    return true; // claim it, as read-aloud does
  });
  emit("callbacks-registered");

  const res = await fetch("/__probe/book.epub");
  const bytes = await res.arrayBuffer();
  R.bookBytes = bytes.byteLength;
  emit("book-fetched");

  // OPEN THE WAY THE APPLICATION DOES.
  //
  // Every earlier run passed `/__probe/book.epub`, a same-origin path. The application passes
  // `convertFileSrc(filePath)` — an `asset:` URL — so the fetch that actually happens in the product
  // was never exercised here at all. The book is staged into app data and opened through that URL.
  const stage = document.getElementById("stage") as HTMLElement;
  const invB = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__?.invoke;
  let bookUrl = "/__probe/book.epub";
  await step("book.assetUrl", async () => {
    if (!invB) return "no invoke";
    const path = (await invB("probe_stage_book")) as string;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    bookUrl = convertFileSrc(path);
    return bookUrl;
  });

  await step("open", () => ctrl.open(bookUrl, stage, {
    style: { fontSizePx: 20, lineHeight: 1.8, marginPct: 6, fontFamily: "serif", justify: true },
    flow: "paged",
  } as never));

  // ---- COMPOSITION: is the host INSIDE the reading area, or over the whole window? --------------
  // The symptom on the real machine was "the toolbar appears, then disappears, and the page is
  // blank". That is what a full-window host frame looks like from outside, and no measurement here
  // could see it while the probe page was a single full-window stage.
  await new Promise((r) => setTimeout(r, 800));
  R.surface["composition"] = (() => {
    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    const bar = document.getElementById("toolbar") as HTMLElement;
    if (!frame) return { frame: "none" };
    const f = frame.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const overlapsToolbar = f.top < b.bottom && f.bottom > b.top && f.left < b.right && f.right > b.left;
    // What is actually on top at the toolbar's centre? If the host is over it, this is the frame.
    const atToolbarCentre = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      parentIsStage: frame.parentElement?.id === "stage",
      parentId: frame.parentElement?.id ?? frame.parentElement?.tagName ?? "?",
      frameRect: { top: Math.round(f.top), height: Math.round(f.height), width: Math.round(f.width) },
      toolbarRect: { top: Math.round(b.top), height: Math.round(b.height) },
      overlapsToolbar,
      topmostAtToolbarCentre: (atToolbarCentre as HTMLElement | null)?.id
        || (atToolbarCentre as HTMLElement | null)?.tagName || "none",
      toolbarStillOnTop: (atToolbarCentre as HTMLElement | null)?.id === "toolbar",
    };
  })();
  emit("composition");
  R.open = typeof R.surface["open"] === "string" && String(R.surface["open"]).startsWith("FAIL") ? "failed" : "opened";
  emit("opened");

  // ---- the synchronous surface, served from the mirror ----------------------------------------
  const sync = () => {
    R.sync = {
      currentSectionIndex: ctrl.currentSectionIndex(),
      atChapterStart: ctrl.atChapterStart(),
      hasNextSection: ctrl.hasNextSection(),
      isTtsChapterOnScreen: ctrl.isTtsChapterOnScreen(),
      tocLength: ctrl.getToc().length,
      tocHrefSectionSize: ctrl.tocHrefSectionMap().size,
      pdfHasSpeakableText: ctrl.pdfHasSpeakableText(),
      openingUnderTopBar: ctrl.openingUnderTopBar(),
      // CFI behaviour: same section is true, a different section is false. Pure and shared.
      bookmarkSameSection: ctrl.bookmarkVisible("epubcfi(/6/4!/4/2)", "epubcfi(/6/4!/4/10)"),
      bookmarkOtherSection: ctrl.bookmarkVisible("epubcfi(/6/4!/4/2)", "epubcfi(/6/8!/4/2)"),
      ttsCursor0: ctrl.getTtsCursor(0),
    };
  };
  sync();
  emit("sync-read");

  // ---- keyboard: the three locally-decided paths ------------------------------------------------
  const before = ctrl.currentSectionIndex();
  R.keyboard["handleNavKey(ArrowLeft)"] = ctrl.handleNavKey("ArrowLeft");
  R.keyboard["handleNavKey(unmapped)"] = ctrl.handleNavKey("F9");
  await new Promise((r) => setTimeout(r, 1500));
  sync();
  R.keyboard.arrowCallbackAsked = arrowAsked;
  R.keyboard.spaceCallbackAsked = spaceAsked;
  R.keyboard.sectionBefore = before;
  R.keyboard.sectionAfter = ctrl.currentSectionIndex();
  emit("keyboard");

  // ---- highlights, references, search, TTS track ------------------------------------------------
  // Driven through the engine's own surface, so what is proven is the transport carrying the real
  // calls — not that forwarding code exists.
  // ---- async forwards over the proxy ------------------------------------------------------------
  await step("getCurrentChapterSentences", async () => (await ctrl.getCurrentChapterSentences("ar")).length);
  await step("goToNextChapter", async () => {
    await ctrl.goToNextChapter();
    return true;
  });
  await new Promise((r) => setTimeout(r, 1200));
  sync();
  R.surface["sectionAfterChapterJump"] = ctrl.currentSectionIndex();
  emit("forwards");

  // Give real input (delivered by the harness) time to produce events.
  await new Promise((r) => setTimeout(r, 8000));
  sync();
  R.keyboard.spaceCallbackAskedFinal = spaceAsked;
  // Freeze the EPUB's state BEFORE the PDF replaces it. The final `sync()` used to run after the PDF
  // opened, so the report read `toc=0` and called it a failure — a PDF has no table of contents.
  R.surface["syncEpub"] = { ...R.sync };
  emit("input-window-closed");

  // A FABRICATED CFI PROVES NOTHING. The previous pass highlighted
  // `epubcfi(/6/4!/4/2,/1:0,/1:40)`, which need not resolve to anything in this book — the call
  // crosses, returns, paints no pixels, and a broken transport looks identical to a working one. The
  // CFI used here is one the ENGINE produced from the real drag the harness performed, so it points
  // at text that is genuinely on screen.
  R.surface["realCfiFromSelection"] = realCfi;

  await step("addHighlight", async () =>
    realCfi ? await ctrl.addHighlight(realCfi, "#ffd54f", 0.5) : "no selection cfi");
  await step("loadHighlights", async () => {
    await ctrl.loadHighlights(realCfi ? [{ cfi: realCfi, color: "#80cbc4", alpha: 0.4 }] : []);
    return true;
  });
  await step("setHighlightColor", () => {
    if (realCfi) ctrl.setHighlightColor(realCfi, "#ef9a9a");
    return true;
  });
  await new Promise((r) => setTimeout(r, 1500));
  R.surface["overlayAfterHighlight"] =
    (R.surface["hostSelfcheck"] as { overlay?: unknown } | undefined)?.overlay ?? null;

  await step("removeHighlight", () => {
    if (realCfi) ctrl.removeHighlight(realCfi);
    return true;
  });
  await new Promise((r) => setTimeout(r, 1200));
  R.surface["overlayAfterRemove"] =
    (R.surface["hostSelfcheck"] as { overlay?: unknown } | undefined)?.overlay ?? null;

  // References are the notes surface: a list pushed into the engine, matched against book text.
  await step("setReferences", () => {
    ctrl.setReferences([{ id: "r1", phrase: "الكاتب" } as never]);
    return true;
  });

  // SEARCH — the progressive path. The callbacks stay app-side and the host pushes batches.
  let batches = 0;
  let progress = 0;
  await step("searchBook", async () => {
    const hits = await ctrl.searchBook("الكلمات", {
      onBatch: () => { batches++; },
      onProgress: () => { progress++; },
    });
    return { hits: hits.length, batches, progress };
  });

  // TTS TRACK — the spotlight the reader draws on the sentence being spoken. Audio itself is played
  // in the application document and never crosses; what crosses is the tracking.
  await step("trackStats", async () => {
    const st = await ctrl.trackStats("ar");
    return { units: (st as { units?: number }).units ?? null, withRange: (st as { withRange?: number }).withRange ?? null };
  });
  // REAL AUDIO. `tts_synthesize` is an application-side IPC command — it never crosses the reader
  // host — but synthesising a sentence for real is the only way to say the read-aloud pipeline works
  // in this environment rather than merely that its plumbing exists. A network failure here is a
  // property of the runner, not of the transport, and is reported as such.
  await step("tts.synthesize", async () => {
    const inv3 = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__?.invoke;
    if (!inv3) return "no invoke";
    try {
      const res = (await inv3("tts_synthesize", {
        engine: "edge",
        id: "ar-SA-HamedNeural", // a real Edge voice: `id` IS the voice, not a request id
        text: "السلام عليكم ورحمة الله وبركاته",
      })) as ArrayBuffer | { byteLength?: number };
      const len = res instanceof ArrayBuffer ? res.byteLength : (res?.byteLength ?? -1);
      return { audioBytes: len };
    } catch (e) {
      return `NETWORK-OR-ENGINE:${e instanceof Error ? e.message.slice(0, 90) : String(e).slice(0, 90)}`;
    }
  });

  // THE SPOTLIGHT, ADVANCED AS PLAYBACK WOULD. What crosses the host during read-aloud is the
  // tracking, not the audio, so this is the transport-relevant half measured for real: each sentence
  // must produce painted geometry in the overlayer, and the paint must move between sentences.
  // A SESSION FIRST. `showReadingHighlight` refuses when `content.index !== ttsUnitsIndex`, and only
  // `getChapterUnits` retains units and sets that index — `trackStats` computes them transiently on
  // its non-live branch. Without a session the spotlight correctly paints nothing, which is what an
  // earlier pass measured and briefly mistook for a transport failure. The call travels the
  // transport; the side effect it needs happens in the host, which is where the engine lives.
  await step("tts.buildUnits", async () => (await ctrl.getChapterUnits("ar")).length);

  const spotlight: { i: number; painted: number | null; areaPx: number | null }[] = [];
  for (const i of [0, 1, 2]) {
    ctrl.showReadingHighlight(i);
    await new Promise((r) => setTimeout(r, 700));
    const ov = (R.surface["hostSelfcheck"] as { overlay?: { painted?: number; areaPx?: number } } | undefined)?.overlay;
    spotlight.push({ i, painted: ov?.painted ?? null, areaPx: ov?.areaPx ?? null });
  }
  R.surface["tts.spotlight"] = spotlight;
  await step("ttsCursorAfterTrack", () => ctrl.getTtsCursor(0));
  await step("clearReadingHighlight", () => {
    ctrl.clearReadingHighlight();
    return true;
  });
  await new Promise((r) => setTimeout(r, 700));
  R.surface["tts.spotlightAfterClear"] =
    (R.surface["hostSelfcheck"] as { overlay?: { painted?: number } } | undefined)?.overlay?.painted ?? null;
  emit("annotations");


  // ---- a user font over asset: ------------------------------------------------------------------
  // Staged by a probe-only Rust command from the compiled bundle, so nothing is downloaded and no
  // fixture enters the repository. Only the application can turn a path into an asset: URL, so it
  // hands the URL to the host and the host answers whether it can actually load it as a face.
  await step("assetFont.stage", async () => {
    const inv2 = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__?.invoke;
    if (!inv2) return "no invoke";
    const path = (await inv2("probe_stage_font")) as string;
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(path);
    R.surface["assetFont.url"] = url;
    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    frame?.contentWindow?.postMessage({ __sardProbeFont: url }, "*");
    return url;
  });
  await new Promise((r) => setTimeout(r, 2500));
  R.surface["assetFont"] =
    ((R.surface["hostSelfcheck"] as { assets?: Record<string, unknown> } | undefined)?.assets?.assetFont) ?? null;
  emit("asset-font");

  // ---- PDF, through the same host ---------------------------------------------------------------
  // A real PDF, sniffed as one from its bytes. Opening it after the EPUB also exercises reopening
  // the host with a different book, which is what switching books in the library does.
  await step("openPdf", () => ctrl.open("/__probe/book.pdf", stage, {
    style: { fontSizePx: 20, lineHeight: 1.8, marginPct: 6, fontFamily: "serif", justify: true },
  } as never));
  await new Promise((r) => setTimeout(r, 2500));
  await step("pdf.isFixedLayout", () => (ctrl as unknown as { isFixedLayout: boolean }).isFixedLayout);
  await step("pdf.pageCount", () => (ctrl as unknown as { pdfPageCount?: number }).pdfPageCount ?? null);
  await step("pdf.textQuality", () => ctrl.pdfTextQuality());
  await step("pdf.hasSpeakableText", () => ctrl.pdfHasSpeakableText());
  await step("pdf.renderedScale", () => ctrl.pdfRenderedScale());
  R.surface["pdf.renderedSurface"] =
    (R.surface["hostSelfcheck"] as { rendered?: unknown } | undefined)?.rendered ?? null;

  // PDF INTERACTION. The text layer is switched off at the product level (`PDF_TTS_ENABLED = false`,
  // and FoliateController returns early on it), so `coverage: 0` is the correct answer rather than a
  // defect — there is no text layer to test. What a reader actually does with a PDF is turn pages
  // and zoom, and both go through the transport.
  await step("pdf.navKey", () => ctrl.handleNavKey("ArrowLeft"));
  await new Promise((r) => setTimeout(r, 1500));
  await step("pdf.zoom", () => {
    ctrl.setPdfZoom("fit-width");
    return true;
  });
  await new Promise((r) => setTimeout(r, 1500));
  await step("pdf.scaleAfterZoom", () => ctrl.pdfRenderedScale());
  R.surface["pdf.surfaceAfterInteraction"] =
    (R.surface["hostSelfcheck"] as { rendered?: unknown } | undefined)?.rendered ?? null;
  sync();
  emit("final");
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a: unknown) => unknown } })
    .__TAURI_INTERNALS__?.invoke;
  try {
    if (inv) void inv("probe_finish", { payload: JSON.stringify(R) });
  } catch {
    /* the collector has it */
  }
}

void main().catch((e) => {
  R.errors.push(`main: ${e instanceof Error ? e.message : String(e)}`);
  emit("main-failed");
});
