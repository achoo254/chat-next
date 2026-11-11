//! PTY processes: spawn, the reader / writer / waiter threads, the read gate
//! used by flow control, and process termination.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;

use crossbeam_channel::{Receiver, Sender};
#[cfg(windows)]
use portable_pty::ChildKiller;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::flow::READ_CHUNK;

/// Most bytes read from the PTY but not yet taken by the hub. Bounds memory
/// when the hub is busy; flow control pauses reading well before this.
const MAX_QUEUED: usize = 4 * READ_CHUNK;

/// What to run in a new session.
#[derive(Debug, Clone, Default)]
pub struct OpenSpec {
    pub cols: u16,
    pub rows: u16,
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub claude_config_dir: Option<String>,
}

/// How a session's process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    /// Exit code, or -1 when killed by a signal.
    pub code: i32,
    /// Signal number, 0 when none.
    pub signal: u8,
}

/// Events from the PTY threads to the hub.
#[derive(Debug)]
pub enum PtyEvent {
    Output { session: u32, data: Vec<u8> },
    Eof { session: u32 },
    Exited { session: u32, exit: ExitInfo },
}

/// Bytes to write to a PTY: `buf[start..]`. Lets the hub forward the frame it
/// received without copying the keystrokes out of it.
pub struct WriteJob {
    pub buf: Vec<u8>,
    pub start: usize,
}

#[derive(Default)]
struct GateState {
    paused: bool,
    queued: usize,
    closed: bool,
}

/// Lets the hub stop and resume the reader thread of a session.
#[derive(Default)]
pub struct Gate {
    state: Mutex<GateState>,
    cv: Condvar,
}

impl Gate {
    fn lock(&self) -> MutexGuard<'_, GateState> {
        // A poisoned gate only means a thread panicked while holding three
        // plain fields; the values are still meaningful.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_paused(&self, paused: bool) {
        let mut s = self.lock();
        if s.paused != paused {
            s.paused = paused;
            if !paused {
                self.cv.notify_all();
            }
        }
    }

    pub fn is_paused(&self) -> bool {
        self.lock().paused
    }

    /// The hub took `n` bytes from the reader.
    pub fn consumed(&self, n: usize) {
        let mut s = self.lock();
        s.queued = s.queued.saturating_sub(n);
        self.cv.notify_all();
    }

    pub fn close(&self) {
        let mut s = self.lock();
        s.closed = true;
        self.cv.notify_all();
    }

    /// Block until reading is allowed; false once closed.
    fn wait_ready(&self) -> bool {
        let mut s = self.lock();
        while !s.closed && (s.paused || s.queued >= MAX_QUEUED) {
            s = self.cv.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        !s.closed
    }

    fn produced(&self, n: usize) {
        self.lock().queued += n;
    }
}

/// A spawned PTY process with its threads running.
pub struct Pty {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Sender<WriteJob>,
    pub gate: Arc<Gate>,
    pub process: ProcessControl,
}

/// Default shell: the login shell on POSIX ($SHELL, else the password
/// database, else /bin/sh, started as a login shell by portable-pty).
#[cfg(unix)]
fn default_command() -> CommandBuilder {
    CommandBuilder::new_default_prog()
}

/// Default shell on Windows: pwsh, then powershell, then cmd.
#[cfg(windows)]
fn default_command() -> CommandBuilder {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for exe in ["pwsh.exe", "powershell.exe"] {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return CommandBuilder::new(candidate);
            }
        }
    }
    let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
    CommandBuilder::new(comspec)
}

fn command(spec: &OpenSpec) -> CommandBuilder {
    let mut cmd = match &spec.shell {
        Some(shell) => {
            let mut c = CommandBuilder::new(shell);
            c.args(&spec.args);
            c
        }
        None => default_command(),
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = &spec.claude_config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    cmd
}

/// Spawn the process on a new PTY and start its reader, writer and waiter
/// threads. Events go to `events`.
pub fn spawn(session: u32, spec: &OpenSpec, events: Sender<PtyEvent>) -> Result<Pty, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let child = pair
        .slave
        .spawn_command(command(spec))
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Keep no slave handle: the reader must see EOF when the process exits.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;

    let gate = Arc::new(Gate::default());
    let (write_tx, write_rx) = crossbeam_channel::unbounded::<WriteJob>();
    let process = ProcessControl {
        pid: child.process_id(),
        #[cfg(windows)]
        killer: child.clone_killer(),
    };

    let spawned = thread::Builder::new()
        .name(format!("pty-w-{session}"))
        .spawn(move || writer_loop(writer, write_rx))
        .and_then(|_| {
            let gate = gate.clone();
            let events = events.clone();
            let answer = write_tx.clone();
            thread::Builder::new()
                .name(format!("pty-r-{session}"))
                .spawn(move || reader_loop(session, reader, gate, events, answer))
        })
        .and_then(|_| {
            thread::Builder::new()
                .name(format!("pty-wait-{session}"))
                .spawn(move || waiter(session, child, events))
        });
    if let Err(e) = spawned {
        let mut process = process;
        process.hangup(None);
        process.force_kill(None);
        return Err(format!("thread spawn failed: {e}"));
    }
    Ok(Pty {
        master: pair.master,
        writer: write_tx,
        gate,
        process,
    })
}

fn writer_loop(mut writer: Box<dyn Write + Send>, jobs: Receiver<WriteJob>) {
    for job in jobs.iter() {
        let bytes = job.buf.get(job.start..).unwrap_or_default();
        if writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn reader_loop(
    session: u32,
    mut reader: Box<dyn Read + Send>,
    gate: Arc<Gate>,
    events: Sender<PtyEvent>,
    answer: Sender<WriteJob>,
) {
    let mut buf = vec![0u8; READ_CHUNK];
    // ConPTY sends a cursor position query at startup and accepts no input
    // until the host answers it; only the first one is ours to answer.
    let mut startup_query_pending = cfg!(windows);
    while gate.wait_ready() {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let mut data = buf[..n].to_vec();
                if startup_query_pending && take_startup_dsr(&mut data) {
                    startup_query_pending = false;
                    let _ = answer.send(WriteJob {
                        buf: b"\x1b[1;1R".to_vec(),
                        start: 0,
                    });
                }
                if data.is_empty() {
                    continue;
                }
                gate.produced(data.len());
                if events.send(PtyEvent::Output { session, data }).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // EIO on macOS/Linux once the process side is gone.
            Err(_) => break,
        }
    }
    let _ = events.send(PtyEvent::Eof { session });
}

/// Remove the first `ESC[6n` (device status report, cursor position) from
/// `data`. Returns whether one was found. Used for the ConPTY startup query,
/// which must be answered by the host and must not reach clients (their
/// terminal would answer it a second time).
pub fn take_startup_dsr(data: &mut Vec<u8>) -> bool {
    const DSR: &[u8] = b"\x1b[6n";
    match data.windows(DSR.len()).position(|w| w == DSR) {
        Some(at) => {
            data.drain(at..at + DSR.len());
            true
        }
        None => false,
    }
}

#[cfg(unix)]
fn waiter(session: u32, child: Box<dyn Child + Send + Sync>, events: Sender<PtyEvent>) {
    use nix::sys::wait::{waitpid, WaitStatus};
    use nix::unistd::Pid;
    let exit = match child.process_id() {
        Some(pid) => loop {
            match waitpid(Pid::from_raw(pid as i32), None) {
                Ok(WaitStatus::Exited(_, code)) => break ExitInfo { code, signal: 0 },
                Ok(WaitStatus::Signaled(_, sig, _)) => {
                    break ExitInfo {
                        code: -1,
                        signal: sig as i32 as u8,
                    }
                }
                Ok(_) => continue,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(_) => {
                    break ExitInfo {
                        code: -1,
                        signal: 0,
                    }
                }
            }
        },
        None => ExitInfo {
            code: -1,
            signal: 0,
        },
    };
    // The process is reaped; the Child handle has nothing left to do.
    drop(child);
    let _ = events.send(PtyEvent::Exited { session, exit });
}

#[cfg(windows)]
fn waiter(session: u32, mut child: Box<dyn Child + Send + Sync>, events: Sender<PtyEvent>) {
    let exit = match child.wait() {
        Ok(status) => ExitInfo {
            code: status.exit_code() as i32,
            signal: 0,
        },
        Err(_) => ExitInfo {
            code: -1,
            signal: 0,
        },
    };
    let _ = events.send(PtyEvent::Exited { session, exit });
}

/// Terminates a session's processes.
pub struct ProcessControl {
    pid: Option<u32>,
    /// TerminateProcess handle; POSIX signals the pid directly.
    #[cfg(windows)]
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl ProcessControl {
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Ask politely: SIGHUP to the shell and to the foreground job on POSIX,
    /// TerminateProcess on Windows.
    pub fn hangup(&mut self, foreground: Option<i32>) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, killpg, Signal};
            use nix::unistd::Pid;
            if let Some(pgrp) = foreground.filter(|&p| p > 1) {
                let _ = killpg(Pid::from_raw(pgrp), Signal::SIGHUP);
            }
            if let Some(pid) = self.pid {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGHUP);
            }
        }
        #[cfg(windows)]
        {
            let _ = foreground;
            let _ = self.killer.kill();
        }
    }

    /// Kill outright whatever is left of the shell and the foreground job.
    pub fn force_kill(&mut self, foreground: Option<i32>) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, killpg, Signal};
            use nix::unistd::Pid;
            if let Some(pgrp) = foreground.filter(|&p| p > 1) {
                let _ = killpg(Pid::from_raw(pgrp), Signal::SIGKILL);
            }
            if let Some(pid) = self.pid {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = foreground;
            let _ = self.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_dsr_is_removed_once() {
        let mut v = b"\x1b[?25l\x1b[6n\x1b[2J".to_vec();
        assert!(take_startup_dsr(&mut v));
        assert_eq!(v, b"\x1b[?25l\x1b[2J");
        assert!(!take_startup_dsr(&mut v));
        let mut only = b"\x1b[6n".to_vec();
        assert!(take_startup_dsr(&mut only));
        assert!(only.is_empty());
    }

    #[test]
    fn gate_blocks_until_resumed() {
        let gate = Arc::new(Gate::default());
        gate.set_paused(true);
        let g = gate.clone();
        let t = thread::spawn(move || g.wait_ready());
        thread::sleep(std::time::Duration::from_millis(50));
        assert!(!t.is_finished());
        gate.set_paused(false);
        assert!(t.join().unwrap_or(false));
        gate.close();
        assert!(!gate.wait_ready());
    }

    #[test]
    fn gate_bounds_queued_bytes() {
        let gate = Gate::default();
        gate.produced(MAX_QUEUED);
        let g = Arc::new(gate);
        let g2 = g.clone();
        let t = thread::spawn(move || g2.wait_ready());
        thread::sleep(std::time::Duration::from_millis(50));
        assert!(!t.is_finished());
        g.consumed(READ_CHUNK);
        assert!(t.join().unwrap_or(false));
    }
}
