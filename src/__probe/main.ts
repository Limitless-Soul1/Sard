// PROBE-ONLY — throwaway branch, never merged.
//
// The runtime gate for the WIRED reader. Earlier probes hand-rolled their own messages, which proved
// the host answered but said nothing about the transport the product actually uses. This one calls
// `createReader()` and then drives the result through `FoliateController`'s own surface, so what is
// measured is the shipping code path: the proxy, the mirror, the event pushes, the local decisions.
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
          R.surface["selection.payload"] = JSON.parse(JSON.stringify(args[0]));
        }
      });
    } catch (e) {
      R.errors.push(`register ${name}: ${String(e)}`);
    }
  }
  // The two synchronous callbacks. Neither may cross the port.
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

  // OPEN through the engine's own signature. The hosted transport fetches the bytes itself.
  const stage = document.getElementById("stage") as HTMLElement;
  await step("open", () => ctrl.open("/__probe/book.epub", stage, {
    style: { fontSizePx: 20, lineHeight: 1.8, marginPct: 6, fontFamily: "serif", justify: true },
    flow: "paged",
  } as never));
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
  const cfi = (ctrl as unknown as { currentCfi?: () => string }).currentCfi?.() ?? null;
  R.surface["cfiAtCursor"] = cfi;

  await step("addHighlight", async () => await ctrl.addHighlight("epubcfi(/6/4!/4/2,/1:0,/1:40)", "#ffd54f", 0.5));
  await step("loadHighlights", async () => {
    await ctrl.loadHighlights([{ cfi: "epubcfi(/6/4!/4/4,/1:0,/1:30)", color: "#80cbc4", alpha: 0.4 }]);
    return true;
  });
  await step("setHighlightColor", () => {
    ctrl.setHighlightColor("epubcfi(/6/4!/4/2,/1:0,/1:40)", "#ef9a9a");
    return true;
  });
  await step("removeHighlight", () => {
    ctrl.removeHighlight("epubcfi(/6/4!/4/2,/1:0,/1:40)");
    return true;
  });

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
  await step("showReadingHighlight", () => {
    ctrl.showReadingHighlight(0);
    return true;
  });
  await step("ttsCursorAfterTrack", () => ctrl.getTtsCursor(0));
  await step("clearReadingHighlight", () => {
    ctrl.clearReadingHighlight();
    return true;
  });

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
