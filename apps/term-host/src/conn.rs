//! Client connections: grants, device keys, the path a connection sends on,
//! and per-session attachment state (offsets and flow window).

use std::collections::BTreeMap;
use std::fmt;
use std::time::Instant;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::control::AgentTx;
use crate::flow::{AckClock, FlowWindow, PathKind};
use crate::wire::{encode_server, server_frame_len, ServerFrame};

/// The transport is gone; the connection must be closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

/// One way of delivering terminal frames to a client. The relay path is
/// implemented here; the direct (WebRTC) path in `rtc::DirectSink`.
pub trait FrameSink: Send {
    /// Queue exactly one terminal frame for the client. Must not block.
    fn send(&mut self, frame: &ServerFrame<'_>) -> Result<(), SinkClosed>;
    /// Bytes queued and not yet handed to the transport.
    fn buffered(&self) -> usize;
    /// Which coalescing rules apply.
    fn path(&self) -> PathKind;
}

/// Frames over the agent's control socket (`kind 1`).
pub struct RelaySink {
    conn: u32,
    agent: AgentTx,
}

impl RelaySink {
    pub fn new(conn: u32, agent: AgentTx) -> Self {
        RelaySink { conn, agent }
    }

    pub fn link(&self) -> u64 {
        self.agent.link()
    }
}

impl FrameSink for RelaySink {
    fn send(&mut self, frame: &ServerFrame<'_>) -> Result<(), SinkClosed> {
        let mut buf = Vec::with_capacity(4 + 1 + 4 + server_frame_len(frame));
        crate::control::begin_relay_frame(&mut buf, self.conn);
        encode_server(frame, &mut buf);
        crate::control::finish_frame(&mut buf);
        if self.agent.send_raw(buf) {
            Ok(())
        } else {
            Err(SinkClosed)
        }
    }

    fn buffered(&self) -> usize {
        self.agent.buffered()
    }

    fn path(&self) -> PathKind {
        PathKind::Relay
    }
}

/// A paired device's public key (32 bytes, base64url in JSON).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceKey([u8; 32]);

impl DeviceKey {
    pub fn parse(s: &str) -> Option<DeviceKey> {
        let trimmed = s.trim_end_matches('=');
        let bytes = URL_SAFE_NO_PAD.decode(trimmed).ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        Some(DeviceKey(arr))
    }

    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }
}

impl fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceKey({})", self.encode())
    }
}

/// Output state of one session for one connection.
#[derive(Debug)]
pub struct Attachment {
    /// Next output offset to send.
    pub sent: u64,
    /// Highest offset the client acknowledged.
    pub acked: u64,
    pub window: FlowWindow,
    pub clock: AckClock,
    /// When the oldest unsent byte arrived (for coalescing).
    pub pending_since: Option<Instant>,
    /// Send pending output without coalescing (replay after Attach).
    pub urgent: bool,
    /// `Exit` was sent for this session.
    pub exit_sent: bool,
}

impl Attachment {
    pub fn new(offset: u64) -> Self {
        let mut clock = AckClock::default();
        clock.reset(offset);
        Attachment {
            sent: offset,
            acked: offset,
            window: FlowWindow::default(),
            clock,
            pending_since: None,
            urgent: true,
            exit_sent: false,
        }
    }

    /// Bytes read but not acknowledged (sent or still being coalesced).
    pub fn outstanding(&self, end: u64) -> u64 {
        end.saturating_sub(self.acked)
    }
}

/// A client connection granted by the agent.
pub struct Conn {
    pub id: u32,
    pub device_key: DeviceKey,
    /// When the grant was made (ms since the Unix epoch).
    pub created_at: u64,
    /// Set while the grant waits for a transport; cleared when one opens.
    pub expires: Option<Instant>,
    pub relay: Option<RelaySink>,
    /// Direct (WebRTC) transport; preferred while connected.
    pub direct: Option<Box<dyn FrameSink>>,
    /// The WebRTC peer answering this connection's latest offer (connecting
    /// or open). Dropping it closes the peer.
    pub peer: Option<crate::rtc::PeerHandle>,
    /// The client sent a valid Hello.
    pub hello: bool,
    pub attachments: BTreeMap<u32, Attachment>,
}

impl Conn {
    pub fn granted(id: u32, device_key: DeviceKey, expires: Instant) -> Self {
        Conn {
            id,
            device_key,
            created_at: crate::audit::now_ms(),
            expires: Some(expires),
            relay: None,
            direct: None,
            peer: None,
            hello: false,
            attachments: BTreeMap::new(),
        }
    }

    /// The sink frames go out on: direct when connected, else relay.
    pub fn sink(&mut self) -> Option<&mut dyn FrameSink> {
        if let Some(d) = self.direct.as_deref_mut() {
            return Some(d);
        }
        self.relay.as_mut().map(|r| r as &mut dyn FrameSink)
    }

    pub fn path(&self) -> Option<PathKind> {
        if let Some(d) = self.direct.as_deref() {
            return Some(d.path());
        }
        self.relay.as_ref().map(|r| r.path())
    }

    pub fn buffered(&self) -> usize {
        if let Some(d) = self.direct.as_deref() {
            return d.buffered();
        }
        self.relay.as_ref().map_or(0, |r| r.buffered())
    }

    pub fn is_open(&self) -> bool {
        self.relay.is_some() || self.direct.is_some()
    }

    /// The path in `conn_state` terms: `direct` or `relay` when open, else
    /// `connecting` (a peer is being set up, or the grant waits for a path).
    pub fn state(&self) -> &'static str {
        if self.direct.is_some() {
            "direct"
        } else if self.relay.is_some() {
            "relay"
        } else {
            "connecting"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_key_parsing_is_strict() {
        let raw = [7u8; 32];
        let s = URL_SAFE_NO_PAD.encode(raw);
        let k = DeviceKey::parse(&s);
        assert_eq!(k.map(|k| k.encode()), Some(s.clone()));
        // Padded form is accepted too.
        assert!(DeviceKey::parse(&format!("{s}=")).is_some());
        assert!(DeviceKey::parse(&URL_SAFE_NO_PAD.encode([1u8; 31])).is_none());
        assert!(DeviceKey::parse("not base64 !!").is_none());
        assert!(DeviceKey::parse("").is_none());
    }

    #[test]
    fn outstanding_counts_unacked_bytes() {
        let mut a = Attachment::new(100);
        assert_eq!(a.outstanding(100), 0);
        a.sent = 150;
        assert_eq!(a.outstanding(170), 70);
        a.acked = 150;
        assert_eq!(a.outstanding(170), 20);
    }
}
