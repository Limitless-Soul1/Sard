//! SESSION DIAGNOSTICS: WHAT EACH SYNTHESIS CALL WENT THROUGH, ONE RECORD PER CALL.
//!
//! OBSERVATION ONLY. The frontend sees a call's one result; the route log (`edge_route`) sees each handshake.
//! Neither can tell a call that waited on its HANDSHAKE from one that waited on the service's FIRST AUDIO, and
//! that is the question a slow read-aloud raises. A record holds, as milliseconds from the call's start: when
//! a connection began opening and when its handshake completed, when the request was written, when the service
//! acknowledged it (`turn.start`), when the first audio arrived and when the call ended — with how it ended,
//! the HTTP status when the service answered with one, the route, whether the connection was new or warm, and
//! how many earlier calls asked for the same sentence.
//!
//! WHAT IS NEVER RECORDED. No text, no voice list, no URL, header, token or connection id. The call is
//! identified by `diag`, the number the frontend gave its dispatch (a counter, never derived from the text).
//! "The same sentence" is recognised through a keyed hash of the text that stays in this process's memory: the
//! key is random per process, at most `PRIOR_KEEP` hashes are held, none older than `PRIOR_WINDOW`, and neither
//! the hash nor the key leaves this module — the record carries only the count.
//!
//! BOUNDED AND CHEAP. The last `CALL_LOG_KEEP` records, in memory; the frontend files them under the listening
//! session they belong to and keeps them only for its newest sessions (`ttsTelemetry.ts`). A call costs one
//! hash of its text and two short locks. Nothing in the synthesis reads any of it.

use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::BuildHasher;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::edge_route::Route;
use super::lock_recover;

/// One synthesis call, as it went.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    /// Increases by one per record, for the life of the process, in the order the calls ENDED.
    pub seq: u64,
    /// The frontend's number for the dispatch this call served, when it gave one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diag: Option<u64>,
    /// Unix time, in ms, when the call began.
    pub at: u64,
    /// The listener was waiting on it: the call carried a recovery budget.
    pub waited_on: bool,
    /// The budget and the first-audio cap the frontend asked for, as it asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cap_ms: Option<u64>,
    /// How many of the earlier calls (at most `PRIOR_KEEP`, none older than `PRIOR_WINDOW`) asked for the same text.
    pub prior: u32,
    /// A connection was opened for this call; false when the warm one was reused.
    pub fresh: bool,
    /// How long the warm client this call found had been idle, when it found one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_ms: Option<u64>,
    /// The route of the connection the request went out on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<&'static str>,
    // ---- milliseconds from the call's start ----
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_ms: Option<u64>,
    /// The service's `turn.start` for this request: read from the client's own turn state, never inferred from
    /// a message that carried no audio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_audio_ms: Option<u64>,
    /// The first-audio bound the stream was held to, from the moment the request was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_ms: Option<u64>,
    pub end_ms: u64,
    /// `ok`, `cancelled`, `connect-timeout`, `connect-error`, `no-audio`, `stream-stalled`, `service-error`,
    /// `setup-timeout` or `setup-error` (see `end_of`).
    pub end: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// A call's record while the call runs. Each moment is kept the first time it is noted.
pub(super) struct Probe {
    started: Instant,
    rec: CallRecord,
}

impl Probe {
    pub(super) fn begin(diag: Option<u64>, text: &str, budget_ms: Option<u64>, cap_ms: Option<u64>) -> Self {
        let (started, at) = (Instant::now(), SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64));
        Self::begin_at(started, at, diag, prior_of(text, started), budget_ms, cap_ms)
    }

    fn begin_at(started: Instant, at: u64, diag: Option<u64>, prior: u32, budget_ms: Option<u64>, cap_ms: Option<u64>) -> Self {
        let rec = CallRecord {
            seq: 0, diag, at, waited_on: budget_ms.is_some(), budget_ms, cap_ms, prior, fresh: false, idle_ms: None, route: None,
            connect_ms: None, connected_ms: None, sent_ms: None, turn_start_ms: None, first_audio_ms: None, window_ms: None,
            end_ms: 0, end: "ok", status: None,
        };
        Self { started, rec }
    }

    fn ms(&self) -> u64 {
        self.ms_at(Instant::now())
    }

    fn ms_at(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.started).as_millis() as u64
    }

    pub(super) fn diag(&self) -> Option<u64> {
        self.rec.diag
    }

    #[cfg(test)]
    pub(super) fn noted(&self) -> &CallRecord {
        &self.rec
    }

    /// The warm client this call found, if any, and how long it had been idle.
    pub(super) fn found_client(&mut self, idle: Option<Duration>) {
        self.rec.idle_ms = idle.map(|d| d.as_millis() as u64);
    }

    pub(super) fn connecting(&mut self) {
        self.rec.fresh = true;
        let ms = self.ms();
        self.rec.connect_ms.get_or_insert(ms);
    }

    pub(super) fn connected(&mut self, route: Route) {
        self.rec.route = Some(route.name());
        let ms = self.ms();
        self.rec.connected_ms.get_or_insert(ms);
    }

    pub(super) fn reused(&mut self, route: Route) {
        self.rec.route = Some(route.name());
    }

    pub(super) fn window(&mut self, first_audio: Duration) {
        self.rec.window_ms = Some(first_audio.as_millis() as u64);
    }

    pub(super) fn sent(&mut self, at: Instant) {
        let ms = self.ms_at(at);
        self.rec.sent_ms.get_or_insert(ms);
    }

    pub(super) fn turn_started(&mut self, at: Instant) {
        let ms = self.ms_at(at);
        self.rec.turn_start_ms.get_or_insert(ms);
    }

    pub(super) fn first_audio(&mut self, at: Instant) {
        let ms = self.ms_at(at);
        self.rec.first_audio_ms.get_or_insert(ms);
    }

    /// The call ended with `error`, or without one. Files the record.
    pub(super) fn finish(self, error: Option<&str>) {
        record(self.end(error));
    }

    fn end(mut self, error: Option<&str>) -> CallRecord {
        self.rec.end_ms = self.ms();
        (self.rec.end, self.rec.status) = end_of(error);
        self.rec
    }
}

/// How a call ended, from the error it returned. The strings are the engine's contract with the frontend
/// (`classifyFailure` and `isPermanentFailure` in src/lib/tts.ts read the same ones), and the status is read from
/// the same `<phase>: http <status>;` marker, never from other digits.
fn end_of(error: Option<&str>) -> (&'static str, Option<u16>) {
    let Some(e) = error else { return ("ok", None) };
    let end = if e.starts_with("edge synth cancelled") {
        "cancelled"
    } else if e.starts_with("edge connect timed out") {
        "connect-timeout"
    } else if e.starts_with("edge connect") {
        "connect-error"
    } else if e.starts_with("edge synth stalled: no audio") {
        "no-audio"
    } else if e.starts_with("edge synth stalled") {
        "stream-stalled"
    } else if e.starts_with("edge synth") {
        "service-error"
    } else if e.starts_with("edge voices") && e.contains("timed out") {
        "setup-timeout"
    } else {
        "setup-error"
    };
    let status = ["edge connect: http ", "edge voices: http ", "edge synth: http "].iter().find_map(|marker| {
        let rest = e.strip_prefix(marker)?;
        (rest.get(3..4) == Some(";")).then(|| rest.get(..3)?.parse::<u16>().ok()).flatten()
    });
    (end, status)
}

// ---- the same sentence, counted without keeping it ----

const PRIOR_KEEP: usize = 64;
const PRIOR_WINDOW: Duration = Duration::from_secs(300);
static PRIOR: Mutex<VecDeque<(u64, Instant)>> = Mutex::new(VecDeque::new());

fn prior_of(text: &str, now: Instant) -> u32 {
    static KEY: OnceLock<RandomState> = OnceLock::new();
    let hash = KEY.get_or_init(RandomState::new).hash_one(text);
    let mut recent = lock_recover(&PRIOR);
    recent.retain(|&(_, at)| now.saturating_duration_since(at) <= PRIOR_WINDOW);
    let prior = recent.iter().filter(|&&(h, _)| h == hash).count() as u32;
    recent.push_back((hash, now));
    if recent.len() > PRIOR_KEEP {
        recent.pop_front();
    }
    prior
}

// ---- the log ----

const CALL_LOG_KEEP: usize = 400;
static CALL_LOG: Mutex<(u64, VecDeque<CallRecord>)> = Mutex::new((0, VecDeque::new()));

fn record(mut rec: CallRecord) {
    let mut log = lock_recover(&CALL_LOG);
    log.0 += 1;
    rec.seq = log.0;
    log.1.push_back(rec);
    if log.1.len() > CALL_LOG_KEEP {
        log.1.pop_front();
    }
}

/// The calls that ended after sequence number `since`, oldest first.
pub(super) fn call_log_since(since: u64) -> Vec<CallRecord> {
    lock_recover(&CALL_LOG).1.iter().filter(|c| c.seq > since).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_error_the_engine_returns_ends_its_call_in_one_named_way_with_the_answered_status() {
        let cases: &[(Option<&str>, &str, Option<u16>)] = &[
            (None, "ok", None),
            (Some("edge synth cancelled"), "cancelled", None),
            (Some("edge connect timed out"), "connect-timeout", None),
            (Some("edge connect: http 429; msedge rate-limited (http 429)"), "connect-error", Some(429)),
            (Some("edge connect: http 403; msedge refused (http 403), bing refused (http 403)"), "connect-error", Some(403)),
            (Some("edge connect: msedge failed (os error 10060)"), "connect-error", None),
            (Some("edge connect: abandoned"), "connect-error", None),
            (Some("edge connect: no warm client"), "connect-error", None),
            (Some("edge synth stalled: no audio"), "no-audio", None),
            (Some("edge synth stalled: stream idle"), "stream-stalled", None),
            (Some("edge synth stalled: over budget"), "stream-stalled", None),
            (Some("edge synth: Io(Os { code: 10054, kind: ConnectionReset })"), "service-error", None),
            (Some("edge synth: worker ended"), "service-error", None),
            (Some("edge voices timed out"), "setup-timeout", None),
            (Some("edge voices fetch timed out"), "setup-timeout", None),
            (Some("edge voices: http 503; UreqError(StatusCode(503))"), "setup-error", Some(503)),
            (Some("unknown edge voice: ar-XX-NobodyNeural"), "setup-error", None),
        ];
        for &(error, end, status) in cases {
            assert_eq!(end_of(error), (end, status), "{error:?}");
        }
        // Digits that are not the marker's are never a status.
        assert_eq!(end_of(Some("edge synth: Http(Response { status: 500, headers: {\"content-length\": \"434\"} })")).1, None);
        assert_eq!(end_of(Some("edge connect: http 42; short")).1, None);
    }

    #[test]
    fn a_record_keeps_each_moment_the_first_time_and_in_the_order_it_happened() {
        let mut p = Probe::begin_at(Instant::now(), 1_793_000_000_000, Some(7), 0, Some(12_000), Some(6_000));
        p.found_client(Some(Duration::from_millis(2_500)));
        p.connecting();
        std::thread::sleep(Duration::from_millis(20));
        p.connected(Route::Bing);
        p.window(Duration::from_millis(5_400));
        p.sent(Instant::now());
        std::thread::sleep(Duration::from_millis(20));
        p.turn_started(Instant::now());
        std::thread::sleep(Duration::from_millis(20));
        p.first_audio(Instant::now());
        let first = p.rec.first_audio_ms;
        std::thread::sleep(Duration::from_millis(20));
        p.first_audio(Instant::now()); // a later chunk moves nothing
        p.turn_started(Instant::now());
        assert_eq!(p.rec.first_audio_ms, first);
        let r = p.end(None);
        let at = |o: Option<u64>| o.expect("noted");
        assert!(at(r.connect_ms) < at(r.connected_ms));
        assert!(at(r.connected_ms) <= at(r.sent_ms) && at(r.sent_ms) < at(r.turn_start_ms));
        assert!(at(r.turn_start_ms) < at(r.first_audio_ms) && at(r.first_audio_ms) < r.end_ms);
        assert_eq!((r.diag, r.waited_on, r.fresh, r.idle_ms, r.route, r.window_ms, r.end), (Some(7), true, true, Some(2_500), Some("bing"), Some(5_400), "ok"));
    }

    #[test]
    fn a_warm_call_that_failed_before_the_service_answered_records_only_what_happened() {
        let mut p = Probe::begin_at(Instant::now(), 1, None, 2, None, None);
        p.found_client(Some(Duration::from_millis(900)));
        p.reused(Route::MsEdge);
        p.sent(Instant::now());
        let r = p.end(Some("edge synth: Io(Os { code: 10054, kind: ConnectionReset })"));
        assert_eq!((r.fresh, r.route, r.waited_on, r.prior, r.end), (false, Some("msedge"), false, 2, "service-error"));
        assert_eq!((r.connect_ms, r.connected_ms, r.turn_start_ms, r.first_audio_ms), (None, None, None, None));
    }

    #[test]
    fn what_the_frontend_receives_is_numbers_and_names_and_never_the_text() {
        // Words no field name can contain, so a match can only be the text leaking.
        let text = "جملة الكتاب نفسها لا تسجل أبدا QUOKKA ZEPHYR";
        let mut p = Probe::begin(Some(41), text, Some(12_000), Some(6_000));
        p.found_client(None);
        p.connecting();
        p.connected(Route::MsEdge);
        p.sent(Instant::now());
        p.turn_started(Instant::now());
        p.first_audio(Instant::now());
        let r = p.end(Some("edge synth stalled: stream idle"));
        let json = serde_json::to_string(&r).unwrap();
        for word in text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2) {
            assert!(!json.contains(word), "{word} in {json}");
        }
        let fields: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&json).unwrap();
        let allowed = [
            "seq", "diag", "at", "waitedOn", "budgetMs", "capMs", "prior", "fresh", "idleMs", "route", "connectMs", "connectedMs",
            "sentMs", "turnStartMs", "firstAudioMs", "windowMs", "endMs", "end", "status",
        ];
        for (k, v) in &fields {
            assert!(allowed.contains(&k.as_str()), "unexpected field {k}");
            assert!(v.is_number() || v.is_boolean() || matches!(k.as_str(), "route" | "end"), "{k} = {v}");
        }
    }

    #[test]
    fn the_same_text_is_counted_within_the_window_and_forgotten_after_it() {
        let t0 = Instant::now();
        let text = format!("a sentence only this test uses {t0:?}");
        assert_eq!(prior_of(&text, t0), 0);
        assert_eq!(prior_of(&text, t0 + Duration::from_secs(1)), 1);
        assert_eq!(prior_of("another sentence", t0 + Duration::from_secs(2)), 0);
        assert_eq!(prior_of(&text, t0 + Duration::from_secs(3)), 2);
        assert_eq!(prior_of(&text, t0 + PRIOR_WINDOW + Duration::from_secs(4)), 0, "older than the window: forgotten");
        assert!(lock_recover(&PRIOR).len() <= PRIOR_KEEP);
    }

    #[test]
    fn the_call_log_files_each_call_in_the_order_it_ended_and_stays_bounded() {
        let before = call_log_since(0).last().map_or(0, |c| c.seq);
        Probe::begin_at(Instant::now(), 10, Some(1), 0, None, None).finish(None);
        Probe::begin_at(Instant::now(), 11, Some(2), 0, None, None).finish(Some("edge synth cancelled"));
        let got: Vec<_> = call_log_since(before).into_iter().filter(|c| c.at == 10 || c.at == 11).collect();
        assert_eq!(got.iter().map(|c| (c.diag, c.end)).collect::<Vec<_>>(), [(Some(1), "ok"), (Some(2), "cancelled")]);
        assert!(got[1].seq > got[0].seq);
        for _ in 0..CALL_LOG_KEEP + 10 {
            Probe::begin_at(Instant::now(), 12, None, 0, None, None).finish(None);
        }
        assert_eq!(call_log_since(0).len(), CALL_LOG_KEEP);
        assert!(call_log_since(u64::MAX).is_empty());
    }
}
