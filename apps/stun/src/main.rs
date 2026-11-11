//! `stun-responder [--listen ADDR]`: serves STUN Binding requests on one UDP
//! address (default `0.0.0.0:3478`, or `STUN_LISTEN`). Logs only to stderr:
//! a start line, and a summary every hour.

use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use stun_responder::{binding_response, parse_binding_request, RateLimiter, MAX_REQUEST_LEN};

const DEFAULT_LISTEN: &str = "0.0.0.0:3478";
const LISTEN_ENV: &str = "STUN_LISTEN";
/// Answers per source address per second.
const PER_SOURCE_LIMIT: u32 = 20;
/// Most source addresses tracked at once (a few MB at worst).
const MAX_SOURCES: usize = 65_536;
const SUMMARY_EVERY: Duration = Duration::from_secs(3600);

#[derive(Default)]
struct Counters {
    answered: u64,
    limited: u64,
    ignored: u64,
    send_errors: u64,
    recv_errors: u64,
}

fn listen_address() -> Result<SocketAddr, String> {
    let mut args = std::env::args().skip(1);
    let mut chosen: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => match args.next() {
                Some(v) => chosen = Some(v),
                None => return Err("--listen needs an address such as 0.0.0.0:3478".into()),
            },
            "--version" => {
                println!("stun-responder {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-h" | "--help" => {
                println!(
                    "usage: stun-responder [--listen ADDR]  (default {DEFAULT_LISTEN}, env {LISTEN_ENV})"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let raw = chosen
        .or_else(|| std::env::var(LISTEN_ENV).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    raw.parse()
        .map_err(|e| format!("invalid listen address {raw:?}: {e}"))
}

fn main() -> ExitCode {
    let addr = match listen_address() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("stun-responder: {e}");
            return ExitCode::from(2);
        }
    };
    let sock = match UdpSocket::bind(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("stun-responder: cannot bind {addr}: {e}");
            return ExitCode::from(1);
        }
    };
    // Wake up regularly so the hourly summary is written on an idle socket.
    if let Err(e) = sock.set_read_timeout(Some(Duration::from_secs(1))) {
        eprintln!("stun-responder: cannot set read timeout: {e}");
        return ExitCode::from(1);
    }
    eprintln!(
        "stun-responder {} listening on udp {addr}, {PER_SOURCE_LIMIT} answers/s per source",
        env!("CARGO_PKG_VERSION")
    );
    serve(&sock)
}

fn serve(sock: &UdpSocket) -> ExitCode {
    let mut limiter = RateLimiter::new(PER_SOURCE_LIMIT, Duration::from_secs(1), MAX_SOURCES);
    let mut c = Counters::default();
    let mut last_summary = Instant::now();
    let mut consecutive_recv_errors = 0u32;
    // One byte more than the largest accepted request, so an oversized
    // datagram is seen as oversized instead of silently truncated to fit.
    let mut buf = [0u8; MAX_REQUEST_LEN + 1];
    loop {
        let now = Instant::now();
        if now.duration_since(last_summary) >= SUMMARY_EVERY {
            eprintln!(
                "summary: answered={} limited={} ignored={} send_errors={} recv_errors={} tracked_sources={}",
                c.answered, c.limited, c.ignored, c.send_errors, c.recv_errors, limiter.tracked()
            );
            c = Counters::default();
            last_summary = now;
        }
        let (n, from) = match sock.recv_from(&mut buf) {
            Ok(r) => {
                consecutive_recv_errors = 0;
                r
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => {
                c.recv_errors += 1;
                consecutive_recv_errors += 1;
                // A persistent receive error would otherwise spin; fail so
                // systemd restarts the service with a fresh socket.
                if consecutive_recv_errors > 1000 {
                    eprintln!("stun-responder: giving up after repeated receive errors: {e}");
                    return ExitCode::from(1);
                }
                continue;
            }
        };
        let Some(txid) = parse_binding_request(&buf[..n]) else {
            c.ignored += 1;
            continue;
        };
        if !limiter.allow(from.ip(), Instant::now()) {
            c.limited += 1;
            continue;
        }
        match sock.send_to(&binding_response(&txid, from), from) {
            Ok(_) => c.answered += 1,
            Err(_) => c.send_errors += 1,
        }
    }
}
