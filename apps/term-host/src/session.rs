//! One terminal session: its PTY, the raw output (in-memory ring plus the
//! on-disk log of every byte), the headless screen, and its lifecycle
//! (running, exited, closing).

use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use portable_pty::{MasterPty, PtySize};
use serde_json::{json, Value};

use crate::audit::now_ms;
use crate::output_log::OutputLog;
use crate::pty::{self, ExitInfo, Gate, OpenSpec, ProcessControl, PtyEvent, WriteJob};
use crate::ring::Ring;
use crate::screen::{Screen, Snapshot};
use crate::wire::{ServerFrame, MAX_DIM, MIN_DIM};

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
    /// Send the stream-start `Snapshot` (offset 0, just RIS), then `Output`
    /// from 0: the client gets every byte the program ever wrote.
    FromStart,
    /// Fallback when bytes before the requested offset are gone (the output
    /// log failed and the ring wrapped): a `Snapshot` rendered by the
    /// headless screen, then `Output` from its offset.
    Rendered,
}

/// `held_start` is the oldest offset the session can still serve (0 while
/// its output log is intact), `end` one past the newest byte.
pub fn attach_plan(last_offset: u64, held_start: u64, end: u64) -> AttachPlan {
    if last_offset > 0 && last_offset >= held_start && last_offset <= end {
        AttachPlan::Replay { from: last_offset }
    } else if held_start == 0 {
        AttachPlan::FromStart
    } else {
        AttachPlan::Rendered
    }
}

/// The first `Snapshot` of a full replay: it only resets the client (RIS) so
/// the `Output` from offset 0 lands on a clean terminal. It carries the
/// session's current size, the size the client fits to right after anyway,
/// so the client's resize does not make the program redraw for another size.
pub fn stream_start_snapshot(cols: u16, rows: u16) -> Snapshot {
    Snapshot {
        offset: 0,
        cols: cols.clamp(MIN_DIM, MAX_DIM),
        rows: rows.clamp(MIN_DIM, MAX_DIM),
        alt_screen: false,
        vt: b"\x1bc".to_vec(),
    }
}

pub fn snapshot_frame(session: u32, snap: &Snapshot) -> ServerFrame<'_> {
    ServerFrame::Snapshot {
        session,
        offset: snap.offset,
        cols: snap.cols,
        rows: snap.rows,
        alt_screen: snap.alt_screen,
        vt: &snap.vt,
    }
}

/// Output bytes from `from`, at most `max`, appended to `out`: from the ring
/// when it still holds `from`, else from the log. Returns how many (0 when
/// `from` is not held). Errors come from the log only.
pub fn read_output(
    ring: &Ring,
    log: Option<&mut OutputLog>,
    from: u64,
    max: usize,
    out: &mut Vec<u8>,
) -> io::Result<usize> {
    if ring.holds_from(from) {
        return Ok(ring.read_into(from, max, out));
    }
    match log {
        Some(log) => log.read_into(from, max, out),
        None => Ok(0),
    }
}

pub struct Session {
    pub id: u32,
    pub created_at: u64,
    pub cols: u16,
    pub rows: u16,
    /// Fast in-memory tail of the output.
    pub ring: Ring,
    /// Every output byte since the session opened. None when it could not
    /// be created or failed later: the session then falls back to what the
    /// ring holds and to rendered snapshots (`AttachPlan::Rendered`).
    log: Option<OutputLog>,
    /// Window title for `list`, and the rendered snapshot of the fallback.
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
        log: Option<OutputLog>,
        events: Sender<PtyEvent>,
    ) -> Result<Session, String> {
        let p = pty::spawn(id, spec, events)?;
        Ok(Session {
            id,
            created_at: now_ms(),
            cols: spec.cols,
            rows: spec.rows,
            ring: Ring::new(ring_bytes.max(MIN_RING_BYTES)),
            log,
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

    /// Oldest offset still served byte-exactly: 0 while the output log is
    /// intact, else the start of the ring.
    pub fn held_start(&self) -> u64 {
        if self.log.is_some() {
            0
        } else {
            self.ring.start()
        }
    }

    /// New raw output from the reader thread, in stream order. An error means
    /// the output log just failed and was dropped: the bytes are still in the
    /// ring and the screen, and the session goes on in the fallback mode.
    pub fn ingest(&mut self, data: &[u8]) -> io::Result<()> {
        self.ring.push(data);
        self.screen.process(data);
        self.gate.consumed(data.len());
        let res = match self.log.as_mut() {
            Some(log) => log.append(data),
            None => Ok(()),
        };
        if res.is_err() {
            self.log = None;
        }
        res
    }

    /// See [`read_output`]. A log error drops the log (fallback mode).
    pub fn read_output_into(
        &mut self,
        from: u64,
        max: usize,
        out: &mut Vec<u8>,
    ) -> io::Result<usize> {
        let res = read_output(&self.ring, self.log.as_mut(), from, max, out);
        if res.is_err() {
            self.log = None;
        }
        res
    }

    pub fn start_snapshot(&self) -> Snapshot {
        stream_start_snapshot(self.cols, self.rows)
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
    /// Also deletes the output log.
    pub fn release(&mut self) {
        self.writer = None;
        self.gate.close();
        self.log = None;
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
    use crate::output_log::prepare_dir;
    use crate::screen::SCROLLBACK_ROWS;
    use crate::wire::MAX_OUTPUT_DATA;

    /// `rows` lines (callers pass more than the headless screen keeps),
    /// colours, wide characters and ED3 full redraws in the middle.
    fn long_stream(rows: usize) -> Vec<u8> {
        let mut stream = Vec::new();
        for i in 0..rows {
            stream
                .extend_from_slice(format!("\x1b[3{}mdòng {i} 漢字\x1b[0m\r\n", i % 8).as_bytes());
            if i % 700 == 699 {
                stream.extend_from_slice(b"\x1b[2J\x1b[3J\x1b[H");
            }
        }
        stream
    }

    /// Ring + log fed the way `Session::ingest` feeds them.
    fn feed(ring_bytes: usize, stream: &[u8], dir: &std::path::Path) -> (Ring, OutputLog) {
        let mut ring = Ring::new(ring_bytes);
        let Ok(mut log) = OutputLog::create(dir, 1) else {
            panic!("create log")
        };
        for chunk in stream.chunks(333) {
            ring.push(chunk);
            assert!(log.append(chunk).is_ok());
        }
        (ring, log)
    }

    /// What a client receives from `from` on, frame by frame as the hub sends it.
    fn drain(ring: &Ring, log: &mut OutputLog, from: u64, out: &mut Vec<u8>) {
        let mut at = from;
        while at < ring.end() {
            let n = read_output(ring, Some(&mut *log), at, MAX_OUTPUT_DATA, out).unwrap_or(0);
            assert!(n > 0, "stalled at {at}");
            at += n as u64;
        }
    }

    #[test]
    fn attach_plan_replays_every_held_offset_and_restarts_otherwise() {
        // Log intact: everything from 0 is held.
        assert_eq!(attach_plan(0, 0, 150), AttachPlan::FromStart);
        assert_eq!(attach_plan(1, 0, 150), AttachPlan::Replay { from: 1 });
        assert_eq!(attach_plan(150, 0, 150), AttachPlan::Replay { from: 150 });
        assert_eq!(attach_plan(151, 0, 150), AttachPlan::FromStart);
        // Log lost: only what the ring holds, rendered snapshot otherwise.
        assert_eq!(attach_plan(0, 50, 150), AttachPlan::Rendered);
        assert_eq!(attach_plan(49, 50, 150), AttachPlan::Rendered);
        assert_eq!(attach_plan(50, 50, 150), AttachPlan::Replay { from: 50 });
        assert_eq!(attach_plan(151, 50, 150), AttachPlan::Rendered);
    }

    #[test]
    fn fresh_attach_replays_every_byte_from_offset_zero() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir")
        };
        let stream = long_stream(SCROLLBACK_ROWS * 20);
        let (ring, mut log) = feed(MIN_RING_BYTES, &stream, &dir);
        assert!(stream.len() > MIN_RING_BYTES && ring.start() > 0);
        assert_eq!(attach_plan(0, 0, ring.end()), AttachPlan::FromStart);
        let snap = stream_start_snapshot(80, 24);
        assert_eq!((snap.offset, snap.alt_screen), (0, false));
        let mut got = snap.vt.clone();
        drain(&ring, &mut log, snap.offset, &mut got);
        let mut want = b"\x1bc".to_vec();
        want.extend_from_slice(&stream);
        assert!(got == want, "replay differs from RIS + the full stream");
    }

    #[test]
    fn client_behind_the_ring_is_served_from_the_log_byte_exactly() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir")
        };
        let stream = long_stream(SCROLLBACK_ROWS * 4);
        let (ring, mut log) = feed(2000, &stream, &dir);
        for applied in [
            1,
            5,
            333,
            ring.start() as usize - 1,
            ring.start() as usize,
            stream.len() - 10,
        ] {
            let from = applied as u64;
            assert_eq!(
                attach_plan(from, 0, ring.end()),
                AttachPlan::Replay { from }
            );
            let mut got = Vec::new();
            drain(&ring, &mut log, from, &mut got);
            assert!(got[..] == stream[applied..], "from {applied}");
        }
    }

    #[test]
    fn without_a_log_only_the_ring_is_served() {
        let mut ring = Ring::new(100);
        ring.push(&[b'a'; 150]);
        let mut out = Vec::new();
        assert_eq!(read_output(&ring, None, 10, 100, &mut out).ok(), Some(0));
        assert_eq!(read_output(&ring, None, 60, 100, &mut out).ok(), Some(90));
        // The ring has not wrapped yet: offset 0 is still held.
        let mut young = Ring::new(100);
        young.push(b"abc");
        assert_eq!(
            attach_plan(0, young.start(), young.end()),
            AttachPlan::FromStart
        );
    }
}
