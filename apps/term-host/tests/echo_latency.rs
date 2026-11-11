//! Echo latency through the whole daemon: client -> hub -> PTY -> `cat`
//! (raw) -> hub -> client, over the relay path (control socket) and over
//! the direct path (WebRTC data channel on loopback). Run explicitly:
//! `cargo test --release --test echo_latency -- --ignored --nocapture --test-threads 1`
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{AgentClient, Frame, TermClient};

const SAMPLES: usize = 2000;
const SPACING: Duration = Duration::from_millis(5);

fn open_cat(agent: &AgentClient) -> u32 {
    let r = agent
        .call(
            "open",
            json!({ "cols": 80, "rows": 24, "shell": "/bin/sh", "args": ["-c", "stty raw -echo; exec cat"] }),
        )
        .expect("open");
    r["session"].as_u64().expect("id") as u32
}

fn measure(t: &mut TermClient, s: u32, label: &str) {
    // Wait for stty to take effect.
    std::thread::sleep(Duration::from_millis(500));
    while t.recv_acking(Duration::from_millis(100)).is_some() {}
    let mut lat = Vec::with_capacity(SAMPLES);
    let mut lost = 0;
    for _ in 0..SAMPLES {
        let t0 = Instant::now();
        t.input(s, b"x").expect("input");
        loop {
            match t.recv_acking(Duration::from_secs(2)) {
                Some(Frame::Output { data, .. }) if data.contains(&b'x') => {
                    lat.push(t0.elapsed().as_secs_f64() * 1000.0);
                    break;
                }
                Some(_) => continue,
                None => {
                    lost += 1;
                    break;
                }
            }
        }
        std::thread::sleep(SPACING);
    }
    let n = lat.len();
    let (p50, p95, p99, max) = percentiles(lat);
    eprintln!(
        "{label} echo latency over {n} samples (lost {lost}): p50 {p50:.3} ms, p95 {p95:.3} ms, p99 {p99:.3} ms, max {max:.3} ms"
    );
    assert_eq!(lost, 0);
}

#[test]
#[ignore = "benchmark: run explicitly"]
fn direct_echo_latency() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_cat(&agent);
    let mut t = attach_direct(&agent, 1, 1, s);
    measure(&mut t, s, "direct");
}

#[test]
#[ignore = "benchmark: run explicitly"]
fn relay_echo_latency_baseline() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_cat(&agent);
    let mut t = attach_new(&agent, 1, 1, s);
    measure(&mut t, s, "relay");
}
