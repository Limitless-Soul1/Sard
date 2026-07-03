import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { FoliateController, type SelectionInfo, type TocEntry } from "../../reader-engine/FoliateController";
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
import { bookRegister, progressGet, progressSave, settingsGet, settingsSet } from "../../lib/ipc";
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
import { PageBookmark } from "./PageBookmark";
import { useAnnotations } from "./annotationsStore";
import { MARKER_WINDOW, useBookmarks } from "./bookmarksStore";
import { ReaderChrome, type SettingsSection } from "./ReaderChrome";
import { SettingsPanel } from "./SettingsPanel";
import { useChromeOnIntent } from "./useChromeOnIntent";

// The book to open: id (for progress) + absolute file path (for the asset protocol).
export interface OpenTarget {
  id: string;
  filePath: string;
  dir?: string | null;
  cfi?: string | null; // jump-to location (RAWY-27 inbox); else resume saved progress
}

const SAVE_DEBOUNCE_MS = 500;

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
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [annoOpen, setAnnoOpen] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [annoTab, setAnnoTab] = useState<import("./AnnotationsPanel").AnnoTab>("notes");
  const progressTimer = useRef<number | undefined>(undefined);
  const styleTimer = useRef<number | undefined>(undefined);
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
  const [basketOpen, setBasketOpen] = useState(false); // RAWY-60 passages tray
  const basketCount = usePhotoBasket((s) => s.passages.length);

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
  const { visible: chromeVisible, wake, signalMove, signalScroll, setHold } = useChromeOnIntent();

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
      // RAWY-27: an inbox item passes a jump CFI that wins over the saved reading position.
      const resumeCfi = target.cfi ?? saved?.cfi ?? null;

      // RAWY-40/43: per-book → effective = GLOBAL defaults with THIS book's PARTIAL override on
      // top, theme = override theme else global. UNIFIED → the GLOBAL style/theme, IGNORING (never
      // deleting) the override so switching back to per-book restores it. Per-script defaults
      // still back-fill anything the global row lacks (RTL books get the Arabic baseline).
      const ts = useTheme.getState();
      const unified = useStyleScope.getState().scope === "unified";
      const global = await loadGlobalStyle();
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
          if (cfi) progressSave(bookRef.current, cfi, fraction).catch(console.error);
        }, SAVE_DEBOUNCE_MS);
      });

      // The whole reader (chrome + page) takes the book's effective theme while reading; the
      // Library keeps the global default (restored on exit). The global store is NOT mutated.
      applyTheme(THEMES[effTheme]);
      await ctrl.open(url, stageRef.current!, {
        resumeCfi,
        style: initialStyle,
        theme: THEMES[effTheme],
        flags: { overrideBookColor: ts.overrideBookColor, hideChapterTitles: ts.hideChapterTitles, hideFirstLine: ts.hideFirstLine },
        dir: target.dir ?? undefined,
        flow: initialStyle.flowMode, // scrolled (default) or paged — RAWY-25
        revealLabels: makeRevealLabels(), // RAWY-70
      });
      // Superseded during the (async) open → don't publish ready/toc or bind the shared stores; the
      // newer open owns them now.
      if (stale()) return;

      setBookThemeId(effTheme);
      setHasOv(!unified && calcHasOverride(override)); // Reset is a per-book affordance
      set({ status: "ready", dir: ctrl.dir ?? "?", style: initialStyle, bookTitle: ctrl.title ?? null });
      setToc(ctrl.getToc()); // chapters panel (RAWY-21)
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
      ctrlRef.current?.dispose();
      // The photo-card basket is a per-reading-session collection (RAWY-60) — clear it on exit.
      usePhotoBasket.getState().clear();
      // Restore the LIBRARY theme to the chrome on exit (RAWY-40/48) — the book theme was only
      // for this reading session; the Library shows its own independent theme again.
      applyTheme(THEMES[libraryThemeRef.current]);
    };
    // Open the book the Library handed us; re-open if the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

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
    () => setHold(settingsOpen || annoOpen || basketOpen),
    [settingsOpen, annoOpen, basketOpen, setHold],
  );

  // RAWY-72: wake the auto-hiding chrome on pointer activity inside the content iframe (which never
  // reaches a window listener). A move goes through the jitter dedup; a tap always wakes.
  // RAWY-73: scroll intent (scrolled mode) — scroll down hides, scroll up shows. `wake`/`signalMove`/
  // `signalScroll` are stable, so this registers once and stays valid across section loads.
  useEffect(() => {
    ctrlRef.current?.onActivity((x, y, isTap) => (isTap ? wake() : signalMove(x, y)));
    ctrlRef.current?.onScrollIntent((down) => signalScroll(down));
  }, [wake, signalMove, signalScroll]);

  // When the basket empties (Clear, or removing the last passage) the top-bar button hides, so
  // close the now-orphaned tray too (RAWY-60).
  useEffect(() => {
    if (basketCount === 0) setBasketOpen(false);
  }, [basketCount]);

  // Chapters panel is OPEN BY DEFAULT (RAWY-22); the user's choice persists per `chapters_open`.
  useEffect(() => {
    if (status !== "ready") return;
    settingsGet("chapters_open").then((v) => setChaptersOpen(v !== "0"));
  }, [status]);

  // Placement model (RAWY-32 — supersedes the RAWY-30/D20 follow-direction model): reading panels
  // are PINNED to FIXED PHYSICAL sides that DO NOT move when the UI language flips. Chapters sits
  // on the physical LEFT; annotations and the settings slide-over both sit on the physical RIGHT —
  // each on the SAME physical side as the toolbar button that opens it (the top bar is pinned to
  // match). Chapters (left) COEXISTS with either right panel; annotations and settings share the
  // right edge, so opening one closes the other. Only panel CONTENT/labels translate with the UI
  // language; the reading TEXT stays book-directed (foliate, isolated — RAWY-12).
  const toggleChapters = useCallback(() => {
    setChaptersOpen((v) => {
      const next = !v;
      settingsSet("chapters_open", next ? "1" : "0").catch(console.error);
      return next;
    });
  }, []);

  // DEV: deterministically open a panel for screenshots (settings `dev_panel`: chapters |
  // notes | highlights). Mirrors the dev_open hook; no effect in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV || status !== "ready") return;
    settingsGet("dev_panel").then((p) => {
      if (p === "chapters") setChaptersOpen(true);
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
        else if (!Number.isNaN(Number(s))) await ctrl.goToFraction(Number(s));
        setTimeout(() => settingsSet("dev_diag", ctrl.diagnose()).catch(() => {}), 500);
      }, 350);
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
      ctrlRef.current?.applyStyle(next);
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
  const chromeShown = chromeVisible || settingsOpen || annoOpen || basketOpen;
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

  // Responsive page width (RAWY-23): the slider fraction → a window-relative preferred width
  // (vw), clamped to a readable range in CSS; "match window" fills it.
  const pageFraction = style?.pageWidth ?? PAGE_WIDTH_DEFAULT;
  const fitWindow = style?.pageFitWindow ?? false;
  // RAWY-74: the page-turn chevrons belong to PAGED mode only — in scrolled mode there are no pages
  // to turn, so they're hidden (they were showing in scrolled mode where next()/prev() jump sections).
  const isPaged = (style?.flowMode ?? "scrolled") === "paged";
  // RAWY-74: forward wheel events happening over the reading MARGINS (the desk / sheet padding,
  // outside foliate's content iframe) to the book's scroller, so the wheel scrolls anywhere in the
  // reading area — not only over the text. A wheel over the text fires INSIDE the iframe (never
  // bubbles here across the frame boundary), so this can't double-scroll. Paged mode ignores it.
  const onDeskWheel = (e: React.WheelEvent) => {
    if (isPaged) return;
    ctrlRef.current?.scrollByWheel(e.deltaY);
  };

  const jumpHref = (href: string) => ctrlRef.current?.goToHref(href);
  const jumpCfi = (cfi: string) => ctrlRef.current?.goToLocator(cfi);

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
  const leftPad = chaptersOpen ? PANEL : 0;
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

  return (
    <div className="reader-root">
      {/* desk + centered page sheet (the book) + page-turn affordances */}
      <div className="reader-desk" style={deskStyle} onWheel={onDeskWheel}>
        {isPaged && (
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
        <div className={`page-sheet${isRtlBook ? " rtl" : ""}${fitWindow ? " fitw" : ""}`}>
          {/* RAWY-41: the bookmark marker shows ONLY where a saved bookmark is visible (not the
              old always-on ribbon). Fixed physical position; draggable along the top edge. */}
          {activeBm && <PageBookmark title={t("bookmark.here")} belowChrome={chromeShown} />}
          <div className="page-host" ref={stageRef} dir="ltr" />
          <div className="page-grain" />
        </div>
        {isPaged && (
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
        onClose={() => setChaptersOpen(false)}
        toc={toc}
        currentHref={chapterHref}
        hideTitles={hideChapterTitles}
        onToggleHideTitles={() => setHideTitles(!hideChapterTitles)}
        hideFirstLine={hideFirstLine}
        onToggleHideFirstLine={() => setHideFirstLine(!hideFirstLine)}
        onJump={jumpHref}
        fraction={fraction}
      />

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
      />

      <AnnotationLayer ctrlRef={ctrlRef} onPhotoCard={openPhotoCard} onAddToCard={addToBasket} />

      <PhotoBasketTray open={basketOpen} onClose={() => setBasketOpen(false)} onCompose={composeBasket} />

      {photoCard && (
        <PhotoComposer
          data={photoCard}
          initialThemeId={bookThemeId}
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
