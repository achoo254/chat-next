//! The direct path: WebRTC data channels between the headless client (a
//! `str0m` offerer) and the real daemon, signaled through the control
//! socket as the agent does, media over loopback UDP.
#![cfg(unix)]

mod common;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{Frame, TermClient};
use tunelo_term_host::nic;
use tunelo_term_host::wire::{error_code, ClientFrame};
use tunelo_term_host::ExitReason;

#[test]
fn direct_echo_resize_snapshot_events_and_no_typed_bytes_leak() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_direct(&agent, 1, 1, s);
    assert!(t.is_direct());

    run(&mut t, s, "echo s3cr3t_$((6*7))\r", "s3cr3t_42");
    t.send(&ClientFrame::Resize {
        session: s,
        cols: 100,
        rows: 30,
    })
    .expect("resize");
    run(&mut t, s, "stty size\r", "30 100");
    let list = agent.call("list", json!({})).expect("list");
    assert_eq!(list[0]["attached"], true);

    // Ping/Pong on the direct path.
    t.send(&ClientFrame::Ping { client_micros: 77 })
        .expect("ping");
    let deadline = Instant::now() + T;
    loop {
        assert!(Instant::now() < deadline, "no pong");
        if let Some(Frame::Pong { client_micros: 77 }) = t.recv_acking(T) {
            break;
        }
    }

    // A second direct client attaching from scratch gets the stream-start
    // Snapshot, then the whole output from offset 0.
    let mut t2 = agent.grant_term(2, &key(2)).expect("grant 2");
    t2.connect_direct(LOOPBACK, T).expect("direct 2");
    t2.hello().expect("hello 2");
    t2.attach(s, 0).expect("attach 2");
    match t2.recv_acking(T) {
        Some(Frame::Snapshot {
            offset,
            cols,
            rows,
            vt,
            ..
        }) => {
            assert_eq!((offset, cols, rows), (0, 100, 30));
            assert_eq!(vt, b"\x1bc");
        }
        other => panic!("expected snapshot, got {other:?}"),
    }
    t2.read_until(s, T, |b| contains(b, b"s3cr3t_42"))
        .expect("replay shows earlier output");

    // Frame errors come back on the direct path too.
    t2.send(&ClientFrame::Attach {
        session: 999,
        last_offset: 0,
    })
    .expect("attach missing");
    loop {
        match t2.recv_acking(T) {
            // The rest of the replay may still be on its way.
            Some(Frame::Output { session, .. }) if session == s => {}
            Some(Frame::Error { code, session, .. }) => {
                assert_eq!((code, session), (error_code::NO_SUCH_SESSION, 999));
                break;
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    let states: Vec<String> = events_for(&agent, "conn_state", 1)
        .iter()
        .map(|e| e["state"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(&states[..2], ["connecting", "direct"], "{states:?}");
    let answers = events_for(&agent, "signal", 1);
    assert!(answers.iter().any(
        |e| e["kind"] == "answer" && e["sdp"].as_str().is_some_and(|s| s.contains("typ host"))
    ));

    // Typed bytes never reach the log or any event.
    let log = d.log_text();
    assert!(log.contains("direct path open"), "{log}");
    assert!(!log.contains("s3cr3t"), "typed text in the log");
    assert!(agent.transcript().iter().all(|l| !l.contains("s3cr3t")));
}

/// Sends `L1`..`L<n>` lines with short pauses, then a marker that does not
/// appear in the typed command.
const GEN: &str = "perl -e '$|=1; for my $i (1..6000) { print \"L$i\\n\"; \
                   select(undef,undef,undef,0.001) if $i % 2 == 0 } print \"GEN_\",\"DONE\\n\"'\r";

/// Read applied output for `dur` (or until `stop` holds), checking that
/// offsets are contiguous.
fn collect(
    t: &mut TermClient,
    s: u32,
    got: &mut Vec<u8>,
    end: &mut u64,
    dur: Duration,
    stop: &dyn Fn(&[u8]) -> bool,
) {
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline && !stop(got) {
        match t.recv_acking(Duration::from_millis(20)) {
            Some(Frame::Output {
                session,
                offset,
                data,
            }) if session == s => {
                assert_eq!(offset, *end, "contiguous applied output");
                *end += data.len() as u64;
                got.extend_from_slice(&data);
            }
            Some(Frame::Snapshot { .. }) => panic!("resync: bytes were lost"),
            _ => {}
        }
    }
}

fn fnv(data: &[u8]) -> u64 {
    data.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[test]
fn path_switch_relay_direct_relay_direct_is_byte_exact() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    // An observer that stays on the relay the whole time.
    let mut obs = attach_new(&agent, 2, 2, s);
    let mut t = attach_new(&agent, 1, 1, s);
    t.set_continuity(true);
    let start_t = t.applied(s);
    let start_obs = obs.applied(s);
    let done = |b: &[u8]| contains(b, b"GEN_DONE");

    t.input(s, GEN.as_bytes()).expect("generator");
    let (mut got, mut end) = (Vec::new(), start_t);
    collect(
        &mut t,
        s,
        &mut got,
        &mut end,
        Duration::from_millis(300),
        &done,
    );
    t.connect_direct(LOOPBACK, T).expect("relay -> direct");
    assert!(t.is_direct());
    collect(
        &mut t,
        s,
        &mut got,
        &mut end,
        Duration::from_millis(400),
        &done,
    );
    t.fall_back_to_relay().expect("direct -> relay");
    assert!(!t.is_direct());
    collect(
        &mut t,
        s,
        &mut got,
        &mut end,
        Duration::from_millis(400),
        &done,
    );
    // Every switch happened while the generator was still writing.
    assert!(!done(&got), "generator ended before the last switch");
    t.connect_direct(LOOPBACK, T)
        .expect("relay -> direct again");
    collect(
        &mut t,
        s,
        &mut got,
        &mut end,
        Duration::from_secs(60),
        &done,
    );
    assert!(done(&got), "generator finished");

    let (mut seen, mut obs_end) = (Vec::new(), start_obs);
    collect(
        &mut obs,
        s,
        &mut seen,
        &mut obs_end,
        Duration::from_secs(60),
        &done,
    );
    assert!(done(&seen));

    // Byte-exact over the common range of both clients.
    let from = start_t.max(start_obs);
    let to = end.min(obs_end);
    assert!(to > from + 40_000, "common range {from}..{to}");
    let a = &got[(from - start_t) as usize..(to - start_t) as usize];
    let b = &seen[(from - start_obs) as usize..(to - start_obs) as usize];
    assert_eq!(a.len(), b.len());
    assert!(a == b, "streams differ");
    eprintln!(
        "path switch: {} bytes, offsets {from}..{to}, hash {:016x} on both clients",
        to - from,
        fnv(a)
    );

    // Every generator line exactly once, in order.
    let text = String::from_utf8_lossy(&got);
    let lines: Vec<u32> = text
        .split("\r\n")
        .filter_map(|l| l.strip_prefix('L').and_then(|n| n.parse().ok()))
        .collect();
    let expected: Vec<u32> = (1..=6000).collect();
    assert_eq!(lines, expected, "no line lost or repeated");

    let states: Vec<String> = events_for(&agent, "conn_state", 1)
        .iter()
        .map(|e| e["state"].as_str().unwrap_or("").to_string())
        .collect();
    let direct = states.iter().filter(|s| *s == "direct").count();
    assert!(direct >= 2, "{states:?}");
    assert!(
        states.iter().filter(|s| *s == "relay").count() >= 2,
        "{states:?}"
    );
}

#[test]
fn session_limit_and_many_sessions_on_one_direct_connection() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let first = open_sh(&agent);
    let mut t = attach_direct(&agent, 1, 1, first);
    let mut ids = vec![first];
    for _ in 1..20 {
        ids.push(open_sh(&agent));
    }
    let r = agent.call(
        "open",
        json!({ "cols": 80, "rows": 24, "shell": "/bin/sh" }),
    );
    assert_eq!(r.map_err(|e| e.code), Err("session_limit".to_string()));

    // A second session on the same direct connection.
    let other = ids[7];
    t.attach(other, 0).expect("attach other");
    loop {
        match t.recv_acking(T) {
            // The first session's own output (its prompt) may come first.
            Some(Frame::Output { session, .. }) if session == first => {}
            Some(Frame::Snapshot { session, .. }) => {
                assert_eq!(session, other);
                break;
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
    }
    run(&mut t, other, "echo second_$((2*2))\r", "second_4");
    run(&mut t, first, "echo first_$((1*1))\r", "first_1");
}

#[test]
fn revoke_and_set_revoked_close_direct_peers_within_a_second() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_direct(&agent, 1, 1, s);
    run(&mut t, s, "echo ok_$((1+1))\r", "ok_2");

    let t0 = Instant::now();
    let r = agent
        .call("revoke_device", json!({ "deviceKey": key(1) }))
        .expect("revoke");
    assert_eq!(r["closed"], 1);
    let mut got_error = false;
    while t0.elapsed() < Duration::from_secs(1) {
        if let Some(Frame::Error { code, .. }) = t.recv(Duration::from_millis(50)) {
            assert_eq!(code, error_code::REVOKED);
            got_error = true;
            break;
        }
    }
    let error_at = t0.elapsed();
    let link = t.direct_link().expect("link");
    assert!(link.wait_closed(Duration::from_secs(1)), "peer still open");
    let closed_at = t0.elapsed();
    eprintln!(
        "revoke_device: Error 6 after {:.2} ms, direct path closed after {:.2} ms",
        error_at.as_secs_f64() * 1000.0,
        closed_at.as_secs_f64() * 1000.0
    );
    assert!(got_error, "no Error 6 on the direct path");
    assert!(closed_at < Duration::from_secs(1));
    assert!(events_for(&agent, "conn_state", 1)
        .iter()
        .any(|e| e["state"] == "closed" && e["reason"] == "revoked"));

    // set_revoked from a reconnecting agent does the same.
    let mut t2 = attach_direct(&agent, 2, 2, s);
    run(&mut t2, s, "echo two_$((1+1))\r", "two_2");
    let t0 = Instant::now();
    let r = agent
        .call("set_revoked", json!({ "deviceKeys": [key(2)] }))
        .expect("set_revoked");
    assert_eq!(r["closed"], 1);
    let link = t2.direct_link().expect("link");
    assert!(link.wait_closed(Duration::from_secs(1)), "peer still open");
    eprintln!(
        "set_revoked: direct path closed after {:.2} ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );
    let again = agent.call("grant", json!({ "conn": 3, "deviceKey": key(2) }));
    assert_eq!(again.map_err(|e| e.code), Err("revoked".to_string()));
}

#[test]
fn silent_client_stays_and_vanished_client_is_closed_by_ice() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_direct(&agent, 1, 1, s);
    run(&mut t, s, "echo alive_$((3+3))\r", "alive_6");

    // No application traffic for longer than the ICE consent timeout: ICE
    // keepalives hold the path, the daemon does not drop the client.
    std::thread::sleep(Duration::from_secs(12));
    assert!(events_for(&agent, "conn_state", 1)
        .iter()
        .all(|e| e["state"] != "closed"));
    run(&mut t, s, "echo still_$((3+4))\r", "still_7");
    // The ICE round trip was reported once measured.
    assert!(events_for(&agent, "conn_state", 1)
        .iter()
        .any(|e| e["state"] == "direct" && e["rttMs"].as_f64().is_some_and(|ms| ms >= 0.0)));

    // The client's network vanishes: no close, no more datagrams.
    let t0 = Instant::now();
    t.direct_link().expect("link").vanish();
    let ev = agent
        .wait_event(Duration::from_secs(40), |e| {
            e["event"] == "conn_state" && e["conn"] == 1 && e["state"] == "closed"
        })
        .expect("closed after ICE gave up");
    eprintln!(
        "vanished client reported closed after {:.1} s",
        t0.elapsed().as_secs_f64()
    );
    assert_eq!(ev["reason"], "transport_closed");
    assert!(events_for(&agent, "signal", 1)
        .iter()
        .any(|e| e["kind"] == "end" && e["reason"] == "ice_disconnected"));
    // The session itself is untouched.
    let list = agent.call("list", json!({})).expect("list");
    assert_eq!(list[0]["session"], s);
    assert!(list[0].get("exited").is_none() || list[0]["exited"].is_null());
}

/// Flip the last hex digit of the DTLS fingerprint in an SDP.
fn alter_fingerprint(sdp: String) -> String {
    sdp.lines()
        .map(|l| {
            if l.starts_with("a=fingerprint:") {
                let mut s = l.to_string();
                let last = s.pop().unwrap_or('0');
                s.push(if last == '0' { '1' } else { '0' });
                s
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n"
}

#[test]
fn altered_fingerprint_fails_the_handshake_and_relay_still_works() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = agent.grant_term(1, &key(1)).expect("grant");
    let r = t.offer_direct(LOOPBACK, Duration::from_secs(5), alter_fingerprint);
    assert!(r.is_err(), "handshake must fail");
    let end = agent
        .wait_event(T, |e| {
            e["event"] == "signal" && e["conn"] == 1 && e["kind"] == "end"
        })
        .expect("signal end");
    assert_eq!(end["reason"], "dtls_failed");
    assert!(events_for(&agent, "conn_state", 1)
        .iter()
        .all(|e| e["state"] != "direct"));

    // The grant was not used up: the client falls back to the relay.
    t.open_relay().expect("relay");
    t.hello().expect("hello");
    t.attach(s, 0).expect("attach");
    assert!(matches!(t.recv_acking(T), Some(Frame::Snapshot { .. })));
    run(&mut t, s, "echo relay_$((5+5))\r", "relay_10");
}

#[test]
fn shutdown_closes_direct_peers_and_shells() {
    let mut d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_direct(&agent, 1, 1, s);
    let pid = shell_pid(&mut t, s, "echo SH=$$\r");
    assert!(alive(pid));
    let t0 = Instant::now();
    agent.call("shutdown", json!({})).expect("shutdown");
    assert!(t
        .direct_link()
        .expect("link")
        .wait_closed(Duration::from_secs(2)));
    eprintln!(
        "shutdown: reply and direct path closed after {:.1} ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(d.wait(), Some(ExitReason::ShutdownCommand));
    assert!(wait_until(Duration::from_secs(3), || !alive(pid)));
}

/// Minimal STUN Binding responder on a LAN address that reports a mapped
/// port one above the source port, as a port-changing NAT would.
fn stun_responder(ip: IpAddr) -> (SocketAddr, Arc<AtomicBool>, Arc<AtomicUsize>) {
    let sock = UdpSocket::bind(SocketAddr::new(ip, 0)).expect("bind stun");
    sock.set_read_timeout(Some(Duration::from_millis(100)))
        .expect("timeout");
    let addr = sock.local_addr().expect("addr");
    let stop = Arc::new(AtomicBool::new(false));
    let hits = Arc::new(AtomicUsize::new(0));
    let (stop2, hits2) = (stop.clone(), hits.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 1500];
        while !stop2.load(Ordering::Relaxed) {
            let Ok((n, from)) = sock.recv_from(&mut buf) else {
                continue;
            };
            if n < 20 || buf[0..2] != [0, 1] {
                continue;
            }
            hits2.fetch_add(1, Ordering::Relaxed);
            let IpAddr::V4(v4) = from.ip() else { continue };
            let cookie = [0x21u8, 0x12, 0xA4, 0x42];
            let port = from.port().wrapping_add(1) ^ 0x2112;
            let mut m = vec![0x01, 0x01, 0, 12];
            m.extend_from_slice(&cookie);
            m.extend_from_slice(&buf[8..20]);
            m.extend_from_slice(&[0x00, 0x20, 0, 8, 0, 1]);
            m.extend_from_slice(&port.to_be_bytes());
            m.extend(v4.octets().iter().zip(cookie).map(|(a, k)| a ^ k));
            let _ = sock.send_to(&m, from);
        }
    });
    (addr, stop, hits)
}

#[test]
fn stun_mapping_is_trickled_as_a_server_reflexive_candidate() {
    let lan = nic::local_addresses(false)
        .unwrap_or_default()
        .into_iter()
        .find(IpAddr::is_ipv4);
    let Some(lan) = lan else {
        eprintln!("skipped: this machine has no non-loopback IPv4 address");
        return;
    };
    let (server, stop, hits) = stun_responder(lan);
    let d = TestDaemon::start_with(|c| c.stun_servers = vec![server.to_string()]);
    let (agent, _) = d.agent();
    let t = agent.grant_term(1, &key(1)).expect("grant");
    let _link = t
        .offer_direct(LOOPBACK, T, |s| s)
        .expect("direct path opens");
    // A multi-homed host opens one socket per address and each one asks the
    // responder, so wait for the srflx candidate that belongs to `lan` instead
    // of assuming it is the first one to arrive.
    let ev = agent
        .wait_event(T, |e| {
            e["event"] == "signal"
                && e["conn"] == 1
                && e["kind"] == "candidate"
                && e["candidate"]
                    .as_str()
                    .is_some_and(|c| c.contains("typ srflx") && c.contains(&format!(" {lan} ")))
        })
        .expect("trickled srflx candidate for the LAN socket");
    stop.store(true, Ordering::Relaxed);
    let cand = ev["candidate"].as_str().unwrap_or("");
    assert!(cand.starts_with("candidate:"), "{cand}");
    assert!(cand.contains("typ srflx"), "{cand}");
    assert!(
        cand.contains(&format!(" {lan} ")),
        "mapped address of the LAN socket"
    );
    assert!(hits.load(Ordering::Relaxed) >= 1);
}

#[test]
fn reconnected_agent_hello_lists_the_connections_that_outlived_the_old_one() {
    let d = TestDaemon::start();
    let s;
    let mut t;
    {
        let (agent, hello) = d.agent();
        assert_eq!(hello["minor"], 1);
        assert_eq!(hello["connections"], json!([]));
        s = open_sh(&agent);
        // Conn 7: relay first, then the direct path too (it outlives the agent).
        t = agent.open_relay(7, &key(3)).expect("open relay");
        t.hello().expect("hello");
        t.attach(s, 0).expect("attach");
        assert!(matches!(t.recv_acking(T), Some(Frame::Snapshot { .. })));
        t.connect_direct(LOOPBACK, T).expect("direct path");
        assert!(t.is_direct());
        run(&mut t, s, "echo before_$((2+2))\r", "before_4");
        // Conn 8: relay only (closes with the agent link); conn 9: a grant
        // still waiting for its first path.
        let _relay_only = attach_new(&agent, 8, 4, s);
        agent
            .call("grant", json!({ "conn": 9, "deviceKey": key(5) }))
            .expect("grant 9");
        agent.close();
    }

    // The control link drops and a new agent connects: hello lists what lives on.
    let (agent, hello) = d.agent();
    let conns = hello["connections"].as_array().expect("connections");
    let ids: Vec<u64> = conns.iter().filter_map(|c| c["conn"].as_u64()).collect();
    assert_eq!(ids, [7, 9], "{conns:?}");
    assert_eq!(conns[0]["deviceKey"], key(3));
    assert_eq!(conns[0]["state"], "direct");
    assert!(conns[0]["createdAt"].as_u64().is_some_and(|ms| ms > 0));
    assert_eq!(conns[1]["state"], "connecting");
    // Nothing secret or typed is in the listing.
    let text = hello["connections"].to_string();
    assert!(!text.contains("before_"));
    assert!(!text.contains("sdp") && !text.contains("token"));

    // The peer still works, and the new agent can close it with conn_close.
    run(&mut t, s, "echo after_$((3+3))\r", "after_6");
    agent
        .call("conn_close", json!({ "conn": 7 }))
        .expect("conn_close");
    assert!(t
        .direct_link()
        .expect("link")
        .wait_closed(Duration::from_secs(2)));
    agent
        .call("conn_close", json!({ "conn": 9 }))
        .expect("conn_close 9");
    // The session is untouched.
    let list = agent.call("list", json!({})).expect("list");
    assert_eq!(list[0]["session"], s);
    agent.close();
    let (_agent, hello) = d.agent();
    assert_eq!(hello["connections"], json!([]));
}
