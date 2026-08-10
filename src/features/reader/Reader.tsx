import { useCallback, useEffect, useRef, useState, type CSSProperties, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { pdfAttemptStarted, stageOk } from "@pdfDiag"; // DIAGNOSTIC BUILD ONLY
import { getCurrentWindow } from "@tauri-apps/api/window";

import { setBookCssMode } from "../../reader-engine/FoliateController";
import { FoliateController, type SearchHit, type SelectionInfo, type TocEntry } from "../../reader-engine/FoliateController";
// The reader for THIS platform: the same object as always on Windows, the hosted transport on
// WebKit. This import is the only place the reader's construction differs.
import { createReader, needsReaderHost } from "../../reader-transport";
// DIAGNOSTIC — throwaway branch. Sends the lifecycle trace to stdout via the core, because a
// WebKitGTK console does not reach the terminal the tester is watching.
import { setTraceSink, trace as diagTrace } from "../../reader-transport/trace";
setTraceSink((line) => {
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__?.invoke;
  try { void inv?.("probe_log", { line }); } catch { /* nothing to do about a failing logger */ }
});
import { PhotoComposer } from "../photo/PhotoComposer";
import type { CardData } from "../photo/photo";
import { useReader } from "../../reader-engine/store";
import { parseSectionHref, sectionHref } from "../../reader-engine/sectionHref"; // WP-6A: generated-row hrefs
import { positionReadout } from "../../reader-engine/position";
import { loadBookCssMode } from "../../reader-engine/bookCssSetting"; // WP-7 stage 3 // WP-4F: one place decides the readout
// RAWY-291: PDF reading appearances + the zoom lattice.
import {
  isPdfThemeId, PDF_THEME_KEY, pdfTheme, pdfZoomKey, pdfZoomAttr, parseStoredZoom,
  stepPdfZoom, zoomForWheel, isFitMode, type PdfZoom, type PdfThemeId,
} from "../../reader-engine/pdfView";
import {
  ARABIC_DEFAULTS,
  defaultsForDir,
  PAGE_WIDTH_DEFAULT,
  pageWidthPx,
  type ReadingStyle,
  type RevealLabels,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "../../reader-engine/injectedCss";
import { bookGet, bookRegister, bookSetCoverPng, bookSetExtracted, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
// RESILIENCE-1 / WP-3: the ONE place a book's displayed name is decided (see lib/bookMeta.ts).
import { hintMeta, resolveBookMeta } from "../../lib/bookMeta";
// RESILIENCE-1 / WP-1: every open failure flows through this one classifier + card.
import { classifyBookError, runtimeRefusal } from "../../lib/bookErrors";
import { formatDiagnostics, readDiagnostics, recordDiagnostic, toDiagnostic, type Classified } from "../../lib/errors";
import { canRender, runtimeReport } from "../../lib/runtime";
import { openWebView2Help } from "../../lib/webview2";
import { ErrorCard } from "../../app/ErrorCard";
import { useI18n } from "../../i18n";
import { extractChapterNumber, localeNum } from "../../lib/format";
import { applyTheme, THEMES, useTheme, type ThemeId } from "../../theme";
import {
  clearBookOverride,
  effectiveStyle,
  hasOverride as calcHasOverride,
  loadBookOverride,
  loadGlobalStyle,
  saveBookOverride,
  saveGlobalStyle,
  type BookOverride,
} from "./perBookSettings";
import { useStyleScope } from "../../lib/styleScope";
// RAWY-265 (Phase 3): the page-opacity gate + the desk scrim, both resolved in one place.
import { currentDeskScrim, effectivePageOpacity, useBackground } from "../../lib/background";
import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { PhotoBasketTray } from "./PhotoBasketTray";
import { usePhotoBasket } from "./photoBasket";
import { ChaptersPanel } from "./ChaptersPanel";
import { isOpening } from "./openingState";
import { SearchPanel } from "./SearchPanel";
import { PageBookmark } from "./PageBookmark";
import { useAnnotations } from "./annotationsStore";
import { useReferences } from "./referencesStore"; // RAWY-260: phrase-bound references, per book
import { useBookmarks } from "./bookmarksStore";
import { ReaderChrome, type SettingsSection } from "./ReaderChrome";
import { SettingsPanel } from "./SettingsPanel";
import { useReadMarkerStyle } from "../../lib/readMarkerStyle"; // RAWY-256: the global read-marker variant
import { ReturnPill } from "./ReturnPill"; // RAWY-250: the return-to-reading-position pill
import { TtsPlayer } from "./TtsPlayer";
import { releaseButtonFocusAfterPointerClick, skipSentenceForArrow, useTts } from "../../lib/tts";
import { useChromeOnIntent } from "./useChromeOnIntent";

// The book to open: id (for progress) + absolute file path (for the asset protocol).
export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
  cfi?: string | null; // jump-to location (RAWY-27 inbox); else resume saved progress
  format?: string | null; // RAWY-85 — 'pdf' opens read-only (no themes/annotations); else EPUB
  // RESILIENCE-1 / WP-3 — a HINT, not the source. The reader re-reads the row by id; these only
  // stand in if that read fails, so a launching surface never becomes an authority on the name.
  title?: string | null;
  author?: string | null;
}

const SAVE_DEBOUNCE_MS = 500;

// RESILIENCE-1 / WP-6A: a synthesised contents row targets a SPINE INDEX, not a document href — the
// book has no anchors worth pointing at. The href space lives in reader-engine/sectionHref.ts so that
// every surface that reads an href can recognise one, not just the jump handler.

// RAWY-250: the position the owner was reading before a programmatic jump, plus the chapter label the return
// pill shows ("العودة إلى … · <chapter>") and the section it lived in. A CFI is cross-section, so the anchor
// survives chapter changes for free.
type ReadAnchor = { cfi: string; label: string | null; sec: number };

// RAWY-250: read-chapter history accrues from here on (owner's go-ahead), so RAWY-256's Contents indicator
// has real data the day it lands. The completion rule is "advanced FORWARD out of the chapter" (D66 §4) plus
// "entered at/near its beginning" for the marker (§5). If the rule ever proves wrong, clearing the history is
// a single key delete per book: `chapters_read:<bookId>` (see OPEN).
const RECORD_READ_CHAPTERS = true;

// RAWY-250 (addendum 5): how long after a jump its resulting relocate still counts as JUMP-DRIVEN. foliate
// lands and emits within a frame or two; 1.5 s is far above that and far below any real reading pace, so it
// cannot swallow a genuine page-turn advance.
const JUMP_NAV_WINDOW_MS = 1500;

// RAWY-181 (BUG 1): resolve AFTER the browser has painted (the 2nd rAF runs after the 1st's paint), so a
// synchronous task queued right after runs UNDER the freshly-painted UI instead of blocking a blank frame.
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// RAWY-285: a persisted set of spine-section indices (`chapters_read:<id>` / `seen_start:<id>`). Lifted to
// module scope because `openBook` now reads BOTH sets before the view exists (see the load ordering there),
// and the parse must be identical for both. A corrupt/legacy value means "nothing recorded yet", never a throw.
const parseSecs = (raw: string | null): number[] => {
  try {
    const p = raw ? JSON.parse(raw) : [];
    return Array.isArray(p) ? p.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
};

export function Reader({
  book: initial,
  onExit,
  onOpenBook,
}: {
  book: OpenTarget;
  onExit: () => void;
  /** RAWY-206: open a DIFFERENT book at a locator (the Notes panel's cross-book rows). Goes up to App's
   *  `setOpen` — the same path the Library uses — so the `[initial.id]` effect re-opens at `cfi`. */
  onOpenBook?: (t: OpenTarget) => void;
}) {
  // `uiDir` is the UI LANGUAGE direction (distinct from the book's `dir` below) — RAWY-71 uses it
  // to lay the localized placeholder/reveal widget out in the right direction.
  const { t, lang, dir: uiDir } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  // WINDOWS IS UNCHANGED: the same synchronous construction, available on the first render exactly as
  // before. `needsReaderHost()` is false there, so this line runs and the ref below is never used.
  //
  // On WebKit the reader cannot be built synchronously — the reader host is a document that has to
  // load and hand back a port first. Rather than make every reader of `ctrlRef` cope with null, the
  // promise is created once here and awaited at the ONE place that needs the object before it can do
  // anything: `openBook`. Everything else already guards with `?.`.
  if (!ctrlRef.current && !needsReaderHost()) ctrlRef.current = new FoliateController();
  const hostedRef = useRef<Promise<FoliateController> | null>(null);
  if (!ctrlRef.current && !hostedRef.current) hostedRef.current = createReader();
  // WHEN THE READER EXISTS, as a value effects can depend on.
  //
  // The callbacks below are registered in mount-time effects, and a ref is invisible to React — it
  // cannot re-run anything when it is filled in. On Windows that never mattered: the controller is
  // constructed during this first render, so `true` here and the effects find it. On the hosted path
  // it arrives later, the effects ran once against `null`, and nine of the ten callbacks were never
  // registered at all. MEASURED on real WebKitGTK: all three registration sites reported
  // `ctrlPresent: false`, and a genuine drag across the text produced no selection event.
  //
  // Windows is unchanged by construction: this starts `true` there and never changes, so each effect
  // still runs exactly once, at mount, exactly as before.
  const [readerReady, setReaderReady] = useState(() => ctrlRef.current != null);
  // A dev/debug surface reachable from DevTools without shipping any UI — the same convention as
  // `window.__sardTtsStats`. Lets the TTS-tracking probe measure the REAL pipeline instead of a
  // re-implementation of it that could drift.
  (window as unknown as { __sardTrackStats?: (lang?: string) => unknown }).__sardTrackStats = (lang) =>
    ctrlRef.current?.trackStats(lang);
  // RAWY-292: the same convention for PDF read-aloud — units as the pipeline builds them, plus the
  // text-layer verdict, so extraction QUALITY is measured through the real code.
  (window as unknown as { __sardPdfTts?: (lang?: string) => unknown }).__sardPdfTts = async (lang) => {
    const units = (await ctrlRef.current?.getChapterUnits(lang)) ?? [];
    return {
      units: units.length,
      withRange: units.filter((u) => !!u.range).length,
      text: units.map((u) => u.text).join(" "),
      verdict: ctrlRef.current?.pdfTextQuality() ?? null,
    };
  };
  // RAWY-70: the hide-first-line placeholder/reveal strings that ride into the content frame.
  // RAWY-71: + the UI direction so the confirm row (question · Reveal · Cancel) mirrors correctly.
  const makeRevealLabels = (): RevealLabels => ({
    hidden: t("reader.titleHidden"),
    confirm: t("reader.revealTitleConfirm"),
    reveal: t("reader.reveal"),
    cancel: t("reader.revealCancel"),
    dir: uiDir,
  });

  const bookRef = useRef<string>(initial.id);
  // RAWY-78: cancellation/epoch guard for openBook (audit #3). Each open bumps this and captures
  // the value; after every await it re-checks. A SUPERSEDED open — a newer open started, or this
  // reader unmounted (the effect cleanup bumps it) — bails BEFORE any side effect (module-level
  // applyTheme, the GLOBAL reader store, the shared annotations/bookmarks stores, or ctrl.open on a
  // possibly-null stage). This is the same "is this still current?" identity check FoliateController
  // does for its own view, lifted one layer up to the whole open sequence.
  const openEpoch = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("typography");
  // RAWY-89: Contents + Search share the physical-left, so only ONE is open at a time — a single
  // source of truth makes that structural (no two-setter races; the persisted-open effect can't
  // re-open Contents over a Search the user just opened). `chaptersOpen`/`searchOpen` are derived.
  const [leftPanel, setLeftPanel] = useState<"contents" | "search" | null>(null);
  const chaptersOpen = leftPanel === "contents";
  const searchOpen = leftPanel === "search";
  const [annoOpen, setAnnoOpen] = useState(false);
  const readMarker = useReadMarkerStyle((s2) => s2.marker); // RAWY-256: global choice, applied to the panel
  const [toc, setToc] = useState<TocEntry[]>([]);
  // RAWY-256: href -> spine section index, built ONCE per book (not per row, not per render) from
  // book.sections ids. Feeds the Contents read markers.
  // WP-6A: true when THIS book's contents were built by Sard from the spine (the panel says so).
  const [synthNote, setSynthNote] = useState(false);
  const [tocSecMap, setTocSecMap] = useState<Map<string, number>>(new Map());
  // Bumped whenever a chapter is newly marked read, so the memoised read-href Set recomputes exactly then.
  const [readVersion, setReadVersion] = useState(0);
  const [annoTab, setAnnoTab] = useState<import("./AnnotationsPanel").AnnoTab>("notes");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  // RAWY-162 / RAWY-227: timers for the debounced per-book save of the last-spoken sentence (the resume
  // cursor — a SEPARATE position from the reading CFI). Listen/Play now CONTINUE from that cursor by
  // default (RAWY-227) rather than offering a dismissible 12s prompt.
  const ttsSaveTimer = useRef<number | undefined>(undefined);
  const ttsLastSave = useRef(0);
  // RAWY-186: the LATEST play/pause handler, so the once-registered reading-frame Space callback always
  // calls the current closure (fresh chapter/lang) — no stale capture. Assigned each render below.
  const playRef = useRef<() => boolean>(() => false);
  // RAWY-285: is the book CURRENTLY open a PDF? Same stale-capture guard as `playRef`. The window
  // close-requested handler registers ONCE ([] deps) but must describe the book on screen NOW, not the one
  // this Reader happened to mount with — the Reader is REUSED across books (RAWY-206 cross-book follow).
  const isPdfRef = useRef(false);
  // RAWY-249 (PART 2): latest hideChrome, so the once-registered onRelocate closure (openBook, [] deps) always
  // calls the current hook callback — same stale-capture guard as playRef.
  const hideChromeRef = useRef<() => void>(() => {});
  // RAWY-250: same stale-capture guard as playRef/hideChromeRef — onRelocate is registered ONCE (openBook,
  // [] deps), so it must reach the CURRENT thaw / mark-read closures through refs.
  const thawRef = useRef<() => void>(() => {});
  const markChapterReadRef = useRef<(sec: number) => void>(() => {});
  const markSeenStartRef = useRef<(sec: number) => void>(() => {}); // RAWY-256 (addendum): same stale-capture guard
  // The last spine section index seen by onRelocate. Used to detect a MANUAL chapter change while a
  // read-aloud session sits in the "chapter-end" state (audio finished, the pill/Kashida offered a
  // "next chapter" button) — navigating away in that window must clear the stale offer so the button
  // never points at a chapter the user already left (and a later Play reads the current chapter).
  const lastSectionRef = useRef<number>(-1);
  // RAWY-190: set right before the "next chapter" control navigates, so the resulting onRelocate knows
  // this section change is the EXPECTED outcome of that button (not a manual browse) and does NOT stop
  // read-aloud. Without it, the relocate from the next-chapter advance would trip the chapter-end clear
  // (above) and kill the session before startListen() can begin reading the new chapter.
  const nextChapterArmedRef = useRef(false);
  // RAWY-250: THE READING ANCHOR. A programmatic jump (search hit / highlight / note / TOC / bookmark)
  // captures where the owner was ACTUALLY reading and FREEZES `reading_progress` — foliate fires `relocate`
  // on every view move and nothing else distinguishes "I read here" from "I glanced here" (RAWY-232), so
  // without this a single search costs him his place. ONE-DEEP by the owner's choice: a second jump does NOT
  // overwrite the anchor, it still points at the original reading position. The anchor IS the freeze (one
  // piece of state, so the pill and the freeze can never disagree). `anchorRef` is what the once-registered
  // onRelocate closure reads; `anchorUi` mirrors it for rendering.
  const anchorRef = useRef<ReadAnchor | null>(null);
  const [anchorUi, setAnchorUi] = useState<ReadAnchor | null>(null);
  // RAWY-250 (PART 0.4 / D66): per-chapter tracking for the SHARED end-signal. `atStart` = the chapter was
  // entered at its beginning (a mid-chapter jump must never mark it read); `endOnArrival` = its end-condition
  // was already true when we landed (a chapter shorter than one screen) — that one completes only when the
  // reader LEAVES IT FORWARD, never on arrival; `ended` de-dupes repeated relocates at the end.
  const chapTrackRef = useRef<{ sec: number; atStart: boolean }>({ sec: -1, atStart: false });
  // RAWY-256 (addendum): "I have seen this chapter's BEGINNING" is a fact about the CHAPTER, not about the
  // current visit, so it cannot live in the single-slot tracker above — `beginJump` pre-arms that tracker to
  // the jump target with `atStart: false`, which DESTROYED the fact for the chapter being left. The owner hit
  // exactly that: read N from its start → jumped to a highlight → Returned to N near its end → read on →
  // advanced out, and N was never marked. A per-SESSION SET of section indices whose start has been seen
  // survives any excursion away and back, by ANY route (the Return button, a fresh jump, ordinary
  // navigation), while still excluding a chapter whose beginning was never seen (case 4). Session-scoped
  // deliberately: persisting it across a restart (case 6) is the owner's pending decision, NOT implemented.
  const seenStartRef = useRef<Set<number>>(new Set());
  // RAWY-250 (addendum 5): timestamp of the last JUMP navigation. A thaw may ONLY be caused by a
  // READING-DRIVEN forward advance (page turn / scroll / TTS advancing into the next chapter). A section
  // change caused by a JUMP is NEVER a thaw, in EITHER direction — the previous rule tested only
  // `curSec > track.sec`, so a FORWARD jump (the owner's 140 → 397) self-thawed: it cleared the anchor (pill
  // vanished), wrote progress at the jumped position, and a later jump then installed a fresh anchor there
  // (pill reappeared pointing at the wrong chapter). A timestamp rather than a bare flag so that a jump
  // landing INSIDE the same chapter (no section change, nothing to consume it) cannot poison a genuine
  // advance minutes later.
  const jumpNavAtRef = useRef(0);
  // RAWY-250 (addendum 3): `atStart` is the ONLY geometry still needed — the completion MOMENT is now the
  // forward section change, so `atChapterEnd()` is gone; `atChapterStart()` survives because the read-marker
  // still requires the chapter to have been entered at/near its beginning.
  // RAWY-250 (PART 4): the set of chapters (spine section indices) read to the end, per book. Persisted in the
  // existing settings key/value table (`chapters_read:<bookId>`) — additive, no schema migration (D66).
  // NOTE (RAWY-250 PART 4, half 2): the read-chapter SET is recorded and persisted from this session on, so
  // the history exists by the time the Contents indicator lands; the indicator UI itself (6 variants +
  // chooser) is NOT built yet — see OPEN. Nothing here renders it, so there is no half-built control.
  const readChaptersRef = useRef<Set<number>>(new Set());
  // RAWY-82 (#15): rAF-batch the live style apply during a slider drag — hold the latest style and
  // apply it at most once per frame (persistence stays on the 500ms debounce below).
  const styleRafRef = useRef<number | null>(null);
  const pendingStyleRef = useRef<ReadingStyle | null>(null);
  // Per-book settings (RAWY-40): the global reading defaults (baseline), this book's PARTIAL
  // override, and the global theme captured on entry (restored to the chrome on exit).
  const globalStyleRef = useRef<ReadingStyle | null>(null);
  const overrideRef = useRef<BookOverride>({});
  // The LIBRARY theme captured on entry, restored to the chrome on exit (RAWY-48/D29 — the
  // Library has its OWN theme, independent of any book/unified theme).
  const libraryThemeRef = useRef<ThemeId>(useTheme.getState().themeId);
  const [bookThemeId, setBookThemeId] = useState<ThemeId>(useTheme.getState().bookThemeId);
  const [hasOv, setHasOv] = useState(false);
  const [photoCard, setPhotoCard] = useState<CardData | null>(null); // RAWY-49 Photo Mode composer
  const [devCardFont, setDevCardFont] = useState<string | null>(null); // RAWY-81 DEV capture only
  const [basketOpen, setBasketOpen] = useState(false); // RAWY-60 passages tray
  const basketCount = usePhotoBasket((s) => s.passages.length);
  const ttsActive = useTts((s) => s.active); // RAWY-105: read-aloud player visible?
  const ttsIndex = useTts((s) => s.index); // RAWY-126: current spoken sentence (drives the spotlight)
  const ttsStatus = useTts((s) => s.status); // RAWY-126: playing vs paused (paused keeps, doesn't follow)
  const ttsWords = useTts((s) => s.words); // RAWY-127: the sentence's Edge word timings ([] = none)
  const ttsWordIndex = useTts((s) => s.wordIndex); // RAWY-127: active word (drives the karaoke pill)

  const { status, dir, cfi, fraction, chapterLabel, chapterHref, error, style, bookTitle, location, pageLabel } = useReader();
  // The book is still being opened — the page has nothing to show, and the contents are not yet
  // known. Both surfaces below read this ONE value so they can never disagree; see openingState.ts
  // for why an empty TOC cannot answer the question by itself.
  const opening = isOpening(status);
  // DIAGNOSTIC — throwaway branch. The page indicator's whole lifetime, timestamped, so it can be
  // compared against the engine's own open() duration rather than eyeballed from a screenshot.
  useEffect(() => {
    diagTrace("PAGE     opening indicator", { opening, status });
  }, [opening, status]);
  // RAWY-43: unified (all books share one style) vs per-book. Drives where changes are written
  // and how a book's effective style/theme is resolved.
  const scope = useStyleScope((s) => s.scope);
  // RAWY-41: the current book's bookmarks; the marker shows ONLY in the bookmark's chapter.
  // RAWY-229 (corrected): a bookmark is a per-CHAPTER mark — its marker shows anywhere in that chapter, at
  // any scroll position (top to bottom), and hides only when the reader LEAVES the chapter. `bookmarkVisible`
  // compares SECTION identity (not the visible range, not a whole-book fraction window — which lit the
  // marker in every chapter of a long book). `cfi` changes on each relocate, so this recomputes as we move.
  const bookmarks = useBookmarks((s) => s.bookmarks);
  const activeBm = bookmarks.find((b) => ctrlRef.current?.bookmarkVisible(b.cfi, cfi)) ?? null;
  // THEME is per-book (RAWY-40) — read from `bookThemeId`, not the global store. Override-book-
  // colour + hide-chapter-titles stay GLOBAL flags. RAWY-216: Reader only READS them now (to inject
  // the CSS); the setters live where the controls do — the drawer's "All books" tab / Global Settings.
  const { overrideBookColor, hideChapterTitles, hideFirstLine, immersive } = useTheme();
  // RAWY-265 (Phase 3): the effective page opacity + the desk scrim in force. Both ride the EXISTING
  // applyTheme(theme, flags) channel rather than new plumbing, and both are 1 unless a reading
  // background is genuinely showing — so an untouched profile passes exactly what it passed before.
  const pageOpacity = useBackground((s) => effectivePageOpacity(s));
  const deskScrim = useBackground((s) => currentDeskScrim(s));
  const { visible: chromeVisible, scrolledAway, signalMove, signalScroll, setHold, hideChrome } = useChromeOnIntent();
  // RAWY-194 (C): the chrome no longer wakes on bare keystrokes. A keyboard user still reaches it: when Tab
  // moves focus INTO the chrome (its controls stay in the tab order), reveal + PIN it — the genuine "I want
  // the toolbar" intent — and release when focus leaves. This also stops focus landing on an aria-hidden
  // control (ReaderChrome sets aria-hidden while the bar is hidden). The pill is a sibling of the chrome, so
  // focusing a transport button never trips this.
  const [chromeFocused, setChromeFocused] = useState(false);

  // RESILIENCE-1 / WP-1: one exit for every failed open — classify, RECORD, then show. Recording is
  // unconditional and fire-and-forget: a compatibility problem reported weeks later has to be
  // diagnosable without asking the reader to reproduce it (principle 5).
  const failOpen = useCallback((classified: Classified) => {
    recordDiagnostic(toDiagnostic("book-open", classified));
    useReader.getState().set({ status: "error", error: classified });
  }, []);

  // The Details block: this failure PLUS the recorded history and the runtime report. A single
  // paste that answers "what broke, on what machine, and had it broken before" (principle 5).
  const [diagText, setDiagText] = useState("");
  useEffect(() => {
    if (status !== "error") return;
    void readDiagnostics().then((entries) => setDiagText(formatDiagnostics(entries, runtimeReport())));
  }, [status]);

  const openBook = useCallback(async (target: OpenTarget) => {
    const set = useReader.getState().set;
    // RAWY-78: supersede any in-flight open and capture THIS invocation's epoch. `stale()` turns
    // true once a newer open starts or this reader unmounts — re-checked after every await so a
    // superseded continuation bails before touching any shared state.
    const epoch = ++openEpoch.current;
    const stale = () => openEpoch.current !== epoch;

    // RESILIENCE-1 / WP-1 — PRE-FLIGHT. Refuse before attempting, when the refusal is already known.
    // A PDF on a runtime without PDF.js's required features cannot open, and letting it try only
    // buys a slower failure with a worse message. Checking the CAPABILITY (not a version, not the
    // eventual exception text) keeps this correct even if a future engine changes what it throws.
    const preflightFormat = (target.format ?? "epub").toLowerCase();
    if (!canRender(preflightFormat === "pdf" ? "pdf" : "epub")) {
      bookRef.current = target.id;
      failOpen(runtimeRefusal(preflightFormat, { bookId: target.id }));
      return;
    }

    try {
      bookRef.current = target.id;
      set({ status: "loading", bookId: target.id });

      // RAWY-285: THIS FUNCTION IS THE SINGLE OWNER OF PER-BOOK SESSION STATE.
      //
      // The Reader instance is REUSED across books: App holds one `<Reader>` and a cross-book follow
      // (RAWY-206, the Notes/Bookmarks rows) only changes `initial.id`, so React re-runs this open
      // WITHOUT remounting — deliberately, because the Notes panel must survive the follow (see
      // AnnotationsPanel's `currentBookId` snap-back). That makes every ref below a per-book fact living
      // on a component that outlives the book, and anything not cleared here LEAKS into the next book.
      //
      // Measured, not theorised (RAWY-285 investigation, real release build + real DB): a cross-book
      // follow wrote book A's read-chapter set under book B's key — 96 recorded chapters replaced by A's
      // five — because `chapTrackRef`/`seenStartRef`/`readChaptersRef` still described A when B's first
      // relocate arrived; and A's return-anchor stayed live, freezing B's `reading_progress` entirely.
      // One reset, listed in one place, is what stops a future per-book field being forgotten again.
      lastSectionRef.current = -1;      // "no previous section yet" — re-arms the prevSec !== -1 guards
      chapTrackRef.current = { sec: -1, atStart: false }; // sec < 0 ⇒ the completion rule cannot fire
      seenStartRef.current = new Set(); // replaced by THIS book's persisted set below, before the view exists
      readChaptersRef.current = new Set();
      jumpNavAtRef.current = 0;
      nextChapterArmedRef.current = false;
      anchorRef.current = null;         // RAWY-250: an anchor belongs to the book it was taken in
      setAnchorUi(null);
      setSearchQuery("");               // book A's hits are meaningless CFIs in book B
      setActiveHitCfi(null);
      setPdfPageCount(0);

      // DIAGNOSTIC BUILD ONLY — stages 1-4 of the PDF ledger. Observation only.
      pdfAttemptStarted({
        bookId: target.id,
        filePath: target.filePath,
        format: target.filePath?.toLowerCase().endsWith(".pdf") ? "pdf" : "other",
        title: target.title ?? null,
      });
      stageOk("library.row", { bookId: target.id });
      stageOk("path.resolved", { filePath: target.filePath, length: target.filePath?.length ?? 0 });

      const url = convertFileSrc(target.filePath);
      stageOk("asset.url", { assetUrl: url, scheme: (() => { try { return new URL(url).protocol + "//" + new URL(url).host; } catch { return "UNPARSEABLE"; } })() });

      await bookRegister(target.id, target.filePath);
      if (stale()) return;

      // RESILIENCE-1 / WP-3 — READ THE AUTHORITATIVE ROW, once, here.
      //
      // The reader is launched from four surfaces (library card, inbox, bookmarks shelf, a cross-book
      // note jump) and only the library card ever held a full row, so a caller-supplied title would be
      // right on one path and absent on three. Asking the database by id makes every path identical.
      // A failure here is NOT fatal: the book still opens, and the chrome falls back to the hint the
      // caller passed (`target.title`) — a missing name must never cost the reader their book.
      let meta = await bookGet(target.id)
        .then((row) => (row ? resolveBookMeta(row) : null))
        .catch(() => null);
      if (stale()) return;
      if (!meta && (target.title || target.author)) meta = hintMeta(target.id, target.title, target.author);
      set({ bookTitle: meta?.title ?? null, bookAuthor: meta?.author ?? null, bookScript: meta?.script ?? null });
      const saved = await progressGet(target.id);
      if (stale()) return;
      // RAWY-85: a PDF is fixed-layout — it has a page index, not a CFI. It resumes by FRACTION and
      // gets none of the EPUB typography/annotation machinery.
      const targetIsPdf = (target.format ?? "").toLowerCase() === "pdf";
      isPdfRef.current = targetIsPdf; // RAWY-285: the close flush reads this, not its mount-time capture
      // RAWY-27: an inbox item passes a jump CFI that wins over the saved reading position.
      const resumeCfi = target.cfi ?? (targetIsPdf ? null : saved?.cfi) ?? null;
      const resumeFraction = targetIsPdf ? (saved?.fraction ?? null) : null;

      // RAWY-40/43: per-book → effective = GLOBAL defaults with THIS book's PARTIAL override on
      // top, theme = override theme else global. UNIFIED → the GLOBAL style/theme, IGNORING (never
      // deleting) the override so switching back to per-book restores it. RAWY-176 (AUD-6): the
      // saved global row loads OVER this book's DIRECTION baseline (loadGlobalStyle(target.dir)), so
      // any field the row lacks falls back to the Arabic baseline for an RTL book — on a fresh
      // install (no row) an Arabic book now opens at zoom 1.15 / line-height 1.9 / start, not Latin.
      const ts = useTheme.getState();
      const unified = useStyleScope.getState().scope === "unified";
      // RESILIENCE-1 / WP-7 (stage 3): tell the engine what this book's own stylesheet may contain,
      // BEFORE `ctrl.open()` — the sanitiser hook runs while the book's resources are being loaded,
      // so the mode has to be current by then. Ships `off`, so today this loads a setting whose value
      // makes the sanitiser return an empty sheet.
      setBookCssMode(await loadBookCssMode());
      if (stale()) return;
      const global = await loadGlobalStyle(target.dir ?? undefined);
      if (stale()) return;
      const override = await loadBookOverride(target.id);
      // Guards the block below — the ref writes, module-level applyTheme, and ctrl.open (which would
      // otherwise run on a null/superseded stage and throw A's error onto B).
      if (stale()) return;
      libraryThemeRef.current = ts.themeId; // restore this to the chrome on exit
      globalStyleRef.current = global;
      overrideRef.current = override;

      // RAWY-285: EVERY per-book persisted value is loaded HERE — before `onRelocate` is registered and
      // before `ctrl.open()`, which is the first moment the engine can emit a position.
      //
      // ORDERING IS THE WHOLE FIX. These four reads used to sit AFTER `ctrl.open()` (and after three more
      // awaits), while the relocate handler that CONSUMES and RE-PERSISTS the two sets was already live.
      // `markSeenStart`/`markChapterRead` write the WHOLE in-memory set, so a relocate landing in that
      // window persisted an EMPTY set over the stored one. Measured on the real build, three times: a
      // seeded `[1..9]`, `[7,8,9]` and `[3..9]` each came back as a single-element set after ONE open —
      // and the same call site, exercised once loading had finished, correctly merged (`[1]` → `[1,6]`).
      // Nothing here depends on the view, so the reads simply belong before it. No flag, no guard, no
      // deferral of the handler: the data is just present before anything can read it.
      const [readRaw, seenRaw, spoilerRaw, invertRaw, pdfThemeRaw, pdfZoomRaw] = await Promise.all([
        settingsGet(`chapters_read:${target.id}`).catch(() => null),
        settingsGet(`seen_start:${target.id}`).catch(() => null),
        settingsGet(`spoiler_safe:${target.id}`).catch(() => null),
        settingsGet(`pdf_invert:${target.id}`).catch(() => null),
        // The PDF appearance is a READING preference, so it is global like the book theme — a reader
        // who wants sepia wants it for every PDF. Zoom is the opposite: it belongs to the document,
        // because the right magnification depends on that file's page size and scan quality.
        settingsGet(PDF_THEME_KEY).catch(() => null),
        settingsGet(pdfZoomKey(target.id)).catch(() => null),
      ]);
      if (stale()) return;
      // RAWY-250 (PART 4) / RAWY-256 (addendum, case 6): the read-chapter set and the "beginning seen" set,
      // both per book, both plain settings rows (additive, no migration). An absent key = nothing recorded.
      readChaptersRef.current = new Set(parseSecs(readRaw));
      seenStartRef.current = new Set(parseSecs(seenRaw));
      setReadVersion((v) => v + 1); // RAWY-256: publish the loaded set to the Contents markers
      // RAWY-285: the two per-book PREFERENCES that used to be read by their own `[]`-dep effects. Those
      // effects ran once per Reader MOUNT, so a cross-book follow silently kept the previous book's answer
      // (measured: a book whose spoiler-safe was stored OFF opened with it ON via the cross-book route and
      // OFF via the Library route — same book, same stored value). Loading them on the same path as every
      // other per-book value removes the second lifecycle rather than adding a second reset.
      setSpoilerSafe(spoilerRaw !== "0"); // default ON (design §5)
      // A reader who had chosen "inverted" before themes existed keeps a dark page: the old boolean is
      // honoured once, as "night", and only when no theme has been chosen since. Nobody's setting is
      // silently discarded, and nobody who never used invert gets a dark theme they did not ask for.
      setPdfThemeId(isPdfThemeId(pdfThemeRaw) ? pdfThemeRaw : invertRaw === "1" ? "night" : "normal");
      setPdfZoom(parseStoredZoom(pdfZoomRaw) ?? "fit-page");
      // The book's theme comes from the shared BOOK theme (D29), NOT the Library theme:
      // unified → the shared book theme; per-book → this book's override, else the shared book theme.
      const bookDefault = ts.bookThemeId;
      const effTheme = unified ? bookDefault : (override.themeId ?? bookDefault);
      let initialStyle = unified ? global : effectiveStyle(global, override);

      // RESILIENCE-1 / WP-6B — a FRAGMENTED spine defaults to SCROLLED flow.
      //
      // MEASURED across the corpus: exactly one book qualifies — `word-generated--unknown-title`,
      // 116 sections whose median is under 4 KB. foliate paginates strictly per section and
      // `expand()` pads each one up to a whole page (paginator.js:381), so in PAGED mode those 116
      // arbitrary breaks become 116 mostly-blank pages. In SCROLLED mode they are invisible.
      // The 1433-section Calibre book is deliberately NOT caught: its sections are large enough that
      // the breaks are real chapter boundaries — the flag tests the median, not the count.
      //
      // A DEFAULT, not a lock: it applies only when this book has no saved flow of its own, so a
      // reader who chooses paged keeps paged, on this book, for ever. The global preference is left
      // alone — one degenerate book must not change how every other book opens.
      if (meta?.spineFragmented && !unified && override.style?.flowMode == null) {
        initialStyle = { ...initialStyle, flowMode: "scrolled" };
      }

      diagTrace("APP      openBook reached the reader binding");
      // On the hosted path this is the first moment the reader is actually needed, and the awaits
      // above have already given the host time to load. On Windows `ctrlRef.current` was assigned
      // during the first render and this resolves to it without awaiting anything.
      if (!ctrlRef.current && hostedRef.current) {
        ctrlRef.current = await hostedRef.current;
        setReaderReady(true); // the effects below depend on this and register on the next render
      }
      diagTrace("APP      reader bound", { hosted: !!hostedRef.current, readerReadyFlipped: true });
      if (stale()) return;
      const ctrl = ctrlRef.current!;
      ctrl.onRelocate(({ cfi, fraction, chapterLabel, chapterHref, location, pageLabel }) => {
        // WP-4F: `location`/`pageLabel` are foliate's own position data, which used to be dropped here.
        set({ cfi, fraction, chapterLabel, chapterHref, location, pageLabel });
        // RAWY-190: if read-aloud finished a chapter (status "chapter-end") and the user navigated to a
        // DIFFERENT section, the stale "next chapter" offer no longer applies (its button would advance
        // from the chapter on screen, which is now the one the user moved to — not the finished one). Stop
        // the session cleanly so the pill AND the kashida drop the offer; a later Play restarts on the
        // current chapter. EXCEPTION: the "next chapter" control's OWN advance also relocates here — it
        // arms `nextChapterArmedRef` first so we consume the flag and DON'T stop the session it's handing
        // to startListen (without this, the legit advance would kill its own session — the WIP race).
        const curSec = ctrl.currentSectionIndex();
        const prevSec = lastSectionRef.current;
        const tts = useTts.getState();
        if (nextChapterArmedRef.current) {
          nextChapterArmedRef.current = false;
        } else if (tts.active && tts.status === "chapter-end" && prevSec !== -1 && curSec !== prevSec) {
          // RAWY-190: hide the stale "next chapter" offer but KEEP the player (dismissEnd, not stop) — the
          // bead/transport stays and a later Play reads the CURRENT chapter (scenario B). A full stop would
          // remove the kashida bead entirely, leaving no way to play from the minimized state.
          tts.dismissEnd();
        }
        lastSectionRef.current = curSec;
        // RAWY-249 (PART 2): a NEW chapter that landed at/near its TOP leaves the opening under the 70px bar
        // (scrolled flow pins page-host inset 0 — RAWY-142, so we can NOT scroll it clear: nothing sits above
        // a section top). Hide the bar so the opening is fully visible — a fade over stationary text (inset
        // untouched → no RAWY-142 jump), no overshoot (we don't scroll past the opening). Correct whether the
        // bar was shown (→ hides) or already hidden (→ no-op). Gated on a real section CHANGE + near-top, so
        // mid-chapter scrolls, resumes and fragment-jumps (which land below the bar) are untouched.
        if (prevSec !== -1 && curSec !== prevSec && ctrl.openingUnderTopBar()) hideChromeRef.current();
        // RAWY-250 (PART 0.4 / PART 2 / PART 4, D66): ONE end-signal, TWO different questions. THAW asks
        // "is he reading HERE now?"; the READ MARKER asks "has he consumed this chapter's WHOLE content?".
        // A mid-chapter jump then read-to-the-end answers YES to the first and NO to the second, so the
        // marker carries one EXTRA condition (entered at the beginning) and is therefore always a SUBSET of
        // thaw — which is why a chapter can never be marked read while progress says he never got there.
        if (!targetIsPdf) {
          const track = chapTrackRef.current;
          if (curSec !== track.sec) {
            // COMPLETION = ADVANCING FORWARD OUT OF A CHAPTER (owner's definition, addendum 3) — arrival is
            // never completion, so there is no longer a short-chapter special case and no end-geometry test.
            // ONE rule, two questions: advancing forward THAWS (he is reading here), and additionally MARKS
            // READ only if the chapter was also ENTERED AT ITS BEGINNING — entered mid-way by a jump then
            // advanced out of thaws but is NOT read (he never saw the first half), so marker ⊂ thaw holds.
            // Going BACKWARD or jumping sideways out of a chapter completes nothing. A TTS chapter advance is
            // the same forward section change — one signal, no separate notion.
            // RAWY-250 (addendum 5): ONLY a READING-DRIVEN advance completes a chapter. A jump-driven
            // section change (search / highlight / note / bookmark) is never a thaw and never a completion,
            // in EITHER direction — otherwise a forward jump self-thaws, destroying the anchor AND writing
            // progress at the jumped position.
            const jumpDriven = performance.now() - jumpNavAtRef.current < JUMP_NAV_WINDOW_MS;
            jumpNavAtRef.current = 0; // consumed by the section change it caused
            if (!jumpDriven && track.sec >= 0 && curSec > track.sec) {
              // RAWY-256 (addendum): consult the DURABLE per-book set, not the transient tracker. The
              // tracker is a single slot that `beginJump` overwrites with `atStart:false` when the reader
              // jumps away, so a chapter entered at its start and returned to (case 2) or re-entered
              // mid-way (case 3) had lost the fact and could never be marked. The set still EXCLUDES a
              // chapter whose beginning was never seen (case 4) — that exclusion is the point.
              if (seenStartRef.current.has(track.sec)) markChapterReadRef.current(track.sec);
              thawRef.current();
            }
            // Record "I have seen this chapter's beginning" whenever a section change LANDS at a start —
            // by ordinary advance, a TOC click, or a resume that lands at the top. Durable for the book
            // (case 6), so closing the app mid-chapter does not forfeit a chapter genuinely read.
            const landedAtStart = ctrl.atChapterStart();
            if (landedAtStart) markSeenStartRef.current(curSec);
            chapTrackRef.current = { sec: curSec, atStart: landedAtStart };
          }
        }
        if (progressTimer.current) clearTimeout(progressTimer.current);
        // RAWY-250 (PART 1): while the anchor holds (a jump is being previewed), the reader's REAL position
        // must stay untouched in the row — so resume-on-open still lands where he was actually reading.
        // Every other write path is unchanged; the freeze ends via the pill's × or the end-signal above.
        if (anchorRef.current) return;
        progressTimer.current = window.setTimeout(() => {
          // RAWY-85: a PDF has no CFI — persist it by fraction (empty cfi) so it still resumes.
          if (cfi || targetIsPdf) progressSave(bookRef.current, cfi ?? "", fraction).catch(console.error);
        }, SAVE_DEBOUNCE_MS);
      });

      // The whole reader (chrome + page) takes the book's effective theme while reading; the
      // Library keeps the global default (restored on exit). The global store is NOT mutated.
      applyTheme(THEMES[effTheme]);
      await ctrl.open(url, stageRef.current!, {
        resumeCfi,
        resumeFraction, // RAWY-85: PDFs resume by page fraction
        style: initialStyle,
        theme: THEMES[effTheme],
        flags: { overrideBookColor: ts.overrideBookColor, hideChapterTitles: ts.hideChapterTitles, hideFirstLine: ts.hideFirstLine, pageOpacity: effectivePageOpacity(), deskScrim: currentDeskScrim() },
        dir: target.dir ?? undefined, // RAWY-85: a PDF's manual RTL override lives in books.dir too
        flow: initialStyle.flowMode, // scrolled (default) or paged — RAWY-25
        revealLabels: makeRevealLabels(), // RAWY-70
      });
      // Superseded during the (async) open → don't publish ready/toc or bind the shared stores; the
      // newer open owns them now.
      if (stale()) return;

      setBookThemeId(effTheme);
      setHasOv(!unified && calcHasOverride(override)); // Reset is a per-book affordance
      // RESILIENCE-1 / WP-3 — the DATABASE names this book, not the file.
      //
      // `bookTitle` used to be `ctrl.title`: foliate's `dc:title`, straight out of the EPUB. That made
      // the reading chrome, the note card and every shared photo card disagree with the library the
      // moment a reader renamed a book — proven in the owner's own library, where `cd27ab1d` reads
      // "Lord Of The mysteries" on the shelf and showed the embedded "لورد الغوامض" in the reader.
      // `meta` is the row this reader fetched by id (see the open above), so all five surfaces now
      // resolve from the same COALESCE'd value.
      set({
        status: "ready",
        dir: ctrl.dir ?? "?",
        style: initialStyle,
        bookTitle: meta?.title ?? null,
        bookAuthor: meta?.author ?? null,
        bookScript: meta?.script ?? null, // WP-5A: what the read-aloud pre-flight gates on
      });
      if (targetIsPdf) setPdfPageCount(ctrl.pdfPageCount); // RAWY-87: total pages for the position readout
      diagTrace("APP      after open", { dir: (ctrl as unknown as { dir?: string }).dir ?? null, toc: ctrl.getToc().length, pdfPages: (ctrl as unknown as { pdfPageCount?: number }).pdfPageCount ?? null });
      setToc(ctrl.getToc()); // chapters panel (RAWY-21)
      setTocSecMap(ctrl.tocHrefSectionMap()); // RAWY-256: one pass, reused by every marker render
      // RESILIENCE-1 / WP-6A: this book's own contents are useless (WP-2 measured it). Build a usable
      // index from the spine instead — off the critical path, so the book is already readable while
      // it runs, and only for a flagged book so no well-formed book pays for it.
      setSynthNote(false);
      if (meta?.tocDegenerate && !targetIsPdf) {
        // WP-6B — BEFORE generating anything, ask the book again.
        //
        // `tocDegenerate` means "the contents the engine chose are too small for this spine". It does
        // NOT mean the book has no contents: an EPUB 3 file may carry a useless navigation document
        // and a complete NCX, and the engine only falls back to the NCX when the navigation document
        // yields nothing at all. Measured on the three reported books — 1 nav entry beside 2963 / 529
        // / 362 NCX entries that resolve 100% of the linear spine, with the book's real chapter names.
        //
        // The test is a COMPARISON, not a threshold: adopt the NCX only when it offers strictly more
        // destinations than what is displayed. That can only increase navigability, it needs no tuned
        // constant, and it leaves books whose NCX is no better (the Word conversions, whose NCX holds
        // one entry and which the engine already uses) on exactly the path they take today.
        //
        // Generating from the spine stays the LAST resort, unchanged, for books with no better source.
        void (async () => {
          const ncx = await ctrl.getNcxToc();
          if (stale()) return;
          const shown = ctrl.getToc().length;
          if (ncx.length >= 2 && ncx.length > shown) {
            setToc(ncx);
            setTocSecMap(ctrl.tocHrefSectionMap(ncx)); // the map must describe the list actually shown
            return; // authored contents — nothing is generated, and no note is shown
          }
          const synth = await ctrl.getSynthesisedToc();
          if (stale() || !synth || !synth.entries.length) return;
          applySynthesised(synth);
        })();
      }
      // The LAST resort, unchanged from WP-6A: contents generated from the spine.
      function applySynthesised(synth: { entries: { label: string | null; ordinal: number; index: number }[] }) {
          // A section with no heading is NUMBERED, never named from its text. The number is the
          // section's position in the linear spine, so it says where the reader is and nothing more.
          // The generated rows REPLACE the book's own contents, so the href→section map must describe
          // THEM. Left as it was, `tocSecMap` still held the book's unusable native hrefs — keys that
          // appear nowhere in the TOC being displayed — so every lookup keyed by a displayed row's
          // href missed: the nearest-preceding fallback in `tocIndex` and the read-chapter markers in
          // `readHrefs`, which are built by walking this map.
          //
          // Stated precisely, because it was mutation-tested: removing this line does NOT break the
          // active highlight on the measured book (that resolves by another route and still passes
          // 6/6), so this is not the fix for the highlight and is not claimed to be. It is here
          // because a map keyed by hrefs the TOC no longer contains is wrong state whatever currently
          // depends on it.
          setTocSecMap(new Map(synth.entries.map((e) => [sectionHref(e.index), e.index])));
          setToc(
            synth.entries.map((e) => ({
              // "Chapter N", not "Section N". These ARE spine sections internally, but the Contents
              // panel is a NAVIGATION surface and "Chapter" is what a reader of a novel expects. The
              // label claims nothing about the file — it never asserts the book contained this title,
              // it just names a place to go. `panel.chapter` already exists for exactly this row.
              label: e.label ?? t("panel.chapter", { n: localeNum(e.ordinal, lang) }),
              href: sectionHref(e.index),
              level: 0,
            })),
          );
          setSynthNote(true);
      }
      // WP-4D: opening a book is the first navigation action, and it never claimed focus — measured,
      // a freshly opened book had focus on <body>, so the very first arrow key did nothing. This is
      // the state a reader meets before any other, which is why it produced the loudest report.
      restoreReadingFocus();

      // RAWY-85: enrich a PDF's real title/author (PDF.js getMetadata) + a page-1 cover (getCover)
      // ONCE — import stored only the filename + no cover. The library reflects it on next visit.
      if (targetIsPdf) {
        const done = await settingsGet(`pdf_meta:${target.id}`).catch(() => null);
        if (!done && !stale()) {
          const t = ctrl.title;
          // RESILIENCE-1 / WP-3D — this is an EXTRACTION, so it writes the extraction columns.
          //
          // It used to call `bookUpdate`, which writes `metadata_overrides` — the table that means
          // "the reader typed this". A PDF opened after being renamed would therefore have its
          // override silently replaced by whatever PDF.js found in the file, and the rename would be
          // unrecoverable because the original was gone. `bookSetExtracted` writes the base columns
          // and only where they are still empty, so a reader's title always wins through COALESCE.
          if (t && t.trim()) await bookSetExtracted(target.id, t, ctrl.author).catch(console.error);
          const bytes = await ctrl.getCoverBytes();
          if (bytes && bytes.byteLength) await bookSetCoverPng(target.id, bytes).catch(console.error);
          await settingsSet(`pdf_meta:${target.id}`, "1").catch(() => {});
        }
      }

      // RESILIENCE-1 / WP-3 — CLOSE THE EXTRACTION GAP, don't paper over it in the view.
      //
      // A row can reach here with no title: imported before WP-2's tolerant decoder existed, or with
      // an OPF that the old parser could not read. The tempting fix is to fall back to `ctrl.title`
      // when displaying — but that puts the file back in the display path and the library keeps
      // showing nothing, so the two surfaces disagree again. Instead the value foliate extracted goes
      // INTO the database (base columns only, never over an override) and is displayed FROM it. The
      // library agrees on its next visit, and the row heals itself permanently on first open.
      const needTitle = !meta?.title && !!ctrl.title?.trim();
      const needAuthor = !meta?.author && !!ctrl.author?.trim();
      if (needTitle || needAuthor) {
        const healed = await bookSetExtracted(
          target.id,
          needTitle ? ctrl.title : null,
          needAuthor ? ctrl.author : null,
        ).catch(() => null);
        if (stale()) return;
        if (healed) {
          meta = resolveBookMeta(healed);
          set({ bookTitle: meta.title, bookAuthor: meta.author });
        }
      }
      // Load this book's highlights/notes into the shared store (in-context layer + panel).
      useAnnotations.getState().bind(ctrl, target.id);
      await useAnnotations.getState().load();
      if (stale()) return;
      useBookmarks.getState().load(target.id); // RAWY-41 — this book's saved locations
      // RAWY-260: this book's references, loaded ONCE here and held in memory. The controller re-marks each
      // section from that set as it renders — no per-section query, and the book is never rescanned.
      useReferences.getState().bind(ctrl, target.id);
      await useReferences.getState().load();
      // RAWY-285: the read-chapter / beginning-seen sets and the two per-book preferences used to be read
      // HERE, after the view was already emitting relocates. They are now loaded before `ctrl.open()` —
      // see the ordering note above. Nothing replaces them at this point.
    } catch (e) {
      // A SUPERSEDED open's error (e.g. ctrl.open on a null stage after unmount) must NOT flip the
      // current book into the error overlay — only report a failure that belongs to the live open.
      if (stale()) return;
      // RESILIENCE-1 / WP-1: THE single classification point for a failed open. Was `String(e)`,
      // which printed engine internals straight into the card with only "Try again" beneath them.
      failOpen(classifyBookError(e, { bookId: target.id, format: target.format, stage: "open" }));
    }
  }, []);

  useEffect(() => {
    openBook(initial);
    return () => {
      // RAWY-78: supersede any in-flight open so its continuation bails after its next await instead
      // of running applyTheme/ctrl.open/set() against the disposed controller + null stage.
      openEpoch.current++;
      if (progressTimer.current) clearTimeout(progressTimer.current);
      if (ttsSaveTimer.current) clearTimeout(ttsSaveTimer.current);
      // RAWY-162: persist the last-spoken sentence for THIS book BEFORE stop()+dispose() (RAWY-155
      // stops audio on exit; this remembers where to offer a resume next time). Guarded by `active`.
      if (useTts.getState().active) {
        const cur = ctrlRef.current?.getTtsCursor(useTts.getState().index);
        if (cur) settingsSet(`tts_position:${initial.id}`, JSON.stringify(cur)).catch(() => {});
      }
      if (styleRafRef.current) cancelAnimationFrame(styleRafRef.current); // RAWY-82: drop a pending live-apply frame
      if (zoomRaf.current) { cancelAnimationFrame(zoomRaf.current); zoomRaf.current = 0; } // and a pending Ctrl+Wheel step
      // RAWY-286: `destroy()`, not `dispose()`. This cleanup is the LEAVE-THE-BOOK path (unmount, or
      // `initial.id` changing on a cross-book follow), so the read-aloud ranges must go too — they hold
      // `Range`s into the outgoing chapter's document and were measured pinning it for the whole session.
      // `open()` keeps calling plain `dispose()`, which is what preserves RAWY-129's same-book re-open.
      // Ordering matters and is already correct: `getTtsCursor` above reads `ttsUnits` BEFORE this runs.
      ctrlRef.current?.destroy();
      // RAWY-155: read-aloud is a per-reading-session activity — leaving the book (Back to Library,
      // opening a different book, the error screen — every exit unmounts the Reader or changes
      // `initial.id`) must STOP it completely. `useTts.stop()` halts playback + the
      // WebAudio context, cancels the synth queue (gen++ so no late sentence fires) and the karaoke
      // RAF, drops the warm Edge connection, and resets the pill/store. Without this the module-level engine
      // (which lives outside the component tree) keeps playing into the Library and the next book.
      useTts.getState().stop();
      // The photo-card basket is a per-reading-session collection (RAWY-60) — clear it on exit.
      usePhotoBasket.getState().clear();
      // Restore the LIBRARY theme to the chrome on exit (RAWY-40/48) — the book theme was only
      // for this reading session; the Library shows its own independent theme again.
      applyTheme(THEMES[libraryThemeRef.current]);
    };
    // Open the book the Library handed us; re-open if the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  // RAWY-173 (AUD-10): the reading position is saved on a 500 ms debounce and the TTS resume cursor on a
  // ~2 s throttle; React cleanup does NOT run when the OS window is closed, so closing mid-read would lose
  // the last position tick + the last-spoken sentence. On the window's close-requested, FLUSH both
  // (the SAME values the debounced saves compute) before the app tears down, then close.
  //
  // RAWY-174 (regression fix): registering an onCloseRequested handler makes the window's close depend on
  // a JS `destroy()` (the @tauri-apps/api handler auto-destroys when NOT prevented; we preventDefault to
  // flush first, so WE must destroy). `destroy()` needs `core:window:allow-destroy` — which was NOT
  // granted, so it rejected and, since preventDefault had already blocked the native close, the ✕ did
  // NOTHING inside a book (the Library, with no handler, still closed natively). The permission is now
  // granted (capabilities/default.json), and this handler ALWAYS reaches the close on success/timeout/
  // error (try/finally + a bounded flush), so ✕ closes promptly every time.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let closing = false; // flush + close exactly once; a second ✕ during the flush is left to the first
    // RAWY-285: this handler registers ONCE, so it must read the book from the SAME live sources every
    // other writer uses — `bookRef` / `isPdfRef`, both updated by `openBook` — never from the props this
    // effect happened to close over. It used to capture `initial.id`/`initial.format` at MOUNT, so after a
    // cross-book follow the ✕ wrote the book on screen's read-aloud cursor under the PREVIOUS book's key.
    // Measured on the real build: closing while listening made `tts_position:<Alice>` byte-identical to
    // Lord of Mysteries' cursor (sec 374, its CFI and its Arabic snippet), destroying Alice's own.
    const flush = async () => {
      const st = useReader.getState();
      // RAWY-250 (addendum 4, DEFECT 1): the freeze must hold at EVERY writer, not just the debounced one.
      // `reading_progress` has TWO writers (RAWY-232) — the onRelocate save AND this close flush — and the
      // guard was originally placed only on the first, so closing the app while parked on a jumped-to
      // position persisted THAT position and destroyed the real one (owner: jumped to a highlight in ch140,
      // closed, reopened at ch140). While an anchor is active NOTHING may write the row. The freeze STATE
      // deliberately does NOT survive the restart — no persistent anchor is stored; the row is simply left
      // untouched, so the next open resumes at the real reading position with no pill and no trace of the
      // visit. The TTS cursor flush below is unaffected (separate storage, not reading_progress).
      // progress: same rule as the debounced save (a PDF persists by fraction with an empty cfi)
      if (!anchorRef.current && (st.cfi || isPdfRef.current)) await progressSave(bookRef.current, st.cfi ?? "", st.fraction).catch(() => {});
      // the last-spoken TTS sentence: the same cursor the throttled save + stop-on-exit write
      if (useTts.getState().active) {
        const cur = ctrlRef.current?.getTtsCursor(useTts.getState().index);
        if (cur) await settingsSet(`tts_position:${bookRef.current}`, JSON.stringify(cur)).catch(() => {});
      }
    };
    win
      .onCloseRequested(async (event) => {
        event.preventDefault(); // hold the native close so we can flush; WE own the destroy below
        if (closing) return; // a second ✕ while still flushing — the first invocation will close it
        closing = true;
        try {
          // flush the last progress + TTS cursor, but NEVER let a slow/failed flush block the close
          await Promise.race([flush(), new Promise((r) => setTimeout(r, 1500))]);
        } finally {
          // ALWAYS close now — destroy() bypasses this handler (no re-fire loop). It needs
          // core:window:allow-destroy (granted, RAWY-174); wrapped so nothing can leave the ✕ dead.
          try { await win.destroy(); } catch { /* no other JS path can force the close */ }
        }
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GLOBAL flags (override-book-colour, hide-chapter-title, hide-first-line) → re-inject the book
  // at its PER-BOOK theme (RAWY-40). Theme itself is per-book and handled by setBookTheme, not here.
  // RAWY-265 (Phase 3): `pageOpacity` and `deskScrim` are in the DEPENDENCY LIST, not merely in the
  // flags object. Passing a value the effect does not depend on is a silent no-op — the slider would
  // move, the store would update, and the injected paper would keep its previous alpha until some
  // unrelated flag happened to change. `applyTheme` refreshes the RAWY-140 dynamic paint sheet, so
  // this repaints in place with no reflow.
  useEffect(() => {
    if (status !== "ready") return;
    ctrlRef.current?.applyTheme(THEMES[bookThemeId], { overrideBookColor, hideChapterTitles, hideFirstLine, pageOpacity, deskScrim });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideBookColor, hideChapterTitles, hideFirstLine, pageOpacity, deskScrim]);

  // RAWY-70: keep the in-content placeholder/reveal strings in sync with the UI language — a plain
  // re-inject swaps the localized CSS `content` vars (the placeholder DOM itself is text-free).
  useEffect(() => {
    ctrlRef.current?.setRevealLabels(makeRevealLabels());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // RAWY-43: toggling the unified/per-book scope LIVE re-resolves the open book's effective
  // style + theme immediately. Unified → the global style/theme (overrides ignored, kept);
  // per-book → global ∪ this book's preserved override.
  useEffect(() => {
    if (status !== "ready") return;
    const global = globalStyleRef.current;
    if (!global) return;
    const unified = scope === "unified";
    const override = overrideRef.current;
    const effStyle = unified ? global : effectiveStyle(global, override);
    const bookDefault = useTheme.getState().bookThemeId;
    const effTheme = unified ? bookDefault : (override.themeId ?? bookDefault);
    useReader.getState().set({ style: effStyle });
    setBookThemeId(effTheme);
    setHasOv(!unified && calcHasOverride(override));
    applyTheme(THEMES[effTheme]);
    ctrlRef.current?.applyTheme(THEMES[effTheme], { overrideBookColor, hideChapterTitles, hideFirstLine, pageOpacity, deskScrim });
    ctrlRef.current?.applyStyle(effStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Pin the chrome open only while an ACTIVELY-DRIVEN drawer is open — Settings/Notes/basket, which
  // you interact with via the top bar. The Contents panel is DELIBERATELY excluded (RAWY-73): it is
  // a side navigation list you keep open WHILE reading, and it opens by default (RAWY-22) — pinning
  // the bar to it meant the bar never auto-hid for the owner. Contents now leaves the bar free to
  // auto-hide on idle/scroll (the panel itself stays open; it just doesn't force the bar shown).
  useEffect(
    () => setHold(settingsOpen || annoOpen || basketOpen || searchOpen || chromeFocused),
    [settingsOpen, annoOpen, basketOpen, searchOpen, chromeFocused, setHold],
  );
  // RAWY-194 (C): track whether keyboard focus is inside the chrome, so Tab-into-the-toolbar reveals+pins it
  // (via the setHold above) and Tab-away releases it. `focusout.relatedTarget` is where focus is going.
  useEffect(() => {
    const inChrome = (n: EventTarget | null) => n instanceof HTMLElement && !!n.closest(".reader-chrome");
    // Only KEYBOARD focus reveals the chrome (`:focus-visible`), so a MOUSE click on a chrome control (e.g.
    // Listen) does NOT pin the bar open and break the immersive auto-hide (caught live, RAWY-194 STEP 3).
    const onIn = (e: FocusEvent) => { if (inChrome(e.target) && (e.target as HTMLElement).matches(":focus-visible")) setChromeFocused(true); };
    const onOut = (e: FocusEvent) => { if (inChrome(e.target) && !inChrome(e.relatedTarget)) setChromeFocused(false); };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => { document.removeEventListener("focusin", onIn); document.removeEventListener("focusout", onOut); };
  }, []);

  // RAWY-72: keep the auto-hiding chrome awake on pointer activity inside the content iframe (which never
  // reaches a window listener). RAWY-133: a tap/click on the reading CONTENT is for reading or selecting
  // text (incl. RAWY-132's click-to-dismiss), NOT chrome intent — it must not flash the bars. So a content
  // TAP is now routed through the SAME top-edge reveal as a move (RAWY-118) rather than an unconditional
  // wake: while the bar is shown any content activity keeps it awake; while hidden, only a reach into the
  // top-edge zone brings it back (a mid-text tap/selection stays hidden). Deliberate reveals are unchanged
  // — the top-edge zone, scroll-up (below), a keydown, and a tap on the app chrome/desk (the hook's own
  // window `pointerdown` → wake) all still show the bars.
  // RAWY-73: scroll intent (scrolled mode) — scroll down hides, scroll up shows. `signalMove`/`signalScroll`
  // are stable, so this registers once and stays valid across section loads.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    // DIAGNOSTIC: does this mount-time registration find a controller at all?
    diagTrace("REG      Reader mount effect", { ctrlPresent: !!ctrl, registers: ["onActivity", "onSpace", "onArrow", "onScrollIntent", "onZoomIntent", "onReadingRedraw"] });
    ctrl?.onActivity((x, y) => signalMove(x, y));
    // RAWY-180 (Part B): Space with focus inside the reading frame toggles read-aloud when a session is
    // active (returns true → the frame swallows the key); otherwise Space keeps scrolling/paging.
    // RAWY-186: routed through `playRef` so, after navigating to a different chapter, Space (like the pill
    // Play) reads the CURRENT chapter instead of resuming the old one. The ref always holds the latest closure.
    ctrl?.onSpace(() => playRef.current());
    // RAWY-184 (Part C) / PART D: Right/Left arrow with focus inside the reading frame skips the next/prev
    // SENTENCE while read-aloud is active — NOT mirrored in RTL (the transport is a media/time control, not
    // reading direction); otherwise the arrows keep their normal page-turn (which DOES mirror in RTL).
    ctrl?.onArrow((key) => skipSentenceForArrow(key));
    // RAWY-73/130: scroll-down hides the bars, scroll-up shows them — the SAME during TTS now (RAWY-129
    // gated this off to dodge a reflow hitch; RAWY-130 removes the gate and instead pins the reading area
    // full-height during TTS via `.reader-root.tts-playing .page-host` (global.css), so the bars hide/show
    // by compositing over a stationary reading area — smooth, no page-host relayout).
    ctrl?.onScrollIntent((down) => signalScroll(down));
    // Ctrl+Wheel over the BOOK TEXT. The wheel fires inside the section iframe and never crosses the
    // frame boundary, so the desk's own handler cannot see it — the same split RAWY-87 documented for
    // PDF paging. Both routes end in `zoomByWheel`, so the behaviour is identical wherever the pointer is.
    // RAWY-291: routed through a ref because this effect runs once — reading `isPdf`/the PDF zoom
    // callback directly would freeze whichever values existed at registration.
    ctrl?.onZoomIntent((deltaY) => zoomIntentRef.current(deltaY));
    // RAWY-129 (A): after returning to a still-playing chapter (its overlay is recreated, units rebuilt with
    // fresh ranges), re-draw the reading track at the CURRENT sentence/word from the store.
    ctrl?.onReadingRedraw(() => {
      const st = useTts.getState();
      if (!st.active) return;
      ctrl.showReadingHighlight(st.index);
      ctrl.setReadingWords(st.index, st.words);
      ctrl.showReadingWord(st.wordIndex);
    });
    // `readerReady` is what makes this re-run once the hosted controller exists. The registrations
    // are assignments on the controller (`this.activityCb = cb`), so a re-run REPLACES each callback
    // rather than adding a second one.
  }, [signalMove, signalScroll, readerReady]);

  // When the basket empties (Clear, or removing the last passage) the top-bar button hides, so
  // close the now-orphaned tray too (RAWY-60).
  useEffect(() => {
    if (basketCount === 0) setBasketOpen(false);
  }, [basketCount]);

  // RAWY-126 (TTS reading indicator, Phase 1): drive the sentence "spotlight" off the queue's current
  // sentence. The units were built in lockstep with the queue at start (startListen*), so
  // `ttsIndex` maps straight to a range. Playing → draw + gently follow; paused → keep the highlight
  // where it stopped (draw, no scroll); stopped / closed → clear. A chapter change is handled inside
  // the controller (the units carry their section index; a mismatch clears the stale highlight).
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (!ttsActive) {
      ctrl.clearReadingHighlight();
      return;
    }
    ctrl.showReadingHighlight(ttsIndex);
    // RAWY-127: (re)build the word sub-ranges for this sentence (empty → no pill).
    ctrl.setReadingWords(ttsIndex, ttsWords);
    if (ttsStatus === "playing") ctrl.followReadingSentence(ttsIndex);
  }, [ttsActive, ttsIndex, ttsStatus, ttsWords]);

  // RAWY-127 (word karaoke, Edge only): move the solid pill to the active word within the sentence
  // track. Driven by the queue's `wordIndex` (a rAF loop maps the audio clock → the spoken word);
  // -1 / no timing → no pill, the Phase-1 sentence spotlight stands alone.
  useEffect(() => {
    if (!ttsActive) return;
    // RAWY-230 (§2a): `ttsStatus` is a dep so the PAUSE transition re-runs this AFTER the sentence-highlight
    // effect above removed WORD_KEY — otherwise the karaoke clock freezes on pause, `ttsWordIndex` never
    // changes, this effect never re-fires, and the word pill is dropped and never restored. Keeps the pill
    // visible while paused (the sentence band already survives via showReadingHighlight).
    ctrlRef.current?.showReadingWord(ttsWordIndex);
  }, [ttsActive, ttsWordIndex, ttsStatus]);

  // RAWY-250 (addendum 3): read-aloud needs NO separate handling — when TTS advances to the next chapter it
  // produces the SAME forward section change as reading on, which the onRelocate rule above already treats as
  // completion. One signal, no fourth notion of "finished".

  // RAWY-230 (§4) / RAWY-249 (PART 3D): when the LAST panel/drawer closes, return focus to the reading frame
  // so SPACE/arrows reach the reading shortcuts immediately — the owner must never have to click the book to
  // restore the keys, for ANY close (×, toolbar re-toggle, Escape). Previously gated on `activeElement===body`,
  // which the panels-stay-mounted design defeats: closing the settings drawer with its × leaves focus ON the ×
  // <button> (it doesn't unmount), so the guard failed and focus stuck → SPACE dead (the owner's report). Now
  // return focus on the close transition UNLESS a KEYBOARD user is focused in the TOOLBAR (Tab + :focus-visible),
  // whose place we must not steal (RAWY-194). The root-level release below already drops POINTER focus to <body>;
  // this covers keyboard/Escape closes and puts focus back IN the frame so page-turn arrows (TTS off) work too.
  // RESILIENCE-1 / WP-4D — THE FOCUS POLICY, STATED ONCE.
  //
  //   After any navigation action, focus belongs to the READING FRAME,
  //   unless a keyboard user is deliberately in the chrome.
  //
  // Before this there was one partial rule that fired only when the LAST panel closed, so every
  // other transition left focus wherever it landed. Measured: on a fresh open, after a toolbar
  // click, and after a desk-margin click, `document.activeElement` was <body> and ArrowRight did
  // nothing. WP-4C makes the key work from anywhere; this makes focus land somewhere sensible so
  // the reader keeps the caret, text selection and screen-reader context inside the book.
  //
  // The keyboard-user exception is not politeness, it is correctness: a Tab user standing on a
  // toolbar button (:focus-visible) must not have their place stolen (RAWY-194).
  const restoreReadingFocus = useCallback(() => {
    const ae = document.activeElement as HTMLElement | null;
    const keyboardInChrome = !!(ae && ae.closest?.(".reader-chrome") && ae.matches?.(":focus-visible"));
    if (!keyboardInChrome) ctrlRef.current?.focusReadingView();
  }, []);

  const anyPanelOpen = settingsOpen || annoOpen || basketOpen || searchOpen || chaptersOpen;
  const prevAnyPanelRef = useRef(false);
  useEffect(() => {
    if (prevAnyPanelRef.current && !anyPanelOpen) restoreReadingFocus();
    prevAnyPanelRef.current = anyPanelOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPanelOpen]);

  // RAWY-162: persist the last-spoken sentence for this book (a cursor separate from the reading CFI).
  // Throttled to ~1 write / 2s during continuous playback (never per-word), with a trailing save so the
  // final position lands; a pause flushes immediately; the stop-on-exit save is in the open cleanup.
  useEffect(() => {
    if (!ttsActive) {
      if (ttsSaveTimer.current) clearTimeout(ttsSaveTimer.current);
      return;
    }
    const save = () => {
      ttsLastSave.current = performance.now();
      const cur = ctrlRef.current?.getTtsCursor(useTts.getState().index);
      if (cur) settingsSet(`tts_position:${initial.id}`, JSON.stringify(cur)).catch(() => {});
    };
    if (ttsSaveTimer.current) clearTimeout(ttsSaveTimer.current);
    if (ttsStatus === "paused") { save(); return; } // flush the paused position now
    const since = performance.now() - ttsLastSave.current;
    if (since >= 2000) save();
    else ttsSaveTimer.current = window.setTimeout(save, 2000 - since);
    return () => { if (ttsSaveTimer.current) clearTimeout(ttsSaveTimer.current); };
  }, [ttsActive, ttsIndex, ttsStatus, initial.id]);

  // Chapters panel is OPEN BY DEFAULT (RAWY-22); the user's choice persists per `chapters_open`.
  useEffect(() => {
    if (status !== "ready") return;
    // RAWY-89: open Contents by default ONLY if no left panel is already open (don't clobber a Search
    // the user opened during this async read — the collision the owner saw).
    settingsGet("chapters_open").then((v) => setLeftPanel((p) => (v !== "0" && p == null ? "contents" : p)));
  }, [status]);

  // Placement model (RAWY-32 — supersedes the RAWY-30/D20 follow-direction model): reading panels
  // are PINNED to FIXED PHYSICAL sides that DO NOT move when the UI language flips. Chapters sits
  // on the physical LEFT; annotations and the settings slide-over both sit on the physical RIGHT —
  // each on the SAME physical side as the toolbar button that opens it (the top bar is pinned to
  // match). Chapters (left) COEXISTS with either right panel; annotations and settings share the
  // right edge, so opening one closes the other. Only panel CONTENT/labels translate with the UI
  // language; the reading TEXT stays book-directed (foliate, isolated — RAWY-12).
  const toggleChapters = useCallback(() => {
    setLeftPanel((p) => {
      const next = p === "contents" ? null : "contents"; // opening Contents closes Search (single left panel)
      settingsSet("chapters_open", next === "contents" ? "1" : "0").catch(console.error);
      return next;
    });
  }, []);

  // DEV: deterministically open a panel for screenshots (settings `dev_panel`: chapters |
  // notes | highlights). Mirrors the dev_open hook; no effect in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV || status !== "ready") return;
    settingsGet("dev_panel").then((p) => {
      if (p === "chapters") setLeftPanel("contents");
      else if (p === "notes") { setAnnoTab("notes"); setAnnoOpen(true); }
      else if (p === "highlights") { setAnnoTab("highlights"); setAnnoOpen(true); }
      else if (p === "settings") setSettingsOpen(true);
      // RAWY-80: open the Settings drawer on a specific tab (e.g. `settings:theme`) for capture.
      else if (p?.startsWith("settings:")) { setSettingsSection(p.slice(9) as SettingsSection); setSettingsOpen(true); }
    });
    settingsGet("dev_seek").then((s) => {
      if (!s) return;
      setTimeout(async () => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        if (s === "toc:last") await ctrl.goToTocEntry("last");
        else if (s.startsWith("toc:")) await ctrl.goToTocEntry(Number(s.slice(4)));
        // RAWY-86: drive the EXACT wheel-paging path (pageByWheel, logical forward/back) N times, to
        // verify PDF paging works through the document (the chevrons use the same underlying nav).
        else if (s.startsWith("next:")) { for (let i = 0; i < Number(s.slice(5)); i++) { ctrl.pageByWheel(120); await new Promise((r) => setTimeout(r, 340)); } }
        else if (s.startsWith("prev:")) { for (let i = 0; i < Number(s.slice(5)); i++) { ctrl.pageByWheel(-120); await new Promise((r) => setTimeout(r, 340)); } }
        // RAWY-87 (#2): drive the page-wheel → pageByWheel forwarding by dispatching synthetic wheels
        // ON THE PDF PAGE DOC (where a real wheel over the page fires), N times, to prove it pages.
        else if (s.startsWith("pagewheel:")) { for (let i = 0; i < Number(s.slice(10)); i++) { ctrl.devPageWheel(120); await new Promise((r) => setTimeout(r, 340)); } }
        // RAWY-88: drive in-book search for capture (WebView2 injects no typing/clicks): "search:<frac>:<query>"
        // — jump to <frac> (advances the furthest-read spoiler boundary), then open the panel + set the query.
        else if (s.startsWith("search:")) {
          const rest = s.slice(7);
          const ci = rest.indexOf(":");
          const frac = Number(rest.slice(0, ci));
          const q = rest.slice(ci + 1);
          if (!Number.isNaN(frac) && frac > 0) { await ctrl.goToFraction(frac); await new Promise((r) => setTimeout(r, 500)); }
          setLeftPanel("search"); setSearchQuery(q);
        }
        // RAWY-88: prove jump-to-result — search, then goToSearchHit the LAST match; the landed fraction
        // (saved to reading_progress on relocate) should match that hit's location. "searchjump:<query>"
        else if (s.startsWith("searchjump:")) {
          const hits = await ctrl.searchBook(s.slice(11));
          await settingsSet("dev_search_n", String(hits.length)).catch(() => {});
          if (hits.length) {
            const target = hits[hits.length - 1];
            await settingsSet("dev_search_targetfrac", target.frac.toFixed(4)).catch(() => {});
            await ctrl.goToSearchHit(target.cfi);
          }
        }
        else if (!Number.isNaN(Number(s))) await ctrl.goToFraction(Number(s));
        setTimeout(() => settingsSet("dev_diag", ctrl.diagnose()).catch(() => {}), 500);
      }, 350);
    });
    // RAWY-81 (#1): open the Photo composer on a sample passage with a preset quote font, so the
    // independent-quote-font control can be captured (the picker can't be driven headless). The
    // preset rides in as `initialQuoteFont` — the SAME path the gallery "Edit" uses to restore it.
    settingsGet("dev_photocard").then((v) => {
      if (!v) return;
      const rtl = useReader.getState().dir === "rtl";
      setDevCardFont(v === "default" ? null : v);
      setPhotoCard({
        quote: rtl
          ? "الكُتبُ بساتينُ العقلاء، ومن قرأ فيها أينعت في نفسه ثمارُ الحكمة."
          : "The quote font is now its own choice — set the card’s face apart from the book.",
        dir: rtl ? "rtl" : "ltr",
        bookTitle: useReader.getState().bookTitle ?? undefined,
        author: rtl ? "أحمد شوقي" : "Lewis Carroll",
        chapterLabel: useReader.getState().chapterLabel ?? undefined,
        date: new Date(),
      });
    });
  }, [status]);

  // RAWY-40: a reading-setting change WHILE READING writes a PER-BOOK override (the global
  // `reading_style` defaults are only touched by Global Settings). Effective = global ∪ override;
  // the override accumulates exactly the fields the user changed for THIS book.
  // Ctrl+Wheel zoom. Deliberately NOT a second zoom system: it computes the next value on the
  // slider's own lattice and hands it to the SAME `update` the slider calls, so the two inputs cannot
  // drift — there is one field, one writer, and nothing to keep in sync.
  //
  // Coalesced to one change per animation frame. MEASURED: a zoom step costs ~51 ms to apply and
  // settle (scrolled and paged alike), while a wheel emits far faster than that, so writing every
  // tick would queue reflows behind each other. A frame is the natural bound and needs no timer and
  // no tunable constant. The pending value — not the committed one — is the base for the next tick,
  // so a fast spin accumulates instead of collapsing to a single step.
  const zoomRaf = useRef(0);
  const zoomPending = useRef<number | null>(null);
  // `update` is a fresh closure every render, while the wheel handler is registered ONCE (the callback
  // effect above runs on mount). Reading the writer through a ref means the handler always calls the
  // CURRENT `update` instead of the one that existed when the book opened — the same reason
  // `playRef` exists a few hundred lines up.
  const updateRef = useRef<(patch: Partial<ReadingStyle>) => void>(() => {});
  const zoomByWheel = useCallback((deltaY: number) => {
    if (!deltaY) return;
    const cur = zoomPending.current ?? useReader.getState().style?.zoom;
    if (cur == null) return;
    // Wheel UP (negative delta) zooms IN, matching every other application.
    // Rounded to the same 2 decimals the slider stores, so a value reached by wheel is one the slider
    // can also express — otherwise the two inputs would drift onto different lattices.
    const raw = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur + (deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    const next = Math.round(raw * 100) / 100;
    if (next === cur) return; // already at a bound — nothing to schedule
    zoomPending.current = next;
    if (zoomRaf.current) return;
    zoomRaf.current = requestAnimationFrame(() => {
      zoomRaf.current = 0;
      const v = zoomPending.current;
      zoomPending.current = null;
      if (v != null) updateRef.current({ zoom: v });
    });
  }, []);

  const update = (patch: Partial<ReadingStyle>) => {
    const current = useReader.getState().style;
    const global = globalStyleRef.current;
    if (!current || !global) return;
    const next = { ...current, ...patch };
    useReader.getState().set({ style: next });

    const unified = useStyleScope.getState().scope === "unified";
    if (unified) {
      // UNIFIED (RAWY-43): the change is the new GLOBAL baseline → write the global row (affects
      // every book). The per-book override is left untouched (ignored, not deleted).
      globalStyleRef.current = next;
    } else {
      // PER-BOOK (RAWY-40): fold the patch into this book's partial override — a field back at the
      // global default drops out (so it keeps following global), otherwise it's recorded.
      const ovStyle: Partial<ReadingStyle> = { ...(overrideRef.current.style ?? {}) };
      for (const k of Object.keys(patch) as (keyof ReadingStyle)[]) {
        if (next[k] === global[k]) delete ovStyle[k];
        else (ovStyle as Record<string, unknown>)[k] = next[k];
      }
      overrideRef.current = { ...overrideRef.current, style: ovStyle };
      setHasOv(calcHasOverride(overrideRef.current));
    }

    // flowMode is a renderer attribute set at open() — switching it re-opens at the current CFI
    // (preserves position); every other field is the live injected-CSS funnel.
    const flowChanged = patch.flowMode != null && patch.flowMode !== current.flowMode;
    if (flowChanged) {
      const cfi = useReader.getState().cfi;
      ctrlRef.current?.open(convertFileSrc(initial.filePath), stageRef.current!, {
        resumeCfi: cfi,
        style: next,
        theme: THEMES[bookThemeId],
        flags: {
          overrideBookColor: useTheme.getState().overrideBookColor,
          hideChapterTitles: useTheme.getState().hideChapterTitles,
          hideFirstLine: useTheme.getState().hideFirstLine,
        },
        dir: initial.dir ?? undefined,
        flow: next.flowMode,
        revealLabels: makeRevealLabels(), // RAWY-70
      }).then(() => useAnnotations.getState().load()).catch(console.error);
    } else {
      // RAWY-82 (#15): a slider drag fires many onChange ticks, and each applyStyle rebuilds the
      // injected CSS + re-lays-out the whole chapter (buildReadingCss → foliate setStyles). Coalesce
      // to at most ONE apply per animation frame with the LATEST value — the drag stays smooth and
      // the final settled value always applies (the last tick updates pendingStyleRef, and any
      // already-scheduled frame reads it). The store `set({ style })` above stays immediate, so the
      // slider itself and the desk page-width/margin vars track every tick with no lag.
      pendingStyleRef.current = next;
      if (styleRafRef.current == null) {
        styleRafRef.current = requestAnimationFrame(() => {
          styleRafRef.current = null;
          const s = pendingStyleRef.current;
          pendingStyleRef.current = null;
          if (s) ctrlRef.current?.applyStyle(s);
        });
      }
    }
    if (styleTimer.current) clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => {
      if (useStyleScope.getState().scope === "unified") saveGlobalStyle(useReader.getState().style!);
      else saveBookOverride(bookRef.current, overrideRef.current);
    }, SAVE_DEBOUNCE_MS);
  };
  updateRef.current = update;

  // THEME change from the Theme tab. Applies to the reading surface (:root while reading + the
  // book iframe) but NEVER to the Library's own theme (RAWY-48/D29). PER-BOOK (RAWY-40): change
  // ONLY this book's paper+ink (persisted in the book override). UNIFIED (RAWY-43): set the shared
  // BOOK theme (`book_theme_id`) so every book follows it — the Library theme (`theme_id`) is left
  // untouched, so returning to the Library still shows its own theme.
  const setBookTheme = (id: ThemeId) => {
    setBookThemeId(id);
    applyTheme(THEMES[id]);
    ctrlRef.current?.applyTheme(THEMES[id], { overrideBookColor, hideChapterTitles, hideFirstLine, pageOpacity, deskScrim });
    if (useStyleScope.getState().scope === "unified") {
      useTheme.getState().setBookTheme(id); // shared BOOK theme — persists book_theme_id, not the Library
    } else {
      const bookDefault = useTheme.getState().bookThemeId;
      overrideRef.current = { ...overrideRef.current, themeId: id === bookDefault ? undefined : id };
      setHasOv(calcHasOverride(overrideRef.current));
      saveBookOverride(bookRef.current, overrideRef.current);
    }
  };

  // Reset this book to the app defaults (RAWY-40, Band I "↻ Reset"): drop the whole override.
  const resetBook = () => {
    overrideRef.current = {};
    setHasOv(false);
    clearBookOverride(bookRef.current);
    const global = globalStyleRef.current ?? defaultsForDir(dir);
    useReader.getState().set({ style: global });
    // Reset → follow the shared BOOK theme (D29), not the Library theme.
    const bookDefault = useTheme.getState().bookThemeId;
    setBookThemeId(bookDefault);
    applyTheme(THEMES[bookDefault]);
    ctrlRef.current?.applyTheme(THEMES[bookDefault], { overrideBookColor, hideChapterTitles, hideFirstLine, pageOpacity, deskScrim });
    ctrlRef.current?.applyStyle(global);
  };

  // RAWY-41: toggle a bookmark at the CURRENT reading location (CFI + fraction + chapter). If the
  // visible spot is already bookmarked, remove it; else add. The button reflects bookmarked state.
  // RAWY-229 (corrected): a CHAPTER-SCOPED toggle. Find THIS chapter's bookmark (section identity — the same
  // test the marker uses) and remove it; else add one — so pressing never creates a second bookmark in a
  // chapter that already has one, even when the existing one is scrolled out of view. Resolved at click time
  // from the live cfi (not the render-time marker), so it is correct at any scroll position. If a chapter
  // somehow holds >1 bookmark (legacy data), `find` removes the first one only — no silent bulk delete.
  const onBookmark = () => {
    const st = useReader.getState();
    const ctrl = ctrlRef.current;
    if (!st.cfi || !ctrl) return;
    const existing = useBookmarks.getState().bookmarks.find((b) => ctrl.bookmarkVisible(b.cfi, st.cfi));
    if (existing) useBookmarks.getState().remove(existing.id);
    else useBookmarks.getState().add(st.cfi, st.chapterLabel, st.fraction);
  };

  // RAWY-85: PDF Phase 0 is READ-ONLY. `isPdf` gates the EPUB-only affordances (themes/fonts/
  // annotations/Photo Mode) behind honest in-app messaging. A PDF has no spine page-progression, so
  // the reader offers a manual reading-DIRECTION override for Arabic PDFs; changing it persists the
  // choice (books.dir via metadata_override) and re-opens the PDF at the current page.
  const isPdf = (initial.format ?? "").toLowerCase() === "pdf";
  // RAWY-86: PDF appearance INVERT (approximate night mode — a CSS invert filter, NOT real themes;
  // it flips images too), persisted per book. Plus copy-selection. Feedback rides a small transient
  // message. RAWY-141: the reading-direction override + in-PDF find were removed (see SettingsPanel).
  // RAWY-291: the two-state invert is now a set of reading appearances (see reader-engine/pdfView.ts
  // for why a PDF "theme" can only be a colour transform), and the renderer's zoom is finally exposed.
  const [pdfThemeId, setPdfThemeId] = useState<PdfThemeId>("normal");
  const [pdfZoom, setPdfZoom] = useState<PdfZoom>("fit-page");
  // RAWY-292: the PDF toast is gone with copy-selection, its only caller. A PDF that cannot be read
  // aloud now degrades through the EXISTING read-aloud path: unusable pages yield zero units, which is
  // the same empty-chapter state an empty EPUB chapter produces — one behaviour, not a parallel one.
  // RAWY-285: `pdf_invert` is loaded by `openBook` with every other per-book value (it was a mount-once
  // effect, which a reused Reader silently never re-ran). The setter below is unchanged.
  const choosePdfTheme = (id: PdfThemeId) => {
    setPdfThemeId(id);
    settingsSet(PDF_THEME_KEY, id).catch(() => {});
    // Keep the legacy per-book key truthful, so a downgrade still shows a dark page for a dark theme.
    settingsSet(`pdf_invert:${initial.id}`, pdfTheme(id).dark ? "1" : "0").catch(() => {});
  };

  // ZOOM. The renderer re-renders the page through pdf.js at the requested scale (fixed-layout.js
  // observes `zoom`), so this is real resolution, not a magnified bitmap. Two consequences shape the
  // code below: a re-render costs real work, so wheel events are COALESCED rather than applied one by
  // one; and the scale a fit-mode resolves to is known only to the renderer, so stepping out of a fit
  // mode reads the scale actually on screen instead of guessing.
  const pdfZoomRef = useRef<PdfZoom>("fit-page");
  pdfZoomRef.current = pdfZoom;
  const zoomIntentRef = useRef<(d: number) => void>(() => {});
  const pdfZoomWrite = useRef<number | undefined>(undefined);
  const applyPdfZoom = useCallback((z: PdfZoom) => {
    setPdfZoom(z);
    ctrlRef.current?.setPdfZoom(z);
    // Persist lazily: a wheel gesture must not write a settings row per frame.
    if (pdfZoomWrite.current) clearTimeout(pdfZoomWrite.current);
    pdfZoomWrite.current = window.setTimeout(() => {
      settingsSet(pdfZoomKey(initial.id), pdfZoomAttr(z)).catch(() => {});
    }, 400);
  }, [initial.id]);
  /** The scale currently on screen — resolved by the renderer when a fit mode is active. */
  const currentPdfScale = useCallback(
    () => (isFitMode(pdfZoomRef.current) ? (ctrlRef.current?.pdfRenderedScale() ?? 1) : (pdfZoomRef.current as number)),
    [],
  );
  const pdfZoomStep = useCallback((dir: 1 | -1) => applyPdfZoom(stepPdfZoom(currentPdfScale(), dir)), [applyPdfZoom, currentPdfScale]);
  // Wheel/pinch: coalesce to one render per frame. A trackpad pinch arrives as ctrl+wheel too, which
  // is why no separate gesture handler is needed on this platform.
  const pdfZoomPending = useRef<number | null>(null);
  const pdfZoomRaf = useRef<number | undefined>(undefined);
  const pdfZoomByWheel = useCallback((deltaY: number) => {
    const from = pdfZoomPending.current ?? currentPdfScale();
    pdfZoomPending.current = zoomForWheel(from, deltaY);
    if (pdfZoomRaf.current !== undefined) return;
    pdfZoomRaf.current = requestAnimationFrame(() => {
      pdfZoomRaf.current = undefined;
      const v = pdfZoomPending.current;
      pdfZoomPending.current = null;
      if (v != null) applyPdfZoom(v);
    });
  }, [applyPdfZoom, currentPdfScale]);
  zoomIntentRef.current = isPdf ? pdfZoomByWheel : zoomByWheel;
  useEffect(() => () => {
    if (pdfZoomRaf.current !== undefined) cancelAnimationFrame(pdfZoomRaf.current);
    if (pdfZoomWrite.current) clearTimeout(pdfZoomWrite.current);
  }, []);

  // RAWY-294: push the appearance INTO the PDF page's own document, so it cannot reach the surround.
  useEffect(() => {
    if (!isPdf) return;
    const th = pdfTheme(pdfThemeId);
    const apply = () => ctrlRef.current?.setPdfTheme(th.filter, th.tint);
    apply();
    // Pages render asynchronously; re-apply briefly so a page that arrives late is not left untinted.
    const id = window.setInterval(apply, 700);
    const stop = window.setTimeout(() => window.clearInterval(id), 6000);
    return () => { window.clearInterval(id); window.clearTimeout(stop); };
  }, [isPdf, pdfThemeId, initial.id]);

  // RAWY-293: whether THIS page yields speakable text — the read-aloud control follows real
  // extraction, so it never appears on a scan and never promises what the pipeline cannot deliver.
  const [pdfCanListen, setPdfCanListen] = useState(false);
  useEffect(() => {
    if (!isPdf) { setPdfCanListen(false); return; }
    const tick = () => setPdfCanListen(ctrlRef.current?.pdfHasSpeakableText() ?? false);
    tick();
    const id = window.setInterval(tick, 1200);
    return () => window.clearInterval(id);
  }, [isPdf, initial.id]);

  // Apply the remembered zoom once the PDF's renderer exists. The renderer defaults to fit-page, so
  // without this a document reopened at 2x would silently come back at fit-page.
  useEffect(() => {
    if (!isPdf) return;
    let tries = 0;
    const id = window.setInterval(() => {
      if (ctrlRef.current?.pdfPageCount || tries++ > 40) {
        ctrlRef.current?.setPdfZoom(pdfZoomRef.current);
        window.clearInterval(id);
      }
    }, 150);
    return () => window.clearInterval(id);
  }, [isPdf, initial.id]);
  // RAWY-292: copy-selection removed from the PDF panel. It depended on the same text layer that
  // measurement showed is absent or damaged in most of these documents, so the control was offered
  // far more often than it could work. The controller method remains for the selection path.

  // RAWY-87 (#1): a PDF has no chapters, so the bottom chrome shows page position (page / total) and
  // the progress bar is scrubbable to jump. pageCount = the PDF's fixed-layout section count (set on
  // open); the current page derives from the saved fraction (= (pageIndex+0.5)/count, RAWY-86).
  const [pdfPageCount, setPdfPageCount] = useState(0);
  // Scrub → jump to the latest requested fraction with ONE goToFraction in flight at a time: a fast
  // drag across a 3000-page PDF must never stack page renders — run the freshest, drop the stale.
  const scrubPendingRef = useRef<number | null>(null);
  const scrubBusyRef = useRef(false);
  const onPdfScrub = (frac: number) => {
    scrubPendingRef.current = Math.max(0, Math.min(1, frac));
    if (scrubBusyRef.current) return;
    scrubBusyRef.current = true;
    (async () => {
      const ctrl = ctrlRef.current;
      while (ctrl && scrubPendingRef.current != null) {
        const f = scrubPendingRef.current;
        scrubPendingRef.current = null;
        await ctrl.goToFraction(f);
      }
    })().catch(() => {}).finally(() => { scrubBusyRef.current = false; });
  };

  // ---- RAWY-88: in-book search + spoiler-safe (EPUB only; a PDF keeps its RAWY-86 find) ----
  // (searchOpen is declared with the other panel state above, so the chrome-hold effect can read it.)
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState(0); // RAWY-89: scan fraction (0..1) for the live indicator
  const [spoilerSafe, setSpoilerSafe] = useState(true); // ON by default (the whole point), per book
  const [revealAhead, setRevealAhead] = useState(false); // "show them anyway" — this once
  const [activeHitCfi, setActiveHitCfi] = useState<string | null>(null);
  const searchEpoch = useRef(0);
  const searchDebounce = useRef<number | undefined>(undefined);
  const searchAbort = useRef<AbortController | null>(null);

  // RAWY-285: the per-book spoiler-safe preference (default ON, design §5) is loaded by `openBook`
  // alongside every other per-book value — see the ordering note there. It was a mount-once effect, so a
  // Reader reused across books kept the FIRST book's answer for the rest of the session.

  // debounced whole-book search; a newer query supersedes (epoch) + aborts the in-flight scan
  useEffect(() => {
    const q = searchQuery.trim();
    setRevealAhead(false);
    setActiveHitCfi(null);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchAbort.current?.abort();
    const myEpoch = ++searchEpoch.current;
    if (!q) { setSearchHits([]); setSearching(false); setSearchProgress(0); return; }
    setSearching(true);
    setSearchProgress(0);
    setSearchHits([]);
    searchDebounce.current = window.setTimeout(() => {
      const ctrl = ctrlRef.current;
      if (!ctrl) return;
      const ac = new AbortController();
      searchAbort.current = ac;
      // RAWY-89: stream partial results + scan progress as foliate scans, so the panel feels alive.
      ctrl.searchBook(q, {
        signal: ac.signal,
        onProgress: (f) => { if (searchEpoch.current === myEpoch) setSearchProgress(f); },
        onBatch: (hits) => { if (searchEpoch.current === myEpoch) setSearchHits(hits); },
      }).then((hits) => {
        if (searchEpoch.current !== myEpoch) return; // superseded
        setSearchHits(hits);
        setSearchProgress(1);
        setSearching(false);
      }).catch(() => { if (searchEpoch.current === myEpoch) setSearching(false); });
    }, 320);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchQuery]);

  const toggleSearch = useCallback(() => {
    setLeftPanel((p) => (p === "search" ? null : "search")); // opening Search closes Contents
  }, []);
  // RAWY-175 (AUD-3): STABLE (useCallback) so the memoized SearchPanel/ResultRow can skip re-rendering
  // when only unrelated Reader state changed — the reference doesn't churn every render.
  const onToggleSpoiler = useCallback(() => {
    setRevealAhead(false);
    setSpoilerSafe((v) => {
      const next = !v;
      // RAWY-285: `bookRef.current`, not `initial.id`. This callback is deliberately STABLE (empty deps,
      // above) so the memoised SearchPanel does not churn — which means it closes over the FIRST render's
      // props for the life of the Reader. Toggling spoiler-safe after a cross-book follow therefore wrote
      // the new book's answer under the PREVIOUS book's key. Reading the live ref keeps the callback
      // stable AND correct; the same ref every other per-book writer already uses.
      settingsSet(`spoiler_safe:${bookRef.current}`, next ? "1" : "0").catch(() => {});
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // RAWY-250 (PART 1): capture the REAL reading position and freeze progress, immediately BEFORE a
  // programmatic jump navigates. ONE-DEEP (the owner's choice): if an anchor already exists, a further jump
  // keeps pointing at the ORIGINAL reading position rather than at the previous jump's landing.
  // `target` = the CFI/href the jump is about to navigate to, so the landing section can be pre-armed.
  const beginJump = useCallback((target?: string) => {
    // RAWY-250 (addendum 6): DETERMINISTIC jump suppression. Resolve the section the jump will land in and
    // pre-arm the chapter tracker with it, so the landing relocate is NOT a section change and therefore can
    // never reach the thaw rule — regardless of how long the load takes, how busy the machine is, or how many
    // relocates the engine emits for one jump (an `onExpand` re-anchor emits another). `atStart: false` is
    // exactly right here too: a chapter ENTERED BY A JUMP must never be markable as read (the reader never
    // saw its first half), so this one assignment encodes both rules.
    const targetSec = target ? (ctrlRef.current?.targetSectionIndex(target) ?? null) : null;
    if (targetSec !== null) chapTrackRef.current = { sec: targetSec, atStart: false };
    // RAWY-250 (addendum 5): the TIMING fallback, used ONLY when the target could not be resolved (a
    // malformed/out-of-bounds CFI). Stamped for EVERY jump — including one that keeps the existing anchor —
    // so a 2nd/3rd jump is never left unstamped (the owner's failing case).
    jumpNavAtRef.current = targetSec === null ? performance.now() : 0;
    if (anchorRef.current) return; // already frozen — keep the ORIGINAL anchor (one-deep, never replaced)
    const st = useReader.getState();
    if (!st.cfi) return; // nothing real to return to yet (a PDF, or before the first relocate)
    const a: ReadAnchor = { cfi: st.cfi, label: st.chapterLabel, sec: ctrlRef.current?.currentSectionIndex() ?? -1 };
    anchorRef.current = a;
    setAnchorUi(a);
  }, []);

  const onJumpHit = useCallback((hit: SearchHit) => {
    setActiveHitCfi(hit.cfi);
    beginJump(hit.cfi); // RAWY-250: freeze the real position + pre-arm the landing section (§6.2)
    // RAWY-139: pass the split excerpt so goToSearchHit can re-find the hit's exact text in the rendered
    // doc (the search CFI is unreliable there — the rendered structure differs from the search doc).
    ctrlRef.current?.goToSearchHit(hit.cfi, { pre: hit.pre, match: hit.match, post: hit.post });
  }, []);
  // RESILIENCE-1 / WP-4F: the position readout, decided in ONE pure place (reader-engine/position.ts)
  // and formatted with the app's locale digits — the same formatter the PDF page counter already uses.
  const position = useMemo(
    () => positionReadout({ location, pageLabel }, (n) => localeNum(n, lang)),
    [location, pageLabel, lang],
  );

  // the reader's position label for the toggle + "you are here" (current chapter, else a percent)
  const searchPositionLabel = chapterLabel || t("reader.percentRead", { p: localeNum(Math.round(fraction * 100), lang) });

  // RAWY-88: ⌘F / Ctrl-F / "/" opens search even in immersive mode (design §1). Ignored while typing.
  // RAWY-196: test `e.code` (the PHYSICAL key), never `e.key` (what the LAYOUT produces). The old
  // `e.key === "f"` test was silently dead for the owner: on an Arabic keyboard that key yields "ب",
  // so Ctrl+F could never match — and the unhandled key fell through to WebView2's own find bar. The
  // "/" shortcut had the same defect (that key is "ظ" on an Arabic layout). FoliateController forwards
  // both from the reading iframe, which is where a reader's focus actually is.
  useEffect(() => {
    if (isPdf) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName ?? "");
      const cmdF = (e.metaKey || e.ctrlKey) && e.code === "KeyF";
      const slash = e.code === "Slash" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !typing;
      if (cmdF || slash) {
        e.preventDefault();
        setLeftPanel("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdf]);

  // RESILIENCE-1 / WP-4C — THE PARENT WINDOW OWNS PAGE-TURN KEYS.
  //
  // The book's iframe already had arrow handlers, but a keydown in a child frame never reaches the
  // parent — so whenever focus sat anywhere else (a fresh open, a toolbar click, the desk margin)
  // the key reached NO handler and the reader concluded that navigation was broken. This listener
  // is the missing half: it catches those exact states and routes them into `handleNavKey`, the one
  // owner the frame also calls, so a key cannot behave differently by where focus happens to be.
  //
  // Exactly one path sees any physical keypress, so there is no double turn.
  useEffect(() => {
    const onNavKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      // Never steal a key from someone typing, or from a control that legitimately uses arrows
      // (a slider, a select) — the settings drawer is full of them.
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (t && t.closest?.('[role="slider"], input[type="range"]')) return;
      if (!(e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      if (ctrlRef.current?.handleNavKey(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onNavKey);
    return () => window.removeEventListener("keydown", onNavKey);
  }, []);

  // RAWY-49: open the Photo Mode composer for a selected passage. The card starts on the book's
  // current theme + direction, with the book title/author/chapter as removable metadata.
  const openPhotoCard = (sel: SelectionInfo) => {
    const st = useReader.getState();
    setPhotoCard({
      quote: sel.text.replace(/\s+/g, " ").trim(),
      dir: dir === "rtl" ? "rtl" : "ltr",
      bookId: bookRef.current,
      cfi: sel.cfi,
      // RESILIENCE-1 / WP-3: a card is SHARED, so it must credit what the reader believes they are
      // reading. These were `ctrl?.title` / `ctrl?.author` — the file's embedded metadata — which
      // meant a renamed book went out into the world under its old name, and a corrected author
      // credit was undone the moment the quote left the app.
      bookTitle: st.bookTitle ?? undefined,
      author: st.bookAuthor ?? undefined,
      chapterLabel: st.chapterLabel ?? undefined,
      date: new Date(),
    });
  };

  // RAWY-60: "Add to card" collects a passage into the session basket with the chapter it was
  // taken from (so a card can span chapters). A new book resets the basket (store-side).
  const addToBasket = (sel: SelectionInfo) => {
    const st = useReader.getState();
    usePhotoBasket.getState().add(
      {
        id: crypto.randomUUID(),
        text: sel.text.replace(/\s+/g, " ").trim(),
        chapterLabel: st.chapterLabel ?? null,
        cfi: sel.cfi,
      },
      {
        bookId: bookRef.current,
        // WP-3: same rule as the single-passage card above — the credit is the effective name.
        bookTitle: st.bookTitle ?? null,
        author: st.bookAuthor ?? null,
        dir: dir === "rtl" ? "rtl" : "ltr",
      },
    );
  };

  // RAWY-60: compose every collected passage into ONE multi-passage card. The metadata rule
  // (footer chapter once vs per-passage labels) is decided inside PhotoCard from the passages.
  const composeBasket = () => {
    const b = usePhotoBasket.getState();
    if (!b.passages.length) return;
    setBasketOpen(false);
    setPhotoCard({
      quote: b.passages.map((p) => p.text).join("\n\n"), // joined text (gallery/storage fallback)
      passages: b.passages.map((p) => ({ text: p.text, chapterLabel: p.chapterLabel ?? undefined })),
      dir: b.dir,
      bookId: b.bookId ?? undefined,
      bookTitle: b.bookTitle ?? undefined,
      author: b.author ?? undefined,
      chapterLabel: b.passages[0]?.chapterLabel ?? undefined,
      date: new Date(),
    });
  };

  const isRtlBook = dir === "rtl";
  // Whether the chrome bar is currently shown — the bookmark marker drops below it so it stays
  // visible (RAWY-42); same condition the chrome itself uses. RAWY-73: `chaptersOpen` is excluded
  // (matching the pin above) so the Contents panel being open no longer forces the bar shown — the
  // bar follows the auto-hide (chromeVisible), and the marker tracks it.
  const chromeShown = chromeVisible || settingsOpen || annoOpen || basketOpen || searchOpen;
  // When chapter titles are hidden (anti-spoiler), the chrome shows a neutral "Chapter N" — using
  // the book's OWN chapter number, parsed straight from `chapterLabel` (already the real,
  // currently-matched TOC label — RAWY-67). A single-volume import whose real first chapter is
  // "الفصل 200" now correctly shows 200, not the imposed list position. Never fabricated: a
  // label/entry with no extractable number falls back to the TOC array position, same as before.
  // RAWY-287 — WHICH TOC ENTRY THE READER IS INSIDE, resolved against EPUB reading order.
  //
  // `chapterHref` is foliate's `tocItem.href` for the current position, and it is correct — but it is
  // `null` whenever the position lies in a spine document that the nav document does not list. That is
  // ordinary, valid EPUB (a cover, a title page, an unlisted opening section), and BOTH reported books
  // do it. Matching hrefs alone therefore reported "no chapter" for a reader who was plainly inside
  // the book, and the old chrome label then printed a confident, wrong "Chapter 1".
  //
  // The general rule, which needs no per-book knowledge: you are inside the LAST TOC entry that begins
  // at or before your position in reading order. Resolution order:
  //   1. foliate's own `tocItem` — authoritative, and the only thing that can distinguish SEVERAL
  //      entries inside ONE document (Alice's three front-matter anchors).
  //   2. otherwise the nearest preceding entry by SPINE index, via the RAWY-256 `tocSecMap` that is
  //      already built once per book. This is what makes an unlisted opening section resolve to
  //      something honest instead of to nothing.
  //   3. otherwise -1: genuinely before the first listed entry. The chrome then says so rather than
  //      inventing a number.
  const curSec = cfi ? (ctrlRef.current?.currentSectionIndex() ?? -1) : -1;
  const tocIndex = useMemo(() => {
    const direct = toc.findIndex((c) => c.href && c.href === chapterHref);
    if (direct >= 0) return direct;
    if (curSec < 0 || !tocSecMap.size) return -1;
    let best = -1, bestSec = -1;
    toc.forEach((c, i) => {
      const sec = c.href ? tocSecMap.get(c.href) : undefined;
      if (typeof sec === "number" && sec <= curSec && sec >= bestSec) { best = i; bestSec = sec; }
    });
    return best;
  }, [toc, chapterHref, curSec, tocSecMap]);

  // RAWY-287: the chrome's number comes from the SAME single source the panel uses, so the bar and the
  // list can never disagree. An entry with no designator — in a book that numbers its chapters — is a
  // section, not "Chapter N"; and a position inside no listed entry at all is stated as unknown rather
  // than rendered as "Chapter 1", which is what both reported books displayed.
  const tocOwnNumbers = useMemo(() => {
    const own = toc.map((c) => extractChapterNumber(c.label));
    return own.filter((n) => n != null).length >= 2 ? own : null;
  }, [toc]);
  const chapter = (() => {
    if (!hideChapterTitles) return chapterLabel || t("reader.chapterFallback");
    if (tocIndex < 0) return t("reader.chapterFallback");
    const own = tocOwnNumbers ? tocOwnNumbers[tocIndex] : tocIndex + 1;
    return own == null
      ? t("panel.tocSection", { n: localeNum(tocIndex + 1, lang) })
      : t("panel.chapter", { n: localeNum(own, lang) });
  })();

  // RAWY-105: start read-aloud from the current chapter (top-bar Listen). Voice defaults by the BOOK's
  // direction (Arabic book → Arabic voice). RAWY-227: if a session is already reading THIS chapter, resume
  // it in place instead of restarting at the top; and when a saved cursor belongs to this chapter, CONTINUE
  // from it by default (no dismissible prompt).
  const startListen = async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    // RAWY-227: a live session whose chapter is ON SCREEN must NOT be torn down and restarted at the top by
    // Listen — if it's paused, resume in place; if playing, it's already reading this chapter (no-op). A
    // session on a DIFFERENT chapter (navigated away) falls through and reads the current chapter fresh.
    const live = useTts.getState();
    if (live.active && ctrl.isTtsChapterOnScreen() && (live.status === "paused" || live.status === "playing")) {
      if (live.status === "paused") live.toggle();
      return;
    }
    const bookLang = isRtlBook ? "ar" : "en"; // RAWY-111: the store resolves the per-language voice
    // RAWY-181 (BUG 1): the first Listen used to FREEZE the window — `getCurrentChapterSentences()` is a
    // SYNCHRONOUS chapter DOM walk (segment into units + build ranges) that ran BEFORE any UI feedback,
    // and `new AudioContext()` inits on first play. Show the loading pill FIRST (instant feedback), let
    // it paint, THEN do the walk + start playback — so the work happens UNDER the visible "preparing"
    // state instead of a dead frozen frame. (The sidecar spawn / Edge connect / synth were already async.)
    useTts.setState({ active: true, status: "preparing", chapterLabel: chapter, error: null });
    // RAWY-162: read the saved TTS cursor BEFORE playback starts (playback overwrites it via the save
    // effect). RAWY-227: it is now the DEFAULT continue point, not a prompt. A stale/absent value → top.
    let saved: { cfi?: string; sec?: number; idx: number; snip?: string } | null = null;
    try {
      const raw = await settingsGet(`tts_position:${initial.id}`);
      if (raw) saved = JSON.parse(raw);
    } catch { saved = null; }
    await nextPaint(); // let the "preparing" pill paint before the chapter walk
    // RAWY-182: the walk is now async + CHUNKED (non-blocking), so the pill + shrink button stay
    // responsive throughout preparation instead of the thread being hogged until audio starts.
    const sentences = await ctrl.getCurrentChapterSentences(bookLang);
    // RAWY-227: CONTINUE from the saved position by DEFAULT — but ONLY when the saved cursor belongs to the
    // chapter being started (same section). This is the interaction gate with FIX A: a next-chapter arrival
    // (goToNextChapter → startListen) has a saved cursor from the OLD section, so it correctly reads the NEW
    // chapter from its TOP. Resolution mirrors the old resume mapping (prefer the saved idx when its text
    // still matches `snip`, else search the sentences for `snip`, else clamp) so re-segmentation can't land
    // on the wrong sentence.
    const sameChapter = !!(saved && typeof saved.idx === "number" && saved.sec === ctrl.currentSectionIndex() && saved.idx > 0);
    let startIndex = 0;
    if (sameChapter && saved) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const key = norm(saved.snip ?? "").slice(0, 24);
      const at = saved.idx;
      if (key && sentences[at] && norm(sentences[at]).startsWith(key)) startIndex = at;
      else if (key) { const k = sentences.findIndex((s) => norm(s).includes(key)); startIndex = k >= 0 ? k : Math.min(Math.max(0, at), sentences.length - 1); }
      else startIndex = Math.min(Math.max(0, at), sentences.length - 1);
    }
    // WP-5A: the SNIFFED script rides along so the pre-flight can refuse before any synthesis.
    useTts.getState().start({ sentences, lang: bookLang, startIndex, chapterLabel: chapter, bookScript: useReader.getState().bookScript });
  };
  // RAWY-186 (Part A): the Play/Pause gesture (pill button AND Space). Read-aloud audio is decoupled from
  // the view (RAWY-129: you can browse while listening), so pressing Play after navigating to a DIFFERENT
  // chapter used to RESUME the old chapter. Now: PAUSE always pauses in place; PLAY (from paused) reads the
  // chapter you're CURRENTLY viewing if you've navigated away (restart at its top — startListen; the 184-A
  // gate then offers a same-chapter resume only when the saved cursor belongs here), else resumes normally.
  // The top-bar Listen already restarts the current chapter, so this makes every Play consistent. Returns
  // whether it acted, so Space is only swallowed when it did. `startListen` reads the live current section.
  const playOrRelisten = (): boolean => {
    const st = useTts.getState();
    const ctrl = ctrlRef.current;
    if (!st.active) return false;
    // RAWY-257 3B (C6 — blocker 1): `buffering` joins `playing` here. This gate is where EVERY pause gesture
    // converges — the pill button, the kashida bead, Space from the app, and Space from inside the reading
    // frame (FoliateController.onSpace → playRef) — so while `buffering` fell through to the `return false`
    // below, a pause was silently discarded at the moment the user most wanted it: mid-stall. Measured live:
    // the button was enabled, showed a spinner, the click dispatched, and the status stayed `buffering` for
    // 10 s of sampling, then played anyway. `toggle()` in tts.ts is the actuator (C6 blocker 2).
    if (st.status === "playing" || st.status === "buffering") { st.toggle(); return true; } // pause in place
    if (st.status === "paused") {
      if (ctrl && !ctrl.isTtsChapterOnScreen()) { void startListen(); return true; } // navigated away → current chapter
      st.toggle(); // same chapter → resume where it paused
      return true;
    }
    // RAWY-190 (chapter-end): a chapter finished (or the user navigated to a fresh chapter after one
    // finished) — Play reads the CURRENT chapter from its top, so the button is never dead. Shared by the
    // pill Play, Space, and the kashida bead (all route through onPlayPause), so every state agrees.
    if (st.status === "chapter-end") { void startListen(); return true; }
    return false; // preparing / downloading / error / edge-error (RAWY-193) — Play/Space do nothing; the
                  // Edge-unavailable state is acted on only via its explicit Retry button
  };
  playRef.current = playOrRelisten;
  hideChromeRef.current = hideChrome;
  // RAWY-184 (Part B): the end-of-chapter "next chapter" control — navigate to the next spine section and
  // read it from the top. startListen reads the now-current chapter; the saved cursor is a different
  // section, so the Part A same-chapter gate shows no resume prompt.
  const nextChapter = async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    // RAWY-190: arm the flag so the relocate this navigation triggers isn't mistaken for a manual browse
    // and does NOT stop the chapter-end session before startListen() can read the new chapter (onRelocate).
    nextChapterArmedRef.current = true;
    await ctrl.goToNextChapter();
    await startListen();
  };
  // RAWY-124: listen from the SELECTION — read from the sentence the selection begins in, flowing forward.
  // RAWY-227: locate that sentence by the selection's captured DOM RANGE (exact), falling back to the
  // whitespace-normalised 24-char text match, then to the chapter top — so Listen starts at the selected
  // line, not index 0, even for Arabic (where Intl.Segmenter boundaries broke the text-only match).
  const startListenFromSelection = async (sel: SelectionInfo) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const bookLang = isRtlBook ? "ar" : "en";
    // RAWY-181 (BUG 1): same freeze-avoidance as startListen — show the loading pill + paint before the
    // synchronous chapter walk.
    useTts.setState({ active: true, status: "preparing", chapterLabel: chapter, error: null });
    await nextPaint();
    const sentences = await ctrl.getCurrentChapterSentences(bookLang); // RAWY-182: async + chunked (non-blocking)
    // RAWY-227: exact range → unit mapping first (units were just built for this on-screen chapter); the
    // 24-char normalised text match is only a FALLBACK, and the chapter top is the last resort.
    let startIndex = ctrl.ttsUnitIndexForRange(sel.range);
    if (startIndex < 0) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const needle = norm(sel.text).slice(0, 24);
      startIndex = needle ? sentences.findIndex((s) => norm(s).includes(needle)) : -1;
    }
    if (startIndex < 0) startIndex = 0;
    // RAWY-182: call start() even when empty (it surfaces the empty-chapter state), so the "preparing"
    // pill shown above never gets stuck — consistent with startListen.
    useTts.getState().start({ sentences, lang: bookLang, startIndex, chapterLabel: chapter });
  };

  // Responsive page width (RAWY-23): the slider fraction → a window-relative preferred width
  // (vw), clamped to a readable range in CSS; "match window" fills it.
  const pageFraction = style?.pageWidth ?? PAGE_WIDTH_DEFAULT;
  const fitWindow = style?.pageFitWindow ?? false;
  // RAWY-74: the page-turn chevrons belong to PAGED mode only — in scrolled mode there are no pages
  // to turn, so they're hidden (they were showing in scrolled mode where next()/prev() jump sections).
  const isPaged = (style?.flowMode ?? "scrolled") === "paged";
  // RAWY-86: a PDF is fixed-layout — ALWAYS paged (chevrons + wheel-to-page), never scrolled. This
  // is the stuck-nav fix (RAWY-85 left a PDF with no chevrons + a scroll no-op).
  const showChevrons = isPaged || isPdf;
  // RAWY-74: forward wheel events happening over the reading MARGINS (the desk / sheet padding,
  // outside foliate's content iframe) to the book's scroller, so the wheel scrolls anywhere in the
  // reading area — not only over the text. A wheel over the text fires INSIDE the iframe (never
  // bubbles here across the frame boundary), so this can't double-scroll. Paged mode ignores it.
  const onDeskWheel = (e: React.WheelEvent) => {
    // Zoom is answered before the PDF and paged branches, so Ctrl+Wheel behaves the same everywhere
    // in the reading area. (A PDF is fixed-layout and has no ReadingStyle, so it keeps paging.)
    // RAWY-291: Ctrl+Wheel now zooms a PDF as well. It previously fell through to the paging branch
    // below, so the gesture every reader expects to magnify a scan turned the page instead.
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); (isPdf ? pdfZoomByWheel : zoomByWheel)(e.deltaY); return; }
    // RAWY-86 / RAWY-293: scrolls the zoomed page first, turns the page only at its edge.
    if (isPdf) { e.preventDefault(); ctrlRef.current?.pageByWheel(e.deltaY, e.deltaX); return; }
    if (isPaged) return;
    ctrlRef.current?.scrollByWheel(e.deltaY);
  };

  // RAWY-175 (AUD-3): STABLE callbacks so the memoized ChaptersPanel skips re-rendering the ~1,300-row
  // TOC on unrelated Reader re-renders (a search batch, a TTS word tick). Behaviour identical.
  // RAWY-250 (PART 2): THAW — the freeze ends and the CURRENT position is written at once, so "I am reading
  // here now" takes effect immediately rather than waiting for the next relocate. Used by the pill's × and by
  // the end-signal (reaching the end of the chapter he landed in, incl. TTS reading it to the end).
  const thawAnchor = useCallback(() => {
    if (!anchorRef.current) return;
    anchorRef.current = null;
    setAnchorUi(null);
    const st = useReader.getState();
    if (st.cfi) progressSave(bookRef.current, st.cfi, st.fraction).catch(() => {});
  }, []);
  // RAWY-250 (PART 3): RETURN — go back to the frozen position and drop the anchor. Nothing to thaw: the
  // reader IS the frozen position again, so ordinary saving simply resumes from it.
  const returnToAnchor = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    setAnchorUi(null);
    ctrlRef.current?.goToLocator(a.cfi);
  }, []);
  // RAWY-250 (PART 4): record a chapter as READ (idempotent) and persist the set for this book.
  // RAWY-256 (addendum, case 6 — owner's decision): remember that this chapter's BEGINNING has been seen,
  // and PERSIST it per book. A 1432-chapter book is read across many sessions; if the fact died with the
  // session, closing the app mid-chapter would forfeit a chapter the owner genuinely read — making the
  // marker useless in exactly the books it exists for. Same settings key/value pattern as `chapters_read`
  // (`seen_start:<bookId>`, JSON array of section indices) ⇒ no schema change, no migration.
  const markSeenStart = useCallback((sec: number) => {
    if (sec < 0 || seenStartRef.current.has(sec)) return;
    seenStartRef.current.add(sec);
    settingsSet(`seen_start:${bookRef.current}`, JSON.stringify([...seenStartRef.current].sort((x, y) => x - y))).catch(() => {});
  }, []);
  markSeenStartRef.current = markSeenStart;

  const markChapterRead = useCallback((sec: number) => {
    if (sec < 0 || readChaptersRef.current.has(sec)) return;
    readChaptersRef.current.add(sec);
    setReadVersion((v) => v + 1); // RAWY-256: recompute the read-href Set exactly once per newly-read chapter
    // RAWY-250 (addendum 3): the WRITE is gated on `RECORD_READ_CHAPTERS`, which RAWY-250 flipped to
    // `true` once the owner confirmed the completion rule live — so read history DOES accrue, and
    // RAWY-256's Contents indicators read it. (Clearing it is one key delete per book:
    // `chapters_read:<bookId>`.) RAWY-FINAL: this comment previously still said "DATA COLLECTION IS
    // OFF", i.e. it described the exact opposite of the constant three lines above it. Comment only —
    // no behaviour was changed here.
    if (!RECORD_READ_CHAPTERS) return;
    settingsSet(`chapters_read:${bookRef.current}`, JSON.stringify([...readChaptersRef.current].sort((x, y) => x - y))).catch(() => {});
  }, []);
  thawRef.current = thawAnchor;
  markChapterReadRef.current = markChapterRead;

  // RAWY-250 (PART 1): every programmatic jump path freezes first, then navigates. These are exactly the
  // paths RAWY-232 measured as overwriting the reading position: TOC click, highlight/note, search hit
  // (below), and the in-reader bookmark list (which also routes through jumpCfi).
  // RAWY-256: the set of TOC hrefs whose chapter is READ — a STABLE reference, recomputed only when the
  // book loads or a chapter is newly marked (readVersion), never per render and never per row. The rows are
  // memo-ised (RAWY-175), so a chapter change re-renders 2 rows, not 1432.
  const readHrefs = useMemo(() => {
    const out = new Set<string>();
    if (!readChaptersRef.current.size || !tocSecMap.size) return out;
    for (const [href, sec] of tocSecMap) if (readChaptersRef.current.has(sec)) out.add(href);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocSecMap, readVersion]);

  // RAWY-250 (addendum 3): the Contents panel is ORDINARY NAVIGATION, NOT a jump — clicking a chapter targets
  // a PLACE the reader intends to read FROM, not a piece of content he wants to look at. It therefore does NOT
  // freeze and shows no pill; progress saves normally. (RAWY-232's path table measured which paths WRITE
  // progress — it was never a ruling on which are jumps.)
  // WP-4D: a TOC click IS a navigation action, so focus returns to the book. It used to navigate and
  // leave focus on the clicked row (measured: activeElement <body>/the row, arrows dead) — the panel
  // deliberately stays open, so the close-transition rule above never fired for this path.
  const jumpHref = useCallback(
    (href: string) => {
      // WP-6A: a synthesised row carries a spine index, not a real href.
      const section = parseSectionHref(href);
      const r = section != null ? ctrlRef.current?.goToSection(section) : ctrlRef.current?.goToHref(href);
      restoreReadingFocus();
      return r;
    },
    [restoreReadingFocus],
  );
  const jumpCfi = useCallback(
    (cfi: string) => {
      beginJump(cfi);
      const r = ctrlRef.current?.goToLocator(cfi);
      restoreReadingFocus();
      return r;
    },
    [beginJump, restoreReadingFocus],
  );
  const closeContents = useCallback(() => setLeftPanel((p) => (p === "contents" ? null : p)), []);
  const closeSearch = useCallback(() => setLeftPanel((p) => (p === "search" ? null : p)), []);
  // (RAWY-216 removed the two anti-spoiler toggle callbacks: the Contents panel no longer duplicates
  // those controls, so their only home is the drawer's "All books" tab, which reads useTheme directly.)

  // RAWY-34: Text / Theme / Layout each select a distinct TAB of the ONE settings drawer
  // (Text · Page · Theme — the design's band I), reusing the RAWY-24 controls. Pressing the
  // button whose tab is already showing toggles the drawer closed. Settings and Notes share the
  // right edge → opening Settings closes Notes; Contents (left) coexists with either.
  const openSettings = (section: SettingsSection) => {
    if (settingsOpen && settingsSection === section) {
      setSettingsOpen(false);
      return;
    }
    setSettingsSection(section);
    setSettingsOpen(true);
    setAnnoOpen(false);
  };

  // Shift the desk so an open edge panel sits BESIDE the page, never over it (RAWY-22). Panels are
  // PINNED to fixed PHYSICAL sides (RAWY-32 — supersedes the RAWY-30/D20 follow-direction model):
  // chapters on the physical LEFT, annotations on the physical RIGHT — they do NOT move with the
  // UI language. Physical paddingLeft/Right match those fixed sides regardless of <html dir>.
  // The three right-edge drawers (Settings 384 / Notes 300) are mutually exclusive; Contents
  // (left) coexists. Shift the desk by whichever right drawer is open so the page recenters.
  // ⚠ These MUST match the panels' CSS widths (`.reader-panel` / `.rp-trail` in global.css). The width
  // lives in two places — here it drives the desk padding + `--reading-shift` (the TTS pill, the kashida
  // and the resume hint all read it), so changing only the CSS silently de-centres the page and slides
  // those off-target. RAWY-206 widened the NOTES panel (trailing) to 340 for its book+chapter labels;
  // Contents/Search (leading) stay 300.
  const PANEL_LEAD = 300;
  const PANEL_TRAIL = 340;
  // Contents + Search both live on the physical-left and are mutually exclusive — either shifts the desk.
  const leftPad = chaptersOpen || searchOpen ? PANEL_LEAD : 0;
  // The Notes drawer pushes the desk so the page sits beside it. The SETTINGS drawer does NOT
  // (RAWY-36): it overlays the page's edge, so the page keeps its full width and the Page-width
  // control shows its real effect live while you adjust it (pushing the desk capped the sheet to
  // the narrowed space → "page width does nothing"). The top cluster stays clickable above both.
  const rightPad = annoOpen ? PANEL_TRAIL : 0;
  const deskStyle = {
    "--page-pref": `${pageWidthPx(pageFraction)}px`,
    // Page margin insets the foliate host within the sheet (RAWY-36) — reliable across flow modes
    // (foliate's !important html padding can't be beaten from injected CSS).
    "--page-margin": `${style?.marginPx ?? 56}px`,
    paddingLeft: leftPad,
    paddingRight: rightPad,
    // RESILIENCE-1 / WP-4B: the SAME insets, published as vars so the page-turn chevrons can move
    // with the reading area. They must be set here, next to the padding they mirror — an absolutely
    // positioned child cannot read its parent's padding, and a second hardcoded 300 would drift.
    "--panel-lead": `${leftPad}px`,
    "--panel-trail": `${rightPad}px`,
  } as CSSProperties;

  // RAWY-114: centre the floating read-aloud pill over the READING AREA (not the raw viewport), so an
  // open Contents/Notes panel shifts it clear of the panel — the compact pill reads this var.
  // RAWY-201: the per-book custom PAGE + BACKGROUND colours ride READER-SCOPED vars set here on
  // .reader-root (never the global --paper-bg/--app-bg → no chrome/accent bleed). Set ONLY when a real
  // colour is stored; when null the var is absent and the CSS falls back to the theme value — so an
  // untouched book is byte-identical. `--reader-page` feeds the .page-sheet margin (the iframe surface
  // gets the same value via injectedCss → no seam); `--reader-bg` feeds .reader-root + .reader-desk.
  const rootVars = {
    "--reading-shift": `${(leftPad - rightPad) / 2}px`,
    ...(style?.pageColor ? { "--reader-page": style.pageColor } : {}),
    ...(style?.backgroundColor ? { "--reader-bg": style.backgroundColor } : {}),
  } as CSSProperties;

  return (
    // RAWY-117: `chrome-hidden` propagates the auto-hide state to the LAYOUT — the reading area
    // reclaims the top the bar vacated (no dead band) and the Contents panel fills the space the
    // bars leave. Frozen offsets keyed to bars-present (page-host 70px top; panel 70/56) were the
    // A + C bugs; this class releases them. Safe now that the show-trigger only fires on intent (B).
    // RAWY-142: `flow-scrolled` (scrolled EPUB, not paged/PDF) pins the reading area full-height so a
    // bar-hide composites over a STATIONARY area instead of shifting the chapter up ~70px (the jump) —
    // the same full-height pin RAWY-130 used for TTS, now unified for all scrolled reading (global.css).
    // RAWY-249 (PART 3B): ONE focus-release mechanism for the WHOLE reader surface. Every panel, drawer, pill
    // and the selection menu is a descendant of .reader-root (no portals), so a single capture-phase click
    // handler releases focus from any POINTER-clicked keys-swallower (button / [role=button] / link) before it
    // can capture SPACE/arrows — superseding the per-container onClickCapture the toolbar/pills still carry.
    <div className={`reader-root${chromeShown ? "" : " chrome-hidden"}${ttsActive ? " tts-playing" : ""}${!isPaged && !isPdf ? " flow-scrolled" : ""}${immersive ? " immersive" : ""}${scrolledAway && !chromeShown ? " scrolled-away" : ""}${style?.immHidePill ? " im-hide-pill" : ""}${style?.immHideScrollbar ? " im-hide-scrollbar" : ""}${ttsStatus === "chapter-end" ? " tts-chapter-end" : ""}${ttsStatus === "edge-error" ? " tts-edge-error" : ""}`} style={rootVars} onClickCapture={releaseButtonFocusAfterPointerClick}>
      {/* desk + centered page sheet (the book) + page-turn affordances */}
      <div
        // RAWY-294: `pdf-view` marks EVERY PDF (it carries the scroll containment); the theme itself
        // is applied inside the page document, not by a class on this ancestor.
        className={`reader-desk${isPdf ? " pdf-view" : ""}${style?.backgroundColor ? " custom-bg" : ""}`}
        style={deskStyle}
        onWheel={onDeskWheel}
      >
        {showChevrons && (
          <button
            className="page-chevron page-chevron-left"
            // ‹ is ALWAYS the previous page and › ALWAYS the next one, in every book. These used to
            // move the page PHYSICALLY (left chevron = goLeft), so in an Arabic book ‹ advanced and
            // › went back — the same inversion the keyboard arrows had, and the same complaint. The
            // tooltip no longer needs to know the book's direction, because the control no longer
            // changes meaning with it.
            onClick={() => ctrlRef.current?.backward()}
            title={t("reader.prev")}
          >
            ‹
          </button>
        )}
        <div className={`page-sheet${fitWindow ? " fitw" : ""}`}>
          {/* RAWY-41: the bookmark marker shows ONLY where a saved bookmark is visible (not the
              old always-on ribbon). Fixed physical position; draggable along the top edge. */}
          {activeBm && <PageBookmark title={t("bookmark.here")} belowChrome={chromeShown} />}
          <div className="page-host" ref={stageRef} dir="ltr" />
          <div className="page-grain" />
          {/* The page while the book is being opened. It sits INSIDE the sheet, so the paper, its
              width and its theme are already the ones the book will use — the page does not change
              shape when the text arrives, it just fills. No timer and no minimum duration: it is
              mounted by the reader's own status and unmounts the moment the status turns `ready`,
              so what it shows is exactly how long the parse took. */}
          {opening && (
            // `dir` is the UI's, not the book's: this is Sard speaking, and it is on screen before
            // the book's own direction is even known. Without it the label inherits the LTR of the
            // page host beside it, which puts the ellipsis of "جارٍ فتح الكتاب…" on the wrong end —
            // seen on real WebKitGTK before this was set.
            <div className="page-loading" role="status" aria-live="polite" dir={uiDir}>
              <span className="sp-spinner" aria-hidden />
              <span>{t("reader.opening")}</span>
              {/* DIAGNOSTIC — throwaway. In the first WebKitGTK capture of this label, "جارٍ" sat
                  lower than "فتح الكتاب" and looked like a different typeface — the same signature as
                  the open Arabic typography defect, but here in Sard's OWN UI font rather than in
                  book content. The only difference between these two lines is the tanween (U+064D).
                  If line 1 shifts and line 2 does not, the trigger is a font fallback for the
                  diacritic; if both sit flat, the earlier capture was something else. */}
              <span>جارٍ ← tanween</span>
              <span>جار ← none</span>
            </div>
          )}
        </div>
        {showChevrons && (
          <button
            className="page-chevron page-chevron-right"
            onClick={() => ctrlRef.current?.forward()}
            title={t("reader.next")}
          >
            ›
          </button>
        )}
      </div>

      <ChaptersPanel
        open={chaptersOpen}
        onClose={closeContents}
        toc={toc}
        // An empty `toc` is ambiguous on its own — see openingState.ts. This is what tells the panel
        // whether it is looking at a book with no contents or at a book it has not finished reading.
        loading={opening}
        synthesised={synthNote}
        // A generated TOC has no native href to report as "current", so foliate's `chapterHref` stays
        // null for the whole book and the panel's scroll-to-current effect never re-fires as the
        // reader moves. Falling back to the active row's own href gives it a value that changes per
        // chapter, exactly as a native TOC does. Native books are unaffected: `chapterHref` is set,
        // so the fallback is never reached.
        currentHref={chapterHref ?? toc[tocIndex]?.href ?? null}
        activeIndex={tocIndex}
        hideTitles={hideChapterTitles}
        onJump={jumpHref}
        readHrefs={readHrefs}
        readMarker={readMarker}
        fraction={fraction}
      />

      {!isPdf && (
        <SearchPanel
          open={searchOpen}
          onClose={closeSearch}
          bookTitle={bookTitle}
          positionLabel={searchPositionLabel}
          bookDir={isRtlBook ? "rtl" : "ltr"}
          query={searchQuery}
          onQuery={setSearchQuery}
          searching={searching}
          searchProgress={searchProgress}
          hits={searchHits}
          spoilerSafe={spoilerSafe}
          onToggleSpoiler={onToggleSpoiler}
          revealAhead={revealAhead}
          onRevealAhead={setRevealAhead}
          activeCfi={activeHitCfi}
          onJump={onJumpHit}
        />
      )}

      <AnnotationsPanel
        open={annoOpen}
        onClose={() => setAnnoOpen(false)}
        onJump={jumpCfi}
        onOpenBook={onOpenBook}
        initialTab={annoTab}
      />

      <ReaderChrome
        visible={chromeShown}
        position={position}
        bookTitle={bookTitle}
        chapter={chapter}
        fraction={fraction}
        onBack={onExit}
        onContents={toggleChapters}
        onSearch={toggleSearch}
        searchOpen={searchOpen}
        onListen={startListen}
        ttsActive={ttsActive}
        onText={() => openSettings("typography")}
        onTheme={() => openSettings("colour")}
        onLayout={() => openSettings("layout")}
        onAnnotations={() => { setAnnoOpen((v) => !v); setSettingsOpen(false); }}
        onBookmark={onBookmark}
        bookmarked={!!activeBm}
        chaptersOpen={chaptersOpen}
        annoOpen={annoOpen}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        basketCount={basketCount}
        basketOpen={basketOpen}
        onBasket={() => setBasketOpen((v) => !v)}
        isPdf={isPdf}
        pdfCanListen={pdfCanListen}
        pdfPageCount={pdfPageCount}
        onScrub={onPdfScrub}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        style={style ?? ARABIC_DEFAULTS}
        update={update}
        isRtlBook={isRtlBook}
        section={settingsSection}
        onSection={setSettingsSection}
        bookThemeId={bookThemeId}
        onPickTheme={setBookTheme}
        bookTitle={bookTitle}
        hasOverride={hasOv}
        onReset={resetBook}
        unified={scope === "unified"}
        isPdf={isPdf}
        pdfThemeId={pdfThemeId}
        onPdfTheme={choosePdfTheme}
        pdfZoom={pdfZoom}
        onPdfZoomStep={pdfZoomStep}
        onPdfZoomMode={(m) => applyPdfZoom(m)}
      />

      {/* RAWY-85: no in-context selection toolbar (highlight/note/Photo Mode) for PDFs — they're
          CFI-less in Phase 0, so the whole annotation layer is disabled rather than half-working. */}
      {!isPdf && <AnnotationLayer ctrlRef={ctrlRef} readerReady={readerReady} onPhotoCard={openPhotoCard} onAddToCard={addToBasket} onListen={startListenFromSelection} />}
      {/* RAWY-105: read-aloud player (EPUB-only) — floats above the reading area while listening. */}
      {(!isPdf || pdfCanListen) && (
        <TtsPlayer
          panelLeft={chaptersOpen || searchOpen}
          panelRight={annoOpen}
          hasNextChapter={ttsStatus === "chapter-end" && (ctrlRef.current?.hasNextSection() ?? false)}
          onNextChapter={nextChapter}
          onPlayPause={playOrRelisten}
        />
      )}

      {/* RAWY-250 (PART 3): the return pill — shown only while an anchor holds (i.e. while progress is
          frozen after a jump), so the freeze is never invisible. EPUB only (a PDF has no CFI anchor). */}
      {!isPdf && anchorUi && (
        <ReturnPill
          label={anchorUi.label}
          chromeShown={chromeShown}
          onReturn={returnToAnchor}
          onDismiss={thawAnchor}
        />
      )}

      {/* RAWY-86: transient PDF feedback (find result / copied). */}

      <PhotoBasketTray open={basketOpen} onClose={() => setBasketOpen(false)} onCompose={composeBasket} />

      {photoCard && (
        <PhotoComposer
          data={photoCard}
          initialThemeId={bookThemeId}
          initialQuoteFont={devCardFont}
          lang={lang}
          onClose={() => setPhotoCard(null)}
        />
      )}

      {status === "error" && error && (
        // RAWY-79 (#11): a calm, themed failure state with its OWN recovery actions — always visible,
        // independent of the auto-hiding chrome (so a load failure with no mouse movement isn't a
        // dead end).
        //
        // RESILIENCE-1 / WP-1: the card is now driven by the CLASSIFICATION, not by a raw string.
        // Which actions appear is decided by the failure's own presentation — "Try again" is offered
        // only where retrying can actually work, which is why the reported PDF failure now offers
        // "How to update WebView2" instead of a button that could never have helped.
        <div className="reader-error-overlay" role="alert">
          <ErrorCard
            classified={error}
            handlers={{
              retry: () => openBook(initial),
              back: onExit,
              reimport: onExit, // re-importing happens in the Library — take them there
              "remove-book": onExit, // deletion lives in the Library's own two-step confirm (D31)
              "update-runtime": () => void openWebView2Help(),
            }}
            diagnosticsText={diagText}
          />
        </div>
      )}
    </div>
  );
}
