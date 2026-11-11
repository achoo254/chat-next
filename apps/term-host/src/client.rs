//! Headless client (section 8): talks to a daemon over the control socket as
//! the agent does, and speaks terminal frames as a browser would, over the
//! relay path (`kind 1`) or the direct path (a WebRTC offerer built on the
//! same `str0m`), switching between them by the rules of section 4. Used by
//! the integration tests and the latency bench.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{select_biased, Receiver, RecvTimeoutError, Sender};
use serde_json::{json, Value};
use str0m::change::SdpAnswer;
use str0m::channel::ChannelId;
use str0m::{Candidate, Event, IceConnectionState, Output, Rtc};

use crate::control::{self, read_frame, write_frame, Stream, KIND_JSON, KIND_RELAY};
use crate::flow::ACK_SAMPLE_MIN_BYTES;
use crate::rtc::{self, Packet, LABEL_IN, LABEL_OUT};
use crate::wire::{decode_server, encode_client, ClientFrame, ServerFrame};

const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// A daemon frame with owned data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Hello {
        version: u8,
        max_frame: u32,
    },
    Output {
        session: u32,
        offset: u64,
        data: Vec<u8>,
    },
    Snapshot {
        session: u32,
        offset: u64,
        cols: u16,
        rows: u16,
        alt_screen: bool,
        vt: Vec<u8>,
    },
    Exit {
        session: u32,
        code: i32,
        signal: u8,
    },
    Pong {
        client_micros: u64,
    },
    Error {
        session: u32,
        code: u16,
        message: String,
    },
}

impl Frame {
    fn from_wire(f: &ServerFrame<'_>) -> Frame {
        match *f {
            ServerFrame::Hello { version, max_frame } => Frame::Hello { version, max_frame },
            ServerFrame::Output {
                session,
                offset,
                data,
            } => Frame::Output {
                session,
                offset,
                data: data.to_vec(),
            },
            ServerFrame::Snapshot {
                session,
                offset,
                cols,
                rows,
                alt_screen,
                vt,
            } => Frame::Snapshot {
                session,
                offset,
                cols,
                rows,
                alt_screen,
                vt: vt.to_vec(),
            },
            ServerFrame::Exit {
                session,
                code,
                signal,
            } => Frame::Exit {
                session,
                code,
                signal,
            },
            ServerFrame::Pong { client_micros } => Frame::Pong { client_micros },
            ServerFrame::Error {
                session,
                code,
                message,
            } => Frame::Error {
                session,
                code,
                message: message.to_string(),
            },
        }
    }
}

/// An error reply to a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub code: String,
    pub message: String,
}

struct Inner {
    writer: Mutex<Stream>,
    closer: Stream,
    next_id: AtomicU64,
    replies: Receiver<Value>,
    events: Receiver<Value>,
    terms: Arc<Mutex<HashMap<u32, Sender<Vec<u8>>>>>,
    /// Every JSON line the daemon sent (for audit / leak checks).
    seen: Arc<Mutex<Vec<String>>>,
}

/// The agent side of the control socket.
#[derive(Clone)]
pub struct AgentClient {
    inner: Arc<Inner>,
}

/// Read `token` and the endpoint from `<home>/term-host/control.json`.
pub fn read_control(home: &Path) -> io::Result<(String, Value)> {
    let raw = std::fs::read(home.join(crate::DIR_NAME).join(crate::CONTROL_FILE))?;
    let v: Value = serde_json::from_slice(&raw).map_err(io::Error::other)?;
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::other("control.json without token"))?
        .to_string();
    Ok((token, v))
}

impl AgentClient {
    /// Connect and authenticate with the token from `control.json`.
    pub fn connect(home: &Path) -> io::Result<(AgentClient, Value)> {
        let (token, _) = read_control(home)?;
        let client = AgentClient::connect_raw(home)?;
        let hello = client
            .call(
                "hello",
                json!({ "major": 1, "minor": 0, "token": token, "agentVersion": "headless-client" }),
            )
            .map_err(|e| io::Error::other(format!("hello refused: {}", e.code)))?;
        Ok((client, hello))
    }

    /// Connect without sending anything (tests of the handshake).
    pub fn connect_raw(home: &Path) -> io::Result<AgentClient> {
        let path = home.join(crate::DIR_NAME).join("control.sock");
        let stream = control::connect(&path)?;
        let reader = stream.try_clone()?;
        let closer = stream.try_clone()?;
        let (reply_tx, replies) = crossbeam_channel::unbounded();
        let (event_tx, events) = crossbeam_channel::unbounded();
        let terms: Arc<Mutex<HashMap<u32, Sender<Vec<u8>>>>> = Arc::default();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        {
            let terms = terms.clone();
            let seen = seen.clone();
            thread::Builder::new()
                .name("client-read".into())
                .spawn(move || reader_loop(reader, reply_tx, event_tx, terms, seen))?;
        }
        Ok(AgentClient {
            inner: Arc::new(Inner {
                writer: Mutex::new(stream),
                closer,
                next_id: AtomicU64::new(1),
                replies,
                events,
                terms,
                seen,
            }),
        })
    }

    pub fn send_json(&self, v: &Value) -> io::Result<()> {
        let body = serde_json::to_vec(v).map_err(io::Error::other)?;
        let mut w = self
            .inner
            .writer
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?;
        write_frame(&mut *w, KIND_JSON, &body)
    }

    /// Send a command and wait for its reply.
    pub fn call(&self, cmd: &str, params: Value) -> Result<Value, CallError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let mut msg = params;
        if !msg.is_object() {
            msg = json!({});
        }
        msg["id"] = json!(id);
        msg["cmd"] = json!(cmd);
        self.send_json(&msg).map_err(|e| CallError {
            code: "io".into(),
            message: e.to_string(),
        })?;
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.inner.replies.recv_timeout(left) {
                Ok(v) if v.get("id") == Some(&json!(id)) => {
                    return if v.get("ok") == Some(&json!(true)) {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(CallError {
                            code: v["error"]["code"].as_str().unwrap_or("").to_string(),
                            message: v["error"]["message"].as_str().unwrap_or("").to_string(),
                        })
                    };
                }
                Ok(_) => continue,
                Err(_) => {
                    return Err(CallError {
                        code: "timeout".into(),
                        message: format!("no reply to {cmd}"),
                    })
                }
            }
        }
    }

    /// Next reply that was not consumed by `call` (handshake tests).
    pub fn next_reply(&self, timeout: Duration) -> Option<Value> {
        self.inner.replies.recv_timeout(timeout).ok()
    }

    /// Whether the daemon closed the socket (replies channel disconnected).
    pub fn wait_closed(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            match self
                .inner
                .replies
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(_) => continue,
                Err(RecvTimeoutError::Disconnected) => return true,
                Err(RecvTimeoutError::Timeout) => return false,
            }
        }
    }

    pub fn next_event(&self, timeout: Duration) -> Option<Value> {
        self.inner.events.recv_timeout(timeout).ok()
    }

    /// Wait for an event matching `pred`, skipping others.
    pub fn wait_event(&self, timeout: Duration, pred: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let ev = self.inner.events.recv_timeout(left).ok()?;
            if pred(&ev) {
                return Some(ev);
            }
        }
    }

    /// Every JSON message received so far, as text.
    pub fn transcript(&self) -> Vec<String> {
        self.inner
            .seen
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    /// Close the socket (agent going away).
    pub fn close(&self) {
        self.inner.closer.shutdown();
    }

    /// `grant` + `relay_open` + a terminal client for `conn`.
    pub fn open_relay(&self, conn: u32, device_key: &str) -> Result<TermClient, CallError> {
        let mut t = self.grant_term(conn, device_key)?;
        t.open_relay()?;
        Ok(t)
    }

    /// `grant` + a terminal client for `conn` with no path yet.
    pub fn grant_term(&self, conn: u32, device_key: &str) -> Result<TermClient, CallError> {
        let (tx, rx) = crossbeam_channel::unbounded();
        if let Ok(mut t) = self.inner.terms.lock() {
            t.insert(conn, tx.clone());
        }
        self.call("grant", json!({ "conn": conn, "deviceKey": device_key }))?;
        Ok(TermClient {
            agent: self.clone(),
            conn,
            tx,
            rx,
            acks: HashMap::new(),
            relay: false,
            direct: None,
            via_direct: false,
            continuity: false,
            backlog: VecDeque::new(),
            barrier: 0,
        })
    }

    fn send_relay(&self, conn: u32, frame: &[u8]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(4 + frame.len());
        payload.extend_from_slice(&conn.to_be_bytes());
        payload.extend_from_slice(frame);
        let mut w = self
            .inner
            .writer
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?;
        write_frame(&mut *w, KIND_RELAY, &payload)
    }
}

fn reader_loop(
    mut r: Stream,
    replies: Sender<Value>,
    events: Sender<Value>,
    terms: Arc<Mutex<HashMap<u32, Sender<Vec<u8>>>>>,
    seen: Arc<Mutex<Vec<String>>>,
) {
    while let Ok(Some((kind, payload))) = read_frame(&mut r) {
        match kind {
            KIND_JSON => {
                if let Ok(mut s) = seen.lock() {
                    s.push(String::from_utf8_lossy(&payload).into_owned());
                }
                let Ok(v) = serde_json::from_slice::<Value>(&payload) else {
                    continue;
                };
                let target = if v.get("event").is_some() {
                    &events
                } else {
                    &replies
                };
                let _ = target.send(v);
            }
            KIND_RELAY if payload.len() >= 4 => {
                let conn = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let tx = terms.lock().ok().and_then(|t| t.get(&conn).cloned());
                if let Some(tx) = tx {
                    let _ = tx.send(payload[4..].to_vec());
                }
            }
            _ => {}
        }
    }
    if let Ok(mut t) = terms.lock() {
        t.clear();
    }
}

/// Ack bookkeeping of one session, per the client rules of section 5: ack
/// after applying 16 KiB more, and at least every 50 ms while unacked.
#[derive(Debug, Default, Clone, Copy)]
pub struct AckState {
    pub applied: u64,
    pub acked: u64,
    since: Option<Instant>,
}

pub const ACK_TIMER: Duration = Duration::from_millis(50);

impl AckState {
    /// Record applied output; returns an offset to ack now, if due.
    pub fn on_applied(&mut self, end: u64, now: Instant) -> Option<u64> {
        self.applied = self.applied.max(end);
        if self.applied > self.acked && self.since.is_none() {
            self.since = Some(now);
        }
        self.due(now)
    }

    pub fn due(&mut self, now: Instant) -> Option<u64> {
        let unacked = self.applied.saturating_sub(self.acked);
        let timer = self
            .since
            .is_some_and(|t| now.saturating_duration_since(t) >= ACK_TIMER);
        if unacked >= ACK_SAMPLE_MIN_BYTES || (unacked > 0 && timer) {
            self.acked = self.applied;
            self.since = None;
            Some(self.acked)
        } else {
            None
        }
    }
}

/// One terminal connection, on the relay path, the direct path, or both.
///
/// Path switching follows section 4: after a new path opens the client
/// sends `Attach{applied}` on it for every attached session, and applies
/// `Output` only from its applied offset onwards (a frame starting past it
/// is a gap and is dropped, bytes before it are duplicates and are cut).
/// Turn this on with [`TermClient::set_continuity`]; it is always on once a
/// direct path was used.
pub struct TermClient {
    agent: AgentClient,
    pub conn: u32,
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
    acks: HashMap<u32, AckState>,
    relay: bool,
    direct: Option<DirectLink>,
    via_direct: bool,
    continuity: bool,
    /// Frames received (and applied) while waiting for something else.
    backlog: VecDeque<Frame>,
    barrier: u64,
}

impl TermClient {
    pub fn send(&self, frame: &ClientFrame<'_>) -> io::Result<()> {
        let mut bytes = Vec::with_capacity(32);
        encode_client(frame, &mut bytes);
        self.send_owned(bytes)
    }

    /// Send arbitrary bytes as one terminal frame (protocol tests).
    pub fn send_raw_frame(&self, frame: &[u8]) -> io::Result<()> {
        self.send_owned(frame.to_vec())
    }

    fn send_owned(&self, frame: Vec<u8>) -> io::Result<()> {
        if self.via_direct {
            if let Some(d) = &self.direct {
                return d.send(frame);
            }
        }
        if !self.relay {
            return Err(io::Error::other("no open path"));
        }
        self.agent.send_relay(self.conn, &frame)
    }

    /// `relay_open` for this connection; frames go on the relay unless the
    /// direct path is in use.
    pub fn open_relay(&mut self) -> Result<(), CallError> {
        self.agent
            .call("relay_open", json!({ "conn": self.conn }))?;
        self.relay = true;
        Ok(())
    }

    /// Apply output by offset (needed whenever paths change).
    pub fn set_continuity(&mut self, on: bool) {
        self.continuity = on;
    }

    /// Whether frames currently go out on the direct path.
    pub fn is_direct(&self) -> bool {
        self.via_direct
    }

    /// Hello handshake.
    pub fn hello(&mut self) -> io::Result<()> {
        self.send(&ClientFrame::Hello {
            version: 1,
            caps: 0,
        })?;
        match self.recv(Duration::from_secs(5)) {
            Some(Frame::Hello { version: 1, .. }) => Ok(()),
            other => Err(io::Error::other(format!(
                "unexpected hello reply: {other:?}"
            ))),
        }
    }

    pub fn input(&self, session: u32, data: &[u8]) -> io::Result<()> {
        self.send(&ClientFrame::Input { session, data })
    }

    pub fn attach(&mut self, session: u32, last_offset: u64) -> io::Result<()> {
        self.acks.insert(
            session,
            AckState {
                applied: last_offset,
                acked: last_offset,
                since: None,
            },
        );
        self.send(&ClientFrame::Attach {
            session,
            last_offset,
        })
    }

    /// Offer a direct path bound to `bind` and wait until it is open, but
    /// keep sending on the current path. `edit_offer` may alter the SDP
    /// before it goes to the daemon (protocol tests).
    pub fn offer_direct(
        &self,
        bind: IpAddr,
        timeout: Duration,
        edit_offer: impl FnOnce(String) -> String,
    ) -> io::Result<DirectLink> {
        let link = DirectLink::connect(&self.agent, self.conn, bind, self.tx.clone(), edit_offer)?;
        if link.wait_open(timeout) {
            Ok(link)
        } else {
            Err(io::Error::other("direct path did not open"))
        }
    }

    /// Open the direct path and move this connection onto it.
    pub fn connect_direct(&mut self, bind: IpAddr, timeout: Duration) -> io::Result<()> {
        let link = self.offer_direct(bind, timeout, |s| s)?;
        self.use_direct(link)
    }

    /// Move onto an open direct path. Keystrokes stay in order across the
    /// switch: a `Ping` sent on the relay after the last relay frame must
    /// come back before anything is sent on the direct path (the daemon
    /// handles relay frames in order). Then every attached session is
    /// re-attached on the direct path at its applied offset.
    pub fn use_direct(&mut self, link: DirectLink) -> io::Result<()> {
        self.continuity = true;
        self.direct = Some(link);
        if self.relay {
            self.barrier += 1;
            let marker = 0xB000_0000_0000_0000 | self.barrier;
            self.send(&ClientFrame::Ping {
                client_micros: marker,
            })?;
            let deadline = Instant::now() + CALL_TIMEOUT;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::Error::other("no pong for the path barrier"));
                }
                match self.next_frame(left) {
                    Some(Frame::Pong { client_micros }) if client_micros == marker => break,
                    Some(f) => self.backlog.push_back(f),
                    None => {}
                }
            }
        }
        self.via_direct = true;
        self.reattach_all()
    }

    /// Leave the direct path (`signal end`) and continue on the relay.
    pub fn fall_back_to_relay(&mut self) -> io::Result<()> {
        if !self.relay {
            return Err(io::Error::other("no relay to fall back to"));
        }
        self.agent
            .call("signal", json!({ "conn": self.conn, "kind": "end" }))
            .map_err(|e| io::Error::other(e.code))?;
        self.via_direct = false;
        if let Some(d) = self.direct.take() {
            d.close();
        }
        self.reattach_all()
    }

    /// The direct link, if any (tests stop or kill it).
    pub fn direct_link(&self) -> Option<&DirectLink> {
        self.direct.as_ref()
    }

    fn reattach_all(&mut self) -> io::Result<()> {
        let sessions: Vec<(u32, u64)> = self.acks.iter().map(|(&s, a)| (s, a.applied)).collect();
        for (session, applied) in sessions {
            self.attach(session, applied)?;
        }
        Ok(())
    }

    /// Next raw frame from the daemon (no automatic ack).
    pub fn recv(&mut self, timeout: Duration) -> Option<Frame> {
        if let Some(f) = self.backlog.pop_front() {
            return Some(f);
        }
        let bytes = self.rx.recv_timeout(timeout).ok()?;
        decode_server(&bytes).ok().map(|f| Frame::from_wire(&f))
    }

    /// Next frame, acking output by the client rules.
    pub fn recv_acking(&mut self, timeout: Duration) -> Option<Frame> {
        if let Some(f) = self.backlog.pop_front() {
            return Some(f);
        }
        self.next_frame(timeout)
    }

    /// Receive, apply (by offset when continuity is on) and ack. Gap and
    /// duplicate frames are skipped.
    fn next_frame(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            self.flush_timer_acks(now);
            let left = deadline.saturating_duration_since(now);
            if left.is_zero() {
                return None;
            }
            let bytes = match self.rx.recv_timeout(left.min(ACK_TIMER)) {
                Ok(b) => b,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return None,
            };
            let frame = decode_server(&bytes).ok().map(|f| Frame::from_wire(&f))?;
            let now = Instant::now();
            let frame = match frame {
                Frame::Output {
                    session,
                    offset,
                    mut data,
                } => {
                    let a = self.acks.entry(session).or_default();
                    let mut offset = offset;
                    if self.continuity {
                        let end = offset + data.len() as u64;
                        if offset > a.applied || end <= a.applied {
                            // Gap (comes again after the re-Attach) or
                            // duplicate (already applied).
                            continue;
                        }
                        let cut = (a.applied - offset) as usize;
                        data.drain(..cut);
                        offset = a.applied;
                    }
                    let end = offset + data.len() as u64;
                    if let Some(off) = a.on_applied(end, now) {
                        let _ = self.send(&ClientFrame::Ack {
                            session,
                            offset: off,
                        });
                    }
                    Frame::Output {
                        session,
                        offset,
                        data,
                    }
                }
                Frame::Snapshot {
                    session,
                    offset,
                    cols,
                    rows,
                    alt_screen,
                    vt,
                } => {
                    self.acks.insert(
                        session,
                        AckState {
                            applied: offset,
                            acked: offset,
                            since: None,
                        },
                    );
                    Frame::Snapshot {
                        session,
                        offset,
                        cols,
                        rows,
                        alt_screen,
                        vt,
                    }
                }
                other => other,
            };
            return Some(frame);
        }
    }

    fn flush_timer_acks(&mut self, now: Instant) {
        let due: Vec<(u32, u64)> = self
            .acks
            .iter_mut()
            .filter_map(|(&s, a)| a.due(now).map(|o| (s, o)))
            .collect();
        for (session, offset) in due {
            let _ = self.send(&ClientFrame::Ack { session, offset });
        }
    }

    pub fn applied(&self, session: u32) -> u64 {
        self.acks.get(&session).map_or(0, |a| a.applied)
    }

    pub fn acked(&self, session: u32) -> u64 {
        self.acks.get(&session).map_or(0, |a| a.acked)
    }

    /// Record `offset` as applied and acknowledge it now.
    pub fn ack(&mut self, session: u32, offset: u64) -> io::Result<()> {
        let a = self.acks.entry(session).or_default();
        a.applied = a.applied.max(offset);
        a.acked = a.applied;
        a.since = None;
        self.send(&ClientFrame::Ack { session, offset })
    }

    /// Read (acking) until `pred` holds on the bytes of `session` received
    /// since this call started. Returns those bytes.
    pub fn read_until(
        &mut self,
        session: u32,
        timeout: Duration,
        pred: impl Fn(&[u8]) -> bool,
    ) -> Option<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        let mut got = Vec::new();
        while !pred(&got) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.recv_acking(left) {
                Some(Frame::Output {
                    session: s, data, ..
                }) if s == session => got.extend_from_slice(&data),
                Some(_) => {}
                None => return None,
            }
        }
        Some(got)
    }
}

/// State changes of a direct link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Open,
    Closed,
}

enum LinkCmd {
    Frame(Vec<u8>),
    /// SCTP shutdown and DTLS close_notify, then stop.
    Close,
    /// Stop at once without telling the daemon and close the socket, as if
    /// the client's network vanished.
    Vanish,
}

/// The client end of a direct path: one `str0m` offerer on its own thread
/// with one UDP socket. Frames from `term-out` go to the terminal client's
/// frame channel, like relay frames.
pub struct DirectLink {
    tx: Sender<LinkCmd>,
    state: Receiver<LinkState>,
    pub local: SocketAddr,
}

impl DirectLink {
    /// Offer to the daemon through `agent` (as the agent relays a browser's
    /// offer) and accept its answer.
    pub fn connect(
        agent: &AgentClient,
        conn: u32,
        bind: IpAddr,
        frames: Sender<Vec<u8>>,
        edit_offer: impl FnOnce(String) -> String,
    ) -> io::Result<DirectLink> {
        let mut rtc = rtc::rtc_config().build(Instant::now());
        let socket = UdpSocket::bind(SocketAddr::new(bind, 0))?;
        let local = socket.local_addr()?;
        let host = Candidate::host(local, "udp").map_err(io::Error::other)?;
        rtc.add_local_candidate(host);
        let mut api = rtc.sdp_api();
        let cin = api.add_channel(LABEL_IN.into());
        let cout = api.add_channel(LABEL_OUT.into());
        let (offer, pending) = api
            .apply()
            .ok_or_else(|| io::Error::other("nothing to offer"))?;
        let sdp = edit_offer(offer.to_sdp_string());
        agent
            .call(
                "signal",
                json!({ "conn": conn, "kind": "offer", "sdp": sdp }),
            )
            .map_err(|e| io::Error::other(format!("offer refused: {}", e.code)))?;
        let ev = agent
            .wait_event(CALL_TIMEOUT, |e| {
                e["event"] == "signal"
                    && e["conn"] == conn
                    && (e["kind"] == "answer" || e["kind"] == "end")
            })
            .ok_or_else(|| io::Error::other("no answer"))?;
        let Some(answer) = ev["sdp"].as_str() else {
            return Err(io::Error::other(format!(
                "direct path refused: {}",
                ev["reason"].as_str().unwrap_or("")
            )));
        };
        let answer = SdpAnswer::from_sdp_string(answer).map_err(io::Error::other)?;
        rtc.sdp_api()
            .accept_answer(pending, answer)
            .map_err(io::Error::other)?;

        let (tx, rx) = crossbeam_channel::unbounded();
        let (state_tx, state) = crossbeam_channel::unbounded();
        let socket = Arc::new(socket);
        let stop = Arc::new(AtomicBool::new(false));
        let (udp_tx, udp_rx) = crossbeam_channel::unbounded();
        let (_pool_tx, pool_rx) = crossbeam_channel::bounded::<Vec<u8>>(1);
        {
            let socket = socket.clone();
            let stop = stop.clone();
            thread::Builder::new()
                .name("client-udp".into())
                .spawn(move || rtc::reader(0, &socket, &udp_tx, &pool_rx, &stop))?;
        }
        let mut link = LinkThread {
            rtc,
            socket,
            local,
            cin,
            cout,
            open: (false, false),
            connected: false,
            pending: VecDeque::new(),
            frames,
            state: state_tx,
        };
        thread::Builder::new()
            .name("client-rtc".into())
            .spawn(move || {
                link.run(&rx, &udp_rx);
                stop.store(true, Ordering::Relaxed);
            })?;
        Ok(DirectLink { tx, state, local })
    }

    fn send(&self, frame: Vec<u8>) -> io::Result<()> {
        self.tx
            .send(LinkCmd::Frame(frame))
            .map_err(|_| io::Error::other("direct link closed"))
    }

    fn wait_state(&self, want: LinkState, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.state.recv_timeout(left) {
                Ok(s) if s == want => return true,
                Ok(_) => {}
                // The thread ended: it is closed for good.
                Err(RecvTimeoutError::Disconnected) => return want == LinkState::Closed,
                Err(RecvTimeoutError::Timeout) => return false,
            }
        }
    }

    pub fn wait_open(&self, timeout: Duration) -> bool {
        self.wait_state(LinkState::Open, timeout)
    }

    /// Whether the daemon closed the path (channels or ICE) within `timeout`.
    pub fn wait_closed(&self, timeout: Duration) -> bool {
        self.wait_state(LinkState::Closed, timeout)
    }

    pub fn close(&self) {
        let _ = self.tx.send(LinkCmd::Close);
    }

    pub fn vanish(&self) {
        let _ = self.tx.send(LinkCmd::Vanish);
    }
}

struct LinkThread {
    rtc: Rtc,
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    cin: ChannelId,
    cout: ChannelId,
    open: (bool, bool),
    connected: bool,
    pending: VecDeque<Vec<u8>>,
    frames: Sender<Vec<u8>>,
    state: Sender<LinkState>,
}

impl LinkThread {
    fn run(&mut self, cmds: &Receiver<LinkCmd>, udp: &Receiver<Packet>) {
        loop {
            let wake = match self.drive() {
                Some(t) => t,
                None => {
                    let _ = self.state.send(LinkState::Closed);
                    return;
                }
            };
            let wait = wake.saturating_duration_since(Instant::now());
            select_biased! {
                recv(udp) -> p => {
                    if let Ok(p) = p {
                        if rtc::feed(&mut self.rtc, self.local, p.from, &p.buf).is_err() {
                            let _ = self.state.send(LinkState::Closed);
                            return;
                        }
                    }
                }
                recv(cmds) -> c => match c {
                    Ok(LinkCmd::Frame(f)) => {
                        self.pending.push_back(f);
                        self.flush();
                    }
                    Ok(LinkCmd::Close) | Err(_) => {
                        if self.rtc.close().is_ok() {
                            let _ = self.drive();
                        }
                        let _ = self.state.send(LinkState::Closed);
                        return;
                    }
                    Ok(LinkCmd::Vanish) => return,
                },
                default(wait) => {}
            }
            let now = Instant::now();
            if now >= wake && self.rtc.handle_input(str0m::Input::Timeout(now)).is_err() {
                let _ = self.state.send(LinkState::Closed);
                return;
            }
            self.flush();
        }
    }

    /// Poll until str0m waits for time; `None` when the link is over.
    fn drive(&mut self) -> Option<Instant> {
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(t)) => return self.rtc.is_alive().then_some(t),
                Ok(Output::Transmit(t)) => {
                    let _ = self.socket.send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(e)) => match e {
                    Event::IceConnectionStateChange(s) => match s {
                        IceConnectionState::Connected | IceConnectionState::Completed => {
                            self.connected = true;
                        }
                        IceConnectionState::Disconnected if self.connected => return None,
                        _ => {}
                    },
                    Event::ChannelOpen(id, _) => {
                        if id == self.cin {
                            self.open.0 = true;
                        } else if id == self.cout {
                            self.open.1 = true;
                        }
                        if self.open == (true, true) {
                            let _ = self.state.send(LinkState::Open);
                        }
                    }
                    Event::ChannelData(d) => {
                        if d.id == self.cout {
                            let _ = self.frames.send(d.data);
                        }
                    }
                    Event::ChannelClose(id) if id == self.cin || id == self.cout => {
                        return None;
                    }
                    _ => {}
                },
                Err(_) => return None,
            }
        }
    }

    fn flush(&mut self) {
        let Some(mut ch) = self.rtc.channel(self.cin) else {
            return;
        };
        while let Some(f) = self.pending.front() {
            match ch.write(true, f) {
                Ok(true) => {
                    self.pending.pop_front();
                }
                _ => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_state_follows_client_rules() {
        let t0 = Instant::now();
        let mut a = AckState::default();
        assert_eq!(a.on_applied(100, t0), None);
        assert_eq!(a.on_applied(16 * 1024 + 100, t0), Some(16 * 1024 + 100));
        assert_eq!(a.on_applied(16 * 1024 + 200, t0), None);
        assert_eq!(a.due(t0 + Duration::from_millis(49)), None);
        assert_eq!(a.due(t0 + Duration::from_millis(50)), Some(16 * 1024 + 200));
        assert_eq!(a.due(t0 + Duration::from_millis(200)), None);
    }
}
