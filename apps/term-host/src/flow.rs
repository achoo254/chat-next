//! Flow control and output coalescing (docs/terminal-wire.md section 5).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::wire::MAX_OUTPUT_DATA;

pub const WINDOW_START: usize = 64 * 1024;
pub const WINDOW_MIN: usize = 16 * 1024;
pub const WINDOW_MAX: usize = 1024 * 1024;
pub const WINDOW_STEP: usize = 16 * 1024;
/// queueDelay below this (and the window used up) grows the window.
pub const QUEUE_DELAY_LOW: Duration = Duration::from_millis(10);
/// queueDelay above this halves the window.
pub const QUEUE_DELAY_HIGH: Duration = Duration::from_millis(40);
/// rttMin is the minimum over this sliding window.
pub const RTT_MIN_SPAN: Duration = Duration::from_secs(10);
/// An Ack sample is taken only when it covers at least this many new bytes:
/// such acks are sent by the client's 16 KiB rule, not its 50 ms timer.
pub const ACK_SAMPLE_MIN_BYTES: u64 = 16 * 1024;
/// Most send records kept per attachment for RTT sampling.
const MAX_SEND_RECORDS: usize = 4096;

/// PTY read buffer size.
pub const READ_CHUNK: usize = 16 * 1024;
/// Ring space kept beyond the window for bytes read after the window filled
/// (reader queue + one read). Without it, unsent bytes could leave the ring.
pub const RING_HEADROOM: usize = 128 * 1024;

/// The window actually applied: never so large that read-but-unsent output
/// could be overwritten in a ring of `ring_capacity` bytes.
pub fn effective_window(window: usize, ring_capacity: usize) -> usize {
    window
        .min(ring_capacity.saturating_sub(RING_HEADROOM))
        .max(WINDOW_MIN)
}
/// Output following an Input within this long is sent at once (echo path).
pub const ECHO_WINDOW: Duration = Duration::from_millis(25);
/// Direct path: flush at this many pending bytes, else after `DIRECT_HOLD`.
pub const DIRECT_FLUSH_BYTES: usize = 16 * 1024;
pub const DIRECT_HOLD: Duration = Duration::from_millis(4);
/// Relay path: flush at a full frame, else after the hold (16 ms, 50 ms when
/// the machine frame budget runs low).
pub const RELAY_FLUSH_BYTES: usize = MAX_OUTPUT_DATA;
pub const RELAY_HOLD: Duration = Duration::from_millis(16);
pub const RELAY_HOLD_LOW_BUDGET: Duration = Duration::from_millis(50);
/// Machine-wide relay Output frame budget.
pub const RELAY_FRAMES_PER_SEC: f64 = 200.0;
pub const RELAY_BURST: f64 = 20.0;

/// Which path a connection currently sends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Direct,
    Relay,
}

/// Sliding-window minimum of RTT samples.
#[derive(Debug, Default)]
pub struct RttMin {
    // Increasing in rtt from front to back; front is the minimum.
    samples: VecDeque<(Instant, Duration)>,
}

impl RttMin {
    pub fn push(&mut self, now: Instant, rtt: Duration) {
        while self.samples.back().is_some_and(|&(_, r)| r >= rtt) {
            self.samples.pop_back();
        }
        self.samples.push_back((now, rtt));
        while self
            .samples
            .front()
            .is_some_and(|&(t, _)| now.saturating_duration_since(t) > RTT_MIN_SPAN)
        {
            self.samples.pop_front();
        }
    }

    pub fn min(&self) -> Option<Duration> {
        self.samples.front().map(|&(_, r)| r)
    }
}

/// Adaptive window of one (connection, session).
#[derive(Debug)]
pub struct FlowWindow {
    size: usize,
    /// Reading was paused by this window since the last change.
    limited: bool,
    last_change: Option<Instant>,
    rtt_min: RttMin,
    last_rtt: Option<Duration>,
}

impl Default for FlowWindow {
    fn default() -> Self {
        FlowWindow {
            size: WINDOW_START,
            limited: false,
            last_change: None,
            rtt_min: RttMin::default(),
            last_rtt: None,
        }
    }
}

impl FlowWindow {
    pub fn size(&self) -> usize {
        self.size
    }

    pub fn last_rtt(&self) -> Option<Duration> {
        self.last_rtt
    }

    /// The window was used up (reading paused because of it).
    pub fn mark_limited(&mut self) {
        self.limited = true;
    }

    /// Feed one RTT sample. Grows by one step when the queue is short and the
    /// window was used up, halves when the queue is long; at most one change
    /// per RTT.
    pub fn on_rtt(&mut self, now: Instant, rtt: Duration) {
        self.rtt_min.push(now, rtt);
        self.last_rtt = Some(rtt);
        let Some(min) = self.rtt_min.min() else {
            return;
        };
        let queue_delay = rtt.saturating_sub(min);
        let may_change = self
            .last_change
            .is_none_or(|t| now.saturating_duration_since(t) >= rtt);
        if !may_change {
            return;
        }
        if queue_delay > QUEUE_DELAY_HIGH {
            self.size = (self.size / 2).max(WINDOW_MIN);
            self.last_change = Some(now);
            self.limited = false;
        } else if queue_delay < QUEUE_DELAY_LOW && self.limited {
            self.size = (self.size + WINDOW_STEP).min(WINDOW_MAX);
            self.last_change = Some(now);
            self.limited = false;
        }
    }
}

/// Send times of Output frames, to turn Acks into RTT samples.
#[derive(Debug, Default)]
pub struct AckClock {
    sent: VecDeque<(u64, Instant)>,
    last_ack: u64,
}

impl AckClock {
    /// Restart at `offset` (attach or reattach).
    pub fn reset(&mut self, offset: u64) {
        self.sent.clear();
        self.last_ack = offset;
    }

    /// An Output frame ending at `end` was handed to the transport.
    pub fn on_send(&mut self, end: u64, now: Instant) {
        if self.sent.len() == MAX_SEND_RECORDS {
            self.sent.pop_front();
        }
        self.sent.push_back((end, now));
    }

    /// An Ack for `offset` arrived. Returns an RTT sample when the ack ends
    /// exactly at a frame boundary and covers at least 16 KiB of new bytes.
    pub fn on_ack(&mut self, offset: u64, now: Instant) -> Option<Duration> {
        let mut matched = None;
        while let Some(&(end, at)) = self.sent.front() {
            if end > offset {
                break;
            }
            self.sent.pop_front();
            if end == offset {
                matched = Some(at);
            }
        }
        let covered = offset.saturating_sub(self.last_ack);
        self.last_ack = self.last_ack.max(offset);
        if covered >= ACK_SAMPLE_MIN_BYTES {
            matched.map(|at| now.saturating_duration_since(at))
        } else {
            None
        }
    }
}

/// Machine-wide token bucket for relay Output frames.
#[derive(Debug)]
pub struct RelayBudget {
    tokens: f64,
    last: Instant,
}

impl RelayBudget {
    pub fn new(now: Instant) -> Self {
        RelayBudget {
            tokens: RELAY_BURST,
            last: now,
        }
    }

    fn refill(&mut self, now: Instant) {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + dt * RELAY_FRAMES_PER_SEC).min(RELAY_BURST);
        self.last = now;
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn low(&mut self, now: Instant) -> bool {
        self.refill(now);
        self.tokens < RELAY_BURST / 2.0
    }

    /// When the next token will be available.
    pub fn next_token_at(&mut self, now: Instant) -> Instant {
        self.refill(now);
        if self.tokens >= 1.0 {
            now
        } else {
            now + Duration::from_secs_f64((1.0 - self.tokens) / RELAY_FRAMES_PER_SEC)
        }
    }
}

/// Coalescing decision for one attachment with pending output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flush {
    Now,
    At(Instant),
}

/// Decide when pending output should go out. `echo` means the session got
/// Input within `ECHO_WINDOW`. The relay budget is checked by the caller.
pub fn flush_decision(
    path: PathKind,
    pending: usize,
    pending_since: Instant,
    echo: bool,
    budget_low: bool,
    now: Instant,
) -> Flush {
    let (bytes, hold) = match path {
        PathKind::Direct => (DIRECT_FLUSH_BYTES, DIRECT_HOLD),
        PathKind::Relay => (
            RELAY_FLUSH_BYTES,
            if budget_low {
                RELAY_HOLD_LOW_BUDGET
            } else {
                RELAY_HOLD
            },
        ),
    };
    let due = pending_since + hold;
    if echo || pending >= bytes || now >= due {
        Flush::Now
    } else {
        Flush::At(due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn effective_window_leaves_ring_headroom() {
        assert_eq!(effective_window(WINDOW_START, 1024 * 1024), WINDOW_START);
        assert_eq!(
            effective_window(WINDOW_MAX, 1024 * 1024),
            1024 * 1024 - RING_HEADROOM
        );
        assert_eq!(effective_window(WINDOW_MAX, 4 * 1024 * 1024), WINDOW_MAX);
        assert_eq!(effective_window(WINDOW_START, 0), WINDOW_MIN);
    }

    #[test]
    fn rtt_min_slides() {
        let t0 = Instant::now();
        let mut m = RttMin::default();
        m.push(t0, ms(20));
        m.push(t0 + ms(1), ms(30));
        assert_eq!(m.min(), Some(ms(20)));
        m.push(t0 + ms(2), ms(10));
        assert_eq!(m.min(), Some(ms(10)));
        // 11 s later the old minimum has expired.
        m.push(t0 + Duration::from_secs(11), ms(25));
        assert_eq!(m.min(), Some(ms(25)));
    }

    #[test]
    fn window_grows_only_when_used_up_and_queue_short() {
        let t0 = Instant::now();
        let mut w = FlowWindow::default();
        assert_eq!(w.size(), WINDOW_START);
        // Short queue but not limited: no growth.
        w.on_rtt(t0, ms(5));
        assert_eq!(w.size(), WINDOW_START);
        // Limited + short queue: +16 KiB per RTT.
        let mut t = t0;
        for i in 1..=4 {
            t += ms(6);
            w.mark_limited();
            w.on_rtt(t, ms(5));
            assert_eq!(w.size(), WINDOW_START + i * WINDOW_STEP);
        }
    }

    #[test]
    fn window_halves_on_queue_growth_once_per_rtt_and_respects_bounds() {
        let t0 = Instant::now();
        let mut w = FlowWindow::default();
        w.on_rtt(t0, ms(5)); // rttMin = 5
        w.on_rtt(t0 + ms(10), ms(60)); // queueDelay 55 > 40
        assert_eq!(w.size(), WINDOW_START / 2);
        // Within the same RTT (60 ms): no second decrease.
        w.on_rtt(t0 + ms(30), ms(60));
        assert_eq!(w.size(), WINDOW_START / 2);
        // Next RTT: halve again, then clamp at the minimum.
        let mut t = t0 + ms(80);
        for _ in 0..10 {
            w.on_rtt(t, ms(60));
            t += ms(70);
        }
        assert_eq!(w.size(), WINDOW_MIN);
    }

    #[test]
    fn window_never_exceeds_max() {
        let t0 = Instant::now();
        let mut w = FlowWindow::default();
        let mut t = t0;
        for _ in 0..200 {
            t += ms(2);
            w.mark_limited();
            w.on_rtt(t, ms(1));
        }
        assert_eq!(w.size(), WINDOW_MAX);
    }

    #[test]
    fn middle_queue_delay_holds_window() {
        let t0 = Instant::now();
        let mut w = FlowWindow::default();
        w.on_rtt(t0, ms(5));
        w.mark_limited();
        w.on_rtt(t0 + ms(50), ms(30)); // queueDelay 25: between thresholds
        assert_eq!(w.size(), WINDOW_START);
    }

    #[test]
    fn ack_clock_samples_threshold_acks_at_frame_boundaries() {
        let t0 = Instant::now();
        let mut c = AckClock::default();
        c.reset(0);
        c.on_send(8 * 1024, t0);
        c.on_send(16 * 1024, t0 + ms(1));
        c.on_send(20 * 1024, t0 + ms(2));
        // Ack at 16 KiB: frame boundary, covers 16 KiB.
        assert_eq!(c.on_ack(16 * 1024, t0 + ms(9)), Some(ms(8)));
        // Timer ack for the small rest: no sample.
        assert_eq!(c.on_ack(20 * 1024, t0 + ms(60)), None);
        // Ack in the middle of a frame: no sample.
        c.on_send(60 * 1024, t0 + ms(70));
        assert_eq!(c.on_ack(50 * 1024, t0 + ms(75)), None);
    }

    #[test]
    fn relay_budget_caps_frame_rate() {
        let t0 = Instant::now();
        let mut b = RelayBudget::new(t0);
        let mut taken = 0;
        for _ in 0..100 {
            if b.try_take(t0) {
                taken += 1;
            }
        }
        assert_eq!(taken, RELAY_BURST as usize);
        assert!(b.low(t0));
        let next = b.next_token_at(t0);
        assert!(next > t0 && next <= t0 + ms(6));
        // Over one second at most burst + 200 frames.
        let mut t = t0;
        let mut more = 0;
        while t < t0 + Duration::from_secs(1) {
            t += Duration::from_micros(500);
            if b.try_take(t) {
                more += 1;
            }
        }
        assert!((199..=201).contains(&more), "{more}");
    }

    #[test]
    fn coalescing_rules() {
        let t0 = Instant::now();
        use Flush::*;
        // Echo path: immediately on both paths.
        assert_eq!(
            flush_decision(PathKind::Direct, 1, t0, true, false, t0),
            Now
        );
        assert_eq!(flush_decision(PathKind::Relay, 1, t0, true, false, t0), Now);
        // Direct: 4 ms hold or 16 KiB.
        assert_eq!(
            flush_decision(PathKind::Direct, 100, t0, false, false, t0),
            At(t0 + ms(4))
        );
        assert_eq!(
            flush_decision(PathKind::Direct, 16 * 1024, t0, false, false, t0),
            Now
        );
        assert_eq!(
            flush_decision(PathKind::Direct, 100, t0, false, false, t0 + ms(4)),
            Now
        );
        // Relay: 16 ms, 50 ms when the budget is low, or a full frame.
        assert_eq!(
            flush_decision(PathKind::Relay, 100, t0, false, false, t0),
            At(t0 + ms(16))
        );
        assert_eq!(
            flush_decision(PathKind::Relay, 100, t0, false, true, t0),
            At(t0 + ms(50))
        );
        assert_eq!(
            flush_decision(PathKind::Relay, MAX_OUTPUT_DATA, t0, false, true, t0),
            Now
        );
    }
}
