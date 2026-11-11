//! Audit events (open / close / denied). Kept until the agent acknowledges
//! them so a close is not lost while the agent is down. Events carry ids and
//! keys only: never typed input or output bytes.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Unacknowledged events kept at most; the oldest are dropped beyond this.
pub const MAX_PENDING: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditKind {
    Open,
    Close,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditEvent {
    pub seq: u64,
    pub kind: AuditKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conn: Option<u32>,
    #[serde(rename = "deviceKey", skip_serializing_if = "Option::is_none")]
    pub device_key: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
}

#[derive(Debug)]
pub struct AuditLog {
    next_seq: u64,
    pending: VecDeque<AuditEvent>,
    dropped: u64,
}

impl Default for AuditLog {
    fn default() -> Self {
        AuditLog {
            next_seq: 1,
            pending: VecDeque::new(),
            dropped: 0,
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl AuditLog {
    /// Record an event and return it for live delivery.
    pub fn record(
        &mut self,
        kind: AuditKind,
        session: Option<u32>,
        conn: Option<u32>,
        device_key: Option<String>,
    ) -> AuditEvent {
        let ev = AuditEvent {
            seq: self.next_seq,
            kind,
            session,
            conn,
            device_key,
            at: now_ms(),
        };
        self.next_seq += 1;
        if self.pending.len() == MAX_PENDING {
            self.pending.pop_front();
            self.dropped += 1;
        }
        self.pending.push_back(ev.clone());
        ev
    }

    /// Forget events with `seq <= up_to`.
    pub fn ack(&mut self, up_to: u64) {
        while self.pending.front().is_some_and(|e| e.seq <= up_to) {
            self.pending.pop_front();
        }
    }

    pub fn pending(&self) -> impl Iterator<Item = &AuditEvent> {
        self.pending.iter()
    }

    /// Events dropped because nobody acknowledged them.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_stay_until_acked() {
        let mut log = AuditLog::default();
        log.record(AuditKind::Open, Some(1), Some(9), Some("k".into()));
        log.record(AuditKind::Close, Some(1), Some(9), None);
        log.record(AuditKind::Denied, None, Some(10), None);
        assert_eq!(
            log.pending().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        log.ack(2);
        assert_eq!(log.pending().map(|e| e.seq).collect::<Vec<_>>(), vec![3]);
        log.ack(0);
        assert_eq!(log.pending().count(), 1);
    }

    #[test]
    fn pending_is_bounded() {
        let mut log = AuditLog::default();
        for _ in 0..MAX_PENDING + 5 {
            log.record(AuditKind::Open, Some(1), None, None);
        }
        assert_eq!(log.pending().count(), MAX_PENDING);
        assert_eq!(log.dropped(), 5);
        assert_eq!(log.pending().next().map(|e| e.seq), Some(6));
    }

    #[test]
    fn json_shape_matches_spec() {
        let mut log = AuditLog::default();
        let ev = log.record(AuditKind::Denied, None, Some(3), Some("abc".into()));
        let v = serde_json::to_value(&ev).unwrap_or_default();
        assert_eq!(v["kind"], "denied");
        assert_eq!(v["deviceKey"], "abc");
        assert!(v.get("session").is_none());
    }
}
