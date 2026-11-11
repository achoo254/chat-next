//! The hub: one thread that owns every session, connection and the audit
//! log. Control messages (agent commands, relay frames, keystrokes) are
//! served before PTY output so a flood of output never delays input.

mod commands;
mod frames;
mod output;

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use crossbeam_channel::{select_biased, Receiver, RecvTimeoutError, Sender};
use serde_json::{json, Value};

use crate::audit::{AuditKind, AuditLog};
use crate::conn::{Conn, DeviceKey};
use crate::control::{error_reply, ok_reply, AgentLink, AgentTx, ControlMsg};
use crate::flow::RelayBudget;
use crate::pty::PtyEvent;
use crate::rtc::{EndReason, PeerEvent, RtcSettings};
use crate::session::{Session, KILL_GRACE};
use crate::wire::{self, ServerFrame};
use crate::{ExitReason, Logger};

/// Longest sleep of the hub loop when nothing is scheduled.
const MAX_SLEEP: Duration = Duration::from_secs(1);
/// After force-killing, wait this long for the last exits at shutdown.
const FINAL_WAIT: Duration = Duration::from_secs(1);

pub struct HubConfig {
    pub ring_bytes: usize,
    pub idle_timeout: Duration,
    pub max_sessions: usize,
    pub rtc: RtcSettings,
    pub log: Logger,
}

struct Agent {
    tx: AgentTx,
    link: AgentLink,
}

pub struct Hub {
    cfg: HubConfig,
    control: Receiver<ControlMsg>,
    /// Kept so the control channel never disconnects while the hub runs;
    /// peer threads report through clones of it.
    control_tx: Sender<ControlMsg>,
    pty_rx: Receiver<PtyEvent>,
    pty_tx: Sender<PtyEvent>,
    sessions: BTreeMap<u32, Session>,
    next_session: u32,
    conns: BTreeMap<u32, Conn>,
    revoked: BTreeSet<DeviceKey>,
    audit: AuditLog,
    agent: Option<Agent>,
    budget: RelayBudget,
    idle_since: Option<Instant>,
    flush_deadline: Option<Instant>,
    exit: Option<ExitReason>,
    shutdown_reply: Option<Value>,
    scratch: Vec<u8>,
}

impl Hub {
    pub fn new(
        cfg: HubConfig,
        control: Receiver<ControlMsg>,
        control_tx: Sender<ControlMsg>,
    ) -> Hub {
        let (pty_tx, pty_rx) = crossbeam_channel::unbounded();
        Hub {
            cfg,
            control,
            control_tx,
            pty_rx,
            pty_tx,
            sessions: BTreeMap::new(),
            next_session: 1,
            conns: BTreeMap::new(),
            revoked: BTreeSet::new(),
            audit: AuditLog::default(),
            agent: None,
            budget: RelayBudget::new(Instant::now()),
            idle_since: None,
            flush_deadline: None,
            exit: None,
            shutdown_reply: None,
            scratch: Vec::with_capacity(wire::MAX_FRAME),
        }
    }

    pub fn run(mut self) -> ExitReason {
        loop {
            let now = Instant::now();
            self.on_timers(now);
            self.flush_all(now);
            if let Some(reason) = self.exit.take() {
                self.shutdown(reason);
                return reason;
            }
            let wait = self
                .next_deadline(now)
                .saturating_duration_since(Instant::now());
            select_biased! {
                recv(self.control) -> m => {
                    if let Ok(m) = m {
                        self.on_control(m);
                    }
                }
                recv(self.pty_rx) -> e => {
                    if let Ok(e) = e {
                        self.on_pty(e);
                    }
                }
                default(wait) => {}
            }
        }
    }

    fn on_control(&mut self, msg: ControlMsg) {
        match msg {
            ControlMsg::AgentHello {
                id,
                params,
                tx,
                link,
            } => {
                if let Some(old) = self.agent.take() {
                    self.cfg
                        .log
                        .info("control: new agent replaces the previous one");
                    self.drop_agent_conns(old.link.id);
                    drop(old.tx);
                    old.link.close();
                }
                self.cfg.log.info(&format!(
                    "control: agent connected (version {:?}, minor {})",
                    params.agent_version, params.minor
                ));
                self.agent = Some(Agent { tx, link });
                let result = self.hello_result();
                self.reply(&id, Ok(result));
            }
            ControlMsg::Command { link, body } => {
                if self.is_current(link) {
                    self.on_command(&body);
                }
            }
            ControlMsg::Relay { link, conn, buf } => {
                if self.is_current(link) {
                    self.on_relay_frame(conn, buf);
                }
            }
            ControlMsg::AgentGone { link } => {
                if self.is_current(link) {
                    self.cfg.log.info("control: agent disconnected");
                    if let Some(agent) = self.agent.take() {
                        self.drop_agent_conns(link);
                        drop(agent.tx);
                        agent.link.close();
                    }
                }
            }
            ControlMsg::Peer { conn, peer, event } => {
                let current = self
                    .conns
                    .get(&conn)
                    .and_then(|c| c.peer.as_ref())
                    .is_some_and(|p| p.id == peer);
                if current {
                    self.on_peer(conn, event);
                }
            }
            ControlMsg::Stop => {
                self.exit.get_or_insert(ExitReason::Stopped);
            }
        }
    }

    /// An event of the current direct peer of `conn_id`.
    fn on_peer(&mut self, conn_id: u32, event: PeerEvent) {
        match event {
            PeerEvent::Frame { buf } => self.on_direct_frame(conn_id, buf),
            PeerEvent::Answer { sdp } => {
                self.emit(
                    json!({ "event": "signal", "conn": conn_id, "kind": "answer", "sdp": sdp }),
                );
            }
            PeerEvent::Candidate { candidate } => {
                self.emit(json!({
                    "event": "signal", "conn": conn_id, "kind": "candidate", "candidate": candidate,
                }));
            }
            PeerEvent::Open { sink } => {
                if let Some(c) = self.conns.get_mut(&conn_id) {
                    c.direct = Some(Box::new(sink));
                    c.expires = None;
                    self.emit(json!({ "event": "conn_state", "conn": conn_id, "state": "direct" }));
                }
            }
            PeerEvent::Rtt { ms } => {
                if self.conns.get(&conn_id).is_some_and(|c| c.direct.is_some()) {
                    let ms = (ms * 10.0).round() / 10.0;
                    self.emit(json!({
                        "event": "conn_state", "conn": conn_id, "state": "direct", "rttMs": ms,
                    }));
                }
            }
            PeerEvent::Ended { reason } => self.end_direct(conn_id, Some(reason)),
        }
    }

    /// Drop the direct peer of a connection. `reason` is set when the peer
    /// ended by itself (reported to the agent as `signal end`). Frames then
    /// go on the relay if there is one; a connection that was open with no
    /// relay left closes; a grant still waiting for its first transport
    /// keeps waiting (the client may fall back to the relay).
    fn end_direct(&mut self, conn_id: u32, reason: Option<EndReason>) {
        let Some(c) = self.conns.get_mut(&conn_id) else {
            return;
        };
        c.peer = None;
        let had_direct = c.direct.take().is_some();
        let has_relay = c.relay.is_some();
        let was_open = c.expires.is_none();
        if let Some(r) = reason {
            self.emit(
                json!({ "event": "signal", "conn": conn_id, "kind": "end", "reason": r.as_str() }),
            );
        }
        if has_relay {
            if had_direct || reason.is_some() {
                self.emit(json!({ "event": "conn_state", "conn": conn_id, "state": "relay" }));
            }
        } else if was_open {
            self.close_conn(conn_id, "transport_closed", None);
        }
    }

    fn is_current(&self, link: u64) -> bool {
        self.agent.as_ref().is_some_and(|a| a.link.id == link)
    }

    fn on_pty(&mut self, event: PtyEvent) {
        let now = Instant::now();
        match event {
            PtyEvent::Output { session, data } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.ingest(&data);
                }
            }
            PtyEvent::Eof { session } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.eof = true;
                    if s.exit.is_some() {
                        self.finalize(session);
                    }
                }
            }
            PtyEvent::Exited { session, exit } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.exit = Some(exit);
                    s.kill_at = None;
                    if s.eof {
                        self.finalize(session);
                    } else {
                        s.finalize_at = Some(now + crate::session::EXIT_DRAIN);
                    }
                }
            }
        }
    }

    fn on_timers(&mut self, now: Instant) {
        let expired: Vec<u32> = self
            .conns
            .values()
            .filter(|c| c.expires.is_some_and(|t| t <= now))
            .map(|c| c.id)
            .collect();
        for id in expired {
            self.close_conn(id, "expired", None);
        }
        let mut finalize = Vec::new();
        for s in self.sessions.values_mut() {
            if s.kill_at.is_some_and(|t| t <= now) {
                self.cfg
                    .log
                    .warn(&format!("session {} did not hang up, killing it", s.id));
                s.force_kill();
            }
            if !s.finished && s.finalize_at.is_some_and(|t| t <= now) {
                finalize.push(s.id);
            }
        }
        for id in finalize {
            self.finalize(id);
        }
        if self.sessions.is_empty() && self.conns.is_empty() {
            let since = *self.idle_since.get_or_insert(now);
            if now.saturating_duration_since(since) >= self.cfg.idle_timeout {
                self.exit.get_or_insert(ExitReason::Idle);
            }
        } else {
            self.idle_since = None;
        }
    }

    fn next_deadline(&self, now: Instant) -> Instant {
        let mut next = now + MAX_SLEEP;
        let mut consider = |t: Option<Instant>| {
            if let Some(t) = t {
                next = next.min(t);
            }
        };
        consider(self.flush_deadline);
        consider(self.idle_since.map(|t| t + self.cfg.idle_timeout));
        for c in self.conns.values() {
            consider(c.expires);
        }
        for s in self.sessions.values() {
            consider(s.kill_at);
            if !s.finished {
                consider(s.finalize_at);
            }
        }
        next
    }

    /// Process exited and its output drained: report Exit.
    fn finalize(&mut self, id: u32) {
        let Some(s) = self.sessions.get_mut(&id) else {
            return;
        };
        if s.finished {
            return;
        }
        s.finished = true;
        s.finalize_at = None;
        let exit = s.exit.unwrap_or(crate::pty::ExitInfo {
            code: -1,
            signal: 0,
        });
        let close = s.close_requested;
        self.cfg.log.info(&format!(
            "session {id} exited (code {}, signal {})",
            exit.code, exit.signal
        ));
        self.emit(json!({
            "event": "session_exit",
            "session": id,
            "code": exit.code,
            "signal": exit.signal,
        }));
        if close {
            self.remove_session(id);
        }
        // Otherwise flush_all delivers the remaining output, then Exit.
    }

    /// Drop a session; attached clients get Exit (if not sent) and lose the
    /// attachment.
    fn remove_session(&mut self, id: u32) {
        let Some(mut s) = self.sessions.remove(&id) else {
            return;
        };
        let exit = s.exit.unwrap_or(crate::pty::ExitInfo {
            code: -1,
            signal: 0,
        });
        let mut detached = Vec::new();
        for conn in self.conns.values_mut() {
            if let Some(att) = conn.attachments.remove(&id) {
                if !att.exit_sent {
                    if let Some(sink) = conn.sink() {
                        let _ = sink.send(&ServerFrame::Exit {
                            session: id,
                            code: exit.code,
                            signal: exit.signal,
                        });
                    }
                }
                detached.push((conn.id, conn.device_key));
            }
        }
        for (conn, key) in detached {
            self.record_audit(AuditKind::Close, Some(id), Some(conn), Some(key));
        }
        s.release();
    }

    /// Close a connection: optional Error frame, audit close of its
    /// attachments, `conn_state closed` to the agent.
    fn close_conn(&mut self, id: u32, reason: &str, error: Option<(u16, &str)>) {
        let Some(mut c) = self.conns.remove(&id) else {
            return;
        };
        if let Some((code, message)) = error {
            if let Some(sink) = c.sink() {
                let _ = sink.send(&ServerFrame::Error {
                    session: 0,
                    code,
                    message,
                });
            }
        }
        let sessions: Vec<u32> = c.attachments.keys().copied().collect();
        for s in sessions {
            self.record_audit(AuditKind::Close, Some(s), Some(id), Some(c.device_key));
        }
        self.cfg
            .log
            .info(&format!("connection {id} closed ({reason})"));
        self.emit(
            json!({ "event": "conn_state", "conn": id, "state": "closed", "reason": reason }),
        );
    }

    /// The agent link is gone: connections that only had the relay close.
    fn drop_agent_conns(&mut self, link: u64) {
        let mut close = Vec::new();
        for c in self.conns.values_mut() {
            if c.relay.as_ref().is_some_and(|r| r.link() == link) {
                if c.direct.is_some() {
                    c.relay = None;
                } else {
                    close.push(c.id);
                }
            }
        }
        for id in close {
            self.close_conn(id, "agent_gone", None);
        }
    }

    fn record_audit(
        &mut self,
        kind: AuditKind,
        session: Option<u32>,
        conn: Option<u32>,
        key: Option<DeviceKey>,
    ) {
        let ev = self
            .audit
            .record(kind, session, conn, key.map(|k| k.encode()));
        if let Ok(mut v) = serde_json::to_value(&ev) {
            v["event"] = json!("audit");
            self.emit(v);
        }
    }

    fn emit(&self, event: Value) {
        if let Some(a) = &self.agent {
            a.tx.send_json(&event);
        }
    }

    fn reply(&self, id: &Value, result: Result<Value, crate::commands::CmdError>) {
        let v = match result {
            Ok(r) => ok_reply(id, r),
            Err(e) => error_reply(id, e.code, &e.message),
        };
        self.emit(v);
    }

    fn attached(&self, session: u32) -> bool {
        self.conns
            .values()
            .any(|c| c.attachments.contains_key(&session))
    }

    fn session_list(&self) -> Value {
        Value::Array(
            self.sessions
                .values()
                .map(|s| s.info(self.attached(s.id)))
                .collect(),
        )
    }

    /// Live connections for `hello`: ids, device keys and paths only (no
    /// secrets, no terminal bytes), so a restarted agent can find the ones
    /// it no longer knows.
    fn conn_list(&self) -> Value {
        Value::Array(
            self.conns
                .values()
                .map(|c| {
                    json!({
                        "conn": c.id,
                        "deviceKey": c.device_key.encode(),
                        "state": c.state(),
                        "createdAt": c.created_at,
                    })
                })
                .collect(),
        )
    }

    fn hello_result(&self) -> Value {
        json!({
            "major": crate::commands::MAJOR,
            "minor": crate::commands::MINOR,
            "daemonVersion": crate::VERSION,
            "pid": std::process::id(),
            "sessions": self.session_list(),
            "connections": self.conn_list(),
            "pendingAudit": self.audit.pending().collect::<Vec<_>>(),
        })
    }

    /// Close connections, then shells (hang up, wait, kill), then answer a
    /// pending `shutdown` and let the agent link drain.
    fn shutdown(&mut self, reason: ExitReason) {
        self.cfg.log.info(&format!("shutting down ({reason})"));
        let conns: Vec<u32> = self.conns.keys().copied().collect();
        for id in conns {
            self.close_conn(id, "shutdown", None);
        }
        let now = Instant::now();
        for s in self.sessions.values_mut() {
            if s.exit.is_none() {
                s.hangup(now);
            }
        }
        self.wait_exits(now + KILL_GRACE);
        for s in self.sessions.values_mut() {
            s.force_kill();
        }
        self.wait_exits(Instant::now() + FINAL_WAIT);
        let left = self.sessions.values().filter(|s| s.exit.is_none()).count();
        if left > 0 {
            self.cfg
                .log
                .warn(&format!("{left} session process(es) did not exit"));
        }
        for s in self.sessions.values_mut() {
            s.release();
        }
        self.sessions.clear();
        if let Some(id) = self.shutdown_reply.take() {
            self.reply(&id, Ok(json!({})));
        }
        if let Some(agent) = self.agent.take() {
            drop(agent.tx);
            agent.link.finish();
        }
    }

    fn wait_exits(&mut self, deadline: Instant) {
        while self.sessions.values().any(|s| s.exit.is_none()) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.pty_rx.recv_timeout(left) {
                Ok(PtyEvent::Exited { session, exit }) => {
                    if let Some(s) = self.sessions.get_mut(&session) {
                        s.exit = Some(exit);
                    }
                }
                Ok(PtyEvent::Output { session, data }) => {
                    if let Some(s) = self.sessions.get_mut(&session) {
                        s.ingest(&data);
                    }
                }
                Ok(PtyEvent::Eof { .. }) => {}
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }
}
