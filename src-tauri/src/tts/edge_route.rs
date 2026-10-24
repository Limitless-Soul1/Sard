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

use std::net::TcpStream;
use std::sync::Mutex;
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

/// One connection attempt as its caller sees it: the route whose handshake is running, and whether the caller
/// has stopped waiting. A handshake the caller gave up on is the caller's to record; the worker then records
/// nothing and tries no other route.
#[derive(Debug, Default)]
pub(super) struct Attempt(Mutex<AttemptState>);

#[derive(Debug, Default)]
struct AttemptState {
    in_flight: Option<Route>,
    over: bool,
}

impl Attempt {
    /// A handshake on `route` is about to start; false when the caller has already stopped waiting.
    fn begin(&self, route: Route) -> bool {
        let mut state = lock_recover(&self.0);
        if state.over {
            return false;
        }
        state.in_flight = Some(route);
        true
    }

    /// The handshake has returned; false when the caller stopped waiting while it ran.
    fn finish(&self) -> bool {
        let mut state = lock_recover(&self.0);
        state.in_flight = None;
        !state.over
    }

    /// The caller stops waiting. Returns the route whose handshake was still running, if one was.
    pub(super) fn end(&self) -> Option<Route> {
        let mut state = lock_recover(&self.0);
        state.over = true;
        state.in_flight.take()
    }
}

/// The caller stopped waiting for `route`'s handshake because its budget ran out.
pub(super) fn timed_out(book: &Mutex<RouteBook>, route: Route) {
    lock_recover(book).failed(route, Failure::TimedOut, Instant::now());
}

/// One connection attempt across the routes, by the rules at the top of this file. `waited_on` says the listener
/// is waiting on it (a recovery-round call). `try_route` makes the connection on one route; the book is never
/// locked while it runs.
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
        if !attempt.finish() {
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
        let moves_on = {
            let mut book = lock_recover(book);
            let cooling = book.failed(route, e.failure, now());
            if e.failure == Failure::RateLimited {
                // A rate limit's pressure may be shared, so it moves on only in the one case the rules allow.
                waited_on && i == 0 && plan.get(1).is_some_and(|&next| book.rate_limit_fallback(route, next, now()))
            } else {
                // Otherwise only from a route this failure has shown to be the problem.
                cooling
            }
        };
        tried.push(format!("{} {} ({})", route.name(), e.failure.name(), e.detail));
        status = e.status;
        if !moves_on {
            break;
        }
    }
    if tried.is_empty() {
        return Err("edge connect: abandoned".into());
    }
    let tried = tried.join(", ");
    Err(match status {
        Some(status) => format!("edge connect: http {status}; {tried}"),
        None => format!("edge connect: {tried}"),
    })
}

/// Open the split synthesis client on the first route that accepts it.
pub(super) fn connect(book: &Mutex<RouteBook>, attempt: &Attempt, waited_on: bool) -> Result<(Sender<TcpStream>, Receiver<TcpStream>), String> {
    connect_via(book, attempt, Instant::now, waited_on, |route| {
        let unix_secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let connection_id = uuid::Uuid::new_v4().simple().to_string();
        let request = request_for(route, unix_secs, &connection_id).map_err(|e| attempt_error(&e.into()))?;
        msedge_tts_split_request(request).map_err(|e| attempt_error(&e))
    })
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
        let mut ended = None;
        let result: Result<(), String> = connect_via(&book, &attempt, || clock.now(), false, |route| {
            tried.push(route);
            ended = attempt.end(); // the caller's budget runs out while this handshake is running
            Err(error_for(Failure::Incompatible))
        });
        assert!(result.is_err());
        assert_eq!(tried, vec![FIRST], "no further route once the caller has gone");
        assert_eq!(ended, Some(FIRST), "the caller learns which handshake it abandoned");
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
    /// cooldown has passed, a valid request reaches it again and clears its record.
    #[test]
    #[ignore]
    fn live_fallback_and_recovery() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let book = Mutex::new(RouteBook::default());
        let mut tried = Vec::new();
        let client = connect_via(&book, &Attempt::default(), Instant::now, false, |route| {
            tried.push(route);
            open(route, if route == ROUTES[0] { now_secs() - 3_600 } else { now_secs() })
        })
        .unwrap();
        println!("broken {}: tried {tried:?}", ROUTES[0].name());
        assert_eq!(tried, ROUTES.to_vec());
        let (bytes, _) = speak(client, voice_name("ar-EG-SalmaNeural"), "هذا اختبار قصير للاتصال.");
        assert!(bytes > 5_000);

        // The first route is cooling: the next attempt goes straight to the second.
        let mut tried = Vec::new();
        connect_via(&book, &Attempt::default(), Instant::now, false, |route| {
            tried.push(route);
            open(route, now_secs())
        })
        .unwrap();
        assert_eq!(tried, vec![ROUTES[1]]);

        // The first route's cooldown is over: its trial, with a valid request, connects and clears its record.
        lock_recover(&book).expire(ROUTES[0]);
        let mut tried = Vec::new();
        let client = connect_via(&book, &Attempt::default(), Instant::now, false, |route| {
            tried.push(route);
            open(route, now_secs())
        })
        .unwrap();
        println!("recovered {}: tried {tried:?}", ROUTES[0].name());
        assert_eq!(tried, vec![ROUTES[0]]);
        let (bytes, _) = speak(client, voice_name("en-AU-WilliamMultilingualNeural"), "This is a short connection test.");
        assert!(bytes > 5_000);
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
        let book = Mutex::new(RouteBook::default());
        for i in 0..3 {
            let mut connected = false;
            for attempt in 1..=3 {
                let t = Instant::now();
                match connect(&book, &Attempt::default(), false) {
                    Ok(_) => {
                        println!("connect {i}: ok in {} ms (try {attempt})", t.elapsed().as_millis());
                        connected = true;
                        break;
                    }
                    Err(e) => {
                        println!("connect {i}: try {attempt} failed in {} ms: {e}", t.elapsed().as_millis());
                        assert!(!e.contains("rate-limited") || !e.contains(','), "a rate limit contacted a second route: {e}");
                        std::thread::sleep(Duration::from_secs(3));
                    }
                }
            }
            assert!(connected, "connect {i}: three transient failures in a row — service unavailable, not a code failure");
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}
