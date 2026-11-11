//! Agent command handlers.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::Hub;
use crate::audit::AuditKind;
use crate::commands::{self, code, CmdError, Command, SignalKind};
use crate::conn::{Conn, DeviceKey, RelaySink};
use crate::pty::OpenSpec;
use crate::rtc;
use crate::session::Session;
use crate::wire::error_code;
use crate::ExitReason;

/// Most connections (granted or open) at once.
const MAX_CONNS: usize = 256;

fn err(code: &'static str, message: impl Into<String>) -> CmdError {
    CmdError {
        code,
        message: message.into(),
    }
}

impl Hub {
    pub(super) fn on_command(&mut self, body: &[u8]) {
        let (id, parsed) = commands::parse(body);
        let result = match parsed {
            Ok(Command::Shutdown) => {
                self.shutdown_reply = Some(id);
                self.exit.get_or_insert(ExitReason::ShutdownCommand);
                return;
            }
            Ok(cmd) => self.exec(cmd),
            Err(e) => Err(e),
        };
        self.reply(&id, result);
    }

    fn exec(&mut self, cmd: Command) -> Result<Value, CmdError> {
        let now = Instant::now();
        match cmd {
            Command::Hello => Err(err(code::BAD_REQUEST, "already authenticated")),
            Command::Open(spec) => self.open(&spec),
            Command::Close { session } => {
                let s = self
                    .sessions
                    .get_mut(&session)
                    .ok_or_else(|| err(code::NO_SUCH_SESSION, "no such session"))?;
                if s.finished {
                    self.remove_session(session);
                } else {
                    s.hangup(now);
                }
                Ok(json!({}))
            }
            Command::Resize {
                session,
                cols,
                rows,
            } => {
                let s = self
                    .sessions
                    .get_mut(&session)
                    .ok_or_else(|| err(code::NO_SUCH_SESSION, "no such session"))?;
                s.resize(cols, rows).map_err(|e| err(code::INTERNAL, e))?;
                Ok(json!({}))
            }
            Command::List => Ok(self.session_list()),
            Command::Grant {
                conn,
                key,
                expires_ms,
            } => self.grant(conn, key, now + Duration::from_millis(expires_ms)),
            Command::Signal {
                conn,
                kind,
                sdp,
                candidate,
            } => self.signal(conn, kind, sdp, candidate),
            Command::RelayOpen { conn } => {
                let Some(tx) = self.agent.as_ref().map(|a| a.tx.clone()) else {
                    return Err(err(code::INTERNAL, "no agent link"));
                };
                let c = self
                    .conns
                    .get_mut(&conn)
                    .ok_or_else(|| err(code::NO_SUCH_CONN, "no such conn"))?;
                c.relay = Some(RelaySink::new(conn, tx));
                c.expires = None;
                // While the direct path is open it stays the one in use.
                let state = if c.direct.is_some() {
                    "direct"
                } else {
                    "relay"
                };
                self.cfg
                    .log
                    .info(&format!("connection {conn} open on relay"));
                self.emit(json!({ "event": "conn_state", "conn": conn, "state": state }));
                Ok(json!({}))
            }
            Command::ConnClose { conn } => {
                if !self.conns.contains_key(&conn) {
                    return Err(err(code::NO_SUCH_CONN, "no such conn"));
                }
                self.close_conn(conn, "closed", None);
                Ok(json!({}))
            }
            Command::RevokeDevice { key } => {
                self.revoked.insert(key);
                let closed = self.close_revoked();
                Ok(json!({ "closed": closed }))
            }
            Command::SetRevoked { keys } => {
                self.revoked = keys.into_iter().collect();
                let closed = self.close_revoked();
                Ok(json!({ "closed": closed }))
            }
            Command::AckAudit { up_to } => {
                self.audit.ack(up_to);
                Ok(json!({}))
            }
            Command::Shutdown => Ok(json!({})),
        }
    }

    fn open(&mut self, spec: &OpenSpec) -> Result<Value, CmdError> {
        let occupied = self
            .sessions
            .values()
            .filter(|s| !s.close_requested)
            .count();
        if occupied >= self.cfg.max_sessions {
            // Make room by dropping the oldest session whose process ended.
            let oldest_exited = self
                .sessions
                .values()
                .filter(|s| s.finished && !s.close_requested)
                .map(|s| s.id)
                .next();
            match oldest_exited {
                Some(id) => self.remove_session(id),
                None => return Err(err(code::SESSION_LIMIT, "session limit reached")),
            }
        }
        let id = self.next_session;
        self.next_session = id
            .checked_add(1)
            .ok_or_else(|| err(code::INTERNAL, "session ids exhausted"))?;
        let s = Session::open(id, spec, self.cfg.ring_bytes, self.pty_tx.clone()).map_err(|e| {
            self.cfg.log.warn(&format!("session open failed: {e}"));
            err(code::INTERNAL, e)
        })?;
        self.cfg.log.info(&format!(
            "session {id} opened (pid {})",
            s.pid().map_or(-1, i64::from)
        ));
        self.sessions.insert(id, s);
        Ok(json!({ "session": id }))
    }

    fn signal(
        &mut self,
        conn: u32,
        kind: SignalKind,
        sdp: Option<String>,
        candidate: Option<String>,
    ) -> Result<Value, CmdError> {
        let Some(c) = self.conns.get_mut(&conn) else {
            return Err(err(code::NO_SUCH_CONN, "no such conn"));
        };
        match kind {
            SignalKind::Offer => {
                let offer = rtc::parse_offer(sdp.as_deref().unwrap_or_default())
                    .map_err(|e| err(code::BAD_REQUEST, e))?;
                // A new offer replaces the previous peer. The connection
                // keeps its relay; with no relay it waits for the new peer.
                c.direct = None;
                c.peer = None;
                let handle = rtc::start(conn, offer, &self.cfg.rtc, self.control_tx.clone())
                    .map_err(|e| err(code::INTERNAL, format!("cannot start peer: {e}")))?;
                c.peer = Some(handle);
                self.emit(json!({ "event": "conn_state", "conn": conn, "state": "connecting" }));
            }
            SignalKind::Candidate => {
                // A candidate racing with the end of its peer is dropped.
                if let (Some(p), Some(text)) = (c.peer.as_ref(), candidate) {
                    p.add_candidate(text);
                }
            }
            SignalKind::End => {
                if c.peer.is_some() {
                    self.end_direct(conn, None);
                }
            }
        }
        Ok(json!({}))
    }

    fn grant(&mut self, conn: u32, key: DeviceKey, expires: Instant) -> Result<Value, CmdError> {
        if self.revoked.contains(&key) {
            self.record_audit(AuditKind::Denied, None, Some(conn), Some(key));
            return Err(err(code::REVOKED, "device revoked"));
        }
        match self.conns.get(&conn) {
            Some(c) if c.is_open() => return Err(err(code::BAD_REQUEST, "conn already open")),
            Some(_) => {}
            None if self.conns.len() >= MAX_CONNS => {
                return Err(err(code::BAD_REQUEST, "too many connections"))
            }
            None => {}
        }
        self.conns.insert(conn, Conn::granted(conn, key, expires));
        Ok(json!({}))
    }

    /// Close every connection of a revoked device; returns how many.
    fn close_revoked(&mut self) -> usize {
        let ids: Vec<u32> = self
            .conns
            .values()
            .filter(|c| self.revoked.contains(&c.device_key))
            .map(|c| c.id)
            .collect();
        for &id in &ids {
            self.close_conn(id, "revoked", Some((error_code::REVOKED, "device revoked")));
        }
        if !ids.is_empty() {
            self.cfg
                .log
                .info(&format!("revocation closed {} connection(s)", ids.len()));
        }
        ids.len()
    }
}
