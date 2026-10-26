//! HOW SARD CONNECTS TO THE EDGE READ-ALOUD SERVICE, AND WHAT IT LEARNS WHEN A WAY STOPS WORKING.
//!
//! The service changed twice in two weeks, on two different hosts, and each change stopped read-aloud
//! completely for a client that knew a single way in:
//!
//!   * from 2026-10-10 the original host refused the version-1 token (HTTP 403);
//!   * from 2026-10-23 the other host answered a WebSocket request carrying neither `Accept` nor
//!     `Accept-Encoding` with a plain HTTP 200 instead of upgrading it — the request this client sent.
//!
//! Measured 2026-10-24 with this module's request: both hosts upgrade it, with the version-2 token
//! (`edge_token`), and both synthesize Arabic and English with word timings. So there are two routes, tried in
//! a fixed order (`ROUTES`), and a small record of how each has failed lately — enough to step around a route
//! the service refuses, to stay on one that is merely having a bad moment, and to come back by itself.
//!
//! THE RULES. A route is left only on evidence that the route, not the moment or the network, is the problem.
//!
//!   * REFUSED or REJECTED: the service answered without upgrading — any HTTP status except 408, 429 and 5xx.
//!     401 and 403 reject the request's credentials (the token or the key: the 2026-10-10 change); every other
//!     status says this request is not a WebSocket there (the 2026-10-23 HTTP 200). The same request cannot get
//!     a different answer, so the other route is tried in the same attempt and this one is skipped for
//!     `REFUSED_COOLDOWN`.
//!   * Everything else is TRANSIENT: a rate limit (429), a server error (408, 5xx), no answer at all (DNS, TCP,
//!     TLS), or a handshake still running when its caller stopped waiting. It ENDS the attempt — no second
//!     request in the same attempt, so a shared rate limit or a dead network is never pressed harder — and the
//!     scheduler retries exactly as it always has. A route is left for transient reasons only when they are
//!     sustained: `TRANSIENT_STREAK` in a row spanning at least `TRANSIENT_SPAN`. It is then skipped for
//!     `TRANSIENT_COOLDOWN`, and the next attempt starts on the other route.
//!   * A RATE LIMIT never penalizes a route: it earns no strike, so whatever it sets off is the base cooldown,
//!     never a doubled one, and a 429 on a route's trial does not skip it again. One case moves on after a 429:
//!     an attempt the listener is WAITING ON — a call of the scheduler's recovery round, the only calls that carry
//!     a budget — whose first route has now answered 429 `RATE_LIMIT_FALLBACK_AFTER` times in a row tries the
//!     next route once, inside the same attempt and its budget, unless that route has failed in the last
//!     `FALLBACK_HOLD`; a limit the routes share therefore costs one extra request a minute at most, and never one
//!     more to the route that is limiting. Nothing else about the attempt, the round or Retry changes.
//!   * A skipped route is TRIED AGAIN by the first connection made after its cooldown — a connection the reader
//!     needs anyway, never an extra request. If it connects, its record is cleared and it is first again. If it
//!     fails in any way, the attempt moves on (except after a rate limit) and the route is skipped for twice as
//!     long as last time, up to `MAX_COOLDOWN`. A route that stays broken costs one handshake per cooldown — at
//!     most one an hour once it has been broken for a while — and two routes cannot take turns failing.
//!   * When every route is being skipped, the attempt tries them in order, each at most once, so whichever
//!     comes back first is found by the next attempt; how many attempts there are is the scheduler's to bound,
//!     as before.
//!   * At most one handshake per route per attempt. A connection clears its route's record. Nothing persists:
//!     each launch starts from the order.
//!   * A SLOW FIRST HANDSHAKE IS NOT WAITED OUT ALONE. When the first route has not answered within
//!     `HEDGE_AFTER`, the next route in the plan is started beside it, and the first handshake to connect wins
//!     the attempt; the other is dropped unused when it finishes and records nothing, success or failure. Every
//!     rule above still decides what a failure means and whether a failure moves the attempt on; only a handshake
//!     that is still running is no longer the only one. Where the first route answers normally, the second is
//!     never contacted (see `HEDGE_AFTER`).
//!
//! WHY THESE NUMBERS. One installation's recorded read-aloud sessions on the msedge host, 2026-10-12 to 10-23:
//! 21,170 requests, 97 failed, 82 of them HTTP 429 at connect. The connection failures came in 57 runs — 34 of
//! one failure, the longest of seven — and every run ended with a success on the same route, 0.9–8.9 s after
//! its last failure. All but one run spanned at most 18.7 s; that one (81 s) began with DNS failures, the
//! listener's own network, which no other route could have fixed. Leaving a route after two transient failures
//! would have switched routes 23 times for nothing; three spanning 30 s would have switched once. Three of the
//! sessions' "Edge unavailable" pauses were a whole recovery round answered 429 (the sentence's first try and
//! both recovery tries), with the route working again seconds later — what the rate-limit fallback is for.
//!
//! WHAT IT CANNOT DO. It cannot keep read-aloud working when the service refuses every route it knows. A route
//! that upgrades and then fails the synthesis is not counted against it here. A fallback that works leaves no
//! trace in the app's records — only a failed attempt is reported. It does not correct the computer's clock,
//! which the token depends on.
//!
//! WHAT IS REPORTED. A failed attempt reads `edge connect: http <status>; <route> <outcome> (<detail>), …`,
//! where the status is that of the last route tried, so `isPermanentFailure` in src/lib/tts.ts reads it
//! exactly as it read the single route's before. Details are HTTP statuses and I/O error kinds only: no URL,
//! token, key, header or response body.

use std::collections::VecDeque;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use msedge_tts::tts::stream::{msedge_tts_split_request, Receiver, Sender};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::client::Request;
use tungstenite::http::header;

use super::edge_token::{sec_ms_gec, CLIENT_KEY};
use super::lock_recover;

/// A way to reach the synthesis WebSocket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Route {
    /// The host Sard 1.4.1 moved to, and the one its read-aloud has been measured on in long sessions.
    MsEdge,
    /// The original read-aloud host, which the other Edge read-aloud clients use. Its own DNS name, front end
    /// and key parameter, so it does not share msedge's way of failing.
    Bing,
}

/// Every route, in the order they are tried. Measured 2026-10-24, 20 interleaved handshakes each: both 20/20;
/// msedge p50 595 ms, p90 735 ms; bing p50 866 ms, p90 986 ms.
pub(super) const ROUTES: [Route; 2] = [Route::MsEdge, Route::Bing];

impl Route {
    pub(super) fn name(self) -> &'static str {
        match self {
            Route::Bing => "bing",
            Route::MsEdge => "msedge",
        }
    }

    /// The endpoint, and the query parameter that carries the client key there.
    fn endpoint(self) -> (&'static str, &'static str) {
        match self {
            Route::Bing => ("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1", "TrustedClientToken"),
            Route::MsEdge => ("wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1", "Ocp-Apim-Subscription-Key"),
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// The browser identity the request presents — the one this client has always sent. Measured 2026-10-24:
/// neither host's answer depends on it.
const USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.193 Mobile Safari/537.36 EdgA/143.0.3650.125";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
/// `2-` names the token scheme; the browser version after it matches the identity above. Measured
/// 2026-10-24: a bare `2-` is refused, and every browser version tried after it was accepted.
const GEC_VERSION: &str = "2-143.0.3650.125";
/// What a browser's own WebSocket request sends. Since 2026-10-23 the msedge host upgrades a request only when
/// it carries `Accept` or `Accept-Encoding`; the bing host does not mind either way.
const ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";
const ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";

/// The upgrade request for `route`, with the token for the window containing `unix_secs`.
pub(super) fn request_for(route: Route, unix_secs: u64, connection_id: &str) -> tungstenite::Result<Request> {
    let (endpoint, key_param) = route.endpoint();
    let url = format!(
        "{endpoint}?{key_param}={CLIENT_KEY}&ConnectionId={connection_id}&Sec-MS-GEC={}&Sec-MS-GEC-Version={GEC_VERSION}",
        sec_ms_gec(unix_secs)
    );
    let mut request = url.into_client_request()?;
    let headers = request.headers_mut();
    for (name, value) in [
        (header::PRAGMA, "no-cache"),
        (header::CACHE_CONTROL, "no-cache"),
        (header::USER_AGENT, USER_AGENT),
        (header::ORIGIN, ORIGIN),
        (header::ACCEPT_ENCODING, ACCEPT_ENCODING),
        (header::ACCEPT_LANGUAGE, ACCEPT_LANGUAGE),
    ] {
        headers.insert(name, header::HeaderValue::from_static(value));
    }
    Ok(request)
}

/// How one route's connection attempt failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// Answered without upgrading, with a status that is about neither credentials, load nor the server: this
    /// request is not a WebSocket there (2xx, 3xx, most 4xx). The 2026-10-23 HTTP 200 is one.
    Incompatible,
    /// 401 or 403: the request's credentials — the token or the key — were refused. The 2026-10-10 change.
    Rejected,
    /// 429.
    RateLimited,
    /// 408 or 5xx.
    ServerError,
    /// No HTTP answer: DNS, TCP, TLS, or a handshake the connection broke off.
    Network,
    /// The caller's budget ran out while the handshake was still running.
    TimedOut,
}

impl Failure {
    /// The service answered and said no: the same request again cannot get a different answer.
    fn is_refusal(self) -> bool {
        matches!(self, Failure::Incompatible | Failure::Rejected)
    }

    fn name(self) -> &'static str {
        match self {
            Failure::Incompatible => "refused",
            Failure::Rejected => "rejected",
            Failure::RateLimited => "rate-limited",
            Failure::ServerError => "server-error",
            Failure::Network => "failed",
            Failure::TimedOut => "timed-out",
        }
    }
}

/// One route's failed attempt, already stripped of everything but what the decision and the report need.
#[derive(Debug)]
pub(super) struct AttemptError {
    pub(super) failure: Failure,
    /// The HTTP status the service answered with, when it answered.
    pub(super) status: Option<u16>,
    /// A short description safe to record: a status or an error kind, never a URL, header or body.
    pub(super) detail: String,
}

/// Classify a connection error and reduce it to what may be recorded.
pub(super) fn attempt_error(e: &msedge_tts::error::Error) -> AttemptError {
    use msedge_tts::error::Error;
    let network = |detail: String| AttemptError { failure: Failure::Network, status: None, detail };
    let Error::TungsteniteError(e) = e else {
        return network("error".into());
    };
    match e {
        tungstenite::Error::Http(response) => {
            let status = response.status().as_u16();
            let failure = match status {
                401 | 403 => Failure::Rejected,
                429 => Failure::RateLimited,
                408 | 500..=599 => Failure::ServerError,
                _ => Failure::Incompatible,
            };
            AttemptError { failure, status: Some(status), detail: format!("http {status}") }
        }
        // The kind and the OS code, which `isFastReset` in src/lib/tts.ts reads (`ConnectionReset`, 10054).
        tungstenite::Error::Io(io) => network(match io.raw_os_error() {
            Some(code) => format!("io {:?} os {code}", io.kind()),
            None => format!("io {:?}", io.kind()),
        }),
        tungstenite::Error::Tls(_) => network("tls".into()),
        tungstenite::Error::Protocol(p) => network(format!("protocol {p:?}").chars().take(60).collect()),
        _ => network("websocket".into()),
    }
}

/// A refused or rejected route is first skipped for this long. The service's method changes are measured in
/// days, so this only bounds how often a refused route is asked again.
pub(super) const REFUSED_COOLDOWN: Duration = Duration::from_secs(600);
/// Transient failures leave a route only when there are at least this many in a row ...
pub(super) const TRANSIENT_STREAK: u32 = 3;
/// ... spanning at least this long — longer than any burst that repaired itself (see the top of this file).
pub(super) const TRANSIENT_SPAN: Duration = Duration::from_secs(30);
/// A route left for transient reasons is first skipped for this long.
pub(super) const TRANSIENT_COOLDOWN: Duration = Duration::from_secs(120);
/// Each failed try after a cooldown doubles the next one, up to this.
pub(super) const MAX_COOLDOWN: Duration = Duration::from_secs(3_600);
/// An attempt the listener waits on tries the next route after this many 429s in a row from its first route —
/// in a fresh recovery round, its final try.
pub(super) const RATE_LIMIT_FALLBACK_AFTER: u32 = 3;
/// ... unless the next route has itself failed this recently.
pub(super) const FALLBACK_HOLD: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default)]
struct RouteState {
    cooling_until: Option<Instant>,
    /// Cooldowns since this route last connected, rate limits excepted. Above zero, each try is a trial.
    strikes: u32,
    /// Transient failures in a row, and when the first of them happened.
    transient: u32,
    transient_since: Option<Instant>,
    /// 429s in a row; any other answer ends the run.
    rate_limited: u32,
    /// When this route last failed, in any way.
    last_failure: Option<Instant>,
}

/// What the routes have done lately — the only state this module keeps, for the life of the process.
#[derive(Debug, Default)]
pub(super) struct RouteBook {
    routes: [RouteState; ROUTES.len()],
}

impl RouteBook {
    fn cooling(&self, route: Route, now: Instant) -> bool {
        self.routes[route.index()].cooling_until.is_some_and(|until| now < until)
    }

    /// The routes one connection attempt may try, in order: those not being skipped; or, when every route is,
    /// all of them.
    pub(super) fn plan(&self, now: Instant) -> Vec<Route> {
        let ready: Vec<Route> = ROUTES.into_iter().filter(|r| !self.cooling(*r, now)).collect();
        if ready.is_empty() {
            ROUTES.to_vec()
        } else {
            ready
        }
    }

    pub(super) fn succeeded(&mut self, route: Route) {
        self.routes[route.index()] = RouteState::default();
    }

    /// Record a failure; true when it puts the route into cooldown.
    pub(super) fn failed(&mut self, route: Route, failure: Failure, now: Instant) -> bool {
        let state = &mut self.routes[route.index()];
        let rate_limit = failure == Failure::RateLimited;
        state.last_failure = Some(now);
        state.rate_limited = if rate_limit { state.rate_limited + 1 } else { 0 };
        let base = if failure.is_refusal() {
            REFUSED_COOLDOWN
        } else if state.strikes > 0 && !rate_limit {
            // A route already skipped once, failing again on its trial: the evidence is not new.
            TRANSIENT_COOLDOWN
        } else {
            state.transient += 1;
            let since = *state.transient_since.get_or_insert(now);
            if state.transient < TRANSIENT_STREAK || now.saturating_duration_since(since) < TRANSIENT_SPAN {
                return false;
            }
            TRANSIENT_COOLDOWN
        };
        state.transient = 0;
        state.transient_since = None;
        // A rate limit alone earns no strike: what it sets off is the base cooldown, never a doubled one.
        let doubling = if rate_limit {
            1
        } else {
            state.strikes = state.strikes.saturating_add(1);
            1u32 << (state.strikes - 1).min(16)
        };
        state.cooling_until = Some(now + base.saturating_mul(doubling).min(MAX_COOLDOWN));
        true
    }

    /// Whether an attempt the listener waits on, its first route having just answered 429, may try `next`: the
    /// first route's 429s have run `RATE_LIMIT_FALLBACK_AFTER` in a row, and `next` has not failed lately.
    fn rate_limit_fallback(&self, first: Route, next: Route, now: Instant) -> bool {
        self.routes[first.index()].rate_limited >= RATE_LIMIT_FALLBACK_AFTER
            && self.routes[next.index()].last_failure.map_or(true, |t| now.saturating_duration_since(t) >= FALLBACK_HOLD)
    }

    /// End a route's cooldown now, as its passing would, without forgetting its strikes.
    #[cfg(test)]
    fn expire(&mut self, route: Route) {
        self.routes[route.index()].cooling_until = None;
    }

    /// The route's current run of transient failures.
    #[cfg(test)]
    pub(super) fn transient_failures(&self, route: Route) -> u32 {
        self.routes[route.index()].transient
    }
}

/// One connection attempt as its caller sees it: the routes whose handshakes are running, the route that won the
/// attempt, and whether the caller has stopped waiting. All three change under ONE lock, so at most one
/// handshake can ever win an attempt. A handshake the caller gave up on is the caller's to record (`end`); a
/// handshake that finishes after the attempt was won or given up records nothing, and its connection is dropped
/// unused where it finished.
///
/// An attempt made for a call can also see that call's cancel flag. It uses it for ONE thing: no handshake
/// starts once the call is cancelled — not even the second route, whose start would otherwise fall between the
/// listener's cancel and the moment the caller next looks (one wait slice). Everything else about a cancel is the
/// caller's, as before: a handshake already running finishes as it always did.
#[derive(Debug, Default)]
pub(super) struct Attempt {
    state: Mutex<AttemptState>,
    cancel: Option<Arc<AtomicBool>>,
}

#[derive(Debug, Default)]
struct AttemptState {
    in_flight: Vec<Route>,
    winner: Option<Route>,
    over: bool,
}

/// Where a finished handshake stands with its attempt.
#[derive(Debug, PartialEq, Eq)]
enum Finish {
    /// It connected first: the attempt is its.
    Won,
    /// It failed while the attempt was still open: its failure counts against its route.
    Failed,
    /// Another route had already won the attempt, or the caller had stopped waiting: dropped, nothing recorded.
    Unused,
}

impl Attempt {
    /// An attempt for a call whose cancel flag is `cancel`.
    pub(super) fn for_call(cancel: Arc<AtomicBool>) -> Self {
        Attempt { state: Mutex::default(), cancel: Some(cancel) }
    }

    /// A handshake on `route` is about to start; false once the call is cancelled, the caller has stopped
    /// waiting, or the attempt is won.
    fn begin(&self, route: Route) -> bool {
        if self.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return false;
        }
        let mut state = lock_recover(&self.state);
        if state.over || state.winner.is_some() {
            return false;
        }
        state.in_flight.push(route);
        true
    }

    /// The handshake on `route` has returned, `connected` or not.
    fn finish(&self, route: Route, connected: bool) -> Finish {
        let mut state = lock_recover(&self.state);
        state.in_flight.retain(|r| *r != route);
        if state.over || state.winner.is_some() {
            Finish::Unused
        } else if connected {
            state.winner = Some(route);
            Finish::Won
        } else {
            Finish::Failed
        }
    }

    /// Whether the caller has stopped waiting.
    fn is_over(&self) -> bool {
        lock_recover(&self.state).over
    }

    /// The caller stops waiting. Returns the routes whose handshakes were still running.
    pub(super) fn end(&self) -> Vec<Route> {
        let mut state = lock_recover(&self.state);
        state.over = true;
        std::mem::take(&mut state.in_flight)
    }
}

/// Record a handshake's failure and say whether it moves the attempt on to the next route in the plan. One
/// decision for both ways of making an attempt, so they cannot drift apart.
fn record_failure(book: &Mutex<RouteBook>, plan: &[Route], index: usize, route: Route, e: &AttemptError, waited_on: bool, now: Instant) -> bool {
    let mut book = lock_recover(book);
    let cooling = book.failed(route, e.failure, now);
    if e.failure == Failure::RateLimited {
        // A rate limit's pressure may be shared, so it moves on only in the one case the rules allow.
        waited_on && index == 0 && plan.get(1).is_some_and(|&next| book.rate_limit_fallback(route, next, now))
    } else {
        // Otherwise only from a route this failure has shown to be the problem.
        cooling
    }
}

/// The report of a failed attempt: the routes in the order they answered, the status that of the last.
fn attempt_failed(tried: &[String], status: Option<u16>) -> String {
    if tried.is_empty() {
        return "edge connect: abandoned".into();
    }
    let tried = tried.join(", ");
    match status {
        Some(status) => format!("edge connect: http {status}; {tried}"),
        None => format!("edge connect: {tried}"),
    }
}

/// The caller stopped waiting for `route`'s handshake because its budget ran out.
pub(super) fn timed_out(book: &Mutex<RouteBook>, route: Route) {
    lock_recover(book).failed(route, Failure::TimedOut, Instant::now());
}

/// One connection attempt across the routes, one handshake after another, by the rules at the top of this file.
/// `waited_on` says the listener is waiting on it (a recovery-round call). `try_route` makes the connection on
/// one route; the book is never locked while it runs.
///
/// The production connect is `connect_hedged_via`; this sequential form is kept as the reference its rules are
/// tested against (on a virtual clock, which the threaded form cannot use), and for the bounded-connect tests.
#[cfg(test)]
pub(super) fn connect_via<C>(
    book: &Mutex<RouteBook>,
    attempt: &Attempt,
    now: impl Fn() -> Instant,
    waited_on: bool,
    mut try_route: impl FnMut(Route) -> Result<C, AttemptError>,
) -> Result<C, String> {
    let plan = lock_recover(book).plan(now());
    let mut tried = Vec::with_capacity(plan.len());
    let mut status = None;
    for (i, &route) in plan.iter().enumerate() {
        if !attempt.begin(route) {
            break;
        }
        let result = try_route(route);
        if attempt.finish(route, result.is_ok()) == Finish::Unused {
            // The caller gave up during this handshake and has recorded it; whatever came back goes unused.
            return Err(format!("edge connect: {} abandoned", route.name()));
        }
        let e = match result {
            Ok(client) => {
                lock_recover(book).succeeded(route);
                return Ok(client);
            }
            Err(e) => e,
        };
        let moves_on = record_failure(book, &plan, i, route, &e, waited_on, now());
        tried.push(format!("{} {} ({})", route.name(), e.failure.name(), e.detail));
        status = e.status;
        if !moves_on {
            break;
        }
    }
    Err(attempt_failed(&tried, status))
}

/// How long the first route's handshake runs alone before the next route is started beside it.
///
/// MEASURED. Of 273 handshakes the owner's installation made on msedge — 73 in real listening (2026-10-24/25) and
/// 200 probed on 2026-10-26 — the slowest took 1.92 s (p95 0.80 s), so where msedge answers normally the second
/// route is never contacted. On the affected installation (245 recorded, 2026-10-25) 60% took longer than 2 s,
/// up to 42.8 s, and none ended between 2 and 3 s: a handshake not done by 2 s was not about to be.
pub(super) const HEDGE_AFTER: Duration = Duration::from_secs(2);

/// How often a waiting attempt looks whether its caller has stopped waiting, so it never outlives its caller by
/// more than this.
const ATTEMPT_POLL: Duration = Duration::from_millis(100);

/// What a handshake running on its own thread reports to its attempt.
enum Leg<C> {
    Won(C),
    Failed { route: Route, index: usize, error: AttemptError, moves_on: bool },
}

/// `connect_via`, with the next route in the plan started beside the first when the first has not answered
/// within `hedge_after` (see THE RULES). Each handshake runs on its own thread, because a handshake cannot be
/// interrupted; the first to connect wins under the attempt's lock and is the only connection returned. A
/// handshake that finishes after that — or after the caller stopped waiting — is dropped on its own thread,
/// unused, and records nothing. Failures are recorded and decided by `record_failure`, exactly as in
/// `connect_via`; a failure that would end the attempt there ends it here once no other handshake is running.
/// Returns within `ATTEMPT_POLL` of the caller giving up.
pub(super) fn connect_hedged_via<C: Send + 'static>(
    book: &Arc<Mutex<RouteBook>>,
    attempt: &Arc<Attempt>,
    waited_on: bool,
    hedge_after: Duration,
    try_route: Arc<dyn Fn(Route) -> Result<C, AttemptError> + Send + Sync>,
) -> Result<C, String> {
    let plan = lock_recover(book).plan(Instant::now());
    let (tx, rx) = mpsc::channel::<Leg<C>>();
    let mut started = vec![false; plan.len()];
    let start = |index: usize, started: &mut Vec<bool>| -> bool {
        let route = plan[index];
        if started[index] || !attempt.begin(route) {
            return false;
        }
        started[index] = true;
        let (book, attempt, tx, try_route, plan) = (book.clone(), attempt.clone(), tx.clone(), try_route.clone(), plan.clone());
        std::thread::spawn(move || {
            let result = try_route(route);
            match (attempt.finish(route, result.is_ok()), result) {
                (Finish::Won, Ok(client)) => {
                    lock_recover(&book).succeeded(route);
                    let _ = tx.send(Leg::Won(client));
                }
                (Finish::Failed, Err(error)) => {
                    let moves_on = record_failure(&book, &plan, index, route, &error, waited_on, Instant::now());
                    let _ = tx.send(Leg::Failed { route, index, error, moves_on });
                }
                // Unused: the attempt was already won, or the caller left. Dropped here, with its socket.
                _ => {}
            }
        });
        true
    };
    if !start(0, &mut started) {
        return Err(attempt_failed(&[], None));
    }
    let begun = Instant::now();
    let mut running = 1usize;
    let mut tried = Vec::with_capacity(plan.len());
    loop {
        let hedge_due = plan.len() > 1 && !started[1];
        let wait = if hedge_due { hedge_after.saturating_sub(begun.elapsed()).min(ATTEMPT_POLL) } else { ATTEMPT_POLL };
        match rx.recv_timeout(wait) {
            Ok(Leg::Won(client)) => return Ok(client),
            Ok(Leg::Failed { route, index, error, moves_on }) => {
                running -= 1;
                tried.push(format!("{} {} ({})", route.name(), error.failure.name(), error.detail));
                if moves_on && index + 1 < plan.len() && start(index + 1, &mut started) {
                    running += 1;
                } else if running == 0 {
                    // This was the last handshake to answer, so its status is the report's.
                    return Err(attempt_failed(&tried, error.status));
                }
            }
            Err(_) => {
                if attempt.is_over() {
                    return Err(attempt_failed(&[], None));
                }
                if hedge_due && begun.elapsed() >= hedge_after && start(1, &mut started) {
                    running += 1;
                }
            }
        }
    }
}

/// Open the split synthesis client on the first route that accepts it.
pub(super) fn connect(book: &Arc<Mutex<RouteBook>>, attempt: &Arc<Attempt>, waited_on: bool) -> Result<(Sender<TcpStream>, Receiver<TcpStream>), String> {
    connect_hedged_via(book, attempt, waited_on, HEDGE_AFTER, Arc::new(move |route| {
        let unix_secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let connection_id = uuid::Uuid::new_v4().simple().to_string();
        let request = request_for(route, unix_secs, &connection_id).map_err(|e| attempt_error(&e.into()))?;
        let started = Instant::now();
        let result = msedge_tts_split_request(request).map_err(|e| attempt_error(&e));
        record_try(route, result.as_ref().map(|_| ()), started.elapsed().as_millis() as u64, waited_on);
        result
    }))
}

// ---- session diagnostics ----------------------------------------------------------------------------------
//
// OBSERVATION ONLY. Every route the production connect tries is recorded as it answered: the route, the outcome
// as the rules above classified it, the HTTP status, how long the handshake took and whether the listener was
// waiting. It is what tells a listening session's telemetry which route served a sentence — the frontend only
// ever sees a call's one result. Bounded and in memory; never a URL, a header, a token or a body. Nothing in
// the routing reads it.

/// One route the production connect tried, as it answered.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTry {
    /// Increases by one per try, for the life of the process.
    pub seq: u64,
    /// Unix time, in ms, when the handshake ended.
    pub at: u64,
    pub route: &'static str,
    /// `ok`, or the failure's class: refused, rejected, rate-limited, server-error, failed, timed-out.
    pub outcome: &'static str,
    pub status: Option<u16>,
    pub ms: u64,
    pub waited_on: bool,
}

const ROUTE_LOG_KEEP: usize = 400;
static ROUTE_LOG: Mutex<(u64, VecDeque<RouteTry>)> = Mutex::new((0, VecDeque::new()));

fn record_try(route: Route, outcome: Result<(), &AttemptError>, ms: u64, waited_on: bool) {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let (outcome, status) = match outcome {
        Ok(()) => ("ok", None),
        Err(e) => (e.failure.name(), e.status),
    };
    let mut log = lock_recover(&ROUTE_LOG);
    log.0 += 1;
    let seq = log.0;
    log.1.push_back(RouteTry { seq, at, route: route.name(), outcome, status, ms, waited_on });
    if log.1.len() > ROUTE_LOG_KEEP {
        log.1.pop_front();
    }
}

/// The routes tried after sequence number `since`, oldest first.
pub(super) fn route_log_since(since: u64) -> Vec<RouteTry> {
    lock_recover(&ROUTE_LOG).1.iter().filter(|t| t.seq > since).cloned().collect()
}

#[cfg(test)]
mod route_log_tests {
    use super::*;

    #[test]
    fn the_route_log_records_each_try_in_order_with_its_class_and_stays_bounded() {
        let before = route_log_since(0).last().map_or(0, |t| t.seq);
        let limited = AttemptError { failure: Failure::RateLimited, status: Some(429), detail: "http 429".into() };
        record_try(Route::MsEdge, Err(&limited), 650, true);
        record_try(Route::Bing, Ok(()), 480, true);
        let got = route_log_since(before);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].route, got[0].outcome, got[0].status, got[0].ms, got[0].waited_on), ("msedge", "rate-limited", Some(429), 650, true));
        assert_eq!((got[1].route, got[1].outcome, got[1].status, got[1].ms), ("bing", "ok", None, 480));
        assert_eq!(got[1].seq, got[0].seq + 1);
        assert!(got[0].at > 0 && got[1].at >= got[0].at);
        // What the frontend receives: no URL, header, token or body — only these fields.
        let json = serde_json::to_string(&got[0]).unwrap();
        assert_eq!(json, format!(r#"{{"seq":{},"at":{},"route":"msedge","outcome":"rate-limited","status":429,"ms":650,"waitedOn":true}}"#, got[0].seq, got[0].at));

        for _ in 0..ROUTE_LOG_KEEP + 10 {
            record_try(Route::Bing, Ok(()), 1, false);
        }
        assert_eq!(route_log_since(0).len(), ROUTE_LOG_KEEP);
        assert!(route_log_since(u64::MAX).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    // ---- the request ----

    #[test]
    fn each_route_asks_for_its_own_endpoint_with_the_version_2_token() {
        let gec = sec_ms_gec(1_791_888_000);
        let bing = request_for(Route::Bing, 1_791_888_000, "0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            bing.uri().to_string(),
            format!("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={CLIENT_KEY}&ConnectionId=0123456789abcdef0123456789abcdef&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=2-143.0.3650.125")
        );
        let msedge = request_for(Route::MsEdge, 1_791_888_000, "0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            msedge.uri().to_string(),
            format!("wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key={CLIENT_KEY}&ConnectionId=0123456789abcdef0123456789abcdef&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=2-143.0.3650.125")
        );
    }

    #[test]
    fn the_request_carries_the_headers_a_browser_sends() {
        let request = request_for(Route::MsEdge, 1_791_888_000, "id").unwrap();
        let h = request.headers();
        // The pair whose absence the msedge host has refused since 2026-10-23.
        assert_eq!(h["accept-encoding"], "gzip, deflate, br, zstd");
        assert_eq!(h["accept-language"], "en-US,en;q=0.9");
        assert_eq!(h["origin"], "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
        assert_eq!(h["user-agent"], USER_AGENT);
        assert_eq!((&h["pragma"], &h["cache-control"]), (&"no-cache".parse().unwrap(), &"no-cache".parse().unwrap()));
    }

    // ---- what a failure means ----

    fn answered(status: u16, body: Option<Vec<u8>>) -> msedge_tts::error::Error {
        let response = tungstenite::http::Response::builder()
            .status(status)
            .header("set-cookie", "MUID=private-value")
            .body(body)
            .unwrap();
        msedge_tts::error::Error::TungsteniteError(tungstenite::Error::Http(Box::new(response)))
    }

    fn io(kind: std::io::ErrorKind, os: Option<i32>) -> msedge_tts::error::Error {
        let e = match os {
            Some(code) => std::io::Error::from_raw_os_error(code),
            None => std::io::Error::new(kind, "no such host"),
        };
        msedge_tts::error::Error::TungsteniteError(tungstenite::Error::Io(e))
    }

    #[test]
    fn a_handshake_answered_with_200_and_an_empty_body_is_incompatible() {
        // Exactly the 2026-10-23 answer: a plain 200, no upgrade, nothing in the body.
        for body in [None, Some(Vec::new())] {
            let e = attempt_error(&answered(200, body));
            assert_eq!((e.failure, e.status), (Failure::Incompatible, Some(200)));
        }
    }

    #[test]
    fn each_kind_of_answer_has_its_own_class() {
        for (status, class) in [
            (101, Failure::Incompatible), // an upgrade tungstenite could not accept arrives as Http too
            (204, Failure::Incompatible),
            (301, Failure::Incompatible),
            (400, Failure::Incompatible),
            (404, Failure::Incompatible),
            (410, Failure::Incompatible),
            (426, Failure::Incompatible),
            (401, Failure::Rejected),
            (403, Failure::Rejected),
            (429, Failure::RateLimited),
            (408, Failure::ServerError),
            (500, Failure::ServerError),
            (502, Failure::ServerError),
            (503, Failure::ServerError),
            (504, Failure::ServerError),
        ] {
            let e = attempt_error(&answered(status, None));
            assert_eq!((e.failure, e.status), (class, Some(status)), "{status}");
        }
    }

    #[test]
    fn credential_rejections_are_told_apart_from_network_failures() {
        let rejected = attempt_error(&answered(403, None));
        let dns = attempt_error(&io(std::io::ErrorKind::Other, Some(11001)));
        assert_eq!((rejected.failure, rejected.failure.name()), (Failure::Rejected, "rejected"));
        assert_eq!((dns.failure, dns.failure.name(), dns.status), (Failure::Network, "failed", None));
        assert!(rejected.failure.is_refusal() && !dns.failure.is_refusal());
        let other = attempt_error(&msedge_tts::error::Error::UnexpectedMessage("x".into()));
        assert_eq!((other.failure, other.status), (Failure::Network, None));
    }

    #[test]
    fn the_detail_is_a_status_or_an_error_kind_and_nothing_from_the_response() {
        let e = attempt_error(&answered(403, Some(b"<html>body</html>".to_vec())));
        assert_eq!(e.detail, "http 403");
        // A reset keeps what the scheduler's fast-reset rule looks for (`ConnectionReset` or 10054).
        let e = attempt_error(&msedge_tts::error::Error::TungsteniteError(tungstenite::Error::Io(std::io::ErrorKind::ConnectionReset.into())));
        assert_eq!(e.detail, "io ConnectionReset");
    }

    /// Windows reports a reset as OS error 10054, which is what the engine meets there: both strings survive.
    #[cfg(windows)]
    #[test]
    fn a_windows_reset_keeps_its_kind_and_its_code() {
        let e = attempt_error(&io(std::io::ErrorKind::ConnectionReset, Some(10054)));
        assert_eq!(e.detail, "io ConnectionReset os 10054");
    }

    /// The reports tests/unit/ttsRouteReports.test.ts plays through the real frontend pipeline, produced here
    /// by the real classification and attempt logic — so the two cannot drift apart.
    #[test]
    fn the_reports_the_frontend_pipeline_tests_play_are_produced_exactly() {
        let report = |answers: Vec<msedge_tts::error::Error>| {
            let mut answers = answers.into_iter();
            let r: Result<(), String> = connect_via(&Mutex::new(RouteBook::default()), &Attempt::default(), Instant::now, false, |_| Err(attempt_error(&answers.next().unwrap())));
            r.unwrap_err()
        };
        let a = |s: u16| answered(s, None);
        assert_eq!(report(vec![a(200), a(200)]), "edge connect: http 200; msedge refused (http 200), bing refused (http 200)");
        assert_eq!(report(vec![a(403), a(403)]), "edge connect: http 403; msedge rejected (http 403), bing rejected (http 403)");
        assert_eq!(report(vec![a(200), a(403)]), "edge connect: http 403; msedge refused (http 200), bing rejected (http 403)");
        assert_eq!(report(vec![a(401), a(401)]), "edge connect: http 401; msedge rejected (http 401), bing rejected (http 401)");
        assert_eq!(report(vec![a(404), a(404)]), "edge connect: http 404; msedge refused (http 404), bing refused (http 404)");
        assert_eq!(report(vec![a(429)]), "edge connect: http 429; msedge rate-limited (http 429)");
        assert_eq!(report(vec![a(503)]), "edge connect: http 503; msedge server-error (http 503)");
        assert_eq!(report(vec![io(std::io::ErrorKind::Other, Some(11001))]), "edge connect: msedge failed (io Uncategorized os 11001)");
        #[cfg(windows)]
        assert_eq!(report(vec![io(std::io::ErrorKind::ConnectionReset, Some(10054))]), "edge connect: msedge failed (io ConnectionReset os 10054)");
        // A recovery round's final try after two 429s, both routes limited.
        let book = Mutex::new(RouteBook::default());
        let waited = |waited_on: bool| -> String {
            let r: Result<(), String> = connect_via(&book, &Attempt::default(), Instant::now, waited_on, |_| Err(attempt_error(&a(429))));
            r.unwrap_err()
        };
        waited(false);
        waited(true);
        assert_eq!(waited(true), "edge connect: http 429; msedge rate-limited (http 429), bing rate-limited (http 429)");
    }

    // ---- choosing a route: scripted outcomes on a virtual clock ----

    const FIRST: Route = ROUTES[0];
    const SECOND: Route = ROUTES[1];

    struct Clock(Cell<Instant>);
    impl Clock {
        fn new() -> Self {
            Clock(Cell::new(Instant::now()))
        }
        fn now(&self) -> Instant {
            self.0.get()
        }
        fn advance(&self, secs: f64) {
            self.0.set(self.0.get() + Duration::from_secs_f64(secs));
        }
    }

    /// What one route answers in a scripted attempt: `Ok(())` connects.
    type Outcome = Result<(), Failure>;

    fn error_for(failure: Failure) -> AttemptError {
        let (status, detail) = match failure {
            Failure::Incompatible => (Some(200), "http 200".to_string()),
            Failure::Rejected => (Some(403), "http 403".to_string()),
            Failure::RateLimited => (Some(429), "http 429".to_string()),
            Failure::ServerError => (Some(503), "http 503".to_string()),
            Failure::Network => (None, "io TimedOut os 10060".to_string()),
            Failure::TimedOut => (None, "timed out".to_string()),
        };
        AttemptError { failure, status, detail }
    }

    /// One attempt at the clock's current time; returns the routes contacted and the result.
    fn attempt_at(book: &Mutex<RouteBook>, clock: &Clock, outcome: impl Fn(Route) -> Outcome) -> (Vec<Route>, Result<(), String>) {
        attempt_with(book, clock, false, outcome)
    }

    /// The same for an attempt the listener is waiting on: a call of the scheduler's recovery round.
    fn waited_at(book: &Mutex<RouteBook>, clock: &Clock, outcome: impl Fn(Route) -> Outcome) -> (Vec<Route>, Result<(), String>) {
        attempt_with(book, clock, true, outcome)
    }

    fn attempt_with(book: &Mutex<RouteBook>, clock: &Clock, waited_on: bool, outcome: impl Fn(Route) -> Outcome) -> (Vec<Route>, Result<(), String>) {
        let tried = RefCell::new(Vec::new());
        let result = connect_via(book, &Attempt::default(), || clock.now(), waited_on, |route| {
            tried.borrow_mut().push(route);
            outcome(route).map_err(error_for)
        });
        (tried.into_inner(), result)
    }

    /// The scheduler's background backoff, as RULE 1 spaces it (2 s doubling to 30 s), without the jitter.
    fn backoff(n: u32) -> f64 {
        (2.0 * 2f64.powi(n as i32)).min(30.0)
    }

    #[test]
    fn the_routes_are_tried_in_the_measured_order() {
        assert_eq!(ROUTES, [Route::MsEdge, Route::Bing], "the measured order (see `ROUTES`)");
        assert_eq!(RouteBook::default().plan(Instant::now()), vec![FIRST, SECOND]);
    }

    #[test]
    fn a_working_preferred_route_is_the_only_one_ever_contacted() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        for _ in 0..200 {
            let (tried, result) = attempt_at(&book, &clock, |_| Ok(()));
            assert_eq!((tried, result), (vec![FIRST], Ok(())));
            clock.advance(7.0);
        }
    }

    #[test]
    fn one_timeout_then_success_stays_on_the_route() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let (tried, result) = attempt_at(&book, &clock, |_| Err(Failure::Network));
        assert_eq!(tried, vec![FIRST], "no second handshake for a transient failure");
        assert_eq!(result.unwrap_err(), format!("edge connect: {} failed (io TimedOut os 10060)", FIRST.name()));
        clock.advance(2.0);
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
        // The same for a handshake the caller stopped waiting for.
        timed_out(&book, FIRST);
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
        assert_eq!(lock_recover(&book).routes[FIRST.index()].transient, 0, "a connection clears the run");
    }

    /// The longest self-repairing runs in the recorded sessions, replayed: six 429s over 18.7 s, then the
    /// scheduler's background retries landing in a server error and a timeout, then success.
    #[test]
    fn bursts_that_repair_themselves_never_leave_the_route() {
        for script in [
            &[(0.0, Failure::RateLimited), (0.7, Failure::RateLimited), (2.0, Failure::RateLimited), (4.0, Failure::RateLimited), (8.0, Failure::RateLimited), (4.0, Failure::RateLimited)][..],
            &[(0.0, Failure::ServerError), (0.25, Failure::ServerError), (0.75, Failure::ServerError), (2.0, Failure::Network), (4.0, Failure::TimedOut)][..],
        ] {
            let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
            for &(after, failure) in script {
                clock.advance(after);
                let (tried, _) = attempt_at(&book, &clock, |_| Err(failure));
                assert_eq!(tried, vec![FIRST], "{failure:?}");
            }
            clock.advance(2.0);
            assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
        }
    }

    #[test]
    fn a_rate_limit_is_waited_out_on_the_same_route() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let (tried, result) = attempt_at(&book, &clock, |_| Err(Failure::RateLimited));
        assert_eq!(tried, vec![FIRST]);
        assert_eq!(result.unwrap_err(), format!("edge connect: http 429; {} rate-limited (http 429)", FIRST.name()));
        clock.advance(1.2);
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
    }

    #[test]
    fn a_sustained_rate_limit_never_sends_two_requests_in_one_attempt() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let mut contacted_second_at = None;
        for n in 0..12 {
            let (tried, _) = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) });
            assert_eq!(tried.len(), 1, "attempt {n}: {tried:?}");
            if tried == vec![SECOND] && contacted_second_at.is_none() {
                contacted_second_at = Some(n);
            }
            clock.advance(backoff(n));
        }
        // Three in a row spanning 30 s first happen at the fifth attempt (0, 2, 6, 14, 30 s); only the attempt
        // after it starts on the other route.
        assert_eq!(contacted_second_at, Some(5));
    }

    #[test]
    fn a_server_error_is_temporary() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        for n in 0..2 {
            assert_eq!(attempt_at(&book, &clock, |_| Err(Failure::ServerError)).0, vec![FIRST]);
            clock.advance(backoff(n));
        }
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
        assert_eq!(lock_recover(&book).plan(clock.now()), vec![FIRST, SECOND]);
    }

    #[test]
    fn the_transient_threshold_is_three_in_a_row_spanning_thirty_seconds_and_skips_for_two_minutes() {
        for (gaps, leaves) in [(&[15.0, 14.9][..], false), (&[15.0, 15.0][..], true), (&[30.0][..], false), (&[0.1, 0.1, 29.8][..], true)] {
            let mut book = RouteBook::default();
            let t0 = Instant::now();
            let mut t = t0;
            assert!(!book.failed(FIRST, Failure::Network, t));
            let mut left = false;
            for gap in gaps {
                t += Duration::from_secs_f64(*gap);
                left = book.failed(FIRST, Failure::Network, t);
            }
            assert_eq!(left, leaves, "{gaps:?}");
            if leaves {
                assert_eq!(book.plan(t + Duration::from_millis(119_999)), vec![SECOND]);
                assert_eq!(book.plan(t + Duration::from_secs(120)), vec![FIRST, SECOND]);
            }
        }
    }

    #[test]
    fn sustained_transient_failures_move_to_the_other_route() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let first_down = |r: Route| if r == FIRST { Err(Failure::Network) } else { Ok(()) };
        for n in 0..4 {
            assert_eq!(attempt_at(&book, &clock, first_down).0, vec![FIRST], "attempt {n}");
            clock.advance(backoff(n));
        }
        // 30 s after the first failure, the fifth in a row: the route is left within this attempt.
        assert_eq!(attempt_at(&book, &clock, first_down), (vec![FIRST, SECOND], Ok(())));
        clock.advance(5.0);
        assert_eq!(attempt_at(&book, &clock, first_down), (vec![SECOND], Ok(())));
    }

    #[test]
    fn repeated_transient_failures_with_the_other_route_also_down_stay_bounded() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let mut handshakes = 0;
        let mut attempts = 0;
        let mut second_seen_after = None;
        // Fifteen minutes of the scheduler's background retries against a network that answers nothing.
        let mut n = 0;
        while clock.now() < Instant::now() + Duration::from_secs(900) {
            let (tried, result) = attempt_at(&book, &clock, |_| Err(Failure::Network));
            assert!(result.is_err());
            assert!(!tried.is_empty() && tried.len() <= ROUTES.len(), "{tried:?}");
            assert!(tried.len() == 1 || tried[0] != tried[1], "{tried:?}");
            if tried.contains(&SECOND) && second_seen_after.is_none() {
                second_seen_after = Some(attempts);
            }
            handshakes += tried.len();
            attempts += 1;
            clock.advance(backoff(n.min(4)));
            n += 1;
        }
        assert_eq!(second_seen_after, Some(4), "the other route only after the first's failures were sustained");
        assert!(handshakes <= 2 * attempts, "{handshakes} handshakes for {attempts} attempts");
    }

    #[test]
    fn a_refused_handshake_moves_on_at_once_and_is_not_repeated() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let first_refuses = |r: Route| if r == FIRST { Err(Failure::Incompatible) } else { Ok(()) };
        assert_eq!(attempt_at(&book, &clock, first_refuses), (vec![FIRST, SECOND], Ok(())));
        // The refused route is not asked again while it is skipped.
        for _ in 0..9 {
            clock.advance(60.0);
            assert_eq!(attempt_at(&book, &clock, first_refuses), (vec![SECOND], Ok(())));
        }
    }

    #[test]
    fn a_rejected_credential_moves_on_like_a_refusal_but_says_which_it_was() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let (tried, result) = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::Rejected) } else { Err(Failure::Incompatible) });
        assert_eq!(tried, vec![FIRST, SECOND]);
        assert_eq!(
            result.unwrap_err(),
            format!("edge connect: http 200; {} rejected (http 403), {} refused (http 200)", FIRST.name(), SECOND.name())
        );
    }

    #[test]
    fn a_recovered_preferred_route_is_used_again_without_flapping() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let mut used = Vec::new();
        // Refused once at the start, working again from then on.
        let first_refused_once = Cell::new(true);
        let outcome = |r: Route| if r == FIRST && first_refused_once.replace(false) { Err(Failure::Incompatible) } else { Ok(()) };
        let mut contacted = Vec::new();
        for _ in 0..40 {
            let (tried, result) = attempt_at(&book, &clock, outcome);
            assert!(result.is_ok());
            used.push(*tried.last().unwrap());
            contacted.push(tried);
            clock.advance(60.0);
        }
        // The refusal moves the first attempt to the other route; it is used while the preferred one is skipped
        // (ten minutes), the preferred route's trial then connects, and it is kept from then on: one switch back.
        assert_eq!(contacted[0], vec![FIRST, SECOND]);
        let expected: Vec<Route> = std::iter::repeat(SECOND).take(10).chain(std::iter::repeat(FIRST).take(30)).collect();
        assert_eq!(used, expected);
        assert!(contacted[1..].iter().all(|t| t.len() == 1), "no attempt after the first contacted two routes");
    }

    #[test]
    fn a_preferred_route_that_stays_broken_is_tried_once_per_doubling_cooldown() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let start = clock.now();
        let mut first_tried_at = Vec::new();
        // Three hours of reading with a reconnect every minute; the first route refuses throughout.
        for _ in 0..180 {
            let (tried, result) = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::Incompatible) } else { Ok(()) });
            assert!(result.is_ok());
            if tried.contains(&FIRST) {
                first_tried_at.push(clock.now().duration_since(start).as_secs() / 60);
            }
            clock.advance(60.0);
        }
        // Minutes: 0, then after 10, 20, 40, 60, 60 minutes of being skipped.
        assert_eq!(first_tried_at, vec![0, 10, 30, 70, 130]);
    }

    #[test]
    fn when_every_route_refuses_each_attempt_asks_each_once_and_recovery_is_found_at_once() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let both_refuse = |r: Route| Err(if r == FIRST { Failure::Incompatible } else { Failure::Rejected });
        let (tried, result) = attempt_at(&book, &clock, both_refuse);
        assert_eq!(tried, vec![FIRST, SECOND]);
        // The status is the last route's, in the form `isPermanentFailure` reads.
        assert_eq!(
            result.unwrap_err(),
            format!("edge connect: http 403; {} refused (http 200), {} rejected (http 403)", FIRST.name(), SECOND.name())
        );
        // Two hours of attempts every 30 s: never more than one handshake per route, and every cooldown capped.
        for _ in 0..240 {
            clock.advance(30.0);
            let (tried, _) = attempt_at(&book, &clock, both_refuse);
            assert_eq!(tried, vec![FIRST, SECOND]);
            for r in ROUTES {
                let until = lock_recover(&book).routes[r.index()].cooling_until.unwrap();
                assert!(until.duration_since(clock.now()) <= MAX_COOLDOWN);
            }
        }
        // The second route comes back: the very next attempt finds it.
        clock.advance(30.0);
        let (tried, result) = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::Incompatible) } else { Ok(()) });
        assert_eq!((tried, result), (vec![FIRST, SECOND], Ok(())));
    }

    #[test]
    fn a_failed_trial_moves_on_and_skips_the_route_again_but_a_rate_limit_does_neither() {
        for (trial, penalized) in [(Failure::Network, true), (Failure::ServerError, true), (Failure::RateLimited, false)] {
            let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
            let _ = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::Incompatible) } else { Ok(()) });
            lock_recover(&book).expire(FIRST);
            let (tried, _) = attempt_at(&book, &clock, |r| if r == FIRST { Err(trial) } else { Ok(()) });
            assert_eq!(tried.len() == 2, penalized, "{trial:?}: {tried:?}");
            let plan = lock_recover(&book).plan(clock.now());
            assert_eq!(plan, if penalized { vec![SECOND] } else { vec![FIRST, SECOND] }, "{trial:?}");
        }
    }

    // ---- the rate-limit fallback of an attempt the listener is waiting on ----

    /// The recorded shape of a round answered 429: the sentence's first try (not waited on), then the round's
    /// two recovery tries (waited on).
    fn round(book: &Mutex<RouteBook>, clock: &Clock, outcome: impl Fn(Route) -> Outcome + Copy) -> Vec<(Vec<Route>, Result<(), String>)> {
        let mut out = vec![attempt_at(book, clock, outcome)];
        for gap in [0.25, 0.75] {
            clock.advance(gap + 0.6);
            out.push(waited_at(book, clock, outcome));
        }
        out
    }

    #[test]
    fn a_429_burst_that_ends_on_the_preferred_route_never_contacts_the_other() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let n = Cell::new(0);
        // The recorded 2026-10-24 opening: two 429s, then the route answers again.
        let outcome = |r: Route| {
            assert_eq!(r, FIRST, "the other route was contacted");
            n.set(n.get() + 1);
            if n.get() <= 2 { Err(Failure::RateLimited) } else { Ok(()) }
        };
        let tries = round(&book, &clock, outcome);
        assert_eq!(tries.iter().map(|t| t.0.clone()).collect::<Vec<_>>(), vec![vec![FIRST]; 3]);
        assert!(tries[2].1.is_ok());
        assert_eq!(lock_recover(&book).routes[FIRST.index()].rate_limited, 0, "a connection ends the run");
    }

    #[test]
    fn a_round_answered_429_tries_the_other_route_on_its_final_attempt_only() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let tries = round(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) });
        assert_eq!(tries[0].0, vec![FIRST], "the sentence's first try is not waited on");
        assert_eq!(tries[1].0, vec![FIRST], "two 429s are not yet a run");
        assert_eq!(tries[2], (vec![FIRST, SECOND], Ok(())), "the third, waited on, tries the other route once");
        // The preferred route is not penalized: still first, never skipped, no strike.
        assert_eq!(lock_recover(&book).plan(clock.now()), vec![FIRST, SECOND]);
        assert_eq!(lock_recover(&book).routes[FIRST.index()].strikes, 0);
        clock.advance(2.0);
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
    }

    #[test]
    fn a_background_attempt_never_falls_back_on_a_rate_limit() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        for _ in 0..6 {
            assert_eq!(attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) }).0, vec![FIRST]);
            clock.advance(1.0);
        }
    }

    #[test]
    fn when_both_routes_answer_429_the_extra_request_is_one_a_minute_at_most() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let both_limited = |_: Route| Err(Failure::RateLimited);
        let tries = round(&book, &clock, both_limited);
        assert_eq!(tries[2].0, vec![FIRST, SECOND]);
        assert_eq!(
            tries[2].1.clone().unwrap_err(),
            format!("edge connect: http 429; {} rate-limited (http 429), {} rate-limited (http 429)", FIRST.name(), SECOND.name())
        );
        // Ten minutes of rounds every 15 s while the limit is shared: at most one handshake more a minute than
        // the rounds make anyway, and never two handshakes to one route in an attempt.
        let start = clock.now();
        let mut extra = 0;
        while clock.now() < start + Duration::from_secs(600) {
            clock.advance(15.0);
            for (tried, result) in round(&book, &clock, both_limited) {
                assert!(result.is_err());
                assert!(!tried.is_empty() && tried.len() <= 2 && (tried.len() == 1 || tried[0] != tried[1]), "{tried:?}");
                extra += tried.len() - 1;
            }
        }
        assert!(extra <= 11, "{extra} extra handshakes in ten minutes");
        // A rate limit alone never penalized either route beyond the base cooldown.
        for r in ROUTES {
            let s = lock_recover(&book).routes[r.index()];
            assert_eq!(s.strikes, 0);
            assert!(s.cooling_until.map_or(true, |t| t.saturating_duration_since(clock.now()) <= TRANSIENT_COOLDOWN));
        }
    }

    #[test]
    fn mixed_rate_limits_timeouts_and_refusals() {
        // A timeout between 429s ends their run: no fallback on the next waited-on 429.
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let _ = attempt_at(&book, &clock, |_| Err(Failure::RateLimited));
        timed_out(&book, FIRST);
        let _ = waited_at(&book, &clock, |_| Err(Failure::RateLimited));
        assert_eq!(waited_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) }).0, vec![FIRST]);
        // A refusal after 429s moves on at once, whether or not the attempt is waited on, and skips the route.
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let _ = attempt_at(&book, &clock, |_| Err(Failure::RateLimited));
        let _ = attempt_at(&book, &clock, |_| Err(Failure::RateLimited));
        assert_eq!(attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::Incompatible) } else { Ok(()) }), (vec![FIRST, SECOND], Ok(())));
        assert_eq!(lock_recover(&book).plan(clock.now()), vec![SECOND]);
        // The other route timed out a moment ago: the fallback waits out FALLBACK_HOLD.
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        lock_recover(&book).failed(SECOND, Failure::TimedOut, clock.now());
        for _ in 0..2 {
            let _ = attempt_at(&book, &clock, |_| Err(Failure::RateLimited));
        }
        assert_eq!(waited_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) }).0, vec![FIRST]);
        clock.advance(60.0);
        assert_eq!(waited_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) }), (vec![FIRST, SECOND], Ok(())));
    }

    #[test]
    fn a_rate_limit_alone_never_keeps_the_preferred_route_away_for_long() {
        // Ten minutes of background retries, every one answered 429 by the preferred route.
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let start = clock.now();
        let mut first_contacts = Vec::new();
        let mut n = 0;
        while clock.now() < start + Duration::from_secs(600) {
            let (tried, _) = attempt_at(&book, &clock, |r| if r == FIRST { Err(Failure::RateLimited) } else { Ok(()) });
            if tried[0] == FIRST {
                first_contacts.push(clock.now().duration_since(start).as_secs_f64());
            }
            clock.advance(backoff(n.min(4)));
            n += 1;
        }
        // Sustained 429s may skip it for the base two minutes, never more, and it is first again right after.
        let longest_gap = first_contacts.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
        assert!(longest_gap <= 120.0 + 30.0, "the preferred route was kept away {longest_gap} s");
        assert_eq!(lock_recover(&book).routes[FIRST.index()].strikes, 0);
    }

    #[test]
    fn a_handshake_the_caller_gave_up_on_is_its_to_record_and_ends_the_attempt() {
        let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
        let attempt = Attempt::default();
        let mut tried = Vec::new();
        let mut ended = Vec::new();
        let result: Result<(), String> = connect_via(&book, &attempt, || clock.now(), false, |route| {
            tried.push(route);
            ended = attempt.end(); // the caller's budget runs out while this handshake is running
            Err(error_for(Failure::Incompatible))
        });
        assert!(result.is_err());
        assert_eq!(tried, vec![FIRST], "no further route once the caller has gone");
        assert_eq!(ended, vec![FIRST], "the caller learns which handshake it abandoned");
        assert_eq!(lock_recover(&book).plan(clock.now()), vec![FIRST, SECOND], "the worker recorded nothing");
        // A later attempt object is unaffected.
        assert_eq!(attempt_at(&book, &clock, |_| Ok(())), (vec![FIRST], Ok(())));
    }

    #[test]
    fn an_attempt_never_makes_more_than_one_handshake_per_route() {
        let classes = [None, Some(Failure::Incompatible), Some(Failure::Rejected), Some(Failure::RateLimited), Some(Failure::ServerError), Some(Failure::Network)];
        for &first in &classes {
            for &second in &classes {
                let (book, clock) = (Mutex::new(RouteBook::default()), Clock::new());
                for n in 0..40 {
                    let (tried, result) = attempt_at(&book, &clock, |r| match if r == FIRST { first } else { second } {
                        None => Ok(()),
                        Some(f) => Err(f),
                    });
                    assert!(!tried.is_empty() && tried.len() <= ROUTES.len(), "{tried:?}");
                    assert!(tried.len() == 1 || tried[0] != tried[1], "{tried:?}");
                    // One connection at most comes out of an attempt, and only from the last route it tried.
                    if result.is_ok() {
                        let last = *tried.last().unwrap();
                        assert_eq!(if last == FIRST { first } else { second }, None);
                    }
                    clock.advance(backoff(n.min(4)));
                }
            }
        }
    }
}

/// The hedged attempt on real threads: scripted handshakes whose order of completion each case controls. The
/// connection a scripted handshake hands back counts itself, so a case can tell the one connection returned from
/// the ones dropped unused — and that none is left behind.
#[cfg(test)]
mod hedged {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    const FIRST: Route = ROUTES[0];
    const SECOND: Route = ROUTES[1];
    const HEDGE: Duration = Duration::from_millis(120);

    struct Conn {
        route: Route,
        live: Arc<AtomicUsize>,
    }
    impl Drop for Conn {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// What one route does in a case: answer after `after` (or once `gate` opens), connecting or failing.
    #[derive(Clone)]
    struct Script {
        after: Duration,
        failure: Option<Failure>,
        gate: Option<Arc<Barrier>>,
    }
    fn ok(ms: u64) -> Script {
        Script { after: Duration::from_millis(ms), failure: None, gate: None }
    }
    fn fail(ms: u64, failure: Failure) -> Script {
        Script { after: Duration::from_millis(ms), failure: Some(failure), gate: None }
    }
    fn error(failure: Failure) -> AttemptError {
        let (status, detail) = match failure {
            Failure::Incompatible => (Some(200), "http 200"),
            Failure::Rejected => (Some(403), "http 403"),
            Failure::RateLimited => (Some(429), "http 429"),
            Failure::ServerError => (Some(503), "http 503"),
            Failure::Network => (None, "io TimedOut os 10060"),
            Failure::TimedOut => (None, "timed out"),
        };
        AttemptError { failure, status, detail: detail.into() }
    }

    struct Run {
        result: Result<Route, String>,
        took: Duration,
        contacted: Arc<Mutex<Vec<Route>>>,
        live: Arc<AtomicUsize>,
    }
    impl Run {
        fn contacted(&self) -> Vec<Route> {
            lock_recover(&self.contacted).clone()
        }
    }

    fn try_route_for(first: Script, second: Script, contacted: Arc<Mutex<Vec<Route>>>, live: Arc<AtomicUsize>) -> Arc<dyn Fn(Route) -> Result<Conn, AttemptError> + Send + Sync> {
        Arc::new(move |route| {
            lock_recover(&contacted).push(route);
            let s = if route == FIRST { first.clone() } else { second.clone() };
            match &s.gate {
                Some(gate) => {
                    gate.wait();
                }
                None => std::thread::sleep(s.after),
            }
            match s.failure {
                None => {
                    live.fetch_add(1, Ordering::SeqCst);
                    Ok(Conn { route, live: live.clone() })
                }
                Some(f) => Err(error(f)),
            }
        })
    }

    fn run_with(book: &Arc<Mutex<RouteBook>>, attempt: &Arc<Attempt>, waited_on: bool, hedge: Duration, first: Script, second: Script) -> Run {
        let (contacted, live) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)));
        let try_route = try_route_for(first, second, contacted.clone(), live.clone());
        let t = Instant::now();
        // The connection returned is read and dropped at once; only connections dropped unused remain to count.
        let result = connect_hedged_via(book, attempt, waited_on, hedge, try_route).map(|conn| conn.route);
        Run { result, took: t.elapsed(), contacted, live }
    }

    fn run(book: &Arc<Mutex<RouteBook>>, waited_on: bool, first: Script, second: Script) -> Run {
        run_with(book, &Arc::new(Attempt::default()), waited_on, HEDGE, first, second)
    }

    fn fresh_book() -> Arc<Mutex<RouteBook>> {
        Arc::new(Mutex::new(RouteBook::default()))
    }

    /// Let every scripted handshake still running finish.
    fn settle(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    #[test]
    fn a_first_route_that_answers_in_time_is_the_only_one_ever_contacted() {
        let book = fresh_book();
        let r = run(&book, false, ok(10), ok(10));
        assert_eq!(r.result, Ok(FIRST));
        settle(300);
        assert_eq!(r.contacted(), vec![FIRST], "the second route is never contacted where the first answers in time");
        assert_eq!(r.live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_slow_first_route_brings_in_the_second_and_the_first_to_connect_wins() {
        let book = fresh_book();
        lock_recover(&book).failed(FIRST, Failure::Network, Instant::now());
        let r = run(&book, false, ok(700), ok(20));
        assert_eq!(r.result, Ok(SECOND));
        assert!(r.took >= HEDGE && r.took < HEDGE + Duration::from_millis(250), "the second route began at the hedge: {:?}", r.took);
        assert_eq!(r.contacted(), vec![FIRST, SECOND]);
        settle(900);
        assert_eq!(r.live.load(Ordering::SeqCst), 0, "the first route's late connection was dropped, not left open");
        let b = lock_recover(&book);
        assert_eq!(b.routes[FIRST.index()].transient, 1, "a late success that lost the attempt does not clear its route's record");
        assert_eq!(b.routes[SECOND.index()].last_failure, None);
    }

    #[test]
    fn the_first_route_still_wins_when_it_connects_before_the_second() {
        let book = fresh_book();
        let r = run(&book, false, ok(170), ok(400));
        assert_eq!(r.result, Ok(FIRST));
        assert_eq!(r.contacted(), vec![FIRST, SECOND]);
        settle(600);
        assert_eq!(r.live.load(Ordering::SeqCst), 0, "the second route's connection was dropped unused");
        assert_eq!(lock_recover(&book).routes[SECOND.index()].last_failure, None, "the losing route recorded nothing");
    }

    #[test]
    fn the_second_route_is_not_started_before_the_hedge_delay() {
        // The first route answers after two of the attempt's polls but before the hedge delay: the attempt woke
        // twice and must not have taken either wake-up for the hedge.
        let book = fresh_book();
        let r = run_with(&book, &Arc::new(Attempt::default()), false, Duration::from_millis(300), ok(250), ok(10));
        assert_eq!(r.result, Ok(FIRST));
        settle(400);
        assert_eq!(r.contacted(), vec![FIRST]);
    }

    #[test]
    fn a_route_that_fails_after_the_attempt_was_won_records_nothing() {
        let book = fresh_book();
        let r = run(&book, false, ok(200), fail(150, Failure::ServerError)); // the second fails at ~270 ms
        assert_eq!(r.result, Ok(FIRST));
        settle(300);
        assert_eq!(r.contacted(), vec![FIRST, SECOND]);
        assert_eq!(lock_recover(&book).routes[SECOND.index()].last_failure, None, "a failure after the attempt was won says nothing");
    }

    #[test]
    fn a_first_route_failing_after_the_second_began_leaves_the_attempt_to_the_second() {
        let book = fresh_book();
        let r = run(&book, false, fail(300, Failure::RateLimited), ok(250));
        assert_eq!(r.result, Ok(SECOND));
        let b = lock_recover(&book);
        assert_eq!(b.routes[FIRST.index()].rate_limited, 1, "a failure while the attempt was still open counts against its route");
    }

    #[test]
    fn both_routes_failing_are_reported_in_the_order_they_answered() {
        let book = fresh_book();
        let r = run(&book, false, fail(400, Failure::ServerError), fail(40, Failure::RateLimited));
        assert_eq!(
            r.result,
            Err(format!("edge connect: http 503; {} rate-limited (http 429), {} server-error (http 503)", SECOND.name(), FIRST.name())),
            "the status is the last answer's, as it was for a single route"
        );
    }

    #[test]
    fn two_connections_at_the_same_moment_still_give_one_winner() {
        for _ in 0..300 {
            let book = fresh_book();
            {
                let mut b = lock_recover(&book);
                let now = Instant::now();
                b.failed(FIRST, Failure::Network, now);
                b.failed(SECOND, Failure::Network, now);
            }
            let gate = Arc::new(Barrier::new(2));
            let both = Script { after: Duration::ZERO, failure: None, gate: Some(gate) };
            let r = run_with(&book, &Arc::new(Attempt::default()), false, Duration::ZERO, both.clone(), both);
            let winner = r.result.clone().expect("one of the two connected");
            settle(5);
            assert_eq!(r.live.load(Ordering::SeqCst), 0, "the other connection was dropped");
            let b = lock_recover(&book);
            let cleared: Vec<Route> = ROUTES.into_iter().filter(|r| b.routes[r.index()].transient == 0).collect();
            assert_eq!(cleared, vec![winner], "exactly the winner's record was cleared");
        }
    }

    #[test]
    fn a_refusal_before_the_hedge_moves_on_at_once_as_before() {
        let book = fresh_book();
        let r = run(&book, false, fail(10, Failure::Incompatible), ok(10));
        assert_eq!(r.result, Ok(SECOND));
        assert!(r.took < HEDGE, "a refusal moves on immediately, not at the hedge: {:?}", r.took);
    }

    #[test]
    fn a_rate_limit_before_the_hedge_still_ends_a_background_attempt() {
        let book = fresh_book();
        let r = run(&book, false, fail(10, Failure::RateLimited), ok(10));
        assert_eq!(r.result, Err(format!("edge connect: http 429; {} rate-limited (http 429)", FIRST.name())));
        settle(300);
        assert_eq!(r.contacted(), vec![FIRST], "a 429 never presses another route, and the hedge did not fire after the attempt ended");
    }

    #[test]
    fn a_waited_on_attempt_after_three_rate_limits_still_moves_on_at_once() {
        let book = fresh_book();
        for _ in 0..2 {
            lock_recover(&book).failed(FIRST, Failure::RateLimited, Instant::now());
        }
        let r = run(&book, true, fail(10, Failure::RateLimited), ok(10));
        assert_eq!(r.result, Ok(SECOND));
        assert!(r.took < HEDGE, "{:?}", r.took);
    }

    #[test]
    fn a_plan_of_one_route_is_never_hedged() {
        let book = fresh_book();
        lock_recover(&book).failed(SECOND, Failure::Incompatible, Instant::now()); // cooling: the plan is [FIRST]
        let r = run(&book, false, ok(300), ok(10));
        assert_eq!(r.result, Ok(FIRST));
        assert_eq!(r.contacted(), vec![FIRST]);
    }

    #[test]
    fn an_attempt_whose_caller_gave_up_ends_soon_and_records_nothing() {
        let book = fresh_book();
        let attempt = Arc::new(Attempt::default());
        let a = attempt.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let _ = a.end();
        });
        let r = run_with(&book, &attempt, false, HEDGE, ok(700), ok(700));
        assert!(r.result.is_err());
        assert!(r.took < Duration::from_millis(200) + ATTEMPT_POLL + Duration::from_millis(100), "{:?}", r.took);
        settle(900);
        assert_eq!(r.live.load(Ordering::SeqCst), 0, "both late connections were dropped");
        let b = lock_recover(&book);
        for route in ROUTES {
            assert_eq!((b.routes[route.index()].transient, b.routes[route.index()].last_failure), (0, None), "{route:?}: nothing recorded by the attempt itself");
        }
    }

    /// Where every handshake answers before the hedge, the hedged attempt is the sequential one: the same routes
    /// contacted, the same result and the same record, for every pair of answers and either kind of caller.
    #[test]
    fn with_answers_before_the_hedge_it_is_exactly_the_sequential_attempt() {
        let answers = [None, Some(Failure::Incompatible), Some(Failure::Rejected), Some(Failure::RateLimited), Some(Failure::ServerError), Some(Failure::Network)];
        for waited_on in [false, true] {
            for primed_429s in [0, 2] {
                for first in answers {
                    for second in answers {
                        let prime = |b: &Mutex<RouteBook>| {
                            for _ in 0..primed_429s {
                                lock_recover(b).failed(FIRST, Failure::RateLimited, Instant::now());
                            }
                        };
                        let sequential = Mutex::new(RouteBook::default());
                        prime(&sequential);
                        let mut seq_tried = Vec::new();
                        let seq = connect_via(&sequential, &Attempt::default(), Instant::now, waited_on, |route| {
                            seq_tried.push(route);
                            match if route == FIRST { first } else { second } {
                                None => Ok(route),
                                Some(f) => Err(error(f)),
                            }
                        });
                        let hedged_book = fresh_book();
                        prime(&hedged_book);
                        let script = |f: Option<Failure>| Script { after: Duration::from_millis(2), failure: f, gate: None };
                        let r = run(&hedged_book, waited_on, script(first), script(second));
                        let case = format!("waited_on {waited_on}, primed {primed_429s}, answers {first:?}/{second:?}");
                        assert_eq!(r.result, seq, "{case}");
                        assert_eq!(r.contacted(), seq_tried, "{case}");
                        let (a, b) = (lock_recover(&sequential), lock_recover(&hedged_book));
                        for route in ROUTES {
                            let (x, y) = (&a.routes[route.index()], &b.routes[route.index()]);
                            assert_eq!((x.strikes, x.transient, x.rate_limited, x.cooling_until.is_some()), (y.strikes, y.transient, y.rate_limited, y.cooling_until.is_some()), "{case}: {route:?}");
                        }
                    }
                }
            }
        }
    }
}

/// Live-service checks of the two routes. They need the network and the real service, so they are `#[ignore]`
/// and run explicitly: `cargo test --locked -- edge_route::live --ignored --test-threads=1 --nocapture`.
/// They print statuses, byte counts and timings only — never a token, the key or a URL.
#[cfg(test)]
mod live {
    use super::*;
    use msedge_tts::tts::stream::SynthesizedResponse;
    use msedge_tts::tts::SpeechConfig;

    fn now_secs() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    fn open(route: Route, unix_secs: u64) -> Result<(Sender<TcpStream>, Receiver<TcpStream>), AttemptError> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        msedge_tts_split_request(request_for(route, unix_secs, &id).unwrap()).map_err(|e| attempt_error(&e))
    }

    /// A connection the case needs, with the live service's TRANSIENT answers absorbed the way the scheduler
    /// absorbs them in the app: a rate limit, a server error or no answer is retried, up to three tries, 3 s
    /// apart; a refusal or a rejection fails at once, because that is what these cases exist to catch.
    fn open_ok(route: Route) -> (Sender<TcpStream>, Receiver<TcpStream>) {
        let mut last = String::new();
        for attempt in 1..=3 {
            match open(route, now_secs()) {
                Ok(client) => {
                    if attempt > 1 {
                        println!("  {}: connected on try {attempt} (service transient: {last})", route.name());
                    }
                    return client;
                }
                Err(e) if e.failure.is_refusal() => panic!("{} refused the request: {}", route.name(), e.detail),
                Err(e) => last = format!("{} ({})", e.failure.name(), e.detail),
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        panic!("{}: three transient answers in a row ({last}) — service unavailable, not a code failure", route.name());
    }

    /// What a route answered within one attempt: `None` when it connected, else the failure and its detail.
    type Answer = (Route, Option<(Failure, String)>);

    /// The routes one attempt contacted, in order.
    fn routes(answers: &[Answer]) -> Vec<Route> {
        answers.iter().map(|(route, _)| *route).collect()
    }

    /// An attempt the case needs to CONNECT, made through `connect_via` with this book, with the live service's
    /// TRANSIENT answers absorbed as `open_ok` absorbs them: an attempt that ends on a rate limit, a server error or
    /// no answer is made again, up to three tries, 3 s apart; one that ends on a refusal or a rejection fails at
    /// once. `before` runs before every try. Returns the client and, for every try, what each route answered —
    /// which the case asserts on and every failure prints.
    fn connect_ok(
        book: &Mutex<RouteBook>,
        unix_secs: impl Fn(Route) -> u64,
        before: impl Fn(),
    ) -> ((Sender<TcpStream>, Receiver<TcpStream>), Vec<Vec<Answer>>) {
        let mut tries: Vec<Vec<Answer>> = Vec::new();
        for attempt in 1..=3 {
            before();
            let mut answers = Vec::new();
            let result = connect_via(book, &Attempt::default(), Instant::now, false, |route| {
                let r = open(route, unix_secs(route));
                answers.push((route, r.as_ref().err().map(|e| (e.failure, e.detail.clone()))));
                r
            });
            let ended_on = answers.last().and_then(|(_, answer)| answer.as_ref().map(|(failure, _)| *failure));
            tries.push(answers);
            match result {
                Ok(client) => {
                    if attempt > 1 {
                        println!("  connected on try {attempt} (service transient before it): {tries:?}");
                    }
                    return (client, tries);
                }
                Err(e) if ended_on.is_some_and(|failure| !failure.is_refusal()) => {
                    println!("  try {attempt} ended on a service transient: {e}");
                }
                Err(e) => panic!("try {attempt} failed: {e}; answers: {tries:?}"),
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        panic!("three transient answers in a row — service unavailable, not a code failure; answers: {tries:?}");
    }

    /// One synthesis on an open client: (audio bytes, word boundaries).
    fn speak(client: (Sender<TcpStream>, Receiver<TcpStream>), voice: &str, text: &str) -> (usize, usize) {
        let (mut tx, mut rx) = client;
        let config = SpeechConfig {
            voice_name: format!("Microsoft Server Speech Text to Speech Voice ({voice})"),
            audio_format: "audio-24khz-48kbitrate-mono-mp3".into(),
            pitch: 0,
            rate: 0,
            volume: 0,
        };
        tx.send(text, &config).unwrap();
        let (mut bytes, mut words) = (0, 0);
        while rx.can_read() {
            match rx.read().unwrap() {
                Some(SynthesizedResponse::AudioBytes(b)) => bytes += b.len(),
                Some(SynthesizedResponse::AudioMetadata(m)) => words += m.iter().filter(|m| m.boundary_type.as_deref() == Some("WordBoundary")).count(),
                None => {}
            }
        }
        (bytes, words)
    }

    fn voice_name(short: &str) -> &str {
        match short {
            "en-AU-WilliamMultilingualNeural" => "en-AU, WilliamMultilingualNeural",
            "ar-EG-SalmaNeural" => "ar-EG, SalmaNeural",
            _ => unreachable!(),
        }
    }

    #[test]
    #[ignore]
    fn live_both_routes_speak_arabic_and_english() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        for route in ROUTES {
            for (voice, text) in [("en-AU-WilliamMultilingualNeural", "This is a short connection test."), ("ar-EG-SalmaNeural", "هذا اختبار قصير للاتصال.")] {
                let t = Instant::now();
                let client = open_ok(route);
                let connected = t.elapsed().as_millis();
                let (bytes, words) = speak(client, voice_name(voice), text);
                println!("{} {voice}: connect {connected} ms, total {} ms, {bytes} audio bytes, {words} words", route.name(), t.elapsed().as_millis());
                assert!(bytes > 5_000 && words > 0, "{} {voice}: {bytes} bytes, {words} words", route.name());
            }
        }
    }

    #[test]
    #[ignore]
    fn live_an_expired_token_is_refused_on_both_routes() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        for route in ROUTES {
            let e = open(route, now_secs() - 3_600).err().unwrap_or_else(|| panic!("{} accepted an hour-old token", route.name()));
            println!("{} with an hour-old token: {:?} ({})", route.name(), e.failure, e.detail);
            assert_eq!(e.failure, Failure::Rejected, "an expired token is a credential rejection");
        }
    }

    /// The fallback against the real service: the first route is made to fail by the service itself (an
    /// expired token), the attempt moves to the second and that connection synthesizes; once the first route's
    /// cooldown has passed, a valid request reaches it again and clears its record. Each step is an attempt made
    /// through `connect_ok`, so a transient answer from the live service (MEASURED 2026-10-24: a 429 on the trial,
    /// in a run right after the other live cases) is retried instead of failing the case.
    #[test]
    #[ignore]
    fn live_fallback_and_recovery() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let book = Mutex::new(RouteBook::default());
        let (client, tries) = connect_ok(&book, |route| if route == ROUTES[0] { now_secs() - 3_600 } else { now_secs() }, || {});
        println!("broken {}: {tries:?}", ROUTES[0].name());
        // The try on which the first route refused moved on to the second within that same attempt. A try before it
        // ended on a transient from the first route alone; a try after it went straight to the second.
        let refused = tries
            .iter()
            .position(|t| matches!(t.first(), Some((route, Some((failure, _)))) if *route == ROUTES[0] && failure.is_refusal()))
            .unwrap_or_else(|| panic!("{} never refused the hour-old token: {tries:?}", ROUTES[0].name()));
        assert_eq!(routes(&tries[refused]), ROUTES.to_vec(), "{tries:?}");
        assert!(tries[..refused].iter().all(|t| routes(t) == vec![ROUTES[0]]), "{tries:?}");
        assert!(tries[refused + 1..].iter().all(|t| routes(t) == vec![ROUTES[1]]), "{tries:?}");
        let (bytes, _) = speak(client, voice_name("ar-EG-SalmaNeural"), "هذا اختبار قصير للاتصال.");
        assert!(bytes > 5_000, "{bytes} audio bytes");

        // The first route is cooling: the next attempt goes straight to the second.
        let (_, tries) = connect_ok(&book, |_| now_secs(), || {});
        assert!(tries.iter().all(|t| routes(t) == vec![ROUTES[1]]), "{tries:?}");

        // The first route's cooldown is over: its trial, with a valid request, connects and clears its record. A
        // transient answer to the trial ends that attempt without contacting the second route; a rate limit leaves
        // the route due for another trial and any other transient cools it again, so the cooldown is ended before
        // every try, as its passing would.
        let (client, tries) = connect_ok(&book, |_| now_secs(), || lock_recover(&book).expire(ROUTES[0]));
        println!("recovered {}: {tries:?}", ROUTES[0].name());
        assert!(tries.iter().all(|t| routes(t) == vec![ROUTES[0]]), "{tries:?}");
        let (bytes, _) = speak(client, voice_name("en-AU-WilliamMultilingualNeural"), "This is a short connection test.");
        assert!(bytes > 5_000, "{bytes} audio bytes");
    }

    /// The 2026-10-23 failure itself, against the real service: the msedge route is sent the request WITHOUT the
    /// browser headers, which that host answers with a plain HTTP 200. The attempt must read it as a refusal and
    /// reach the other route at once, and that connection must speak.
    #[test]
    #[ignore]
    fn live_an_http_200_from_the_first_route_moves_the_attempt_on() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        assert_eq!(ROUTES[0], Route::MsEdge, "the header-less request is refused by msedge, not by bing");
        let book = Mutex::new(RouteBook::default());
        let mut answers = Vec::new();
        let client = connect_via(&book, &Attempt::default(), Instant::now, false, |route| {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let mut request = request_for(route, now_secs(), &id).unwrap();
            if route == Route::MsEdge {
                request.headers_mut().remove(header::ACCEPT_ENCODING);
                request.headers_mut().remove(header::ACCEPT_LANGUAGE);
            }
            let r = msedge_tts_split_request(request).map_err(|e| attempt_error(&e));
            answers.push((route, r.as_ref().err().map(|e| (e.failure, e.detail.clone()))));
            r
        })
        .unwrap_or_else(|e| panic!("no route connected: {e}"));
        println!("answers: {answers:?}");
        assert_eq!(answers[0], (Route::MsEdge, Some((Failure::Incompatible, "http 200".to_string()))));
        assert_eq!(answers[1], (Route::Bing, None));
        let (bytes, words) = speak(client, voice_name("ar-EG-SalmaNeural"), "هذا اختبار قصير للاتصال.");
        assert!(bytes > 5_000 && words > 0);
    }

    /// The production connect, end to end, a few times in a row. A transient answer is retried the way the
    /// scheduler would (3 s apart, three tries); what is asserted is that every connection is eventually made
    /// and that a rate limit never made the attempt contact a second route.
    #[test]
    #[ignore]
    fn live_connect_in_a_row() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let book = Arc::new(Mutex::new(RouteBook::default()));
        for i in 0..3 {
            let mut connected = false;
            for attempt in 1..=3 {
                let t = Instant::now();
                match connect(&book, &Arc::new(Attempt::default()), false) {
                    Ok(_) => {
                        println!("connect {i}: ok in {} ms (try {attempt})", t.elapsed().as_millis());
                        connected = true;
                        break;
                    }
                    Err(e) => {
                        println!("connect {i}: try {attempt} failed in {} ms: {e}", t.elapsed().as_millis());
                        // A second route is contacted only by the slow-handshake rule, never by a 429 itself.
                        assert!(!e.contains("rate-limited") || !e.contains(',') || t.elapsed() >= HEDGE_AFTER, "a rate limit contacted a second route: {e}");
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
            }
            assert!(connected, "connect {i}: three transient failures in a row — service unavailable, not a code failure");
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}
