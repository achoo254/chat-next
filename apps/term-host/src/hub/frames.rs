//! Terminal frames from clients (section 3), arriving on any path.

use std::time::Instant;

use super::Hub;
use crate::audit::AuditKind;
use crate::conn::{Attachment, Conn};
use crate::pty::WriteJob;
use crate::session::{
    attach_plan, live_snapshot_frames, preview_frame, snapshot_frame, AttachPlan,
};
use crate::wire::{self, error_code, ClientFrame, DecodeError, ServerFrame};

pub(super) fn send_error(conn: &mut Conn, session: u32, code: u16, message: &str) {
    if let Some(sink) = conn.sink() {
        let _ = sink.send(&ServerFrame::Error {
            session,
            code,
            message,
        });
    }
}

impl Hub {
    /// `buf` is a relay payload: `conn u32` then one terminal frame.
    pub(super) fn on_relay_frame(&mut self, conn_id: u32, buf: Vec<u8>) {
        if self.conns.get(&conn_id).is_some_and(|c| c.relay.is_some()) {
            self.on_client_frame(conn_id, buf, 4);
        }
    }

    /// `buf` is one terminal frame from the `term-in` data channel.
    pub(super) fn on_direct_frame(&mut self, conn_id: u32, buf: Vec<u8>) {
        if self.conns.get(&conn_id).is_some_and(|c| c.direct.is_some()) {
            self.on_client_frame(conn_id, buf, 0);
        }
    }

    /// One terminal frame at `buf[start..]`, from either path.
    fn on_client_frame(&mut self, conn_id: u32, buf: Vec<u8>, start: usize) {
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            // Closed or never granted: nothing to answer on.
            return;
        };
        let frame = match wire::decode_client(buf.get(start..).unwrap_or_default()) {
            Ok(f) => owned(&f),
            Err(DecodeError::UnknownType(_)) => return,
            Err(_) => {
                send_error(conn, 0, error_code::BAD_FRAME, "malformed frame");
                return;
            }
        };
        match frame {
            Frame::Input { session } => self.on_input(
                conn_id,
                session,
                WriteJob {
                    buf,
                    start: start + wire::HEADER_LEN,
                },
            ),
            other => self.on_frame(conn_id, other),
        }
    }

    /// Keystrokes: straight to the session's writer thread, no copy.
    fn on_input(&mut self, conn_id: u32, session: u32, job: WriteJob) {
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        if !conn.hello {
            send_error(conn, 0, error_code::BAD_FRAME, "hello first");
            return;
        }
        let Some(s) = self.sessions.get_mut(&session) else {
            send_error(
                conn,
                session,
                error_code::NO_SUCH_SESSION,
                "no such session",
            );
            return;
        };
        if !conn.attachments.contains_key(&session) {
            send_error(conn, session, error_code::NOT_ATTACHED, "not attached");
            return;
        }
        s.write(job, Instant::now());
    }

    fn on_frame(&mut self, conn_id: u32, frame: Frame) {
        let now = Instant::now();
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        match frame {
            Frame::Hello { version, caps } => {
                if version != wire::VERSION {
                    send_error(conn, 0, error_code::BAD_VERSION, "unsupported version");
                    return;
                }
                conn.hello = true;
                conn.caps = caps & wire::SUPPORTED_CAPS;
                // Only a client that set a bit takes a Hello longer than 5 bytes.
                let caps = (caps != 0).then_some(conn.caps);
                if let Some(sink) = conn.sink() {
                    let _ = sink.send(&ServerFrame::Hello {
                        version: wire::VERSION,
                        max_frame: wire::MAX_FRAME as u32,
                        caps,
                    });
                }
            }
            _ if !conn.hello => send_error(conn, 0, error_code::BAD_FRAME, "hello first"),
            Frame::Input { .. } => {}
            Frame::Ping { client_micros } => {
                if let Some(sink) = conn.sink() {
                    let _ = sink.send(&ServerFrame::Pong { client_micros });
                }
            }
            Frame::Resize {
                session,
                cols,
                rows,
            } => {
                let Some(s) = self.sessions.get_mut(&session) else {
                    send_error(
                        conn,
                        session,
                        error_code::NO_SUCH_SESSION,
                        "no such session",
                    );
                    return;
                };
                if !conn.attachments.contains_key(&session) {
                    send_error(conn, session, error_code::NOT_ATTACHED, "not attached");
                    return;
                }
                if let Err(e) = s.resize(cols, rows) {
                    self.cfg.log.warn(&format!("session {session}: {e}"));
                }
            }
            Frame::Attach {
                session,
                last_offset,
            } => {
                let Some(s) = self.sessions.get_mut(&session) else {
                    send_error(
                        conn,
                        session,
                        error_code::NO_SUCH_SESSION,
                        "no such session",
                    );
                    return;
                };
                let live = conn.live_history() && s.screen.live_ready();
                let from = match attach_plan(last_offset, s.held_start(), s.end()) {
                    AttachPlan::Replay { from } => from,
                    _ if live && send_live_snapshot(conn, session, s) => s.screen.fed_offset(),
                    plan => {
                        let snap = if plan == AttachPlan::FromStart {
                            s.start_snapshot()
                        } else {
                            s.snapshot()
                        };
                        if let Some(sink) = conn.sink() {
                            let _ = sink.send(&snapshot_frame(session, &snap));
                        }
                        snap.offset
                    }
                };
                let att = Attachment::new(from);
                let is_new = conn.attachments.insert(session, att).is_none();
                // A path change re-attaches: pages being sent start over on
                // the new path (parts on the old one may be lost).
                for page in conn.pages.iter_mut().filter(|p| p.session == session) {
                    page.next = 0;
                }
                // A preview just before it was audited as the opening already.
                let previewed = conn.previewed.remove(&session);
                if is_new && !previewed {
                    let key = conn.device_key;
                    self.record_audit(AuditKind::Open, Some(session), Some(conn_id), Some(key));
                }
            }
            // A client that starts from LiveSnapshot sends Preview for older
            // daemons: nothing to answer, nothing opened, when its Attach will
            // get one. A session on the alternate screen (or whose numbering
            // is unreliable) still replays, so it still gets its preview.
            Frame::Preview { session }
                if conn.live_history()
                    && self
                        .sessions
                        .get(&session)
                        .is_some_and(|s| s.screen.live_ready()) => {}
            Frame::Preview { session } => {
                // The session as the emulator renders it now: shown by the client at once while the Attach that
                // follows replays the whole stream out of sight. Nothing about the attachment changes.
                let Some(s) = self.sessions.get(&session) else {
                    send_error(
                        conn,
                        session,
                        error_code::NO_SUCH_SESSION,
                        "no such session",
                    );
                    return;
                };
                let snap = s.snapshot();
                if let Some(sink) = conn.sink() {
                    let _ = sink.send(&preview_frame(session, &snap));
                }
                // The preview shows the session's content: audited as its opening, once, unless already attached.
                if !conn.attachments.contains_key(&session) && conn.previewed.insert(session) {
                    let key = conn.device_key;
                    self.record_audit(AuditKind::Open, Some(session), Some(conn_id), Some(key));
                }
            }
            Frame::Detach { session } => {
                conn.cancel_history(Some(session));
                if conn.attachments.remove(&session).is_some() {
                    let key = conn.device_key;
                    self.record_audit(AuditKind::Close, Some(session), Some(conn_id), Some(key));
                } else {
                    send_error(conn, session, error_code::NOT_ATTACHED, "not attached");
                }
            }
            Frame::HistoryRequest {
                session,
                req_id,
                epoch,
                before_row,
                max_rows,
            } => {
                self.on_history_request(conn_id, session, req_id, epoch, before_row, max_rows, now)
            }
            Frame::Ack { session, offset } => {
                let Some(att) = conn.attachments.get_mut(&session) else {
                    send_error(conn, session, error_code::NOT_ATTACHED, "not attached");
                    return;
                };
                if offset > att.sent {
                    send_error(
                        conn,
                        session,
                        error_code::BAD_FRAME,
                        "ack beyond sent output",
                    );
                    return;
                }
                if offset > att.acked {
                    att.acked = offset;
                    if let Some(rtt) = att.clock.on_ack(offset, now) {
                        att.window.on_rtt(now, rtt);
                    }
                }
            }
        }
    }
}

/// Send the frames of the session's `LiveSnapshot`; false (nothing sent)
/// when it does not fit 255 frames.
fn send_live_snapshot(conn: &mut Conn, session: u32, s: &mut crate::session::Session) -> bool {
    let snap = s.screen.live_snapshot();
    let Some(frames) = live_snapshot_frames(session, &snap) else {
        return false;
    };
    if let Some(sink) = conn.sink() {
        for f in &frames {
            if sink.send(f).is_err() {
                break;
            }
        }
    }
    true
}

/// A client frame without borrowed data; Input data stays in its buffer.
enum Frame {
    Input {
        session: u32,
    },
    Hello {
        version: u8,
        caps: u8,
    },
    HistoryRequest {
        session: u32,
        req_id: u16,
        epoch: u32,
        before_row: u64,
        max_rows: u16,
    },
    Resize {
        session: u32,
        cols: u16,
        rows: u16,
    },
    Attach {
        session: u32,
        last_offset: u64,
    },
    Detach {
        session: u32,
    },
    Ack {
        session: u32,
        offset: u64,
    },
    Ping {
        client_micros: u64,
    },
    Preview {
        session: u32,
    },
}

fn owned(f: &ClientFrame<'_>) -> Frame {
    match *f {
        ClientFrame::Hello { version, caps } => Frame::Hello { version, caps },
        ClientFrame::HistoryRequest {
            session,
            req_id,
            epoch,
            before_row,
            max_rows,
        } => Frame::HistoryRequest {
            session,
            req_id,
            epoch,
            before_row,
            max_rows,
        },
        ClientFrame::Resize {
            session,
            cols,
            rows,
        } => Frame::Resize {
            session,
            cols,
            rows,
        },
        ClientFrame::Attach {
            session,
            last_offset,
        } => Frame::Attach {
            session,
            last_offset,
        },
        ClientFrame::Detach { session } => Frame::Detach { session },
        ClientFrame::Ack { session, offset } => Frame::Ack { session, offset },
        ClientFrame::Ping { client_micros } => Frame::Ping { client_micros },
        ClientFrame::Preview { session } => Frame::Preview { session },
        ClientFrame::Input { session, .. } => Frame::Input { session },
    }
}
