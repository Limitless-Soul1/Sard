// SARD DIAGNOSTIC BUILD — evidence collector. NOT part of the product's behaviour.
//
// Two reported failures cannot be reproduced on any development machine:
//   Issue 1  opening a PDF fails with `TypeError: Failed to fetch`
//   Issue 2  read-aloud plays audio with NO highlighting at all (neither sentence nor word)
//
// Both work here and fail there, so the evidence has to come from the affected machine. This module
// records what actually happened, step by step, and writes a report that can be read without
// guessing. It changes no product behaviour: it observes, it never intervenes.
//
// EVIDENCE DISCIPLINE. Every line carries a tier and they are never blended:
//   MEASURED  read directly from the running application
//   DERIVED   computed from measured values, with the inputs shown
//   UNKNOWN   could not be established — written as UNKNOWN, never guessed
//
// Almost everything here is a HOOK rather than an edit to the pipeline, because a hook cannot change
// the thing it is watching. `fetch` is wrapped once (covering the book file, the pdf.js CSS and the
// worker in one place) and the TTS store is subscribed to. Only four facts genuinely cannot be seen
// from outside — the tracking-unit section, the follow decision, the spotlight draw, and the word
// timing length — and those call `diagNote()` from their own site.

import { renderStages as renderPdfStagesText, stageOk as pdfStageOk, pdfAttemptActive, pdfStages, pdfAttempts } from "./pdfDiag"; // DIAGNOSTIC BUILD ONLY
import { autopsy, renderBlackScreenText, renderStages, renderStagesText, type BlackScreenReport } from "./renderDiag"; // DIAGNOSTIC BUILD ONLY

export type Tier = "MEASURED" | "DERIVED" | "UNKNOWN";

export interface DiagEvent {
  t: number; // ms since collection started
  at: string; // ISO timestamp
  stage: string; // "pdf.open", "tts.units", "fetch", …
  tier: Tier;
  msg: string;
  data?: Record<string, unknown>;
}

// RECORDING LIFETIME: one continuous session, from launch until export.
//
// The tester will try several things before deciding to export — open a book, fail, try another,
// start read-aloud, retry — and the report must contain ALL of it, not the last attempt. So nothing
// is reset between attempts and nothing is dropped.
//
// The cap exists only so a machine left running for days cannot exhaust memory. It is deliberately
// far above any realistic session (the sampler emits at most ~1/second, and only while audio is
// sounding), and if it were ever reached the report SAYS SO rather than quietly losing the
// beginning — a silently truncated timeline would be worse than no timeline, because the earliest
// events are usually the interesting ones.
const MAX_EVENTS = 50_000;
const events: DiagEvent[] = [];
let t0 = Date.now();
let startedAtIso = "";
let armed = false;
let truncatedFrom = 0; // how many events were dropped, if the cap was ever hit (normally 0)

/** Record one observation. Never throws — a diagnostic must not break the thing it observes. */
export function diagNote(stage: string, tier: Tier, msg: string, data?: Record<string, unknown>): void {
  if (!armed) return;
  try {
    if (events.length >= MAX_EVENTS) {
      const dropped = events.splice(0, 1000).length;
      truncatedFrom += dropped; // never silent — the report states this explicitly
    }
    events.push({ t: Date.now() - t0, at: new Date().toISOString(), stage, tier, msg, data });
  } catch {
    /* never let instrumentation fail the app */
  }
}

/** Is the diagnostic collector running? Call sites use this to skip work when it is off. */
export const diagArmed = (): boolean => armed;

// ---------------------------------------------------------------------------------------------
// ISSUE 1 — every fetch, in one hook.
//
// The PDF path makes three network requests and they fail DIFFERENTLY, which is why the raw record
// matters: view.js fetches the book and checks `res.ok` (so a missing file is an HTTP status);
// pdf.js fetches two CSS files under a top-level await with NO ok check; the worker is loaded
// separately. `TypeError: Failed to fetch` is a NETWORK-level rejection — the request never
// completed — so distinguishing "rejected" from "completed with status" is the whole game.
// ---------------------------------------------------------------------------------------------
let fetchHooked = false;
function hookFetch(): void {
  if (fetchHooked || typeof window === "undefined") return;
  fetchHooked = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const started = performance.now();
    // The stack is captured BEFORE the await so it still shows the caller, which is how we learn
    // WHICH of the three fetches this is without guessing from the URL alone.
    const stack = new Error("fetch call site").stack ?? "(no stack)";
    try {
      const res = await orig(input as RequestInfo, init);
      diagNote("fetch", "MEASURED", `${res.status} ${res.statusText || ""} ${url}`.trim(), {
        url,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        type: res.type,
        redirected: res.redirected,
        contentType: res.headers.get("content-type"),
        contentLength: res.headers.get("content-length"),
        ms: Math.round(performance.now() - started),
        outcome: "COMPLETED (HTTP response received)",
        callSite: stack.split("\n").slice(1, 6).join(" | "),
      });
      // DIAGNOSTIC: the book file arriving over the asset protocol IS stage 6.
      if (/text_layer_builder.css|annotation_layer_builder.css/.test(url)) {
        pdfStageOk("pdfjs.import", { evidence: "pdf.js top-level CSS load proves the module instantiated" });
        pdfStageOk("pdfjs.css", { url: url.slice(0, 120), status: res.status, bytes: res.headers.get("content-length") });
      }
      if (/asset.localhost/.test(url) && pdfAttemptActive()) {
        pdfStageOk("book.fetch", { url: url.slice(0, 160), status: res.status, bytes: res.headers.get("content-length"), contentType: res.headers.get("content-type"), ms: Math.round(performance.now() - started) });
      }
      return res;
    } catch (e) {
      // THIS is the shape the tester reports. Record it in full: a rejection here means no HTTP
      // response existed at all.
      const err = e as Error;
      diagNote("fetch", "MEASURED", `NETWORK REJECTION on ${url}`, {
        url,
        outcome: "REJECTED (no HTTP response — this is a network-level failure)",
        errorName: err?.name ?? typeof e,
        errorMessage: err?.message ?? String(e),
        ms: Math.round(performance.now() - started),
        stack: err?.stack ?? "(none)",
        callSite: stack.split("\n").slice(1, 8).join(" | "),
      });
      throw e; // rethrow untouched — the app must behave exactly as it would without us
    }
  };
  diagNote("init", "MEASURED", "fetch hook installed");
}

/**
 * GLOBAL FAILURE CAPTURE.
 *
 * The previous report could not explain the PDF failure because the only thing being watched was
 * `fetch`. An ES module that fails to load, or a rejected dynamic import, never touches `fetch` and
 * therefore left no trace at all. These two listeners are the difference between "the CSS was never
 * fetched, we don't know why" and having the actual exception with its stack.
 */
let errorsHooked = false;
function hookErrors(): void {
  if (errorsHooked || typeof window === "undefined") return;
  errorsHooked = true;
  window.addEventListener("error", (e: ErrorEvent) => {
    diagNote("js.error", "MEASURED", `uncaught error: ${e.message}`, {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      errorName: e.error?.name ?? "(none)",
      stack: e.error?.stack ?? "(no stack)",
    });
  });
  // A failed dynamic import surfaces HERE, not as an error event.
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r = e.reason as Error | undefined;
    diagNote("js.rejection", "MEASURED", `unhandled promise rejection: ${r?.message ?? String(e.reason)}`, {
      errorName: r?.name ?? typeof e.reason,
      message: r?.message ?? String(e.reason),
      stack: r?.stack ?? "(no stack)",
      isModuleLoadFailure: /dynamically imported module|Failed to fetch/i.test(String(r?.message ?? e.reason)),
    });
  });
  // Resource-level failures (script/link/img) bubble in the CAPTURE phase only.
  window.addEventListener(
    "error",
    (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === (window as unknown as HTMLElement) || !("tagName" in t)) return;
      diagNote("js.resource", "MEASURED", `resource failed to load: <${t.tagName.toLowerCase()}>`, {
        tag: t.tagName,
        src: (t as HTMLScriptElement).src ?? (t as HTMLLinkElement).href ?? "(none)",
      });
    },
    true,
  );
  diagNote("init", "MEASURED", "global error + unhandledrejection handlers installed");
}

// ---------------------------------------------------------------------------------------------
// ISSUE 2 — the read-aloud timeline.
//
// Subscribes to the TTS store and samples the things that decide whether a reader sees anything:
// the engine's own cursor, the word-timing list, the AudioContext clock (whose currentTime does not
// advance while suspended), and the overlayer the highlight is actually drawn on.
// ---------------------------------------------------------------------------------------------
type Unsub = () => void;
let ttsUnsub: Unsub | null = null;
let sampler: number | null = null;
let lastKey = "";

interface TtsSnapshot {
  status: unknown; index: unknown; total: unknown; wordIndex: unknown;
  words: number; underruns: unknown; abandoned: unknown; lastFailure: unknown; error: unknown;
}

function readStore(): TtsSnapshot | null {
  const st = (window as unknown as { __sardTtsStore?: { getState: () => Record<string, unknown> } }).__sardTtsStore?.getState();
  if (!st) return null;
  return {
    status: st.status, index: st.index, total: st.total, wordIndex: st.wordIndex,
    words: Array.isArray(st.words) ? st.words.length : -1,
    underruns: st.underruns, abandoned: st.abandoned, lastFailure: st.lastFailure, error: st.error,
  };
}

/** What is on screen right now, and what the highlight layer contains. */
function readView(): Record<string, unknown> {
  const v = document.querySelector(".page-host foliate-view") as unknown as {
    renderer?: { getContents?: () => { index?: number; doc?: Document; overlayer?: { element?: Element } }[] };
  } | null;
  const c = v?.renderer?.getContents?.()?.[0];
  const el = c?.overlayer?.element ?? null;
  const svg = el && el.tagName?.toLowerCase() === "svg" ? el : (el?.querySelector?.("svg") ?? null);
  const kids = svg ? Array.from(svg.children) : el ? Array.from(el.children) : [];
  let firstY: number | null = null;
  if (kids[0] && "getBoundingClientRect" in kids[0]) firstY = Math.round((kids[0] as Element).getBoundingClientRect().top);
  return {
    viewPresent: !!v,
    displayedSectionIndex: c?.index ?? null,
    hasOverlayer: !!c?.overlayer,
    overlayerHasElement: !!el,
    spotlightShapes: kids.length,
    spotlightFirstY: firstY,
    // The controller publishes the section its tracking units were built for (see FoliateController).
    ttsUnitsSectionIndex: (window as unknown as { __sardDiagUnits?: { section?: number | null } }).__sardDiagUnits?.section ?? null,
  };
}

function audioState(): Record<string, unknown> {
  const AC = (window as unknown as { __sardDiagAudio?: AudioContext }).__sardDiagAudio;
  if (!AC) return { audioContext: "UNKNOWN — not published by the TTS module" };
  return { state: AC.state, currentTime: Number(AC.currentTime.toFixed(3)), sampleRate: AC.sampleRate };
}

/**
 * Attach to the TTS store, retrying until it exists.
 *
 * The first version subscribed ONCE at startup and silently collected nothing: `App` mounts before
 * the TTS module has created its store, so `__sardTtsStore` was still undefined and the diagnostic
 * produced a report with an empty read-aloud section — useless for the issue it was built for. The
 * sampler below therefore re-attempts the subscription on every tick until it succeeds.
 */
function attachStore(): void {
  const store = (window as unknown as { __sardTtsStore?: { subscribe: (f: () => void) => Unsub } }).__sardTtsStore;
  if (store?.subscribe && !ttsUnsub) {
    ttsUnsub = store.subscribe(() => {
      const s = readStore();
      if (!s) return;
      const key = `${s.status}|${s.index}|${s.wordIndex}|${s.words}`;
      if (key === lastKey) return; // only transitions, not every notification
      lastKey = key;
      diagNote("tts.state", "MEASURED", `status=${s.status} sentence=${s.index}/${s.total} wordIndex=${s.wordIndex} words=${s.words}`, {
        ...s, ...readView(), audio: audioState(),
      });
    });
    diagNote("init", "MEASURED", "TTS store subscription installed");
  }
}

function startTtsWatch(): void {
  attachStore();
  // A slow sampler does two jobs: it keeps retrying the subscription until the TTS module exists,
  // and it catches what a state transition cannot — a frozen clock, or a spotlight that stops
  // moving while the engine keeps advancing.
  if (sampler == null) {
    sampler = window.setInterval(() => {
      attachStore();
      const s = readStore();
      if (!s || (s.status !== "playing" && s.status !== "buffering")) return;
      diagNote("tts.sample", "MEASURED", `sample status=${s.status} sentence=${s.index} word=${s.wordIndex}`, {
        ...s, ...readView(), audio: audioState(),
      });
    }, 1000);
  }
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------
async function environment(): Promise<Record<string, unknown>> {
  const env: Record<string, unknown> = {
    collectedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    engine: (navigator as unknown as { userAgentData?: { brands?: { brand: string; version: string }[] } })
      .userAgentData?.brands?.map((b) => `${b.brand}/${b.version}`).join(", ") ?? "UNKNOWN",
    language: navigator.language,
    platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "UNKNOWN",
    deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? "UNKNOWN",
    hardwareConcurrency: navigator.hardwareConcurrency ?? "UNKNOWN",
    origin: location.origin,
    href: location.href,
    // The capability gate's own inputs — the built-ins PDF.js and the EPUB parser require.
    builtins: {
      "Uint8Array.prototype.toHex": typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex,
      "Uint8Array.prototype.toBase64": typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64,
      "Uint8Array.fromBase64": typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64,
      "Object.groupBy": typeof (Object as unknown as { groupBy?: unknown }).groupBy,
      "Map.groupBy": typeof (Map as unknown as { groupBy?: unknown }).groupBy,
    },
  };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    env.appInfo = await invoke("app_info");
  } catch (e) {
    env.appInfo = `UNKNOWN — ${String(e)}`;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
function renderText(env: Record<string, unknown>, black: BlackScreenReport): string {
  const L: string[] = [];
  const rule = (c = "=") => L.push(c.repeat(78));
  rule();
  L.push("SARD DIAGNOSTIC REPORT");
  rule();
  L.push("");
  L.push("Every line below is tagged with how it was established:");
  L.push("  MEASURED  read directly from the running application");
  L.push("  DERIVED   computed from measured values (inputs are shown)");
  L.push("  UNKNOWN   could not be established - NOT a guess");
  L.push("");
  rule("-");
  L.push("ENVIRONMENT");
  rule("-");
  for (const [k, v] of Object.entries(env)) {
    L.push(`  ${k.padEnd(22)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  L.push("");
  rule("-");
  L.push("RECORDING WINDOW");
  rule("-");
  const durMs = Date.now() - t0;
  L.push(`  started (app launch)   ${startedAtIso || "UNKNOWN"}`);
  L.push(`  exported (Ctrl+Shift+D) ${new Date().toISOString()}`);
  L.push(`  duration               ${Math.round(durMs / 1000)} s (${(durMs / 60000).toFixed(1)} min)`);
  L.push(`  events recorded        ${events.length}`);
  L.push(
    truncatedFrom === 0
      ? "  completeness           COMPLETE — every event from launch to export is included"
      : `  completeness           TRUNCATED — the ${truncatedFrom} EARLIEST events were dropped (cap ${MAX_EVENTS}).` +
        " The beginning of this session is NOT in the report.",
  );
  L.push("");
  rule("-");
  L.push(`TIMELINE  (${events.length} events)`);
  rule("-");
  for (const e of events) {
    L.push(`[${String(e.t).padStart(7)}ms] ${e.tier.padEnd(8)} ${e.stage.padEnd(14)} ${e.msg}`);
    if (e.data) {
      for (const [k, v] of Object.entries(e.data)) {
        if (v === undefined) continue;
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        // Stacks are the point of this report - never truncate them.
        if (k === "stack" || k === "callSite") {
          L.push(`              ${k}:`);
          for (const line of s.split(/\||\n/)) if (line.trim()) L.push(`                ${line.trim()}`);
        } else {
          L.push(`              ${k} = ${s}`);
        }
      }
    }
  }
  L.push("");
  L.push(renderPdfStagesText());
  L.push("");
  L.push(renderStagesText());
  L.push("");
  L.push(renderBlackScreenText(black));
  L.push("");
  rule("-");
  L.push("ANALYSIS (each conclusion names the evidence it rests on)");
  rule("-");
  for (const line of analyse()) L.push("  " + line);
  L.push("");
  return L.join("\r\n");
}

/**
 * State the conditions that were actually observed. This deliberately does NOT diagnose: it reports
 * which condition held, and says UNKNOWN when the evidence does not settle it.
 */
function analyse(): string[] {
  const out: string[] = [];
  const fetches = events.filter((e) => e.stage === "fetch");
  const rejected = fetches.filter((e) => (e.data?.outcome as string)?.startsWith("REJECTED"));
  out.push(`MEASURED  fetches observed: ${fetches.length}, of which network-rejected: ${rejected.length}`);
  for (const r of rejected) {
    out.push(`MEASURED  REJECTED ${String(r.data?.url)}`);
    out.push(`DERIVED   no HTTP response existed for that request, so this is not a 404/403 -`);
    out.push(`          inputs: errorName=${String(r.data?.errorName)} errorMessage=${String(r.data?.errorMessage)}`);
  }
  if (fetches.length === 0) out.push("UNKNOWN   no fetch was observed - the failure may occur before any request is made");

  const tts = events.filter((e) => e.stage === "tts.state" || e.stage === "tts.sample");
  if (!tts.length) {
    out.push("UNKNOWN   no read-aloud activity was recorded");
    return out;
  }
  const playing = tts.filter((e) => e.data?.status === "playing" || e.data?.status === "buffering");
  const sentences = new Set(playing.map((e) => e.data?.index));
  const shapes = playing.map((e) => Number(e.data?.spotlightShapes ?? 0));
  const ys = new Set(playing.map((e) => e.data?.spotlightFirstY).filter((y) => y != null));
  const words = new Set(playing.map((e) => Number(e.data?.words ?? -1)));
  const dispSecs = new Set(playing.map((e) => e.data?.displayedSectionIndex));
  const unitSecs = new Set(playing.map((e) => e.data?.ttsUnitsSectionIndex));
  out.push(`MEASURED  sentence indices seen while sounding: ${[...sentences].join(", ") || "(none)"}`);
  out.push(`MEASURED  word-timing list lengths seen: ${[...words].join(", ")}`);
  out.push(`MEASURED  spotlight shape counts seen: ${[...new Set(shapes)].join(", ")}`);
  out.push(`MEASURED  distinct spotlight positions: ${ys.size}`);
  out.push(`MEASURED  displayed section index(es): ${[...dispSecs].join(", ")}`);
  out.push(`MEASURED  tracking-unit section index(es): ${[...unitSecs].join(", ")}`);

  const maxShapes = shapes.length ? Math.max(...shapes) : 0;
  if (maxShapes === 0) {
    out.push("DERIVED   NO highlight was ever drawn (spotlight shape count never exceeded 0).");
    const d = [...dispSecs][0], u = [...unitSecs][0];
    if (u == null) {
      out.push("UNKNOWN   the tracking-unit section was not published - cannot test the section-match condition");
    } else if (d !== u) {
      out.push(`DERIVED   CONDITION THAT FAILED: displayedSection (${String(d)}) != ttsUnitsSection (${String(u)})`);
      out.push("          The controller draws only when these are equal, so no spotlight was created.");
    } else {
      out.push(`DERIVED   section indices MATCH (${String(d)}), so the section-mismatch condition is NOT the cause.`);
      out.push("UNKNOWN   the highlight was skipped for some other reason - see the tts.* events above");
    }
    if (words.size === 1 && words.has(0)) {
      out.push("MEASURED  word-timing list was empty for every sentence (words.length == 0)");
      out.push("DERIVED   word-level karaoke was skipped by its own early return; this alone does NOT");
      out.push("          explain a missing SENTENCE highlight, which is drawn independently.");
    }
  } else if (ys.size <= 1 && sentences.size > 1) {
    out.push(`DERIVED   the highlight was drawn but NEVER MOVED: ${sentences.size} sentences, 1 position.`);
  } else {
    out.push("DERIVED   highlighting was drawn and moved - tracking appears to work in this session.");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------------
/**
 * Begin recording. Called once at launch, before the user does anything.
 *
 * IDEMPOTENT ON PURPOSE. It used to clear `events` unconditionally, which meant a second call — a
 * React remount, a StrictMode double-invoke — would wipe a timeline the tester had already spent
 * minutes producing, with no sign anything had been lost. A restart request on an already-running
 * collector is now a no-op that says so.
 */
/**
 * DIAGNOSTIC BUILD ONLY — amend the Rust startup record with what only the frontend can see.
 *
 * The Rust core writes that record before any of this exists, with the handshake marked NOT REACHED.
 * Every call here is fire-and-forget and swallows its own failure: this observes, it never
 * intervenes, and a diagnostic that can break startup is worse than no diagnostic.
 */
function startupMark(section: string): void {
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("diag_startup_mark", { section });
    } catch {
      /* an older core has no such command — nothing to do, and nothing to break */
    }
  })();
}

/**
 * THE STALE-FRONTEND TEST, and it needs no build-time plumbing.
 *
 * `fetch("/index.html", { cache: "no-store" })` reads the copy EMBEDDED IN THIS EXECUTABLE. The live
 * document's own <script src> is whatever the WebView actually loaded. Vite hashes every asset
 * filename, so if those two lists disagree the running page did not come from this binary — which is
 * exactly what a stale WebView2 cache produces, and is otherwise indistinguishable from it.
 *
 * The export button is measured too, with its box and computed visibility: "the button never
 * appeared" can also mean it was created and is invisible on that machine (scaling, an overriding
 * style), which is a different cause and would otherwise be missed entirely.
 */
async function frontendFacts(): Promise<string> {
  const L: string[] = [];
  const refs = (html: string) => [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const live = [...document.querySelectorAll<HTMLElement>("script[src], link[rel=stylesheet][href]")]
    .map((e) => e.getAttribute("src") ?? e.getAttribute("href") ?? "")
    .filter(Boolean);
  let embedded: string[] = [];
  let embeddedErr = "";
  try {
    const r = await fetch("/index.html", { cache: "no-store" });
    embedded = refs(await r.text());
  } catch (e) {
    embeddedErr = String(e);
  }
  L.push(`  liveDocumentAssets ${live.join(" , ") || "(none)"}`);
  L.push(`  embeddedIndexAssets ${embedded.join(" , ") || `(unreadable: ${embeddedErr})`}`);
  if (embedded.length && live.length) {
    const norm = (u: string) => u.split("/").pop() ?? u;
    const match = embedded.every((e) => live.some((l) => norm(l) === norm(e)));
    L.push(`  assetsMatch        ${match ? "YES — the page came from this executable" : "NO  <-- THE RUNNING PAGE IS NOT FROM THIS EXECUTABLE (stale cache)"}`);
  } else {
    L.push("  assetsMatch        UNKNOWN — one of the two lists could not be read");
  }
  const b = document.getElementById("sard-diag-export");
  if (!b) {
    L.push("  exportButton       ABSENT from the DOM");
  } else {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    L.push(`  exportButton       present, ${Math.round(r.width)}x${Math.round(r.height)} at (${Math.round(r.left)},${Math.round(r.top)})`);
    L.push(`  exportButtonStyle  display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity} zIndex=${cs.zIndex}`);
    L.push(`  windowInnerSize    ${window.innerWidth}x${window.innerHeight}  devicePixelRatio=${window.devicePixelRatio}`);
  }
  return L.join("\n");
}

export function diagStart(): void {
  if (armed) {
    diagNote("init", "MEASURED", "diagStart() called again — IGNORED, the existing recording continues uninterrupted");
    return;
  }
  // The FIRST thing recorded, before anything that could throw. If the record shows `entered` and
  // nothing after it, the failure is inside diagStart itself and the exception line below says where.
  startupMark("FRONTEND PHASE 1\n------------------------------------------------------------------------------\n  status             ENTERED — diagStart() began");
  armed = true;
  t0 = Date.now();
  startedAtIso = new Date().toISOString();
  events.length = 0;
  truncatedFrom = 0;
  diagNote("init", "MEASURED", "recording started at application launch — continues until Ctrl+Shift+D");
  // The exception is RECORDED AND RETHROWN, never swallowed. Swallowing would change what the
  // application does on the machine under investigation, and this build exists to observe that
  // machine, not to alter it. If initialisation is what fails there, the record says so and the
  // failure still happens exactly as it did before.
  try {
    hookFetch();
    hookErrors();
    startTtsWatch();
    installShortcut();
  } catch (e) {
    const err = e as { message?: string; stack?: string };
    startupMark(
      `FRONTEND PHASE 2\n------------------------------------------------------------------------------\n` +
        `  status             EXCEPTION during diagStart()\n` +
        `  message            ${err?.message ?? String(e)}\n` +
        `  stack              ${(err?.stack ?? "(no stack)").split("\n").slice(0, 6).join(" | ")}`,
    );
    throw e;
  }
  // Completion is reported once the DOM facts are readable. Deferred to a task so a slow fetch can
  // never delay startup, and awaited nowhere — the record is amended when it is ready.
  void frontendFacts()
    .then((facts) => startupMark(`FRONTEND PHASE 2
------------------------------------------------------------------------------
  status             COMPLETED — diagStart() finished\n${facts}`))
    .catch((e) => startupMark(`FRONTEND PHASE 2
------------------------------------------------------------------------------
  status             COMPLETED — diagStart() finished\n  factsError         ${String(e)}`));
}

/**
 * EXPORTING THE REPORT — and why this is no longer a keyboard shortcut alone.
 *
 * Both testers reported that Ctrl+Shift+D did nothing, which made the whole build useless. Measured
 * with real key events routed through the browser's input pipeline (tests/harness/shortcut-chain.mjs):
 *
 *   library, nothing open      -> event reaches the window, handler runs, report written
 *   A BOOK IS OPEN             -> the event NEVER REACHES THE TOP-LEVEL WINDOW at all
 *
 * The reading content lives in an iframe inside <foliate-view>'s CLOSED shadow root. Once a book is
 * open the focus is inside that iframe, and a key event delivered there fires in the IFRAME's window
 * — it does not propagate to the parent document, so a listener on the top-level window can never
 * see it. The application's own reading shortcuts work precisely because FoliateController attaches
 * its handlers to the section document; the diagnostic shortcut did not, and nobody noticed because
 * the pre-ship verification dispatched a synthetic KeyboardEvent straight at `window`, which bypasses
 * focus routing entirely and therefore could not fail the way a real keypress does.
 *
 * A tester MUST open a book to reproduce any of the reported problems, so every one of them was in
 * the broken state by the time they tried to export. Three defences now, in order of reliability:
 *
 *   1. A VISIBLE BUTTON, always on screen. It depends on no focus, no layout, no keyboard at all.
 *   2. The shortcut, attached to the top window AND to every section document as it loads.
 *   3. A key match on `event.code` as well as `event.key`, so a non-Latin keyboard layout (which
 *      reports a layout character in `key` while `code` stays "KeyD") cannot silently break it.
 *      Both are accepted, never one alone: measured, Windows' own Unicode injection path delivers
 *      key="d" with an EMPTY code, which a code-only test would reject.
 */
const wantsExport = (e: KeyboardEvent): boolean =>
  e.ctrlKey && e.shiftKey && (e.code === "KeyD" || e.key === "D" || e.key === "d");

let shortcutInstalled = false;
function installShortcut(): void {
  if (shortcutInstalled || typeof window === "undefined") return;
  shortcutInstalled = true;
  installExportButton();
  window.addEventListener("keydown", (e) => {
    if (!wantsExport(e)) return;
    e.preventDefault();
    exportNow("Ctrl+Shift+D (top-level window)");
  });
  diagNote("init", "MEASURED", "save shortcut installed (Ctrl+Shift+D) + export button + per-document listeners");
}

/** The one export path. Every trigger goes through here, so they cannot drift apart. */
let exporting = false;
export function exportNow(trigger: string): void {
  if (exporting) return; // a double-click or a repeated key must not write two reports
  exporting = true;
  // STOP first, then export: the report is a closed record of the whole session, and nothing that
  // happens while the file is being written can appear in it half-recorded.
  diagNote("init", "MEASURED", `export requested via ${trigger} — recording STOPPED, exporting the session`);
  diagStop();
  void diagSave()
    .then((dir) =>
      window.alert(
        "✅  Diagnostic report saved successfully.\n\n" +
          "It was saved in this folder:\n\n" +
          `${dir}\n\n` +
          "Please send BOTH files starting with  sard-diag-  (the .txt and the .json)\n" +
          "to the developer. You do not need to do anything else.\n\n" +
          "Recording has now stopped. The report covers your whole session,\n" +
          "from when Sard started until you pressed these keys.\n\n" +
          "Tip: the folder has just opened — the newest two files are the ones to send.",
      ),
    )
    .catch((err) =>
      window.alert(
        "⚠️  The diagnostic report could NOT be saved.\n\n" +
          `Reason: ${String(err)}\n\n` +
          "Please send this message to the developer.",
      ),
    )
    .finally(() => {
      exporting = false;
    });
}

/**
 * Attach the shortcut INSIDE a section document.
 *
 * This is the fix for the measured root cause: while a book is open the focus lives in the content
 * iframe, and its key events never reach the top-level window. FoliateController calls this for every
 * section document it is handed, EPUB and PDF alike.
 */
const attached = new WeakSet<Document>();
export function diagAttachDocument(doc: Document | undefined | null): void {
  if (!doc || attached.has(doc)) return;
  attached.add(doc);
  try {
    doc.addEventListener(
      "keydown",
      (e: Event) => {
        const ev = e as KeyboardEvent;
        if (!wantsExport(ev)) return;
        ev.preventDefault();
        exportNow("Ctrl+Shift+D (inside the reading frame)");
      },
      true, // capture: run before the reader's own navigation handlers can consume it
    );
    diagNote("init", "MEASURED", "export shortcut attached to a section document");
  } catch (err) {
    diagNote("init", "UNKNOWN", "could not attach the shortcut to a section document", { error: String(err) });
  }
}

/**
 * THE FALLBACK THAT DEPENDS ON NOTHING — a visible button.
 *
 * Built from plain DOM rather than React so no re-render can remove it, appended to <body> so it is
 * present on every screen, and given the highest possible stacking order so no dialog can bury it.
 * It works with no keyboard at all, which is the point: the export must never again hinge on a key
 * combination arriving at the right window.
 */
let buttonInstalled = false;
function installExportButton(): void {
  if (buttonInstalled || typeof document === "undefined") return;
  buttonInstalled = true;
  const mount = () => {
    if (!document.body || document.getElementById("sard-diag-export")) return;
    const b = document.createElement("button");
    b.id = "sard-diag-export";
    b.type = "button";
    b.textContent = "🛟  حفظ تقرير التشخيص  ·  Save diagnostic report";
    b.setAttribute("dir", "auto");
    b.setAttribute(
      "style",
      [
        "position:fixed", "bottom:12px", "left:12px", "z-index:2147483647",
        "padding:10px 16px", "border-radius:10px", "border:2px solid #fff",
        "background:#b3261e", "color:#fff", "font:600 14px/1.2 system-ui,Segoe UI,sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,.45)", "cursor:pointer", "opacity:.92",
        "max-width:min(92vw,420px)", "text-align:center",
      ].join(";"),
    );
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportNow("the on-screen export button");
    });
    document.body.append(b);
    diagNote("init", "MEASURED", "on-screen export button installed");
  };
  mount();
  if (!document.getElementById("sard-diag-export")) {
    // The collector starts before React has mounted anything; retry until <body> exists, then stop.
    let tries = 0;
    const t = setInterval(() => {
      mount();
      if (document.getElementById("sard-diag-export") || ++tries > 40) clearInterval(t);
    }, 250);
  }
}

/**
 * DIAGNOSTIC BUILD ONLY — the TTS module publishes its AudioContext here.
 *
 * The karaoke clock is derived from `currentTime`, which does NOT advance while a context is
 * suspended, so the collector has to be able to watch it. It used to be written straight onto
 * `globalThis` by tts.ts; that put an instrumentation call in a product module where the bundler
 * could not see it was diagnostic, and it duly survived into release bundles. Routed through this
 * module it disappears with the rest when a release build aliases lib/diag to no-ops.
 */
export function diagPublishAudio(ctx: unknown): void {
  try { (window as unknown as Record<string, unknown>).__sardDiagAudio = ctx; } catch { /* never affect playback */ }
}

/** DIAGNOSTIC BUILD ONLY — the section the reading-tracking units were built for (see audioState/snapshot). */
export function diagPublishUnits(section: number, units: number, displayed: number | null): void {
  try {
    (window as unknown as Record<string, unknown>).__sardDiagUnits = { section, units, displayed, at: new Date().toISOString() };
  } catch { /* never affect playback */ }
}

export function diagStop(): void {
  armed = false;
  if (ttsUnsub) { ttsUnsub(); ttsUnsub = null; }
  if (sampler != null) { clearInterval(sampler); sampler = null; }
}

/** Build both reports and ask Rust to save them. Returns the paths written. */
export async function diagSave(): Promise<string> {
  const env = await environment();
  // Run the black-page autopsy FIRST, against the live screen. The tester presses Ctrl+Shift+D while
  // the failure is still in front of them, so this measures the failure itself rather than a
  // reconstruction of it — and it must happen before anything else can disturb the DOM.
  const black = autopsy();
  const text = renderText(env, black);
  const json = JSON.stringify(
    {
      env,
      recording: { startedAt: startedAtIso, exportedAt: new Date().toISOString(), durationMs: Date.now() - t0, eventCount: events.length, droppedEarliest: truncatedFrom, complete: truncatedFrom === 0 },
      events,
      analysis: analyse(),
      pdfStages: pdfStages(),
      pdfEarlierAttempts: pdfAttempts(),
      renderStages: renderStages(),
      blackScreen: black,
    },
    null,
    1,
  );
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("diag_save", { text, json })) as string;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sardDiag = { start: diagStart, stop: diagStop, save: diagSave, note: diagNote, events: () => events };
}
