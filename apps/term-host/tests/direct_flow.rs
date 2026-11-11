//! Flow control under a flood (`yes`) over the direct path (WebRTC data
//! channel on loopback). Same probe as `flow.rs`: keys are echoed by `cat`
//! in raw mode while a background `yes` floods the same terminal.
#![cfg(unix)]

mod common;

use std::process::Command;
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{Frame, TermClient};
use tunelo_term_host::flow::{READ_CHUNK, WINDOW_START};

fn rss_kb() -> u64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("rss")
}

/// Read without acking for `d`; returns how far past `from` output went.
fn inflight_without_acks(t: &mut TermClient, from: u64, d: Duration) -> u64 {
    let mut end = from;
    let t0 = Instant::now();
    while t0.elapsed() < d {
        if let Some(Frame::Output { offset, data, .. }) = t.recv(Duration::from_millis(50)) {
            end = end.max(offset + data.len() as u64);
        }
    }
    end - from
}

#[test]
fn flood_over_the_data_channel_keeps_keys_prompt_and_the_window_adapts() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let r = agent
        .call(
            "open",
            json!({ "cols": 80, "rows": 24, "shell": "/bin/sh", "args": ["-c", "stty raw -echo; yes & exec cat"] }),
        )
        .expect("open");
    let s = r["session"].as_u64().expect("id") as u32;
    let mut t = attach_direct(&agent, 1, 1, s);
    let rss_before = rss_kb();

    // 1. No acks: at most one window is sent, then the daemon stops.
    let acked = t.applied(s);
    let inflight = inflight_without_acks(&mut t, acked, Duration::from_millis(1500));
    eprintln!("direct: inflight with no acks {inflight} bytes (window {WINDOW_START})");
    assert!(inflight <= WINDOW_START as u64, "beyond the window");
    assert!(
        inflight + READ_CHUNK as u64 >= WINDOW_START as u64,
        "window was used"
    );
    let stall_end = acked + inflight;

    // 2. Ack: output resumes exactly at the next byte.
    t.ack(s, stall_end).expect("ack");
    match t.recv_acking(T) {
        Some(Frame::Output { offset, .. }) => assert_eq!(offset, stall_end),
        other => panic!("expected output after ack, got {other:?}"),
    }

    // 3. Keys typed during the flood come back promptly.
    let mut samples = Vec::new();
    let mut flood_bytes = 0u64;
    let flood_start = Instant::now();
    for i in 0..60u8 {
        let key = b'A' + (i % 26);
        let sent = Instant::now();
        t.input(s, &[key]).expect("key");
        loop {
            assert!(sent.elapsed() < T, "key never echoed");
            match t.recv_acking(T) {
                Some(Frame::Output { data, .. }) => {
                    flood_bytes += data.len() as u64;
                    if data.contains(&key) {
                        samples.push(sent.elapsed().as_secs_f64() * 1000.0);
                        break;
                    }
                }
                Some(Frame::Snapshot { .. }) => panic!("resync: output was dropped"),
                _ => {}
            }
        }
        let until = Instant::now() + Duration::from_millis(50);
        while Instant::now() < until {
            if let Some(Frame::Output { data, .. }) = t.recv_acking(Duration::from_millis(10)) {
                flood_bytes += data.len() as u64;
            }
        }
    }
    let secs = flood_start.elapsed().as_secs_f64();
    let rss_after = rss_kb();
    let (p50, p95, p99, max) = percentiles(samples);
    eprintln!(
        "direct: keystroke echo during flood p50 {p50:.2} ms, p95 {p95:.2} ms, p99 {p99:.2} ms, \
         max {max:.2} ms; flood {:.2} MiB/s; rss {rss_before} -> {rss_after} KiB",
        flood_bytes as f64 / secs / 1048576.0
    );
    let bound = if cfg!(debug_assertions) { 250.0 } else { 100.0 };
    assert!(p95 < bound, "keystroke echo p95 {p95:.1} ms during flood");
    assert!(
        rss_after.saturating_sub(rss_before) < 64 * 1024,
        "memory grew {rss_before} -> {rss_after} KiB"
    );

    // 4. A slow client (applies about 256 KiB/s) builds a queue: the
    // round trip of its acks grows far above the minimum seen in step 3,
    // so the window shrinks.
    let slow_until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < slow_until {
        if let Some(Frame::Output { data, .. }) = t.recv_acking(Duration::from_millis(20)) {
            std::thread::sleep(Duration::from_micros(data.len() as u64 * 4));
        }
    }
    let from = t.acked(s).max(t.applied(s));
    // Ack everything applied so the measurement starts from a clean point.
    t.ack(s, from).expect("ack");
    let inflight = inflight_without_acks(&mut t, from, Duration::from_millis(1500));
    eprintln!("direct: inflight with no acks after the slow phase {inflight} bytes");
    assert!(
        inflight < WINDOW_START as u64,
        "window did not shrink: {inflight}"
    );

    agent.call("close", json!({ "session": s })).expect("close");
    agent
        .wait_event(T, |e| e["event"] == "session_exit" && e["session"] == s)
        .expect("session exits on close");
}
