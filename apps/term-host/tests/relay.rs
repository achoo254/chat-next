//! Sessions, terminal frames over the relay path, revocation and audit,
//! driven only through the control socket.
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::Frame;
use tunelo_term_host::wire::{error_code, ClientFrame};

#[test]
fn shell_echo_resize_snapshot_and_replay() {
    let d = TestDaemon::start();
    let (agent, hello) = d.agent();
    assert_eq!(hello["major"], 1);
    let s = open_sh(&agent);
    let mut t = attach_new(&agent, 1, 1, s);

    // Input reaches the shell and its output comes back.
    run(&mut t, s, "echo marker_$((6*7))\r", "marker_42");

    // Resize from the client is seen by programs in the session.
    t.send(&ClientFrame::Resize {
        session: s,
        cols: 100,
        rows: 30,
    })
    .expect("resize");
    run(&mut t, s, "stty size\r", "30 100");
    // Resize from the agent too.
    agent
        .call("resize", json!({ "session": s, "cols": 90, "rows": 20 }))
        .expect("resize cmd");
    run(&mut t, s, "stty size\r", "20 90");
    let list = agent.call("list", json!({})).expect("list");
    assert_eq!(list[0]["cols"], 90);
    assert_eq!(list[0]["attached"], true);

    // A second client attaching from scratch gets a Snapshot of the screen.
    let mut t2 = agent.open_relay(2, &key(2)).expect("relay 2");
    t2.hello().expect("hello 2");
    t2.attach(s, 0).expect("attach 2");
    match t2.recv_acking(T) {
        Some(Frame::Snapshot { cols, rows, vt, .. }) => {
            assert_eq!((cols, rows), (90, 20));
            assert!(contains(&vt, b"marker_42"), "snapshot shows earlier output");
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    // Reattach of the first client with its applied offset: replay, no
    // snapshot, starting exactly where it left off.
    let applied = t.applied(s);
    t.send(&ClientFrame::Detach { session: s }).expect("detach");
    run(&mut t2, s, "echo after_$((1+1))\r", "after_2");
    t.attach(s, applied).expect("reattach");
    let mut replayed = Vec::new();
    let deadline = Instant::now() + T;
    let mut first_offset = None;
    while !contains(&replayed, b"after_2") && Instant::now() < deadline {
        match t.recv_acking(T) {
            Some(Frame::Output { offset, data, .. }) => {
                first_offset.get_or_insert(offset);
                replayed.extend_from_slice(&data);
            }
            Some(Frame::Snapshot { .. }) => panic!("replay expected, got snapshot"),
            _ => {}
        }
    }
    assert_eq!(
        first_offset,
        Some(applied),
        "replay starts at lastOffset: no gap, no overlap"
    );
    assert!(contains(&replayed, b"after_2"));
}

#[test]
fn default_login_shell_runs() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let r = agent
        .call("open", json!({ "cols": 80, "rows": 24 }))
        .expect("open");
    let s = r["session"].as_u64().expect("id") as u32;
    let mut t = attach_new(&agent, 1, 1, s);
    t.input(s, b"echo TERM=$TERM COLOR=$COLORTERM SUM=$((20+3))\r")
        .expect("input");
    let out = t
        .read_until(s, Duration::from_secs(20), |b| contains(b, b"SUM=23"))
        .expect("login shell answers");
    assert!(contains(&out, b"TERM=xterm-256color COLOR=truecolor"));
}

#[test]
fn claude_config_dir_is_only_set_when_given() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let r = agent
        .call(
            "open",
            json!({ "cols": 80, "rows": 24, "shell": "/bin/sh", "env": { "CLAUDE_CONFIG_DIR": "/tmp/profile-x" } }),
        )
        .expect("open");
    let s = r["session"].as_u64().expect("id") as u32;
    let mut t = attach_new(&agent, 1, 1, s);
    run(
        &mut t,
        s,
        "echo CC=$CLAUDE_CONFIG_DIR.\r",
        "CC=/tmp/profile-x.",
    );
}

#[test]
fn malformed_and_unattached_frames_get_errors() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = agent.open_relay(1, &key(1)).expect("relay");
    // Frames before Hello are refused.
    t.input(s, b"x").expect("send");
    assert!(matches!(
        t.recv(T),
        Some(Frame::Error {
            code: error_code::BAD_FRAME,
            ..
        })
    ));
    t.hello().expect("hello");
    // Input without Attach.
    t.input(s, b"x").expect("send");
    assert!(matches!(
        t.recv(T),
        Some(Frame::Error {
            code: error_code::NOT_ATTACHED,
            ..
        })
    ));
    // Unknown session.
    t.send(&ClientFrame::Attach {
        session: 999,
        last_offset: 0,
    })
    .expect("send");
    assert!(matches!(
        t.recv(T),
        Some(Frame::Error {
            code: error_code::NO_SUCH_SESSION,
            ..
        })
    ));
    // Bad resize values are malformed.
    t.send(&ClientFrame::Resize {
        session: s,
        cols: 0,
        rows: 10,
    })
    .expect("send");
    assert!(matches!(
        t.recv(T),
        Some(Frame::Error {
            code: error_code::BAD_FRAME,
            ..
        })
    ));
    // An unknown frame type is ignored silently; the next reply is the Pong.
    t.send_raw_frame(&[0x7e, 0, 0, 0, 0, 1, 2, 3])
        .expect("unknown");
    t.send(&ClientFrame::Ping { client_micros: 77 })
        .expect("ping");
    assert_eq!(t.recv(T), Some(Frame::Pong { client_micros: 77 }));
    // Unsupported version.
    t.send(&ClientFrame::Hello {
        version: 9,
        caps: 0,
    })
    .expect("send");
    assert!(matches!(
        t.recv(T),
        Some(Frame::Error {
            code: error_code::BAD_VERSION,
            ..
        })
    ));
}

#[test]
fn revoke_device_closes_connection_within_a_second() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_new(&agent, 7, 3, s);
    let mut other = attach_new(&agent, 8, 4, s);
    let t0 = Instant::now();
    let r = agent
        .call("revoke_device", json!({ "deviceKey": key(3) }))
        .expect("revoke");
    assert_eq!(r["closed"], 1);
    let err = loop {
        match t.recv(T) {
            Some(Frame::Error { code, .. }) => break code,
            Some(_) => continue,
            None => panic!("no error frame"),
        }
    };
    let elapsed = t0.elapsed();
    assert_eq!(err, error_code::REVOKED);
    assert!(elapsed < Duration::from_secs(1), "closed after {elapsed:?}");
    let ev = agent
        .wait_event(T, |e| {
            e["event"] == "conn_state" && e["conn"] == 7 && e["state"] == "closed"
        })
        .expect("conn_state");
    assert_eq!(ev["state"], "closed");
    assert_eq!(ev["reason"], "revoked");
    eprintln!(
        "revoke_device: Error 6 after {:.2} ms",
        elapsed.as_secs_f64() * 1000.0
    );
    // The revoked device cannot get a new grant; that is audited.
    let e = agent
        .call("grant", json!({ "conn": 9, "deviceKey": key(3) }))
        .expect_err("revoked grant");
    assert_eq!(e.code, "revoked");
    assert!(agent
        .wait_event(T, |e| e["event"] == "audit" && e["kind"] == "denied")
        .is_some());
    // The other device is untouched.
    run(&mut other, s, "echo still_$((2+2))\r", "still_4");
}

#[test]
fn set_revoked_closes_and_blocks_listed_devices() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut a = attach_new(&agent, 1, 10, s);
    let _b = attach_new(&agent, 2, 11, s);
    let t0 = Instant::now();
    let r = agent
        .call("set_revoked", json!({ "deviceKeys": [key(10), key(12)] }))
        .expect("set_revoked");
    assert_eq!(r["closed"], 1);
    let got = loop {
        match a.recv(T) {
            Some(Frame::Error { code, .. }) => break code,
            Some(_) => continue,
            None => panic!("no error frame"),
        }
    };
    assert_eq!(got, error_code::REVOKED);
    assert!(t0.elapsed() < Duration::from_secs(1));
    assert_eq!(
        agent
            .call("grant", json!({ "conn": 3, "deviceKey": key(12) }))
            .map_err(|e| e.code),
        Err("revoked".to_string())
    );
    // Replacing the list un-revokes.
    agent
        .call("set_revoked", json!({ "deviceKeys": [] }))
        .expect("clear");
    assert!(agent
        .call("grant", json!({ "conn": 3, "deviceKey": key(12) }))
        .is_ok());
}

#[test]
fn agent_disconnect_keeps_sessions_and_replays_audit() {
    let d = TestDaemon::start();
    let s;
    {
        let (agent, _) = d.agent();
        s = open_sh(&agent);
        let mut t = attach_new(&agent, 1, 1, s);
        run(&mut t, s, "MARK=kept_$((40+2)); echo set\r", "set");
        agent.close();
    }
    // A new agent sees the session and the audit events it missed.
    let (agent, hello) = d.agent();
    let sessions = hello["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session"], s);
    let pending = hello["pendingAudit"].as_array().expect("pendingAudit");
    assert!(pending
        .iter()
        .any(|e| e["kind"] == "open" && e["session"] == s));
    assert!(
        pending
            .iter()
            .any(|e| e["kind"] == "close" && e["session"] == s),
        "close while the agent was away is kept: {pending:?}"
    );
    let up_to = pending
        .iter()
        .filter_map(|e| e["seq"].as_u64())
        .max()
        .expect("seq");
    agent
        .call("ack_audit", json!({ "upTo": up_to }))
        .expect("ack");
    let mut t = attach_new(&agent, 2, 1, s);
    run(&mut t, s, "echo $MARK\r", "kept_42");
    // Acked events are not replayed again.
    agent.close();
    let (_agent, hello) = d.agent();
    let pending = hello["pendingAudit"].as_array().expect("pendingAudit");
    assert!(pending.iter().all(|e| e["seq"].as_u64() > Some(up_to)));
}

#[test]
fn twenty_sessions_then_limit() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let ids: Vec<u32> = (0..20).map(|_| open_sh(&agent)).collect();
    assert_eq!(ids, (1..=20).collect::<Vec<_>>());
    let e = agent
        .call(
            "open",
            json!({ "cols": 80, "rows": 24, "shell": "/bin/sh" }),
        )
        .expect_err("21st");
    assert_eq!(e.code, "session_limit");
    // Closing one frees a slot; ids are never reused.
    agent.call("close", json!({ "session": 5 })).expect("close");
    agent
        .wait_event(T, |e| e["event"] == "session_exit" && e["session"] == 5)
        .expect("exit event");
    assert_eq!(open_sh(&agent), 21);
}

#[test]
fn session_exit_is_reported_to_clients_and_agent() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_new(&agent, 1, 1, s);
    t.input(s, b"exit 7\r").expect("input");
    let deadline = Instant::now() + T;
    let code = loop {
        assert!(Instant::now() < deadline, "no Exit frame");
        if let Some(Frame::Exit { code, signal, .. }) = t.recv_acking(T) {
            assert_eq!(signal, 0);
            break code;
        }
    };
    assert_eq!(code, 7);
    let ev = agent
        .wait_event(T, |e| e["event"] == "session_exit")
        .expect("session_exit");
    assert_eq!(ev["code"], 7);
    let list = agent.call("list", json!({})).expect("list");
    assert_eq!(list[0]["exited"]["code"], 7);
}

#[test]
fn typed_input_never_appears_in_logs_or_events() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = attach_new(&agent, 1, 1, s);
    let secret = "pw-Zx81q-secret";
    // Typed, echoed, executed, and also typed then erased.
    run(&mut t, s, &format!("echo {secret}\r"), secret);
    t.input(s, format!("{secret}-erased").as_bytes())
        .expect("input");
    t.input(s, b"\x15").expect("kill line");
    t.send(&ClientFrame::Detach { session: s }).expect("detach");
    agent.call("close", json!({ "session": s })).expect("close");
    agent
        .wait_event(T, |e| e["event"] == "session_exit")
        .expect("exit");
    agent
        .call("conn_close", json!({ "conn": 1 }))
        .expect("conn_close");
    agent
        .wait_event(T, |e| e["event"] == "conn_state" && e["state"] == "closed")
        .expect("closed");
    let events = agent.transcript().join("\n");
    let logs = d.log_text();
    assert!(events.contains("\"audit\""), "audit events were produced");
    assert!(!logs.is_empty());
    for text in [&events, &logs] {
        assert!(!text.contains(secret), "typed input leaked: {text}");
        assert!(!text.contains("pw-Zx81q"), "typed input leaked: {text}");
    }
}

#[test]
fn granted_connection_expires_without_transport() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    agent
        .call(
            "grant",
            json!({ "conn": 5, "deviceKey": key(1), "expiresMs": 200 }),
        )
        .expect("grant");
    let ev = agent
        .wait_event(T, |e| e["event"] == "conn_state" && e["conn"] == 5)
        .expect("expired");
    assert_eq!(ev["reason"], "expired");
    assert_eq!(
        agent
            .call("relay_open", json!({ "conn": 5 }))
            .map_err(|e| e.code),
        Err("no_such_conn".to_string())
    );
    // An offer must be valid SDP with a data channel section.
    agent
        .call("grant", json!({ "conn": 6, "deviceKey": key(1) }))
        .expect("grant");
    let r = agent.call(
        "signal",
        json!({ "conn": 6, "kind": "offer", "sdp": "v=0" }),
    );
    assert_eq!(r.map_err(|e| e.code), Err("bad_request".to_string()));
    let r = agent.call(
        "signal",
        json!({ "conn": 99, "kind": "offer", "sdp": "v=0" }),
    );
    assert_eq!(r.map_err(|e| e.code), Err("no_such_conn".to_string()));
}
