//! Output delivery: coalescing, the per-attachment window, the relay frame
//! budget, and pausing PTY reads (section 5).

use std::time::{Duration, Instant};

use super::Hub;
use crate::conn::{Attachment, FrameSink, SinkClosed};
use crate::flow::{effective_window, flush_decision, Flush, PathKind, RelayBudget, ECHO_WINDOW};
use crate::history::Page;
use crate::session::{live_snapshot_frames, snapshot_frame, Session};
use crate::wire::{ServerFrame, MAX_OUTPUT_DATA};
use crate::Logger;

/// Skip a connection whose transport already holds this much.
const SINK_HIGH_WATER: usize = 1024 * 1024;
/// Retry delay for a connection above the high-water mark.
const SINK_RETRY: Duration = Duration::from_millis(5);
/// History parts sent to one connection per pass.
const PAGE_PARTS_PER_PASS: usize = 2;
/// A history part waits while the transport holds more than this.
const PAGE_HIGH_WATER: usize = 128 * 1024;
/// When to try the next history parts.
const PAGE_RETRY: Duration = Duration::from_millis(10);

impl Hub {
    /// Send whatever is due on every attachment, then pause or resume each
    /// session's reader according to the windows.
    pub(super) fn flush_all(&mut self, now: Instant) {
        let Hub {
            sessions,
            conns,
            budget,
            scratch,
            flush_deadline,
            cfg,
            ..
        } = self;
        *flush_deadline = None;
        let mut dead = Vec::new();
        for conn in conns.values_mut() {
            let Some(path) = conn.path() else {
                continue;
            };
            let crowded = conn.buffered() > SINK_HIGH_WATER;
            let live = conn.live_history();
            let Some(sink) = conn
                .direct
                .as_deref_mut()
                .or_else(|| conn.relay.as_mut().map(|r| r as &mut dyn FrameSink))
            else {
                continue;
            };
            for (&sid, att) in conn.attachments.iter_mut() {
                let Some(s) = sessions.get_mut(&sid) else {
                    continue;
                };
                if crowded && att.sent < s.end() {
                    merge(flush_deadline, Some(now + SINK_RETRY));
                    continue;
                }
                match flush_attachment(s, att, sink, path, budget, scratch, now, &cfg.log, live) {
                    Ok(next) => merge(flush_deadline, next),
                    Err(SinkClosed) => {
                        dead.push(conn.id);
                        break;
                    }
                }
            }
        }
        // History pages only after every connection's output of this pass,
        // a few parts at a time, and only while the transport is nearly empty
        // and the relay budget is not low: output and echo always go first.
        for conn in conns.values_mut() {
            if conn.pages.is_empty() || dead.contains(&conn.id) {
                continue;
            }
            let Some(path) = conn.path() else {
                continue;
            };
            let mut sent = 0;
            while !conn.pages.is_empty() {
                if sent >= PAGE_PARTS_PER_PASS || conn.buffered() > PAGE_HIGH_WATER {
                    merge(flush_deadline, Some(now + PAGE_RETRY));
                    break;
                }
                // While the budget is low a page takes at most one token per pass.
                if path == PathKind::Relay
                    && ((budget.low(now) && sent > 0) || !budget.try_take(now))
                {
                    merge(
                        flush_deadline,
                        Some(budget.next_token_at(now).max(now + PAGE_RETRY)),
                    );
                    break;
                }
                let Some(sink) = conn
                    .direct
                    .as_deref_mut()
                    .or_else(|| conn.relay.as_mut().map(|r| r as &mut dyn FrameSink))
                else {
                    break;
                };
                let Some(page) = conn.pages.front_mut() else {
                    break;
                };
                match sessions.get(&page.session).map(|s| s.screen.epoch()) {
                    None => {
                        conn.pages.pop_front();
                        continue;
                    }
                    Some(epoch) if epoch != page.epoch => {
                        *page = Page::empty(page.session, page.req_id, epoch);
                    }
                    Some(_) => {}
                }
                if sink.send(&page.frame(page.next)).is_err() {
                    dead.push(conn.id);
                    break;
                }
                sent += 1;
                page.next += 1;
                if page.next >= page.parts.len() {
                    conn.pages.pop_front();
                }
            }
        }
        for s in sessions.values() {
            let end = s.end();
            let mut paused = false;
            for conn in conns.values_mut() {
                if let Some(att) = conn.attachments.get_mut(&s.id) {
                    let window = effective_window(att.window.size(), s.ring.capacity()) as u64;
                    // Read nothing more while a window of output (sent or
                    // waiting to be sent) is unacknowledged.
                    if att.outstanding(end) >= window {
                        paused = true;
                    }
                    // Grow only when the path is the bottleneck: inflight
                    // reached the window. Bytes held by coalescing or the
                    // relay frame budget do not count.
                    if att.sent.saturating_sub(att.acked) >= window {
                        att.window.mark_limited();
                    }
                }
            }
            // An exited session has nothing left to read; a closing one must
            // drain to EOF.
            s.set_paused(paused && s.is_live());
        }
        for id in dead {
            self.close_conn(id, "transport_closed", None);
        }
    }
}

fn merge(slot: &mut Option<Instant>, t: Option<Instant>) {
    if let Some(t) = t {
        *slot = Some(slot.map_or(t, |s| s.min(t)));
    }
}

/// Send the due part of one session's output to one client. Returns when to
/// look again (None: nothing pending or waiting for an Ack). Bytes that left
/// the ring come from the session's output log, at most one window per call,
/// so a long replay advances with the acks and never holds up the hub.
#[allow(clippy::too_many_arguments)]
fn flush_attachment(
    s: &mut Session,
    att: &mut Attachment,
    sink: &mut dyn FrameSink,
    path: PathKind,
    budget: &mut RelayBudget,
    scratch: &mut Vec<u8>,
    now: Instant,
    log: &Logger,
    live: bool,
) -> Result<Option<Instant>, SinkClosed> {
    let end = s.end();
    if att.sent < s.held_start() {
        // Only without an output log: the bytes this client still needs left
        // the ring, so resync with a rendered snapshot (the live one for a
        // client that takes it).
        let mut offset = None;
        if live && s.screen.live_ready() {
            let snap = s.screen.live_snapshot();
            if let Some(frames) = live_snapshot_frames(s.id, &snap) {
                for f in &frames {
                    sink.send(f)?;
                }
                offset = Some(snap.offset);
            }
        }
        let offset = match offset {
            Some(o) => o,
            None => {
                let snap = s.snapshot();
                sink.send(&snapshot_frame(s.id, &snap))?;
                snap.offset
            }
        };
        att.sent = offset;
        att.acked = offset;
        att.clock.reset(offset);
        att.urgent = true;
    }
    let window = effective_window(att.window.size(), s.ring.capacity());
    let limit = end.min(att.acked.saturating_add(window as u64));
    if att.sent < limit {
        let pending = (limit - att.sent) as usize;
        let since = *att.pending_since.get_or_insert(now);
        let echo = att.urgent
            || s.finished
            || s.last_input
                .is_some_and(|t| now.saturating_duration_since(t) < ECHO_WINDOW);
        let low = path == PathKind::Relay && budget.low(now);
        if let Flush::At(t) = flush_decision(path, pending, since, echo, low, now) {
            return Ok(Some(t));
        }
        while att.sent < limit {
            if path == PathKind::Relay && !budget.try_take(now) {
                return Ok(Some(budget.next_token_at(now)));
            }
            scratch.clear();
            let want = ((limit - att.sent) as usize).min(MAX_OUTPUT_DATA);
            let n = match s.read_output_into(att.sent, want, scratch) {
                Ok(n) => n,
                Err(e) => {
                    // The log is dropped now; the next pass resyncs this
                    // client with a rendered snapshot.
                    log.warn(&format!(
                        "session {}: output log unreadable ({e}), dropped; late clients get a rendered snapshot",
                        s.id
                    ));
                    return Ok(Some(now));
                }
            };
            if n == 0 {
                break;
            }
            sink.send(&ServerFrame::Output {
                session: s.id,
                offset: att.sent,
                data: scratch,
            })?;
            att.sent += n as u64;
            att.clock.on_send(att.sent, now);
        }
        att.urgent = false;
    }
    // Bytes held back by the window keep their age so they go out as soon
    // as an Ack opens the window.
    if att.sent >= end {
        att.pending_since = None;
        if s.finished && !att.exit_sent {
            let exit = s.exit.unwrap_or(crate::pty::ExitInfo {
                code: -1,
                signal: 0,
            });
            sink.send(&ServerFrame::Exit {
                session: s.id,
                code: exit.code,
                signal: exit.signal,
            })?;
            att.exit_sent = true;
        }
    }
    Ok(None)
}
