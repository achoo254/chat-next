//! Minimal STUN Binding responder (RFC 8489, compatible with RFC 5389).
//!
//! Answers a Binding request with one XOR-MAPPED-ADDRESS attribute that holds
//! the source address of the request. No TURN, no authentication, no error
//! responses and nothing persisted: anything that is not a well-formed Binding
//! request is dropped silently, so the service cannot be used to reflect
//! arbitrary traffic. Each source address gets at most a fixed number of
//! answers per second, which bounds what a spoofed-source flood can reflect.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

/// Fixed STUN header length in bytes.
pub const HEADER_LEN: usize = 20;
/// Magic cookie that every RFC 5389+ message carries at bytes 4..8.
pub const MAGIC_COOKIE: u32 = 0x2112_A442;
/// Message type of a Binding request.
pub const BINDING_REQUEST: u16 = 0x0001;
/// Message type of a Binding success response.
pub const BINDING_SUCCESS: u16 = 0x0101;
/// Attribute type of XOR-MAPPED-ADDRESS.
pub const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
/// Largest request accepted; a Binding request from an ICE agent is far
/// smaller, and anything larger is not worth parsing.
pub const MAX_REQUEST_LEN: usize = 548;

/// A 96-bit STUN transaction id.
pub type TransactionId = [u8; 12];

/// The transaction id of `buf` if it is a well-formed Binding request:
/// two leading zero bits, Binding request type, length that matches the
/// datagram and is a multiple of four, and the magic cookie. Attributes are
/// not inspected; the answer never depends on them.
pub fn parse_binding_request(buf: &[u8]) -> Option<TransactionId> {
    if buf.len() < HEADER_LEN || buf.len() > MAX_REQUEST_LEN {
        return None;
    }
    let msg_type = u16::from_be_bytes([buf[0], buf[1]]);
    if msg_type != BINDING_REQUEST {
        return None;
    }
    let body_len = usize::from(u16::from_be_bytes([buf[2], buf[3]]));
    if body_len % 4 != 0 || HEADER_LEN + body_len != buf.len() {
        return None;
    }
    if u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) != MAGIC_COOKIE {
        return None;
    }
    let mut txid = [0u8; 12];
    txid.copy_from_slice(&buf[8..HEADER_LEN]);
    Some(txid)
}

/// A Binding success response for `txid` that reports `mapped` in an
/// XOR-MAPPED-ADDRESS attribute. An IPv4-mapped IPv6 source (from a
/// dual-stack socket) is reported as the IPv4 address it carries.
pub fn binding_response(txid: &TransactionId, mapped: SocketAddr) -> Vec<u8> {
    let cookie = MAGIC_COOKIE.to_be_bytes();
    let ip = match mapped.ip() {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    let (family, xored_ip): (u8, Vec<u8>) = match ip {
        IpAddr::V4(v4) => (
            0x01,
            v4.octets().iter().zip(cookie).map(|(a, k)| a ^ k).collect(),
        ),
        IpAddr::V6(v6) => {
            let key = cookie.iter().chain(txid.iter());
            (
                0x02,
                v6.octets().iter().zip(key).map(|(a, k)| a ^ k).collect(),
            )
        }
    };
    let xport = mapped.port() ^ (MAGIC_COOKIE >> 16) as u16;
    let value_len = 4 + xored_ip.len();
    let body_len = 4 + value_len;

    let mut m = Vec::with_capacity(HEADER_LEN + body_len);
    m.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    // body_len is at most 24, so the cast cannot truncate.
    m.extend_from_slice(&(body_len as u16).to_be_bytes());
    m.extend_from_slice(&cookie);
    m.extend_from_slice(txid);
    m.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
    m.extend_from_slice(&(value_len as u16).to_be_bytes());
    m.push(0);
    m.push(family);
    m.extend_from_slice(&xport.to_be_bytes());
    m.extend_from_slice(&xored_ip);
    m
}

/// Per-source fixed-window limiter: at most `limit` allowed events per source
/// address in each window. Memory is bounded by `max_sources`; when the table
/// is full of sources seen in the current window, new sources are refused
/// rather than letting a spoofed flood grow the table.
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    max_sources: usize,
    sources: HashMap<IpAddr, (Instant, u32)>,
    last_sweep: Option<Instant>,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration, max_sources: usize) -> Self {
        Self {
            limit,
            window,
            max_sources,
            sources: HashMap::new(),
            last_sweep: None,
        }
    }

    /// Whether one more event from `ip` at `now` is within the limit; counts
    /// the event when it is.
    pub fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        self.sweep_if_due(now);
        if let Some((start, count)) = self.sources.get_mut(&ip) {
            if now.saturating_duration_since(*start) >= self.window {
                *start = now;
                *count = 0;
            }
            if *count >= self.limit {
                return false;
            }
            *count += 1;
            return true;
        }
        if self.limit == 0 {
            return false;
        }
        if self.sources.len() >= self.max_sources {
            self.sweep(now);
            if self.sources.len() >= self.max_sources {
                return false;
            }
        }
        self.sources.insert(ip, (now, 1));
        true
    }

    /// Number of source addresses currently tracked.
    pub fn tracked(&self) -> usize {
        self.sources.len()
    }

    fn sweep_if_due(&mut self, now: Instant) {
        let due = match self.last_sweep {
            None => true,
            Some(t) => now.saturating_duration_since(t) >= self.window * 10,
        };
        if due {
            self.sweep(now);
        }
    }

    /// Drops sources whose window has ended; they would start a fresh window
    /// on their next event anyway.
    fn sweep(&mut self, now: Instant) {
        let window = self.window;
        self.sources
            .retain(|_, (start, _)| now.saturating_duration_since(*start) < window);
        self.last_sweep = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn request(txid: &TransactionId, attrs: &[u8]) -> Vec<u8> {
        let mut m = Vec::new();
        m.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
        m.extend_from_slice(&(attrs.len() as u16).to_be_bytes());
        m.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        m.extend_from_slice(txid);
        m.extend_from_slice(attrs);
        m
    }

    /// Independent decoder written from RFC 8489 section 14.2.
    fn decode_xor_mapped(resp: &[u8], txid: &TransactionId) -> SocketAddr {
        assert_eq!(&resp[0..2], &BINDING_SUCCESS.to_be_bytes());
        assert_eq!(
            usize::from(u16::from_be_bytes([resp[2], resp[3]])),
            resp.len() - 20
        );
        assert_eq!(&resp[4..8], &MAGIC_COOKIE.to_be_bytes());
        assert_eq!(&resp[8..20], txid);
        assert_eq!(&resp[20..22], &ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        let v = &resp[24..];
        assert_eq!(
            usize::from(u16::from_be_bytes([resp[22], resp[23]])),
            v.len()
        );
        let port = u16::from_be_bytes([v[2], v[3]]) ^ 0x2112;
        let mut key = MAGIC_COOKIE.to_be_bytes().to_vec();
        key.extend_from_slice(txid);
        let ip = match v[1] {
            1 => {
                let o: Vec<u8> = v[4..8].iter().zip(&key).map(|(a, k)| a ^ k).collect();
                IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], o[3]))
            }
            2 => {
                let mut o = [0u8; 16];
                for (i, b) in v[4..20].iter().enumerate() {
                    o[i] = b ^ key[i];
                }
                IpAddr::V6(Ipv6Addr::from(o))
            }
            f => panic!("unknown family {f}"),
        };
        SocketAddr::new(ip, port)
    }

    const TXID: TransactionId = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    #[test]
    fn accepts_plain_binding_request() {
        assert_eq!(parse_binding_request(&request(&TXID, &[])), Some(TXID));
    }

    #[test]
    fn accepts_request_with_attributes() {
        // SOFTWARE attribute "abcd" plus a FINGERPRINT-sized trailer.
        let attrs = [
            0x80, 0x22, 0, 4, b'a', b'b', b'c', b'd', 0x80, 0x28, 0, 4, 0, 0, 0, 0,
        ];
        assert_eq!(parse_binding_request(&request(&TXID, &attrs)), Some(TXID));
    }

    #[test]
    fn rejects_malformed_or_other_messages() {
        let good = request(&TXID, &[]);
        assert_eq!(parse_binding_request(&good[..19]), None, "short");
        assert_eq!(parse_binding_request(&[]), None, "empty");

        let mut wrong_type = good.clone();
        wrong_type[1] = 0x11; // Binding indication
        assert_eq!(parse_binding_request(&wrong_type), None, "indication");

        let mut response = good.clone();
        response[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes());
        assert_eq!(parse_binding_request(&response), None, "response");

        let mut high_bits = good.clone();
        high_bits[0] |= 0xC0;
        assert_eq!(parse_binding_request(&high_bits), None, "leading bits");

        let mut no_cookie = good.clone();
        no_cookie[4] = 0;
        assert_eq!(parse_binding_request(&no_cookie), None, "cookie");

        let mut bad_len = request(&TXID, &[0, 0, 0, 0]);
        bad_len[3] = 8;
        assert_eq!(parse_binding_request(&bad_len), None, "length mismatch");

        let unaligned = request(&TXID, &[0, 0, 0]);
        assert_eq!(parse_binding_request(&unaligned), None, "unaligned");

        let huge = request(&TXID, &[0u8; MAX_REQUEST_LEN]);
        assert_eq!(parse_binding_request(&huge), None, "too large");
    }

    #[test]
    fn response_round_trips_ipv4_and_ipv6() {
        for mapped in [
            "203.0.113.7:54321",
            "198.51.100.1:1",
            "[2001:db8::42]:3478",
            "[2001:db8:ffff::1]:65535",
        ] {
            let mapped: SocketAddr = mapped.parse().expect("address");
            let resp = binding_response(&TXID, mapped);
            let expected_len = if mapped.is_ipv4() { 32 } else { 44 };
            assert_eq!(resp.len(), expected_len, "{mapped}");
            assert_eq!(decode_xor_mapped(&resp, &TXID), mapped);
        }
    }

    #[test]
    fn ipv4_mapped_source_is_reported_as_ipv4() {
        let from: SocketAddr = "[::ffff:203.0.113.7]:4000".parse().expect("address");
        let resp = binding_response(&TXID, from);
        assert_eq!(resp.len(), 32);
        assert_eq!(
            decode_xor_mapped(&resp, &TXID),
            "203.0.113.7:4000".parse::<SocketAddr>().expect("address")
        );
    }

    #[test]
    fn response_is_not_a_request() {
        let resp = binding_response(&TXID, "203.0.113.7:1".parse().expect("address"));
        assert_eq!(parse_binding_request(&resp), None);
    }

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(198, 51, 100, last))
    }

    #[test]
    fn limiter_allows_limit_per_window_per_source() {
        let mut rl = RateLimiter::new(20, Duration::from_secs(1), 100);
        let t0 = Instant::now();
        for i in 0..20 {
            assert!(rl.allow(ip(1), t0), "request {i}");
        }
        assert!(!rl.allow(ip(1), t0), "21st in the same second");
        assert!(
            !rl.allow(ip(1), t0 + Duration::from_millis(999)),
            "still same window"
        );
        assert!(rl.allow(ip(2), t0), "other source is independent");
        assert!(rl.allow(ip(1), t0 + Duration::from_secs(1)), "next window");
    }

    #[test]
    fn limiter_bounds_tracked_sources() {
        let mut rl = RateLimiter::new(20, Duration::from_secs(1), 3);
        let t0 = Instant::now();
        for i in 1..=3 {
            assert!(rl.allow(ip(i), t0));
        }
        assert!(!rl.allow(ip(4), t0), "table full of live sources");
        assert!(rl.allow(ip(1), t0), "known source still served");
        assert_eq!(rl.tracked(), 3);

        let later = t0 + Duration::from_secs(2);
        assert!(rl.allow(ip(4), later), "expired sources are swept");
        assert_eq!(rl.tracked(), 1);
    }

    #[test]
    fn limiter_sweeps_idle_sources_periodically() {
        let mut rl = RateLimiter::new(20, Duration::from_secs(1), 100);
        let t0 = Instant::now();
        for i in 1..=50 {
            assert!(rl.allow(ip(i), t0));
        }
        assert_eq!(rl.tracked(), 50);
        assert!(rl.allow(ip(200), t0 + Duration::from_secs(11)));
        assert_eq!(rl.tracked(), 1);
    }

    #[test]
    fn zero_limit_refuses_everything() {
        let mut rl = RateLimiter::new(0, Duration::from_secs(1), 10);
        assert!(!rl.allow(ip(1), Instant::now()));
        assert_eq!(rl.tracked(), 0);
    }
}
