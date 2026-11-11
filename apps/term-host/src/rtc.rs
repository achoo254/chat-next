//! Direct path (WebRTC data channels, section 2): one `str0m` `Rtc` per peer
//! connection, sans-IO, driven by its own thread. Each local UDP socket has
//! a blocking reader thread feeding that peer thread; no async runtime.
//!
//! The browser offers, the daemon answers. Terminal frames travel on
//! `term-in` (client to daemon) and `term-out` (daemon to client); the hub
//! sees them exactly like relay frames, so flow control, offsets, Snapshot
//! and reattach are shared by both paths.

use std::collections::VecDeque;
use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{select_biased, Receiver, Sender};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::config::CryptoProvider;
use str0m::net::{DatagramRecv, Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig, RtcError};

use crate::conn::{FrameSink, SinkClosed};
use crate::control::ControlMsg;
use crate::flow::PathKind;
use crate::nic::{self, StunProbes, StunSend};
use crate::wire::{encode_server, server_frame_len, ServerFrame};
use crate::Logger;

/// Data channel the client sends terminal frames on.
pub const LABEL_IN: &str = "term-in";
/// Data channel the daemon sends terminal frames on.
pub const LABEL_OUT: &str = "term-out";
/// Both channels must be open this long after the offer.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// On close, wait at most this long for queued frames (an `Error` before a
/// revocation, say) to be acknowledged by the client before tearing down.
const CLOSE_LINGER: Duration = Duration::from_millis(250);
/// Reader threads check for shutdown this often.
const READER_POLL: Duration = Duration::from_millis(250);
/// Largest UDP datagram read.
const UDP_BUF: usize = 2048;
/// Recycled buffers kept per pool.
const POOL: usize = 64;
/// SCTP send buffer; above the largest flow window plus control frames so
/// the flow window, not SCTP, decides how much is in flight.
const SCTP_BUFFER: usize = 2 * 1024 * 1024;
/// ICE consent: a pair that stops answering is dropped after about 10 s
/// (and 15 s after the client's last check), instead of str0m's 24 s.
const MAX_STUN_RTO: Duration = Duration::from_millis(1500);
const MAX_STUN_RETRANSMITS: usize = 7;
/// ICE round-trip statistics period (for `conn_state.rttMs`).
const STATS_INTERVAL: Duration = Duration::from_secs(1);

/// Settings shared by every peer connection.
#[derive(Clone)]
pub struct RtcSettings {
    /// `host:port` STUN servers; empty disables server-reflexive candidates.
    pub stun_servers: Arc<[String]>,
    /// Offer loopback addresses as host candidates (tests only).
    pub allow_loopback: bool,
    pub log: Logger,
}

/// Why a peer connection ended (`signal end` `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// The agent sent `signal end`, a new offer replaced it, or the
    /// connection was closed (revocation, `conn_close`, shutdown).
    Closed,
    /// ICE consent failed after the path had connected.
    IceDisconnected,
    /// The client closed `term-in` or `term-out`.
    ChannelClosed,
    /// DTLS failed, including a certificate that does not match the
    /// fingerprint of the offer.
    DtlsFailed,
    /// The channels did not open within [`CONNECT_TIMEOUT`].
    Timeout,
    /// No local address could be bound.
    NoAddress,
    /// The offer was refused by the WebRTC layer.
    BadOffer,
    /// Any other failure of the WebRTC layer or the sockets.
    Error,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Closed => "closed",
            EndReason::IceDisconnected => "ice_disconnected",
            EndReason::ChannelClosed => "channel_closed",
            EndReason::DtlsFailed => "dtls_failed",
            EndReason::Timeout => "timeout",
            EndReason::NoAddress => "no_address",
            EndReason::BadOffer => "bad_offer",
            EndReason::Error => "error",
        }
    }
}

/// What a peer thread tells the hub (`ControlMsg::Peer`).
pub enum PeerEvent {
    /// The SDP answer (host candidates included).
    Answer { sdp: String },
    /// A local candidate found later (server reflexive).
    Candidate { candidate: String },
    /// `term-in` and `term-out` are open: frames can flow.
    Open { sink: DirectSink },
    /// First ICE round-trip time measured after `Open`.
    Rtt { ms: f64 },
    /// One terminal frame from `term-in`.
    Frame { buf: Vec<u8> },
    /// The peer is gone; nothing more comes from it.
    Ended { reason: EndReason },
}

enum PeerCmd {
    /// One encoded terminal frame for `term-out`.
    Frame(Vec<u8>),
    /// A remote ICE candidate (`candidate:...`).
    Candidate(String),
    /// Resolved STUN servers.
    StunServers(Vec<SocketAddr>),
    Close,
}

/// Hub-side handle of a peer thread. Dropping it closes the peer.
pub struct PeerHandle {
    pub id: u64,
    tx: Sender<PeerCmd>,
}

impl PeerHandle {
    /// Hand a remote candidate to the peer (trickle ICE).
    pub fn add_candidate(&self, candidate: String) {
        let _ = self.tx.send(PeerCmd::Candidate(candidate));
    }
}

impl Drop for PeerHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(PeerCmd::Close);
    }
}

/// Frames to the client over `term-out`.
pub struct DirectSink {
    tx: Sender<PeerCmd>,
    /// Bytes handed to the peer thread and not yet accepted by SCTP.
    queued: Arc<AtomicUsize>,
    /// Bytes SCTP holds until the client acknowledges them.
    sctp: Arc<AtomicUsize>,
    /// Buffers coming back from the peer thread for reuse.
    pool: Receiver<Vec<u8>>,
}

impl FrameSink for DirectSink {
    fn send(&mut self, frame: &ServerFrame<'_>) -> Result<(), SinkClosed> {
        let len = server_frame_len(frame);
        let mut buf = self
            .pool
            .try_recv()
            .unwrap_or_else(|_| Vec::with_capacity(len));
        buf.clear();
        encode_server(frame, &mut buf);
        self.queued.fetch_add(len, Ordering::Relaxed);
        if self.tx.send(PeerCmd::Frame(buf)).is_err() {
            self.queued.fetch_sub(len, Ordering::Relaxed);
        }
        // A dead peer thread has already queued `Ended` for the hub, which
        // moves the connection to the relay (the client re-attaches there)
        // or closes it. Failing here would close the whole connection.
        Ok(())
    }

    fn buffered(&self) -> usize {
        self.queued.load(Ordering::Relaxed) + self.sctp.load(Ordering::Relaxed)
    }

    fn path(&self) -> PathKind {
        PathKind::Direct
    }
}

/// Parse an offer from the agent. It must negotiate data channels.
pub fn parse_offer(sdp: &str) -> Result<SdpOffer, String> {
    if !sdp.lines().any(|l| l.starts_with("m=application")) {
        return Err("offer has no data channel section".into());
    }
    SdpOffer::from_sdp_string(sdp).map_err(|e| format!("invalid offer: {e}"))
}

/// The crypto backend chosen by the crate features (aws-lc-rs, or the
/// Windows CNG backend), shared by all peers.
pub fn crypto() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| Arc::new(str0m::crypto::from_feature_flags()))
        .clone()
}

/// An `RtcConfig` with the daemon's ICE, SCTP and crypto settings.
pub fn rtc_config() -> RtcConfig {
    let mut cfg = RtcConfig::new()
        .set_crypto_provider(crypto())
        .set_sctp_max_buffered_amount(SCTP_BUFFER)
        .set_stats_interval(Some(STATS_INTERVAL));
    cfg.set_max_stun_rto(MAX_STUN_RTO);
    cfg.set_max_stun_retransmits(MAX_STUN_RETRANSMITS);
    cfg
}

static NEXT_PEER: AtomicU64 = AtomicU64::new(1);

/// Start a peer thread answering `offer` for connection `conn`. Events go to
/// the hub as `ControlMsg::Peer`.
pub fn start(
    conn: u32,
    offer: SdpOffer,
    settings: &RtcSettings,
    hub: Sender<ControlMsg>,
) -> io::Result<PeerHandle> {
    let id = NEXT_PEER.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = crossbeam_channel::unbounded();
    let settings = settings.clone();
    let cmd_tx = tx.clone();
    thread::Builder::new()
        .name(format!("rtc-{conn}"))
        .spawn(move || {
            let log = settings.log.clone();
            let notify = Notify { conn, id, hub };
            let reason = match Peer::setup(&notify, offer, &settings, cmd_tx, rx) {
                Ok(mut peer) => {
                    let reason = peer.run();
                    peer.stop_readers();
                    reason
                }
                Err(reason) => reason,
            };
            log.info(&format!(
                "connection {conn}: direct path ended ({})",
                reason.as_str()
            ));
            notify.send(PeerEvent::Ended { reason });
        })?;
    Ok(PeerHandle { id, tx })
}

struct Notify {
    conn: u32,
    id: u64,
    hub: Sender<ControlMsg>,
}

impl Notify {
    fn send(&self, event: PeerEvent) -> bool {
        self.hub
            .send(ControlMsg::Peer {
                conn: self.conn,
                peer: self.id,
                event,
            })
            .is_ok()
    }
}

/// A datagram from a reader thread.
pub(crate) struct Packet {
    pub sock: usize,
    pub from: SocketAddr,
    pub buf: Vec<u8>,
}

struct Peer<'a> {
    notify: &'a Notify,
    log: Logger,
    rtc: Rtc,
    sockets: Vec<Arc<UdpSocket>>,
    locals: Vec<SocketAddr>,
    stop: Arc<AtomicBool>,
    udp_rx: Receiver<Packet>,
    udp_pool: Sender<Vec<u8>>,
    cmd_tx: Sender<PeerCmd>,
    cmd_rx: Receiver<PeerCmd>,
    stun: StunProbes,
    stun_out: Vec<StunSend>,
    started: Instant,
    in_id: Option<ChannelId>,
    out_id: Option<ChannelId>,
    open: bool,
    ice_connected: bool,
    rtt_sent: bool,
    /// Frames SCTP did not accept yet (its buffer was full).
    pending: VecDeque<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    sctp: Arc<AtomicUsize>,
    /// Buffers returned to the hub's `DirectSink`.
    sink_pool: Sender<Vec<u8>>,
    sink_pool_rx: Receiver<Vec<u8>>,
    /// `Close` received: tear down once SCTP drained or at this time.
    closing: Option<Instant>,
    ended: Option<EndReason>,
}

fn classify(e: &RtcError) -> EndReason {
    match e {
        RtcError::Dtls(_) => EndReason::DtlsFailed,
        RtcError::RemoteSdp(m) if m.contains("fingerprint") => EndReason::DtlsFailed,
        _ => EndReason::Error,
    }
}

impl<'a> Peer<'a> {
    fn setup(
        notify: &'a Notify,
        offer: SdpOffer,
        settings: &RtcSettings,
        cmd_tx: Sender<PeerCmd>,
        cmd_rx: Receiver<PeerCmd>,
    ) -> Result<Peer<'a>, EndReason> {
        let started = Instant::now();
        let mut rtc = rtc_config().build(started);
        let addrs = nic::local_addresses(settings.allow_loopback).map_err(|e| {
            settings.log.warn(&format!(
                "connection {}: listing interfaces failed: {e}",
                notify.conn
            ));
            EndReason::NoAddress
        })?;
        let mut sockets = Vec::new();
        let mut locals = Vec::new();
        for s in nic::bind_sockets(&addrs) {
            let Ok(local) = s.local_addr() else { continue };
            let Ok(c) = Candidate::host(local, "udp") else {
                continue;
            };
            if rtc.add_local_candidate(c).is_some() {
                locals.push(local);
                sockets.push(Arc::new(s));
            }
        }
        if sockets.is_empty() {
            return Err(EndReason::NoAddress);
        }
        let answer = rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|_| EndReason::BadOffer)?;
        if !notify.send(PeerEvent::Answer {
            sdp: answer.to_sdp_string(),
        }) {
            return Err(EndReason::Closed);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (udp_tx, udp_rx) = crossbeam_channel::unbounded();
        let (udp_pool, udp_pool_rx) = crossbeam_channel::bounded(POOL);
        for (i, s) in sockets.iter().enumerate() {
            let s = s.clone();
            let tx = udp_tx.clone();
            let pool = udp_pool_rx.clone();
            let reader_stop = stop.clone();
            let spawned = thread::Builder::new()
                .name(format!("rtc-udp-{}", notify.conn))
                .spawn(move || reader(i, &s, &tx, &pool, &reader_stop));
            if spawned.is_err() {
                stop.store(true, Ordering::Relaxed);
                return Err(EndReason::Error);
            }
        }
        if !settings.stun_servers.is_empty() {
            let servers = settings.stun_servers.clone();
            let tx = cmd_tx.clone();
            // DNS can block for seconds: resolve off the peer thread.
            let _ = thread::Builder::new()
                .name("rtc-stun-dns".into())
                .spawn(move || {
                    let _ = tx.send(PeerCmd::StunServers(nic::resolve_servers(&servers)));
                });
        }
        settings.log.info(&format!(
            "connection {}: direct path answering ({} local address(es))",
            notify.conn,
            sockets.len()
        ));
        let (sink_pool, sink_pool_rx) = crossbeam_channel::bounded(POOL);
        Ok(Peer {
            notify,
            log: settings.log.clone(),
            rtc,
            sockets,
            locals,
            stop,
            udp_rx,
            udp_pool,
            cmd_tx,
            cmd_rx,
            stun: StunProbes::default(),
            stun_out: Vec::new(),
            started,
            in_id: None,
            out_id: None,
            open: false,
            ice_connected: false,
            rtt_sent: false,
            pending: VecDeque::new(),
            queued: Arc::new(AtomicUsize::new(0)),
            sctp: Arc::new(AtomicUsize::new(0)),
            sink_pool,
            sink_pool_rx,
            closing: None,
            ended: None,
        })
    }

    fn stop_readers(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    fn run(&mut self) -> EndReason {
        let connect_deadline = self.started + CONNECT_TIMEOUT;
        loop {
            let rtc_wake = match self.drive() {
                Ok(t) => t,
                Err(reason) => return reason,
            };
            if let Some(reason) = self.ended.take() {
                return reason;
            }
            self.flush_pending();
            if let Some(reason) = self.ended.take() {
                return reason;
            }
            if let Some(deadline) = self.closing {
                if self.sctp.load(Ordering::Relaxed) == 0 || Instant::now() >= deadline {
                    self.close_now();
                    return EndReason::Closed;
                }
            }
            let now = Instant::now();
            if !self.open && now >= connect_deadline {
                return EndReason::Timeout;
            }
            self.send_stun(now);

            let mut wake = rtc_wake;
            if let Some(t) = self.stun.next_at() {
                wake = wake.min(t);
            }
            if !self.open {
                wake = wake.min(connect_deadline);
            }
            if let Some(t) = self.closing {
                wake = wake.min(t);
            }
            let wait = wake.saturating_duration_since(Instant::now());
            // Datagrams from the client (keystrokes among them) go first.
            select_biased! {
                recv(self.udp_rx) -> p => {
                    if let Ok(p) = p {
                        if let Err(e) = self.on_packet(p) {
                            return classify(&e);
                        }
                    }
                }
                recv(self.cmd_rx) -> c => {
                    match c {
                        Ok(c) => self.on_cmd(c),
                        // Unreachable while `cmd_tx` is held here.
                        Err(_) => return EndReason::Closed,
                    }
                }
                default(wait) => {}
            }
            let now = Instant::now();
            if now >= rtc_wake {
                if let Err(e) = self.rtc.handle_input(Input::Timeout(now)) {
                    return classify(&e);
                }
            }
        }
    }

    /// Poll str0m until it only waits for time: send datagrams, handle events.
    fn drive(&mut self) -> Result<Instant, EndReason> {
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(t)) => return Ok(t),
                Ok(Output::Transmit(t)) => {
                    if let Some(i) = self.locals.iter().position(|l| *l == t.source) {
                        if let Some(s) = self.sockets.get(i) {
                            // UDP: a failed send is a lost datagram.
                            let _ = s.send_to(&t.contents, t.destination);
                        }
                    }
                }
                Ok(Output::Event(e)) => self.on_event(e),
                Err(e) => return Err(classify(&e)),
            }
        }
    }

    fn on_event(&mut self, e: Event) {
        match e {
            Event::IceConnectionStateChange(state) => match state {
                IceConnectionState::Connected | IceConnectionState::Completed => {
                    self.ice_connected = true;
                }
                // Before the first connection the ICE layer may still find a
                // pair (trickled candidates); the connect timeout decides.
                IceConnectionState::Disconnected if self.ice_connected => {
                    self.ended.get_or_insert(EndReason::IceDisconnected);
                }
                _ => {}
            },
            Event::ChannelOpen(id, label) => {
                match label.as_str() {
                    LABEL_IN => self.in_id = Some(id),
                    LABEL_OUT => self.out_id = Some(id),
                    _ => {}
                }
                if !self.open && self.in_id.is_some() && self.out_id.is_some() {
                    self.open = true;
                    let sink = DirectSink {
                        tx: self.cmd_tx.clone(),
                        queued: self.queued.clone(),
                        sctp: self.sctp.clone(),
                        pool: self.sink_pool_rx.clone(),
                    };
                    self.log.info(&format!(
                        "connection {}: direct path open",
                        self.notify.conn
                    ));
                    if !self.notify.send(PeerEvent::Open { sink }) {
                        self.ended.get_or_insert(EndReason::Closed);
                    }
                }
            }
            Event::ChannelData(d) => {
                if self.open && Some(d.id) == self.in_id {
                    self.notify.send(PeerEvent::Frame { buf: d.data });
                }
            }
            Event::ChannelClose(id) => {
                if Some(id) == self.in_id || Some(id) == self.out_id {
                    self.ended.get_or_insert(EndReason::ChannelClosed);
                }
            }
            Event::PeerStats(s) if self.open && !self.rtt_sent => {
                let rtt = s
                    .selected_candidate_pair
                    .and_then(|p| p.current_round_trip_time);
                if let Some(rtt) = rtt {
                    self.rtt_sent = true;
                    self.notify.send(PeerEvent::Rtt {
                        ms: rtt.as_secs_f64() * 1000.0,
                    });
                }
            }
            _ => {}
        }
    }

    fn on_packet(&mut self, p: Packet) -> Result<(), RtcError> {
        let Packet { sock, from, buf } = p;
        let result = match self.locals.get(sock) {
            Some(&local) => self.receive(sock, local, from, &buf),
            None => Ok(()),
        };
        let mut buf = buf;
        buf.clear();
        let _ = self.udp_pool.try_send(buf);
        result
    }

    fn receive(
        &mut self,
        sock: usize,
        local: SocketAddr,
        from: SocketAddr,
        buf: &[u8],
    ) -> Result<(), RtcError> {
        if let Some(mapped) = self.stun.on_packet(sock, from, buf) {
            self.on_mapped(local, mapped);
            return Ok(());
        }
        feed(&mut self.rtc, local, from, buf)
    }

    /// A STUN server told us how `local` looks from outside.
    fn on_mapped(&mut self, local: SocketAddr, mapped: SocketAddr) {
        if mapped == local || self.locals.contains(&mapped) {
            // No NAT on this path: the host candidate already covers it.
            return;
        }
        let Ok(c) = Candidate::server_reflexive(mapped, local, "udp") else {
            return;
        };
        if let Some(added) = self.rtc.add_local_candidate(c) {
            let candidate = added.to_sdp_string();
            self.notify.send(PeerEvent::Candidate { candidate });
        }
    }

    fn send_stun(&mut self, now: Instant) {
        self.stun.due(now, &mut self.stun_out);
        for s in self.stun_out.drain(..) {
            if let Some(sock) = self.sockets.get(s.sock) {
                let _ = sock.send_to(&s.request, s.server);
            }
        }
    }

    fn on_cmd(&mut self, cmd: PeerCmd) {
        match cmd {
            PeerCmd::Frame(buf) => {
                if self.closing.is_some() {
                    self.queued.fetch_sub(buf.len(), Ordering::Relaxed);
                    return;
                }
                self.pending.push_back(buf);
                self.flush_pending();
            }
            PeerCmd::Candidate(text) => {
                let line = text.trim();
                let line = line.strip_prefix("a=").unwrap_or(line);
                if line.is_empty() {
                    // End-of-candidates marker.
                    return;
                }
                // mDNS (`.local`) candidates cannot be resolved here; the
                // client is still reached through peer-reflexive candidates.
                if let Ok(c) = Candidate::from_sdp_string(line) {
                    self.rtc.add_remote_candidate(c);
                }
            }
            PeerCmd::StunServers(servers) => {
                if let Err(e) = self.stun.start(&self.locals, &servers, Instant::now()) {
                    self.log.warn(&format!(
                        "connection {}: STUN skipped: {e}",
                        self.notify.conn
                    ));
                }
            }
            PeerCmd::Close => {
                if self.closing.is_none() {
                    self.closing = Some(Instant::now() + CLOSE_LINGER);
                }
            }
        }
    }

    /// Move queued frames into SCTP while it has room.
    fn flush_pending(&mut self) {
        let Some(id) = self.out_id else {
            return;
        };
        let Some(mut ch) = self.rtc.channel(id) else {
            return;
        };
        while let Some(buf) = self.pending.front() {
            match ch.write(true, buf) {
                Ok(true) => {
                    if let Some(mut buf) = self.pending.pop_front() {
                        self.queued.fetch_sub(buf.len(), Ordering::Relaxed);
                        buf.clear();
                        let _ = self.sink_pool.try_send(buf);
                    }
                }
                Ok(false) => break,
                Err(_) => {
                    self.ended.get_or_insert(EndReason::Error);
                    break;
                }
            }
        }
        self.sctp.store(ch.buffered_amount(), Ordering::Relaxed);
    }

    /// SCTP shutdown and DTLS close_notify, sent before the thread exits so
    /// the client sees its channels close at once.
    fn close_now(&mut self) {
        let dropped: usize = self.pending.drain(..).map(|b| b.len()).sum();
        self.queued.fetch_sub(dropped, Ordering::Relaxed);
        if self.rtc.close().is_err() {
            return;
        }
        for _ in 0..64 {
            match self.rtc.poll_output() {
                Ok(Output::Transmit(t)) => {
                    if let Some(i) = self.locals.iter().position(|l| *l == t.source) {
                        if let Some(s) = self.sockets.get(i) {
                            let _ = s.send_to(&t.contents, t.destination);
                        }
                    }
                }
                Ok(Output::Event(_)) => {}
                Ok(Output::Timeout(_)) | Err(_) => break,
            }
            if !self.rtc.is_alive() {
                break;
            }
        }
    }
}

/// Hand one received datagram to `rtc`. Datagrams that are not STUN, DTLS
/// or RTP, or that belong to no session of this `Rtc` (port scans, stray
/// traffic), are dropped instead of failing the connection.
pub(crate) fn feed(
    rtc: &mut Rtc,
    local: SocketAddr,
    from: SocketAddr,
    buf: &[u8],
) -> Result<(), RtcError> {
    let Ok(contents) = DatagramRecv::try_from(buf) else {
        return Ok(());
    };
    let input = Input::Receive(
        Instant::now(),
        Receive {
            proto: Protocol::Udp,
            source: from,
            destination: local,
            contents,
        },
    );
    if !rtc.accepts(&input) {
        return Ok(());
    }
    rtc.handle_input(input)
}

/// Blocking reader of one UDP socket. Exits when `stop` is set or the peer
/// thread is gone.
pub(crate) fn reader(
    sock: usize,
    s: &UdpSocket,
    tx: &Sender<Packet>,
    pool: &Receiver<Vec<u8>>,
    stop: &AtomicBool,
) {
    if s.set_read_timeout(Some(READER_POLL)).is_err() {
        return;
    }
    let mut buf: Vec<u8> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        if buf.capacity() < UDP_BUF {
            buf = pool.try_recv().unwrap_or_default();
        }
        buf.resize(UDP_BUF, 0);
        match s.recv_from(&mut buf) {
            Ok((n, from)) => {
                buf.truncate(n);
                let packet = Packet {
                    sock,
                    from,
                    buf: std::mem::take(&mut buf),
                };
                if tx.send(packet).is_err() {
                    return;
                }
            }
            Err(e) => match e.kind() {
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => {}
                // Windows reports ICMP port unreachable on the next read.
                io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted => {}
                _ => thread::sleep(Duration::from_millis(10)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_without_data_channels_are_refused() {
        assert!(parse_offer("v=0\r\n").is_err());
        assert!(
            parse_offer("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\ngarbage").is_err()
        );
    }

    #[test]
    fn end_reasons_are_stable_strings() {
        assert_eq!(EndReason::DtlsFailed.as_str(), "dtls_failed");
        assert_eq!(EndReason::IceDisconnected.as_str(), "ice_disconnected");
        assert_eq!(
            classify(&RtcError::RemoteSdp("remote fingerprint no match".into())),
            EndReason::DtlsFailed
        );
        assert_eq!(
            classify(&RtcError::RemoteSdp("other".into())),
            EndReason::Error
        );
    }

    #[test]
    fn direct_sink_counts_queued_bytes_and_survives_a_dead_peer() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let (_pool_tx, pool) = crossbeam_channel::bounded(POOL);
        let mut sink = DirectSink {
            tx,
            queued: Arc::default(),
            sctp: Arc::default(),
            pool,
        };
        let frame = ServerFrame::Pong { client_micros: 7 };
        assert_eq!(sink.send(&frame), Ok(()));
        assert_eq!(sink.buffered(), server_frame_len(&frame));
        assert!(
            matches!(rx.try_recv(), Ok(PeerCmd::Frame(b)) if b.len() == server_frame_len(&frame))
        );
        drop(rx);
        assert_eq!(sink.send(&frame), Ok(()), "dead peer is reported by Ended");
        assert_eq!(sink.buffered(), server_frame_len(&frame));
        assert_eq!(sink.path(), PathKind::Direct);
    }
}
