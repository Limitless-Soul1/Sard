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
//! a fixed order (`ROUTES`), and a small record of which one has just failed and how — enough to step around a
//! route the service refuses, without hammering it, and to come back to it by itself.
//!
//! THE RULES.
//!
//!   * A route the service ANSWERED without upgrading (any HTTP status except 408, 429 and 5xx) is refused:
//!     this way of connecting is not accepted right now. The next route is tried in the same connection
//!     attempt, and the refused one is skipped for `REFUSED_COOLDOWN`.
//!   * Anything else — a timeout, a rate limit, a server error, or no answer at all (DNS, TCP, TLS) — may be
//!     the moment or the network rather than the route, so ONE such failure changes nothing: it is reported
//!     and the scheduler retries as before. `TRANSIENT_STREAK` of them in a row on the same route skip it for
//!     `TRANSIENT_COOLDOWN`.
//!   * A cooldown orders the routes; it never refuses to connect. When every route is cooling, the one whose
//!     cooldown ends first is tried, alone — so a service that refuses every route costs one handshake per
//!     attempt, as before, and the first route that works again is found by the next attempt.
//!   * A connection on a route clears its record. Nothing is persisted: each launch starts from the order.
//!   * At most one handshake per route per attempt, so an attempt makes at most `ROUTES.len()` of them.
//!
//! WHAT IT CANNOT DO. It cannot keep read-aloud working when the service refuses every route it knows, and a
//! route that upgrades but then fails the synthesis is not counted against it here. A connection attempt that
//! is still running when its caller's budget ends is reported as a timeout by the caller; the route learns its
//! outcome only if the attempt finishes.
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
/// 2026-10-24: a bare `2-` is refused, and any version is accepted.
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

/// How one route's connection attempt failed, as far as choosing a route is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// The service answered without upgrading: this way of connecting is not accepted right now.
    Refused,
    /// A timeout, a rate limit, a server error or no answer: it may be the moment or the network.
    Transient,
}

impl Failure {
    fn name(self) -> &'static str {
        match self {
            Failure::Refused => "refused",
            Failure::Transient => "failed",
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
    let transient = |detail: String| AttemptError { failure: Failure::Transient, status: None, detail };
    let Error::TungsteniteError(e) = e else {
        return transient("error".into());
    };
    match e {
        tungstenite::Error::Http(response) => {
            let status = response.status().as_u16();
            let failure = if status == 408 || status == 429 || status >= 500 { Failure::Transient } else { Failure::Refused };
            AttemptError { failure, status: Some(status), detail: format!("http {status}") }
        }
        // The kind and the OS code, which `isFastReset` in src/lib/tts.ts reads (`ConnectionReset`, 10054).
        tungstenite::Error::Io(io) => transient(match io.raw_os_error() {
            Some(code) => format!("io {:?} os {code}", io.kind()),
            None => format!("io {:?}", io.kind()),
        }),
        tungstenite::Error::Tls(_) => transient("tls".into()),
        tungstenite::Error::Protocol(p) => transient(format!("protocol {p:?}").chars().take(60).collect()),
        _ => transient("websocket".into()),
    }
}

/// A refused route is skipped for this long. The service's method changes are measured in days, so this only
/// bounds how often a refused route is asked again; ten minutes keeps that to a handful of handshakes an hour.
pub(super) const REFUSED_COOLDOWN: Duration = Duration::from_secs(600);
/// This many transient failures in a row on one route, and it is skipped for `TRANSIENT_COOLDOWN`.
pub(super) const TRANSIENT_STREAK: u32 = 2;
pub(super) const TRANSIENT_COOLDOWN: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Default)]
struct RouteState {
    cooling_until: Option<Instant>,
    transient_streak: u32,
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

    /// The routes one connection attempt may try, in order: those not cooling; or, when every route is
    /// cooling, the one whose cooldown ends first, alone.
    pub(super) fn plan(&self, now: Instant) -> Vec<Route> {
        let ready: Vec<Route> = ROUTES.into_iter().filter(|r| !self.cooling(*r, now)).collect();
        if !ready.is_empty() {
            return ready;
        }
        ROUTES.into_iter().min_by_key(|r| self.routes[r.index()].cooling_until).into_iter().collect()
    }

    pub(super) fn succeeded(&mut self, route: Route) {
        self.routes[route.index()] = RouteState::default();
    }

    /// Record a failure; true when it puts the route into cooldown, which is when the attempt moves on.
    pub(super) fn failed(&mut self, route: Route, failure: Failure, now: Instant) -> bool {
        let state = &mut self.routes[route.index()];
        let cooldown = match failure {
            Failure::Refused => REFUSED_COOLDOWN,
            Failure::Transient => {
                state.transient_streak = state.transient_streak.saturating_add(1);
                if state.transient_streak < TRANSIENT_STREAK {
                    return false;
                }
                TRANSIENT_COOLDOWN
            }
        };
        state.cooling_until = Some(now + cooldown);
        true
    }
}

/// One connection attempt across the routes, by the rules at the top of this file. `attempt` makes the
/// connection on one route; the book is never locked while it runs.
pub(super) fn connect_via<C>(book: &Mutex<RouteBook>, mut attempt: impl FnMut(Route) -> Result<C, AttemptError>) -> Result<C, String> {
    let plan = lock_recover(book).plan(Instant::now());
    let mut tried = Vec::with_capacity(plan.len());
    let mut status = None;
    for route in plan {
        let e = match attempt(route) {
            Ok(client) => {
                lock_recover(book).succeeded(route);
                return Ok(client);
            }
            Err(e) => e,
        };
        let moved_on = lock_recover(book).failed(route, e.failure, Instant::now());
        tried.push(format!("{} {} ({})", route.name(), e.failure.name(), e.detail));
        status = e.status;
        if !moved_on {
            break;
        }
    }
    let tried = tried.join(", ");
    Err(match status {
        Some(status) => format!("edge connect: http {status}; {tried}"),
        None => format!("edge connect: {tried}"),
    })
}

/// Open the split synthesis client on the first route that accepts it.
pub(super) fn connect(book: &Mutex<RouteBook>) -> Result<(Sender<TcpStream>, Receiver<TcpStream>), String> {
    connect_via(book, |route| {
        let unix_secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let connection_id = uuid::Uuid::new_v4().simple().to_string();
        let request = request_for(route, unix_secs, &connection_id).map_err(|e| attempt_error(&e.into()))?;
        msedge_tts_split_request(request).map_err(|e| attempt_error(&e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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

    fn answered(status: u16) -> msedge_tts::error::Error {
        let response = tungstenite::http::Response::builder()
            .status(status)
            .header("set-cookie", "MUID=private-value")
            .body(Some(b"<html>body</html>".to_vec()))
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
    fn an_answer_without_an_upgrade_is_a_refusal() {
        // 200 is the 2026-10-23 answer; 403 the 2026-10-10 one.
        for status in [200, 204, 301, 400, 401, 403, 404, 410, 426] {
            let e = attempt_error(&answered(status));
            assert_eq!((e.failure, e.status), (Failure::Refused, Some(status)), "{status}");
        }
    }

    #[test]
    fn a_rate_limit_a_server_error_or_no_answer_is_transient() {
        for status in [408, 429, 500, 502, 503, 504] {
            let e = attempt_error(&answered(status));
            assert_eq!((e.failure, e.status), (Failure::Transient, Some(status)), "{status}");
        }
        let e = attempt_error(&io(std::io::ErrorKind::Other, None));
        assert_eq!((e.failure, e.status), (Failure::Transient, None));
        let e = attempt_error(&msedge_tts::error::Error::UnexpectedMessage("x".into()));
        assert_eq!((e.failure, e.status), (Failure::Transient, None));
    }

    #[test]
    fn the_detail_is_a_status_or_an_error_kind_and_nothing_from_the_response() {
        let e = attempt_error(&answered(403));
        assert_eq!(e.detail, "http 403");
        // A reset keeps the two strings the scheduler's fast-reset rule looks for.
        let e = attempt_error(&io(std::io::ErrorKind::ConnectionReset, Some(10054)));
        assert!(e.detail.contains("ConnectionReset") && e.detail.contains("10054"), "{}", e.detail);
    }

    // ---- choosing a route ----

    fn refused(status: u16) -> AttemptError {
        AttemptError { failure: Failure::Refused, status: Some(status), detail: format!("http {status}") }
    }
    fn transient(status: Option<u16>) -> AttemptError {
        AttemptError { failure: Failure::Transient, status, detail: status.map_or("io TimedOut".into(), |s| format!("http {s}")) }
    }

    const FIRST: Route = ROUTES[0];
    const SECOND: Route = ROUTES[1];

    /// Run one connection attempt with scripted outcomes per route; returns the routes tried and the result.
    fn attempt_with(book: &Mutex<RouteBook>, outcome: impl Fn(Route) -> Result<(), AttemptError>) -> (Vec<Route>, Result<(), String>) {
        let tried = RefCell::new(Vec::new());
        let result = connect_via(book, |route| {
            tried.borrow_mut().push(route);
            outcome(route)
        });
        (tried.into_inner(), result)
    }

    #[test]
    fn a_fresh_book_tries_the_routes_in_order() {
        assert_eq!(ROUTES, [Route::MsEdge, Route::Bing], "the measured order (see `ROUTES`)");
        assert_eq!(RouteBook::default().plan(Instant::now()), vec![FIRST, SECOND]);
        let book = Mutex::new(RouteBook::default());
        let (tried, result) = attempt_with(&book, |_| Ok(()));
        assert_eq!((tried, result), (vec![FIRST], Ok(())));
    }

    #[test]
    fn a_refused_route_falls_back_in_the_same_attempt_and_is_skipped_afterwards() {
        let book = Mutex::new(RouteBook::default());
        let first_refuses = |r: Route| if r == FIRST { Err(refused(200)) } else { Ok(()) };
        let (tried, result) = attempt_with(&book, first_refuses);
        assert_eq!((tried, result), (vec![FIRST, SECOND], Ok(())));
        // The next attempt does not ask the refused route again.
        let (tried, result) = attempt_with(&book, first_refuses);
        assert_eq!((tried, result), (vec![SECOND], Ok(())));
    }

    #[test]
    fn a_refused_route_is_asked_again_once_its_cooldown_ends() {
        let mut book = RouteBook::default();
        let t0 = Instant::now();
        assert!(book.failed(FIRST, Failure::Refused, t0));
        assert_eq!(book.plan(t0 + REFUSED_COOLDOWN - Duration::from_secs(1)), vec![SECOND]);
        assert_eq!(book.plan(t0 + REFUSED_COOLDOWN), vec![FIRST, SECOND]);
    }

    #[test]
    fn one_transient_failure_changes_nothing() {
        let book = Mutex::new(RouteBook::default());
        let (tried, result) = attempt_with(&book, |_| Err(transient(None)));
        assert_eq!(tried, vec![FIRST], "no second handshake for an ambiguous failure");
        assert_eq!(result.unwrap_err(), format!("edge connect: {} failed (io TimedOut)", FIRST.name()));
        assert_eq!(lock_recover(&book).plan(Instant::now()), vec![FIRST, SECOND]);
    }

    #[test]
    fn transient_failures_in_a_row_move_to_the_next_route() {
        let book = Mutex::new(RouteBook::default());
        let first_times_out = |r: Route| if r == FIRST { Err(transient(None)) } else { Ok(()) };
        let (tried, _) = attempt_with(&book, first_times_out);
        assert_eq!(tried, vec![FIRST]);
        let (tried, result) = attempt_with(&book, first_times_out);
        assert_eq!((tried, result), (vec![FIRST, SECOND], Ok(())));
        let (tried, _) = attempt_with(&book, first_times_out);
        assert_eq!(tried, vec![SECOND], "skipped while it cools");
    }

    #[test]
    fn a_connection_clears_the_streak() {
        let mut book = RouteBook::default();
        let now = Instant::now();
        assert!(!book.failed(FIRST, Failure::Transient, now));
        book.succeeded(FIRST);
        assert!(!book.failed(FIRST, Failure::Transient, now), "the streak restarted");
        assert_eq!(book.plan(now), vec![FIRST, SECOND]);
    }

    #[test]
    fn a_rate_limit_is_not_a_reason_to_try_the_other_route_at_once() {
        let book = Mutex::new(RouteBook::default());
        let (tried, result) = attempt_with(&book, |_| Err(transient(Some(429))));
        assert_eq!(tried, vec![FIRST]);
        assert_eq!(result.unwrap_err(), format!("edge connect: http 429; {} failed (http 429)", FIRST.name()));
    }

    #[test]
    fn when_every_route_refuses_each_attempt_asks_only_one() {
        let book = Mutex::new(RouteBook::default());
        let both_refuse = |r: Route| Err(refused(if r == FIRST { 200 } else { 403 }));
        let (tried, result) = attempt_with(&book, both_refuse);
        assert_eq!(tried, vec![FIRST, SECOND]);
        // The status is the last route's, in the form `isPermanentFailure` reads.
        assert_eq!(
            result.unwrap_err(),
            format!("edge connect: http 403; {} refused (http 200), {} refused (http 403)", FIRST.name(), SECOND.name())
        );
        let (tried, _) = attempt_with(&book, both_refuse);
        assert_eq!(tried, vec![FIRST], "the cooldown that ends first, alone");
        let (tried, _) = attempt_with(&book, both_refuse);
        assert_eq!(tried, vec![SECOND]);
        // The first route that works again is found by the next attempt and clears its record.
        let (tried, result) = attempt_with(&book, |_| Ok(()));
        assert_eq!((tried.len(), result), (1, Ok(())));
    }

    #[test]
    fn an_attempt_never_makes_more_than_one_handshake_per_route() {
        let outcomes = [Ok(()), Err(Failure::Refused), Err(Failure::Transient)];
        for &first in &outcomes {
            for &second in &outcomes {
                let book = Mutex::new(RouteBook::default());
                for _ in 0..6 {
                    let (tried, _) = attempt_with(&book, |r| {
                        let o = if r == FIRST { first } else { second };
                        o.map_err(|f| if f == Failure::Refused { refused(403) } else { transient(Some(503)) })
                    });
                    assert!(!tried.is_empty() && tried.len() <= ROUTES.len(), "{tried:?}");
                    assert!(tried.len() == 1 || tried[0] != tried[1], "{tried:?}");
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
                let client = open(route, now_secs()).unwrap_or_else(|e| panic!("{} refused: {}", route.name(), e.detail));
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
            assert_eq!(e.failure, Failure::Refused);
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
        let client = connect_via(&book, |route| {
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
        connect_via(&book, |route| {
            tried.push(route);
            open(route, now_secs())
        })
        .unwrap();
        assert_eq!(tried, vec![ROUTES[1]]);

        // The first route's cooldown is over (back-dated): a valid request reaches it first and clears its record.
        let past = Instant::now().checked_sub(REFUSED_COOLDOWN + Duration::from_secs(1)).unwrap();
        lock_recover(&book).failed(ROUTES[0], Failure::Refused, past);
        let mut tried = Vec::new();
        let client = connect_via(&book, |route| {
            tried.push(route);
            open(route, now_secs())
        })
        .unwrap();
        println!("recovered {}: tried {tried:?}", ROUTES[0].name());
        assert_eq!(tried, vec![ROUTES[0]]);
        let (bytes, _) = speak(client, voice_name("en-AU-WilliamMultilingualNeural"), "This is a short connection test.");
        assert!(bytes > 5_000);
    }

    /// The production connect, end to end, a few times in a row.
    #[test]
    #[ignore]
    fn live_connect_in_a_row() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let book = Mutex::new(RouteBook::default());
        for i in 0..5 {
            let t = Instant::now();
            let r = connect(&book);
            println!("connect {i}: {} in {} ms", if r.is_ok() { "ok" } else { "FAILED" }, t.elapsed().as_millis());
            if let Err(e) = &r {
                println!("  {e}");
            }
            assert!(r.is_ok());
            std::thread::sleep(Duration::from_millis(800));
        }
    }
}
