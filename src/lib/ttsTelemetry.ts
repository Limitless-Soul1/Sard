// READ-ALOUD RESILIENCE TELEMETRY — the local, durable record of how the failure-isolation system
// actually behaves during real listening.
//
// WHY A SECOND INSTRUMENT. `listeningOutcomes.ts` (v3) measures the LISTENER'S experience: gaps,
// underruns, time-to-first-audio, how a session ended. It predates the resilience work and cannot see
// any of it — a retry, a background recovery, a recovery round's budget, a preemption and a breaker
// trip are all invisible to a store subscription alone. This module measures the SYSTEM: every
// synthesis attempt with its role, attempt number and budget, every recovery round with its duration,
// and whether a sentence that failed ahead of playback was repaired before the listener reached it.
// v3 is left exactly as it is, on its own key, so its baseline stays comparable.
//
// IT OBSERVES; IT NEVER STEERS. The same four guarantees v3 states, for the same reasons:
//   1. NO WRITE WHILE AUDIO IS SOUNDING. `settings_set` is a SYNC `#[tauri::command]`, and a sync
//      command blocks the native window (RAWY-183/188). Persistence happens at the end of a session,
//      at a chapter end, or at teardown — never mid-sentence.
//   2. NO TIMER. Every measurement is transition-driven arithmetic, driven by the store subscription
//      and by the dispatch hook. No interval, no rAF, nothing that runs while the reader listens.
//   3. NO STORE WRITES, NO SCHEDULER CALLS. This module reads `useTts` and `ttsStats()`. It cannot
//      change a retry, a budget, a lead or a playback decision, because it never calls anything that
//      could. The one hook inside `tts.ts` (`noteDispatch`) is called AFTER an attempt has settled and
//      cannot affect its outcome.
//   4. FAULTS ISOLATED BUT COUNTED. Every entry point is wrapped; a fault increments `faults` and is
//      kept in `lastFault` rather than being swallowed.
//
// WHAT IS NEVER RECORDED. No book title, no chapter label, no author, no file path, no library id, no
// sentence text. A sentence appears as its INDEX in the chapter and its LENGTH IN CHARACTERS, which is
// what a synthesis cost has to be read against. Error strings come from the engine ("edge synth
// stalled: no audio", a socket code) and never from the book. The voice id and the playback speed are
// recorded because a latency number means nothing without them.
import { useTts } from "./tts";
import { settingsGet, settingsSet } from "./ipc";

/** The key this instrument owns. New name, new shape — never mixed with v3's outcome records. */
const KEY = "tts_resilience_v1";
/** Retention bounds. An engineering limit, chosen so a long stress test cannot grow the row without end. */
const KEEP_SESSIONS = 200;
const KEEP_DISPATCHES = 800;
const KEEP_EVENTS = 400;

// ---- record shapes ------------------------------------------------------------------------------

/** One synthesis attempt, as the scheduler dispatched it and as the engine answered. */
export interface DispatchRecord {
  /** ms since session start */
  at: number;
  /** sentence index within the chapter — a position, never text */
  unit: number;
  /** characters in that sentence: the only honest denominator for a synthesis latency */
  len: number;
  /** why the scheduler asked for it: current | lead | look-ahead | retry | probe | recovery */
  role: string;
  /** attempt number within its round (recovery rounds count 1..3; background retries count failures) */
  attempt: number;
  /** what was left of the listener's 12 s budget when a recovery attempt was dispatched */
  budgetMs: number | null;
  /** dispatch → settle, in ms */
  ms: number;
  ok: boolean;
  /** decoded audio seconds, when the attempt produced audio */
  audioSec: number | null;
  /** the classified failure kind (`edge-down`, `stall-synth`, `ws-connect`, `cancelled`, …) */
  kind: string | null;
  /** the engine's own words, truncated. Never book text. */
  detail: string | null;
}

/** A moment the listener or the system marked. Timeline, not aggregate. */
export interface TelemetryEvent {
  at: number;
  kind:
    | "firstAudio" | "advance" | "skip" | "back" | "seek" | "pause" | "resume" | "stop"
    | "voiceChange" | "speedChange" | "underrun" | "buffering" | "edgeError" | "error"
    | "retryIndicator" | "userRetry" | "recoveryStart" | "recoveryEnd" | "chapterEnd" | "health";
  unit: number;
  /** one small number or short token per event — never content */
  a?: number | string | null;
  b?: number | string | null;
}

/** Per-sentence history, so "was it repaired before playback got there?" is answerable. */
export interface UnitOutcome {
  unit: number;
  attempts: number;
  failures: number;
  /** ms since session start of the first failed attempt for this sentence */
  firstFailAt: number | null;
  /** ms since session start of the attempt that finally produced audio */
  recoveredAt: number | null;
  /** ms since session start when playback arrived at this sentence */
  reachedAt: number | null;
  /** true when playback arrived and the audio was already there (no wait) */
  reachedReady: boolean | null;
  /** true when this sentence failed while still ahead of playback AND was fixed before playback reached it */
  repairedBeforeReached: boolean;
  /** the sentence the listener was actually stopped on */
  endedInError: boolean;
}

export interface ResilienceSession {
  id: string;
  startedAt: number;          // epoch ms
  endedAt: number | null;     // epoch ms
  endReason: "stop" | "chapterEnd" | "chapterChange" | "teardown" | "open";
  // ---- context (no content) ----
  engine: string;
  voice: string;
  speed: number;
  speedChanges: number;
  voiceChanges: number;
  units: number;              // sentences in the chapter — a count
  // ---- continuity ----
  timeToFirstAudioMs: number | null;
  soundingMs: number;
  silentMs: number;           // active but nothing sounding: the audible gaps
  pausedMs: number;
  unitsAdvanced: number;
  gaps: { at: number; ms: number; unit: number; duringRecovery: boolean; afterUserAction: boolean }[];
  longestGapMs: number;
  underruns: number;          // per-session delta of the engine's own counter
  // ---- the resilience system ----
  dispatches: DispatchRecord[];
  dispatchesDropped: number;
  events: TelemetryEvent[];
  eventsDropped: number;
  unitOutcomes: UnitOutcome[];
  /** per-session deltas of `ttsStats().isolation` */
  isolation: {
    futureRetries: number; recoveries: number; recoverySuccesses: number;
    cancelled: number; probes: number; resetRetries: number; breakerTrips: number;
  };
  /** every recovery round the listener actually waited through */
  recoveryRounds: { at: number; unit: number; ms: number; attempts: number; outcome: "recovered" | "edge-error" | "abandoned"; budgetRespected: boolean }[];
  /** the highest `maxConcurrent` the scheduler reported — the single-flight invariant, observed */
  maxConcurrentEdge: number;
  /** health as the breaker reported it, in order of appearance */
  healthSeen: string[];
  playRejections: number;
  watchdogNudges: number;
  /** terminal states the listener had to acknowledge */
  edgeErrors: number;
  errors: number;
  userRetries: number;
  /** aggregate synthesis latency for this session, computed from `dispatches` */
  synth: { n: number; okN: number; failN: number; p50: number; p95: number; max: number } | null;
  /** how much decoded audio was ahead of the cursor when playback advanced, sampled at advances */
  bufferedAheadSec: { n: number; p50: number; min: number } | null;
  /** the instrument's own health, so a thin record is never mistaken for a quiet session */
  meta: { events: number; faults: number; lastFault: string | null; version: 1 };
}

// ---- in-flight state ----------------------------------------------------------------------------

type Phase = "idle" | "preparing" | "sounding" | "silent" | "paused" | "acknowledged";

let registered = false;
let loaded = false;
let history: ResilienceSession[] = [];
let cur: ResilienceSession | null = null;
let phase: Phase = "idle";
let phaseSince = 0;
let sessionT0 = 0;
let lastIndex = -1;
let lastUserActionAt = -1;
let underrunsAtStart = 0;
let isolationAtStart: Record<string, number> | null = null;
/**
 * THE LAST COUNTERS SEEN WHILE THE SESSION WAS STILL ALIVE.
 *
 * `stop()` calls `scheduler.reset()`, which zeroes the isolation counters, and only THEN sets the store
 * to idle — so a read taken when this module observes the stop returns zeros for a session that really
 * did retry and recover. Measured: a session with a recorded recovery round reported
 * `recoveries: 0`. The counters are therefore sampled at every transition and the last live sample is
 * what the finished record is built from.
 */
let lastStats: Stats = {};
/** The engine’s underrun counter as it stood while the session was still running (see `lastStats`). */
let lastUnderruns = 0;
let dirty = false;
let events = 0;
let faults = 0;
let lastFault: string | null = null;
let suspended = false;
const units = new Map<number, UnitOutcome>();
const bufferedSamples: number[] = [];
/** The recovery round currently being waited through, if any. */
let round: { at: number; unit: number; attempts: number; startedMs: number } | null = null;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const USER_WINDOW_MS = 1500;
/** How long after arriving at a sentence a wait still counts as "playback had to wait for THIS one". */
const REACH_WINDOW_MS = 2500;

interface Stats {
  isolation?: Record<string, number>;
  health?: string;
  inRecovery?: boolean;
  maxConcurrent?: number;
  bufferedSeconds?: number;
  playRejections?: number;
  watchdogNudges?: number;
  underruns?: number;
}
function stats(): Stats {
  try {
    return ((window as unknown as { __sardTtsStats?: () => Stats }).__sardTtsStats?.() ?? {}) as Stats;
  } catch { return {}; }
}

function unitOf(i: number): UnitOutcome {
  let u = units.get(i);
  if (!u) {
    u = { unit: i, attempts: 0, failures: 0, firstFailAt: null, recoveredAt: null, reachedAt: null, reachedReady: null, repairedBeforeReached: false, endedInError: false };
    units.set(i, u);
  }
  return u;
}

/**
 * PLAYBACK ARRIVED AND HAD TO WAIT.
 *
 * The advance and the wait are two separate store updates: `playFrom` publishes the new index first and
 * increments the underrun counter afterwards, so the counter has not moved yet at the moment the cursor
 * changes. `reachedReady` is therefore set optimistically on arrival and corrected here, by the first
 * buffering or underrun that lands on the same sentence while it is still the one being waited for.
 */
function markNotReady(unit: number, t: number): void {
  const u = units.get(unit);
  if (!u || u.reachedAt === null) return;
  if (t - sessionT0 - u.reachedAt > REACH_WINDOW_MS) return;
  u.reachedReady = false;
}

function pushEvent(kind: TelemetryEvent["kind"], unit: number, a?: number | string | null, b?: number | string | null): void {
  if (!cur) return;
  if (cur.events.length >= KEEP_EVENTS) { cur.eventsDropped++; return; }
  cur.events.push({ at: Math.round(now() - sessionT0), kind, unit, a: a ?? null, b: b ?? null });
}

// ---- the dispatch hook (called from tts.ts, after an attempt has settled) ------------------------

/**
 * ONE SYNTHESIS ATTEMPT, RECORDED AFTER IT SETTLED.
 *
 * Called from `synthDispatch` on both paths. It runs after the attempt's promise has already resolved
 * or rejected, so nothing it does can change what the scheduler sees: the value and the error travel
 * on their own path, and this only reads them. It allocates one small object and returns.
 */
export function noteDispatch(rec: Omit<DispatchRecord, "at">): void {
  try {
    if (!cur) return;
    const at = Math.round(now() - sessionT0);
    const u = unitOf(rec.unit);
    u.attempts++;
    if (rec.ok) {
      // A sentence that had failed and now has audio is repaired. Whether that happened in time is
      // decided when playback arrives (`reachedAt`), not here.
      if (u.firstFailAt !== null && u.recoveredAt === null) u.recoveredAt = at;
    } else {
      u.failures++;
      if (u.firstFailAt === null) u.firstFailAt = at;
    }
    if (round && rec.role === "recovery" && rec.unit === round.unit) round.attempts = Math.max(round.attempts, rec.attempt);
    if (cur.dispatches.length >= KEEP_DISPATCHES) { cur.dispatchesDropped++; return; }
    cur.dispatches.push({ at, ...rec });
  } catch (e) { faults++; lastFault = String(e); }
}

// ---- session lifecycle --------------------------------------------------------------------------

function open(s: Snap): void {
  const st = stats();
  sessionT0 = now();
  phaseSince = sessionT0;
  phase = "preparing";
  lastIndex = s.index;
  lastUserActionAt = -1;
  underrunsAtStart = s.underruns;
  lastUnderruns = s.underruns;
  isolationAtStart = st.isolation ? { ...st.isolation } : null;
  units.clear();
  bufferedSamples.length = 0;
  round = null;
  cur = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(), endedAt: null, endReason: "open",
    engine: s.engine, voice: s.voice, speed: s.speed, speedChanges: 0, voiceChanges: 0, units: s.total,
    timeToFirstAudioMs: null, soundingMs: 0, silentMs: 0, pausedMs: 0, unitsAdvanced: 0,
    gaps: [], longestGapMs: 0, underruns: 0,
    dispatches: [], dispatchesDropped: 0, events: [], eventsDropped: 0, unitOutcomes: [],
    isolation: { futureRetries: 0, recoveries: 0, recoverySuccesses: 0, cancelled: 0, probes: 0, resetRetries: 0, breakerTrips: 0 },
    recoveryRounds: [], maxConcurrentEdge: 0, healthSeen: [],
    playRejections: 0, watchdogNudges: 0, edgeErrors: 0, errors: 0, userRetries: 0,
    synth: null, bufferedAheadSec: null,
    meta: { events: 0, faults: 0, lastFault: null, version: 1 },
  };
}

function closePhase(t: number, _s: Snap): void {
  if (!cur) return;
  const d = Math.max(0, t - phaseSince);
  if (phase === "sounding") cur.soundingMs += Math.round(d);
  else if (phase === "paused") cur.pausedMs += Math.round(d);
  else if (phase === "silent") {
    cur.silentMs += Math.round(d);
    const afterUserAction = lastUserActionAt >= 0 && phaseSince - lastUserActionAt <= USER_WINDOW_MS;
    cur.gaps.push({ at: Math.round(phaseSince - sessionT0), ms: Math.round(d), unit: lastIndex, duringRecovery: round !== null, afterUserAction });
    if (d > cur.longestGapMs) cur.longestGapMs = Math.round(d);
  }
  phaseSince = t;
}

function finish(reason: ResilienceSession["endReason"], s: Snap): void {
  if (!cur) return;
  const st = lastStats.isolation ? lastStats : stats();
  cur.endedAt = Date.now();
  cur.endReason = reason;
  cur.underruns = Math.max(0, Math.max(s.underruns, lastUnderruns) - underrunsAtStart);
  if (isolationAtStart && st.isolation) {
    for (const k of Object.keys(cur.isolation) as (keyof ResilienceSession["isolation"])[]) {
      cur.isolation[k] = Math.max(0, (st.isolation[k] ?? 0) - (isolationAtStart[k] ?? 0));
    }
  }
  cur.maxConcurrentEdge = Math.max(cur.maxConcurrentEdge, st.maxConcurrent ?? 0);
  cur.playRejections = st.playRejections ?? 0;
  cur.watchdogNudges = st.watchdogNudges ?? 0;
  // per-sentence verdicts
  for (const u of units.values()) {
    if (u.firstFailAt !== null && u.recoveredAt !== null && u.reachedAt !== null) {
      u.repairedBeforeReached = u.recoveredAt <= u.reachedAt;
    }
    cur.unitOutcomes.push(u);
  }
  // synthesis latency, from this session's own attempts
  const ms = cur.dispatches.map((d) => d.ms).sort((a, b) => a - b);
  if (ms.length) {
    const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
    cur.synth = { n: ms.length, okN: cur.dispatches.filter((d) => d.ok).length, failN: cur.dispatches.filter((d) => !d.ok).length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(ms[ms.length - 1]) };
  }
  if (bufferedSamples.length) {
    const b = [...bufferedSamples].sort((x, y) => x - y);
    cur.bufferedAheadSec = { n: b.length, p50: +b[Math.floor(b.length / 2)].toFixed(1), min: +b[0].toFixed(1) };
  }
  cur.meta = { events, faults, lastFault, version: 1 };
  history.push(cur);
  if (history.length > KEEP_SESSIONS) history = history.slice(-KEEP_SESSIONS);
  cur = null;
  phase = "idle";
  dirty = true;
  void flush();
}

// ---- persistence --------------------------------------------------------------------------------

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await settingsGet(KEY);
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) history = parsed as ResilienceSession[]; }
  } catch { /* an unreadable record must never break the reader */ }
}

async function flush(force = false): Promise<void> {
  // GUARANTEE 1: never while audio is sounding — `settings_set` is synchronous on the native side.
  if (!dirty) return;
  if (!force && phase === "sounding") return;
  dirty = false;
  try {
    await load();
    await settingsSet(KEY, JSON.stringify(history));
  } catch (e) { faults++; lastFault = String(e); dirty = true; }
}

// ---- the store observer -------------------------------------------------------------------------

interface Snap {
  active: boolean; status: string; index: number; total: number;
  engine: string; voice: string; speed: number;
  retryAttempt: number; underruns: number; error: string | null;
}

function onChange(s: Snap, p: Snap): void {
  const t = now();
  const st = stats();
  if (s.active && st.isolation) lastStats = st; // see `lastStats`: sampled while alive, used after the reset
  if (s.active) lastUnderruns = s.underruns;   // the same reset applies to the store’s own counter

  // A session BOUNDARY while the player stays active. `preparing` is only ever entered by start(),
  // setVoice() or a recovery, and those are told apart by what else changed — the same rule the older
  // instrument applies:
  //   • after an error state      → the listener recovering: the SAME session (counted as a user retry below)
  //   • engine or voice changed   → an intentional switch: the SAME session
  //   • otherwise                 → start(): a NEW chapter, whether the listener pressed Next or the
  //                                 chapter simply played out and the next one followed on its own.
  //
  // THE DEFECT THIS CLOSES. A chapter that played out set `suspended` and nothing lifted it while the
  // player stayed active — but automatic continuation starts the next chapter WITHOUT going through
  // idle. Measured on a real day of listening: the older instrument recorded 11 sessions, this one 2;
  // every chapter that began by continuation was missing, including the one with the only failure.
  const enteredPreparing = s.status === "preparing" && p.status !== "preparing";
  if (enteredPreparing && cur && s.active) {
    const recovery = p.status === "error" || p.status === "edge-error";
    const voiceChange = s.engine !== p.engine || s.voice !== p.voice;
    if (!recovery && !voiceChange) {
      closePhase(t, s);
      finish("chapterChange", s);
      open(s);
    }
  }
  if (suspended && s.active && !cur && enteredPreparing) {
    suspended = false;
    open(s);
  }

  // A session begins when the player becomes active, and only once per activation.
  if (s.active && !cur && !suspended) open(s);
  if (!s.active) {
    if (cur) { closePhase(t, s); finish(p.active ? "stop" : "teardown", s); }
    suspended = false;
    return;
  }
  if (!cur) return;

  // CONTEXT IS PROVISIONAL AT ACTIVATION. A session opens the instant the player becomes active, and at
  // that moment the sentence list has not been handed over yet: `total` is 0 and `voice` is "" until
  // `start()` resolves the voice. So the context is kept CURRENT, and only a change between two real
  // values counts as the listener changing something.
  if (s.total && s.total !== cur.units) cur.units = s.total;
  if (s.engine && s.engine !== cur.engine) cur.engine = s.engine;
  if (s.voice !== p.voice) {
    if (p.voice && s.voice) { cur.voiceChanges++; pushEvent("voiceChange", s.index); }
    if (s.voice) cur.voice = s.voice;
  }
  if (s.speed !== p.speed) { cur.speedChanges++; pushEvent("speedChange", s.index, s.speed); cur.speed = s.speed; }
  if (st.health && cur.healthSeen[cur.healthSeen.length - 1] !== st.health) { cur.healthSeen.push(st.health); pushEvent("health", s.index, st.health); }
  if ((st.maxConcurrent ?? 0) > cur.maxConcurrentEdge) cur.maxConcurrentEdge = st.maxConcurrent ?? 0;

  // the cursor moved: a natural advance, or something the listener did
  if (s.index !== p.index) {
    const delta = s.index - p.index;
    const u = unitOf(s.index);
    u.reachedAt = Math.round(t - sessionT0);
    // "ready" means the engine did not have to wait: its own underrun counter did not move.
    u.reachedReady = s.underruns === p.underruns;
    if (delta === 1) { cur.unitsAdvanced++; pushEvent("advance", s.index); }
    else {
      lastUserActionAt = t;
      pushEvent(delta > 1 ? "skip" : delta === -1 ? "back" : "seek", s.index, delta);
    }
    if (typeof st.bufferedSeconds === "number") bufferedSamples.push(st.bufferedSeconds);
    lastIndex = s.index;
  }
  if (s.underruns > p.underruns) {
    pushEvent("underrun", s.index, s.underruns - p.underruns);
    markNotReady(s.index, t);
  }

  // the visible recovery round: the indicator rises only for attempts the listener waits through
  if (s.retryAttempt > p.retryAttempt) {
    if (!round) { round = { at: Math.round(t - sessionT0), unit: s.index, attempts: s.retryAttempt, startedMs: t }; pushEvent("recoveryStart", s.index, s.retryAttempt); }
    else round.attempts = Math.max(round.attempts, s.retryAttempt);
    pushEvent("retryIndicator", s.index, s.retryAttempt);
  }

  // status transitions drive the phase accounting
  if (s.status !== p.status) {
    switch (s.status) {
      case "playing":
        closePhase(t, s);
        if (p.status === "paused") pushEvent("resume", s.index);
        if (cur.timeToFirstAudioMs === null) { cur.timeToFirstAudioMs = Math.round(t - sessionT0); pushEvent("firstAudio", s.index, cur.timeToFirstAudioMs); }
        if (round) { closeRound(t, "recovered", s.index); }
        phase = "sounding";
        break;
      case "buffering":
        closePhase(t, s);
        pushEvent("buffering", s.index);
        markNotReady(s.index, t);
        phase = "silent";
        break;
      case "paused":
        closePhase(t, s);
        pushEvent("pause", s.index);
        phase = "paused";
        break;
      case "preparing":
        closePhase(t, s);
        phase = "preparing";
        break;
      case "edge-error":
      case "error": {
        closePhase(t, s);
        const kind = s.status === "edge-error" ? "edgeError" : "error";
        if (kind === "edgeError") cur.edgeErrors++; else cur.errors++;
        unitOf(s.index).endedInError = true;
        pushEvent(kind, s.index, s.error ?? null);
        if (round) closeRound(t, "edge-error", s.index);
        phase = "acknowledged";
        break;
      }
      case "chapter-end":
        closePhase(t, s);
        pushEvent("chapterEnd", s.index);
        finish("chapterEnd", s);
        suspended = true; // do not reopen until the listener acts again
        return;
      case "idle":
        closePhase(t, s);
        finish("stop", s);
        return;
      default:
        break;
    }
    // leaving an acknowledged state by the listener's own action is a user retry
    if ((p.status === "edge-error" || p.status === "error") && (s.status === "preparing" || s.status === "buffering" || s.status === "playing")) {
      cur.userRetries++;
      lastUserActionAt = t;
      pushEvent("userRetry", s.index);
    }
  }
}

function closeRound(t: number, outcome: "recovered" | "edge-error" | "abandoned", unit: number): void {
  if (!cur || !round) return;
  const ms = Math.round(t - round.startedMs);
  // The budget is a ceiling on what the LISTENER waits: measured from the first indicator to the
  // outcome. 12 s + a frame of slack, because the store transition is observed, not the timer itself.
  cur.recoveryRounds.push({ at: round.at, unit: round.unit, ms, attempts: round.attempts, outcome, budgetRespected: ms <= 12_500 });
  pushEvent("recoveryEnd", unit, outcome, ms);
  round = null;
}

// ---- public surface -----------------------------------------------------------------------------

export async function ttsTelemetry(): Promise<ResilienceSession[]> {
  await load();
  return cur ? [...history, cur] : history;
}
export async function resetTtsTelemetry(): Promise<void> {
  history = [];
  cur = null;
  phase = "idle";
  dirty = true;
  await flush(true);
}
export function ttsTelemetryHealth(): { events: number; faults: number; lastFault: string | null; phase: Phase; hasSession: boolean; sessions: number; dispatches: number } {
  return { events, faults, lastFault, phase, hasSession: cur !== null, sessions: history.length, dispatches: cur?.dispatches.length ?? 0 };
}

export function registerTtsTelemetry(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  try {
    const pick = (s: ReturnType<typeof useTts.getState>): Snap => ({
      active: s.active, status: s.status, index: s.index, total: s.total,
      engine: s.engine, voice: s.voice, speed: s.speed,
      retryAttempt: s.retryAttempt, underruns: s.underruns, error: s.error ?? null,
    });
    let prev = pick(useTts.getState());
    useTts.subscribe((state) => {
      events++;
      const next = pick(state);
      try { onChange(next, prev); } catch (e) { faults++; lastFault = String(e); }
      prev = next;
    });
    // Teardown: the app is closing and there is no playback left to protect, so the write is taken.
    window.addEventListener("pagehide", () => {
      try {
        if (cur) { closePhase(now(), prev); finish("teardown", prev); }
        void flush(true);
      } catch (e) { faults++; lastFault = String(e); }
    });
    const w = window as unknown as Record<string, unknown>;
    w.__sardTtsTelemetry = ttsTelemetry;
    w.__sardTtsTelemetryReset = resetTtsTelemetry;
    w.__sardTtsTelemetryHealth = ttsTelemetryHealth;
    void load();
  } catch { /* the reader must work whether or not measurement does */ }
}
