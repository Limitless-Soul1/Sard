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
  await new Promise((r) => setTimeout(r, 6000));
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
