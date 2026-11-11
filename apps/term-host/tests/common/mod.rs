//! Shared helpers for the integration tests: a real daemon on a temp config
//! dir, reached only through its control socket.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use tempfile::TempDir;
use tunelo_term_host::client::{AgentClient, Frame, TermClient};
use tunelo_term_host::{start, Config, Daemon, Logger};

pub const T: Duration = Duration::from_secs(10);

pub struct TestDaemon {
    pub dir: TempDir,
    daemon: Option<Daemon>,
    pub logs: Arc<Mutex<Vec<String>>>,
}

impl TestDaemon {
    pub fn start() -> TestDaemon {
        TestDaemon::start_with(|_| {})
    }

    pub fn start_with(tweak: impl FnOnce(&mut Config)) -> TestDaemon {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut cfg = Config::new(dir.path());
        let sink = logs.clone();
        cfg.logger = Logger::new(move |l| sink.lock().expect("logs").push(l.to_string()));
        // Direct path over loopback, no STUN traffic leaving the machine.
        cfg.stun_servers = Vec::new();
        cfg.allow_loopback = true;
        tweak(&mut cfg);
        let daemon = start(cfg).expect("daemon start");
        TestDaemon {
            dir,
            daemon: Some(daemon),
            logs,
        }
    }

    pub fn home(&self) -> &std::path::Path {
        self.dir.path()
    }

    pub fn agent(&self) -> (AgentClient, Value) {
        AgentClient::connect(self.home()).expect("agent connect")
    }

    /// Wait for the daemon to exit (after `shutdown` or idle).
    pub fn wait(&mut self) -> Option<tunelo_term_host::ExitReason> {
        self.daemon.take().map(|d| d.wait())
    }

    pub fn log_text(&self) -> String {
        self.logs.lock().expect("logs").join("\n")
    }
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        if let Some(d) = self.daemon.take() {
            d.stopper().stop();
            d.wait();
        }
    }
}

pub fn key(n: u8) -> String {
    URL_SAFE_NO_PAD.encode([n; 32])
}

/// Open a session running `/bin/sh` (predictable prompt, no user rc files).
pub fn open_sh(agent: &AgentClient) -> u32 {
    let r = agent
        .call(
            "open",
            json!({ "cols": 80, "rows": 24, "shell": "/bin/sh" }),
        )
        .expect("open");
    r["session"].as_u64().expect("session id") as u32
}

/// Grant + relay_open + Hello + Attach(0); waits for the first Snapshot.
pub fn attach_new(agent: &AgentClient, conn: u32, device: u8, session: u32) -> TermClient {
    let mut t = agent.open_relay(conn, &key(device)).expect("open relay");
    t.hello().expect("hello");
    t.attach(session, 0).expect("attach");
    match t.recv_acking(T) {
        Some(Frame::Snapshot { .. }) => {}
        other => panic!("expected snapshot, got {other:?}"),
    }
    t
}

pub const LOOPBACK: std::net::IpAddr = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

/// Grant + direct path over loopback + Hello + Attach(0); waits for the
/// first Snapshot. No relay is opened.
pub fn attach_direct(agent: &AgentClient, conn: u32, device: u8, session: u32) -> TermClient {
    let mut t = agent.grant_term(conn, &key(device)).expect("grant");
    t.connect_direct(LOOPBACK, T).expect("direct path");
    t.hello().expect("hello");
    t.attach(session, 0).expect("attach");
    match t.recv_acking(T) {
        Some(Frame::Snapshot { .. }) => {}
        other => panic!("expected snapshot, got {other:?}"),
    }
    t
}

/// Every JSON event of `kind` (`"conn_state"`, `"signal"`) for `conn` seen
/// so far, parsed.
pub fn events_for(agent: &AgentClient, kind: &str, conn: u32) -> Vec<Value> {
    agent
        .transcript()
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["event"] == kind && v["conn"] == conn)
        .collect()
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Type a command and wait for `expect` in the output.
pub fn run(t: &mut TermClient, session: u32, cmd: &str, expect: &str) -> Vec<u8> {
    t.input(session, cmd.as_bytes()).expect("input");
    t.read_until(session, T, |b| contains(b, expect.as_bytes()))
        .unwrap_or_else(|| panic!("no {expect:?} after {cmd:?}"))
}

/// Run `cmd` (which must print `SH=$$`) and return the shell's pid.
pub fn shell_pid(t: &mut TermClient, session: u32, cmd: &str) -> i32 {
    t.input(session, cmd.as_bytes()).expect("input");
    let out = t
        .read_until(session, T, |b| number_after(b, "SH=").is_some())
        .expect("shell pid printed");
    number_after(&out, "SH=").expect("pid")
}

pub fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    f()
}

pub fn alive(pid: i32) -> bool {
    // Signal 0 checks existence; a reaped process is gone.
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

/// Parse `KEY=<digits>` from output.
pub fn number_after(out: &[u8], key: &str) -> Option<i32> {
    let text = String::from_utf8_lossy(out);
    let at = text.rfind(key)? + key.len();
    let digits: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

pub fn percentiles(mut v: Vec<f64>) -> (f64, f64, f64, f64) {
    v.sort_by(|a, b| a.total_cmp(b));
    let p = |q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)];
    (p(0.5), p(0.95), p(0.99), v[v.len() - 1])
}
