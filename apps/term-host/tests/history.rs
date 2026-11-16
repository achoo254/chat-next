//! A client with `CAP_LIVE_HISTORY` starts from the screen as it is now
//! (`LiveSnapshot`) and pages back through every history row of the current
//! epoch with `HistoryRequest`, rebuilt from the output log once the rows are
//! older than the live scrollback. Older clients and the alternate screen
//! keep the full replay.
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{Frame, TermClient};
use tunelo_term_host::wire::{error_code, ClientFrame, CAP_LIVE_HISTORY};

/// `n` numbered rows `<tag>00001 …`, then an end marker; neither the row
/// pattern nor the marker appears in the typed command itself.
fn gen(tag: char, n: u32) -> String {
    format!(
        "perl -e 'for my $i (1..{n}) {{ printf \"\\e[3%dm{tag}%05d\\e[0m %s\\n\", $i % 8, $i, \"x\" x 30 }} print \"GEN_\",\"DONE{tag}\\n\"'\r"
    )
}

/// Read output until `marker` shows up.
fn run_until(t: &mut TermClient, s: u32, cmd: &str, marker: &[u8]) {
    t.input(s, cmd.as_bytes()).expect("input");
    let deadline = Instant::now() + T * 3;
    let mut got = Vec::new();
    while !contains(&got, marker) {
        assert!(Instant::now() < deadline, "no {marker:?}");
        if let Some(Frame::Output { session, data, .. }) = t.recv_acking(T) {
            if session == s {
                got.extend_from_slice(&data);
            }
        }
    }
}

/// Every `<tag>NNNNN` number in `bytes`, in order.
fn numbers(bytes: &[u8], tag: u8) -> Vec<u32> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 6 <= bytes.len() {
        if bytes[i] == tag && bytes[i + 1..i + 6].iter().all(u8::is_ascii_digit) {
            let n = std::str::from_utf8(&bytes[i + 1..i + 6])
                .ok()
                .and_then(|t| t.parse().ok());
            if let Some(n) = n {
                out.push(n);
            }
            i += 6;
        } else {
            i += 1;
        }
    }
    out
}

struct Live {
    offset: u64,
    epoch: u32,
    history_end: u64,
    tail_rows: u16,
    vt: Vec<u8>,
}

/// Collect the parts of a `LiveSnapshot`; panics on any other start.
fn live_snapshot(t: &mut TermClient, s: u32) -> Live {
    let mut vt = Vec::new();
    let mut want_part = 0u8;
    loop {
        match t.recv_acking(T) {
            Some(Frame::LiveSnapshot {
                session,
                offset,
                epoch,
                history_end,
                tail_rows,
                part,
                parts,
                vt: chunk,
                ..
            }) if session == s => {
                assert_eq!(part, want_part, "parts in order");
                want_part += 1;
                vt.extend_from_slice(&chunk);
                if part + 1 == parts {
                    return Live {
                        offset,
                        epoch,
                        history_end,
                        tail_rows,
                        vt,
                    };
                }
            }
            Some(Frame::Output { offset, .. }) => {
                panic!("output at {offset} before the live snapshot")
            }
            Some(Frame::Preview { .. }) => panic!("a live client got a preview"),
            other => panic!("expected a live snapshot, got {other:?}"),
        }
    }
}

struct Page {
    epoch: u32,
    first_row: u64,
    row_count: u16,
    at_start: bool,
    vt: Vec<u8>,
}

/// Ask for one page and collect all its parts; output frames in between are
/// applied and skipped.
fn page(t: &mut TermClient, s: u32, req: u16, epoch: u32, before: u64) -> Result<Page, u8> {
    t.history(s, req, epoch, before, 500)
        .expect("history request");
    let mut vt = Vec::new();
    loop {
        match t.recv_acking(T * 2) {
            Some(Frame::History {
                session,
                req_id,
                epoch,
                first_row,
                row_count,
                part,
                parts,
                at_start,
                vt: chunk,
            }) if session == s && req_id == req => {
                vt.extend_from_slice(&chunk);
                if part + 1 == parts {
                    return Ok(Page {
                        epoch,
                        first_row,
                        row_count,
                        at_start,
                        vt,
                    });
                }
            }
            Some(Frame::HistoryError { req_id, code, .. }) if req_id == req => return Err(code),
            Some(Frame::Output { .. }) => {}
            None => panic!("no answer to history request {req}"),
            Some(other) => panic!("unexpected {other:?}"),
        }
    }
}

/// Page back from `history_end` to the start of the epoch; returns the
/// rows' bytes oldest first.
fn all_history(t: &mut TermClient, s: u32, live: &Live) -> Vec<u8> {
    let mut pages: Vec<Vec<u8>> = Vec::new();
    let mut before = live.history_end;
    let mut req = 1;
    loop {
        let p = page(t, s, req, live.epoch, before).unwrap_or_else(|c| panic!("history error {c}"));
        assert_eq!(p.epoch, live.epoch);
        assert_eq!(
            p.first_row + u64::from(p.row_count),
            before,
            "pages are contiguous"
        );
        assert_eq!(
            p.vt.windows(2).filter(|w| w == b"\r\n").count(),
            usize::from(p.row_count)
        );
        pages.push(p.vt);
        before = p.first_row;
        req += 1;
        if p.at_start {
            assert_eq!(before, 0);
            break;
        }
    }
    pages.into_iter().rev().flatten().collect()
}

fn live_client(agent: &tunelo_term_host::client::AgentClient, conn: u32, device: u8) -> TermClient {
    let mut t = agent.open_relay(conn, &key(device)).expect("relay");
    assert_eq!(
        t.hello_with(CAP_LIVE_HISTORY).expect("hello"),
        Some(CAP_LIVE_HISTORY)
    );
    t
}

#[test]
fn live_attach_shows_the_screen_and_pages_back_to_the_first_row() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut writer = attach_new(&agent, 1, 1, s);
    run_until(&mut writer, s, &gen('R', 1500), b"GEN_DONER");
    // A resize in the middle: the rebuild applies it where the live screen did.
    writer
        .send(&ClientFrame::Resize {
            session: s,
            cols: 60,
            rows: 30,
        })
        .expect("resize");
    run_until(&mut writer, s, &gen('Q', 1500), b"GEN_DONEQ");

    let mut t = live_client(&agent, 2, 2);
    // Sent for older daemons; this one answers it with nothing.
    t.preview(s).expect("preview");
    t.attach(s, 0).expect("attach");
    let live = live_snapshot(&mut t, s);
    assert!(live.offset > 0);
    assert!(
        live.tail_rows > 0 && live.history_end > 1000,
        "{} {}",
        live.history_end,
        live.tail_rows
    );
    agent
        .wait_event(T, |e| {
            e["event"] == "audit" && e["kind"] == "open" && e["conn"] == 2 && e["session"] == s
        })
        .expect("attach audited");

    // Typing works at once: the echo comes as Output from the snapshot's offset.
    t.input(s, b"echo LIVE_\"\"OK\r").expect("input");
    let deadline = Instant::now() + T;
    let mut echoed = Vec::new();
    let mut next = live.offset;
    while !contains(&echoed, b"LIVE_OK") {
        assert!(Instant::now() < deadline, "no echo");
        if let Some(Frame::Output { offset, data, .. }) = t.recv_acking(T) {
            assert_eq!(offset, next, "output continues the live snapshot");
            next += data.len() as u64;
            echoed.extend_from_slice(&data);
        }
    }

    // Every row before the snapshot, then the snapshot's own: R1..R1500 then
    // Q1..Q1500, none missing, none twice.
    let history = all_history(&mut t, s, &live);
    let mut joined = history.clone();
    joined.extend_from_slice(&live.vt);
    assert_eq!(numbers(&joined, b'R'), (1..=1500).collect::<Vec<_>>());
    assert_eq!(numbers(&joined, b'Q'), (1..=1500).collect::<Vec<_>>());
}

#[test]
fn erasing_the_history_starts_an_epoch_and_older_rows_never_come_back() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut writer = attach_new(&agent, 1, 1, s);
    run_until(&mut writer, s, &gen('R', 800), b"GEN_DONER");

    let mut t = live_client(&agent, 2, 2);
    t.attach(s, 0).expect("attach");
    let before = live_snapshot(&mut t, s);

    run_until(&mut writer, s, "printf '\\033[2J\\033[03J\\033[H'\r", b"$ ");
    run_until(&mut writer, s, &gen('S', 700), b"GEN_DONES");

    // The page asked for the old epoch says the epoch changed.
    let p = page(&mut t, s, 1, before.epoch, before.history_end)
        .unwrap_or_else(|c| panic!("error {c}"));
    assert!(p.epoch > before.epoch && p.row_count == 0 && p.at_start);

    let mut fresh = live_client(&agent, 3, 3);
    fresh.attach(s, 0).expect("attach");
    let live = live_snapshot(&mut fresh, s);
    assert_eq!(live.epoch, p.epoch);
    let history = all_history(&mut fresh, s, &live);
    assert!(
        numbers(&history, b'R').is_empty(),
        "rows erased by the program came back"
    );
    let mut joined = history;
    joined.extend_from_slice(&live.vt);
    assert_eq!(numbers(&joined, b'S'), (1..=700).collect::<Vec<_>>());
}

#[test]
fn history_needs_an_attached_session() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut t = live_client(&agent, 2, 2);
    t.history(s, 1, 0, 10, 10).expect("send");
    match t.recv_acking(T) {
        Some(Frame::Error { code, session, .. }) => {
            assert_eq!((code, session), (error_code::NOT_ATTACHED, s))
        }
        other => panic!("expected not attached, got {other:?}"),
    }
    t.attach(s, 0).expect("attach");
    let _ = live_snapshot(&mut t, s);
    t.send(&ClientFrame::Detach { session: s }).expect("detach");
    t.history(s, 2, 0, 10, 10).expect("send");
    let deadline = Instant::now() + T;
    loop {
        assert!(Instant::now() < deadline, "no error after detach");
        match t.recv_acking(T) {
            Some(Frame::Error { code, .. }) => {
                assert_eq!(code, error_code::NOT_ATTACHED);
                break;
            }
            Some(Frame::History { .. }) => panic!("history after detach"),
            _ => {}
        }
    }
}

#[test]
fn old_clients_and_the_alternate_screen_keep_the_full_replay() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut writer = attach_new(&agent, 1, 1, s);
    run_until(&mut writer, s, &gen('R', 100), b"GEN_DONER");

    // An old client: a 5-byte Hello, a Preview, then the replay from 0.
    let mut old = agent.open_relay(2, &key(2)).expect("relay");
    assert_eq!(old.hello_with(0).expect("hello"), None);
    old.preview(s).expect("preview");
    assert!(matches!(old.recv_acking(T), Some(Frame::Preview { .. })));
    old.attach(s, 0).expect("attach");
    assert!(matches!(
        old.recv_acking(T),
        Some(Frame::Snapshot { offset: 0, .. })
    ));

    // On the alternate screen a live client gets the preview and the replay.
    writer
        .input(s, b"printf '\\033[?1049hALT_''SCREEN'; cat\r")
        .expect("input");
    let deadline = Instant::now() + T;
    let mut got = Vec::new();
    while !contains(&got, b"ALT_SCREEN") {
        assert!(Instant::now() < deadline, "alternate screen not entered");
        if let Some(Frame::Output { data, .. }) = writer.recv_acking(T) {
            got.extend_from_slice(&data);
        }
    }
    let mut t = live_client(&agent, 3, 3);
    t.preview(s).expect("preview");
    match t.recv_acking(T) {
        Some(Frame::Preview { alt_screen, .. }) => assert!(alt_screen),
        other => panic!("expected preview, got {other:?}"),
    }
    t.attach(s, 0).expect("attach");
    assert!(matches!(
        t.recv_acking(T),
        Some(Frame::Snapshot { offset: 0, .. })
    ));
}

#[test]
fn closing_the_session_while_history_is_rebuilt_removes_its_log() {
    let d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s = open_sh(&agent);
    let mut writer = attach_new(&agent, 1, 1, s);
    run_until(&mut writer, s, &gen('R', 3000), b"GEN_DONER");
    let mut t = live_client(&agent, 2, 2);
    t.attach(s, 0).expect("attach");
    let live = live_snapshot(&mut t, s);
    // Older than the live scrollback: this one is rebuilt from the log.
    t.history(s, 1, live.epoch, 100, 50).expect("history");
    agent.call("close", json!({ "session": s })).expect("close");
    let out = d.home().join("term-host").join("output");
    assert!(
        wait_until(T, || std::fs::read_dir(&out)
            .map(|r| r.count() == 0)
            .unwrap_or(true)),
        "log left behind"
    );
    // No page of a closed session goes out.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Some(Frame::History { row_count, .. }) = t.recv_acking(Duration::from_millis(200)) {
            assert_eq!(row_count, 0, "rows of a closed session");
        }
    }
}
