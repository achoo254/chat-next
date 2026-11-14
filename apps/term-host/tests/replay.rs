//! Every client sees the exact raw stream the program wrote since the session
//! opened: a fresh attach replays from offset 0 and a client that fell behind
//! the in-memory ring is served from the session's output log on disk.
#![cfg(unix)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{Frame, TermClient};
use tunelo_term_host::session::DEFAULT_RING_BYTES;
use tunelo_term_host::wire::ClientFrame;

/// About 1.9 MB in 30000 coloured rows (more than the ring, far more rows
/// than any history cap), with full redraws that erase the scrollback (ED3)
/// along the way; the end marker never appears in the typed command.
const GEN: &str = "perl -e '$|=0; for my $i (1..30000) { print \"\\e[3\", $i % 8, \"mrow $i\\e[0m \", \"x\" x 40, \"\\n\"; \
                   print \"\\e[2J\\e[3J\\e[H\" if $i % 5000 == 0 } print \"GEN_\",\"DONE\\n\"'\r";

fn output_dir(d: &TestDaemon) -> PathBuf {
    d.home().join("term-host").join("output")
}

fn log_files(d: &TestDaemon) -> Vec<PathBuf> {
    std::fs::read_dir(output_dir(d))
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default()
}

/// Every Output byte of `s` from `from` on, until `stop` holds on them;
/// asserts the offsets are contiguous and no Snapshot interrupts them.
fn collect_from(t: &mut TermClient, s: u32, from: u64, stop: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + T * 3;
    let mut got = Vec::new();
    let mut end = from;
    while !contains(&got, stop) {
        assert!(
            Instant::now() < deadline,
            "no {stop:?} after {} bytes",
            got.len()
        );
        match t.recv_acking(T) {
            Some(Frame::Output {
                session,
                offset,
                data,
            }) if session == s => {
                assert_eq!(offset, end, "contiguous output");
                end += data.len() as u64;
                got.extend_from_slice(&data);
            }
            Some(Frame::Snapshot { .. }) => panic!("resync: bytes were lost"),
            _ => {}
        }
    }
    got
}

#[test]
fn fresh_attach_replays_every_byte_since_the_session_opened() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    // Attached from the very first byte: its bytes are the reference stream.
    let mut first = attach_new(&agent, 1, 1, s);
    first.input(s, GEN.as_bytes()).expect("input");
    let stream = collect_from(&mut first, s, 0, b"GEN_DONE");
    assert!(stream.len() > DEFAULT_RING_BYTES, "{} bytes", stream.len());
    assert!(contains(&stream, b"\x1b[3J"));

    // The log is private and holds the whole stream.
    let files = log_files(&d);
    assert_eq!(files.len(), 1, "{files:?}");
    let meta = std::fs::metadata(&files[0]).expect("log meta");
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    let dir_mode = std::fs::metadata(output_dir(&d)).map(|m| m.permissions().mode() & 0o777);
    assert_eq!(dir_mode.ok(), Some(0o700));

    // A second device opening the terminal later gets a reset at offset 0,
    // then exactly the same bytes, ED3 included.
    let mut late = agent.open_relay(2, &key(2)).expect("relay 2");
    late.hello().expect("hello 2");
    late.attach(s, 0).expect("attach 2");
    match late.recv_acking(T) {
        Some(Frame::Snapshot { offset, vt, .. }) => {
            assert_eq!(offset, 0);
            assert_eq!(vt, b"\x1bc");
        }
        other => panic!("expected snapshot, got {other:?}"),
    }
    let replay = collect_from(&mut late, s, 0, b"GEN_DONE");
    assert!(
        replay.len() >= stream.len() && replay[..stream.len()] == stream[..],
        "replay differs from the stream"
    );

    // Closing the session deletes its log.
    agent.call("close", json!({ "session": s })).expect("close");
    agent
        .wait_event(T, |e| e["event"] == "session_exit" && e["session"] == s)
        .expect("exit event");
    assert!(
        wait_until(T, || log_files(&d).is_empty()),
        "log left behind: {:?}",
        log_files(&d)
    );
}

#[test]
fn client_behind_the_ring_is_replayed_from_the_log() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut watcher = attach_new(&agent, 1, 1, s);
    let mut away = attach_new(&agent, 2, 2, s);
    run(&mut away, s, "echo here_$((3*3))\r", "here_9");
    away.send(&ClientFrame::Detach { session: s })
        .expect("detach");
    // Take what was already on its way (the prompt), then note where it stopped.
    while away.recv_acking(Duration::from_millis(300)).is_some() {}
    let applied = away.applied(s);

    // More than a ring of output while the second client is away.
    watcher.input(s, GEN.as_bytes()).expect("input");
    let stream = collect_from(&mut watcher, s, 0, b"GEN_DONE");
    assert!(stream.len() as u64 > applied + DEFAULT_RING_BYTES as u64);

    // Reattach where it left off: a replay from the log, no snapshot, no gap.
    away.attach(s, applied).expect("reattach");
    let replay = collect_from(&mut away, s, applied, b"GEN_DONE");
    let want = &stream[applied as usize..];
    assert!(
        replay.len() >= want.len() && replay[..want.len()] == *want,
        "replay differs from the stream"
    );
}

#[test]
fn stale_logs_are_wiped_at_start() {
    let dir = tempfile::tempdir().expect("tempdir");
    let stale = dir.path().join("term-host").join("output");
    std::fs::create_dir_all(&stale).expect("mkdir");
    std::fs::write(stale.join("session-1.log"), b"old secret").expect("write");
    let mut cfg = tunelo_term_host::Config::new(dir.path());
    cfg.logger = tunelo_term_host::Logger::new(|_| {});
    let daemon = tunelo_term_host::start(cfg).expect("start");
    assert!(!stale.join("session-1.log").exists());
    daemon.stopper().stop();
    daemon.wait();
    assert!(!stale.exists(), "empty log dir removed on exit");
}
