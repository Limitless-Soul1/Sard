// RAWY-263 (Layer 1 §6): the LOCAL, DURABLE OUTCOME RECORDER.
//
// It exists because LISTENING-OUTCOMES.md §6 requires a real-listening baseline before any proposal can be
// judged, and none existed: `stop()` zeroes every counter when a session ends.
//
// IT MUST OBSERVE REALITY, NOT INFLUENCE IT. Four guarantees, worst-consequence first:
//   1. NO WRITE WHILE AUDIO IS SOUNDING. `settings_set` is a SYNC `#[tauri::command]`, and a sync command
//      blocks the whole native window (RAWY-183/188). Persistence happens only when nothing is sounding.
//      A hard kill mid-playback loses that session — a stated limit, not a periodic write.
//   2. NO TIMER. Accounting is transition-driven arithmetic. No interval, no rAF.
//   3. NO STORE WRITES. This module only reads. `tts.ts` and `ttsScheduler.ts` are untouched.
//   4. FAULTS ISOLATED BUT COUNTED. Silent swallowing is what made the first version undebuggable.
//
// ---- WHY GAPS ARE CLASSIFIED THE WAY THEY ARE (the v1 lesson) ----
// v1 guessed intent from cursor movement. Real listening proved that wrong: chapter changes appeared as
// 5–7 s "gaps" at unit 0, and one record spanned four chapters because pressing Next never clears `active`.
// Guessing was the wrong instrument. The app already publishes two UNAMBIGUOUS signals, and v2 uses those:
//
//   • `underruns` increments in EXACTLY one place — `playFrom` finding the sentence not ready on a natural
//     advance (`!ready && !establishLead`). That is the app's own definition of an UNEXPECTED wait.
//   • `status === "preparing"` is set by only four call sites: start(), setVoice(), resumeEdge(), and the
//     Piper voice download. They are told apart by what else changed, so a new chapter, a voice change and
//     a user-driven recovery are each identified rather than inferred.
//
// A gap is therefore a FAILURE only when the app itself says playback had to wait, or when it ended in a
// state the listener had to acknowledge. Everything the listener asked for — pause, seek, chapter change,
// voice change, stop — is recorded as EXPECTED and kept out of the failure metrics. Anything that fits
// neither is recorded as UNCLASSIFIED and counted separately: §5 forbids resolving an ambiguity silently.
import { useTts } from "./tts";
import { settingsGet, settingsSet } from "./ipc";

const KEY = "listening_outcomes_v2";
// v2 is a NEW key on purpose: v1 records have a different shape (chapter changes counted as gaps, engine
// captured before it was resolved), and mixing two instruments' output in one statistic would be worse than
// starting clean. The v1 record stays on disk under its own key for reference.
/** Retention bound — an engineering limit, not a Layer 1 target. */
const KEEP_SESSIONS = 300;

// ---- record shapes -----------------------------------------------------------------------------------

export type GapKind = "failure" | "expected" | "unclassified";
export type GapCause = "underrun" | "error" | "recovery" | "chapterChange" | "voiceChange" | "seek" | "unknown";

/** A period of active listening in which nothing was sounding. */
export interface Gap {
  at: number;            // ms since session start
  ms: number;
  index: number;
  kind: GapKind;
  cause: GapCause;
  /** how many unexpected waits the ENGINE itself counted during this gap — the decisive discriminator */
  underrunsDelta: number;
  cursorDelta: number;
  afterCursorMove: boolean;
  duringRecovery: boolean;
}

/** A synthesis failure as the app classified it. Recorded so a later analysis does not have to guess which
 *  kind of failure produced a gap — the single most important thing v1 could not answer. */
export interface FailureEvent {
  at: number;
  kind: string;
  detail: string;
  unit: number;
  len: number;
}

export type EndReason = "closed" | "chapterChange" | "hidden" | "open";

export interface SessionRecord {
  startedAt: number;
  endReason: EndReason;
  /** O5 — from the listener's activation to first audio. null if audio never started. */
  timeToFirstAudioMs: number | null;
  /** active listening: sounding + silent-while-waiting, after first audio. Excludes paused, preparing,
   *  chapter transitions and acknowledged states (§5). */
  activeMs: number;
  soundingMs: number;
  gaps: Gap[];
  failures: FailureEvent[];
  /** furthest the visible retry indicator got */
  maxRetryAttempt: number;
  /** O6 — the listener had to act to continue */
  neededUserAction: boolean;
  /** O7 — ended in a state the listener had to acknowledge */
  endedAcknowledged: boolean;
  /** O8 — state changes that WOULD show a production indicator. UPPER BOUND: whether one was displayed
   *  depends on player size, which is component-local state this module cannot see. */
  productionStateEvents: number;
  // context (§5) — captured when audio actually starts, not at activation, so it reflects the real session
  engine: string;
  voice: string;
  speed: number;
  chapter: string;
  units: number;
  unitsAdvanced: number;
  meanUnitSeconds: number | null;
  sourceMs: { n: number; p50: number; p95: number; max: number } | null;
  underruns: number;
  abandoned: number;
  /** false until audio started; context fields are provisional until then */
  metaCaptured: boolean;
  /** observation began mid-session — EXCLUDED from O5 */
  joinedLate: boolean;
  partial: boolean;
}

// ---- in-flight state ---------------------------------------------------------------------------------

type Phase = "idle" | "preparing" | "starting" | "sounding" | "silent" | "paused" | "acknowledged";

let history: SessionRecord[] = [];
let loaded = false;
let cur: SessionRecord | null = null;
let phase: Phase = "idle";
let phaseSince = 0;
let sessionT0 = 0;
let firstIndex = 0;
let lastIndex = 0;
let lastCursorMoveAt = -1;
let lastCursorDelta = 0;
let underrunsAtGapStart = 0;
let retryDuringGap = false;
let dirty = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const CURSOR_WINDOW_MS = 1200;

interface Snap {
  active: boolean; status: string; index: number; total: number;
  engine: string; voice: string; speed: number; chapterLabel: string;
  retryAttempt: number; underruns: number; abandoned: number;
  /** The STORE holds a formatted SUMMARY STRING (`len=N kind …`) — it is what the pill renders. The
   *  structured record (kind / detail / unit / len) lives only behind `ttsStats()`. So the string is used to
   *  DETECT a new failure and the structured one is read at that moment. Measured: assuming the store held
   *  the object produced `detail: "undefined"` for every failure. */
  lastFailure: string | null;
}

/** The structured failure record, read at the moment the store's summary string changes. */
function structuredFailure(): { unit: number; len: number; kind: string; detail: string } | null {
  try {
    const st = (window as unknown as { __sardTtsStats?: () => { lastFailure?: { unit: number; len: number; kind: string; detail: string } | null } }).__sardTtsStats?.();
    return st?.lastFailure ?? null;
  } catch { return null; }
}

function sourceSnapshot(): void {
  if (!cur) return;
  try {
    const st = (window as unknown as { __sardTtsStats?: () => { dispatchMs?: { n: number; p50: number; p95: number; max: number } | null } }).__sardTtsStats?.();
    const d = st?.dispatchMs;
    if (d && d.n > 0) cur.sourceMs = { n: d.n, p50: d.p50, p95: d.p95, max: d.max };
  } catch { /* context is optional; the outcome is not */ }
}

/** Close the current phase, attributing its time and — if it was silent — classifying the gap. */
function closePhase(t: number, s: Snap, endingBecause: GapCause | null): void {
  if (!cur) return;
  const d = Math.max(0, t - phaseSince);
  if (phase === "sounding") { cur.soundingMs += d; cur.activeMs += d; }
  else if (phase === "silent") {
    const underrunsDelta = s.underruns - underrunsAtGapStart;
    // A chapter change ends the SESSION; the silence it produces belongs to no session and is discarded
    // outright rather than recorded as an expected gap. This is what polluted the first dataset.
    if (endingBecause === "chapterChange") { phaseSince = t; return; }
    let kind: GapKind;
    let cause: GapCause;
    if (endingBecause === "error") { kind = "failure"; cause = "error"; }
    else if (underrunsDelta > 0) { kind = "failure"; cause = "underrun"; }
    else if (retryDuringGap) { kind = "failure"; cause = "recovery"; }
    else if (endingBecause === "voiceChange") { kind = "expected"; cause = "voiceChange"; }
    else if (lastCursorMoveAt >= 0 && phaseSince - lastCursorMoveAt <= CURSOR_WINDOW_MS && lastCursorDelta !== 1) {
      kind = "expected"; cause = "seek";
    } else { kind = "unclassified"; cause = "unknown"; }
    cur.activeMs += d;
    cur.gaps.push({
      at: Math.round(phaseSince - sessionT0), ms: Math.round(d), index: lastIndex,
      kind, cause, underrunsDelta, cursorDelta: lastCursorDelta,
      afterCursorMove: lastCursorMoveAt >= 0 && phaseSince - lastCursorMoveAt <= CURSOR_WINDOW_MS,
      duringRecovery: retryDuringGap,
    });
  }
  phaseSince = t;
}

// ---- persistence -------------------------------------------------------------------------------------

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await settingsGet(KEY);
    if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) history = parsed as SessionRecord[]; }
  } catch { /* a missing or unreadable record must never break the reader */ }
}

const journal: { at: number; phase: Phase; wrote: boolean; bytes: number }[] = [];
const JOURNAL_KEEP = 200;

async function flush(force = false): Promise<void> {
  // Capture synchronously: `finish()` nulls `cur` right after calling this, and reading it after the first
  // await would silently drop the finalised session. Measured — that is exactly what happened in v1.
  const rec = cur;
  const recPartial = phase !== "idle";
  const note = (wrote: boolean, bytes = 0) => {
    journal.push({ at: Math.round(now()), phase, wrote, bytes });
    if (journal.length > JOURNAL_KEEP) journal.shift();
  };
  try {
    if (!dirty && !force) { note(false); return; }
    if (phase === "sounding") { note(false); return; } // guarantee 1
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

export function listeningJournal(): { at: number; phase: string; wrote: boolean; bytes: number }[] {
  return journal.map((j) => ({ ...j }));
}

// ---- session lifecycle -------------------------------------------------------------------------------

function startSession(t: number, s: Snap, joinedLate: boolean): void {
  sessionT0 = t;
  phaseSince = t;
  firstIndex = s.index;
  lastIndex = s.index;
  lastCursorMoveAt = -1;
  lastCursorDelta = 0;
  underrunsAtGapStart = s.underruns;
  retryDuringGap = false;
  cur = {
    startedAt: Date.now(), endReason: "open",
    timeToFirstAudioMs: null, activeMs: 0, soundingMs: 0, gaps: [], failures: [],
    maxRetryAttempt: 0, neededUserAction: false, endedAcknowledged: false, productionStateEvents: 0,
    engine: s.engine, voice: s.voice, speed: s.speed, chapter: s.chapterLabel,
    units: s.total, unitsAdvanced: 0, meanUnitSeconds: null, sourceMs: null,
    underruns: 0, abandoned: 0, metaCaptured: false, joinedLate, partial: true,
  };
  phase = joinedLate ? (s.status === "playing" ? "sounding" : s.status === "paused" ? "paused" : "silent") : "preparing";
  dirty = true;
}

function finish(reason: EndReason): void {
  if (!cur) return;
  try {
    cur.endReason = reason;
    const ss = cur.soundingMs / 1000;
    cur.meanUnitSeconds = cur.unitsAdvanced > 0 ? Math.round(((ss * cur.speed) / cur.unitsAdvanced) * 100) / 100 : null;
    cur.partial = false;
  } catch { /* keep whatever was gathered */ }
  phase = "idle";
  dirty = true;
  void flush(true);
  cur = null;
}

// ---- the observer ------------------------------------------------------------------------------------

function onChange(s: Snap, p: Snap): void {
  const t = now();

  // A session BOUNDARY. `preparing` is only ever set by start(), setVoice(), resumeEdge() or a Piper voice
  // download, and those are told apart by what else changed:
  //   • after an error state          → resumeEdge: the listener recovering. SAME session.
  //   • engine or voice changed       → setVoice: an intentional switch. SAME session.
  //   • after "downloading"           → the Piper model fetch. SAME session.
  //   • otherwise                     → start(): a NEW chapter. New session.
  const enteredPreparing = s.status === "preparing" && p.status !== "preparing";
  if (enteredPreparing && cur && s.active) {
    const recovery = p.status === "error" || p.status === "edge-error";
    const voiceChange = s.engine !== p.engine || s.voice !== p.voice;
    const download = p.status === "downloading";
    if (recovery) { cur.neededUserAction = true; retryDuringGap = true; }
    if (!recovery && !voiceChange && !download) {
      closePhase(t, s, "chapterChange");   // the silence of a chapter change is discarded, not recorded
      finish("chapterChange");
      startSession(t, s, false);
      return;
    }
    if (voiceChange) closePhase(t, s, "voiceChange");
  }

  if (s.active && !cur) startSession(t, s, !(s.active && !p.active));
  if (!cur) return;

  // ---- cursor movement ----
  if (s.index !== p.index) {
    lastCursorDelta = s.index - p.index;
    lastCursorMoveAt = t;
    lastIndex = s.index;
    cur.unitsAdvanced = Math.max(cur.unitsAdvanced, s.index - firstIndex);
    // Read the source instrument WHILE the session is alive: `stop()` resets it before this observer learns
    // the session ended, so reading it at the end always returned empty. Measured.
    sourceSnapshot();
  }

  // ---- failures, as the app itself classified them ----
  if (s.lastFailure && s.lastFailure !== p.lastFailure) {
    const f = structuredFailure();
    cur.failures.push({
      at: Math.round(t - sessionT0),
      kind: f?.kind ?? "unknown",
      detail: String(f?.detail ?? s.lastFailure).slice(0, 160),
      unit: f?.unit ?? lastIndex,
      len: f?.len ?? -1,
    });
  }
  if (s.retryAttempt > 0) { retryDuringGap = true; cur.maxRetryAttempt = Math.max(cur.maxRetryAttempt, s.retryAttempt); }

  // ---- production indicators ----
  if ((s.status === "buffering" && p.status !== "buffering") || (s.retryAttempt > 0 && p.retryAttempt === 0)) {
    cur.productionStateEvents++;
  }

  const sounding = s.status === "playing";
  const acknowledged = s.status === "error" || s.status === "edge-error";

  // O5 and the context that describes the session, captured when audio ACTUALLY starts — at activation the
  // engine and voice are not yet resolved and `total` may be stale, which is why v1 recorded engine=piper
  // and units=0 for Edge sessions.
  if (sounding && !cur.metaCaptured) {
    if (cur.timeToFirstAudioMs === null && !cur.joinedLate) cur.timeToFirstAudioMs = Math.round(t - sessionT0);
    cur.engine = s.engine; cur.voice = s.voice; cur.speed = s.speed;
    cur.chapter = s.chapterLabel; cur.units = s.total;
    cur.metaCaptured = true;
  }

  // Leaving an acknowledged state can only happen because the listener acted.
  if ((p.status === "error" || p.status === "edge-error") && !acknowledged && s.active) cur.neededUserAction = true;

  let next: Phase;
  if (!s.active) next = "idle";
  else if (acknowledged) next = "acknowledged";
  else if (s.status === "paused") next = "paused";
  else if (sounding) next = "sounding";
  else if (s.status === "buffering") next = cur.metaCaptured ? "silent" : "preparing";
  else if (s.status === "preparing" || s.status === "downloading") next = "preparing";
  else next = "paused"; // chapter-end and idle-ish states are not interruptions (§5)

  if (next !== phase) {
    closePhase(t, s, acknowledged ? "error" : null);
    if (next === "silent") { underrunsAtGapStart = s.underruns; retryDuringGap = s.retryAttempt > 0; }
    phase = next;
    dirty = true;
  }

  cur.underruns = s.underruns;
  cur.abandoned = s.abandoned;

  if (!s.active && p.active) {
    cur.endedAcknowledged = p.status === "error" || p.status === "edge-error";
    finish("closed");
  } else if (acknowledged && !(p.status === "error" || p.status === "edge-error")) {
    cur.endedAcknowledged = true;
    void flush(true);
  } else if (s.status === "paused" && p.status !== "paused") {
    void flush(true);
  }
}

// ---- summary -----------------------------------------------------------------------------------------

export interface OutcomeSummary {
  sessions: number;
  listeningHours: number;
  continuityPct: number | null;
  /** O2/O3/O4 — FAILURE gaps only. Expected gaps are reported separately and never mixed in. */
  failureSecPerHour: number | null;
  failuresPerHour: number | null;
  longestFailureMs: number | null;
  expected: { count: number; sec: number };
  unclassified: { count: number; sec: number };
  firstAudioP50Ms: number | null;
  firstAudioMaxMs: number | null;
  neededActionPer100: number | null;
  endedAcknowledgedPer100: number | null;
  productionEventsPerHour: number | null;
  failureKinds: { kind: string; n: number }[];
  contentProfiles: { meanUnitSeconds: number; sessions: number }[];
}

const med = (a: number[]): number | null => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function summarise(rows: SessionRecord[] = history): OutcomeSummary {
  const done = rows.filter((r) => r.activeMs > 0);
  const activeMs = done.reduce((a, r) => a + r.activeMs, 0);
  const hours = activeMs / 3_600_000;
  const sounding = done.reduce((a, r) => a + r.soundingMs, 0);
  const gaps = done.flatMap((r) => r.gaps ?? []);
  const fail = gaps.filter((g) => g.kind === "failure");
  const exp = gaps.filter((g) => g.kind === "expected");
  const unc = gaps.filter((g) => g.kind === "unclassified");
  const per = (n: number) => (hours > 0 ? Math.round((n / hours) * 10) / 10 : null);
  const ttfa = done.filter((r) => !r.joinedLate).map((r) => r.timeToFirstAudioMs).filter((x): x is number => x !== null);
  const kinds = new Map<string, number>();
  for (const r of done) for (const f of r.failures ?? []) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  const profiles = new Map<number, number>();
  for (const r of done) if (r.meanUnitSeconds) { const b = Math.round(r.meanUnitSeconds); profiles.set(b, (profiles.get(b) ?? 0) + 1); }
  return {
    sessions: done.length,
    listeningHours: Math.round(hours * 100) / 100,
    continuityPct: activeMs > 0 ? Math.round((sounding / activeMs) * 1000) / 10 : null,
    failureSecPerHour: per(fail.reduce((a, g) => a + g.ms, 0) / 1000),
    failuresPerHour: per(fail.length),
    longestFailureMs: fail.length ? Math.max(...fail.map((g) => g.ms)) : null,
    expected: { count: exp.length, sec: Math.round(exp.reduce((a, g) => a + g.ms, 0) / 100) / 10 },
    unclassified: { count: unc.length, sec: Math.round(unc.reduce((a, g) => a + g.ms, 0) / 100) / 10 },
    firstAudioP50Ms: med(ttfa),
    firstAudioMaxMs: ttfa.length ? Math.max(...ttfa) : null,
    neededActionPer100: done.length ? Math.round((done.filter((r) => r.neededUserAction).length / done.length) * 1000) / 10 : null,
    endedAcknowledgedPer100: done.length ? Math.round((done.filter((r) => r.endedAcknowledged).length / done.length) * 1000) / 10 : null,
    productionEventsPerHour: per(done.reduce((a, r) => a + r.productionStateEvents, 0)),
    failureKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n })),
    contentProfiles: [...profiles.entries()].sort((a, b) => a[0] - b[0]).map(([meanUnitSeconds, sessions]) => ({ meanUnitSeconds, sessions })),
  };
}

/** History PLUS the session currently in flight. The in-flight one is never persisted while audio is
 *  sounding (guarantee 1), so without this it is invisible — to a test and to the owner's own readout.
 *  This is a pure read: nothing is written, and the live record is a copy.
 *  Its time only counts phases already CLOSED, so it lags reality by the phase in progress. */
function snapshotSessions(): SessionRecord[] {
  if (!cur) return history;
  return [...history.filter((h) => h.startedAt !== cur!.startedAt), { ...cur, partial: true }];
}

export async function listeningOutcomes(): Promise<{ summary: OutcomeSummary; sessions: SessionRecord[] }> {
  await load();
  const rows = snapshotSessions();
  return { summary: summarise(rows), sessions: rows };
}

export async function resetListeningOutcomes(): Promise<void> {
  history = []; loaded = true; cur = null; phase = "idle";
  try { await settingsSet(KEY, "[]"); } catch { /* nothing to do */ }
}

// ---- registration ------------------------------------------------------------------------------------

let registered = false;
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
      lastFailure: s.lastFailure ?? null,
    });
    let prev = pick(useTts.getState());
    useTts.subscribe((state) => {
      events++;
      const next = pick(state);
      try { onChange(next, prev); } catch (e) { faults++; lastFault = String(e); }
      prev = next;
    });
    const onHide = () => { if (phase !== "sounding") { if (cur) cur.endReason = "hidden"; void flush(true); } };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") onHide(); });
    const w = window as unknown as Record<string, unknown>;
    w.__sardListening = listeningOutcomes;
    w.__sardListeningReset = resetListeningOutcomes;
    w.__sardListeningJournal = listeningJournal;
    w.__sardListeningPhase = () => phase;
    w.__sardListeningHealth = listeningHealth;
    void load();
  } catch { /* the reader must work whether or not measurement does */ }
}
