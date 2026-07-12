import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { FoliateController, type SearchHit, type SelectionInfo, type TocEntry } from "../../reader-engine/FoliateController";
import { PhotoComposer } from "../photo/PhotoComposer";
import type { CardData } from "../photo/photo";
import { useReader } from "../../reader-engine/store";
import {
  ARABIC_DEFAULTS,
  defaultsForDir,
  PAGE_WIDTH_DEFAULT,
  pageWidthPx,
  type ReadingStyle,
  type RevealLabels,
} from "../../reader-engine/injectedCss";
import { bookRegister, bookSetCoverPng, bookUpdate, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
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
import { AnnotationLayer } from "./AnnotationLayer";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { PhotoBasketTray } from "./PhotoBasketTray";
import { usePhotoBasket } from "./photoBasket";
import { ChaptersPanel } from "./ChaptersPanel";
import { SearchPanel } from "./SearchPanel";
import { PageBookmark } from "./PageBookmark";
import { useAnnotations } from "./annotationsStore";
import { MARKER_WINDOW, useBookmarks } from "./bookmarksStore";
import { ReaderChrome, type SettingsSection } from "./ReaderChrome";
import { SettingsPanel } from "./SettingsPanel";
import { TtsPlayer } from "./TtsPlayer";
import { skipSentenceForArrow, toggleTtsPlayback, useTts } from "../../lib/tts";
import { useChromeOnIntent } from "./useChromeOnIntent";

// The book to open: id (for progress) + absolute file path (for the asset protocol).
export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
  cfi?: string | null; // jump-to location (RAWY-27 inbox); else resume saved progress
  format?: string | null; // RAWY-85 — 'pdf' opens read-only (no themes/annotations); else EPUB
}

const SAVE_DEBOUNCE_MS = 500;

// RAWY-181 (BUG 1): resolve AFTER the browser has painted (the 2nd rAF runs after the 1st's paint), so a
// synchronous task queued right after runs UNDER the freshly-painted UI instead of blocking a blank frame.
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function Reader({ book: initial, onExit }: { book: OpenTarget; onExit: () => void }) {
  // `uiDir` is the UI LANGUAGE direction (distinct from the book's `dir` below) — RAWY-71 uses it
  // to lay the localized placeholder/reveal widget out in the right direction.
  const { t, lang, dir: uiDir } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<FoliateController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new FoliateController();
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("text");
  // RAWY-89: Contents + Search share the physical-left, so only ONE is open at a time — a single
  // source of truth makes that structural (no two-setter races; the persisted-open effect can't
  // re-open Contents over a Search the user just opened). `chaptersOpen`/`searchOpen` are derived.
  const [leftPanel, setLeftPanel] = useState<"contents" | "search" | null>(null);
  const chaptersOpen = leftPanel === "contents";
  const searchOpen = leftPanel === "search";
  const [annoOpen, setAnnoOpen] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [annoTab, setAnnoTab] = useState<import("./AnnotationsPanel").AnnoTab>("notes");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
  // RAWY-162 (TTS resume): a saved last-spoken cursor offered on Listen (a SEPARATE cursor from the
  // reading CFI); timers for the debounced per-book save of the last-spoken sentence.
  const [resumeHint, setResumeHint] = useState<{ cfi?: string; sec?: number; idx: number; snip?: string } | null>(null);
  const ttsSaveTimer = useRef<number | undefined>(undefined);
  const ttsLastSave = useRef(0);
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
  const ttsWords = useTts((s) => s.words); // RAWY-127: the sentence's Edge word timings ([] = Piper)
  const ttsWordIndex = useTts((s) => s.wordIndex); // RAWY-127: active word (drives the karaoke pill)

  const { status, dir, fraction, chapterLabel, chapterHref, error, style, bookTitle } = useReader();
  // RAWY-43: unified (all books share one style) vs per-book. Drives where changes are written
  // and how a book's effective style/theme is resolved.
  const scope = useStyleScope((s) => s.scope);
  // RAWY-41: the current book's bookmarks; the marker shows ONLY when one is at the visible spot.
  const bookmarks = useBookmarks((s) => s.bookmarks);
  const activeBm = bookmarks.find((b) => b.fraction != null && Math.abs(b.fraction - fraction) <= MARKER_WINDOW) ?? null;
  // THEME is per-book (RAWY-40) — read from `bookThemeId`, not the global store. Override-book-
  // colour + hide-chapter-titles stay GLOBAL flags (set in Global Settings / chapters panel).
  const { overrideBookColor, hideChapterTitles, hideFirstLine, setHideTitles, setHideFirstLine } = useTheme();
  const { visible: chromeVisible, signalMove, signalScroll, setHold } = useChromeOnIntent();

  const openBook = useCallback(async (target: OpenTarget) => {
    const set = useReader.getState().set;
    // RAWY-78: supersede any in-flight open and capture THIS invocation's epoch. `stale()` turns
    // true once a newer open starts or this reader unmounts — re-checked after every await so a
    // superseded continuation bails before touching any shared state.
    const epoch = ++openEpoch.current;
    const stale = () => openEpoch.current !== epoch;
    try {
      bookRef.current = target.id;
      set({ status: "loading", bookId: target.id });

      const url = convertFileSrc(target.filePath);

      await bookRegister(target.id, target.filePath);
      if (stale()) return;
      const saved = await progressGet(target.id);
      if (stale()) return;
      // RAWY-85: a PDF is fixed-layout — it has a page index, not a CFI. It resumes by FRACTION and
      // gets none of the EPUB typography/annotation machinery.
      const targetIsPdf = (target.format ?? "").toLowerCase() === "pdf";
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
      const global = await loadGlobalStyle(target.dir ?? undefined);
      if (stale()) return;
      const override = await loadBookOverride(target.id);
      // Guards the block below — the ref writes, module-level applyTheme, and ctrl.open (which would
      // otherwise run on a null/superseded stage and throw A's error onto B).
      if (stale()) return;
      libraryThemeRef.current = ts.themeId; // restore this to the chrome on exit
      globalStyleRef.current = global;
      overrideRef.current = override;
      // The book's theme comes from the shared BOOK theme (D29), NOT the Library theme:
      // unified → the shared book theme; per-book → this book's override, else the shared book theme.
      const bookDefault = ts.bookThemeId;
      const effTheme = unified ? bookDefault : (override.themeId ?? bookDefault);
      const initialStyle = unified ? global : effectiveStyle(global, override);

      const ctrl = ctrlRef.current!;
      ctrl.onRelocate(({ cfi, fraction, chapterLabel, chapterHref }) => {
        set({ cfi, fraction, chapterLabel, chapterHref });
        if (progressTimer.current) clearTimeout(progressTimer.current);
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
        flags: { overrideBookColor: ts.overrideBookColor, hideChapterTitles: ts.hideChapterTitles, hideFirstLine: ts.hideFirstLine },
        dir: target.dir ?? undefined, // RAWY-85: a PDF's manual RTL override lives in books.dir too
        flow: initialStyle.flowMode, // scrolled (default) or paged — RAWY-25
        revealLabels: makeRevealLabels(), // RAWY-70
      });
      // Superseded during the (async) open → don't publish ready/toc or bind the shared stores; the
      // newer open owns them now.
      if (stale()) return;

      setBookThemeId(effTheme);
      setHasOv(!unified && calcHasOverride(override)); // Reset is a per-book affordance
      set({ status: "ready", dir: ctrl.dir ?? "?", style: initialStyle, bookTitle: ctrl.title ?? null });
      if (targetIsPdf) setPdfPageCount(ctrl.pdfPageCount); // RAWY-87: total pages for the position readout
      setToc(ctrl.getToc()); // chapters panel (RAWY-21)

      // RAWY-85: enrich a PDF's real title/author (PDF.js getMetadata) + a page-1 cover (getCover)
      // ONCE — import stored only the filename + no cover. The library reflects it on next visit.
      if (targetIsPdf) {
        const done = await settingsGet(`pdf_meta:${target.id}`).catch(() => null);
        if (!done && !stale()) {
          const t = ctrl.title;
          if (t && t.trim()) await bookUpdate(target.id, { title: t, author: ctrl.author }).catch(console.error);
          const bytes = await ctrl.getCoverBytes();
          if (bytes && bytes.byteLength) await bookSetCoverPng(target.id, bytes).catch(console.error);
          await settingsSet(`pdf_meta:${target.id}`, "1").catch(() => {});
        }
      }
      // Load this book's highlights/notes into the shared store (in-context layer + panel).
      useAnnotations.getState().bind(ctrl, target.id);
      await useAnnotations.getState().load();
      if (stale()) return;
      useBookmarks.getState().load(target.id); // RAWY-41 — this book's saved locations
    } catch (e) {
      // A SUPERSEDED open's error (e.g. ctrl.open on a null stage after unmount) must NOT flip the
      // current book into the error overlay — only report a failure that belongs to the live open.
      if (stale()) return;
      set({ status: "error", error: String(e) });
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
      ctrlRef.current?.dispose();
      // RAWY-155: read-aloud is a per-reading-session activity — leaving the book (Back to Library,
      // opening a different book, the error screen — every exit unmounts the Reader or changes
      // `initial.id`) must STOP it completely. `useTts.stop()` halts both engines' playback + the
      // WebAudio context, cancels the synth queue (gen++ so no late sentence fires) and the karaoke
      // RAF, stops the Piper sidecar, and resets the pill/store. Without this the module-level engine
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
    const targetIsPdf = (initial.format ?? "").toLowerCase() === "pdf";
    const flush = async () => {
      const st = useReader.getState();
      // progress: same rule as the debounced save (a PDF persists by fraction with an empty cfi)
      if (st.cfi || targetIsPdf) await progressSave(bookRef.current, st.cfi ?? "", st.fraction).catch(() => {});
      // the last-spoken TTS sentence: the same cursor the throttled save + stop-on-exit write
      if (useTts.getState().active) {
        const cur = ctrlRef.current?.getTtsCursor(useTts.getState().index);
        if (cur) await settingsSet(`tts_position:${initial.id}`, JSON.stringify(cur)).catch(() => {});
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
  useEffect(() => {
    if (status !== "ready") return;
    ctrlRef.current?.applyTheme(THEMES[bookThemeId], { overrideBookColor, hideChapterTitles, hideFirstLine });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideBookColor, hideChapterTitles, hideFirstLine]);

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
    ctrlRef.current?.applyTheme(THEMES[effTheme], { overrideBookColor, hideChapterTitles, hideFirstLine });
    ctrlRef.current?.applyStyle(effStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Pin the chrome open only while an ACTIVELY-DRIVEN drawer is open — Settings/Notes/basket, which
  // you interact with via the top bar. The Contents panel is DELIBERATELY excluded (RAWY-73): it is
  // a side navigation list you keep open WHILE reading, and it opens by default (RAWY-22) — pinning
  // the bar to it meant the bar never auto-hid for the owner. Contents now leaves the bar free to
  // auto-hide on idle/scroll (the panel itself stays open; it just doesn't force the bar shown).
  useEffect(
    () => setHold(settingsOpen || annoOpen || basketOpen || searchOpen),
    [settingsOpen, annoOpen, basketOpen, searchOpen, setHold],
  );

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
    ctrl?.onActivity((x, y) => signalMove(x, y));
    // RAWY-180 (Part B): Space with focus inside the reading frame toggles read-aloud when a session is
    // active (returns true → the frame swallows the key); otherwise Space keeps scrolling/paging.
    ctrl?.onSpace(() => toggleTtsPlayback());
    // RAWY-184 (Part C): Left/Right arrow with focus inside the reading frame skips the prev/next SENTENCE
    // while read-aloud is active (RTL-aware via the UI direction, matching the ⏮/⏭); otherwise the arrows
    // keep their normal page-turn.
    ctrl?.onArrow((key) => skipSentenceForArrow(key, uiDir));
    // RAWY-73/130: scroll-down hides the bars, scroll-up shows them — the SAME during TTS now (RAWY-129
    // gated this off to dodge a reflow hitch; RAWY-130 removes the gate and instead pins the reading area
    // full-height during TTS via `.reader-root.tts-playing .page-host` (global.css), so the bars hide/show
    // by compositing over a stationary reading area — smooth, no page-host relayout).
    ctrl?.onScrollIntent((down) => signalScroll(down));
    // RAWY-129 (A): after returning to a still-playing chapter (its overlay is recreated, units rebuilt with
    // fresh ranges), re-draw the reading track at the CURRENT sentence/word from the store.
    ctrl?.onReadingRedraw(() => {
      const st = useTts.getState();
      if (!st.active) return;
      ctrl.showReadingHighlight(st.index);
      ctrl.setReadingWords(st.index, st.words);
      ctrl.showReadingWord(st.wordIndex);
    });
  }, [signalMove, signalScroll, uiDir]);

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
    // RAWY-127: (re)build the word sub-ranges for this sentence (empty for Piper → no pill).
    ctrl.setReadingWords(ttsIndex, ttsWords);
    if (ttsStatus === "playing") ctrl.followReadingSentence(ttsIndex);
  }, [ttsActive, ttsIndex, ttsStatus, ttsWords]);

  // RAWY-127 (word karaoke, Edge only): move the solid pill to the active word within the sentence
  // track. Driven by the queue's `wordIndex` (a rAF loop maps the audio clock → the spoken word);
  // -1 / no timing (Piper / fallback) → no pill, the Phase-1 sentence spotlight stands alone.
  useEffect(() => {
    if (!ttsActive) return;
    ctrlRef.current?.showReadingWord(ttsWordIndex);
  }, [ttsActive, ttsWordIndex]);

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

  // RAWY-162: the resume hint auto-dismisses after a while and whenever read-aloud stops.
  useEffect(() => {
    if (!resumeHint) return;
    const t = window.setTimeout(() => setResumeHint(null), 12000);
    return () => clearTimeout(t);
  }, [resumeHint]);
  useEffect(() => {
    if (!ttsActive) setResumeHint(null);
  }, [ttsActive]);
  // RAWY-184 (Part A): navigating to a DIFFERENT chapter drops any resume hint, so a stale same-chapter
  // offer can never jump back once the reader has moved on (belt-and-braces with the same-chapter gate).
  useEffect(() => {
    setResumeHint(null);
  }, [chapterHref]);


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

  // THEME change from the Theme tab. Applies to the reading surface (:root while reading + the
  // book iframe) but NEVER to the Library's own theme (RAWY-48/D29). PER-BOOK (RAWY-40): change
  // ONLY this book's paper+ink (persisted in the book override). UNIFIED (RAWY-43): set the shared
  // BOOK theme (`book_theme_id`) so every book follows it — the Library theme (`theme_id`) is left
  // untouched, so returning to the Library still shows its own theme.
  const setBookTheme = (id: ThemeId) => {
    setBookThemeId(id);
    applyTheme(THEMES[id]);
    ctrlRef.current?.applyTheme(THEMES[id], { overrideBookColor, hideChapterTitles, hideFirstLine });
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
    ctrlRef.current?.applyTheme(THEMES[bookDefault], { overrideBookColor, hideChapterTitles, hideFirstLine });
    ctrlRef.current?.applyStyle(global);
  };

  // RAWY-41: toggle a bookmark at the CURRENT reading location (CFI + fraction + chapter). If the
  // visible spot is already bookmarked, remove it; else add. The button reflects bookmarked state.
  const onBookmark = () => {
    const st = useReader.getState();
    if (!st.cfi) return;
    useBookmarks.getState().toggle(st.cfi, st.chapterLabel, st.fraction);
  };

  // RAWY-85: PDF Phase 0 is READ-ONLY. `isPdf` gates the EPUB-only affordances (themes/fonts/
  // annotations/Photo Mode) behind honest in-app messaging. A PDF has no spine page-progression, so
  // the reader offers a manual reading-DIRECTION override for Arabic PDFs; changing it persists the
  // choice (books.dir via metadata_override) and re-opens the PDF at the current page.
  const isPdf = (initial.format ?? "").toLowerCase() === "pdf";
  // RAWY-86: PDF appearance INVERT (approximate night mode — a CSS invert filter, NOT real themes;
  // it flips images too), persisted per book. Plus copy-selection. Feedback rides a small transient
  // message. RAWY-141: the reading-direction override + in-PDF find were removed (see SettingsPanel).
  const [pdfInvert, setPdfInvert] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);
  const pdfMsgTimer = useRef<number | undefined>(undefined);
  const flashPdf = (m: string) => {
    setPdfMsg(m);
    if (pdfMsgTimer.current) clearTimeout(pdfMsgTimer.current);
    pdfMsgTimer.current = window.setTimeout(() => setPdfMsg(null), 2600);
  };
  useEffect(() => {
    if (!isPdf) return;
    settingsGet(`pdf_invert:${initial.id}`).then((v) => setPdfInvert(v === "1")).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const togglePdfInvert = () => {
    setPdfInvert((v) => {
      const next = !v;
      settingsSet(`pdf_invert:${initial.id}`, next ? "1" : "0").catch(() => {});
      return next;
    });
  };
  const copyPdfSelection = async () => {
    const txt = (await ctrlRef.current?.copyPdfSelection()) ?? "";
    flashPdf(txt ? t("pdf.copied") : t("pdf.copyEmpty"));
  };

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

  // per-book spoiler-safe preference (default ON) — remembered per book (design §5)
  useEffect(() => {
    if (isPdf) return;
    settingsGet(`spoiler_safe:${initial.id}`).then((v) => setSpoilerSafe(v !== "0")).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      settingsSet(`spoiler_safe:${initial.id}`, next ? "1" : "0").catch(() => {});
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onJumpHit = useCallback((hit: SearchHit) => {
    setActiveHitCfi(hit.cfi);
    // RAWY-139: pass the split excerpt so goToSearchHit can re-find the hit's exact text in the rendered
    // doc (the search CFI is unreliable there — the rendered structure differs from the search doc).
    ctrlRef.current?.goToSearchHit(hit.cfi, { pre: hit.pre, match: hit.match, post: hit.post });
  }, []);
  // the reader's position label for the toggle + "you are here" (current chapter, else a percent)
  const searchPositionLabel = chapterLabel || t("reader.percentRead", { p: localeNum(Math.round(fraction * 100), lang) });

  // RAWY-88: ⌘F / Ctrl-F / "/" opens search even in immersive mode (design §1). Ignored while typing.
  useEffect(() => {
    if (isPdf) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName ?? "");
      const cmdF = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
      const slash = e.key === "/" && !typing;
      if (cmdF || slash) {
        e.preventDefault();
        setLeftPanel("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdf]);

  // RAWY-49: open the Photo Mode composer for a selected passage. The card starts on the book's
  // current theme + direction, with the book title/author/chapter as removable metadata.
  const openPhotoCard = (sel: SelectionInfo) => {
    const ctrl = ctrlRef.current;
    const st = useReader.getState();
    setPhotoCard({
      quote: sel.text.replace(/\s+/g, " ").trim(),
      dir: dir === "rtl" ? "rtl" : "ltr",
      bookId: bookRef.current,
      cfi: sel.cfi,
      bookTitle: ctrl?.title ?? st.bookTitle ?? undefined,
      author: ctrl?.author,
      chapterLabel: st.chapterLabel ?? undefined,
      date: new Date(),
    });
  };

  // RAWY-60: "Add to card" collects a passage into the session basket with the chapter it was
  // taken from (so a card can span chapters). A new book resets the basket (store-side).
  const addToBasket = (sel: SelectionInfo) => {
    const ctrl = ctrlRef.current;
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
        bookTitle: ctrl?.title ?? st.bookTitle ?? null,
        author: ctrl?.author ?? null,
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
  const tocIndex = toc.findIndex((c) => c.href && c.href === chapterHref);
  const realChapterNum = extractChapterNumber(chapterLabel);
  const chapter = hideChapterTitles
    ? t("panel.chapter", { n: localeNum(realChapterNum ?? (tocIndex >= 0 ? tocIndex : 0) + 1, lang) })
    : chapterLabel || t("reader.chapterFallback");

  // RAWY-105: start read-aloud from the current chapter (Stage 1 entry; Stage 2 adds
  // listen-from-selection). Voice defaults by the BOOK's direction (Arabic book → Arabic voice).
  const startListen = async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const bookLang = isRtlBook ? "ar" : "en"; // RAWY-111: the store resolves the per-language voice
    // RAWY-181 (BUG 1): the first Listen used to FREEZE the window — `getCurrentChapterSentences()` is a
    // SYNCHRONOUS chapter DOM walk (segment into units + build ranges) that ran BEFORE any UI feedback,
    // and `new AudioContext()` inits on first play. Show the loading pill FIRST (instant feedback), let
    // it paint, THEN do the walk + start playback — so the work happens UNDER the visible "preparing"
    // state instead of a dead frozen frame. (The sidecar spawn / Edge connect / synth were already async.)
    useTts.setState({ active: true, status: "preparing", chapterLabel: chapter, error: null, notice: null });
    // RAWY-162: read the saved TTS cursor BEFORE playback starts (playback overwrites it via the save
    // effect), so we can offer a resume. A stale/absent value → no prompt (behaves exactly as before).
    let saved: { cfi?: string; sec?: number; idx: number; snip?: string } | null = null;
    try {
      const raw = await settingsGet(`tts_position:${initial.id}`);
      if (raw) saved = JSON.parse(raw);
    } catch { saved = null; }
    await nextPaint(); // let the "preparing" pill paint before the chapter walk
    // RAWY-182: the walk is now async + CHUNKED (non-blocking), so the pill + shrink button stay
    // responsive throughout preparation instead of the thread being hogged until audio starts.
    const sentences = await ctrl.getCurrentChapterSentences(bookLang);
    useTts.getState().start({
      sentences,
      lang: bookLang,
      startIndex: 0,
      chapterLabel: chapter,
    });
    // RAWY-184 (Part A): only offer resume when the saved cursor belongs to the CURRENT chapter (and is
    // past its start). Pressing Play always reads the CURRENT chapter from the top; if the saved cursor
    // is in a DIFFERENT chapter, there is NO prompt and NO jump-back — so an ignored hint from an earlier
    // chapter can never later start the wrong (saved) chapter. (Same-chapter resume still prompts + jumps.)
    if (saved && typeof saved.idx === "number" && saved.sec === ctrl.currentSectionIndex() && saved.idx > 0) {
      setResumeHint(saved);
    } else {
      setResumeHint(null);
    }
  };
  // RAWY-162: the user chose "resume" on the hint — map the saved cursor to a live sentence (navigating
  // to its chapter if needed) and restart playback there (spotlight 126 + karaoke 127 re-align).
  const doResume = async () => {
    const cursor = resumeHint;
    setResumeHint(null);
    const ctrl = ctrlRef.current;
    if (!ctrl || !cursor) return;
    const bookLang = isRtlBook ? "ar" : "en";
    const idx = await ctrl.prepareTtsResume(cursor, bookLang);
    if (idx < 0) return; // couldn't map the cursor → leave the normal playback running
    const sentences = await ctrl.getCurrentChapterSentences(bookLang);
    useTts.getState().start({
      sentences,
      lang: bookLang,
      startIndex: idx,
      chapterLabel: chapter,
    });
  };
  // RAWY-184 (Part B): the end-of-chapter "next chapter" control — navigate to the next spine section and
  // read it from the top. startListen reads the now-current chapter; the saved cursor is a different
  // section, so the Part A same-chapter gate shows no resume prompt.
  const nextChapter = async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    await ctrl.goToNextChapter();
    await startListen();
  };
  // RAWY-124: listen from the SELECTION (the "Stage 2" that was planned in the comment above but never
  // built). Read the chapter's blocks, find the one the selection begins in (whitespace-normalised
  // substring match), and start read-aloud from there — flowing forward. Falls back to the chapter
  // start if the block can't be located, so Listen always speaks.
  const startListenFromSelection = async (sel: SelectionInfo) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const bookLang = isRtlBook ? "ar" : "en";
    // RAWY-181 (BUG 1): same freeze-avoidance as startListen — show the loading pill + paint before the
    // synchronous chapter walk.
    useTts.setState({ active: true, status: "preparing", chapterLabel: chapter, error: null, notice: null });
    await nextPaint();
    const sentences = await ctrl.getCurrentChapterSentences(bookLang); // RAWY-182: async + chunked (non-blocking)
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const needle = norm(sel.text).slice(0, 24);
    let startIndex = needle ? sentences.findIndex((s) => norm(s).includes(needle)) : -1;
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
    if (isPdf) { ctrlRef.current?.pageByWheel(e.deltaY); return; } // RAWY-86: wheel turns PDF pages
    if (isPaged) return;
    ctrlRef.current?.scrollByWheel(e.deltaY);
  };

  // RAWY-175 (AUD-3): STABLE callbacks so the memoized ChaptersPanel skips re-rendering the ~1,300-row
  // TOC on unrelated Reader re-renders (a search batch, a TTS word tick). Behaviour identical.
  const jumpHref = useCallback((href: string) => ctrlRef.current?.goToHref(href), []);
  const jumpCfi = useCallback((cfi: string) => ctrlRef.current?.goToLocator(cfi), []);
  const closeContents = useCallback(() => setLeftPanel((p) => (p === "contents" ? null : p)), []);
  const closeSearch = useCallback(() => setLeftPanel((p) => (p === "search" ? null : p)), []);
  const onToggleHideTitles = useCallback(() => setHideTitles(!hideChapterTitles), [hideChapterTitles, setHideTitles]);
  const onToggleHideFirstLine = useCallback(() => setHideFirstLine(!hideFirstLine), [hideFirstLine, setHideFirstLine]);

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
  const PANEL = 300;
  // Contents + Search both live on the physical-left and are mutually exclusive — either shifts the desk.
  const leftPad = chaptersOpen || searchOpen ? PANEL : 0;
  // The Notes drawer pushes the desk so the page sits beside it. The SETTINGS drawer does NOT
  // (RAWY-36): it overlays the page's edge, so the page keeps its full width and the Page-width
  // control shows its real effect live while you adjust it (pushing the desk capped the sheet to
  // the narrowed space → "page width does nothing"). The top cluster stays clickable above both.
  const rightPad = annoOpen ? PANEL : 0;
  const deskStyle = {
    "--page-pref": `${pageWidthPx(pageFraction)}px`,
    // Page margin insets the foliate host within the sheet (RAWY-36) — reliable across flow modes
    // (foliate's !important html padding can't be beaten from injected CSS).
    "--page-margin": `${style?.marginPx ?? 56}px`,
    paddingLeft: leftPad,
    paddingRight: rightPad,
  } as CSSProperties;

  // RAWY-114: centre the floating read-aloud pill over the READING AREA (not the raw viewport), so an
  // open Contents/Notes panel shifts it clear of the panel — the compact pill reads this var.
  const rootVars = { "--reading-shift": `${(leftPad - rightPad) / 2}px` } as CSSProperties;

  return (
    // RAWY-117: `chrome-hidden` propagates the auto-hide state to the LAYOUT — the reading area
    // reclaims the top the bar vacated (no dead band) and the Contents panel fills the space the
    // bars leave. Frozen offsets keyed to bars-present (page-host 70px top; panel 70/56) were the
    // A + C bugs; this class releases them. Safe now that the show-trigger only fires on intent (B).
    // RAWY-142: `flow-scrolled` (scrolled EPUB, not paged/PDF) pins the reading area full-height so a
    // bar-hide composites over a STATIONARY area instead of shifting the chapter up ~70px (the jump) —
    // the same full-height pin RAWY-130 used for TTS, now unified for all scrolled reading (global.css).
    <div className={`reader-root${chromeShown ? "" : " chrome-hidden"}${ttsActive ? " tts-playing" : ""}${!isPaged && !isPdf ? " flow-scrolled" : ""}`} style={rootVars}>
      {/* desk + centered page sheet (the book) + page-turn affordances */}
      <div className={`reader-desk${isPdf && pdfInvert ? " pdf-invert" : ""}`} style={deskStyle} onWheel={onDeskWheel}>
        {showChevrons && (
          <button
            className="page-chevron page-chevron-left"
            onClick={() => ctrlRef.current?.next()}
            // The LEFT chevron always moves to the physical-left page (foliate's goLeft()) —
            // for an LTR book that's Previous; for an RTL book it's actually Next (RAWY-65: the
            // tooltip previously always said "Previous", which was wrong for Arabic books even
            // though the click behavior itself was already correct).
            title={isRtlBook ? t("reader.next") : t("reader.prev")}
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
        </div>
        {showChevrons && (
          <button
            className="page-chevron page-chevron-right"
            onClick={() => ctrlRef.current?.prev()}
            title={isRtlBook ? t("reader.prev") : t("reader.next")}
          >
            ›
          </button>
        )}
      </div>

      <ChaptersPanel
        open={chaptersOpen}
        onClose={closeContents}
        toc={toc}
        currentHref={chapterHref}
        hideTitles={hideChapterTitles}
        onToggleHideTitles={onToggleHideTitles}
        hideFirstLine={hideFirstLine}
        onToggleHideFirstLine={onToggleHideFirstLine}
        onJump={jumpHref}
        fraction={fraction}
        isPdf={isPdf}
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
        initialTab={annoTab}
      />

      <ReaderChrome
        visible={chromeShown}
        bookTitle={bookTitle}
        chapter={chapter}
        fraction={fraction}
        onBack={onExit}
        onContents={toggleChapters}
        onSearch={toggleSearch}
        searchOpen={searchOpen}
        onListen={startListen}
        ttsActive={ttsActive}
        onText={() => openSettings("text")}
        onTheme={() => openSettings("theme")}
        onLayout={() => openSettings("page")}
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
        pdfInvert={pdfInvert}
        onPdfInvert={togglePdfInvert}
        onPdfCopy={copyPdfSelection}
      />

      {/* RAWY-85: no in-context selection toolbar (highlight/note/Photo Mode) for PDFs — they're
          CFI-less in Phase 0, so the whole annotation layer is disabled rather than half-working. */}
      {!isPdf && <AnnotationLayer ctrlRef={ctrlRef} onPhotoCard={openPhotoCard} onAddToCard={addToBasket} onListen={startListenFromSelection} />}

      {/* RAWY-105: read-aloud player (EPUB-only) — floats above the reading area while listening. */}
      {!isPdf && (
        <TtsPlayer
          panelLeft={chaptersOpen || searchOpen}
          panelRight={annoOpen}
          hasNextChapter={ttsStatus === "chapter-end" && (ctrlRef.current?.hasNextSection() ?? false)}
          onNextChapter={nextChapter}
        />
      )}

      {/* RAWY-162: a tasteful, non-intrusive hint to resume the last-spoken sentence — appears on Listen
          when a saved TTS cursor exists; ignoring it keeps normal playback. */}
      {!isPdf && resumeHint && (
        <div className="tts-resume" dir={dir} role="status">
          <svg className="tts-resume-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 8v4l3 2M3.5 9A9 9 0 1 1 3 12" /><path d="M3 4v5h5" /></svg>
          <span className="tts-resume-msg">{t("tts.resumePrompt")}</span>
          <button className="tts-resume-go" onClick={doResume}>{t("tts.resume")}</button>
          <button className="tts-resume-x" onClick={() => setResumeHint(null)} aria-label={t("tts.dismiss")} title={t("tts.dismiss")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      )}

      {/* RAWY-86: transient PDF feedback (find result / copied). */}
      {pdfMsg && <div className="pdf-toast">{pdfMsg}</div>}

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

      {status === "error" && (
        // RAWY-79 (#11): a calm, themed failure state with its OWN recovery actions — always visible,
        // independent of the auto-hiding chrome (so a load failure with no mouse movement isn't a
        // dead end). "Try again" re-runs openBook for the same target; "Back to library" exits.
        <div className="reader-error-overlay" role="alert">
          <div className="reader-error-card">
            <div className="reader-error-mark" aria-hidden>⚠</div>
            <div className="reader-error-title">{t("reader.error.title")}</div>
            {error && <div className="reader-error-detail">{error}</div>}
            <div className="reader-error-actions">
              <button className="reader-error-btn primary" onClick={() => openBook(initial)}>
                {t("reader.error.retry")}
              </button>
              <button className="reader-error-btn" onClick={onExit}>
                {t("reader.error.back")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
