// Backgrounds (RAWY-265) — the Library surface (Phase 1) and the Reading DESK (Phase 2).
//
// The images themselves are managed files (see src-tauri/src/backgrounds/mod.rs). This module owns
// what the USER controls, how those controls become CSS, and the contrast rules that keep each
// surface readable. Everything is applied through CSS custom properties on :root plus ONE gate
// attribute per surface, so a surface with no image is inert — not merely invisible (invariant I-1).
//
// ## The two surfaces have DIFFERENT measured floors, and that is the point
//
//   LIBRARY — LIB_SCRIM_MIN = 0.77
//     The library ground carries real text: book titles, shelf names, counts, the search field. The
//     floor is the least scrim at which `--text` still clears WCAG AA (4.5:1) over ANY image content,
//     across all 16 themes; Slate binds at 0.767. (AAA would need 0.930 — 7% of the photo visible —
//     which is a tint, not a background. AA for the library is the owner's ruling; reading keeps AAA.)
//
//   READING DESK — READ_SCRIM_MIN = 0.62
//     MEASURED: the desk carries NO bare text. The book sits on the OPAQUE `.page-sheet` (RAWY-146's
//     by-construction guarantee), and every floating element brings its own chrome background — the
//     thinnest being the kashida bead at 90%. With the scrim at ZERO, chrome text still clears
//     6.20:1 worst-case (bead, Slate). So no readability constraint forces a scrim here at all, and
//     0.62 is a DESIGN floor chosen by the owner for presence, not a safety floor.
//     Reading comfort is preserved structurally: the image physically cannot reach behind the text.
//
// The reading surface needs NO colour re-grounding (the library's `--lib-faint` problem does not
// recur — nothing on the desk is failing contrast), so its scrim is pure CSS and follows whatever
// theme `:root` currently carries. That matters while reading: the Reader applies the BOOK theme to
// `:root` directly, so a CSS-resolved scrim tracks it with no JS recomputation.

import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import {
  backgroundChoose,
  backgroundSetSurface,
  backgroundsList,
  settingsGet,
  settingsSet,
  type BackgroundRow,
} from "./ipc";
import { contrastRatio } from "./contrast";

export type BgSurface = "library" | "reading";

// ---- measured / ruled constants (see the module note; do not tune without re-measuring) ----
export const LIB_SCRIM_MIN = 0.77;
export const READ_SCRIM_MIN = 0.62;
const SIDEBAR_ALPHA = 0.85;
const FAINT_FLOOR = 3.0;
const FAINT_STEP = 0.05;

export const scrimMinFor = (s: BgSurface): number => (s === "library" ? LIB_SCRIM_MIN : READ_SCRIM_MIN);

/**
 * RAWY-279 — the READING surface's Presence may travel PAST 100; the LIBRARY's may not.
 *
 * The two surfaces are not symmetric, and the asymmetry is measured, not stylistic:
 *   LIBRARY — `--text` sits DIRECTLY on the composited ground, so the scrim is a live WCAG AA
 *     guarantee. Measured across all 16 themes against a pure-black/pure-white worst case, AA 4.5:1
 *     holds down to an overlay of exactly **0.77** (Slate binding) and 3:1 only to 0.65. There is NO
 *     headroom: at 0.50 the worst case is 1.99:1 and at 0.00 it is 1.08–1.85:1. Letting a reader past
 *     the floor here would ship a slider whose upper half makes the library unreadable, and no colour
 *     choice fixes it, because below the floor the ground IS an arbitrary photograph. Capped at 100.
 *   READING DESK — no bare text exists on it: the book sits on the opaque `.page-sheet`, and every
 *     floating element carries its own chrome. Measured at overlay ZERO, the thinnest of them (the
 *     kashida bead at 90%) still clears **6.23:1** worst-case across 16 themes against a 4.5:1 floor.
 *     RAWY-265 called 0.62 a DESIGN floor rather than a safety one; this is that claim re-measured.
 *
 * 260 is where the EXISTING slope reaches a fully transparent overlay: `alpha = 1 − 0.0038·p` hits 0
 * at p ≈ 263, so 260 leaves 1.2% of tint — visually the original image — without needing the clamp.
 */
const PRESENCE_MAX_LIBRARY = 100;
const PRESENCE_MAX_READING = 260;
export const presenceMaxFor = (s: BgSurface): number =>
  s === "library" ? PRESENCE_MAX_LIBRARY : PRESENCE_MAX_READING;

// PAGE OPACITY (Phase 3). MEASURED, spec §5.2: the least page opacity at which body text still clears
// WCAG AAA (7:1) over ANY image, across all 16 themes, with the desk scrim at its own 0.62 floor (the
// worst case, since a lower scrim lets more image through). Sepia binds at 0.833; 0.84 is that rounded
// up. AAA is ACHIEVED — the owner-authorised fallback to AA was measured as unnecessary and not taken.
//
// The desk scrim does substantial work here: without it AAA would permit only 7.0% translucency
// instead of 16.7%. That is spec §5.1's argument, quantified.
export const PAGE_OPACITY_MIN = 0.84;

// ---- control ranges ----
export const BG_BLUR_MAX = 40;
export const BG_PRESENCE_MAX = 100;

// TASTE constants, labelled as such — they choose a pleasant STARTING POINT, are not safety floors,
// and cannot breach one (every value they produce is clamped into the measured range above).
const LUMA_SHIFT_TARGET = 0.06;
const PRESENCE_ARRIVE_MIN = 30;
const PRESENCE_ARRIVE_MAX = 85;
const BLUR_DEFAULT = 18;

const K_ENABLED = "bg_enabled";
const K_PARAMS: Record<BgSurface, string> = {
  library: "bg_library_params",
  reading: "bg_reading_params",
};
const K_ID: Record<BgSurface, string> = {
  library: "bg_library_id",
  reading: "bg_reading_id",
};
// The surface BINDING is written by Rust inside `background_choose` / `background_set_surface` so the
// GC can read it without parsing this module's JSON. It is deliberately never written from here.

export interface BgParams {
  /** 0..100. 0 = fully scrimmed away; 100 = this surface's measured floor. */
  presence: number;
  blur: number;
  flip: boolean;
  /** background-position, in %. `cover` crops; this chooses what survives. */
  focalX: number;
  focalY: number;
  /** READING SURFACE ONLY (Phase 3). 1 = today's fully opaque paper; PAGE_OPACITY_MIN = the measured
   *  AAA floor. Default 1, and that default is load-bearing: at 1 nothing downstream changes at all. */
  pageOpacity: number;
  /**
   * RAWY-278. READING SURFACE ONLY. Whether the immersive RECEDE adds its extra blur step.
   *
   * `true` = today's behaviour exactly: in immersive mode, once the reader deliberately scrolls into
   * the page, the desk image goes from `blur` to `blur + 4px`. `false` removes ONLY that step — the
   * base blur above is untouched, and the recede's +14% scrim step is untouched, so the environment
   * still steps back, just without the extra softening.
   *
   * A USER PREFERENCE, NOT A PERFORMANCE OPTION, and the distinction is measured rather than assumed:
   * on the WebView2 runtime's own Chromium at a 240 Hz frame budget, a blur sweep from 0 px to 40 px
   * held p50 4.2 ms / p95 4.3 ms / worst 4.4 ms with zero dropped frames at both a 1076x628 and a
   * 1896x988 window, and the recede measured mean 4.17 ms with the step ON versus 4.17 ms with it OFF.
   * Turning this off buys nothing and must never be presented as if it did.
   *
   * Default `true`, and that default is load-bearing: a params blob written before this field existed
   * has no such key, reads as `true`, and emits no CSS at all — see `applyBackgrounds`.
   */
  immersiveBlur: boolean;
}

export const BG_DEFAULT_PARAMS: BgParams = {
  presence: 60,
  blur: BLUR_DEFAULT,
  flip: false,
  focalX: 50,
  focalY: 50,
  pageOpacity: 1,
  immersiveBlur: true,
};

/** Presence → scrim opacity, across the only range that surface permits. Full theme colour at 0, the
 *  floor at 100 — so a presence of 100 can never be unreadable by construction. */
export const scrimAlpha = (presence: number, surface: BgSurface = "library"): number => {
  // RAWY-279: the clamp is now PER SURFACE, but the divisor stays 100 and the formula is untouched.
  // That is the whole trick, and it is what makes "no migration" true rather than merely intended:
  // dividing by the per-surface MAX would rescale the curve and change what every stored value means
  // (at presence 60 the reading overlay would jump 0.848 → 0.912). Dividing by 100 keeps the SLOPE
  // identical and simply lets the reading surface travel further along the same line, so every value
  // in 0..100 resolves to the exact same alpha it always did, on both surfaces.
  const p = Math.max(0, Math.min(presenceMaxFor(surface), presence)) / 100;
  const min = scrimMinFor(surface);
  // `Math.max(0, …)` is a no-op for every value the sliders can produce (260 leaves 1.2%); it exists
  // so a hand-edited or future-larger presence can never drive a negative percentage into color-mix().
  return Math.max(0, 1 - p * (1 - min));
};

const lin = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const parseHex = (c: string): [number, number, number] | null => {
  const h = c.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};
const relLum = (rgb: [number, number, number]): number =>
  0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const toHex = (rgb: number[]): string =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/**
 * The "arrive correct" initial presence (spec §10.2). Solve for the presence at which the image
 * shifts the composited ground by at most LUMA_SHIFT_TARGET, given its own measured mean luminance:
 * the ground is `α·ground + (1−α)·image`, so the shift is `(1−α)·|imgLum − groundLum|`. An image whose
 * tone already matches the surface can be shown boldly; one that fights it arrives restrained.
 * `ground` is the surface's own base colour — `paperBg` for the library, `surfaceBg` for the desk.
 */
export function initialPresence(meanLuma: number | null, groundHex: string, surface: BgSurface = "library"): number {
  if (meanLuma == null) return BG_DEFAULT_PARAMS.presence;
  const ground = parseHex(groundHex);
  if (!ground) return BG_DEFAULT_PARAMS.presence;
  const delta = Math.abs(meanLuma - relLum(ground));
  const headroom = 1 - scrimMinFor(surface); // the largest (1−α) this surface allows
  const wanted = delta < 1e-4 ? headroom : Math.min(headroom, LUMA_SHIFT_TARGET / delta);
  const presence = (wanted / headroom) * 100;
  return Math.round(Math.max(PRESENCE_ARRIVE_MIN, Math.min(PRESENCE_ARRIVE_MAX, presence)));
}

/**
 * Re-ground `--lib-faint` so it clears FAINT_FLOOR against the WORST-CASE composited library ground.
 * LIBRARY ONLY — measured, the reading desk has no equivalent failure (nothing on it is under floor).
 * Identical in shape to RAWY-256's `resolveReadMarker` and RAWY-260's `resolveMarkOnGround`.
 */
export function regroundFaint(faint: string, paperBg: string, text: string, alpha: number): string {
  const f = parseHex(faint);
  const p = parseHex(paperBg);
  const t = parseHex(text);
  if (!f || !p || !t) return faint;
  const grounds: [number, number, number][] = [
    [0, 0, 0],
    [255, 255, 255],
  ].map((img) => p.map((v, i) => v * alpha + img[i] * (1 - alpha)) as [number, number, number]);
  const worst = grounds.reduce((a, b) => (contrastRatio(faint, toHex(a)) <= contrastRatio(faint, toHex(b)) ? a : b));
  const worstHex = toHex(worst);
  if (contrastRatio(faint, worstHex) >= FAINT_FLOOR) return faint;
  for (let k = FAINT_STEP; k <= 1.0001; k += FAINT_STEP) {
    const c = toHex(f.map((v, i) => v + (t[i] - v) * k));
    if (contrastRatio(c, worstHex) >= FAINT_FLOOR) return c;
  }
  return text;
}

/** The URL the WebView loads: the derivative when one exists, else the untouched original. */
export const bgSrcUrl = (row: BackgroundRow): string =>
  convertFileSrc(row.derivative_path ?? row.original_path);

interface BgState {
  ready: boolean;
  enabled: boolean;
  library: BackgroundRow | null;
  libraryParams: BgParams;
  reading: BackgroundRow | null;
  readingParams: BgParams;
  setEnabled: (v: boolean) => void;
  setParams: (surface: BgSurface, p: Partial<BgParams>) => void;
  /** Import + bind in one gesture, arriving at a computed presence. */
  choose: (surface: BgSurface, path: string, groundHex: string) => Promise<BackgroundRow>;
  clear: (surface: BgSurface) => Promise<void>;
  resetParams: (surface: BgSurface, groundHex: string) => void;
}

const parseParams = (raw: string | null): BgParams => {
  if (!raw) return { ...BG_DEFAULT_PARAMS };
  try {
    const o = JSON.parse(raw) as Partial<BgParams>;
    return {
      presence: typeof o.presence === "number" ? o.presence : BG_DEFAULT_PARAMS.presence,
      blur: typeof o.blur === "number" ? o.blur : BG_DEFAULT_PARAMS.blur,
      flip: !!o.flip,
      focalX: typeof o.focalX === "number" ? o.focalX : 50,
      focalY: typeof o.focalY === "number" ? o.focalY : 50,
      // A params blob written before Phase 3 has no `pageOpacity`; it reads as 1 (fully opaque), so an
      // existing profile keeps today's paper exactly. No migration, by construction.
      pageOpacity: typeof o.pageOpacity === "number" ? o.pageOpacity : 1,
      // RAWY-278: same rule. A blob written before this field existed has no key and reads as `true`,
      // which is today's behaviour — so every existing profile is unchanged without a migration.
      immersiveBlur: typeof o.immersiveBlur === "boolean" ? o.immersiveBlur : true,
    };
  } catch {
    return { ...BG_DEFAULT_PARAMS };
  }
};

/**
 * The EFFECTIVE page opacity — the ONE gate for the whole Phase 3 path.
 *
 * Returns exactly 1 unless a reading background is genuinely showing AND the reader has moved the
 * control. Everything downstream (the sheet alpha, the injected rgba paper, the `overrideBookColor`
 * coupling, all three guards) keys off this single value, so "the untouched profile is byte-identical"
 * is enforced in one place instead of being re-asserted at each site.
 */
export function effectivePageOpacity(s: Pick<BgState, "enabled" | "reading" | "readingParams"> = useBackground.getState()): number {
  if (!s.enabled || !s.reading) return 1;
  const v = s.readingParams.pageOpacity;
  if (typeof v !== "number" || !(v < 1)) return 1;
  return Math.max(PAGE_OPACITY_MIN, Math.min(1, v));
}

/** The desk scrim alpha currently in force — the guards need it to model the real ground. */
export function currentDeskScrim(s: Pick<BgState, "enabled" | "reading" | "readingParams"> = useBackground.getState()): number {
  if (!s.enabled || !s.reading) return 1; // no image → the desk is pure theme colour
  return scrimAlpha(s.readingParams.presence, "reading");
}

// Which store slots a surface owns. Typed as the literal union so a `set()` keyed on them stays
// checked — a plain `string` here would silently accept a typo and write a phantom slot.
type RowKey = "library" | "reading";
type ParamKey = "libraryParams" | "readingParams";
const rowKey = (s: BgSurface): RowKey => (s === "library" ? "library" : "reading");
const paramKey = (s: BgSurface): ParamKey => (s === "library" ? "libraryParams" : "readingParams");

export const useBackground = create<BgState>((set, get) => ({
  ready: false,
  enabled: true,
  library: null,
  libraryParams: { ...BG_DEFAULT_PARAMS },
  reading: null,
  readingParams: { ...BG_DEFAULT_PARAMS },
  setEnabled: (v) => {
    set({ enabled: v });
    settingsSet(K_ENABLED, v ? "1" : "0").catch(console.error);
  },
  setParams: (surface, p) => {
    const next = { ...get()[paramKey(surface)], ...p };
    set({ [paramKey(surface)]: next } as Partial<BgState>);
    settingsSet(K_PARAMS[surface], JSON.stringify(next)).catch(console.error);
  },
  choose: async (surface, path, groundHex) => {
    // RAWY-278 — A REPLACE PRESERVES PAGE OPACITY. A FIRST IMPORT IS UNCHANGED.
    //
    // Until now every parameter except `presence` was overwritten with the defaults on any import.
    // That is right for a FIRST image — the surface has no tuning yet, and arriving at a considered
    // default is the whole point of `initialPresence`. It is wrong for a REPLACE: it silently threw
    // away work the reader had already done. Observed in the field on a real profile — a reader with
    // `blur: 0` and `pageOpacity: 0.84` on both surfaces replaced the image and got `blur: 18` and
    // `pageOpacity: 1` back, with no action of theirs and no way to tell what had happened.
    //
    // WHY ONLY PAGE OPACITY SURVIVES (owner's ruling, and it draws the line in the right place):
    //   pageOpacity  — a READING preference. How much of the page you want to see through is about
    //                  how you read, not about which photograph is behind it, so it should not move
    //                  when the picture does.
    //   blur         — part of how a SPECIFIC image looks. One photo's artistic tuning is not a
    //                  statement about the next one, so a new image starts from the default.
    //   focalX/Y     — meaningless across images: a focal point is a coordinate in a particular
    //                  composition, and a different photo has a different subject in a different place.
    //   flip         — likewise a property of the picture, not of the surface.
    //   presence     — always recomputed, never carried: it is SOLVED against the new image's own
    //                  measured luminance against this surface's ground, so carrying it would defeat
    //                  the "arrive correct" behaviour entirely.
    //
    // `replacing` is read BEFORE the await, so it describes the state at the moment the reader asked
    // for the replacement rather than whatever the store holds when the import finally lands.
    // NOTE: `resetParams` ("Reset adjustments") is deliberately NOT changed — it still restores every
    // parameter INCLUDING page opacity, because that button's whole meaning is "put it all back".
    const replacing = get()[rowKey(surface)] !== null;
    const prev = get()[paramKey(surface)];

    // ONE call: import and bind are atomic in Rust, so the just-chosen image can never be collected
    // by a GC running between the two steps.
    const row = await backgroundChoose(surface, path);
    const params: BgParams = {
      ...BG_DEFAULT_PARAMS,
      presence: initialPresence(row.mean_luma, groundHex, surface),
      // Carried on a replace only. Harmless on the library surface, where both values are inert —
      // `effectivePageOpacity` reads `readingParams` alone and the library has no immersive mode —
      // so this needs no per-surface branch.
      //
      // ⚠ `immersiveBlur` IS A JUDGEMENT CALL, FLAGGED RATHER THAN BURIED. The owner's rule named
      // page opacity to keep and blur/flip/focal to reset, and `immersiveBlur` did not exist when it
      // was written. It is carried because it matches the KEEP reasoning, not the RESET one: the
      // reset list is things that describe a particular picture (its artistic blur, its subject's
      // position, its orientation), whereas this is a behaviour preference about immersive mode —
      // "do I want the environment to soften when I scroll in?" — which no more depends on which
      // photograph is behind it than page opacity does. One line to flip if the owner disagrees.
      ...(replacing ? { pageOpacity: prev.pageOpacity, immersiveBlur: prev.immersiveBlur } : {}),
    };
    set({ [rowKey(surface)]: row, [paramKey(surface)]: params } as Partial<BgState>);
    await settingsSet(K_PARAMS[surface], JSON.stringify(params)).catch(console.error);
    return row;
  },
  clear: async (surface) => {
    // Rust clears the binding AND collects the now-unreferenced files in the same call.
    await backgroundSetSurface(surface, null);
    set({ [rowKey(surface)]: null, [paramKey(surface)]: { ...BG_DEFAULT_PARAMS } } as Partial<BgState>);
    await settingsSet(K_PARAMS[surface], JSON.stringify(BG_DEFAULT_PARAMS)).catch(console.error);
  },
  resetParams: (surface, groundHex) => {
    const row = get()[rowKey(surface)];
    const params: BgParams = {
      ...BG_DEFAULT_PARAMS,
      presence: row ? initialPresence(row.mean_luma, groundHex, surface) : BG_DEFAULT_PARAMS.presence,
    };
    set({ [paramKey(surface)]: params } as Partial<BgState>);
    settingsSet(K_PARAMS[surface], JSON.stringify(params)).catch(console.error);
  },
}));

const LIB_VARS = ["--bg-lib-image", "--bg-lib-blur", "--bg-lib-flip", "--bg-lib-pos", "--bg-lib-scrim", "--bg-lib-sidebar", "--bg-lib-faint"];
const READ_VARS = ["--bg-rd-image", "--bg-rd-blur", "--bg-rd-flip", "--bg-rd-pos", "--bg-rd-scrim-base", "--bg-page-opacity", "--bg-rd-immstep", "--bg-rd-immscrim"];

// ---- RAWY-269: the ENTRANCE gate ------------------------------------------------------------
// Spec §10.3 wanted the background to FADE IN rather than hard-swap, and used `@starting-style` to
// get a transition on a pseudo-element that has just come into existence. But "comes into existence"
// is a property of the CONTAINER, not of the background: `.lib-root` is rebuilt on every return from
// the reader and `.reader-desk` on every book opened, so the entrance replayed on every one of them
// — from opacity 0, i.e. from the bare theme ground. Measured on a `trueblack` profile, closing a
// book took the whole window to 5.15 luma (near-black) and climbed back over ~180 ms, every time.
//
// So the CSS is gated on `[data-bg-entrance]` and this is the only thing that raises it: the moment
// a surface goes from ABSENT to PRESENT. That is app start, and the reader choosing or enabling an
// image — the two moments the fade was actually designed for — and nothing else.
const ENTRANCE_MS = 400; // > the 200ms fade, so the attribute outlives the transition it enables
let libraryWasOn = false;
let readingWasOn = false;
let entranceTimer: number | undefined;
function markEntrance(r: HTMLElement): void {
  r.dataset.bgEntrance = "1";
  if (entranceTimer !== undefined) window.clearTimeout(entranceTimer);
  entranceTimer = window.setTimeout(() => {
    delete r.dataset.bgEntrance;
    entranceTimer = undefined;
  }, ENTRANCE_MS);
}

/**
 * Write both surfaces to the document, or REMOVE every trace of one.
 *
 * The "off" branch deletes the gate attribute and every custom property rather than setting them to
 * neutral values — invariant I-1 requires an untouched profile to be inert, not merely to look the
 * same. With no background there is no gate attribute, so not one RAWY-265 CSS rule can match, no
 * compositing layer is created, and no image is decoded.
 */
export function applyBackgrounds(theme: { paperBg: string; text: string; muted: string }): void {
  const r = document.documentElement;
  const s = useBackground.getState();

  // ---- Library ----
  if (!s.enabled || !s.library) {
    delete r.dataset.bgLibrary;
    for (const k of LIB_VARS) r.style.removeProperty(k);
    libraryWasOn = false; // RAWY-269: turning it back on is a genuine arrival, and gets its fade
  } else {
    if (!libraryWasOn) markEntrance(r); // RAWY-269
    libraryWasOn = true;
    const p = s.libraryParams;
    const alpha = scrimAlpha(p.presence, "library");
    // `--lib-faint` is computed from the SAME token expression the stylesheet uses
    // (`color-mix(in srgb, muted 62%, paper-bg)`), resolved here so the blend has real numbers — a
    // color-mix() result cannot be read back out of CSS for a contrast calculation.
    const f = parseHex(theme.muted);
    const pg = parseHex(theme.paperBg);
    const faint = f && pg ? toHex(f.map((v, i) => v * 0.62 + pg[i] * 0.38)) : theme.muted;
    r.style.setProperty("--bg-lib-image", `url("${bgSrcUrl(s.library)}")`);
    r.style.setProperty("--bg-lib-blur", `${Math.max(0, Math.min(BG_BLUR_MAX, p.blur))}px`);
    r.style.setProperty("--bg-lib-flip", p.flip ? "-1" : "1");
    r.style.setProperty("--bg-lib-pos", `${p.focalX}% ${p.focalY}%`);
    // Emitted as PERCENTAGES because that is what `color-mix()` consumes directly.
    r.style.setProperty("--bg-lib-scrim", `${(alpha * 100).toFixed(2)}%`);
    r.style.setProperty("--bg-lib-sidebar", `${(SIDEBAR_ALPHA * 100).toFixed(0)}%`);
    r.style.setProperty("--bg-lib-faint", regroundFaint(faint, theme.paperBg, theme.text, alpha));
    r.dataset.bgLibrary = "on";
  }

  // ---- Reading desk ----
  // No colour is computed here: the desk scrim is `--app-bg` resolved in CSS, so it follows whatever
  // theme `:root` currently carries. While a book is open that is the BOOK theme (the Reader applies
  // it to `:root` directly and restores the library theme on exit), which is exactly the colour the
  // desk should tint toward — and it tracks a live theme change with no JS involvement at all.
  // The PAGE-OPACITY gate is separate from the reading gate: the desk image can be showing while the
  // paper stays fully opaque (the default). Only when the reader actually moves the control does the
  // translucent-paper path exist at all — see `effectivePageOpacity`.
  const pageOp = effectivePageOpacity(s);
  if (pageOp < 1) {
    r.style.setProperty("--bg-page-opacity", `${(pageOp * 100).toFixed(2)}%`);
    r.dataset.bgPage = "on";
  } else {
    delete r.dataset.bgPage;
    r.style.removeProperty("--bg-page-opacity");
  }

  if (!s.enabled || !s.reading) {
    delete r.dataset.bgReading;
    for (const k of READ_VARS) r.style.removeProperty(k);
    readingWasOn = false; // RAWY-269 — see the library half
  } else {
    if (!readingWasOn) markEntrance(r); // RAWY-269
    readingWasOn = true;
    const p = s.readingParams;
    r.style.setProperty("--bg-rd-image", `url("${bgSrcUrl(s.reading)}")`);
    r.style.setProperty("--bg-rd-blur", `${Math.max(0, Math.min(BG_BLUR_MAX, p.blur))}px`);
    r.style.setProperty("--bg-rd-flip", p.flip ? "-1" : "1");
    r.style.setProperty("--bg-rd-pos", `${p.focalX}% ${p.focalY}%`);
    // The BASE only. CSS derives the live `--bg-rd-scrim` from it (a registered property, so the
    // immersive recede can interpolate) and the receded state ADDS to this base — never subtracts,
    // so the floor cannot be undercut from the stylesheet.
    r.style.setProperty("--bg-rd-scrim-base", `${(scrimAlpha(p.presence, "reading") * 100).toFixed(2)}%`);
    // RAWY-278 — the immersive blur STEP, and the asymmetry here is the whole design.
    //
    // ENABLED (the default) writes NOTHING. The stylesheet's own `var(--bg-rd-immstep, 4px)` fallback
    // supplies the 4px, so the enabled path emits not one property that today does not emit, and
    // "pixel-identical to the current release" is true BY CONSTRUCTION rather than by re-derivation.
    // DISABLED writes `0px`, which collapses the receded filter to `blur(base + 0px)` — the same
    // computed value as the un-receded state, so Chromium starts no transition and re-rasterises
    // nothing. Nothing else in the recede is touched: the +14% scrim step still runs.
    //
    // `removeProperty` on the enabled branch is what makes toggling OFF then ON return to the exact
    // original state — a skipped `setProperty` would leave the stale `0px` on `:root` forever.
    //
    // ⚠ THE SCRIM STEP IS GATED HERE TOO, AND THAT IS THE ACTUAL BUG FIX.
    // The recede has TWO steps: +4px of blur AND +14% of scrim. Gating only the blur made the option
    // look broken, because on a real wallpaper the scrim step is the part you can SEE. MEASURED in
    // the running app, entering immersive with the boost switched OFF: 91.4% of pixels changed, mean
    // 3.49/255 — a clearly visible change the reader had just asked for none of. Neutralising the
    // scrim step took the same transition to 412 pixels of 792,000 (mean 0.0235/255), i.e. nothing.
    // For comparison the blur step alone is mean 1.20/255 — 2.9x SMALLER than the scrim step. A
    // contrast drop on a dark image reads as softening, which is why it was reported as "blur".
    // Same construction as the blur step: ENABLED emits nothing and the stylesheet's own `14%`
    // fallback applies, so the default is byte-identical to what shipped.
    if (p.immersiveBlur === false) {
      r.style.setProperty("--bg-rd-immstep", "0px");
      r.style.setProperty("--bg-rd-immscrim", "0%");
    } else {
      r.style.removeProperty("--bg-rd-immstep");
      r.style.removeProperty("--bg-rd-immscrim");
    }
    r.dataset.bgReading = "on";
  }
}

/** Load persisted background state. Call once at startup, in the same batch as `initTheme`, so the
 *  first paint is already correct (a later application would flash the themed ground first). */
export async function initBackground(): Promise<void> {
  const [enabled, libParams, rdParams, rows, libId, rdId] = await Promise.all([
    settingsGet(K_ENABLED).catch(() => null),
    settingsGet(K_PARAMS.library).catch(() => null),
    settingsGet(K_PARAMS.reading).catch(() => null),
    backgroundsList().catch(() => [] as BackgroundRow[]),
    settingsGet(K_ID.library).catch(() => null),
    settingsGet(K_ID.reading).catch(() => null),
  ]);
  // A missing file degrades to the theme and KEEPS the setting (spec §7.5) — the row simply resolves
  // to null here, and the user's configuration is untouched on disk.
  useBackground.setState({
    ready: true,
    enabled: enabled !== "0",
    library: libId ? (rows.find((r) => r.id === libId) ?? null) : null,
    libraryParams: parseParams(libParams),
    reading: rdId ? (rows.find((r) => r.id === rdId) ?? null) : null,
    readingParams: parseParams(rdParams),
  });
}
