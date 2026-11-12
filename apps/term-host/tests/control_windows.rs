//! Windows named pipe control channel: the last reply written before the
//! daemon closes the pipe still reaches the client (`DisconnectNamedPipe`
//! discards unread data unless the pipe is drained first).
//!
//! Self-contained: `client` and `tests/common` are POSIX-only, so this talks
//! to the pipe through `control` directly.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tunelo_term_host::control::{self, read_frame, write_frame, FrameError, Stream, KIND_JSON};
use tunelo_term_host::{start, Config, ExitReason, Logger, CONTROL_FILE, DIR_NAME};

const T: Duration = Duration::from_secs(10);

fn start_daemon(home: &Path) -> tunelo_term_host::Daemon {
    let mut cfg = Config::new(home);
    cfg.logger = Logger::new(|_| {});
    cfg.stun_servers = Vec::new();
    start(cfg).expect("daemon start")
}

/// Token and pipe path from `control.json`.
fn control_info(home: &Path) -> (String, PathBuf) {
    let raw = std::fs::read(home.join(DIR_NAME).join(CONTROL_FILE)).expect("control.json");
    let v: Value = serde_json::from_slice(&raw).expect("control.json is JSON");
    let token = v["token"].as_str().expect("token").to_string();
    let pipe = v["pipe"].as_str().expect("pipe").into();
    (token, pipe)
}

fn connect(pipe: &Path) -> Stream {
    let s = control::connect(pipe).expect("connect to the pipe");
    s.set_read_timeout(Some(T));
    s
}

fn send(s: &mut Stream, v: &Value) {
    let body = serde_json::to_vec(v).expect("serialize");
    write_frame(s, KIND_JSON, &body).expect("send frame");
}

/// The next reply (a message with an `id`); unsolicited events are skipped.
fn recv(s: &mut Stream) -> Value {
    loop {
        let v: Value = match read_frame(s) {
            Ok(Some((KIND_JSON, body))) => serde_json::from_slice(&body).expect("reply is JSON"),
            other => panic!("expected a JSON reply, got {other:?}"),
        };
        if v.get("id").is_some() {
            return v;
        }
    }
}

/// After the last reply the daemon closes the pipe: the next read is EOF or
/// a disconnected-pipe error, never another frame or a timeout.
fn assert_closed(s: &mut Stream) {
    match read_frame(s) {
        Ok(None) => {}
        Err(FrameError::Io(e)) => {
            assert_ne!(e.kind(), std::io::ErrorKind::TimedOut, "pipe left open")
        }
        other => panic!("expected the pipe to close, got {other:?}"),
    }
}

#[test]
fn rejected_hello_reply_reaches_the_client() {
    let dir = tempfile::tempdir().expect("tempdir");
    let daemon = start_daemon(dir.path());
    let (_, pipe) = control_info(dir.path());

    let mut c = connect(&pipe);
    send(
        &mut c,
        &json!({ "id": 1, "cmd": "hello", "major": 1, "minor": 0, "token": "not-the-token" }),
    );
    let reply = recv(&mut c);
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"]["code"], "unauthorized");
    assert_closed(&mut c);

    daemon.stopper().stop();
    daemon.wait();
}

#[test]
fn shutdown_reply_reaches_the_client() {
    let dir = tempfile::tempdir().expect("tempdir");
    let daemon = start_daemon(dir.path());
    let (token, pipe) = control_info(dir.path());

    let mut c = connect(&pipe);
    send(
        &mut c,
        &json!({ "id": 1, "cmd": "hello", "major": 1, "minor": 0, "token": token,
                 "agentVersion": "windows-test" }),
    );
    assert_eq!(recv(&mut c)["ok"], true, "hello accepted");
    send(&mut c, &json!({ "id": 2, "cmd": "shutdown" }));
    let reply = recv(&mut c);
    assert_eq!(reply["id"], 2);
    assert_eq!(reply["ok"], true);
    assert_closed(&mut c);
    assert_eq!(daemon.wait(), ExitReason::ShutdownCommand);
}
