// RAWY-263 (Layer 1 §6): the LOCAL, DURABLE OUTCOME RECORDER.
//
// This exists for one reason: LISTENING-OUTCOMES.md §6 requires a real-listening baseline before any
// proposal can be judged, and no baseline exists today because `stop()` zeroes every counter when a session
// ends. It is the one deliberate exception to §7 rule 1 — it improves no Layer 1 outcome by itself; it is
// what makes the others measurable.
//
// IT MUST OBSERVE REALITY, NOT INFLUENCE IT. Four guarantees, in order of how badly a breach would matter:
//
//   1. NO WRITE WHILE AUDIO IS PLAYING. `settings_set` is a SYNC `#[tauri::command]`, and OPEN.md's
//      RAWY-183/188 lesson is that a sync command blocks the ENTIRE native window. Persistence therefore
//      happens only when nothing is sounding: on session end, on pause, and on page hide. A hard kill in the
//      middle of playback loses that session — accepted, and recorded here as a known limit rather than
//      papered over with a periodic write.
//   2. NO TIMER. Accounting is purely transition-driven: every interval is closed by arithmetic on the
//      previous transition's timestamp. There is no interval, no rAF, and no recurring cost of any kind.
//   3. NO STORE WRITES. This module never calls `setState`. It only reads. It cannot alter playback.
//   4. TOTAL FAULT ISOLATION. Every entry point is wrapped, so a defect in the recorder can never propagate
//      into the reader. If this module throws, listening continues and only the measurement is lost.
//
// It also deliberately does NOT decide contested classifications. §5 says to record raw durations and
// classify later; so interruptions are stored with their attribution evidence attached, and the summary
// reports both a raw and a filtered figure rather than silently choosing one.
import { useTts } from "./tts";
import { settingsGet, settingsSet } from "./ipc";

const KEY = "listening_outcomes_v1";
/** Retention bound. An implementation bound, NOT a Layer 1 target — the document forbids target constants,
 *  not engineering limits. Sized so the record stays small enough to write in one go while nothing plays. */
const KEEP_SESSIONS = 300;

// ---- the record shapes -------------------------------------------------------------------------------

/** One period of active listening in which nothing was sounding. Attribution evidence travels WITH it,
 *  because §5 forbids baking a classification into the measurement. */
export interface Interruption {
  /** ms since session start */
  at: number;
  ms: number;
  /** the sentence index the listener was on */
  index: number;
  /** did the cursor move within a moment before this gap? A listener-requested move makes the gap
   *  expected (§5 excludes it); a natural advance does not. */
  afterCursorMove: boolean;
  /** how far the cursor moved. +1 is ambiguous (a natural advance and a single skip look alike from
   *  outside), anything else is unambiguously listener-requested. Stored so the ambiguity stays visible. */
  cursorDelta: number;
  /** was a recovery visibly in progress during this gap? */
  duringRecovery: boolean;
}

export interface SessionRecord {
  /** wall-clock start, so sessions can be ordered and aged out */
  startedAt: number;
  /** O5 — ms from the listener's activation to the first audio. null if audio never started. */
  timeToFirstAudioMs: number | null;
  /** active listening time: sounding + silent-but-waiting, after first audio (§5) */
  activeMs: number;
  /** of which was actually sounding */
  soundingMs: number;
  interruptions: Interruption[];
  /** O6 — the listener had to act to continue (only a user action can leave an error state) */
  neededUserAction: boolean;
  /** O7 — the session ended in a state the listener had to acknowledge */
  endedAcknowledged: boolean;
  /** O8 (partial) — state changes that CAUSE a production indicator to be shown.
   *  HONEST LIMIT: whether one was actually DISPLAYED depends on the player's size, which is component-local
   *  state this module cannot see. In the minimised player nothing is shown. So this counts the events, and
   *  is an UPPER BOUND on what the listener perceived. Do not report it as "perceived" without that caveat. */
  productionStateEvents: number;
  /** context, without which an outcome change cannot be attributed (§5) */
  engine: string;
  voice: string;
  speed: number;
  chapter: string;
  units: number;
  unitsAdvanced: number;
  /** derived content profile: mean audio-seconds per spoken unit */
  meanUnitSeconds: number | null;
  /** how the audio source was performing, from the existing instrument */
  sourceMs: { n: number; p50: number; p95: number; max: number } | null;
  /** the engine's own counters at session end */
  underruns: number;
  abandoned: number;
  /** the observer began mid-session, so its start time is unknown — EXCLUDED from O5 */
  joinedLate: boolean;
  /** true when the record was written while the session was still open (a pause/hide flush) */
  partial: boolean;
}

// ---- in-flight session state -------------------------------------------------------------------------

type Phase = "idle" | "starting" | "sounding" | "silent" | "paused" | "acknowledged";

let history: SessionRecord[] = [];
let loaded = false;
let cur: SessionRecord | null = null;
let phase: Phase = "idle";
let phaseSince = 0;
let sessionT0 = 0;
let firstIndex = -1;
let lastIndex = -1;
let lastCursorMoveAt = -1;
let lastCursorDelta = 0;
let dirty = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** A cursor move is "recent" if it plausibly caused the gap we are now measuring. */
const CURSOR_WINDOW_MS = 1200;

/** Take a reading of how the audio source is performing, from the existing instrument. Kept out of `finish()`
 *  because the session's own counters are reset before this observer learns the session ended. */
function sourceSnapshot(): void {
  if (!cur) return;
  try {
    const st = (window as unknown as { __sardTtsStats?: () => { dispatchMs?: { n: number; p50: number; p95: number; max: number } | null } }).__sardTtsStats?.();
    const d = st?.dispatchMs;
    if (d && d.n > 0) cur.sourceMs = { n: d.n, p50: d.p50, p95: d.p95, max: d.max };
  } catch { /* context is optional; the outcome is not */ }
}

function closePhase(t: number, opts: { retrying: boolean }): void {
  if (!cur) return;
  const d = Math.max(0, t - phaseSince);
  if (phase === "sounding") { cur.soundingMs += d; cur.activeMs += d; }
  else if (phase === "silent") {
    cur.activeMs += d;
    cur.interruptions.push({
      at: Math.round(phaseSince - sessionT0),
      ms: Math.round(d),
      index: lastIndex,
      afterCursorMove: lastCursorMoveAt >= 0 && phaseSince - lastCursorMoveAt <= CURSOR_WINDOW_MS,
      cursorDelta: lastCursorDelta,
      duringRecovery: opts.retrying,
    });
  }
  phaseSince = t;
}

// ---- persistence (never while sounding) ---------------------------------------------------------------

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await settingsGet(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed as SessionRecord[];
    }
  } catch { /* a missing or unparseable record must never break the reader */ }
}

/** Every flush ATTEMPT, with the phase it was made in and whether it actually wrote. This exists so
 *  guarantee 1 is TESTABLE rather than asserted: an external check can prove no write ever landed while
 *  audio was sounding. Bounded, and the only thing in this module that exists for the benefit of a test. */
const journal: { at: number; phase: Phase; wrote: boolean; bytes: number }[] = [];
const JOURNAL_KEEP = 200;

/** Persist. Refuses to write while audio is sounding — guarantee 1. */
async function flush(force = false): Promise<void> {
  const note = (wrote: boolean, bytes = 0) => {
    journal.push({ at: Math.round(now()), phase, wrote, bytes });
    if (journal.length > JOURNAL_KEEP) journal.shift();
  };
  // Capture the in-flight record SYNCHRONOUSLY, before the first await. `finish()` nulls `cur` immediately
  // after calling this, so reading `cur` after `await load()` would see null and silently drop the finalised
  // session — leaving only an earlier partial write in the history. Measured: that is exactly what happened.
  const rec = cur;
  const recPartial = phase !== "idle" && phase !== "acknowledged";
  try {
    if (!dirty && !force) { note(false); return; }
    if (phase === "sounding") { note(false); return; } // never block the main thread while audio is sounding
    await load();
    const out = rec ? [...history.filter((h) => h.startedAt !== rec.startedAt), { ...rec, partial: recPartial }] : history;
    out.sort((a, b) => a.startedAt - b.startedAt);
    history = out.slice(-KEEP_SESSIONS);
    dirty = false;
    const payload = JSON.stringify(history);
    note(true, payload.length);
    await settingsSet(KEY, payload);
  } catch { /* measurement is never worth a user-visible failure */ }
}

/** Read-only view of the write journal, for verifying guarantee 1 from outside. */
export function listeningJournal(): { at: number; phase: string; wrote: boolean; bytes: number }[] {
  return journal.map((j) => ({ ...j }));
}

// ---- the observer ------------------------------------------------------------------------------------

interface Snap {
  active: boolean;
  status: string;
  index: number;
  total: number;
  engine: string;
  voice: string;
  speed: number;
  chapterLabel: string;
  retryAttempt: number;
  underruns: number;
  abandoned: number;
}

function onChange(s: Snap, p: Snap): void {
  const t = now();

  // ---- session start ----
  // Created on the RISING EDGE of `active`, but ALSO lazily whenever a session is active and we have no
  // record for it. Without the lazy case the observer goes permanently blind after anything that clears
  // `cur` mid-session — a diagnostic reset, or registration happening late (dev hot-reload does this) — and
  // blindness is indistinguishable from "nothing happened", which is the worst failure mode a measurement
  // can have. A session joined late is FLAGGED so it cannot pollute O5, which needs the true start.
  const joinedLate = s.active && !cur && !(s.active && !p.active);
  if (s.active && (!p.active || !cur)) {
    sessionT0 = t;
    phaseSince = t;
    phase = "starting";
    firstIndex = s.index;
    lastIndex = s.index;
    lastCursorMoveAt = -1;
    lastCursorDelta = 0;
    cur = {
      startedAt: Date.now(),
      timeToFirstAudioMs: null,
      activeMs: 0, soundingMs: 0, interruptions: [],
      neededUserAction: false, endedAcknowledged: false, productionStateEvents: 0,
      engine: s.engine, voice: s.voice, speed: s.speed, chapter: s.chapterLabel,
      units: s.total, unitsAdvanced: 0, meanUnitSeconds: null, sourceMs: null,
      underruns: 0, abandoned: 0, partial: true, joinedLate,
    };
    // A session joined in progress already has audio sounding, so seed the phase from reality rather than
    // pretending it is starting — otherwise the first interval would be misattributed.
    if (joinedLate) {
      phase = s.status === "playing" ? "sounding" : s.status === "paused" ? "paused" : "silent";
      cur.timeToFirstAudioMs = null; // unknowable from here; excluded from O5 by `joinedLate`
    }
    dirty = true;
  }
  if (!cur) return;

  // ---- cursor movement (context for attributing a gap) ----
  if (s.index !== p.index) {
    lastCursorDelta = s.index - p.index;
    lastCursorMoveAt = t;
    lastIndex = s.index;
    cur.unitsAdvanced = Math.max(cur.unitsAdvanced, s.index - firstIndex);
    // Snapshot how the audio source is performing WHILE THE SESSION IS ALIVE. Reading it at session end is
    // too late: `stop()` resets the latency series before this observer sees `active: false`, so the value
    // read there is always empty. Measured — the field came back null every time. Once per sentence is
    // frequent enough for context and keeps the observation path trivial.
    sourceSnapshot();
  }

  // ---- a production indicator became displayable ----
  const enteredWait = s.status === "buffering" && p.status !== "buffering";
  const enteredRetry = s.retryAttempt > 0 && p.retryAttempt === 0;
  if (enteredWait || enteredRetry) cur.productionStateEvents++;

  // ---- phase transitions ----
  const sounding = s.status === "playing";
  const waiting = s.status === "buffering";
  const paused = s.status === "paused";
  const acknowledged = s.status === "error" || s.status === "edge-error";
  const ended = s.status === "chapter-end" || !s.active;

  // O5: the first time audio actually sounds
  if (sounding && cur.timeToFirstAudioMs === null) {
    cur.timeToFirstAudioMs = Math.round(t - sessionT0);
  }

  // A listener can only leave an acknowledged state by acting (Retry / Switch / Play), so a transition OUT
  // of one is proof they had to. That is O6, inferred without any hook into the playback path.
  if ((p.status === "error" || p.status === "edge-error") && !acknowledged && s.active) {
    cur.neededUserAction = true;
  }

  let next: Phase = phase;
  if (!s.active) next = "idle";
  else if (acknowledged) next = "acknowledged";
  else if (paused) next = "paused";
  else if (sounding) next = "sounding";
  else if (waiting) next = cur.timeToFirstAudioMs === null ? "starting" : "silent";
  else if (ended) next = "paused"; // chapter end is not an interruption (§5)
  else next = cur.timeToFirstAudioMs === null ? "starting" : "paused";

  if (next !== phase) {
    closePhase(t, { retrying: p.retryAttempt > 0 || s.retryAttempt > 0 });
    phase = next;
    dirty = true;
  }

  cur.underruns = s.underruns;
  cur.abandoned = s.abandoned;

  // ---- session end ----
  if (!s.active && p.active) {
    cur.endedAcknowledged = p.status === "error" || p.status === "edge-error";
    finish();
  } else if (acknowledged && !(p.status === "error" || p.status === "edge-error")) {
    cur.endedAcknowledged = true;
    void flush(true); // nothing is sounding in an acknowledged state, so writing here is safe
  } else if (paused && !(p.status === "paused")) {
    void flush(true); // a pause is the natural safe point to persist
  }
}

function finish(): void {
  if (!cur) return;
  try {
    const ss = cur.soundingMs / 1000;
    cur.meanUnitSeconds = cur.unitsAdvanced > 0 ? Math.round(((ss * cur.speed) / cur.unitsAdvanced) * 100) / 100 : null;
    cur.partial = false;
  } catch { /* keep whatever was gathered */ }
  phase = "idle";
  dirty = true;
  void flush(true);
  cur = null;
}

// ---- summary (the owner-facing projection) ------------------------------------------------------------

export interface OutcomeSummary {
  sessions: number;
  listeningHours: number;
  /** O1 */
  continuityPct: number | null;
  /** O2 */
  interruptionSecPerHour: number | null;
  /** O3 */
  interruptionsPerHour: number | null;
  /** O4 */
  longestInterruptionMs: number | null;
  /** O5 */
  firstAudioP50Ms: number | null;
  firstAudioMaxMs: number | null;
  /** O6 / O7, per 100 sessions */
  neededActionPer100: number | null;
  endedAcknowledgedPer100: number | null;
  /** O8, upper bound — see SessionRecord.productionStateEvents */
  productionEventsPerHour: number | null;
  /** the same figures counting ONLY gaps not attributable to a listener-requested move */
  filtered: { interruptionSecPerHour: number | null; interruptionsPerHour: number | null; longestMs: number | null };
  contentProfiles: { meanUnitSeconds: number; sessions: number }[];
}

const med = (a: number[]): number | null => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function summarise(rows: SessionRecord[] = history): OutcomeSummary {
  const done = rows.filter((r) => r.activeMs > 0);
  const activeMs = done.reduce((a, r) => a + r.activeMs, 0);
  const hours = activeMs / 3_600_000;
  const sounding = done.reduce((a, r) => a + r.soundingMs, 0);
  const all = done.flatMap((r) => r.interruptions);
  // §5: a gap the listener asked for (an unambiguous cursor move) is not an interruption. A +1 move is
  // ambiguous from outside, so it is counted in the RAW figure and excluded from the FILTERED one.
  const real = all.filter((i) => !(i.afterCursorMove && i.cursorDelta !== 1));
  const filt = all.filter((i) => !i.afterCursorMove);
  const per = (n: number) => (hours > 0 ? Math.round((n / hours) * 10) / 10 : null);
  const profiles = new Map<number, number>();
  for (const r of done) if (r.meanUnitSeconds) {
    const bucket = Math.round(r.meanUnitSeconds);
    profiles.set(bucket, (profiles.get(bucket) ?? 0) + 1);
  }
  return {
    sessions: done.length,
    listeningHours: Math.round(hours * 100) / 100,
    continuityPct: activeMs > 0 ? Math.round((sounding / activeMs) * 1000) / 10 : null,
    interruptionSecPerHour: per(real.reduce((a, i) => a + i.ms, 0) / 1000),
    interruptionsPerHour: per(real.length),
    longestInterruptionMs: real.length ? Math.max(...real.map((i) => i.ms)) : null,
    firstAudioP50Ms: med(done.filter((r) => !r.joinedLate).map((r) => r.timeToFirstAudioMs).filter((x): x is number => x !== null)),
    firstAudioMaxMs: (() => { const v = done.filter((r) => !r.joinedLate).map((r) => r.timeToFirstAudioMs).filter((x): x is number => x !== null); return v.length ? Math.max(...v) : null; })(),
    neededActionPer100: done.length ? Math.round((done.filter((r) => r.neededUserAction).length / done.length) * 1000) / 10 : null,
    endedAcknowledgedPer100: done.length ? Math.round((done.filter((r) => r.endedAcknowledged).length / done.length) * 1000) / 10 : null,
    productionEventsPerHour: per(done.reduce((a, r) => a + r.productionStateEvents, 0)),
    filtered: {
      interruptionSecPerHour: per(filt.reduce((a, i) => a + i.ms, 0) / 1000),
      interruptionsPerHour: per(filt.length),
      longestMs: filt.length ? Math.max(...filt.map((i) => i.ms)) : null,
    },
    contentProfiles: [...profiles.entries()].sort((a, b) => a[0] - b[0]).map(([meanUnitSeconds, sessions]) => ({ meanUnitSeconds, sessions })),
  };
}

/** The owner-facing read path. Loads lazily so nothing is read during playback. */
export async function listeningOutcomes(): Promise<{ summary: OutcomeSummary; sessions: SessionRecord[] }> {
  await load();
  return { summary: summarise(), sessions: history };
}

/** Discard the record — used to start a clean baseline before an A/B. */
export async function resetListeningOutcomes(): Promise<void> {
  history = [];
  loaded = true;
  // `cur = null` is safe now: onChange re-creates a record lazily for an in-progress session.
  cur = null;
  phase = "idle";
  try { await settingsSet(KEY, "[]"); } catch { /* nothing to do */ }
}

// ---- registration ------------------------------------------------------------------------------------

let registered = false;
/** Observability of the observer: how many store changes were seen, and whether any were dropped by
 *  guarantee 4. Without these, a silent fault in this module is indistinguishable from "nothing happened" —
 *  which is exactly the trap the first version of this file fell into. */
let events = 0;
let faults = 0;
let lastFault: string | null = null;
export function listeningHealth(): { events: number; faults: number; lastFault: string | null; phase: string; hasSession: boolean } {
  return { events, faults, lastFault, phase, hasSession: cur !== null };
}

export function registerOutcomeRecorder(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  try {
    const pick = (s: ReturnType<typeof useTts.getState>): Snap => ({
      active: s.active, status: s.status, index: s.index, total: s.total,
      engine: s.engine, voice: s.voice, speed: s.speed, chapterLabel: s.chapterLabel,
      retryAttempt: s.retryAttempt, underruns: s.underruns, abandoned: s.abandoned,
    });
    let prev = pick(useTts.getState());
    useTts.subscribe((state) => {
      events++;
      const next = pick(state);
      // Guarantee 4 keeps a recorder fault out of the reader — but swallowing silently also makes the
      // recorder undebuggable, so the fault is RECORDED even though it is not rethrown.
      try { onChange(next, prev); } catch (e) { faults++; lastFault = String(e); }
      prev = next;
    });
    // Flush when the window goes away — the last safe point at which a record can be saved.
    const onHide = () => { if (phase !== "sounding") void flush(true); };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") onHide(); });
    (window as unknown as { __sardListening?: unknown }).__sardListening = listeningOutcomes;
    (window as unknown as { __sardListeningReset?: unknown }).__sardListeningReset = resetListeningOutcomes;
    (window as unknown as { __sardListeningJournal?: unknown }).__sardListeningJournal = listeningJournal;
    (window as unknown as { __sardListeningPhase?: unknown }).__sardListeningPhase = () => phase;
    (window as unknown as { __sardListeningHealth?: unknown }).__sardListeningHealth = listeningHealth;
    void load();
  } catch { /* the reader must work whether or not measurement does */ }
}
