//! Local control channel between the agent and the daemon (section 6):
//! socket framing, the authenticated link to one agent, and the platform
//! transports (Unix domain socket, Windows named pipe).

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use serde_json::{json, Value};

use crate::commands::{self, HelloParams};
use crate::Logger;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{connect, peer_allowed, Listener, Stream};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::restrict_to_owner;
#[cfg(windows)]
pub use windows::{connect, Listener, Stream};

/// Largest socket frame (`kind` + payload).
pub const MAX_SOCKET_FRAME: usize = 1024 * 1024;
pub const KIND_JSON: u8 = 0;
pub const KIND_RELAY: u8 = 1;
/// The first command must arrive within this long.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// An agent that stops reading for this long is dropped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Messages from control threads to the hub (high priority).
pub enum ControlMsg {
    /// An agent passed the token check.
    AgentHello {
        id: Value,
        params: HelloParams,
        tx: AgentTx,
        link: AgentLink,
    },
    /// A JSON command from the current agent (still unparsed).
    Command {
        link: u64,
        body: Vec<u8>,
    },
    /// A relay frame: `buf[4..]` is one terminal frame for `conn`.
    Relay {
        link: u64,
        conn: u32,
        buf: Vec<u8>,
    },
    AgentGone {
        link: u64,
    },
    /// From the thread of direct peer `peer` of connection `conn`.
    Peer {
        conn: u32,
        peer: u64,
        event: crate::rtc::PeerEvent,
    },
    /// Stop requested (signal or embedding code).
    Stop,
}

/// Sends socket frames to one agent without blocking the caller.
#[derive(Clone)]
pub struct AgentTx {
    link: u64,
    tx: Sender<Vec<u8>>,
    buffered: Arc<AtomicUsize>,
}

impl AgentTx {
    pub fn link(&self) -> u64 {
        self.link
    }

    /// Queue an already framed buffer. False when the link is gone.
    pub fn send_raw(&self, buf: Vec<u8>) -> bool {
        let n = buf.len();
        self.buffered.fetch_add(n, Ordering::Relaxed);
        if self.tx.send(buf).is_ok() {
            true
        } else {
            self.buffered.fetch_sub(n, Ordering::Relaxed);
            false
        }
    }

    pub fn send_json(&self, v: &Value) -> bool {
        self.send_raw(json_frame(v))
    }

    pub fn buffered(&self) -> usize {
        self.buffered.load(Ordering::Relaxed)
    }
}

/// Owner side of an agent link: closes the socket and waits for the writer.
pub struct AgentLink {
    pub id: u64,
    closer: Stream,
    writer: Option<JoinHandle<()>>,
}

impl AgentLink {
    /// Close the socket now (replaced agent, shutdown).
    pub fn close(mut self) {
        self.closer.shutdown();
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }

    /// Let queued frames go out (all `AgentTx` clones must be dropped
    /// first), then close.
    pub fn finish(mut self) {
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
        self.closer.shutdown();
    }
}

/// Start a socket frame of `kind`; `finish_frame` fills in the length.
fn begin_frame(buf: &mut Vec<u8>, kind: u8) {
    buf.extend_from_slice(&[0, 0, 0, 0, kind]);
}

/// Start a relay frame for `conn`; the terminal frame is appended next.
pub fn begin_relay_frame(buf: &mut Vec<u8>, conn: u32) {
    begin_frame(buf, KIND_RELAY);
    buf.extend_from_slice(&conn.to_be_bytes());
}

/// Write the length prefix of a frame started with `begin_*`.
pub fn finish_frame(buf: &mut [u8]) {
    let len = (buf.len().saturating_sub(4)) as u32;
    if let Some(prefix) = buf.get_mut(..4) {
        prefix.copy_from_slice(&len.to_be_bytes());
    }
}

pub fn json_frame(v: &Value) -> Vec<u8> {
    let mut buf = Vec::with_capacity(128);
    begin_frame(&mut buf, KIND_JSON);
    // Serializing a Value into a Vec cannot fail.
    let _ = serde_json::to_writer(&mut buf, v);
    finish_frame(&mut buf);
    buf
}

/// Errors reading a socket frame.
#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// Length 0 or above `MAX_SOCKET_FRAME`: the stream cannot be resynced.
    BadLength(u32),
}

/// Read one socket frame. `Ok(None)` on clean EOF before a frame.
pub fn read_frame(r: &mut impl Read) -> Result<Option<(u8, Vec<u8>)>, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(FrameError::Io(e)),
    }
    let len = u32::from_be_bytes(len);
    if len == 0 || len as usize > MAX_SOCKET_FRAME {
        return Err(FrameError::BadLength(len));
    }
    let mut kind = [0u8; 1];
    r.read_exact(&mut kind).map_err(FrameError::Io)?;
    let mut payload = vec![0u8; len as usize - 1];
    r.read_exact(&mut payload).map_err(FrameError::Io)?;
    Ok(Some((kind[0], payload)))
}

/// Write one socket frame (used by the headless client).
pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let len = (payload.len() + 1) as u32;
    let mut buf = Vec::with_capacity(payload.len() + 5);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.push(kind);
    buf.extend_from_slice(payload);
    w.write_all(&buf)?;
    w.flush()
}

pub fn error_reply(id: &Value, code: &str, message: &str) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": code, "message": message } })
}

pub fn ok_reply(id: &Value, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result })
}

static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

/// Serve one accepted, peer-checked connection on its own thread.
pub fn spawn_link(stream: Stream, token: Arc<str>, hub: Sender<ControlMsg>, log: Logger) {
    let spawned = thread::Builder::new()
        .name("control-link".into())
        .spawn(move || serve_link(stream, &token, hub, &log));
    if spawned.is_err() {
        // Out of threads: the connection is dropped and the agent retries.
    }
}

fn serve_link(stream: Stream, token: &str, hub: Sender<ControlMsg>, log: &Logger) {
    let mut reader = stream;
    reader.set_read_timeout(Some(HELLO_TIMEOUT));
    let first = match read_frame(&mut reader) {
        Ok(Some(f)) => f,
        Ok(None) | Err(_) => {
            log.info("control: client left before hello");
            return;
        }
    };
    let (writer, closer) = match (reader.try_clone(), reader.try_clone()) {
        (Ok(w), Ok(c)) => (w, c),
        _ => {
            log.warn("control: could not clone the control stream");
            return;
        }
    };
    let hello = if first.0 == KIND_JSON {
        commands::parse_hello(&first.1, token)
    } else {
        Err(commands::HelloReject::NotHello)
    };
    let (id, params) = match hello {
        Ok(v) => v,
        Err(reject) => {
            log.warn(&format!("control: rejected client ({})", reject.reason()));
            let mut w = writer;
            let reply = json_frame(&error_reply(&reject.id(), reject.code(), reject.reason()));
            let _ = w.write_all(&reply).and_then(|_| w.flush());
            reader.shutdown();
            return;
        }
    };
    reader.set_read_timeout(None);
    writer.set_write_timeout(Some(WRITE_TIMEOUT));

    let link = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = crossbeam_channel::unbounded::<Vec<u8>>();
    let buffered = Arc::new(AtomicUsize::new(0));
    let writer_handle = {
        let buffered = buffered.clone();
        thread::Builder::new()
            .name("control-write".into())
            .spawn(move || writer_loop(writer, rx, buffered))
    };
    let Ok(writer_handle) = writer_handle else {
        log.warn("control: could not start the writer thread");
        return;
    };
    let agent_tx = AgentTx { link, tx, buffered };
    let agent_link = AgentLink {
        id: link,
        closer,
        writer: Some(writer_handle),
    };
    if hub
        .send(ControlMsg::AgentHello {
            id,
            params,
            tx: agent_tx,
            link: agent_link,
        })
        .is_err()
    {
        return;
    }

    loop {
        match read_frame(&mut reader) {
            Ok(Some((KIND_JSON, body))) => {
                if hub.send(ControlMsg::Command { link, body }).is_err() {
                    break;
                }
            }
            Ok(Some((KIND_RELAY, buf))) => {
                if buf.len() < 4 {
                    log.warn("control: relay frame without a connection id");
                    continue;
                }
                let conn = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
                if hub.send(ControlMsg::Relay { link, conn, buf }).is_err() {
                    break;
                }
            }
            // Unknown kinds come from a newer agent of the same major: skip.
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(FrameError::BadLength(n)) => {
                log.warn(&format!("control: bad frame length {n}, closing"));
                break;
            }
            Err(FrameError::Io(_)) => break,
        }
    }
    reader.shutdown();
    let _ = hub.send(ControlMsg::AgentGone { link });
}

fn writer_loop(mut w: Stream, rx: Receiver<Vec<u8>>, buffered: Arc<AtomicUsize>) {
    for buf in rx.iter() {
        let n = buf.len();
        let ok = w.write_all(&buf).is_ok();
        buffered.fetch_sub(n, Ordering::Relaxed);
        if !ok {
            w.shutdown();
            // Drain so senders see the link as alive-but-dropping until the
            // hub learns it is gone from the reader side.
            for buf in rx.iter() {
                buffered.fetch_sub(buf.len(), Ordering::Relaxed);
            }
            return;
        }
    }
}

/// Constant-time comparison for the token.
pub fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, KIND_JSON, br#"{"id":1}"#).unwrap_or_default();
        write_frame(&mut buf, KIND_RELAY, &[0, 0, 0, 7, 0x15]).unwrap_or_default();
        let mut r = &buf[..];
        assert_eq!(
            read_frame(&mut r).ok().flatten(),
            Some((KIND_JSON, br#"{"id":1}"#.to_vec()))
        );
        assert_eq!(
            read_frame(&mut r).ok().flatten(),
            Some((KIND_RELAY, vec![0, 0, 0, 7, 0x15]))
        );
        assert!(matches!(read_frame(&mut r), Ok(None)));
    }

    #[test]
    fn socket_frame_lengths_are_bounded() {
        let zero = [0u8, 0, 0, 0];
        assert!(matches!(
            read_frame(&mut &zero[..]),
            Err(FrameError::BadLength(0))
        ));
        let huge = ((MAX_SOCKET_FRAME + 1) as u32).to_be_bytes();
        assert!(matches!(
            read_frame(&mut &huge[..]),
            Err(FrameError::BadLength(_))
        ));
        // Truncated payload is an I/O error, not a panic.
        let short = [0u8, 0, 0, 10, 0, b'{'];
        assert!(matches!(
            read_frame(&mut &short[..]),
            Err(FrameError::Io(_))
        ));
    }

    #[test]
    fn built_frames_have_correct_length_prefix() {
        let f = json_frame(&json!({"a": 1}));
        let mut r = &f[..];
        let (kind, body) = read_frame(&mut r).ok().flatten().unwrap_or_default();
        assert_eq!(kind, KIND_JSON);
        assert_eq!(body, br#"{"a":1}"#);
        let mut relay = Vec::new();
        begin_relay_frame(&mut relay, 5);
        relay.extend_from_slice(&[0x95, 0, 0, 0, 0]);
        finish_frame(&mut relay);
        let mut r = &relay[..];
        let (kind, body) = read_frame(&mut r).ok().flatten().unwrap_or_default();
        assert_eq!((kind, &body[..4]), (KIND_RELAY, &5u32.to_be_bytes()[..]));
    }

    #[test]
    fn token_comparison() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("ab", "abc"));
        assert!(!token_matches("", "abc"));
    }
}
