//! `HistoryRequest` (section 4, "Lịch sử theo yêu cầu"): pages from the live
//! scrollback or the cache at once, otherwise a rebuild on a worker thread
//! whose result goes back to the connection that asked, if it still waits.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use super::Hub;
use crate::conn::Conn;
use crate::control::ControlMsg;
use crate::history::{self, Built, InFlight, Job, Page, RebuildSpec, REBUILD_ROWS};
use crate::wire::{error_code, history_error, ServerFrame};

fn history_error(conn: &mut Conn, session: u32, req_id: u16, code: u8) {
    if let Some(sink) = conn.sink() {
        let _ = sink.send(&ServerFrame::HistoryError {
            session,
            req_id,
            code,
        });
    }
}

impl Hub {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn on_history_request(
        &mut self,
        conn_id: u32,
        session: u32,
        req_id: u16,
        epoch: u32,
        before_row: u64,
        max_rows: u16,
        now: Instant,
    ) {
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        let Some(s) = self.sessions.get_mut(&session) else {
            super::frames::send_error(
                conn,
                session,
                error_code::NO_SUCH_SESSION,
                "no such session",
            );
            return;
        };
        // Only a connection reading the session (audited as opened) may read its history.
        if !conn.attachments.contains_key(&session) {
            super::frames::send_error(conn, session, error_code::NOT_ATTACHED, "not attached");
            return;
        }
        // The same request again after a path change: the answer is on its way.
        let same = |h: &InFlight| h.session == session && h.req_id == req_id;
        if conn.history.as_ref().is_some_and(same)
            || conn
                .pages
                .iter()
                .any(|p| p.session == session && p.req_id == req_id)
        {
            return;
        }
        // One page at a time: waiting for a rebuild or still being sent.
        if conn.history.is_some() || !conn.pages.is_empty() || !conn.history_rate.try_take(now) {
            history_error(conn, session, req_id, history_error::BUSY);
            return;
        }
        let current = s.screen.epoch();
        // Rows numbered unreliably are never served (the live rows neither).
        if !s.screen.exact() {
            history_error(conn, session, req_id, history_error::UNAVAILABLE);
            return;
        }
        if epoch != current {
            conn.pages.push_back(Page::empty(session, req_id, current));
            self.flush_deadline = Some(now);
            return;
        }
        let before = before_row.min(s.screen.lines());
        let from = before.saturating_sub(u64::from(max_rows));
        if before == 0 {
            conn.pages.push_back(Page::empty(session, req_id, current));
            self.flush_deadline = Some(now);
            return;
        }
        let rows = s
            .screen
            .history_rows(from, before)
            .or_else(|| self.rebuilds.cached(session, current, from, before, now));
        if let Some(rows) = rows {
            conn.pages
                .push_back(Page::new(session, req_id, current, from, &rows));
            self.flush_deadline = Some(now);
            return;
        }
        let Some((path, pin)) = s.history_source() else {
            history_error(conn, session, req_id, history_error::UNAVAILABLE);
            return;
        };
        self.rebuilds
            .queue
            .retain(|j| !j.cancel.load(std::sync::atomic::Ordering::Relaxed));
        if self.rebuilds.running >= history::MAX_RUNNING
            && self.rebuilds.queue.len() >= history::MAX_QUEUED
        {
            history_error(conn, session, req_id, history_error::BUSY);
            return;
        }
        let token = self.rebuilds.token();
        let cancel = Arc::new(AtomicBool::new(false));
        conn.history = Some(InFlight {
            token,
            session,
            req_id,
            epoch: current,
            before,
            max_rows,
            cancel: cancel.clone(),
        });
        // Keep the rows before the page too: the next pages (older) come from the cache.
        let spec = RebuildSpec {
            path,
            pin,
            from: before.saturating_sub(REBUILD_ROWS.max(u64::from(max_rows))),
            to: before,
        };
        self.rebuilds.queue.push_back(Job {
            token,
            session,
            spec,
            cancel,
        });
        self.start_rebuilds();
    }

    /// Start queued rebuilds while slots are free (cancelled ones are dropped).
    pub(super) fn start_rebuilds(&mut self) {
        while self.rebuilds.running < history::MAX_RUNNING {
            let Some(job) = self.rebuilds.queue.pop_front() else {
                return;
            };
            if job.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                continue;
            }
            self.rebuilds.running += 1;
            let tx = self.control_tx.clone();
            let spawned = std::thread::Builder::new()
                .name("history".into())
                .spawn(move || {
                    // A panic still frees the slot and answers the connection.
                    let built =
                        std::panic::catch_unwind(|| history::rebuild(&job.spec, &job.cancel))
                            .unwrap_or_else(|_| Built::Failed("the rebuild panicked".into()));
                    let _ = tx.send(ControlMsg::HistoryBuilt {
                        token: job.token,
                        built,
                    });
                });
            if let Err(e) = spawned {
                self.cfg
                    .log
                    .warn(&format!("history: cannot start a rebuild ({e})"));
                self.rebuilds.running -= 1;
                return;
            }
        }
    }

    pub(super) fn on_history_built(&mut self, token: u64, built: Built) {
        self.rebuilds.running = self.rebuilds.running.saturating_sub(1);
        self.start_rebuilds();
        let now = Instant::now();
        let Some(conn) = self
            .conns
            .values_mut()
            .find(|c| c.history.as_ref().is_some_and(|h| h.token == token))
        else {
            // Cancelled meanwhile: nobody gets it.
            return;
        };
        let Some(job) = conn.history.take() else {
            return;
        };
        let session = job.session;
        let Some(current) = self.sessions.get(&session).map(|s| s.screen.epoch()) else {
            return;
        };
        if !conn.attachments.contains_key(&session) {
            return;
        }
        if current != job.epoch {
            // The history was erased meanwhile: say so instead of letting the client time out.
            conn.pages
                .push_back(Page::empty(session, job.req_id, current));
            self.flush_deadline = Some(now);
            return;
        }
        match built {
            Built::Rows { first, rows } => {
                self.rebuilds.store(session, job.epoch, first, rows, now);
                let from = job.before.saturating_sub(u64::from(job.max_rows));
                match self
                    .rebuilds
                    .cached(session, job.epoch, from.max(first), job.before, now)
                {
                    Some(rows) => {
                        conn.pages.push_back(Page::new(
                            session,
                            job.req_id,
                            job.epoch,
                            from.max(first),
                            &rows,
                        ));
                        self.flush_deadline = Some(now);
                    }
                    None => history_error(conn, session, job.req_id, history_error::UNAVAILABLE),
                }
            }
            Built::Failed(e) => {
                self.cfg
                    .log
                    .warn(&format!("session {session}: history rebuild failed ({e})"));
                history_error(conn, session, job.req_id, history_error::UNAVAILABLE);
            }
            Built::Cancelled => history_error(conn, session, job.req_id, history_error::CANCELLED),
        }
    }
}
