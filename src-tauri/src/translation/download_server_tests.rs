//! A minimal HTTP/1.1 file server on 127.0.0.1 for the download tests: ranged responses, redirects, and
//! every misbehaviour a real host or network can produce, injected on demand. No test touches the
//! internet.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub(crate) struct Faults {
    /// Close the connection once the body has passed this absolute offset (once).
    pub drop_after_once: Option<u64>,
    /// Stop sending once the body has passed this absolute offset and hold the connection open
    /// longer than the client's timeout (once).
    pub stall_once_at: Option<u64>,
    /// Answer every ranged request with 200 and the whole file.
    pub ignore_range: bool,
    /// Answer with a Content-Range one byte off.
    pub wrong_range: bool,
    /// Send one byte more than the range — a wrong one.
    pub extra_byte: bool,
    /// Answer the next N requests with `fail_status`.
    pub fail_next: u32,
    pub fail_status: u16,
    /// Raise this flag once the body has passed the offset — a user pressing Cancel mid-download.
    pub cancel_when_past: Option<(u64, Arc<AtomicBool>)>,
}

#[derive(Default, Debug)]
pub(crate) struct Stats {
    pub requests: u32,
    pub body_bytes: u64,
}

pub(crate) struct TestServer {
    pub port: u16,
    pub faults: Arc<Mutex<Faults>>,
    pub stats: Arc<Mutex<Stats>>,
}

impl TestServer {
    pub fn start(data: Vec<u8>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let faults = Arc::new(Mutex::new(Faults::default()));
        let stats = Arc::new(Mutex::new(Stats::default()));
        let data = Arc::new(data);
        let (f, s) = (faults.clone(), stats.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let (f, s, d) = (f.clone(), s.clone(), data.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, port, &d, &f, &s);
                });
            }
        });
        TestServer { port, faults, stats }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn serve(mut conn: TcpStream, port: u16, data: &[u8], faults: &Mutex<Faults>, stats: &Mutex<Stats>) -> std::io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut req = Vec::new();
    let mut byte = [0u8; 1];
    while !req.ends_with(b"\r\n\r\n") {
        if conn.read(&mut byte)? == 0 {
            return Ok(());
        }
        req.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&req).to_string();
    let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
    let range = text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if !k.eq_ignore_ascii_case("range") {
            return None;
        }
        let (a, b) = v.trim().strip_prefix("bytes=")?.split_once('-')?;
        Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?))
    });
    stats.lock().unwrap().requests += 1;

    match path.as_str() {
        "/redirect" => {
            let loc = format!("http://127.0.0.1:{port}/file");
            return write!(conn, "HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        "/redirect-away" => {
            return write!(conn, "HTTP/1.1 302 Found\r\nLocation: http://evil.example/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        "/file" => {}
        _ => return write!(conn, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    }

    let mut f = faults.lock().unwrap();
    if f.fail_next > 0 {
        f.fail_next -= 1;
        let st = f.fail_status;
        drop(f);
        return write!(conn, "HTTP/1.1 {st} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let total = data.len() as u64;
    let (status, from, to, content_range) = match range {
        Some((a, b)) if !f.ignore_range && a <= b && b < total => {
            let shown = if f.wrong_range { format!("bytes {}-{}/{total}", a + 1, b + 1) } else { format!("bytes {a}-{b}/{total}") };
            (206, a, b, Some(shown))
        }
        _ => (200, 0, total - 1, None),
    };
    let extra = f.extra_byte && status == 206 && to + 1 < total;
    let len = to - from + 1 + u64::from(extra);
    let drop_at = f.drop_after_once.take_if(|o| *o > from && *o <= to);
    let stall_at = f.stall_once_at.take_if(|o| *o > from && *o <= to);
    let cancel = f.cancel_when_past.clone();
    drop(f);

    let mut head = format!("HTTP/1.1 {status} {}\r\nContent-Length: {len}\r\nConnection: close\r\n", if status == 206 { "Partial Content" } else { "OK" });
    if let Some(cr) = content_range {
        head.push_str(&format!("Content-Range: {cr}\r\n"));
    }
    head.push_str("\r\n");
    conn.write_all(head.as_bytes())?;

    // The file's own bytes end here; with `extra`, one WRONG byte follows them, so a client that
    // stored it would no longer hold a correct prefix of the file.
    let end = to + 1;
    let mut pos = from;
    while pos < end {
        let mut next = (pos + 16 * 1024).min(end);
        for limit in [drop_at, stall_at].into_iter().flatten() {
            if limit > pos && limit < next {
                next = limit;
            }
        }
        conn.write_all(&data[pos as usize..next as usize])?;
        stats.lock().unwrap().body_bytes += next - pos;
        pos = next;
        if let Some((at, flag)) = &cancel {
            if pos >= *at {
                flag.store(true, Ordering::Relaxed);
            }
        }
        if Some(pos) == drop_at {
            conn.flush()?;
            return Ok(()); // the connection closes mid-body
        }
        if Some(pos) == stall_at {
            conn.flush()?;
            std::thread::sleep(Duration::from_secs(4));
            return Ok(());
        }
    }
    if extra {
        conn.write_all(&[data[end as usize] ^ 0xff])?;
    }
    conn.flush()
}

/// Deterministic, incompressible-looking test bytes.
pub(crate) fn test_bytes(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 33) as u8
        })
        .collect()
}
