//! One terminal session: its PTY, the raw output ring, the headless screen,
//! and its lifecycle (running, exited, closing).

use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use portable_pty::{MasterPty, PtySize};
use serde_json::{json, Value};

use crate::audit::now_ms;
use crate::pty::{self, ExitInfo, Gate, OpenSpec, ProcessControl, PtyEvent, WriteJob};
use crate::ring::Ring;
use crate::screen::{Screen, Snapshot};

/// Default and smallest raw output ring per session.
pub const DEFAULT_RING_BYTES: usize = 1024 * 1024;
/// The smallest ring still leaves the minimum window plus headroom.
pub const MIN_RING_BYTES: usize = 256 * 1024;
/// Most sessions per daemon.
pub const MAX_SESSIONS: usize = 20;
/// After the process exits, wait this long for the last output before
/// sending Exit (a background job may keep the PTY open).
pub const EXIT_DRAIN: Duration = Duration::from_millis(300);
/// After asking a process to hang up, kill it outright after this long.
pub const KILL_GRACE: Duration = Duration::from_secs(2);

/// How to resume a client that sent `Attach{lastOffset}` (section 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachPlan {
    /// Send `Output` from this offset on.
    Replay { from: u64 },
    /// Send a `Snapshot`, then `Output` from the snapshot offset.
    Snapshot,
}

pub fn attach_plan(last_offset: u64, ring: &Ring) -> AttachPlan {
    if last_offset > 0 && ring.holds_from(last_offset) {
        AttachPlan::Replay { from: last_offset }
    } else {
        AttachPlan::Snapshot
    }
}

pub struct Session {
    pub id: u32,
    pub created_at: u64,
    pub cols: u16,
    pub rows: u16,
    pub ring: Ring,
    pub screen: Screen,
    /// Last Input from any client (echo path of the coalescing rules).
    pub last_input: Option<Instant>,
    pub exit: Option<ExitInfo>,
    pub eof: bool,
    /// Exit is reported at this time even without EOF.
    pub finalize_at: Option<Instant>,
    /// Exit has been reported.
    pub finished: bool,
    /// Remove the session once it has finished.
    pub close_requested: bool,
    pub kill_at: Option<Instant>,
    master: Box<dyn MasterPty + Send>,
    writer: Option<Sender<WriteJob>>,
    gate: Arc<Gate>,
    process: ProcessControl,
    foreground: Option<i32>,
}

impl Session {
    pub fn open(
        id: u32,
        spec: &OpenSpec,
        ring_bytes: usize,
        events: Sender<PtyEvent>,
    ) -> Result<Session, String> {
        let p = pty::spawn(id, spec, events)?;
        Ok(Session {
            id,
            created_at: now_ms(),
            cols: spec.cols,
            rows: spec.rows,
            ring: Ring::new(ring_bytes.max(MIN_RING_BYTES)),
            screen: Screen::new(spec.rows, spec.cols),
            last_input: None,
            exit: None,
            eof: false,
            finalize_at: None,
            finished: false,
            close_requested: false,
            kill_at: None,
            master: p.master,
            writer: Some(p.writer),
            gate: p.gate,
            process: p.process,
            foreground: None,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.process.pid()
    }

    /// Offset one past the newest output byte.
    pub fn end(&self) -> u64 {
        self.ring.end()
    }

    /// New raw output from the reader thread, in stream order.
    pub fn ingest(&mut self, data: &[u8]) {
        self.ring.push(data);
        self.screen.process(data);
        self.gate.consumed(data.len());
    }

    /// Queue keystrokes for the PTY. False when the session no longer takes input.
    pub fn write(&mut self, job: WriteJob, now: Instant) -> bool {
        self.last_input = Some(now);
        match &self.writer {
            Some(w) => w.send(job).is_ok(),
            None => false,
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))?;
        self.screen.resize(rows, cols);
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        self.screen.snapshot()
    }

    pub fn set_paused(&self, paused: bool) {
        self.gate.set_paused(paused);
    }

    pub fn is_paused(&self) -> bool {
        self.gate.is_paused()
    }

    /// The process is running and the session takes new clients.
    pub fn is_live(&self) -> bool {
        self.exit.is_none() && !self.close_requested
    }

    /// Start closing: hang up the shell and its foreground job; force-kill
    /// later if needed (`kill_at`).
    pub fn hangup(&mut self, now: Instant) {
        self.close_requested = true;
        if self.exit.is_some() {
            return;
        }
        #[cfg(unix)]
        {
            self.foreground = self.master.process_group_leader();
        }
        self.process.hangup(self.foreground);
        self.writer = None;
        // Reading stays allowed so the reader drains to EOF and exits.
        self.gate.set_paused(false);
        self.kill_at = Some(now + KILL_GRACE);
    }

    pub fn force_kill(&mut self) {
        self.kill_at = None;
        if self.exit.is_none() {
            self.process.force_kill(self.foreground);
        }
    }

    /// Stop the reader thread for good (session removed).
    pub fn release(&mut self) {
        self.writer = None;
        self.gate.close();
    }

    pub fn info(&self, attached: bool) -> Value {
        let mut v = json!({
            "session": self.id,
            "title": self.screen.title(),
            "cols": self.cols,
            "rows": self.rows,
            "createdAt": self.created_at,
            "attached": attached,
        });
        if let Some(e) = self.exit {
            v["exited"] = json!({ "code": e.code, "signal": e.signal });
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a client shows after resuming with `last` applied bytes.
    fn resume(ring: &Ring, screen: &Screen, applied: &[u8]) -> String {
        let last = applied.len() as u64;
        let mut client = vt100::Parser::new(24, 80, 0);
        match attach_plan(last, ring) {
            AttachPlan::Replay { from } => {
                client.process(applied);
                let mut rest = Vec::new();
                ring.read_into(from, usize::MAX, &mut rest);
                client.process(&rest);
            }
            AttachPlan::Snapshot => {
                let snap = screen.snapshot();
                client.process(&snap.vt);
                let mut rest = Vec::new();
                assert!(ring.holds_from(snap.offset));
                ring.read_into(snap.offset, usize::MAX, &mut rest);
                client.process(&rest);
            }
        }
        client.screen().contents()
    }

    #[test]
    fn attach_plan_replays_only_when_ring_holds_the_offset() {
        let mut ring = Ring::new(100);
        ring.push(&[b'a'; 150]);
        assert_eq!(attach_plan(0, &ring), AttachPlan::Snapshot);
        assert_eq!(attach_plan(49, &ring), AttachPlan::Snapshot);
        assert_eq!(attach_plan(50, &ring), AttachPlan::Replay { from: 50 });
        assert_eq!(attach_plan(150, &ring), AttachPlan::Replay { from: 150 });
        assert_eq!(attach_plan(151, &ring), AttachPlan::Snapshot);
    }

    #[test]
    fn reattach_shows_the_same_screen_with_no_gap_or_overlap() {
        let mut stream = Vec::new();
        for i in 0..400 {
            stream.extend_from_slice(format!("\x1b[3{}mdòng {i}\x1b[0m\r\n", i % 8).as_bytes());
        }
        let mut ring = Ring::new(2000);
        let mut screen = Screen::new(24, 80);
        for chunk in stream.chunks(333) {
            ring.push(chunk);
            screen.process(chunk);
        }
        let mut reference = vt100::Parser::new(24, 80, 0);
        reference.process(&stream);
        let want = reference.screen().contents();
        // Replay (recent offset), snapshot (offset 0 and an offset that left
        // the ring) all converge on the same screen.
        for applied in [stream.len() - 10, stream.len(), 0, 5] {
            assert_eq!(
                resume(&ring, &screen, &stream[..applied]),
                want,
                "applied {applied}"
            );
        }
    }
}
